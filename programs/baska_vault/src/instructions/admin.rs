use crate::errors::BundleError;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Box<Account<'info, GlobalConfig>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub system_program: Program<'info, System>,
}

pub fn process_initialize_config(
    ctx: Context<InitializeConfig>,
    keeper: Pubkey,
    fee_recipient: Pubkey,
    max_slippage_bps: u16,
) -> Result<()> {
    require!(max_slippage_bps <= BPS_DENOM, BundleError::InvalidFee);
    let c = &mut ctx.accounts.config;
    c.admin = ctx.accounts.admin.key();
    c.keeper = keeper;
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.fee_recipient = fee_recipient;
    c.max_slippage_bps = max_slippage_bps;
    c.paused = false;
    c.bump = ctx.bumps.config;
    emit!(ConfigInitialized {
        admin: c.admin,
        keeper,
        usdc_mint: c.usdc_mint,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BundleError::Unauthorized)]
    pub config: Box<Account<'info, GlobalConfig>>,
    #[account(mut, seeds = [FUND_SEED, fund.id.to_le_bytes().as_ref()], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
}

/// Pauses `deposit` and `redeem_usdc` for one fund. `redeem_in_kind` is never gated.
pub fn process_set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.fund.paused = paused;
    emit!(PausedChanged {
        fund: ctx.accounts.fund.key(),
        paused
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetGlobalPaused<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BundleError::Unauthorized)]
    pub config: Box<Account<'info, GlobalConfig>>,
}

pub fn process_set_global_paused(ctx: Context<SetGlobalPaused>, paused: bool) -> Result<()> {
    ctx.accounts.config.paused = paused;
    emit!(PausedChanged {
        fund: Pubkey::default(),
        paused
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Devnet-only mock oracle
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitMockFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + MockPriceFeed::INIT_SPACE)]
    pub feed: Account<'info, MockPriceFeed>,
    pub system_program: Program<'info, System>,
}

pub fn process_init_mock_feed(ctx: Context<InitMockFeed>, price: i64, expo: i32, conf: u64) -> Result<()> {
    require!(cfg!(feature = "devnet"), BundleError::DevnetOnly);
    require!(price > 0, BundleError::InvalidPrice);
    let f = &mut ctx.accounts.feed;
    f.authority = ctx.accounts.authority.key();
    f.price = price;
    f.expo = expo;
    f.conf = conf;
    f.publish_time = Clock::get()?.unix_timestamp;
    Ok(())
}

#[derive(Accounts)]
pub struct SetMockPrice<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority @ BundleError::Unauthorized)]
    pub feed: Account<'info, MockPriceFeed>,
}

pub fn process_set_mock_price(ctx: Context<SetMockPrice>, price: i64, conf: u64) -> Result<()> {
    require!(cfg!(feature = "devnet"), BundleError::DevnetOnly);
    require!(price > 0, BundleError::InvalidPrice);
    let f = &mut ctx.accounts.feed;
    f.price = price;
    f.conf = conf;
    f.publish_time = Clock::get()?.unix_timestamp;
    Ok(())
}
