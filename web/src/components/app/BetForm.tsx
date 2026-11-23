"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Download, ExternalLink, EyeOff, FileUp, KeyRound, LineChart, Loader2, ShieldCheck, TriangleAlert, Unlock, Wallet, Trophy } from "lucide-react";
import { getMarket, getMarkets, getMarketShieldedAddress, claimStake, commitBet, revealBet, buildClaim, claimSubmitted, marketPhase, winningSide, type ResolverMarket, ResolverError } from "@/lib/markets/resolver";
import { commitMessage, revealMessage, claimMessage, randomSaltHex, sideCommitment, stakeCommitment, signText, type Side } from "@/lib/markets/crypto";
import { atLeast, downloadReceipt, loadReceipt, readReceiptFile, saveReceipt, updateReceipt, type BetReceipt, type Stage } from "@/lib/markets/receipts";
import { fmtCountdown, fmtLamports, parseSolInput, useResolver } from "@/lib/markets/hooks";
import { errMessage, signAndSend, solscanTx } from "@/lib/markets/wallet-tx";
import { useNow } from "@/lib/useApi";
import { shortAddr } from "@/lib/format";
import { STOVIA } from "@/lib/config";
import { Field, Panel, inputCls } from "./ui";
import { McapBar, PhaseChip, phaseClock } from "./MarketsList";

type StakeMod = typeof import("@/lib/markets/stake");
type Identity = import("@/lib/markets/stake").ShieldedIdentity;
const loadStake = (): Promise<StakeMod> => import("@/lib/markets/stake");

const QUICK = ["0.1", "0.5", "1", "5"];

type Run = { busy: boolean; label?: string; error?: string; info?: string; signature?: string };

