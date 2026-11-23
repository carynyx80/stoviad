import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-display font-extrabold tracking-tight ${className}`}>
      <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
        <circle cx="16" cy="16" r="14" fill="none" stroke="var(--gold)" strokeWidth="2.5" />
        <path d="M16 6 V16 L23 21" fill="none" stroke="var(--bone)" strokeWidth="2.5" strokeLinecap="square" />
        <circle cx="16" cy="16" r="2.5" fill="var(--blood-hot)" />
      </svg>
      <span className="text-xl">Stovia</span>
    </span>
  );
}

export default function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-ink/75 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-5 sm:px-8 lg:px-12">
        <Link href="/" aria-label="Stovia home">
          <Logo />
        </Link>
        <nav className="hidden md:flex items-center gap-8 font-mono text-[11px] tracking-[0.25em] text-bone-dim">
          <a href="#how" className="hover:text-gold transition-colors">HOW IT WORKS</a>
          <a href="#sealed" className="hover:text-gold transition-colors">WHY SEALED</a>
          <a href="#fees" className="hover:text-gold transition-colors">FEES</a>
        </nav>
        <Link
          href="/app"
          className="group inline-flex items-center gap-2 border border-gold px-4 py-2 font-mono text-[11px] tracking-[0.25em] text-gold transition-colors hover:bg-gold hover:text-ink"
        >
          ENTER APP <span className="transition-transform group-hover:translate-x-0.5">&rarr;</span>
        </Link>
      </div>
    </header>
  );
}
