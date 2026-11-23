#!/usr/bin/env bash
# Stovia mainnet deploy. ONE wallet does everything: the company wallet
#   3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm
# pays for and signs the deploy, is the upgrade authority from the first instruction, and is
# admin, treasury and resolver in Config. There is no separate deployer wallet.
#
#   scripts/deploy-mainnet.sh --dry-run [--keypair <signer>]           # read-only preflight + cost
#   scripts/deploy-mainnet.sh --keypair <signer>                        # real mainnet deploy (asks to confirm)
#   STOVIA_LOCALNET_COMPANY=<pubkey> scripts/deploy-mainnet.sh --cluster localnet --keypair <standin.json> --yes
#                                                                       # rehearsal on solana-test-validator
#
# <signer> is the company wallet as a CLI signer:
#   /path/to/company-keypair.json   (a file kept OUTSIDE this repo, on your machine only)
#   usb://ledger?key=N              (Ledger; see docs/deploy.md for the caveats)
#
# Flags: --keypair <signer> (required except with --dry-run)  --dry-run  --cluster mainnet|localnet
#        --url <rpc>  --cu-price <microlamports, default 100000>  --arch v3|v0 (default v3)
#        --skip-build  --yes (no interactive confirmation)
# Env:   STOVIA_LOCALNET_COMPANY  stand-in company pubkey, honored ONLY with --cluster localnet
#                                 (mainnet is pinned to 3aeV... and aborts if this is set to anything else)
#        MAX_LEN                  optional --max-len bytes for ProgramData
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

PROGRAM_ID="6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8"
PROGRAM_KEYPAIR="keys/stovia-program-keypair.json"   # program ADDRESS keypair, not a wallet
MAINNET_COMPANY="3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm"
MAINNET_GENESIS="5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
SO="target/deploy/stovia.so"

DRY_RUN=0; CLUSTER=mainnet; URL=""; CU_PRICE=100000; ARCH=v3; SKIP_BUILD=0; YES=0; KEYPAIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keypair) KEYPAIR="${2:-}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --cluster) CLUSTER="$2"; shift ;;
    --url) URL="$2"; shift ;;
    --cu-price) CU_PRICE="$2"; shift ;;
    --arch) ARCH="$2"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    --yes) YES=1 ;;
    *) echo "unknown flag $1" >&2; exit 1 ;;
  esac
  shift
done

die() { echo "ERROR: $*" >&2; exit 1; }

case "$CLUSTER" in
  mainnet)
    URL="${URL:-https://api.mainnet-beta.solana.com}"
    COMPANY="$MAINNET_COMPANY"
    if [[ -n "${STOVIA_LOCALNET_COMPANY:-}" && "$STOVIA_LOCALNET_COMPANY" != "$MAINNET_COMPANY" ]]; then
      die "STOVIA_LOCALNET_COMPANY is only honored with --cluster localnet; mainnet is pinned to $MAINNET_COMPANY. Unset it."
    fi
    ;;
  localnet)
    URL="${URL:-http://127.0.0.1:8899}"
    COMPANY="${STOVIA_LOCALNET_COMPANY:-$MAINNET_COMPANY}"
    ;;
  *) die "--cluster must be mainnet or localnet" ;;
esac

if [[ -z "$KEYPAIR" && $DRY_RUN -eq 0 ]]; then
  die "--keypair <path|usb://ledger?key=N> is required (the company wallet $COMPANY signs everything)"
