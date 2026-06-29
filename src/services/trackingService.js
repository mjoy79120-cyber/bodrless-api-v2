/**
 * TRACKING SERVICE
 * ─────────────────────────────────────────────────────────────
 * Persists full conversation history and operational alerts.
 * Used by engine.js (conversation turns + LLM fallback alerts)
 * and bookingService.js (booking failure alerts).
 *
 * DESIGN PRINCIPLES:
 * - Every write is fire-and-forget. A tracking failure NEVER
 *   blocks or errors the main request — the traveler's experience
 *   is always the priority. Failures are logged but swallowed.
 * - Packages are stored as jsonb so you can replay exactly what
 *   was shown, including prices and rateKeys at that moment.
 * - Alerts write immediately, not batched — you want to know
 *   about a payment_stuck situation right away, not in 5 minutes.
 * ─────────────────────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

class TrackingService {

  // ─────────────────────────────
  // LOG CONVERSATION TURN
  // Call once per engine.orchestrate() response, after the result
  // is returned. Stores the user message, what the engine said,
  // the packages shown, and whether the LLM was used or fell back.
  //
  // Safe to call without awaiting — all writes are best-effort.
  // ─────────────────────────────
  logTurn({
    sessionId,
    agencyId,
    channel,
    phone = null,
    turnIndex = 0,
    userMessage,
    engineResponse,
    packagesCount = 0,
    needsClarification = false,
    degraded = false,
    tripParams = null,
    packages = null,
    bookingRef = null,
    converted = false,
    usedLLM = true,
    llmModel = null,
    llmError = null,
  }) {
    // Fire and forget — never await this
    this._writeTurn({
      sessionId, agencyId, channel, phone, turnIndex,
      userMessage, engineResponse, packagesCount,
      needsClarification, degraded, tripParams, packages,
      bookingRef, converted, usedLLM, llmModel, llmError,
    }).catch(err => logger.error('TrackingService: turn write failed', { error: err.message, sessionId }));
  }

  async _writeTurn({
    sessionId, agencyId, channel, phone, turnIndex,
    userMessage, engineResponse, packagesCount,
    needsClarification, degraded, tripParams, packages,
    bookingRef, converted, usedLLM, llmModel, llmError,
  }) {
    // Strip packages down to essentials for storage — we don't need
    // full supplier response payloads, just what was shown to the
    // traveler (price, hotel name, flight details, route).
    const packagesSummary = Array.isArray(packages)
      ? packages.slice(0, 4).map(p => ({
          packageId:     p.packageId,
          route:         p.summary?.route,
          totalPrice:    p.summary?.totalPrice,
          currency:      p.summary?.currency,
          nights:        p.summary?.nights,
          passengers:    p.summary?.passengers,
          hotelName:     p.hotel?.name || null,
          airline:       p.transport?.airline || null,
          destination:   p.transport?.destination || null,
          rateKey:       p.hotel?.rateKey || null,
        }))
      : null;

    await supabase.from('conversations').insert({
      id:                  uuidv4(),
      session_id:          sessionId,
      agency_id:           agencyId,
      channel:             channel || 'unknown',
      phone:               phone || null,
      turn_index:          turnIndex,
      user_message:        String(userMessage || '').slice(0, 2000),
      engine_response:     String(engineResponse || '').slice(0, 2000),
      packages_count:      packagesCount || 0,
      needs_clarification: needsClarification || false,
      degraded:            degraded || false,
      destination:         tripParams?.destination || null,
      origin:              tripParams?.origin || null,
      passengers:          tripParams?.passengers || null,
      children:            tripParams?.children || 0,
      nights:              tripParams?.nights || null,
      budget:              tripParams?.budget || null,
      trip_type:           tripParams?.tripType || null,
      used_llm:            usedLLM,
      llm_model:           llmModel || null,
      llm_error:           llmError ? String(llmError).slice(0, 500) : null,
      packages_shown:      packagesSummary,
      booking_ref:         bookingRef || null,
      converted:           converted || false,
      created_at:          new Date().toISOString(),
    });
  }

  // ─────────────────────────────
  // WRITE ALERT
  // Call when something operationally wrong happens. Severity:
  //   info     — notable but expected (LLM fallback once)
  //   warning  — needs watching (zero results, LLM down repeatedly)
  //   error    — a booking failed, supplier errored
  //   critical — payment stuck, flight held + hotel failed
  // ─────────────────────────────
  alert({
    type,
    severity = 'warning',
    title,
    detail = null,
    context = null,
    agencyId = null,
    sessionId = null,
    bookingRef = null,
    phone = null,
    channel = null,
  }) {
    this._writeAlert({
      type, severity, title, detail, context,
      agencyId, sessionId, bookingRef, phone, channel,
    }).catch(err => logger.error('TrackingService: alert write failed', { error: err.message, type }));
  }

  async _writeAlert({ type, severity, title, detail, context, agencyId, sessionId, bookingRef, phone, channel }) {
    await supabase.from('alerts').insert({
      id:          uuidv4(),
      agency_id:   agencyId  || null,
      session_id:  sessionId || null,
      booking_ref: bookingRef || null,
      phone:       phone     || null,
      channel:     channel   || null,
      type,
      severity,
      title:       String(title  || '').slice(0, 200),
      detail:      String(detail || '').slice(0, 1000),
      context:     context   || null,
      resolved:    false,
      created_at:  new Date().toISOString(),
    });
  }

  // ─────────────────────────────
  // MARK TURN AS CONVERTED
  // Called when a booking is confirmed — updates the conversation
  // turn that triggered the booking so converted=true and
  // booking_ref is set, letting you trace booking → conversation.
  // NOTE: bookings has no session_id column — the session lives
  // inside trip_params jsonb as trip_params->>'sessionId'.
  // We match on the conversations table directly using session_id
  // which we pass in from the result object.
  // ─────────────────────────────
  markConverted({ sessionId, bookingRef }) {
    if (!sessionId) return;
    supabase
      .from('conversations')
      .update({ converted: true, booking_ref: bookingRef })
      .eq('session_id', sessionId)
      .then(() => {})
      .catch(err => logger.error('TrackingService: markConverted failed', { error: err.message }));
  }

  // ─────────────────────────────
  // RESOLVE ALERT
  // Called from the admin dashboard when an alert is actioned.
  // ─────────────────────────────
  async resolveAlert(alertId, resolvedBy = 'admin') {
    const { error } = await supabase
      .from('alerts')
      .update({
        resolved:     true,
        resolved_at:  new Date().toISOString(),
        resolved_by:  resolvedBy,
      })
      .eq('id', alertId);

    if (error) throw error;
    return { success: true };
  }

  // ─────────────────────────────
  // CHECK FOR STUCK PAYMENTS
  // Call this on a cron/interval (every 5 minutes is fine).
  // Finds bookings in awaiting_payment for more than 30 minutes
  // and writes a critical alert if not already alerted.
  // Wire it in your server.js: setInterval(() => tracking.checkStuckPayments(), 5 * 60 * 1000)
  // ─────────────────────────────
  async checkStuckPayments() {
    try {
      const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const { data: stuck } = await supabase
        .from('bookings')
        .select('booking_ref,agency_id,guest_phone,total_price,currency,created_at,destination,channel')
        .eq('booking_stage', 'awaiting_payment')
        .lt('created_at', thirtyMinsAgo);

      if (!stuck || stuck.length === 0) return;

      // Only alert once per booking — check if we already have a payment_stuck alert for this ref
      for (const booking of stuck) {
        const { data: existing } = await supabase
          .from('alerts')
          .select('id')
          .eq('booking_ref', booking.booking_ref)
          .eq('type', 'payment_stuck')
          .maybeSingle();

        if (!existing) {
          const minutesStuck = Math.round((Date.now() - new Date(booking.created_at)) / 60000);
          this.alert({
            type:       'payment_stuck',
            severity:   'critical',
            title:      `Payment stuck for ${booking.destination || 'unknown destination'}`,
            detail:     `Booking ${booking.booking_ref} has been in awaiting_payment for ${minutesStuck} minutes. ${booking.currency} ${booking.total_price} uncharged.`,
            context:    { booking_ref: booking.booking_ref, minutes_stuck: minutesStuck, total_price: booking.total_price, currency: booking.currency },
            agencyId:   booking.agency_id,
            bookingRef: booking.booking_ref,
            phone:      booking.guest_phone,
            channel:    booking.channel,
          });
          logger.warn('Stuck payment detected', { bookingRef: booking.booking_ref, minutesStuck });
        }
      }
    } catch (err) {
      logger.error('checkStuckPayments failed', { error: err.message });
    }
  }
}

module.exports = new TrackingService();