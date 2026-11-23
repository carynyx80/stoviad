//! Stovia: Solana memecoin launchpad where every token carries a survival market.
//!
//! Flow: launch_token -> buy/sell on a virtual constant-product curve (TWAP of market cap
//! accumulated on every trade) -> commit_bet (sealed side) before deadline -> reveal_bet in the
//! reveal window -> settle_market (TWAP vs target) -> claim_winnings / claim_bond / sweep_unrevealed.
//!
//! SOL vaults are zero-field program-owned PDAs (`SolVault`). Deposits use system transfers,
//! withdrawals debit lamports directly; vaults never go below their rent-exempt floor because
//! every withdrawal is bounded by an accounting field that excludes the rent deposit.
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8");

pub const BPS_DENOM: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 500;
pub const TOKEN_DECIMALS: u8 = 6;
/// 1,000,000,000 tokens with 6 decimals.
pub const TOTAL_SUPPLY: u64 = 1_000_000_000 * 1_000_000;
/// Virtual reserves at launch (pump-style curve).
pub const INITIAL_VIRTUAL_SOL: u64 = 30 * 1_000_000_000;
pub const INITIAL_VIRTUAL_TOKENS: u64 = 1_073_000_000 * 1_000_000;
pub const REVEAL_WINDOW_SECS: i64 = 24 * 60 * 60;
pub const MIN_MARKET_DURATION_SECS: i64 = 60;
pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

pub const SIDE_SURVIVE: u8 = 1; // YES
pub const SIDE_DIE: u8 = 2; // NO

