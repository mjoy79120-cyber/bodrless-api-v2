/**
 * CACHED SEARCH
 * ─────────────────────────────────────────────────────────────
 * Sits between the engine and all supplier adapters.
 * The engine calls THIS instead of adapters directly.
 *
 * HOTEL SUPPLIERS (parallel):
 *   HotelBeds + RateHawk both searched simultaneously.
 *   Results merged, deduped by name+city, sorted cheapest first.
 *   If one has no availability, the other fills in silently.
 * ─────────────────────────────────────────────────────────────
 */

const fareCache  = require('./fareCache');
const { logger } = require('../utils/logger');

function getDuffel()     { return require('../adapters/duffel');          }
function getTravelDuqa() { return require('../adapters/travelduqa');      }
function getHotelBeds()  { return require('../adapters/hotelbeds');       }
function getRateHawk() { return require('../adapters/ratehawk'); }
function getIabiri()     { return require('../adapters/travler');          }

function _channel(params, sendWhatsApp) {
  if (params.channel) return params.channel;
  return sendWhatsApp ? 'whatsapp' : 'widget';
}

// ─────────────────────────────────────────────
// FLIGHT SEARCH — unchanged
// ─────────────────────────────────────────────
async function flights(params, sendWhatsApp = null) {
  const contentType = 'flight';
  const channel     = _channel(params, sendWhatsApp);

  const cached = await fareCache.get(params, contentType);

  if (cached.hit && !cached.needsRefresh) {
    logger.info('CachedSearch.flights: full cache hit', {
      route: `${params.origin}→${params.destination}`, age: cached.ageMinutes, channel,
    });
    return _buildReturn(cached.results, cached, true, channel);
  }

  if (cached.hit && cached.needsRefresh && channel === 'whatsapp') {
    await _safeSend(sendWhatsApp, fareCache.buildCachePreviewMessage(cached, { ...params, contentType }));
  }

  if (cached.hit && cached.needsRefresh && channel === 'widget') {
    logger.info('CachedSearch.flights: widget stale hit — returning with needsRefresh', {
      route: `${params.origin}→${params.destination}`, age: cached.ageMinutes,
    });
    _backgroundRefresh(() => _liveFlight(params, cached));
    return _buildReturn(cached.results, cached, true, channel);
  }

  logger.info('CachedSearch.flights: firing live search', {
    route: `${params.origin}→${params.destination}`,
    reason: cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss',
    channel,
  });

  const { allResults, cacheRows } = await _liveFlight(params, cached);

  if (cacheRows.length > 0) {
    await fareCache.set(params, contentType, cacheRows).catch(err =>
      logger.warn('CachedSearch.flights: cache write failed', { error: err.message })
    );
  }

  if (cached.hit && channel === 'whatsapp') {
    const best = _pickBest(allResults);
    const liveResult = best
      ? { priceUsd: _toUsd(best.price, best.currency), priceKes: _toKes(best.price, best.currency) }
      : null;
    await _safeSend(sendWhatsApp, fareCache.buildLiveConfirmMessage(liveResult, cached));
  }

  return _buildReturn(allResults, cached, false, channel);
}

async function _liveFlight(params, cached) {
  const [duffelRes, travelduqaRes] = await Promise.allSettled([
    getDuffel().search({ ...params, date: params.departureDate }),
    getTravelDuqa().search({ ...params, date: params.departureDate }),
  ]);

  const duffelResults     = duffelRes.status    === 'fulfilled' ? duffelRes.value    : [];
  const travelduqaResults = travelduqaRes.status === 'fulfilled' ? travelduqaRes.value : [];
  const allResults        = [...duffelResults, ...travelduqaResults];
  const cacheRows         = _buildFlightCacheRows(duffelResults, travelduqaResults, params);

  return { allResults, cacheRows };
}

