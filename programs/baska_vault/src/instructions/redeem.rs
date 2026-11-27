use crate::errors::BundleError;
use crate::events::*;
use crate::state::*;
use crate::{math, nav};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked};

// ---------------------------------------------------------------------------
// redeem_usdc: burn shares, receive USDC from the idle buffer (oracle-priced)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RedeemUsdc<'info> {
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

pub fn process_redeem_usdc<'info>(
    ctx: Context<'info, RedeemUsdc<'info>>,
    shares: u64,
    min_usdc_out: u64,
) -> Result<()> {
    let fund = &ctx.accounts.fund;
    require!(!ctx.accounts.config.paused, BundleError::GlobalPaused);
    require!(!fund.paused, BundleError::FundPaused);
    require!(shares > 0, BundleError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    let nav_now = nav::compute_nav(fund, ctx.accounts.usdc_vault.amount, ctx.remaining_accounts, now)?;
    let supply = ctx.accounts.share_mint.supply;

    let usdc_out = math::usdc_for_shares(shares, supply, nav_now)?;
    require!(usdc_out > 0, BundleError::ZeroAmount);
    require!(usdc_out >= min_usdc_out, BundleError::SlippageExceeded);
    require!(usdc_out <= ctx.accounts.usdc_vault.amount, BundleError::InsufficientIdleUsdc);

    let token_program_id = ctx.accounts.token_program.key();

    token_interface::burn(
        CpiContext::new(
            token_program_id,
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    let id_bytes = fund.id.to_le_bytes();
    let bump = [fund.bump];
    let seeds: &[&[u8]] = &[FUND_SEED, &id_bytes, &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program_id,
            TransferChecked {
                from: ctx.accounts.usdc_vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.user_usdc.to_account_info(),
                authority: ctx.accounts.fund.to_account_info(),
            },
            &[seeds],
        ),
        usdc_out,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(Redeemed {
        fund: ctx.accounts.fund.key(),
        user: ctx.accounts.user.key(),
        shares_in: shares,
        usdc_out,
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// redeem_in_kind: burn shares, receive pro-rata of EVERY vault. No oracle, no
// pause check: this is the always-available escape hatch.
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RedeemInKind<'info> {
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
    // remaining_accounts: [mint_0, vault_0, user_ata_0, mint_1, vault_1, user_ata_1, ...]
}

pub fn process_redeem_in_kind<'info>(
    ctx: Context<'info, RedeemInKind<'info>>,
    shares: u64,
) -> Result<()> {
    let fund = &ctx.accounts.fund;
    require!(shares > 0, BundleError::ZeroAmount);
    let n = fund.num_components as usize;
    require!(ctx.remaining_accounts.len() == n * 3, BundleError::BadRemainingAccounts);

    let supply = ctx.accounts.share_mint.supply;
    let token_program_id = ctx.accounts.token_program.key();
    let fund_ai = ctx.accounts.fund.to_account_info();
    let user_key = ctx.accounts.user.key();

    let id_bytes = fund.id.to_le_bytes();
    let bump = [fund.bump];
    let seeds: &[&[u8]] = &[FUND_SEED, &id_bytes, &bump];

    // Amounts are computed from pre-burn supply and pre-transfer balances.
    let usdc_out = math::pro_rata(ctx.accounts.usdc_vault.amount, shares, supply)?;

    token_interface::burn(
        CpiContext::new(
            token_program_id,
            Burn {
                mint: ctx.accounts.share_mint.to_account_info(),
                from: ctx.accounts.user_shares.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        shares,
    )?;

    if usdc_out > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program_id,
                TransferChecked {
                    from: ctx.accounts.usdc_vault.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.user_usdc.to_account_info(),
                    authority: fund_ai.clone(),
                },
                &[seeds],
            ),
            usdc_out,
            ctx.accounts.usdc_mint.decimals,
        )?;
    }

    for i in 0..n {
        let c = &fund.components[i];
        let mint_ai = &ctx.remaining_accounts[i * 3];
        let vault_ai = &ctx.remaining_accounts[i * 3 + 1];
        let user_ai = &ctx.remaining_accounts[i * 3 + 2];
        require_keys_eq!(mint_ai.key(), c.mint, BundleError::MintMismatch);
        require_keys_eq!(vault_ai.key(), c.vault, BundleError::VaultMismatch);

        let vault = InterfaceAccount::<TokenAccount>::try_from(vault_ai)?;
        let dest = InterfaceAccount::<TokenAccount>::try_from(user_ai)?;
        require_keys_eq!(dest.owner, user_key, BundleError::InvalidTokenAccount);
        require_keys_eq!(dest.mint, c.mint, BundleError::InvalidTokenAccount);

        let amt = math::pro_rata(vault.amount, shares, supply)?;
        if amt == 0 {
            continue;
        }
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                token_program_id,
                TransferChecked {
                    from: vault_ai.clone(),
                    mint: mint_ai.clone(),
                    to: user_ai.clone(),
                    authority: fund_ai.clone(),
                },
                &[seeds],
            ),
            amt,
            c.decimals,
        )?;
    }

    emit!(RedeemedInKind {
        fund: ctx.accounts.fund.key(),
        user: user_key,
        shares_in: shares,
        usdc_out,
    });
    Ok(())
}
