// Survival markets without an on-chain program: launches (Meteora DBC pools), off-chain signed bet
// commitments, reveals, creator bonds and read views. Every user action is authorized by the user's
// own wallet signature (tweetnacl, base58). Dependencies are injected so tests run offline.
//
// Store kinds used here:
//   market  id pool            launch data + worker state (phase, twap, outcome, totals)
//   bet     id market:bettor   {commitment, stakeCommitment, signature, committedTs, revealed, side, salt, revealedTs}
//   stake   id market:bettor   verified Rings stake (claims.js)
//   bond    id market          verified creator bond
//   payout  id market:wallet   computed at settlement; status unpaid|pending|paid|forfeited
import nacl from "tweetnacl";
import { address, getBase58Encoder } from "@solana/kit";
import { HttpError } from "./claims.js";
import { verifyRingsDeposit } from "./claims.js";
import { bytesEqual, hexToBytes, pubkeyBytes, sha256 } from "./crypto.js";
import { WSOL_MINT } from "./dbc.js";
import { twapInit, twapValue } from "./twap.js";

export const REVEAL_WINDOW_S = 24 * 3600;
export const CLAIMS_WINDOW_S = 7 * 24 * 3600;
export const MIN_DEADLINE_S = 3600;
export const MAX_DEADLINE_S = 30 * 24 * 3600;
export const SIDE_SURVIVE = 1;
export const SIDE_DIE = 2;

export const launchMessage = (pool, mint, target, deadline) => `stovia-launch:${pool}:${mint}:${target}:${deadline}`;
export const betMessage = (market, commitment, stakeCommitment) => `stovia-bet:${market}:${commitment}:${stakeCommitment}`;
export const revealMessage = (market, side, salt) => `stovia-reveal:${market}:${side}:${salt}`;
export const bondMessage = (market, amount, ringsTxSignature) => `stovia-bond:${market}:${amount}:${ringsTxSignature}`;
export const claimMessage = (market) => `stovia-claim:${market}`;

const HEX32 = /^[0-9a-fA-F]{64}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const nowSec = (deps) => Math.floor((deps.now ?? Date.now)() / 1000);

export function pubkey(v, field) {
  try {
    return address(String(v));
  } catch {
    throw new HttpError(400, "bad_request", `${field} is not a valid pubkey`);
  }
}

function u64(v, field, { min = 1n } = {}) {
  let x;
  try {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "bigint") throw new Error();
    if (typeof v === "string" && !/^\d+$/.test(v)) throw new Error();
    x = BigInt(v);
  } catch {
    throw new HttpError(400, "bad_request", `${field} must be a non-negative integer`);
  }
  if (x < min || x > 0xffffffffffffffffn) throw new HttpError(400, "bad_request", `${field} out of range`);
  return x;
}

function text(v, field, max, { optional = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (optional) return "";
    throw new HttpError(400, "bad_request", `${field} required`);
  }
  const s = String(v);
  if (s.length > max || /[\u0000-\u001f]/.test(s)) throw new HttpError(400, "bad_request", `${field} too long or has control characters`);
  return s;
}

/** tweetnacl ed25519 over utf8(message); signature base58 (64 bytes). */
export function verifySig(wallet, message, sigB58) {
  let sig;
  try {
    sig = new Uint8Array(getBase58Encoder().encode(String(sigB58 ?? "")));
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pubkeyBytes(wallet));
}

function requireSig(wallet, message, sig) {
  if (!verifySig(wallet, message, sig)) throw new HttpError(401, "bad_signature", `signature must be ${wallet}'s ed25519 signature (base58) over "${message}"`);
}

