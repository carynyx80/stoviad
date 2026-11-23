"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { VersionedTransaction } from "@solana/web3.js";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, EyeOff, KeyRound, Loader2, Lock, RefreshCw, ShieldCheck, TriangleAlert, Wallet } from "lucide-react";
import { API_URL } from "@/lib/config";
import { useSolBalance } from "@/components/wallet/useSolBalance";
import { Field, Panel, Stat, inputCls } from "./ui";

// Type-only imports are erased at build time; the SDK itself is loaded on demand.
type RingsModule = typeof import("@/lib/rings");
type Rings = Awaited<ReturnType<RingsModule["createStoviaRings"]>>;
type Identity = Awaited<ReturnType<Rings["deriveShieldedIdentity"]>>;

let ringsPromise: Promise<{ mod: RingsModule; rings: Rings }> | null = null;
function loadRings() {
  ringsPromise ??= import("@/lib/rings")
    .then(async (mod) => ({ mod, rings: await mod.createStoviaRings(API_URL) }))
    .catch((err) => {
      ringsPromise = null; // allow a retry
      throw err;
    });
  return ringsPromise;
}

const SIGN_MESSAGE =
  "Stovia shielded identity v1\n\nSign to unlock your private balance. This does not send a transaction.";

type Step = "idle" | "building" | "proving" | "signing" | "sending" | "confirming" | "done" | "error";
type TxState = { step: Step; message?: string; signature?: string };

const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;

function errMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: { message?: string; code?: string } } | undefined;
  const raw = `${e?.code ?? ""} ${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
  if (e?.name === "WalletSignMessageError" || e?.name === "WalletSignTransactionError" || e?.name === "WalletSendTransactionError") {
    if (/reject|declin|cancel/i.test(raw)) return "You declined the request in your wallet.";
  }
  if (/reject|declin|cancel/i.test(raw)) return "You declined the request in your wallet.";
  if (/INSUFFICIENT_BALANCE/i.test(raw)) return "Not enough shielded SOL for that amount.";
  if (/insufficient (funds|lamports)|AccountNotFound|0x1\b/i.test(raw)) return "Not enough SOL in your wallet to cover the amount plus network fees.";
  if (/blockhash|expired/i.test(raw)) return "The transaction expired before it landed. Please try again.";
  if (/fetch|network|unavailable|timeout|503|502|504/i.test(raw)) return "The privacy network didn't answer. Please try again in a moment.";
  return (e?.message || "Something went wrong.").slice(0, 220);
}

export function PrivateVault() {
  const { connection } = useConnection();
  const { publicKey, connected, wallet, signMessage, signTransaction, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();
  const { balance: publicSol } = useSolBalance(20_000);

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [unlock, setUnlock] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [shielded, setShielded] = useState<{ lamports: bigint | null; loading: boolean; error?: string }>({ lamports: null, loading: false });
  const [shieldAmt, setShieldAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [shieldTx, setShieldTx] = useState<TxState>({ step: "idle" });
  const [withdrawTx, setWithdrawTx] = useState<TxState>({ step: "idle" });
  const [fmt, setFmt] = useState<RingsModule["formatSol"] | null>(null);
  const owner = useRef<string | null>(null);

  // Forget the in-memory identity whenever the wallet changes or disconnects.
  useEffect(() => {
    const now = publicKey?.toBase58() ?? null;
    if (owner.current !== now) {
      owner.current = now;
      setIdentity(null);
      setShielded({ lamports: null, loading: false });
      setShieldTx({ step: "idle" });
      setWithdrawTx({ step: "idle" });
    }
  }, [publicKey]);

  const refresh = useCallback(async (id: Identity) => {
    setShielded((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const { rings, mod } = await loadRings();
      const lamports = await rings.getShieldedBalance(id);
      setFmt(() => mod.formatSol);
      setShielded({ lamports, loading: false });
    } catch (err) {
      setShielded((s) => ({ ...s, loading: false, error: errMessage(err) }));
    }
  }, []);

  const onUnlock = async () => {
    if (!publicKey) return setVisible(true);
    if (!signMessage) {
      setUnlock({ busy: false, error: "This wallet can't sign messages (some hardware and multisig wallets can't). Use Phantom or Solflare with a software key." });
      return;
    }
    setUnlock({ busy: true });
    try {
      const { rings } = await loadRings();
      const id = await rings.deriveShieldedIdentity({ address: publicKey.toBase58(), signMessage });
      if (owner.current !== publicKey.toBase58()) return;
      setIdentity(id);
      setUnlock({ busy: false });
      void refresh(id);
    } catch (err) {
      setUnlock({ busy: false, error: errMessage(err) });
    }
  };

  /** Hand an SDK transaction to the wallet, send it through our RPC proxy, wait for confirmation. */
  const signAndSend = async (tx: Parameters<RingsModule["toWalletTransaction"]>[0], set: (s: TxState) => void): Promise<string> => {
    const { mod } = await loadRings();
    const ready = mod.toWalletTransaction(tx);
    if (!publicKey) throw new Error("Wallet disconnected.");
    let signature: string;
    set({ step: "signing", message: "Approve the transaction in your wallet." });
    if (ready.v0) {
      const vtx = VersionedTransaction.deserialize(ready.v0);
      if (signTransaction) {
        const signed = await signTransaction(vtx);
        set({ step: "sending", message: "Sending to Solana mainnet." });
        signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
      } else {
        set({ step: "sending", message: "Sending to Solana mainnet." });
        signature = await sendTransaction(vtx, connection, { preflightCommitment: "confirmed", maxRetries: 3 });
      }
    } else {
      // Too large for a legacy/v0 packet: only a wallet that signs version-1 transactions can do it.
      type StdAccount = { address: string };
      type StdSign = { supportedTransactionVersions?: readonly (number | string)[]; signTransaction: (...i: { account: StdAccount; transaction: Uint8Array; chain: string }[]) => Promise<{ signedTransaction: Uint8Array }[]> };
      const std = (wallet?.adapter as unknown as { wallet?: { accounts: readonly StdAccount[]; features: Record<string, unknown> } })?.wallet;
      const feature = std?.features["solana:signTransaction"] as StdSign | undefined;
      const account = std?.accounts.find((a) => a.address === publicKey.toBase58());
      const v1ok = feature?.supportedTransactionVersions?.some((v) => String(v) === "1");
      if (!feature || !account || !v1ok) {
        throw new Error("This transaction needs a wallet that supports Solana version-1 transactions, and yours doesn't yet. Update Phantom or Solflare and try again.");
      }
      const [out] = await feature.signTransaction({ account, transaction: ready.v1, chain: "solana:mainnet" });
      set({ step: "sending", message: "Sending to Solana mainnet." });
      signature = await connection.sendRawTransaction(out.signedTransaction, { preflightCommitment: "confirmed", maxRetries: 3 });
    }
    set({ step: "confirming", message: "Waiting for confirmation.", signature });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const { value } = await connection.getSignatureStatuses([signature]);
      const st = value[0];
      if (st?.err) throw Object.assign(new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)}`), { signature });
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw Object.assign(new Error("Not confirmed after 90s. Check Solscan before retrying."), { signature });
  };

  const run = async (kind: "shield" | "withdraw", e: FormEvent) => {
    e.preventDefault();
    if (!identity || !publicKey) return;
    const set = kind === "shield" ? setShieldTx : setWithdrawTx;
    const amount = kind === "shield" ? shieldAmt : withdrawAmt;
    try {
      const { rings, mod } = await loadRings();
      const lamports = mod.parseSol(amount);
      if (lamports === null || lamports <= BigInt(0)) return set({ step: "error", message: "Enter an amount in SOL, up to 9 decimals." });
      if (kind === "withdraw" && shielded.lamports !== null && lamports > shielded.lamports) return set({ step: "error", message: "That's more than your shielded balance." });
      if (kind === "shield" && publicSol !== null && Number(lamports) / 1e9 > publicSol) return set({ step: "error", message: "That's more than your wallet balance." });
      set({ step: kind === "withdraw" ? "proving" : "building", message: kind === "withdraw" ? "Syncing your notes and generating a zero-knowledge proof (can take ~10–30s)." : "Building the deposit." });
      const payer = publicKey.toBase58();
      const tx = kind === "shield" ? await rings.shieldSol({ payer, identity, lamports }) : await rings.withdrawSol({ payer, identity, lamports });
      const signature = await signAndSend(tx, set);
      set({ step: "done", message: kind === "shield" ? `Shielded ${amount} SOL.` : `Withdrew ${amount} SOL to your wallet.`, signature });
      if (kind === "shield") setShieldAmt("");
      else setWithdrawAmt("");
      void refresh(identity);
    } catch (err) {
      set({ step: "error", message: errMessage(err), signature: (err as { signature?: string })?.signature });
    }
  };

  const busy = (s: Step) => s !== "idle" && s !== "done" && s !== "error";
  const shieldedText = shielded.lamports === null ? "—" : fmt ? fmt(shielded.lamports) : "…";

  if (!connected || !publicKey) {
    return (
      <Panel kicker="Private vault" title="Connect a wallet to open your vault">
        <p className="max-w-[60ch] text-bone-dim">Shield SOL into Helius Privacy Rings, hold it privately, and withdraw it back whenever you want. Your wallet signs everything; Stovia never holds your funds or keys.</p>
        <button type="button" onClick={() => setVisible(true)} className="mt-6 inline-flex h-12 items-center gap-2 rounded-sm bg-gold px-6 font-display font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
          <Wallet className="h-4 w-4" aria-hidden /> Connect wallet
        </button>
      </Panel>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
      <Panel kicker="Shielded identity" title={identity ? "Vault unlocked" : "Unlock your vault"}>
        {!identity ? (
          <>
            <p className="text-bone-dim">Your wallet will be asked to <span className="text-bone">sign a message</span> (not a transaction, no fee). Its signature deterministically derives your private shielded keys, which stay in this tab&apos;s memory only and are forgotten when you leave.</p>
            <pre className="mt-4 whitespace-pre-wrap rounded-sm border border-line bg-ink p-4 font-mono text-xs text-bone-dim">{SIGN_MESSAGE}</pre>
            <p className="mt-3 flex items-start gap-2 text-xs text-bone-dim/90"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blood-hot" aria-hidden />Only sign this exact message on stovia.xyz. Anyone holding this signature can view and spend your shielded balance.</p>
            <button type="button" onClick={onUnlock} disabled={unlock.busy} className="mt-6 inline-flex h-12 items-center gap-2 rounded-sm bg-gold px-6 font-display font-bold text-ink transition hover:bg-gold-hot disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
              {unlock.busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
              {unlock.busy ? "Waiting for signature…" : "Sign to unlock"}
            </button>
            {unlock.error && <p role="alert" className="mt-3 border-l-2 border-blood-hot pl-3 text-sm text-bone">{unlock.error}</p>}
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Stat label="Shielded SOL" value={shielded.loading && shielded.lamports === null ? "…" : shieldedText} tone="gold" />
              <Stat label="Wallet SOL" value={publicSol === null ? "—" : publicSol.toFixed(4)} />
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3 text-xs text-bone-dim">
              <button type="button" onClick={() => refresh(identity)} disabled={shielded.loading} className="inline-flex items-center gap-1.5 rounded-sm border border-line px-3 py-1.5 font-mono uppercase tracking-[0.14em] transition hover:border-gold hover:text-gold disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${shielded.loading ? "animate-spin" : ""}`} aria-hidden /> Refresh
              </button>
              <span className="inline-flex items-center gap-1.5"><EyeOff className="h-3.5 w-3.5" aria-hidden /> Balance decrypted locally with your viewing key</span>
            </div>
            {shielded.error && <p role="alert" className="mt-3 border-l-2 border-blood-hot pl-3 text-sm text-bone">{shielded.error}</p>}
            <p className="mt-5 break-all font-mono text-[11px] text-bone-dim/70">Shielded owner · {identity.ownerSolanaAddress}</p>
          </>
        )}
        <ul className="mt-6 space-y-1.5 border-t border-line pt-4 text-xs text-bone-dim">
          <li>Deposits and withdrawals are public (wallet + amount). What you hold in between is private.</li>
          <li>Tip: shield a round amount early; size your private moves later.</li>
          <li>Helius Privacy Rings is in beta (SDK 0.9.0-alpha). Start small.</li>
        </ul>
      </Panel>

      <div className="grid gap-6">
        <TxForm
          id="shield"
          title="Shield SOL"
          icon={<ArrowDownToLine className="h-4 w-4" aria-hidden />}
          hint="Moves SOL from your wallet into your private balance."
          value={shieldAmt}
          onChange={setShieldAmt}
          onMax={publicSol !== null ? () => setShieldAmt(Math.max(0, publicSol - 0.01).toFixed(4)) : undefined}
          locked={!identity}
          state={shieldTx}
          busy={busy(shieldTx.step)}
          onSubmit={(e) => run("shield", e)}
          tone="gold"
          cta="Shield"
        />
        <TxForm
          id="withdraw"
          title="Withdraw to wallet"
          icon={<ArrowUpFromLine className="h-4 w-4" aria-hidden />}
          hint="Moves shielded SOL back to your connected wallet."
          value={withdrawAmt}
          onChange={setWithdrawAmt}
          onMax={shielded.lamports !== null && fmt ? () => setWithdrawAmt(fmt(shielded.lamports!, 9)) : undefined}
          locked={!identity}
          state={withdrawTx}
          busy={busy(withdrawTx.step)}
          onSubmit={(e) => run("withdraw", e)}
          tone="blood"
          cta="Withdraw"
        />
      </div>
    </div>
  );
}

function TxForm(props: {
  id: string;
  title: string;
  icon: ReactNode;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onMax?: () => void;
  locked: boolean;
  state: TxState;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
  tone: "gold" | "blood";
  cta: string;
}) {
  const { id, state } = props;
  const btn = props.tone === "gold" ? "bg-gold text-ink hover:bg-gold-hot" : "bg-blood text-bone hover:bg-blood-hot";
  return (
    <Panel kicker={props.locked ? "Locked" : "Mainnet"} title={<span className="inline-flex items-center gap-2">{props.icon}{props.title}</span>}>
      <form onSubmit={props.onSubmit} className="space-y-4" aria-busy={props.busy}>
        <Field label="Amount (SOL)" hint={props.hint} htmlFor={`${id}-amt`}>
          <div className="flex gap-2">
            <input id={`${id}-amt`} inputMode="decimal" autoComplete="off" placeholder="0.10" value={props.value} onChange={(e) => props.onChange(e.target.value.replace(",", "."))} disabled={props.locked || props.busy} className={inputCls} />
            {props.onMax && (
              <button type="button" onClick={props.onMax} disabled={props.locked || props.busy} className="h-12 shrink-0 rounded-sm border border-line px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim transition hover:border-gold hover:text-gold disabled:opacity-40">Max</button>
            )}
          </div>
        </Field>
        <button type="submit" disabled={props.locked || props.busy || !props.value} className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm px-6 font-display font-bold transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold ${btn}`}>
          {props.locked ? <Lock className="h-4 w-4" aria-hidden /> : props.busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
          {props.locked ? "Unlock vault first" : props.busy ? "Working…" : props.cta}
        </button>
        <AnimatePresence>
          {state.step !== "idle" && (
            <motion.div role={state.step === "error" ? "alert" : "status"} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={`border-l-2 pl-3 text-sm ${state.step === "error" ? "border-blood-hot text-bone" : state.step === "done" ? "border-gold text-bone" : "border-bone-dim/50 text-bone-dim"}`}>
              <p>{state.message}</p>
              {state.signature && (
                <a href={solscan(state.signature)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-gold hover:text-gold-hot">
                  View on Solscan <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </form>
    </Panel>
  );
}
