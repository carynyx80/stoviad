"use client";

import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { solscanAccount, solscanTx, type SimResult } from "@/lib/admin/tx";

export const btnGold =
  "inline-flex h-11 items-center justify-center gap-2 rounded-sm bg-gold px-5 font-display text-sm font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40";
export const btnGhost =
  "inline-flex h-11 items-center justify-center gap-2 rounded-sm border border-line bg-ink px-5 font-display text-sm font-semibold text-bone transition hover:border-gold/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40";
export const btnBlood =
  "inline-flex h-11 items-center justify-center gap-2 rounded-sm bg-blood px-5 font-display text-sm font-bold text-bone transition hover:bg-blood-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40";

export function AddrLink({ addr, highlight }: { addr: string | null | undefined; highlight?: boolean }) {
  if (!addr) return <span className="font-mono text-xs text-bone-dim">none</span>;
  return (
    <a
      href={solscanAccount(addr)}
      target="_blank"
      rel="noreferrer"
      className={`inline-flex max-w-full items-center gap-1 break-all font-mono text-xs transition hover:text-gold ${highlight ? "text-gold" : "text-bone"}`}
    >
      <span className="min-w-0 break-all">{addr}</span>
      <ExternalLink className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
    </a>
  );
}

export function TxLink({ sig }: { sig: string }) {
  return (
    <a href={solscanTx(sig)} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-gold underline-offset-2 hover:underline">
      <span className="truncate">{sig.slice(0, 20)}…</span> View on Solscan <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}

export function Note({ tone = "dim", children }: { tone?: "dim" | "gold" | "blood" | "ok"; children: ReactNode }) {
  const cls = tone === "blood" ? "border-blood-hot text-bone" : tone === "gold" ? "border-gold text-bone" : tone === "ok" ? "border-gold/70 text-bone" : "border-line text-bone-dim";
  const Icon = tone === "blood" ? AlertTriangle : tone === "ok" ? CheckCircle2 : null;
  return (
    <div role={tone === "blood" ? "alert" : "status"} className={`flex items-start gap-2 border-l-2 pl-3 text-sm ${cls}`}>
      {Icon && <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone === "blood" ? "text-blood-hot" : "text-gold"}`} aria-hidden />}
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs text-bone-dim" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-gold" aria-hidden /> {label}
    </span>
  );
}

export function SimView({ sim }: { sim: SimResult }) {
  return (
    <div className="space-y-2">
      <Note tone={sim.ok ? "ok" : "blood"}>
        {sim.ok ? (
          <>
            <span className="font-semibold">Simulation passed</span>
            {sim.unitsConsumed != null && <span className="text-bone-dim"> · {sim.unitsConsumed.toLocaleString("en-US")} CU</span>}
          </>
        ) : (
          <>
            <span className="font-semibold">Simulation failed:</span> <span className="font-mono text-xs">{sim.err}</span>
          </>
        )}
      </Note>
      {sim.logs.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer font-mono text-[11px] uppercase tracking-[0.16em] text-bone-dim hover:text-gold">Program logs ({sim.logs.length})</summary>
          <pre className="mt-2 max-h-56 overflow-auto rounded-sm border border-line bg-ink p-3 font-mono text-[11px] leading-relaxed text-bone-dim">{sim.logs.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}