fi
IS_USB=0; [[ "$KEYPAIR" == usb://* ]] && IS_USB=1
if [[ -n "$KEYPAIR" && $IS_USB -eq 0 ]]; then
  KEYPAIR="${KEYPAIR/#\~/$HOME}"
  [[ -f "$KEYPAIR" ]] || die "keypair file not found: $KEYPAIR"
  KP_ABS="$(cd "$(dirname "$KEYPAIR")" && pwd)/$(basename "$KEYPAIR")"
  if [[ "$CLUSTER" == mainnet && "$KP_ABS" == "$ROOT"/* ]]; then
    die "the company keypair is inside the repo ($KP_ABS). Move it outside the repo so it can never be committed."
  fi
fi

log() { printf '\n==> %s\n' "$*"; }
run() { # print, and execute unless dry-run
  printf '    $ %s\n' "$*"
  if [[ $DRY_RUN -eq 0 ]]; then "$@"; fi
}
lamports_to_sol() { python3 -c "print(f'{$1/1e9:.6f}')"; }

# ---------------------------------------------------------------- preflight
log "Preflight ($CLUSTER, $URL)$([[ $DRY_RUN -eq 1 ]] && echo ' [DRY RUN: nothing will be sent]')"
for bin in solana solana-keygen anchor cargo node python3; do command -v "$bin" >/dev/null || die "missing $bin"; done
solana --version

GENESIS="$(solana genesis-hash -u "$URL")"
if [[ "$CLUSTER" == mainnet && "$GENESIS" != "$MAINNET_GENESIS" ]]; then die "RPC $URL is not mainnet-beta (genesis $GENESIS)"; fi
if [[ "$CLUSTER" == localnet && "$GENESIS" == "$MAINNET_GENESIS" ]]; then die "--cluster localnet but RPC is mainnet; refusing"; fi
echo "    genesis hash: $GENESIS"

PK="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
[[ "$PK" == "$PROGRAM_ID" ]] || die "program keypair is $PK, expected $PROGRAM_ID"
grep -q "declare_id!(\"$PROGRAM_ID\")" programs/stovia/src/lib.rs || die "declare_id mismatch"

if [[ -n "$KEYPAIR" ]]; then
  SIGNER="$(solana-keygen pubkey "$KEYPAIR")" || die "could not read pubkey from $KEYPAIR"
  [[ "$SIGNER" == "$COMPANY" ]] || die "signer $KEYPAIR is $SIGNER, but the company wallet is $COMPANY. Aborting."
  echo "    signer:   $SIGNER (matches company wallet)"
else
  SIGNER="$COMPANY"
  echo "    signer:   (no --keypair given; dry run only) signer check SKIPPED, using company pubkey for read-only checks"
fi
echo "    program:  $PROGRAM_ID"
echo "    company:  $COMPANY = fee payer, upgrade authority, admin, treasury, resolver"

if solana program show "$PROGRAM_ID" -u "$URL" >/dev/null 2>&1; then
  die "Program $PROGRAM_ID already exists on $CLUSTER. This script only does first deploys."
fi

# ---------------------------------------------------------------- build
if [[ $SKIP_BUILD -eq 0 ]]; then
  log "Build (SBPF $ARCH)"
  if [[ "$ARCH" == v3 ]]; then anchor build; else anchor build -- --arch "$ARCH"; fi
fi
[[ -f "$SO" ]] || die "missing $SO"
SO_SIZE=$(wc -c < "$SO" | tr -d ' ')
SO_FLAGS=$(python3 -c "import struct;print(struct.unpack('<I',open('$SO','rb').read(52)[48:52])[0])")
echo "    $SO: $SO_SIZE bytes, ELF e_flags=$SO_FLAGS (0=SBPFv0, 3=SBPFv3), sha256 $(shasum -a 256 "$SO" | cut -d' ' -f1)"

# ---------------------------------------------------------------- cost
log "Cost estimate (paid entirely by the company wallet)"
PROG_LEN=${MAX_LEN:-$SO_SIZE}
rent() { solana rent -u "$URL" --lamports "$1" | awk '/minimum/{print $(NF-1)}'; }
RENT_PROGDATA=$(rent $((PROG_LEN + 45)))   # ProgramData header 45 bytes
RENT_PROGRAM=$(rent 36)
RENT_BUFFER=$(rent $((SO_SIZE + 37)))      # temporary; refunded when the deploy finalizes
RENT_CONFIG=$(rent 150)                    # 8 + Config::INIT_SPACE (142)
WRITE_TXS=$(( (SO_SIZE + 1000) / 1000 + 5 ))  # ~1 KB per write tx + create/finalize
FEE_PER_TX=$(( 5000 + CU_PRICE * 200000 / 1000000 ))  # worst case: 200k CU limit per tx
TX_FEES=$(( WRITE_TXS * FEE_PER_TX + 2 * FEE_PER_TX ))
SAFETY=50000000                              # 0.05 SOL for retries / re-signing
REQUIRED=$(( RENT_PROGDATA + RENT_PROGRAM + RENT_BUFFER + RENT_CONFIG + TX_FEES + SAFETY ))
PERMANENT=$(( RENT_PROGDATA + RENT_PROGRAM + RENT_CONFIG ))
NET=$(( PERMANENT + TX_FEES ))
printf '    programdata rent %s SOL | program rent %s | buffer rent (refunded) %s | config rent %s\n' \
  "$(lamports_to_sol $RENT_PROGDATA)" "$(lamports_to_sol $RENT_PROGRAM)" "$(lamports_to_sol $RENT_BUFFER)" "$(lamports_to_sol $RENT_CONFIG)"
printf '    ~%s txs, worst-case fees %s SOL (cu-price %s), safety %s SOL\n' \
  "$WRITE_TXS" "$(lamports_to_sol $TX_FEES)" "$CU_PRICE" "$(lamports_to_sol $SAFETY)"
printf '    PEAK balance needed: %s SOL   net spend: ~%s SOL (locked as rent: %s SOL)\n' \
  "$(lamports_to_sol $REQUIRED)" "$(lamports_to_sol $NET)" "$(lamports_to_sol $PERMANENT)"

BAL=$(solana balance "$COMPANY" -u "$URL" --lamports | awk '{print $1}')
printf '    company wallet balance: %s SOL\n' "$(lamports_to_sol $BAL)"
if (( BAL < REQUIRED )); then
  echo "    SHORTFALL: send at least $(lamports_to_sol $((REQUIRED - BAL))) more SOL to $COMPANY" >&2
  [[ $DRY_RUN -eq 1 ]] || exit 1
else
  echo "    balance OK"
fi

if [[ $DRY_RUN -eq 0 && $YES -eq 0 ]]; then
  read -r -p "Deploy $PROGRAM_ID to $CLUSTER, signed and paid by $COMPANY? Type 'deploy' to continue: " ans
  [[ "$ans" == deploy ]] || { echo "aborted"; exit 1; }
fi

# ---------------------------------------------------------------- deploy
log "Deploy program (fee payer AND upgrade authority = company)"
DEPLOY_ARGS=(program deploy --program-id "$PROGRAM_KEYPAIR" "$SO" -u "$URL"
  --keypair "${KEYPAIR:-<company-signer>}" --upgrade-authority "${KEYPAIR:-<company-signer>}"
  --with-compute-unit-price "$CU_PRICE" --max-sign-attempts 50)
[[ -n "${MAX_LEN:-}" ]] && DEPLOY_ARGS+=(--max-len "$MAX_LEN")
[[ "$CLUSTER" == mainnet ]] && DEPLOY_ARGS+=(--use-rpc)
run solana "${DEPLOY_ARGS[@]}"
echo "    If this step fails midway, recover the buffer rent with:"
echo "      solana program close --buffers -u $URL --keypair <company-signer>"

log "Verify on-chain upgrade authority == company"
if [[ $DRY_RUN -eq 0 ]]; then
  UA="$(solana program show "$PROGRAM_ID" -u "$URL" | awk -F': *' '/^Authority/{print $2}')"
  echo "    upgrade authority: $UA"
  [[ "$UA" == "$COMPANY" ]] || die "upgrade authority is $UA, expected $COMPANY"
else
  echo "    [dry-run] would check: solana program show $PROGRAM_ID -u $URL  ->  Authority == $COMPANY"
fi

# ---------------------------------------------------------------- initialize_config
log "initialize_config (admin = treasury = resolver = company, fees 10/10 bps, pending_admin = None)"
POST_ENV=(PROGRAM_ID="$PROGRAM_ID")
[[ "$CLUSTER" == localnet ]] && POST_ENV+=(STOVIA_LOCALNET_COMPANY="$COMPANY")
POST_ARGS=(init --cluster "$CLUSTER" --url "$URL" --cu-price "$CU_PRICE")
if [[ $IS_USB -eq 1 || -z "$KEYPAIR" ]]; then
  # node cannot drive a Ledger; emit an unsigned tx instead (also used by a keyless dry run)
  POST_ARGS+=(--print-tx)
  [[ $IS_USB -eq 1 ]] && echo "    Ledger signer: printing an unsigned initialize_config tx for you to sign (see docs/deploy.md)."
else
  POST_ARGS+=(--keypair "$KEYPAIR")
  [[ $DRY_RUN -eq 1 ]] && POST_ARGS+=(--dry-run)
fi
env "${POST_ENV[@]}" node scripts/post-deploy.mjs "${POST_ARGS[@]}"

if [[ $DRY_RUN -eq 0 && $IS_USB -eq 0 ]]; then
  log "Status"
  env "${POST_ENV[@]}" node scripts/post-deploy.mjs status --cluster "$CLUSTER" --url "$URL" --strict
  log "Done. No further steps: the company wallet already holds every role."
fi
