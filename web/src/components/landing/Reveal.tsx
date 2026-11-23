"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

export default function Reveal({
  children,
  delay = 0,
  y = 40,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-10% 0px" }}
      transition={{ duration: 0.9, delay, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

export function Eyebrow({ n, children }: { n: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 font-mono text-[11px] tracking-[0.25em] text-bone-dim">
      <span className="text-gold">{n}</span>
      <span className="h-px w-10 bg-line" />
      <span>{children}</span>
    </div>
  );
}
