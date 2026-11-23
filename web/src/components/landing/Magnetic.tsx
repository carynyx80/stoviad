"use client";

import Link from "next/link";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { useRef } from "react";

export default function MagneticCTA({
  href = "/app",
  label = "Enter App",
  size = "lg",
}: {
  href?: string;
  label?: string;
  size?: "lg" | "md";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 15, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 220, damping: 15, mass: 0.4 });

  function onMove(e: React.PointerEvent) {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse") return;
    const r = el.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * 0.35);
    y.set((e.clientY - (r.top + r.height / 2)) * 0.45);
  }
  function onLeave() {
    x.set(0);
    y.set(0);
  }

  const pad = size === "lg" ? "h-16 sm:h-20 pl-7 pr-3 sm:pl-9 text-xl sm:text-2xl" : "h-12 pl-5 pr-2 text-base";
  const dot = size === "lg" ? "h-11 w-11 sm:h-14 sm:w-14" : "h-8 w-8";

  return (
    <div ref={ref} onPointerMove={onMove} onPointerLeave={onLeave} className="inline-block p-3 -m-3">
      <motion.div style={{ x: sx, y: sy }}>
        <Link
          href={href}
          className={`group relative inline-flex items-center gap-4 rounded-full bg-gold text-ink font-display font-extrabold tracking-tight overflow-hidden ${pad} shadow-[0_0_0_1px_rgba(224,161,0,0.4),0_20px_60px_-15px_rgba(224,161,0,0.55)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold`}
        >
          <span className="absolute inset-0 translate-y-full bg-bone transition-transform duration-500 ease-[cubic-bezier(.2,.8,.2,1)] group-hover:translate-y-0" />
          <span className="relative">{label}</span>
          <span className={`relative grid place-items-center rounded-full bg-ink text-gold ${dot} transition-transform duration-500 group-hover:rotate-45`}>
            <ArrowUpRight className="h-1/2 w-1/2" strokeWidth={2.5} />
          </span>
        </Link>
      </motion.div>
    </div>
  );
}
