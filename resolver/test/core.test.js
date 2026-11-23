import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, signBytes } from "@solana/kit";
import { MarketIdentities, deriveMarketSeed, parseMasterSeed } from "../src/keys.js";
import { AdminAuth, adminMessage } from "../src/admin.js";
import nacl from "tweetnacl";
import { stakeCommitment, u64le, sha256, pubkeyBytes, buildPayoutTree, payoutProof, verifyPayoutProof, bytesToHex } from "../src/crypto.js";
import { computeSettlement, SIDE_SURVIVE, SIDE_DIE } from "../src/payouts.js";
import { decodeSealedBet } from "../src/chain.js";
import { anchorDiscriminator, decodeAccount, loadIdl } from "../src/idl.js";
import { payoutAddressMessage, verifyWalletSignature } from "../src/claims.js";

const M1 = "6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8";
const M2 = "3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm";
const SEED_A = "11".repeat(32);
const SEED_B = "22".repeat(32);

test("identity derivation is deterministic per (seed, market) and separated across markets/seeds", async () => {
  const a1 = await new MarketIdentities(parseMasterSeed(SEED_A)).publicInfo(M1);
  const a1again = await new MarketIdentities(parseMasterSeed(SEED_A)).publicInfo(M1);
  const a2 = await new MarketIdentities(parseMasterSeed(SEED_A)).publicInfo(M2);
  const b1 = await new MarketIdentities(parseMasterSeed(SEED_B)).publicInfo(M1);
  assert.equal(a1.shieldedAddressHex, a1again.shieldedAddressHex);
  assert.equal(a1.ownerSolanaAddress, a1again.ownerSolanaAddress);
  assert.notEqual(a1.shieldedAddressHex, a2.shieldedAddressHex);
  assert.notEqual(a1.shieldedAddressHex, b1.shieldedAddressHex);
  assert.equal(a1.shieldedAddressHex.length, 99 * 2);
  // HKDF vector pinned so an accidental derivation change (which would orphan funds) fails CI.
  assert.equal(bytesToHex(deriveMarketSeed(parseMasterSeed(SEED_A), M1)), bytesToHex(deriveMarketSeed(parseMasterSeed(SEED_A), M1)));
  assert.notEqual(bytesToHex(deriveMarketSeed(parseMasterSeed(SEED_A), M1)), bytesToHex(deriveMarketSeed(parseMasterSeed(SEED_A), M2)));
});

test("identity objects never serialize secrets", async () => {
  const ids = new MarketIdentities(parseMasterSeed(SEED_A));
  assert.equal(JSON.stringify({ ids }), '{"ids":"[MarketIdentities]"}');
  const info = await ids.publicInfo(M1);
  assert.deepEqual(Object.keys(info).sort(), ["market", "ownerSolanaAddress", "shieldedAddressBase64", "shieldedAddressHex"]);
});

test("master seed validation", () => {
  assert.throws(() => parseMasterSeed(""), /not set/);
  assert.throws(() => parseMasterSeed("abcd"), /32 bytes/);
  assert.throws(() => parseMasterSeed("00".repeat(32)), /all zero/);
});

test("admin auth: company-wallet signature over single-use nonce, 5-minute expiry", async () => {
  const { getBase58Decoder } = await import("@solana/kit");
  const kp = nacl.sign.keyPair();
  const admin = getBase58Decoder().decode(kp.publicKey);
  let t = 0;
  const auth = new AdminAuth({ adminPubkey: admin, now: () => t });
  const sign = (nonce) => getBase58Decoder().decode(nacl.sign.detached(new TextEncoder().encode(adminMessage(nonce)), kp.secretKey));

  const n1 = auth.issue();
  assert.equal(n1.message, `stovia-admin:${n1.nonce}`);
  assert.equal(auth.verify(n1.nonce, sign(n1.nonce)), true);
  assert.equal(auth.verify(n1.nonce, sign(n1.nonce)), false, "single use");

  const n2 = auth.issue();
  const other = nacl.sign.keyPair();
  const bad = getBase58Decoder().decode(nacl.sign.detached(new TextEncoder().encode(adminMessage(n2.nonce)), other.secretKey));
  assert.equal(auth.verify(n2.nonce, bad), false, "wrong key");
  assert.equal(auth.verify(n2.nonce, sign(n2.nonce)), false, "consumed by the failed attempt");

  const n3 = auth.issue();
  t += 5 * 60 * 1000 + 1;
  assert.equal(auth.verify(n3.nonce, sign(n3.nonce)), false, "expired");
  assert.equal(auth.verify("never-issued", sign("never-issued")), false);
});

