/**
 * @stovia/rings — Helius Privacy Rings (Solana Privacy Rings / "SPR") client for Stovia.
 *
 * Wraps `@heliuslabs/spr@0.9.0-alpha`. Every builder returns an UNSIGNED, compiled
 * `@solana/kit` Transaction whose fee payer is the user's wallet. The app hands it to
 * the wallet adapter (`signTransaction`) and sends it. This package never signs with
 * stored keys and never sends anything itself.
 *
 * Shielded identity: a browser wallet cannot export its Ed25519 seed, and the SDK
 * derives the private wallet (nullifier + viewing keys) from an Ed25519 seed. So we
 * derive a separate, deterministic shielded identity from a wallet `signMessage` over
 * a fixed domain string (Ed25519 signatures are deterministic, so the same wallet
 * always recovers the same identity). It lives only in memory for the session.
 * The shielded owner authorizes spends INSIDE the proof (`owner` param of the SDK
 * builders), so the only transaction signer is the user's wallet (fee payer).
 */
import {
  SOL_MINT,
  ShieldedAddress,
  ShieldedKeypair,
  SigningKey,
  Wallet,
  buildDepositTransaction,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  createSprClient,
  getPrivateTokenBalances,
  initializePoseidon,
  syncWallet,
  type Bytes32,
  type SprClientConfig,
} from "@heliuslabs/spr";
import { LocalKeys, SignedTeePolicy } from "@heliuslabs/spr/client";

export type SprClient = Awaited<ReturnType<typeof createSprClient>>;
import { AssetRegistry, LocalShieldedKeys } from "@heliuslabs/spr/transaction";
import { address, type Address, type Transaction } from "@solana/kit";

// ---------------------------------------------------------------------------
// Constants (identical on mainnet and devnet per helius.dev/docs/privacy)
// ---------------------------------------------------------------------------

export const PRIVACY_PROGRAM_ID = address("ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW");
export const USER_REGISTRY_PROGRAM_ID = address("regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ");
export const STATE_TREE = address("777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor");
export const SOL_INTERFACE_PDA = address("CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE");
export { SOL_MINT };

/** Mainnet: one Helius endpoint serves Solana RPC; the SDK routes indexer + TEE prover via `/v1/spr`. */
export const heliusMainnetRpc = (apiKey: string): string =>
  `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
export const heliusDevnetRpc = (apiKey: string): string =>
  `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;

/** Domain string the wallet signs to derive the shielded identity. Changing it changes every user's identity. */
export const SHIELDED_IDENTITY_MESSAGE =
  "Stovia shielded identity v1\n\nSign to unlock your private balance. This does not send a transaction.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal wallet-adapter surface (works with @solana/wallet-adapter and wallet-standard). */
