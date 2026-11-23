"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { StoviaLogo } from "@/components/brand/StoviaLogo";
import { PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import { EmptyState, Panel, Skeleton, Stat, TokenAvatar } from "@/components/app/ui";
import { TradePanel } from "@/components/app/TradePanel";
import { fmtNum, fmtSol, shortAddr } from "@/lib/format";
import { errText, solscanAccount, solscanTx } from "@/lib/admin/tx";
import { DBC_CONFIG, FEE_BREAKDOWN_BPS } from "@/lib/dbc/constants";
import { poolAddressForMint, readPool, readTokenMeta, type PoolView, type TokenMeta } from "@/lib/dbc/client";

type State = { s: "loading" } | { s: "error"; msg: string } | { s: "missing" } | { s: "ready"; view: PoolView; meta: TokenMeta | null };

const REFRESH_MS = 15_000;

export function TokenView({ mint, launchTx, registrationPending }: { mint: string; launchTx?: string; registrationPending?: boolean }) {
  const { connection } = useConnection();
  const mintKey = useMemo(() => {
    try {
      return new PublicKey(mint);
    } catch {
      return null;
    }
  }, [mint]);
  const pool = useMemo(() => (mintKey ? poolAddressForMint(mintKey) : null), [mintKey]);
  const [state, setState] = useState<State>({ s: "loading" });
  const [meta, setMeta] = useState<TokenMeta | null>(null);

  const load = useCallback(async () => {
    if (!mintKey || !pool) return;
    try {
      const view = await readPool(connection, pool);
      if (!view) return setState({ s: "missing" });
      setState({ s: "ready", view, meta: null });
    } catch (e) {
      // A failed background refresh keeps the last good view on screen.
      setState((prev) => (prev.s === "ready" ? prev : { s: "error", msg: errText(e) }));
    }
  }, [connection, mintKey, pool]);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!mintKey) return;
    readTokenMeta(connection, mintKey).then(setMeta).catch(() => setMeta(null));
  }, [connection, mintKey]);

  const symbol = meta?.symbol || "TOKEN";

  return (
    <div className="relative min-h-[calc(100dvh-96px)] overflow-hidden bg-ink">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_85%_0%,rgba(224,161,0,0.07),transparent_50%),radial-gradient(ellipse_at_0%_100%,rgba(142,11,11,0.18),transparent_45%)]" />
      <header className="relative z-10 flex h-14 items-center justify-between gap-3 border-b border-line px-4 sm:px-8">
        <Link href="/app/markets" className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone-dim transition hover:text-gold">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Markets
        </Link>
        <Link href="/" className="font-display text-base font-extrabold tracking-tight text-bone">
          <StoviaLogo markClassName="h-6 w-6" textClassName="text-[22px]" />
        </Link>
      </header>
      <div className="relative z-10 mx-auto max-w-[1400px] px-4 pb-16 pt-10 sm:px-8 sm:pt-14">
        <div className="flex min-w-0 items-center gap-4">
          <TokenAvatar src={meta?.image ?? undefined} ticker={symbol} />
          <div className="min-w-0">
            <h1 className="truncate font-display text-[clamp(2rem,6vw,4.5rem)] font-extrabold leading-[0.95] tracking-[-0.04em] text-bone">{meta?.name || shortAddr(mint, 6, 6)}</h1>
            <p className="font-mono text-sm text-gold">${symbol}</p>
          </div>
        </div>

        {launchTx && (
          <p role="status" className="mt-6 border-l-2 border-gold pl-3 text-sm text-bone">
            Launched on mainnet.{" "}
            <a className="text-gold underline-offset-2 hover:underline" href={solscanTx(launchTx)} target="_blank" rel="noreferrer">
              View transaction
            </a>
            {registrationPending && <span className="text-bone-dim"> · Survival market registration pending.</span>}
          </p>
        )}

        <div className="mt-10">
          {!mintKey ? (
            <EmptyState title="Not a token address" body="That doesn't look like a Solana mint address." />
          ) : !DBC_CONFIG ? (
            <EmptyState title="Stovia config not created yet" body="Trading opens once the company console creates the Meteora partner config." />
          ) : state.s === "loading" ? (
            <Skeleton rows={3} />
          ) : state.s === "error" ? (
            <EmptyState title="Couldn't load the curve" body={state.msg}>
              <button type="button" onClick={load} className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-5 text-bone hover:border-gold/60">
                <RefreshCw className="h-4 w-4" aria-hidden /> Retry
              </button>
            </EmptyState>
          ) : state.s === "missing" ? (
            <EmptyState title="No Stovia curve for this token" body="This mint has no pool on the Stovia bonding-curve config (yet). If you just launched, give the RPC a few seconds." />
          ) : (
            <Ready view={state.view} symbol={symbol} onTraded={load} />
          )}
        </div>
      </div>
    </div>
  );
}

