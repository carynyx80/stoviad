// Read-only live check against Helius mainnet: derives a market identity from a THROWAWAY random
// master seed and syncs its (empty) shielded balance through the SPR indexer. Sends nothing.
// Key source: HELIUS_API_KEY env, else ../keys/helius.env (never printed).
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MarketIdentities } from "../src/keys.js";
import { createRings, heliusMainnetRpc } from "../src/rings.js";

function apiKey() {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY;
  const p = fileURLToPath(new URL("../../keys/helius.env", import.meta.url));
  if (!existsSync(p)) throw new Error("HELIUS_API_KEY not set and keys/helius.env missing");
  const line = readFileSync(p, "utf8").split("\n").find((l) => l.startsWith("HELIUS_API_KEY="));
  if (!line) throw new Error("HELIUS_API_KEY not found in keys/helius.env");
  return line.slice("HELIUS_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
}

const market = process.argv[2] || "6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8";
const ids = new MarketIdentities(new Uint8Array(randomBytes(32)));
const info = await ids.publicInfo(market);
console.log("market:", market);
console.log("derived shielded owner (throwaway seed):", info.ownerSolanaAddress);
const t0 = Date.now();
const rings = await createRings({ rpcUrl: heliusMainnetRpc(apiKey()) });
const bal = await rings.balance(await ids.get(market));
console.log("shielded SOL balance via SPR indexer:", bal.toString(), `(${Date.now() - t0} ms)`);
const rx = await rings.receivedInTx(await ids.get(market), "1".repeat(88));
console.log("receivedInTx(bogus sig):", rx.amount.toString(), "rows", rx.rows);

// Sender check on a real (recent, arbitrary) Privacy Rings transaction — read-only.
import { Chain } from "../src/chain.js";
import { getTransactionDecoder } from "@solana/kit";
const chain = new Chain({ rpcUrl: heliusMainnetRpc(apiKey()), idl: null });
const recent = (await chain.rpc("getSignaturesForAddress", ["ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW", { limit: 5 }])).find((s) => !s.err);
if (recent) {
  const raw = await chain.rpc("getTransaction", [recent.signature, { encoding: "base64", maxSupportedTransactionVersion: 1 }]);
  const feePayer = Object.keys(getTransactionDecoder().decode(Buffer.from(raw.transaction[0], "base64")).signatures)[0];
  const yes = await chain.txSignedBy(recent.signature, feePayer);
  const no = await chain.txSignedBy(recent.signature, "3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm");
  console.log(`txSignedBy(real ring tx v${raw.version}): fee payer ->`, yes.signed, "| unrelated key ->", no.signed);
}

// Unsigned post_sealed_results (fee payer = company wallet), built with a live blockhash. Not sent.
import { loadIdl } from "../src/idl.js";
import { COMPANY_WALLET } from "../src/actions.js";
const chain2 = new Chain({ rpcUrl: heliusMainnetRpc(apiKey()), idl: loadIdl() });
const post = await chain2.buildPostSealedResultsUnsigned({ feePayer: COMPANY_WALLET, market, yesTotal: 1n, noTotal: 2n, payoutRoot: new Uint8Array(32) });
const decodedPost = getTransactionDecoder().decode(Buffer.from(post.txBase64, "base64"));
const sigSlots = Object.entries(decodedPost.signatures);
console.log("unsigned post_sealed_results:", Buffer.from(post.txBase64, "base64").length, "bytes; signer slots:", sigSlots.map(([k, v]) => `${k}=${v ? "signed" : "empty"}`).join(","), "lastValid:", String(post.lastValidBlockHeight));
