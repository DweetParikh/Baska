//! Pure integer math for NAV / shares. u128 everywhere, no floats.
//! Every division floors, so rounding dust stays in the fund.

use crate::errors::BundleError;
use crate::state::DEAD_SHARES;
use anchor_lang::prelude::*;

fn overflow() -> Error {
    error!(BundleError::MathOverflow)
}

fn pow10(e: u32) -> Result<u128> {
    10u128.checked_pow(e).ok_or_else(overflow)
}

/// USD value (6 decimals) of `balance` base units of a token with
/// `token_decimals`, priced at `price * 10^expo` USD per whole token.
pub fn component_value_usd6(balance: u64, token_decimals: u8, price: i64, expo: i32) -> Result<u128> {
    require!(price > 0, BundleError::InvalidPrice);
    let num = (balance as u128)
        .checked_mul(price as u128)
        .ok_or_else(overflow)?;
    // value = balance * price * 10^(expo + 6 - decimals)
    let e = expo as i64 + 6 - token_decimals as i64;
    if e >= 0 {
        num.checked_mul(pow10(e as u32)?).ok_or_else(overflow)
    } else if -e > 38 {
        Ok(0)
    } else {
        Ok(num / pow10((-e) as u32)?)
    }
}

/// Whole-token base units of a component worth `usdc` (USD6) at the given price,
/// floored. Inverse of `component_value_usd6`.
pub fn stock_for_usdc(usdc: u64, token_decimals: u8, price: i64, expo: i32) -> Result<u128> {
    require!(price > 0, BundleError::InvalidPrice);
    // base units = usdc * 10^(decimals - 6 - expo) / price
    let k = token_decimals as i64 - 6 - expo as i64;
    let usdc = usdc as u128;
    if k >= 0 {
        let num = usdc.checked_mul(pow10(k as u32)?).ok_or_else(overflow)?;
        Ok(num / price as u128)
    } else if -k > 38 {
        Ok(0)
    } else {
        let den = (price as u128)
            .checked_mul(pow10((-k) as u32)?)
            .ok_or_else(overflow)?;
        Ok(usdc / den)
    }
}

/// Take `fee_bps` off a swap output, floored.
pub fn apply_fee_bps(amount: u128, fee_bps: u16) -> Result<u64> {
    let net = amount
        .checked_mul(10_000u128 - fee_bps as u128)
        .ok_or_else(overflow)?
        / 10_000u128;
    u64::try_from(net).map_err(|_| overflow())
}

/// Shares to mint for `deposit` USDC given current `supply` (incl. dead shares)
/// and `nav` (USD6) measured BEFORE the deposit.
pub fn shares_for_deposit(deposit: u64, supply: u64, nav: u128) -> Result<u64> {
    let shares: u128 = if supply <= DEAD_SHARES {
        // No real shares outstanding: 1 share = $1.
        deposit as u128
    } else {
        require!(nav > 0, BundleError::ZeroNav);
        (deposit as u128)
            .checked_mul(supply as u128)
            .ok_or_else(overflow)?
            / nav
    };
    u64::try_from(shares).map_err(|_| overflow())
}

/// USDC (base units) owed for burning `shares`, floored.
pub fn usdc_for_shares(shares: u64, supply: u64, nav: u128) -> Result<u64> {
    require!(supply > 0, BundleError::ZeroNav);
    let out = (shares as u128)
        .checked_mul(nav)
        .ok_or_else(overflow)?
        / supply as u128;
    u64::try_from(out).map_err(|_| overflow())
}

/// Pro-rata slice of a vault `balance` for `shares` of `supply`, floored.
pub fn pro_rata(balance: u64, shares: u64, supply: u64) -> Result<u64> {
    require!(supply > 0, BundleError::ZeroNav);
    let out = (balance as u128)
        .checked_mul(shares as u128)
        .ok_or_else(overflow)?
        / supply as u128;
    u64::try_from(out).map_err(|_| overflow())
}

