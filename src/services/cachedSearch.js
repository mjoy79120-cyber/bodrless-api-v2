/**
 * CACHED SEARCH (patched)
 * Changes vs previous version:
 *  - past-date guard: never calls suppliers with a date before today
 *  - searchFailed contract: results carry `searchFailed` so the engine can tell
 *    "supplier errored / rate-limited" from "genuinely no inventory"
 *  - in-flight dedupe: identical concurrent searches share one supplier call
 *  - RateHawk call budget (10 req/min upstream): fail fast instead of burning quota
 *  - failures are never cached
 *  - bypassCache flag on flights() and hotels(): skips cache read AND write,
 *    always calls suppliers live. Used by the booking retry loop after
 *    HOTEL_CONFIRM_FAILED so stale offer IDs are never reused.
 */

const fareCache  = require('./fareCache');
const { logger } = require('../utils/logger');
const { createWindowBudget } = require('../utils/limiter');

function getDuffel()     { return require('../adapters/duffel');          }
function getTravelDuqa() { return require('../adapters/travelduqa');      }
function getHotelBeds()  { return require('../adapters/hotelbeds');       }
function getRateHawk()   { return require('../adapters/ratehawk');        }
function getIabiri()     { return require('../adapters/travler');         }

// RateHawk allows 10 requests / 60s on the SERP endpoint; keep headroom for other traffic
const rateHawkBudget = createWindowBudget(Number(process.env.RATEHAWK_MAX_PER_MIN) || 8, 60000);

const _inflight = new Map();
function _shared(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = Promise.resolve().then(fn).finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

const _failedList = (reason) => Object.assign([], { searchFailed: true, failureReason: reason });
const _isPast = (d) => !!d && String(d).slice(0, 10) < new Date().toISOString().slice(0, 10);

function _channel(params, sendWhatsApp) {
  if (params.channel) return params.channel;
  return sendWhatsApp ? 'whatsapp' : 'widget';
}

// ─────────────────────────────────────────────
// FLIGHT SEARCH
// ─────────────────────────────────────────────
async function flights(params, sendWhatsApp = null) {
  const contentType   = 'flight';
  const channel       = _channel(params, sendWhatsApp);
  const bypassCache   = !!params.bypassCache;

  if (_isPast(params.departureDate)) {
    logger.warn('CachedSearch.flights: departure date is in the past — not calling suppliers', {
      route: `${params.origin}→${params.destination}`, date: params.departureDate,
    });
    return _buildReturn([], null, false, channel, { searchFailed: true, failureReason: 'past_date' });
  }

  // bypassCache: skip cache entirely, go live, and do NOT write back to cache.
  // Used after HOTEL_CONFIRM_FAILED so stale Duffel offer IDs are never reused.
  if (bypassCache) {
    logger.info('CachedSearch.flights: bypassCache=true — live search only, no cache read or write', {
      route: `${params.origin}→${params.destination}`,
    });
    const { allResults, searchFailed } = await _liveFlight(params, { skipCacheWrite: true });
    return _buildReturn(allResults, null, false, channel, { searchFailed });
  }

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
    _backgroundRefresh(() => _liveFlight(params));
    return _buildReturn(cached.results, cached, true, channel);
  }

  logger.info('CachedSearch.flights: firing live search', {
    route: `${params.origin}→${params.destination}`,
    reason: cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss',
    channel,
  });

  const { allResults, cacheRows, searchFailed } = await _liveFlight(params);

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

  return _buildReturn(allResults, cached, false, channel, { searchFailed });
}

async function _liveFlight(params, opts = {}) {
  const skipCacheWrite = !!opts.skipCacheWrite;

  // When bypassCache is set we still use _shared deduplication within this
  // process, but we append a nonce so each bypass call gets its own live hit
  // rather than being folded into a cached in-flight request.
  const nonce = skipCacheWrite ? `-bypass-${Date.now()}` : '';
  const key = ['flight', params.origin, params.destination, params.departureDate,
    params.passengers || 1, params.children || 0, params.cabinClass || 'economy'].join('|').toLowerCase() + nonce;

  return _shared(key, async () => {
    const [duffelRes, travelduqaRes] = await Promise.allSettled([
      getDuffel().search({ ...params, date: params.departureDate }),
      getTravelDuqa().search({ ...params, date: params.departureDate }),
    ]);

    const duffelResults     = duffelRes.status     === 'fulfilled' ? duffelRes.value     : _failedList('rejected');
    const travelduqaResults = travelduqaRes.status === 'fulfilled' ? travelduqaRes.value : _failedList('rejected');

    const duffelFailed = duffelRes.status === 'rejected'     || duffelResults.searchFailed === true;
    const duquaFailed  = travelduqaRes.status === 'rejected' || travelduqaResults.searchFailed === true;

    const allResults = [...duffelResults, ...travelduqaResults];
    const cacheRows  = skipCacheWrite ? [] : _buildFlightCacheRows(duffelResults, travelduqaResults, params);

    const searchFailed = allResults.length === 0 && duffelFailed && duquaFailed;
    if (searchFailed) {
      logger.warn('CachedSearch.flights: all suppliers failed (not caching, not treating as empty inventory)', {
        route: `${params.origin}→${params.destination}`,
        duffel: duffelResults.failureReason || null, travelduqa: travelduqaResults.failureReason || null,
      });
    }
    return { allResults, cacheRows, searchFailed };
  });
}

