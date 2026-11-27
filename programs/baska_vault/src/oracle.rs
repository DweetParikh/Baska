//! Price reads with staleness + confidence checks.
//!
//! Market-hours policy (guide 5.4, option b): US equities only price during
//! market hours, so feeds go stale off-hours. We do NOT widen staleness; a stale
//! feed makes `deposit` / `redeem_usdc` revert while `redeem_in_kind` (which
//! needs no oracle) stays open.

use crate::errors::BundleError;
#[cfg(feature = "devnet")]
use crate::state::MockPriceFeed;
use anchor_lang::prelude::*;

pub const MAX_STALENESS_SECS: i64 = 60;
/// Reject if conf / price > 1%.
pub const MAX_CONF_BPS: u128 = 100;

pub struct PriceData {
    pub price: i64,
    pub expo: i32,
}

pub fn validate(price: i64, conf: u64, publish_time: i64, expo: i32, now: i64) -> Result<PriceData> {
    require!(price > 0, BundleError::InvalidPrice);
    // Also rejects feeds dated in the future (publish_time > now) as stale/invalid.
    let age = now.checked_sub(publish_time).ok_or(BundleError::OracleStale)?;
    require!((0..=MAX_STALENESS_SECS).contains(&age), BundleError::OracleStale);
    require!(
        (conf as u128) * 10_000 <= (price as u128) * MAX_CONF_BPS,
        BundleError::OracleConfidence
    );
    Ok(PriceData { price, expo })
}

pub fn read_price<'info>(
    feed: &'info AccountInfo<'info>,
    expected: &Pubkey,
    now: i64,
) -> Result<PriceData> {
    require_keys_eq!(feed.key(), *expected, BundleError::OracleMismatch);
    read_inner(feed, now)
}

#[cfg(feature = "devnet")]
fn read_inner<'info>(feed: &'info AccountInfo<'info>, now: i64) -> Result<PriceData> {
    // `Account::try_from` checks owner == this program and the discriminator.
    let f = Account::<MockPriceFeed>::try_from(feed)?;
    validate(f.price, f.conf, f.publish_time, f.expo, now)
}

#[cfg(not(feature = "devnet"))]
fn read_inner<'info>(_feed: &'info AccountInfo<'info>, _now: i64) -> Result<PriceData> {
    // TODO: parse Pyth PriceUpdateV2 once pyth-solana-receiver-sdk is pinned to a
    // version compatible with Anchor 1.2. Fail closed until then.
    err!(BundleError::OracleNotConfigured)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_price_ok() {
        assert!(validate(100_000, 100, 1_000, -3, 1_030).is_ok());
    }

    #[test]
    fn stale_price_rejected() {
        assert!(validate(100_000, 100, 1_000, -3, 1_061).is_err());
    }

    #[test]
    fn future_price_rejected() {
        assert!(validate(100_000, 100, 1_100, -3, 1_000).is_err());
    }

    #[test]
    fn wide_confidence_rejected() {
        // conf 2% of price
        assert!(validate(100_000, 2_000, 1_000, -3, 1_000).is_err());
        // conf exactly 1% passes
        assert!(validate(100_000, 1_000, 1_000, -3, 1_000).is_ok());
    }
}