/** commitment = sha256(side_u8 || salt32 || bettor32) */
export const sideCommitment = (side, salt, bettor) => sha256(Uint8Array.of(side), salt, pubkeyBytes(bettor));

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
export async function createLaunch(body, deps) {
  const { store, dbc, identities } = deps;
  if (!body || typeof body !== "object") throw new HttpError(400, "bad_request", "JSON body required");
  const pool = pubkey(body.pool, "pool");
  const mint = pubkey(body.mint, "mint");
  const creator = pubkey(body.creator, "creator");
  const name = text(body.name, "name", 64);
  const symbol = text(body.symbol, "symbol", 16);
  const uri = text(body.uri, "uri", 256, { optional: true });
  const target = u64(body.targetMcapLamports, "targetMcapLamports");
  const deadline = Number(u64(body.deadlineTs, "deadlineTs"));
  requireSig(creator, launchMessage(pool, mint, target.toString(), deadline), body.signature);

  const existing = await store.get("market", pool);
  if (existing) {
    if (existing.mint === mint && existing.creator === creator && existing.targetMcapLamports === target && existing.deadlineTs === deadline) {
      return { ...(await launchResponse(existing, deps)), idempotent: true };
    }
    throw new HttpError(409, "market_exists", "a market already exists for this pool with different parameters");
  }

  const now = nowSec(deps);
  if (deadline - now < MIN_DEADLINE_S || deadline - now > MAX_DEADLINE_S) {
    throw new HttpError(422, "bad_deadline", "deadlineTs must be between 1 hour and 30 days from now");
  }
  if (!dbc) throw new HttpError(503, "not_configured", "HELIUS_API_KEY not configured");
  const snap = await dbc.snapshot(pool);
  if (!snap.exists) throw new HttpError(425, "pool_not_found", "pool account not found (yet); retry once the create-pool tx is confirmed");
  if (!snap.isDbcPool) throw new HttpError(422, "bad_pool_owner", "pool is not a Meteora DBC VirtualPool account");
  if (snap.baseMint !== mint) throw new HttpError(422, "mint_mismatch", "pool base mint does not equal mint");
  if (snap.creator !== creator) throw new HttpError(422, "creator_mismatch", "pool creator does not equal creator");
  if (snap.quoteMint !== WSOL_MINT) throw new HttpError(422, "quote_not_sol", "pool quote mint must be wrapped SOL (mcap is measured in lamports)");
  if (snap.isMigrated) throw new HttpError(422, "pool_migrated", "pool already migrated off the bonding curve");
  if (target <= snap.mcapLamports) throw new HttpError(422, "target_too_low", `targetMcapLamports must exceed the current mcap (${snap.mcapLamports} lamports)`);

  const doc = {
    market: pool,
    pool,
    mint,
    creator,
    name,
    symbol,
    uri,
    targetMcapLamports: target,
    deadlineTs: deadline,
    revealEndsTs: deadline + REVEAL_WINDOW_S,
    createdTs: now,
    launchSignature: String(body.signature),
    phase: "open",
    initialMcapLamports: snap.mcapLamports,
    lastMcap: snap.mcapLamports,
    lastSampleTs: now,
    migrated: false,
    twap: twapInit(now, snap.mcapLamports),
  };
  if (!(await store.insertIfAbsent("market", pool, doc))) return createLaunch(body, deps); // raced: re-run as idempotent
  return launchResponse(doc, deps);
}

async function launchResponse(m, deps) {
  const info = await deps.identities.publicInfo(m.market);
  return {
    ...(await marketView(m, deps)),
    shieldedAddress: info.shieldedAddressHex,
    shieldedAddressBase64: info.shieldedAddressBase64,
    shieldedOwner: info.ownerSolanaAddress,
  };
}

// ---------------------------------------------------------------------------
// Bets: commit / reveal
// ---------------------------------------------------------------------------
async function getMarket(store, market) {
  const m = await store.get("market", market);
  if (!m) throw new HttpError(404, "unknown_market", "no such market");
  return m;
}

