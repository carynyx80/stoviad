// Market worker: a persisted state machine per market (store kind "market", id = DBC pool).
// Every step is idempotent and restart-safe. The resolver NEVER signs a Solana transaction.
//
//   open ──deadline──► revealing ──reveal end──► settled ──claims window end──► sweeping ──► done
//                                                                            (or halted, for manual review)
// - open: sample the DBC pool mcap every SAMPLE_INTERVAL_S and integrate the TWAP (twap.js). If the pool
//   migrated off the curve (is_migrated), sampling stops and the last value is held to the deadline:
//   DBC freezes sqrt_price at the migration price, so the held value is the price at graduation. Reading
//   the post-migration DAMM pool is not implemented (documented risk).
// - revealing: TWAP frozen at the deadline (twapFinal). Bettors reveal; stakes can still be registered
//   (their Rings transfer must have landed by the deadline).
// - settled: outcome = twapFinal >= target ? survived : died. Payouts from verified + revealed stakes
//   (+ bond, payouts.js). Winners claim with POST /claims/build (they pay the fee, no company signature).
// - sweeping (after CLAIMS_WINDOW_S): one admin-queue `sweep` action withdrawing everything left
//   (unrevealed / unverified stakes, unclaimed payouts, dust, forfeited bond) to the company wallet.
//   RESOLVER_SEND_ENABLED gates ONLY this admin-queue step; claims are always available.
import { computeSettlement, SIDE_DIE, SIDE_SURVIVE } from "./payouts.js";
import { bytesToHex } from "./crypto.js";
import { COMPANY_WALLET } from "./actions.js";
import { twapAccumulate, twapValue } from "./twap.js";
import { CLAIMS_WINDOW_S } from "./markets.js";
import { reconcileSlot } from "./payoutclaims.js";

export const TREASURY = COMPANY_WALLET;
export const SAMPLE_INTERVAL_S = 60;

export class SettlementWorker {
  /** deps: { store, dbc, chain, rings, identities, actions: ActionManager|null, sendEnabled, log, now?, sampleIntervalS?, claimsWindowS? } */
  constructor(deps) {
    this.d = { log: console, now: () => Date.now(), sampleIntervalS: SAMPLE_INTERVAL_S, claimsWindowS: CLAIMS_WINDOW_S, ...deps };
    this.running = false;
  }

  nowS() {
    return Math.floor(this.d.now() / 1000);
  }

  async tickAll() {
    if (this.running) return;
    this.running = true;
    try {
      for (const { id: market, doc } of await this.d.store.list("market")) {
        if (doc.phase === "done" || doc.phase === "halted") continue;
        try {
          await this.tick(market);
        } catch (e) {
          this.d.log.error({ market, err: e.message }, "market tick failed");
        }
      }
    } finally {
      this.running = false;
    }
  }

  async save(market, patch) {
    const cur = (await this.d.store.get("market", market)) ?? {};
    const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    await this.d.store.put("market", market, next);
    return next;
  }

