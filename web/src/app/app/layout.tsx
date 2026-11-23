import type { Metadata } from "next";
import { SolanaProvider } from "@/components/wallet/SolanaProvider";
import { ConnectBar } from "@/components/wallet/ConnectBar";

export const metadata: Metadata = {
  title: "Stovia App — launch, bet, survive",
  description: "Launch Solana memecoins with sealed survival markets. Mainnet only.",
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SolanaProvider>
      <div className="min-h-[100dvh] overflow-x-hidden pb-16">{children}</div>
      <ConnectBar />
    </SolanaProvider>
  );
}
