"use client";

import { motion } from "framer-motion";
import type { SectionKey } from "@/lib/sections";

// All motifs are deterministic SVG (no Math.random) so SSR == CSR.
const GOLD = "var(--gold)";
const HOT = "var(--gold-hot)";
const BLOOD = "var(--blood-hot)";
const LINE = "var(--line)";
const BONE = "var(--bone)";

function LaunchMotif() {
  const bars = [18, 26, 22, 38, 34, 52, 47, 68, 61, 84, 78, 100];
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden>
      {[150, 115, 80].map((r, i) => (
        <motion.circle
          key={r}
          cx="200" cy="200" r={r} fill="none" stroke={i === 2 ? GOLD : LINE} strokeWidth={i === 2 ? 1.5 : 1}
          strokeDasharray={i === 0 ? "2 8" : undefined}
          animate={{ rotate: i % 2 ? -360 : 360 }}
          transition={{ duration: 40 + i * 12, repeat: Infinity, ease: "linear" }}
          style={{ originX: "200px", originY: "200px" }}
        />
      ))}
      {bars.map((h, i) => (
        <motion.rect
          key={i}
          x={98 + i * 17} width="10" rx="1"
          fill={i === bars.length - 1 ? HOT : GOLD}
          fillOpacity={0.25 + (i / bars.length) * 0.75}
          initial={{ height: 0, y: 290 }}
          animate={{ height: h * 1.6, y: 290 - h * 1.6 }}
          transition={{ delay: 0.15 + i * 0.05, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
        />
      ))}
      <motion.path
        d="M300 120 l14 -26 l14 26 z"
        fill={HOT}
        animate={{ y: [0, -10, 0] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      />
      <line x1="80" y1="290" x2="320" y2="290" stroke={BONE} strokeOpacity="0.3" />
    </svg>
  );
}

function MarketsMotif() {
  const c = [
    [60, 40, 1], [70, 52, 1], [58, 30, 0], [80, 46, 1], [72, 60, 0], [90, 50, 1], [86, 70, 0],
    [104, 62, 1], [98, 80, 0], [76, 92, 0], [70, 96, 0], [112, 84, 1],
  ];
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden>
      {[100, 160, 220, 280].map((y) => (
        <line key={y} x1="40" x2="360" y1={y} y2={y} stroke={LINE} strokeDasharray="3 6" />
      ))}
      {c.map(([top, len, up], i) => (
        <motion.g
          key={i}
          initial={{ opacity: 0, scaleY: 0.2 }}
          animate={{ opacity: 1, scaleY: 1 }}
          transition={{ delay: i * 0.06, duration: 0.5 }}
          style={{ originY: "200px" }}
        >
          <line x1={58 + i * 25} x2={58 + i * 25} y1={340 - top - len - 18} y2={340 - top + 14} stroke={up ? GOLD : BLOOD} strokeWidth="1.5" />
          <rect x={50 + i * 25} y={340 - top - len} width="16" height={len} fill={up ? GOLD : BLOOD} fillOpacity={up ? 0.9 : 0.85} />
        </motion.g>
      ))}
      <motion.circle
        cx="200" cy="200" r="168" fill="none" stroke={BLOOD} strokeWidth="2" strokeDasharray="1056"
        initial={{ strokeDashoffset: 0 }}
        animate={{ strokeDashoffset: 1056 }}
        transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
        transform="rotate(-90 200 200)"
      />
    </svg>
  );
}

function BetsMotif() {
  const ticks = Array.from({ length: 48 }, (_, i) => i);
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden>
      <defs>
        <path id="sealRing" d="M200,200 m-128,0 a128,128 0 1,1 256,0 a128,128 0 1,1 -256,0" />
      </defs>
      <motion.g animate={{ rotate: 360 }} transition={{ duration: 60, repeat: Infinity, ease: "linear" }} style={{ originX: "200px", originY: "200px" }}>
        <text fill={GOLD} fontSize="13" letterSpacing="6" fontFamily="var(--font-mono)">
          <textPath href="#sealRing">COMMIT · CONCEAL · REVEAL · SURVIVE OR DIE · COMMIT · CONCEAL · REVEAL ·</textPath>
        </text>
      </motion.g>
      {ticks.map((i) => (
        <line key={i} x1="200" y1="36" x2="200" y2={i % 4 ? 44 : 52} stroke={i % 4 ? LINE : GOLD} transform={`rotate(${i * 7.5} 200 200)`} />
      ))}
      <motion.circle cx="200" cy="200" r="92" fill="var(--blood)" animate={{ scale: [1, 1.03, 1] }} transition={{ duration: 3, repeat: Infinity }} style={{ originX: "200px", originY: "200px" }} />
      <circle cx="200" cy="200" r="78" fill="none" stroke={BLOOD} strokeWidth="2" strokeDasharray="4 4" />
      <text x="200" y="196" textAnchor="middle" fill={BONE} fontSize="38" fontFamily="var(--font-serif)" fontStyle="italic">sealed</text>
      <text x="200" y="226" textAnchor="middle" fill={HOT} fontSize="12" letterSpacing="5" fontFamily="var(--font-mono)">YES ▮▮ NO</text>
    </svg>
  );
}

function PortfolioMotif() {
  const arcs = [
    { r: 140, len: 0.72, c: GOLD },
    { r: 112, len: 0.48, c: BLOOD },
    { r: 84, len: 0.86, c: HOT },
    { r: 56, len: 0.33, c: BONE },
  ];
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden>
      {arcs.map(({ r, len, c }, i) => {
        const circ = 2 * Math.PI * r;
        return (
          <g key={r} transform="rotate(-90 200 200)">
            <circle cx="200" cy="200" r={r} fill="none" stroke={LINE} strokeWidth="14" />
            <motion.circle
              cx="200" cy="200" r={r} fill="none" stroke={c} strokeWidth="14" strokeLinecap="butt"
              strokeDasharray={circ}
              initial={{ strokeDashoffset: circ }}
              animate={{ strokeDashoffset: circ * (1 - len) }}
              transition={{ delay: 0.1 + i * 0.12, duration: 1.2, ease: [0.22, 1, 0.36, 1] }}
            />
          </g>
        );
      })}
      <text x="200" y="210" textAnchor="middle" fill={BONE} fontSize="30" fontFamily="var(--font-serif)" fontStyle="italic">yours</text>
    </svg>
  );
}

