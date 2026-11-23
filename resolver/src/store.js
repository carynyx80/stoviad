// Tiny document store: (kind, id) -> JSON doc. Postgres when DATABASE_URL is set, else memory
// (memory loses claims on restart: fine for dev, NOT for production custody).
// Kinds: stake (id market:bettor), txsig (id signature, uniqueness guard), payout_addr (id bettor),
//        market (id market: settlement state machine), payout (id market:bettor), tracked (id market).
const BIG = "__big:";
const ser = (doc) => JSON.stringify(doc, (_k, v) => (typeof v === "bigint" ? BIG + v.toString() : v));
const de = (s) => JSON.parse(s, (_k, v) => (typeof v === "string" && v.startsWith(BIG) ? BigInt(v.slice(BIG.length)) : v));

export class MemoryStore {
  constructor() {
    this.m = new Map();
  }
  async init() {}
  async close() {}
  key = (k, id) => `${k}\u0000${id}`;
  async get(kind, id) {
    const v = this.m.get(this.key(kind, id));
    return v === undefined ? null : de(v);
  }
  async put(kind, id, doc) {
    this.m.set(this.key(kind, id), ser(doc));
  }
  async insertIfAbsent(kind, id, doc) {
    const k = this.key(kind, id);
    if (this.m.has(k)) return false;
    this.m.set(k, ser(doc));
    return true;
  }
  async del(kind, id) {
    this.m.delete(this.key(kind, id));
  }
  async list(kind, idPrefix = "") {
    const pre = this.key(kind, idPrefix);
    const out = [];
    for (const [k, v] of this.m) if (k.startsWith(pre)) out.push({ id: k.slice(kind.length + 1), doc: de(v) });
    return out.sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}

export class PgStore {
  constructor(url) {
    this.url = url;
  }
  async init() {
    const { default: pg } = await import("pg");
    this.pool = new pg.Pool({
      connectionString: this.url,
      ssl: /sslmode=require/.test(this.url) ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS resolver_docs (
      kind text NOT NULL, id text NOT NULL, doc jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, id))`);
  }
  async close() {
    await this.pool?.end();
  }
  async get(kind, id) {
    const r = await this.pool.query("SELECT doc::text AS d FROM resolver_docs WHERE kind=$1 AND id=$2", [kind, id]);
    return r.rows[0] ? de(r.rows[0].d) : null;
  }
  async put(kind, id, doc) {
    await this.pool.query(
      `INSERT INTO resolver_docs(kind,id,doc) VALUES($1,$2,$3::jsonb)
       ON CONFLICT (kind,id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()`,
      [kind, id, ser(doc)],
    );
  }
  async insertIfAbsent(kind, id, doc) {
    const r = await this.pool.query("INSERT INTO resolver_docs(kind,id,doc) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING", [kind, id, ser(doc)]);
    return r.rowCount === 1;
  }
  async del(kind, id) {
    await this.pool.query("DELETE FROM resolver_docs WHERE kind=$1 AND id=$2", [kind, id]);
  }
  async list(kind, idPrefix = "") {
    const r = await this.pool.query(
      "SELECT id, doc::text AS d FROM resolver_docs WHERE kind=$1 AND starts_with(id, $2) ORDER BY id",
      [kind, idPrefix],
    );
    return r.rows.map((row) => ({ id: row.id, doc: de(row.d) }));
  }
}

export const createStore = (url) => (url ? new PgStore(url) : new MemoryStore());