// ─────────────────────────────────────────────
// HOTEL SEARCH
// HotelBeds + RateHawk in parallel.
//
// Merge logic:
//   1. Both run via Promise.allSettled — one failing never kills the other
//   2. Results combined into one array
//   3. Deduped by normalised name+city — same property keeps cheaper rate
//   4. Sorted cheapest first (totalRate in KES equivalent)
//   5. Cache stores the cheapest result (supplier-agnostic)
// ─────────────────────────────────────────────
async function hotels(params, sendWhatsApp = null) {
  const contentType = 'hotel';
  const channel     = _channel(params, sendWhatsApp);

  const cacheParams = {
    destination:   params.destination,
    departureDate: params.checkIn,
    returnDate:    params.checkOut,
    passengers:    params.adults || 1,
    origin:        params.destination,
  };

  const cached = await fareCache.get(cacheParams, contentType);

  if (cached.hit && !cached.needsRefresh) {
    logger.info('CachedSearch.hotels: full cache hit', {
      destination: params.destination, age: cached.ageMinutes, channel,
    });
    return _buildReturn(cached.results, cached, true, channel);
  }

  if (cached.hit && cached.needsRefresh && channel === 'whatsapp') {
    await _safeSend(sendWhatsApp, fareCache.buildCachePreviewMessage(cached, { ...cacheParams, contentType }));
  }

  if (cached.hit && cached.needsRefresh && channel === 'widget') {
    _backgroundRefresh(() => _liveHotel(params, cacheParams, contentType));
    return _buildReturn(cached.results, cached, true, channel);
  }

  logger.info('CachedSearch.hotels: firing live search (HotelBeds + RateHawk)', {
    destination: params.destination,
    reason: cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss',
    channel,
  });

  const { hotelResults } = await _liveHotel(params, cacheParams, contentType);

  if (cached.hit && channel === 'whatsapp') {
    const best = hotelResults[0] || null; // already sorted cheapest first
    const liveResult = best
      ? { priceUsd: _toUsd(best.totalRate, best.currency || 'USD'), priceKes: _toKes(best.totalRate, best.currency || 'USD') }
      : null;
    await _safeSend(sendWhatsApp, fareCache.buildLiveConfirmMessage(liveResult, cached));
  }

  return _buildReturn(hotelResults, cached, false, channel);
}

// ─────────────────────────────────────────────
// _liveHotel — parallel HotelBeds + RateHawk
// ─────────────────────────────────────────────
async function _liveHotel(params, cacheParams, contentType) {
  const [hbRes, rhRes] = await Promise.allSettled([
    getHotelBeds().search(params),
    getRateHawk().search(params),
  ]);

  const hbResults = hbRes.status === 'fulfilled' ? (hbRes.value || []) : [];
  const rhResults = rhRes.status === 'fulfilled' ? (rhRes.value || []) : [];

  if (hbRes.status === 'rejected') {
    logger.warn('CachedSearch.hotels: HotelBeds search failed', { error: hbRes.reason?.message });
  }
  if (rhRes.status === 'rejected') {
    logger.warn('CachedSearch.hotels: RateHawk search failed', { error: rhRes.reason?.message });
  }

  logger.info('CachedSearch.hotels: supplier results', {
    destination: params.destination,
    hotelBeds:   hbResults.length,
    rateHawk:    rhResults.length,
  });

  const combined     = [...hbResults, ...rhResults];
  const deduped      = _dedupeHotels(combined);
  const hotelResults = _sortHotelsCheapest(deduped);

  logger.info('CachedSearch.hotels: merged results', {
    destination: params.destination,
    combined:    combined.length,
    afterDedupe: hotelResults.length,
  });

  if (hotelResults.length > 0) {
    const best = hotelResults[0];
    await fareCache.set(cacheParams, contentType, [{
      supplier: best.supplier,
      priceUsd: _toUsd(best.totalRate, best.currency || 'USD'),
      priceKes: _toKes(best.totalRate, best.currency || 'USD'),
      currency: best.currency || 'USD',
      result:   best,
    }]).catch(err =>
      logger.warn('CachedSearch.hotels: cache write failed', { error: err.message })
    );
  }

  return { hotelResults };
}

// ─────────────────────────────────────────────
// HOTEL DEDUP
// Same property from two suppliers — keep cheaper.
// Key: normalised name + first word of location.
// ─────────────────────────────────────────────
function _dedupeHotels(hotels) {
  const seen = new Map();

  for (const hotel of hotels) {
    const key = _hotelDedupeKey(hotel);
    if (!key) continue;

    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, hotel);
      continue;
    }

    const existingKES = _toKes(existing.totalRate || 0, existing.currency || 'USD');
    const hotelKES    = _toKes(hotel.totalRate    || 0, hotel.currency    || 'USD');

    if (hotelKES < existingKES) {
      logger.info('CachedSearch.hotels: deduped — kept cheaper', {
        name:            hotel.name,
        keptSupplier:    hotel.supplier,    keptKES:    hotelKES,
        droppedSupplier: existing.supplier, droppedKES: existingKES,
      });
      seen.set(key, hotel);
    }
  }

  return Array.from(seen.values());
}

