"use client";

import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { getCreators, type CreatorRow } from "@/lib/markets/resolver";
import { useResolver } from "@/lib/markets/hooks";
import { fmtNum, shortAddr } from "@/lib/format";
import { EmptyState, Skeleton } from "./ui";

const score = (c: CreatorRow) => c.reputation ?? (c.survived ?? 0) * 10 - (c.died ?? 0) * 6;

export function Leaderboard() {
  const creators = useResolver<CreatorRow[]>(getCreators, [], 60_000);
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();

  if (creators.status === "loading") return <Skeleton rows={6} />;
  if (creators.status === "error")
    return (
      <EmptyState title="The board is dark." body="The Stovia resolver isn't answering right now. Rankings will reappear when it's back.">
        <button type="button" onClick={creators.reload} className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-5 font-mono text-xs uppercase tracking-[0.16em] text-bone-dim transition hover:border-gold hover:text-gold">
          <RefreshCw className="h-4 w-4" aria-hidden /> Retry
        </button>
      </EmptyState>
    );
  if (creators.data.length === 0)
    return (
      <EmptyState title="No legends yet." body="Creators earn reputation when their tokens survive. Be the first on the board.">
        <Link href="/app/launch" className="inline-flex h-12 items-center gap-2 rounded-full bg-gold px-6 font-bold text-ink transition hover:bg-gold-hot">
          Launch a token <ArrowUpRight className="h-4 w-4" aria-hidden />
        </Link>
      </EmptyState>
    );

  const ranked = [...creators.data].sort((a, b) => score(b) - score(a) || (b.survived ?? 0) - (a.survived ?? 0)).slice(0, 100);

  return (
    <div className="overflow-hidden rounded-sm border border-line">
      <table className="w-full table-fixed text-left">
        <caption className="sr-only">Creator reputation leaderboard</caption>
        <thead className="border-b border-line bg-ink-2 font-mono text-[10px] uppercase tracking-[0.18em] text-bone-dim">
          <tr>
            <th scope="col" className="w-14 px-3 py-3 sm:w-20 sm:px-5">Rank</th>
            <th scope="col" className="px-3 py-3">Creator</th>
            <th scope="col" className="hidden w-24 px-3 py-3 text-right sm:table-cell">Launches</th>
            <th scope="col" className="w-20 px-3 py-3 text-right sm:w-28">Survived</th>
            <th scope="col" className="hidden w-24 px-3 py-3 text-right sm:table-cell">Died</th>
            <th scope="col" className="w-20 px-3 py-3 text-right sm:w-28 sm:px-5">Rep</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {ranked.map((c, i) => (
            <tr key={c.wallet} className={c.wallet === me ? "bg-gold/10" : "hover:bg-ink-2/60"}>
              <td className={`px-3 py-4 font-display text-2xl font-extrabold sm:px-5 ${i === 0 ? "text-gold" : i < 3 ? "text-bone" : "text-bone-dim"}`}>{i + 1}</td>
              <td className="truncate px-3 py-4">
                <a href={`https://solscan.io/account/${c.wallet}`} target="_blank" rel="noreferrer" className="block truncate font-bold text-bone hover:text-gold">
                  {c.name ?? shortAddr(c.wallet)}
                  {c.wallet === me && <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-gold">you</span>}
                </a>
                {c.name && <span className="font-mono text-xs text-bone-dim">{shortAddr(c.wallet)}</span>}
              </td>
              <td className="hidden px-3 py-4 text-right font-mono text-sm text-bone-dim sm:table-cell">{fmtNum(c.launches)}</td>
              <td className="px-3 py-4 text-right font-mono text-sm text-gold">{fmtNum(c.survived ?? 0)}</td>
              <td className="hidden px-3 py-4 text-right font-mono text-sm text-blood-hot sm:table-cell">{fmtNum(c.died ?? 0)}</td>
              <td className="px-3 py-4 text-right font-mono text-sm font-semibold text-bone sm:px-5">{fmtNum(score(c))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
