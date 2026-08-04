/**
 * FARE REFRESH WORKER
 * ─────────────────────────────────────────────────────────────
 * Background cron that proactively refreshes stale fare cache
 * entries before travelers ask for them.
 *
 * Strategy:
 *   - Runs every 30 minutes via Render cron or node-cron
 *   - Prioritises routes expiring soonest + volatile markets
 *   - Caps at 30 refreshes per run to avoid supplier rate limits
 *   - Writes updated prices to fare_cache + fare_price_history
 *   - Sends WhatsApp price nudges if significant movement detected
 *     on routes travelers have recently searched or saved
 *
 * Render cron setup (render.yaml):
 *   - type: cron
 *     name: fare-refresh-worker
 *     schedule: "*/30 * * * *"
 *     startCommand: node src/workers/refreshWorker.js
 * ─────────────────────────────────────────────────────────────
 */

const supabase      = require('../utils/supabase');
const { logger }    = require('../utils/logger');
const fareCache     = require('./fareCache');

// Lazy-load adapters to avoid circular deps and keep worker lightweight
function getDuffel()     { return require('../adapters/duffelAdapter');     }
function getTravelDuqa() { return require('../adapters/travelduqaAdapter'); }
function getHotelBeds()  { return require('../adapters/hotelbedsAdapter');  }
function getWhatsApp()   { return require('../services/whatsappService');   }

const MAX_REFRESHES_PER_RUN = 30;
const SUPPLIER_DELAY_MS     = 600; // ms between supplier calls — be polite

