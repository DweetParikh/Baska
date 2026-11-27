use crate::errors::BundleError;
use crate::events::*;
use crate::state::*;
use crate::{math, nav};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,
    #[account(seeds = [FUND_SEED, fund.id.to_le_bytes().as_ref()], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = fund.share_mint)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = fund.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        token::mint = share_mint,
        token::authority = user,
        token::token_program = token_program,
    )]
    pub user_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    // remaining_accounts: [vault_0, feed_0, vault_1, feed_1, ...] in component order
}

pub fn process_deposit<'info>(
    ctx: Context<'info, Deposit<'info>>,
    amount: u64,
    min_shares_out: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    let fund = &ctx.accounts.fund;
    require!(!config.paused, BundleError::GlobalPaused);
    require!(!fund.paused, BundleError::FundPaused);
    require!(amount > 0, BundleError::ZeroAmount);
    require!(amount >= fund.min_deposit, BundleError::DepositTooSmall);

    // 1. NAV BEFORE moving any funds.
    let now = Clock::get()?.unix_timestamp;
    let nav_before = nav::compute_nav(fund, ctx.accounts.usdc_vault.amount, ctx.remaining_accounts, now)?;
    let supply = ctx.accounts.share_mint.supply;

    // 2. TVL cap.
    let nav_after = nav_before
        .checked_add(amount as u128)
        .ok_or(BundleError::MathOverflow)?;
    require!(nav_after <= fund.max_tvl as u128, BundleError::TvlCapExceeded);

    // 3. Shares, floored; must be non-zero and satisfy the caller's minimum.
    let shares = math::shares_for_deposit(amount, supply, nav_before)?;
    require!(shares > 0, BundleError::ZeroAmount);
    require!(shares >= min_shares_out, BundleError::SlippageExceeded);

    // 4. Move USDC in (user signs).
    let token_program_id = ctx.accounts.token_program.key();
    token_interface::transfer_checked(
        CpiContext::new(
            token_program_id,
            TransferChecked {
                from: ctx.accounts.user_usdc.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.usdc_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    // 5. Mint shares (fund PDA signs).
    let id_bytes = fund.id.to_le_bytes();
    let bump = [fund.bump];
    let seeds: &[&[u8]] = &[FUND_SEED, &id_bytes, &bump];
    token_interface::mint_to(
        CpiContext::new_with_signer(
            token_program_id,
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.fund.to_account_info(),
            },
            &[seeds],
        ),
        shares,
    )?;

    emit!(Deposited {
        fund: ctx.accounts.fund.key(),
        user: ctx.accounts.user.key(),
        usdc_in: amount,
        shares_out: shares,
        nav_per_share: math::nav_per_share(nav_before, supply),
    });
    Ok(())
}
