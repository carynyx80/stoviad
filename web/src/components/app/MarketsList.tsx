"use client";

import Link from "next/link";
import { ArrowUpRight, Lock } from "lucide-react";
import { getMarkets, getStats, type Market, type Stats } from "@/lib/api";
import { useApi, useNow } from "@/lib/useApi";
import { fmtDeadline, fmtNum, fmtSol, fmtUsd } from "@/lib/format";
import { EmptyState, Skeleton, Stat, StatusPill, TokenAvatar, apiEmptyCopy } from "./ui";

export function MarketsList() {
  const markets = useApi<Market[]>(getMarkets);
  const stats = useApi<Stats>(getStats, (s) => Object.values(s).every((v) => v == null));
  const now = useNow();
  const st = stats.status === "ready" ? stats.data : null;

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Tokens launched" value={fmtNum(st?.tokens)} />
        <Stat label="Live markets" value={fmtNum(st?.liveMarkets)} tone="gold" />
        <Stat label="Survived" value={fmtNum(st?.survived)} />
        <Stat label="Died" value={fmtNum(st?.died)} tone="blood" />
      </div>

      {markets.status === "loading" && <Skeleton rows={5} />}
      {markets.status === "empty" && (
        <EmptyState title="The arena is quiet." body={apiEmptyCopy(markets.reason, "markets")}>
          <Link href="/app/launch" className="inline-flex h-12 items-center gap-2 rounded-full bg-gold px-6 font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
            Launch the first one <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </EmptyState>
      )}
      {markets.status === "ready" && (
        <ul className="divide-y divide-line border-y border-line">
          {markets.data.map((m) => {
            const progress = m.marketCapUsd && m.targetMcapUsd ? Math.min(1, m.marketCapUsd / m.targetMcapUsd) : 0;
            return (
              <li key={m.marketId}>
                <Link href={`/app/bets?market=${encodeURIComponent(m.marketId)}`} className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 py-5 transition hover:bg-ink-2/60 focus-visible:outline-2 focus-visible:outline-gold sm:grid-cols-[auto_2fr_1.4fr_1fr_auto] sm:px-3">
                  <TokenAvatar src={m.image} ticker={m.ticker} />
                  <div className="min-w-0">
                    <p className="truncate font-display text-lg font-bold text-bone">{m.name}</p>
                    <p className="font-mono text-xs text-gold">${m.ticker}</p>
                  </div>
                  <div className="col-span-3 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
                    <div className="flex justify-between font-mono text-[11px] text-bone-dim">
                      <span>{fmtUsd(m.marketCapUsd)}</span>
                      <span>target {fmtUsd(m.targetMcapUsd)}</span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-3">
                      <div className={`h-full ${progress >= 1 ? "bg-gold" : "bg-blood-hot"}`} style={{ width: `${progress * 100}%` }} />
                    </div>
                  </div>
                  <div className="hidden font-mono text-xs text-bone-dim sm:block">
                    <p className="text-bone">{now == null ? "—" : fmtDeadline(m.deadline, now)}</p>
                    <p className="mt-0.5 inline-flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden /> {m.poolSol != null ? `${fmtSol(m.poolSol)} SOL pool` : "sealed pool"}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusPill status={m.status} />
                    <ArrowUpRight className="hidden h-5 w-5 text-bone-dim transition group-hover:rotate-45 group-hover:text-gold sm:block" aria-hidden />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
