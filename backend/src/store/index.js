// Storage: Postgres when DATABASE_URL is set, otherwise in-memory.
// Both expose the same interface:
//   init(), close(), kind
//   recordTransaction(tx) -> { inserted }   (idempotent on signature)
//   snapshot() -> { launches, trades, bets, settlements, claims }
//   counts() -> { transactions, events, undecoded }
import pg from 'pg';
import { marketPda } from '../anchor.js';

// Typed tables and the event names that feed them.
const TYPED = {
  LaunchCreated: 'launches',
  Trade: 'trades',
  BetCommitted: 'bets',
  BetRevealed: 'bets',
  MarketSettled: 'settlements',
  Claimed: 'claims',
};

/** Convert a decoded event into a typed row (shared by both stores). */
export function toTypedRow(tx, ev, programId) {
  const d = ev.data;
  const ts = d.timestamp || tx.timestamp || Math.floor(Date.now() / 1000);
  const base = { signature: tx.signature, idx: ev.idx, slot: tx.slot ?? null, ts };
  switch (ev.name) {
    case 'LaunchCreated':
      return {
        ...base, launch: d.launch, mint: d.mint, creator: d.creator, market: marketPda(d.launch, programId),
        name: d.name, symbol: d.symbol, uri: d.uri, bond_lamports: d.bondLamports, target_mcap: d.targetMcapLamports,
        deadline: d.deadlineTs || null, reveal_end: d.revealEndTs || null,
      };
    case 'Trade':
      return {
        ...base, launch: d.launch, mint: d.mint, trader: d.trader, is_buy: !!d.isBuy, sol_amount: d.solAmount,
        token_amount: d.tokenAmount, mcap_lamports: d.mcapLamports,
      };
    case 'BetCommitted':
      return { ...base, kind: 'commit', market: d.market, bettor: d.bettor, commitment: d.commitment, side: null, amount: d.amount };
    case 'BetRevealed':
      return { ...base, kind: 'reveal', market: d.market, bettor: d.bettor, commitment: null, side: d.side, amount: d.amount };
    case 'MarketSettled':
      return {
        ...base, market: d.market, launch: d.launch, survived: !!d.survived, twap_mcap: d.twapMcap, target_mcap: d.targetMcap,
        yes_pool: d.yesPool, no_pool: d.noPool, bonus_pool: d.bonusPool, unrevealed: d.unrevealed,
      };
    case 'Claimed':
      return { ...base, market: d.market, launch: d.launch, claimant: d.recipient, kind: d.kind, amount: d.amount };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- memory
export class MemoryStore {
  kind = 'memory';
  constructor(programId) {
    this.programId = programId;
    this.txs = new Map();
    this.events = [];
    this.tables = { launches: [], trades: [], bets: [], settlements: [], claims: [] };
  }
  async init() {}
  async close() {}
  async recordTransaction(tx) {
    if (this.txs.has(tx.signature)) return { inserted: false };
    this.txs.set(tx.signature, { signature: tx.signature, slot: tx.slot, timestamp: tx.timestamp, payload: tx.payload, receivedAt: Date.now() });
    for (const ev of tx.events) {
      this.events.push({ signature: tx.signature, idx: ev.idx, name: ev.name, decoded: ev.decoded, data: ev.data, raw: ev.raw });
      if (ev.decoded && TYPED[ev.name]) {
        const row = toTypedRow(tx, ev, this.programId);
        if (row) this.tables[TYPED[ev.name]].push(row);
      }
    }
    // Bound memory: keep the newest 50k raw payloads.
    if (this.txs.size > 50_000) this.txs.delete(this.txs.keys().next().value);
    return { inserted: true };
  }
  async snapshot() {
    const t = this.tables;
    return { launches: [...t.launches], trades: [...t.trades], bets: [...t.bets], settlements: [...t.settlements], claims: [...t.claims] };
  }
  async counts() {
    return { transactions: this.txs.size, events: this.events.length, undecoded: this.events.filter((e) => !e.decoded).length };
  }
}

// ---------------------------------------------------------------- postgres
const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_transactions (
  signature TEXT PRIMARY KEY,
  slot BIGINT,
  block_time BIGINT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  signature TEXT NOT NULL REFERENCES raw_transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  name TEXT,
  decoded BOOLEAN NOT NULL DEFAULT false,
  data JSONB,
  raw TEXT NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE TABLE IF NOT EXISTS launches (
  signature TEXT NOT NULL, idx INT NOT NULL, slot BIGINT, ts BIGINT NOT NULL,
  launch TEXT NOT NULL, mint TEXT NOT NULL, creator TEXT NOT NULL, market TEXT, name TEXT, symbol TEXT, uri TEXT,
  bond_lamports NUMERIC, target_mcap NUMERIC, deadline BIGINT, reveal_end BIGINT,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS launches_mint_idx ON launches(mint);
CREATE INDEX IF NOT EXISTS launches_creator_idx ON launches(creator);
CREATE TABLE IF NOT EXISTS trades (
  signature TEXT NOT NULL, idx INT NOT NULL, slot BIGINT, ts BIGINT NOT NULL,
  launch TEXT, mint TEXT NOT NULL, trader TEXT NOT NULL, is_buy BOOLEAN NOT NULL, sol_amount NUMERIC NOT NULL, token_amount NUMERIC NOT NULL, mcap_lamports NUMERIC,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS trades_mint_idx ON trades(mint);
CREATE TABLE IF NOT EXISTS bets (
  signature TEXT NOT NULL, idx INT NOT NULL, slot BIGINT, ts BIGINT NOT NULL,
  kind TEXT NOT NULL, market TEXT NOT NULL, bettor TEXT NOT NULL, commitment TEXT, side SMALLINT, amount NUMERIC NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS bets_market_idx ON bets(market);
CREATE TABLE IF NOT EXISTS settlements (
  signature TEXT NOT NULL, idx INT NOT NULL, slot BIGINT, ts BIGINT NOT NULL,
  market TEXT NOT NULL, launch TEXT, survived BOOLEAN NOT NULL, twap_mcap NUMERIC, target_mcap NUMERIC,
  yes_pool NUMERIC, no_pool NUMERIC, bonus_pool NUMERIC, unrevealed NUMERIC,
  PRIMARY KEY (signature, idx)
);
CREATE TABLE IF NOT EXISTS claims (
  signature TEXT NOT NULL, idx INT NOT NULL, slot BIGINT, ts BIGINT NOT NULL,
  market TEXT NOT NULL, launch TEXT, claimant TEXT NOT NULL, kind TEXT, amount NUMERIC NOT NULL,
  PRIMARY KEY (signature, idx)
);
`;

const SNAPSHOT_LIMIT = 20_000;

export class PostgresStore {
  kind = 'postgres';
  constructor(url, log, programId) {
    this.programId = programId;
    const ssl = /sslmode=disable/.test(url) || /localhost|127\.0\.0\.1|\.railway\.internal/.test(url) ? false : { rejectUnauthorized: false };
    this.pool = new pg.Pool({ connectionString: url, ssl, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    this.pool.on('error', (err) => log?.error({ err }, 'pg pool error'));
  }
  async init() { await this.pool.query(SCHEMA); }
  async close() { await this.pool.end(); }

  async recordTransaction(tx) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        'INSERT INTO raw_transactions(signature, slot, block_time, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (signature) DO NOTHING',
        [tx.signature, tx.slot ?? null, tx.timestamp ?? null, JSON.stringify(tx.payload)],
      );
      if (ins.rowCount === 0) { await client.query('ROLLBACK'); return { inserted: false }; }
      for (const ev of tx.events) {
        await client.query(
          'INSERT INTO events(signature, idx, name, decoded, data, raw) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [tx.signature, ev.idx, ev.name, ev.decoded, ev.data ? JSON.stringify(ev.data) : null, ev.raw],
        );
        const table = ev.decoded ? TYPED[ev.name] : null;
        const row = table ? toTypedRow(tx, ev, this.programId) : null;
        if (row) {
          const cols = Object.keys(row);
          await client.query(
            `INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
            cols.map((c) => row[c]),
          );
        }
      }
      await client.query('COMMIT');
      return { inserted: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async snapshot() {
    const q = (t) => this.pool.query(`SELECT * FROM ${t} ORDER BY ts DESC LIMIT ${SNAPSHOT_LIMIT}`).then((r) => r.rows.map(normRow));
    const [launches, trades, bets, settlements, claims] = await Promise.all(['launches', 'trades', 'bets', 'settlements', 'claims'].map(q));
    return { launches, trades, bets, settlements, claims };
  }

  async counts() {
    const r = await this.pool.query(`SELECT
      (SELECT count(*) FROM raw_transactions)::int AS transactions,
      (SELECT count(*) FROM events)::int AS events,
      (SELECT count(*) FROM events WHERE NOT decoded)::int AS undecoded`);
    return r.rows[0];
  }
}

// pg returns BIGINT/NUMERIC as strings; normalise numeric-ish columns used as numbers.
function normRow(r) {
  const out = { ...r };
  for (const k of ['ts', 'slot', 'deadline', 'reveal_end', 'idx', 'side']) if (out[k] != null) out[k] = Number(out[k]);
  for (const k of ['sol_amount', 'token_amount', 'amount', 'mcap_lamports', 'bond_lamports', 'target_mcap', 'twap_mcap', 'yes_pool', 'no_pool', 'bonus_pool', 'unrevealed']) if (out[k] != null) out[k] = String(out[k]);
  return out;
}

export async function createStore(cfg, log) {
  if (!cfg.databaseUrl) {
    log.info('DATABASE_URL not set; using in-memory store (data is lost on restart)');
    return new MemoryStore(cfg.programId);
  }
  const store = new PostgresStore(cfg.databaseUrl, log, cfg.programId);
  try {
    await store.init();
    log.info('postgres store ready (tables ensured)');
    return store;
  } catch (err) {
    log.error({ err: err.message }, 'postgres init failed; falling back to in-memory store');
    await store.close().catch(() => {});
    return new MemoryStore(cfg.programId);
  }
}
