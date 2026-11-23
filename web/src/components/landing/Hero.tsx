"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import MagneticCTA from "./Magnetic";

const START = 71 * 3600 + 59 * 60 + 41; // deterministic start for SSR

function fmt(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0"));
}

function SurvivalCard() {
  const [left, setLeft] = useState(START);
  useEffect(() => {
    const id = setInterval(() => setLeft((l) => (l > 0 ? l - 1 : START)), 1000);
    return () => clearInterval(id);
  }, []);
  const [h, m, s] = fmt(left);
  const pct = left / (72 * 3600);

  return (
    <motion.div
      initial={{ opacity: 0, y: 40, rotate: 2 }}
      animate={{ opacity: 1, y: 0, rotate: -1.5 }}
      transition={{ delay: 0.6, duration: 1, ease: [0.2, 0.8, 0.2, 1] }}
      className="relative w-full max-w-[380px] border border-line bg-ink-2/90 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5 font-mono text-[10px] tracking-[0.25em] text-bone-dim">
        <span>SPECIMEN #0412</span>
        <span className="flex items-center gap-1.5 text-gold">
          <span className="st-pulse h-1.5 w-1.5 rounded-full bg-gold" /> LIVE
        </span>
      </div>
      <div className="px-5 pt-5">
        <div className="flex items-baseline justify-between">
          <span className="font-display text-3xl font-extrabold tracking-tight">$MOTH</span>
          <span className="font-mono text-xs text-gold">bond 25 SOL</span>
        </div>
        <p className="mt-1 font-serif italic text-bone-dim text-lg">must outlive the clock.</p>
      </div>
      <div className="px-5 pt-6">
        <div className="font-mono text-[10px] tracking-[0.25em] text-bone-dim">TIME TO VERDICT</div>
        <div className="mt-1 flex items-end gap-1 font-display font-extrabold tabular-nums leading-none text-[56px] sm:text-[64px] tracking-tighter">
          <span>{h}</span>
          <span className="text-gold st-blink">:</span>
          <span>{m}</span>
          <span className="text-gold st-blink">:</span>
          <span className="text-bone-dim">{s}</span>
        </div>
        {/* survival meter */}
        <div className="mt-5 flex h-3 w-full gap-[3px]" aria-hidden>
          {Array.from({ length: 36 }).map((_, i) => {
            const on = i / 36 < pct;
            return (
              <span
                key={i}
                className={`flex-1 ${on ? (i < 6 ? "bg-blood-hot" : "bg-gold") : "bg-line"}`}
              />
            );
          })}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[10px] text-bone-dim">
          <span>T-0 &middot; DEATH</span>
          <span>72H &middot; LAUNCH</span>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 border-t border-line">
        <div className="border-r border-line p-4">
          <div className="font-mono text-[10px] tracking-[0.25em] text-gold">YES / SURVIVES</div>
          <div className="mt-1 font-mono text-xl text-bone">
            <span className="st-redact w-16" /><span className="text-bone-dim"> SOL</span>
          </div>
        </div>
        <div className="p-4">
          <div className="font-mono text-[10px] tracking-[0.25em] text-blood-hot">NO / DIES</div>
          <div className="mt-1 font-mono text-xl text-bone">
            <span className="st-redact w-12" /><span className="text-bone-dim"> SOL</span>
          </div>
        </div>
      </div>
      <div className="border-t border-line px-4 py-2.5 font-mono text-[10px] tracking-[0.2em] text-bone-dim">
        AMOUNTS SEALED &middot; HELIUS PRIVACY RINGS
      </div>
    </motion.div>
  );
}

const line = {
  hidden: { y: "110%" },
  show: (i: number) => ({
    y: "0%",
    transition: { delay: 0.1 + i * 0.12, duration: 1, ease: [0.2, 0.8, 0.2, 1] as const },
  }),
};

export default function Hero() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const yBig = useTransform(scrollYProgress, [0, 1], ["0%", "30%"]);
  const fade = useTransform(scrollYProgress, [0, 0.8], [1, 0]);

  return (
    <section ref={ref} className="relative overflow-hidden">
      {/* giant ghost numeral */}
      <motion.div
        style={{ y: yBig }}
        aria-hidden
        className="pointer-events-none absolute -right-[6vw] top-[6vh] select-none font-display font-extrabold leading-none text-[42vw] lg:text-[34vw] tracking-tighter st-outline"
      >
        72
      </motion.div>
      <div className="st-rings pointer-events-none absolute -left-[20vw] bottom-[-30vw] h-[70vw] w-[70vw] opacity-40" aria-hidden />

      <motion.div style={{ opacity: fade }} className="relative mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12 pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] tracking-[0.25em] text-bone-dim">
          <span className="text-gold">&#9632; SURVIVAL MARKETS</span>
          <span>EVERY TOKEN</span>
          <span className="hidden sm:inline">EVERY BET SEALED</span>
          <span className="hidden md:inline">SOLANA MAINNET</span>
        </div>

        <div className="mt-8 grid gap-12 lg:grid-cols-12 lg:gap-8 items-end">
          <div className="lg:col-span-8">
            <h1 className="font-display font-extrabold uppercase leading-[0.84] tracking-[-0.045em] text-[17vw] sm:text-[15vw] lg:text-[10.5vw] xl:text-[176px]">
              {["Bet on", "what"].map((w, i) => (
                <span key={w} className="block overflow-hidden pb-[0.04em]">
                  <motion.span className="block" variants={line} initial="hidden" animate="show" custom={i}>
                    {w}
                  </motion.span>
                </span>
              ))}
              <span className="block overflow-hidden pb-[0.12em]">
                <motion.span
                  className="block font-serif italic font-normal normal-case tracking-[-0.03em] text-gold leading-[0.9]"
                  variants={line}
                  initial="hidden"
                  animate="show"
                  custom={2}
                >
                  survives.
                </motion.span>
              </span>
            </h1>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.7, duration: 0.8 }}
              className="mt-8 grid gap-8 sm:grid-cols-[1fr_auto] sm:items-end max-w-[880px]"
            >
              <p className="max-w-[460px] text-lg sm:text-xl leading-snug text-bone-dim">
                The Solana launchpad where every coin is born with a sealed survival market.{" "}
                <span className="text-bone">Bet YES it lives. Bet NO it dies.</span>{" "}
                <span className="font-serif italic text-gold text-[1.15em]">Get paid when you get rugged.</span>
              </p>
              <MagneticCTA />
            </motion.div>
          </div>

          <div className="lg:col-span-4 flex lg:justify-end">
            <SurvivalCard />
          </div>
        </div>
      </motion.div>
    </section>
  );
}
