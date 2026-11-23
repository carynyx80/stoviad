/**
 * Meteora Dynamic Bonding Curve helpers (@meteora-ag/dynamic-bonding-curve-sdk 2.0.0).
 * Every transaction here is built unsigned; users sign in their own browser wallets.
 */
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  getCurrentPoint,
  getPriceFromSqrtPrice,
  type PoolConfig,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { stoviaConfigParameters } from "./params";
import { DBC_CONFIG, DBC_PARTNER, TOKEN_DECIMALS, WSOL_MINT } from "./constants";
import { confirmSignature, errText } from "@/lib/admin/tx";

const clients = new WeakMap<Connection, DynamicBondingCurveClient>();
export function dbcClient(connection: Connection): DynamicBondingCurveClient {
  let c = clients.get(connection);
  if (!c) {
    c = new DynamicBondingCurveClient(connection, "confirmed");
    clients.set(connection, c);
  }
  return c;
}

/* ------------------------------------------------------------------ config (admin) */

export type ConfigStatus = { address: PublicKey; exists: boolean; feeClaimer: string | null; creatorFeePct: number | null; thresholdLamports: string | null };

export async function readConfigStatus(connection: Connection, address = DBC_CONFIG): Promise<ConfigStatus | null> {
  if (!address) return null;
  const cfg = await dbcClient(connection).state.getPoolConfig(address);
  return {
    address,
    exists: !!cfg,
    feeClaimer: cfg ? cfg.feeClaimer.toBase58() : null,
    creatorFeePct: cfg ? cfg.creatorTradingFeePercentage : null,
    thresholdLamports: cfg ? cfg.migrationQuoteThreshold.toString() : null,
  };
}

/**
 * The one company-wallet transaction: create the Stovia partner config (createConfig2).
 * The config account is a fresh keypair that must co-sign; it is generated in the browser and
 * discarded after signing (it has no authority over anything once created).
 */
export async function buildCreateConfigTx(connection: Connection, payer: PublicKey = DBC_PARTNER) {
  const configKp = Keypair.generate();
  const tx = await dbcClient(connection).partner.createConfig2({
    ...stoviaConfigParameters(),
    config: configKp.publicKey,
    feeClaimer: DBC_PARTNER,
    leftoverReceiver: DBC_PARTNER,
    quoteMint: WSOL_MINT,
    payer,
    transferFeeParameters: null,
  });
  return { tx, configKp };
}

/* ------------------------------------------------------------------ simulation */

export type CostSim = {
  ok: boolean;
  err: string | null;
  logs: string[];
  unitsConsumed?: number;
  /** Exact lamports leaving the payer (rent + network fee), from the simulated post-balance. */
  costLamports: number | null;
  balanceLamports: number | null;
};

/** Simulate a legacy tx with sigVerify off and read the payer's simulated post-balance. Never throws. */
export async function simulateCost(connection: Connection, tx: Transaction, payer: PublicKey): Promise<CostSim> {
  try {
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;
    const vtx = new VersionedTransaction(tx.compileMessage());
    const [balance, res] = await Promise.all([
      connection.getBalance(payer, "confirmed"),
      connection.simulateTransaction(vtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
        accounts: { encoding: "base64", addresses: [payer.toBase58()] },
      }),
    ]);
    const v = res.value;
    const post = v.accounts?.[0]?.lamports;
    return {
      ok: v.err == null,
      err: v.err == null ? null : typeof v.err === "string" ? v.err : JSON.stringify(v.err),
      logs: v.logs ?? [],
      unitsConsumed: v.unitsConsumed,
      costLamports: post == null ? null : balance - post,
      balanceLamports: balance,
    };
  } catch (e) {
    return { ok: false, err: errText(e), logs: [], costLamports: null, balanceLamports: null };
  }
}

/* ------------------------------------------------------------------ signing */

type WalletBits = Pick<WalletContextState, "publicKey" | "signTransaction" | "sendTransaction">;

/**
 * Wallet signs first, then any extra keypairs (config / mint) co-sign, then we broadcast and
 * poll for confirmation. Signing in this order keeps wallets from flagging pre-signed txs.
 */
