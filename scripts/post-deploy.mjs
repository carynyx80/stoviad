#!/usr/bin/env node
// Stovia post-deploy helper. No Anchor TS dependency: instructions are encoded by hand
// (discriminator = sha256("global:<name>")[..8], Borsh args), matching target/idl/stovia.json.
//
// The company wallet 3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm does everything: it is the
// fee payer and signer of every tx, and admin, treasury and resolver in Config.
//
// Subcommands:
//   init          company signs initialize_config(treasury=company, 10 bps, 10 bps,
//                 pending_admin=None, resolver=company). The company must already be the
//                 program's upgrade authority (the deploy script makes it so from the start).
//   accept-admin  NOT NEEDED in the normal flow (init makes the company admin directly). Kept
//                 only for a future two-step admin hand-over started with propose_admin.
//   status        print Config + upgrade authority and check them against the company wallet.
//                 --strict exits 2 unless admin, treasury, resolver and upgrade authority are
//                 all the company, pending_admin is None and fees are 10/10.
//
// Signing (on-chain commands):
//   --keypair <path>   a local company keypair file (required unless --print-tx)
//   --print-tx         print an UNSIGNED base64 tx (fee payer = company) for wallets that cannot
//                      be used from the CLI. Sign and broadcast it within ~60 s (blockhash expiry).
//   --dry-run          build + simulate, do not send.
// Common flags: --cluster mainnet|localnet (default: mainnet unless --url is localhost),
//               --url <rpc>, --cu-price <microlamports> (default 0 = no priority fee).
// Env: PROGRAM_ID, STOVIA_LOCALNET_COMPANY (stand-in company; honored ONLY with --cluster
//      localnet on a localhost, non-mainnet RPC), PLATFORM_FEE_BPS, CREATOR_FEE_BPS.
//
// @solana/web3.js is resolved from this repo's backend/node_modules if not installed globally.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let web3;
try {
  web3 = await import("@solana/web3.js");
} catch {
  const req = createRequire(path.join(here, "..", "backend", "package.json"));
  web3 = req("@solana/web3.js");
}
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} = web3;

const BPF_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MAINNET_COMPANY = "3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEFAULT_PROGRAM = "6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };

const dryRun = flag("dry-run", false) === true;
const printTx = flag("print-tx", false) === true;
const url = String(flag("url", process.env.RPC_URL || "https://api.mainnet-beta.solana.com"));
const isLocalUrl = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(url);
const cluster = String(flag("cluster", isLocalUrl ? "localnet" : "mainnet"));
if (!["mainnet", "localnet"].includes(cluster)) die("--cluster must be mainnet or localnet");
const kpFlag = flag("keypair", undefined);
const keypairPath = kpFlag === undefined || kpFlag === true ? undefined : String(kpFlag).replace(/^~/, homedir());
const cuPrice = Number(flag("cu-price", process.env.CU_PRICE || 0));
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || DEFAULT_PROGRAM);
const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS || 10);
const creatorFeeBps = Number(process.env.CREATOR_FEE_BPS || 10);

const conn = new Connection(url, "confirmed");

// Company pin: the stand-in override exists only for localnet rehearsals.
const genesis = await conn.getGenesisHash();
const override = process.env.STOVIA_LOCALNET_COMPANY;
let companyStr = MAINNET_COMPANY;
if (cluster === "mainnet") {
  if (override && override !== MAINNET_COMPANY)
    die(`STOVIA_LOCALNET_COMPANY is only honored with --cluster localnet; mainnet is pinned to ${MAINNET_COMPANY}`);
  if (process.env.COMPANY_WALLET && process.env.COMPANY_WALLET !== MAINNET_COMPANY)
    die("COMPANY_WALLET overrides are no longer supported; mainnet is pinned");
} else {
  if (genesis === MAINNET_GENESIS) die("--cluster localnet but the RPC is mainnet-beta; refusing");
  if (!isLocalUrl) die("--cluster localnet requires a localhost RPC URL");
  if (override) companyStr = override;
}
const COMPANY = new PublicKey(companyStr);

