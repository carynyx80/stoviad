// Solana RPC access. Read-only: the resolver builds UNSIGNED transactions and never signs or sends.
// Uses plain JSON-RPC over fetch so the API key stays in one place.
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  compileTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { anchorDiscriminator, decodeAccount, encodeArg } from "./idl.js";
import { pubkeyBytes, pubkeyFromBytes } from "./crypto.js";

export const PROGRAM_ID = "6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8";
const enc = new TextEncoder();

export class Chain {
  constructor({ rpcUrl, idl, programId = PROGRAM_ID, maxTxVersion = 1 }) {
    this.rpcUrl = rpcUrl;
    this.idl = idl;
    this.programId = address(programId);
    this.maxTxVersion = maxTxVersion;
    this._id = 0;
  }

  async rpc(method, params) {
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this._id, method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`RPC ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }

  async getAccountData(addr) {
    const r = await this.rpc("getAccountInfo", [addr, { encoding: "base64", commitment: "confirmed" }]);
    if (!r?.value) return null;
    if (r.value.owner !== this.programId) throw new Error(`account ${addr} not owned by the Stovia program`);
    return new Uint8Array(Buffer.from(r.value.data[0], "base64"));
  }

  async pda(seeds) {
    const [pda] = await getProgramDerivedAddress({ programAddress: this.programId, seeds });
    return pda;
  }

  /** ASSUMPTION (mirrors Bet): SealedBet PDA = ["sealed_bet", market, bettor]. Override seed via SEALED_BET_SEED. */
  sealedBetAddress(market, bettor) {
    const seed = process.env.SEALED_BET_SEED || "sealed_bet";
    return this.pda([enc.encode(seed), pubkeyBytes(market), pubkeyBytes(bettor)]);
  }

  async getMarket(market) {
    const data = await this.getAccountData(market);
    if (!data) return null;
    const m = decodeAccount(this.idl, "Market", data);
    if (!m) throw new Error("IDL has no Market account");
    return { ...m, settled: m.status !== "Open", survived: m.status === "Survived" };
  }

  async getSealedBet(market, bettor) {
    const addr = await this.sealedBetAddress(market, bettor);
    const data = await this.getAccountData(addr);
    if (!data) return null;
    return { address: addr, ...decodeSealedBet(this.idl, data) };
  }

  /** On-chain SealedResults (PDA ["sealed_results", market]) or null if not posted yet. */
  async getSealedResults(market) {
    const addr = await this.pda([enc.encode("sealed_results"), pubkeyBytes(market)]);
    const data = await this.getAccountData(addr);
    if (!data) return null;
    const r = decodeAccount(this.idl, "SealedResults", data);
    return r ? { ...r, payoutRootHex: Buffer.from(r.payout_root).toString("hex") } : { raw: true };
  }

  /**
   * True if `bettor` signed transaction `signature` (the sender of a default-ring transfer is public).
   * SPR builders compile v1 transactions (verified live: getTransaction needs maxSupportedTransactionVersion 1),
   * so decode the wire bytes with @solana/kit, whose `signatures` map is keyed by signer address.
   */
  async txSignedBy(signature, bettor) {
    const tx = await this.rpc("getTransaction", [
      signature,
      { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: this.maxTxVersion },
    ]);
    if (!tx) return { found: false, signed: false };
    if (tx.meta?.err) return { found: true, signed: false, failed: true };
    const decoded = getTransactionDecoder().decode(Buffer.from(tx.transaction[0], "base64"));
    return { found: true, signed: Object.prototype.hasOwnProperty.call(decoded.signatures, bettor), failed: false };
  }

  async getBlockHeight() {
    return BigInt(await this.rpc("getBlockHeight", [{ commitment: "confirmed" }]));
  }

  /** 'confirmed' | 'failed' | 'unknown' */
  async signatureStatus(signature) {
    const r = await this.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const s = r?.value?.[0];
    if (!s) return "unknown";
    if (s.err) return "failed";
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "unknown";
  }

  /**
   * Serialize an UNSIGNED compiled transaction (empty signature slots) to base64 wire format for the
   * company wallet to sign in the browser. The resolver holds no Solana keys and never signs.
   */
  serializeUnsigned(compiledTx) {
    const lv = compiledTx.lifetimeConstraint?.lastValidBlockHeight;
    return { txBase64: getBase64EncodedWireTransaction(compiledTx), lastValidBlockHeight: lv !== undefined ? BigInt(lv) : null };
  }

  /** Unsigned post_sealed_results; fee payer + resolver signer = company wallet (must equal Config.resolver). */
  async buildPostSealedResultsUnsigned({ feePayer, market, yesTotal, noTotal, payoutRoot }) {
    const ix = await this.postSealedResultsIx({ resolver: feePayer, market, yesTotal, noTotal, payoutRoot });
    const { value: bh } = await this.rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const lifetime = { blockhash: bh.blockhash, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) };
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstruction(ix, m),
    );
    return this.serializeUnsigned(compileTransaction(msg));
  }

  async postSealedResultsIx({ resolver, market, yesTotal, noTotal, payoutRoot }) {
    const def = this.idl?.instructions?.find((i) => i.name === "post_sealed_results");
    const values = { yes_total: yesTotal, no_total: noTotal, payout_root: payoutRoot, market };
    if (def) {
      const accounts = [];
      for (const a of def.accounts) {
        let addr;
        if (a.address) addr = a.address;
        else if (a.signer) addr = resolver;
        else if (a.name === "market") addr = market;
        else if (a.pda && a.pda.seeds.every((s) => s.kind === "const" || (s.kind === "account" && s.path === "market"))) {
          addr = await this.pda(a.pda.seeds.map((s) => (s.kind === "const" ? Uint8Array.from(s.value) : pubkeyBytes(market))));
        }
        else throw new Error(`post_sealed_results: cannot resolve account ${a.name}; extend chain.js`);
        const role = a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY;
        accounts.push({ address: address(addr), role });
      }
      const parts = [Uint8Array.from(def.discriminator ?? anchorDiscriminator("global", def.name))];
      for (const arg of def.args) {
        if (!(arg.name in values)) throw new Error(`post_sealed_results: unknown arg ${arg.name}`);
        parts.push(encodeArg(arg.type, values[arg.name]));
      }
      return { programAddress: this.programId, accounts, data: Buffer.concat(parts) };
    }
    // FALLBACK ASSUMPTION (IDL not yet regenerated): accounts [resolver (w,s), config PDA ["config"], market (w)],
    // args (yes_total u64, no_total u64, payout_root [u8;32]).
    const config = await this.pda([enc.encode("config")]);
    return {
      programAddress: this.programId,
      accounts: [
        { address: address(resolver), role: AccountRole.WRITABLE_SIGNER },
        { address: config, role: AccountRole.READONLY },
        { address: address(market), role: AccountRole.WRITABLE },
      ],
      data: Buffer.concat([
        anchorDiscriminator("global", "post_sealed_results"),
        encodeArg("u64", yesTotal),
        encodeArg("u64", noTotal),
        encodeArg({ array: ["u8", 32] }, payoutRoot),
      ]),
    };
  }
}

/**
 * SealedBet decoding. Prefers the IDL. FALLBACK LAYOUT ASSUMPTION (until the program IDL ships SealedBet):
 *   [0..8)   discriminator sha256("account:SealedBet")[..8]
 *   [8..40)  market: Pubkey        [40..72)  bettor: Pubkey
 *   [72..104) commitment: [u8;32]  [104..136) stake_commitment: [u8;32]
 *   [136] side: u8 (0 = unrevealed, 1 = SURVIVE, 2 = DIE)   [137] revealed: bool
 *   (then committed_at: i64, bump: u8 — not read). The current IDL (copied 2026-11-23) defines SealedBet,
 *   so this fallback only matters if the IDL file is missing.
 */
export function decodeSealedBet(idl, data) {
  const viaIdl = decodeAccount(idl, "SealedBet", data);
  if (viaIdl) {
    return {
      market: viaIdl.market,
      bettor: viaIdl.bettor,
      stakeCommitment: Uint8Array.from(viaIdl.stake_commitment),
      side: Number(viaIdl.side ?? 0),
      revealed: Boolean(viaIdl.revealed),
    };
  }
  const b = Buffer.from(data);
  if (b.length < 139) throw new Error("SealedBet account too short for fallback layout");
  if (!b.subarray(0, 8).equals(Buffer.from(anchorDiscriminator("account", "SealedBet")))) throw new Error("SealedBet: discriminator mismatch");
  return {
    market: pubkeyFromBytes(b.subarray(8, 40)),
    bettor: pubkeyFromBytes(b.subarray(40, 72)),
    stakeCommitment: new Uint8Array(b.subarray(104, 136)),
    side: b[136],
    revealed: b[137] !== 0,
  };
}
