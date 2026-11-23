/**
 * Local bet receipts: the secrets (side, salt, amount, salt2) needed to reveal a sealed
 * bet and prove its stake. They are generated in the browser and never sent anywhere
 * until reveal / stake claim. Losing them = the bet can't be revealed (stake is forfeited).
 *
 * Stored in localStorage under `stovia:bet:v1:<wallet>:<market>` (every access wrapped in
 * try/catch: private mode, blocked storage). Users can download / import a JSON backup.
 */
import type { Side } from "./crypto";

export type Stage =
  | "draft" // secrets generated + saved, commitment not yet accepted by the resolver
  | "committed" // POST /bets/commit accepted
  | "staked" // private Rings transfer confirmed (ringsTxSignature set)
  | "claimed" // POST /stakes/claim accepted (bet fully placed)
  | "revealed" // POST /bets/reveal accepted
  | "paid"; // payout claim tx confirmed + reported

export const STAGE_ORDER: Stage[] = ["draft", "committed", "staked", "claimed", "revealed", "paid"];
export const atLeast = (s: Stage, min: Stage) => STAGE_ORDER.indexOf(s) >= STAGE_ORDER.indexOf(min);

export interface BetReceipt {
  v: 1;
  kind: "stovia-bet-receipt";
  wallet: string;
  market: string;
  mint?: string;
  symbol?: string;
  side: Side;
  /** hex, 32 bytes */
  salt: string;
  /** lamports, decimal string */
  amount: string;
  /** hex, 32 bytes */
  salt2: string;
  commitment: string;
  stakeCommitment: string;
  stage: Stage;
  ringsTxSignature?: string;
  claimTxSignature?: string;
  createdAt: string;
  updatedAt: string;
}

const PREFIX = "stovia:bet:v1:";
const key = (wallet: string, market: string) => `${PREFIX}${wallet}:${market}`;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const HEX32 = /^[0-9a-f]{64}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validateReceipt(x: unknown): BetReceipt | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Partial<BetReceipt>;
  if (r.kind !== "stovia-bet-receipt" || r.v !== 1) return null;
  if (typeof r.wallet !== "string" || !B58.test(r.wallet)) return null;
  if (typeof r.market !== "string" || !B58.test(r.market)) return null;
  if (r.side !== 1 && r.side !== 2) return null;
  if (typeof r.salt !== "string" || !HEX32.test(r.salt)) return null;
  if (typeof r.salt2 !== "string" || !HEX32.test(r.salt2)) return null;
  if (typeof r.amount !== "string" || !/^\d+$/.test(r.amount)) return null;
  if (typeof r.commitment !== "string" || !HEX32.test(r.commitment)) return null;
  if (typeof r.stakeCommitment !== "string" || !HEX32.test(r.stakeCommitment)) return null;
  const stage = STAGE_ORDER.includes(r.stage as Stage) ? (r.stage as Stage) : "draft";
  return { ...(r as BetReceipt), stage };
}

export function loadReceipt(wallet: string, market: string): BetReceipt | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key(wallet, market));
    return raw ? validateReceipt(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/** Returns false when storage is unavailable (caller must push the user to download). */
export function saveReceipt(r: BetReceipt): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key(r.wallet, r.market), JSON.stringify({ ...r, updatedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function updateReceipt(r: BetReceipt, patch: Partial<BetReceipt>): BetReceipt {
  const next = { ...r, ...patch, updatedAt: new Date().toISOString() };
  saveReceipt(next);
  return next;
}

export function removeReceipt(wallet: string, market: string): void {
  try {
    storage()?.removeItem(key(wallet, market));
  } catch {
    /* ignore */
  }
}

export function listReceipts(wallet: string): BetReceipt[] {
  const s = storage();
  if (!s) return [];
  const out: BetReceipt[] = [];
  try {
    const pre = `${PREFIX}${wallet}:`;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(pre)) continue;
      try {
        const r = validateReceipt(JSON.parse(s.getItem(k) ?? "null"));
        if (r) out.push(r);
      } catch {
        /* skip corrupt */
      }
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function downloadReceipt(r: BetReceipt): void {
  try {
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `stovia-bet-${r.symbol || r.market.slice(0, 6)}-${r.wallet.slice(0, 4)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {
    /* ignore */
  }
}

/** Parse an imported receipt file. Throws a user-facing message on failure. */
export async function readReceiptFile(file: File): Promise<BetReceipt> {
  if (file.size > 64_000) throw new Error("That file is too large to be a Stovia bet receipt.");
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  const r = validateReceipt(json);
  if (!r) throw new Error("That file isn't a valid Stovia bet receipt.");
  return r;
}
