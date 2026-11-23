"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import MagneticCTA from "./Magnetic";

export default function FinalCTA() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const x = useTransform(scrollYProgress, [0, 1], ["8%", "-28%"]);

  return (
    <section ref={ref} className="relative overflow-hidden border-t border-line py-24 sm:py-36">
      <motion.div
        style={{ x }}
        aria-hidden
        className="pointer-events-none whitespace-nowrap font-display font-extrabold uppercase leading-none tracking-[-0.05em] text-[22vw] text-blood/40"
      >
        Rugged? Paid. Rugged? Paid.
      </motion.div>
      <div className="relative mx-auto -mt-[11vw] max-w-[1440px] px-5 sm:px-8 lg:px-12">
        <div className="grid gap-10 lg:grid-cols-12 lg:items-end">
          <h2 className="lg:col-span-8 font-display font-extrabold uppercase leading-[0.88] tracking-[-0.04em] text-[11vw] sm:text-7xl lg:text-[104px]">
            The launchpad that
            <span className="block font-serif italic font-normal normal-case text-gold tracking-[-0.02em]">
              pays you when you get rugged.
            </span>
          </h2>
          <div className="lg:col-span-4 lg:justify-self-end">
            <MagneticCTA />
          </div>
        </div>
      </div>
    </section>
  );
}
