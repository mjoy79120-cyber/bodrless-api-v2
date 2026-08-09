/**
 * CACHED SEARCH
 * ─────────────────────────────────────────────────────────────
 * Sits between the engine and all four supplier adapters.
 * The engine calls THIS instead of adapters directly.
 *
 * Flow per search:
 *   1. Check fareCache for all suppliers on this route
 *   2a. FULL HIT (all suppliers fresh, stable route)
 *       → Return cached results immediately. Zero API calls.
 *   2b. PARTIAL or STALE HIT
 *       → Return instant preview message to WhatsApp
 *       → Fire live supplier APIs in parallel (existing behaviour)
 *       → Write results to cache
 *       → Return live confirm message
 *   2c. MISS
 *       → Fire all supplier APIs in parallel
 *       → Write results to cache
 *       → Return results normally (no two-message pattern needed)
 *
 * The engine's parallel supplier calls are UNCHANGED — we still
 * always query Duffel + TravelDuqa together for flights,
 * HotelBeds for hotels, IABIRI for buses. Best price still wins.
 * The cache just skips the API calls when we already have fresh data.
 *
 * Usage (replace your engine's direct adapter calls with these):
 *
 *   // Flights
 *   const result = await cachedSearch.flights(params, sendWhatsApp);
 *
 *   // Hotels
 *   const result = await cachedSearch.hotels(params, sendWhatsApp);
 *
 *   // Buses
 *   const result = await cachedSearch.buses(params, sendWhatsApp);
 *
 * sendWhatsApp is an async fn(message) that sends a WA message to
 * the current traveler. Pass null for widget searches.
 *
 * Widget behaviour:
 *   - sendWhatsApp is null — no two-message pattern
 *   - Returns { results, best, fromCache, cacheAge, isStale, needsRefresh }
 *   - Widget reads needsRefresh to show a spinner while live results load
 *   - Widget calls the same endpoint again after receiving needsRefresh:true
 *     to get the confirmed live price (or polls until isStale:false)
 *
 * Channel detection:
 *   Pass channel: 'widget' | 'whatsapp' in params.
 *   Defaults to 'whatsapp' when sendWhatsApp is provided,
 *   'widget' when null.
 * ─────────────────────────────────────────────────────────────
 */

const fareCache   = require('./fareCache');
const { logger }  = require('../utils/logger');

// Lazy-load adapters — same pattern used throughout this codebase
function getDuffel()     { return require('../adapters/duffel');     }
function getTravelDuqa() { return require('../adapters/travelduqa'); }
function getHotelBeds()  { return require('../adapters/hotelbeds');  }
function getIabiri()     { return require('../adapters/travler');     }

// ─────────────────────────────────────────────
// CHANNEL DETECTION
// ─────────────────────────────────────────────
function _channel(params, sendWhatsApp) {
  if (params.channel) return params.channel;
  return sendWhatsApp ? 'whatsapp' : 'widget';
}

