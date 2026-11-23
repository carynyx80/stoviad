/**
 * Stovia Privacy Rings client (browser copy of packages/rings, which Vercel cannot import).
 *
 * Wraps `@heliuslabs/spr@0.9.0-alpha`. Every builder returns an UNSIGNED compiled
 * `@solana/kit` Transaction whose fee payer is the user's wallet. Nothing here signs
 * with stored keys or sends anything. All Helius traffic goes through the Stovia API
 * proxy (`${API}/rpc` for Solana JSON-RPC, `${API}/v1/spr/*` for the indexer and the
 * TEE prover), so the Helius API key never reaches the browser.
 *
 * Load this module with `await import("@/lib/rings")` only: it pulls in the SDK
 * (Poseidon, HPKE, kit) and must stay out of the other pages' bundles.
 *
 * Shielded identity: wallets cannot export their Ed25519 seed, so we derive a separate,
 * deterministic shielded identity from a wallet `signMessage` over a fixed domain string.
 * It lives only in memory. The shielded owner authorizes spends inside the proof, so the
 * wallet stays the only transaction signer (fee payer).
 */
import {
  SOL_MINT,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildDepositTransaction,
  buildWithdrawalTransaction,
  createSprClient,
  getPrivateTokenBalances,
  initializePoseidon,
  syncWallet,
  type Bytes32,
  type ShieldedAddress,
} from "@heliuslabs/spr";
import { LocalKeys, SignedTeePolicy } from "@heliuslabs/spr/client";
import { AssetRegistry, LocalShieldedKeys } from "@heliuslabs/spr/transaction";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type Transaction,
} from "@solana/kit";

export type SprClient = Awaited<ReturnType<typeof createSprClient>>;
export { SOL_MINT };

export const PRIVACY_PROGRAM_ID = "ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW";

/** Domain string the wallet signs. Must stay byte-identical to packages/rings; changing it orphans balances. */
export const SHIELDED_IDENTITY_MESSAGE =
  "Stovia shielded identity v1\n\nSign to unlock your private balance. This does not send a transaction.";

/** Solana's packet limit for legacy / v0 transactions. */
export const LEGACY_TX_MAX_BYTES = 1232;

