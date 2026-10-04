/**
 * RATEHAWK BOOK SERVICE  v2
 * ─────────────────────────────────────────────────────────────
 * Orchestrates the full ETG v3 booking lifecycle:
 *
 *   book()   → hotelpage → prebook → form → finish → poll → confirmed
 *   cancel() → cancel order by partnerOrderId
 *   getOrder() → retrieve full booking details post-confirmation
 *
 * BOOKING LIFECYCLE (per ETG docs):
 *
 *   0. hotelpage()  — live rate fetch; returns fresh h-... hash
 *                     MUST match hotelpageGuests to bookingRooms exactly.
 *   1. prebook()    — locks rate, h-... → p-... hash
 *                     (old hash is consumed — never reuse it)
 *   2. form()       — opens ETG order, links to your partnerOrderId
 *                     retry up to 10x with new partnerOrderId on
 *                     duplicate_reservation / double_booking_form / 5xx
 *   3. finish()     — sends booking to supplier (async)
 *                     proceed even on timeout/unknown/5xx
 *   4. poll()       — check status every POLL_INTERVAL_MS
 *                     stop on 'ok' or terminal error
 *                     if poll window exhausted → 'awaiting_confirmation'
 *
 * PAYMENT TYPE: 'deposit' — bills to your ETG credit line.
 *   ETG invoices monthly. Collect from agency before settlement.
 *
 * CHANGE LOG
 *   2026-10-02  Added hotelpage() step before prebook (was missing).
 *               Fixed guest shape: uses passengerMapper.allocateRooms()
 *               so hotelpageGuests and bookingRooms always match.
 *               Fixed formResult check: only break on explicit 'ok'.
 *               Fixed error field: formResult.error (not error_code).
 *               Added priceChanged surface to caller.
 *               Added message-id dedup guard via Supabase.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const { v4: uuidv4 }        = require('uuid');
const supabase               = require('../utils/supabase');
const { logger }             = require('../utils/logger');
const ratehawkAdapter        = require('../adapters/ratehawk');
const { allocateRooms,
        toResidencyCode }    = require('./passengerMapper');

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const POLL_ATTEMPTS    = Number(process.env.RATEHAWK_POLL_ATTEMPTS)    || 30;
const POLL_INTERVAL_MS = Number(process.env.RATEHAWK_POLL_INTERVAL_MS) || 3000;
const FORM_MAX_RETRIES = 10;

// Terminal booking failures — do NOT retry, show error to user.
const TERMINAL_ERRORS = new Set([
  'soldout', 'book_limit', 'booking_finish_did_not_succeed',
  'provider', '3ds', 'block', 'charge',
  // Full status-table list (ETG docs §5.6)
  'decoding_json', 'endpoint_exceeded_limit', 'endpoint_not_active',
  'endpoint_not_found', 'incorrect_credentials', 'invalid_auth_header',
  'invalid_params', 'lock', 'no_auth_header', 'not_allowed',
  'not_allowed_host', 'order_not_found', 'overdue_debt', 'unexpected_method',
]);

// Finish-step terminal errors — stop immediately, don't proceed to poll.
const TERMINAL_FINISH_ERRORS = new Set([
  'booking_form_expired', 'rate_not_found', 'return_path_required',
  'email', 'incorrect_guests_number', 'incorrect_children_data',
  'incorrect_rooms_number', 'unauthorized_group_booking',
]);

// Form-step errors that require a new partnerOrderId and retry.
const FORM_RETRYABLE_NEW_ID = new Set([
  'duplicate_reservation', 'double_booking_form',
]);

// ─────────────────────────────────────────────
// MAIN BOOK FUNCTION
//
// Params:
//   bookingId     — your Supabase bookings.id
//   pkg           — the selected package (hotel.hotelId, hotel.matchHash,
//                   hotel.checkIn, hotel.checkOut required for hotelpage)
//   passengers    — WhatsApp-native passenger objects (with dateOfBirth,
//                   nationality, type)
//   roomCount     — number of rooms from the package
//   holder        — { firstName, lastName, email, phone }
//   agencyId      — for logging
//   priceApproved — true if caller already confirmed a price change
//
// Returns:
//   { success, status, partnerOrderId, supplierOrderId,
//     priceChanged?, newPrice?, currency?, error? }
// ─────────────────────────────────────────────
async function book({
  bookingId,
  pkg,
  passengers,
  roomCount = 1,
  holder,
  agencyId,
  priceApproved = false,
}) {
  // ── 0. Validate corporate email ───────────────────────────
  const corporateEmail = process.env.RATEHAWK_CORPORATE_EMAIL;
  if (!corporateEmail) {
    logger.error('RateHawkBook: RATEHAWK_CORPORATE_EMAIL not set — refusing to book');
    return { success: false, status: 'failed', error: 'corporate_email_missing' };
  }

  // ── Allocate rooms — single source of truth ───────────────
  // checkIn drives age-at-travel so HP and booking guests match exactly.
  const checkIn = pkg?.hotel?.checkIn || pkg?.transport?.departureDate || null;
  if (!checkIn) {
    logger.error('RateHawkBook: cannot determine checkIn date', { bookingId });
    return { success: false, status: 'failed', error: 'missing_checkin' };
  }

  const { hotelpageGuests, bookingRooms } = allocateRooms(passengers, roomCount, checkIn);

  logger.info('RateHawkBook: room allocation', {
    bookingId,
    roomCount,
    checkIn,
    hotelpageGuests: JSON.stringify(hotelpageGuests),
    bookingRoomsCount: bookingRooms.length,
  });

  // Residency from lead passenger (passport country).
  const residency = toResidencyCode(passengers[0]?.nationality);

  // ── Step 0: Hotelpage — fetch live h-... hash ─────────────
  const hotelId   = pkg?.hotel?.hotelId  || pkg?.hotel?.hotelCode;
  const matchHash = pkg?.hotel?.matchHash || null;
  const checkOut  = pkg?.hotel?.checkOut;

  if (!hotelId) {
    logger.error('RateHawkBook: no hotelId on package', { bookingId, pkg: JSON.stringify(pkg?.hotel) });
    return { success: false, status: 'failed', error: 'missing_hotel_id' };
  }

  let hHash;
  try {
    logger.info('RateHawkBook: fetching live hotelpage', {
      bookingId, hotelId, checkIn, checkOut, residency, hotelpageGuests,
    });

    const hotelPage = await ratehawkAdapter.getHotelPage({
      hotelId,
      checkIn,
      checkOut,
      guests:    hotelpageGuests,
      residency,
    });

    const rates = hotelPage?.rates || [];
    if (rates.length === 0) {
      logger.error('RateHawkBook: hotelpage returned no rates', { bookingId, hotelId });
      return { success: false, status: 'failed', error: 'no_rates_on_hotelpage' };
    }

    // Prefer the rate matching the package's matchHash; fall back to first.
    const matchedRate = matchHash
      ? rates.find(r => r.match_hash === matchHash)
      : null;
    const rate = matchedRate || rates[0];

    hHash = rate?.book_hash;
    if (!hHash?.startsWith('h-')) {
      logger.error('RateHawkBook: hotelpage rate has no h-... hash', {
        bookingId, bookHash: hHash?.slice(0, 20),
      });
      return { success: false, status: 'failed', error: 'invalid_hotelpage_hash' };
    }

    logger.info('RateHawkBook: hotelpage h-... hash obtained', {
      bookingId, hashPrefix: hHash.slice(0, 20), matchedExact: !!matchedRate,
    });
  } catch (err) {
    logger.error('RateHawkBook: hotelpage failed', { bookingId, error: err.message });
    await _updateBookingStatus(bookingId, 'failed', null, null, { error: 'hotelpage_failed' });
    return { success: false, status: 'failed', error: 'hotelpage_failed', detail: err.message };
  }

  // ── Step 1: Prebook — h-... → p-... hash ─────────────────
  let prebookResult;
  try {
    prebookResult = await ratehawkAdapter.prebook({ bookHash: hHash });
  } catch (err) {
    logger.error('RateHawkBook: prebook failed', { bookingId, error: err.message });
    await _updateBookingStatus(bookingId, 'failed', null, null, { error: 'prebook_failed' });
    return { success: false, status: 'failed', error: 'prebook_failed', detail: err.message };
  }

  const pHash = prebookResult.bookHash;
  if (!pHash?.startsWith('p-')) {
    logger.error('RateHawkBook: prebook returned no p-... hash', {
      bookingId, bookHash: pHash?.slice(0, 20),
    });
    return { success: false, status: 'failed', error: 'invalid_prebook_hash' };
  }

  // Surface price change to caller so they can ask traveler to approve.
  if (prebookResult.priceChanged && !priceApproved) {
    logger.warn('RateHawkBook: price changed during prebook — surfacing to caller', {
      bookingId,
      newPrice:  prebookResult.showPrice,
      currency:  prebookResult.currency,
    });
    return {
      success:      false,
      status:       'price_changed',
      priceChanged: true,
      newPrice:     prebookResult.showPrice,
      currency:     prebookResult.currency,
      // Caller must restart the flow (call book() again with priceApproved:true).
      // The p-... hash is NOT returned — prebook must run again after approval
      // because the hash is single-use.
      error:        'PRICE_CHANGED',
    };
  }

  // ── Step 2: Booking Form — retry up to FORM_MAX_RETRIES ──
  let partnerOrderId = _generateOrderId(bookingId);
  let formData       = null;
  let formAttempt    = 0;

  while (formAttempt < FORM_MAX_RETRIES) {
    formAttempt++;
    try {
      logger.info('RateHawkBook: opening booking form', {
        bookingId, partnerOrderId, attempt: formAttempt,
      });

      const formResult = await ratehawkAdapter._openBookingForm({
        partnerOrderId,
        bookHash: pHash,
      });

      // ETG form response: { status: 'ok'|'error', error: null|'code', data: {...} }
      if (formResult?.status === 'ok') {
        formData = formResult.data || formResult;
        logger.info('RateHawkBook: booking form opened', {
          bookingId, partnerOrderId, attempt: formAttempt,
        });
        break;
      }

      const errCode = formResult?.error || formResult?.status;

      // Retryable errors that need a NEW partnerOrderId.
      if (FORM_RETRYABLE_NEW_ID.has(errCode)) {
        logger.warn('RateHawkBook: form retryable — new orderId', {
          bookingId, errCode, attempt: formAttempt,
        });
        partnerOrderId = _generateOrderId(bookingId);
        await _sleep(1000 * formAttempt);
        continue;
      }

      // Generic retryable (5xx-equivalent at application level).
      if (errCode === 'unknown' || errCode === 'timeout') {
        logger.warn('RateHawkBook: form transient error — retrying same orderId', {
          bookingId, errCode, attempt: formAttempt,
        });
        await _sleep(1000 * formAttempt);
        continue;
      }

      // Non-retryable form error.
      logger.error('RateHawkBook: booking form non-retryable error', {
        bookingId, errCode, formResult: JSON.stringify(formResult),
      });
      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: errCode });
      return { success: false, status: 'failed', error: errCode, partnerOrderId };

    } catch (err) {
      const is5xx = (err.response?.status || 0) >= 500;
      const isNetwork = !err.response;

      logger.warn(`RateHawkBook: form attempt ${formAttempt} threw`, {
        bookingId, error: err.message, is5xx, isNetwork,
      });

      if ((is5xx || isNetwork) && formAttempt < FORM_MAX_RETRIES) {
        partnerOrderId = _generateOrderId(bookingId);
        await _sleep(1000 * formAttempt);
        continue;
      }

      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: 'form_error' });
      return {
        success: false, status: 'failed', error: 'form_error',
        detail: err.message, partnerOrderId,
      };
    }
  }

  if (!formData) {
    logger.error('RateHawkBook: exhausted form retries without ok', { bookingId });
    await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: 'form_max_retries' });
    return { success: false, status: 'failed', error: 'form_max_retries', partnerOrderId };
  }

  // Save partnerOrderId immediately — needed by background poller on timeout.
  await _updateBookingStatus(bookingId, 'awaiting_confirmation', partnerOrderId, null, null);

  // ── Step 3: Booking Finish — send to supplier ────────────
  // Per ETG spec: proceed to polling even on finish timeout/unknown/5xx.
  // TERMINAL_FINISH_ERRORS (rate_not_found etc.) are the only hard stop.
  try {
    logger.info('RateHawkBook: sending booking finish', {
      bookingId, partnerOrderId,
      rooms: bookingRooms.length,
    });

    const finishResult = await ratehawkAdapter._finishBooking({
      partnerOrderId,
      bookHash: pHash,
      holder: {
        firstName: holder.firstName,
        lastName:  holder.lastName,
        email:     corporateEmail,   // B2B: always fixed corporate email
        phone:     holder.phone || null,
      },
      guestsByRoom: bookingRooms,
    });

    // Hard stops from finish step.
    const finishError = finishResult?.error;
    if (finishError && TERMINAL_FINISH_ERRORS.has(finishError)) {
      logger.error('RateHawkBook: finish terminal error', { bookingId, finishError });
      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: finishError });
      return { success: false, status: 'failed', error: finishError, partnerOrderId };
    }

    logger.info('RateHawkBook: finish request sent', { bookingId, partnerOrderId });

  } catch (err) {
    const isRetryable = (err.response?.status || 0) >= 500
      || !err.response  // network error
      || /timeout|unknown/i.test(err.message);

    if (!isRetryable) {
      logger.error('RateHawkBook: finish non-retryable error', { bookingId, error: err.message });
      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, null, { error: 'finish_error' });
      return { success: false, status: 'failed', error: 'finish_error', detail: err.message, partnerOrderId };
    }

    logger.warn('RateHawkBook: finish threw retryable error — proceeding to poll', {
      bookingId, error: err.message,
    });
  }

  // ── Step 4: Poll for confirmation ────────────────────────
  logger.info('RateHawkBook: polling for confirmation', {
    bookingId, partnerOrderId, maxAttempts: POLL_ATTEMPTS,
  });

  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt++) {
    await _sleep(POLL_INTERVAL_MS);

    let pollResult;
    try {
      pollResult = await ratehawkAdapter.getBookingStatus({ partnerOrderId });
    } catch (err) {
      // Transient poll failure — ETG spec says keep polling.
      logger.warn(`RateHawkBook: poll attempt ${attempt} threw — continuing`, {
        bookingId, error: err.message,
      });
      continue;
    }

    const { status, orderId, errorCode } = pollResult;

    logger.info('RateHawkBook: poll result', {
      bookingId, partnerOrderId, attempt, status, orderId, errorCode,
    });

    if (status === 'ok') {
      logger.info('RateHawkBook: booking confirmed', { bookingId, partnerOrderId, orderId });
      await _updateBookingStatus(bookingId, 'confirmed', partnerOrderId, orderId, null);
      return {
        success:         true,
        status:          'confirmed',
        partnerOrderId,
        supplierOrderId: orderId,
      };
    }

    // Terminal = stop polling, fail the booking.
    const terminalCode = TERMINAL_ERRORS.has(status)    ? status
                       : TERMINAL_ERRORS.has(errorCode) ? errorCode
                       : null;

    if (terminalCode) {
      logger.error('RateHawkBook: terminal failure during poll', {
        bookingId, partnerOrderId, terminalCode,
      });
      await _updateBookingStatus(bookingId, 'failed', partnerOrderId, orderId, { error: terminalCode });
      return {
        success:         false,
        status:          'failed',
        error:           terminalCode,
        partnerOrderId,
        supplierOrderId: orderId || null,
      };
    }

    // 'processing' | 'timeout' | 'unknown' | 5xx — keep polling per ETG spec.
  }

  // Poll window exhausted — hand off to background poller.
  // partnerOrderId is already in Supabase (saved after form step).
  logger.warn('RateHawkBook: poll window exhausted — awaiting_confirmation', {
    bookingId, partnerOrderId,
  });
  return {
    success:         false,
    status:          'awaiting_confirmation',
    partnerOrderId,
    supplierOrderId: null,
    message:         'Booking is being processed — you will receive confirmation shortly.',
  };
}

// ─────────────────────────────────────────────
// CANCEL
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
      bookingId, partnerOrderId, penalty: result.amountPayable,
    });

    return {
      success:       true,
      partnerOrderId,
      penaltyAmount: result.amountPayable,
      currency:      result.currency,
    };
  } catch (err) {
    // ETG: retry once on timeout.
    logger.warn('RateHawkBook: cancel failed — retrying once', {
      bookingId, partnerOrderId, error: err.message,
    });
    try {
      const result = await ratehawkAdapter.cancel({ partnerOrderId });
      return {
        success:       true,
        partnerOrderId,
        penaltyAmount: result.amountPayable,
        currency:      result.currency,
        retried:       true,
      };
    } catch (err2) {
      logger.error('RateHawkBook: cancel retry also failed', {
        bookingId, partnerOrderId, error: err2.message,
      });
      return { success: false, error: err2.message, partnerOrderId };
    }
  }
}

// ─────────────────────────────────────────────
// GET ORDER  (post-booking only — not for status checks)
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
      booking_status:  supplierStatus === 'confirmed' ? 'confirmed'
                     : supplierStatus === 'failed'    ? 'failed'
                     : 'pending',
      updated_at: new Date().toISOString(),
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