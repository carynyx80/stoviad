import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { VERSION, publicConfig } from './config.js';
import { buildViews } from './views.js';
import { normalise, decodeLogs } from './helius.js';

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))]);

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

const isPubkey = (s) => { try { new PublicKey(s); return true; } catch { return false; } };
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function buildServer({ cfg, store, logger }) {
  const app = Fastify({
    ...(logger ? { loggerInstance: logger } : { logger: { level: cfg.logLevel } }),
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
  });

  // ---- CORS
  const allowed = new Set(cfg.corsOrigins);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / server-to-server
      let ok = allowed.has(origin.replace(/\/$/, ''));
      if (!ok) { try { const u = new URL(origin); ok = u.protocol === 'https:' && u.hostname.endsWith('.vercel.app'); } catch { ok = false; } }
      cb(null, ok);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // ---- light rate limiting (webhook exempt: Helius bursts)
  await app.register(rateLimit, {
    max: cfg.rateLimitMax,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/webhooks/') || req.url === '/health',
  });

  // ---- chain
  const connection = new Connection(cfg.rpcUrl, { commitment: 'confirmed' });
  let deployedCache = { value: false, at: 0, error: null };
  let deployedInflight = null;
  async function programDeployed() {
    if (Date.now() - deployedCache.at < 60_000) return deployedCache.value;
    if (!deployedInflight) {
      deployedInflight = withTimeout(connection.getAccountInfo(new PublicKey(cfg.programId)), 5_000)
        .then((info) => { deployedCache = { value: !!info?.executable, at: Date.now(), error: null }; })
        .catch((err) => {
          app.log.warn({ err: err.message }, 'programDeployed check failed');
          deployedCache = { value: deployedCache.value, at: Date.now(), error: err.message };
        })
        .finally(() => { deployedInflight = null; });
    }
    await deployedInflight;
    return deployedCache.value;
  }

  // ---- views cache (invalidated on new webhook data)
  let viewsCache = null;
  async function views() {
    if (viewsCache && Date.now() - viewsCache.at < 5_000) return viewsCache.v;
    const v = buildViews(await store.snapshot());
    viewsCache = { v, at: Date.now() };
    return v;
  }
  const page = (arr, q) => {
    const { limit, offset } = ListQuery.parse(q ?? {});
    return { items: arr.slice(offset, offset + limit), total: arr.length, limit, offset };
  };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'bad_request', issues: err.issues });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code || 'error', message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'not_found' }));

  // ---- routes
  app.get('/', async () => ({ name: 'stovia-api', version: VERSION, network: cfg.network, docs: '/config' }));

  app.get('/health', async () => ({
    ok: true,
    network: cfg.network,
    programId: cfg.programId,
    programDeployed: await programDeployed(),
    db: store.kind,
    version: VERSION,
    uptimeSec: Math.round(process.uptime()),
  }));

  app.get('/config', async () => publicConfig(cfg));

  app.get('/tokens', async (req) => page((await views()).tokens, req.query));
  app.get('/tokens/:mint', async (req, reply) => {
    const { mint } = req.params;
    if (!isPubkey(mint)) return reply.code(400).send({ error: 'invalid_mint' });
    const t = (await views()).token(mint);
    return t ?? reply.code(404).send({ error: 'token_not_found' });
  });

  app.get('/markets', async (req) => {
    const status = typeof req.query?.status === 'string' ? req.query.status : null;
    const all = (await views()).markets;
    return page(status ? all.filter((m) => m.status === status) : all, req.query);
  });
  app.get('/markets/:id', async (req, reply) => {
    const { id } = req.params;
    if (!isPubkey(id)) return reply.code(400).send({ error: 'invalid_market_id' });
    const m = (await views()).market(id);
    return m ?? reply.code(404).send({ error: 'market_not_found' });
  });

  app.get('/stats', async () => ({ ...(await views()).stats, indexer: await store.counts() }));

  app.get('/creators', async (req) => page((await views()).creators, req.query));
  app.get('/creators/:address', async (req, reply) => {
    const { address } = req.params;
    if (!isPubkey(address)) return reply.code(400).send({ error: 'invalid_address' });
    const c = (await views()).creator(address);
    return c ?? reply.code(404).send({ error: 'creator_not_found' });
  });

  // ---- Helius webhook
  app.post('/webhooks/helius', { config: { rateLimit: false } }, async (req, reply) => {
    if (!cfg.webhookSecret) {
      req.log.warn('webhook rejected: HELIUS_WEBHOOK_SECRET not configured');
      return reply.code(503).send({ error: 'webhook_not_configured' });
    }
    if (!safeEqual(req.headers.authorization, cfg.webhookSecret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body;
    const txs = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : null;
    if (!txs) return reply.code(400).send({ error: 'expected_json_array' });

    const result = { received: txs.length, relevant: 0, inserted: 0, duplicates: 0, events: 0, decoded: 0, skipped: 0, errors: 0 };
    for (const raw of txs) {
      const tx = normalise(raw, cfg.programId);
      if (!tx || !tx.touchesProgram) { result.skipped++; continue; }
      result.relevant++;
      try {
        let logs = tx.logs;
        // Enhanced payloads have no logs: fetch them (best effort) so we can decode events.
        if (!logs && !tx.failed) {
          try {
            const full = await withTimeout(connection.getTransaction(tx.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }), 6_000);
            logs = full?.meta?.logMessages ?? null;
            if (full?.slot && !tx.slot) tx.slot = full.slot;
            if (full?.blockTime && !tx.timestamp) tx.timestamp = full.blockTime;
          } catch (err) {
            req.log.warn({ sig: tx.signature, err: err.message }, 'could not fetch logs; storing raw only');
          }
        }
        const events = tx.failed || !logs ? [] : decodeLogs(logs, cfg.programId);
        const { inserted } = await store.recordTransaction({ ...tx, events });
        if (inserted) {
          result.inserted++;
          result.events += events.length;
          result.decoded += events.filter((e) => e.decoded).length;
          req.log.info({ sig: tx.signature, events: events.map((e) => e.name || 'unknown') }, 'indexed transaction');
        } else result.duplicates++;
      } catch (err) {
        result.errors++;
        req.log.error({ sig: tx.signature, err: err.message }, 'failed to index transaction');
      }
    }
    if (result.inserted) viewsCache = null;
    // 200 even on partial errors would make Helius drop data; return 500 so it retries (idempotent).
    return reply.code(result.errors ? 500 : 200).send(result);
  });

  return app;
}