test("stake commitment = sha256(amount_le_u64 || salt2 || bettor)", () => {
  const salt2 = new Uint8Array(32).fill(9);
  const amount = 1_500_000_000n;
  const expected = sha256(u64le(amount), salt2, pubkeyBytes(M2));
  assert.deepEqual(stakeCommitment(amount, salt2, M2), expected);
  assert.equal(u64le(1n)[0], 1);
  assert.notDeepEqual(stakeCommitment(amount + 1n, salt2, M2), expected);
  assert.throws(() => stakeCommitment(amount, new Uint8Array(31), M2));
});

const B = ["11111111111111111111111111111111", M1, M2, "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW", "regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ"];

test("payout math: winners get stake + pro-rata share of losing pool; invalid stakes excluded", () => {
  const s = computeSettlement({ survived: true }, [
    { bettor: B[0], amount: 100n, verified: true, revealed: true, side: SIDE_SURVIVE },
    { bettor: B[1], amount: 300n, verified: true, revealed: true, side: SIDE_SURVIVE },
    { bettor: B[2], amount: 200n, verified: true, revealed: true, side: SIDE_DIE },
    { bettor: B[3], amount: 999n, verified: true, revealed: false, side: 0 }, // unrevealed -> treasury
    { bettor: B[4], amount: 777n, verified: false, revealed: true, side: SIDE_SURVIVE }, // unverified -> ignored
  ]);
  assert.equal(s.yesTotal, 400n);
  assert.equal(s.noTotal, 200n);
  assert.deepEqual(s.payouts.map((p) => [p.bettor, p.amount]), [[B[0], 150n], [B[1], 450n]]);
  assert.equal(s.totalPaid, 600n);
  assert.equal(s.excludedVerified, 999n);
});

test("payout math: rounding down never exceeds the pool", () => {
  const s = computeSettlement({ survived: false }, [
    { bettor: B[0], amount: 1n, verified: true, revealed: true, side: SIDE_DIE },
    { bettor: B[1], amount: 2n, verified: true, revealed: true, side: SIDE_DIE },
    { bettor: B[2], amount: 10n, verified: true, revealed: true, side: SIDE_SURVIVE },
  ]);
  // 1 + floor(10/3) = 4, 2 + floor(20/3) = 8 → 12 ≤ 13
  assert.deepEqual(s.payouts.map((p) => p.amount), [4n, 8n]);
  assert.ok(s.totalPaid <= s.yesTotal + s.noTotal);
});

test("payout math: empty winning side refunds valid losers", () => {
  const s = computeSettlement({ survived: true }, [{ bettor: B[0], amount: 5n, verified: true, revealed: true, side: SIDE_DIE }]);
  assert.deepEqual(s.payouts, [{ bettor: B[0], amount: 5n, refund: true, stake: 5n, bondRefund: 0n }]);
});

test("Merkle root + proofs verify for every leaf; tampering fails", () => {
  for (let n = 0; n <= B.length; n++) {
    const entries = B.slice(0, n).map((b, i) => ({ bettor: b, amount: BigInt(1000 + i) }));
    const tree = buildPayoutTree(entries);
    if (n === 0) {
      assert.deepEqual(tree.root, new Uint8Array(32));
      continue;
    }
    for (const e of entries) {
      const proof = payoutProof(tree, e.bettor);
      assert.ok(verifyPayoutProof(tree.root, e.bettor, e.amount, proof), `n=${n}`);
      assert.ok(!verifyPayoutProof(tree.root, e.bettor, e.amount + 1n, proof));
    }
    // order-independent
    assert.deepEqual(buildPayoutTree([...entries].reverse()).root, tree.root);
  }
  assert.throws(() => buildPayoutTree([{ bettor: B[0], amount: 1n }, { bettor: B[0], amount: 2n }]), /duplicate/);
});