export async function signSendConfirm(
  connection: Connection,
  w: WalletBits,
  tx: Transaction,
  extraSigners: Keypair[] = [],
  onStep?: (s: "signing" | "sending" | "confirming", sig?: string) => void,
): Promise<string> {
  if (!w.publicKey) throw new Error("Wallet disconnected.");
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = w.publicKey;
  onStep?.("signing");
  let sig: string;
  if (w.signTransaction) {
    const signed = await w.signTransaction(tx);
    if (extraSigners.length) signed.partialSign(...extraSigners);
    onStep?.("sending");
    sig = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
  } else {
    onStep?.("sending");
    sig = await w.sendTransaction(tx, connection, { signers: extraSigners, preflightCommitment: "confirmed", maxRetries: 3 });
  }
  onStep?.("confirming", sig);
  await confirmSignature(connection, sig);
  return sig;
}

/* ------------------------------------------------------------------ pools (creators) */

export function poolAddressForMint(mint: PublicKey, config: PublicKey | null = DBC_CONFIG): PublicKey | null {
  return config ? deriveDbcPoolAddress(WSOL_MINT, mint, config) : null;
}

/** Creator's pool-creation tx. The new mint keypair must co-sign (see signSendConfirm). */
export async function buildCreatePoolTx(
  connection: Connection,
  p: { creator: PublicKey; name: string; symbol: string; uri: string; config?: PublicKey },
) {
  const config = p.config ?? DBC_CONFIG;
  if (!config) throw new Error("Stovia config not created yet.");
  const mintKp = Keypair.generate();
  const tx = await dbcClient(connection).creator.createPool({
    baseMint: mintKp.publicKey,
    config,
    name: p.name,
    symbol: p.symbol,
    uri: p.uri,
    payer: p.creator,
    poolCreator: p.creator,
  });
  return { tx, mintKp, pool: deriveDbcPoolAddress(WSOL_MINT, mintKp.publicKey, config) };
}

/* ------------------------------------------------------------------ reads */

export type PoolView = {
  pool: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  config: PublicKey;
  /** SOL per whole token. */
  priceSol: number;
  /** Fully diluted market cap in SOL (price × total supply). */
  mcapSol: number;
  mcapLamports: bigint;
  /** quoteReserve / migrationQuoteThreshold, 0..1. */
  progress: number;
  quoteReserveLamports: bigint;
  thresholdLamports: bigint;
  migrated: boolean;
  /** Curve is complete (threshold hit) even if the migrator hasn't moved it yet. */
  complete: boolean;
  raw: { virtualPool: VirtualPool; config: PoolConfig };
};

export async function readPool(connection: Connection, pool: PublicKey): Promise<PoolView | null> {
  const c = dbcClient(connection);
  const virtualPool = await c.state.getPool(pool);
  if (!virtualPool) return null;
  const s = virtualPool.poolState;
  const config = await c.state.getPoolConfig(s.config);
  if (!config) return null;
  const decimals = config.tokenDecimal || TOKEN_DECIMALS;
  const price = getPriceFromSqrtPrice(s.sqrtPrice, decimals, 9); // SOL per token
  const supplyRaw = config.postMigrationTokenSupply.isZero() ? null : config.postMigrationTokenSupply;
  // Fallback: read the SPL mint's supply (u64 LE at offset 36) with getAccountInfo (allowed by the RPC proxy).
  const mintAcc = supplyRaw ? null : await connection.getAccountInfo(s.baseMint, "confirmed").catch(() => null);
  const mintSupply = mintAcc && mintAcc.data.length >= 44 ? new DataView(mintAcc.data.buffer, mintAcc.data.byteOffset + 36, 8).getBigUint64(0, true) : BigInt(0);
  const supply = Number(supplyRaw ? supplyRaw.toString() : mintSupply.toString()) / 10 ** decimals;
  const priceSol = price.toNumber();
  const mcapSol = priceSol * supply;
  const quote = BigInt(s.quoteReserve.toString());
  const threshold = BigInt(config.migrationQuoteThreshold.toString());
  const progress = threshold > BigInt(0) ? Math.min(1, Number((quote * BigInt(10_000)) / threshold) / 10_000) : 0;
  return {
    pool,
    mint: s.baseMint,
    creator: s.creator,
    config: s.config,
    priceSol,
    mcapSol,
    mcapLamports: BigInt(Math.floor(mcapSol * 1e9)),
    progress,
    quoteReserveLamports: quote,
    thresholdLamports: threshold,
    migrated: s.isMigrated !== 0,
    complete: quote >= threshold,
    raw: { virtualPool, config },
  };
}

