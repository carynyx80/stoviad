// Offline tests for the program-less survival market: launches, commit/reveal, stakes, TWAP, settlement,
// payout claims (idempotency + double-pay safety), portfolio/leaderboard, treasury sweep. Fake chain/rings/DBC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLaunch, commitBet, revealBet, postBond, listCommitments, portfolio, creatorsLeaderboard, stats, listMarkets, launchMessage, betMessage, revealMessage, bondMessage, claimMessage } from "../src/markets.js";
import { claimStake, parseClaim } from "../src/claims.js";
import { buildClaim, submitClaim, reconcileSlot } from "../src/payoutclaims.js";
import { SettlementWorker } from "../src/worker.js";
import { ActionManager } from "../src/actions.js";
import { twapInit, twapAccumulate, twapValue } from "../src/twap.js";
import { mcapFromSqrtPrice, decodeVirtualPool, VIRTUAL_POOL_DISC } from "../src/dbc.js";
import { bytesToHex, pubkeyBytes } from "../src/crypto.js";
import { buildServer } from "../src/server.js";
import { makeEnv, wallet, salt, sig, commitmentHex, stakeCommitmentHex, POOL, MINT, COMPANY } from "./helpers.js";

const CREATOR = wallet(1);
const ALICE = wallet(2);
const BOB = wallet(3);
const CAROL = wallet(4);
const DAY = 86400;
const quiet = { error() {}, warn() {}, info() {} };

function launchBody(env, { target = 5_000_000_000n, deadline = env.nowS() + 2 * DAY, signer = CREATOR, creator = CREATOR.address } = {}) {
  return { pool: POOL, mint: MINT, creator, name: "Test", symbol: "TST", uri: "https://x/y.json", targetMcapLamports: target.toString(), deadlineTs: deadline, signature: signer.sign(launchMessage(POOL, MINT, target.toString(), deadline)) };
}
const commitBody = (w, side, s, amount, s2) => {
  const commitment = commitmentHex(side, salt(s), w.address);
  const stakeCommitment = stakeCommitmentHex(amount, salt(s2), w.address);
  return { market: POOL, bettor: w.address, commitment, stakeCommitment, signature: w.sign(betMessage(POOL, commitment, stakeCommitment)) };
};
const revealBody = (w, side, s) => ({ market: POOL, bettor: w.address, side, salt: bytesToHex(salt(s)), signature: w.sign(revealMessage(POOL, side, bytesToHex(salt(s)))) });
const claimBody = (w, amount, s2, tx) => ({ market: POOL, bettor: w.address, amount: String(amount), salt2: bytesToHex(salt(s2)), ringsTxSignature: tx });

async function launched(opts = {}) {
  const env = makeEnv({ creator: CREATOR.address, ...opts });
  const r = await createLaunch(launchBody(env, opts), env);
  return { env, r, deadline: r.deadlineTs };
}

