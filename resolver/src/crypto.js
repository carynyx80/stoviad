// Pure hashing helpers: stake commitments, payout leaves and the payout Merkle tree.
// No network, no secrets. Everything here is covered by test/core.test.js.
import { createHash, timingSafeEqual } from "node:crypto";
import { getAddressEncoder, getAddressDecoder } from "@solana/kit";

const addrEnc = getAddressEncoder();
const addrDec = getAddressDecoder();

export const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

export const pubkeyBytes = (base58) => new Uint8Array(addrEnc.encode(base58));
export const pubkeyFromBytes = (bytes) => addrDec.decode(bytes);

export function u64le(value) {
  const v = BigInt(value);
  if (v < 0n || v > 0xffffffffffffffffn) throw new RangeError("u64 out of range");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
}

export function hexToBytes(hex, expectedLen) {
  const clean = String(hex).replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error("invalid hex");
  const out = Uint8Array.from(Buffer.from(clean, "hex"));
  if (expectedLen !== undefined && out.length !== expectedLen) throw new Error(`expected ${expectedLen} bytes, got ${out.length}`);
  return out;
}
export const bytesToHex = (b) => Buffer.from(b).toString("hex");

/** stake_commitment = sha256(amount_le_u64 || salt2[32] || bettor_pubkey[32]) — must match the program. */
export function stakeCommitment(amount, salt2, bettor) {
  if (salt2.length !== 32) throw new Error("salt2 must be 32 bytes");
  return sha256(u64le(amount), salt2, pubkeyBytes(bettor));
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---------------------------------------------------------------------------
// Payout Merkle tree
//   leaf  = sha256(bettor_pubkey[32] || payout_le_u64)            (40-byte preimage)
//   node  = sha256(min(a,b) || max(a,b))                            (64-byte preimage, sorted pair)
//   Leaves are ordered by bettor pubkey bytes; an odd node is carried up unchanged.
//   Sorted pairs mean a verifier needs only the sibling list, not left/right flags.
//   Leaf and node preimages differ in length, so a node cannot be passed off as a leaf.
//   Empty tree root = 32 zero bytes.
// ---------------------------------------------------------------------------

export const payoutLeaf = (bettor, amount) => sha256(pubkeyBytes(bettor), u64le(amount));

const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const hashPair = (a, b) => (cmp(a, b) <= 0 ? sha256(a, b) : sha256(b, a));

/** @param {{bettor: string, amount: bigint}[]} entries */
export function buildPayoutTree(entries) {
  const sorted = [...entries].sort((x, y) => cmp(pubkeyBytes(x.bettor), pubkeyBytes(y.bettor)));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].bettor === sorted[i - 1].bettor) throw new Error("duplicate bettor in payout set");
  }
  const leaves = sorted.map((e) => payoutLeaf(e.bettor, e.amount));
  if (leaves.length === 0) return { root: new Uint8Array(32), layers: [[]], order: [] };
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const prev = layers.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  return { root: layers.at(-1)[0], layers, order: sorted.map((e) => e.bettor) };
}

export function payoutProof(tree, bettor) {
  let idx = tree.order.indexOf(bettor);
  if (idx < 0) return null;
  const proof = [];
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const sib = idx ^ 1;
    if (sib < layer.length) proof.push(layer[sib]);
    idx >>= 1;
  }
  return proof;
}

export function verifyPayoutProof(root, bettor, amount, proof) {
  let h = payoutLeaf(bettor, amount);
  for (const sib of proof) h = hashPair(h, sib);
  return bytesEqual(h, root);
}