/* ------------------------------------------------------------------ swaps */

export type Quote = { amountIn: BN; outputAmount: BN; minimumAmountOut: BN; feeLamportsOrBase: BN };

export async function quoteSwap(connection: Connection, view: PoolView, side: "buy" | "sell", amountIn: BN, slippageBps: number): Promise<Quote> {
  const c = dbcClient(connection);
  const currentPoint = await getCurrentPoint(connection, view.raw.config.activationType);
  const q = c.pool.swapQuote({
    virtualPool: view.raw.virtualPool,
    config: view.raw.config,
    swapBaseForQuote: side === "sell",
    amountIn,
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  return { amountIn, outputAmount: q.outputAmount, minimumAmountOut: q.minimumAmountOut, feeLamportsOrBase: q.tradingFee.add(q.protocolFee).add(q.referralFee) };
}

/** Buy: SOL (lamports) in → tokens out, with slippage-protected minimum. */
export async function buildBuyTx(connection: Connection, owner: PublicKey, pool: PublicKey, lamportsIn: BN, minTokensOut: BN): Promise<Transaction> {
  return dbcClient(connection).pool.swap({ owner, pool, amountIn: lamportsIn, minimumAmountOut: minTokensOut, swapBaseForQuote: false, referralTokenAccount: null });
}

/** Sell: tokens (base units) in → SOL out, with slippage-protected minimum. */
export async function buildSellTx(connection: Connection, owner: PublicKey, pool: PublicKey, tokensIn: BN, minLamportsOut: BN): Promise<Transaction> {
  return dbcClient(connection).pool.swap({ owner, pool, amountIn: tokensIn, minimumAmountOut: minLamportsOut, swapBaseForQuote: true, referralTokenAccount: null });
}

/** Owner's balance of a mint, in base units. */
export async function tokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const res = await connection.getTokenAccountsByOwner(owner, { mint }, "confirmed");
  let total = BigInt(0);
  for (const { account } of res.value) {
    // SPL token account layout: amount u64 LE at offset 64.
    const d = account.data;
    if (d.length >= 72) total += new DataView(d.buffer, d.byteOffset + 64, 8).getBigUint64(0, true);
  }
  return total;
}

/* ------------------------------------------------------------------ token metadata */

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export type TokenMeta = { name: string; symbol: string; uri: string; image: string | null };

/** Decode name/symbol/uri from the Metaplex metadata account, then resolve the image. */
export async function readTokenMeta(connection: Connection, mint: PublicKey): Promise<TokenMeta | null> {
  const [pda] = PublicKey.findProgramAddressSync([new TextEncoder().encode("metadata"), METAPLEX.toBytes(), mint.toBytes()], METAPLEX);
  const acc = await connection.getAccountInfo(pda, "confirmed");
  if (!acc) return null;
  const d = acc.data;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 1 + 32 + 32;
  const str = () => {
    const len = dv.getUint32(o, true);
    o += 4;
    const s = new TextDecoder().decode(d.subarray(o, o + len));
    o += len;
    return s.replace(/\0+$/, "").trim();
  };
  const name = str();
  const symbol = str();
  const uri = str();
  let image: string | null = null;
  try {
    const u = new URL(uri);
    if (u.pathname === "/api/meta" && u.searchParams.get("i")) image = u.searchParams.get("i");
    else {
      const j = (await (await fetch(uri, { cache: "force-cache" })).json()) as { image?: string };
      image = typeof j.image === "string" ? j.image : null;
    }
  } catch {
    /* unreachable / CORS: fall back to the ticker avatar */
  }
  return { name, symbol, uri, image };
}