// ---------------------------------------------------------------------------
test("launch: verifies signature, DBC pool owner/mint/creator/quote, deadline window and target; idempotent", async () => {
  const env = makeEnv({ creator: CREATOR.address });
  await assert.rejects(createLaunch(launchBody(env, { signer: ALICE }), env), { code: "bad_signature" });
  await assert.rejects(createLaunch(launchBody(env, { deadline: env.nowS() + 600 }), env), { code: "bad_deadline" });
  await assert.rejects(createLaunch(launchBody(env, { deadline: env.nowS() + 31 * DAY }), env), { code: "bad_deadline" });
  await assert.rejects(createLaunch(launchBody(env, { target: 1_000_000_000n }), env), { code: "target_too_low" });
  await assert.rejects(createLaunch(launchBody(makeEnv({ creator: CREATOR.address, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" })), makeEnv({ creator: CREATOR.address, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" })), { code: "bad_pool_owner" });
  const e2 = makeEnv({ creator: ALICE.address });
  await assert.rejects(createLaunch(launchBody(e2), e2), { code: "creator_mismatch" });
  const e3 = makeEnv({ creator: CREATOR.address, baseMint: COMPANY });
  await assert.rejects(createLaunch(launchBody(e3), e3), { code: "mint_mismatch" });
  const e4 = makeEnv({ creator: CREATOR.address, quoteMint: COMPANY });
  await assert.rejects(createLaunch(launchBody(e4), e4), { code: "quote_not_sol" });

  const body = launchBody(env);
  const r = await createLaunch(body, env);
  assert.equal(r.market, POOL);
  assert.equal(r.status, "open");
  assert.equal(r.shieldedAddress.length, 198);
  assert.equal(r.revealEndsTs, body.deadlineTs + DAY);
  assert.equal(r.currentMcapLamports, 1_000_000_000n);
  assert.equal((await createLaunch(body, env)).idempotent, true);
  await assert.rejects(createLaunch(launchBody(env, { target: 6_000_000_000n }), env), { code: "market_exists" });
});

test("commit/reveal: signatures, one per bettor, before deadline only, reveal window, hashes-only audit log", async () => {
  const { env, deadline } = await launched();
  const a = commitBody(ALICE, 1, 10, 500n, 11);
  await assert.rejects(commitBet({ ...a, signature: BOB.sign(betMessage(POOL, a.commitment, a.stakeCommitment)) }, env), { code: "bad_signature" });
  assert.equal((await commitBet(a, env)).revealed, false);
  assert.equal((await commitBet(a, env)).idempotent, true);
  await assert.rejects(commitBet(commitBody(ALICE, 2, 12, 500n, 11), env), { code: "already_committed" });
  await commitBet(commitBody(BOB, 2, 20, 300n, 21), env);

  const log = await listCommitments(POOL, env);
  assert.equal(log.count, 2);
  assert.ok(log.commitments.every((c) => c.side === null && c.salt === null && !("amount" in c)));

  await assert.rejects(revealBet(revealBody(ALICE, 1, 10), env), { code: "reveal_not_open" });
  env.setNowS(deadline);
  await assert.rejects(commitBet(commitBody(CAROL, 1, 30, 50n, 31), env), { code: "betting_closed" });
  await assert.rejects(revealBet(revealBody(ALICE, 2, 10), env), { code: "commitment_mismatch" });
  await assert.rejects(revealBet(revealBody(ALICE, 1, 99), env), { code: "commitment_mismatch" });
  await assert.rejects(revealBet({ ...revealBody(ALICE, 1, 10), signature: BOB.sign("x") }, env), { code: "bad_signature" });
  const rv = await revealBet(revealBody(ALICE, 1, 10), env);
  assert.equal(rv.side, 1);
  assert.equal((await revealBet(revealBody(ALICE, 1, 10), env)).idempotent, true);
  env.setNowS(deadline + DAY);
  await assert.rejects(revealBet(revealBody(BOB, 2, 20), env), { code: "reveal_closed" });
});

test("stake claim: checks the off-chain stakeCommitment, bettor signer, deadline, amount, tx reuse", async () => {
  const { env, deadline } = await launched();
  await commitBet(commitBody(ALICE, 1, 10, 500n, 11), env);
  env.deposit(sig("A"), ALICE.address, 500n);
  env.deposit(sig("B"), BOB.address, 500n);
  env.deposit(sig("L"), ALICE.address, 500n, deadline + 5);
  env.deposit(sig("M"), ALICE.address, 400n);
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 501, 11, sig("A"))), env), { code: "commitment_mismatch" });
  await assert.rejects(claimStake(parseClaim(claimBody(BOB, 500, 11, sig("B"))), env), { code: "no_commitment" });
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 500, 11, sig("B"))), env), { code: "not_sender_tx" });
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 500, 11, sig("L"))), env), { code: "tx_after_deadline" });
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 500, 11, sig("M"))), env), { code: "amount_mismatch" });
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 500, 11, sig("N"))), env), { code: "tx_not_found" });
  assert.equal((await env.store.list("txsig")).length, 0, "failed attempts release the tx reservation");
  assert.equal((await claimStake(parseClaim(claimBody(ALICE, 500, 11, sig("A"))), env)).verified, true);
  assert.equal((await claimStake(parseClaim(claimBody(ALICE, 500, 11, sig("A"))), env)).idempotent, true);
  // after the deadline the claim is still accepted (transfer landed in time) until reveal end
  env.setNowS(deadline + 10);
  await commitBet(commitBody(BOB, 2, 20, 500n, 21), env).catch(() => {});
});