#[program]
pub mod stovia {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        treasury: Pubkey,
        platform_fee_bps: u16,
        creator_fee_bps: u16,
    ) -> Result<()> {
        require!(
            platform_fee_bps <= MAX_FEE_BPS && creator_fee_bps <= MAX_FEE_BPS,
            StoviaError::FeeTooHigh
        );
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.treasury = treasury;
        c.platform_fee_bps = platform_fee_bps;
        c.creator_fee_bps = creator_fee_bps;
        c.launch_count = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin-only: rotate treasury / fees.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        treasury: Pubkey,
        platform_fee_bps: u16,
        creator_fee_bps: u16,
    ) -> Result<()> {
        require!(
            platform_fee_bps <= MAX_FEE_BPS && creator_fee_bps <= MAX_FEE_BPS,
            StoviaError::FeeTooHigh
        );
        let c = &mut ctx.accounts.config;
        c.treasury = treasury;
        c.platform_fee_bps = platform_fee_bps;
        c.creator_fee_bps = creator_fee_bps;
        Ok(())
    }

    pub fn launch_token(
        ctx: Context<LaunchToken>,
        name: String,
        symbol: String,
        uri: String,
        bond_lamports: u64,
        target_mcap_lamports: u64,
        deadline_ts: i64,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, StoviaError::NameTooLong);
        require!(!symbol.is_empty() && symbol.len() <= MAX_SYMBOL_LEN, StoviaError::SymbolTooLong);
        require!(uri.len() <= MAX_URI_LEN, StoviaError::UriTooLong);
        require!(bond_lamports > 0, StoviaError::ZeroAmount);
        require!(target_mcap_lamports > 0, StoviaError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(
            deadline_ts >= now.checked_add(MIN_MARKET_DURATION_SECS).ok_or(StoviaError::MathOverflow)?,
            StoviaError::InvalidDeadline
        );

        let config = &mut ctx.accounts.config;
        let fee = bps(bond_lamports, config.platform_fee_bps)?;
        let bond_net = sub(bond_lamports, fee)?;
        require!(bond_net > 0, StoviaError::ZeroAmount);
        config.launch_count = config.launch_count.checked_add(1).ok_or(StoviaError::MathOverflow)?;

        let creator = ctx.accounts.creator.to_account_info();
        sys_transfer(&ctx.accounts.system_program, &creator, &ctx.accounts.treasury.to_account_info(), fee)?;
        sys_transfer(&ctx.accounts.system_program, &creator, &ctx.accounts.bond_vault.to_account_info(), bond_net)?;

        let mint_key = ctx.accounts.mint.key();
        let launch_bump = ctx.bumps.launch;
        let launch = &mut ctx.accounts.launch;
        launch.creator = ctx.accounts.creator.key();
        launch.mint = mint_key;
        launch.name = name.clone();
        launch.symbol = symbol.clone();
        launch.uri = uri.clone();
        launch.virtual_sol = INITIAL_VIRTUAL_SOL;
        launch.virtual_tokens = INITIAL_VIRTUAL_TOKENS;
        launch.real_sol = 0;
        launch.real_tokens = TOTAL_SUPPLY;
        launch.creator_fees_accrued = 0;
        launch.created_at = now;
        launch.bump = launch_bump;

        // Mint the fixed supply into the curve vault, signed by the launch PDA (mint authority).
        let seeds: &[&[u8]] = &[b"launch", mint_key.as_ref(), &[launch_bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: launch.to_account_info(),
                },
                &[seeds],
            ),
            TOTAL_SUPPLY,
        )?;

        let start_mcap = mcap(INITIAL_VIRTUAL_SOL, INITIAL_VIRTUAL_TOKENS)?;
        let m = &mut ctx.accounts.market;
        m.launch = launch.key();
        m.target_mcap = target_mcap_lamports;
        m.start_ts = now;
        m.deadline = deadline_ts;
        m.reveal_end = deadline_ts.checked_add(REVEAL_WINDOW_SECS).ok_or(StoviaError::MathOverflow)?;
        m.twap_cumulative = 0;
        m.last_ts = now;
        m.last_mcap = start_mcap;
        m.bond = bond_net;
        m.bond_claimed = false;
        m.committed_total = 0;
        m.revealed_total = 0;
        m.yes_pool = 0;
        m.no_pool = 0;
        m.bonus_pool = 0;
        m.status = MarketStatus::Open;
        m.twap_mcap = 0;
        m.swept = false;

        emit!(LaunchCreated {
            launch: launch.key(),
            mint: mint_key,
            creator: launch.creator,
            name,
            symbol,
            uri,
            bond_lamports: bond_net,
            platform_fee: fee,
            target_mcap_lamports,
            deadline_ts,
            reveal_end_ts: m.reveal_end,
        });
        Ok(())
    }

    pub fn buy(ctx: Context<Swap>, sol_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(sol_in > 0, StoviaError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let platform_fee = bps(sol_in, config.platform_fee_bps)?;
        let creator_fee = bps(sol_in, config.creator_fee_bps)?;
        let net = sub(sub(sol_in, platform_fee)?, creator_fee)?;
        require!(net > 0, StoviaError::ZeroAmount);

        let launch = &mut ctx.accounts.launch;
        // tokens_out = vt - vs*vt/(vs+net), rounded in the curve's favour.
        let new_vs = add(launch.virtual_sol, net)?;
        let k = (launch.virtual_sol as u128) * (launch.virtual_tokens as u128);
        let new_vt = ceil_div_u128(k, new_vs as u128)?;
        let tokens_out = sub(launch.virtual_tokens, new_vt)?;
        require!(tokens_out > 0, StoviaError::ZeroAmount);
        require!(tokens_out <= launch.real_tokens, StoviaError::InsufficientLiquidity);
        require!(tokens_out >= min_tokens_out, StoviaError::SlippageExceeded);

        accrue_twap(&mut ctx.accounts.market, now)?;

        let user = ctx.accounts.user.to_account_info();
        let sp = &ctx.accounts.system_program;
        sys_transfer(sp, &user, &ctx.accounts.curve_sol.to_account_info(), net)?;
        sys_transfer(sp, &user, &ctx.accounts.treasury.to_account_info(), platform_fee)?;
        sys_transfer(sp, &user, &ctx.accounts.creator_fee_vault.to_account_info(), creator_fee)?;

        let mint_key = launch.mint;
        let seeds: &[&[u8]] = &[b"launch", mint_key.as_ref(), &[launch.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_vault.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: launch.to_account_info(),
                },
                &[seeds],
            ),
            tokens_out,
        )?;

        launch.virtual_sol = new_vs;
        launch.virtual_tokens = new_vt;
        launch.real_sol = add(launch.real_sol, net)?;
        launch.real_tokens = sub(launch.real_tokens, tokens_out)?;
        launch.creator_fees_accrued = add(launch.creator_fees_accrued, creator_fee)?;
        let new_mcap = mcap(launch.virtual_sol, launch.virtual_tokens)?;
        ctx.accounts.market.last_mcap = new_mcap;

        emit!(Trade {
            launch: launch.key(),
            mint: mint_key,
            trader: ctx.accounts.user.key(),
            is_buy: true,
            sol_amount: sol_in,
            token_amount: tokens_out,
            platform_fee,
            creator_fee,
            virtual_sol: launch.virtual_sol,
            virtual_tokens: launch.virtual_tokens,
            mcap_lamports: new_mcap,
            timestamp: now,
        });
        Ok(())
    }

    pub fn sell(ctx: Context<Swap>, tokens_in: u64, min_sol_out: u64) -> Result<()> {
        require!(tokens_in > 0, StoviaError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let config = &ctx.accounts.config;
        let launch = &mut ctx.accounts.launch;

        // gross = vs - vs*vt/(vt+tokens_in), rounded in the curve's favour.
        let new_vt = add(launch.virtual_tokens, tokens_in)?;
        let k = (launch.virtual_sol as u128) * (launch.virtual_tokens as u128);
        let new_vs = ceil_div_u128(k, new_vt as u128)?;
        let gross = sub(launch.virtual_sol, new_vs)?;
        require!(gross > 0, StoviaError::ZeroAmount);
        require!(gross <= launch.real_sol, StoviaError::InsufficientLiquidity);
        let platform_fee = bps(gross, config.platform_fee_bps)?;
        let creator_fee = bps(gross, config.creator_fee_bps)?;
        let sol_out = sub(sub(gross, platform_fee)?, creator_fee)?;
        require!(sol_out >= min_sol_out, StoviaError::SlippageExceeded);

        accrue_twap(&mut ctx.accounts.market, now)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        let vault = ctx.accounts.curve_sol.to_account_info();
        lamports_out(&vault, &ctx.accounts.user.to_account_info(), sol_out)?;
        lamports_out(&vault, &ctx.accounts.treasury.to_account_info(), platform_fee)?;
        lamports_out(&vault, &ctx.accounts.creator_fee_vault.to_account_info(), creator_fee)?;

        launch.virtual_sol = new_vs;
        launch.virtual_tokens = new_vt;
        launch.real_sol = sub(launch.real_sol, gross)?;
        launch.real_tokens = add(launch.real_tokens, tokens_in)?;
        launch.creator_fees_accrued = add(launch.creator_fees_accrued, creator_fee)?;
        let new_mcap = mcap(launch.virtual_sol, launch.virtual_tokens)?;
        ctx.accounts.market.last_mcap = new_mcap;

        emit!(Trade {
            launch: launch.key(),
            mint: launch.mint,
            trader: ctx.accounts.user.key(),
            is_buy: false,
            sol_amount: sol_out,
            token_amount: tokens_in,
            platform_fee,
            creator_fee,
            virtual_sol: launch.virtual_sol,
            virtual_tokens: launch.virtual_tokens,
            mcap_lamports: new_mcap,
            timestamp: now,
        });
        Ok(())
    }

    /// Permissionless: roll the TWAP accumulator forward to now (clamped at deadline).
    pub fn poke_twap(ctx: Context<PokeTwap>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        accrue_twap(&mut ctx.accounts.market, now)
    }

    pub fn claim_creator_fees(ctx: Context<ClaimCreatorFees>) -> Result<()> {
        let launch = &mut ctx.accounts.launch;
        let amount = launch.creator_fees_accrued;
        require!(amount > 0, StoviaError::NothingToClaim);
        launch.creator_fees_accrued = 0;
        lamports_out(
            &ctx.accounts.creator_fee_vault.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            amount,
        )?;
        emit!(Claimed {
            market: Pubkey::default(),
            launch: launch.key(),
            recipient: launch.creator,
            kind: ClaimKind::CreatorFees,
            amount,
        });
        Ok(())
    }

    /// commitment = sha256(side_u8 || salt[32] || bettor_pubkey). One bet per bettor per market.
    pub fn commit_bet(ctx: Context<CommitBet>, commitment: [u8; 32], amount: u64) -> Result<()> {
        require!(amount > 0, StoviaError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, StoviaError::MarketNotOpen);
        require!(now < market.deadline, StoviaError::BettingClosed);

        let fee = bps(amount, ctx.accounts.config.platform_fee_bps)?;
        let stake = sub(amount, fee)?;
        require!(stake > 0, StoviaError::ZeroAmount);

        let bettor = ctx.accounts.bettor.to_account_info();
        sys_transfer(&ctx.accounts.system_program, &bettor, &ctx.accounts.treasury.to_account_info(), fee)?;
        sys_transfer(&ctx.accounts.system_program, &bettor, &ctx.accounts.market_vault.to_account_info(), stake)?;

        market.committed_total = add(market.committed_total, stake)?;
        let bet = &mut ctx.accounts.bet;
        bet.market = market.key();
        bet.bettor = ctx.accounts.bettor.key();
        bet.commitment = commitment;
        bet.amount = stake;
        bet.side = 0;
        bet.revealed = false;
        bet.claimed = false;
        bet.bump = ctx.bumps.bet;

        emit!(BetCommitted {
            market: market.key(),
            bettor: bet.bettor,
            commitment,
            amount: stake,
            platform_fee: fee,
        });
        Ok(())
    }

    pub fn reveal_bet(ctx: Context<RevealBet>, side: u8, salt: [u8; 32]) -> Result<()> {
        require!(side == SIDE_SURVIVE || side == SIDE_DIE, StoviaError::InvalidSide);
        let now = Clock::get()?.unix_timestamp;
        let market = &mut ctx.accounts.market;
        require!(now >= market.deadline, StoviaError::RevealNotStarted);
        require!(now < market.reveal_end, StoviaError::RevealWindowClosed);
        let bet = &mut ctx.accounts.bet;
        require!(!bet.revealed, StoviaError::AlreadyRevealed);
        let side_byte = [side];
        let digest = hashv(&[&side_byte[..], &salt[..], bet.bettor.as_ref()]).to_bytes();
        require!(digest == bet.commitment, StoviaError::CommitmentMismatch);

        bet.revealed = true;
        bet.side = side;
        market.revealed_total = add(market.revealed_total, bet.amount)?;
        if side == SIDE_SURVIVE {
            market.yes_pool = add(market.yes_pool, bet.amount)?;
        } else {
            market.no_pool = add(market.no_pool, bet.amount)?;
        }
        emit!(BetRevealed { market: market.key(), bettor: bet.bettor, side, amount: bet.amount });
        Ok(())
    }

    /// Permissionless after the reveal window. TWAP over [start, deadline] vs target.
    pub fn settle_market(ctx: Context<SettleMarket>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Open, StoviaError::AlreadySettled);
        require!(now >= market.reveal_end, StoviaError::RevealWindowOpen);
        accrue_twap(market, now)?;
        let duration = market.deadline.checked_sub(market.start_ts).ok_or(StoviaError::MathOverflow)?;
        require!(duration > 0, StoviaError::MathOverflow);
        let twap = market
            .twap_cumulative
            .checked_div(duration as u128)
            .ok_or(StoviaError::MathOverflow)?;
        let twap = u64::try_from(twap).map_err(|_| StoviaError::MathOverflow)?;
        market.twap_mcap = twap;

        if twap >= market.target_mcap {
            market.status = MarketStatus::Survived;
        } else {
            market.status = MarketStatus::Died;
            // Bond joins the NO side's winnings: move it from the bond vault into the market vault.
            let bond = market.bond;
            lamports_out(
                &ctx.accounts.bond_vault.to_account_info(),
                &ctx.accounts.market_vault.to_account_info(),
                bond,
            )?;
            market.bonus_pool = bond;
            market.bond_claimed = true;
        }
        emit!(MarketSettled {
            market: market.key(),
            launch: market.launch,
            survived: market.status == MarketStatus::Survived,
            twap_mcap: twap,
            target_mcap: market.target_mcap,
            yes_pool: market.yes_pool,
            no_pool: market.no_pool,
            bonus_pool: market.bonus_pool,
            unrevealed: sub(market.committed_total, market.revealed_total)?,
        });
        Ok(())
    }

    /// Creator reclaims the bond if the token survived.
    pub fn claim_bond(ctx: Context<ClaimBond>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status == MarketStatus::Survived, StoviaError::NotSurvived);
        require!(!market.bond_claimed, StoviaError::NothingToClaim);
        market.bond_claimed = true;
        let amount = market.bond;
        lamports_out(&ctx.accounts.bond_vault.to_account_info(), &ctx.accounts.creator.to_account_info(), amount)?;
        emit!(Claimed {
            market: market.key(),
            launch: market.launch,
            recipient: ctx.accounts.creator.key(),
            kind: ClaimKind::Bond,
            amount,
        });
        Ok(())
    }

    /// Winner: stake + stake * (losing_pool + bonus) / winning_pool.
    /// If nobody revealed on the winning side, revealed losers are refunded their stake.
    pub fn claim_winnings(ctx: Context<ClaimWinnings>) -> Result<()> {
        let market = &ctx.accounts.market;
        require!(market.status != MarketStatus::Open, StoviaError::NotSettled);
        let bet = &mut ctx.accounts.bet;
        require!(bet.revealed, StoviaError::NotRevealed);
        require!(!bet.claimed, StoviaError::AlreadyClaimed);
        let winning_side = if market.status == MarketStatus::Survived { SIDE_SURVIVE } else { SIDE_DIE };
        let (win_pool, lose_pool) = if winning_side == SIDE_SURVIVE {
            (market.yes_pool, market.no_pool)
        } else {
            (market.no_pool, market.yes_pool)
        };
        let payout = if win_pool == 0 {
            bet.amount // refund: no winners
        } else {
            require!(bet.side == winning_side, StoviaError::LosingBet);
            let pot = add(lose_pool, market.bonus_pool)?;
            add(bet.amount, mul_div(bet.amount, pot, win_pool)?)?
        };
        bet.claimed = true;
        lamports_out(&ctx.accounts.market_vault.to_account_info(), &ctx.accounts.bettor.to_account_info(), payout)?;
        emit!(Claimed {
            market: market.key(),
            launch: market.launch,
            recipient: bet.bettor,
            kind: ClaimKind::Winnings,
            amount: payout,
        });
        Ok(())
    }

    /// Permissionless after settlement: unrevealed stakes (and an orphaned bonus when no winner
    /// revealed) go to the treasury.
    pub fn sweep_unrevealed(ctx: Context<SweepUnrevealed>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.status != MarketStatus::Open, StoviaError::NotSettled);
        require!(!market.swept, StoviaError::AlreadySwept);
        let mut amount = sub(market.committed_total, market.revealed_total)?;
        let win_pool = if market.status == MarketStatus::Survived { market.yes_pool } else { market.no_pool };
        if win_pool == 0 {
            amount = add(amount, market.bonus_pool)?;
        }
        require!(amount > 0, StoviaError::NothingToClaim);
        market.swept = true;
        lamports_out(&ctx.accounts.market_vault.to_account_info(), &ctx.accounts.treasury.to_account_info(), amount)?;
        emit!(Claimed {
            market: market.key(),
            launch: market.launch,
            recipient: ctx.accounts.treasury.key(),
            kind: ClaimKind::Sweep,
            amount,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or_else(|| error!(StoviaError::MathOverflow))
}
fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or_else(|| error!(StoviaError::MathOverflow))
}
fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, StoviaError::MathOverflow);
    let v = (a as u128)
        .checked_mul(b as u128)
        .ok_or(StoviaError::MathOverflow)?
        / (c as u128);
    u64::try_from(v).map_err(|_| error!(StoviaError::MathOverflow))
}
fn bps(amount: u64, fee_bps: u16) -> Result<u64> {
    mul_div(amount, fee_bps as u64, BPS_DENOM)
}
fn ceil_div_u128(n: u128, d: u128) -> Result<u64> {
    require!(d > 0, StoviaError::MathOverflow);
    let q = n.checked_add(d - 1).ok_or(StoviaError::MathOverflow)? / d;
    u64::try_from(q).map_err(|_| error!(StoviaError::MathOverflow))
}
/// Market cap in lamports = spot price (vs/vt) * total supply.
fn mcap(virtual_sol: u64, virtual_tokens: u64) -> Result<u64> {
    mul_div(virtual_sol, TOTAL_SUPPLY, virtual_tokens)
}
/// cumulative += last_mcap * (min(now, deadline) - last_ts)
fn accrue_twap(m: &mut Market, now: i64) -> Result<()> {
    let t = now.min(m.deadline);
    if t > m.last_ts {
        let dt = (t - m.last_ts) as u128;
        let inc = (m.last_mcap as u128).checked_mul(dt).ok_or(StoviaError::MathOverflow)?;
        m.twap_cumulative = m.twap_cumulative.checked_add(inc).ok_or(StoviaError::MathOverflow)?;
        m.last_ts = t;
    }
    Ok(())
}
fn sys_transfer<'info>(
    sp: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    system_program::transfer(
        CpiContext::new(sp.to_account_info(), system_program::Transfer { from: from.clone(), to: to.clone() }),
        amount,
    )
}
/// Debit a program-owned vault directly. Amounts are bounded by accounting fields that exclude
/// the vault's rent deposit, so the vault always stays rent-exempt.
fn lamports_out<'info>(vault: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let rent_floor = Rent::get()?.minimum_balance(vault.data_len());
    let remaining = vault.lamports().checked_sub(amount).ok_or(StoviaError::InsufficientVaultBalance)?;
    require!(remaining >= rent_floor, StoviaError::InsufficientVaultBalance);
    vault.sub_lamports(amount)?;
    to.add_lamports(amount)?;
    Ok(())
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub platform_fee_bps: u16,
    pub creator_fee_bps: u16,
    pub launch_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub creator: Pubkey,
    pub mint: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    #[max_len(200)]
    pub uri: String,
    pub virtual_sol: u64,
    pub virtual_tokens: u64,
    /// SOL actually held by the curve (excl. rent).
    pub real_sol: u64,
    /// Tokens still in the curve vault.
    pub real_tokens: u64,
    /// Unclaimed creator fees in the creator fee vault (excl. rent).
    pub creator_fees_accrued: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum MarketStatus {
    Open,
    Survived,
    Died,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub launch: Pubkey,
    pub target_mcap: u64,
    pub start_ts: i64,
    pub deadline: i64,
    pub reveal_end: i64,
    /// Sum of mcap_lamports * seconds over [start_ts, last_ts].
    pub twap_cumulative: u128,
    pub last_ts: i64,
    pub last_mcap: u64,
    pub twap_mcap: u64,
    pub bond: u64,
    pub bond_claimed: bool,
    pub committed_total: u64,
    pub revealed_total: u64,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub bonus_pool: u64,
    pub status: MarketStatus,
    pub swept: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub commitment: [u8; 32],
    pub amount: u64,
    pub side: u8,
    pub revealed: bool,
    pub claimed: bool,
    pub bump: u8,
}

