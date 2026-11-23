"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { StoviaLogo } from "@/components/brand/StoviaLogo";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { ShieldAlert, ShieldCheck, Wallet } from "lucide-react";
import { EmptyState, Skeleton } from "@/components/app/ui";
import { COMPANY_WALLET } from "@/lib/admin/anchor";
import { shortAddr } from "@/lib/format";
import { ProgramPanel } from "./ProgramPanel";
import { ResolverQueue } from "./ResolverQueue";
import { DbcConfigPanel } from "./DbcConfigPanel";

export function AdminConsole() {
  return (
    <div className="relative min-h-[calc(100dvh-64px)] overflow-hidden bg-ink">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_85%_0%,rgba(224,161,0,0.07),transparent_50%),radial-gradient(ellipse_at_0%_100%,rgba(142,11,11,0.18),transparent_45%)]" />
      <header className="relative z-10 flex h-14 items-center justify-between gap-3 border-b border-line px-4 sm:px-8">
        <span className="inline-flex items-center gap-2 rounded-sm border border-blood-hot/50 bg-blood/20 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-bone">
          <ShieldAlert className="h-3.5 w-3.5 text-blood-hot" aria-hidden /> Admin
        </span>
        <Link href="/" className="font-display text-base font-extrabold tracking-tight text-bone">
          <StoviaLogo markClassName="h-6 w-6" textClassName="text-[22px]" />
        </Link>
      </header>
      <div className="relative z-10 mx-auto max-w-[1400px] px-4 pb-16 pt-10 sm:px-8 sm:pt-14">
        <h1 className="font-display leading-[0.9] tracking-[-0.045em]">
          <span className="block text-[clamp(2.25rem,7vw,5.5rem)] font-extrabold text-bone">Company console</span>
          <span className="block font-serif text-[clamp(1.5rem,4vw,3rem)] font-normal italic tracking-[-0.02em] text-gold">your wallet, your signature.</span>
        </h1>
        <p className="mt-5 max-w-[60ch] text-base text-bone-dim">
          Every Stovia on-chain operation is signed here by the company wallet in your own browser wallet. Stovia never holds this key. Solana mainnet only.
        </p>
        <div className="mt-10 sm:mt-14">
          <Gate />
        </div>
      </div>
    </div>
  );
}

function Gate() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <Skeleton rows={3} />;
  if (!connected || !publicKey) {
    return (
      <EmptyState title="Connect the company wallet" body={`Only ${shortAddr(COMPANY_WALLET.toBase58(), 6, 6)} can use this console.`}>
        <button type="button" onClick={() => setVisible(true)} className="inline-flex h-12 items-center gap-2 rounded-full bg-gold px-6 font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
          <Wallet className="h-4 w-4" aria-hidden /> Connect wallet
        </button>
      </EmptyState>
    );
  }
  if (!publicKey.equals(COMPANY_WALLET)) {
    return (
      <EmptyState title="Company wallet only" body={<>Connected as <span className="font-mono text-bone">{shortAddr(publicKey.toBase58(), 6, 6)}</span>. Switch to the company wallet in your wallet extension to continue.</>}>
        <button type="button" onClick={() => setVisible(true)} className="inline-flex h-12 items-center gap-2 rounded-full border border-line px-6 font-bold text-bone transition hover:border-gold/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
          <Wallet className="h-4 w-4" aria-hidden /> Change wallet
        </button>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-10">
      <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-gold">
        <ShieldCheck className="h-4 w-4" aria-hidden /> Company wallet verified · {shortAddr(COMPANY_WALLET.toBase58(), 6, 6)}
      </p>
      <DbcConfigPanel />
      <ProgramPanel />
      <ResolverQueue />
    </div>
  );
}