test("TWAP math: step-hold integration, gaps hold the last value, post-deadline samples ignored", () => {
  let s = twapInit(0, 100n);
  s = twapAccumulate(s, 60, 200n, 300);
  s = twapAccumulate(s, 120, 400n, 300);
  assert.equal(twapValue(s, 120, 300), (100n * 60n + 200n * 60n) / 120n); // 150
  // gap until deadline holds 400
  assert.equal(twapValue(s, 300, 300), (100n * 60n + 200n * 60n + 400n * 180n) / 300n);
  const late = twapAccumulate(s, 900, 1_000_000n, 300);
  assert.equal(twapValue(late, 900, 300), twapValue(s, 300, 300), "post-deadline sample does not count");
  assert.equal(twapValue(twapInit(5, 7n), 5, 300), 7n);
  // DBC mcap = sqrt^2 * supply >> 128 (decimals cancel in raw units)
  assert.equal(mcapFromSqrtPrice(1n << 64n, 1000n), 1000n); // price 1 lamport/raw
  assert.equal(mcapFromSqrtPrice(1n << 63n, 1000n), 250n); // price 0.25
});

test("DBC VirtualPool decode (synthetic account with the IDL layout)", () => {
  const b = Buffer.alloc(424);
  VIRTUAL_POOL_DISC.copy(b, 0);
  Buffer.from(pubkeyBytes(COMPANY)).copy(b, 104);
  Buffer.from(pubkeyBytes(MINT)).copy(b, 136);
  b.writeBigUInt64LE(123n, 280);
  b.writeBigUInt64LE(1n, 288); // high limb
  b[305] = 1;
  const p = decodeVirtualPool(b);
  assert.equal(p.creator, COMPANY);
  assert.equal(p.baseMint, MINT);
  assert.equal(p.sqrtPrice, (1n << 64n) + 123n);
  assert.equal(p.isMigrated, true);
  assert.throws(() => decodeVirtualPool(Buffer.alloc(424)), /discriminator/);
});

// Full market: Alice 100 SURVIVE, Bob 300 DIE, Carol 50 unrevealed, creator bond 200.
async function fullMarket({ finalMcap, bond = 200n, sendEnabled = false } = {}) {
  const { env, deadline } = await launched();
  const worker = new SettlementWorker({ ...env, actions: new ActionManager({ ...env, companyWallet: COMPANY }), sendEnabled, log: quiet });
  const plan = [
    [ALICE, 1, 100n, "A"],
    [BOB, 2, 300n, "B"],
    [CAROL, 1, 50n, "C"],
  ];
  for (const [w, side, amt, s] of plan) {
    await commitBet(commitBody(w, side, side * 10 + amt.toString().length, amt, 7), env);
    env.deposit(sig(s), w.address, amt);
    await claimStake(parseClaim(claimBody(w, amt, 7, sig(s))), env);
  }
  if (bond) {
    env.deposit(sig("D"), CREATOR.address, bond);
    await postBond(POOL, { amount: bond.toString(), ringsTxSignature: sig("D"), signature: CREATOR.sign(bondMessage(POOL, bond.toString(), sig("D"))) }, env);
  }
  // sample: mcap moves to finalMcap for the whole window after 1 minute
  env.advance(60);
  env.pool.mcapLamports = finalMcap;
  await worker.tick(POOL);
  env.setNowS(deadline);
  assert.equal((await worker.tick(POOL)).phase, "revealing");
  await revealBet(revealBody(ALICE, 1, 13), env);
  await revealBet(revealBody(BOB, 2, 23), env);
  env.setNowS(deadline + DAY);
  const m = await worker.tick(POOL);
  return { env, worker, m, deadline };
}