/// Lamport-holding PDA (curve SOL, bond, creator fees, market escrow).
#[account]
#[derive(InitSpace)]
pub struct SolVault {}

// ---------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// Upgrade authority gate: only the program's upgrade authority may initialize.
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ StoviaError::Unauthorized)]
    pub program: Program<'info, crate::program::Stovia>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ StoviaError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ StoviaError::Unauthorized)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct LaunchToken<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: must equal config.treasury.
    #[account(mut, address = config.treasury @ StoviaError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(init, payer = creator, mint::decimals = TOKEN_DECIMALS, mint::authority = launch)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, space = 8 + Launch::INIT_SPACE, seeds = [b"launch", mint.key().as_ref()], bump)]
    pub launch: Box<Account<'info, Launch>>,
    #[account(init, payer = creator, token::mint = mint, token::authority = launch,
        seeds = [b"curve_vault", launch.key().as_ref()], bump)]
    pub curve_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, space = 8, seeds = [b"curve_sol", launch.key().as_ref()], bump)]
    pub curve_sol: Box<Account<'info, SolVault>>,
    #[account(init, payer = creator, space = 8, seeds = [b"bond", launch.key().as_ref()], bump)]
    pub bond_vault: Box<Account<'info, SolVault>>,
    #[account(init, payer = creator, space = 8, seeds = [b"creator_fee", launch.key().as_ref()], bump)]
    pub creator_fee_vault: Box<Account<'info, SolVault>>,
    #[account(init, payer = creator, space = 8 + Market::INIT_SPACE, seeds = [b"market", launch.key().as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init, payer = creator, space = 8, seeds = [b"market_vault", launch.key().as_ref()], bump)]
    pub market_vault: Box<Account<'info, SolVault>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: must equal config.treasury.
    #[account(mut, address = config.treasury @ StoviaError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"launch", mint.key().as_ref()], bump = launch.bump, has_one = mint)]
    pub launch: Box<Account<'info, Launch>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"curve_vault", launch.key().as_ref()], bump)]
    pub curve_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"curve_sol", launch.key().as_ref()], bump)]
    pub curve_sol: Box<Account<'info, SolVault>>,
    #[account(mut, seeds = [b"creator_fee", launch.key().as_ref()], bump)]
    pub creator_fee_vault: Box<Account<'info, SolVault>>,
    #[account(mut, seeds = [b"market", launch.key().as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(init_if_needed, payer = user, associated_token::mint = mint, associated_token::authority = user)]
    pub user_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PokeTwap<'info> {
    #[account(mut, seeds = [b"market", market.launch.as_ref()], bump)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFees<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"launch", launch.mint.as_ref()], bump = launch.bump, has_one = creator @ StoviaError::Unauthorized)]
    pub launch: Account<'info, Launch>,
    #[account(mut, seeds = [b"creator_fee", launch.key().as_ref()], bump)]
    pub creator_fee_vault: Account<'info, SolVault>,
}

