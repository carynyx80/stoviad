/**
 * Hand prepared wire bytes to the connected wallet, send via our RPC connection, and wait
 * for confirmation. Only runs from an explicit user click; the wallet always prompts.
 */
import { VersionedTransaction, type Connection } from "@solana/web3.js";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { PreparedTx } from "./stake";

type WalletBits = Pick<WalletContextState, "publicKey" | "wallet" | "signTransaction" | "sendTransaction">;

export async function signAndSend(
  prepared: PreparedTx,
  w: WalletBits,
  connection: Connection,
  onStep?: (step: "signing" | "sending" | "confirming", signature?: string) => void,
): Promise<string> {
  const { publicKey, signTransaction, sendTransaction, wallet } = w;
  if (!publicKey) throw new Error("Wallet disconnected.");
  let signature: string;
  onStep?.("signing");
  if (prepared.v0) {
    const vtx = VersionedTransaction.deserialize(prepared.v0);
    if (signTransaction) {
      const signed = await signTransaction(vtx);
      onStep?.("sending");
      signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 3 });
    } else {
      onStep?.("sending");
      signature = await sendTransaction(vtx, connection, { preflightCommitment: "confirmed", maxRetries: 3 });
    }
  } else if (prepared.v1) {
    type StdAccount = { address: string };
    type StdSign = {
      supportedTransactionVersions?: readonly (number | string)[];
      signTransaction: (...i: { account: StdAccount; transaction: Uint8Array; chain: string }[]) => Promise<{ signedTransaction: Uint8Array }[]>;
    };
    const std = (wallet?.adapter as unknown as { wallet?: { accounts: readonly StdAccount[]; features: Record<string, unknown> } })?.wallet;
    const feature = std?.features["solana:signTransaction"] as StdSign | undefined;
    const account = std?.accounts.find((a) => a.address === publicKey.toBase58());
    const v1ok = feature?.supportedTransactionVersions?.some((v) => String(v) === "1");
    if (!feature || !account || !v1ok) {
      throw new Error("This transaction needs a wallet that supports Solana version-1 transactions. Update Phantom or Solflare and try again.");
    }
    const [out] = await feature.signTransaction({ account, transaction: prepared.v1, chain: "solana:mainnet" });
    onStep?.("sending");
    signature = await connection.sendRawTransaction(out.signedTransaction, { preflightCommitment: "confirmed", maxRetries: 3 });
  } else {
    throw new Error("Nothing to sign.");
  }
  onStep?.("confirming", signature);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st?.err) throw Object.assign(new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)}`), { signature });
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return signature;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw Object.assign(new Error("Not confirmed after 90s. Check Solscan before retrying."), { signature });
}

export function errMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: { message?: string; code?: string } } | undefined;
  const raw = `${e?.code ?? ""} ${e?.message ?? ""} ${e?.cause?.code ?? ""} ${e?.cause?.message ?? ""}`;
  if (/reject|declin|cancel/i.test(raw)) return "You declined the request in your wallet.";
  if (/INSUFFICIENT_BALANCE/i.test(raw)) return "Not enough shielded SOL for that amount. Shield more SOL first.";
  if (/insufficient (funds|lamports)|AccountNotFound|0x1\b/i.test(raw)) return "Not enough SOL in your wallet to cover the amount plus network fees.";
  if (/blockhash|expired/i.test(raw)) return "The transaction expired before it landed. Please try again.";
  if (e?.name === "ResolverError") return (e.message || "The resolver rejected the request.").slice(0, 240);
  if (/fetch|network|unavailable|timeout|503|502|504/i.test(raw)) return "The network didn't answer. Please try again in a moment.";
  return (e?.message || "Something went wrong.").slice(0, 240);
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
