import cfg from "@/stovia.config.json";

export const STOVIA = cfg;
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");
/**
 * HTTP JSON-RPC: the Stovia API's Helius proxy when the API is configured (key stays
 * server-side), else NEXT_PUBLIC_RPC_URL, else the public mainnet endpoint.
 */
export const RPC_ENDPOINT = API_URL
  ? `${API_URL}/rpc`
  : process.env.NEXT_PUBLIC_RPC_URL && process.env.NEXT_PUBLIC_RPC_URL.length > 0
    ? process.env.NEXT_PUBLIC_RPC_URL
    : "https://api.mainnet-beta.solana.com";
/** The proxy is HTTP-only, so subscriptions go to the public mainnet websocket. */
export const WS_ENDPOINT = "wss://api.mainnet-beta.solana.com";

/** The on-chain program is not deployed yet; all tx buttons show a "soon" state. */
export const PROGRAM_LIVE = false;

export const PLATFORM_FEE_PCT = cfg.platformFeeBps / 100; // 0.1
export const CREATOR_FEE_PCT = cfg.creatorFeeBps / 100; // 0.1
