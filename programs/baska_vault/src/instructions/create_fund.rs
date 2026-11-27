use crate::errors::BundleError;
use crate::events::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ComponentInput {
    pub price_feed: Pubkey,
    pub target_weight_bps: u16,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateFund<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BundleError::Unauthorized)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(
        init,
        payer = admin,
        space = 8 + Fund::INIT_SPACE,
        seeds = [FUND_SEED, id.to_le_bytes().as_ref()],
        bump
    )]
    pub fund: Box<Account<'info, Fund>>,

    #[account(
        init,
        payer = admin,
        seeds = [SHARE_MINT_SEED, fund.key().as_ref()],
        bump,
        mint::decimals = SHARE_DECIMALS,
        mint::authority = fund,
        mint::token_program = token_program,
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = admin,
        seeds = [USDC_VAULT_SEED, fund.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = fund,
        token::token_program = token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Holds the dead shares. Owned by the Fund PDA; no instruction ever spends from it.
    #[account(
        init,
        payer = admin,
        seeds = [DEAD_SEED, fund.key().as_ref()],
        bump,
        token::mint = share_mint,
        token::authority = fund,
        token::token_program = token_program,
    )]
    pub dead_shares: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: [mint_0, vault_0, mint_1, vault_1, ...]
    // Each vault must be an existing token account for `mint_i` owned by the fund PDA,
    // created by the admin beforehand (e.g. as the fund's ATA).
}

#[allow(clippy::too_many_arguments)]
pub fn process_create_fund<'info>(
    ctx: Context<'info, CreateFund<'info>>,
    id: u64,
    name: [u8; 32],
    mgmt_fee_bps: u16,
    min_deposit: u64,
    max_tvl: u64,
    drift_tolerance_bps: u16,
    inputs: Vec<ComponentInput>,
) -> Result<()> {
    let n = inputs.len();
    require!(n >= 1 && n <= MAX_COMPONENTS, BundleError::InvalidComponents);
    require!(ctx.remaining_accounts.len() == n * 2, BundleError::BadRemainingAccounts);
    require!(mgmt_fee_bps <= MAX_MGMT_FEE_BPS, BundleError::InvalidFee);
    require!(min_deposit >= MIN_DEPOSIT_FLOOR, BundleError::DepositTooSmall);
    require!(drift_tolerance_bps <= BPS_DENOM, BundleError::InvalidFee);

    let fund_key = ctx.accounts.fund.key();
    let token_program_id = ctx.accounts.token_program.key();

    let mut components = [Component::default(); MAX_COMPONENTS];
    let mut weight_sum: u32 = 0;
    for (i, input) in inputs.iter().enumerate() {
        let mint_ai = &ctx.remaining_accounts[i * 2];
        let vault_ai = &ctx.remaining_accounts[i * 2 + 1];
        // Both must belong to the same token program as the fund's USDC/share accounts.
        require_keys_eq!(*mint_ai.owner, token_program_id, BundleError::MintMismatch);
        let mint = InterfaceAccount::<Mint>::try_from(mint_ai)?;
        let vault = InterfaceAccount::<TokenAccount>::try_from(vault_ai)?;
        require_keys_eq!(vault.mint, mint.key(), BundleError::VaultMismatch);
        require_keys_eq!(vault.owner, fund_key, BundleError::InvalidTokenAccount);
        require!(vault.delegate.is_none(), BundleError::InvalidTokenAccount);
        require!(vault.close_authority.is_none(), BundleError::InvalidTokenAccount);
        require!(input.target_weight_bps > 0, BundleError::InvalidWeights);
        // No duplicate mints / vaults.
        for prev in components.iter().take(i) {
            require_keys_neq!(prev.mint, mint.key(), BundleError::InvalidComponents);
            require_keys_neq!(prev.vault, vault.key(), BundleError::InvalidComponents);
        }
        weight_sum += input.target_weight_bps as u32;
        components[i] = Component {
            mint: mint.key(),
            vault: vault.key(),
            price_feed: input.price_feed,
            target_weight_bps: input.target_weight_bps,
            decimals: mint.decimals,
        };
    }
    require!(weight_sum == BPS_DENOM as u32, BundleError::InvalidWeights);

    let fund = &mut ctx.accounts.fund;
    fund.id = id;
    fund.name = name;
    fund.share_mint = ctx.accounts.share_mint.key();
    fund.usdc_vault = ctx.accounts.usdc_vault.key();
    fund.components = components;
    fund.num_components = n as u8;
    fund.mgmt_fee_bps = mgmt_fee_bps;
    fund.last_fee_ts = Clock::get()?.unix_timestamp;
    fund.min_deposit = min_deposit;
    fund.max_tvl = max_tvl;
    fund.drift_tolerance_bps = drift_tolerance_bps;
    fund.paused = false;
    fund.bump = ctx.bumps.fund;

    // Dead shares.
    let id_bytes = id.to_le_bytes();
    let bump = [ctx.bumps.fund];
    let seeds: &[&[u8]] = &[FUND_SEED, &id_bytes, &bump];
    token_interface::mint_to(
        CpiContext::new_with_signer(
            token_program_id,
            MintTo {
                mint: ctx.accounts.share_mint.to_account_info(),
                to: ctx.accounts.dead_shares.to_account_info(),
                authority: ctx.accounts.fund.to_account_info(),
            },
            &[seeds],
        ),
        DEAD_SHARES,
    )?;

    emit!(FundCreated {
        fund: fund_key,
        id,
        share_mint: ctx.accounts.share_mint.key(),
        num_components: n as u8,
    });
    Ok(())
}
