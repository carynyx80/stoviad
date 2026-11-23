// Stake claims (checked against off-chain signed commitments) and payout-address registration. Dependencies are injected so tests can run offline.
import { address, getPublicKeyFromAddress, verifySignature, getBase58Encoder } from "@solana/kit";
import { bytesEqual, bytesToHex, hexToBytes, stakeCommitment } from "./crypto.js";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Market phases after which no stake can be registered (results are being / have been computed).
const FROZEN_PHASES = new Set(["settled", "sweeping", "done", "halted"]);
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function parsePubkey(v, field) {
  try {
    return address(String(v));
  } catch {
    throw new HttpError(400, "bad_request", `${field} is not a valid pubkey`);
  }
}

export function parseClaim(body) {
  if (!body || typeof body !== "object") throw new HttpError(400, "bad_request", "JSON body required");
  const market = parsePubkey(body.market, "market");
  const bettor = parsePubkey(body.bettor, "bettor");
  let amount;
  try {
    amount = BigInt(body.amount);
  } catch {
    throw new HttpError(400, "bad_request", "amount must be an integer (lamports)");
  }
  if (amount <= 0n || amount > 0xffffffffffffffffn) throw new HttpError(400, "bad_request", "amount out of range");
  let salt2;
  try {
    salt2 = hexToBytes(body.salt2, 32);
  } catch {
    throw new HttpError(400, "bad_request", "salt2 must be 32 bytes hex");
  }
  const sig = String(body.ringsTxSignature ?? "");
  if (!SIG_RE.test(sig)) throw new HttpError(400, "bad_request", "ringsTxSignature must be a base58 signature");
  return { market, bettor, amount, salt2, ringsTxSignature: sig };
}

/**
 * Verify and record a sealed stake against the bettor's OFF-CHAIN signed commitment (POST /bets/commit).
 * deps: { store, chain: {txSignedBy}, rings: {receivedInTx}, identities: {get}, now?: () => ms }
 * The Rings transfer must have landed (blockTime) at or before the market deadline: otherwise a bettor
 * could commit, watch the market cap, and only fund the bet if it is winning (a free option).
 */
export async function claimStake(input, deps) {
  const { store, chain, rings, identities } = deps;
  const nowS = Math.floor((deps.now ?? Date.now)() / 1000);
  const { market, bettor, amount, salt2, ringsTxSignature } = input;
  const stakeId = `${market}:${bettor}`;

  const m = await store.get("market", market);
  if (!m) throw new HttpError(404, "unknown_market", "no such market");
  if (FROZEN_PHASES.has(m.phase) || nowS >= Number(m.revealEndsTs)) throw new HttpError(409, "market_frozen", "market results already computed; claim window closed");

  const existing = await store.get("stake", stakeId);
  if (existing?.verified) {
    if (existing.ringsTxSignature === ringsTxSignature && existing.amount === amount) return { ...publicStake(existing), idempotent: true };
    throw new HttpError(409, "already_claimed", "a verified stake already exists for this bettor and market");
  }

  // 1) Off-chain binding: sha256(amount || salt2 || bettor) == signed stakeCommitment
  const bet = await store.get("bet", stakeId);
  if (!bet) throw new HttpError(404, "no_commitment", "no bet commitment for this bettor and market (POST /bets/commit first)");
  if (!bytesEqual(stakeCommitment(amount, salt2, bettor), hexToBytes(bet.stakeCommitment, 32))) {
    throw new HttpError(422, "commitment_mismatch", "sha256(amount||salt2||bettor) does not match the committed stakeCommitment");
  }

  // 2) Reserve the Rings tx signature so one transfer can back only one stake (or bond).
  const reserved = await store.insertIfAbsent("txsig", ringsTxSignature, { stakeId, at: Date.now() });
  if (!reserved) {
    const owner = await store.get("txsig", ringsTxSignature);
    if (owner?.stakeId !== stakeId) throw new HttpError(409, "tx_already_used", "this Rings transaction already backs another stake");
  }
  try {
    await verifyRingsDeposit({ chain, rings, identities, market, sender: bettor, amount, ringsTxSignature, deadlineTs: m.deadlineTs });
  } catch (e) {
    if (reserved) await store.del("txsig", ringsTxSignature); // allow a retry after indexer lag
    throw e;
  }

  const doc = {
    market,
    bettor,
    amount,
    ringsTxSignature,
    stakeCommitmentHex: bet.stakeCommitment,
    verified: true,
    verifiedAt: new Date().toISOString(),
  };
  if (!(await store.insertIfAbsent("stake", stakeId, doc))) {
    // Lost a race with a concurrent claim for the same bettor.
    const other = await store.get("stake", stakeId);
    if (other?.ringsTxSignature === ringsTxSignature) return { ...publicStake(other), idempotent: true };
    throw new HttpError(409, "already_claimed", "a verified stake already exists for this bettor and market");
  }
  return publicStake(doc);
}

