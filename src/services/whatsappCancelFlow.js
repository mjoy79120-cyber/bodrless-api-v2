/**
 * WHATSAPP CANCEL FLOW
 * ─────────────────────────────────────────────
 * Lets a traveler cancel their own confirmed booking directly via
 * WhatsApp — e.g. "cancel my booking". Two-step: detect intent,
 * confirm with real cancellation-fee/refund terms shown BEFORE
 * anything happens, only act on an explicit "yes".
 *
 * Built for the HotelBeds certification call requirement to
 * demonstrate a live cancellation as a genuine traveler-facing
 * action, not a backend/ops-only operation.
 *
 * Booking lookup is by guest_phone — the most recent CONFIRMED
 * booking for whichever number is messaging. If a traveler has
 * multiple active bookings, this MVP only offers to cancel the most
 * recent one; a real multi-booking picker is a reasonable follow-up
 * but out of scope for the immediate certification need.
 * ─────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const whatsappService = require('./whatsapp');
const bookingService = require('./bookingService');

// In-memory pending-confirmation state, same pattern as
// webhooks.js's recentPackagesByPhone — a phone number that just
// received a cancellation preview is "pending" until they reply
// yes/no or the TTL expires.
const pendingCancellations = new Map(); // phone -> { bookingRef, expiresAt }
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes

const CANCEL_INTENT_RE = /\b(cancel|refund)\b.{0,25}\b(my\s+)?(booking|reservation|trip|hotel|room)\b|\bi\s+want\s+to\s+cancel\b|\bcancel\s+my\s+booking\b|\bcancel\s+it\b|\bplease\s+cancel\b/i;
const CONFIRM_RE = /^(yes|yep|yeah|yup|confirm|correct|proceed|do it|go ahead)\b/i;
const DECLINE_RE = /^(no|nope|nah|cancel\s+that|never\s*mind|stop|don'?t)\b/i;

class WhatsAppCancelFlow {

  // ─────────────────────────────────────────────
  // Quick check webhooks.js can use BEFORE calling handleMessage,
  // to decide routing priority against other flows (e.g. the normal
  // booking/search flow) without actually acting yet.
  // ─────────────────────────────────────────────
  looksLikeCancelIntent(text) {
    return CANCEL_INTENT_RE.test(String(text || ''));
  }

  hasPendingConfirmation(phone) {
    const entry = pendingCancellations.get(phone);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      pendingCancellations.delete(phone);
      return false;
    }
    return true;
  }

  // ─────────────────────────────────────────────
  // MAIN ENTRY POINT
  // Returns true if this message was handled by the cancel flow
  // (caller should stop processing it any further), false if it
  // wasn't relevant (caller should fall through to normal handling).
  // ─────────────────────────────────────────────
  async handleMessage({ phoneNumberId, from, text }) {
    if (this.hasPendingConfirmation(from)) {
      return this._handleConfirmationReply({ phoneNumberId, from, text });
    }

    if (!this.looksLikeCancelIntent(text)) return false;

    return this._startCancellation({ phoneNumberId, from });
  }

  async _startCancellation({ phoneNumberId, from }) {
    const booking = await this._findMostRecentCancellableBooking(from);

    if (!booking) {
      await whatsappService.sendText(phoneNumberId, from,
        "I couldn't find an active booking under this number to cancel. If you booked with a different phone number, let me know the booking reference and I'll look it up for you."
      );
      return true;
    }

    const terms = this._previewCancellationTerms(booking);
    const hotelName = booking.hotel_details?.name || 'your hotel';

    const lines = [
      `You're about to cancel booking *${booking.booking_ref}* for *${hotelName}*.`,
      '',
    ];

    if (terms.feeApplies) {
      lines.push(`⚠️ This is past the free-cancellation window — a cancellation fee of ${terms.feeCurrency} ${terms.feeAmount.toLocaleString()} applies.`);
    } else {
      lines.push(`✅ This is within the free-cancellation window — no fee applies.`);
    }
    lines.push(`Estimated refund: ${terms.feeCurrency} ${terms.refundAmount.toLocaleString()}.`);
    lines.push('');
    lines.push('Reply *YES* to confirm cancellation, or *NO* to keep your booking.');

    pendingCancellations.set(from, {
      bookingRef: booking.booking_ref,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    await whatsappService.sendText(phoneNumberId, from, lines.join('\n'));
    return true;
  }

  async _handleConfirmationReply({ phoneNumberId, from, text }) {
    const pending = pendingCancellations.get(from);
    const answer = String(text || '').trim();

    if (CONFIRM_RE.test(answer)) {
      pendingCancellations.delete(from);
      await whatsappService.sendText(phoneNumberId, from, `Processing your cancellation for ${pending.bookingRef}...`);

      const result = await bookingService.cancelConfirmedBooking({
        bookingRef: pending.bookingRef,
        requestedBy: 'traveler_whatsapp',
      });

      if (!result.success) {
        await whatsappService.sendText(phoneNumberId, from,
          `I couldn't complete the cancellation: ${result.error}. Please contact support for help.`
        );
        return true;
      }

      const lines = [`✅ Booking ${result.bookingRef} has been cancelled.`];

      if (result.supplierCancelSucceeded === false) {
        lines.push(`⚠️ There was an issue confirming this directly with the hotel supplier — our team has been notified and will follow up to make sure this is fully resolved on their end too.`);
      }

      if (result.refundAmount > 0) {
        lines.push(`Refund due: ${result.refundCurrency} ${result.refundAmount.toLocaleString()}. ${result.refundNote}`);
      } else if (result.feeApplies) {
        lines.push(`No refund is due — the full amount became non-refundable per the cancellation policy at the time of cancelling.`);
      }

      await whatsappService.sendText(phoneNumberId, from, lines.join('\n'));
      return true;
    }

    if (DECLINE_RE.test(answer)) {
      pendingCancellations.delete(from);
      await whatsappService.sendText(phoneNumberId, from, `Okay, I've left your booking as is.`);
      return true;
    }

    // Unclear reply — re-ask, refresh the TTL rather than losing the
    // pending state on an ambiguous answer.
    pending.expiresAt = Date.now() + PENDING_TTL_MS;
    await whatsappService.sendText(phoneNumberId, from,
      `Sorry, I didn't catch that — reply *YES* to confirm cancelling booking ${pending.bookingRef}, or *NO* to keep it.`
    );
    return true;
  }

  // ─────────────────────────────────────────────
  // PREVIEW CANCELLATION TERMS
  // Same fee-calculation logic as bookingService.cancelConfirmedBooking
  // itself — duplicated deliberately (not imported) so this preview
  // can never silently drift from what actually gets applied, but
  // also can't accidentally trigger a real cancellation just by
  // being shown. Kept simple and side-effect-free.
  // ─────────────────────────────────────────────
  _previewCancellationTerms(booking) {
    const policies = booking.hotel_details?.cancellationPolicies || [];
    const now = new Date();
    let feeApplies = false;
    let feeAmount = 0;
    let feeCurrency = booking.currency || 'KES';

    for (const p of policies) {
      if (p.from && now >= new Date(p.from)) {
        const amt = Number(p.amount) || 0;
        if (amt >= feeAmount) {
          feeApplies = true;
          feeAmount = amt;
          feeCurrency = p.currencyId || feeCurrency;
        }
      }
    }

    const totalPaid = Number(booking.total_price || 0);
    const refundAmount = feeApplies ? Math.max(0, totalPaid - feeAmount) : totalPaid;

    return { feeApplies, feeAmount, feeCurrency, refundAmount };
  }

  async _findMostRecentCancellableBooking(phone) {
    try {
      const { data, error } = await supabase
        .from('bookings')
        .select('*')
        .eq('guest_phone', phone)
        .eq('status', 'confirmed')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error || !data || data.length === 0) return null;
      return data[0];
    } catch (err) {
      logger.error('WhatsAppCancelFlow: booking lookup failed', { error: err.message });
      return null;
    }
  }
}

module.exports = new WhatsAppCancelFlow();