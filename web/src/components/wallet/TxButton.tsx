"use client";

import { useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AnimatePresence, motion } from "framer-motion";
import { Hourglass, Wallet } from "lucide-react";
import { PROGRAM_LIVE } from "@/lib/config";

/**
 * Transaction trigger. Not connected -> opens the wallet modal.
 * Connected -> shows the "program launching soon" state (no fake txs).
 */
export function TxButton({
  children,
  tone = "gold",
  disabled,
  className = "",
}: {
  children: ReactNode;
  tone?: "gold" | "blood" | "bone";
  disabled?: boolean;
  className?: string;
}) {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [soon, setSoon] = useState(false);

  const toneCls =
    tone === "blood"
      ? "bg-blood text-bone hover:bg-blood-hot"
      : tone === "bone"
        ? "bg-bone text-ink hover:bg-white"
        : "bg-gold text-ink hover:bg-gold-hot";

  const onClick = () => {
    if (!connected) {
      setVisible(true);
      return;
    }
    if (!PROGRAM_LIVE) setSoon(true);
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled && connected}
        className={`inline-flex h-14 w-full items-center justify-center gap-2 rounded-sm px-6 font-display text-base font-bold tracking-tight transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40 ${toneCls}`}
      >
        {!connected && <Wallet className="h-4 w-4" aria-hidden />}
        {connected ? children : "Connect wallet to continue"}
      </button>
      <AnimatePresence>
        {soon && connected && (
          <motion.p
            role="status"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-3 flex items-start gap-2 border-l-2 border-gold pl-3 text-sm text-bone-dim"
          >
            <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-gold" aria-hidden />
            <span>
              <span className="font-semibold text-bone">Program launching soon on mainnet.</span> Nothing was signed or sent — the Stovia program isn&apos;t deployed yet.
            </span>
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
