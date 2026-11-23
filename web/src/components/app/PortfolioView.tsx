"use client";

import Link from "next/link";
import { ArrowUpRight, Lock } from "lucide-react";
import { getTokens, type Token } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fmtSol, fmtUsd, shortAddr } from "@/lib/format";
import { useSolBalance } from "@/components/wallet/useSolBalance";
import { ConnectGate } from "./ConnectGate";
import { EmptyState, Panel, Skeleton, Stat, StatusPill, TokenAvatar, apiEmptyCopy } from "./ui";

export function PortfolioView() {
  return (
    <ConnectGate title="Your hand is empty." body="Connect a mainnet wallet to see your launches and sealed positions. Positions are decrypted locally — never on our servers.">
      {(addr) => <Inner addr={addr} />}
    </ConnectGate>
  );
}

function Inner({ addr }: { addr: string }) {
  const { balance } = useSolBalance();
  const tokens = useApi<Token[]>(getTokens);
  const mine = tokens.status === "ready" ? tokens.data.filter((t) => t.creator === addr) : [];

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Stat label="Wallet" value={<span className="font-mono text-xl sm:text-2xl">{shortAddr(addr)}</span>} />
        <Stat label="SOL balance" value={fmtSol(balance, 3)} tone="gold" />
        <Stat label="Sealed positions" value="0" />
        <Stat label="Launches" value={tokens.status === "ready" ? String(mine.length) : "—"} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel kicker="Sealed" title="Your positions">
          <EmptyState
            title="Nothing sealed yet."
            body={<>Bets you seal will be listed here with a <Lock className="inline h-3.5 w-3.5" aria-hidden /> until you reveal them after each deadline.</>}
          >
            <Link href="/app/bets" className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-gold hover:text-gold-hot">
              Place a sealed bet <ArrowUpRight className="h-4 w-4" aria-hidden />
            </Link>
          </EmptyState>
        </Panel>
        <Panel kicker="Created" title="Your launches">
          {tokens.status === "loading" && <Skeleton rows={3} />}
          {tokens.status === "empty" && <EmptyState title="No launches." body={apiEmptyCopy(tokens.reason, "launches")} />}
          {tokens.status === "ready" && mine.length === 0 && (
            <EmptyState title="No launches." body="You haven't launched a token from this wallet yet.">
              <Link href="/app/launch" className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-gold hover:text-gold-hot">
                Launch one <ArrowUpRight className="h-4 w-4" aria-hidden />
              </Link>
            </EmptyState>
          )}
          {mine.length > 0 && (
            <ul className="divide-y divide-line">
              {mine.map((t) => (
                <li key={t.mint} className="flex items-center gap-4 py-4">
                  <TokenAvatar src={t.image} ticker={t.ticker} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-bone">{t.name}</p>
                    <p className="font-mono text-xs text-bone-dim">{fmtUsd(t.marketCapUsd)} / {fmtUsd(t.targetMcapUsd)}</p>
                  </div>
                  <StatusPill status={t.status} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
