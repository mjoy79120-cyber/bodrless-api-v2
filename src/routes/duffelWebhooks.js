/**
 * DUFFEL WEBHOOKS
 * ─────────────────────────────────────────────────────────────
 * Receives real-time notifications FROM Duffel — airline-initiated
 * schedule changes, order created/cancelled confirmations, payment
 * events, etc.
 *
 * SIGNATURE VERIFICATION: every webhook POST carries a
 * `Webhook-Signature` header shaped like `t=<timestamp>,v1=<hex>`.
 * The signature is HMAC-SHA256 of `${timestamp}.${rawBody}` using
 * the webhook secret (set as DUFFEL_WEBHOOK_SECRET in Render).
 *
 * RAW BODY: req.rawBody is populated by server.js's express.json
 * verify callback — required for HMAC verification.
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const tracking = require('../services/trackingService');

// Trip monitoring — lazy-loaded to avoid circular dependency issues
let _tripMonitoringService = null;
let _disruptionFlow = null;

const getTripMonitoring = () => {
  if (!_tripMonitoringService) {
    try { _tripMonitoringService = require('../services/tripMonitoringService'); } catch (e) {
      logger.warn('DuffelWebhook: tripMonitoringService not available', { error: e.message });
    }
  }
  return _tripMonitoringService;
};

const getDisruptionFlow = () => {
  if (!_disruptionFlow) {
    try { _disruptionFlow = require('../services/disruptionFlow'); } catch (e) {
      logger.warn('DuffelWebhook: disruptionFlow not available', { error: e.message });
    }
  }
  return _disruptionFlow;
};

// ─────────────────────────────────────────────
// SIGNATURE VERIFICATION
// ─────────────────────────────────────────────
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function verifyDuffelSignature(rawBody, signatureHeader) {
  const secret = process.env.DUFFEL_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('DUFFEL_WEBHOOK_SECRET not set — cannot verify any Duffel webhook, rejecting');
    return { valid: false, reason: 'not_configured' };
  }
  if (!signatureHeader) {
    return { valid: false, reason: 'missing_signature_header' };
  }

  const parts = Object.fromEntries(
    signatureHeader.split(',').map(kv => kv.split('=').map(s => s.trim()))
  );
  const timestamp = parts.t;
  const providedSignature = parts.v1;

  if (!timestamp || !providedSignature) {
    return { valid: false, reason: 'malformed_signature_header' };
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, reason: 'timestamp_too_old', ageSeconds };
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  const providedBuf = Buffer.from(providedSignature, 'hex');
  if (expectedBuf.length !== providedBuf.length) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  const isValid = crypto.timingSafeEqual(expectedBuf, providedBuf);

  return isValid ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}

// ─────────────────────────────────────────────
// WEBHOOK ENDPOINT
// ─────────────────────────────────────────────
router.post('/duffel', async (req, res) => {
  const rawBody = req.rawBody;
  const signatureHeader = req.headers['webhook-signature'];

  if (!rawBody) {
    logger.error('Duffel webhook: req.rawBody missing — raw-body middleware not wired in server.js');
    return res.status(500).send('Server misconfigured — cannot verify webhook.');
  }

  const verification = verifyDuffelSignature(rawBody, signatureHeader);
  if (!verification.valid) {
    logger.warn('Duffel webhook: signature verification failed', { reason: verification.reason });
    return res.status(401).send('Invalid signature.');
  }

  // Acknowledge immediately — Duffel retries on timeout
  res.status(200).send('OK');

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    logger.error('Duffel webhook: could not parse verified body as JSON', { error: err.message });
    return;
  }

  // Type: top-level first, then nested fallback per Duffel docs
  const eventType = event?.type
    || event?.data?.object?.type
    || null;

  const eventData = event?.data?.object || event?.data || null;

  logger.info('Duffel webhook received', { eventType, orderId: eventData?.id || eventData?.order_id });

  try {
    switch (eventType) {

      case 'order.airline_initiated_change_detected':
        await handleAirlineInitiatedChange(eventData);
        break;

      case 'order.flight_delay':
        await handleFlightDisruption(eventData, 'delay');
        break;

      case 'order.flight_cancelled':
        await handleFlightDisruption(eventData, 'cancellation');
        break;

      case 'order.cancelled':
        logger.info('Duffel webhook: order cancelled (informational)', { orderId: eventData?.id });
        break;

      case 'order.updated':
        logger.info('Duffel webhook: order updated (informational)', { orderId: eventData?.id });
        await _logToTripMonitoring(eventData, 'order_updated', 'info', 'Duffel order updated');
        break;

      case 'order.payment_succeeded':
      case 'payment.created':
        logger.info('Duffel webhook: payment event (informational)', { orderId: eventData?.order_id || eventData?.id });
        await _logToTripMonitoring(eventData, 'payment_confirmed', 'info', 'Payment confirmed by Duffel');
        break;

      default:
        logger.info('Duffel webhook: unhandled event type (informational only)', { eventType });
    }
  } catch (err) {
    logger.error('Duffel webhook: handler threw after acknowledging', { eventType, error: err.message });
  }
});

// ─────────────────────────────────────────────
// HANDLE FLIGHT DISRUPTION (delay / cancellation)
// Routes into trip monitoring disruptionFlow which handles:
//   - Searching alternative flights
//   - Sending WhatsApp options to traveler
//   - Notifying hotel and transfer of delay
//   - Executing Duffel order change when traveler picks an option
// Falls back to alert-only for pre-monitoring bookings.
// ─────────────────────────────────────────────
async function handleFlightDisruption(orderData, forcedDisruptionType) {
  const orderId = orderData?.id;
  if (!orderId) {
    logger.warn('Duffel webhook: disruption event with no order id');
    return;
  }

  const monitoring = getTripMonitoring();
  const flow = getDisruptionFlow();

  if (monitoring && flow) {
    const trip = await monitoring.getTripBySupplierOrder('duffel', orderId);
    if (trip) {
      // Build normalized disruption object matching flightStatusService shape
      const slices  = orderData?.slices  || [];
      const slice   = slices[0]          || {};
      const segment = slice.segments?.[0] || {};
      const carrier = segment.marketing_carrier || segment.operating_carrier || {};

      const delayMinutes = orderData?.changes?.find(
        c => c.type === 'flight_delay'
      )?.flight_delay_in_minutes || 0;

      const isCancelled = forcedDisruptionType === 'cancellation' || orderData?.status === 'cancelled';
      const isDelayed   = !isCancelled && delayMinutes >= 20;

      const disruption = {
        flightNumber:    segment.marketing_carrier_flight_number || trip.flight_number || null,
        airline:         carrier.name       || null,
        airlineCode:     carrier.iata_code  || null,
        status:          isCancelled ? 'Cancelled' : (isDelayed ? 'Delayed' : 'Changed'),
        rawStatus:       orderData?.status  || null,
        departure: {
          iata:          slice.origin?.iata_code      || null,
          scheduledTime: segment.departing_at         || null,
          revisedTime:   null,
          gate:          null,
        },
        arrival: {
          iata:          slice.destination?.iata_code || null,
          scheduledTime: segment.arriving_at          || null,
          revisedTime:   null,
        },
        delayMinutes,
        isDisrupted:     isCancelled || isDelayed,
        disruptionType:  forcedDisruptionType,
        isCancelled,
        isDiverted:      false,
        isDelayed,
        source:          'duffel_webhook',
        duffelOrderId:   orderId,
      };

      await flow.handleFlightDisruption(trip, disruption);
      return;
    }
  }

  // Fallback: not in monitoring system — alert only
  await _alertFallback(orderId, forcedDisruptionType);
}

// ─────────────────────────────────────────────
// HANDLE AIRLINE-INITIATED CHANGE
// Routes into disruption flow for monitored trips.
// Falls back to alert + WhatsApp for pre-monitoring bookings.
// ─────────────────────────────────────────────
async function handleAirlineInitiatedChange(orderData) {
  const orderId = orderData?.id;
  if (!orderId) {
    logger.warn('Duffel webhook: airline_initiated_change_detected with no order id');
    return;
  }

  // Try trip monitoring first
  const monitoring = getTripMonitoring();
  const flow = getDisruptionFlow();

  if (monitoring && flow) {
    const trip = await monitoring.getTripBySupplierOrder('duffel', orderId);
    if (trip) {
      await handleFlightDisruption(orderData, 'schedule_change');
      return;
    }
  }

  // Fallback: pre-monitoring booking — alert + WhatsApp traveler directly
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('supplier_order_id', orderId)
    .maybeSingle();

  if (error || !booking) {
    logger.warn('Duffel webhook: airline-initiated change for unknown order', {
      orderId, error: error?.message,
    });
    return;
  }

  tracking.alert({
    type:       'airline_initiated_change',
    severity:   'critical',
    title:      `Airline changed a booked flight — ${booking.booking_ref}`,
    detail:     `Duffel detected an airline-initiated change on order ${orderId} (booking ${booking.booking_ref}). Review in Duffel's dashboard and contact the traveler.`,
    context:    { bookingRef: booking.booking_ref, orderId },
    agencyId:   booking.agency_id,
    bookingRef: booking.booking_ref,
  });

  if (booking.guest_phone) {
    try {
      const whatsappService = require('../services/whatsapp');
      const { data: agency } = await supabase
        .from('agencies')
        .select('whatsapp_phone_number_id')
        .eq('id', booking.agency_id)
        .single();

      if (agency?.whatsapp_phone_number_id) {
        await whatsappService.sendText(
          agency.whatsapp_phone_number_id,
          booking.guest_phone,
          `We've been notified by the airline of a change affecting your flight for booking *${booking.booking_ref}*. Our team is reviewing this now and will contact you shortly with details and options.`
        );
      }
    } catch (err) {
      logger.error('Duffel webhook: could not notify traveler of airline-initiated change', {
        bookingRef: booking.booking_ref, error: err.message,
      });
    }
  }
}

// ─────────────────────────────────────────────
// LOG TO TRIP MONITORING
// For informational events — just appends to the event log.
// ─────────────────────────────────────────────
async function _logToTripMonitoring(orderData, eventType, severity, title) {
  const orderId = orderData?.id || orderData?.order_id;
  if (!orderId) return;

  const monitoring = getTripMonitoring();
  if (!monitoring) return;

  try {
    const trip = await monitoring.getTripBySupplierOrder('duffel', orderId);
    if (!trip) return;
    await monitoring.logEvent(trip.id, { event_type: eventType, severity, title, metadata: { orderId } });
  } catch (err) {
    logger.error('Duffel webhook: _logToTripMonitoring failed', { orderId, error: err.message });
  }
}

// ─────────────────────────────────────────────
// ALERT FALLBACK
// For bookings not yet in the monitoring system.
// ─────────────────────────────────────────────
async function _alertFallback(orderId, disruptionType) {
  const { data: booking } = await supabase
    .from('bookings')
    .select('booking_ref, agency_id, guest_phone')
    .eq('supplier_order_id', orderId)
    .maybeSingle();

  if (!booking) {
    logger.warn('Duffel webhook: no booking found for disruption alert fallback', { orderId });
    return;
  }

  tracking.alert({
    type:       `flight_${disruptionType}`,
    severity:   disruptionType === 'cancellation' ? 'critical' : 'warning',
    title:      `Flight ${disruptionType} detected — ${booking.booking_ref}`,
    detail:     `Duffel order ${orderId} has a ${disruptionType}. Check Duffel dashboard for details.`,
    context:    { orderId, bookingRef: booking.booking_ref },
    agencyId:   booking.agency_id,
    bookingRef: booking.booking_ref,
  });
}

module.exports = router;

/**
 * ═══════════════════════════════════════════════════════════
 * SERVER.JS WIRING
 * ═══════════════════════════════════════════════════════════
 * Mounted in server.js at:
 *   app.use('/api/webhooks', duffelWebhookRoutes);
 *
 * Live endpoint:  POST /api/webhooks/duffel
 * Register this URL in Duffel dashboard → Developers → Webhooks
 *
 * Mounted BEFORE the rate limiter so burst events are never 429'd.
 * ═══════════════════════════════════════════════════════════
 */