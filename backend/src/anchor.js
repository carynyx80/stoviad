// Anchor event decoding from "Program data: <base64>" log lines.
// Discriminator = sha256("event:<Name>")[0..8].
// Field layouts below are the expected Borsh layouts. If the on-chain IDL differs,
// update EVENT_LAYOUTS: events whose discriminator matches but fail to decode are
// still stored raw (decoded=false) so nothing is lost and can be re-indexed later.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

// Mirrors #[event] structs in programs/stovia/src/lib.rs (field order matters).
export const CLAIM_KINDS = ['winnings', 'bond', 'creatorFees', 'sweep'];
export const EVENT_LAYOUTS = {
  LaunchCreated: [
    ['launch', 'pubkey'], ['mint', 'pubkey'], ['creator', 'pubkey'],
    ['name', 'string'], ['symbol', 'string'], ['uri', 'string'],
    ['bondLamports', 'u64'], ['platformFee', 'u64'], ['targetMcapLamports', 'u64'],
    ['deadlineTs', 'i64'], ['revealEndTs', 'i64'],
  ],
  Trade: [
    ['launch', 'pubkey'], ['mint', 'pubkey'], ['trader', 'pubkey'], ['isBuy', 'bool'],
    ['solAmount', 'u64'], ['tokenAmount', 'u64'], ['platformFee', 'u64'], ['creatorFee', 'u64'],
    ['virtualSol', 'u64'], ['virtualTokens', 'u64'], ['mcapLamports', 'u64'], ['timestamp', 'i64'],
  ],
  BetCommitted: [
    ['market', 'pubkey'], ['bettor', 'pubkey'], ['commitment', 'bytes32'],
    ['amount', 'u64'], ['platformFee', 'u64'],
  ],
  BetRevealed: [
    ['market', 'pubkey'], ['bettor', 'pubkey'], ['side', 'u8'], ['amount', 'u64'],
  ],
  MarketSettled: [
    ['market', 'pubkey'], ['launch', 'pubkey'], ['survived', 'bool'],
    ['twapMcap', 'u64'], ['targetMcap', 'u64'], ['yesPool', 'u64'], ['noPool', 'u64'],
    ['bonusPool', 'u64'], ['unrevealed', 'u64'],
  ],
  Claimed: [
    ['market', 'pubkey'], ['launch', 'pubkey'], ['recipient', 'pubkey'], ['kind', 'claimKind'], ['amount', 'u64'],
  ],
};

export function discriminator(name) {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const DISC = new Map(Object.keys(EVENT_LAYOUTS).map((n) => [discriminator(n).toString('hex'), n]));

class Reader {
  constructor(buf) { this.buf = buf; this.o = 0; }
  need(n) { if (this.o + n > this.buf.length) throw new Error('buffer underrun'); }
  pubkey() { this.need(32); const v = new PublicKey(this.buf.subarray(this.o, this.o + 32)).toBase58(); this.o += 32; return v; }
  bytes32() { this.need(32); const v = this.buf.subarray(this.o, this.o + 32).toString('hex'); this.o += 32; return v; }
  u8() { this.need(1); return this.buf.readUInt8(this.o++); }
  bool() { return this.u8() !== 0; }
  u64() { this.need(8); const v = this.buf.readBigUInt64LE(this.o); this.o += 8; return v.toString(); }
  i64() { this.need(8); const v = this.buf.readBigInt64LE(this.o); this.o += 8; return Number(v); }
  claimKind() { const k = this.u8(); return CLAIM_KINDS[k] ?? `unknown(${k})`; }
  string() { this.need(4); const len = this.buf.readUInt32LE(this.o); this.o += 4; this.need(len); const s = this.buf.subarray(this.o, this.o + len).toString('utf8'); this.o += len; return s; }
}

/** Decode one base64 "Program data" payload. Returns {name, decoded, data, raw}. */
export function decodeEvent(b64) {
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return null; }
  if (buf.length < 8) return { name: null, decoded: false, data: null, raw: b64 };
  const name = DISC.get(buf.subarray(0, 8).toString('hex')) ?? null;
  if (!name) return { name: null, decoded: false, data: null, raw: b64 };
  try {
    const r = new Reader(buf.subarray(8));
    const data = {};
    for (const [field, type] of EVENT_LAYOUTS[name]) data[field] = r[type]();
    return { name, decoded: true, data, raw: b64 };
  } catch (err) {
    return { name, decoded: false, data: null, raw: b64, error: String(err.message || err) };
  }
}

/**
 * Extract "Program data:" payloads emitted while PROGRAM_ID is the executing program.
 * Tracks the invoke stack so CPI'd programs' logs are not attributed to us.
 */
export function extractProgramData(logs, programId) {
  if (!Array.isArray(logs)) return [];
  const stack = [];
  const out = [];
  for (const line of logs) {
    if (typeof line !== 'string') continue;
    let m;
    if ((m = line.match(/^Program (\w+) invoke \[\d+\]/))) { stack.push(m[1]); continue; }
    if ((m = line.match(/^Program (\w+) (success|failed)/))) { if (stack[stack.length - 1] === m[1]) stack.pop(); continue; }
    if (line.startsWith('Program data: ')) {
      // If logs were truncated / no invoke lines, fall back to accepting the payload.
      if (stack.length === 0 || stack[stack.length - 1] === programId) out.push(line.slice('Program data: '.length).trim());
    }
  }
  return out;
}

/** Market PDA = ["market", launch]. */
export function marketPda(launch, programId) {
  return PublicKey.findProgramAddressSync([Buffer.from('market'), new PublicKey(launch).toBuffer()], new PublicKey(programId))[0].toBase58();
}

/** Test helper: encode an event for local verification. */
export function encodeEvent(name, data) {
  const parts = [discriminator(name)];
  for (const [field, type] of EVENT_LAYOUTS[name]) {
    const v = data[field];
    if (type === 'pubkey') parts.push(new PublicKey(v).toBuffer());
    else if (type === 'bytes32') parts.push(Buffer.from(v, 'hex'));
    else if (type === 'claimKind') parts.push(Buffer.from([CLAIM_KINDS.indexOf(v)]));
    else if (type === 'u8' || type === 'bool') parts.push(Buffer.from([Number(v)]));
    else if (type === 'u64') { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); parts.push(b); }
    else if (type === 'i64') { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); parts.push(b); }
    else if (type === 'string') { const s = Buffer.from(v, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(s.length); parts.push(l, s); }
  }
  return Buffer.concat(parts).toString('base64');
}