#[derive(Accounts)]
pub struct CommitBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: must equal config.treasury.
    #[account(mut, address = config.treasury @ StoviaError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"market", market.launch.as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [b"market_vault", market.launch.as_ref()], bump)]
    pub market_vault: Box<Account<'info, SolVault>>,
    #[account(init, payer = bettor, space = 8 + Bet::INIT_SPACE,
        seeds = [b"bet", market.key().as_ref(), bettor.key().as_ref()], bump)]
    pub bet: Box<Account<'info, Bet>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RevealBet<'info> {
    /// Anyone holding (side, salt) may reveal; the bettor key is bound inside the commitment.
    pub revealer: Signer<'info>,
    #[account(mut, seeds = [b"market", market.launch.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"bet", market.key().as_ref(), bet.bettor.as_ref()], bump = bet.bump, has_one = market)]
    pub bet: Account<'info, Bet>,
}

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(mut, seeds = [b"market", market.launch.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"bond", market.launch.as_ref()], bump)]
    pub bond_vault: Account<'info, SolVault>,
    #[account(mut, seeds = [b"market_vault", market.launch.as_ref()], bump)]
    pub market_vault: Account<'info, SolVault>,
}

#[derive(Accounts)]
pub struct ClaimBond<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(has_one = creator @ StoviaError::Unauthorized)]
    pub launch: Account<'info, Launch>,
    #[account(mut, seeds = [b"market", launch.key().as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"bond", launch.key().as_ref()], bump)]
    pub bond_vault: Account<'info, SolVault>,
}