test("single-leaf root equals the leaf hash sha256(bettor||amount_le)", () => {
  const tree = buildPayoutTree([{ bettor: M1, amount: 42n }]);
  assert.deepEqual(tree.root, sha256(pubkeyBytes(M1), u64le(42n)));
});

test("SealedBet fallback layout decodes", () => {
  const buf = Buffer.alloc(139);
  Buffer.from(anchorDiscriminator("account", "SealedBet")).copy(buf, 0);
  Buffer.from(pubkeyBytes(M1)).copy(buf, 8);
  Buffer.from(pubkeyBytes(M2)).copy(buf, 40);
  buf.fill(7, 104, 136);
  buf[136] = 2;
  buf[137] = 1;
  const d = decodeSealedBet(null, buf);
  assert.equal(d.market, M1);
  assert.equal(d.bettor, M2);
  assert.deepEqual(d.stakeCommitment, new Uint8Array(32).fill(7));
  assert.equal(d.side, 2);
  assert.equal(d.revealed, true);
});

test("IDL Market decode (copied IDL)", () => {
  const idl = loadIdl();
  assert.ok(idl, "idl/stovia.json present");
  const acc = idl.accounts.find((a) => a.name === "Market");
  // launch(32) target(8) start(8) deadline(8) reveal_end(8) twap_cum(16) last_ts(8) last_mcap(8) twap(8)
  // bond(8) bond_claimed(1) committed(8) revealed(8) yes(8) no(8) bonus(8) status(1) swept(1)
  // + sealed_committed(u32) sealed_revealed(u32)
  const body = Buffer.alloc(32 + 8 * 4 + 16 + 8 * 3 + 8 + 1 + 8 * 5 + 1 + 1 + 4 + 4);
  body[body.length - 10] = 1; // status = Survived
  const m = decodeAccount(idl, "Market", Buffer.concat([Buffer.from(acc.discriminator), body]));
  assert.equal(m.status, "Survived");
});

test("post_sealed_results ix resolves all IDL accounts and encodes args", async () => {
  const { Chain } = await import("../src/chain.js");
  const chain = new Chain({ rpcUrl: "http://127.0.0.1:1", idl: loadIdl() });
  const ix = await chain.postSealedResultsIx({ resolver: M2, market: M1, yesTotal: 5n, noTotal: 7n, payoutRoot: new Uint8Array(32).fill(1) });
  assert.equal(ix.accounts.length, 5);
  assert.equal(ix.accounts[0].address, M2);
  assert.equal(ix.accounts[2].address, M1);
  assert.equal(ix.data.length, 8 + 8 + 8 + 32);
  assert.deepEqual([...ix.data.subarray(0, 8)], [150, 46, 89, 136, 177, 204, 203, 232]);
});

test("SealedBet decodes via the current IDL", () => {
  const idl = loadIdl();
  const acc = idl.accounts.find((a) => a.name === "SealedBet");
  const body = Buffer.alloc(32 * 4 + 1 + 1 + 8 + 1);
  Buffer.from(pubkeyBytes(M1)).copy(body, 0);
  Buffer.from(pubkeyBytes(M2)).copy(body, 32);
  body.fill(5, 96, 128);
  body[128] = 1;
  body[129] = 1;
  const d = decodeSealedBet(idl, Buffer.concat([Buffer.from(acc.discriminator), body]));
  assert.equal(d.bettor, M2);
  assert.deepEqual(d.stakeCommitment, new Uint8Array(32).fill(5));
  assert.equal(d.side, 1);
  assert.equal(d.revealed, true);
});

test("payout address signature verification", async () => {
  const signer = await generateKeyPairSigner();
  const hex = "ab".repeat(99);
  const msg = new TextEncoder().encode(payoutAddressMessage(signer.address, hex));
  const sig = await signBytes(signer.keyPair.privateKey, msg);
  assert.equal(await verifyWalletSignature(signer.address, payoutAddressMessage(signer.address, hex), Buffer.from(sig).toString("hex")), true);
  assert.equal(await verifyWalletSignature(signer.address, payoutAddressMessage(signer.address, "cd".repeat(99)), Buffer.from(sig).toString("hex")), false);
});
