"use client";

import { getCreators, type Creator } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { CREATOR_FEE_PCT, PLATFORM_FEE_PCT } from "@/lib/config";
import { fmtNum, fmtSol } from "@/lib/format";
import { TxButton } from "@/components/wallet/TxButton";
import { ConnectGate } from "./ConnectGate";
import { Panel, Skeleton, Stat, apiEmptyCopy } from "./ui";

export function CreatorVault() {
  return (
    <div className="space-y-6">
      <ConnectGate title="The vault is locked." body={`Connect the wallet you launched with. Every trade on your token pays you ${CREATOR_FEE_PCT}% — claimable any time.`}>
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

function Inner({ addr }: { addr: string }) {
  const creators = useApi<Creator[]>(getCreators);
  if (creators.status === "loading") return <Skeleton rows={2} />;
  const me = creators.status === "ready" ? creators.data.find((c) => c.wallet === addr) : undefined;
  const accrued = me?.feesAccruedSol ?? 0;

  return (
    <Panel kicker="Your vault">
      <div className="grid grid-cols-1 items-end gap-8 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-bone-dim">Claimable</p>
          <p className="mt-2 font-display text-[clamp(3rem,10vw,6.5rem)] font-extrabold leading-none tracking-[-0.04em] text-gold">
            {fmtSol(accrued, 4)} <span className="font-serif text-[0.45em] font-normal italic text-bone">SOL</span>
          </p>
          <div className="mt-6 grid grid-cols-3 gap-4">
            <Stat label="Claimed" value={fmtSol(me?.feesClaimedSol ?? 0)} />
            <Stat label="Launches" value={fmtNum(me?.launches ?? 0)} />
            <Stat label="Survived" value={fmtNum(me?.survived ?? 0)} />
          </div>
          {!me && (
            <p className="mt-5 text-sm text-bone-dim">
              {creators.status === "empty" ? apiEmptyCopy(creators.reason, "creator fees") : "No fees recorded for this wallet yet — launch a token to start earning."}
            </p>
          )}
        </div>
        <TxButton disabled={accrued <= 0}>Claim {fmtSol(accrued, 4)} SOL</TxButton>
      </div>
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
