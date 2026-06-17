/**
 * TRIP ROUTES
 * ─────────────────────────────────────────────
 * Widget + WhatsApp + API Safe
 * Supports conversational follow-ups
 * Saves searches and bookings to Supabase
 *
 * BOOKING FLOW (flights):
 * 1. Validate the offer hasn't expired
 * 2. Call TravelDuqa selectOffer() to lock in fare rules
 * 3. Call TravelDuqa book() with real passenger details, paymentType: 'hold'
 * 4. Only mark Supabase as confirmed/hold if TravelDuqa actually succeeds —
 *    a failed supplier call now returns a real error to the client instead
 *    of silently pretending the booking worked.
 * ─────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const orchestrationEngine = require('../orchestration/engine');
const whatsappService = require('../services/whatsapp');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

let supplierAdapter = null;
try {
  supplierAdapter = require('../adapters');
} catch (e) {
  logger.warn('Supplier adapter not loaded in trips routes — bookings will fail for live suppliers', { error: e.message });
}

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

  const passengerSchema = Joi.object({
    firstName:    Joi.string().required(),
    lastName:     Joi.string().required(),
    dateOfBirth:  Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    gender:       Joi.string().valid('male', 'female').optional(),
    type:         Joi.string().valid('adult', 'child', 'infant').default('adult'),
  });

  const schema = Joi.object({
    packageIndex: Joi.number().optional(),
    agencyId:     Joi.string().optional(),
    guestName:    Joi.string().optional().default('Valued Guest'),
    guestPhone:   Joi.string().allow('', null).optional(),
    guestEmail:   Joi.string().allow('', null).optional(),
    passengers:   Joi.alternatives().try(
      Joi.number(),
      Joi.array().items(passengerSchema)
    ).optional().default(1),
    package: Joi.object().optional(),
    channel: Joi.string().optional().default('widget'),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  const bookingRef = `BDR-${Date.now()}`;
  const pkg        = value.package || {};
  const transport  = pkg.transport || {};
  const hotel      = pkg.hotel || {};
  const transfers  = pkg.transfers || {};
  const summary    = pkg.summary || {};

  const guestName        = value.guestName || 'Valued Guest';
  const passengerDetails = Array.isArray(value.passengers) ? value.passengers : null;
  const passengerCount   = passengerDetails ? passengerDetails.length : (value.passengers || summary.passengers || 1);
  const nights           = summary.nights || 0;
  const route            = summary.route || `${transport.origin || 'Origin'} to ${transport.destination || 'Destination'}`;
  const totalPrice       = summary.totalPrice || 0;
  const currency         = summary.currency || 'KES';
  const agencyId         = value.agencyId || 'epic-travels';

  logger.info('Booking initiated', { bookingRef, agencyId, flightSupplier: transport.supplier, hotelSupplier: hotel.supplier });

  const isFlightBooking = transport && transport.supplier === 'travelduqa';
  const isHotelBooking  = hotel && hotel.supplier === 'hotelbeds';

  let flightResult = null;
  let hotelResult  = null;
  let bookingStatus = 'confirmed';

  // ── Validate prerequisites before touching any supplier ──
  if (isFlightBooking || isHotelBooking) {
    if (!supplierAdapter) {
      logger.error('Booking failed — supplier adapter unavailable', { bookingRef });
      return res.status(503).json({
        success: false,
        error: 'Booking system is temporarily unavailable. Please try again shortly.',
      });
    }
    if (!passengerDetails || passengerDetails.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Passenger details are required to complete this booking.',
      });
    }
    if (!value.guestPhone) {
      return res.status(400).json({ success: false, error: 'Phone number is required.' });
    }
  }

  if (isFlightBooking && !value.guestEmail) {
    return res.status(400).json({ success: false, error: 'Email is required for flight bookings.' });
  }

  // ── Step 1: Flight booking (TravelDuqa) ──
  if (isFlightBooking) {
    if (transport.expiresAt && Date.now() > new Date(transport.expiresAt).getTime()) {
      logger.warn('Booking attempted on expired flight offer', { bookingRef, expiresAt: transport.expiresAt });
      return res.status(410).json({
        success: false,
        error: 'This flight offer has expired. Please search again for current prices.',
        code: 'OFFER_EXPIRED',
      });
    }

    try {
      await supplierAdapter.selectOffer({
        supplier: 'travelduqa',
        resultId: transport.resultId,
        offerId:  transport.offerId,
      });

      const passengersForBooking = passengerDetails.map((p, idx) => ({
        ...p,
        phone: idx === 0 ? value.guestPhone : undefined,
        email: idx === 0 ? value.guestEmail : undefined,
      }));

      flightResult = await supplierAdapter.book({
        supplier:          'travelduqa',
        resultId:          transport.resultId,
        offerId:           transport.offerId,
        passengerDetails:  passengersForBooking,
        totalAmount:       transport.price,
        currency:          transport.currency || 'KES',
        paymentType:       'hold',
        sendEticket:       false,
      });

      bookingStatus = 'hold';
      logger.info('TravelDuqa booking created', { bookingRef, supplierRef: flightResult?.supplierBookingReference });

    } catch (err) {
      const supplierMessage = err.response?.data?.message || err.message;
      logger.error('TravelDuqa booking failed', { bookingRef, error: supplierMessage });
      return res.status(502).json({
        success: false,
        error: `We couldn't confirm the flight with the airline (${supplierMessage}). No payment has been taken — please search again.`,
        code: 'SUPPLIER_BOOKING_FAILED',
      });
    }
  }

  // ── Step 2: Hotel booking (HotelBeds) ──
  // Only attempted after the flight succeeds (if both are present), so we
  // never end up with a paid/held hotel but a failed flight.
  if (isHotelBooking) {
    try {
      const leadGuest = { firstName: passengerDetails[0].firstName, lastName: passengerDetails[0].lastName };
      const guestsForHotel = passengerDetails.map((p, idx) => ({
        firstName: p.firstName,
        lastName:  p.lastName,
        type:      p.type === 'child' ? 'child' : 'adult',
        roomId:    1,
      }));

      hotelResult = await supplierAdapter.book({
        supplier:        'hotelbeds',
        rateKey:         hotel.rateKey,
        holder:          leadGuest,
        guests:          guestsForHotel,
        clientReference: bookingRef,
        remark:          `Booked via Bodrless for ${agencyId}`,
      });

      logger.info('HotelBeds booking created', { bookingRef, supplierRef: hotelResult?.supplierBookingReference });

    } catch (err) {
      const supplierMessage = err.response?.data?.message || err.message;
      logger.error('HotelBeds booking failed', { bookingRef, error: supplierMessage });

      // If the flight already succeeded, we have a real held seat that
      // exists with the airline — don't silently lose that. Surface a
      // partial-success response so the traveler and agency both know
      // the flight is secured but the hotel needs manual follow-up.
      if (flightResult) {
        try {
          await _saveBooking({
            bookingRef, agencyId, guestName,
            guestPhone: value.guestPhone || null,
            guestEmail: value.guestEmail || null,
            passengers: passengerCount, passengerDetails, nights, totalPrice, currency,
            destination: transport.destination || summary.destination || null,
            origin: transport.origin || summary.origin || null,
            channel: value.channel || 'widget',
            transport, hotel, transfers, summary,
            status: 'partial_flight_only',
            supplierBookingReference: flightResult?.supplierBookingReference || null,
            supplierOrderId: flightResult?.orderId || null,
          });
        } catch (saveErr) {
          logger.error('CRITICAL: flight booked, hotel failed, AND Supabase save failed', { bookingRef, error: saveErr.message });
        }

        return res.status(207).json({
          success: true,
          bookingRef,
          status: 'partial_flight_only',
          warning: `Your flight is held with the airline, but we couldn't confirm the hotel (${supplierMessage}). Our team will follow up to sort out accommodation.`,
        });
      }

      return res.status(502).json({
        success: false,
        error: `We couldn't confirm the hotel booking (${supplierMessage}). No payment has been taken — please search again.`,
        code: 'SUPPLIER_BOOKING_FAILED',
      });
    }
  }

  if (isFlightBooking && bookingStatus === 'confirmed') {
    bookingStatus = 'hold'; // flight legs always go through hold first in this version
  }
  if (isHotelBooking && hotelResult?.status === 'CONFIRMED' && !isFlightBooking) {
    bookingStatus = 'confirmed';
  }
  if (isFlightBooking && isHotelBooking) {
    bookingStatus = 'hold_flight_confirmed_hotel'; // flight held, hotel confirmed — distinct from pure hold
  }

  // ── Only persist to Supabase once we know the real outcome ──
  try {
    await _saveBooking({
      bookingRef,
      agencyId,
      guestName,
      guestPhone: value.guestPhone || null,
      guestEmail: value.guestEmail || null,
      passengers: passengerCount,
      passengerDetails,
      nights,
      totalPrice,
      currency,
      destination: transport.destination || summary.destination || null,
      origin: transport.origin || summary.origin || null,
      channel: value.channel || 'widget',
      transport,
      hotel,
      transfers,
      summary,
      status: bookingStatus,
      supplierBookingReference: flightResult?.supplierBookingReference || hotelResult?.supplierBookingReference || null,
      supplierOrderId: flightResult?.orderId || null,
      hotelSupplierReference: hotelResult?.supplierBookingReference || null,
    });
  } catch (err) {
    // A supplier booking succeeded but our own DB write failed — this is a
    // real seat hold / hotel confirmation that exists with the supplier even
    // though we couldn't record it. Surface this loudly rather than losing it.
    logger.error('CRITICAL: supplier booking succeeded but Supabase save failed', {
      bookingRef, error: err.message, flightResult, hotelResult,
    });
    return res.status(207).json({
      success: true,
      bookingRef,
      status: bookingStatus,
      warning: 'Booking was confirmed with the supplier but our records may be out of sync. Please contact support with your booking reference.',
    });
  }

  _sendMockNotifications({
    bookingRef,
    guestName,
    passengers: passengerCount,
    nights,
    route,
    totalPrice,
    currency,
    transport,
    hotel,
    transfers,
    agencyId,
    status: bookingStatus,
  }).catch(err => logger.error('Notification error', { error: err.message }));

  const statusMessages = {
    confirmed:                       'Booking confirmed! All parties have been notified.',
    hold:                             'Your seat has been held with the airline. We will be in touch to complete payment.',
    hold_flight_confirmed_hotel:      'Your flight seat is held with the airline and your hotel is confirmed. We will be in touch to complete flight payment.',
  };

  return res.json({
    success: true,
    bookingRef,
    status: bookingStatus,
    message: statusMessages[bookingStatus] || 'Booking received.',
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
async function _saveBooking({
  bookingRef, agencyId, guestName, guestPhone, guestEmail, passengers, passengerDetails,
  nights, totalPrice, currency, destination, origin, channel, transport, hotel, transfers,
  summary, status, supplierBookingReference, supplierOrderId, hotelSupplierReference,
}) {
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
    currency: currency || 'KES',
    status: status || 'confirmed',
    booking_status: status || 'confirmed',
    payment_status: 'pending',
    supplier_status: status || 'confirmed',
    supplier_booking_reference: supplierBookingReference,
    supplier_order_id: supplierOrderId,
    hotel_supplier_reference: hotelSupplierReference,
    channel,
    flight_details: transport || null,
    hotel_details: hotel || null,
    transfer_details: transfers || null,
    trip_params: summary || null,
  });

  if (passengerDetails && passengerDetails.length > 0) {
    const manifestRows = passengerDetails.map(p => ({
      booking_ref: bookingRef,
      agency_id: agencyId,
      first_name: p.firstName,
      last_name: p.lastName,
      date_of_birth: p.dateOfBirth || null,
      gender: p.gender || null,
      passenger_type: p.type || 'adult',
    }));
    await supabase.from('passenger_manifest').insert(manifestRows);
  }

  if (summary?.sessionId) {
    await supabase
      .from('trip_searches')
      .update({ converted: true })
      .eq('session_id', summary.sessionId);
  }
}


// ─────────────────────────────────────────────
// MOCK NOTIFICATIONS (agency-facing, via WhatsApp)
// ─────────────────────────────────────────────
async function _sendMockNotifications({ bookingRef, guestName, passengers, nights, route, totalPrice, currency, transport, hotel, transfers, agencyId, status }) {

  const phoneNumberId = MOCK_PHONE_NUMBER_ID;
  const to = MOCK_NOTIFY_NUMBER;

  if (!phoneNumberId) {
    logger.warn('WHATSAPP_PHONE_NUMBER_ID not set — skipping mock notifications');
    return;
  }

  const delay = ms => new Promise(r => setTimeout(r, ms));
  const cur = currency || 'KES';
  const statusLabel = status === 'hold' ? 'SEAT HELD (payment pending)' : 'CONFIRMED';

  await whatsappService.sendText(phoneNumberId, to,
    `*NEW BOOKING - ${bookingRef}*\n` +
    `Status: ${statusLabel}\n` +
    `---\n` +
    `Guest: ${guestName} (${passengers} pax)\n` +
    `Route: ${route}\n` +
    `Nights: ${nights}\n` +
    `Flight: ${transport.airline || 'TBC'} - ${transport.origin || ''} to ${transport.destination || ''}\n` +
    `Hotel: ${hotel.name || 'TBC'} - ${hotel.location || ''}\n` +
    `Transfer: ${transfers.provider || 'TBC'}\n` +
    `Total: ${cur} ${totalPrice.toLocaleString()}\n` +
    `Commission: ${cur} ${Math.round(totalPrice * 0.05).toLocaleString()}\n` +
    `---\n` +
    `[AGENCY NOTIFICATION - Bodrless]`
  );

  if (hotel.name) {
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
      `---\n` +
      `[HOTEL NOTIFICATION - Bodrless]`
    );
  }

  if (transfers.provider) {
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
  }

  logger.info('Mock notifications sent', { bookingRef, to });
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
      supplierBookingReference: data.supplier_booking_reference,
    });
  } catch (err) {
    logger.error('Booking status lookup failed', { error: err.message });
    return res.status(500).json({ error: 'Failed to fetch booking status' });
  }
});

module.exports = router;