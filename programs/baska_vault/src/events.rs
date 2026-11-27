use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub usdc_mint: Pubkey,
}

#[event]
pub struct FundCreated {
    pub fund: Pubkey,
    pub id: u64,
    pub share_mint: Pubkey,
    pub num_components: u8,
}

#[event]
pub struct Deposited {
    pub fund: Pubkey,
    pub user: Pubkey,
    pub usdc_in: u64,
    pub shares_out: u64,
    /// NAV per share in USD with 6 decimals, measured before the deposit.
    pub nav_per_share: u64,
}

#[event]
pub struct Redeemed {
    pub fund: Pubkey,
    pub user: Pubkey,
    pub shares_in: u64,
    pub usdc_out: u64,
}

#[event]
pub struct RedeemedInKind {
    pub fund: Pubkey,
    pub user: Pubkey,
    pub shares_in: u64,
    pub usdc_out: u64,
}

#[event]
pub struct Swapped {
    pub fund: Pubkey,
    pub from_mint: Pubkey,
    pub to_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub nav_before: u128,
    pub nav_after: u128,
    pub drift_before_bps: u64,
    pub drift_after_bps: u64,
}

#[event]
pub struct PausedChanged {
    pub fund: Pubkey, // Pubkey::default() for the global switch
    pub paused: bool,
}
