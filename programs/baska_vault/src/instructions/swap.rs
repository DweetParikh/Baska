use crate::errors::BundleError;
use crate::events::*;
use crate::state::*;
use crate::{math, nav, oracle};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SwapDirection {
    /// idle USDC -> component token
    Buy,
    /// component token -> idle USDC
    Sell,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    pub keeper: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = keeper @ BundleError::Unauthorized)]
    pub config: Box<Account<'info, GlobalConfig>>,
    #[account(seeds = [FUND_SEED, fund.id.to_le_bytes().as_ref()], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = fund.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Checked against `fund.components[component_index]` in the handler.
    pub component_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub component_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA that owns the mock liquidity accounts; only used as a signer via seeds.
    #[account(seeds = [LIQUIDITY_SEED], bump)]
    pub liquidity_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = liquidity_authority,
        token::token_program = token_program,
    )]
    pub liquidity_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = component_mint,
        token::authority = liquidity_authority,
        token::token_program = token_program,
    )]
    pub liquidity_stock: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: [vault_0, feed_0, vault_1, feed_1, ...] in component order
}

#[allow(clippy::too_many_arguments)]
fn transfer<'info>(
    token_program: Pubkey,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    seeds: &[&[u8]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from,
                mint,
                to,
                authority,
            },
            &[seeds],
        ),
        amount,
        decimals,
    )
}

/// Keeper-only rebalancing swap against the DEVNET mock DEX (oracle price, fixed fee).
///
/// Post-conditions (guide 5.5):
///  1. NAV after >= NAV before * (10_000 - max_slippage_bps) / 10_000
///  2. weight drift from target must not increase
///  3. only the fund's own component (or USDC) can be traded
///
/// TODO(mainnet): replace the mock leg with a CPI into Jupiter/Sunrise using route
/// accounts from `remaining_accounts`; the same post-conditions apply unchanged.
pub fn process_execute_swap<'info>(
    mut ctx: Context<'info, ExecuteSwap<'info>>,
    direction: SwapDirection,
    component_index: u8,
    amount_in: u64,
    min_amount_out: u64,
) -> Result<()> {
    require!(cfg!(feature = "devnet"), BundleError::DevnetOnly);
    require!(!ctx.accounts.config.paused, BundleError::GlobalPaused);
    require!(!ctx.accounts.fund.paused, BundleError::FundPaused);
    require!(amount_in > 0, BundleError::ZeroAmount);

    let idx = component_index as usize;
    require!(
        idx < ctx.accounts.fund.num_components as usize,
        BundleError::InvalidComponentIndex
    );
    let c = ctx.accounts.fund.components[idx];
    require_keys_eq!(ctx.accounts.component_mint.key(), c.mint, BundleError::MintMismatch);
    require_keys_eq!(ctx.accounts.component_vault.key(), c.vault, BundleError::VaultMismatch);

    let remaining = ctx.remaining_accounts;
    let now = Clock::get()?.unix_timestamp;

    // ---- before ----
    let before = nav::compute_breakdown(&ctx.accounts.fund, ctx.accounts.usdc_vault.amount, remaining, now)?;
    let drift_before = nav::drift_bps(&ctx.accounts.fund, &before);
    let price = oracle::read_price(&remaining[idx * 2 + 1], &c.price_feed, now)?;

    // ---- quote at oracle price, minus mock DEX fee ----
    let amount_out = match direction {
        SwapDirection::Buy => {
            let gross = math::stock_for_usdc(amount_in, c.decimals, price.price, price.expo)?;
            math::apply_fee_bps(gross, MOCK_SWAP_FEE_BPS)?
        }
        SwapDirection::Sell => {
            let gross = math::component_value_usd6(amount_in, c.decimals, price.price, price.expo)?;
            math::apply_fee_bps(gross, MOCK_SWAP_FEE_BPS)?
        }
    };
    require!(amount_out > 0, BundleError::SwapZeroOutput);
    require!(amount_out >= min_amount_out, BundleError::SlippageExceeded);

    // ---- execute ----
    let token_program_id = ctx.accounts.token_program.key();
    let fund_id_bytes = ctx.accounts.fund.id.to_le_bytes();
    let fund_bump = [ctx.accounts.fund.bump];
    let fund_seeds: &[&[u8]] = &[FUND_SEED, &fund_id_bytes, &fund_bump];
    let liq_bump = [ctx.bumps.liquidity_authority];
    let liq_seeds: &[&[u8]] = &[LIQUIDITY_SEED, &liq_bump];
    let usdc_dec = ctx.accounts.usdc_mint.decimals;
    let fund_ai = ctx.accounts.fund.to_account_info();
    let liq_ai = ctx.accounts.liquidity_authority.to_account_info();

    let (from_mint, to_mint) = match direction {
        SwapDirection::Buy => {
            // fund USDC -> liquidity USDC ; liquidity stock -> fund component vault
            transfer(
                token_program_id,
                ctx.accounts.usdc_vault.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
                ctx.accounts.liquidity_usdc.to_account_info(),
                fund_ai.clone(),
                fund_seeds,
                amount_in,
                usdc_dec,
            )?;
            transfer(
                token_program_id,
                ctx.accounts.liquidity_stock.to_account_info(),
                ctx.accounts.component_mint.to_account_info(),
                ctx.accounts.component_vault.to_account_info(),
                liq_ai,
                liq_seeds,
                amount_out,
                c.decimals,
            )?;
            (ctx.accounts.usdc_mint.key(), c.mint)
        }
        SwapDirection::Sell => {
            // fund component -> liquidity stock ; liquidity USDC -> fund USDC
            transfer(
                token_program_id,
                ctx.accounts.component_vault.to_account_info(),
                ctx.accounts.component_mint.to_account_info(),
                ctx.accounts.liquidity_stock.to_account_info(),
                fund_ai.clone(),
                fund_seeds,
                amount_in,
                c.decimals,
            )?;
            transfer(
                token_program_id,
                ctx.accounts.liquidity_usdc.to_account_info(),
                ctx.accounts.usdc_mint.to_account_info(),
                ctx.accounts.usdc_vault.to_account_info(),
                liq_ai,
                liq_seeds,
                amount_out,
                usdc_dec,
            )?;
            (c.mint, ctx.accounts.usdc_mint.key())
        }
    };

    // ---- after: re-read live balances and enforce post-conditions ----
    ctx.accounts.usdc_vault.reload()?;
    let after = nav::compute_breakdown(&ctx.accounts.fund, ctx.accounts.usdc_vault.amount, remaining, now)?;
    let drift_after = nav::drift_bps(&ctx.accounts.fund, &after);

    let floor = before
        .total
        .checked_mul(10_000u128 - ctx.accounts.config.max_slippage_bps as u128)
        .ok_or(BundleError::MathOverflow)?
        / 10_000u128;
    require!(after.total >= floor, BundleError::NavSlippageExceeded);
    require!(drift_after <= drift_before, BundleError::SwapIncreasesDrift);

    emit!(Swapped {
        fund: ctx.accounts.fund.key(),
        from_mint,
        to_mint,
        amount_in,
        amount_out,
        nav_before: before.total,
        nav_after: after.total,
        drift_before_bps: drift_before as u64,
        drift_after_bps: drift_after as u64,
    });
    Ok(())
}
