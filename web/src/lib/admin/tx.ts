import {
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
  type PublicKey,
  type TransactionInstruction,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;

export type SimResult = { ok: boolean; err: string | null; logs: string[]; unitsConsumed?: number };

/** Human-readable error text from anything thrown (wallet, RPC, our own). */
export function errText(e: unknown): string {
  if (e == null) return "Unknown error";
  if (typeof e === "string") return e;
  if (e instanceof Error) {
    const inner = (e as Error & { error?: unknown }).error;
    const msg = e.message || e.name;
    if (inner instanceof Error && inner.message && inner.message !== msg) return `${msg} (${inner.message})`;
    return msg || "Unknown error";
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function simErr(err: SimulatedTransactionResponse["err"]): string | null {
  if (err == null) return null;
  return typeof err === "string" ? err : JSON.stringify(err);
}

/** Build an unsigned legacy-message VersionedTransaction (the most widely supported shape). */
export async function buildTx(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[]) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
  return { tx: new VersionedTransaction(message), blockhash, lastValidBlockHeight };
}

/** Simulate without signatures (sigVerify off). Never throws. */
export async function simulate(connection: Connection, tx: VersionedTransaction | Transaction, replaceBlockhash = true): Promise<SimResult> {
  try {
    const vtx = tx instanceof VersionedTransaction ? tx : new VersionedTransaction(tx.compileMessage());
    const res = await connection.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: replaceBlockhash,
      commitment: "confirmed",
    });
    const v = res.value;
    return { ok: v.err == null, err: simErr(v.err), logs: v.logs ?? [], unitsConsumed: v.unitsConsumed };
  } catch (e) {
    return { ok: false, err: errText(e), logs: [] };
  }
}

/**
 * Poll signature status until confirmed / failed / timeout. Polling (not websockets)
 * because the default RPC is an HTTP-only proxy.
 */
export async function confirmSignature(connection: Connection, signature: string, timeoutMs = 90_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const st = value[0];
    if (st?.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Not confirmed after ${Math.round(timeoutMs / 1000)}s — check Solscan before retrying.`);
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/**
 * Simulate raw wire bytes (e.g. a v1 tx web3.js can't re-serialize) via JSON-RPC directly.
 * If the node can't decode the format, report it as skipped rather than failed. Never throws.
 */
export async function simulateRaw(connection: Connection, raw: Uint8Array): Promise<SimResult> {
  try {
    const res = await fetch(connection.rpcEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateTransaction",
        params: [bytesToB64(raw), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }],
      }),
    });
    const j = (await res.json()) as { error?: { message?: string }; result?: { value: { err: unknown; logs: string[] | null; unitsConsumed?: number } } };
    if (j.error) {
      const msg = j.error.message ?? "RPC error";
      if (/version|deserializ|decode|invalid transaction|failed to/i.test(msg)) return { ok: true, err: null, logs: [`Simulation skipped: RPC can't decode this format (${msg})`] };
      return { ok: false, err: msg, logs: [] };
    }
    const v = j.result!.value;
    return { ok: v.err == null, err: v.err == null ? null : typeof v.err === "string" ? v.err : JSON.stringify(v.err), logs: v.logs ?? [], unitsConsumed: v.unitsConsumed };
  } catch (e) {
    return { ok: true, err: null, logs: [`Simulation skipped: ${errText(e)}`] };
  }
}
