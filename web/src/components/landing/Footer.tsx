import Link from "next/link";
import config from "@/stovia.config.json";
import { Logo } from "./Nav";

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export default function Footer() {
  return (
    <footer className="border-t border-line bg-ink-2/50">
      <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-14 sm:px-8 lg:grid-cols-12 lg:px-12">
        <div className="lg:col-span-5">
          <Logo />
          <p className="mt-4 max-w-sm font-serif italic text-2xl leading-tight text-bone-dim">
            Bet on what survives.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-8 font-mono text-[11px] tracking-[0.2em] text-bone-dim sm:grid-cols-3 lg:col-span-7">
          <div className="space-y-3">
            <div className="text-bone">PRODUCT</div>
            <Link href="/app" className="block hover:text-gold">ENTER APP</Link>
            <a href="#how" className="block hover:text-gold">HOW IT WORKS</a>
            <a href="#fees" className="block hover:text-gold">FEES</a>
          </div>
          <div className="space-y-3">
            <div className="text-bone">PRIVACY</div>
            <a href="#sealed" className="block hover:text-gold">SEALED BETS</a>
            <span className="block">HELIUS PRIVACY RINGS</span>
          </div>
          <div className="col-span-2 space-y-3 sm:col-span-1">
            <div className="text-bone">PROGRAM</div>
            <span className="block break-all normal-case tracking-normal">{short(config.programId)}</span>
          </div>
        </div>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-5 py-5 font-mono text-[10px] tracking-[0.2em] text-bone-dim sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
          <span className="flex items-center gap-2">
            <span className="st-pulse h-1.5 w-1.5 rounded-full bg-gold" />
            LIVE ON SOLANA MAINNET
          </span>
          <span>MEMECOINS ARE RISKY. MOST DIE. TRADE WHAT YOU CAN LOSE.</span>
          <span>&copy; 2026 STOVIA</span>
        </div>
      </div>
    </footer>
  );
}
