"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight, Coins, RefreshCw } from "lucide-react";
import { getCreators, getMarkets, marketPhase, type CreatorRow, type ResolverMarket } from "@/lib/markets/resolver";
import { fmtCountdown, useResolver } from "@/lib/markets/hooks";
import { useNow } from "@/lib/useApi";
import { CREATOR_FEE_PCT, PLATFORM_FEE_PCT } from "@/lib/config";
import { fmtNum } from "@/lib/format";
import { ConnectGate } from "./ConnectGate";
import { EmptyState, Panel, Skeleton, Stat, TokenAvatar } from "./ui";
import { McapBar, PhaseChip } from "./MarketsList";

export function CreatorVault() {
  return (
    <div className="space-y-6">
      <ConnectGate title="The vault is locked." body={`Connect the wallet you launched with. Every trade on your token pays you ${CREATOR_FEE_PCT}% — claim it from each token's page.`}>
        {(addr) => <Inner addr={addr} />}
      </ConnectGate>
      <Panel kicker="Fee split" title="Where every trade's fee goes">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Split pct={`${CREATOR_FEE_PCT}%`} label="To the creator" tone="gold" />
          <Split pct={`${PLATFORM_FEE_PCT}%`} label="To the Stovia treasury" />
          <Split pct="0%" label="Hidden fees" tone="blood" />
        </div>
      </Panel>
    </div>
  );
}

function bondText(phase: ReturnType<typeof marketPhase>, m: ResolverMarket, now: number | null): { text: string; tone: string } {
  if (phase === "survived") return { text: "Bond returned", tone: "text-gold" };
  if (phase === "died") return { text: "Bond slashed to winners", tone: "text-blood-hot" };
  if (phase === "open") return { text: `Bond locked · deadline in ${fmtCountdown(m.deadline, now)}`, tone: "text-bone" };
  return { text: "Bond locked · settling", tone: "text-bone-dim" };
}

function Inner({ addr }: { addr: string }) {
  const now = useNow(1000);
  const markets = useResolver<ResolverMarket[]>(getMarkets, [], 30_000);
  const creators = useResolver<CreatorRow[]>(getCreators, [], 60_000);
  const mine = useMemo(() => (markets.status === "ready" ? markets.data.filter((m) => m.creator === addr) : []), [markets, addr]);
  const me = creators.status === "ready" ? creators.data.find((c) => c.wallet === addr) : undefined;

  if (markets.status === "loading") return <Skeleton rows={3} />;
  if (markets.status === "error")
    return (
      <EmptyState title="The vault went quiet." body="The Stovia resolver isn't answering right now. Your launches will reappear when it's back.">
        <button type="button" onClick={markets.reload} className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-5 font-mono text-xs uppercase tracking-[0.16em] text-bone-dim transition hover:border-gold hover:text-gold">
          <RefreshCw className="h-4 w-4" aria-hidden /> Retry
        </button>
      </EmptyState>
    );

  const phases = mine.map((m) => marketPhase(m, now));
  const survived = me?.survived ?? phases.filter((p) => p === "survived").length;
  const died = me?.died ?? phases.filter((p) => p === "died").length;
  const open = phases.filter((p) => p === "open" || p === "revealing" || p === "settling").length;

  return (
    <Panel kicker="Your launches">
      <div className="mb-8 grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Launches" value={fmtNum(me?.launches ?? mine.length)} />
        <Stat label="Live" value={fmtNum(open)} tone="gold" />
        <Stat label="Survived" value={fmtNum(survived)} />
        <Stat label="Died" value={fmtNum(died)} tone="blood" />
      </div>
      {mine.length === 0 ? (
        <EmptyState title="No launches yet." body="Tokens launched from this wallet show up here with their bond and market status.">
          <Link href="/app/launch" className="inline-flex h-12 items-center gap-2 rounded-full bg-gold px-6 font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
            Launch a token <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {mine.map((m, i) => {
            const phase = phases[i];
            const bond = bondText(phase, m, now);
            return (
              <li key={m.market} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-3 py-5 sm:grid-cols-[auto_1.6fr_1.6fr_auto]">
                <TokenAvatar src={m.image} ticker={m.symbol} />
                <div className="min-w-0">
                  <p className="truncate font-display text-lg font-bold text-bone">{m.name} <span className="font-mono text-xs text-gold">${m.symbol}</span></p>
                  <p className={`font-mono text-xs ${bond.tone}`} suppressHydrationWarning>{bond.text}</p>
                </div>
                <div className="col-span-3 row-start-2 min-w-0 sm:col-span-1 sm:row-start-auto">
                  <McapBar m={m} />
                </div>
                <div className="col-start-3 row-start-1 flex flex-col items-end gap-2 sm:col-start-auto sm:row-start-auto">
                  <PhaseChip phase={phase} />
                  <Link href={`/app/token/${encodeURIComponent(m.mint)}`} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-gold/60 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-gold transition hover:bg-gold/10 focus-visible:outline-2 focus-visible:outline-gold">
                    <Coins className="h-3.5 w-3.5" aria-hidden /> Fees &amp; trade
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-5 text-sm text-bone-dim">Creator trading fees accrue in each token&apos;s Meteora pool. Claim them from the token page.</p>
    </Panel>
  );
}

function Split({ pct, label, tone }: { pct: string; label: string; tone?: "gold" | "blood" }) {
  return (
    <div className="rounded-sm border border-line p-5">
      <p className={`font-display text-4xl font-extrabold tracking-tight ${tone === "gold" ? "text-gold" : tone === "blood" ? "text-blood-hot" : "text-bone"}`}>{pct}</p>
      <p className="mt-1 font-serif text-lg italic text-bone-dim">{label}</p>
    </div>
  );
}
