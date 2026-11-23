// Admin actions: every Solana-signed step is an UNSIGNED transaction (fee payer = company wallet)
// that the company wallet signs and broadcasts in the browser. The resolver never holds a Solana key.
//
// Action doc (store kind "action", id = actionId):
//   { id, kind: "post_results"|"payout"|"sweep", market, bettor?, amount?, status, attempts,
//     signature?, submittedAt?, lastBuiltValidHeight? }
//   status: pending → submitted → confirmed   (submitted → pending again if failed / expired unlanded)
//
// Double-signing is safe by construction: every rebuild of an action spends the same thing
// (post_sealed_results is init-once; a Rings payout/withdraw spends the same input UTXO nullifiers
// while the market wallet has not changed), so at most one variant can land.
import { hexToBytes } from "./crypto.js";

export const COMPANY_WALLET = "3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm";
export const MAX_ATTEMPTS = 5;
const SUBMIT_TIMEOUT_MS = 3 * 60 * 1000; // a fresh blockhash is valid ~60-90 s; then treat as unlanded

export const actionId = (kind, market, bettor) => (bettor ? `${kind}:${market}:${bettor}` : `${kind}:${market}`);

export class ActionManager {
  /** deps: { store, chain, rings, identities, companyWallet, now? } */
  constructor(deps) {
    this.d = { companyWallet: COMPANY_WALLET, now: () => Date.now(), ...deps };
  }

  async ensure(kind, market, extra = {}) {
    const id = actionId(kind, market, extra.bettor);
    await this.d.store.insertIfAbsent("action", id, { id, kind, market, ...extra, status: "pending", attempts: 0, createdAt: new Date().toISOString() });
    return this.d.store.get("action", id);
  }

  async get(id) {
    return this.d.store.get("action", id);
  }

  /** Build a fresh unsigned tx for an action. Returns { txBase64, lastValidBlockHeight, summary, amount }. */
  async build(action) {
    const { chain, rings, identities, store, companyWallet } = this.d;
    if (action.kind === "post_results") {
      const st = await store.get("market", action.market);
      const r = await chain.buildPostSealedResultsUnsigned({
        feePayer: companyWallet,
        market: action.market,
        yesTotal: st.yesTotal,
        noTotal: st.noTotal,
        payoutRoot: hexToBytes(st.rootHex, 32),
      });
      return { ...r, amount: null, summary: `post_sealed_results for market ${action.market}: yes_total=${st.yesTotal} no_total=${st.noTotal} root=${st.rootHex}` };
    }
    const identity = await identities.get(action.market);
    if (action.kind === "payout") {
      const pa = await store.get("payout_addr", action.bettor);
      const recipient = pa ? hexToBytes(pa.shieldedAddressHex) : action.bettor;
      const tx = await rings.buildPayout({ identity, feePayer: companyWallet, recipient, lamports: action.amount });
      return {
        ...unsigned(chain, tx),
        amount: action.amount,
        summary: `Private payout of ${action.amount} lamports from market ${action.market} identity to ${pa ? "registered shielded address of" : "registry address of"} ${action.bettor}`,
      };
    }
    if (action.kind === "sweep") {
      const bal = await rings.balance(identity);
      if (bal === 0n) return null;
      const tx = await rings.buildWithdraw({ identity, feePayer: companyWallet, recipient: companyWallet, lamports: bal });
      return { ...unsigned(chain, tx), amount: bal, summary: `Withdraw remaining ${bal} lamports (unrevealed/unclaimed stakes + dust) from market ${action.market} to the company wallet (public)` };
    }
    throw new Error(`unknown action kind ${action.kind}`);
  }

  /** Pending actions with freshly built txs (blockhash current at GET time). */
  async listPending() {
    const out = [];
    for (const { doc } of await this.d.store.list("action")) {
      if (doc.status !== "pending") continue;
      let built;
      try {
        built = await this.build(doc);
      } catch (e) {
        out.push({ ...view(doc), error: `build failed: ${e.message}` });
        continue;
      }
      if (!built) continue;
      await this.d.store.put("action", doc.id, { ...doc, lastBuiltValidHeight: built.lastValidBlockHeight ?? null, lastBuiltAt: new Date().toISOString() });
      out.push({ ...view(doc), amount: built.amount ?? doc.amount ?? null, summary: built.summary, transaction: built.txBase64, lastValidBlockHeight: built.lastValidBlockHeight ?? null });
    }
    return out;
  }

  /** Record a broadcast signature, then check it right away. */
  async submit(id, signature) {
    const a = await this.get(id);
    if (!a) return { error: "unknown_action" };
    if (a.status === "confirmed") return { status: "confirmed", idempotent: true };
    if (a.status === "stuck") return { error: "action_stuck" };
    if (a.status === "submitted" && a.signature === signature) return { status: await this.check(id) };
    await this.d.store.put("action", id, { ...a, status: "submitted", signature, submittedAt: this.d.now(), attempts: a.attempts + 1 });
    return { status: await this.check(id) };
  }

  /**
   * Verify a submitted action on-chain. Returns 'confirmed' | 'submitted' | 'pending' | 'stuck'.
   * Confirmed requires: tx succeeded, signed by the company wallet, and an action-specific effect.
   */
  async check(id) {
    const { store, chain, rings, identities, companyWallet } = this.d;
    const a = await this.get(id);
    if (!a || a.status !== "submitted") return a?.status ?? "missing";
    const status = await chain.signatureStatus(a.signature);
    let ok = false;
    let reason = status;
    if (status === "confirmed") {
      const info = await chain.txSignedBy(a.signature, companyWallet);
      if (!info.signed) reason = "not_signed_by_company_wallet";
      else if (a.kind === "post_results") {
        const posted = await chain.getSealedResults(a.market);
        const st = await store.get("market", a.market);
        ok = !!posted && (!posted.payoutRootHex || posted.payoutRootHex === st.rootHex);
        if (!ok) reason = "sealed_results_missing_or_root_mismatch";
      } else {
        const identity = await identities.get(a.market);
        const rows = await rings.outboundInTx(identity, a.signature);
        const want = a.kind === "payout" ? "privateTransfer" : "publicWithdrawal";
        ok = rows.some((r) => r.kind === want && (a.kind !== "payout" || r.amount === BigInt(a.amount)));
        if (!ok) reason = "market_wallet_effect_not_found";
      }
    }
    if (ok) {
      await store.put("action", id, { ...a, status: "confirmed", confirmedAt: new Date().toISOString() });
      return "confirmed";
    }
    const stillWaiting = status === "unknown" && this.d.now() - a.submittedAt < SUBMIT_TIMEOUT_MS;
    if (stillWaiting) return "submitted";
    // failed, wrong tx, or expired without landing: reopen (rebuild on next GET)
    const next = a.attempts >= MAX_ATTEMPTS ? "stuck" : "pending";
    await store.put("action", id, { ...a, status: next, signature: null, lastError: reason });
    return next;
  }
}

function unsigned(chain, compiledTx) {
  return chain.serializeUnsigned(compiledTx);
}

const view = (d) => ({ id: d.id, kind: d.kind, market: d.market, bettor: d.bettor ?? null, status: d.status, attempts: d.attempts, lastError: d.lastError ?? null });

export const parseActionSubmit = (body) => {
  const id = String(body?.actionId ?? "");
  const sig = String(body?.signature ?? "");
  if (!id || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return null;
  return { id, signature: sig };
};

