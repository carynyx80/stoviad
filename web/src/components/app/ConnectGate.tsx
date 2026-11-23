"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Wallet } from "lucide-react";
import { EmptyState, Skeleton } from "./ui";

/** Renders children only with a connected wallet; otherwise a connect prompt. */
export function ConnectGate({ title, body, children }: { title: string; body: string; children: (address: string) => ReactNode }) {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) return <Skeleton rows={3} />;
  if (!connected || !publicKey) {
    return (
      <EmptyState title={title} body={body}>
        <button type="button" onClick={() => setVisible(true)} className="inline-flex h-12 items-center gap-2 rounded-full bg-gold px-6 font-bold text-ink transition hover:bg-gold-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold">
          <Wallet className="h-4 w-4" aria-hidden /> Connect wallet
        </button>
      </EmptyState>
    );
  }
  return <>{children(publicKey.toBase58())}</>;
}