/** Shared by stakes and creator bonds: sender signed the tx, it landed by the deadline, market identity received exactly `amount`. */
export async function verifyRingsDeposit({ chain, rings, identities, market, sender, amount, ringsTxSignature, deadlineTs }) {
  // The sender of a default-ring transfer is public: the sender must have signed it.
  const signed = await chain.txSignedBy(ringsTxSignature, sender);
  if (!signed.found) throw new HttpError(425, "tx_not_found", "transaction not found yet; retry shortly");
  if (signed.failed) throw new HttpError(422, "tx_failed", "transaction failed on-chain");
  if (!signed.signed) throw new HttpError(422, "not_sender_tx", "the wallet did not sign this transaction");
  if (signed.blockTime == null) throw new HttpError(425, "tx_no_blocktime", "transaction block time not available yet; retry shortly");
  if (Number(signed.blockTime) > Number(deadlineTs)) throw new HttpError(422, "tx_after_deadline", "the Rings transfer landed after the market deadline");
  // The market identity must have received exactly `amount` lamports in that tx (decrypted locally).
  const identity = await identities.get(market);
  const got = await rings.receivedInTx(identity, ringsTxSignature);
  if (got.rows === 0) throw new HttpError(425, "note_not_indexed", "no shielded SOL note to this market in that transaction (yet); retry shortly");
  if (got.amount !== amount) throw new HttpError(422, "amount_mismatch", "shielded amount received does not match the claimed amount");
}

const publicStake = (d) => ({ market: d.market, bettor: d.bettor, verified: d.verified, ringsTxSignature: d.ringsTxSignature });

// ---------------------------------------------------------------------------
// Payout address registration: authenticated by the bettor's Ed25519 signature.
// ---------------------------------------------------------------------------
export const payoutAddressMessage = (bettor, shieldedAddressHex) =>
  `Stovia payout address v1\nbettor:${bettor}\naddress:${shieldedAddressHex.toLowerCase()}`;
export const resultsAccessMessage = (market, bettor) => `Stovia results v1\nmarket:${market}\nbettor:${bettor}`;

export function decodeSig(sig) {
  const s = String(sig ?? "");
  try {
    const b = /^[0-9a-fA-F]{128}$/.test(s) ? hexToBytes(s) : new Uint8Array(getBase58Encoder().encode(s));
    if (b.length !== 64) throw new Error();
    return b;
  } catch {
    throw new HttpError(400, "bad_request", "signature must be 64 bytes (base58 or hex)");
  }
}

export async function verifyWalletSignature(pubkey, message, sig) {
  const key = await getPublicKeyFromAddress(address(pubkey));
  return verifySignature(key, decodeSig(sig), new TextEncoder().encode(message));
}

export async function registerPayoutAddress(body, { store, ShieldedAddress }) {
  const bettor = parsePubkey(body?.bettor, "bettor");
  let bytes;
  try {
    bytes = hexToBytes(body?.shieldedAddress ?? "");
    ShieldedAddress.fromBytes(bytes); // validates the 99-byte wire form
  } catch {
    throw new HttpError(400, "bad_request", "shieldedAddress must be the hex wire form of a ShieldedAddress");
  }
  const hex = bytesToHex(bytes);
  if (!(await verifyWalletSignature(bettor, payoutAddressMessage(bettor, hex), body?.signature))) {
    throw new HttpError(401, "bad_signature", "signature does not verify for bettor");
  }
  await store.put("payout_addr", bettor, { shieldedAddressHex: hex, at: new Date().toISOString() });
  return { bettor, registered: true };
}
