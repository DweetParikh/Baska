use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod nav;
pub mod oracle;
pub mod state;

pub use instructions::*;

// Placeholder id. Run `anchor keys sync` after the first build to replace it.
declare_id!("H8RhPUZy8tpL3nJbpvpXwjg8vWFWNfvuT2iF9PcoPrgu");

#[program]
pub mod baska_vault {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        keeper: Pubkey,
        fee_recipient: Pubkey,
        max_slippage_bps: u16,
    ) -> Result<()> {
        instructions::process_initialize_config(ctx, keeper, fee_recipient, max_slippage_bps)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_fund<'info>(
        ctx: Context<'info, CreateFund<'info>>,
        id: u64,
        name: [u8; 32],
        mgmt_fee_bps: u16,
        min_deposit: u64,
        max_tvl: u64,
        drift_tolerance_bps: u16,
        components: Vec<ComponentInput>,
    ) -> Result<()> {
        instructions::process_create_fund(
            ctx,
            id,
            name,
            mgmt_fee_bps,
            min_deposit,
            max_tvl,
            drift_tolerance_bps,
            components,
        )
    }

    pub fn deposit<'info>(
        ctx: Context<'info, Deposit<'info>>,
        amount: u64,
        min_shares_out: u64,
    ) -> Result<()> {
        instructions::process_deposit(ctx, amount, min_shares_out)
    }

    pub fn redeem_usdc<'info>(
        ctx: Context<'info, RedeemUsdc<'info>>,
        shares: u64,
        min_usdc_out: u64,
    ) -> Result<()> {
        instructions::process_redeem_usdc(ctx, shares, min_usdc_out)
    }

    pub fn redeem_in_kind<'info>(
        ctx: Context<'info, RedeemInKind<'info>>,
        shares: u64,
    ) -> Result<()> {
        instructions::process_redeem_in_kind(ctx, shares)
    }

    pub fn execute_swap<'info>(
        ctx: Context<'info, ExecuteSwap<'info>>,
        direction: SwapDirection,
        component_index: u8,
        amount_in: u64,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::process_execute_swap(ctx, direction, component_index, amount_in, min_amount_out)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::process_set_paused(ctx, paused)
    }

    pub fn set_global_paused(ctx: Context<SetGlobalPaused>, paused: bool) -> Result<()> {
        instructions::process_set_global_paused(ctx, paused)
    }

    // Devnet-only mock oracle (handlers fail unless built with `devnet`).
    pub fn init_mock_feed(ctx: Context<InitMockFeed>, price: i64, expo: i32, conf: u64) -> Result<()> {
        instructions::process_init_mock_feed(ctx, price, expo, conf)
    }

    pub fn set_mock_price(ctx: Context<SetMockPrice>, price: i64, conf: u64) -> Result<()> {
        instructions::process_set_mock_price(ctx, price, conf)
    }
}