const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE)[0];

const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

function loadCompanySigner() {
  if (!keypairPath) die("--keypair <company-keypair.json> is required (or use --print-tx)");
  if (keypairPath.startsWith("usb://") || keypairPath.startsWith("prompt:"))
    die("this script cannot drive a Ledger/prompt signer; use --print-tx and sign the tx in your wallet");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
  if (!kp.publicKey.equals(COMPANY))
    die(`keypair ${keypairPath} is ${kp.publicKey.toBase58()}, but the company wallet is ${COMPANY.toBase58()}`);
  return kp;
}

// ---------------------------------------------------------------- decoding
function decodeConfig(d) {
  const pk = (o) => new PublicKey(d.subarray(o, o + 32));
  const hasPending = d[85] === 1;
  return {
    admin: pk(8),
    treasury: pk(40),
    platformFeeBps: d.readUInt16LE(72),
    creatorFeeBps: d.readUInt16LE(74),
    launchCount: d.readBigUInt64LE(76),
    pendingAdmin: hasPending ? pk(86) : null,
    resolver: pk(hasPending ? 118 : 86),
  };
}
async function upgradeAuthority() {
  const acc = await conn.getAccountInfo(programData);
  if (!acc) return undefined; // program not deployed
  // ProgramData: u32 tag(3) | u64 slot | Option<Pubkey>
  return acc.data[12] === 1 ? new PublicKey(acc.data.subarray(13, 45)) : null;
}

async function buildTx(ixs) {
  const tx = new Transaction();
  if (cuPrice > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }));
  }
  tx.add(...ixs);
  tx.feePayer = COMPANY;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  return tx;
}

// Every on-chain step goes through here: --print-tx, --dry-run, or sign with the company keypair.
async function sendIxs(ixs, label) {
  const tx = await buildTx(ixs);
  if (printTx) {
    const b64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
    console.error(`[print-tx] ${label}: unsigned tx, fee payer + sole signer = ${COMPANY.toBase58()}, cluster ${cluster}.`);
    console.error("[print-tx] blockhash expires in ~60-90 s: sign and broadcast promptly, or re-run to refresh.");
    if ((await upgradeAuthority()) !== undefined) {
      const sim = await conn.simulateTransaction(tx).catch((e) => ({ value: { err: e.message, logs: [] } }));
      console.error(`[print-tx] simulation (no sig verify): err=${JSON.stringify(sim.value.err)}`);
    } else {
      console.error("[print-tx] program not deployed on this cluster yet; simulation skipped.");
    }
    console.log(b64);
    return null;
  }
  const signer = loadCompanySigner();
  if (dryRun) {
    console.log(`[dry-run] ${label}: not sending.`);
    if ((await upgradeAuthority()) === undefined) {
      console.log("[dry-run] program not deployed on this cluster; skipping simulation.");
      ixs.forEach((ix) => console.log(`  ix data (hex): ${ix.data.toString("hex")}\n  accounts: ${ix.keys.map((k) => k.pubkey.toBase58()).join(", ")}`));
      return null;
    }
    const sim = await conn.simulateTransaction(tx, [signer]);
    console.log(`[dry-run] simulation: err=${JSON.stringify(sim.value.err)}`);
    (sim.value.logs || []).forEach((l) => console.log(`  ${l}`));
    return null;
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
  console.log(`${label}: ${sig}`);
  return sig;
}

// ---------------------------------------------------------------- commands
async function init() {
  const log = printTx ? console.error : console.log;
  log(`cluster        ${cluster} (${url})`);
  log(`program        ${PROGRAM_ID.toBase58()}`);
  log(`config PDA     ${configPda.toBase58()}`);
  log(`signer/payer   ${COMPANY.toBase58()} (company)`);
  log(`admin          ${COMPANY.toBase58()}`);
  log(`treasury       ${COMPANY.toBase58()}`);
  log(`resolver       ${COMPANY.toBase58()}`);
  log(`pending_admin  none`);
  log(`fees           platform ${platformFeeBps} bps, creator ${creatorFeeBps} bps`);

  const existing = await conn.getAccountInfo(configPda);
  if (existing) {
    log("Config already initialized; not re-initializing." + fmtConfig(decodeConfig(existing.data)));
    return;
  }
  const ua = await upgradeAuthority();
  if (!dryRun && !printTx && ua === undefined) die("program is not deployed at this cluster");
  if (ua && !ua.equals(COMPANY)) die(`upgrade authority is ${ua.toBase58()}, not the company; initialize would fail`);

  const data = Buffer.concat([
    disc("initialize_config"),
    COMPANY.toBuffer(),         // treasury
    u16(platformFeeBps),
    u16(creatorFeeBps),
    Buffer.from([0]),           // pending_admin: None (the signer becomes admin directly)
    COMPANY.toBuffer(),         // resolver
  ]);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: COMPANY, isSigner: true, isWritable: true },   // admin = payer = upgrade authority
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: programData, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  await sendIxs([ix], "initialize_config");
}

