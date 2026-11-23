// Winner-initiated payout claims. The winner pays the fee and signs; the company wallet is not involved.
// The resolver builds an UNSIGNED Rings tx from the market identity (proof produced server-side with the
// market's shielded key) with fee payer = winner, and verifies the result on-chain afterwards.
//
// Double-pay safety: ONE claim slot per market (store kind "claimslot", id = market, taken with
// insertIfAbsent). While a slot is held:
//   - the same winner gets the SAME cached tx bytes back (so every copy has the same signature and the
//     same input notes: at most one can land);
//   - everyone else gets 409 market_busy (retry in ~a minute);
//   - the slot is released only when (a) the tx is verified paid, (b) it failed on-chain, or (c) its
//     blockhash expired (block height > lastValidBlockHeight + EXPIRY_MARGIN) AND a fresh sync of the
//     market wallet shows no unattributed outbound row matching it (if one exists it is attributed to
//     this claim and the payout is marked paid even if the winner never called /claims/submitted).
// Payout amounts and a winner's bond refund are combined in one payout doc (id market:wallet).
import { HttpError } from "./claims.js";
import { claimMessage, pubkey, verifySig } from "./markets.js";
import { hexToBytes, bytesToHex, pubkeyBytes } from "./crypto.js";
import nacl from "tweetnacl";
import { getBase58Encoder, getTransactionDecoder } from "@solana/kit";

/** True iff `signature` is the bettor's ed25519 signature over the exact message of the cached claim tx. */
export function signatureMatchesSlot(slot, signature) {
  try {
    const { messageBytes } = getTransactionDecoder().decode(Buffer.from(slot.txBase64, "base64"));
    const sig = new Uint8Array(getBase58Encoder().encode(signature));
    return sig.length === 64 && nacl.sign.detached.verify(new Uint8Array(messageBytes), sig, pubkeyBytes(slot.bettor));
  } catch {
    return false;
  }
}

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export const EXPIRY_MARGIN_BLOCKS = 150n; // ~1 min past lastValidBlockHeight before a slot is reclaimed
export const CLOSE_BUFFER_S = 600; // stop building claims 10 min before the treasury sweep may start
const nowSec = (deps) => Math.floor((deps.now ?? Date.now)() / 1000);
const kindFor = (mode) => (mode === "transfer" ? "privateTransfer" : "publicWithdrawal");

async function settledMarket(store, market, deps) {
  const m = await store.get("market", market);
  if (!m) throw new HttpError(404, "unknown_market", "no such market");
  if (!m.outcome) throw new HttpError(409, "not_settled", "market is not settled yet");
  if (m.phase !== "settled" || nowSec(deps) >= m.claimsCloseTs - CLOSE_BUFFER_S) throw new HttpError(410, "claims_closed", "the claims window has closed; leftovers go to the treasury");
  return m;
}

/** POST /claims/build */
export async function buildClaim(body, deps) {
  const { store, chain, rings, identities, ShieldedAddress } = deps;
  const market = pubkey(body?.market, "market");
  const bettor = pubkey(body?.bettor, "bettor");
  if (!verifySig(bettor, claimMessage(market), body?.signature)) throw new HttpError(401, "bad_signature", `signature must be the bettor's signature over "${claimMessage(market)}"`);
  await settledMarket(store, market, deps);
  const pid = `${market}:${bettor}`;
  let p = await store.get("payout", pid);
  if (!p || BigInt(p.amount) === 0n) throw new HttpError(404, "no_payout", "nothing to claim for this wallet in this market");
  if (p.status === "paid") throw new HttpError(409, "already_paid", `already paid in ${p.paidSignature}`);

  let recipient = null; // Uint8Array shielded address => private transfer; null => public withdrawal to bettor
  if (body?.shieldedAddress) {
    try {
      recipient = hexToBytes(String(body.shieldedAddress));
      ShieldedAddress?.fromBytes(recipient);
    } catch {
      throw new HttpError(400, "bad_request", "shieldedAddress must be the hex wire form of a ShieldedAddress");
    }
  } else {
    const pa = await store.get("payout_addr", bettor);
    if (pa) recipient = hexToBytes(pa.shieldedAddressHex);
  }

  let slot = await store.get("claimslot", market);
  if (slot) {
    const released = await reconcileSlot(market, deps);
    if (!released) {
      slot = await store.get("claimslot", market);
      if (slot?.bettor === bettor && slot.txBase64) return claimResponse(slot, { cached: true });
      throw new HttpError(409, "market_busy", "another payout claim for this market is in flight; retry in about a minute");
    }
    p = await store.get("payout", pid);
    if (p.status === "paid") throw new HttpError(409, "already_paid", `already paid in ${p.paidSignature}`);
  }

  if (!(await store.insertIfAbsent("claimslot", market, { market, bettor, status: "building", at: Date.now() }))) {
    throw new HttpError(409, "market_busy", "another payout claim for this market is in flight; retry in about a minute");
  }
  let built;
  const mode = recipient ? "transfer" : "withdraw";
  try {
    const identity = await identities.get(market);
    const lamports = BigInt(p.amount);
    const tx = recipient
      ? await rings.buildPayout({ identity, feePayer: bettor, recipient, lamports })
      : await rings.buildWithdraw({ identity, feePayer: bettor, recipient: bettor, lamports });
    built = chain.serializeUnsigned(tx);
  } catch (e) {
    await store.del("claimslot", market);
    throw new HttpError(502, "build_failed", `could not build the payout transaction: ${e.message}`);
  }
  slot = {
    market,
    bettor,
    amount: BigInt(p.amount),
    mode,
    recipient: recipient ? bytesToHex(recipient) : bettor,
    txBase64: built.txBase64,
    lastValidBlockHeight: built.lastValidBlockHeight,
    builtAt: Date.now(),
    signature: null,
    status: "built",
  };
  await store.put("claimslot", market, slot);
  await store.put("payout", pid, { ...p, status: "pending" });
  return claimResponse(slot, { cached: false });
}

