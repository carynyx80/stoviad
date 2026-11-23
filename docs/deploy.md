# Deploying Stovia to Solana mainnet

Nothing has been deployed yet. The scripts were rehearsed end to end on a local `solana-test-validator` only, never on mainnet.

**One wallet does everything.** The company wallet `3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm` pays for and signs the deploy. It is the upgrade authority from the very first instruction, and it is admin, treasury and resolver in Config. There is no separate deployer wallet, no authority hand-over and no `accept_admin` step.

| Role | Address |
|---|---|
| Program ID (`keys/stovia-program-keypair.json`: the program's *address* keypair, not a wallet) | `6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8` |
| Company wallet: fee payer, upgrade authority, admin, treasury, resolver | `3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm` |
| Config PDA (`seeds = ["config"]`) | `DHGxfvpS3pXeVCzJDWpWvYfPJrPNbmqrbMSk4xGT86kD` |
| ProgramData | `HKjG8FRNrLyRR3s1YZjh5evCBT7PqPZ9xumGNn36nV6h` |

The same addresses are in `packages/config/stovia.json` (`companyWallet`, `admin`, `resolver`). IDL: `target/idl/stovia.json`.

## SOL cost (all paid by the company wallet)

Measured from the current build: `target/deploy/stovia.so` is 587,592 bytes, SBPFv3. Rent comes from `solana rent` on mainnet, 2026-11-23. The script recomputes all of this live on every run.

| Item | SOL | Notes |
|---|---|---|
| ProgramData rent (587,592 + 45 bytes) | 2.985846 | permanent |
| Program account rent (36 bytes) | 0.000833 | permanent |
| Config rent (150 bytes) | 0.001412 | permanent |
| Deploy buffer rent | 2.985806 | **temporary**: refunded when the deploy finalizes |
| Tx fees, ~593 txs at `--cu-price 100000` | ≤ 0.0149 | worst case, 200k CU limit per tx |
| Safety margin | 0.05 | retries and re-signing |
| **Peak balance needed** | **≈ 6.04 SOL** | about 3.03 SOL comes back after the deploy |
| **Net spend** | **≈ 3.0 SOL** | 2.988 SOL stays locked as rent |

On 2026-11-23 the company wallet held **0.010650 SOL**, so the shortfall is **≈ 6.03 SOL**.

## How the company wallet can sign

`solana program deploy` writes the program in ~590 transactions, and the fee payer and upgrade authority must sign them. It needs a **CLI signer**: a keypair file or a Ledger. **Phantom (or any browser wallet) cannot sign a program deploy.** Your options:

**(a) Export the company keypair to a file on your own machine (most practical).**
- If 3aeV… lives in Phantom, recover it locally from its secret recovery phrase. The command prompts for the phrase, so it never lands in shell history:
  ```bash
  solana-keygen recover 'prompt://?key=0/0' -o ~/.config/solana/stovia-company.json
  solana-keygen pubkey ~/.config/solana/stovia-company.json   # must print 3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm
  ```
  `key=0/0` matches Phantom's first account. If it prints another address, try `key=1/0`, `key=2/0`, and so on.
- Keep the file **outside this repo**; the script refuses a keypair path inside the repo on mainnet.
- After the deploy, delete it or move it to offline storage. The company stays upgrade authority, so you will need it again for future upgrades.

**(b) Ledger via `--keypair 'usb://ledger?key=N'`.**
- Works with the Solana CLI. However, the Ledger is then the fee payer of all ~590 write transactions, so expect to approve each one on the device. That is impractical, but possible.
- `initialize_config` cannot be signed from Node with a Ledger. The script prints it as an unsigned tx instead (see `--print-tx`).

**(c) Squads multisig.**
- With Squads, the upgrade authority would be the Squads *vault* address, not 3aeV…. So this only fits if you decide to make a vault the authority, which changes the plan above.
- The scripts do not automate Squads.

> **Never paste a private key or seed phrase into a chat, an issue, a web form, or this repo.** We never have the company key; you run the commands below on your machine.

## Steps (run these yourself)

1. **Fund** `3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm` with at least **6.05 SOL**. The dry run prints the exact shortfall.
2. **Dry run.** This is read-only and sends nothing. It checks the RPC is mainnet, verifies that the signer equals the company wallet, the program keypair matches `declare_id!`, and the program is not already deployed. Then it prices the deploy against the company balance:
   ```bash
   scripts/deploy-mainnet.sh --dry-run --keypair ~/.config/solana/stovia-company.json
   ```
   You can leave out `--keypair` in a dry run only. The signer check is then skipped, and `initialize_config` is shown as an unsigned tx.
3. **Deploy.** It asks you to type `deploy`. A paid RPC is more reliable than the public one:
   ```bash
   scripts/deploy-mainnet.sh --keypair ~/.config/solana/stovia-company.json \
     --url 'https://mainnet.helius-rpc.com/?api-key=…' --cu-price 100000
   # Ledger instead:  --keypair 'usb://ledger?key=0'
   ```
   The script then runs these in order:
   1. Build (`anchor build`, SBPFv3). Pass `--skip-build` to reuse `target/deploy/stovia.so`.
   2. `solana program deploy --program-id keys/stovia-program-keypair.json target/deploy/stovia.so --keypair <company> --upgrade-authority <company> --with-compute-unit-price N --use-rpc --max-sign-attempts 50`
   3. A check that the on-chain upgrade authority is the company wallet; it aborts otherwise.
   4. `post-deploy.mjs init`: the company signs `initialize_config(treasury=company, 10 bps, 10 bps, pending_admin=None, resolver=company)`. The signer becomes admin.
   5. `post-deploy.mjs status --strict`.
   - If the deploy dies midway, run `solana program close --buffers -um --keypair <company>` to recover the buffer rent, or resume with the buffer seed phrase the CLI prints.
4. **Verify** at any time:
   ```bash
   node scripts/post-deploy.mjs status --url https://api.mainnet-beta.solana.com --strict
   ```
   It exits 0 only when upgrade authority, admin, treasury and resolver are all 3aeV…, pending_admin is none and fees are 10/10.

### `--print-tx` (for wallets that cannot be used from the CLI)

Every on-chain step in `post-deploy.mjs` (`init`, and the optional `accept-admin`) accepts `--print-tx`. It prints an **unsigned base64 legacy transaction** whose fee payer and sole signer is the company wallet. Sign it with a tool that accepts a raw serialized Solana transaction, then broadcast it within about 60 s, before the blockhash expires. If you miss the window, re-run to get a fresh one.

```bash
node scripts/post-deploy.mjs init --url https://api.mainnet-beta.solana.com --print-tx
```

The deploy itself cannot be printed this way, because it is ~590 transactions plus a fresh buffer keypair. Use option (a) or (b) above for it.

`accept-admin` is **not needed**: `init` already makes the company admin. The command stays only for a future two-step admin hand-over started with `propose_admin`.

## Local rehearsal (what was actually run)

A stand-in keypair plays the company. The stand-in override `STOVIA_LOCALNET_COMPANY` is honored **only** with `--cluster localnet`, on a localhost RPC whose genesis is not mainnet. With mainnet, both scripts abort if it is set to anything other than 3aeV….

```bash
solana-keygen new --no-bip39-passphrase -o <scratch>/standin.json
solana-test-validator --reset --ledger <scratch>/ledger &
solana airdrop 10 <standin-pubkey> -u localhost
STOVIA_LOCALNET_COMPANY=<standin-pubkey> scripts/deploy-mainnet.sh --cluster localnet \
  --keypair <scratch>/standin.json --yes --skip-build --cu-price 1000
```

Result on 2026-11-23 (solana-test-validator 4.4.1):

- The SBPFv3 program was deployed, with the stand-in as fee payer and upgrade authority.
- The upgrade-authority check passed.
- `initialize_config` was signed by the stand-in.
- `status --strict` passed all checks: upgrade authority, admin, treasury and resolver are the stand-in, pending_admin is none, and fees are 10/10.

A second run, on a fresh validator, tested the `--print-tx` path. `init --print-tx` printed the unsigned tx, and its simulation returned `err=null`. The tx was signed outside the script, broadcast, and `status --strict` passed.

Negative checks that abort as intended:

- missing `--keypair`
- a signer that is not the company wallet
- the stand-in key used against mainnet
- `STOVIA_LOCALNET_COMPANY` set on mainnet (both scripts)
- `--cluster localnet` pointed at a non-local or mainnet RPC

A local validator uses the older rent rate, so the same binary costs about 4.09 SOL in rent there, against 2.99 SOL on mainnet.

## SBPF version

- `solana feature status -um` shows **SBPFv3 deployment and execution active on mainnet since epoch 993** (feature `5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC`, SIMD-0178/0189/0377).
- SIMD-0500 (disable deploying SBPF v0–v2) is pending.
- The deploy therefore uses the default `anchor build` (SBPFv3, ELF e_flags=3). `--arch v0` remains a fallback.
- The litesvm tests still need a v0 build (`target/deploy-v0/stovia.so`), because litesvm 0.6 cannot load v3.

## Program surface added for this deploy

- **Admin:**
  - `initialize_config(treasury, platform_fee_bps, creator_fee_bps, pending_admin: Option<Pubkey>, resolver)`. Only the upgrade authority may call it, and the signer becomes admin.
  - `propose_admin` / `accept_admin` (two-step hand-over, unused at launch).
  - `set_resolver`, and `update_config`, both admin only.
  - Events: `AdminProposed`, `AdminAccepted`, `ResolverUpdated`.
- **Sealed (Privacy Rings) bets:**
  - Instructions: `commit_sealed_bet`, `reveal_sealed_bet`, `post_sealed_results`. The last is resolver only, callable after `settle_market`, and once per market.
  - Accounts: `SealedBet`, `SealedResults`.
  - Fields: `Market.sealed_committed` and `Market.sealed_revealed`.

## Risks

- **One key holds every role.** The company wallet is upgrade authority, admin, treasury and resolver. Losing it means losing upgrades and admin. If it leaks, an attacker can upgrade the program and redirect fees. Keep it offline when not in use. Later you can move roles with `set_resolver`, `propose_admin`, or `solana program set-upgrade-authority`, for example to a Squads vault.
- **The resolver is the company wallet.** It is trusted for sealed bets: it posts totals and payout roots that the chain cannot verify. If the resolver service needs to sign automatically, it would need this key online. Rotate to a dedicated resolver key with `set_resolver` before running that service. See `docs/privacy-rings.md`.
- **Sealed and public pools are separate.** Public claims ignore sealed money, and the reverse.
- **There is a window between deploy and init.** Only the upgrade authority (the company) can call `initialize_config`, so nobody can front-run it.
- Rings is beta, and its SDK is pinned to `0.9.0-alpha`. See `docs/privacy-rings.md`.
