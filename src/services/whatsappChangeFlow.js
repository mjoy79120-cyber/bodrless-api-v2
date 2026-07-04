/**
 * WHATSAPP CHANGE FLIGHT FLOW
 * ─────────────────────────────────────────────────────────────
 * Lets a traveler change an existing CONFIRMED, PAID flight booking
 * via WhatsApp — "change my flight", "I need to change my booking",
 * etc.
 *
 * IMPORTANT DESIGN DECISION: since this all happens over plain text
 * with no website session/login, we cannot assume which booking a
 * traveler means (unlike, say, cancellation's "most recent
 * confirmed booking" shortcut). This flow ALWAYS explicitly asks
 * for the booking reference (Bodrless's own BDR-... ref, shown on
 * every voucher and confirmation message) before doing anything —
 * never guesses.
 *
 * Flow:
 *   1. Ask for booking reference (or accept it if already stated in
 *      the same message, e.g. "change my flight BDR-123456")
 *   2. Look up the booking, validate it's eligible (confirmed, paid,
 *      Duffel-sourced flight — see bookingService.requestFlightChange)
 *   3. Ask for the new desired date
 *   4. Show the REAL cost/penalty from the airline, ask to confirm
 *   5. On confirmation:
 *      - Free or refund changes: confirmed automatically
 *      - Changes that cost MORE: NOT auto-confirmed yet (no
 *        traveler-facing payment collection built for this specific
 *        case) — the real cost is shown, and the traveler is told
 *        our team will follow up to collect payment and complete it,
 *        an honest "manual processing" fallback rather than either
 *        silently charging Bodrless's own balance without collecting
 *        from the traveler, or building a whole new payment flow
 *        blind right now.
 *
 * State lives in-memory per phone number (short-lived, multi-step
 * conversation) — same pattern as whatsappCancelFlow.js.
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const bookingService = require('./bookingService');
const whatsappService = require('./whatsapp');
const { logger } = require('../utils/logger');
const tracking = require('./trackingService');

const pendingChanges = new Map(); // phone -> { step, bookingRef, booking, newDate, changeRequestId, offers, selectedOffer }
const PENDING_TTL_MS = 10 * 60 * 1000;

const CHANGE_INTENT_RE = /\bchange\s+(my\s+)?(flight|booking|trip|dates?|reservation)\b|\breschedule\b|\bmove\s+my\s+flight\b/i;
const BOOKING_REF_RE = /\bBDR-\d+\b/i;

class WhatsAppChangeFlow {

  looksLikeChangeIntent(text) {
    return CHANGE_INTENT_RE.test(String(text || ''));
  }

  hasPendingChange(phone) {
    const entry = pendingChanges.get(phone);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) { pendingChanges.delete(phone); return false; }
    return true;
  }

  async handleMessage({ phoneNumberId, from, text }) {
    if (this.hasPendingChange(from)) {
      return this._continueFlow({ phoneNumberId, from, text });
    }

    if (!this.looksLikeChangeIntent(text)) return false;

    // Traveler may have included the booking ref in the same
    // message (e.g. "change my flight BDR-1783000672617") — don't
    // make them repeat it if they already gave it.
    const inlineMatch = text.match(BOOKING_REF_RE);
    if (inlineMatch) {
      return this._lookupBooking({ phoneNumberId, from, bookingRef: inlineMatch[0].toUpperCase() });
    }

    pendingChanges.set(from, { step: 'awaiting_booking_ref', expiresAt: Date.now() + PENDING_TTL_MS });
    await whatsappService.sendText(phoneNumberId, from,
      "Sure — what's your booking reference? It looks like *BDR-* followed by some numbers, and was included in your confirmation message and voucher."
    );
    return true;
  }

  async _continueFlow({ phoneNumberId, from, text }) {
    const pending = pendingChanges.get(from);

    if (/^cancel$/i.test(text.trim())) {
      pendingChanges.delete(from);
      await whatsappService.sendText(phoneNumberId, from, "Okay, I've stopped the change request. Your booking is unaffected.");
      return true;
    }

    if (pending.step === 'awaiting_booking_ref') {
      const match = text.match(BOOKING_REF_RE);
      if (!match) {
        pending.expiresAt = Date.now() + PENDING_TTL_MS;
        await whatsappService.sendText(phoneNumberId, from,
          "Sorry, that doesn't look like a booking reference — it should look like *BDR-1783000672617*. Please check your confirmation message and try again, or reply *cancel* to stop."
        );
        return true;
      }
      return this._lookupBooking({ phoneNumberId, from, bookingRef: match[0].toUpperCase() });
    }

    if (pending.step === 'awaiting_new_date') {
      return this._handleNewDate({ phoneNumberId, from, text, pending });
    }

    if (pending.step === 'awaiting_change_confirmation') {
      return this._handleChangeConfirmation({ phoneNumberId, from, text, pending });
    }

    return false;
  }

  async _lookupBooking({ phoneNumberId, from, bookingRef }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .maybeSingle();

    if (error || !booking) {
      pendingChanges.delete(from);
      await whatsappService.sendText(phoneNumberId, from,
        `I couldn't find a booking with reference *${bookingRef}*. Please double-check it and send "change my flight" again to retry.`
      );
      return true;
    }

    if (booking.status !== 'confirmed' || booking.payment_status !== 'paid') {
      pendingChanges.delete(from);
      await whatsappService.sendText(phoneNumberId, from,
        `Booking *${bookingRef}* isn't in a confirmed, paid state, so it can't be changed through here. Please contact support if you need help with it.`
      );
      return true;
    }

    const transport = booking.package_snapshot?.transport || {};
    if (transport.supplier !== 'duffel' || !booking.supplier_order_id) {
      pendingChanges.delete(from);
      await whatsappService.sendText(phoneNumberId, from,
        `Booking *${bookingRef}*'s flight isn't eligible for changes through this service yet. Please contact support directly for help changing it.`
      );
      return true;
    }

    pendingChanges.set(from, {
      step: 'awaiting_new_date',
      bookingRef,
      booking,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    await whatsappService.sendText(phoneNumberId, from,
      `Found it — *${bookingRef}*, ${transport.origin || ''} → ${transport.destination || ''}.\n\nWhat new date would you like to fly? (e.g. "21 May 2027")`
    );
    return true;
  }

  async _handleNewDate({ phoneNumberId, from, text, pending }) {
    const newDate = this._parseFlexibleDate(text);
    if (!newDate) {
      pending.expiresAt = Date.now() + PENDING_TTL_MS;
      await whatsappService.sendText(phoneNumberId, from,
        `Sorry, I couldn't read that date — try something like "21 May 2027" or "2027-05-21". Reply *cancel* to stop.`
      );
      return true;
    }

    await whatsappService.sendText(phoneNumberId, from, "Checking with the airline for available flights on that date — one moment...");

    const result = await bookingService.requestFlightChange({
      bookingRef: pending.bookingRef,
      newDepartureDate: newDate,
    });

    if (!result.success) {
      pendingChanges.delete(from);
      await whatsappService.sendText(phoneNumberId, from, `Sorry, I couldn't check change options: ${result.error}`);
      return true;
    }

    if (!result.hasOffers) {
      pendingChanges.delete(from);
      await whatsappService.sendText(phoneNumberId, from, result.message || "No flights are available for that date. Please try a different date by sending \"change my flight\" again.");
      return true;
    }

    // Cheapest offer first (see duffel.js) — present that one; a
    // future improvement could let the traveler pick among several,
    // but the cheapest is the reasonable default for a text flow.
    const offer = result.offers[0];
    const costLine = offer.changeTotalAmount > 0
      ? `This change costs an extra *${offer.changeTotalCurrency} ${offer.changeTotalAmount.toLocaleString()}*${offer.penaltyAmount > 0 ? ` (includes a ${offer.penaltyCurrency} ${offer.penaltyAmount.toLocaleString()} change fee)` : ''}.`
      : offer.changeTotalAmount < 0
        ? `This change actually gives you a refund of *${offer.changeTotalCurrency} ${Math.abs(offer.changeTotalAmount).toLocaleString()}*.`
        : `This change is *free* — no extra cost.`;

    pendingChanges.set(from, {
      ...pending,
      step: 'awaiting_change_confirmation',
      newDate,
      changeRequestId: result.changeRequestId,
      selectedOffer: offer,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });

    await whatsappService.sendText(phoneNumberId, from,
      `Here's what changing to *${newDate}* looks like:\n\n${costLine}\n\nReply *yes* to confirm, or *no* to cancel.`
    );
    return true;
  }

  async _handleChangeConfirmation({ phoneNumberId, from, text, pending }) {
    const answer = text.trim().toLowerCase();
    const isYes = /^(yes|yeah|y|ok|okay|confirm|proceed)$/i.test(answer);
    const isNo  = /^(no|nope|n|cancel|stop|decline)$/i.test(answer);

    if (!isYes && !isNo) {
      await whatsappService.sendText(phoneNumberId, from, `Please reply *yes* to confirm this change, or *no* to cancel.`);
      return true;
    }

    if (isNo) {
      pendingChanges.delete(from);
      await whatsappService.sendText(phoneNumberId, from, "Okay, no changes made to your booking.");
      return true;
    }

    const offer = pending.selectedOffer;

    // HONEST SCOPE LIMIT: no traveler-facing payment collection
    // exists yet for a change that costs MORE (would need its own
    // M-Pesa STK push flow, not yet built). Rather than silently pay
    // Duffel from Bodrless's own balance without ever collecting
    // that money from the traveler, this is flagged for manual
    // follow-up instead — same honest "not automated yet" posture
    // already used for cancellation refunds elsewhere in this
    // codebase.
    if (offer.changeTotalAmount > 0) {
      pendingChanges.delete(from);
      tracking.alert({
        type:     'flight_change_needs_payment',
        severity: 'warning',
        title:    `Flight change needs payment collection — ${pending.bookingRef}`,
        detail:   `Traveler confirmed a flight change to ${pending.newDate} costing ${offer.changeTotalCurrency} ${offer.changeTotalAmount}. Payment collection for flight changes isn't automated yet — manually collect payment then complete the change (offerId: ${offer.offerId}, changeRequestId: ${pending.changeRequestId}).`,
        context:  { bookingRef: pending.bookingRef, offer, newDate: pending.newDate },
        agencyId: pending.booking?.agency_id,
        bookingRef: pending.bookingRef,
      });
      await whatsappService.sendText(phoneNumberId, from,
        `Got it — this change costs *${offer.changeTotalCurrency} ${offer.changeTotalAmount.toLocaleString()}*. Our team will contact you shortly to collect payment and complete this change (this specific case isn't fully automated yet).`
      );
      return true;
    }

    await whatsappService.sendText(phoneNumberId, from, "Confirming this change with the airline now...");

    const result = await bookingService.confirmFlightChange({
      bookingRef: pending.bookingRef,
      offerId: offer.offerId,
      changeTotalAmount: offer.changeTotalAmount,
      changeTotalCurrency: offer.changeTotalCurrency,
    });

    pendingChanges.delete(from);

    if (!result.success) {
      await whatsappService.sendText(phoneNumberId, from, `Something went wrong confirming this change: ${result.error}`);
      return true;
    }

    const refundNote = result.changeTotalAmount < 0
      ? ` A refund of ${result.changeTotalCurrency} ${Math.abs(result.changeTotalAmount).toLocaleString()} will be processed by our team.`
      : '';
    await whatsappService.sendText(phoneNumberId, from,
      `✅ Done! Your flight has been changed to *${pending.newDate}*.${refundNote} You'll receive an updated confirmation shortly.`
    );
    return true;
  }

  // Same flexible date parser as whatsappBooking.js — duplicated
  // deliberately (not imported) to keep these two conversational
  // flows independent, rather than coupling them together for a
  // small shared utility.
  _parseFlexibleDate(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return this._isValidCalendarDate(text) ? text : null;
    }

    const MONTHS = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const monthNamePattern = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    const monthMatch = text.match(monthNamePattern);
    if (monthMatch) {
      const monthNum = MONTHS[monthMatch[1].slice(0, 3).toLowerCase()];
      const numbers = text.match(/\d{1,4}/g) || [];
      const yearCandidate = numbers.find(n => n.length === 4);
      const dayCandidate  = numbers.find(n => n !== yearCandidate && Number(n) >= 1 && Number(n) <= 31);
      if (monthNum && yearCandidate && dayCandidate) {
        const dateStr = `${yearCandidate}-${monthNum}-${String(dayCandidate).padStart(2, '0')}`;
        return this._isValidCalendarDate(dateStr) ? dateStr : null;
      }
      return null;
    }

    const numericMatch = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (numericMatch) {
      let [, a, b, year] = numericMatch;
      a = Number(a); b = Number(b);
      let day, month;
      if (a > 12 && b <= 12) { day = a; month = b; }
      else if (b > 12 && a <= 12) { day = b; month = a; }
      else { day = a; month = b; }
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return this._isValidCalendarDate(dateStr) ? dateStr : null;
    }

    return null;
  }

  _isValidCalendarDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) return false;
    const [y, m, day] = dateStr.split('-').map(Number);
    return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === day
      && y >= new Date().getFullYear();
  }
}

module.exports = new WhatsAppChangeFlow();