// ─────────────────────────────────────────────────────────────
// MAIN WORKER ENTRY POINT
// ─────────────────────────────────────────────────────────────
async function run() {
  logger.info('RefreshWorker: starting run');

  try {
    const candidates = await fetchRefreshCandidates();
    logger.info('RefreshWorker: candidates found', { count: candidates.length });

    let refreshed = 0;
    let nudgesSent = 0;

    for (const record of candidates) {
      if (refreshed >= MAX_REFRESHES_PER_RUN) {
        logger.info('RefreshWorker: cap reached, stopping', { refreshed });
        break;
      }

      try {
        const nudge = await refreshRecord(record);
        refreshed++;

        if (nudge) {
          await sendPriceNudge(nudge);
          nudgesSent++;
        }

        // Polite delay between supplier calls
        await sleep(SUPPLIER_DELAY_MS);

      } catch (err) {
        logger.warn('RefreshWorker: record refresh failed', {
          routeKey: record.route_key,
          supplier: record.supplier,
          error:    err.message,
        });
      }
    }

    logger.info('RefreshWorker: run complete', { refreshed, nudgesSent });

  } catch (err) {
    logger.error('RefreshWorker: run threw', { error: err.message });
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────
// FETCH REFRESH CANDIDATES
// Prioritisation order:
//   1. Volatile routes expiring in next 30 min
//   2. Any route marked stale
//   3. Routes expiring in next 2 hrs (departure within 14 days)
//   4. Everything else expiring soon
// ─────────────────────────────────────────────────────────────
async function fetchRefreshCandidates() {
  const now         = new Date();
  const in30min     = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const in2hrs      = new Date(now.getTime() + 2  * 60 * 60 * 1000).toISOString();
  const todayStr    = now.toISOString().split('T')[0];

  // Only refresh future departures
  const { data, error } = await supabase
    .from('fare_cache')
    .select('*')
    .gte('departure_date', todayStr)
    .or(`is_stale.eq.true,expires_at.lt.${in2hrs}`)
    .order('expires_at', { ascending: true })
    .limit(MAX_REFRESHES_PER_RUN * 2); // fetch more than we need, we'll prioritise below

  if (error) {
    logger.warn('RefreshWorker: fetchCandidates failed', { error: error.message });
    return [];
  }

  if (!data || data.length === 0) return [];

  // Score and sort candidates
  return data
    .map(r => ({
      ...r,
      _priority: scorePriority(r, now, in30min),
    }))
    .sort((a, b) => b._priority - a._priority)
    .slice(0, MAX_REFRESHES_PER_RUN);
}

function scorePriority(record, now, in30min) {
  let score = 0;

  // Stale records always high priority
  if (record.is_stale) score += 100;

  // Volatile routes expiring very soon — critical
  const volatile = fareCache.isVolatileRoute(record.origin, record.destination);
  if (volatile && new Date(record.expires_at) < new Date(in30min)) score += 80;
  else if (volatile) score += 40;

  // Near departure = higher priority
  const daysOut = Math.ceil((new Date(record.departure_date) - now) / 86400000);
  if (daysOut <= 3)       score += 60;
  else if (daysOut <= 7)  score += 40;
  else if (daysOut <= 14) score += 20;

  // Expiring very soon
  const expiresIn = new Date(record.expires_at) - now;
  if (expiresIn < 15 * 60 * 1000) score += 30; // < 15 min

  return score;
}

// ─────────────────────────────────────────────────────────────
// REFRESH A SINGLE CACHE RECORD
// Hits the original supplier, updates cache, returns nudge
// payload if price moved significantly.
// ─────────────────────────────────────────────────────────────
async function refreshRecord(record) {
  const params = {
    origin:        record.origin,
    destination:   record.destination,
    departureDate: record.departure_date,
    returnDate:    record.return_date,
    passengers:    record.passengers,
    cabinClass:    record.cabin_class,
    tripType:      record.trip_type,
  };

  let liveResult = null;

  try {
    if (record.content_type === 'flight') {
      liveResult = await refreshFlight(record.supplier, params);
    } else if (record.content_type === 'hotel') {
      liveResult = await refreshHotel(record.supplier, params);
    }
  } catch (err) {
    logger.warn('RefreshWorker: supplier call failed', {
      supplier: record.supplier,
      routeKey: record.route_key,
      error:    err.message,
    });
    // Mark stale so next request hits live API
    await fareCache.markStale(record.route_key, record.content_type);
    return null;
  }

  if (!liveResult) {
    await fareCache.markStale(record.route_key, record.content_type);
    return null;
  }

  const oldPriceUsd = record.price_usd;
  const newPriceUsd = liveResult.priceUsd;

  // Write updated result to cache
  await fareCache.set(params, record.content_type, [{
    supplier:  record.supplier,
    priceUsd:  newPriceUsd,
    priceKes:  liveResult.priceKes,
    currency:  liveResult.currency || 'USD',
    result:    liveResult.result,
  }]);

  logger.info('RefreshWorker: record refreshed', {
    routeKey:  record.route_key,
    supplier:  record.supplier,
    oldPrice:  oldPriceUsd,
    newPrice:  newPriceUsd,
  });

  // Detect significant price movement
  const movement = fareCache.detectPriceMovement(oldPriceUsd, newPriceUsd);
  if (!movement) return null;

  // Find travelers who have this route saved and should be nudged
  const travelers = await findInterestedTravelers(record.route_key);
  if (travelers.length === 0) return null;

  return {
    routeKey:   record.route_key,
    record,
    movement,
    newPriceUsd,
    newPriceKes: liveResult.priceKes,
    travelers,
  };
}

// ─────────────────────────────────────────────────────────────
// SUPPLIER REFRESH CALLS
// Each returns { priceUsd, priceKes, currency, result }
// ─────────────────────────────────────────────────────────────
async function refreshFlight(supplier, params) {
  if (supplier === 'duffel') {
    const adapter = getDuffel();
    const results = await adapter.search(params);
    if (!results || results.length === 0) return null;
    const best = results[0]; // adapter returns sorted by price
    return {
      priceUsd: best.summary?.totalPriceUsd || best.price,
      priceKes: best.summary?.totalPrice    || null,
      currency: best.summary?.currency      || 'USD',
      result:   best,
    };
  }

  if (supplier === 'travelduqa') {
    const adapter = getTravelDuqa();
    const results = await adapter.search(params);
    if (!results || results.length === 0) return null;
    const best = results[0];
    return {
      priceUsd: best.summary?.totalPriceUsd || best.price,
      priceKes: best.summary?.totalPrice    || null,
      currency: best.summary?.currency      || 'USD',
      result:   best,
    };
  }

  logger.warn('RefreshWorker: unknown flight supplier', { supplier });
  return null;
}

async function refreshHotel(supplier, params) {
  if (supplier === 'hotelbeds') {
    const adapter = getHotelBeds();
    const results = await adapter.search(params);
    if (!results || results.length === 0) return null;
    const best = results[0];
    return {
      priceUsd: best.summary?.totalPriceUsd || best.price,
      priceKes: best.summary?.totalPrice    || null,
      currency: best.summary?.currency      || 'USD',
      result:   best,
    };
  }

  logger.warn('RefreshWorker: unknown hotel supplier', { supplier });
  return null;
}

// ─────────────────────────────────────────────────────────────
// FIND INTERESTED TRAVELERS
// Travelers who have this route in a saved/active itinerary
// and should receive a price nudge.
// ─────────────────────────────────────────────────────────────
async function findInterestedTravelers(routeKey) {
  try {
    // Check pending_itineraries for saved trips on this route
    const { data } = await supabase
      .from('pending_itineraries')
      .select('phone, agency_id, currency, leg_flow')
      .in('status', ['active', 'partially_booked'])
      .gt('expires_at', new Date().toISOString())
      .not('phone', 'is', null);

    if (!data || data.length === 0) return [];

    // Filter to those whose leg_flow contains this route key
    // (rough match on origin/destination from routeKey)
    const parts = routeKey.split('-');
    const origin = parts[0];
    const dest   = parts[1];

    return data.filter(itin => {
      const lf  = itin.leg_flow || {};
      const tp  = lf.tripParams || {};
      return (
        (tp.origin      || '').toUpperCase() === origin &&
        (tp.destination || '').toUpperCase() === dest
      );
    });

  } catch (err) {
    logger.warn('RefreshWorker: findInterestedTravelers failed', { error: err.message });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// SEND PRICE NUDGE via WhatsApp
// ─────────────────────────────────────────────────────────────
async function sendPriceNudge({ routeKey, record, movement, newPriceKes, travelers }) {
  try {
    const wa = getWhatsApp();

    for (const traveler of travelers) {
      if (!traveler.phone) continue;

      const currency  = traveler.currency || 'KES';
      const priceStr  = newPriceKes
        ? `KES ${Math.round(newPriceKes).toLocaleString()}`
        : `${record.currency} ${record.price_usd}`;

      let msg;
      if (movement.direction === 'down') {
        msg = `📉 *Price drop alert!*\n\nThe fare on your saved trip (${record.origin} → ${record.destination}) just dropped by KES ${movement.changeKes.toLocaleString()} (${movement.changePct}%).\n\nNew price: *${priceStr}*\n\nWant to lock it in now?`;
      } else {
        msg = `📈 *Price update on your saved trip*\n\n${record.origin} → ${record.destination} has gone up by KES ${movement.changeKes.toLocaleString()} (${movement.changePct}%).\n\nCurrent price: *${priceStr}*\n\nReply *book* to secure at this price or *search* to find alternatives.`;
      }

      await wa.sendMessage(traveler.phone, msg, traveler.agency_id);

      logger.info('RefreshWorker: nudge sent', {
        phone:     traveler.phone,
        routeKey,
        direction: movement.direction,
        changePct: movement.changePct,
      });
    }
  } catch (err) {
    logger.error('RefreshWorker: sendPriceNudge threw', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// CLEANUP — remove expired records older than 7 days
// Keeps the table lean. Run daily.
// ─────────────────────────────────────────────────────────────
async function cleanup() {
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase
      .from('fare_cache')
      .delete()
      .lt('expires_at', cutoff);

    if (error) {
      logger.warn('RefreshWorker.cleanup: failed', { error: error.message });
    } else {
      logger.info('RefreshWorker.cleanup: done', { cutoff });
    }
  } catch (err) {
    logger.error('RefreshWorker.cleanup threw', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// ENTRY POINT — run when called directly as a cron job
// ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--cleanup')) {
    cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
  } else {
    run().then(() => process.exit(0)).catch(() => process.exit(1));
  }
}

module.exports = { run, cleanup, refreshRecord };