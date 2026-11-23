/**
 * Public resolver client for markets, sealed bets, stakes, claims, portfolio, creators, stats.
 * Markets live off-chain in the resolver (there is no Stovia program). Every write is
 * authorized by a wallet signMessage signature produced by the caller.
 */

export const RESOLVER_URL = (process.env.NEXT_PUBLIC_RESOLVER_URL || "https://stovia-resolver-production.up.railway.app").replace(/\/+$/, "");

export type MarketStatus = "open" | "revealing" | "survived" | "died";

export type MarketTotals = {
  survivePool?: bigint;
  diePool?: bigint;
  forfeited?: bigint;
  winners?: number;
  raw: Record<string, unknown>;
};

export type ResolverMarket = {
  market: string;
  mint: string;
  name: string;
  symbol: string;
  uri?: string;
  image?: string;
  creator?: string;
  targetMcapLamports: bigint | null;
  currentMcapLamports: bigint | null;
  twapMcapLamports: bigint | null;
  /** ms epoch */
  deadline: number | null;
  /** ms epoch */
  revealEnds: number | null;
  status: MarketStatus | string;
  commitments: number | null;
  revealed: number | null;
  totals?: MarketTotals;
};

export type Stats = { tokens?: number; liveMarkets?: number; survived?: number; died?: number; volumeLamports?: bigint | null; bets?: number };

export type CreatorRow = {
  wallet: string;
  name?: string;
  launches?: number;
  survived?: number;
  died?: number;
  open?: number;
  reputation?: number;
};

export type PortfolioBet = {
  market: string;
  status?: string;
  committed?: boolean;
  staked?: boolean;
  revealed?: boolean;
  side?: number;
  won?: boolean;
  claimable?: boolean;
  claimed?: boolean;
  payoutLamports?: bigint | null;
  stakeLamports?: bigint | null;
};
export type Portfolio = { bets: PortfolioBet[]; launches: string[]; raw: unknown };

export class ResolverError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "ResolverError";
  }
}

/* ---------------- low-level ---------------- */

