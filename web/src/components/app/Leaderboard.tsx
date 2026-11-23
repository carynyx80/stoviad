"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { getCreators, type Creator } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fmtNum, shortAddr } from "@/lib/format";
import { EmptyState, Skeleton, apiEmptyCopy } from "./ui";

const score = (c: Creator) => c.reputation ?? (c.survived ?? 0) * 10 - (c.died ?? 0) * 6;

export function Leaderboard() {
  const creators = useApi<Creator[]>(getCreators);
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();

  if (creators.status === "loading") return <Skeleton rows={6} />;
  if (creators.status === "empty")
    return <EmptyState title="No legends yet." body={apiEmptyCopy(creators.reason, "rankings")} />;

  const ranked = [...creators.data].sort((a, b) => score(b) - score(a)).slice(0, 100);

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
                <span className="block truncate font-bold text-bone">{c.name ?? shortAddr(c.wallet)}</span>
                {c.name && <span className="font-mono text-xs text-bone-dim">{shortAddr(c.wallet)}</span>}
              </td>
              <td className="hidden px-3 py-4 text-right font-mono text-sm text-bone-dim sm:table-cell">{fmtNum(c.launches)}</td>
              <td className="px-3 py-4 text-right font-mono text-sm text-gold">{fmtNum(c.survived)}</td>
              <td className="hidden px-3 py-4 text-right font-mono text-sm text-blood-hot sm:table-cell">{fmtNum(c.died)}</td>
              <td className="px-3 py-4 text-right font-mono text-sm font-semibold text-bone sm:px-5">{fmtNum(score(c))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
