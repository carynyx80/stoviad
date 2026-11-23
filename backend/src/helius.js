// Normalise Helius webhook payloads (enhanced or raw) into
// { signature, slot, timestamp, logs|null, touchesProgram, payload }.
import { extractProgramData, decodeEvent } from './anchor.js';

function collectProgramIds(tx) {
  const ids = new Set();
  const walk = (ixs) => {
    if (!Array.isArray(ixs)) return;
    for (const ix of ixs) {
      if (ix?.programId) ids.add(ix.programId);
      walk(ix?.innerInstructions);
    }
  };
  walk(tx.instructions);
  for (const a of tx.accountData || []) if (a?.account) ids.add(a.account);
  // Raw webhook format
  const keys = tx.transaction?.message?.accountKeys;
  if (Array.isArray(keys)) for (const k of keys) ids.add(typeof k === 'string' ? k : k?.pubkey);
  return ids;
}

export function normalise(tx, programId) {
  if (!tx || typeof tx !== 'object') return null;
  const signature = tx.signature || tx.transaction?.signatures?.[0];
  if (typeof signature !== 'string' || signature.length < 32 || signature.length > 128) return null;
  const logs = tx.meta?.logMessages || tx.logMessages || null;
  const ids = collectProgramIds(tx);
  const touchesProgram = ids.has(programId) || (Array.isArray(logs) && logs.some((l) => typeof l === 'string' && l.includes(programId)));
  return {
    signature,
    slot: Number.isFinite(tx.slot) ? tx.slot : null,
    timestamp: Number.isFinite(tx.timestamp) ? tx.timestamp : Number.isFinite(tx.blockTime) ? tx.blockTime : null,
    failed: !!(tx.transactionError || tx.meta?.err),
    logs,
    touchesProgram,
    payload: tx,
  };
}

export function decodeLogs(logs, programId) {
  return extractProgramData(logs, programId)
    .map((b64) => decodeEvent(b64))
    .filter(Boolean)
    .map((ev, idx) => ({ idx, ...ev }));
}
