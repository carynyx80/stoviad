# Stovia resolver

The resolver is the whole survival-market engine. **There is no Stovia on-chain program** (it is not deployed). It is a self-contained Node 22 package and deploys as its own Railway service with root `resolver/`.

- **Tokens** launch on **Meteora Dynamic Bonding Curve** (program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`), built by the web app. Market id = DBC pool address.
- **Bets** are off-chain commit-reveal: the bettor's wallet signs `commitment = sha256(side_u8 ‖ salt ‖ bettor)` and `stakeCommitment = sha256(amount_le_u64 ‖ salt2 ‖ bettor)`. Commitments are public (`GET /markets/:m/commitments`).
- **Stakes** move privately as Helius Privacy Rings transfers to a per-market shielded identity derived from `RESOLVER_MASTER_SEED`. The ring hides asset and amount; sender and recipient stay visible.
- **Settlement** reads the token's market cap from the DBC pool every ~60 s and compares its TWAP (launch → deadline) against the creator's target.
- **Payouts** are claimed by winners: the resolver builds an unsigned Rings tx (proof made with the market identity, fee payer = winner); the winner signs and pays the fee.
- **Treasury**: leftovers after the 7-day claims window go to the company wallet via the admin queue.

## Survival market lifecycle

```
POST /launches ──► open ──deadline──► revealing ──deadline+24h──► survived|died ──+7d──► sweeping ──► done
                  (commit, stake,     (reveal, register stakes      (winners claim         (admin queue,
                   bond; mcap          whose transfer landed          with /claims/build)    company signs)
                   sampled ~60s)       before the deadline)
```

- **Launch** (`POST /launches`): the creator signs `stovia-launch:${pool}:${mint}:${targetMcapLamports}:${deadlineTs}`. The resolver checks: tweetnacl signature; pool account owner = DBC program and VirtualPool discriminator; `base_mint == mint`; `creator == creator`; the pool config's `quote_mint` is wSOL (mcap is measured in lamports); not migrated; deadline 1 h to 30 d ahead; target > current mcap. Idempotent.
- **Mcap** = `floor(sqrt_price² × mint.supply / 2¹²⁸)` lamports. `sqrt_price` is Q64.64 of quote-raw per base-raw, so decimals cancel. Decoded fields of `VirtualPool` (bytemuck, after the 8-byte discriminator `d5e005d16245775c`): `config` @72, `creator` @104, `base_mint` @136, `base_reserve` @232, `quote_reserve` @240, `sqrt_price` (u128) @280, `is_migrated` @305. `PoolConfig.quote_mint` @8. Supply from the SPL/Token-2022 mint @36.
- **TWAP**: step-hold integral `cum += lastMcap × dt`, `twap = cum / (deadline − launch)`. Gaps (worker down, RPC errors) hold the last value; post-deadline samples never count. **Migration**: when `is_migrated` flips, sampling stops and the last value is held to the deadline (DBC freezes `sqrt_price` at the graduation price). Reading the post-migration DAMM pool is not implemented.
- **Commit** (`POST /bets/commit`): before the deadline only, one per bettor per market, signature over `stovia-bet:${market}:${commitment}:${stakeCommitment}`.
- **Stake** (`POST /stakes/claim`): after one Rings transfer of `amount` to the market's shielded address. Checked: `sha256(amount‖salt2‖bettor)` equals the signed `stakeCommitment`; the bettor signed the tx; **the tx's blockTime ≤ deadline** (otherwise a bettor could fund only winning bets); the decrypted inbound amount equals `amount`; the tx is not reused. Accepted until reveal end.
- **Reveal** (`POST /bets/reveal`): deadline ≤ now < deadline+24 h; signature over `stovia-reveal:${market}:${side}:${salt}`; must match the commitment.
- **Bond** (`POST /launches/:market/bond`, optional): creator signs `stovia-bond:${market}:${amount}:${ringsTxSignature}`; same deposit checks as stakes. Survived → refunded to the creator. Died → added to the pool the NO winners share. Died with no NO winners → treasury.
- **Settlement** at reveal end: `survived = twap ≥ target`. Pools come from verified **and** revealed stakes only. Winner payout = `stake + floor(stake × (losing + bond_if_died) / winning)`. If the winning side is empty, valid losers are refunded. Unrevealed and unverified stakes, dust and unclaimed payouts are swept.
- **Claims** (`POST /claims/build` → sign → `POST /claims/submitted`): one in-flight claim per market (a "claim slot"). While held, the same winner gets the same cached tx bytes; others get `409 market_busy`. `/claims/submitted` only accepts the winner's signature over the exact message the resolver built, then verifies on-chain: confirmed, signed by the winner, market wallet shows an outbound row of exactly the payout. A slot is released only when paid, failed, or its blockhash expired (+150 blocks) **and** a fresh wallet sync shows no matching unattributed outbound row. If one exists, it is attributed and marked paid. So at most one payout can land per winner. With `shieldedAddress` (or a registered payout address) the payout is a private transfer. Otherwise it is a public withdrawal to the winner's wallet, which reveals the amount.
- **Treasury**: at `claimsCloseTs = revealEnds + 7 d` (claims stop 10 min earlier), unpaid payouts become `forfeited` and one `sweep` admin action withdraws the remaining balance to the company wallet. `RESOLVER_SEND_ENABLED` gates only this admin-queue step. Claims are always available.

## API (survival markets)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/launches` | creator sig | `{pool, mint, creator, name, symbol, uri, targetMcapLamports, deadlineTs, signature}` → 201 (200 if repeated) `{market, shieldedAddress (hex), shieldedAddressBase64, shieldedOwner, ...market view}` |
| POST | `/launches/:market/bond` | creator sig | `{amount, salt2?, ringsTxSignature, signature}` |
| GET | `/markets` | none | `{markets:[view]}`, filter `?status=open\|revealing\|survived\|died&creator=` |
| GET | `/markets/:market` | none | view + shielded address |
| GET | `/markets/:market/commitments` | none | public audit log: bettor, commitment, stakeCommitment, signature, committedTs; side and salt only after reveal |
| POST | `/bets/commit` | bettor sig | `{market, bettor, commitment, stakeCommitment, signature}` |
| POST | `/stakes/claim` | salt2 | `{market, bettor, amount, salt2, ringsTxSignature}` (425 = retry, 422 = mismatch) |
| POST | `/bets/reveal` | bettor sig | `{market, bettor, side, salt, signature}` |
| GET | `/portfolio/:wallet` | none | `{wallet, bets:[{...commitment, revealed, side, stakeVerified, payout, payoutStatus unpaid\|pending\|paid\|forfeited, payoutSignature}], launches:[view + bond]}` |
| GET | `/creators` | none | `{creators:[{creator, launches, survived, died, live, survivalRate}]}` |
| GET | `/stats` | none | counts, settled volume, paid out |
| POST | `/claims/build` | bettor sig over `stovia-claim:${market}` | `{market, bettor, shieldedAddress?, signature}` → `{amount, mode transfer\|withdraw, feePayer, transaction (base64 unsigned), lastValidBlockHeight, cached}` |
| POST | `/claims/submitted` | tx sig must match the built tx | `{market, bettor, signature}` → 200 `paid` / 202 `submitted\|failed` |

Market view fields: `market, pool, mint, name, symbol, uri, creator, targetMcapLamports, deadlineTs, revealEndsTs, createdTs, status (open|revealing|survived|died), phase, currentMcapLamports, lastSampleTs, twapMcapLamports, twapSamples, migrated, commitments, revealed, bondPosted, totals` (null until settled; then `survivePool, diePool, bond, bondToWinners, bondRefund, totalPayout, payoutCount, payoutRoot, settledTs, claimsCloseTs`). All u64 values are decimal strings.

## Legacy (program-based) design

The sections below describe the earlier design: a Stovia program with `commit_sealed_bet` / `post_sealed_results`, plus company-paid payouts. The program-reading code (`chain.getMarket/getSealedBet`, `idl.js`, `post_results`/`payout` admin action kinds) is still present but **unused** by the market flow. The trust model, key handling, admin auth and the action lifecycle still apply. The admin queue now carries only `sweep` actions.

## Two kinds of keys

| Key | Held by | Used for |
|---|---|---|
| `RESOLVER_MASTER_SEED` → per-market `ShieldedKeypair` | this service (env) | ZK spend and viewing keys: decrypting stakes, authorizing payouts and withdrawals **inside the Rings proof** |
| Company wallet `3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm` | the company, in a browser wallet. **This service never holds it.** | **Every** Solana signature: fee payer of every Rings tx, signer of `post_sealed_results` (it must equal `Config.resolver`), and recipient of treasury sweeps |

The resolver never signs or broadcasts a Solana transaction. Each step that needs a Solana signature becomes an **admin action**:

1. The resolver builds an UNSIGNED transaction with fee payer = company wallet. For Rings payouts and sweeps, it produces the proof server-side using the market identity.
2. An operator fetches it with `GET /admin/pending`, signs and sends it with the company wallet in the browser, and reports the signature with `POST /admin/submitted`.
3. The resolver verifies the result on-chain and only then advances the state machine.

## Trust model (read this first)

**The resolver custodies every sealed stake from the moment it is sent until it is paid out.** Spending a market's shielded funds needs two things:

- a proof authorized by that market's shielded key, which comes from `RESOLVER_MASTER_SEED`;
- a fee payer, which can be **any** Solana wallet. The fee payer is not an authorization.

So **whoever holds the master seed can drain every market**, even without the company wallet. That includes the operator, anyone who compromises the Railway service, and anyone who reads its env. The company wallet's key controls `post_sealed_results` (the on-chain commitment) but not the shielded funds themselves.

Who can see what:

| Data | Public chain observer | Resolver operator / admin | The bettor |
|---|---|---|---|
| That wallet X sent a private transfer to market M's shielded address | yes (default ring shows sender and recipient) | yes | yes |
| Stake amount | no | **yes** (decrypts with the market viewing key; the claim also discloses it) | yes |
| Bet side | after reveal (on-chain) | after reveal | yes |
| Per-market pool totals (`yes_total`, `no_total`) | yes, posted by `post_sealed_results` | yes | yes |
| Individual payout amounts | no (only the Merkle root is on-chain) | **yes** (shown in `/admin/pending`) | yes (own leaf) |
| Treasury sweep amount | **yes** (a withdrawal to a public address reveals the amount) | yes | n/a |
| A winner's withdrawal to public | yes | yes | yes |
| That the company wallet paid fees for market M's payouts | yes (fee payer is public) | yes | yes |

What the chain does constrain:

- `stake_commitment = sha256(amount_le_u64 ‖ salt2 ‖ bettor)` is recorded on-chain at commit time. A bettor can always prove their amount.
- `post_sealed_results` can only be signed by `Config.resolver` (the company wallet). It is init-once per market and runs after `settle_market`. It publishes the totals and the payout Merkle root before any payout is offered for signing. Leaf = `sha256(bettor ‖ payout_le_u64)`, with sorted-pair nodes. Each bettor can check their own leaf with `GET /markets/:m/payouts/:bettor`.

What it does **not** constrain:

- Nothing on-chain forces payouts to be sent, or stops a seed holder from moving stakes elsewhere.
- The resolver could refuse to verify a valid claim. The stake would then be excluded and swept. Such a dispute is publicly provable with `(amount, salt2, tx signature)`, but there is no on-chain remedy.
- Unrevealed stakes and stakes never claimed go to the company wallet. This is policy enforced by this code, not by the program.

Mitigations to adopt before real volume:

- Keep the master seed in a KMS or HSM, or run the resolver in a TEE.
- Split the seed across signers.
- Cap the size of each market.
- Publish an audit log.
- Plan the move to a PDA-owned SPP ZK-program escrow (see `docs/privacy-rings.md`).

## Flow

1. **Frontend gets the market address.** `GET /markets/:market/shielded-address` returns it. The address is deterministic: `HKDF-SHA256(master_seed, info="stovia-market:"+market)` → Ed25519 seed → `ShieldedKeypair`.
2. **Bettor stakes.** The bettor calls `commit_sealed_bet(commitment, stake_commitment)` and makes **one** private Rings transfer of `amount` lamports to that address, signed by the bettor's wallet.
3. **Bettor claims.** The bettor sends `POST /stakes/claim {market, bettor, amount, salt2, ringsTxSignature}`. The resolver checks all of the following:
   - The `SealedBet` PDA `["sealed_bet", market, bettor]` exists, and its `stake_commitment` equals `sha256(amount ‖ salt2 ‖ bettor)`.
   - The Rings tx signature is not already used by another stake.
   - The bettor signed the transaction. It is decoded as v1, which Rings txs are (verified live).
   - After syncing the market wallet through the SPR indexer and decrypting with the market viewing key, the inbound `privateTransfer` SOL rows for that signature sum to exactly `amount`.
4. **Bettor registers a payout address (optional).** `POST /payout-address {bettor, shieldedAddress(hex), signature}`. The signature is the bettor's Ed25519 signature over `"Stovia payout address v1\nbettor:<bettor>\naddress:<hex>"`. The fallback is the bettor's pubkey, resolved through the SPR user registry.
5. **Worker settles.** The worker runs every `WORKER_INTERVAL_MS`. Each market goes through a persisted state machine:
   ```
   computing → computed ──[RESOLVER_SEND_ENABLED]──► awaiting_post_signature → paying → sweeping → done   (or halted)
   ```
   - **computed:** claims are frozen. Pools come from **verified and revealed** stakes. Each winner gets `stake + floor(stake × losing / winning)`. If the winning side is empty, valid losers are refunded. The bond stays in the public program path. The dry run (the default) stops here and creates no actions.
   - **awaiting_post_signature:** after a solvency check (shielded balance ≥ total payouts), one `post_results` action is created. The state advances once `SealedResults` is on-chain with the computed root, even if it was signed outside the admin flow. A different root halts the market.
   - **paying:** one `payout` action per winner, exposed **one at a time** per market. The SDK wallet does not reserve UTXOs across unconfirmed txs.
   - **sweeping:** one `sweep` action withdraws the remaining balance (unrevealed stakes, unclaimed stakes, rounding dust) to the company wallet. Nothing is created if the balance is 0.

### Admin actions and crash safety

- **Action lifecycle:** each action is a stored doc that moves `pending → submitted → confirmed`. If its tx failed, landed without the expected effect, or was never seen within 3 minutes (the blockhash has expired by then), it goes back to `pending`. After 5 attempts it becomes `stuck` and the market halts for manual review.
- **Blockhash expiry: transactions are rebuilt on every `GET /admin/pending`.** Each call fetches a fresh blockhash and, for Rings actions, produces a fresh proof. Sign promptly after fetching. Every GET for a Rings action calls the prover, so expect a few seconds of latency per action.
- **Signing two rebuilds of one action is safe.** Every rebuild spends the same thing: `post_sealed_results` is init-once, and a Rings payout or withdrawal spends the same input UTXO nullifiers while the market wallet is unchanged. At most one version can land.
- **Confirmation is verified on-chain, not trusted from the caller.** The tx must succeed and be signed by the company wallet. On top of that:
  - for `post_results`, `SealedResults` must exist with the computed root;
  - for `payout`, the market wallet must show an outbound `privateTransfer` of exactly the payout amount in that tx;
  - for `sweep`, an outbound `publicWithdrawal` in that tx.
- **Restart-safe.** All state lives in the store. A restart picks up submitted signatures and re-checks them.

## HTTP API

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | `{ok, store, sendEnabled, companyWallet, ringsReady}` |
| GET | `/markets/:market/shielded-address` | none | deterministic public address; starts tracking the market |
| POST | `/stakes/claim` | none (salt2 is the secret) | 201 on success, 200 on an idempotent repeat. 425 means not indexed yet, retry. 422 means a mismatch. 409 means a conflict or frozen results. |
| POST | `/payout-address` | bettor signature | see above |
| GET | `/markets/:market/results` | none | state, totals, root, post signature |
| GET | `/markets/:market/payouts/:bettor?signature=` | bettor signature over `"Stovia results v1\nmarket:<m>\nbettor:<b>"` | own payout, status, tx signature, Merkle proof |
| GET | `/admin/nonce` | none | `{nonce, message: "stovia-admin:<nonce>", expiresAt}` |
| GET | `/admin/pending` | admin | `{feePayer, actions:[{id, kind, market, bettor, amount, summary, transaction (base64 unsigned wire tx), lastValidBlockHeight, attempts, lastError}]}` |
| POST | `/admin/submitted` | admin | body `{actionId, signature}`. Returns `{status: confirmed \| submitted \| pending \| stuck}` |

**Admin auth.** No static passwords. The client calls `GET /admin/nonce`, has the company wallet `signMessage("stovia-admin:<nonce>")`, and sends two headers: `x-admin-nonce: <nonce>` and `x-admin-signature: <base58 64-byte signature>`. The server verifies with tweetnacl against the company wallet pubkey. Nonces are single-use (consumed even by a failed attempt), expire after 5 minutes, and are held in memory, so a restart invalidates outstanding nonces. Each admin request needs its own nonce.

## Env

See `.env.example`.

- **Secrets:** `RESOLVER_MASTER_SEED` (32-byte hex) and `HELIUS_API_KEY`. There is **no Solana signer secret.**
- **Storage:** `DATABASE_URL` (Postgres; a single table `resolver_docs` is auto-created). Without it the service runs in memory, which is dev only.
- **Behaviour:** `RESOLVER_SEND_ENABLED` (default `false`; when true, treasury-sweep admin actions are created; claims never depend on it). `DBC_PROGRAM_ID` override.
- **Optional:** `COMPANY_WALLET` override.

Secrets are removed from `process.env` after they are loaded. They are never logged or returned. Request bodies are redacted from logs.

## Run and test

```bash
npm install
npm test                                # offline: 29 tests
npm run check:dbc [pool]                # read-only: decode a live DBC pool + mcap
HELIUS_API_KEY=... npm run check:live   # read-only mainnet checks; sends nothing
RESOLVER_MASTER_SEED=$(openssl rand -hex 32) npm start
```

The IDL is copied into `idl/stovia.json` because this service must not read `../target`. After every program change, re-copy it with `cp ../target/idl/stovia.json idl/`.

## Railway

- `railway.json`: Nixpacks, `node src/index.js`, healthcheck `/health`, **1 replica**. The worker and the admin nonces are single-instance.
- Set the root directory to `resolver/`.
- Add Postgres and set its URL as `DATABASE_URL`.

## Known gaps and risks

- **Custody.** The master seed controls every market's stakes until they are paid. There is no on-chain escrow. The settlement outcome, the commitments and the payout rules are enforced by this code. They are publicly auditable (signed commitments, reveals, payout root, TWAP inputs from chain), but nothing on-chain enforces them.
- **Mcap manipulation.** The TWAP over the whole market life dilutes short spikes. But a creator or whale can buy the curve up and hold it (buys add real SOL to the pool, so this costs money and is exposed to sells). Supply is the full mint supply, including curve-locked tokens, as DBC and the launchpads do. DBC price manipulation by wash trading costs fees. Large bets vs thin curves are the main risk; cap bet size relative to curve liquidity before real volume.
- **Migration.** After graduation the held DBC price is used. The real DAMM price may diverge.
- **Bettor-paid claims are unverified live.** Building a Rings transfer/withdrawal whose fee payer differs from the shielded owner (the winner as fee payer) is not verified, and neither is the history-row `direction`/`kind` for withdrawals.
- **Public portfolio.** `GET /portfolio/:wallet` shows payout amounts after settlement (no auth), which reveals stake sizes for winners.
- **Slot liveness.** One in-flight claim per market. A winner who builds and never signs blocks others for about 2 minutes (blockhash expiry + margin).


- **SDK pinned at `@heliuslabs/spr@0.9.0-alpha`, endpoints in beta.**
  - Verified live (read-only): indexer wallet sync for a derived identity; Rings txs are v1; the bettor-signer check on a real Rings tx; an unsigned `post_sealed_results` built with a live blockhash has exactly one empty signer slot, the company wallet.
  - **Not verified:** an actual inbound transfer, the history-row `direction`/`kind` classification, building payouts and withdrawals through the TEE prover with a fee payer different from the shielded owner, browser wallets accepting v1 txs, and tree fees. Do one tiny end-to-end run before announcing.
- **Fees.** An SPP tree fee taken from the shielded balance would make the full-balance sweep or the last payout fail. The action would retry and then become stuck.
- **UTXO fan-in.** Many small notes may exceed the proof input count. A merge step is not implemented.
- **Claim/compute race.** There is a window of milliseconds in which a claim can land just after results start computing. That stake is swept rather than paid.
- **Payout timing is public.** Sequential transfers from the market address, paid for by the company wallet, are visible on-chain.
- **One stake per bettor per market, in a single transfer.**