export interface WalletLike {
  readonly address: Address | string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface StoviaRingsOptions {
  /** Helius RPC URL incl. api key, e.g. heliusMainnetRpc(key). Never ship the key to browsers; proxy it. */
  readonly rpcUrl: string;
  /** Network for the signed TEE prover policy. Inferred from the host when omitted. */
  readonly network?: "mainnet" | "devnet";
  /** Optional overrides (local stacks). */
  readonly indexerUrl?: string;
  readonly proverUrl?: string;
}

/** A user's in-memory shielded identity. Never persist `keypair`. */
export interface ShieldedIdentity {
  readonly keypair: ShieldedKeypair;
  readonly shieldedAddress: ShieldedAddress;
  /** 99-byte wire form (signing || nullifier || viewing pubkeys), safe to publish/store (no secrets). */
  readonly shieldedAddressBytes: Uint8Array;
  /** The Solana address the shielded owner key maps to (NOT the user's wallet). */
  readonly ownerSolanaAddress: Address;
}

export interface StoviaRings {
  readonly client: SprClient;
  deriveShieldedIdentity(wallet: WalletLike): Promise<ShieldedIdentity>;
  shieldSol(wallet: WalletLike, lamports: bigint, opts?: { identity?: ShieldedIdentity; memo?: Uint8Array }): Promise<Transaction>;
  sendSealedStake(input: SendSealedStakeInput): Promise<Transaction>;
  getShieldedBalance(identity: ShieldedIdentity): Promise<bigint>;
  withdrawSol(input: WithdrawSolInput): Promise<Transaction>;
}

export interface SendSealedStakeInput {
  /** User wallet: fee payer and only transaction signer. */
  readonly wallet: WalletLike;
  readonly identity: ShieldedIdentity;
  /** Market escrow's shielded address (wire bytes, ShieldedAddress, or a registered Solana address). */
  readonly marketShieldedAddress: Uint8Array | ShieldedAddress | Address;
  readonly lamports: bigint;
  /**
   * Commit-reveal commitment (32 bytes) from the Stovia Anchor program. NOT embedded in the
   * private transfer (SPR transfers carry no memo field in 0.9.0-alpha). Returned unchanged so
   * the caller records it in the Anchor `commit_bet` ix, keyed by the transfer signature.
   */
  readonly memoCommitment: Uint8Array;
}

export interface WithdrawSolInput {
  readonly wallet: WalletLike;
  readonly identity: ShieldedIdentity;
  readonly lamports: bigint;
  /** Public destination; defaults to the wallet. Withdrawals reveal recipient + amount. */
  readonly recipient?: Address;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function inferNetwork(url: string): "mainnet" | "devnet" | undefined {
  const host = new URL(url).hostname;
  if (host === "mainnet.helius-rpc.com") return "mainnet";
  if (host === "devnet.helius-rpc.com") return "devnet";
  return undefined;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

function toShieldedDestination(dest: Uint8Array | ShieldedAddress | Address): ShieldedAddress | Address {
  if (dest instanceof Uint8Array) return ShieldedAddress.fromBytes(dest);
  return dest;
}

export async function createStoviaRings(opts: StoviaRingsOptions): Promise<StoviaRings> {
  await initializePoseidon();
  const network = opts.network ?? inferNetwork(opts.proverUrl ?? opts.rpcUrl);
  const config: SprClientConfig = {
    solanaRpcUrl: opts.rpcUrl,
    proofDataSource: "prover",
    ...(opts.indexerUrl ? { indexerUrl: opts.indexerUrl } : {}),
    ...(opts.proverUrl ? { proverUrl: opts.proverUrl } : {}),
    ...(network ? { proverTee: SignedTeePolicy.forNetwork(network) } : {}),
  };
  const client = await createSprClient(config);
  const assets = new AssetRegistry();
  const wallets = new WeakMap<ShieldedKeypair, Wallet>();

  async function syncedWallet(identity: ShieldedIdentity): Promise<Wallet> {
    let w = wallets.get(identity.keypair);
    if (!w) {
      w = new Wallet({ identity: identity.shieldedAddress, registry: assets });
      wallets.set(identity.keypair, w);
    }
    await syncWallet({
      wallet: w,
      keys: LocalShieldedKeys.fromKeypair(identity.keypair),
      client,
      config: { pageLimit: 50 },
    });
    return w;
  }

  async function deriveShieldedIdentity(wallet: WalletLike): Promise<ShieldedIdentity> {
    const sig = await wallet.signMessage(new TextEncoder().encode(SHIELDED_IDENTITY_MESSAGE));
    const seed = await sha256(sig);
    try {
      const keypair = ShieldedKeypair.fromKeypair(SigningKey.fromEd25519Bytes(seed as Bytes32));
      const shieldedAddress = keypair.shieldedAddress();
      return {
        keypair,
        shieldedAddress,
        shieldedAddressBytes: shieldedAddress.toBytes(),
        ownerSolanaAddress: shieldedAddress.solanaAddress(),
      };
    } finally {
      seed.fill(0);
      sig.fill(0);
    }
  }

  /** Public SOL -> the user's private balance. Reveals depositor, recipient owner, amount. */
  async function shieldSol(
    wallet: WalletLike,
    lamports: bigint,
    o: { identity?: ShieldedIdentity; memo?: Uint8Array } = {},
  ): Promise<Transaction> {
    const identity = o.identity ?? (await deriveShieldedIdentity(wallet));
    const payer = address(String(wallet.address));
    return buildDepositTransaction({
      client,
      feePayer: payer,
      depositor: payer,
      recipient: identity.shieldedAddress,
      asset: SOL_MINT,
      amount: lamports,
      ...(o.memo ? { memo: o.memo } : {}),
    });
  }

  /** Private SOL transfer: user's shielded balance -> market escrow's shielded address. Hides amount + asset. */
  async function sendSealedStake(input: SendSealedStakeInput): Promise<Transaction> {
    if (input.memoCommitment.length !== 32) throw new Error("memoCommitment must be 32 bytes");
    const w = await syncedWallet(input.identity);
    return buildTransferTransaction({
      client,
      wallet: w,
      keys: LocalKeys.fromKeypair(input.identity.keypair, client.proofService),
      feePayer: address(String(input.wallet.address)),
      owner: input.identity.keypair, // authorize inside the proof; wallet is the only tx signer
      recipient: toShieldedDestination(input.marketShieldedAddress),
      asset: SOL_MINT,
      amount: input.lamports,
    });
  }

  /** Sum of decrypted SOL UTXOs. Requires the viewing key, so it takes an identity, not a bare address. */
  async function getShieldedBalance(identity: ShieldedIdentity): Promise<bigint> {
    const w = await syncedWallet(identity);
    return getPrivateTokenBalances(w).find((b) => b.mint === SOL_MINT)?.amount ?? 0n;
  }

  /** Private -> public SOL. Reveals recipient and amount. */
  async function withdrawSol(input: WithdrawSolInput): Promise<Transaction> {
    const w = await syncedWallet(input.identity);
    const payer = address(String(input.wallet.address));
    return buildWithdrawalTransaction({
      client,
      wallet: w,
      keys: LocalKeys.fromKeypair(input.identity.keypair, client.proofService),
      feePayer: payer,
      owner: input.identity.keypair,
      recipient: input.recipient ?? payer,
      asset: SOL_MINT,
      amount: input.lamports,
    });
  }

  return { client, deriveShieldedIdentity, shieldSol, sendSealedStake, getShieldedBalance, withdrawSol };
}