export function BetForm() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signMessage } = wallet;
  const { setVisible } = useWalletModal();
  const now = useNow(1000);
  const addr = publicKey?.toBase58() ?? null;

  const markets = useResolver<ResolverMarket[]>(getMarkets, [], 60_000);
  const [marketId, setMarketId] = useState("");
  const detail = useResolver<ResolverMarket>(marketId ? () => getMarket(marketId) : null, [marketId], 20_000);

  const [side, setSide] = useState<Side | null>(null);
  const [amount, setAmount] = useState("");
  const [receipt, setReceipt] = useState<BetReceipt | null>(null);
  const [run, setRun] = useState<Run>({ busy: false });
  const [shortfall, setShortfall] = useState<bigint | null>(null);
  const [shieldedBal, setShieldedBal] = useState<bigint | null>(null);
  const identity = useRef<{ owner: string; id: Identity } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imported = useRef<BetReceipt | null>(null);

  useEffect(() => {
    try {
      const m = new URLSearchParams(window.location.search).get("market");
      if (m && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m)) setMarketId(m);
    } catch {
      /* ignore */
    }
  }, []);

  // Load the local receipt for wallet+market; forget the shielded identity on wallet change.
  useEffect(() => {
    const mem = imported.current && imported.current.wallet === addr && imported.current.market === marketId ? imported.current : null;
    setReceipt(addr && marketId ? loadReceipt(addr, marketId) ?? mem : null);
    setRun({ busy: false });
    setShortfall(null);
    if (identity.current && identity.current.owner !== addr) {
      identity.current = null;
      setShieldedBal(null);
    }
  }, [addr, marketId]);

  const selectMarket = (id: string) => {
    setMarketId(id);
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("market", id);
      else url.searchParams.delete("market");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* ignore */
    }
  };

  const m = detail.status === "ready" && detail.data.market === marketId ? detail.data : null;
  const phase = m ? marketPhase(m, now) : null;
  const list = markets.status === "ready" ? markets.data : [];
  const openList = list.filter((x) => marketPhase(x, now) === "open");

  /* ---------------- flow steps ---------------- */

  const getIdentity = useCallback(async (stake: StakeMod): Promise<Identity> => {
    if (!publicKey || !signMessage) throw new Error("This wallet can't sign messages. Use Phantom or Solflare with a software key.");
    if (identity.current?.owner === publicKey.toBase58()) return identity.current.id;
    setRun((r) => ({ ...r, label: "Sign once to unlock your shielded balance (no fee)." }));
    const rings = await stake.loadRings();
    const id = await rings.deriveShieldedIdentity({ address: publicKey.toBase58(), signMessage });
    identity.current = { owner: publicKey.toBase58(), id };
    return id;
  }, [publicKey, signMessage]);

  /** Continue a receipt from its current stage up to "claimed" (bet fully placed). */
  const advance = useCallback(async (start: BetReceipt) => {
    if (!publicKey || !signMessage) return;
    let r = start;
    setShortfall(null);
    try {
      if (r.stage === "draft") {
        setRun({ busy: true, label: "Step 1/3 · Sign your sealed commitment in your wallet (no fee)." });
        const signature = await signText(signMessage, commitMessage(r.market, r.commitment, r.stakeCommitment));
        setRun({ busy: true, label: "Step 1/3 · Recording your commitment." });
        try {
          await commitBet({ market: r.market, bettor: r.wallet, commitment: r.commitment, stakeCommitment: r.stakeCommitment, signature });
        } catch (e) {
          if ((e as ResolverError)?.status !== 409) throw e; // 409 = already committed (idempotent retry)
        }
        r = updateReceipt(r, { stage: "committed" });
        setReceipt(r);
      }

      if (r.stage === "committed") {
        // A previous attempt may have sent the Rings transfer without seeing confirmation.
        if (r.ringsTxSignature) {
          const { value } = await connection.getSignatureStatuses([r.ringsTxSignature], { searchTransactionHistory: true });
          const st = value[0];
          if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
            r = updateReceipt(r, { stage: "staked" });
            setReceipt(r);
          } else if (st && !st.err) {
            throw new Error("Your previous stake transfer is still confirming. Wait a minute, then continue.");
          } else {
            r = updateReceipt(r, { ringsTxSignature: undefined });
            setReceipt(r);
          }
        }
      }

      if (r.stage === "committed") {
        const stake = await loadStake();
        const id = await getIdentity(stake);
        setRun({ busy: true, label: "Step 2/3 · Checking your shielded balance." });
        const rings = await stake.loadRings();
        const bal = await rings.getShieldedBalance(id);
        setShieldedBal(bal);
        const amt = BigInt(r.amount);
        if (bal < amt) {
          setShortfall(amt - bal);
          setRun({ busy: false, info: `Your shielded balance is ${fmtLamports(bal)} SOL. Shield at least ${fmtLamports(amt - bal, 9)} SOL to fund this bet privately.` });
          return;
        }
        setRun({ busy: true, label: "Step 2/3 · Building the private transfer and its zero-knowledge proof (~10–30s)." });
        const marketShieldedAddressHex = await getMarketShieldedAddress(r.market);
        const prepared = await stake.preparePrivateStake({ identity: id, payer: publicKey.toBase58(), marketShieldedAddressHex, lamports: amt });
        let sent: string | undefined;
        try {
          sent = await signAndSend(prepared, wallet, connection, (step, sig) => {
            if (sig) {
              sent = sig;
              r = updateReceipt(r, { ringsTxSignature: sig });
              setReceipt(r);
            }
            setRun({ busy: true, label: step === "signing" ? "Step 2/3 · Approve the private stake in your wallet." : step === "sending" ? "Step 2/3 · Sending to Solana mainnet." : "Step 2/3 · Waiting for confirmation.", signature: sig });
          });
        } catch (e) {
          const sig = (e as { signature?: string })?.signature ?? sent;
          if (sig) {
            r = updateReceipt(r, { ringsTxSignature: sig });
            setReceipt(r);
          }
          throw e;
        }
        r = updateReceipt(r, { stage: "staked", ringsTxSignature: sent });
        setReceipt(r);
        setShieldedBal(bal - amt);
      }

      if (r.stage === "staked") {
        setRun({ busy: true, label: "Step 3/3 · Proving your stake to the market.", signature: r.ringsTxSignature });
        await claimStake(
          { market: r.market, bettor: r.wallet, amount: r.amount, salt2: r.salt2, ringsTxSignature: r.ringsTxSignature ?? "" },
          (n) => setRun({ busy: true, label: `Step 3/3 · Waiting for the Rings indexer to see your transfer (try ${n + 1})…`, signature: r.ringsTxSignature }),
        );
        r = updateReceipt(r, { stage: "claimed" });
        setReceipt(r);
        setRun({ busy: false, info: "Your bet is sealed and staked. Come back after the deadline to reveal it." });
        return;
      }
      setRun({ busy: false });
    } catch (e) {
      setRun({ busy: false, error: errMessage(e), signature: (e as { signature?: string })?.signature });
    }
  }, [publicKey, signMessage, connection, wallet, getIdentity]);

  const onSeal = async () => {
    if (!publicKey) return setVisible(true);
    if (!signMessage) return setRun({ busy: false, error: "This wallet can't sign messages. Use Phantom or Solflare with a software key." });
    if (!m || phase !== "open" || !side) return;
    const lamports = parseSolInput(amount);
    if (lamports === null || lamports <= BigInt(0)) return setRun({ busy: false, error: "Enter an amount in SOL (up to 9 decimals)." });
    try {
      const bettor = publicKey.toBase58();
      const salt = randomSaltHex();
      const salt2 = randomSaltHex();
      const [commitment, stakeC] = await Promise.all([sideCommitment(side, salt, bettor), stakeCommitment(lamports, salt2, bettor)]);
      const ts = new Date().toISOString();
      const r: BetReceipt = { v: 1, kind: "stovia-bet-receipt", wallet: bettor, market: m.market, mint: m.mint, symbol: m.symbol, side, salt, amount: lamports.toString(), salt2, commitment, stakeCommitment: stakeC, stage: "draft", createdAt: ts, updatedAt: ts };
      // Secrets are persisted BEFORE anything is signed. No storage -> force a file backup.
      if (!saveReceipt(r)) downloadReceipt(r);
      setReceipt(r);
      void advance(r);
    } catch (e) {
      setRun({ busy: false, error: errMessage(e) });
    }
  };

  const onShield = async () => {
    if (!publicKey || !receipt || shortfall === null) return;
    try {
      const stake = await loadStake();
      const id = await getIdentity(stake);
      // Small buffer so rounding / fees on the private transfer never leave it 1 lamport short.
      const lamports = shortfall + BigInt(1_000_000);
      setRun({ busy: true, label: "Building the shield deposit." });
      const prepared = await stake.prepareShield(id, publicKey.toBase58(), lamports);
      const sig = await signAndSend(prepared, wallet, connection, (step, s) =>
        setRun({ busy: true, label: step === "signing" ? "Approve the shield deposit in your wallet." : step === "sending" ? "Sending to Solana mainnet." : "Waiting for confirmation.", signature: s }),
      );
      setRun({ busy: true, label: "Shielded. Waiting for the privacy indexer to credit your balance…", signature: sig });
      const rings = await stake.loadRings();
      const need = BigInt(receipt.amount);
      for (let i = 0; i < 20; i++) {
        const bal = await rings.getShieldedBalance(id);
        setShieldedBal(bal);
        if (bal >= need) {
          setShortfall(null);
          return void advance(receipt);
        }
        await new Promise((res) => setTimeout(res, 3000));
      }
      setRun({ busy: false, info: "Shield confirmed but not indexed yet. Press Continue in a minute.", signature: sig });
    } catch (e) {
      setRun({ busy: false, error: errMessage(e), signature: (e as { signature?: string })?.signature });
    }
  };

  const onReveal = async () => {
    if (!receipt || !signMessage) return;
    try {
      setRun({ busy: true, label: "Sign your reveal in your wallet (no fee)." });
      const signature = await signText(signMessage, revealMessage(receipt.market, receipt.side, receipt.salt));
      setRun({ busy: true, label: "Revealing your side." });
      try {
        await revealBet({ market: receipt.market, bettor: receipt.wallet, side: receipt.side, salt: receipt.salt, signature });
      } catch (e) {
        if ((e as ResolverError)?.status !== 409) throw e;
      }
      const r = updateReceipt(receipt, { stage: "revealed" });
      setReceipt(r);
      setRun({ busy: false, info: "Revealed. Payouts open once the market settles." });
      detail.reload();
    } catch (e) {
      setRun({ busy: false, error: errMessage(e) });
    }
  };

  const onClaimPayout = async () => {
    if (!receipt || !signMessage || !publicKey) return;
    try {
      setRun({ busy: true, label: "Sign your claim request (no fee)." });
      const authSig = await signText(signMessage, claimMessage(receipt.market));
      setRun({ busy: true, label: "Building your payout transaction." });
      const built = await buildClaim({ market: receipt.market, bettor: receipt.wallet, signature: authSig });
      const stake = await loadStake();
      const prepared = stake.prepareResolverTx(built.tx);
      const sig = await signAndSend(prepared, wallet, connection, (step, s) =>
        setRun({ busy: true, label: step === "signing" ? "Approve the payout in your wallet." : step === "sending" ? "Sending to Solana mainnet." : "Waiting for confirmation.", signature: s }),
      );
      await claimSubmitted({ market: receipt.market, bettor: receipt.wallet, signature: sig }).catch(() => undefined);
      const r = updateReceipt(receipt, { stage: "paid", claimTxSignature: sig });
      setReceipt(r);
      setRun({ busy: false, info: "Payout claimed.", signature: sig });
    } catch (e) {
      setRun({ busy: false, error: errMessage(e), signature: (e as { signature?: string })?.signature });
    }
  };

  const onImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const r = await readReceiptFile(file);
      if (addr && r.wallet !== addr) throw new Error(`This receipt belongs to wallet ${shortAddr(r.wallet)}. Connect that wallet to use it.`);
      const existing = loadReceipt(r.wallet, r.market);
      const merged = existing && atLeast(existing.stage, r.stage) && existing.salt === r.salt ? existing : r;
      imported.current = merged;
      const stored = saveReceipt(merged);
      if (r.market === marketId) setReceipt(addr ? merged : null);
      else selectMarket(r.market);
      if (!stored) setRun({ busy: false, info: "Receipt loaded for this session only (browser storage is unavailable)." });
      else if (!addr) setRun({ busy: false, info: `Receipt imported. Connect wallet ${shortAddr(r.wallet)} to use it.` });
    } catch (err) {
      setRun({ busy: false, error: (err as Error).message });
    }
  };

  /* ---------------- render ---------------- */

  const won = receipt && m ? winningSide(m.status) === receipt.side : false;
  const settled = phase === "survived" || phase === "died";
  const lamports = parseSolInput(amount);
  const canSeal = !!m && phase === "open" && side !== null && lamports !== null && lamports > BigInt(0) && !run.busy;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_1fr]">
      <div className="min-w-0 space-y-6">
        <Panel kicker="Market" title="Will it survive?">
          <Field label="Market" htmlFor="b-market" hint={markets.status === "error" ? "Couldn't load the market list. Paste a market address instead." : undefined}>
            {list.length > 0 ? (
              <select id="b-market" className={`${inputCls} appearance-none`} value={marketId} onChange={(e) => selectMarket(e.target.value)}>
                <option value="">{openList.length ? "Choose an open market…" : "No open markets — pick any to view"}</option>
                {(openList.length ? openList : list).map((x) => (
                  <option key={x.market} value={x.market}>${x.symbol} — {x.name}</option>
                ))}
                {marketId && !list.some((x) => x.market === marketId) && <option value={marketId}>{shortAddr(marketId, 6, 6)}</option>}
                {marketId && openList.length > 0 && !openList.some((x) => x.market === marketId) && list.some((x) => x.market === marketId) && (
                  <option value={marketId}>${list.find((x) => x.market === marketId)?.symbol} (closed)</option>
                )}
              </select>
            ) : (
              <input id="b-market" className={`${inputCls} font-mono text-sm`} value={marketId} onChange={(e) => selectMarket(e.target.value.trim())} placeholder={markets.status === "loading" ? "Loading markets…" : "Market address"} autoComplete="off" spellCheck={false} />
            )}
          </Field>

          {marketId && detail.status === "loading" && <div className="mt-5 h-20 animate-pulse rounded-sm bg-ink-3/70" />}
          {marketId && detail.status === "error" && !m && <p role="alert" className="mt-5 border-l-2 border-blood-hot pl-3 text-sm text-bone">Couldn&apos;t load this market. {detail.message}</p>}
          {m && phase && (
            <div className="mt-5 space-y-4 rounded-sm border border-line bg-ink/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-display text-lg font-bold text-bone">{m.name} <span className="font-mono text-sm text-gold">${m.symbol}</span></p>
                  <p className="font-mono text-xs text-bone-dim" suppressHydrationWarning>{phaseClock(m, phase, now)} · {m.commitments ?? 0} sealed</p>
                </div>
                <div className="flex items-center gap-2">
                  <PhaseChip phase={phase} />
                  <Link href={`/app/token/${encodeURIComponent(m.mint)}`} className="inline-flex h-8 items-center gap-1 rounded-full border border-line px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim transition hover:border-gold hover:text-gold">
                    <LineChart className="h-3.5 w-3.5" aria-hidden /> Token
                  </Link>
                </div>
              </div>
              <McapBar m={m} />
              <p className="text-xs text-bone-dim">Survives if the TWAP market cap is at or above target at the deadline. Reveal window closes {fmtCountdown(m.revealEnds, now) === "now" ? "now" : `in ${fmtCountdown(m.revealEnds, now)}`}.</p>
            </div>
          )}
        </Panel>

        {!addr ? (
          <Panel kicker="Your sealed bet" title="Connect to bet">
            <p className="text-bone-dim">Your wallet signs the commitment and funds the private stake. Stovia never holds your keys.</p>
            <button type="button" onClick={() => setVisible(true)} className="mt-5 inline-flex h-12 items-center gap-2 rounded-sm bg-gold px-6 font-display font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
              <Wallet className="h-4 w-4" aria-hidden /> Connect wallet
            </button>
          </Panel>
        ) : receipt ? (
          <Panel kicker="Your sealed bet" title={<>You bet <span className={receipt.side === 1 ? "text-gold" : "text-blood-hot"}>{receipt.side === 1 ? "YES" : "NO"}</span> · {fmtLamports(BigInt(receipt.amount))} SOL</>}>
            <Stepper stage={receipt.stage} settled={settled} won={won} />
            <div className="mt-6 space-y-3">
              {!atLeast(receipt.stage, "claimed") && phase !== null && (
                phase === "open" || atLeast(receipt.stage, "committed") ? (
                  shortfall !== null ? (
                    <div className="space-y-3 rounded-sm border border-gold/40 bg-gold/5 p-4">
                      <p className="text-sm text-bone">Bets are paid from your <span className="text-gold">shielded</span> balance so the amount never sits next to your wallet on-chain.</p>
                      <div className="flex flex-wrap gap-3">
                        <ActionButton onClick={onShield} busy={run.busy} icon={<ShieldCheck className="h-4 w-4" aria-hidden />}>Shield {fmtLamports(shortfall + BigInt(1_000_000))} SOL first</ActionButton>
                        <Link href="/app/vault" className="inline-flex h-12 items-center rounded-sm border border-line px-4 font-mono text-xs uppercase tracking-[0.14em] text-bone-dim hover:border-gold hover:text-gold">Open vault</Link>
                      </div>
                    </div>
                  ) : (
                    <ActionButton onClick={() => advance(receipt)} busy={run.busy} icon={<KeyRound className="h-4 w-4" aria-hidden />}>
                      {receipt.stage === "draft" ? "Sign commitment" : receipt.stage === "committed" ? "Fund private stake" : "Prove stake"}
                    </ActionButton>
                  )
                ) : (
                  <p className="text-sm text-bone-dim">This market closed before your commitment was recorded. Nothing was staked.</p>
                )
              )}
              {receipt.stage === "claimed" && phase === "open" && <p className="text-sm text-bone-dim">Sealed and staked. Reveal opens when the market closes {now != null && m?.deadline ? `in ${fmtCountdown(m.deadline, now)}` : "at the deadline"}.</p>}
              {receipt.stage === "claimed" && phase === "revealing" && (
                <ActionButton onClick={onReveal} busy={run.busy} icon={<Unlock className="h-4 w-4" aria-hidden />} tone={receipt.side === 2 ? "blood" : "gold"}>Reveal my bet</ActionButton>
              )}
              {receipt.stage === "claimed" && (phase === "settling" || settled) && <p className="text-sm text-bone-dim">The reveal window closed before this bet was revealed. Unrevealed stakes go to the treasury.</p>}
              {receipt.stage === "revealed" && !settled && <p className="text-sm text-bone-dim">Revealed. Waiting for the market to settle.</p>}
              {receipt.stage === "revealed" && settled && won && (
                <ActionButton onClick={onClaimPayout} busy={run.busy} icon={<Trophy className="h-4 w-4" aria-hidden />}>Claim payout</ActionButton>
              )}
              {receipt.stage === "revealed" && settled && !won && <p className="text-sm text-bone-dim">The token {m?.status}. This bet didn&apos;t win.</p>}
              {receipt.stage === "paid" && (
                <p className="text-sm text-gold">
                  Payout claimed.{" "}
                  {receipt.claimTxSignature && <a className="underline" href={solscanTx(receipt.claimTxSignature)} target="_blank" rel="noreferrer">View tx</a>}
                </p>
              )}
            </div>
            {shieldedBal !== null && <p className="mt-4 font-mono text-[11px] text-bone-dim">Shielded balance · {fmtLamports(shieldedBal)} SOL</p>}
            <RunStatus run={run} />
            {!atLeast(receipt.stage, "revealed") && (
              <div className="mt-6 flex items-start gap-3 border-t border-line pt-5">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-blood-hot" aria-hidden />
                <div className="text-sm text-bone-dim">
                  <p><span className="font-semibold text-bone">Back up this receipt.</span> It holds the secret salts needed to reveal. It lives only in this browser; if you lose it, the bet can&apos;t be revealed and the stake goes to the treasury.</p>
                  <button type="button" onClick={() => downloadReceipt(receipt)} className="mt-3 inline-flex h-10 items-center gap-2 rounded-sm border border-gold/60 px-4 font-mono text-xs uppercase tracking-[0.14em] text-gold transition hover:bg-gold/10 focus-visible:outline-2 focus-visible:outline-gold">
                    <Download className="h-4 w-4" aria-hidden /> Download bet receipt
                  </button>
                </div>
              </div>
            )}
          </Panel>
        ) : (
          <Panel kicker="Your sealed bet" title="Pick a side">
            <div className="space-y-6">
              <fieldset disabled={!m || phase !== "open"} className="disabled:opacity-50">
                <legend className="mb-2 block font-mono text-[11px] uppercase tracking-[0.18em] text-bone-dim">Your side</legend>
                <div className="grid grid-cols-2 gap-3">
                  {([1, 2] as const).map((v) => {
                    const on = side === v;
                    const yes = v === 1;
                    return (
                      <label key={v} className={`relative flex cursor-pointer flex-col items-start overflow-hidden rounded-sm border p-4 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-gold sm:p-5 ${on ? (yes ? "border-gold bg-gold/10" : "border-blood-hot bg-blood/20") : "border-line hover:border-bone-dim"}`}>
                        <input type="radio" name="side" value={v} checked={on} onChange={() => setSide(v)} className="sr-only" />
                        <span className={`font-display text-4xl font-extrabold tracking-tight sm:text-5xl ${yes ? "text-gold" : "text-blood-hot"}`}>{yes ? "YES" : "NO"}</span>
                        <span className="mt-1 font-serif text-lg italic text-bone-dim">{yes ? "it survives" : "it dies"}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <Field label="Amount (SOL)" htmlFor="b-amount" hint="Paid privately from your shielded balance through Helius Privacy Rings.">
                <input id="b-amount" inputMode="decimal" autoComplete="off" className={`${inputCls} font-mono text-lg`} value={amount} onChange={(e) => setAmount(e.target.value.replace(",", "."))} placeholder="0.00" disabled={!m || phase !== "open"} />
                <div className="mt-2 flex flex-wrap gap-2">
                  {QUICK.map((q) => (
                    <button key={q} type="button" onClick={() => setAmount(q)} className="rounded-full border border-line px-3 py-1 font-mono text-xs text-bone-dim transition hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-gold">{q} SOL</button>
                  ))}
                </div>
              </Field>

              <ActionButton onClick={onSeal} busy={run.busy} disabled={!canSeal} tone={side === 2 ? "blood" : "gold"} icon={<KeyRound className="h-4 w-4" aria-hidden />}>
                {!marketId ? "Choose a market" : m && phase !== "open" ? "Betting closed" : `Seal ${side === 1 ? "YES" : side === 2 ? "NO" : "bet"}${lamports && lamports > BigInt(0) ? ` · ${fmtLamports(lamports)} SOL` : ""}`}
              </ActionButton>
              <p className="text-xs text-bone-dim">You&apos;ll sign a commitment (free), unlock your shielded balance (free), then approve one private transfer. A receipt with your secret salts is saved in this browser first — download a backup.</p>
              <RunStatus run={run} />
            </div>
          </Panel>
        )}
      </div>

      <div className="min-w-0 space-y-6">
        <Panel kicker="How sealing works" title={<>Nobody sees your <span className="font-serif font-normal italic text-gold">hand</span>.</>}>
          <ol className="space-y-6">
            <Step icon={<KeyRound className="h-5 w-5" />} n="01" title="Commit your side">
              Your wallet signs a hash of <span className="font-mono text-bone">side + secret salt</span>. YES and NO look identical until you reveal.
            </Step>
            <Step icon={<EyeOff className="h-5 w-5" />} n="02" title="Stake privately">
              The SOL moves from your shielded balance through Helius <span className="text-bone">Privacy Rings</span> to the market. The amount never appears next to your wallet.
            </Step>
            <Step icon={<Unlock className="h-5 w-5" />} n="03" title="Reveal, then claim">
              After the deadline you reveal with your receipt. Winners split the losing side; unrevealed stakes go to the treasury.
            </Step>
          </ol>
          <div className="mt-7 flex items-start gap-2 border-t border-line pt-5 font-mono text-[11px] leading-relaxed text-bone-dim">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
            <span>Ring program {shortAddr(STOVIA.privacyRings.program, 6, 4)} · mainnet · Privacy Rings is in beta, start small.</span>
          </div>
        </Panel>

        <Panel kicker="Another device?" title="Import a receipt">
          <p className="text-sm text-bone-dim">Placed a bet elsewhere? Import its receipt file to reveal or claim from here. Receipts never leave your browser.</p>
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={onImport} aria-label="Import bet receipt file" />
          <button type="button" onClick={() => fileRef.current?.click()} className="mt-4 inline-flex h-11 items-center gap-2 rounded-sm border border-line px-4 font-mono text-xs uppercase tracking-[0.14em] text-bone-dim transition hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-gold">
            <FileUp className="h-4 w-4" aria-hidden /> Import receipt
          </button>
        </Panel>
      </div>
    </div>
  );
}

const STEPS: { stage: Stage; label: string }[] = [
  { stage: "committed", label: "Commitment signed" },
  { stage: "staked", label: "Private stake sent" },
  { stage: "claimed", label: "Stake proven" },
  { stage: "revealed", label: "Revealed" },
  { stage: "paid", label: "Payout claimed" },
];

function Stepper({ stage, settled, won }: { stage: Stage; settled: boolean; won: boolean }) {
  const steps = settled && !won && atLeast(stage, "revealed") ? STEPS.slice(0, 4) : STEPS;
  const activeIdx = steps.findIndex((s) => !atLeast(stage, s.stage));
  return (
    <ol className="grid grid-cols-1 gap-2 sm:grid-cols-5">
      {steps.map((s, i) => {
        const done = atLeast(stage, s.stage);
        const active = i === activeIdx;
        return (
          <li key={s.stage} className={`flex items-center gap-2 rounded-sm border px-3 py-2 text-xs sm:flex-col sm:items-start ${done ? "border-gold/50 text-bone" : active ? "border-bone-dim/60 text-bone" : "border-line text-bone-dim/60"}`}>
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px] ${done ? "border-gold bg-gold text-ink" : "border-current"}`}>{done ? <Check className="h-3 w-3" aria-hidden /> : i + 1}</span>
            <span>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ActionButton({ children, onClick, busy, disabled, icon, tone = "gold" }: { children: ReactNode; onClick: () => void; busy: boolean; disabled?: boolean; icon?: ReactNode; tone?: "gold" | "blood" }) {
  const cls = tone === "blood" ? "bg-blood text-bone hover:bg-blood-hot" : "bg-gold text-ink hover:bg-gold-hot";
  return (
    <button type="button" onClick={onClick} disabled={busy || disabled} className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-sm px-6 font-display font-bold transition disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold sm:w-auto ${cls}`}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {busy ? "Working…" : children}
    </button>
  );
}

function RunStatus({ run }: { run: Run }) {
  const text = run.error ?? run.label ?? run.info;
  return (
    <AnimatePresence>
      {text && (
        <motion.div role={run.error ? "alert" : "status"} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={`mt-4 border-l-2 pl-3 text-sm ${run.error ? "border-blood-hot text-bone" : run.busy ? "border-bone-dim/50 text-bone-dim" : "border-gold text-bone"}`}>
          <p>{text}</p>
          {run.signature && (
            <a href={solscanTx(run.signature)} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-gold hover:text-gold-hot">
              View on Solscan <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Step({ icon, n, title, children }: { icon: ReactNode; n: string; title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-gold/40 text-gold" aria-hidden>{icon}</span>
      <div>
        <p className="font-display font-bold text-bone"><span className="mr-2 font-mono text-xs text-gold">{n}</span>{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-bone-dim">{children}</p>
      </div>
    </li>
  );
}
