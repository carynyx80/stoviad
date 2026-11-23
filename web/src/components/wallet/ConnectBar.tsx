"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Check, Copy, LogOut, Wallet } from "lucide-react";
import { useSolBalance } from "./useSolBalance";
import { fmtSol, shortAddr } from "@/lib/format";
import PoweredByHelius from "@/components/brand/PoweredByHelius";

export const BAR_HEIGHT = 64;

export function ConnectBar() {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const { balance, loading } = useSolBalance();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setMounted(true), []);

  const addr = publicKey?.toBase58() ?? "";
  const isOn = mounted && connected && !!publicKey;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div
      role="region"
      aria-label="Wallet"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-ink/95 backdrop-blur-md"
      style={{ height: BAR_HEIGHT, paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold/60 to-transparent" />
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-2 px-3 sm:gap-4 sm:px-6">
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-gold/40 bg-gold/10 px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-gold sm:text-[11px]"
          title="Solana mainnet-beta"
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-gold opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-gold" />
          </span>
          Mainnet
        </span>
        <PoweredByHelius className="hidden shrink-0 lg:inline-flex" />

        <div className="min-w-0 flex-1 font-mono text-[11px] text-bone-dim sm:text-xs">
          {isOn ? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="hidden uppercase tracking-[0.14em] sm:inline">Balance</span>
              <span className="truncate text-sm font-semibold text-bone sm:text-base" aria-live="polite">
                {balance == null ? (loading ? "…" : "—") : fmtSol(balance, 4)}
              </span>
              <span className="text-gold">SOL</span>
            </span>
          ) : (
            <span className="hidden truncate uppercase tracking-[0.14em] sm:inline">
              Wallet not connected · <span className="font-serif text-sm normal-case italic tracking-normal text-bone">bets stay sealed</span>
            </span>
          )}
        </div>

        {isOn ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={copy}
              className="group inline-flex h-10 items-center gap-2 rounded-sm border border-line bg-ink-2 px-3 font-mono text-xs text-bone transition hover:border-gold/60 focus-visible:outline-2 focus-visible:outline-gold"
              aria-label={`Copy address ${addr}`}
            >
              {wallet?.adapter.icon ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={wallet.adapter.icon} alt="" className="h-4 w-4" />
              ) : (
                <Wallet className="h-4 w-4 text-gold" aria-hidden />
              )}
              {shortAddr(addr)}
              {copied ? <Check className="h-3.5 w-3.5 text-gold" aria-hidden /> : <Copy className="h-3.5 w-3.5 text-bone-dim group-hover:text-gold" aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => disconnect().catch(() => {})}
              className="inline-flex h-10 w-10 items-center justify-center rounded-sm border border-line bg-ink-2 text-bone-dim transition hover:border-blood-hot hover:text-blood-hot focus-visible:outline-2 focus-visible:outline-gold"
              aria-label="Disconnect wallet"
              title="Disconnect"
            >
              <LogOut className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setVisible(true)}
            disabled={mounted && connecting}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-sm bg-gold px-4 font-display text-sm font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-70 sm:px-6"
          >
            <Wallet className="h-4 w-4" aria-hidden />
            {mounted && connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </div>
    </div>
  );
}
