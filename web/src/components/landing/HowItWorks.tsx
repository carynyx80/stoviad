"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import Reveal, { Eyebrow } from "./Reveal";

const STEPS = [
  {
    n: "01",
    title: "Launch",
    accent: "with a bond.",
    body: "Creators lock SOL behind their own coin. Skin in the game, on-chain, before the first buy. Rug it and the bond feeds the people who called it.",
    tag: "CREATOR BOND",
    color: "text-gold",
  },
  {
    n: "02",
    title: "Sealed",
    accent: "bets.",
    body: "Every token opens a survival market. Back YES it lives through the window, or NO it dies. Sizes stay sealed inside Helius Privacy Rings, so nobody can front-run the verdict.",
    tag: "YES / NO",
    color: "text-bone",
  },
  {
    n: "03",
    title: "Survive",
    accent: "or get paid.",
    body: "When the clock hits zero the market settles. Survivors pay the believers. Corpses pay the skeptics. Either way, someone walks away with SOL.",
    tag: "SETTLEMENT",
    color: "text-blood-hot",
  },
];

export default function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 70%", "end 60%"] });
  const h = useTransform(scrollYProgress, [0, 1], ["0%", "100%"]);

  return (
    <section id="how" className="relative mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12 py-24 sm:py-32">
      <div className="grid gap-12 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <div className="lg:sticky lg:top-28">
            <Eyebrow n="01">HOW IT WORKS</Eyebrow>
            <Reveal>
              <h2 className="mt-6 font-display font-extrabold uppercase leading-[0.88] tracking-[-0.04em] text-5xl sm:text-6xl lg:text-7xl">
                Three acts.
                <span className="block font-serif italic font-normal normal-case text-gold tracking-[-0.02em]">One verdict.</span>
              </h2>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-6 max-w-sm text-bone-dim text-lg leading-snug">
                Memecoins die fast. Stovia turns that fact into a market, and makes the creator stake something on the outcome.
              </p>
            </Reveal>
          </div>
        </div>

        <div ref={ref} className="relative lg:col-span-8">
          <div className="absolute left-0 top-0 bottom-0 w-px bg-line" aria-hidden />
          <motion.div style={{ height: h }} className="absolute left-0 top-0 w-px bg-gold" aria-hidden />
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.05}>
              <article className="group relative grid gap-6 border-b border-line py-12 pl-8 sm:pl-12 sm:grid-cols-[auto_1fr] sm:gap-10 last:border-b-0">
                <span className="absolute -left-[5px] top-[3.6rem] h-[11px] w-[11px] rotate-45 border border-gold bg-ink transition-colors group-hover:bg-gold" />
                <div className="font-display font-extrabold leading-none tracking-tighter text-[88px] sm:text-[120px] st-outline-bone transition-colors">
                  {s.n}
                </div>
                <div>
                  <div className={`font-mono text-[11px] tracking-[0.25em] ${s.color}`}>{s.tag}</div>
                  <h3 className="mt-3 font-display font-extrabold uppercase leading-[0.9] tracking-[-0.03em] text-4xl sm:text-5xl">
                    {s.title}{" "}
                    <span className="font-serif italic font-normal normal-case text-gold">{s.accent}</span>
                  </h3>
                  <p className="mt-4 max-w-xl text-bone-dim text-lg leading-relaxed">{s.body}</p>
                </div>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
