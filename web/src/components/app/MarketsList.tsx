"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight, LineChart, Lock, RefreshCw } from "lucide-react";
import { getMarkets, getStats, marketPhase, type ResolverMarket, type Stats } from "@/lib/markets/resolver";
import { fmtCountdown, fmtLamports, useResolver } from "@/lib/markets/hooks";
import { useNow } from "@/lib/useApi";
import { fmtNum } from "@/lib/format";
import { EmptyState, Skeleton, Stat, TokenAvatar } from "./ui";

type Phase = ReturnType<typeof marketPhase>;

const PHASE_CLS: Record<Phase, string> = {
  open: "border-bone-dim/40 text-bone",
  revealing: "border-gold/50 text-gold",
  settling: "border-gold/30 text-gold/80",
  survived: "border-gold bg-gold/10 text-gold",
  died: "border-blood-hot/60 bg-blood/20 text-blood-hot",
};

export function PhaseChip({ phase }: { phase: Phase }) {
  return <span className={`inline-flex shrink-0 rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${PHASE_CLS[phase]}`}>{phase}</span>;
}

export function McapBar({ m }: { m: ResolverMarket }) {
  const cur = m.twapMcapLamports ?? m.currentMcapLamports;
  const tgt = m.targetMcapLamports;
  const pct = cur != null && tgt != null && tgt > BigInt(0) ? Math.min(1, Number((cur * BigInt(10_000)) / tgt) / 10_000) : 0;
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-2 font-mono text-[11px] text-bone-dim">
        <span className="truncate">{fmtLamports(cur, 2)} SOL mcap</span>
        <span className="truncate">target {fmtLamports(tgt, 2)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-3" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label="Market cap vs target">
        <div className={`h-full ${pct >= 1 ? "bg-gold" : "bg-blood-hot"}`} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

export function phaseClock(m: ResolverMarket, phase: Phase, now: number | null): string {
  if (phase === "open") return `closes in ${fmtCountdown(m.deadline, now)}`;
  if (phase === "revealing") return `reveal ends in ${fmtCountdown(m.revealEnds, now)}`;
  if (phase === "settling") return "settling…";
  return phase === "survived" ? "survived" : "died";
}

const FILTERS = ["all", "open", "revealing", "settled"] as const;

export function MarketsList() {
  const markets = useResolver<ResolverMarket[]>(getMarkets, [], 30_000);
  const stats = useResolver<Stats>(getStats, [], 60_000);
  const now = useNow(1000);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const st = stats.status === "ready" ? stats.data : null;

  const rows = useMemo(() => {
    if (markets.status !== "ready") return [];
    const order: Record<Phase, number> = { open: 0, revealing: 1, settling: 2, survived: 3, died: 3 };
    return markets.data
      .map((m) => ({ m, phase: marketPhase(m, now) }))
      .filter(({ phase }) => filter === "all" || (filter === "settled" ? phase === "survived" || phase === "died" : filter === "revealing" ? phase === "revealing" || phase === "settling" : phase === filter))
      .sort((a, b) => order[a.phase] - order[b.phase] || (a.m.deadline ?? 0) - (b.m.deadline ?? 0));
  }, [markets, now, filter]);

  const live = markets.status === "ready" ? markets.data.filter((m) => marketPhase(m, now) === "open").length : undefined;

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Tokens launched" value={fmtNum(st?.tokens ?? (markets.status === "ready" ? markets.data.length : undefined))} />
        <Stat label="Live markets" value={fmtNum(st?.liveMarkets ?? live)} tone="gold" />
        <Stat label="Survived" value={fmtNum(st?.survived)} />
        <Stat label="Died" value={fmtNum(st?.died)} tone="blood" />
      </div>

      {markets.status === "loading" && <Skeleton rows={5} />}

      {markets.status === "error" && (
        <EmptyState title="The arena went dark." body="The Stovia resolver isn't answering right now. Markets will reappear as soon as it's back.">
          <button type="button" onClick={markets.reload} className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-5 font-mono text-xs uppercase tracking-[0.16em] text-bone-dim transition hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-gold">
            <RefreshCw className="h-4 w-4" aria-hidden /> Retry
          </button>
        </EmptyState>
      )}

      {markets.status === "ready" && markets.data.length === 0 && (
        <EmptyState title="The arena is quiet." body="No markets yet. Every launch opens a survival market the moment its token goes live.">
          <Link href="/app/launch" className="inline-flex h-12 items-center gap-2 rounded-full bg-gold px-6 font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
            Launch the first one <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </EmptyState>
      )}

      {markets.status === "ready" && markets.data.length > 0 && (
        <div>
          <div role="tablist" aria-label="Filter markets" className="mb-4 flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f}
                role="tab"
                type="button"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`rounded-full border px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] transition focus-visible:outline-2 focus-visible:outline-gold ${filter === f ? "border-gold text-gold" : "border-line text-bone-dim hover:border-bone-dim"}`}
              >
                {f}
              </button>
            ))}
          </div>
          {rows.length === 0 ? (
            <p className="border-y border-line py-10 text-center text-sm text-bone-dim">No {filter} markets right now.</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {rows.map(({ m, phase }) => (
                <li key={m.market} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-3 py-5 sm:grid-cols-[auto_2fr_1.6fr_1.2fr_auto] sm:px-3">
                  <TokenAvatar src={m.image} ticker={m.symbol} />
                  <div className="min-w-0">
                    <p className="truncate font-display text-lg font-bold text-bone">{m.name}</p>
                    <p className="font-mono text-xs text-gold">${m.symbol || "—"}</p>
                  </div>
                  <div className="col-span-3 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
                    <McapBar m={m} />
                  </div>
                  <div className="col-span-3 row-start-3 flex items-center justify-between gap-3 font-mono text-xs text-bone-dim sm:col-span-1 sm:row-start-auto sm:block">
                    <p className="text-bone" suppressHydrationWarning>{phaseClock(m, phase, now)}</p>
                    <p className="mt-0.5 inline-flex items-center gap-1">
                      <Lock className="h-3 w-3" aria-hidden /> {m.commitments ?? 0} sealed{phase !== "open" && m.revealed != null ? ` · ${m.revealed} revealed` : ""}
                    </p>
                  </div>
                  <div className="col-start-3 row-start-1 flex flex-col items-end gap-2 sm:col-start-auto sm:row-start-auto sm:flex-row sm:items-center">
                    <PhaseChip phase={phase} />
                    <div className="flex items-center gap-2">
                      <Link href={`/app/token/${encodeURIComponent(m.mint)}`} aria-label={`${m.name} token page`} className="inline-flex h-9 items-center gap-1 rounded-full border border-line px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-dim transition hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-gold">
                        <LineChart className="h-3.5 w-3.5" aria-hidden /> Trade
                      </Link>
                      <Link
                        href={`/app/bets?market=${encodeURIComponent(m.market)}`}
                        className={`inline-flex h-9 items-center gap-1 rounded-full px-3 font-mono text-[11px] font-bold uppercase tracking-[0.14em] transition focus-visible:outline-2 focus-visible:outline-gold ${phase === "open" ? "bg-gold text-ink hover:bg-gold-hot" : "border border-line text-bone hover:border-gold hover:text-gold"}`}
                      >
                        {phase === "open" ? "Bet" : phase === "revealing" ? "Reveal" : "View"} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