const claimResponse = (slot, extra) => ({
  market: slot.market,
  bettor: slot.bettor,
  amount: slot.amount,
  mode: slot.mode, // transfer (private, to a shielded address) | withdraw (public, to the bettor's wallet)
  feePayer: slot.bettor,
  transaction: slot.txBase64,
  lastValidBlockHeight: slot.lastValidBlockHeight,
  ...extra,
});

/** POST /claims/submitted {market, bettor, signature: tx signature} */
export async function submitClaim(body, deps) {
  const { store } = deps;
  const market = pubkey(body?.market, "market");
  const bettor = pubkey(body?.bettor, "bettor");
  const signature = String(body?.signature ?? "");
  if (!SIG_RE.test(signature)) throw new HttpError(400, "bad_request", "signature must be the base58 transaction signature");
  const pid = `${market}:${bettor}`;
  const p = await store.get("payout", pid);
  if (!p) throw new HttpError(404, "no_payout", "nothing to claim for this wallet in this market");
  if (p.status === "paid") {
    if (p.paidSignature === signature) return { market, bettor, status: "paid", signature, idempotent: true };
    throw new HttpError(409, "already_paid", `already paid in ${p.paidSignature}`);
  }
  const slot = await store.get("claimslot", market);
  if (!slot || slot.bettor !== bettor) throw new HttpError(409, "no_claim_in_flight", "no claim transaction is in flight for this wallet; call /claims/build");
  // Only the signature of the exact tx we handed out is accepted (prevents a bogus "failed" signature
  // from releasing the slot while the real tx is still valid).
  if (!signatureMatchesSlot(slot, signature)) throw new HttpError(422, "signature_mismatch", "signature is not the bettor's signature over the claim transaction this resolver built");
  await store.put("claimslot", market, { ...slot, signature, submittedAt: Date.now() });
  const status = await checkSlotSignature({ ...slot, signature }, signature, deps);
  return { market, bettor, status, signature };
}

/**
 * Verify one candidate signature for the held slot. Returns paid | submitted | failed.
 * paid: tx confirmed, signed by the bettor, market wallet shows the outbound row of exactly slot.amount.
 */
async function checkSlotSignature(slot, signature, deps) {
  const { store, chain, rings, identities } = deps;
  const st = await chain.signatureStatus(signature);
  if (st === "failed") {
    await release(slot, deps, "failed");
    return "failed";
  }
  if (st !== "confirmed") return "submitted";
  const signed = await chain.txSignedBy(signature, slot.bettor);
  if (!signed.signed) throw new HttpError(422, "not_bettor_tx", "that transaction was not signed by the bettor");
  const rows = await rings.outboundInTx(await identities.get(slot.market), signature);
  if (!rows.some((r) => r.kind === kindFor(slot.mode) && BigInt(r.amount) === BigInt(slot.amount))) return "submitted"; // indexer lag: retry
  await markPaid(slot, signature, deps);
  return "paid";
}

async function markPaid(slot, signature, deps) {
  const { store } = deps;
  const pid = `${slot.market}:${slot.bettor}`;
  const p = await store.get("payout", pid);
  await store.put("payout", pid, { ...p, status: "paid", paidSignature: signature, paidAt: new Date().toISOString(), mode: slot.mode });
  await store.del("claimslot", slot.market);
}

async function release(slot, deps, reason) {
  const { store } = deps;
  const pid = `${slot.market}:${slot.bettor}`;
  const p = await store.get("payout", pid);
  if (p && p.status === "pending") await store.put("payout", pid, { ...p, status: "unpaid", lastClaimError: reason });
  await store.del("claimslot", slot.market);
}

/**
 * Called by /claims/build (on a held slot) and by the worker every tick. Returns true when the slot is
 * gone afterwards (paid, failed or expired-unlanded), false while it must stay held.
 */
export async function reconcileSlot(market, deps) {
  const { store, chain, rings, identities } = deps;
  const slot = await store.get("claimslot", market);
  if (!slot) return true;
  if (slot.status === "building") {
    // crashed mid-build (no tx was ever returned): safe to drop after a minute
    if (Date.now() - slot.at > 60_000) {
      await release(slot, deps, "build_abandoned");
      return true;
    }
    return false;
  }
  if (slot.signature) {
    const s = await checkSlotSignature(slot, slot.signature, deps).catch(() => "submitted");
    if (s !== "submitted") return true;
  }
  // Expired? Only then can no copy of the tx land any more.
  const lvh = slot.lastValidBlockHeight != null ? BigInt(slot.lastValidBlockHeight) : null;
  const expired = lvh !== null ? (await chain.getBlockHeight()) > lvh + EXPIRY_MARGIN_BLOCKS : Date.now() - slot.builtAt > 5 * 60_000;
  if (!expired) return false;
  // Did it land without being reported? Attribute an unclaimed matching outbound row to this slot.
  const identity = await identities.get(market);
  const known = new Set();
  for (const { doc } of await store.list("payout", `${market}:`)) if (doc.paidSignature) known.add(doc.paidSignature);
  const sweep = await store.get("action", `sweep:${market}`);
  if (sweep?.signature) known.add(sweep.signature);
  const rows = await rings.outboundAll(identity);
  const hit = rows.find((r) => !known.has(r.signature) && r.kind === kindFor(slot.mode) && BigInt(r.amount) === BigInt(slot.amount));
  if (hit) {
    await markPaid(slot, hit.signature, deps);
    return true;
  }
  await release(slot, deps, "expired_unlanded");
  return true;
}