export async function commitBet(body, deps) {
  const { store } = deps;
  const market = pubkey(body?.market, "market");
  const bettor = pubkey(body?.bettor, "bettor");
  const commitment = String(body?.commitment ?? "");
  const stakeCommitment = String(body?.stakeCommitment ?? "");
  if (!HEX32.test(commitment) || !HEX32.test(stakeCommitment)) throw new HttpError(400, "bad_request", "commitment and stakeCommitment must be 32-byte hex");
  requireSig(bettor, betMessage(market, commitment, stakeCommitment), body.signature);
  const m = await getMarket(store, market);
  if (nowSec(deps) >= m.deadlineTs || m.phase !== "open") throw new HttpError(409, "betting_closed", "the market deadline has passed");
  const doc = {
    market,
    bettor,
    commitment: commitment.toLowerCase(),
    stakeCommitment: stakeCommitment.toLowerCase(),
    signature: String(body.signature),
    committedTs: nowSec(deps),
    revealed: false,
    side: 0,
  };
  if (!(await store.insertIfAbsent("bet", `${market}:${bettor}`, doc))) {
    const cur = await store.get("bet", `${market}:${bettor}`);
    if (cur.commitment === doc.commitment && cur.stakeCommitment === doc.stakeCommitment) return { ...betView(cur), idempotent: true };
    throw new HttpError(409, "already_committed", "one bet per bettor per market");
  }
  return betView(doc);
}

export async function revealBet(body, deps) {
  const { store } = deps;
  const market = pubkey(body?.market, "market");
  const bettor = pubkey(body?.bettor, "bettor");
  const side = Number(body?.side);
  if (side !== SIDE_SURVIVE && side !== SIDE_DIE) throw new HttpError(400, "bad_request", "side must be 1 (survive) or 2 (die)");
  const saltStr = String(body?.salt ?? "");
  if (!HEX32.test(saltStr)) throw new HttpError(400, "bad_request", "salt must be 32-byte hex");
  requireSig(bettor, revealMessage(market, side, saltStr), body.signature);
  const m = await getMarket(store, market);
  const now = nowSec(deps);
  if (now < m.deadlineTs) throw new HttpError(409, "reveal_not_open", "reveals open at the deadline");
  if (now >= m.revealEndsTs || !["open", "revealing"].includes(m.phase)) throw new HttpError(409, "reveal_closed", "the reveal window has ended");
  const id = `${market}:${bettor}`;
  const bet = await store.get("bet", id);
  if (!bet) throw new HttpError(404, "no_commitment", "no bet commitment for this bettor and market");
  if (!bytesEqual(sideCommitment(side, hexToBytes(saltStr, 32), bettor), hexToBytes(bet.commitment, 32))) {
    throw new HttpError(422, "commitment_mismatch", "sha256(side||salt||bettor) does not match the commitment");
  }
  if (bet.revealed) return { ...betView(bet), idempotent: true };
  const next = { ...bet, revealed: true, side, salt: saltStr.toLowerCase(), revealSignature: String(body.signature), revealedTs: now };
  await store.put("bet", id, next);
  return betView(next);
}

const betView = (b) => ({
  market: b.market,
  bettor: b.bettor,
  commitment: b.commitment,
  stakeCommitment: b.stakeCommitment,
  committedTs: b.committedTs,
  revealed: !!b.revealed,
  side: b.revealed ? b.side : null,
});

/** Public audit log: hashes + signatures only (no amounts, no unrevealed sides). */
export async function listCommitments(market, deps) {
  await getMarket(deps.store, market);
  const bets = (await deps.store.list("bet", `${market}:`)).map((r) => r.doc);
  return {
    market,
    count: bets.length,
    message: "stovia-bet:<market>:<commitment>:<stakeCommitment>",
    commitments: bets
      .sort((a, b) => a.committedTs - b.committedTs || (a.bettor < b.bettor ? -1 : 1))
      .map((b) => ({ bettor: b.bettor, commitment: b.commitment, stakeCommitment: b.stakeCommitment, signature: b.signature, committedTs: b.committedTs, revealed: !!b.revealed, side: b.revealed ? b.side : null, salt: b.revealed ? b.salt : null })),
  };
}