// ─────────────────────────────────────────────
// FLIGHT SEARCH
// Queries Duffel + TravelDuqa in parallel.
//
// Returns:
//   WhatsApp: { results, best, fromCache, cacheAge, isStale }
//   Widget:   { results, best, fromCache, cacheAge, isStale,
//               needsRefresh, cachePreview, supplierComparison }
// ─────────────────────────────────────────────
async function flights(params, sendWhatsApp = null) {
  const contentType = 'flight';
  const channel     = _channel(params, sendWhatsApp);

  // ── 1. Cache check ────────────────────────────────────────────
  const cached = await fareCache.get(params, contentType);

  if (cached.hit && !cached.needsRefresh) {
    logger.info('CachedSearch.flights: full cache hit', {
      route:    `${params.origin}→${params.destination}`,
      age:      cached.ageMinutes,
      supplier: cached.bestSupplier,
      channel,
    });
    return _buildReturn(cached.results, cached, true, channel);
  }

  // ── 2a. WhatsApp: send instant preview message ────────────────
  if (cached.hit && cached.needsRefresh && channel === 'whatsapp') {
    const previewMsg = fareCache.buildCachePreviewMessage(cached, {
      ...params, contentType,
    });
    await _safeSend(sendWhatsApp, previewMsg);
  }

  // ── 2b. Widget: return stale data immediately with needsRefresh ──
  // Widget JS reads needsRefresh:true, shows a spinner overlay,
  // then re-calls the search endpoint to get the live-confirmed result.
  if (cached.hit && cached.needsRefresh && channel === 'widget') {
    logger.info('CachedSearch.flights: widget stale hit — returning with needsRefresh', {
      route: `${params.origin}→${params.destination}`,
      age:   cached.ageMinutes,
    });

    // Fire live search in background (non-blocking) so by the time
    // the widget re-calls, cache is already warm with fresh data.
    _backgroundRefresh(() => _liveFlight(params, cached));

    return _buildReturn(cached.results, cached, true, channel);
  }

  // ── 3. Live supplier calls (parallel, unchanged) ──────────────
  logger.info('CachedSearch.flights: firing live search', {
    route:  `${params.origin}→${params.destination}`,
    reason: cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss',
    channel,
  });

  const { allResults, cacheRows } = await _liveFlight(params, cached);

  // ── 4. Write to cache ─────────────────────────────────────────
  if (cacheRows.length > 0) {
    await fareCache.set(params, contentType, cacheRows).catch(err =>
      logger.warn('CachedSearch.flights: cache write failed', { error: err.message })
    );
  }

  // ── 5. WhatsApp: live confirm message ─────────────────────────
  if (cached.hit && channel === 'whatsapp') {
    const best       = _pickBest(allResults);
    const liveResult = best
      ? { priceUsd: _toUsd(best.price, best.currency), priceKes: _toKes(best.price, best.currency) }
      : null;
    await _safeSend(sendWhatsApp, fareCache.buildLiveConfirmMessage(liveResult, cached));
  }

  return _buildReturn(allResults, cached, false, channel);
}

// Extracted so both the foreground call and _backgroundRefresh can use it
async function _liveFlight(params, cached) {
  const [duffelRes, travelduqaRes] = await Promise.allSettled([
    getDuffel().search(params),
    getTravelDuqa().search(params),
  ]);

  const duffelResults     = duffelRes.status    === 'fulfilled' ? duffelRes.value    : [];
  const travelduqaResults = travelduqaRes.status === 'fulfilled' ? travelduqaRes.value : [];
  const allResults        = [...duffelResults, ...travelduqaResults];
  const cacheRows         = _buildFlightCacheRows(duffelResults, travelduqaResults, params);

  return { allResults, cacheRows };
}

// ─────────────────────────────────────────────
// HOTEL SEARCH
// Queries HotelBeds only (single supplier).
// Returns { results, best, fromCache, cacheAge }
// ─────────────────────────────────────────────
async function hotels(params, sendWhatsApp = null) {
  const contentType = 'hotel';
  const channel     = _channel(params, sendWhatsApp);

  const cacheParams = {
    destination:   params.destination,
    departureDate: params.checkIn,
    returnDate:    params.checkOut,
    passengers:    params.adults || 1,
    origin:        params.destination, // hotels use destination as route key origin
  };

  // ── 1. Cache check ────────────────────────────────────────────
  const cached = await fareCache.get(cacheParams, contentType);

  if (cached.hit && !cached.needsRefresh) {
    logger.info('CachedSearch.hotels: full cache hit', {
      destination: params.destination,
      age:         cached.ageMinutes,
      channel,
    });
    return _buildReturn(cached.results, cached, true, channel);
  }

  if (cached.hit && cached.needsRefresh && channel === 'whatsapp') {
    await _safeSend(sendWhatsApp, fareCache.buildCachePreviewMessage(cached, {
      ...cacheParams, contentType,
    }));
  }

  if (cached.hit && cached.needsRefresh && channel === 'widget') {
    _backgroundRefresh(() => _liveHotel(params, cacheParams, contentType));
    return _buildReturn(cached.results, cached, true, channel);
  }

  // ── 2. Live supplier call ─────────────────────────────────────
  logger.info('CachedSearch.hotels: firing live search', {
    destination: params.destination,
    reason:      cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss',
    channel,
  });

  const { hotelResults } = await _liveHotel(params, cacheParams, contentType);

  // ── 3. WhatsApp: live confirm ─────────────────────────────────
  if (cached.hit && channel === 'whatsapp') {
    const best       = hotelResults.sort((a, b) => a.totalRate - b.totalRate)[0] || null;
    const liveResult = best
      ? { priceUsd: _toUsd(best.totalRate, best.currency || 'EUR'), priceKes: _toKes(best.totalRate, best.currency || 'EUR') }
      : null;
    await _safeSend(sendWhatsApp, fareCache.buildLiveConfirmMessage(liveResult, cached));
  }

  return _buildReturn(hotelResults, cached, false, channel);
}