function Ready({ view, symbol, onTraded }: { view: PoolView; symbol: string; onTraded: () => void }) {
  const pct = Math.round(view.progress * 1000) / 10;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex min-w-0 flex-col gap-6">
        <Panel kicker="Live curve">
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
            <Stat label="Price (SOL)" value={view.priceSol < 0.001 ? view.priceSol.toExponential(3) : fmtSol(view.priceSol, 6)} />
            <Stat label="Market cap" value={`${fmtSol(view.mcapSol, 1)} SOL`} tone="gold" />
            <Stat label="Raised" value={`${fmtSol(Number(view.quoteReserveLamports) / 1e9, 2)} SOL`} />
          </div>
          <div className="mt-8">
            <div className="mb-2 flex justify-between font-mono text-[11px] uppercase tracking-[0.18em] text-bone-dim">
              <span>Bonding curve</span>
              <span className="text-bone">{view.migrated ? "Graduated" : `${pct}%`}</span>
            </div>
            <div className="h-3 overflow-hidden rounded-full border border-line bg-ink" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Bonding curve progress">
              <div className="h-full bg-gold transition-[width] duration-700" style={{ width: `${view.migrated ? 100 : pct}%` }} />
            </div>
            <p className="mt-2 text-xs text-bone-dim">
              Graduates to a Meteora DAMM v2 pool at {fmtNum(Number(view.thresholdLamports) / 1e9)} SOL raised.
            </p>
          </div>
        </Panel>
        <Panel kicker="Survival market">
          <p className="text-sm text-bone-dim">Think it dies before its deadline? Or survives? Place a sealed bet.</p>
          <Link href={`/app/bets?market=${view.pool.toBase58()}`} className="mt-4 inline-flex h-12 items-center gap-2 rounded-sm bg-blood px-5 font-display font-bold text-bone hover:bg-blood-hot">
            Bet on ${symbol}
          </Link>
        </Panel>
        <Panel kicker="On-chain">
          <dl className="space-y-2 font-mono text-xs">
            <Addr k="Mint" v={view.mint.toBase58()} />
            <Addr k="Pool" v={view.pool.toBase58()} />
            <Addr k="Creator" v={view.creator.toBase58()} />
            <Addr k="Config" v={view.config.toBase58()} />
            <div className="flex justify-between gap-3">
              <dt className="uppercase tracking-[0.14em] text-bone-dim">Fees</dt>
              <dd className="text-bone">
                {FEE_BREAKDOWN_BPS.total / 100}% · creator {FEE_BREAKDOWN_BPS.creator / 100}% · Stovia {FEE_BREAKDOWN_BPS.partner / 100}% · Meteora {FEE_BREAKDOWN_BPS.protocol / 100}%
              </dd>
            </div>
          </dl>
        </Panel>
      </div>
      <TradePanel view={view} symbol={symbol} onTraded={onTraded} />
    </div>
  );
}

function Addr({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="uppercase tracking-[0.14em] text-bone-dim">{k}</dt>
      <dd className="min-w-0">
        <a href={solscanAccount(v)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-bone hover:text-gold">
          {shortAddr(v, 6, 6)} <ExternalLink className="h-3 w-3 opacity-60" aria-hidden />
        </a>
      </dd>
    </div>
  );
}