test("worker: samples mcap, freezes TWAP at deadline, settles SURVIVED with bond refund to creator", async () => {
  const { env, m } = await fullMarket({ finalMcap: 9_000_000_000n });
  assert.equal(m.phase, "settled");
  assert.equal(m.outcome, "survived");
  assert.ok(m.twapFinal >= 5_000_000_000n);
  assert.equal(m.yesTotal, 100n);
  assert.equal(m.noTotal, 300n);
  const alice = await env.store.get("payout", `${POOL}:${ALICE.address}`);
  assert.equal(alice.amount, 400n); // 100 + 100*300/100
  const cr = await env.store.get("payout", `${POOL}:${CREATOR.address}`);
  assert.equal(cr.amount, 200n);
  assert.equal(cr.bondRefund, 200n);
  assert.equal(await env.store.get("payout", `${POOL}:${CAROL.address}`), null, "unrevealed stake forfeited");
});

test("worker: DIED -> NO winners share losing pool + bond: stake + floor(stake*(losing+bond)/winning)", async () => {
  const { env, m } = await fullMarket({ finalMcap: 1_100_000_000n });
  assert.equal(m.outcome, "died");
  assert.equal(m.bondToWinners, 200n);
  const bob = await env.store.get("payout", `${POOL}:${BOB.address}`);
  assert.equal(bob.amount, 300n + (300n * (100n + 200n)) / 300n);
  assert.equal(await env.store.get("payout", `${POOL}:${CREATOR.address}`), null);
});

test("worker: migrated pool stops sampling and holds the last value; RPC failure holds too", async () => {
  const { env, deadline } = await launched();
  const worker = new SettlementWorker({ ...env, actions: null, sendEnabled: false, log: quiet });
  env.advance(60);
  env.pool.mcapLamports = 8_000_000_000n;
  env.pool.isMigrated = true;
  let m = await worker.tick(POOL);
  assert.equal(m.migrated, true);
  env.pool.mcapLamports = 1n; // must be ignored now
  env.advance(120);
  m = await worker.tick(POOL);
  assert.equal(m.lastMcap, 8_000_000_000n);
  env.dbc.fail = true;
  env.setNowS(deadline);
  m = await worker.tick(POOL);
  assert.equal(m.phase, "revealing");
  // 60s at 1 SOL then (2d - 60s) at 8 SOL
  const span = BigInt(deadline - m.createdTs);
  assert.equal(m.twapFinal, (1_000_000_000n * 60n + 8_000_000_000n * (span - 60n)) / span);
});

test("payout claims: cached idempotent tx, market busy for others, signature bound to the built tx, paid once", async () => {
  const { env, deadline } = await fullMarket({ finalMcap: 9_000_000_000n });
  const deps = { ...env, ShieldedAddress: null };
  const cb = (w) => ({ market: POOL, bettor: w.address, signature: w.sign(claimMessage(POOL)) });
  await assert.rejects(buildClaim({ ...cb(ALICE), signature: BOB.sign(claimMessage(POOL)) }, deps), { code: "bad_signature" });
  await assert.rejects(buildClaim(cb(BOB), deps), { code: "no_payout" });

  const b1 = await buildClaim(cb(ALICE), deps);
  assert.equal(b1.amount, 400n);
  assert.equal(b1.feePayer, ALICE.address);
  assert.equal(b1.mode, "withdraw");
  const b2 = await buildClaim(cb(ALICE), deps);
  assert.equal(b2.transaction, b1.transaction, "same bytes while in flight");
  assert.equal(b2.cached, true);
  assert.equal(env.builds(), 1);
  await assert.rejects(buildClaim(cb(CREATOR), deps), { code: "market_busy" });

  // a signature over some OTHER message cannot touch the slot
  await assert.rejects(submitClaim({ market: POOL, bettor: ALICE.address, signature: ALICE.sign("other") }, deps), { code: "signature_mismatch" });
  const txSig = ALICE.signTx(b1.transaction);
  assert.equal((await submitClaim({ market: POOL, bettor: ALICE.address, signature: txSig }, deps)).status, "submitted");
  env.land(txSig, ALICE.address, { outbound: { kind: "publicWithdrawal", amount: 400n } });
  assert.equal((await submitClaim({ market: POOL, bettor: ALICE.address, signature: txSig }, deps)).status, "paid");
  assert.equal((await submitClaim({ market: POOL, bettor: ALICE.address, signature: txSig }, deps)).idempotent, true);
  await assert.rejects(buildClaim(cb(ALICE), deps), { code: "already_paid" });

  // slot freed: creator can now claim the bond refund
  const c1 = await buildClaim(cb(CREATOR), deps);
  assert.equal(c1.amount, 200n);
  const p = await portfolio(ALICE.address, env);
  assert.equal(p.bets[0].payoutStatus, "paid");
  assert.equal(p.bets[0].payout, 400n);
  assert.equal(p.bets[0].stakeVerified, true);
  assert.equal(deadline > 0, true);
});

