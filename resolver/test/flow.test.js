// Offline tests for claim verification and the settlement state machine, with fake chain/rings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { claimStake, parseClaim } from "../src/claims.js";
import { stakeCommitment, bytesToHex } from "../src/crypto.js";
import { SettlementWorker } from "../src/worker.js";
import { ActionManager } from "../src/actions.js";

const MARKET = "6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8";
const ALICE = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";
const BOB = "regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ";
const CAROL = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";
const sig = (c) => c.repeat(88);
const salt = (n) => new Uint8Array(32).fill(n);

const COMPANY = "3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm";

// Fake chain/rings. `landed` maps a signature to what it did on-chain once the admin "broadcasts" it.
function fakes({ bets, notes, signers, settled = false, survived = true, balance = 10_000n }) {
  const statuses = new Map();
  const signedBy = new Map(); // sig -> signer list
  const outbound = new Map(); // sig -> rows
  let sealedResults = null;
  let builds = 0;
  const chain = {
    async getSealedBet(_m, b) {
      return bets[b] ? { market: MARKET, bettor: b, ...bets[b] } : null;
    },
    async txSignedBy(s, b) {
      if (signers[s]) return { found: true, signed: signers[s] === b, failed: false };
      if (signedBy.has(s)) return { found: true, signed: signedBy.get(s).includes(b), failed: false };
      return { found: false };
    },
    async getMarket() {
      return { settled, survived };
    },
    async getSealedResults() {
      return sealedResults;
    },
    async signatureStatus(s) {
      return statuses.get(s) ?? "unknown";
    },
    serializeUnsigned(tx) {
      return { txBase64: Buffer.from(JSON.stringify(tx)).toString("base64"), lastValidBlockHeight: 1000n };
    },
    async buildPostSealedResultsUnsigned({ feePayer, yesTotal, noTotal, payoutRoot }) {
      builds++;
      return { txBase64: Buffer.from(`post:${feePayer}:${yesTotal}:${noTotal}:${Buffer.from(payoutRoot).toString("hex")}`).toString("base64"), lastValidBlockHeight: 1000n };
    },
  };
  const rings = {
    bal: balance,
    async receivedInTx(_id, s) {
      return notes[s] ?? { amount: 0n, rows: 0 };
    },
    async outboundInTx(_id, s) {
      return outbound.get(s) ?? [];
    },
    async balance() {
      return rings.bal;
    },
    async buildPayout({ feePayer, recipient, lamports }) {
      builds++;
      return { kind: "payout", feePayer, recipient: typeof recipient === "string" ? recipient : "shielded", lamports: String(lamports) };
    },
    async buildWithdraw({ feePayer, recipient, lamports }) {
      builds++;
      return { kind: "withdraw", feePayer, recipient, lamports: String(lamports) };
    },
  };
  const identities = { async get(m) { return { market: m }; } };
  // Simulate the company wallet signing + the tx landing with its effect.
  const land = (sig, effect) => {
    statuses.set(sig, "confirmed");
    signedBy.set(sig, [COMPANY]);
    if (effect.post) sealedResults = { payoutRootHex: effect.post };
    if (effect.outbound) outbound.set(sig, [effect.outbound]);
    if (effect.spend) rings.bal -= effect.spend;
  };
  return { chain, rings, identities, land, statuses, signedBy, builds: () => builds, setSealedResults: (v) => (sealedResults = v) };
}

function claimBody(bettor, amount, s, txs) {
  return { market: MARKET, bettor, amount: String(amount), salt2: bytesToHex(salt(s)), ringsTxSignature: txs };
}

test("claim: verifies commitment, signer and decrypted amount; rejects reuse and mismatches", async () => {
  const store = new MemoryStore();
  const f = fakes({
    bets: { [ALICE]: { stakeCommitment: stakeCommitment(500n, salt(1), ALICE), revealed: false, side: 0 } },
    notes: { [sig("A")]: { amount: 500n, rows: 1 } },
    signers: { [sig("A")]: ALICE, [sig("B")]: BOB },
  });
  const deps = { store, ...f };
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 501, 1, sig("A"))), deps), { code: "commitment_mismatch" });
  await assert.rejects(claimStake(parseClaim(claimBody(BOB, 500, 1, sig("B"))), deps), { code: "no_sealed_bet" });
  const ok = await claimStake(parseClaim(claimBody(ALICE, 500, 1, sig("A"))), deps);
  assert.equal(ok.verified, true);
  const again = await claimStake(parseClaim(claimBody(ALICE, 500, 1, sig("A"))), deps);
  assert.equal(again.idempotent, true);
  assert.equal((await store.list("tracked")).length, 1);
});

