"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Download, Lock, RefreshCw } from "lucide-react";
import { getMarkets, getPortfolio, marketPhase, winningSide, type Portfolio, type PortfolioBet, type ResolverMarket } from "@/lib/markets/resolver";
import { atLeast, downloadReceipt, listReceipts, type BetReceipt } from "@/lib/markets/receipts";
import { fmtCountdown, fmtLamports, useResolver } from "@/lib/markets/hooks";
import { useNow } from "@/lib/useApi";
import { fmtSol, shortAddr } from "@/lib/format";
import { useSolBalance } from "@/components/wallet/useSolBalance";
import { ConnectGate } from "./ConnectGate";
import { EmptyState, Panel, Skeleton, Stat, TokenAvatar } from "./ui";
import { McapBar, PhaseChip } from "./MarketsList";

export function PortfolioView() {
  return (
    <ConnectGate title="Your hand is empty." body="Connect a mainnet wallet to see your sealed positions and launches. Bet secrets stay in this browser — never on our servers.">
      {(addr) => <Inner addr={addr} />}
    </ConnectGate>
  );
}

type Action = { kind: "finish" | "reveal" | "claim" | "missing" | "none"; text: string };
type Row = { market: string; m?: ResolverMarket; receipt?: BetReceipt; server?: PortfolioBet; action: Action };

function actionFor(m: ResolverMarket | undefined, r: BetReceipt | undefined, s: PortfolioBet | undefined, now: number | null): Action {
  if (!m) return { kind: "none", text: "Market data unavailable" };
  const phase = marketPhase(m, now);
  const settled = phase === "survived" || phase === "died";
  const revealed = (r && atLeast(r.stage, "revealed")) || s?.revealed;
  const paid = r?.stage === "paid" || s?.claimed;
  const side = r?.side ?? s?.side;
  const won = s?.won ?? (side != null && winningSide(m.status) === side);
  if (paid) return { kind: "none", text: "Payout claimed" };
  if (settled && revealed && (s?.claimable ?? won)) return { kind: "claim", text: s?.payoutLamports != null ? `Claim ${fmtLamports(s.payoutLamports)} SOL` : "Claim payout" };
  if (settled) return { kind: "none", text: revealed ? "Didn't win" : "Not revealed · forfeited" };
  if (phase === "revealing" && !revealed) {
    if (!r) return { kind: "missing", text: "Reveal due · import your receipt" };
    if (atLeast(r.stage, "claimed")) return { kind: "reveal", text: `Reveal due · ${fmtCountdown(m.revealEnds, now)} left` };
  }
  if (r && !atLeast(r.stage, "claimed")) return phase === "open" ? { kind: "finish", text: "Finish placing this bet" } : { kind: "none", text: "Not placed before close" };
  if (phase === "open") return { kind: "none", text: `Sealed · reveal in ${fmtCountdown(m.deadline, now)}` };
  return { kind: "none", text: revealed ? "Revealed · awaiting settlement" : "Settling" };
}

const ACTION_CLS: Record<Action["kind"], string> = {
  claim: "bg-gold text-ink",
  reveal: "bg-gold/15 text-gold border border-gold/50",
  finish: "border border-bone-dim/50 text-bone",
  missing: "border border-blood-hot/60 text-blood-hot",
  none: "text-bone-dim",
};