// ─────────────────────────────────────────────
// HOTEL SEARCH — HotelBeds + RateHawk in parallel
// ─────────────────────────────────────────────
async function hotels(params, sendWhatsApp = null) {
  const contentType = 'hotel';
  const channel     = _channel(params, sendWhatsApp);
  const bypassCache = !!params.bypassCache;

  const checkIn = params.checkIn || params.departureDate;
  if (_isPast(checkIn)) {
    logger.warn('CachedSearch.hotels: check-in is in the past — not calling suppliers', {
      destination: params.destination, checkIn,
    });
    return _buildReturn([], null, false, channel, { searchFailed: true, failureReason: 'past_date' });
  }

  const cacheParams = {
    destination:   params.destination,
    departureDate: checkIn,
    returnDate:    params.checkOut || params.returnDate,
    passengers:    params.adults   || params.passengers || 1,
    origin:        params.destination,
  };

  // bypassCache: skip cache entirely, go live, do NOT write back.
  if (bypassCache) {
    logger.info('CachedSearch.hotels: bypassCache=true — live search only, no cache read or write', {
      destination: params.destination,
    });
    const { hotelResults, searchFailed } = await _liveHotel(params, cacheParams, contentType, { skipCacheWrite: true });
    return _buildReturn(hotelResults, null, false, channel, { searchFailed });
  }

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

  const { hotelResults, searchFailed } = await _liveHotel(params, cacheParams, contentType);

  if (cached.hit && channel === 'whatsapp') {
    const best = hotelResults[0] || null;
    const liveResult = best
      ? { priceUsd: _toUsd(best.totalRate, best.currency || 'USD'), priceKes: _toKes(best.totalRate, best.currency || 'USD') }
      : null;
    await _safeSend(sendWhatsApp, fareCache.buildLiveConfirmMessage(liveResult, cached));
  }

  return _buildReturn(hotelResults, cached, false, channel, { searchFailed });
}

async function _liveHotel(params, cacheParams, contentType, opts = {}) {
  const skipCacheWrite = !!opts.skipCacheWrite;
  const nonce = skipCacheWrite ? `-bypass-${Date.now()}` : '';
  const key = ['hotel', params.destination, params.checkIn || params.departureDate, params.checkOut || params.returnDate,
    params.adults || params.passengers || 1, params.children || 0, params.rooms || 1].join('|').toLowerCase() + nonce;

  return _shared(key, async () => {
    const rhAllowed = rateHawkBudget.tryAcquire();
    if (!rhAllowed) {
      logger.warn('CachedSearch.hotels: RateHawk per-minute budget used — skipping RateHawk for this search');
    }

    const [hbRes, rhRes] = await Promise.allSettled([
      getHotelBeds().search(params),
      rhAllowed ? getRateHawk().search(params) : Promise.resolve(_failedList('budget')),
    ]);

    const hbResults = hbRes.status === 'fulfilled' ? (hbRes.value || []) : _failedList('rejected');
    const rhResults = rhRes.status === 'fulfilled' ? (rhRes.value || []) : _failedList('rejected');

    if (hbRes.status === 'rejected') logger.warn('CachedSearch.hotels: HotelBeds search failed', { error: hbRes.reason?.message });
    if (rhRes.status === 'rejected') logger.warn('CachedSearch.hotels: RateHawk search failed',  { error: rhRes.reason?.message });

    logger.info('CachedSearch.hotels: supplier results', {
      destination: params.destination, hotelBeds: hbResults.length, rateHawk: rhResults.length,
    });

    const combined     = [...hbResults, ...rhResults];
    const hotelResults = _sortHotelsCheapest(_dedupeHotels(combined));

    logger.info('CachedSearch.hotels: merged results', {
      destination: params.destination, combined: combined.length, afterDedupe: hotelResults.length,
      topResult: hotelResults[0] ? `${hotelResults[0].name} [${hotelResults[0].supplier}]` : 'none',
    });

    if (!skipCacheWrite && hotelResults.length > 0) {
      const best = hotelResults[0];
      await fareCache.set(cacheParams, contentType, [{
        supplier: best.supplier,
        priceUsd: _toUsd(best.totalRate, best.currency || 'USD'),
        priceKes: _toKes(best.totalRate, best.currency || 'USD'),
        currency: best.currency || 'USD',
        result:   best,
      }]).catch(err => logger.warn('CachedSearch.hotels: cache write failed', { error: err.message }));
    }

    const hbFailed = hbRes.status === 'rejected' || hbResults.searchFailed === true;
    const rhFailed = rhRes.status === 'rejected' || rhResults.searchFailed === true;
    return { hotelResults, searchFailed: hotelResults.length === 0 && hbFailed && rhFailed };
  });
}