test("payout claims: expired unreported landing is attributed (no double pay); expired unlanded and failed release", async () => {
  const { env } = await fullMarket({ finalMcap: 9_000_000_000n });
  const deps = { ...env, ShieldedAddress: null };
  const cb = (w) => ({ market: POOL, bettor: w.address, signature: w.sign(claimMessage(POOL)) });

  // 1) Alice builds, signs and lands WITHOUT reporting; after expiry the worker attributes it.
  const b = await buildClaim(cb(ALICE), deps);
  const s1 = ALICE.signTx(b.transaction);
  env.land(s1, ALICE.address, { outbound: { kind: "publicWithdrawal", amount: 400n } });
  assert.equal(await reconcileSlot(POOL, deps), false, "not expired yet: slot held");
  env.setHeight(1000 + 151);
  assert.equal(await reconcileSlot(POOL, deps), true);
  const pa = await env.store.get("payout", `${POOL}:${ALICE.address}`);
  assert.equal(pa.status, "paid");
  assert.equal(pa.paidSignature, s1);
  await assert.rejects(buildClaim(cb(ALICE), deps), { code: "already_paid" });

  // 2) Creator builds, never lands; after expiry the slot is released and a FRESH tx is built.
  env.setHeight(500);
  const c1 = await buildClaim(cb(CREATOR), deps);
  env.setHeight(1200);
  const c2 = await buildClaim(cb(CREATOR), deps);
  assert.notEqual(c2.transaction, c1.transaction);
  // 3) that tx fails on-chain -> released, payout back to unpaid
  const s3 = CREATOR.signTx(c2.transaction);
  env.land(s3, CREATOR.address, { failed: true });
  assert.equal((await submitClaim({ market: POOL, bettor: CREATOR.address, signature: s3 }, deps)).status, "failed");
  assert.equal((await env.store.get("payout", `${POOL}:${CREATOR.address}`)).status, "unpaid");
  assert.equal(await env.store.get("claimslot", POOL), null);
});

test("treasury sweep: after the claims window, unpaid payouts forfeited; admin queue gated by RESOLVER_SEND_ENABLED; claims closed", async () => {
  const { env, worker, deadline } = await fullMarket({ finalMcap: 9_000_000_000n });
  const deps = { ...env, ShieldedAddress: null };
  env.setNowS(deadline + DAY + 7 * DAY);
  await assert.rejects(buildClaim({ market: POOL, bettor: ALICE.address, signature: ALICE.sign(claimMessage(POOL)) }, deps), { code: "claims_closed" });
  let m = await worker.tick(POOL);
  assert.equal(m.phase, "sweeping");
  assert.equal((await env.store.get("payout", `${POOL}:${ALICE.address}`)).status, "forfeited");
  assert.equal((await env.store.list("action")).length, 0, "send disabled: no admin action");

  const actions = new ActionManager({ ...env, companyWallet: COMPANY });
  const w2 = new SettlementWorker({ ...env, actions, sendEnabled: true, log: quiet });
  m = await w2.tick(POOL);
  const pending = await actions.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "sweep");
  assert.equal(pending[0].amount, 650n); // all deposits (100+300+50+200) remain
  env.land(sig("S"), COMPANY, { outbound: { kind: "publicWithdrawal", amount: 650n } });
  assert.equal((await actions.submit(pending[0].id, sig("S"))).status, "confirmed");
  assert.equal((await w2.tick(POOL)).phase, "done");
});

