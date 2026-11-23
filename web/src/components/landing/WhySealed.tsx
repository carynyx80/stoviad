"use client";

import { motion } from "framer-motion";
import { EyeOff, Lock, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import Reveal, { Eyebrow } from "./Reveal";

const GLYPHS = "#%&@$*0123456789ABCDEF";
const ROWS = [
  { side: "YES", wallet: "7xKp…q3Vd" },
  { side: "NO", wallet: "Fh2m…9aLr" },
  { side: "YES", wallet: "3aBn…Wz81" },
  { side: "NO", wallet: "Qe9t…mK2c" },
  { side: "YES", wallet: "Lr4s…0pHx" },
];

// Deterministic pseudo-random scramble, advanced only on the client.
function scramble(seed: number, len: number) {
  let s = "";
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += GLYPHS[x % GLYPHS.length];
  }
  return s;
}

function SealedLedger() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 110);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="relative border border-line bg-ink-2">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 font-mono text-[10px] tracking-[0.25em] text-bone-dim">
        <span>MARKET $OMEN<span className="hidden sm:inline"> &middot; ORDER FLOW</span></span>
        <span className="flex items-center gap-1.5 text-gold">
          <Lock className="h-3 w-3" /> RING-SEALED
        </span>
      </div>
      <ul className="divide-y divide-line font-mono text-sm">
        {ROWS.map((r, i) => (
          <li key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3.5">
            <span
              className={`w-12 text-center text-[11px] tracking-[0.2em] py-0.5 border ${
                r.side === "YES" ? "border-gold text-gold" : "border-blood-hot text-blood-hot"
              }`}
            >
              {r.side}
            </span>
            <span className="text-bone-dim truncate">{r.wallet}</span>
            <span className="tabular-nums text-bone">
              <span className="text-bone-dim">{scramble(tick * 7 + i * 131, 4)}</span>
              <span className="text-bone-dim/60">.</span>
              <span className="text-bone-dim">{scramble(tick * 13 + i * 71, 2)}</span>
              <span className="ml-1.5 text-bone-dim/70">SOL</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 border-t border-line">
        <div className="border-r border-line p-4">
          <div className="font-mono text-[10px] tracking-[0.25em] text-bone-dim">VISIBLE</div>
          <div className="mt-1 text-bone">Side, timestamp</div>
        </div>
        <div className="p-4">
          <div className="font-mono text-[10px] tracking-[0.25em] text-bone-dim">HIDDEN</div>
          <div className="mt-1 text-gold">Every amount</div>
        </div>
      </div>
    </div>
  );
}

const POINTS = [
  { icon: EyeOff, t: "No whale-watching", d: "Nobody can see a big NO land and dump ahead of it." },
  { icon: ShieldCheck, t: "No dev games", d: "Creators can't size up the doubters and rug into the gap." },
  { icon: Lock, t: "Verifiable settlement", d: "Amounts stay shielded while payouts settle on-chain." },
];

export default function WhySealed() {
  return (
    <section id="sealed" className="relative overflow-hidden border-y border-line bg-ink-2/40">
      <div className="st-rings pointer-events-none absolute -right-[25vw] top-1/2 h-[60vw] w-[60vw] -translate-y-1/2 opacity-60" aria-hidden />
      <div className="relative mx-auto grid max-w-[1440px] gap-16 px-5 py-24 sm:px-8 sm:py-32 lg:grid-cols-12 lg:px-12">
        <div className="lg:col-span-7">
          <Eyebrow n="02">WHY SEALED</Eyebrow>
          <Reveal>
            <h2 className="mt-6 font-display font-extrabold uppercase leading-[0.86] tracking-[-0.04em] text-5xl sm:text-7xl lg:text-[96px]">
              Nobody sees
              <br />
              your size.
              <span className="mt-2 block font-serif italic font-normal normal-case text-bone-dim tracking-[-0.02em] text-3xl sm:text-5xl lg:text-6xl">
                not whales. not the dev. <span className="text-gold">not us.</span>
              </span>
            </h2>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-8 max-w-xl text-lg leading-relaxed text-bone-dim">
              Open prediction markets leak. A visible bet is a signal, and a signal is a trade someone else makes first.
              Stovia routes every position through <span className="text-bone">Helius Privacy Rings</span>: the side
              is public, the amount is sealed.
            </p>
          </Reveal>
          <div className="mt-12 grid gap-px bg-line border border-line sm:grid-cols-3">
            {POINTS.map((p, i) => (
              <Reveal key={p.t} delay={0.1 + i * 0.08} className="bg-ink p-5">
                <p.icon className="h-5 w-5 text-gold" strokeWidth={1.75} />
                <div className="mt-4 font-display text-lg font-bold tracking-tight">{p.t}</div>
                <p className="mt-1.5 text-sm leading-relaxed text-bone-dim">{p.d}</p>
              </Reveal>
            ))}
          </div>
        </div>
        <div className="lg:col-span-5 lg:pt-16">
          <motion.div
            initial={{ opacity: 0, rotate: 3, y: 40 }}
            whileInView={{ opacity: 1, rotate: 1, y: 0 }}
            viewport={{ once: true, margin: "-10% 0px" }}
            transition={{ duration: 1, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <SealedLedger />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
