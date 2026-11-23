// Settlement worker: a persisted state machine per market. Every step is idempotent and safe to
// re-run after a crash at any point. The resolver NEVER signs Solana transactions: each signed step
// is an admin action (unsigned tx, fee payer = company wallet) signed in the browser.
//
//   (none) ─settled─► computing ─► computed ─[ACTIONS]─► awaiting_post_signature ─► paying ─► sweeping ─► done
//                                                                         (or halted, for manual review)
// - computing/computed: claims frozen; pools, payouts and Merkle root stored.
//   With RESOLVER_SEND_ENABLED=false (default) no admin actions are created (dry run stops at computed).
// - awaiting_post_signature: one `post_results` action; advances when SealedResults is on-chain with our root.
// - paying: one `payout` action per winner, exposed ONE AT A TIME per market (the market wallet does not
//   reserve UTXOs across unconfirmed txs, so parallel spends would collide).
// - sweeping: one `sweep` action withdrawing the remainder to the company wallet.
import { computeSettlement } from "./payouts.js";
import { bytesToHex } from "./crypto.js";
import { COMPANY_WALLET } from "./actions.js";

export const TREASURY = COMPANY_WALLET;

export class SettlementWorker {
  /** deps: { store, chain, rings, identities, actions: ActionManager, sendEnabled, log } */
  constructor(deps) {
    this.d = { log: console, ...deps };
    this.running = false;
  }

  async tickAll() {
    if (this.running) return;
    this.running = true;
    try {
      for (const { id: market } of await this.d.store.list("tracked")) {
        try {
          await this.tick(market);
        } catch (e) {
          this.d.log.error({ market, err: e.message }, "settlement tick failed");
        }
      }
    } finally {
      this.running = false;
    }
  }

  async setState(market, patch) {
    const cur = (await this.d.store.get("market", market)) ?? {};
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await this.d.store.put("market", market, next);
    return next;
  }

  /** Drive a submitted action forward; returns its status. */
  async actionStatus(a) {
    if (a.status === "submitted") return this.d.actions.check(a.id);
    return a.status;
  }

  async tick(market) {
    const { store, chain, rings, identities, actions, sendEnabled } = this.d;
    let st = await store.get("market", market);
    if (st?.state === "done" || st?.state === "halted") return st;

    if (!st || st.state === "computing") {
      const m = await chain.getMarket(market);
      if (!m || !m.settled) return st;
      st = await this.setState(market, { state: "computing", survived: m.survived });
      st = await this.compute(market, m.survived);
    }
    if (!sendEnabled) return st; // dry run stops at `computed`

    if (st.state === "computed") {
      const posted = await chain.getSealedResults(market);
      if (posted) {
        // Already on-chain (init-once). Accept only our root.
        if (posted.payoutRootHex && posted.payoutRootHex !== st.rootHex) {
          return this.setState(market, { state: "halted", haltReason: "on-chain payout root differs from computed root" });
        }
        st = await this.setState(market, { state: "paying" });
      } else {
        // Solvency check before committing to a payout root on-chain.
        const bal = await rings.balance(await identities.get(market));
        if (bal < BigInt(st.totalPaid)) return this.setState(market, { state: "halted", haltReason: "market identity balance below total payouts" });
        await actions.ensure("post_results", market);
        st = await this.setState(market, { state: "awaiting_post_signature" });
      }
    }

    if (st.state === "awaiting_post_signature") {
      const a = await actions.ensure("post_results", market);
      const s = await this.actionStatus(a);
      if (s === "stuck") return this.setState(market, { state: "halted", haltReason: "post_results action stuck" });
      if (s !== "confirmed") {
        // Signed outside the admin flow (or POST /admin/submitted never arrived)? Trust the account.
        const posted = await chain.getSealedResults(market);
        if (!posted || (posted.payoutRootHex && posted.payoutRootHex !== st.rootHex)) return st;
      }
      st = await this.setState(market, { state: "paying" });
    }

    if (st.state === "paying") {
      const r = await this.payNext(market);
      if (r === "stuck") return this.setState(market, { state: "halted", haltReason: "payout action stuck" });
      if (r !== "all_paid") return st;
      st = await this.setState(market, { state: "sweeping" });
    }

    if (st.state === "sweeping") {
      const existing = await actions.get(`sweep:${market}`);
      if (!existing) {
        const bal = await rings.balance(await identities.get(market));
        if (bal === 0n) return this.setState(market, { state: "done" });
      }
      const a = existing ?? (await actions.ensure("sweep", market));
      const s = await this.actionStatus(a);
      if (s === "stuck") return this.setState(market, { state: "halted", haltReason: "sweep action stuck" });
      if (s === "confirmed") st = await this.setState(market, { state: "done" });
    }
    return st;
  }

  /** Freeze results from verified claims + on-chain reveal state. Idempotent: rerun recomputes identically. */
  async compute(market, survived) {
    const { store, chain } = this.d;
    const stakes = [];
    for (const { doc } of await store.list("stake", `${market}:`)) {
      if (!doc.verified) continue;
      const bet = await chain.getSealedBet(market, doc.bettor);
      stakes.push({ bettor: doc.bettor, amount: doc.amount, verified: true, revealed: !!bet?.revealed, side: bet?.side ?? 0 });
    }
    const s = computeSettlement({ survived }, stakes);
    for (const p of s.payouts) {
      await store.insertIfAbsent("payout", `${market}:${p.bettor}`, { market, bettor: p.bettor, amount: p.amount, refund: p.refund, status: "pending" });
    }
    return this.setState(market, {
      state: "computed",
      survived,
      yesTotal: s.yesTotal,
      noTotal: s.noTotal,
      totalPaid: s.totalPaid,
      excludedVerified: s.excludedVerified,
      rootHex: bytesToHex(s.root),
      payoutCount: s.payouts.length,
      computedAt: new Date().toISOString(),
    });
  }

  /** Expose the next unpaid payout as an action; one at a time. */
  async payNext(market) {
    const { store, actions } = this.d;
    for (const { id, doc } of await store.list("payout", `${market}:`)) {
      if (doc.status === "confirmed") continue;
      const a = await actions.ensure("payout", market, { bettor: doc.bettor, amount: doc.amount });
      const s = await this.actionStatus(a);
      if (s === "confirmed") {
        await store.put("payout", id, { ...doc, status: "confirmed", actionId: a.id });
        continue;
      }
      return s; // pending / submitted / stuck
    }
    return "all_paid";
  }
}
