/**
 * Sealed-bet crypto. Dependency-free (WebCrypto only) so it runs in the browser and in
 * plain Node for tests. Byte layouts MUST match the resolver:
 *
 *   commitment      = sha256(side_u8 || salt[32] || bettor_pubkey[32])        (65-byte preimage)
 *   stakeCommitment = sha256(amount_le_u64 || salt2[32] || bettor_pubkey[32]) (72-byte preimage)
 *
 * Hex is lowercase, no 0x prefix. Signatures are base58 (bitcoin alphabet).
 */

export type Side = 1 | 2; // 1 = survives (YES), 2 = dies (NO)

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP: Record<string, number> = Object.fromEntries(B58.split("").map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP[s[i]];
    if (v === undefined) throw new Error("invalid base58");
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}

/** 32-byte Solana public key from its base58 address. Throws on anything else. */
export function pubkeyBytes(address: string): Uint8Array {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error("not a 32-byte public key");
  return b;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex: string, expectedLen?: number): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  if (expectedLen !== undefined && out.length !== expectedLen) throw new Error(`expected ${expectedLen} bytes, got ${out.length}`);
  return out;
}

export function u64le(value: bigint): Uint8Array {
  if (value < BigInt(0) || value > BigInt("18446744073709551615")) throw new RangeError("u64 out of range");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, value, true);
  return b;
}

/** 32 cryptographically random bytes as hex. */
export function randomSaltHex(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function sha256Hex(...parts: Uint8Array[]): Promise<string> {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  const d = await globalThis.crypto.subtle.digest("SHA-256", buf);
  return bytesToHex(new Uint8Array(d));
}

/** hex sha256(side_u8 || salt32 || bettor32) */
export function sideCommitment(side: Side, saltHex: string, bettor: string): Promise<string> {
  if (side !== 1 && side !== 2) throw new Error("side must be 1 or 2");
  return sha256Hex(new Uint8Array([side]), hexToBytes(saltHex, 32), pubkeyBytes(bettor));
}

/** hex sha256(amount_le_u64 || salt2_32 || bettor32) */
export function stakeCommitment(amountLamports: bigint, salt2Hex: string, bettor: string): Promise<string> {
  return sha256Hex(u64le(amountLamports), hexToBytes(salt2Hex, 32), pubkeyBytes(bettor));
}

export const commitMessage = (market: string, commitment: string, stakeCommit: string) => `stovia-bet:${market}:${commitment}:${stakeCommit}`;
export const revealMessage = (market: string, side: Side, saltHex: string) => `stovia-reveal:${market}:${side}:${saltHex}`;
export const claimMessage = (market: string) => `stovia-claim:${market}`;

/** wallet.signMessage over the UTF-8 message, returned base58. */
export async function signText(signMessage: (m: Uint8Array) => Promise<Uint8Array>, text: string): Promise<string> {
  return base58Encode(await signMessage(new TextEncoder().encode(text)));
}
