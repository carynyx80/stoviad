import { PublicKey } from "@solana/web3.js";

export {
  DBC_PROGRAM_ID,
  DBC_PARTNER,
  WSOL_MINT,
  FEE_BREAKDOWN_BPS,
  TOKEN_DECIMALS,
  TOKEN_SUPPLY,
  INITIAL_MCAP_SOL,
  MIGRATION_MCAP_SOL,
} from "./params";

/**
 * The Stovia DBC partner config. A DBC config is a fresh keypair account (not a PDA), so its
 * address is only known after the admin console creates it. Set NEXT_PUBLIC_DBC_CONFIG to the
 * address the console prints; until then launching shows "Stovia config not created yet".
 */
function parseConfig(): PublicKey | null {
  const raw = (process.env.NEXT_PUBLIC_DBC_CONFIG ?? "").trim();
  if (!raw) return null;
  try {
    return new PublicKey(raw);
  } catch {
    return null;
  }
}
export const DBC_CONFIG: PublicKey | null = parseConfig();

/** Public site origin used for token metadata URIs (stable: the URI is written on-chain forever). */
export const SITE_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.stovia.xyz").replace(/\/+$/, "");

export const RESOLVER_URL = (process.env.NEXT_PUBLIC_RESOLVER_URL || "https://stovia-resolver-production.up.railway.app").replace(/\/+$/, "");

/** Metaplex limits enforced on-chain. */
export const MAX_NAME_LEN = 32;
export const MAX_SYMBOL_LEN = 10;
export const MAX_URI_LEN = 200;

/**
 * Token metadata URI. If the creator already hosts a Metaplex JSON (IPFS/Arweave/https ending in
 * .json) it is used as-is; otherwise we point at Stovia's stateless /api/meta route, which renders
 * the JSON purely from the query string. Since the URI is immutable on-chain, the metadata is
 * effectively content-addressed: nothing is stored server-side and nothing can be changed later.
 */
export function metadataUri(name: string, symbol: string, image: string): string {
  if (/^(https?:\/\/|ipfs:\/\/|ar:\/\/)\S+\.json(\?\S*)?$/i.test(image)) return image;
  const q = new URLSearchParams({ n: name, s: symbol });
  if (image) q.set("i", image);
  return `${SITE_ORIGIN}/api/meta?${q.toString()}`;
}