test("claim: tx signed by someone else, amount mismatch, and not-yet-indexed (retryable)", async () => {
  const store = new MemoryStore();
  const f = fakes({
    bets: { [ALICE]: { stakeCommitment: stakeCommitment(500n, salt(1), ALICE) } },
    notes: { [sig("A")]: { amount: 400n, rows: 1 } },
    signers: { [sig("A")]: ALICE, [sig("B")]: BOB, [sig("C")]: ALICE },
  });
  const deps = { store, ...f };
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 500, 1, sig("B"))), deps), { code: "not_bettor_tx" });
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 500, 1, sig("A"))), deps), { code: "amount_mismatch" });
  await assert.rejects(claimStake(parseClaim(claimBody(ALICE, 500, 1, sig("C"))), deps), { code: "note_not_indexed" });
  // failed attempts released the tx reservation
  assert.equal((await store.list("txsig")).length, 0);
});

test("claim input validation", () => {
  assert.throws(() => parseClaim({ ...claimBody(ALICE, 1, 1, sig("A")), amount: "-1" }), { code: "bad_request" });
  assert.throws(() => parseClaim({ ...claimBody(ALICE, 1, 1, sig("A")), salt2: "00" }), { code: "bad_request" });
  assert.throws(() => parseClaim({ ...claimBody(ALICE, 1, 1, sig("A")), market: "nope" }), { code: "bad_request" });
});

async function seededMarket({ settled = true, sendEnabled = false, balance } = {}) {
  const store = new MemoryStore();
  const bets = {
    [ALICE]: { stakeCommitment: stakeCommitment(100n, salt(1), ALICE), revealed: true, side: 1 },
    [BOB]: { stakeCommitment: stakeCommitment(300n, salt(2), BOB), revealed: true, side: 2 },
    [CAROL]: { stakeCommitment: stakeCommitment(50n, salt(3), CAROL), revealed: false, side: 0 },
  };
  let t = 1_000_000;
  const f = fakes({
    bets,
    notes: { [sig("A")]: { amount: 100n, rows: 1 }, [sig("B")]: { amount: 300n, rows: 1 }, [sig("C")]: { amount: 50n, rows: 1 } },
    signers: { [sig("A")]: ALICE, [sig("B")]: BOB, [sig("C")]: CAROL },
    settled,
    survived: true,
    balance: balance ?? 450n,
  });
  const deps = { store, ...f };
  await claimStake(parseClaim(claimBody(ALICE, 100, 1, sig("A"))), deps);
  await claimStake(parseClaim(claimBody(BOB, 300, 2, sig("B"))), deps);
  await claimStake(parseClaim(claimBody(CAROL, 50, 3, sig("C"))), deps);
  const log = { error() {}, warn() {}, info() {} };
  const actions = new ActionManager({ store, ...f, now: () => t });
  const worker = new SettlementWorker({ store, ...f, actions, sendEnabled, log });
  return { store, f, worker, actions, deps, advance: (ms) => (t += ms) };
}

test("worker: unsettled market is a no-op; dry run stops at computed with frozen results and no actions", async () => {
  const a = await seededMarket({ settled: false });
  assert.equal(await a.worker.tick(MARKET), null);

  const { store, worker, deps } = await seededMarket({ settled: true, sendEnabled: false });
  const st = await worker.tick(MARKET);
  assert.equal(st.state, "computed");
  assert.equal(st.yesTotal, 100n);
  assert.equal(st.noTotal, 300n);
  assert.equal(st.totalPaid, 400n); // Alice: 100 + 100*300/100
  const again = await worker.tick(MARKET);
  assert.equal(again.rootHex, st.rootHex);
  assert.equal((await store.list("payout")).length, 1);
  assert.equal((await store.list("action")).length, 0, "dry run creates no admin actions");
  await assert.rejects(claimStake(parseClaim(claimBody(CAROL, 50, 3, sig("C"))), deps), { code: "market_frozen" });
});

