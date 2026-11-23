import { API_URL } from "./config";

/* ---------- Types (loose: backend shape may evolve) ---------- */
export type Token = {
  mint: string;
  name: string;
  ticker: string;
  image?: string;
  creator?: string;
  marketCapUsd?: number;
  targetMcapUsd?: number;
  bondSol?: number;
  deadline?: string | number;
  status?: "live" | "survived" | "died" | string;
};
export type Market = Token & {
  marketId: string;
  betCount?: number;
  /** Total pool may be public; per-side split stays sealed until reveal. */
  poolSol?: number;
};
export type Stats = {
  tokens?: number;
  liveMarkets?: number;
  survived?: number;
  died?: number;
  volumeSol?: number;
};
export type Creator = {
  wallet: string;
  name?: string;
  launches?: number;
  survived?: number;
  died?: number;
  reputation?: number;
  feesAccruedSol?: number;
  feesClaimedSol?: number;
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "unset" | "unreachable" | "bad-response" };

export const apiConfigured = () => API_URL.length > 0;

/** Never throws, never logs. */
async function get<T>(path: string, timeoutMs = 7000): Promise<ApiResult<T>> {
  if (!apiConfigured()) return { ok: false, reason: "unset" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}${path}`, { signal: ctrl.signal, headers: { accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return { ok: false, reason: "bad-response" };
    const json = (await res.json()) as T;
    return { ok: true, data: json };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Normalizers ---------- */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Obj, ...k: string[]) => { for (const key of k) { const v = o[key]; if (typeof v === "string" && v) return v; } return undefined; };
const num = (o: Obj, ...k: string[]) => { for (const key of k) { const v = o[key]; const n = typeof v === "string" ? Number(v) : v; if (typeof n === "number" && Number.isFinite(n)) return n; } return undefined; };

function listOf(json: unknown, ...keys: string[]): Obj[] {
  if (Array.isArray(json)) return json.filter(isObj);
  if (isObj(json)) {
    for (const k of [...keys, "data", "items", "results"]) {
      const v = json[k];
      if (Array.isArray(v)) return v.filter(isObj);
    }
  }
  return [];
}

function toToken(o: Obj): Token | null {
  const mint = str(o, "mint", "address", "id");
  const name = str(o, "name");
  if (!mint || !name) return null;
  return {
    mint,
    name,
    ticker: (str(o, "ticker", "symbol") ?? "").toUpperCase(),
    image: str(o, "image", "imageUrl", "image_url", "uri"),
    creator: str(o, "creator", "creatorWallet", "creator_wallet"),
    marketCapUsd: num(o, "marketCapUsd", "mcap", "market_cap", "marketCap"),
    targetMcapUsd: num(o, "targetMcapUsd", "targetMcap", "target_mcap", "target"),
    bondSol: num(o, "bondSol", "bond", "bond_sol"),
    deadline: (str(o, "deadline", "deadlineAt", "deadline_at") ?? num(o, "deadline", "deadlineTs", "deadline_ts")),
    status: str(o, "status", "state"),
  };
}

export async function getTokens(): Promise<ApiResult<Token[]>> {
  const r = await get<unknown>("/tokens");
  if (!r.ok) return r;
  return { ok: true, data: listOf(r.data, "tokens").map(toToken).filter((t): t is Token => !!t) };
}

export async function getMarkets(): Promise<ApiResult<Market[]>> {
  const r = await get<unknown>("/markets");
  if (!r.ok) return r;
  const data = listOf(r.data, "markets")
    .map((o) => {
      const t = toToken(isObj(o.token) ? { ...o, ...(o.token as Obj) } : o);
      if (!t) return null;
      return { ...t, marketId: str(o, "marketId", "market", "id") ?? t.mint, betCount: num(o, "betCount", "bets", "bet_count"), poolSol: num(o, "poolSol", "pool", "pool_sol") } as Market;
    })
    .filter((m): m is Market => !!m);
  return { ok: true, data };
}

export async function getStats(): Promise<ApiResult<Stats>> {
  const r = await get<unknown>("/stats");
  if (!r.ok) return r;
  const o = isObj(r.data) ? (isObj(r.data.data) ? (r.data.data as Obj) : r.data) : {};
  return {
    ok: true,
    data: {
      tokens: num(o, "tokens", "totalTokens", "tokenCount"),
      liveMarkets: num(o, "liveMarkets", "live", "markets"),
      survived: num(o, "survived"),
      died: num(o, "died", "dead"),
      volumeSol: num(o, "volumeSol", "volume", "volume_sol"),
    },
  };
}

export async function getCreators(): Promise<ApiResult<Creator[]>> {
  const r = await get<unknown>("/creators");
  if (!r.ok) return r;
  const data = listOf(r.data, "creators")
    .map((o): Creator | null => {
      const wallet = str(o, "wallet", "address", "creator", "id");
      if (!wallet) return null;
      return {
        wallet,
        name: str(o, "name", "handle"),
        launches: num(o, "launches", "tokens", "launchCount"),
        survived: num(o, "survived"),
        died: num(o, "died", "dead"),
        reputation: num(o, "reputation", "score", "rep"),
        feesAccruedSol: num(o, "feesAccruedSol", "feesAccrued", "unclaimed", "fees_accrued"),
        feesClaimedSol: num(o, "feesClaimedSol", "feesClaimed", "claimed", "fees_claimed"),
      };
    })
    .filter((c): c is Creator => !!c);
  return { ok: true, data };
}
