/**
 * FARE CACHE SERVICE
 * ─────────────────────────────────────────────────────────────
 * Stores best supplier results per route so Bodrless can:
 *   1. Respond instantly with cached prices (no API wait)
 *   2. Refresh live in the background and confirm/update
 *   3. Track price trends ("this route is rising")
 *   4. Reduce supplier API call volume significantly
 *
 * Cache behaviour by route type:
 *   East Africa / Gulf  → cache as source of truth, short TTL
 *   US / Europe         → cache as instant preview only,
 *                         always confirm live in background
 *
 * WhatsApp flow for volatile routes:
 *   Message 1 (instant): cached price + "confirming live..."
 *   Message 2 (seconds later): confirmed price or update
 *
 * Usage:
 *   // Check cache before hitting supplier APIs
 *   const cached = await fareCache.get(params, 'flight');
 *   if (cached.hit) return cached; // instant return
 *
 *   // After live search, write results to cache
 *   await fareCache.set(params, 'flight', supplierResults);
 *
 *   // Build WhatsApp message 1 (instant)
 *   const preview = fareCache.buildCachePreviewMessage(cached);
 *
 *   // After live refresh, build message 2
 *   const confirm = fareCache.buildLiveConfirmMessage(liveResult, cached);
 * ─────────────────────────────────────────────────────────────
 */

const supabase  = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// VOLATILE MARKET DETECTION
// These airports use aggressive yield management —
// prices can move every 30-60 minutes.
// ─────────────────────────────────────────────
const VOLATILE_AIRPORTS = new Set([
  // US domestic
  'JFK', 'LAX', 'ORD', 'DFW', 'MIA', 'SFO', 'BOS', 'SEA', 'ATL', 'DEN',
  'LAS', 'PHX', 'IAH', 'EWR', 'MCO', 'MSP', 'DTW', 'PHL', 'CLT', 'LGA',
  // Europe
  'LHR', 'CDG', 'AMS', 'FRA', 'MAD', 'FCO', 'ZRH', 'MUC', 'BRU', 'VIE',
  'LIS', 'CPH', 'ARN', 'OSL', 'HEL', 'DUB', 'MAN', 'BCN',
  // Transatlantic hubs
  'YYZ', 'YUL', 'GRU', 'EZE',
]);

// East African + Gulf markets — more stable, longer TTL acceptable
const STABLE_AIRPORTS = new Set([
  'NBO', 'MBA', 'KIS', 'EDL',  // Kenya
  'EBB', 'KLA',                 // Uganda
  'DAR', 'ZNZ', 'JRO',         // Tanzania
  'KGL',                        // Rwanda
  'ADD',                        // Ethiopia
  'JNB', 'CPT',                 // South Africa
  'DXB', 'DOH', 'AUH', 'RUH',  // Gulf
  'CMN', 'CAI',                 // North Africa
]);

// ─────────────────────────────────────────────
// PRICE MOVEMENT THRESHOLDS
// ─────────────────────────────────────────────
const PRICE_MOVE_THRESHOLD_PCT = 3;   // >3% change = notify traveler
const PRICE_MOVE_THRESHOLD_KES = 500; // or >KES 500 absolute

// ─────────────────────────────────────────────
// TTL CALCULATION
// Returns TTL in milliseconds based on departure
// proximity AND route volatility.
// ─────────────────────────────────────────────
function getCacheTTLms(departureDateStr, origin = '', destination = '') {
  const daysOut = departureDateStr
    ? Math.ceil((new Date(departureDateStr) - new Date()) / 86400000)
    : 30;

  const isVolatile = VOLATILE_AIRPORTS.has((origin || '').toUpperCase()) ||
                   VOLATILE_AIRPORTS.has((destination || '').toUpperCase());

  // Base TTL by departure proximity
  let baseTTLms;
  if (daysOut <= 3)        baseTTLms = 20  * 60 * 1000; // 20 min
  else if (daysOut <= 14)  baseTTLms = 60  * 60 * 1000; // 1 hr
  else if (daysOut <= 30)  baseTTLms = 2   * 60 * 60 * 1000; // 2 hrs
  else if (daysOut <= 90)  baseTTLms = 4   * 60 * 60 * 1000; // 4 hrs
  else                     baseTTLms = 8   * 60 * 60 * 1000; // 8 hrs

  // Volatile markets: halve the TTL
  return isVolatile ? Math.floor(baseTTLms / 2) : baseTTLms;
}

