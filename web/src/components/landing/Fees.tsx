import config from "@/stovia.config.json";
import Reveal, { Eyebrow } from "./Reveal";

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

export default function Fees() {
  const rows = [
    { k: "Platform", v: pct(config.platformFeeBps), d: "Keeps the lights on. Routed to the Stovia treasury.", c: "text-gold" },
    { k: "Creator", v: pct(config.creatorFeeBps), d: "Paid to the bonded creator, as long as the coin is breathing.", c: "text-bone" },
  ];
  const total = pct(config.platformFeeBps + config.creatorFeeBps);

  return (
    <section id="fees" className="relative mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12 py-24 sm:py-32">
      <Eyebrow n="03">FEES</Eyebrow>
      <div className="mt-6 grid gap-12 lg:grid-cols-12 lg:items-end">
        <Reveal className="lg:col-span-6">
          <h2 className="font-display font-extrabold uppercase leading-[0.86] tracking-[-0.04em] text-5xl sm:text-7xl lg:text-[96px]">
            Two fees.
            <span className="block font-serif italic font-normal normal-case text-gold tracking-[-0.02em]">Both tiny.</span>
          </h2>
          <p className="mt-6 max-w-md text-lg leading-relaxed text-bone-dim">
            No hidden spread, no launch tax, no &ldquo;migration&rdquo; surprise. {total} on volume, split down the middle.
          </p>
        </Reveal>
        <div className="lg:col-span-6">
          {rows.map((r, i) => (
            <Reveal key={r.k} delay={i * 0.1}>
              <div className="group grid grid-cols-[1fr_auto] items-end gap-6 border-t border-line py-6 last:border-b">
                <div>
                  <div className="font-mono text-[11px] tracking-[0.25em] text-bone-dim">{r.k.toUpperCase()} FEE</div>
                  <p className="mt-2 max-w-xs text-bone-dim leading-snug">{r.d}</p>
                </div>
                <div
                  className={`font-display font-extrabold tabular-nums leading-[0.8] tracking-[-0.05em] text-[72px] sm:text-[120px] ${r.c} transition-transform duration-500 group-hover:-translate-y-1`}
                >
                  {r.v}
                </div>
              </div>
            </Reveal>
          ))}
          <Reveal delay={0.2}>
            <div className="flex items-center justify-between py-5 font-mono text-xs tracking-[0.2em] text-bone-dim">
              <span>TOTAL</span>
              <span className="text-bone">{total} &middot; THAT&apos;S IT</span>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