async function _liveHotel(params, cacheParams, contentType) {
  let hotelResults = [];
  try {
    hotelResults = await getHotelBeds().search(params);
  } catch (err) {
    logger.warn('CachedSearch.hotels: HotelBeds search failed', { error: err.message });
  }

  if (hotelResults.length > 0) {
    const best = hotelResults.sort((a, b) => a.totalRate - b.totalRate)[0];
    await fareCache.set(cacheParams, contentType, [{
      supplier: 'hotelbeds',
      priceUsd: _toUsd(best.totalRate, best.currency || 'EUR'),
      priceKes: _toKes(best.totalRate, best.currency || 'EUR'),
      currency: best.currency || 'EUR',
      result:   best,
    }]).catch(err => logger.warn('CachedSearch.hotels: cache write failed', { error: err.message }));
  }

  return { hotelResults };
}

// ─────────────────────────────────────────────
// BUS SEARCH (IABIRI)
// Bus prices are in KES and very stable —
// longer TTL applied, no volatile route logic needed.
// Returns { results, best, fromCache, cacheAge }
// ─────────────────────────────────────────────
async function buses(params, sendWhatsApp = null) {
  const contentType = 'bus';
  const channel     = _channel(params, sendWhatsApp);

  const cacheParams = {
    origin:        params.origin,
    destination:   params.destination,
    departureDate: params.date,
    passengers:    params.passengers || 1,
    cabinClass:    'standard',
    tripType:      'one_way',
  };

  // ── 1. Cache check ────────────────────────────────────────────
  const cached = await fareCache.get(cacheParams, contentType);

  if (cached.hit && !cached.needsRefresh) {
    logger.info('CachedSearch.buses: full cache hit', {
      route: `${params.origin}→${params.destination}`,
      age:   cached.ageMinutes,
      channel,
    });
    return _buildReturn(cached.results, cached, true, channel);
  }

  if (cached.hit && cached.needsRefresh && channel === 'whatsapp') {
    await _safeSend(sendWhatsApp, fareCache.buildCachePreviewMessage(cached, {
      ...cacheParams, contentType,
    }));
  }

  if (cached.hit && cached.needsRefresh && channel === 'widget') {
    _backgroundRefresh(() => _liveBus(params, cacheParams, contentType));
    return _buildReturn(cached.results, cached, true, channel);
  }

  // ── 2. Live supplier call ─────────────────────────────────────
  logger.info('CachedSearch.buses: firing live search', {
    route:  `${params.origin}→${params.destination}`,
    reason: cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss',
    channel,
  });

  const { busResults } = await _liveBus(params, cacheParams, contentType);

  // ── 3. WhatsApp: live confirm ─────────────────────────────────
  if (cached.hit && channel === 'whatsapp') {
    const best       = busResults.sort((a, b) => a.price - b.price)[0] || null;
    const liveResult = best ? { priceUsd: _toUsd(best.price, 'KES'), priceKes: best.price } : null;
    await _safeSend(sendWhatsApp, fareCache.buildLiveConfirmMessage(liveResult, cached));
  }

  return _buildReturn(busResults, cached, false, channel);
}

async function _liveBus(params, cacheParams, contentType) {
  let busResults = [];
  try {
    busResults = await getIabiri().search(params);
  } catch (err) {
    logger.warn('CachedSearch.buses: IABIRI search failed', { error: err.message });
  }

  if (busResults.length > 0) {
    const best = busResults.sort((a, b) => a.price - b.price)[0];
    await fareCache.set(cacheParams, contentType, [{
      supplier: 'iabiri',
      priceUsd: _toUsd(best.price, 'KES'),
      priceKes: best.price,
      currency: 'KES',
      result:   best,
    }]).catch(err => logger.warn('CachedSearch.buses: cache write failed', { error: err.message }));
  }

  return { busResults };
}