// ---------------------------------------------------------------------------
// Creator bond
// ---------------------------------------------------------------------------
export async function postBond(marketParam, body, deps) {
  const { store, chain, rings, identities } = deps;
  const market = pubkey(marketParam, "market");
  const amount = u64(body?.amount, "amount");
  const ringsTxSignature = String(body?.ringsTxSignature ?? "");
  if (!SIG_RE.test(ringsTxSignature)) throw new HttpError(400, "bad_request", "ringsTxSignature must be a base58 signature");
  const m = await getMarket(store, market);
  requireSig(m.creator, bondMessage(market, amount.toString(), ringsTxSignature), body?.signature);
  if (nowSec(deps) >= m.revealEndsTs || !["open", "revealing"].includes(m.phase)) throw new HttpError(409, "market_frozen", "market already settled");
  const existing = await store.get("bond", market);
  if (existing) {
    if (existing.ringsTxSignature === ringsTxSignature && existing.amount === amount) return { market, creator: m.creator, verified: true, idempotent: true };
    throw new HttpError(409, "bond_exists", "this market already has a bond");
  }
  if (!chain || !rings) throw new HttpError(503, "not_configured", "HELIUS_API_KEY not configured");
  const owner = `bond:${market}`;
  const reserved = await store.insertIfAbsent("txsig", ringsTxSignature, { stakeId: owner, at: Date.now() });
  if (!reserved && (await store.get("txsig", ringsTxSignature))?.stakeId !== owner) throw new HttpError(409, "tx_already_used", "this Rings transaction already backs another stake");
  try {
    await verifyRingsDeposit({ chain, rings, identities, market, sender: m.creator, amount, ringsTxSignature, deadlineTs: m.deadlineTs });
  } catch (e) {
    if (reserved) await store.del("txsig", ringsTxSignature);
    throw e;
  }
  await store.insertIfAbsent("bond", market, { market, creator: m.creator, amount, ringsTxSignature, verified: true, verifiedAt: new Date().toISOString() });
  return { market, creator: m.creator, verified: true };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
export function marketStatus(m, now) {
  if (m.outcome) return m.outcome; // survived | died
  if (now >= m.deadlineTs) return "revealing";
  return "open";
}

export async function marketView(m, deps, counts) {
  const now = nowSec(deps);
  const c = counts ?? (await countBets(deps.store, m.market));
  const status = marketStatus(m, now);
  const settled = !!m.outcome;
  const bond = await deps.store.get("bond", m.market);
  return {
    market: m.market,
    pool: m.pool,
    mint: m.mint,
    name: m.name,
    symbol: m.symbol,
    uri: m.uri,
    creator: m.creator,
    targetMcapLamports: m.targetMcapLamports,
    deadlineTs: m.deadlineTs,
    revealEndsTs: m.revealEndsTs,
    createdTs: m.createdTs,
    status,
    phase: m.phase,
    currentMcapLamports: m.lastMcap,
    lastSampleTs: m.lastSampleTs,
    twapMcapLamports: m.twapFinal ?? twapValue(m.twap, Math.min(now, m.deadlineTs), m.deadlineTs),
    twapSamples: m.twap.samples,
    migrated: !!m.migrated,
    commitments: c.commitments,
    revealed: c.revealed,
    bondPosted: !!bond?.verified,
    totals: settled
      ? {
          survivePool: m.yesTotal,
          diePool: m.noTotal,
          bond: m.bond,
          bondToWinners: m.bondToWinners,
          bondRefund: m.bondRefund,
          totalPayout: m.totalPaid,
          payoutCount: m.payoutCount,
          payoutRoot: m.rootHex,
          settledTs: m.settledTs,
          claimsCloseTs: m.claimsCloseTs,
        }
      : null,
  };
}

async function countBets(store, market) {
  const bets = await store.list("bet", `${market}:`);
  return { commitments: bets.length, revealed: bets.filter((b) => b.doc.revealed).length };
}

export async function listMarkets(deps, { status, creator } = {}) {
  const out = [];
  for (const { doc } of await deps.store.list("market")) {
    if (creator && doc.creator !== creator) continue;
    const v = await marketView(doc, deps);
    if (status && v.status !== status) continue;
    out.push(v);
  }
  return out.sort((a, b) => b.createdTs - a.createdTs);
}

export async function getMarketView(market, deps) {
  const m = await getMarket(deps.store, pubkey(market, "market"));
  return launchResponse(m, deps);
}

export async function portfolio(walletParam, deps) {
  const { store } = deps;
  const wallet = pubkey(walletParam, "wallet");
  const markets = new Map((await store.list("market")).map((r) => [r.id, r.doc]));
  const now = nowSec(deps);
  const bets = [];
  for (const { id, doc } of await store.list("bet")) {
    if (doc.bettor !== wallet) continue;
    const m = markets.get(doc.market);
    const stake = await store.get("stake", id);
    const payout = await store.get("payout", id);
    bets.push({
      ...betView(doc),
      name: m?.name ?? null,
      symbol: m?.symbol ?? null,
      marketStatus: m ? marketStatus(m, now) : null,
      stakeVerified: !!stake?.verified,
      stakeRingsTx: stake?.ringsTxSignature ?? null,
      payout: payout ? payout.amount : m?.outcome ? 0n : null,
      refund: payout?.refund ?? false,
      payoutStatus: payout?.status ?? null, // unpaid | pending | paid | forfeited
      payoutSignature: payout?.paidSignature ?? null,
      claimsCloseTs: m?.claimsCloseTs ?? null,
    });
  }
  const launches = [];
  for (const m of markets.values()) {
    if (m.creator !== wallet) continue;
    const v = await marketView(m, deps);
    const bond = await store.get("bond", m.market);
    const p = await store.get("payout", `${m.market}:${wallet}`);
    launches.push({ ...v, bond: bond ? { verified: true, amount: bond.amount, refund: p?.bondRefund ?? null } : null });
  }
  return { wallet, bets, launches };
}

export async function creatorsLeaderboard(deps) {
  const now = nowSec(deps);
  const by = new Map();
  for (const { doc: m } of await deps.store.list("market")) {
    const s = by.get(m.creator) ?? { creator: m.creator, launches: 0, survived: 0, died: 0, live: 0 };
    s.launches++;
    const st = marketStatus(m, now);
    if (st === "survived") s.survived++;
    else if (st === "died") s.died++;
    else s.live++;
    by.set(m.creator, s);
  }
  return [...by.values()]
    .map((s) => ({ ...s, survivalRate: s.survived + s.died > 0 ? s.survived / (s.survived + s.died) : null }))
    .sort((a, b) => b.survived - a.survived || (b.survivalRate ?? -1) - (a.survivalRate ?? -1) || b.launches - a.launches);
}

export async function stats(deps) {
  const now = nowSec(deps);
  const s = { markets: 0, open: 0, revealing: 0, survived: 0, died: 0, commitments: 0, revealed: 0, verifiedStakes: 0, bettors: 0, creators: 0, settledVolumeLamports: 0n, paidOutLamports: 0n };
  const creators = new Set();
  for (const { doc: m } of await deps.store.list("market")) {
    s.markets++;
    s[marketStatus(m, now)]++;
    creators.add(m.creator);
    if (m.outcome) s.settledVolumeLamports += BigInt(m.yesTotal ?? 0n) + BigInt(m.noTotal ?? 0n);
  }
  const bettors = new Set();
  for (const { doc } of await deps.store.list("bet")) {
    s.commitments++;
    if (doc.revealed) s.revealed++;
    bettors.add(doc.bettor);
  }
  for (const { doc } of await deps.store.list("stake")) if (doc.verified) s.verifiedStakes++;
  for (const { doc } of await deps.store.list("payout")) if (doc.status === "paid") s.paidOutLamports += BigInt(doc.amount);
  s.bettors = bettors.size;
  s.creators = creators.size;
  return s;
}
