/**
 * DUFFEL WEBHOOKS
 * ─────────────────────────────────────────────────────────────
 * Receives real-time notifications FROM Duffel — airline-initiated
 * schedule changes, order created/cancelled confirmations, payment
 * events, etc. This is the reactive counterpart to everything else
 * built for Duffel this session (booking, cancel, change), which are
 * all things BODRLESS initiates on demand. This route instead
 * receives events Duffel pushes to us.
 *
 * SIGNATURE VERIFICATION (real scheme confirmed from Duffel's docs,
 * 2026-07-03): every webhook POST carries a `Webhook-Signature`
 * header shaped like `t=<timestamp>,v1=<hex signature>`. The
 * signature is an HMAC-SHA256 of the string `${timestamp}.${rawBody}`
 * using the webhook's own secret (generated when the webhook is
 * created in Duffel's dashboard/API — NOT the same as
 * DUFFEL_ACCESS_TOKEN). Never process a webhook body without
 * verifying this first — an unverified endpoint would let anyone
 * POST a fake "your flight was cancelled" event.
 *
 * *** RAW BODY REQUIREMENT — WIRED IN SERVER.JS ***
 * Signature verification needs the RAW, exact request body bytes —
 * not a re-stringified version of Express's parsed body. server.js
 * handles this via the `verify` callback on the global JSON parser:
 *
 *   app.use(express.json({
 *     verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
 *   }));
 *
 * So req.rawBody is the exact UTF-8 bytes Duffel signed, while
 * req.body remains parsed JSON for every other route, unchanged.
 * If req.rawBody is ever missing here, the endpoint fails loudly
 * with a 500 (see below) rather than silently accepting anything.
 *
 * Set DUFFEL_WEBHOOK_SECRET in Render env vars (from creating the
 * webhook in Duffel's dashboard — a real value, not invented).
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const tracking = require('../services/trackingService');
const notificationService = require('../services/notifications');

// ─────────────────────────────────────────────
// SIGNATURE VERIFICATION
// ─────────────────────────────────────────────
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60; // reject anything older than 5 minutes — replay-attack protection

function verifyDuffelSignature(rawBody, signatureHeader) {
  const secret = process.env.DUFFEL_WEBHOOK_SECRET;
  if (!secret) {
    logger.error('DUFFEL_WEBHOOK_SECRET not set — cannot verify any Duffel webhook, rejecting');
    return { valid: false, reason: 'not_configured' };
  }
  if (!signatureHeader) {
    return { valid: false, reason: 'missing_signature_header' };
  }

  // Header shape: "t=1699999999,v1=abcdef123..."
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

  // Constant-time comparison — a plain === check here would leak
  // timing information an attacker could use to guess the signature
  // byte-by-byte. Both buffers must be equal length for
  // timingSafeEqual, so a length mismatch is checked first (and is
  // itself just "invalid", not a crash).
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
// req.rawBody is populated by server.js's express.json verify
// callback (see file header) — this is NOT the default Express
// behavior, so the missing-rawBody guard below stays as a tripwire.
// ─────────────────────────────────────────────
router.post('/duffel', async (req, res) => {
  const rawBody = req.rawBody;
  const signatureHeader = req.headers['webhook-signature'];

  if (!rawBody) {
    logger.error('Duffel webhook: req.rawBody is missing — raw-body middleware is not wired correctly in server.js. Rejecting for safety.');
    return res.status(500).send('Server misconfigured — cannot verify webhook.');
  }

  const verification = verifyDuffelSignature(rawBody, signatureHeader);
  if (!verification.valid) {
    logger.warn('Duffel webhook: signature verification failed — rejecting', { reason: verification.reason });
    return res.status(401).send('Invalid signature.');
  }

  // Acknowledge immediately — Duffel expects a fast 200 response and
  // will retry on failure/timeout. Real handling happens after
  // responding so a slow lookup/notification never risks a
  // duplicate delivery from Duffel's own retry logic.
  res.status(200).send('OK');

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    logger.error('Duffel webhook: could not parse verified body as JSON', { error: err.message });
    return;
  }

  const eventType = event?.data?.object?.type || event?.type || null;
  const eventData = event?.data?.object || event?.data || null;

  logger.info('Duffel webhook received', { eventType, orderId: eventData?.id || eventData?.order_id });

  try {
    switch (eventType) {
      case 'order.airline_initiated_change_detected':
        await handleAirlineInitiatedChange(eventData);
        break;

      case 'order.cancelled':
        logger.info('Duffel webhook: order cancelled (informational)', { orderId: eventData?.id });
        break;

      case 'payment.created':
        logger.info('Duffel webhook: payment created (informational)', { orderId: eventData?.order_id });
        break;

      default:
        // Any event type not explicitly handled is logged, not
        // silently dropped — useful for noticing new event types
        // Duffel adds later without us realizing.
        logger.info('Duffel webhook: unhandled event type (informational only)', { eventType });
    }
  } catch (err) {
    // Never let a handler error surface as a failed webhook response
    // — we already sent 200 above. Log loudly instead so it's caught
    // in monitoring rather than silently triggering Duffel retries
    // for a duplicate root cause.
    logger.error('Duffel webhook: handler threw after acknowledging', { eventType, error: err.message });
  }
});

// ─────────────────────────────────────────────
// HANDLE AIRLINE-INITIATED CHANGE
// The airline changed something about a flight someone already
// booked (schedule shift, cancellation, etc.) — Bodrless didn't
// initiate this. Find which real booking this belongs to and raise
// a clear, actionable alert; also let the traveler know directly
// rather than leaving them to discover it themselves.
//
// NOT YET BUILT: automatically rebooking/resolving the change on
// the traveler's behalf — that needs its own real Duffel endpoint
// (likely accepting/rejecting the airline's proposed change) which
// hasn't been confirmed via documentation yet. For now this
// surfaces the change clearly for manual handling, rather than
// guessing at an automated resolution.
// ─────────────────────────────────────────────
async function handleAirlineInitiatedChange(orderData) {
  const orderId = orderData?.id;
  if (!orderId) {
    logger.warn('Duffel webhook: airline_initiated_change_detected with no order id');
    return;
  }

  const { data: booking, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('supplier_order_id', orderId)
    .maybeSingle();

  if (error || !booking) {
    logger.warn('Duffel webhook: airline-initiated change for an order we have no matching booking for', { orderId, error: error?.message });
    return;
  }

  tracking.alert({
    type:     'airline_initiated_change',
    severity: 'critical',
    title:    `Airline changed a booked flight — ${booking.booking_ref}`,
    detail:   `Duffel detected an airline-initiated change on order ${orderId} (booking ${booking.booking_ref}). This was NOT something Bodrless requested. Review the order in Duffel's dashboard and contact the traveler with next steps — automated resolution isn't built yet.`,
    context:  { bookingRef: booking.booking_ref, orderId },
    agencyId: booking.agency_id,
    bookingRef: booking.booking_ref,
  });

  // Let the traveler know directly and promptly — never leave them
  // to find out from the airline first with no context from us.
  if (booking.guest_phone) {
    try {
      const whatsappService = require('../services/whatsapp');
      const agency = await supabase.from('agencies').select('whatsapp_phone_number_id').eq('id', booking.agency_id).single();
      if (agency?.data?.whatsapp_phone_number_id) {
        await whatsappService.sendText(
          agency.data.whatsapp_phone_number_id,
          booking.guest_phone,
          `We've been notified by the airline of a change affecting your flight for booking *${booking.booking_ref}*. Our team is reviewing this now and will contact you shortly with details and options.`
        );
      }
    } catch (err) {
      logger.error('Duffel webhook: could not notify traveler of airline-initiated change', { bookingRef: booking.booking_ref, error: err.message });
    }
  }
}

module.exports = router;

/**
 * ═══════════════════════════════════════════════════════════
 * SERVER.JS WIRING — DONE (2026-07-04)
 * ═══════════════════════════════════════════════════════════
 * This route is mounted in server.js at:
 *
 *   app.use('/api/webhooks', duffelWebhookRoutes);
 *
 * giving the live endpoint:  POST /api/webhooks/duffel
 * (this is the URL to register in Duffel's dashboard)
 *
 * Raw body capture is handled globally via the `verify` callback
 * on express.json() in server.js (see file header) — no separate
 * express.raw() mount is needed, and adding one would be redundant.
 *
 * The webhook routes are deliberately mounted BEFORE the /api/
 * rate limiter in server.js, so a burst of airline-initiated
 * change events (e.g. a mass disruption) can never be dropped
 * with a 429. Authentication is the HMAC signature check above,
 * not the rate limiter.
 * ═══════════════════════════════════════════════════════════
 */