"use client";

import { useCallback, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";
import { COMPANY_WALLET } from "@/lib/admin/anchor";
import { KeyRound, PlugZap, RefreshCw } from "lucide-react";
import { Panel } from "@/components/app/ui";
import {
  RESOLVER_URL,
  ResolverError,
  authenticate,
  decodeTx,
  fetchPending,
  postSubmitted,
  resolverConfigured,
  serializable,
  type AdminAuth,
  type PendingAction,
} from "@/lib/admin/resolver";
import { confirmSignature, errText, simulate, simulateRaw, type SimResult } from "@/lib/admin/tx";
import { AddrLink, Busy, Note, SimView, TxLink, btnGhost, btnGold } from "./bits";

type ItemState =
  | { s: "idle" }
  | { s: "simulating" }
  | { s: "signing"; sim: SimResult }
  | { s: "sending"; sim: SimResult }
  | { s: "confirming"; sig: string }
  | { s: "reporting"; sig: string }
  | { s: "done"; sig: string; reportError?: string }
  | { s: "error"; error: string; sim?: SimResult; sig?: string };

/**
 * Sign raw v1 bytes through the Wallet Standard `solana:signTransaction` feature (same
 * fallback the vault uses for oversize Rings txs). Existing signatures are preserved.
 */
async function signRawV1(adapter: Adapter | undefined, address: string, raw: Uint8Array): Promise<Uint8Array> {
  type StdAccount = { address: string };
  type StdSign = {
    supportedTransactionVersions?: readonly (number | string)[];
    signTransaction: (...i: { account: StdAccount; transaction: Uint8Array; chain: string }[]) => Promise<{ signedTransaction: Uint8Array }[]>;
  };
  const std = (adapter as unknown as { wallet?: { accounts: readonly StdAccount[]; features: Record<string, unknown> } } | undefined)?.wallet;
  const feature = std?.features["solana:signTransaction"] as StdSign | undefined;
  const account = std?.accounts.find((a) => a.address === address);
  if (!feature || !account || !feature.supportedTransactionVersions?.some((v) => String(v) === "1")) {
    throw new Error("This transaction can only be signed as v1 and your wallet doesn't support version-1 transactions yet. Update Phantom or Solflare, or ask the resolver to split it so it fits a v0 packet.");
  }
  const [out] = await feature.signTransaction({ account, transaction: raw, chain: "solana:mainnet" });
  if (!out?.signedTransaction) throw new Error("Wallet returned no signed transaction.");
  return out.signedTransaction;
}

const isBusy = (st?: ItemState) => !!st && ["simulating", "signing", "sending", "confirming", "reporting"].includes(st.s);

export function ResolverQueue() {
  if (!resolverConfigured()) {
    return (
      <Panel kicker="Resolver" title="Pending actions">
        <Note tone="gold">
          <span className="inline-flex items-center gap-2 font-semibold">
            <PlugZap className="h-4 w-4 text-gold" aria-hidden /> Resolver not connected
          </span>
          <span className="block text-bone-dim">Set NEXT_PUBLIC_RESOLVER_URL to the resolver service to load its signing queue.</span>
        </Note>
      </Panel>
    );
  }
  return <Queue />;
}

function Queue() {
  const { connection } = useConnection();
  const { signMessage, signTransaction, wallet, publicKey } = useWallet();
  const authRef = useRef<AdminAuth | null>(null);
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<PendingAction[] | null>(null);
  const [states, setStates] = useState<Record<string, ItemState>>({});
  const [signingAll, setSigningAll] = useState(false);

  const setItem = (id: string, st: ItemState) => setStates((m) => ({ ...m, [id]: st }));

  const ensureAuth = useCallback(
    async (fresh = false): Promise<AdminAuth> => {
      if (authRef.current && !fresh) return authRef.current;
      if (!signMessage) throw new Error("This wallet can't sign messages — use Phantom or Solflare.");
      const a = await authenticate(signMessage);
      authRef.current = a;
      setAuthed(true);
      return a;
    },
    [signMessage],
  );

  /** Run an authenticated call; on 401/403 re-sign a fresh nonce once. */
  const withAuth = useCallback(
    async <T,>(fn: (a: AdminAuth) => Promise<T>): Promise<T> => {
      try {
        return await fn(await ensureAuth());
      } catch (e) {
        if (e instanceof ResolverError && (e.status === 401 || e.status === 403)) {
          authRef.current = null;
          setAuthed(false);
          return fn(await ensureAuth(true));
        }
        throw e;
      }
    },
    [ensureAuth],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await withAuth(fetchPending);
      setItems(list);
      setStates((m) => {
        const next: Record<string, ItemState> = {};
        for (const it of list) if (m[it.id]) next[it.id] = m[it.id];
        return next;
      });
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [withAuth]);

  const signOne = useCallback(
    async (item: PendingAction): Promise<boolean> => {
      const fail = (error: string, sim?: SimResult, sig?: string) => {
        setItem(item.id, { s: "error", error, sim, sig });
        return false;
      };
      if (!signTransaction || !publicKey) return fail("This wallet can't sign transactions.");
      const dec = decodeTx(item.tx);
      if (!dec.ok) return fail(dec.error);
      const walletName = wallet?.adapter.name ?? "This wallet";
      // null = legacy only; undefined = adapter didn't say (let the wallet decide).
      const supported = wallet?.adapter.supportedTransactionVersions;
      const walletLacks = (v: 0) => supported !== undefined && !(supported?.has(v) ?? false);

      // Normalize to: something to simulate + a function returning signed wire bytes.
      let simulateIt: () => Promise<SimResult>;
      let signIt: () => Promise<Uint8Array>;
      let vLabel: string;
      let note: string | null = null;
      setItem(item.id, { s: "simulating" });

      if (dec.tx === null) {
        // v1 (Privacy Rings payouts / withdrawals): convert with the vault's toWalletTransaction.
        let plan: import("@/lib/admin/v1").V1Plan;
        try {
          const { planV1 } = await import("@/lib/admin/v1");
          plan = planV1(dec.raw);
        } catch (e) {
          return fail(`Could not decode v1 transaction: ${errText(e)}`);
        }
        if (plan.feePayer !== COMPANY_WALLET.toBase58() && plan.mode === "v0") {
          return fail(`Fee payer is ${plan.feePayer}, not the company wallet — refusing to sign.`);
        }
        if (plan.mode === "v0") {
          if (walletLacks(0)) return fail(`${walletName} doesn't support v0 transactions. Use Phantom or Solflare.`);
          const vtx = VersionedTransaction.deserialize(plan.v0);
          vLabel = "v1→v0";
          note = "Converted v1 → v0 (same fee payer, blockhash and program instructions).";
          simulateIt = () => simulate(connection, vtx, false);
          signIt = async () => (await signTransaction(vtx)).serialize();
        } else {
          const raw = plan.v1;
          vLabel = "v1";
          note = `Raw v1 signing (${plan.reason}).`;
          simulateIt = () => simulateRaw(connection, raw);
          signIt = () => signRawV1(wallet?.adapter, publicKey.toBase58(), raw);
        }
      } else {
        const tx = dec.tx;
        vLabel = dec.version === "legacy" ? "legacy" : `v${dec.version}`;
        if (dec.version === 0 && walletLacks(0)) return fail(`${walletName} doesn't support v0 transactions. Use Phantom or Solflare.`);
        if (!serializable(tx)) return fail(`This ${vLabel} transaction can't be re-serialized for the wallet.`);
        simulateIt = () => simulate(connection, tx, false);
        signIt = async () => (await signTransaction(tx)).serialize();
      }

      const sim0 = await simulateIt();
      const sim: SimResult = note ? { ...sim0, logs: [note, ...sim0.logs] } : sim0;
      if (!sim.ok) {
        const stale = /blockhash/i.test(sim.err ?? "");
        return fail(stale ? "Blockhash expired — ask the resolver to rebuild this transaction, then refresh." : "Simulation failed — not signed.", sim);
      }
      setItem(item.id, { s: "signing", sim });
      let raw: Uint8Array;
      try {
        raw = await signIt();
      } catch (e) {
        const msg = errText(e);
        return fail(/version/i.test(msg) ? `${walletName} rejected this ${vLabel} transaction (${msg}).` : `Wallet: ${msg}`, sim);
      }
      let sig: string | undefined;
      try {
        setItem(item.id, { s: "sending", sim });
        sig = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
        setItem(item.id, { s: "confirming", sig });
        await confirmSignature(connection, sig);
      } catch (e) {
        return fail(errText(e), sim, sig);
      }
      setItem(item.id, { s: "reporting", sig });
      try {
        await withAuth((a) => postSubmitted(a, item.id, sig!));
        setItem(item.id, { s: "done", sig });
      } catch (e) {
        setItem(item.id, { s: "done", sig, reportError: errText(e) });
      }
      return true;
    },
    [connection, publicKey, signTransaction, wallet, withAuth],
  );

  const signAll = async () => {
    if (!items) return;
    setSigningAll(true);
    try {
      for (const it of items) {
        if (states[it.id]?.s === "done") continue;
        await signOne(it);
      }
    } finally {
      setSigningAll(false);
    }
  };

  const anyBusy = signingAll || Object.values(states).some(isBusy);
  const remaining = items?.filter((it) => states[it.id]?.s !== "done").length ?? 0;

  return (
    <Panel
      kicker="Resolver"
      title={
        <span className="flex flex-wrap items-center justify-between gap-3">
          Pending actions
          {authed && (
            <span className="flex flex-wrap gap-2">
              <button type="button" className={`${btnGhost} h-9 px-3 text-xs`} onClick={() => void load()} disabled={loading || anyBusy}>
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden /> Refresh
              </button>
              <button type="button" className={`${btnGold} h-9 px-3 text-xs`} onClick={() => void signAll()} disabled={anyBusy || remaining === 0}>
                Sign all ({remaining})
              </button>
            </span>
          )}
        </span>
      }
    >
      <p className="mb-4 break-all font-mono text-[11px] text-bone-dim">{RESOLVER_URL}</p>
      {!authed && !items && (
        <div className="space-y-3">
          <p className="text-sm text-bone-dim">Sign a one-time login message (no transaction, no fee) to prove the company wallet to the resolver.</p>
          <button type="button" className={btnGold} onClick={() => void load()} disabled={loading}>
            <KeyRound className="h-4 w-4" aria-hidden /> {loading ? "Waiting for wallet…" : "Sign in & load queue"}
          </button>
        </div>
      )}
      {error && (
        <div className="mt-4">
          <Note tone="blood">{error}</Note>
        </div>
      )}
      {items && items.length === 0 && <Note>Queue is empty — nothing for the company wallet to sign.</Note>}
      {items && items.length > 0 && (
        <ul className="space-y-4">
          {items.map((it) => (
            <QueueItem key={it.id} item={it} state={states[it.id] ?? { s: "idle" }} disabled={anyBusy} onSign={() => void signOne(it)} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Amounts({ amounts }: { amounts: unknown }) {
  if (amounts == null) return null;
  if (typeof amounts !== "object") return <span className="font-mono text-xs text-bone">{String(amounts)}</span>;
  const entries = Array.isArray(amounts) ? amounts.map((v, i) => [String(i), v] as const) : Object.entries(amounts as Record<string, unknown>);
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-1.5">
          <dt className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">{k}</dt>
          <dd className="font-mono text-xs text-bone">{typeof v === "object" ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function QueueItem({ item, state, disabled, onSign }: { item: PendingAction; state: ItemState; disabled: boolean; onSign: () => void }) {
  const sim = "sim" in state ? state.sim : undefined;
  const sig = "sig" in state ? state.sig : undefined;
  return (
    <li className={`min-w-0 rounded-sm border bg-ink p-4 sm:p-5 ${state.s === "done" ? "border-gold/40" : state.s === "error" ? "border-blood-hot/50" : "border-line"}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {item.kind && <span className="rounded-full border border-gold/50 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-gold">{item.kind}</span>}
            <span className="font-mono text-[10px] text-bone-dim">#{item.id}</span>
          </div>
          <p className="font-display text-base font-semibold text-bone">{item.summary || "(no summary)"}</p>
          {item.market && (
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">Market</span>
              <AddrLink addr={item.market} />
            </div>
          )}
          <Amounts amounts={item.amounts} />
        </div>
        <div className="shrink-0">
          {state.s === "done" ? (
            <span className="font-mono text-xs uppercase tracking-[0.16em] text-gold">Sent</span>
          ) : (
            <button type="button" className={`${btnGold} w-full sm:w-auto`} onClick={onSign} disabled={disabled}>
              {state.s === "error" ? "Retry" : "Sign & send"}
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 space-y-2 empty:hidden">
        {state.s === "simulating" && <Busy label="Simulating…" />}
        {state.s === "signing" && <Busy label="Waiting for wallet signature…" />}
        {state.s === "sending" && <Busy label="Broadcasting…" />}
        {state.s === "confirming" && <Busy label="Confirming…" />}
        {state.s === "reporting" && <Busy label="Reporting to resolver…" />}
        {sim && state.s === "error" && <SimView sim={sim} />}
        {state.s === "error" && <Note tone="blood">{state.error}</Note>}
        {state.s === "done" && state.reportError && <Note tone="gold">Confirmed on-chain, but reporting to the resolver failed: {state.reportError}</Note>}
        {sig && <TxLink sig={sig} />}
      </div>
    </li>
  );
}
