import { Transaction, VersionedTransaction, type TransactionVersion } from "@solana/web3.js";

export const RESOLVER_URL = (process.env.NEXT_PUBLIC_RESOLVER_URL ?? "").replace(/\/+$/, "");
export const resolverConfigured = () => RESOLVER_URL.length > 0;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 encoder (bitcoin alphabet) for the auth signature header. */
export function base58(bytes: Uint8Array): string {
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  // all-zero input: digits = [0] would add an extra "1"
  return bytes.length > 0 && bytes.every((b) => b === 0) ? out.slice(0, bytes.length) : out;
}

export type AdminAuth = { sig: string; nonce: string };

export type PendingAction = {
  id: string;
  kind?: string;
  market?: string;
  summary?: string;
  amounts?: unknown;
  tx: string;
};

export class ResolverError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ResolverError";
  }
}

async function call<T>(path: string, init: RequestInit = {}, auth?: AdminAuth): Promise<T> {
  if (!resolverConfigured()) throw new ResolverError("Resolver not connected");
  const headers = new Headers(init.headers);
  if (auth) {
    headers.set("x-stovia-admin", auth.sig);
    headers.set("x-stovia-nonce", auth.nonce);
  }
  if (init.body) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`${RESOLVER_URL}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ResolverError("Resolver unreachable (network / CORS).");
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      msg = j.error ?? j.message ?? msg;
    } catch {
      /* not json */
    }
    throw new ResolverError(`${res.status}: ${msg || res.statusText}`, res.status);
  }
  try {
    return (text ? JSON.parse(text) : null) as T;
  } catch {
    throw new ResolverError("Resolver returned invalid JSON.");
  }
}

export async function fetchNonce(): Promise<string> {
  const r = await call<{ nonce?: string }>("/admin/nonce");
  if (!r || typeof r.nonce !== "string" || !r.nonce) throw new ResolverError("Resolver returned no nonce.");
  return r.nonce;
}

/** Sign "stovia-admin:<nonce>" with the connected wallet. */
export async function authenticate(signMessage: (m: Uint8Array) => Promise<Uint8Array>): Promise<AdminAuth> {
  const nonce = await fetchNonce();
  const sig = await signMessage(new TextEncoder().encode(`stovia-admin:${nonce}`));
  return { sig: base58(sig), nonce };
}

export async function fetchPending(auth: AdminAuth): Promise<PendingAction[]> {
  const r = await call<unknown>("/admin/pending", {}, auth);
  const list = Array.isArray(r) ? r : Array.isArray((r as { pending?: unknown })?.pending) ? (r as { pending: unknown[] }).pending : null;
  if (!list) throw new ResolverError("Unexpected /admin/pending response.");
  return list.filter((x): x is PendingAction => !!x && typeof (x as PendingAction).id === "string" && typeof (x as PendingAction).tx === "string");
}

export async function postSubmitted(auth: AdminAuth, actionId: string, signature: string): Promise<void> {
  await call("/admin/submitted", { method: "POST", body: JSON.stringify({ actionId, signature }) }, auth);
}

// ---------- tx decoding ----------

export type DecodedTx =
  | { ok: true; tx: VersionedTransaction | Transaction; version: TransactionVersion }
  | { ok: true; tx: null; version: 1; raw: Uint8Array }
  | { ok: false; error: string };

/**
 * Message version from wire bytes, before any deserialization. v1 is message-first
 * (first byte 0x81); legacy/v0 are signatures-first (compact-u16 count, 64-byte sigs, message).
 */
export function wireVersion(bytes: Uint8Array): TransactionVersion | number | "unknown" {
  if (bytes.length === 0) return "unknown";
  if (bytes[0] === 0x81) return 1;
  let n = 0;
  let i = 0;
  for (let shift = 0; i < 3 && i < bytes.length; i++, shift += 7) {
    n |= (bytes[i] & 0x7f) << shift;
    if ((bytes[i] & 0x80) === 0) {
      i++;
      break;
    }
  }
  const at = i + n * 64;
  if (at >= bytes.length) return "unknown";
  return bytes[at] & 0x80 ? bytes[at] & 0x7f : "legacy";
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * base64 -> transaction. v1 (message-first, prefix 0x81) is returned as raw bytes for
 * conversion via lib/admin/v1; legacy/v0 go through VersionedTransaction.deserialize,
 * with Transaction.from as the legacy fallback.
 */
export function decodeTx(b64: string): DecodedTx {
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    return { ok: false, error: "Transaction is not valid base64." };
  }
  const v = wireVersion(bytes);
  if (v === 1) return { ok: true, tx: null, version: 1, raw: bytes };
  if (typeof v === "number" && v > 1) return { ok: false, error: `Unsupported transaction version v${v}.` };
  try {
    const vtx = VersionedTransaction.deserialize(bytes);
    return { ok: true, tx: vtx, version: vtx.version };
  } catch (e1) {
    try {
      return { ok: true, tx: Transaction.from(bytes), version: "legacy" };
    } catch {
      return { ok: false, error: `Could not deserialize transaction: ${e1 instanceof Error ? e1.message : String(e1)}` };
    }
  }
}

/**
 * Wallet adapters and sendRawTransaction both need `serialize()`. web3.js 1.99 can
 * *deserialize* v1 messages but throws on serializing them, so check up front.
 */
export function serializable(tx: VersionedTransaction | Transaction): boolean {
  try {
    if (tx instanceof VersionedTransaction) tx.message.serialize();
    else tx.serializeMessage();
    return true;
  } catch {
    return false;
  }
}