function isVolatileRoute(origin = '', destination = '') {
  return VOLATILE_AIRPORTS.has((origin || '').toUpperCase()) ||
       VOLATILE_AIRPORTS.has((destination || '').toUpperCase());
}

// ─────────────────────────────────────────────
// ROUTE KEY
// Canonical cache key per search permutation.
// ─────────────────────────────────────────────
function buildRouteKey(params) {
  const {
    origin, destination, departureDate, returnDate,
    passengers, cabinClass, tripType,
  } = params;

  const o      = (origin      || '').toUpperCase().trim();
  const d      = (destination || '').toUpperCase().trim();
  const dep    = departureDate || '';
  const ret    = returnDate    ? `-ret${returnDate}` : '';
  const pax    = passengers    || 1;
  const cabin  = (cabinClass  || 'economy').toLowerCase();
  const type   = (tripType    || 'return').toLowerCase();

  return `${o}-${d}-${dep}${ret}-${pax}pax-${cabin}-${type}`;
}

// ─────────────────────────────────────────────
// HOTEL CACHE KEY
// Separate key space from flights.
// ─────────────────────────────────────────────
function buildHotelRouteKey(params) {
  const { destination, checkIn, checkOut, passengers, rooms } = params;
  const d   = (destination || '').toLowerCase().trim().replace(/\s+/g, '_');
  const r   = rooms      || 1;
  const pax = passengers || 1;
  return `hotel-${d}-${checkIn}-${checkOut}-${pax}pax-${r}rooms`;
}

// ─────────────────────────────────────────────────────────────
// GET — check cache before hitting supplier APIs
//
// Returns:
//   { hit: true,  results, volatile, ageMinutes, trend }  — cache hit
//   { hit: false, volatile }                               — cache miss
// ─────────────────────────────────────────────────────────────
async function get(params, contentType = 'flight') {
  try {
    if (!params.origin && !params.destination) {
      logger.warn('FareCache.get: skipping — both origin and destination are null');
      return { hit: false, volatile: false };
    }

    const routeKey = contentType === 'hotel'
      ? buildHotelRouteKey(params)
      : buildRouteKey(params);

    const volatile = isVolatileRoute(params.origin, params.destination);

    // Fetch ALL rows for this route — including stale and expired ones.
    // We want to show stale data instantly while refreshing live,
    // rather than returning a miss and making the traveler wait cold.
    const { data, error } = await supabase
      .from('fare_cache')
      .select('*')
      .eq('route_key', routeKey)
      .eq('content_type', contentType)
      .order('price_usd', { ascending: true }); // cheapest first

    if (error) {
      logger.warn('FareCache.get: query failed', { routeKey, error: error.message });
      return { hit: false, volatile };
    }

    if (!data || data.length === 0) {
      logger.info('FareCache.get: miss', { routeKey, contentType });
      return { hit: false, volatile };
    }

    const now        = new Date();
    const freshRows  = data.filter(r => !r.is_stale && new Date(r.expires_at) > now);
    const staleRows  = data.filter(r => r.is_stale  || new Date(r.expires_at) <= now);

    // Prefer fresh rows; fall back to stale so we always have something to show
    const rows       = freshRows.length > 0 ? freshRows : staleRows;
    const isStale    = freshRows.length === 0;

    const best       = rows[0]; // cheapest
    const ageMs      = Date.now() - new Date(best.fetched_at).getTime();
    const ageMinutes = Math.round(ageMs / 60000);
    const results    = rows.map(r => r.result_snapshot);

    // Build price trend if we have history
    const trend = await getPriceTrend(routeKey, contentType, best.price_usd);

    // needsRefresh = stale, expired, or volatile (always confirm volatile live)
    const needsRefresh = isStale || volatile;

    logger.info('FareCache.get: hit', {
      routeKey, contentType,
      suppliers:    rows.map(r => r.supplier),
      bestPrice:    best.price_usd,
      bestSupplier: best.supplier,
      ageMinutes,
      isStale,
      volatile,
      needsRefresh,
    });

    return {
      hit:          true,
      results,
      best:         best.result_snapshot,
      bestPrice:    best.price_usd,
      bestPriceKES: best.price_kes,
      bestSupplier: best.supplier,
      currency:     best.currency || 'USD',
      ageMinutes,
      isStale,
      volatile,
      needsRefresh,   // caller should fire live search when true
      trend,
      routeKey,
      suppliers:    rows.map(r => ({ supplier: r.supplier, priceUsd: r.price_usd, priceKes: r.price_kes })),
    };

  } catch (err) {
    logger.error('FareCache.get threw', { error: err.message });
    return { hit: false, volatile: false };
  }
}