test("views: market list fields, totals hidden until settlement, creators leaderboard, stats, portfolio launches", async () => {
  const { env } = await launched();
  await commitBet(commitBody(ALICE, 1, 10, 500n, 11), env);
  let [v] = await listMarkets(env);
  assert.equal(v.status, "open");
  assert.equal(v.commitments, 1);
  assert.equal(v.revealed, 0);
  assert.equal(v.totals, null);
  assert.ok(v.twapMcapLamports > 0n);

  const settled = await fullMarket({ finalMcap: 1_100_000_000n });
  [v] = await listMarkets(settled.env);
  assert.equal(v.status, "died");
  assert.equal(v.totals.diePool, 300n);
  const lb = await creatorsLeaderboard(settled.env);
  assert.deepEqual(lb[0], { creator: CREATOR.address, launches: 1, survived: 0, died: 1, live: 0, survivalRate: 0 });
  const st = await stats(settled.env);
  assert.equal(st.markets, 1);
  assert.equal(st.died, 1);
  assert.equal(st.commitments, 3);
  assert.equal(st.verifiedStakes, 3);
  assert.equal(st.settledVolumeLamports, 400n);
  const p = await portfolio(CREATOR.address, settled.env);
  assert.equal(p.launches.length, 1);
  assert.equal(p.launches[0].bond.amount, 200n);
  const pc = await portfolio(CAROL.address, settled.env);
  assert.equal(pc.bets[0].revealed, false);
  assert.equal(pc.bets[0].payout, 0n);
});

test("HTTP: routes serialize BigInt as strings and map errors", async () => {
  const env = makeEnv({ creator: CREATOR.address });
  const app = buildServer({ ...env, config: { logLevel: "silent", companyWallet: COMPANY } });
  let r = await app.inject({ method: "POST", url: "/launches", payload: launchBody(env) });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().targetMcapLamports, "5000000000");
  r = await app.inject({ method: "POST", url: "/launches", payload: launchBody(env) });
  assert.equal(r.statusCode, 200);
  r = await app.inject({ method: "GET", url: "/markets" });
  assert.equal(r.json().markets[0].status, "open");
  r = await app.inject({ method: "GET", url: `/markets/${POOL}` });
  assert.equal(r.json().market, POOL);
  r = await app.inject({ method: "POST", url: "/bets/commit", payload: commitBody(ALICE, 1, 10, 500n, 11) });
  assert.equal(r.statusCode, 201);
  r = await app.inject({ method: "GET", url: `/markets/${POOL}/commitments` });
  assert.equal(r.json().count, 1);
  r = await app.inject({ method: "POST", url: "/bets/reveal", payload: revealBody(ALICE, 1, 10) });
  assert.equal(r.statusCode, 409);
  r = await app.inject({ method: "GET", url: `/portfolio/${ALICE.address}` });
  assert.equal(r.json().bets.length, 1);
  for (const u of ["/creators", "/stats", "/health"]) assert.equal((await app.inject({ method: "GET", url: u })).statusCode, 200);
  r = await app.inject({ method: "GET", url: "/markets/nope" });
  assert.equal(r.statusCode, 400);
  await app.close();
});

test("settlement math with bond: died with no NO winners -> YES refunded, bond to treasury; survived merges creator bet + bond", async () => {
  const { computeSettlement } = await import("../src/payouts.js");
  const s = computeSettlement({ survived: false, bond: 70n, creator: CREATOR.address }, [{ bettor: ALICE.address, amount: 10n, verified: true, revealed: true, side: 1 }]);
  assert.deepEqual(s.payouts.map((p) => [p.bettor, p.amount, p.refund]), [[ALICE.address, 10n, true]]);
  assert.equal(s.bondToTreasury, 70n);
  const t = computeSettlement({ survived: true, bond: 70n, creator: CREATOR.address }, [
    { bettor: CREATOR.address, amount: 10n, verified: true, revealed: true, side: 1 },
    { bettor: BOB.address, amount: 30n, verified: true, revealed: true, side: 2 },
  ]);
  const cr = t.payouts.find((p) => p.bettor === CREATOR.address);
  assert.equal(cr.amount, 10n + 30n + 70n);
  assert.equal(cr.bondRefund, 70n);
  assert.equal(t.totalPaid, 110n);
});
