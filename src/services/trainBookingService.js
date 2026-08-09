/**
 * TRAIN BOOKING SERVICE
 * ─────────────────────────────────────────────────────────────
 * Sits between engine.js and trainBookingAgent.js.
 *
 * engine.js calls:
 *   trainBookingService.warmUp(tripParams)       ← when train shown in results
 *   trainBookingService.book(bookingRef, ...)    ← when user confirms booking
 *
 * Stores sessionId in Supabase bookings table so it survives
 * across webhook turns (WhatsApp) or widget refreshes.
 */

const agent    = require('../orchestration/trainBookingAgent');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// WARM UP — fire-and-forget when train results are shown
// ─────────────────────────────────────────────────────────────
/**
 * Call this immediately after engine returns a train package.
 * Does NOT block — runs in background.
 *
 * @param {object} tripParams - from engine (origin, destination, departureDate, etc.)
 * @param {string} internalBookingRef - your pending booking ref (pre-generated)
 */
function warmUp(tripParams, internalBookingRef) {
  // Fire and forget — don't await, don't block the response
  _doWarmUp(tripParams, internalBookingRef).catch(err =>
    logger.warn('TrainBookingService: warmUp fire-and-forget error', { error: err.message })
  );
}

async function _doWarmUp(tripParams, internalBookingRef) {
  const params = {
    origin:      tripParams.origin,
    destination: tripParams.destination,
    date:        tripParams.departureDate,
    time:        tripParams.timePreference === 'morning' ? '08:00' : '15:00',
    trainType:   tripParams.trainClass || 'express',
    passengers:  tripParams.passengers || 1,
  };

  logger.info('TrainBookingService: starting warm-up', { params, internalBookingRef });

  const sessionId = await agent.warmUp(params);

  if (sessionId && internalBookingRef) {
    // Persist sessionId so we can resume it when user confirms
    await supabase
      .from('bookings')
      .update({ metadata: { train_session_id: sessionId, train_params: params } })
      .eq('booking_ref', internalBookingRef)
      .catch(err => logger.warn('TrainBookingService: failed to store sessionId', { error: err.message }));

    logger.info('TrainBookingService: warm session ready', { sessionId, internalBookingRef });
  }
}

// ─────────────────────────────────────────────────────────────
// BOOK — called when user clicks confirm
// ─────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.bookingRef   - your internal booking_ref
 * @param {string} opts.agencyId
 * @param {object} [opts.tripParams] - needed for cold booking fallback
 * @returns {Promise<{ success, krcRef, message, error }>}
 */
async function book({ bookingRef, agencyId, tripParams }) {
  logger.info('TrainBookingService: book called', { bookingRef, agencyId });

  // ── Retrieve warm sessionId from bookings table ──────────
  let sessionId = null;
  try {
    const { data } = await supabase
      .from('bookings')
      .select('metadata')
      .eq('booking_ref', bookingRef)
      .single();

    sessionId = data?.metadata?.train_session_id || null;

    if (sessionId) {
      const status = agent.sessionStatus(sessionId);
      if (!status.found) {
        logger.warn('TrainBookingService: warm session expired — will cold book', { sessionId });
        sessionId = null;
      } else {
        logger.info('TrainBookingService: resuming warm session', { sessionId, expiresIn: status.expiresIn });
      }
    }
  } catch (err) {
    logger.warn('TrainBookingService: could not retrieve sessionId from bookings', { error: err.message });
  }

  // ── Complete booking (warm or cold) ──────────────────────
  const result = sessionId
    ? await agent.complete({ sessionId, bookingRef, agencyId })
    : await agent.coldBook({ bookingRef, agencyId, params: _buildParams(tripParams) });

  // ── Update booking record ─────────────────────────────────
  if (result.success && result.krcRef) {
    await supabase
      .from('bookings')
      .update({
        supplier_booking_reference: result.krcRef,
        supplier_status:            'confirmed',
        booking_status:             'confirmed',
      })
      .eq('booking_ref', bookingRef)
      .catch(err => logger.warn('TrainBookingService: failed to update booking', { error: err.message }));
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _buildParams(tripParams) {
  if (!tripParams) return {};
  return {
    origin:      tripParams.origin,
    destination: tripParams.destination,
    date:        tripParams.departureDate,
    time:        tripParams.timePreference === 'morning' ? '08:00' : '15:00',
    trainType:   tripParams.trainClass || 'express',
    passengers:  tripParams.passengers || 1,
  };
}

module.exports = { warmUp, book };