// Offline fakes for chain / rings / DBC and wallet helpers shared by the flow tests.
import nacl from "tweetnacl";
import {
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { MemoryStore } from "../src/store.js";
import { sha256, pubkeyBytes, u64le, bytesToHex } from "../src/crypto.js";
import { WSOL_MINT } from "../src/dbc.js";

const b58 = getBase58Decoder();
export const COMPANY = "3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm";
export const POOL = "FuEU7BrShjYGz4yHUHzyCQigafpB6nfHMFYW1NX9wyco";
export const MINT = "CCdLh8sof9LvhQ9miBmPhxzWWnRRBPY6tCFrN3fiBAGS";
export const sig = (c) => c.repeat(88);

export function wallet(seedByte) {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  const addr = b58.decode(kp.publicKey);
  return {
    address: addr,
    sign: (msg) => b58.decode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)),
    signTx: (txBase64) => {
      const { messageBytes } = getTransactionDecoder().decode(Buffer.from(txBase64, "base64"));
      return b58.decode(nacl.sign.detached(new Uint8Array(messageBytes), kp.secretKey));
    },
  };
}

export const salt = (n) => new Uint8Array(32).fill(n);
export const commitmentHex = (side, s, bettor) => bytesToHex(sha256(Uint8Array.of(side), s, pubkeyBytes(bettor)));
export const stakeCommitmentHex = (amount, s, bettor) => bytesToHex(sha256(u64le(amount), s, pubkeyBytes(bettor)));

let txCounter = 0;
function compiled(feePayer, tag) {
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM", lastValidBlockHeight: 1000n }, m),
    (m) => appendTransactionMessageInstruction({ programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), accounts: [], data: new TextEncoder().encode(`${tag}:${++txCounter}`) }, m),
  );
  return compileTransaction(msg);
}

/** Build a full fake environment. `t` is the clock in ms (mutable through env.setNow / env.advance). */
export function makeEnv({ nowS = 1_800_000_000, mcap = 1_000_000_000n, owner = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", creator, quoteMint = WSOL_MINT, baseMint = MINT } = {}) {
  let t = nowS * 1000;
  let height = 500n;
  const store = new MemoryStore();
  const pool = { exists: true, owner, isDbcPool: owner === "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", baseMint, creator, quoteMint, isMigrated: false, mcapLamports: mcap };
  const txs = new Map(); // sig -> {signers, blockTime, failed}
  const statuses = new Map();
  const notes = new Map(); // sig -> {amount, rows}
  const outbound = []; // {signature, kind, amount}
  let builds = 0;
  const dbc = {
    fail: false,
    async snapshot() {
      if (dbc.fail) throw new Error("rpc down");
      return { ...pool };
    },
  };
  const chain = {
    async txSignedBy(s, who) {
      const x = txs.get(s);
      if (!x) return { found: false, signed: false };
      if (x.failed) return { found: true, signed: false, failed: true, blockTime: x.blockTime };
      return { found: true, signed: x.signers.includes(who), failed: false, blockTime: x.blockTime };
    },
    async signatureStatus(s) {
      return statuses.get(s) ?? "unknown";
    },
    async getBlockHeight() {
      return height;
    },
    serializeUnsigned(tx) {
      return { txBase64: getBase64EncodedWireTransaction(tx), lastValidBlockHeight: BigInt(tx.lifetimeConstraint.lastValidBlockHeight) };
    },
  };
  const rings = {
    bal: 0n,
    async receivedInTx(_id, s) {
      return notes.get(s) ?? { amount: 0n, rows: 0 };
    },
    async outboundInTx(_id, s) {
      return outbound.filter((o) => o.signature === s);
    },
    async outboundAll() {
      return [...outbound];
    },
    async balance() {
      return rings.bal;
    },
    async buildPayout({ feePayer, lamports }) {
      builds++;
      return compiled(feePayer, `payout:${lamports}`);
    },
    async buildWithdraw({ feePayer, recipient, lamports }) {
      builds++;
      return compiled(feePayer, `withdraw:${recipient}:${lamports}`);
    },
  };
  const identities = {
    async get(m) {
      return { market: m };
    },
    async publicInfo(m) {
      return { market: m, shieldedAddressHex: "ab".repeat(99), shieldedAddressBase64: "", ownerSolanaAddress: m };
    },
  };
  const env = {
    store,
    dbc,
    chain,
    rings,
    identities,
    pool,
    now: () => t,
    nowS: () => Math.floor(t / 1000),
    setNowS: (s) => (t = s * 1000),
    advance: (s) => (t += s * 1000),
    setHeight: (h) => (height = BigInt(h)),
    builds: () => builds,
    /** A bettor's private Rings deposit landing on-chain. */
    deposit(s, from, amount, blockTime) {
      txs.set(s, { signers: [from], blockTime: blockTime ?? Math.floor(t / 1000), failed: false });
      notes.set(s, { amount: BigInt(amount), rows: 1 });
      rings.bal += BigInt(amount);
    },
    /** A claim / sweep tx landing with its market-wallet effect. */
    land(s, signer, effect) {
      statuses.set(s, effect?.failed ? "failed" : "confirmed");
      txs.set(s, { signers: [signer], blockTime: Math.floor(t / 1000), failed: !!effect?.failed });
      if (effect?.outbound) {
        outbound.push({ signature: s, ...effect.outbound });
        rings.bal -= BigInt(effect.outbound.amount);
      }
    },
  };
  return env;
}
