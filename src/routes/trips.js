/**
 * TRIP ROUTES
 * ─────────────────────────────────────────────
 * Widget + WhatsApp + API Safe
 * Supports conversational follow-ups
 * Saves searches and bookings to Supabase
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const orchestrationEngine = require('../orchestration/engine');
const whatsappService = require('../services/whatsapp');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

const MOCK_NOTIFY_NUMBER = '254716098296';
const MOCK_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

// ─────────────────────────────────────────────
// ORCHESTRATE
// ─────────────────────────────────────────────
router.post('/orchestrate', async (req, res) => {

  const schema = Joi.object({
    prompt: Joi.string().min(1).max(500).required(),
    agencyId: Joi.string().optional(),
    channelType: Joi.string().valid('whatsapp', 'widget', 'api').default('api'),
    sessionId: Joi.string().allow(null).optional(),
    conversationHistory: Joi.array().optional(),
    previousParams: Joi.object().allow(null).optional(),
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
    const resolvedAgencyId = value.agencyId || 'epic-travels';

    logger.info('Orchestration started', {
      agencyId: resolvedAgencyId,
      prompt: value.prompt
    });

    const result = await orchestrationEngine.orchestrate(
      value.prompt,
      resolvedAgencyId,
      {
        conversationHistory: value.conversationHistory || [],
        previousParams: value.previousParams || null,
      }
    );

    const packages = Array.isArray(result?.packages) ? result.packages : [];

    // Save search to Supabase — fire and forget
    _saveSearch({
      agencyId: resolvedAgencyId,
      sessionId: value.sessionId,
      prompt: value.prompt,
      tripParams: result?.tripParams,
      packagesReturned: packages.length,
      channel: value.channelType,
    }).catch(err => logger.error('Search save error', { error: err.message }));

    return res.json({
      success: true,
      sessionId: result?.sessionId || `sess_${Date.now()}`,
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
// BOOK
// ─────────────────────────────────────────────
router.post('/book', async (req, res) => {

  const schema = Joi.object({
    packageIndex: Joi.number().optional(),
    agencyId: Joi.string().optional(),
    guestName: Joi.string().optional().default('Valued Guest'),
    guestPhone: Joi.string().allow('', null).optional(),
    guestEmail: Joi.string().allow('', null).optional(),
    passengers: Joi.number().optional().default(1),
    package: Joi.object().optional(),
    channel: Joi.string().optional().default('widget'),
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
  const agencyId = value.agencyId || 'epic-travels';

  logger.info('Booking initiated', { bookingRef, agencyId });

  // Save booking to Supabase
  _saveBooking({
    bookingRef,
    agencyId,
    guestName,
    guestPhone: value.guestPhone || null,
    guestEmail: value.guestEmail || null,
    passengers,
    nights,
    totalPrice,
    destination: transport.destination || summary.destination || null,
    origin: transport.origin || summary.origin || null,
    channel: value.channel || 'widget',
    transport,
    hotel,
    transfers,
    summary,
  }).catch(err => logger.error('Booking save error', { error: err.message }));

  // Send notifications
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
    agencyId,
  }).catch(err => logger.error('Notification error', { error: err.message }));

  return res.json({
    success: true,
    bookingRef,
    message: 'Booking confirmed! All parties have been notified.',
    status: 'confirmed',
  });
});


// ─────────────────────────────────────────────
// SAVE SEARCH TO SUPABASE
// ─────────────────────────────────────────────
async function _saveSearch({ agencyId, sessionId, prompt, tripParams, packagesReturned, channel }) {
  await supabase.from('trip_searches').insert({
    agency_id: agencyId,
    session_id: sessionId || null,
    prompt,
    destination: tripParams?.destination || null,
    origin: tripParams?.origin || null,
    passengers: tripParams?.passengers || 1,
    budget: tripParams?.budget || null,
    nights: tripParams?.nights || null,
    packages_returned: packagesReturned,
    channel: channel || 'widget',
    converted: false,
  });
}


// ─────────────────────────────────────────────
// SAVE BOOKING TO SUPABASE
// ─────────────────────────────────────────────
async function _saveBooking({ bookingRef, agencyId, guestName, guestPhone, guestEmail, passengers, nights, totalPrice, destination, origin, channel, transport, hotel, transfers, summary }) {
  await supabase.from('bookings').insert({
    booking_ref: bookingRef,
    agency_id: agencyId,
    guest_name: guestName,
    guest_phone: guestPhone,
    guest_email: guestEmail,
    destination,
    origin,
    nights,
    passengers,
    total_price: totalPrice,
    currency: 'USD',
    status: 'confirmed',
    channel,
    flight_details: transport || null,
    hotel_details: hotel || null,
    transfer_details: transfers || null,
    trip_params: summary || null,
  });

  // Mark search as converted
  if (summary?.sessionId) {
    await supabase
      .from('trip_searches')
      .update({ converted: true })
      .eq('session_id', summary.sessionId);
  }
}


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