#[derive(Accounts)]
pub struct ClaimWinnings<'info> {
    /// CHECK: payout recipient, bound to bet.bettor; claim is permissionless (crank-friendly).
    #[account(mut, address = bet.bettor @ StoviaError::Unauthorized)]
    pub bettor: UncheckedAccount<'info>,
    #[account(seeds = [b"market", market.launch.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"market_vault", market.launch.as_ref()], bump)]
    pub market_vault: Account<'info, SolVault>,
    #[account(mut, seeds = [b"bet", market.key().as_ref(), bet.bettor.as_ref()], bump = bet.bump, has_one = market)]
    pub bet: Account<'info, Bet>,
}

#[derive(Accounts)]
pub struct SweepUnrevealed<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: must equal config.treasury.
    #[account(mut, address = config.treasury @ StoviaError::InvalidTreasury)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"market", market.launch.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"market_vault", market.launch.as_ref()], bump)]
    pub market_vault: Account<'info, SolVault>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub bond_lamports: u64,
    pub platform_fee: u64,
    pub target_mcap_lamports: u64,
    pub deadline_ts: i64,
    pub reveal_end_ts: i64,
}

#[event]
pub struct Trade {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub trader: Pubkey,
    pub is_buy: bool,
    /// Buy: gross SOL paid. Sell: net SOL received.
    pub sol_amount: u64,
    pub token_amount: u64,
    pub platform_fee: u64,
    pub creator_fee: u64,
    pub virtual_sol: u64,
    pub virtual_tokens: u64,
    pub mcap_lamports: u64,
    pub timestamp: i64,
}

