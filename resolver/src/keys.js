// Key management. Secrets come only from env and are never logged or returned by the API.
//
// Market shielded identity:
//   ikm  = RESOLVER_MASTER_SEED (32 bytes, hex)
//   seed = HKDF-SHA256(ikm, salt = "", info = "stovia-market:" + marketPubkeyBase58, L = 32)
//   keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed))
// Deterministic: the same master seed always recovers every market's identity, so the
// resolver needs no per-market key storage and a restart loses nothing. Losing the master
// seed loses every unpaid stake; leaking it hands an attacker every market's funds.
import { hkdfSync } from "node:crypto";
import { ShieldedKeypair, SigningKey, initializePoseidon } from "@heliuslabs/spr";
import { address } from "@solana/kit";
import { hexToBytes, bytesToHex } from "./crypto.js";

export const MARKET_INFO_PREFIX = "stovia-market:";

export function parseMasterSeed(hex) {
  if (!hex) throw new Error("RESOLVER_MASTER_SEED is not set");
  const seed = hexToBytes(hex.trim(), 32);
  if (seed.every((b) => b === 0)) throw new Error("RESOLVER_MASTER_SEED must not be all zero");
  return seed;
}

/** Raw 32-byte Ed25519 seed for a market's shielded identity. Caller must wipe it. */
export function deriveMarketSeed(masterSeed, market) {
  const m = address(market); // validates base58 pubkey
  return new Uint8Array(hkdfSync("sha256", masterSeed, new Uint8Array(0), MARKET_INFO_PREFIX + m, 32));
}

let poseidonReady;
const ensurePoseidon = () => (poseidonReady ??= initializePoseidon());

export class MarketIdentities {
  #master;
  #cache = new Map();
  constructor(masterSeed) {
    this.#master = masterSeed;
  }
  /** @returns {Promise<{market: string, keypair: ShieldedKeypair, shieldedAddress: any, shieldedAddressBytes: Uint8Array, ownerSolanaAddress: string}>} */
  async get(market) {
    const m = address(market);
    const hit = this.#cache.get(m);
    if (hit) return hit;
    await ensurePoseidon();
    const seed = deriveMarketSeed(this.#master, m);
    try {
      const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed));
      const shieldedAddress = keypair.shieldedAddress();
      const id = {
        market: m,
        keypair,
        shieldedAddress,
        shieldedAddressBytes: shieldedAddress.toBytes(),
        ownerSolanaAddress: shieldedAddress.solanaAddress(),
      };
      this.#cache.set(m, id);
      return id;
    } finally {
      seed.fill(0);
    }
  }
  /** Public, safe-to-publish view. */
  async publicInfo(market) {
    const id = await this.get(market);
    return {
      market: id.market,
      shieldedAddressHex: bytesToHex(id.shieldedAddressBytes),
      shieldedAddressBase64: Buffer.from(id.shieldedAddressBytes).toString("base64"),
      ownerSolanaAddress: id.ownerSolanaAddress,
    };
  }
  // Keep secrets out of accidental JSON.stringify / console.log / util.inspect.
  toJSON() {
    return "[MarketIdentities]";
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return "[MarketIdentities]";
  }
}