async function acceptAdmin() {
  console.error("NOTE: accept-admin is unnecessary in the normal flow; init already makes the company admin.");
  const acc = await conn.getAccountInfo(configPda);
  if (!acc) die("config not initialized");
  const c = decodeConfig(acc.data);
  if (!c.pendingAdmin || !c.pendingAdmin.equals(COMPANY))
    die(`pending_admin is ${c.pendingAdmin?.toBase58() ?? "none"}; nothing for ${COMPANY.toBase58()} to accept`);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: COMPANY, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data: disc("accept_admin"),
  });
  await sendIxs([ix], "accept_admin");
}

const fmtConfig = (c) =>
  `\n  admin          ${c.admin.toBase58()}\n  pending_admin  ${c.pendingAdmin?.toBase58() ?? "none"}` +
  `\n  treasury       ${c.treasury.toBase58()}\n  resolver       ${c.resolver.toBase58()}` +
  `\n  fees           ${c.platformFeeBps}/${c.creatorFeeBps} bps, launches ${c.launchCount}`;

async function status() {
  const strict = flag("strict", false) === true;
  const ua = await upgradeAuthority();
  console.log(`cluster            ${cluster} (${url})`);
  console.log(`company            ${COMPANY.toBase58()}`);
  console.log(`program            ${PROGRAM_ID.toBase58()} (${ua === undefined ? "NOT DEPLOYED" : "deployed"})`);
  console.log(`upgrade authority  ${ua === undefined ? "-" : ua?.toBase58() ?? "none (immutable)"}`);
  const acc = await conn.getAccountInfo(configPda);
  if (!acc) { console.log("config             not initialized"); if (strict) process.exit(2); return; }
  const c = decodeConfig(acc.data);
  console.log(`config             ${configPda.toBase58()}${fmtConfig(c)}`);
  const checks = [
    ["upgrade authority == company", !!ua && ua.equals(COMPANY)],
    ["admin == company", c.admin.equals(COMPANY)],
    ["treasury == company", c.treasury.equals(COMPANY)],
    ["resolver == company", c.resolver.equals(COMPANY)],
    ["pending_admin == none", c.pendingAdmin === null],
    [`fees == ${platformFeeBps}/${creatorFeeBps} bps`, c.platformFeeBps === platformFeeBps && c.creatorFeeBps === creatorFeeBps],
  ];
  let ok = true;
  for (const [name, pass] of checks) { console.log(`  [${pass ? "x" : " "}] ${name}`); ok &&= pass; }
  console.log(ok ? "ALL CHECKS PASS" : "CHECKS FAILED");
  if (strict && !ok) process.exit(2);
}

const cmds = { init, "accept-admin": acceptAdmin, status };
if (!cmds[cmd]) die("usage: post-deploy.mjs <init|status|accept-admin> [--cluster mainnet|localnet] [--url URL] [--keypair PATH | --print-tx] [--dry-run] [--strict]");
await cmds[cmd]();