function _hotelDedupeKey(hotel) {
  if (!hotel.name) return null;

  const normName = (hotel.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normLocation = (hotel.location || hotel.city || hotel.destination || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')[0];

  if (!normName) return null;
  return `${normName}|${normLocation}`;
}

function _sortHotelsCheapest(hotels) {
  return [...hotels].sort((a, b) => {
    const aKES = _toKes(a.totalRate || 0, a.currency || 'USD');
    const bKES = _toKes(b.totalRate || 0, b.currency || 'USD');
    return aKES - bKES;
  });
}

// ─────────────────────────────────────────────
// BUS SEARCH (IABIRI) — unchanged
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

  const cached = await fareCache.get(cacheParams, contentType);

  if (cached.hit && !cached.needsRefresh) {
    logger.info('CachedSearch.buses: full cache hit', {
      route: `${params.origin}→${params.destination}`, age: cached.ageMinutes, channel,
    });
    return _buildReturn(cached.results, cached, true, channel);
  }

  if (cached.hit && cached.needsRefresh && channel === 'whatsapp') {
    await _safeSend(sendWhatsApp, fareCache.buildCachePreviewMessage(cached, { ...cacheParams, contentType }));
  }

  if (cached.hit && cached.needsRefresh && channel === 'widget') {
    _backgroundRefresh(() => _liveBus(params, cacheParams, contentType));
    return _buildReturn(cached.results, cached, true, channel);
  }

  logger.info('CachedSearch.buses: firing live search', {
    route: `${params.origin}→${params.destination}`,
    reason: cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss',
    channel,
  });

  const { busResults } = await _liveBus(params, cacheParams, contentType);

  if (cached.hit && channel === 'whatsapp') {
    const best = busResults.sort((a, b) => a.price - b.price)[0] || null;
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
// COMBINED TRANSPORT — unchanged
// ─────────────────────────────────────────────
async function transport(params, sendWhatsApp = null) {
  const [flightResult, busResult] = await Promise.allSettled([
    flights(params, sendWhatsApp),
    buses({ origin: params.origin, destination: params.destination, date: params.departureDate, passengers: params.passengers }, null),
  ]);

  return {
    flights: flightResult.status === 'fulfilled' ? flightResult.value : { results: [], fromCache: false },
    buses:   busResult.status   === 'fulfilled' ? busResult.value   : { results: [], fromCache: false },
  };
}

// ─────────────────────────────────────────────
// HELPERS — unchanged
// ─────────────────────────────────────────────
function _buildFlightCacheRows(duffelResults, travelduqaResults) {
  const rows = [];
  if (duffelResults.length > 0) {
    const best = _pickBest(duffelResults);
    if (best) rows.push({ supplier: 'duffel', priceUsd: _toUsd(best.price, best.currency), priceKes: _toKes(best.price, best.currency), currency: best.currency || 'KES', result: best });
  }
  if (travelduqaResults.length > 0) {
    const best = _pickBest(travelduqaResults);
    if (best) rows.push({ supplier: 'travelduqa', priceUsd: _toUsd(best.price, best.currency), priceKes: _toKes(best.price, best.currency), currency: best.currency || 'KES', result: best });
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
    cacheAge:     cached?.ageMinutes   || null,
    isStale:      cached?.isStale      || false,
    needsRefresh: cached?.needsRefresh || false,
    suppliers:    cached?.suppliers    || [],
  };

  if (channel === 'widget') {
    base.widget = {
      showRefreshSpinner: cached?.needsRefresh || false,
      cachedPriceKES:     cached?.bestPriceKES || null,
      cachedSupplier:     cached?.bestSupplier || null,
      priceAgeMinutes:    cached?.ageMinutes   || null,
      supplierBreakdown:  (cached?.suppliers || []).map(s => ({
        supplier: s.supplier,
        priceKes: s.priceKes || Math.round((s.priceUsd || 0) * 130),
        isBest:   s.supplier === cached?.bestSupplier,
      })),
      trend: cached?.trend || null,
    };
  }

  return base;
}

function _backgroundRefresh(fn) {
  Promise.resolve()
    .then(fn)
    .catch(err => logger.warn('CachedSearch: background refresh failed', { error: err.message }));
}

const FX = { KES: 1, USD: 130, EUR: 143, GBP: 167 };

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
    if (typeof sendWhatsApp === 'function' && message) await sendWhatsApp(message);
  } catch (err) {
    logger.warn('CachedSearch: WhatsApp send failed', { error: err.message });
  }
}

module.exports = { flights, hotels, buses, transport };