// HTTP API (Fastify). Never returns or logs secrets; request bodies (salts, amounts) are not logged.
import Fastify from "fastify";
import { ShieldedAddress } from "@heliuslabs/spr";
import { address } from "@solana/kit";
import { claimStake, parseClaim, registerPayoutAddress, verifyWalletSignature, resultsAccessMessage, HttpError } from "./claims.js";
import { buildPayoutTree, payoutProof, bytesToHex } from "./crypto.js";
import { parseActionSubmit } from "./actions.js";

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
    companyWallet: config.companyWallet, // fee payer / Config.resolver; resolver never holds its key
    ringsReady: !!deps.rings,
  }));

  app.get("/markets/:market/shielded-address", async (req) => {
    const market = pk(req.params.market, "market");
    const info = await identities.publicInfo(market);
    // Only track real Stovia market accounts (sweep even if nobody claims); arbitrary
    // addresses get their deterministic address but never enter the worker's queue.
    let tracked = false;
    if (deps.chain) {
      try {
        if (await deps.chain.getMarket(market)) {
          await store.insertIfAbsent("tracked", market, { since: Date.now() });
          tracked = true;
        }
      } catch { /* not a Stovia market (or program not deployed yet) */ }
    }
    return { ...info, tracked };
  });

  app.post("/stakes/claim", async (req, reply) => {
    if (!deps.rings || !deps.chain) throw new HttpError(503, "not_configured", "HELIUS_API_KEY not configured");
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

  // Public: totals and root are posted on-chain anyway. Individual payouts are NOT listed here.
  app.get("/markets/:market/results", async (req) => {
    const market = pk(req.params.market, "market");
    const st = await store.get("market", market);
    if (!st) return { market, state: "open" };
    const post = await store.get("action", `post_results:${market}`);
    return json({
      market,
      state: st.state,
      survived: st.survived,
      yesTotal: st.yesTotal,
      noTotal: st.noTotal,
      payoutRoot: st.rootHex,
      payoutCount: st.payoutCount,
      postSignature: post?.signature ?? null,
      postConfirmed: post?.status === "confirmed",
      haltReason: st.haltReason,
    });
  });

  // Bettor-only: own payout amount + Merkle proof. Auth: Ed25519 signature over resultsAccessMessage.
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
    const send = await store.get("action", `payout:${market}:${bettor}`);
    return json({
      market,
      bettor,
      payout: mine.amount,
      refund: mine.refund,
      status: mine.status,
      signature: send?.signature ?? null,
      payoutRoot: st.rootHex,
      proof: payoutProof(tree, bettor).map(bytesToHex),
    });
  });

  return app;
}
