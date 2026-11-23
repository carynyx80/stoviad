// Stovia's Meteora Dynamic Bonding Curve (DBC) partner config.
//
// Kept free of local imports so the same module can be loaded by Node for
// mainnet simulations (see the report) and by the Next.js app.
//
// Fee model (verified against @meteora-ag/dynamic-bonding-curve-sdk 2.0.0 math, `splitFees`):
//   every swap pays the pool's base fee; Meteora's protocol keeps 20% of it
//   (PROTOCOL_FEE_PERCENT), the remaining 80% is the "trading fee", split between
//   the partner (fee claimer) and the pool creator by `creatorTradingFeePercentage`.
//   DBC's minimum base fee is 25 bps (MIN_FEE_BPS), so:
//     total 0.25%  =  0.05% Meteora protocol  +  0.10% Stovia (partner)  +  0.10% creator
//   which hits the 0.1% platform + 0.1% creator target exactly.
import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

/** Meteora DBC program (mainnet-beta). */
export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/** Wrapped SOL: every Stovia curve is quoted in SOL. */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
/** Company wallet: DBC partner, fee claimer and leftover receiver. */
export const DBC_PARTNER = new PublicKey("3aeVzSa3XKR8vstMFkXzVCnokcC4LApQPH3S8G7ckLgm");

export const DBC_BASE_FEE_BPS = 25; // DBC minimum
export const DBC_PROTOCOL_SHARE_PCT = 20; // Meteora, fixed by the program
export const DBC_CREATOR_SHARE_PCT = 50; // of the remaining 80%
export const TOKEN_DECIMALS = 6;
export const TOKEN_SUPPLY = 1_000_000_000;
/** Market caps in SOL. */
export const INITIAL_MCAP_SOL = 30;
export const MIGRATION_MCAP_SOL = 400;

/** Effective fee shares of each trade, in bps. */
export const FEE_BREAKDOWN_BPS = {
  total: DBC_BASE_FEE_BPS,
  protocol: (DBC_BASE_FEE_BPS * DBC_PROTOCOL_SHARE_PCT) / 100,
  partner: (DBC_BASE_FEE_BPS * (100 - DBC_PROTOCOL_SHARE_PCT) * (100 - DBC_CREATOR_SHARE_PCT)) / 10_000,
  creator: (DBC_BASE_FEE_BPS * (100 - DBC_PROTOCOL_SHARE_PCT) * DBC_CREATOR_SHARE_PCT) / 10_000,
};

/** The Stovia curve: SPL token, 1B supply, 30 → 400 SOL market cap, graduates to DAMM v2. */
export function stoviaConfigParameters(): ConfigParameters {
  return buildCurveWithMarketCap({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: TOKEN_SUPPLY,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: DBC_BASE_FEE_BPS, endingFeeBps: DBC_BASE_FEE_BPS, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false, // keeps the fee at exactly 0.25%
      collectFeeMode: CollectFeeMode.QuoteToken, // fees accrue in SOL
      creatorTradingFeePercentage: DBC_CREATOR_SHARE_PCT,
      poolCreationFee: 0, // creators pay only rent + network fees
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25, // graduated DAMM v2 pool: 0.25% fee
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    // Graduated LP is 100% permanently locked, split 50/50: Stovia and the creator
    // keep claiming the DAMM v2 trading fees of their locked positions forever.
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: INITIAL_MCAP_SOL,
    migrationMarketCap: MIGRATION_MCAP_SOL,
  });
}
