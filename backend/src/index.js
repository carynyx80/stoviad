import pino from 'pino';
import { loadConfig, VERSION } from './config.js';
import { createStore } from './store/index.js';
import { buildServer } from './server.js';

const log = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'stovia-api', version: VERSION } });

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  log.fatal(err.message);
  process.exit(1);
}

const redactedRpc = cfg.rpcUrl.replace(/(api[-_]?key=)[^&]+/i, '$1***');
log.info({ network: cfg.network, programId: cfg.programId, rpc: redactedRpc, rpcIsDefault: cfg.rpcIsDefault, db: cfg.databaseUrl ? 'postgres' : 'memory', webhookSecret: !!cfg.webhookSecret, cors: cfg.corsOrigins }, 'starting');
if (!cfg.webhookSecret) log.warn('HELIUS_WEBHOOK_SECRET not set: /webhooks/helius will reject all requests');

const store = await createStore(cfg, log);
const app = await buildServer({ cfg, store, logger: log });

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  const force = setTimeout(() => { log.error('forced exit after 10s'); process.exit(1); }, 10_000);
  force.unref();
  try {
    await app.close();
    await store.close();
    log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error({ err: err.message }, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => log.error({ err: String(err?.message || err) }, 'unhandledRejection'));

try {
  await app.listen({ port: cfg.port, host: cfg.host });
} catch (err) {
  log.fatal({ err: err.message }, 'failed to listen');
  process.exit(1);
}