/// NAV per share, USD6 (0 when no supply).
pub fn nav_per_share(nav: u128, supply: u64) -> u64 {
    if supply == 0 {
        return 0;
    }
    u64::try_from(nav.saturating_mul(1_000_000) / supply as u128).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_one_token_at_150_usd() {
        // 1 token (9 dec) at 150.00000000 (expo -8) => $150 => 150e6
        let v = component_value_usd6(1_000_000_000, 9, 15_000_000_000, -8).unwrap();
        assert_eq!(v, 150_000_000);
    }

    #[test]
    fn handles_positive_scale() {
        // 1 token (6 dec) at price 3 expo 2 => $300
        assert_eq!(component_value_usd6(1_000_000, 6, 3, 2).unwrap(), 300_000_000);
    }

    #[test]
    fn rejects_non_positive_price() {
        assert!(component_value_usd6(1, 6, 0, 0).is_err());
        assert!(component_value_usd6(1, 6, -5, 0).is_err());
    }

    #[test]
    fn first_deposit_is_one_to_one() {
        assert_eq!(shares_for_deposit(5_000_000, DEAD_SHARES, 0).unwrap(), 5_000_000);
    }

    #[test]
    fn second_deposit_is_proportional() {
        // supply 10M shares, nav $20M => each share worth $2 => $10 buys 5 shares
        assert_eq!(shares_for_deposit(10_000_000, 10_000_000, 20_000_000).unwrap(), 5_000_000);
    }

    #[test]
    fn deposit_rejected_when_nav_zero_with_real_supply() {
        assert!(shares_for_deposit(1_000_000, 10_000_000, 0).is_err());
    }

    #[test]
    fn round_trip_never_gains_value() {
        // For many (deposit, supply, nav) triples: deposit -> redeem <= deposit.
        for supply in [2_000u64, 1_000_000, 123_456_789, 10_000_000_000] {
            for nav in [1u128, 999, 1_000_000, 987_654_321, 50_000_000_000] {
                for dep in [1u64, 7, 1_000_000, 33_333_333, 9_999_999_999] {
                    // Absurd ratios (shares > u64::MAX) correctly overflow-revert; skip them.
                    let Ok(shares) = shares_for_deposit(dep, supply, nav) else {
                        continue;
                    };
                    // after the deposit: supply' = supply+shares, nav' = nav+dep
                    let out = usdc_for_shares(
                        shares,
                        supply + shares,
                        nav + dep as u128,
                    )
                    .unwrap();
                    assert!(out <= dep, "gained value: dep={dep} out={out}");
                }
            }
        }
    }

    #[test]
    fn stock_for_usdc_inverts_value() {
        // $150 buys 1 token (9 dec) at price 150 (expo -8)
        assert_eq!(
            stock_for_usdc(150_000_000, 9, 15_000_000_000, -8).unwrap(),
            1_000_000_000
        );
        // never returns more value than paid in (floor)
        for usdc in [1u64, 999, 1_000_000, 123_456_789] {
            for (dec, price, expo) in [(9u8, 20_000_000_000i64, -8i32), (6, 5_000_000_000, -8), (8, 7, 1)] {
                let units = stock_for_usdc(usdc, dec, price, expo).unwrap();
                let back = component_value_usd6(units as u64, dec, price, expo).unwrap();
                assert!(back <= usdc as u128, "usdc={usdc} dec={dec} back={back}");
            }
        }
    }

    #[test]
    fn fee_is_floored() {
        assert_eq!(apply_fee_bps(10_000, 10).unwrap(), 9_990);
        assert_eq!(apply_fee_bps(999, 10).unwrap(), 998);
    }

    #[test]
    fn redeem_floors() {
        // 1 share of 3, nav 10 => 3.33 -> 3
        assert_eq!(usdc_for_shares(1, 3, 10).unwrap(), 3);
        assert_eq!(pro_rata(10, 1, 3).unwrap(), 3);
    }
}
