"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion, type PanInfo, type Variants } from "framer-motion";
import { ArrowLeft, ArrowRight, ArrowUpRight } from "lucide-react";
import { SECTIONS } from "@/lib/sections";
import { Motif } from "./Motifs";

const N = SECTIONS.length;
const pad = (n: number) => String(n).padStart(2, "0");
const EASE = [0.22, 1, 0.36, 1] as const;

export function Slideshow() {
  const [[index, dir], setState] = useState<[number, number]>([0, 0]);
  const reduce = useReducedMotion();
  const lastWheel = useRef(0);

  const go = useCallback((next: number) => {
    setState(([cur]) => {
      const clamped = Math.max(0, Math.min(N - 1, next));
      if (clamped === cur) return [cur, 0];
      return [clamped, clamped > cur ? 1 : -1];
    });
  }, []);
  const step = useCallback((d: number) => setState(([cur]) => {
    const n = Math.max(0, Math.min(N - 1, cur + d));
    return n === cur ? [cur, 0] : [n, d];
  }), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (document.querySelector(".wallet-adapter-modal")) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); step(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); step(-1); }
      else if (e.key === "Home") { e.preventDefault(); go(0); }
      else if (e.key === "End") { e.preventDefault(); go(N - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, step]);

  const onWheel = (e: React.WheelEvent) => {
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < 24) return;
    const now = e.timeStamp;
    if (now - lastWheel.current < 750) return;
    lastWheel.current = now;
    step(d > 0 ? 1 : -1);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const swipe = info.offset.x + info.velocity.x * 0.2;
    if (swipe < -90) step(1);
    else if (swipe > 90) step(-1);
  };

  const s = SECTIONS[index];
  const accent = s.tone === "gold" ? "text-gold" : "text-blood-hot";

  const slideV: Variants = {
    enter: (d: number) => ({ x: reduce ? 0 : d >= 0 ? "18%" : "-18%", opacity: 0 }),
    center: { x: 0, opacity: 1, transition: { duration: 0.7, ease: EASE } },
    exit: (d: number) => ({ x: reduce ? 0 : d >= 0 ? "-12%" : "12%", opacity: 0, transition: { duration: 0.4, ease: EASE } }),
  };
  const item: Variants = {
    enter: { y: reduce ? 0 : 40, opacity: 0 },
    center: (i: number) => ({ y: 0, opacity: 1, transition: { delay: 0.12 + i * 0.07, duration: 0.7, ease: EASE } }),
    exit: { opacity: 0, transition: { duration: 0.2 } },
  };

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Stovia app sections"
      className="relative flex h-[calc(100dvh-96px)] min-h-[560px] flex-col overflow-hidden bg-ink"
      onWheel={onWheel}
    >
      {/* grain / vignette */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_70%_40%,rgba(224,161,0,0.08),transparent_55%),radial-gradient(ellipse_at_10%_100%,rgba(142,11,11,0.22),transparent_50%)]" />

      {/* Top bar */}
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between px-4 sm:px-8">
        <Link href="/" className="font-display text-lg font-extrabold tracking-tight text-bone focus-visible:outline-2 focus-visible:outline-gold">
          STOVIA<span className="text-gold">.</span>
        </Link>
        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-bone-dim">
          <span className="hidden sm:inline">The app</span>
          <span aria-hidden className="hidden h-px w-8 bg-line sm:inline-block" />
          <span className="text-bone" aria-live="polite" aria-atomic>
            <span className={accent}>{pad(index + 1)}</span> / {pad(N)}
          </span>
        </div>
      </header>
      <div className="relative z-20 mx-4 h-px bg-line sm:mx-8" aria-hidden>
        <motion.div
          className={`absolute inset-y-0 left-0 ${s.tone === "gold" ? "bg-gold" : "bg-blood-hot"}`}
          initial={false}
          animate={{ width: `${((index + 1) / N) * 100}%` }}
          transition={{ duration: 0.6, ease: EASE }}
          style={{ height: 2, top: -0.5 }}
        />
      </div>

      {/* Slides */}
      <div className="relative flex-1">
        <AnimatePresence initial={false} custom={dir}>
          <motion.article
            key={s.key}
            custom={dir}
            variants={slideV}
            initial="enter"
            animate="center"
            exit="exit"
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.18}
            onDragEnd={onDragEnd}
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${N}: ${s.label}`}
            className="absolute inset-0 cursor-grab touch-pan-y select-none active:cursor-grabbing"
          >
            {/* giant numeral */}
            <motion.span
              aria-hidden
              custom={0}
              variants={item}
              className="pointer-events-none absolute -bottom-[6vw] right-[-2vw] font-display font-extrabold leading-none text-transparent [-webkit-text-stroke:1px_var(--line)] text-[46vw] md:text-[30vw]"
            >
              {pad(index + 1)}
            </motion.span>

            <div className="relative mx-auto grid h-full max-w-[1600px] grid-cols-1 items-center gap-6 px-4 sm:px-8 md:grid-cols-[1.25fr_1fr] md:gap-10">
              {/* motif: background on mobile, column on desktop */}
              <motion.div
                aria-hidden
                initial={{ opacity: 0, scale: reduce ? 1 : 0.9, rotate: reduce ? 0 : -6 }}
                animate={{ opacity: 1, scale: 1, rotate: 0, transition: { delay: 0.2, duration: 0.9, ease: EASE } }}
                className="pointer-events-none absolute right-[-12%] top-[2%] w-[78%] max-w-[340px] opacity-35 md:pointer-events-auto md:relative md:right-auto md:top-auto md:order-2 md:w-full md:max-w-[560px] md:justify-self-center md:opacity-100"
              >
                <div className="aspect-square w-full">
                  <Motif k={s.key} />
                </div>
              </motion.div>

              <div className="relative z-10 flex flex-col justify-center pt-16 md:order-1 md:pt-0">
                <motion.p custom={1} variants={item} className="mb-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-bone-dim sm:text-xs">
                  <span className={accent}>{pad(index + 1)}</span>
                  <span aria-hidden className="h-px w-10 bg-bone-dim/40" />
                  {s.tag}
                </motion.p>
                <h2 className="font-display leading-[0.86] tracking-[-0.045em]">
                  <motion.span custom={2} variants={item} className="block text-[clamp(3rem,12.5vw,11.5rem)] font-extrabold text-bone">
                    {s.title}
                  </motion.span>
                  <motion.span custom={3} variants={item} className={`block font-serif text-[clamp(2rem,7.5vw,6.5rem)] font-normal italic tracking-[-0.02em] ${accent}`}>
                    {s.accent}
                  </motion.span>
                </h2>
                <motion.p custom={4} variants={item} className="mt-6 max-w-[34ch] text-base leading-snug text-bone-dim sm:text-xl md:text-2xl">
                  {s.pitch}
                </motion.p>
                <motion.div custom={5} variants={item} className="mt-8 flex flex-wrap items-center gap-5">
                  <Link
                    href={s.href}
                    draggable={false}
                    className={`group inline-flex h-14 items-center gap-3 rounded-full pl-7 pr-2 font-display text-base font-bold transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-gold sm:text-lg ${
                      s.tone === "gold" ? "bg-gold text-ink hover:bg-gold-hot" : "bg-blood text-bone hover:bg-blood-hot"
                    }`}
                  >
                    {s.cta}
                    <span className={`flex h-10 w-10 items-center justify-center rounded-full transition group-hover:rotate-45 ${s.tone === "gold" ? "bg-ink text-gold" : "bg-bone text-blood"}`}>
                      <ArrowUpRight className="h-5 w-5" aria-hidden />
                    </span>
                  </Link>
                  <span className="hidden font-mono text-[11px] uppercase tracking-[0.2em] text-bone-dim sm:inline">
                    Swipe · ← → keys
                  </span>
                </motion.div>
              </div>
            </div>
          </motion.article>
        </AnimatePresence>
      </div>

      {/* Controls */}
      <nav aria-label="Slides" className="relative z-20 flex h-16 shrink-0 items-center gap-3 border-t border-line px-4 sm:px-8">
        <button
          type="button"
          onClick={() => step(-1)}
          disabled={index === 0}
          aria-label="Previous slide"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-bone transition hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-gold disabled:opacity-30"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>

        <ol className="flex min-w-0 flex-1 items-center justify-center gap-2 lg:justify-between lg:gap-1">
          {SECTIONS.map((sec, i) => {
            const active = i === index;
            return (
              <li key={sec.key} className="lg:min-w-0 lg:flex-1">
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-label={`Go to slide ${i + 1}: ${sec.label}`}
                  aria-current={active ? "true" : undefined}
                  className="group flex w-full items-center justify-center gap-2 rounded-sm py-2 focus-visible:outline-2 focus-visible:outline-gold lg:justify-start lg:px-2"
                >
                  <span
                    className={`block h-1.5 rounded-full transition-all duration-500 lg:hidden ${
                      active ? `w-7 ${sec.tone === "gold" ? "bg-gold" : "bg-blood-hot"}` : "w-1.5 bg-bone-dim/40"
                    }`}
                  />
                  <span className={`hidden truncate whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.14em] transition lg:inline ${active ? "text-bone" : "text-bone-dim/60 group-hover:text-bone-dim"}`}>
                    <span className={active ? (sec.tone === "gold" ? "text-gold" : "text-blood-hot") : ""}>{pad(i + 1)}</span>{" "}
                    {sec.label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <button
          type="button"
          onClick={() => step(1)}
          disabled={index === N - 1}
          aria-label="Next slide"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line text-bone transition hover:border-gold hover:text-gold focus-visible:outline-2 focus-visible:outline-gold disabled:opacity-30"
        >
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </nav>
    </section>
  );
}