// ─────────────────────────────────────────────
// COMBINED TRANSPORT SEARCH
// Mirrors what your engine's searchTransport likely does —
// fires flights + buses in parallel and returns both.
// Use this for routes where the traveler hasn't specified
// transport mode (e.g. "Nairobi to Mombasa").
// ─────────────────────────────────────────────
async function transport(params, sendWhatsApp = null) {
  const [flightResult, busResult] = await Promise.allSettled([
    flights(params, sendWhatsApp),
    buses({
      origin:      params.origin,
      destination: params.destination,
      date:        params.departureDate,
      passengers:  params.passengers,
    }, null), // don't double-send WA for buses on a combined search
  ]);

  return {
    flights: flightResult.status === 'fulfilled' ? flightResult.value : { results: [], fromCache: false },
    buses:   busResult.status   === 'fulfilled' ? busResult.value   : { results: [], fromCache: false },
  };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function _buildFlightCacheRows(duffelResults, travelduqaResults, params) {
  const rows = [];

  // Best Duffel result
  if (duffelResults.length > 0) {
    const best = _pickBest(duffelResults);
    if (best) {
      rows.push({
        supplier: 'duffel',
        priceUsd: _toUsd(best.price, best.currency),
        priceKes: _toKes(best.price, best.currency),
        currency: best.currency || 'KES',
        result:   best,
      });
    }
  }

  // Best TravelDuqa result
  if (travelduqaResults.length > 0) {
    const best = _pickBest(travelduqaResults);
    if (best) {
      rows.push({
        supplier: 'travelduqa',
        priceUsd: _toUsd(best.price, best.currency),
        priceKes: _toKes(best.price, best.currency),
        currency: best.currency || 'KES',
        result:   best,
      });
    }
  }

  return rows;
}

function _pickBest(results) {
  if (!results || results.length === 0) return null;
  return results
    .filter(r => r && (r.price || r.totalRate))
    .sort((a, b) => {
      const pa = _toKes(a.price || a.totalRate || 0, a.currency);
      const pb = _toKes(b.price || b.totalRate || 0, b.currency);
      return pa - pb;
    })[0] || null;
}

function _buildReturn(results, cached, fromCache, channel = 'whatsapp') {
  const base = {
    results,
    best:         _pickBest(results),
    fromCache,
    cacheAge:     cached?.ageMinutes  || null,
    isStale:      cached?.isStale     || false,
    needsRefresh: cached?.needsRefresh || false,
    suppliers:    cached?.suppliers    || [],
  };

  // Widget gets extra fields the frontend JS needs to manage UI state
  if (channel === 'widget') {
    base.widget = {
      // true = show spinner overlay, re-call search endpoint
      showRefreshSpinner: cached?.needsRefresh || false,
      // Cached price to display immediately while refreshing
      cachedPriceKES:     cached?.bestPriceKES || null,
      cachedSupplier:     cached?.bestSupplier || null,
      // How old the displayed price is
      priceAgeMinutes:    cached?.ageMinutes   || null,
      // Supplier comparison for the widget price table
      supplierBreakdown:  (cached?.suppliers || []).map(s => ({
        supplier: s.supplier,
        priceKes: s.priceKes || Math.round((s.priceUsd || 0) * 130),
        isBest:   s.supplier === cached?.bestSupplier,
      })),
      // Price trend for the widget badge ("↑ 8% this week")
      trend: cached?.trend || null,
    };
  }

  return base;
}

// Fire a refresh in the background without blocking the response.
// Used by widget channel when returning stale data immediately.
function _backgroundRefresh(fn) {
  Promise.resolve()
    .then(fn)
    .catch(err => logger.warn('CachedSearch: background refresh failed', { error: err.message }));
}

// Approximate conversion rates — good enough for cache comparison.
// Real rates applied at display time by the engine/formatter.
const FX = {
  KES: 1,
  USD: 130,
  EUR: 143,
  GBP: 167,
};

function _toKes(amount, currency = 'KES') {
  const rate = FX[(currency || 'KES').toUpperCase()] || 130;
  return Math.round(Number(amount || 0) * rate);
}

function _toUsd(amount, currency = 'KES') {
  const kes = _toKes(amount, currency);
  return Math.round(kes / FX.USD * 100) / 100;
}

async function _safeSend(sendWhatsApp, message) {
  try {
    if (typeof sendWhatsApp === 'function' && message) {
      await sendWhatsApp(message);
    }
  } catch (err) {
    logger.warn('CachedSearch: WhatsApp send failed', { error: err.message });
  }
}

module.exports = { flights, hotels, buses, transport };