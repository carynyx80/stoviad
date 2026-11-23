import cfg from "@/stovia.config.json";

export const STOVIA = cfg;
export const RPC_ENDPOINT =
  process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL.length > 0
    ? process.env.NEXT_PUBLIC_RPC_URL
    : "https://api.mainnet-beta.solana.com";
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

/** The on-chain program is not deployed yet; all tx buttons show a "soon" state. */
export const PROGRAM_LIVE = false;

export const PLATFORM_FEE_PCT = cfg.platformFeeBps / 100; // 0.1
export const CREATOR_FEE_PCT = cfg.creatorFeeBps / 100; // 0.1
