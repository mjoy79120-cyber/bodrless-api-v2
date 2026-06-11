/**
 * BODRLESS PUBLIC API v1
 * ─────────────────────────────────────────────
 * Full-service endpoint for OTAs and partners
 *
 * What OTAs get:
 * - Trip orchestration (flights + hotels + transfers)
 * - AI prompt parsing (English, Swahili, any language)
 * - Their own inventory prioritized
 * - Bodrless inventory fills gaps
 * - Booking coordination
 * - Hotel + transfer + agency notifications
 * - Conversation context (follow-ups)
 * - Accessibility support
 * - Everything we add in future — automatically
 * ─────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const orchestrationEngine = require('../orchestration/engine');
const notificationService = require('../services/notifications');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// RESOLVE API KEY
// ─────────────────────────────────────────────
async function resolveApiKey(req) {
  const apiKey = req.headers['x-api-key'] ||
    req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) return null;

  const { data } = await supabase
    .from('agencies')
    .select('id, name, plan, status')
    .eq('api_key', apiKey)
    .single();

  if (!data || data.status !== 'active') return null;
  return data;
}

// ─────────────────────────────────────────────
// API DOCS
// GET /api/v1
// ─────────────────────────────────────────────
router.get('/', (req, res) => {
  res.json({
    name: 'Bodrless API',
    version: '1.0',
    description: 'Full-service trip planning and booking infrastructure',
    what_you_get: [
      'AI-powered prompt parsing (English, Swahili, any language)',
      'Trip package orchestration (flights + hotels + transfers)',
      'Your inventory prioritized — Bodrless fills gaps',
      'Booking coordination — hotel, transfer, agency all notified',
      'Conversational follow-ups — cheaper, different options, etc',
      'Accessibility support',
      'Real-time seat availability (Travler buses)',
      'Everything we add in future — automatically included',
    ],
    quick_start: {
      step1: 'POST /api/agencies/signup to get your API key',
      step2: 'Upload your inventory via dashboard or API',
      step3: 'POST /api/v1/search with your prompt',
      step4: 'POST /api/v1/book to confirm',
    },
    endpoints: {
      'GET /api/v1': 'This docs page',
      'POST /api/v1/search': 'Search for trip packages',
      'POST /api/v1/book': 'Book a package',
      'POST /api/v1/inventory/upload': 'Upload your inventory',
      'GET /api/v1/bookings': 'Get your bookings',
      'POST /api/v1/notify/delay': 'Trigger flight delay notifications',
    },
    authentication: 'Pass your API key as x-api-key header',
    contact: 'hello@bodrless.com',
  });
});


// ─────────────────────────────────────────────
// SEARCH
// POST /api/v1/search
// ─────────────────────────────────────────────
router.post('/search', async (req, res) => {

  const schema = Joi.object({
    // Natural language — easiest way
    prompt: Joi.string().max(500).optional(),

    // OR structured params
    origin: Joi.string().optional(),
    destination: Joi.string().optional(),
    departure_date: Joi.string().optional(),
    return_date: Joi.string().optional(),
    passengers: Joi.number().optional(),
    nights: Joi.number().optional(),
    budget: Joi.string().valid('low', 'mid', 'high', 'luxury').optional(),
    transport_mode: Joi.string().valid('flight', 'bus', 'train').optional(),
    seat_preference: Joi.string().optional(),
    meal_plan: Joi.string().optional(),
    accessibility: Joi.boolean().optional(),

    // Conversation context for follow-ups
    session_id: Joi.string().allow(null).optional(),
    conversation_history: Joi.array().optional(),
    previous_params: Joi.object().allow(null).optional(),

    max_results: Joi.number().max(10).default(4),
    currency: Joi.string().default('USD'),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    return res.status(400).json({
      success: false,
      error: error.details[0].message,
      code: 'VALIDATION_ERROR'
    });
  }

  const agency = await resolveApiKey(req);

  if (!agency) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or missing API key. Get yours at POST /api/agencies/signup',
      code: 'AUTH_REQUIRED'
    });
  }

  try {
    logger.info('OTA API search', { agencyId: agency.id, prompt: value.prompt });

    // Build prompt from structured params if no prompt
    let searchPrompt = value.prompt;

    if (!searchPrompt && value.destination) {
      const parts = [];
      if (value.origin) parts.push(`from ${value.origin}`);
      parts.push(`to ${value.destination}`);
      if (value.passengers) parts.push(`${value.passengers} people`);
      if (value.nights) parts.push(`${value.nights} nights`);
      if (value.budget) parts.push(`${value.budget} budget`);
      if (value.departure_date) parts.push(`on ${value.departure_date}`);
      if (value.transport_mode) parts.push(`by ${value.transport_mode}`);
      if (value.meal_plan) parts.push(value.meal_plan.replace('_', ' '));
      if (value.accessibility) parts.push('wheelchair accessible');
      searchPrompt = parts.join(' ');
    }

    if (!searchPrompt) {
      return res.status(400).json({
        success: false,
        error: 'Either prompt or destination is required',
        code: 'MISSING_PARAMS'
      });
    }

    const result = await orchestrationEngine.orchestrate(
      searchPrompt,
      agency.id,
      {
        conversationHistory: value.conversation_history || [],
        previousParams: value.previous_params || null,
      }
    );

    const packages = Array.isArray(result?.packages) ? result.packages : [];

    // Save search
    await supabase.from('trip_searches').insert({
      agency_id: agency.id,
      session_id: value.session_id || result.sessionId,
      prompt: searchPrompt,
      destination: result.tripParams?.destination || null,
      origin: result.tripParams?.origin || null,
      passengers: result.tripParams?.passengers || 1,
      budget: result.tripParams?.budget || null,
      nights: result.tripParams?.nights || null,
      packages_returned: packages.length,
      channel: 'api',
      converted: false,
    }).catch(() => {});

    return res.json({
      success: true,
      session_id: result.sessionId,
      agency: agency.name,
      packages: packages.slice(0, value.max_results).map(pkg => ({
        id: pkg.packageId,
        route: pkg.summary?.route,
        passengers: pkg.summary?.passengers,
        nights: pkg.summary?.nights,
        total_price: pkg.summary?.totalPrice,
        price_per_person: pkg.summary?.pricePerPerson,
        currency: value.currency,
        meal_plan: pkg.summary?.mealPlan || null,
        seat_preference: pkg.summary?.seatPreference || null,
        flight: pkg.transport?.airline ? {
          airline: pkg.transport.airline,
          flight_number: pkg.transport.flightNumber,
          origin: pkg.transport.origin,
          destination: pkg.transport.destination,
          departure_time: pkg.transport.departureTime,
          arrival_time: pkg.transport.arrivalTime,
          price: pkg.transport.price,
          seats: pkg.transport.seats || null,
          transport_type: pkg.transport.transportType || 'flight',
        } : null,
        hotel: pkg.hotel?.name ? {
          name: pkg.hotel.name,
          location: pkg.hotel.location,
          stars: pkg.hotel.stars,
          rating: pkg.hotel.rating,
          price_per_night: pkg.hotel.pricePerNight,
          meal_plan: pkg.hotel.mealPlan || null,
        } : null,
        transfer: pkg.transfers?.provider ? {
          provider: pkg.transfers.provider,
          vehicle_type: pkg.transfers.vehicleType,
          price: pkg.transfers.price,
        } : null,
        status: pkg.status,
      })),
      trip_params: result.tripParams,
      intent: result.intent || null,
      conversation_history: result.conversationHistory || [],
      generated_at: result.generatedAt,
    });

  } catch (err) {
    logger.error('OTA API search error', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Search failed',
      code: 'SERVER_ERROR'
    });
  }
});


// ─────────────────────────────────────────────
// BOOK
// POST /api/v1/book
// ─────────────────────────────────────────────
router.post('/book', async (req, res) => {

  const schema = Joi.object({
    package_id: Joi.string().optional(),
    guest_name: Joi.string().required(),
    guest_email: Joi.string().email().required(),
    guest_phone: Joi.string().required(),
    passengers: Joi.number().default(1),
    special_requests: Joi.string().allow('', null).optional(),
    package: Joi.object().optional(),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  const agency = await resolveApiKey(req);

  if (!agency) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  const bookingRef = `BDR-${Date.now()}`;
  const pkg = value.package || {};
  const transport = pkg.transport || {};
  const hotel = pkg.hotel || {};
  const transfers = pkg.transfers || {};
  const summary = pkg.summary || {};

  try {
    // Save booking
    await supabase.from('bookings').insert({
      booking_ref: bookingRef,
      agency_id: agency.id,
      guest_name: value.guest_name,
      guest_email: value.guest_email,
      guest_phone: value.guest_phone,
      passengers: value.passengers,
      total_price: summary.totalPrice || 0,
      destination: transport.destination || null,
      origin: transport.origin || null,
      nights: summary.nights || null,
      channel: 'api',
      flight_details: transport,
      hotel_details: hotel,
      transfer_details: transfers,
      trip_params: summary,
      status: 'confirmed',
      currency: 'USD',
    });

    // Fire coordination notifications
    notificationService.notifyBookingConfirmed({
      booking: {
        bookingRef,
        guestName: value.guest_name,
        guestPhone: value.guest_phone,
        passengers: value.passengers,
        agencyId: agency.id,
        totalPrice: summary.totalPrice || 0,
        checkIn: summary.departureDate || null,
        specialRequests: value.special_requests || 'None',
      },
      flight: transport.airline ? {
        flightNumber: transport.flightNumber,
        departureTime: transport.departureTime,
        arrivalTime: transport.arrivalTime,
        destination: transport.destination,
      } : null,
      hotel: hotel.name ? hotel : null,
      transfer: transfers.provider ? transfers : null,
    }).catch(err => logger.error('Notification error', { error: err.message }));

    return res.json({
      success: true,
      booking_ref: bookingRef,
      status: 'confirmed',
      message: 'Booking confirmed. Hotel, transfer and agency have been notified.',
      guest: {
        name: value.guest_name,
        email: value.guest_email,
        phone: value.guest_phone,
      },
    });

  } catch (err) {
    logger.error('OTA book error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// UPLOAD INVENTORY
// POST /api/v1/inventory/upload
// OTAs can upload their own inventory
// ─────────────────────────────────────────────
router.post('/inventory/upload', async (req, res) => {

  const agency = await resolveApiKey(req);
  if (!agency) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  const schema = Joi.object({
    type: Joi.string().valid('flight', 'hotel', 'transfer', 'bus').required(),
    items: Joi.array().min(1).required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  try {
    const table = value.type === 'hotel' ? 'hotels'
      : value.type === 'transfer' ? 'transfers'
      : 'flights';

    const records = value.items.map(item => ({
      ...item,
      agency_id: agency.id,
    }));

    const { error: insertError } = await supabase
      .from(table)
      .insert(records);

    if (insertError) throw insertError;

    return res.json({
      success: true,
      message: `${records.length} ${value.type}(s) uploaded successfully`,
      count: records.length,
    });

  } catch (err) {
    logger.error('Inventory upload error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// GET BOOKINGS
// GET /api/v1/bookings
// ─────────────────────────────────────────────
router.get('/bookings', async (req, res) => {

  const agency = await resolveApiKey(req);
  if (!agency) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  try {
    const { data } = await supabase
      .from('bookings')
      .select('*')
      .eq('agency_id', agency.id)
      .order('created_at', { ascending: false })
      .limit(100);

    return res.json({
      success: true,
      bookings: data || [],
      count: (data || []).length,
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// FLIGHT DELAY NOTIFICATION
// POST /api/v1/notify/delay
// OTA can trigger delay notifications for all parties
// ─────────────────────────────────────────────
router.post('/notify/delay', async (req, res) => {

  const agency = await resolveApiKey(req);
  if (!agency) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }

  const schema = Joi.object({
    booking_ref: Joi.string().required(),
    delay_minutes: Joi.number().required(),
    new_arrival_time: Joi.string().required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ success: false, error: error.details[0].message });
  }

  try {
    // Get booking details
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', value.booking_ref)
      .eq('agency_id', agency.id)
      .single();

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // Fire delay notifications to all parties
    await notificationService.notifyFlightDelay({
      booking: {
        bookingRef: booking.booking_ref,
        guestName: booking.guest_name,
        passengers: booking.passengers,
        agencyId: agency.id,
      },
      flight: booking.flight_details || {},
      hotel: booking.hotel_details || null,
      transfer: booking.transfer_details || null,
      delayMinutes: value.delay_minutes,
      newArrivalTime: value.new_arrival_time,
    });

    return res.json({
      success: true,
      message: `Delay notifications sent to hotel, transfer and traveler for booking ${value.booking_ref}`,
    });

  } catch (err) {
    logger.error('Delay notification error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;