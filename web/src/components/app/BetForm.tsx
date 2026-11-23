"use client";

import { useEffect, useState } from "react";
import { EyeOff, KeyRound, ShieldCheck, Unlock } from "lucide-react";
import { getMarkets, type Market } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { STOVIA } from "@/lib/config";
import { shortAddr } from "@/lib/format";
import { TxButton } from "@/components/wallet/TxButton";
import { Field, Panel, inputCls } from "./ui";

const QUICK = ["0.1", "0.5", "1", "5"];

export function BetForm() {
  const markets = useApi<Market[]>(getMarkets);
  const [market, setMarket] = useState("");
  const [side, setSide] = useState<"yes" | "no" | null>(null);
  const [amount, setAmount] = useState("");

  // Preselect ?market= after mount (avoids useSearchParams + Suspense requirement).
  useEffect(() => {
    try {
      const m = new URLSearchParams(window.location.search).get("market");
      if (m) setMarket(m);
    } catch {
      /* ignore */
    }
  }, []);

  const amt = Number(amount);
  const valid = market.trim().length > 0 && side !== null && amt > 0;
  const list = markets.status === "ready" ? markets.data : [];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
      <Panel kicker="Your sealed bet" title="Will it survive?">
        <div className="space-y-6">
          <Field label="Market" htmlFor="b-market" hint={list.length ? undefined : "No live market list yet — paste a token mint address."}>
            {list.length ? (
              <select id="b-market" className={`${inputCls} appearance-none`} value={market} onChange={(e) => setMarket(e.target.value)}>
                <option value="">Choose a live market…</option>
                {list.map((m) => (
                  <option key={m.marketId} value={m.marketId}>${m.ticker} — {m.name}</option>
                ))}
              </select>
            ) : (
              <input id="b-market" className={`${inputCls} font-mono text-sm`} value={market} onChange={(e) => setMarket(e.target.value.trim())} placeholder="Token mint address" autoComplete="off" spellCheck={false} />
            )}
          </Field>

          <fieldset>
            <legend className="mb-2 block font-mono text-[11px] uppercase tracking-[0.18em] text-bone-dim">Your side</legend>
            <div className="grid grid-cols-2 gap-3">
              {(["yes", "no"] as const).map((v) => {
                const on = side === v;
                const yes = v === "yes";
                return (
                  <label
                    key={v}
                    className={`group relative flex cursor-pointer flex-col items-start overflow-hidden rounded-sm border p-4 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-gold sm:p-5 ${
                      on ? (yes ? "border-gold bg-gold/10" : "border-blood-hot bg-blood/20") : "border-line hover:border-bone-dim"
                    }`}
                  >
                    <input type="radio" name="side" value={v} checked={on} onChange={() => setSide(v)} className="sr-only" />
                    <span className={`font-display text-4xl font-extrabold tracking-tight sm:text-5xl ${yes ? "text-gold" : "text-blood-hot"}`}>{yes ? "YES" : "NO"}</span>
                    <span className="mt-1 font-serif text-lg italic text-bone-dim">{yes ? "it survives" : "it dies"}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <Field label="Amount (SOL)" htmlFor="b-amount" hint="Routed through a Privacy Ring — the amount never appears on-chain next to your wallet.">
            <input id="b-amount" type="number" min={0} step={0.01} inputMode="decimal" className={`${inputCls} font-mono text-lg`} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            <div className="mt-2 flex flex-wrap gap-2">
              {QUICK.map((q) => (
                <button key={q} type="button" onClick={() => setAmount(q)} className="rounded-full border border-line px-3 py-1 font-mono text-xs text-bone-dim transition hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-gold">
                  {q} SOL
                </button>
              ))}
            </div>
          </Field>

          <TxButton tone={side === "no" ? "blood" : "gold"} disabled={!valid}>
            Seal {side ? side.toUpperCase() : "bet"}{amt > 0 ? ` · ${amount} SOL` : ""}
          </TxButton>
        </div>
      </Panel>

      <Panel kicker="How sealing works" title={<>Nobody sees your <span className="font-serif font-normal italic text-gold">hand</span>.</>}>
        <ol className="space-y-6">
          <Step icon={<KeyRound className="h-5 w-5" />} n="01" title="Commit your side">
            Your wallet signs a hash of <span className="font-mono text-bone">side + secret salt</span>. On-chain it&apos;s just noise — YES and NO look identical.
          </Step>
          <Step icon={<EyeOff className="h-5 w-5" />} n="02" title="Ring your amount">
            The SOL moves through Helius <span className="text-bone">Privacy Rings</span>, so the bet size is hidden among every other deposit in the ring.
          </Step>
          <Step icon={<Unlock className="h-5 w-5" />} n="03" title="Reveal at the deadline">
            After the deadline you reveal your salt. Winners split the losing side plus the slashed bond.
          </Step>
        </ol>
        <div className="mt-7 flex items-start gap-2 border-t border-line pt-5 font-mono text-[11px] leading-relaxed text-bone-dim">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
          <span>
            Ring program {shortAddr(STOVIA.privacyRings.program, 6, 4)} · state tree {shortAddr(STOVIA.privacyRings.stateTree, 4, 4)} · mainnet
          </span>
        </div>
      </Panel>
    </div>
  );
}

function Step({ icon, n, title, children }: { icon: React.ReactNode; n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[auto_1fr] gap-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-gold/40 text-gold" aria-hidden>{icon}</span>
      <div>
        <p className="font-display font-bold text-bone"><span className="mr-2 font-mono text-xs text-gold">{n}</span>{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-bone-dim">{children}</p>
      </div>
    </li>
  );
}
