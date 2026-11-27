use anchor_lang::prelude::*;

pub const MAX_COMPONENTS: usize = 10;
pub const BPS_DENOM: u16 = 10_000;
/// Share mint decimals (matches USDC so 1 share = $1 at launch).
pub const SHARE_DECIMALS: u8 = 6;
/// Shares minted to a fund-owned, unspendable account at creation. Blunts
/// share-inflation (donation) attacks together with `MIN_DEPOSIT_FLOOR`.
pub const DEAD_SHARES: u64 = 1_000;
/// Smallest allowed `min_deposit` for a fund ($1 in USDC base units).
pub const MIN_DEPOSIT_FLOOR: u64 = 1_000_000;
pub const MAX_MGMT_FEE_BPS: u16 = 1_000;

pub const CONFIG_SEED: &[u8] = b"config";
pub const FUND_SEED: &[u8] = b"fund";
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";
pub const USDC_VAULT_SEED: &[u8] = b"usdc_vault";
pub const DEAD_SEED: &[u8] = b"dead";
/// PDA that owns the devnet mock-swap liquidity token accounts.
pub const LIQUIDITY_SEED: &[u8] = b"mock_liquidity";
/// Fee the devnet mock DEX takes from every swap output.
pub const MOCK_SWAP_FEE_BPS: u16 = 10;

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    pub admin: Pubkey, // multisig on mainnet
    pub keeper: Pubkey,
    pub usdc_mint: Pubkey,
    pub fee_recipient: Pubkey,
    pub max_slippage_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Component {
    pub mint: Pubkey,
    pub vault: Pubkey,      // token account owned by the Fund PDA
    pub price_feed: Pubkey, // Pyth PriceUpdateV2 or MockPriceFeed
    pub target_weight_bps: u16,
    pub decimals: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Fund {
    pub id: u64,
    pub name: [u8; 32],
    pub share_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub components: [Component; MAX_COMPONENTS],
    pub num_components: u8,
    pub mgmt_fee_bps: u16,
    pub last_fee_ts: i64,
    pub min_deposit: u64,
    pub max_tvl: u64,
    pub drift_tolerance_bps: u16,
    pub paused: bool,
    pub bump: u8,
}

/// Admin-writable oracle for localnet/devnet. Mirrors the fields we use from Pyth.
#[account]
#[derive(InitSpace)]
pub struct MockPriceFeed {
    pub authority: Pubkey,
    pub price: i64,
    pub expo: i32,
    pub conf: u64,
    pub publish_time: i64,
}