test("admin flow: unsigned txs with company fee payer, verified submissions, crash-safe through done", async () => {
  const { store, f, worker, actions } = await seededMarket({ sendEnabled: true });
  let st = await worker.tick(MARKET);
  assert.equal(st.state, "awaiting_post_signature");
  await worker.tick(MARKET);
  assert.equal((await store.list("action")).length, 1, "idempotent: one post action");

  // GET /admin/pending rebuilds a fresh unsigned tx each call
  let pending = await actions.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "post_results");
  assert.match(Buffer.from(pending[0].transaction, "base64").toString(), new RegExp(`^post:${COMPANY}:100:300:${st.rootHex}$`));
  const b1 = f.builds();
  await actions.listPending();
  assert.equal(f.builds(), b1 + 1, "rebuilt on every GET");

  // submitted but not landed yet -> stays submitted, not listed as pending
  assert.equal((await actions.submit(pending[0].id, sig("P"))).status, "submitted");
  assert.equal((await actions.listPending()).length, 0);
  assert.equal((await worker.tick(MARKET)).state, "awaiting_post_signature");

  f.land(sig("P"), { post: st.rootHex });
  // crash + restart: fresh worker/action manager over the same store
  const actions2 = new ActionManager({ ...actions.d });
  const worker2 = new SettlementWorker({ ...worker.d, actions: actions2 });
  st = await worker2.tick(MARKET);
  assert.equal(st.state, "paying");

  pending = await actions2.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "payout");
  assert.equal(pending[0].amount, 400n);
  const ptx = JSON.parse(Buffer.from(pending[0].transaction, "base64").toString());
  assert.equal(ptx.feePayer, COMPANY);
  assert.equal(ptx.recipient, ALICE);

  // a confirmed tx WITHOUT the expected market-wallet effect is rejected and the action reopens
  f.land(sig("X"), {});
  assert.equal((await actions2.submit(pending[0].id, sig("X"))).status, "pending");

  f.land(sig("Q"), { outbound: { kind: "privateTransfer", amount: 400n }, spend: 400n });
  assert.equal((await actions2.submit(pending[0].id, sig("Q"))).status, "confirmed");
  assert.equal((await actions2.submit(pending[0].id, sig("Q"))).idempotent, true);
  st = await worker2.tick(MARKET);
  assert.equal(st.state, "sweeping");

  pending = await actions2.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "sweep");
  assert.equal(pending[0].amount, 50n); // Carol's unrevealed stake
  const stx = JSON.parse(Buffer.from(pending[0].transaction, "base64").toString());
  assert.equal(stx.recipient, COMPANY);
  f.land(sig("S"), { outbound: { kind: "publicWithdrawal", amount: 50n }, spend: 50n });
  await actions2.submit(pending[0].id, sig("S"));
  st = await worker2.tick(MARKET);
  assert.equal(st.state, "done");
  assert.equal((await store.get("payout", `${MARKET}:${ALICE}`)).status, "confirmed");
  assert.equal((await actions2.listPending()).length, 0);
});

test("admin flow: unlanded submission reopens after timeout; signer must be company wallet; insolvency halts", async () => {
  const { f, worker, actions, advance } = await seededMarket({ sendEnabled: true });
  await worker.tick(MARKET);
  const [p] = await actions.listPending();
  await actions.submit(p.id, sig("P"));
  advance(60_000);
  assert.equal(await actions.check(p.id), "submitted");
  advance(10 * 60_000);
  assert.equal(await actions.check(p.id), "pending", "expired without landing -> rebuild");

  // landed, but signed by someone else
  f.statuses.set(sig("Z"), "confirmed");
  f.signedBy.set(sig("Z"), [ALICE]);
  assert.equal((await actions.submit(p.id, sig("Z"))).status, "pending");

  // signed outside the admin flow: SealedResults on-chain with our root is accepted
  const st0 = await worker.tick(MARKET);
  f.setSealedResults({ payoutRootHex: st0.rootHex });
  assert.equal((await worker.tick(MARKET)).state, "paying");

  const h = await seededMarket({ sendEnabled: true, balance: 10n });
  const st = await h.worker.tick(MARKET);
  assert.equal(st.state, "halted");
  assert.equal((await h.actions.listPending()).length, 0);
});
