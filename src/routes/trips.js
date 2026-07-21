/**
 * TRIP ROUTES
 * ─────────────────────────────────────────────
 * Widget + WhatsApp + API Safe
 * Supports conversational follow-ups
 * Saves searches and bookings to Supabase
 *
 * BOOKING FLOW v2 (flight-first, single combined payment):
 *   POST /book-init  -> hold flight (TravelDuqa) then confirm hotel
 *                        (HotelBeds, refundable rate only). No charge yet.
 *   POST /book-pay    -> stubbed M-Pesa trigger for now
 *   POST /book-confirm-payment -> simulates/receives payment success,
 *                        converts the flight hold into a ticketed booking
 *   POST /book-cancel -> simulates/receives payment failure, cancels the
 *                        hotel (refundable) and lets the flight hold expire
 *
 * All of the actual supplier orchestration lives in bookingService.js so
 * both the widget and the WhatsApp conversational flow share one
 * implementation rather than duplicating booking logic in two places.
 * ─────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const orchestrationEngine = require('../orchestration/engine');
const bookingService = require('../services/bookingService');
const whatsappService = require('../services/whatsapp');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

const MOCK_NOTIFY_NUMBER = '254716098296';
const MOCK_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';

// Demo/public-facing agency IDs that should be able to SEARCH (orchestrate)
// but never actually book — these API keys are visible in public-facing
// frontend code (e.g. the landing page playground), so booking must be
// blocked at the route level regardless of what the client sends.
const DEMO_ONLY_AGENCY_IDS = new Set(['bodrless-demo']);

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
    return res.json({ success: false, error: error.details[0].message, packages: [] });
  }

  try {
    const resolvedAgencyId = value.agencyId || 'epic-travels';

    logger.info('Orchestration started', { agencyId: resolvedAgencyId, prompt: value.prompt });

    const result = await orchestrationEngine.orchestrate(
      value.prompt,
      resolvedAgencyId,
      {
        conversationHistory: value.conversationHistory || [],
        previousParams: value.previousParams || null,
        channel: value.channelType || 'api',
      }
    );

    const packages = Array.isArray(result?.packages) ? result.packages : [];

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
      text: result?.text || null,
      packages: packages.slice(0, 4),
      tripParams: result?.tripParams || null,
      conversationHistory: result?.conversationHistory || [],
      intent: result?.intent || null,
      needsClarification: result?.needsClarification || false,
    });

  } catch (err) {
    logger.error('Orchestration fatal error', { error: err.message });
    return res.json({ success: false, error: err.message, packages: [] });
  }
});


// ─────────────────────────────────────────────
// BOOK — STEP 1: INIT (hold flight, confirm hotel)
// ─────────────────────────────────────────────
router.post('/book-init', async (req, res) => {

  const passengerSchema = Joi.object({
    firstName:   Joi.string().required(),
    lastName:    Joi.string().required(),
    dateOfBirth: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    gender:      Joi.string().valid('male', 'female').optional(),
    type:        Joi.string().valid('adult', 'child', 'infant').default('adult'),
    idNumber:    Joi.string().allow(null, '').optional(),
  }).custom((value, helpers) => {
    // Passport/ID required for all adult travelers, optional for children/infants
    if (value.type === 'adult' && !value.idNumber) {
      return helpers.error('any.required', { label: 'idNumber' });
    }
    return value;
  }, 'idNumber required for adults');

  const schema = Joi.object({
    agencyId:   Joi.string().optional(),
    guestName:  Joi.string().optional().default('Valued Guest'),
    guestPhone: Joi.string().allow('', null).optional(),
    guestEmail: Joi.string().allow('', null).optional(),
    passengers: Joi.array().items(passengerSchema).min(1).required(),
    package:    Joi.object().required(),
    channel:    Joi.string().optional().default('widget'),
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  // Block booking for demo/public-facing agency keys — these are visible
  // in published frontend code (e.g. the landing page playground) and
  // must only ever be able to search, never book.
  if (value.agencyId && DEMO_ONLY_AGENCY_IDS.has(value.agencyId)) {
    return res.status(403).json({
      success: false,
      error: 'This is a demo account for search only. Sign up for a real agency account to make bookings.',
      code: 'DEMO_ACCOUNT_BOOKING_BLOCKED',
    });
  }

  const bookingRef = `BDR-${Date.now()}`;
  const agencyId   = value.agencyId || 'epic-travels';

  logger.info('Booking init', { bookingRef, agencyId });

  const result = await bookingService.initBooking({
    bookingRef,
    agencyId,
    pkg: value.package,
    passengerDetails: value.passengers,
    guestName: value.guestName,
    guestPhone: value.guestPhone,
    guestEmail: value.guestEmail,
    channel: value.channel,
  });

  if (!result.success) {
    const statusCode = result.code === 'OFFER_EXPIRED' ? 410 : 502;
    return res.status(statusCode).json(result);
  }

  return res.json(result);
});


// ─────────────────────────────────────────────
// BOOK — STEP 2: TRIGGER PAYMENT (real IntaSend M-Pesa STK push)
// ─────────────────────────────────────────────
router.post('/book-pay', async (req, res) => {
  const schema = Joi.object({
    bookingRef: Joi.string().required(),
    phone:      Joi.string().required(),
    amount:     Joi.number().required(),
    currency:   Joi.string().default('KES'),
    email:      Joi.string().allow('', null).optional(),
    firstName:  Joi.string().allow('', null).optional(),
    lastName:   Joi.string().allow('', null).optional(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  const result = await bookingService.triggerPayment(value);
  if (!result.success) {
    return res.status(502).json(result);
  }
  return res.json(result);
});


// ─────────────────────────────────────────────
// BOOK — STEP 3: CONFIRM PAYMENT (manual for now, webhook later)
// ─────────────────────────────────────────────
router.post('/book-confirm-payment', async (req, res) => {
  const schema = Joi.object({ bookingRef: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  const result = await bookingService.confirmPayment(value);

  if (result.success) {
    _notifyBookingComplete(value.bookingRef).catch(err =>
      logger.error('Booking-complete notification failed', { error: err.message })
    );
  }

  return res.json(result);
});


// ─────────────────────────────────────────────
// BOOK — PAYMENT FAILED / CANCELLED
// ─────────────────────────────────────────────
router.post('/book-cancel', async (req, res) => {
  const schema = Joi.object({ bookingRef: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  const result = await bookingService.failPayment(value);
  return res.json(result);
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
// NOTIFY ON BOOKING COMPLETE (after payment confirmed)
// ─────────────────────────────────────────────
async function _notifyBookingComplete(bookingRef) {
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('booking_ref', bookingRef)
    .single();

  if (error || !booking) {
    logger.warn('Could not load booking for notification', { bookingRef });
    return;
  }

  const phoneNumberId = MOCK_PHONE_NUMBER_ID;
  const to = MOCK_NOTIFY_NUMBER;
  if (!phoneNumberId) {
    logger.warn('WHATSAPP_PHONE_NUMBER_ID not set — skipping booking-complete notification');
    return;
  }

  const transport = booking.flight_details || {};
  const hotel      = booking.hotel_details  || {};
  const transfers  = booking.transfer_details || {};
  const cur = booking.currency || 'KES';

  const delay = ms => new Promise(r => setTimeout(r, ms));

  await whatsappService.sendText(phoneNumberId, to,
    `*BOOKING PAID & CONFIRMED - ${bookingRef}*\n` +
    `---\n` +
    `Guest: ${booking.guest_name} (${booking.passengers} pax)\n` +
    `Route: ${booking.origin || 'TBC'} to ${booking.destination || 'TBC'}\n` +
    `Nights: ${booking.nights}\n` +
    `Flight: ${transport.airline || 'TBC'} - ${transport.origin || ''} to ${transport.destination || ''}\n` +
    `Hotel: ${hotel.name || 'TBC'} - ${hotel.location || ''}\n` +
    `Transfer: ${transfers.provider || 'TBC'}\n` +
    `Total: ${cur} ${(booking.total_price || 0).toLocaleString()}\n` +
    `Commission: ${cur} ${Math.round((booking.total_price || 0) * 0.05).toLocaleString()}\n` +
    `---\n` +
    `[AGENCY NOTIFICATION - Bodrless]`
  );

  if (hotel.name) {
    await delay(1000);
    await whatsappService.sendText(phoneNumberId, to,
      `*HOTEL BOOKING ALERT - ${bookingRef}*\n` +
      `---\n` +
      `To: ${hotel.name}\n` +
      `Guest: ${booking.guest_name}\n` +
      `Pax: ${booking.passengers}\n` +
      `Nights: ${booking.nights}\n` +
      `Location: ${hotel.location || 'TBC'}\n` +
      `Supplier ref: ${booking.hotel_supplier_reference || 'TBC'}\n` +
      `---\n` +
      `[HOTEL NOTIFICATION - Bodrless]`
    );
  }

  logger.info('Booking-complete notifications sent', { bookingRef, to });
}


// ─────────────────────────────────────────────
// BOOKING STATUS
// ─────────────────────────────────────────────
router.get('/booking/:bookingId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', req.params.bookingId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    return res.json({
      bookingId: data.booking_ref,
      status: data.status,
      bookingStage: data.booking_stage,
      supplierBookingReference: data.supplier_booking_reference,
      hotelSupplierReference: data.hotel_supplier_reference,
    });
  } catch (err) {
    logger.error('Booking status lookup failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch booking status' });
  }
});

module.exports = router;