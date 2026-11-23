// Read-only live check: find a recent Meteora DBC VirtualPool on mainnet, decode it and compute its
// market cap in lamports. Sends nothing. Usage: node scripts/live-dbc.js [poolAddress]
// Key source: HELIUS_API_KEY env, else ../keys/helius.env (never printed).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Chain } from "../src/chain.js";
import { heliusMainnetRpc } from "../src/rings.js";
import { DbcReader, DBC_PROGRAM_ID, VIRTUAL_POOL_DISC } from "../src/dbc.js";

function apiKey() {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const p = fileURLToPath(new URL("../../keys/helius.env", import.meta.url));
  if (!existsSync(p)) throw new Error("HELIUS_API_KEY not set and keys/helius.env missing");
  const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("HELIUS_API_KEY="));
  if (!line) throw new Error("HELIUS_API_KEY not found in keys/helius.env");
  return line.slice("HELIUS_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

const chain = new Chain({ rpcUrl: heliusMainnetRpc(apiKey()), idl: null });
const dbc = new DbcReader({ chain });

async function findPool() {
  const sigs = await chain.rpc("getSignaturesForAddress", [DBC_PROGRAM_ID, { limit: 25 }]);
  for (const s of sigs.filter((x) => !x.err)) {
    const tx = await chain.rpc("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    const keys = [...(tx?.transaction?.message?.accountKeys ?? []), ...(tx?.meta?.loadedAddresses?.writable ?? [])];
    for (const k of keys) {
      const a = await chain.getAccountInfo(k);
      if (a?.owner === DBC_PROGRAM_ID && Buffer.from(a.data.subarray(0, 8)).equals(VIRTUAL_POOL_DISC)) return k;
    }
  }
  return null;
}

const pool = process.argv[2] || (await findPool());
if (!pool) throw new Error("no DBC pool found in recent program txs");
const s = await dbc.snapshot(pool);
const show = { pool, ...s };
for (const k of Object.keys(show)) if (typeof show[k] === "bigint") show[k] = show[k].toString();
console.log(JSON.stringify(show, null, 2));
if (s.isDbcPool) {
  console.log("mcap SOL:", Number(s.mcapLamports) / 1e9, "| quote is wSOL:", s.quoteMint === "So11111111111111111111111111111111111111112");
  console.log("cross-check price (quoteReserve/baseReserve is NOT the curve price, informational):", s.baseReserve > 0n ? Number(s.quoteReserve) / Number(s.baseReserve) : null);
}