#[event]
pub struct BetCommitted {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub commitment: [u8; 32],
    pub amount: u64,
    pub platform_fee: u64,
}

#[event]
pub struct BetRevealed {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub side: u8,
    pub amount: u64,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub launch: Pubkey,
    pub survived: bool,
    pub twap_mcap: u64,
    pub target_mcap: u64,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub bonus_pool: u64,
    pub unrevealed: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimKind {
    Winnings,
    Bond,
    CreatorFees,
    Sweep,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub launch: Pubkey,
    pub recipient: Pubkey,
    pub kind: ClaimKind,
    pub amount: u64,
}

// ---------------------------------------------------------------- errors

#[error_code]
pub enum StoviaError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Fee exceeds maximum")]
    FeeTooHigh,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Treasury account does not match config")]
    InvalidTreasury,
    #[msg("Name empty or too long")]
    NameTooLong,
    #[msg("Symbol empty or too long")]
    SymbolTooLong,
    #[msg("URI too long")]
    UriTooLong,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Deadline too soon")]
    InvalidDeadline,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
    #[msg("Insufficient curve liquidity")]
    InsufficientLiquidity,
    #[msg("Vault balance would drop below rent floor")]
    InsufficientVaultBalance,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Betting closed: deadline passed")]
    BettingClosed,
    #[msg("Side must be 1 (survive) or 2 (die)")]
    InvalidSide,
    #[msg("Reveal window has not started")]
    RevealNotStarted,
    #[msg("Reveal window closed")]
    RevealWindowClosed,
    #[msg("Reveal window still open")]
    RevealWindowOpen,
    #[msg("Bet already revealed")]
    AlreadyRevealed,
    #[msg("Commitment does not match side/salt/bettor")]
    CommitmentMismatch,
    #[msg("Market already settled")]
    AlreadySettled,
    #[msg("Market not settled")]
    NotSettled,
    #[msg("Token did not survive")]
    NotSurvived,
    #[msg("Bet was never revealed")]
    NotRevealed,
    #[msg("Already claimed")]
    AlreadyClaimed,
    #[msg("Bet is on the losing side")]
    LosingBet,
    #[msg("Already swept")]
    AlreadySwept,
}