export interface WalletLike {
  readonly address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

/** In-memory shielded identity. Never persist it. */
export interface ShieldedIdentity {
  readonly keypair: ShieldedKeypair;
  readonly shieldedAddress: ShieldedAddress;
  readonly ownerSolanaAddress: string;
}

export interface StoviaRings {
  readonly client: SprClient;
  deriveShieldedIdentity(wallet: WalletLike): Promise<ShieldedIdentity>;
  getShieldedBalance(identity: ShieldedIdentity): Promise<bigint>;
  shieldSol(input: { payer: string; identity: ShieldedIdentity; lamports: bigint }): Promise<Transaction>;
  withdrawSol(input: { payer: string; identity: ShieldedIdentity; lamports: bigint; recipient?: string }): Promise<Transaction>;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

let poseidonReady: Promise<void> | null = null;

/** `apiUrl` is the Stovia API origin (NEXT_PUBLIC_API_URL). Mainnet only. */
export async function createStoviaRings(apiUrl: string): Promise<StoviaRings> {
  const base = apiUrl.replace(/\/+$/, "");
  if (!base) throw new Error("Stovia API URL is not configured");
  poseidonReady ??= initializePoseidon();
  await poseidonReady;
  const client = await createSprClient({
    solanaRpcUrl: `${base}/rpc`,
    // The proxy is HTTP only; the SDK would otherwise derive a ws:// URL on the API host.
    solanaRpcSubscriptionsUrl: "wss://api.mainnet-beta.solana.com",
    indexerUrl: `${base}/v1/spr`,
    proverUrl: `${base}/v1/spr`,
    proofDataSource: "prover",
    proverTee: SignedTeePolicy.forNetwork("mainnet"),
    ...(base.startsWith("http://") ? { allowInsecureHttp: true } : {}),
  });
  const assets = new AssetRegistry();
  const wallets = new WeakMap<ShieldedKeypair, Wallet>();

  async function syncedWallet(identity: ShieldedIdentity): Promise<Wallet> {
    let w = wallets.get(identity.keypair);
    if (!w) {
      w = new Wallet({ identity: identity.shieldedAddress, registry: assets });
      wallets.set(identity.keypair, w);
    }
    await syncWallet({ wallet: w, keys: LocalShieldedKeys.fromKeypair(identity.keypair), client, config: { pageLimit: 50 } });
    return w;
  }

  return {
    client,

    async deriveShieldedIdentity(wallet) {
      const sig = await wallet.signMessage(new TextEncoder().encode(SHIELDED_IDENTITY_MESSAGE));
      const seed = await sha256(sig);
      try {
        const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
        const shieldedAddress = keypair.shieldedAddress();
        return { keypair, shieldedAddress, ownerSolanaAddress: String(shieldedAddress.solanaAddress()) };
      } finally {
        seed.fill(0);
        sig.fill(0);
      }
    },

    async getShieldedBalance(identity) {
      const w = await syncedWallet(identity);
      return getPrivateTokenBalances(w).find((b) => b.mint === SOL_MINT)?.amount ?? BigInt(0);
    },

    async shieldSol({ payer, identity, lamports }) {
      const p = address(payer);
      return buildDepositTransaction({
        client,
        feePayer: p,
        depositor: p,
        recipient: identity.shieldedAddress,
        asset: SOL_MINT,
        amount: lamports,
      });
    },

    async withdrawSol({ payer, identity, lamports, recipient }) {
      const w = await syncedWallet(identity);
      const p = address(payer);
      return buildWithdrawalTransaction({
        client,
        wallet: w,
        keys: LocalKeys.fromKeypair(identity.keypair, client.proofService),
        feePayer: p,
        owner: identity.keypair,
        recipient: recipient ? address(recipient) : p,
        asset: SOL_MINT,
        amount: lamports,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Wallet bridge
// ---------------------------------------------------------------------------

const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");

function u32Ix(tag: number, value: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = tag;
  new DataView(data.buffer).setUint32(1, value >>> 0, true);
  return { programAddress: COMPUTE_BUDGET, data };
}

function u64Ix(tag: number, value: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = tag;
  new DataView(data.buffer).setBigUint64(1, value, true);
  return { programAddress: COMPUTE_BUDGET, data };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface WalletReadyTx {
  /** The SDK's native version-1 wire transaction (unsigned). */
  readonly v1: Uint8Array;
  /**
   * The same instructions recompiled as a version-0 transaction with explicit
   * ComputeBudget instructions, which every wallet-adapter wallet understands.
   * null when it would not fit the 1232-byte legacy packet limit.
   */
  readonly v0: Uint8Array | null;
  readonly feePayer: string;
}

/**
 * The SDK always compiles version-1 transactions (config in the header). Most wallets
 * only sign legacy / v0, so we also produce an equivalent v0 transaction: same fee payer,
 * blockhash and instructions, with the header config turned into ComputeBudget ixs.
 * The program instructions (and any proof inside them) are untouched.
 */
export function toWalletTransaction(tx: Transaction): WalletReadyTx {
  const v1 = base64ToBytes(getBase64EncodedWireTransaction(tx));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const msg = decompileTransactionMessage(compiled) as unknown as {
    feePayer: { address: Address };
    lifetimeConstraint: { blockhash: string; lastValidBlockHeight: bigint };
    instructions: readonly Instruction[];
    config?: { computeUnitLimit?: number | bigint; loadedAccountsDataSizeLimit?: number | bigint; priorityFeeLamports?: number | bigint };
  };
  let v0: Uint8Array | null = null;
  try {
    const cfg = msg.config ?? {};
    const pre: Instruction[] = [];
    const cu = cfg.computeUnitLimit !== undefined ? Number(cfg.computeUnitLimit) : 0;
    if (cu > 0) pre.push(u32Ix(2, cu));
    if (cfg.priorityFeeLamports !== undefined && cu > 0 && BigInt(cfg.priorityFeeLamports) > BigInt(0)) {
      // v1 prices the whole tx in lamports; v0 prices per CU in micro-lamports.
      pre.push(u64Ix(3, (BigInt(cfg.priorityFeeLamports) * BigInt(1_000_000)) / BigInt(cu)));
    }
    if (cfg.loadedAccountsDataSizeLimit !== undefined) pre.push(u32Ix(4, Number(cfg.loadedAccountsDataSizeLimit)));
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(msg.feePayer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(msg.lifetimeConstraint as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0], m),
      (m) => appendTransactionMessageInstructions([...pre, ...msg.instructions], m),
    );
    const bytes = base64ToBytes(getBase64EncodedWireTransaction(compileTransaction(message)));
    v0 = bytes.length <= LEGACY_TX_MAX_BYTES ? bytes : null;
  } catch {
    v0 = null;
  }
  return { v1, v0, feePayer: String(msg.feePayer.address) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

/** Lamports from a decimal SOL string ("0.25"), exact (no float). null when invalid. */
export function parseSol(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d{0,9}(\.\d{0,9})?$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole || "0") * BigInt(1_000_000_000) + BigInt((frac + "000000000").slice(0, 9));
}

export function formatSol(lamports: bigint, digits = 4): string {
  const neg = lamports < BigInt(0);
  const abs = neg ? -lamports : lamports;
  const whole = abs / BigInt(1_000_000_000);
  const frac = (abs % BigInt(1_000_000_000)).toString().padStart(9, "0").slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}
