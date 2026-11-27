use crate::errors::BundleError;
use crate::state::{Fund, BPS_DENOM, MAX_COMPONENTS};
use crate::{math, oracle};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

pub struct Breakdown {
    pub idle: u128,
    pub values: [u128; MAX_COMPONENTS],
    pub n: usize,
    pub total: u128,
}

/// Per-component USD6 values + idle USDC.
///
/// `accts` must be `[vault_0, feed_0, vault_1, feed_1, ...]` in component order.
/// Call BEFORE moving funds so balances reflect pre-instruction state.
pub fn compute_breakdown<'info>(
    fund: &Fund,
    idle_usdc: u64,
    accts: &'info [AccountInfo<'info>],
    now: i64,
) -> Result<Breakdown> {
    let n = fund.num_components as usize;
    require!(accts.len() >= n * 2, BundleError::BadRemainingAccounts);

    let mut b = Breakdown {
        idle: idle_usdc as u128,
        values: [0u128; MAX_COMPONENTS],
        n,
        total: idle_usdc as u128,
    };
    for i in 0..n {
        let c = &fund.components[i];
        let vault_ai = &accts[i * 2];
        let feed_ai = &accts[i * 2 + 1];
        require_keys_eq!(vault_ai.key(), c.vault, BundleError::VaultMismatch);
        let vault = InterfaceAccount::<TokenAccount>::try_from(vault_ai)?;
        let p = oracle::read_price(feed_ai, &c.price_feed, now)?;
        let v = math::component_value_usd6(vault.amount, c.decimals, p.price, p.expo)?;
        b.values[i] = v;
        b.total = b.total.checked_add(v).ok_or(BundleError::MathOverflow)?;
    }
    Ok(b)
}

/// NAV in USD6 = idle USDC + sum(component value).
pub fn compute_nav<'info>(
    fund: &Fund,
    idle_usdc: u64,
    accts: &'info [AccountInfo<'info>],
    now: i64,
) -> Result<u128> {
    let n = fund.num_components as usize;
    require!(accts.len() == n * 2, BundleError::BadRemainingAccounts);
    Ok(compute_breakdown(fund, idle_usdc, accts, now)?.total)
}

/// Sum over components of |actual_weight - target_weight| in bps, measured
/// against total NAV (idle cash included in the denominator). Cash is not a
/// target asset, so it is excluded from the sum: deploying idle USDC into an
/// underweight component lowers drift, buying an overweight one raises it.
pub fn drift_bps(fund: &Fund, b: &Breakdown) -> u128 {
    if b.total == 0 {
        return 0;
    }
    let mut d: u128 = 0;
    for i in 0..b.n {
        let actual = b.values[i] * BPS_DENOM as u128 / b.total;
        let target = fund.components[i].target_weight_bps as u128;
        d += actual.abs_diff(target);
    }
    d
}
