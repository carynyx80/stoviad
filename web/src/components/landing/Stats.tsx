"use client";

import { motion, useMotionValueEvent, useScroll, useTransform } from "framer-motion";
import { useRef, useState } from "react";

const SEGMENTS = 72;

export default function Stats() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 85%", "end 35%"] });
  const progress = useTransform(scrollYProgress, [0, 1], [0, SEGMENTS]);
  const [lit, setLit] = useState(0);
  useMotionValueEvent(progress, "change", (v) => setLit(Math.round(v)));
  const hoursLeft = SEGMENTS - lit;

  return (
    <section ref={ref} className="relative mx-auto max-w-[1440px] px-5 sm:px-8 lg:px-12 pt-24 sm:pt-32">
      <div className="grid gap-8 lg:grid-cols-12 lg:items-end">
        <h2 className="lg:col-span-8 font-display font-extrabold uppercase leading-[0.86] tracking-[-0.04em] text-[13vw] sm:text-7xl lg:text-[112px]">
          Most coins
          <span className="block">
            don&apos;t see <span className="font-serif italic font-normal normal-case text-blood-hot tracking-[-0.02em] whitespace-nowrap">day three.</span>
          </span>
        </h2>
        <p className="lg:col-span-4 max-w-sm text-lg leading-snug text-bone-dim lg:justify-self-end">
          Everyone already knows it. Stovia is the first launchpad that lets you{" "}
          <span className="font-serif italic text-gold text-[1.15em]">price it in</span>, on every single launch.
        </p>
      </div>

      <div className="mt-14">
        <div className="flex items-end justify-between font-mono text-[11px] tracking-[0.25em] text-bone-dim">
          <span>SURVIVAL WINDOW</span>
          <span className="tabular-nums">
            <span className={hoursLeft < 12 ? "text-blood-hot" : "text-gold"}>{String(hoursLeft).padStart(2, "0")}H</span> REMAINING
          </span>
        </div>
        <div className="mt-3 flex h-16 sm:h-24 gap-[2px] sm:gap-[3px]" aria-hidden>
          {Array.from({ length: SEGMENTS }).map((_, i) => {
            const burned = i < lit;
            const danger = i >= SEGMENTS - 12;
            return (
              <motion.span
                key={i}
                className="flex-1 origin-bottom"
                animate={{
                  backgroundColor: burned ? (danger ? "#c4161c" : "#e0a100") : "#1a1510",
                  scaleY: burned ? 1 : 0.55,
                }}
                transition={{ duration: 0.25 }}
              />
            );
          })}
        </div>
        <div className="mt-3 grid grid-cols-3 font-mono text-[10px] tracking-[0.25em] text-bone-dim">
          <span>H+00 &middot; LAUNCH</span>
          <span className="text-center">H+36</span>
          <span className="text-right text-blood-hot">H+72 &middot; VERDICT</span>
        </div>
      </div>
    </section>
  );
}
