# Helius Privacy Rings in Stovia: feasibility note

Status: research plus client package (`packages/rings`). No transaction has been sent on any network. Anything marked **UNVERIFIED** has not been checked against a live endpoint.

Sources: helius.dev/docs/privacy (overview, endpoints, security, guides/transfer), GitHub `helius-labs/zolana-examples` (typescript-client, `escrow/timelock_escrow.md`, escrow README), and the type declarations of `@heliuslabs/spr@0.9.0-alpha`.

## TL;DR

- **The client side works as designed.** `@stovia/rings` builds unsigned deposit, private-transfer and withdraw transactions, and the user's wallet is the only signer. `tsc --noEmit` passes. An offline smoke test (no network) derived a keypair and round-tripped its address.
- **Escrow verdict: possible, but not trustless in our timeframe.** The protocol does support program-owned shielded UTXOs. A program PDA can own a UTXO, and SPP spends it only when that program `invoke_signed`s. `escrow/timelock_escrow.md` shows this. But doing it requires the Anchor program to become an **SPP ZK program**: its own circuits, its own trusted setup and its own audit. The official example says it is "Not for production" and uses insecure test keys. There is a second problem. The program cannot see bet amounts, so it cannot compute pro-rata payouts unless a circuit proves them.
- **Recommended for launch:** an operator-held market shielded identity, with payouts gated by the on-chain Anchor resolution. See "Recommended Stovia flow" below. The trust assumption must be disclosed.

## Endpoints (mainnet)

| Service | URL |
|---|---|
| Solana RPC | `https://mainnet.helius-rpc.com/?api-key=KEY` |
| Indexer (Photon) | `https://mainnet.helius-rpc.com/v1/spr/{method}?api-key=KEY` (the SDK routes it automatically) |
| Prover (attested TEE) | same host, under `/v1/spr`. The SDK verifies it with `SignedTeePolicy.forNetwork("mainnet")` |

- Helius labels these "Beta Endpoints".
- Our package infers the TEE policy from the host `mainnet.helius-rpc.com`.
- **Do not ship the API key to browsers.** Proxy it through `backend/`. **UNVERIFIED:** whether the `/v1/spr` prover path works through a reverse proxy.

Program IDs are the same on mainnet and devnet:

| Account | Address |
|---|---|
| Privacy program (SPP) | `ring1GaLCuJnkUMVkX2JeZLTTX17wKsV4fZmPVzXANW` |
| User registry | `regy3WAeRXMYuMYxr5iK3Bf9Arr3PcxGxyzAddbiqDQ` |
| State tree | `777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor` |
| SOL interface PDA | `CiNmas621VuyofiDSrEPfTXHKrdZuB6jMKECyNiMpLXE` |

## Real SDK API (0.9.0-alpha) and how we use it

The method names in the brief exist. The SDK also has a higher-level `wallet` layer, and the package uses that layer because it returns **compiled, unsigned `Transaction`s with a separate `feePayer`**:

| Wrapper function | SDK call |
|---|---|
| `createStoviaRings({ rpcUrl })` | `initializePoseidon()`, then `createSprClient({ solanaRpcUrl, proofDataSource: "prover", proverTee })` |
| `deriveShieldedIdentity(wallet)` | wallet `signMessage(fixed domain)` → sha256 → `SigningKey.fromEd25519Bytes` → `ShieldedKeypair.fromKeypair` |
| `shieldSol(wallet, lamports)` | `buildDepositTransaction({ feePayer, depositor, recipient: shieldedAddress, asset: SOL_MINT, amount, memo? })` |
| `sendSealedStake({ wallet, identity, marketShieldedAddress, lamports, memoCommitment })` | `syncWallet`, then `buildTransferTransaction({ ..., owner: keypair, recipient })` |
| `getShieldedBalance(identity)` | `syncWallet` + `getPrivateTokenBalances` |
| `withdrawSol({ wallet, identity, lamports, recipient? })` | `buildWithdrawalTransaction({ ..., owner: keypair })` |

The lower-level primitives also exist with the names in the brief:

- `depositInstruction`, `transactInstruction`, `DepositAsset`, `TransactWithdrawal` in `/interface`
- `ConfidentialTransfer`, `ProofInputUtxo`, `decryptToBalances`, `WithdrawalTarget`, `AssetRegistry` in `/transaction`
- `LocalKeys`, `SignedTeePolicy`, `atSlot` in `/client`

Differences from the brief:

1. **The shielded identity is not the wallet.** The SDK derives the nullifier and viewing keys from an Ed25519 *seed*, and wallet adapters never expose the seed. We therefore derive a deterministic identity from a wallet signature. Ed25519 signatures are deterministic, so the same wallet always recovers the same identity. The identity lives in memory only. Its owner key authorizes spends *inside the proof* (the SDK's `owner` param), so the wallet stays the only transaction signer. **Risks:**
   - Any site that gets the user to sign the same message can derive the identity. Mitigation: the message is domain-specific. Consider adding the origin to it.
   - Changing `SHIELDED_IDENTITY_MESSAGE` orphans every existing balance.
   - **UNVERIFIED:** that every wallet produces deterministic `signMessage` output. Ledger and some MPC wallets may not.
2. **`getShieldedBalance` takes an identity, not an address.** Balances are encrypted, and reading them needs the viewing key.
3. **Private transfers have no memo field in this API.** `memoCommitment` is checked to be 32 bytes. The caller then records it in the Anchor `commit_bet` ix, which is public anyway. Deposits do take a `memo`.
4. **The SDK is pinned to `0.9.0-alpha`.** The examples README says this release predates the deployed 1.0 programs' per-tree fee defaults and the `update_keys` registry data. **UNVERIFIED** against mainnet: send one tiny deposit/transfer/withdraw on devnet before mainnet. The examples use v1 transactions with `computeUnitLimit: 450_000`. **UNVERIFIED:** whether user wallets accept the v1 txs that the builders compile.

## What is hidden vs visible

| Action | Sender | Recipient | Asset | Amount |
|---|---|---|---|---|
| Deposit (public → private) | visible | visible (owner) | visible | **visible** |
| Default-ring transfer | visible | visible | hidden | hidden |
| Withdraw (private → public) | visible | visible | visible | **visible** |
| Custom *anonymous* ring | hidden (relayer) | hidden | hidden | hidden |

Custom rings are still being audited ("expected December 2026"), so we do not use them.

What this means for Stovia:

- A deposit right before a stake leaks the stake size through timing correlation. **Mitigation:** in the UI, encourage depositing a round amount ahead of time and staking smaller amounts later.
- The transfer reveals that wallet X bet on market M. The amount stays hidden, and so does the side, because of our commit-reveal.
- Payout withdrawals reveal winnings. If a winner keeps the payout shielded, it stays hidden.

## Fees and limits

- **Fees:** the four docs pages we read state none. The SDK has a `TreeFeeSchedule`, and the examples mention "per-tree fee defaults" in the 1.0 programs, so a protocol fee likely exists. **UNVERIFIED.** Budget for the normal Solana fee, a priority fee, and possibly an SPP tree fee.
- **Limits:** no min/max amounts or rate limits are documented. Proof shapes are fixed (inputs × outputs). The examples spend 1 input UTXO, so many small UTXOs may require merges first (the SDK has `buildMergeTransaction`). Prover latency per transfer is unknown (**UNVERIFIED**).
- **Security status:** Certora, OtterSec and zkSecurity audits of SPP and its circuits are listed. The trusted setup ran on 2026-11-02. The endpoints are still labelled beta.

## Can an Anchor PDA escrow a shielded balance?

What the docs and examples show (`escrow/timelock_escrow.md`):

- An SPP UTXO's owner can be a PDA: `owner_hash = Poseidon(solana_owner_identity(pda), Poseidon(0))`. The SDK exposes `ShieldedAddress.forPda({ pda, nullifierPublicKey, viewingPublicKey })`.
- SPP spends a PDA-owned UTXO only when the owning program signs the SPP `transact` CPI with `invoke_signed`. The example program "stores no state and owns no accounts". The funds live as leaves in the SPP tree.
- The owning program has to verify **its own Groth16 proof** binding the SPP transaction (`private_tx_hash`). Without that proof, SPP accepts any owner that signs.
- Whoever spends needs the UTXO preimage, including the blinding. The outputs are encrypted to the address's viewing key, so a Stovia operator or indexer holding that viewing key learns every bet amount.

Blockers for a trustless Stovia version:

1. We would need custom circuits for a payout like `winner_payout = stake * pool / winning_pool` over hidden amounts. That is a multi-input proof over every bet UTXO in the market. SPP's fixed small proof shapes make this a batched, multi-transaction design.
2. We would need our own trusted setup, verifying keys and an audit. The example is "Not for production" and its proofs can be forged.
3. Aggregating hidden amounts needs someone who can decrypt them: the viewing-key holder, or a TEE.

**Verdict:** a trustless shielded escrow is feasible in principle with this stack, but not within a hackathon. It is a separate engineering effort (Rust/Xark circuits, trusted setup, audit).

## Recommended Stovia flow (launch)

1. **Shield.** The user signs once to derive the identity (`deriveShieldedIdentity`), then `shieldSol` deposits a round amount. Encourage doing this ahead of time.
2. **Sealed stake.** Each market gets a **market shielded identity** held by the Stovia resolver. Ideally it runs in a TEE or is split across signers; at minimum it lives in a KMS-held key, never in the repo. The market's `ShieldedAddress` bytes are published in the Anchor market account. In one flow the user:
   - signs `sendSealedStake` (the private transfer to the market address), and
   - calls Anchor `commit_bet(commitment = H(side, salt, amount, transfer_sig))`.
   Including the amount in the commitment binds the hidden amount to the reveal.
3. **Reveal and resolve.** The user reveals `(side, salt, amount)` to the program. Amounts become visible at reveal unless that step is moved off-chain to the resolver. *Design choice:* reveal to the resolver only. The program then stores just the outcome and a Merkle root of payouts that the resolver posts. Users can verify their own leaf.
4. **Private payout.** The resolver decrypts the market's UTXOs, computes payouts, and sends winners **private transfers** from the market identity to each winner's shielded address. The payouts must match the posted root. Winners keep the funds shielded or `withdrawSol` them.
5. **Trust disclosure.** The resolver can see amounts and could misdirect funds before payout. Mitigations:
   - publish the payout root on chain before paying,
   - publish per-market totals,
   - put the resolver in a TEE,
   - plan the move to the PDA-owned ZK-program escrow described above.

## Next verification steps

- Run the package against **devnet** with an in-memory test identity funded from a devnet faucet: deposit, transfer, withdraw.
- Confirm the tree fees, the v1 transaction size and wallet compatibility.
- Measure prover latency.
- Confirm that the 0.9.0-alpha builders still work against the deployed 1.0 programs.
