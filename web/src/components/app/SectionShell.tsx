import Link from "next/link";
import { StoviaLogo } from "@/components/brand/StoviaLogo";
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { SECTIONS, sectionByKey, sectionIndex, type SectionKey } from "@/lib/sections";

const pad = (n: number) => String(n).padStart(2, "0");

export function SectionShell({ k, children, aside }: { k: SectionKey; children: ReactNode; aside?: ReactNode }) {
  const s = sectionByKey(k);
  const i = sectionIndex(k);
  const accent = s.tone === "gold" ? "text-gold" : "text-blood-hot";
  return (
    <div className="relative min-h-[calc(100dvh-96px)] overflow-hidden bg-ink">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_85%_0%,rgba(224,161,0,0.07),transparent_50%),radial-gradient(ellipse_at_0%_100%,rgba(142,11,11,0.18),transparent_45%)]" />
      <header className="relative z-10 flex h-14 items-center justify-between gap-3 border-b border-line px-4 sm:px-8">
        <Link href="/app" className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone-dim transition hover:text-gold focus-visible:outline-2 focus-visible:outline-gold">
          <ArrowLeft className="h-4 w-4" aria-hidden /> All sections
        </Link>
        <nav aria-label="Sections" className="hidden items-center gap-4 lg:flex">
          {SECTIONS.map((sec) => (
            <Link
              key={sec.key}
              href={sec.href}
              aria-current={sec.key === k ? "page" : undefined}
              className={`font-mono text-[11px] uppercase tracking-[0.14em] transition focus-visible:outline-2 focus-visible:outline-gold ${sec.key === k ? "text-bone" : "text-bone-dim/60 hover:text-bone-dim"}`}
            >
              {sec.label}
            </Link>
          ))}
        </nav>
        <Link href="/" className="font-display text-base font-extrabold tracking-tight text-bone">
          <StoviaLogo markClassName="h-6 w-6" textClassName="text-[22px]" />
        </Link>
      </header>

      <div className="relative z-10 mx-auto max-w-[1400px] px-4 pb-16 pt-10 sm:px-8 sm:pt-14">
        <p className="mb-4 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.24em] text-bone-dim">
          <span className={accent}>{pad(i + 1)}</span>
          <span aria-hidden className="h-px w-10 bg-bone-dim/40" />
          {s.label}
        </p>
        <h1 className="font-display leading-[0.88] tracking-[-0.045em]">
          <span className="block text-[clamp(2.75rem,9vw,7.5rem)] font-extrabold text-bone">{s.title}</span>
          <span className={`block font-serif text-[clamp(1.75rem,5vw,4.25rem)] font-normal italic tracking-[-0.02em] ${accent}`}>{s.accent}</span>
        </h1>
        <p className="mt-5 max-w-[52ch] text-base text-bone-dim sm:text-lg">{s.pitch}</p>
        {aside}
        <div className="mt-10 sm:mt-14">{children}</div>
      </div>
    </div>
  );
}