// ─────────────────────────────────────────────────────────────
// SET — write supplier results to cache after live search
//
// supplierResults: array of { supplier, priceUsd, priceKes,
//                             currency, result }
// Upserts one row per supplier (best price per supplier).
// ─────────────────────────────────────────────────────────────
async function set(params, contentType = 'flight', supplierResults = []) {
  try {
    const routeKey = contentType === 'hotel'
      ? buildHotelRouteKey(params)
      : buildRouteKey(params);

    const ttlMs     = getCacheTTLms(params.departureDate, params.origin, params.destination);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const now       = new Date().toISOString();

    const rows = supplierResults
      .filter(r => r && r.supplier && r.result)
      .map(r => ({
        route_key:       routeKey,
        origin:          (params.origin      || '').toUpperCase(),
        destination:     (params.destination || '').toUpperCase(),
        departure_date:  params.departureDate || null,
        return_date:     params.returnDate    || null,
        passengers:      params.passengers    || 1,
        cabin_class:     params.cabinClass    || 'economy',
        trip_type:       params.tripType      || 'return',
        supplier:        r.supplier,
        content_type:    contentType,
        price_usd:       r.priceUsd   || null,
        price_kes:       r.priceKes   || null,
        currency:        r.currency   || 'USD',
        result_snapshot: r.result,
        fetched_at:      now,
        expires_at:      expiresAt,
        is_stale:        false,
      }));

    if (rows.length === 0) {
      logger.warn('FareCache.set: no valid rows to write', { routeKey });
      return;
    }

    const { error } = await supabase
      .from('fare_cache')
      .upsert(rows, { onConflict: 'route_key,supplier,content_type' });

    if (error) {
      logger.warn('FareCache.set: upsert failed', { routeKey, error: error.message });
    } else {
      logger.info('FareCache.set: written', {
        routeKey, contentType,
        suppliers: rows.map(r => `${r.supplier}@${r.price_usd}`),
        expiresAt,
      });
    }

    // Write price history for trend tracking
    await writePriceHistory(routeKey, contentType, rows);

  } catch (err) {
    logger.error('FareCache.set threw', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// MARK STALE — force refresh on next request
// Call when you know prices have changed (e.g. after a booking
// removes seats from inventory on this route).
// ─────────────────────────────────────────────────────────────
async function markStale(routeKey, contentType = 'flight') {
  try {
    await supabase
      .from('fare_cache')
      .update({ is_stale: true })
      .eq('route_key', routeKey)
      .eq('content_type', contentType);

    logger.info('FareCache.markStale', { routeKey, contentType });
  } catch (err) {
    logger.error('FareCache.markStale threw', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// PRICE HISTORY — for trend detection
// Written alongside every cache set. Separate table so we
// don't bloat fare_cache with historical rows.
// ─────────────────────────────────────────────────────────────
async function writePriceHistory(routeKey, contentType, rows) {
  try {
    const history = rows.map(r => ({
      route_key:    routeKey,
      content_type: contentType,
      supplier:     r.supplier,
      price_usd:    r.price_usd,
      price_kes:    r.price_kes,
      currency:     r.currency,
      recorded_at:  r.fetched_at,
    }));

    await supabase.from('fare_price_history').insert(history);
  } catch (err) {
    // Non-critical — don't throw
    logger.warn('FareCache.writePriceHistory failed', { error: err.message });
  }
}

async function getPriceTrend(routeKey, contentType, currentPriceUsd) {
  try {
    if (!currentPriceUsd) return null;

    // Get last 5 price points for this route across all suppliers
    const { data } = await supabase
      .from('fare_price_history')
      .select('price_usd, recorded_at')
      .eq('route_key', routeKey)
      .eq('content_type', contentType)
      .order('recorded_at', { ascending: false })
      .limit(10);

    if (!data || data.length < 2) return null;

    const prices    = data.map(r => r.price_usd).filter(Boolean);
    const oldest    = prices[prices.length - 1];
    const change    = currentPriceUsd - oldest;
    const changePct = Math.round((change / oldest) * 100);

    if (Math.abs(changePct) < 2) return null; // noise, ignore

    return {
      direction:  change > 0 ? 'up' : 'down',
      changePct:  Math.abs(changePct),
      changeUsd:  Math.abs(Math.round(change)),
      overPoints: prices.length,
      signal:     Math.abs(changePct) >= 10 ? 'strong' : 'mild',
    };

  } catch (err) {
    return null; // non-critical
  }
}

// ─────────────────────────────────────────────────────────────
// DETECT PRICE MOVEMENT
// Compare new live price against cached price.
// Returns nudge payload if movement is significant.
// ─────────────────────────────────────────────────────────────
function detectPriceMovement(cachedPriceUsd, livePriceUsd, currency = 'USD') {
  if (!cachedPriceUsd || !livePriceUsd) return null;

  const change    = livePriceUsd - cachedPriceUsd;
  const changePct = Math.abs(change / cachedPriceUsd) * 100;

  // Convert USD change to KES for display (rough 130x rate)
  const changeKes = Math.abs(Math.round(change * 130));

  if (changePct < PRICE_MOVE_THRESHOLD_PCT && changeKes < PRICE_MOVE_THRESHOLD_KES) {
    return null; // no meaningful movement
  }

  return {
    direction:  change > 0 ? 'up' : 'down',
    changePct:  Math.round(changePct),
    changeUsd:  Math.abs(Math.round(change)),
    changeKes,
    significant: changePct >= 10 || changeKes >= 2000,
  };
}

// ─────────────────────────────────────────────────────────────
// WHATSAPP MESSAGE BUILDERS
// ─────────────────────────────────────────────────────────────

/**
 * Message 1 — instant response from cache.
 * Sent immediately while live refresh fires in background.
 * Always shows:
 *   - Best price + winning supplier
 *   - All other suppliers checked + their prices (or "no availability")
 *   - Price trend if detected
 *   - Stale/age notice + "confirming now" footer
 */
function buildCachePreviewMessage(cacheResult, params = {}) {
  const {
    bestPriceKES, bestPrice, bestSupplier, ageMinutes,
    volatile, isStale, trend, suppliers = [],
  } = cacheResult;

  const dest     = (params.destination || 'your destination').toUpperCase();
  const dep      = params.departureDate
    ? new Date(params.departureDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : '';
  const pax      = params.passengers || 1;
  const paxLabel = pax > 1 ? ` · ${pax} pax` : '';

  const lines = [];

  // ── Header ───────────────────────────────────
  lines.push(`✈️ *${dest}${dep ? ` · ${dep}` : ''}${paxLabel}*`);
  lines.push('');

  // ── Best price ───────────────────────────────
  if (bestPriceKES) {
    lines.push(`Best price: *KES ${Math.round(bestPriceKES).toLocaleString()}*`);
  }

  // ── Supplier breakdown — always show all suppliers checked ──
  // Even if only one has a result, list what was checked
  const ALL_FLIGHT_SUPPLIERS = ['duffel', 'travelduqa'];
  const ALL_HOTEL_SUPPLIERS  = ['hotelbeds'];
  const allSuppliers = params.contentType === 'hotel'
    ? ALL_HOTEL_SUPPLIERS
    : ALL_FLIGHT_SUPPLIERS;

  const supplierLines = allSuppliers.map(s => {
    const found = suppliers.find(r => r.supplier === s);
    if (!found) {
      // Supplier was checked but had no availability or wasn't cached yet
      return `  • ${_supplierLabel(s)}: _checking..._`;
    }
    const kes    = found.priceKes || Math.round((found.priceUsd || 0) * 130);
    const isBest = s === bestSupplier;
    return isBest
      ? `  • ${_supplierLabel(s)}: *KES ${kes.toLocaleString()}* ✓ best`
      : `  • ${_supplierLabel(s)}: KES ${kes.toLocaleString()}`;
  });

  lines.push(`_Checked ${allSuppliers.length} suppliers:_`);
  lines.push(...supplierLines);

  // ── Trend signal ─────────────────────────────
  if (trend) {
    lines.push('');
    const icon     = trend.direction === 'up' ? '📈' : '📉';
    const strength = trend.signal === 'strong' ? '' : 'slightly ';
    lines.push(`${icon} _Prices on this route have ${strength}${trend.direction === 'up' ? 'risen' : 'dropped'} ${trend.changePct}% recently_`);
  }

  // ── Age / stale notice + confirming footer ───
  lines.push('');
  if (isStale) {
    lines.push(`_⚠️ Cached price — confirming live now..._`);
  } else if (volatile) {
    lines.push(`_⚡ Active market — confirming live price now..._`);
  } else if (ageMinutes < 60) {
    lines.push(`_Checked ${ageMinutes} min ago — confirming now..._`);
  } else {
    const hrs = Math.round(ageMinutes / 60);
    lines.push(`_Checked ${hrs}h ago — confirming now..._`);
  }

  return lines.join('\n');
}

// Human-readable supplier labels for WhatsApp messages
function _supplierLabel(supplier) {
  const labels = {
    duffel:     'Duffel',
    travelduqa: 'TravelDuqa',
    hotelbeds:  'HotelBeds',
    iabiri:     'IABIRI',
  };
  return labels[supplier] || supplier;
}

/**
 * Message 2 — live confirmation sent after background refresh.
 * Shows whether price held, dropped, or rose.
 */
function buildLiveConfirmMessage(liveResult, previousCache = null) {
  if (!liveResult) {
    return `⚠️ Could not reach live pricing right now. The price shown above was last confirmed — I'd recommend booking soon to lock it in.`;
  }

  const liveKes    = liveResult.priceKes || Math.round((liveResult.priceUsd || 0) * 130);
  const cachedKes  = previousCache?.bestPriceKES;
  const movement   = previousCache
    ? detectPriceMovement(previousCache.bestPrice, liveResult.priceUsd)
    : null;

  const lines = [];

  if (!movement) {
    // Price held
    lines.push(`✅ *Price confirmed: KES ${liveKes.toLocaleString()}*`);
    lines.push(`_Good to go — this fare is live and available._`);
  } else if (movement.direction === 'down') {
    // Price dropped — good news
    lines.push(`🎉 *Price dropped! Now KES ${liveKes.toLocaleString()}*`);
    lines.push(`_Down KES ${movement.changeKes.toLocaleString()} (${movement.changePct}%) since we last checked._`);
  } else {
    // Price rose
    lines.push(`⚠️ *Price updated: KES ${liveKes.toLocaleString()}*`);
    lines.push(`_Up KES ${movement.changeKes.toLocaleString()} (${movement.changePct}%) from earlier._`);
    if (movement.significant) {
      lines.push(`_Prices on this route are moving — worth booking soon if you're keen._`);
    }
  }

  lines.push('');
  lines.push('Shall I go ahead and hold this for you?');

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────
// CACHE STATS — for admin dashboard / monitoring
// ─────────────────────────────────────────────────────────────
async function getStats() {
  try {
    const { data } = await supabase
      .from('fare_cache')
      .select('content_type, is_stale, expires_at, supplier');

    if (!data) return null;

    const now      = new Date();
    const total    = data.length;
    const fresh    = data.filter(r => !r.is_stale && new Date(r.expires_at) > now).length;
    const stale    = data.filter(r => r.is_stale).length;
    const expired  = data.filter(r => new Date(r.expires_at) <= now).length;
    const flights  = data.filter(r => r.content_type === 'flight').length;
    const hotels   = data.filter(r => r.content_type === 'hotel').length;

    const bySupplier = {};
    for (const r of data) {
      bySupplier[r.supplier] = (bySupplier[r.supplier] || 0) + 1;
    }

    return { total, fresh, stale, expired, flights, hotels, bySupplier };
  } catch (err) {
    logger.error('FareCache.getStats threw', { error: err.message });
    return null;
  }
}

module.exports = {
  get,
  set,
  markStale,
  buildCachePreviewMessage,
  buildLiveConfirmMessage,
  detectPriceMovement,
  buildRouteKey,
  buildHotelRouteKey,
  getCacheTTLms,
  isVolatileRoute,
  getStats,
};