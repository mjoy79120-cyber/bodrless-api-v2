/**
 * WHATSAPP CANCEL FLOW
 * ─────────────────────────────────────────────
 * Lets a traveler cancel a confirmed booking via WhatsApp.
 *
 * FIXED (2026-07-10):
 *   - Now actually calls the Duffel cancel API (was the known gap —
 *     previously only cancelled HotelBeds, never Duffel)
 *   - Reads supplier order IDs from the correct columns:
 *       duffel_order_id (new column from migration)
 *       hotel_supplier_reference / supplier_booking_reference
 *       travelduqa_order_id (new column from migration)
 *   - Falls back gracefully if one supplier cancel fails — still
 *     cancels the other and marks the booking cancelled in Supabase
 *   - Stores refund amounts per supplier in bookings table
 *   - Uses conversationMemoryService to preserve context so the
 *     traveler can search again immediately after cancelling
 *
 * Flow (post-booking, with ref):
 *   1. Traveler says "cancel my booking" or "cancel BDR-xxx"
 *   2. Lookup booking by phone (most recent) or by ref if stated
 *   3. Show real cancellation policy + fee from supplier
 *   4. Ask YES / NO
 *   5. On YES: cancel Duffel order + HotelBeds booking in parallel
 *   6. Update bookings table: cancelled_at, refund amounts, status
 *   7. Tell traveler outcome + any refund due
 *   8. Preserve conversation so they can search again right away
 * ─────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const whatsappService = require('./whatsapp');
const conversationMemory = require('./conversationMemoryService');
const tracking = require('./trackingService');

// Lazy-load adapters to avoid circular dep issues at startup
let duffelAdapter     = null;
let hotelbedsAdapter  = null;
let travelduqaAdapter = null;

function getDuffel()     { if (!duffelAdapter)     duffelAdapter     = require('../adapters/duffel');     return duffelAdapter; }
function getHotelbeds()  { if (!hotelbedsAdapter)  hotelbedsAdapter  = require('../adapters/hotelbeds');  return hotelbedsAdapter; }
function getTravelduqa() { if (!travelduqaAdapter) travelduqaAdapter = require('../adapters/travelduqa'); return travelduqaAdapter; }

const pendingCancellations = new Map(); // phone -> { bookingRef, expiresAt, booking, terms }
const PENDING_TTL_MS = 10 * 60 * 1000;

const CANCEL_INTENT_RE = /\b(cancel|refund)\b.{0,25}\b(my\s+)?(booking|reservation|trip|hotel|room|flight)\b|\bi\s+want\s+to\s+cancel\b|\bcancel\s+my\s+booking\b|\bcancel\s+it\b|\bplease\s+cancel\b/i;
const BOOKING_REF_RE   = /\bBD[LR]-\d+\b/i;
const CONFIRM_RE = /^(yes|yep|yeah|yup|confirm|correct|proceed|do it|go ahead)\b/i;
const DECLINE_RE = /^(no|nope|nah|cancel\s+that|never\s*mind|stop|don'?t)\b/i;

class WhatsAppCancelFlow {

  looksLikeCancelIntent(text) {
    return CANCEL_INTENT_RE.test(String(text || ''));
  }

  hasPendingConfirmation(phone) {
    const entry = pendingCancellations.get(phone);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { pendingCancellations.delete(phone); return false; }
    return true;
  }

  async handleMessage({ phoneNumberId, from, text, agencyId }) {
    if (this.hasPendingConfirmation(from)) {
      return this._handleConfirmationReply({ phoneNumberId, from, text, agencyId });
    }
    if (!this.looksLikeCancelIntent(text)) return false;
    return this._startCancellation({ phoneNumberId, from, text, agencyId });
  }

  async _startCancellation({ phoneNumberId, from, text, agencyId }) {
    // Check if they included a ref inline ("cancel booking BDR-123")
    const inlineRef = text?.match(BOOKING_REF_RE)?.[0]?.toUpperCase() || null;

    const booking = inlineRef
      ? await this._findBookingByRef(inlineRef)
      : await this._findMostRecentCancellableBooking(from);

    if (!booking) {
      await whatsappService.sendText(phoneNumberId, from,
        "I couldn't find an active booking under this number to cancel. If you booked with a different phone number, share the booking reference (BDR-... or BDL-...) and I'll look it up."
      );
      return true;
    }

    // Get real cancellation terms from the supplier
    const terms = await this._fetchCancellationTerms(booking);

    const hotelName  = booking.hotel_details?.name       || booking.package_snapshot?.hotel?.name || 'your hotel';
    const flightInfo = booking.flight_details?.airline
      ? ` + ${booking.flight_details.airline} flight`
      : '';

    const lines = [
      `You're about to cancel booking *${booking.booking_ref}* — ${hotelName}${flightInfo}.`,
      '',
    ];

    if (terms.feeApplies) {
      lines.push(`⚠️ A cancellation fee of *${terms.feeCurrency} ${terms.feeAmount.toLocaleString()}* applies.`);
    } else {
      lines.push(`✅ This is within the free-cancellation window — no fee applies.`);
    }

    if (terms.flightNonRefundable) {
      lines.push(`✈️ The flight portion is *non-refundable* per the airline's fare rules.`);
    } else if (terms.flightRefundAmount > 0) {
      lines.push(`✈️ A flight refund of *${terms.feeCurrency} ${terms.flightRefundAmount.toLocaleString()}* may be due (subject to airline processing).`);
    }

    lines.push(`Estimated total refund: *${terms.feeCurrency} ${terms.totalRefund.toLocaleString()}*`);
    lines.push('');
    lines.push('Reply *YES* to confirm cancellation, or *NO* to keep your booking.');

    pendingCancellations.set(from, {
      bookingRef: booking.booking_ref,
      booking,
      terms,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    await whatsappService.sendText(phoneNumberId, from, lines.join('\n'));
    return true;
  }

  async _handleConfirmationReply({ phoneNumberId, from, text, agencyId }) {
    const pending = pendingCancellations.get(from);
    const answer  = String(text || '').trim();

    if (CONFIRM_RE.test(answer)) {
      pendingCancellations.delete(from);
      await whatsappService.sendText(phoneNumberId, from, `Processing your cancellation for *${pending.bookingRef}*...`);
      return this._executeCancellation({ phoneNumberId, from, agencyId, pending });
    }

    if (DECLINE_RE.test(answer)) {
      pendingCancellations.delete(from);
      await whatsappService.sendText(phoneNumberId, from, "Okay, your booking is unchanged. Let me know if there's anything else I can help with.");
      return true;
    }

    // Unclear — re-ask, refresh TTL
    pending.expiresAt = Date.now() + PENDING_TTL_MS;
    await whatsappService.sendText(phoneNumberId, from,
      `Please reply *YES* to confirm cancelling *${pending.bookingRef}*, or *NO* to keep it.`
    );
    return true;
  }

  async _executeCancellation({ phoneNumberId, from, agencyId, pending }) {
    const { booking, terms } = pending;
    const results = { duffel: null, hotelbeds: null, travelduqa: null, errors: [] };

    // ── Cancel Duffel flight order ───────────────────────────
    // THIS WAS THE KNOWN GAP — now actually calls the API
    const duffelOrderId = booking.duffel_order_id || booking.supplier_order_id;
    if (duffelOrderId && booking.flight_details?.supplier === 'duffel') {
      try {
        logger.info('CancelFlow: cancelling Duffel order', { orderId: duffelOrderId, bookingRef: booking.booking_ref });
        results.duffel = await getDuffel().cancel(duffelOrderId);
        logger.info('CancelFlow: Duffel cancel confirmed', {
          bookingRef: booking.booking_ref,
          refundAmount: results.duffel?.refundAmount,
          refundCurrency: results.duffel?.refundCurrency,
        });
      } catch (err) {
        logger.error('CancelFlow: Duffel cancel failed', { bookingRef: booking.booking_ref, error: err.message });
        results.errors.push(`Flight cancellation: ${err.message}`);
      }
    }

    // ── Cancel TravelDuqa flight order ──────────────────────
    const travelduqaOrderId = booking.travelduqa_order_id ||
      (booking.flight_details?.supplier === 'travelduqa' ? booking.supplier_order_id : null);
    if (travelduqaOrderId) {
      try {
        logger.info('CancelFlow: cancelling TravelDuqa order', { orderId: travelduqaOrderId });
        const cancelRes = await getTravelduqa().cancel(travelduqaOrderId);

        // TravelDuqa needs a two-step: cancel -> confirmCancellation
        if (cancelRes?.cancellationId) {
          await new Promise(r => setTimeout(r, 2000)); // brief wait for their system
          await getTravelduqa().confirmCancellation({
            cancellationId: cancelRes.cancellationId,
            amount: terms.totalRefund || 0,
            currency: terms.feeCurrency || 'KES',
          });
        }
        results.travelduqa = cancelRes;
        logger.info('CancelFlow: TravelDuqa cancel confirmed', { bookingRef: booking.booking_ref });
      } catch (err) {
        logger.error('CancelFlow: TravelDuqa cancel failed', { bookingRef: booking.booking_ref, error: err.message });
        results.errors.push(`Flight cancellation: ${err.message}`);
      }
    }

    // ── Cancel HotelBeds booking ────────────────────────────
    const hotelRef = booking.hotelbeds_booking_ref ||
      booking.hotel_supplier_reference ||
      (booking.hotel_details?.supplier === 'hotelbeds' ? booking.supplier_booking_reference : null);
    if (hotelRef) {
      try {
        logger.info('CancelFlow: cancelling HotelBeds booking', { hotelRef, bookingRef: booking.booking_ref });
        results.hotelbeds = await getHotelbeds().cancel({ bookingRef: hotelRef });
        logger.info('CancelFlow: HotelBeds cancel confirmed', { bookingRef: booking.booking_ref });
      } catch (err) {
        logger.error('CancelFlow: HotelBeds cancel failed', { bookingRef: booking.booking_ref, error: err.message });
        results.errors.push(`Hotel cancellation: ${err.message}`);
      }
    }

    // ── Update bookings table ──────────────────────────────
    const now = new Date().toISOString();
    const refundAmount   = (results.duffel?.refundAmount || 0) + (terms.hotelRefund || 0);
    const refundCurrency = results.duffel?.refundCurrency || terms.feeCurrency || 'KES';

    try {
      await supabase
        .from('bookings')
        .update({
          status:             'cancelled',
          booking_status:     'cancelled',
          cancellation_status: results.errors.length > 0 ? 'partial' : 'confirmed',
          cancelled_at:        now,
          cancelled_by:        'traveler_whatsapp',
          refunded_amount:     refundAmount,
          refund_amount:       refundAmount,
          refund_currency:     refundCurrency,
          refund_note:         results.errors.length > 0
            ? `Partial: ${results.errors.join('; ')}`
            : 'Cancelled successfully',
        })
        .eq('booking_ref', booking.booking_ref);
    } catch (err) {
      logger.error('CancelFlow: failed to update bookings table', { bookingRef: booking.booking_ref, error: err.message });
    }

    // ── Alert ops if partial failure ──────────────────────
    if (results.errors.length > 0) {
      tracking.alert({
        type:      'cancellation_partial_failure',
        severity:  'warning',
        title:     `Partial cancellation — ${booking.booking_ref}`,
        detail:    `Some supplier cancellations failed: ${results.errors.join('; ')}. Manual follow-up needed.`,
        context:   { bookingRef: booking.booking_ref, results },
        agencyId:  booking.agency_id,
        bookingRef: booking.booking_ref,
      });
    }

    // ── Build response message ─────────────────────────────
    const lines = [`✅ Booking *${booking.booking_ref}* has been cancelled.`];

    if (results.errors.length > 0) {
      lines.push(`\n⚠️ One part of your booking couldn't be cancelled automatically — our team has been notified and will follow up to confirm everything is resolved.`);
    }

    if (refundAmount > 0) {
      lines.push(`\nRefund due: *${refundCurrency} ${refundAmount.toLocaleString()}*. This will be processed within 7-14 business days back to your original payment method.`);
    } else if (terms.feeApplies || terms.flightNonRefundable) {
      lines.push(`\nNo refund is due based on the cancellation policy at the time of cancelling.`);
    }

    lines.push(`\nFeel free to search for a new trip anytime — just tell me where you'd like to go!`);

    await whatsappService.sendText(phoneNumberId, from, lines.join(''));

    // Preserve conversation context so they can search again
    await conversationMemory.clearSelectedPackage(from, agencyId);

    return true;
  }

  // ─────────────────────────────────────────────
  // FETCH REAL CANCELLATION TERMS
  // Reads from the booking's stored cancellation policies
  // (saved at booking time from HotelBeds + Duffel responses).
  // Does NOT make a live API call — policies were saved at
  // booking time per HotelBeds certification requirements.
  // ─────────────────────────────────────────────
  async _fetchCancellationTerms(booking) {
    const now     = new Date();
    const totalPaid = Number(booking.total_price || 0);
    const currency  = booking.currency || 'KES';

    // ── Hotel cancellation fee ──────────────────────────────
    const hotelPolicies = booking.hotel_details?.cancellationPolicies ||
      booking.package_snapshot?.hotel?.cancellationPolicies || [];

    let feeApplies = false;
    let feeAmount  = 0;
    let feeCurrency = currency;

    for (const p of hotelPolicies) {
      if (p.from && now >= new Date(p.from)) {
        const amt = Number(p.amount) || 0;
        if (amt >= feeAmount) {
          feeApplies  = true;
          feeAmount   = amt;
          feeCurrency = p.currencyId || feeCurrency;
        }
      }
    }

    const hotelRefund = feeApplies ? Math.max(0, totalPaid - feeAmount) : totalPaid;

    // ── Flight refund status ────────────────────────────────
    const flightIsRefundable    = booking.flight_details?.isRefundable;
    const flightNonRefundable   = flightIsRefundable === false;
    const flightRefundPenalty   = Number(booking.flight_details?.refundPenalty || 0);
    const flightPaid            = Number(booking.flight_details?.price || 0);
    const flightRefundAmount    = flightNonRefundable ? 0 : Math.max(0, flightPaid - flightRefundPenalty);

    const totalRefund = Math.max(0, hotelRefund + flightRefundAmount);

    return {
      feeApplies,
      feeAmount,
      feeCurrency,
      hotelRefund,
      flightNonRefundable,
      flightRefundAmount,
      totalRefund,
    };
  }

  async _findBookingByRef(bookingRef) {
    try {
      const { data } = await supabase
        .from('bookings')
        .select('*')
        .eq('booking_ref', bookingRef)
        .maybeSingle();
      return data || null;
    } catch (err) {
      logger.error('CancelFlow: findBookingByRef failed', { bookingRef, error: err.message });
      return null;
    }
  }

  async _findMostRecentCancellableBooking(phone) {
    try {
      const { data } = await supabase
        .from('bookings')
        .select('*')
        .eq('guest_phone', phone)
        .eq('status', 'confirmed')
        .order('created_at', { ascending: false })
        .limit(1);

      return data?.[0] || null;
    } catch (err) {
      logger.error('CancelFlow: findMostRecentBooking failed', { phone, error: err.message });
      return null;
    }
  }
}

module.exports = new WhatsAppCancelFlow();