use anchor_lang::prelude::*;

#[error_code]
pub enum BundleError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Caller is not authorised")]
    Unauthorized,
    #[msg("Protocol is paused")]
    GlobalPaused,
    #[msg("Fund is paused")]
    FundPaused,
    #[msg("Deposit below fund minimum")]
    DepositTooSmall,
    #[msg("Deposit would exceed fund TVL cap")]
    TvlCapExceeded,
    #[msg("Computed share/USDC amount is below the caller's minimum")]
    SlippageExceeded,
    #[msg("Zero amount")]
    ZeroAmount,
    #[msg("Fund NAV is zero while shares are outstanding")]
    ZeroNav,
    #[msg("Not enough idle USDC in the fund; use redeem_in_kind")]
    InsufficientIdleUsdc,
    #[msg("Invalid component list")]
    InvalidComponents,
    #[msg("Target weights must sum to 10_000 bps")]
    InvalidWeights,
    #[msg("Invalid fee")]
    InvalidFee,
    #[msg("Wrong number of remaining accounts")]
    BadRemainingAccounts,
    #[msg("Vault account does not match the fund component")]
    VaultMismatch,
    #[msg("Mint account does not match the fund component")]
    MintMismatch,
    #[msg("Token account has a delegate or invalid owner")]
    InvalidTokenAccount,
    #[msg("Price feed account does not match the fund component")]
    OracleMismatch,
    #[msg("Oracle price is stale")]
    OracleStale,
    #[msg("Oracle confidence interval too wide")]
    OracleConfidence,
    #[msg("Oracle price is not positive")]
    InvalidPrice,
    #[msg("No production oracle is configured in this build")]
    OracleNotConfigured,
    #[msg("This instruction is only available in devnet builds")]
    DevnetOnly,
    #[msg("Component index out of range")]
    InvalidComponentIndex,
    #[msg("Swap would increase weight drift from target")]
    SwapIncreasesDrift,
    #[msg("Swap lowered NAV by more than max_slippage_bps")]
    NavSlippageExceeded,
    #[msg("Swap output is zero")]
    SwapZeroOutput,
}