function _dedupeHotels(list) {
  const seen = new Map();
  for (const hotel of list) {
    const key = _hotelDedupeKey(hotel);
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing) { seen.set(key, hotel); continue; }
    const existingKES = _toKes(existing.totalRate || 0, existing.currency || 'USD');
    const hotelKES    = _toKes(hotel.totalRate    || 0, hotel.currency    || 'USD');
    if (hotelKES < existingKES) seen.set(key, hotel);
  }
  return Array.from(seen.values());
}

function _hotelDedupeKey(hotel) {
  if (!hotel.name) return null;
  const clean = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const normName = clean(hotel.name);
  const normLocation = clean(hotel.location || hotel.city || hotel.destination).split(' ')[0];
  return normName ? `${normName}|${normLocation}` : null;
}

function _sortHotelsCheapest(list) {
  return [...list].sort((a, b) =>
    _toKes(a.totalRate || 0, a.currency || 'USD') - _toKes(b.totalRate || 0, b.currency || 'USD'));
}

// ─────────────────────────────────────────────
// BUS SEARCH (IABIRI) — unchanged apart from past-date guard
// ─────────────────────────────────────────────
async function buses(params, sendWhatsApp = null) {
  const contentType = 'bus';
  const channel     = _channel(params, sendWhatsApp);

  if (_isPast(params.date)) return _buildReturn([], null, false, channel, { searchFailed: true, failureReason: 'past_date' });

  const cacheParams = {
    origin: params.origin, destination: params.destination, departureDate: params.date,
    passengers: params.passengers || 1, cabinClass: 'standard', tripType: 'one_way',
  };

  const cached = await fareCache.get(cacheParams, contentType);

  if (cached.hit && !cached.needsRefresh) {
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
    reason: cached.hit ? (cached.isStale ? 'stale' : 'volatile') : 'miss', channel,
  });

  const { busResults } = await _liveBus(params, cacheParams, contentType);

  if (cached.hit && channel === 'whatsapp') {
    const best = [...busResults].sort((a, b) => a.price - b.price)[0] || null;
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
    const best = [...busResults].sort((a, b) => a.price - b.price)[0];
    await fareCache.set(cacheParams, contentType, [{
      supplier: 'iabiri', priceUsd: _toUsd(best.price, 'KES'), priceKes: best.price, currency: 'KES', result: best,
    }]).catch(err => logger.warn('CachedSearch.buses: cache write failed', { error: err.message }));
  }
  return { busResults };
}

async function transport(params, sendWhatsApp = null) {
  const [flightResult, busResult] = await Promise.allSettled([
    flights(params, sendWhatsApp),
    buses({ origin: params.origin, destination: params.destination, date: params.departureDate, passengers: params.passengers }, null),
  ]);
  return {
    flights: flightResult.status === 'fulfilled' ? flightResult.value : { results: [], fromCache: false, searchFailed: true },
    buses:   busResult.status   === 'fulfilled' ? busResult.value   : { results: [], fromCache: false },
  };
}

// ─────────────────────────────────────────────
// HELPERS
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
    .sort((a, b) => _toKes(a.price || a.totalRate || 0, a.currency) - _toKes(b.price || b.totalRate || 0, b.currency))[0] || null;
}

function _buildReturn(results, cached, fromCache, channel = 'whatsapp', extra = {}) {
  const base = {
    results,
    best:          _pickBest(results),
    fromCache,
    cacheAge:      cached?.ageMinutes   || null,
    isStale:       cached?.isStale      || false,
    needsRefresh:  cached?.needsRefresh || false,
    suppliers:     cached?.suppliers    || [],
    searchFailed:  !!extra.searchFailed,
    failureReason: extra.failureReason  || null,
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
  Promise.resolve().then(fn).catch(err => logger.warn('CachedSearch: background refresh failed', { error: err.message }));
}

const FX = { KES: 1, USD: 130, EUR: 143, GBP: 167 };
function _toKes(amount, currency = 'KES') {
  const rate = FX[(currency || 'KES').toUpperCase()] || 130;
  return Math.round(Number(amount || 0) * rate);
}
function _toUsd(amount, currency = 'KES') {
  return Math.round(_toKes(amount, currency) / FX.USD * 100) / 100;
}

async function _safeSend(sendWhatsApp, message) {
  try { if (typeof sendWhatsApp === 'function' && message) await sendWhatsApp(message); }
  catch (err) { logger.warn('CachedSearch: WhatsApp send failed', { error: err.message }); }
}

module.exports = { flights, hotels, buses, transport };