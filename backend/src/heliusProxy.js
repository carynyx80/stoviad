// Helius proxy: keeps HELIUS_API_KEY on the server while browsers talk to
//   POST /rpc            -> Solana JSON-RPC (method allowlist, batch support)
//   GET|POST /v1/spr/*   -> Privacy Rings indexer + TEE prover (as @heliuslabs/spr requests them)
//
// The SPR prover encrypts request bodies to the attested enclave and binds the
// route (minus any `api-key` query pair) as AAD, so a path-preserving proxy that
// injects the key is exactly what the SDK is designed for. We never log the
// upstream URL (it contains the key).

const UPSTREAM_ORIGIN = 'https://mainnet.helius-rpc.com';

// Privacy Rings programs whose accounts the SDK scans with getProgramAccounts.
const SPR_PROGRAMS = new Set([
  'ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW', // shielded pool program
  'regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ', // user registry
]);

export const RPC_METHODS = new Set([
  // reads
  'getAccountInfo', 'getBalance', 'getBlockHeight', 'getBlockTime', 'getEpochInfo', 'getFeeForMessage',
  'getGenesisHash', 'getHealth', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getMultipleAccounts', 'getRecentPrioritizationFees', 'getSignatureStatuses', 'getSignaturesForAddress',
  'getSlot', 'getTokenAccountBalance', 'getTokenAccountsByOwner', 'getTransaction', 'getVersion',
  'isBlockhashValid',
  // writes / dry runs
  'sendTransaction', 'simulateTransaction',
  // restricted: only for SPR programs (see allowCall)
  'getProgramAccounts',
]);

const MAX_BATCH = 25;
const RPC_BODY_LIMIT = 256 * 1024;
const SPR_BODY_LIMIT = 4 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 12 * 1024 * 1024; // SDK accepts indexer bodies up to 10 MiB
const RPC_TIMEOUT_MS = 25_000;
const SPR_TIMEOUT_MS = 30_000;
const PROVE_TIMEOUT_MS = 120_000; // synchronous proving can take a while

const SPR_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,3}$/;
const SPR_REQ_HEADERS = ['content-type', 'accept', 'spr-tee', 'spr-tee-enc', 'spr-tee-ciphertext'];
const SPR_RES_HEADERS = ['content-type', 'spr-tee', 'retry-after', 'cache-control'];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function allowCall(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call) || typeof call.method !== 'string') {
    return { code: -32600, message: 'Invalid request' };
  }
  if (!RPC_METHODS.has(call.method)) return { code: -32601, message: `Method not allowed: ${call.method}` };
  if (call.method === 'getProgramAccounts') {
    const program = Array.isArray(call.params) ? call.params[0] : undefined;
    if (!SPR_PROGRAMS.has(program)) return { code: -32601, message: 'getProgramAccounts is limited to Privacy Rings programs' };
  }
  return null;
}

/** Fetch upstream with a deadline and a response size cap. Never throws with the URL in the message. */
async function upstream(url, init, timeoutMs) {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_UPSTREAM_BYTES) {
    await res.body?.cancel();
    const err = new Error('upstream response too large');
    err.code = 'too_large';
    throw err;
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_UPSTREAM_BYTES) {
    const err = new Error('upstream response too large');
    err.code = 'too_large';
    throw err;
  }
  return { res, body };
}

function failure(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { status: 504, error: 'upstream_timeout' };
  if (err?.code === 'too_large') return { status: 502, error: 'upstream_too_large' };
  return { status: 502, error: 'upstream_unavailable' };
}

export async function heliusProxy(app, { cfg }) {
  const apiKey = cfg.heliusApiKey;
  const keyQs = apiKey ? `api-key=${encodeURIComponent(apiKey)}` : '';

  // Raw bodies: we forward bytes unchanged (keeps big integers and encrypted TEE payloads intact).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  // ---------------------------------------------------------------- /rpc
  app.post('/rpc', {
    bodyLimit: RPC_BODY_LIMIT,
    config: { rateLimit: { max: cfg.proxyRpcRateMax, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    if (!apiKey) return reply.code(503).send(rpcError(null, -32000, 'RPC proxy not configured'));
    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? ''));
    } catch {
      return reply.code(400).send(rpcError(null, -32700, 'Parse error'));
    }
    const batch = Array.isArray(payload);
    const calls = batch ? payload : [payload];
    if (calls.length === 0) return reply.code(400).send(rpcError(null, -32600, 'Empty batch'));
    if (calls.length > MAX_BATCH) return reply.code(400).send(rpcError(null, -32600, `Batch too large (max ${MAX_BATCH})`));
    const denied = calls.map(allowCall);
    if (denied.some(Boolean)) {
      const errors = calls.map((c, i) => rpcError(c?.id, denied[i]?.code ?? -32600, denied[i]?.message ?? 'Batch rejected: contains a disallowed method'));
      return reply.code(batch ? 200 : 403).send(batch ? errors : errors[0]);
    }
    try {
      const { res, body } = await upstream(`${UPSTREAM_ORIGIN}/?${keyQs}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: req.body,
      }, RPC_TIMEOUT_MS);
      return reply.code(res.status).header('content-type', res.headers.get('content-type') || 'application/json').send(body);
    } catch (err) {
      const f = failure(err);
      req.log.warn({ err: err?.name, kind: f.error }, 'rpc proxy upstream failure');
      return reply.code(f.status).send(rpcError(batch ? null : calls[0]?.id, -32003, f.error));
    }
  });

  // ---------------------------------------------------------------- /v1/spr/*
  const spr = async (req, reply) => {
    if (!apiKey) return reply.code(503).send({ error: 'spr_proxy_not_configured' });
    const sub = req.params['*'] ?? '';
    if (!SPR_PATH.test(sub)) return reply.code(404).send({ error: 'not_found' });

    // Keep the caller's query (e.g. attestation `nonce`) minus any api-key, then add ours.
    const qIndex = req.url.indexOf('?');
    const kept = qIndex === -1 ? [] : req.url.slice(qIndex + 1).split('&')
      .filter((p) => p !== '' && !new URLSearchParams(`?${p}`).has('api-key'));
    const target = `${UPSTREAM_ORIGIN}/v1/spr/${sub}?${[...kept, keyQs].join('&')}`;

    const headers = {};
    for (const h of SPR_REQ_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    const hasBody = req.method === 'POST' && req.body !== undefined && req.body !== null;
    try {
      const { res, body } = await upstream(target, {
        method: req.method,
        headers,
        ...(hasBody ? { body: req.body } : {}),
      }, /(^|\/)prove$/.test(sub) ? PROVE_TIMEOUT_MS : SPR_TIMEOUT_MS);
      reply.code(res.status);
      for (const h of SPR_RES_HEADERS) {
        const v = res.headers.get(h);
        if (v !== null) reply.header(h, v);
      }
      return reply.send(body);
    } catch (err) {
      const f = failure(err);
      req.log.warn({ err: err?.name, kind: f.error, path: sub }, 'spr proxy upstream failure');
      return reply.code(f.status).send({ error: f.error });
    }
  };
  const sprOpts = {
    bodyLimit: SPR_BODY_LIMIT,
    config: { rateLimit: { max: cfg.proxySprRateMax, timeWindow: '1 minute' } },
  };
  app.get('/v1/spr/*', sprOpts, spr);
  app.post('/v1/spr/*', sprOpts, spr);
}
