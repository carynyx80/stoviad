"use client";

import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { apiConfigured } from "@/lib/api";
import type { ApiState } from "@/lib/useApi";

export function Panel({ children, className = "", title, kicker }: { children: ReactNode; className?: string; title?: ReactNode; kicker?: string }) {
  return (
    <section className={`min-w-0 rounded-sm border border-line bg-ink-2/80 p-5 sm:p-7 ${className}`}>
      {kicker && <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-bone-dim">{kicker}</p>}
      {title && <h2 className="mb-5 font-display text-xl font-bold tracking-tight text-bone sm:text-2xl">{title}</h2>}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "gold" | "blood" }) {
  return (
    <div className="min-w-0 border-l border-line pl-4">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-dim">{label}</p>
      <p className={`mt-1 truncate font-display text-2xl font-extrabold tracking-tight sm:text-3xl ${tone === "gold" ? "text-gold" : tone === "blood" ? "text-blood-hot" : "text-bone"}`}>{value}</p>
    </div>
  );
}

export function EmptyState({ title, body, children }: { title: string; body: ReactNode; children?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-sm border border-dashed border-line px-6 py-14 text-center sm:py-20"
    >
      <div aria-hidden className="mx-auto mb-6 h-16 w-16 rounded-full border border-gold/40 bg-[radial-gradient(circle,rgba(224,161,0,0.25),transparent_70%)]" />
      <p className="font-serif text-3xl italic text-bone sm:text-4xl">{title}</p>
      <div className="mx-auto mt-3 max-w-[46ch] text-sm text-bone-dim sm:text-base">{body}</div>
      {children && <div className="mt-6 flex justify-center">{children}</div>}
    </motion.div>
  );
}

export function apiEmptyCopy(reason: Extract<ApiState<unknown>, { status: "empty" }>["reason"], what: string): string {
  if (reason === "empty") return `No ${what} yet. The first ones appear the moment the program goes live on mainnet.`;
  if (!apiConfigured() || reason === "unset") return `Live ${what} will stream in once the Stovia indexer is connected.`;
  return `The Stovia indexer isn't answering right now. ${what[0].toUpperCase()}${what.slice(1)} will reappear automatically.`;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-sm bg-ink-3/70" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </div>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="mb-2 block font-mono text-[11px] uppercase tracking-[0.18em] text-bone-dim">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-bone-dim/80">{hint}</p>}
    </div>
  );
}

export const inputCls =
  "h-12 w-full min-w-0 rounded-sm border border-line bg-ink px-4 font-display text-base text-bone placeholder:text-bone-dim/50 transition focus:border-gold focus:outline-none focus-visible:ring-1 focus-visible:ring-gold";

export function StatusPill({ status }: { status?: string }) {
  const s = (status ?? "live").toLowerCase();
  const cls = s === "survived" ? "border-gold/50 text-gold" : s === "died" || s === "dead" ? "border-blood-hot/60 text-blood-hot" : "border-bone-dim/40 text-bone";
  return <span className={`inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] ${cls}`}>{s}</span>;
}

export function TokenAvatar({ src, ticker }: { src?: string; ticker: string }) {
  return (
    <span className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full border border-line bg-ink-3 font-display text-xs font-bold text-gold">
      {ticker.slice(0, 3) || "?"}
      {src && /^https?:\/\//.test(src) && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={(e) => { e.currentTarget.style.display = "none"; }} />
      )}
    </span>
  );
}