  async tick(market) {
    let m = await this.d.store.get("market", market);
    if (!m || m.phase === "done" || m.phase === "halted") return m;
    const now = this.nowS();

    if (m.phase === "open") {
      if (now < m.deadlineTs) {
        if (now - m.lastSampleTs >= this.d.sampleIntervalS) m = await this.sample(m, now);
        return m;
      }
      // Deadline: one last reading if the previous one is stale is NOT taken (it would be post-deadline);
      // the last pre-deadline value is held to the deadline.
      const twap = twapAccumulate(m.twap, m.deadlineTs, null, m.deadlineTs);
      m = await this.save(market, { phase: "revealing", twap, twapFinal: twapValue(twap, m.deadlineTs, m.deadlineTs) });
    }

    if (m.phase === "revealing") {
      if (now < m.revealEndsTs) return m;
      m = await this.settle(m, now);
    }

    if (m.phase === "settled") {
      await reconcileSlot(market, this.d).catch((e) => this.d.log.warn({ market, err: e.message }, "claim slot reconcile failed"));
      if (now < m.claimsCloseTs) return m;
      if (await this.d.store.get("claimslot", market)) return m; // a claim tx may still land; wait for expiry
      for (const { id, doc } of await this.d.store.list("payout", `${market}:`)) {
        if (doc.status !== "paid") await this.d.store.put("payout", id, { ...doc, status: "forfeited" });
      }
      m = await this.save(market, { phase: "sweeping" });
    }

    if (m.phase === "sweeping") {
      const { actions, rings, identities, sendEnabled } = this.d;
      if (!sendEnabled || !actions) return m; // admin queue disabled: wait
      const existing = await actions.get(`sweep:${market}`);
      if (!existing) {
        const bal = await rings.balance(await identities.get(market));
        if (bal === 0n) return this.save(market, { phase: "done" });
      }
      const a = existing ?? (await actions.ensure("sweep", market));
      const s = a.status === "submitted" ? await actions.check(a.id) : a.status;
      if (s === "stuck") return this.save(market, { phase: "halted", haltReason: "sweep action stuck" });
      if (s === "confirmed") m = await this.save(market, { phase: "done" });
    }
    return m;
  }

  async sample(m, now) {
    if (m.migrated) {
      return this.save(m.market, { twap: twapAccumulate(m.twap, now, m.lastMcap, m.deadlineTs), lastSampleTs: now });
    }
    let snap;
    try {
      snap = await this.d.dbc.snapshot(m.pool);
    } catch (e) {
      this.d.log.warn({ market: m.market, err: e.message }, "mcap sample failed; holding last value");
      return m;
    }
    if (!snap?.isDbcPool) {
      this.d.log.warn({ market: m.market }, "pool no longer readable as a DBC pool; holding last value");
      return m;
    }
    const patch = { twap: twapAccumulate(m.twap, now, snap.mcapLamports, m.deadlineTs), lastMcap: snap.mcapLamports, lastSampleTs: now };
    if (snap.isMigrated) Object.assign(patch, { migrated: true, migratedTs: now });
    return this.save(m.market, patch);
  }

  /** Freeze results from verified stakes + revealed bets. Idempotent: payout docs are insert-once. */
  async settle(m, now) {
    const { store } = this.d;
    const survived = BigInt(m.twapFinal) >= BigInt(m.targetMcapLamports);
    const stakes = [];
    for (const { id, doc } of await store.list("stake", `${m.market}:`)) {
      if (!doc.verified) continue;
      const bet = await store.get("bet", id);
      const side = bet?.revealed ? bet.side : 0;
      stakes.push({ bettor: doc.bettor, amount: doc.amount, verified: true, revealed: side === SIDE_SURVIVE || side === SIDE_DIE, side });
    }
    const bond = await store.get("bond", m.market);
    const s = computeSettlement({ survived, bond: bond?.verified ? bond.amount : 0n, creator: m.creator }, stakes);
    for (const p of s.payouts) {
      await store.insertIfAbsent("payout", `${m.market}:${p.bettor}`, {
        market: m.market,
        bettor: p.bettor,
        amount: p.amount,
        stake: p.stake,
        bondRefund: p.bondRefund,
        refund: p.refund,
        status: "unpaid",
      });
    }
    return this.save(m.market, {
      phase: "settled",
      outcome: survived ? "survived" : "died",
      yesTotal: s.yesTotal,
      noTotal: s.noTotal,
      bond: s.bond,
      bondToWinners: s.bondToWinners,
      bondRefund: s.bondRefund,
      bondToTreasury: s.bondToTreasury,
      totalPaid: s.totalPaid,
      excludedVerified: s.excludedVerified,
      rootHex: bytesToHex(s.root),
      payoutCount: s.payouts.length,
      settledTs: now,
      claimsCloseTs: m.revealEndsTs + this.d.claimsWindowS,
    });
  }
}
