/**
 * Private stake + claim-tx helpers on top of lib/rings. HEAVY (pulls in the SPR SDK):
 * load only with `await import("@/lib/markets/stake")`.
 *
 * Nothing here signs or sends. Builders return wallet-ready bytes; the caller hands
 * them to the connected wallet (lib/markets/wallet-tx).
 */
import { SOL_MINT, ShieldedAddress, Wallet, buildTransferTransaction, syncWallet } from "@heliuslabs/spr";
import { LocalKeys } from "@heliuslabs/spr/client";
import { AssetRegistry, LocalShieldedKeys } from "@heliuslabs/spr/transaction";
import { address, getTransactionDecoder } from "@solana/kit";
import { createStoviaRings, toWalletTransaction, formatSol, parseSol, type ShieldedIdentity, type StoviaRings } from "@/lib/rings";
import { API_URL } from "@/lib/config";
import { hexToBytes } from "./crypto";

export { formatSol, parseSol };
export type { ShieldedIdentity, StoviaRings };

let ringsPromise: Promise<StoviaRings> | null = null;
export function loadRings(): Promise<StoviaRings> {
  ringsPromise ??= createStoviaRings(API_URL).catch((err) => {
    ringsPromise = null;
    throw err;
  });
  return ringsPromise;
}

/** Wire bytes ready for a wallet: v0 when it fits, else the raw v1 (needs a v1-capable wallet). */
export type PreparedTx = { v0: Uint8Array | null; v1: Uint8Array | null };

export async function prepareShield(identity: ShieldedIdentity, payer: string, lamports: bigint): Promise<PreparedTx> {
  const rings = await loadRings();
  const ready = toWalletTransaction(await rings.shieldSol({ payer, identity, lamports }));
  return { v0: ready.v0, v1: ready.v1 };
}

/**
 * Private Rings transfer of `lamports` from the bettor's shielded balance to the market's
 * shielded address (resolver-provided hex wire form). The shielded owner authorizes inside
 * the proof, so the connected wallet is the only transaction signer (fee payer).
 */
export async function preparePrivateStake(input: { identity: ShieldedIdentity; payer: string; marketShieldedAddressHex: string; lamports: bigint }): Promise<PreparedTx> {
  const rings = await loadRings();
  const client = rings.client;
  let recipient: ShieldedAddress;
  try {
    recipient = ShieldedAddress.fromBytes(hexToBytes(input.marketShieldedAddressHex));
  } catch {
    throw new Error("The market's shielded address is malformed. Please try again later.");
  }
  const wallet = new Wallet({ identity: input.identity.shieldedAddress, registry: new AssetRegistry() });
  await syncWallet({ wallet, keys: LocalShieldedKeys.fromKeypair(input.identity.keypair), client, config: { pageLimit: 50 } });
  const tx = await buildTransferTransaction({
    client,
    wallet,
    keys: LocalKeys.fromKeypair(input.identity.keypair, client.proofService),
    feePayer: address(input.payer),
    owner: input.identity.keypair,
    recipient,
    asset: SOL_MINT,
    amount: input.lamports,
  });
  const ready = toWalletTransaction(tx);
  return { v0: ready.v0, v1: ready.v1 };
}

/**
 * Resolver claim tx (base64; legacy, v0 or v1). v1 with a single signer (us) is recompiled
 * to v0; v1 that needs other signers is kept raw (converting would break their signatures).
 * Legacy/v0 bytes are returned as-is in `v0` (VersionedTransaction.deserialize handles both).
 */
export function prepareResolverTx(b64: string): PreparedTx {
  const bin = atob(b64.replace(/\s+/g, ""));
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  if (raw[0] !== 0x81) return { v0: raw, v1: null };
  const tx = getTransactionDecoder().decode(raw);
  const signers = Object.keys(tx.signatures);
  if (signers.length > 1) return { v0: null, v1: raw };
  const ready = toWalletTransaction(tx);
  return { v0: ready.v0, v1: raw };
}
