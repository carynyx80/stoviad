// Entry point: load config from env, wire dependencies, start HTTP API + settlement loop.
import { MarketIdentities, parseMasterSeed } from "./keys.js";
import { createStore } from "./store.js";
import { loadIdl } from "./idl.js";
import { Chain, PROGRAM_ID } from "./chain.js";
import { DbcReader, DBC_PROGRAM_ID } from "./dbc.js";
import { createRings, heliusMainnetRpc } from "./rings.js";
import { SettlementWorker } from "./worker.js";
import { ActionManager, COMPANY_WALLET } from "./actions.js";
import { AdminAuth } from "./admin.js";
import { buildServer } from "./server.js";

const env = process.env;
const config = {
  port: Number(env.PORT || 8080),
  host: env.HOST || "0.0.0.0",
  databaseUrl: env.DATABASE_URL || "",
  heliusApiKey: env.HELIUS_API_KEY || "",
  rpcUrl: env.SOLANA_RPC_URL || "",
  sendEnabled: env.RESOLVER_SEND_ENABLED === "true",
  workerIntervalMs: Number(env.WORKER_INTERVAL_MS || 30000),
  corsOrigin: env.CORS_ORIGIN || "*",
  companyWallet: env.COMPANY_WALLET || COMPANY_WALLET,
  programId: env.STOVIA_PROGRAM_ID || PROGRAM_ID,
  maxTxVersion: Number(env.RPC_MAX_TX_VERSION ?? 1),
  dbcProgramId: env.DBC_PROGRAM_ID || DBC_PROGRAM_ID,
  logLevel: env.LOG_LEVEL || "info",
};

async function main() {
  const identities = new MarketIdentities(parseMasterSeed(env.RESOLVER_MASTER_SEED));
  delete process.env.RESOLVER_MASTER_SEED;

  const store = createStore(config.databaseUrl);
  await store.init();

  const rpcUrl = config.rpcUrl || (config.heliusApiKey ? heliusMainnetRpc(config.heliusApiKey) : "");
  let chain = null;
  let rings = null;
  let dbc = null;
  if (rpcUrl) {
    chain = new Chain({ rpcUrl, idl: loadIdl(), programId: config.programId, maxTxVersion: config.maxTxVersion });
    dbc = new DbcReader({ chain, programId: config.dbcProgramId });
    rings = await createRings({ rpcUrl });
  }

  const adminAuth = new AdminAuth({ adminPubkey: config.companyWallet });
  // Admin queue (treasury sweeps only). RESOLVER_SEND_ENABLED gates creating its actions, nothing else.
  const actions = chain && rings ? new ActionManager({ store, chain, rings, identities, companyWallet: config.companyWallet }) : null;
  const worker = chain && rings
    ? new SettlementWorker({ store, dbc, chain, rings, identities, actions, sendEnabled: config.sendEnabled, log: console })
    : null;

  const app = buildServer({ store, identities, chain, rings, dbc, actions, worker, adminAuth, config });
  if (worker) worker.d.log = app.log;
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ sendEnabled: config.sendEnabled, store: config.databaseUrl ? "postgres" : "memory", rpc: !!rpcUrl, companyWallet: config.companyWallet }, "resolver up");

  let timer = null;
  if (worker) {
    const loop = async () => {
      await worker.tickAll().catch((e) => app.log.error({ err: e.message }, "worker loop"));
      timer = setTimeout(loop, config.workerIntervalMs);
    };
    timer = setTimeout(loop, 2000);
  }

  const shutdown = async () => {
    clearTimeout(timer);
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error("fatal:", e.message); // message only: never dump env or key material
  process.exit(1);
});
