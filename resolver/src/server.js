// HTTP API (Fastify). Never returns or logs secrets; request bodies (salts, amounts) are not logged.
import Fastify from "fastify";
import { ShieldedAddress } from "@heliuslabs/spr";
import { address } from "@solana/kit";
import { claimStake, parseClaim, registerPayoutAddress, verifyWalletSignature, resultsAccessMessage, HttpError } from "./claims.js";
import { buildPayoutTree, payoutProof, bytesToHex } from "./crypto.js";
import { parseActionSubmit } from "./actions.js";
import { createLaunch, commitBet, revealBet, postBond, listMarkets, getMarketView, listCommitments, portfolio, creatorsLeaderboard, stats } from "./markets.js";
import { buildClaim, submitClaim } from "./payoutclaims.js";

export function buildServer(deps) {
  const { store, identities, config } = deps;
  const app = Fastify({
    logger: {
      level: config.logLevel ?? "info",
      redact: ["req.headers.authorization", "req.body", "body"],
      serializers: { req: (r) => ({ method: r.method, url: r.url.replace(/api-key=[^&]+/, "api-key=***") }) },
    },
    bodyLimit: 16 * 1024,
  });

  app.addHook("onSend", async (req, reply) => {
    const origin = config.corsOrigin ?? "*";
    reply.header("access-control-allow-origin", origin);
    reply.header("access-control-allow-headers", "content-type, x-admin-nonce, x-admin-signature");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  });
  app.options("/*", async (_req, reply) => reply.code(204).send());

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: "bad_request", message: err.message });
    req.log.error({ err: err.message }, "unhandled");
    return reply.code(500).send({ error: "internal", message: "internal error" });
  });

  const json = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const pk = (v, f) => {
    try {
      return address(String(v));
    } catch {
      throw new HttpError(400, "bad_request", `${f} is not a valid pubkey`);
    }
  };

  app.get("/health", async () => ({
    ok: true,
    service: "stovia-resolver",
    store: config.databaseUrl ? "postgres" : "memory",
    sendEnabled: !!config.sendEnabled,
    companyWallet: config.companyWallet, // treasury + admin-queue signer; resolver never holds its key
    ringsReady: !!deps.rings,
    dbcReady: !!deps.dbc,
  }));

  // ---------------------------------------------------------------------------
  // Survival markets (no on-chain program): launches, bets, bonds, claims, views
  // ---------------------------------------------------------------------------
  const needRings = () => {
    if (!deps.rings || !deps.chain) throw new HttpError(503, "not_configured", "HELIUS_API_KEY not configured");
  };

  app.post("/launches", async (req, reply) => {
    const r = await createLaunch(req.body, deps);
    return reply.code(r.idempotent ? 200 : 201).send(json(r));
  });
  app.post("/launches/:market/bond", async (req, reply) => {
    needRings();
    const r = await postBond(req.params.market, req.body, deps);
    return reply.code(r.idempotent ? 200 : 201).send(json(r));
  });
  app.get("/markets", async (req) => json({ markets: await listMarkets(deps, { status: req.query.status, creator: req.query.creator }) }));
  app.get("/markets/:market", async (req) => json(await getMarketView(req.params.market, deps)));
  app.get("/markets/:market/commitments", async (req) => json(await listCommitments(pk(req.params.market, "market"), deps)));
  app.post("/bets/commit", async (req, reply) => {
    const r = await commitBet(req.body, deps);
    return reply.code(r.idempotent ? 200 : 201).send(json(r));
  });
  app.post("/bets/reveal", async (req) => json(await revealBet(req.body, deps)));
  app.get("/portfolio/:wallet", async (req) => json(await portfolio(req.params.wallet, deps)));
  app.get("/creators", async () => json({ creators: await creatorsLeaderboard(deps) }));
  app.get("/stats", async () => json(await stats(deps)));
  app.post("/claims/build", async (req) => {
    needRings();
    return json(await buildClaim(req.body, { ...deps, ShieldedAddress }));
  });
  app.post("/claims/submitted", async (req, reply) => {
    needRings();
    const r = await submitClaim(req.body, deps);
    return reply.code(r.status === "paid" ? 200 : 202).send(json(r));
  });

  app.get("/markets/:market/shielded-address", async (req) => {
    const market = pk(req.params.market, "market");
    const info = await identities.publicInfo(market);
    // Markets are tracked from POST /launches; any address still gets its deterministic identity.
    return { ...info, tracked: !!(await store.get("market", market)) };
  });

  app.post("/stakes/claim", async (req, reply) => {
    needRings();
    const res = await claimStake(parseClaim(req.body), deps);
    return reply.code(res.idempotent ? 200 : 201).send(res);
  });

  app.post("/payout-address", async (req) => registerPayoutAddress(req.body, { store, ShieldedAddress }));

  // ---------------------------------------------------------------------------
  // Admin: company wallet signs every Solana tx in the browser. Auth = signed single-use nonce.
  // ---------------------------------------------------------------------------
  const requireAdmin = (req) => {
    if (!deps.adminAuth) throw new HttpError(503, "not_configured", "admin auth not configured");
    if (!deps.adminAuth.verify(req.headers["x-admin-nonce"], req.headers["x-admin-signature"])) {
      throw new HttpError(401, "admin_auth_failed", "x-admin-signature must be the company wallet's signature over stovia-admin:<nonce> (single-use, 5 min)");
    }
  };

  app.get("/admin/nonce", async () => {
    if (!deps.adminAuth) throw new HttpError(503, "not_configured", "admin auth not configured");
    return deps.adminAuth.issue();
  });

  // Pending actions with UNSIGNED txs (fee payer = company wallet), rebuilt on every call so the blockhash is fresh.
  app.get("/admin/pending", async (req) => {
    requireAdmin(req);
    if (!deps.actions) throw new HttpError(503, "not_configured", "HELIUS_API_KEY not configured");
    return json({ feePayer: config.companyWallet, actions: await deps.actions.listPending() });
  });

  app.post("/admin/submitted", async (req) => {
    requireAdmin(req);
    if (!deps.actions) throw new HttpError(503, "not_configured", "HELIUS_API_KEY not configured");
    const p = parseActionSubmit(req.body);
    if (!p) throw new HttpError(400, "bad_request", "body {actionId, signature(base58)} required");
    const r = await deps.actions.submit(p.id, p.signature);
    if (r.error === "unknown_action") throw new HttpError(404, r.error, "no such action");
    if (r.error) throw new HttpError(409, r.error, "action cannot accept submissions");
    // Kick the state machine for that market so the next action appears without waiting a full interval.
    if (r.status === "confirmed" && deps.worker) {
      const a = await deps.actions.get(p.id);
      await deps.worker.tick(a.market).catch(() => {});
    }
    return { actionId: p.id, ...r };
  });

  // Public settlement summary (totals are public after settlement). Individual payouts are NOT listed here.
  app.get("/markets/:market/results", async (req) => {
    const market = pk(req.params.market, "market");
    const st = await store.get("market", market);
    if (!st) throw new HttpError(404, "unknown_market", "no such market");
    return json({
      market,
      phase: st.phase,
      outcome: st.outcome ?? null,
      twapFinal: st.twapFinal ?? null,
      targetMcapLamports: st.targetMcapLamports,
      survivePool: st.yesTotal ?? null,
      diePool: st.noTotal ?? null,
      payoutRoot: st.rootHex ?? null,
      payoutCount: st.payoutCount ?? null,
      claimsCloseTs: st.claimsCloseTs ?? null,
      haltReason: st.haltReason ?? null,
    });
  });

  // Bettor-only: own payout amount + Merkle proof against the published payoutRoot.
  app.get("/markets/:market/payouts/:bettor", async (req) => {
    const market = pk(req.params.market, "market");
    const bettor = pk(req.params.bettor, "bettor");
    if (!(await verifyWalletSignature(bettor, resultsAccessMessage(market, bettor), req.query.signature))) {
      throw new HttpError(401, "bad_signature", "signature does not verify for bettor");
    }
    const st = await store.get("market", market);
    if (!st?.rootHex) throw new HttpError(404, "not_computed", "results not computed yet");
    const all = (await store.list("payout", `${market}:`)).map((r) => r.doc);
    const mine = all.find((p) => p.bettor === bettor);
    if (!mine) return { market, bettor, payout: "0", proof: [] };
    const tree = buildPayoutTree(all.map((p) => ({ bettor: p.bettor, amount: p.amount })));
    return json({
      market,
      bettor,
      payout: mine.amount,
      refund: mine.refund,
      bondRefund: mine.bondRefund ?? 0n,
      status: mine.status,
      signature: mine.paidSignature ?? null,
      payoutRoot: st.rootHex,
      proof: payoutProof(tree, bettor).map(bytesToHex),
    });
  });

  return app;
}