async function call<T>(path: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${RESOLVER_URL}${path}`, { ...init, headers, cache: "no-store", signal: ctrl.signal });
  } catch {
    throw new ResolverError("The Stovia resolver isn't reachable right now.");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = text.slice(0, 240);
    let code: string | undefined;
    try {
      const j = JSON.parse(text) as { error?: string; message?: string; code?: string };
      code = j.code ?? (typeof j.error === "string" && /^[a-z_]+$/.test(j.error) ? j.error : undefined);
      msg = j.message ?? j.error ?? msg;
    } catch {
      /* not json */
    }
    throw new ResolverError(msg || res.statusText || `HTTP ${res.status}`, res.status, code);
  }
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new ResolverError("The resolver returned an unreadable response.");
  }
}

const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });

/* ---------------- normalizers ---------------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Obj, ...k: string[]) => {
  for (const key of k) {
    const v = o[key];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
};
const num = (o: Obj, ...k: string[]) => {
  for (const key of k) {
    const v = o[key];
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return undefined;
};
const bool = (o: Obj, ...k: string[]) => {
  for (const key of k) if (typeof o[key] === "boolean") return o[key] as boolean;
  return undefined;
};
export function toBig(v: unknown): bigint | null {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  } catch {
    /* fallthrough */
  }
  return null;
}
const big = (o: Obj, ...k: string[]) => {
  for (const key of k) {
    const b = toBig(o[key]);
    if (b !== null) return b;
  }
  return null;
};
/** seconds or ms or ISO -> ms */
function ts(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) {
    if (/^\d+$/.test(v)) return ts(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

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

function toMarket(o: Obj): ResolverMarket | null {
  const market = str(o, "market", "marketId", "id");
  const mint = str(o, "mint") ?? market;
  if (!market || !mint) return null;
  const totalsRaw = isObj(o.totals) ? o.totals : null;
  return {
    market,
    mint,
    name: str(o, "name") ?? "Unnamed token",
    symbol: (str(o, "symbol", "ticker") ?? "").toUpperCase(),
    uri: str(o, "uri"),
    image: str(o, "image", "imageUrl"),
    creator: str(o, "creator"),
    targetMcapLamports: big(o, "targetMcapLamports", "targetMcap"),
    currentMcapLamports: big(o, "currentMcapLamports", "mcapLamports"),
    twapMcapLamports: big(o, "twapMcapLamports"),
    deadline: ts(o.deadlineTs ?? o.deadline),
    revealEnds: ts(o.revealEndsTs ?? o.revealEnds),
    status: (str(o, "status") ?? "open").toLowerCase(),
    commitments: num(o, "commitments", "commitmentCount") ?? null,
    revealed: num(o, "revealed", "revealedCount") ?? null,
    totals: totalsRaw
      ? {
          survivePool: big(totalsRaw, "survive", "survivePool", "surviveLamports", "yes") ?? undefined,
          diePool: big(totalsRaw, "die", "diePool", "dieLamports", "no") ?? undefined,
          forfeited: big(totalsRaw, "forfeited", "unrevealed", "forfeitedLamports") ?? undefined,
          winners: num(totalsRaw, "winners", "winnerCount"),
          raw: totalsRaw,
        }
      : undefined,
  };
}

/* ---------------- reads ---------------- */

export async function getMarkets(): Promise<ResolverMarket[]> {
  const r = await call<unknown>("/markets");
  return listOf(r, "markets").map(toMarket).filter((m): m is ResolverMarket => !!m);
}

export async function getMarket(market: string): Promise<ResolverMarket> {
  const r = await call<unknown>(`/markets/${encodeURIComponent(market)}`);
  const o = isObj(r) && isObj(r.market) ? { ...r, ...(r.market as Obj) } : r;
  const m = isObj(o) ? toMarket(o) : null;
  if (!m) throw new ResolverError("Market not found.", 404);
  return m;
}

export async function getMarketShieldedAddress(market: string): Promise<string> {
  const r = await call<Obj>(`/markets/${encodeURIComponent(market)}/shielded-address`);
  const hex = isObj(r) ? str(r, "shieldedAddress", "shieldedAddressHex") : undefined;
  if (!hex || !/^(0x)?[0-9a-fA-F]+$/.test(hex)) throw new ResolverError("The resolver returned no market shielded address.");
  return hex;
}

export async function getStats(): Promise<Stats> {
  const r = await call<unknown>("/stats");
  const o = isObj(r) ? (isObj(r.data) ? (r.data as Obj) : r) : {};
  return {
    tokens: num(o, "tokens", "launches", "totalTokens", "markets"),
    liveMarkets: num(o, "liveMarkets", "open", "live"),
    survived: num(o, "survived"),
    died: num(o, "died", "dead"),
    bets: num(o, "bets", "commitments"),
    volumeLamports: big(o, "volumeLamports", "stakedLamports"),
  };
}

export async function getCreators(): Promise<CreatorRow[]> {
  const r = await call<unknown>("/creators");
  return listOf(r, "creators")
    .map((o): CreatorRow | null => {
      const wallet = str(o, "creator", "wallet", "address", "id");
      if (!wallet) return null;
      return {
        wallet,
        name: str(o, "name", "handle"),
        launches: num(o, "launches", "markets", "tokens"),
        survived: num(o, "survived"),
        died: num(o, "died", "dead"),
        open: num(o, "open", "live"),
        reputation: num(o, "reputation", "score", "rep"),
      };
    })
    .filter((c): c is CreatorRow => !!c);
}

export async function getPortfolio(wallet: string): Promise<Portfolio> {
  const r = await call<unknown>(`/portfolio/${encodeURIComponent(wallet)}`);
  const bets = listOf(r, "bets", "positions")
    .map((o): PortfolioBet | null => {
      const market = str(o, "market", "marketId");
      if (!market) return null;
      return {
        market,
        status: str(o, "status", "marketStatus"),
        committed: bool(o, "committed"),
        staked: bool(o, "staked", "stakeClaimed"),
        revealed: bool(o, "revealed"),
        side: num(o, "side"),
        won: bool(o, "won", "winner"),
        claimable: bool(o, "claimable", "canClaim"),
        claimed: bool(o, "claimed", "paid"),
        payoutLamports: big(o, "payoutLamports", "payout"),
        stakeLamports: big(o, "stakeLamports", "amount", "stake"),
      };
    })
    .filter((b): b is PortfolioBet => !!b);
  const launches = isObj(r)
    ? listOf(r, "launches", "created").map((o) => str(o, "market", "mint") ?? "").filter(Boolean)
    : [];
  return { bets, launches, raw: r };
}

/* ---------------- writes ---------------- */

export function commitBet(body: { market: string; bettor: string; commitment: string; stakeCommitment: string; signature: string }) {
  return post<unknown>("/bets/commit", body);
}

/** Retries 425 (Rings tx not indexed yet) with backoff, ~2 minutes total. */
export async function claimStake(
  body: { market: string; bettor: string; amount: string; salt2: string; ringsTxSignature: string },
  onWait?: (attempt: number) => void,
): Promise<unknown> {
  let delay = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await post<unknown>("/stakes/claim", body);
    } catch (e) {
      const err = e as ResolverError;
      if (err?.status !== 425 || attempt >= 12) throw e;
      onWait?.(attempt);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(15_000, Math.round(delay * 1.5));
    }
  }
}

export function revealBet(body: { market: string; bettor: string; side: number; salt: string; signature: string }) {
  return post<unknown>("/bets/reveal", body);
}

export async function buildClaim(body: { market: string; bettor: string; signature: string }): Promise<{ tx: string; lastValidBlockHeight?: number }> {
  const r = await post<Obj>("/claims/build", body);
  const tx = isObj(r) ? str(r, "tx", "transaction") : undefined;
  if (!tx) throw new ResolverError("The resolver returned no claim transaction.");
  return { tx, lastValidBlockHeight: num(r, "lastValidBlockHeight") };
}

export function claimSubmitted(body: { market: string; bettor: string; signature: string }) {
  return post<unknown>("/claims/submitted", body);
}

/* ---------------- helpers ---------------- */

export const LAMPORTS = 1_000_000_000;
export const lamportsToSol = (l: bigint | null | undefined): number | null => (l == null ? null : Number(l) / LAMPORTS);

/** Phase from status + clock (the resolver's status is authoritative when present). */
export function marketPhase(m: ResolverMarket, now: number | null): "open" | "revealing" | "settling" | "survived" | "died" {
  if (m.status === "survived" || m.status === "died") return m.status;
  if (m.status === "revealing") return now != null && m.revealEnds != null && now >= m.revealEnds ? "settling" : "revealing";
  if (now != null && m.deadline != null && now >= m.deadline) return now != null && m.revealEnds != null && now >= m.revealEnds ? "settling" : "revealing";
  return "open";
}

/** Winning side once settled: 1 survives, 2 dies. */
export const winningSide = (status: string): 1 | 2 | null => (status === "survived" ? 1 : status === "died" ? 2 : null);