function Inner({ addr }: { addr: string }) {
  const { balance } = useSolBalance();
  const now = useNow(1000);
  const markets = useResolver<ResolverMarket[]>(getMarkets, [], 30_000);
  const portfolio = useResolver<Portfolio>(() => getPortfolio(addr), [addr], 30_000);
  const [receipts, setReceipts] = useState<BetReceipt[]>([]);
  useEffect(() => setReceipts(listReceipts(addr)), [addr]);

  const byMarket = useMemo(() => new Map((markets.status === "ready" ? markets.data : []).map((m) => [m.market, m])), [markets]);
  const rows: Row[] = useMemo(() => {
    const server = portfolio.status === "ready" ? portfolio.data.bets : [];
    const ids = new Set<string>([...receipts.map((r) => r.market), ...server.map((b) => b.market)]);
    return [...ids].map((id) => {
      const m = byMarket.get(id);
      const receipt = receipts.find((r) => r.market === id);
      const s = server.find((b) => b.market === id);
      return { market: id, m, receipt, server: s, action: actionFor(m, receipt, s, now) };
    });
  }, [receipts, portfolio, byMarket, now]);

  const due = rows.filter((r) => r.action.kind !== "none");
  const launches = useMemo(() => {
    const ids = new Set(portfolio.status === "ready" ? portfolio.data.launches : []);
    return (markets.status === "ready" ? markets.data : []).filter((m) => m.creator === addr || ids.has(m.market) || ids.has(m.mint));
  }, [markets, portfolio, addr]);
  const loading = markets.status === "loading" || portfolio.status === "loading";

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Wallet" value={<span className="font-mono text-xl sm:text-2xl">{shortAddr(addr)}</span>} />
        <Stat label="SOL balance" value={fmtSol(balance, 3)} tone="gold" />
        <Stat label="Sealed positions" value={loading && rows.length === 0 ? "—" : String(rows.length)} />
        <Stat label="Action needed" value={String(due.length)} tone={due.length ? "blood" : undefined} />
      </div>

      {(markets.status === "error" || portfolio.status === "error") && (
        <p role="status" className="flex flex-wrap items-center gap-3 border-l-2 border-blood-hot pl-3 text-sm text-bone-dim">
          The resolver isn&apos;t answering, so some positions may be missing. Local receipts are still shown.
          <button type="button" onClick={() => { markets.reload(); portfolio.reload(); }} className="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-[0.14em] text-gold hover:text-gold-hot">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
          </button>
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel kicker="Sealed" title="Your positions">
          {loading && rows.length === 0 ? (
            <Skeleton rows={3} />
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing sealed yet." body={<>Bets you seal appear here with a <Lock className="inline h-3.5 w-3.5" aria-hidden /> until you reveal them after each deadline.</>}>
              <Link href="/app/bets" className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-gold hover:text-gold-hot">
                Place a sealed bet <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {[...due, ...rows.filter((r) => r.action.kind === "none")].map((row) => {
                const side = row.receipt?.side ?? row.server?.side;
                const amt = row.receipt ? BigInt(row.receipt.amount) : row.server?.stakeLamports ?? null;
                return (
                  <li key={row.market} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
                    <TokenAvatar src={row.m?.image} ticker={row.m?.symbol ?? row.receipt?.symbol ?? "?"} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold text-bone">
                        {row.m?.name ?? (row.receipt?.symbol ? `$${row.receipt.symbol}` : shortAddr(row.market))}{" "}
                        {side != null && <span className={`font-mono text-xs ${side === 1 ? "text-gold" : "text-blood-hot"}`}>{side === 1 ? "YES" : "NO"}</span>}
                      </p>
                      <p className="font-mono text-xs text-bone-dim">{amt != null ? `${fmtLamports(amt)} SOL` : "sealed amount"}{row.receipt ? "" : " · no local receipt"}</p>
                    </div>
                    {row.m && <PhaseChip phase={marketPhase(row.m, now)} />}
                    <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
                      {row.receipt && !atLeast(row.receipt.stage, "revealed") && (
                        <button type="button" onClick={() => downloadReceipt(row.receipt!)} aria-label="Download bet receipt" title="Download bet receipt" className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-line text-bone-dim transition hover:border-gold hover:text-gold">
                          <Download className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      )}
                      <Link href={`/app/bets?market=${encodeURIComponent(row.market)}`} className={`inline-flex h-8 items-center gap-1 rounded-full px-3 font-mono text-[11px] uppercase tracking-[0.12em] transition hover:opacity-90 ${ACTION_CLS[row.action.kind]}`} suppressHydrationWarning>
                        {row.action.text} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-5 border-t border-line pt-4 text-xs text-bone-dim">
            Receipts live only in this browser. Keep a downloaded copy of each until you&apos;ve revealed; without it the bet can&apos;t be revealed and its stake goes to the treasury.{" "}
            <Link href="/app/bets" className="text-gold hover:text-gold-hot">Import a receipt</Link>
          </p>
        </Panel>

        <Panel kicker="Created" title="Your launches">
          {markets.status === "loading" && <Skeleton rows={3} />}
          {markets.status === "error" && <p className="text-sm text-bone-dim">Launches will appear when the resolver is back.</p>}
          {markets.status === "ready" && launches.length === 0 && (
            <EmptyState title="No launches." body="You haven't launched a token from this wallet yet.">
              <Link href="/app/launch" className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-gold hover:text-gold-hot">
                Launch one <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            </EmptyState>
          )}
          {launches.length > 0 && (
            <ul className="divide-y divide-line">
              {launches.map((m) => (
                <li key={m.market}>
                  <Link href={`/app/token/${encodeURIComponent(m.mint)}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-4 py-4 transition hover:bg-ink-2/60">
                    <TokenAvatar src={m.image} ticker={m.symbol} />
                    <div className="min-w-0">
                      <p className="truncate font-bold text-bone">{m.name} <span className="font-mono text-xs text-gold">${m.symbol}</span></p>
                      <McapBar m={m} />
                    </div>
                    <PhaseChip phase={marketPhase(m, now)} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
