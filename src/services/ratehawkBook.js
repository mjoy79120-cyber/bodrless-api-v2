/**
 * RATEHAWK BOOK SERVICE
 * ─────────────────────────────────────────────────────────────
 * Orchestrates the full ETG v3 booking lifecycle:
 *
 *   book()        → prebook → form → finish → poll → confirmed
 *   cancel()      → cancel order by partnerOrderId
 *   getOrder()    → retrieve full booking details post-confirmation
 *
 * BOOKING LIFECYCLE (per ETG docs):
 *
 *   1. prebook()    — locks rate, returns fresh book_hash
 *                     (old hash is consumed — never reuse it)
 *   2. form()       — opens ETG order, links to your partnerOrderId
 *                     retry up to 10x with new partnerOrderId on
 *                     duplicate_reservation / double_booking_form / 5xx
 *   3. finish()     — sends booking to supplier (async)
 *                     proceed even on timeout/unknown/5xx
 *   4. poll()       — check status every POLL_INTERVAL_MS
 *                     stop on 'ok' or terminal error
 *                     if poll window exhausted → 'awaiting_confirmation'
 *                     (ratehawkConfirmPoller.js handles those in background)
 *
 * PAYMENT TYPE: 'deposit' — bills to your ETG credit line.
 *   ETG invoices monthly. Collect from agency before settlement.
 *   Never use 'now' (immediate card capture) until you have
 *   working card infrastructure.
 *
 * CALLED BY:
 *   webhooks.js / hotelDirectEngine.js when supplier = 'ratehawk'
 *
 * SUPABASE COLUMNS USED:
 *   bookings.ratehawk_partner_order_id  — your order reference
 *   bookings.ratehawk_order_id          — ETG's order reference
 *   bookings.supplier_status            — 'confirmed' | 'awaiting_confirmation' | 'failed'
 *   bookings.booking_status             — mirrors supplier_status
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const { v4: uuidv4 }   = require('uuid');
const supabase          = require('../utils/supabase');
const { logger }        = require('../utils/logger');
const ratehawkAdapter   = require('../adapters/ratehawkAdapter');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const POLL_ATTEMPTS     = Number(process.env.RATEHAWK_POLL_ATTEMPTS)    || 30;
const POLL_INTERVAL_MS  = Number(process.env.RATEHAWK_POLL_INTERVAL_MS) || 3000;
const FORM_MAX_RETRIES  = 10; // ETG spec: limit form retries to 10

// Terminal booking failures — do NOT retry, show error to user
const TERMINAL_ERRORS = new Set([
  'soldout', 'book_limit', 'booking_finish_did_not_succeed',
  'provider', '3ds', 'block', 'no_available_rates',
]);

// Retryable on form step (per ETG error-handling diagram)
const FORM_RETRYABLE = new Set([
  'duplicate_reservation', 'double_booking_form', 'unknown', 'timeout',
]);

// ─────────────────────────────────────────────
// MAIN BOOK FUNCTION
//
// Call this from your booking handler after:
//   - Payment confirmed (IntaSend webhook)
//   - Booking record created in Supabase (status: pending)
//
// Params:
//   bookingId      — your Supabase bookings.id
//   bookHash       — from ratehawkAdapter.search() → rateKey field
//   holder         — { firstName, lastName, email, phone }
//   guests         — [{ firstName, lastName, email?, phone? }]
//   agencyId       — for logging
//
// Returns:
//   { success, status, partnerOrderId, supplierOrderId, error? }
// ─────────────────────────────────────────────
async function book({ bookingId, bookHash, holder, guests, agencyId }) {
  logger.info('RateHawkBook: starting booking flow', {
    bookingId, hashPrefix: bookHash?.slice(0, 20),
  });

  // ── Step 1: Prebook — lock rate, get fresh book_hash ─────────
  let prebookResult;
  try {
    prebookResult = await ratehawkAdapter.prebook({ bookHash });
  } catch (err) {
    logger.error('RateHawkBook: prebook failed', { bookingId, error: err.message });
    await _updateBookingStatus(bookingId, 'failed', null, null, { error: 'prebook_failed' });
    return { success: false, status: 'failed', error: 'prebook_failed', detail: err.message };
  }

  const freshBookHash = prebookResult.bookHash;

  // Surface price change to caller if needed
  if (prebookResult.priceChanged) {
    logger.warn('RateHawkBook: price changed during prebook', {
      bookingId,
      newPrice:  prebookResult.netPrice,
      currency:  prebookResult.currency,
    });
    // Note: caller should have already accepted price drift up to
    // RATEHAWK_PRICE_INCREASE_PCT (default 2%). Larger drift = prebook
    // throws before we get here.
  }

  // ── Step 2: Booking Form — open ETG order (retry up to 10x) ──
  let partnerOrderId = _generateOrderId(bookingId);
  let formResult     = null;
  let formAttempt    = 0;

  while (formAttempt < FORM_MAX_RETRIES) {
    formAttempt++;
    try {
      logger.info('RateHawkBook: opening booking form', {
        bookingId, partnerOrderId, attempt: formAttempt,
      });

      formResult = await ratehawkAdapter._openBookingForm({
        partnerOrderId,
        bookHash: freshBookHash,
      });

      // 'ok' status — proceed
      if (!formResult?.status || formResult.status === 'ok') {
        logger.info('RateHawkBook: booking form opened', {
          bookingId, partnerOrderId, attempt: formAttempt,
        });
        break;
      }

      // Check if retryable
      const errCode = formResult?.error_code || formResult?.status;
      if (FORM_RETRYABLE.has(errCode)) {
        logger.warn('RateHawkBook: form retryable error — retrying with new orderId', {
          bookingId, errCode, attempt: formAttempt,
        });
        partnerOrderId = _generateOrderId(bookingId); // fresh ID per ETG spec
        await _sleep(1000 * formAttempt); // back off
        continue;
      }

      // Non-retryable form error
      logger.error('RateHawkBook: booking form non-retryable error', {
        bookingId, errCode, formResult,
      });
      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: errCode });
      return { success: false, status: 'failed', error: errCode, partnerOrderId };

    } catch (err) {
      const isRetryable = err.response?.status >= 500;
      logger.warn(`RateHawkBook: form attempt ${formAttempt} threw`, {
        bookingId, error: err.message, retryable: isRetryable,
      });
      if (!isRetryable || formAttempt >= FORM_MAX_RETRIES) {
        await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: 'form_error' });
        return { success: false, status: 'failed', error: 'form_error', detail: err.message, partnerOrderId };
      }
      partnerOrderId = _generateOrderId(bookingId);
      await _sleep(1000 * formAttempt);
    }
  }

  if (formAttempt >= FORM_MAX_RETRIES && !formResult) {
    logger.error('RateHawkBook: exhausted form retries', { bookingId });
    await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: 'form_max_retries' });
    return { success: false, status: 'failed', error: 'form_max_retries', partnerOrderId };
  }

  // ── Step 3: Booking Finish — send to supplier (async start) ──
  try {
    logger.info('RateHawkBook: sending booking finish', { bookingId, partnerOrderId });
    await ratehawkAdapter._finishBooking({
      partnerOrderId,
      bookHash: freshBookHash,
      holder,
      guests,
    });
    logger.info('RateHawkBook: finish request sent', { bookingId, partnerOrderId });
  } catch (err) {
    // ETG spec: proceed to polling even on timeout/unknown/5xx from finish
    const isRetryable = err.response?.status >= 500
      || err.message?.includes('timeout')
      || err.message?.includes('unknown');

    if (!isRetryable) {
      logger.error('RateHawkBook: finish non-retryable error', {
        bookingId, error: err.message,
      });
      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: 'finish_error' });
      return { success: false, status: 'failed', error: 'finish_error', detail: err.message, partnerOrderId };
    }

    logger.warn('RateHawkBook: finish threw retryable error — proceeding to poll anyway', {
      bookingId, error: err.message,
    });
  }

  // Save partnerOrderId to Supabase now — needed by poller if we time out
  await _updateBookingStatus(bookingId, 'awaiting_confirmation', partnerOrderId, null, null);

  // ── Step 4: Poll for confirmation ────────────────────────────
  logger.info('RateHawkBook: polling for confirmation', {
    bookingId, partnerOrderId, maxAttempts: POLL_ATTEMPTS,
  });

  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    await _sleep(POLL_INTERVAL_MS);

    let pollResult;
    try {
      pollResult = await ratehawkAdapter.getBookingStatus({ partnerOrderId });
    } catch (err) {
      // Transient poll error — keep trying
      logger.warn(`RateHawkBook: poll attempt ${attempt} threw`, {
        bookingId, error: err.message,
      });
      continue;
    }

    const { status, orderId, errorCode } = pollResult;
    logger.info('RateHawkBook: poll result', {
      bookingId, partnerOrderId, attempt, status, orderId,
    });

    if (status === 'ok') {
      logger.info('RateHawkBook: booking confirmed', {
        bookingId, partnerOrderId, orderId,
      });
      await _updateBookingStatus(bookingId, 'confirmed', partnerOrderId, orderId, null);
      return {
        success:         true,
        status:          'confirmed',
        partnerOrderId,
        supplierOrderId: orderId,
      };
    }

    const terminalCode = TERMINAL_ERRORS.has(status)    ? status
                       : TERMINAL_ERRORS.has(errorCode) ? errorCode
                       : null;

    if (terminalCode) {
      logger.error('RateHawkBook: terminal booking failure', {
        bookingId, partnerOrderId, terminalCode,
      });
      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, orderId, { error: terminalCode });
      return {
        success:        false,
        status:         'failed',
        error:          terminalCode,
        partnerOrderId,
        supplierOrderId: orderId || null,
      };
    }

    // 'processing', 'timeout', 'unknown', 5xx — keep polling
  }

  // Poll window exhausted — hand off to background poller
  logger.warn('RateHawkBook: poll window exhausted — booking marked awaiting_confirmation', {
    bookingId, partnerOrderId,
  });

  // Status already set to awaiting_confirmation above
  return {
    success:        false,
    status:         'awaiting_confirmation',
    partnerOrderId,
    supplierOrderId: null,
    message:        'Booking is being processed — you will receive confirmation shortly.',
  };
}

// ─────────────────────────────────────────────
// CANCEL
//
// Call after confirming cancellation policy allows it.
// Returns { success, penaltyAmount, currency }
// ─────────────────────────────────────────────
async function cancel({ bookingId, partnerOrderId }) {
  logger.info('RateHawkBook: cancelling booking', { bookingId, partnerOrderId });

  try {
    const result = await ratehawkAdapter.cancel({ partnerOrderId });

    await supabase
      .from('bookings')
      .update({
        booking_status:  'cancelled',
        supplier_status: 'cancelled',
        updated_at:      new Date().toISOString(),
      })
      .eq('id', bookingId);

    logger.info('RateHawkBook: cancellation successful', {
      bookingId, partnerOrderId, penalty: result.penaltyAmount,
    });

    return {
      success:       true,
      partnerOrderId,
      penaltyAmount: result.penaltyAmount,
      currency:      result.currency,
    };
  } catch (err) {
    logger.error('RateHawkBook: cancellation failed', {
      bookingId, partnerOrderId, error: err.message,
    });
    return { success: false, error: err.message, partnerOrderId };
  }
}

// ─────────────────────────────────────────────
// GET ORDER
//
// Retrieve full booking details from ETG after confirmation.
// Note: ETG syncs async — may be empty immediately after booking.
// Do not use for status checks — use poll/webhook for that.
// ─────────────────────────────────────────────
async function getOrder({ partnerOrderId }) {
  try {
    return await ratehawkAdapter.getOrder({ partnerOrderId });
  } catch (err) {
    logger.error('RateHawkBook: getOrder failed', { partnerOrderId, error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

// Generates a unique partner order ID.
// Format: RH-{bookingId-prefix}-{timestamp}-{random}
// Regenerated on each form retry per ETG spec.
function _generateOrderId(bookingId) {
  const prefix    = (bookingId || '').slice(0, 8);
  const timestamp = Date.now().toString(36).toUpperCase();
  const rand      = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `RH-${prefix}-${timestamp}-${rand}`;
}

async function _updateBookingStatus(bookingId, supplierStatus, partnerOrderId, supplierOrderId, meta) {
  if (!bookingId) return;
  try {
    const update = {
      supplier_status: supplierStatus,
      booking_status:  supplierStatus === 'confirmed' ? 'confirmed' : supplierStatus === 'failed' ? 'failed' : 'pending',
      updated_at:      new Date().toISOString(),
    };

    if (partnerOrderId) update.ratehawk_partner_order_id = partnerOrderId;
    if (supplierOrderId) update.ratehawk_order_id        = supplierOrderId;
    if (meta)            update.supplier_meta            = meta;

    await supabase.from('bookings').update(update).eq('id', bookingId);
  } catch (err) {
    logger.error('RateHawkBook: _updateBookingStatus failed', { bookingId, error: err.message });
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { book, cancel, getOrder };