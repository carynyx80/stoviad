"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

/** Mainnet SOL balance of the connected wallet. null = unknown/unavailable. */
export function useSolBalance(pollMs = 30_000) {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        if (alive) setBalance(lamports / LAMPORTS_PER_SOL);
      } catch {
        if (alive) setBalance(null);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    const id = window.setInterval(load, pollMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [connection, publicKey, pollMs]);

  return { balance, loading };
}
