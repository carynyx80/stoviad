/**
 * Version-1 resolver transactions (Privacy Rings payouts / withdrawals).
 *
 * web3.js 1.99 can read v1 but cannot re-serialize it, and most wallets only sign
 * legacy / v0. We reuse the vault's `toWalletTransaction` (lib/rings): same fee payer,
 * blockhash and program instructions (proof untouched) recompiled as v0, with the v1
 * header config turned into ComputeBudget ixs. The converted message bytes differ from
 * the v1 ones, which is fine while the company wallet is the ONLY signer: the proof
 * authorizes the spend, the outer signature only pays fees. If the v1 tx needs other
 * signers (already partially signed), conversion would invalidate their signatures,
 * so we keep the raw v1 bytes and use the Wallet Standard v1 signing path instead.
 *
 * Heavy (pulls in the SPR SDK): load with `await import("@/lib/admin/v1")` only.
 */
import { getTransactionDecoder } from "@solana/kit";
import { toWalletTransaction } from "../rings";

export type V1Plan =
  | { mode: "v0"; v0: Uint8Array; v1: Uint8Array; feePayer: string }
  | { mode: "raw-v1"; v1: Uint8Array; feePayer: string; reason: string };

/** v1 wire format is message-first: [0x81, numRequiredSignatures, ...message, ...signatures]. */
export function planV1(raw: Uint8Array): V1Plan {
  const tx = getTransactionDecoder().decode(raw);
  const signers = Object.keys(tx.signatures);
  const feePayer = signers[0] ?? "";
  const othersSigned = Object.entries(tx.signatures).some(([addr, sig]) => addr !== feePayer && sig != null && sig.some((b) => b !== 0));
  if (signers.length > 1 || othersSigned) {
    return { mode: "raw-v1", v1: raw, feePayer, reason: `needs ${signers.length} signers; converting would break their signatures` };
  }
  const ready = toWalletTransaction(tx);
  if (!ready.v0) return { mode: "raw-v1", v1: raw, feePayer: ready.feePayer, reason: "too large for a v0 packet" };
  return { mode: "v0", v0: ready.v0, v1: ready.v1, feePayer: ready.feePayer };
}
