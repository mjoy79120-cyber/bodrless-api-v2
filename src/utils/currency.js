/**
 * CURRENCY UTILITY
 * ─────────────────────────────────────────────────────────────
 * Converts supplier prices (EUR from HotelBeds, KES from
 * TravelDuqa/Supabase) into a single canonical display currency
 * so package totals are mathematically correct.
 *
 * Canonical currency: KES
 *
 * Rates are fetched from Open ER-API (open.er-api.com) — free,
 * no API key required, supports KES — and cached in-memory
 * for 6 hours to avoid hammering the API on every search.
 *
 * A hardcoded fallback rate is used if the API is unreachable,
 * so a network blip never breaks the booking flow. Update
 * FALLBACK_RATES periodically (e.g. monthly) to keep it reasonable.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('./logger');

const CANONICAL_CURRENCY = 'KES';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Fallback rates: 1 unit of [currency] = X KES
// Update these periodically — last set: June 2026, approx EUR/KES ~151
const FALLBACK_RATES_TO_KES = {
  KES: 1,
  EUR: 151,
  USD: 129,
  GBP: 176,
};

let _cache = {
  rates: { ...FALLBACK_RATES_TO_KES },
  fetchedAt: 0,
};

/**
 * Refresh the rates cache from Open ER-API if stale.
 * Fails silently to the existing cache (or fallback) on error.
 */
async function _refreshRatesIfStale() {
  const isStale = Date.now() - _cache.fetchedAt > CACHE_TTL_MS;
  if (!isStale) return;

  try {
    // Base = KES. Swapped from Frankfurter because Frankfurter doesn't support KES.
    const response = await axios.get('https://open.er-api.com/v6/latest/KES', {
      timeout: 5000,
    });

    if (response.data?.result !== 'success') {
      throw new Error('Exchange rate provider returned an unsuccessful status');
    }

    const rates = response.data?.rates || {};
    const updated = { KES: 1 };
    const targetCurrencies = ['EUR', 'USD', 'GBP'];

    for (const currency of targetCurrencies) {
      const kesToCurrency = rates[currency];
      if (kesToCurrency > 0) {
        updated[currency] = 1 / kesToCurrency; // invert to "1 unit currency = X KES"
      }
    }

    _cache = { rates: updated, fetchedAt: Date.now() };
    logger.info('Currency rates refreshed successfully', { rates: updated });

  } catch (err) {
    logger.warn('Currency rate refresh failed — using cached/fallback rates', { error: err.message });
    // Keep existing cache; don't update fetchedAt so we retry next call
  }
}

/**
 * Convert an amount from one currency to KES (canonical).
 * Always await this before doing arithmetic across suppliers.
 */
async function toKES(amount, fromCurrency) {
  if (!amount) return 0;
  const currency = (fromCurrency || 'KES').toUpperCase();
  if (currency === 'KES') return Number(amount);

  await _refreshRatesIfStale();

  const rate = _cache.rates[currency];
  if (!rate) {
    logger.warn('Unknown currency for conversion — treating as KES 1:1', { currency });
    return Number(amount);
  }

  return Math.round(Number(amount) * rate);
}

/**
 * Convert a batch of {amount, currency} pairs to KES in one pass.
 * Useful for summing a package's flight + hotel + transfer prices
 * which may each be in a different currency.
 */
async function sumToKES(items) {
  await _refreshRatesIfStale();
  let total = 0;
  for (const item of items) {
    total += await toKES(item.amount, item.currency);
  }
  return total;
}

/**
 * Get the current cached rate for a currency (1 unit = X KES).
 * Synchronous — uses whatever's cached, won't trigger a refresh.
 * Useful for display purposes ("rates last updated...") without
 * forcing an await in hot paths.
 */
function getCachedRate(currency) {
  return _cache.rates[(currency || 'KES').toUpperCase()] || 1;
}

module.exports = {
  CANONICAL_CURRENCY,
  toKES,
  sumToKES,
  getCachedRate,
};