// Helius Privacy Rings (SPR 0.9.0-alpha) access for market shielded identities.
// Mirrors packages/rings/src/index.ts. The fee payer is the company wallet (signs in the browser);
// the market identity authorizes spends inside the proof. Builders return compiled UNSIGNED txs.
import {
  SOL_MINT,
  ShieldedAddress,
  Wallet,
  buildTransferTransaction,
  buildWithdrawalTransaction,
  createSprClient,
  getPrivateTokenBalances,
  getPrivateTransactions,
  initializePoseidon,
  syncWallet,
} from "@heliuslabs/spr";
import { LocalKeys, SignedTeePolicy } from "@heliuslabs/spr/client";
import { AssetRegistry, LocalShieldedKeys } from "@heliuslabs/spr/transaction";
import { address } from "@solana/kit";

export { SOL_MINT };

export const heliusMainnetRpc = (apiKey) => `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;

function inferNetwork(url) {
  const host = new URL(url).hostname;
  if (host === "mainnet.helius-rpc.com") return "mainnet";
  if (host === "devnet.helius-rpc.com") return "devnet";
  return undefined;
}

export async function createRings({ rpcUrl, indexerUrl, proverUrl }) {
  await initializePoseidon();
  const network = inferNetwork(proverUrl ?? rpcUrl);
  const client = await createSprClient({
    solanaRpcUrl: rpcUrl,
    proofDataSource: "prover",
    ...(indexerUrl ? { indexerUrl } : {}),
    ...(proverUrl ? { proverUrl } : {}),
    ...(network ? { proverTee: SignedTeePolicy.forNetwork(network) } : {}),
  });
  const assets = new AssetRegistry();
  const wallets = new Map(); // market -> Wallet (in-memory; resyncs from the indexer after restart)
  const locks = new Map();

  // syncWallet must not run concurrently for the same wallet; serialize per market.
  function withLock(key, fn) {
    const prev = locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  }

  async function synced(identity) {
    return withLock(identity.market, async () => {
      let w = wallets.get(identity.market);
      if (!w) {
        w = new Wallet({ identity: identity.shieldedAddress, registry: assets });
        wallets.set(identity.market, w);
      }
      await syncWallet({ wallet: w, keys: LocalShieldedKeys.fromKeypair(identity.keypair), client, config: { pageLimit: 50 } });
      return w;
    });
  }

  /**
   * Sum of SOL the market identity received in `signature`, decrypted with the market viewing key.
   * Counts inbound private transfers only (a deposit straight to the market would reveal the amount
   * publicly and is rejected; so are self-transfers).
   */
  async function receivedInTx(identity, signature) {
    const w = await synced(identity);
    let total = 0n;
    let rows = 0;
    for (const tx of getPrivateTransactions(w)) {
      if (tx.id.signature !== signature) continue;
      if (tx.direction !== "inbound" || tx.kind !== "privateTransfer" || tx.asset !== SOL_MINT) continue;
      total += tx.amount;
      rows++;
    }
    return { amount: total, rows };
  }

  /** Outbound rows (payouts / withdrawals) the market identity made in `signature`. */
  async function outboundInTx(identity, signature) {
    const w = await synced(identity);
    return getPrivateTransactions(w)
      .filter((tx) => tx.id.signature === signature && tx.direction === "outbound" && tx.asset === SOL_MINT)
      .map((tx) => ({ kind: tx.kind, amount: tx.amount }));
  }

  async function balance(identity) {
    const w = await synced(identity);
    return getPrivateTokenBalances(w).find((b) => b.mint === SOL_MINT)?.amount ?? 0n;
  }

  function toDestination(dest) {
    if (dest instanceof Uint8Array) return ShieldedAddress.fromBytes(dest);
    return address(dest); // registered Solana address (user registry record)
  }

  /** Private transfer market identity -> recipient shielded address. Fee payer = company wallet. */
  async function buildPayout({ identity, feePayer, recipient, lamports }) {
    const w = await synced(identity);
    return buildTransferTransaction({
      client,
      wallet: w,
      keys: LocalKeys.fromKeypair(identity.keypair, client.proofService),
      feePayer: address(feePayer),
      owner: identity.keypair,
      recipient: toDestination(recipient),
      asset: SOL_MINT,
      amount: BigInt(lamports),
    });
  }

  /** Withdraw market identity -> public address (treasury sweep). Reveals amount + recipient. */
  async function buildWithdraw({ identity, feePayer, recipient, lamports }) {
    const w = await synced(identity);
    return buildWithdrawalTransaction({
      client,
      wallet: w,
      keys: LocalKeys.fromKeypair(identity.keypair, client.proofService),
      feePayer: address(feePayer),
      owner: identity.keypair,
      recipient: address(recipient),
      asset: SOL_MINT,
      amount: BigInt(lamports),
    });
  }

  return { client, receivedInTx, outboundInTx, balance, buildPayout, buildWithdraw };
}
