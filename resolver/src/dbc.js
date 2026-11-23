// Meteora Dynamic Bonding Curve (DBC) pool reads. Read-only; no SDK dependency (layout decoded by hand
// from the program IDL shipped in @meteora-ag/dynamic-bonding-curve-sdk@2.0.0, idl version 0.2.2).
//
// Program (mainnet + devnet): dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN
//
// VirtualPool (bytemuck, repr(C), zero-copy) = 8-byte Anchor discriminator + PoolState:
//   [8..72)    volatility_tracker (u64, [u8;8], u128 x3)
//   [72..104)  config: Pubkey       -> PoolConfig account (quote_mint lives there)
//   [104..136) creator: Pubkey
//   [136..168) base_mint: Pubkey     (the launched token)
//   [168..200) base_vault  [200..232) quote_vault
//   [232..240) base_reserve u64     [240..248) quote_reserve u64
//   [248..280) protocol/partner base/quote fees (u64 x4)
//   [280..296) sqrt_price: u128      Q64.64 sqrt(quote_raw / base_raw)
//   [296..304) activation_point u64
//   [304] pool_type u8  [305] is_migrated u8  ... [308] migration_progress u8
// PoolConfig (bytemuck) = 8-byte discriminator + quote_mint: Pubkey at [8..40) ...
//
// Market cap in lamports (quote = wrapped SOL, raw units, so decimals cancel out):
//   price_raw = (sqrt_price / 2^64)^2 lamports per raw base unit
//   mcap      = sqrt_price^2 * mint.supply / 2^128     (integer, floor)
// mint.supply is read from the SPL Token / Token-2022 mint account ([36..44) u64).
import { pubkeyFromBytes } from "./crypto.js";

export const DBC_PROGRAM_ID = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const VIRTUAL_POOL_DISC = Buffer.from([213, 224, 5, 209, 98, 69, 119, 92]);
export const POOL_CONFIG_DISC = Buffer.from([26, 108, 14, 123, 116, 230, 129, 43]);
const VIRTUAL_POOL_MIN_LEN = 309;

const u64 = (b, o) => b.readBigUInt64LE(o);
const u128 = (b, o) => b.readBigUInt64LE(o) | (b.readBigUInt64LE(o + 8) << 64n);

export function decodeVirtualPool(data) {
  const b = Buffer.from(data);
  if (b.length < VIRTUAL_POOL_MIN_LEN) throw new Error("not a DBC VirtualPool (too short)");
  if (!b.subarray(0, 8).equals(VIRTUAL_POOL_DISC)) throw new Error("not a DBC VirtualPool (discriminator)");
  return {
    config: pubkeyFromBytes(b.subarray(72, 104)),
    creator: pubkeyFromBytes(b.subarray(104, 136)),
    baseMint: pubkeyFromBytes(b.subarray(136, 168)),
    baseVault: pubkeyFromBytes(b.subarray(168, 200)),
    quoteVault: pubkeyFromBytes(b.subarray(200, 232)),
    baseReserve: u64(b, 232),
    quoteReserve: u64(b, 240),
    sqrtPrice: u128(b, 280),
    activationPoint: u64(b, 296),
    poolType: b[304],
    isMigrated: b[305] !== 0,
    migrationProgress: b[308],
  };
}

export function decodePoolConfigQuoteMint(data) {
  const b = Buffer.from(data);
  if (b.length < 40 || !b.subarray(0, 8).equals(POOL_CONFIG_DISC)) throw new Error("not a DBC PoolConfig");
  return pubkeyFromBytes(b.subarray(8, 40));
}

/** SPL Token / Token-2022 mint: supply u64 at 36, decimals u8 at 44. */
export function decodeMintSupply(data) {
  const b = Buffer.from(data);
  if (b.length < 82) throw new Error("not a mint account");
  return { supply: u64(b, 36), decimals: b[44] };
}

/** floor(sqrtPrice^2 * supply / 2^128): market cap in quote raw units (lamports for wSOL). */
export const mcapFromSqrtPrice = (sqrtPrice, supply) => (BigInt(sqrtPrice) * BigInt(sqrtPrice) * BigInt(supply)) >> 128n;

/**
 * Live DBC reader over a Chain (needs chain.getAccountInfo). snapshot(pool) returns everything the
 * resolver needs: ownership, creator, mint, quote mint, migration flag and the mcap in lamports.
 */
export class DbcReader {
  constructor({ chain, programId = DBC_PROGRAM_ID }) {
    this.chain = chain;
    this.programId = programId;
    this.quoteMintCache = new Map(); // config -> quote mint (PoolConfig is immutable)
  }

  async snapshot(pool) {
    const acc = await this.chain.getAccountInfo(pool);
    if (!acc) return { exists: false };
    if (acc.owner !== this.programId) return { exists: true, owner: acc.owner, isDbcPool: false };
    let p;
    try {
      p = decodeVirtualPool(acc.data);
    } catch (e) {
      return { exists: true, owner: acc.owner, isDbcPool: false, error: e.message };
    }
    let quoteMint = this.quoteMintCache.get(p.config);
    if (!quoteMint) {
      const cfg = await this.chain.getAccountInfo(p.config);
      if (!cfg || cfg.owner !== this.programId) throw new Error("DBC pool config account missing");
      quoteMint = decodePoolConfigQuoteMint(cfg.data);
      this.quoteMintCache.set(p.config, quoteMint);
    }
    const mintAcc = await this.chain.getAccountInfo(p.baseMint);
    if (!mintAcc || (mintAcc.owner !== TOKEN_PROGRAM && mintAcc.owner !== TOKEN_2022_PROGRAM)) throw new Error("base mint account missing");
    const { supply, decimals } = decodeMintSupply(mintAcc.data);
    return {
      exists: true,
      owner: acc.owner,
      isDbcPool: true,
      ...p,
      quoteMint,
      supply,
      decimals,
      mcapLamports: mcapFromSqrtPrice(p.sqrtPrice, supply),
    };
  }
}
