/**
 * TRIP ROUTES
 * ─────────────────────────────────────────────
 * Widget + WhatsApp + API Safe
 * Supports conversational follow-ups
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const orchestrationEngine = require('../orchestration/engine');
const whatsappService = require('../services/whatsapp');
const { logger } = require('../utils/logger');

const MOCK_NOTIFY_NUMBER = '254716098296';
const MOCK_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

// ─────────────────────────────────────────────
// ORCHESTRATE
// ─────────────────────────────────────────────
router.post('/orchestrate', async (req, res) => {

  const schema = Joi.object({
    prompt: Joi.string().min(1).max(500).required(),
    agencyId: Joi.string().default('accessible-travel'),
    channelType: Joi.string().valid('whatsapp', 'widget', 'api').default('api'),
    sessionId: Joi.string().optional(),
    conversationHistory: Joi.array().optional(),
    previousParams: Joi.object().optional(),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    return res.json({
      success: false,
      error: error.details[0].message,
      packages: []
    });
  }

 try {
  const resolvedAgencyId = value.agencyId || 'accessible-travel';

  logger.info('Orchestration started', {
    agencyId: resolvedAgencyId,
    prompt: value.prompt
  });

  console.log("=================================");
  console.log("ORCHESTRATE REQUEST RECEIVED");
  console.log("PROMPT:", value.prompt);
  console.log("AGENCY:", resolvedAgencyId);
  console.log("SESSION:", value.sessionId);
  console.log("=================================");

  const result = await orchestrationEngine.orchestrate(
    value.prompt,
    resolvedAgencyId,
    value.sessionId || null
  );

  console.log("=================================");
  console.log("ENGINE RESULT");
  console.log("PACKAGES:", result?.packages?.length || 0);
  console.log(
    "TRIP PARAMS:",
    JSON.stringify(result?.tripParams, null, 2)
  );
  console.log("=================================");

    const packages = Array.isArray(result?.packages) ? result.packages : [];

    console.log("PACKAGES FOUND:", packages.length);

if (packages.length > 0) {
  console.log(
    "FIRST PACKAGE:",
    JSON.stringify(packages[0], null, 2)
  );
}

    return res.json({
  success: true,
  sessionId: result?.sessionId || `sess_${Date.now()}`,
  text: result?.text || '',
  packages: packages.slice(0, 4),
  tripParams: result?.tripParams || null,
  conversationHistory: result?.conversationHistory || [],
  intent: result?.intent || null,
});
  } catch (err) {
    logger.error('Orchestration fatal error', { error: err.message });
    return res.json({
      success: false,
      error: err.message,
      packages: []
    });
  }
});


// ─────────────────────────────────────────────
// BOOK — with mock coordination notifications
// ─────────────────────────────────────────────
router.post('/book', async (req, res) => {

  const schema = Joi.object({
    packageIndex: Joi.number().optional(),
    agencyId: Joi.string().optional(),
    guestName: Joi.string().optional().default('Valued Guest'),
    guestPhone: Joi.string().optional(),
    passengers: Joi.number().optional().default(1),
    package: Joi.object().optional(),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    return res.json({ success: false, error: error.details[0].message });
  }

  const bookingRef = `BDR-${Date.now()}`;
  const pkg = value.package || {};
  const transport = pkg.transport || {};
  const hotel = pkg.hotel || {};
  const transfers = pkg.transfers || {};
  const summary = pkg.summary || {};

  const guestName = value.guestName || 'Valued Guest';
  const passengers = value.passengers || summary.passengers || 1;
  const nights = summary.nights || 3;
  const route = summary.route || `${transport.origin || 'Origin'} to ${transport.destination || 'Destination'}`;
  const totalPrice = summary.totalPrice || 0;

  logger.info('Booking initiated', { bookingRef, agencyId: value.agencyId });

  _sendMockNotifications({
    bookingRef,
    guestName,
    passengers,
    nights,
    route,
    totalPrice,
    transport,
    hotel,
    transfers,
    agencyId: value.agencyId || 'accessible-travel',
  }).catch(err => logger.error('Notification error', { error: err.message }));

  return res.json({
    success: true,
    bookingRef,
    message: 'Booking confirmed! All parties have been notified.',
    status: 'confirmed',
  });
});


// ─────────────────────────────────────────────
// MOCK NOTIFICATIONS
// ─────────────────────────────────────────────
async function _sendMockNotifications({ bookingRef, guestName, passengers, nights, route, totalPrice, transport, hotel, transfers, agencyId }) {

  const phoneNumberId = MOCK_PHONE_NUMBER_ID;
  const to = MOCK_NOTIFY_NUMBER;

  if (!phoneNumberId) {
    logger.warn('WHATSAPP_PHONE_NUMBER_ID not set — skipping mock notifications');
    return;
  }

  const delay = ms => new Promise(r => setTimeout(r, ms));

  await whatsappService.sendText(phoneNumberId, to,
    `*NEW BOOKING - ${bookingRef}*\n` +
    `---\n` +
    `Guest: ${guestName} (${passengers} pax)\n` +
    `Route: ${route}\n` +
    `Nights: ${nights}\n` +
    `Flight: ${transport.airline || 'TBC'} - ${transport.origin || ''} to ${transport.destination || ''}\n` +
    `Hotel: ${hotel.name || 'TBC'} - ${hotel.location || ''}\n` +
    `Transfer: ${transfers.provider || 'TBC'}\n` +
    `Total: $${totalPrice}\n` +
    `Commission: $${Math.round(totalPrice * 0.05)}\n` +
    `---\n` +
    `[AGENCY NOTIFICATION - Bodrless]`
  );

  await delay(1000);

  await whatsappService.sendText(phoneNumberId, to,
    `*HOTEL BOOKING ALERT - ${bookingRef}*\n` +
    `---\n` +
    `To: ${hotel.name || 'Hotel'}\n` +
    `Guest: ${guestName}\n` +
    `Pax: ${passengers}\n` +
    `Arrival flight: ${transport.airline || 'TBC'} ${transport.flightNumber || ''}\n` +
    `Arrival time: ${transport.arrivalTime || 'TBC'}\n` +
    `Nights: ${nights}\n` +
    `Location: ${hotel.location || 'TBC'}\n` +
    `Special requests: None\n` +
    `---\n` +
    `[HOTEL NOTIFICATION - Bodrless]`
  );

  await delay(1000);

  await whatsappService.sendText(phoneNumberId, to,
    `*TRANSFER BOOKING ALERT - ${bookingRef}*\n` +
    `---\n` +
    `To: ${transfers.provider || 'Transfer Provider'}\n` +
    `Guest: ${guestName}\n` +
    `Pax: ${passengers}\n` +
    `Flight: ${transport.airline || 'TBC'} ${transport.flightNumber || ''}\n` +
    `Pickup: ${transport.destination || 'TBC'} Airport\n` +
    `Pickup time: ${transport.arrivalTime || 'TBC'}\n` +
    `Drop-off: ${hotel.name || 'TBC'} - ${hotel.location || 'TBC'}\n` +
    `Vehicle: ${transfers.vehicleType || 'Car'}\n` +
    `---\n` +
    `[TRANSFER NOTIFICATION - Bodrless]`
  );

  logger.info('Mock notifications sent', { bookingRef, to });
}


// ─────────────────────────────────────────────
// BOOKING STATUS
// ─────────────────────────────────────────────
router.get('/booking/:bookingId', async (req, res) => {
  return res.json({
    bookingId: req.params.bookingId,
    status: 'confirmed'
  });
});

module.exports = router;
