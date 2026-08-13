/**
 * RATEHAWK CONFIRM POLLER  (background cron worker)
 * ─────────────────────────────────────────────────────────────
 * Picks up bookings that timed out during the inline poll window
 * and keeps checking until ETG confirms or fails them.
 *
 * When to run:
 *   Call startPoller() once at app startup.
 *   It runs on a fixed interval (default every 60 seconds).
 *   On each tick it queries Supabase for all RateHawk bookings
 *   with supplier_status = 'awaiting_confirmation' and polls
 *   ETG's status endpoint for each one.
 *
 * Stopping:
 *   Call stopPoller() on graceful shutdown (SIGTERM handler).
 *
 * Supabase columns required on bookings table:
 *   ratehawk_partner_order_id  TEXT
 *   ratehawk_order_id          TEXT
 *   supplier_status            TEXT
 *   booking_status             TEXT
 *   supplier                   TEXT  (filter: 'ratehawk')
 *   ratehawk_poll_attempts     INT   (tracks total attempts across restarts)
 *   updated_at                 TIMESTAMPTZ
 *
 * Add these columns if they don't exist yet:
 *   ALTER TABLE bookings
 *     ADD COLUMN IF NOT EXISTS ratehawk_partner_order_id TEXT,
 *     ADD COLUMN IF NOT EXISTS ratehawk_order_id         TEXT,
 *     ADD COLUMN IF NOT EXISTS ratehawk_poll_attempts    INT DEFAULT 0;
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const ratehawkAdapter = require('../adapters/ratehawkAdapter');

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const TICK_INTERVAL_MS  = Number(process.env.RATEHAWK_POLLER_INTERVAL_MS) || 60_000;  // how often cron ticks
const POLL_INTERVAL_MS  = Number(process.env.RATEHAWK_POLL_INTERVAL_MS)   || 3_000;   // delay between individual status checks
const MAX_TOTAL_ATTEMPTS= Number(process.env.RATEHAWK_MAX_POLL_ATTEMPTS)   || 300;     // ~15 min at 3s intervals — give up after this
const BATCH_SIZE        = 10; // how many bookings to process per tick

const TERMINAL_ERRORS = new Set([
  'soldout', 'book_limit', 'booking_finish_did_not_succeed',
  'provider', '3ds', 'block', 'no_available_rates',
]);

// ─────────────────────────────────────────────
// POLLER STATE
// ─────────────────────────────────────────────
let _intervalId = null;
let _running    = false;

// ─────────────────────────────────────────────
// START / STOP
// ─────────────────────────────────────────────
function startPoller() {
  if (_intervalId) {
    logger.warn('RateHawkConfirmPoller: already running');
    return;
  }

  logger.info('RateHawkConfirmPoller: started', {
    tickIntervalMs:   TICK_INTERVAL_MS,
    pollIntervalMs:   POLL_INTERVAL_MS,
    maxTotalAttempts: MAX_TOTAL_ATTEMPTS,
    batchSize:        BATCH_SIZE,
  });

  // Run immediately on start, then on interval
  _tick().catch(err => logger.error('RateHawkConfirmPoller: initial tick failed', { error: err.message }));

  _intervalId = setInterval(() => {
    if (_running) {
      logger.warn('RateHawkConfirmPoller: previous tick still running — skipping');
      return;
    }
    _tick().catch(err => logger.error('RateHawkConfirmPoller: tick failed', { error: err.message }));
  }, TICK_INTERVAL_MS);
}

function stopPoller() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    logger.info('RateHawkConfirmPoller: stopped');
  }
}

// ─────────────────────────────────────────────
// TICK — query pending bookings and poll each
// ─────────────────────────────────────────────
async function _tick() {
  _running = true;
  try {
    // Fetch awaiting_confirmation RateHawk bookings
    const { data: pendingBookings, error } = await supabase
      .from('bookings')
      .select('id, ratehawk_partner_order_id, ratehawk_poll_attempts, guest_name, destination')
      .eq('supplier_status', 'awaiting_confirmation')
      .eq('supplier', 'ratehawk')
      .not('ratehawk_partner_order_id', 'is', null)
      .lt('ratehawk_poll_attempts', MAX_TOTAL_ATTEMPTS)  // skip bookings we've given up on
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE);

    if (error) {
      logger.error('RateHawkConfirmPoller: Supabase query failed', { error: error.message });
      return;
    }

    if (!pendingBookings || pendingBookings.length === 0) {
      logger.info('RateHawkConfirmPoller: no pending bookings — idle');
      return;
    }

    logger.info('RateHawkConfirmPoller: processing pending bookings', {
      count: pendingBookings.length,
    });

    // Process each booking sequentially (avoids hammering ETG rate limits)
    for (const booking of pendingBookings) {
      await _pollOne(booking).catch(err =>
        logger.error('RateHawkConfirmPoller: _pollOne failed', {
          bookingId: booking.id, error: err.message,
        })
      );
      // Small gap between calls to be a good API citizen
      await _sleep(500);
    }
  } finally {
    _running = false;
  }
}

// ─────────────────────────────────────────────
// POLL ONE BOOKING
// ─────────────────────────────────────────────
async function _pollOne(booking) {
  const { id: bookingId, ratehawk_partner_order_id: partnerOrderId } = booking;
  const currentAttempts = booking.ratehawk_poll_attempts || 0;

  logger.info('RateHawkConfirmPoller: polling booking', {
    bookingId, partnerOrderId, totalAttemptsSoFar: currentAttempts,
  });

  // Increment attempt counter first so we don't loop forever on crashes
  await supabase
    .from('bookings')
    .update({ ratehawk_poll_attempts: currentAttempts + 1, updated_at: new Date().toISOString() })
    .eq('id', bookingId);

  // Give ETG a moment before checking
  await _sleep(POLL_INTERVAL_MS);

  let pollResult;
  try {
    pollResult = await ratehawkAdapter.getBookingStatus({ partnerOrderId });
  } catch (err) {
    logger.warn('RateHawkConfirmPoller: status check threw — will retry next tick', {
      bookingId, partnerOrderId, error: err.message,
    });
    return; // leave as awaiting_confirmation, retry next tick
  }

  const { status, orderId, errorCode } = pollResult;

  logger.info('RateHawkConfirmPoller: poll result', {
    bookingId, partnerOrderId, status, orderId,
  });

  // ── Confirmed ─────────────────────────────────────────────────
  if (status === 'ok') {
    await supabase
      .from('bookings')
      .update({
        supplier_status:  'confirmed',
        booking_status:   'confirmed',
        ratehawk_order_id: orderId || null,
        updated_at:        new Date().toISOString(),
      })
      .eq('id', bookingId);

    logger.info('RateHawkConfirmPoller: booking confirmed', {
      bookingId, partnerOrderId, orderId,
    });

    // Fire a notification so the agency knows
    await _notifyConfirmed(booking, orderId).catch(err =>
      logger.warn('RateHawkConfirmPoller: confirmation notification failed', { error: err.message })
    );
    return;
  }

  // ── Terminal failure ──────────────────────────────────────────
  const terminalCode = TERMINAL_ERRORS.has(status)    ? status
                     : TERMINAL_ERRORS.has(errorCode) ? errorCode
                     : null;

  if (terminalCode) {
    await supabase
      .from('bookings')
      .update({
        supplier_status: 'failed',
        booking_status:  'failed',
        supplier_meta:   { error: terminalCode },
        updated_at:      new Date().toISOString(),
      })
      .eq('id', bookingId);

    logger.error('RateHawkConfirmPoller: terminal failure', {
      bookingId, partnerOrderId, terminalCode,
    });

    await _notifyFailed(booking, terminalCode).catch(err =>
      logger.warn('RateHawkConfirmPoller: failure notification failed', { error: err.message })
    );
    return;
  }

  // ── Max attempts reached — give up ───────────────────────────
  if (currentAttempts + 1 >= MAX_TOTAL_ATTEMPTS) {
    await supabase
      .from('bookings')
      .update({
        supplier_status: 'failed',
        booking_status:  'failed',
        supplier_meta:   { error: 'poll_timeout', lastStatus: status },
        updated_at:      new Date().toISOString(),
      })
      .eq('id', bookingId);

    logger.error('RateHawkConfirmPoller: max attempts reached — marking failed', {
      bookingId, partnerOrderId, lastStatus: status,
    });

    await _notifyFailed(booking, 'poll_timeout').catch(() => {});
    return;
  }

  // Still 'processing' / 'timeout' / 'unknown' — leave as awaiting, retry next tick
  logger.info('RateHawkConfirmPoller: still processing — will retry next tick', {
    bookingId, partnerOrderId, status, attempt: currentAttempts + 1,
  });
}

// ─────────────────────────────────────────────
// NOTIFICATIONS
// These are fire-and-forget — adapt to your
// existing notification system (WhatsApp, email, Slack alert, etc.)
// ─────────────────────────────────────────────
async function _notifyConfirmed(booking, orderId) {
  // Pull tracking service if available
  let tracking = null;
  try { tracking = require('../services/trackingService'); } catch (e) {}

  if (tracking) {
    await tracking.alert({
      type:     'ratehawk_booking_confirmed',
      severity: 'info',
      title:    `RateHawk booking confirmed — ${booking.guest_name || 'Guest'}`,
      detail:   `Destination: ${booking.destination || 'unknown'} | ETG Order: ${orderId}`,
      context:  { bookingId: booking.id, orderId },
    });
  }

  logger.info('RateHawkConfirmPoller: confirmed notification sent', {
    bookingId: booking.id, orderId,
  });
}

async function _notifyFailed(booking, reason) {
  let tracking = null;
  try { tracking = require('../services/trackingService'); } catch (e) {}

  if (tracking) {
    await tracking.alert({
      type:     'ratehawk_booking_failed',
      severity: 'error',
      title:    `RateHawk booking FAILED — ${booking.guest_name || 'Guest'}`,
      detail:   `Destination: ${booking.destination || 'unknown'} | Reason: ${reason}`,
      context:  { bookingId: booking.id, reason },
    });
  }

  logger.error('RateHawkConfirmPoller: failure notification sent', {
    bookingId: booking.id, reason,
  });
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { startPoller, stopPoller };