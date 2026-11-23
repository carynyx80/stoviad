"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { WalletAdapterNetwork, type WalletError } from "@solana/wallet-adapter-base";
// Direct adapter imports (not the @solana/wallet-adapter-wallets barrel, which
// drags in WalletConnect/reown/viem and floods webpack with warnings).
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { RPC_ENDPOINT } from "@/lib/config";

import "@solana/wallet-adapter-react-ui/styles.css";
import "./wallet-theme.css";

/** Stovia is mainnet-only. There is intentionally no network switcher. */
export const NETWORK = WalletAdapterNetwork.Mainnet;

export function SolanaProvider({ children }: { children: ReactNode }) {
  // Phantom + Solflare explicitly; any other Wallet Standard wallet
  // (Backpack, Glow, etc.) is auto-detected by WalletProvider.
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: NETWORK })],
    [],
  );

  // Swallow adapter errors (e.g. user closed the popup) instead of console.error.
  const onError = useCallback((_error: WalletError) => {}, []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