function CreatorMotif() {
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden>
      <circle cx="200" cy="200" r="160" fill="var(--ink-2)" stroke={LINE} strokeWidth="2" />
      <circle cx="200" cy="200" r="150" fill="none" stroke={GOLD} strokeOpacity="0.4" />
      <motion.g animate={{ rotate: [0, 120, 80, 200, 200] }} transition={{ duration: 9, repeat: Infinity, ease: [0.65, 0, 0.35, 1] }} style={{ originX: "200px", originY: "200px" }}>
        {ticks.map((i) => (
          <line key={i} x1="200" y1="62" x2="200" y2={i % 5 ? 72 : 84} stroke={i % 5 ? BONE : GOLD} strokeOpacity={i % 5 ? 0.35 : 1} strokeWidth={i % 5 ? 1 : 2} transform={`rotate(${i * 6} 200 200)`} />
        ))}
        <polygon points="200,96 192,112 208,112" fill={HOT} />
      </motion.g>
      <circle cx="200" cy="200" r="70" fill="var(--ink)" stroke={GOLD} strokeWidth="2" />
      {[0, 60, 120].map((a) => (
        <rect key={a} x="194" y="134" width="12" height="132" rx="2" fill={GOLD} fillOpacity="0.15" transform={`rotate(${a} 200 200)`} />
      ))}
      <text x="200" y="196" textAnchor="middle" fill={GOLD} fontSize="34" fontWeight="800" fontFamily="var(--font-display)">0.1%</text>
      <text x="200" y="220" textAnchor="middle" fill={BONE} fillOpacity="0.7" fontSize="11" letterSpacing="4" fontFamily="var(--font-mono)">CREATOR</text>
    </svg>
  );
}

function LeaderboardMotif() {
  const podium = [
    { x: 70, h: 150, n: "2", c: BONE },
    { x: 155, h: 220, n: "1", c: GOLD },
    { x: 240, h: 110, n: "3", c: BLOOD },
  ];
  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden>
      {podium.map(({ x, h, n, c }, i) => (
        <motion.g key={n} initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.15 + i * 0.12, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
          <rect x={x} y={330 - h} width="80" height={h} fill={c} fillOpacity={n === "1" ? 0.95 : 0.18} stroke={c} />
          <text x={x + 40} y={330 - h + 52} textAnchor="middle" fill={n === "1" ? "var(--ink)" : c} fontSize="44" fontWeight="800" fontFamily="var(--font-display)">{n}</text>
        </motion.g>
      ))}
      <motion.path
        d="M175 80 l10 -24 l15 16 l15 -16 l10 24 z"
        fill={HOT}
        animate={{ y: [0, -6, 0], rotate: [0, -3, 0] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
      />
      <line x1="40" x2="360" y1="330" y2="330" stroke={BONE} strokeOpacity="0.3" />
    </svg>
  );
}

export function Motif({ k }: { k: SectionKey }) {
  switch (k) {
    case "launch": return <LaunchMotif />;
    case "markets": return <MarketsMotif />;
    case "bets": return <BetsMotif />;
    case "portfolio": return <PortfolioMotif />;
    case "creator": return <CreatorMotif />;
    case "leaderboard": return <LeaderboardMotif />;
  }
}
