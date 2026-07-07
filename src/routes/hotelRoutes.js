/**
 * HOTEL DIRECT API ROUTES — v2
 * ─────────────────────────────────────────────────────────────
 * Hotel groups are independent tenants — no agency_id.
 * Auth uses x-hotel-key header = hotel_groups.slug.
 *
 * Mount in server.js:
 *   const hotelRoutes = require('./routes/hotelRoutes');
 *   app.use('/api/hotel', hotelRoutes);
 *
 * Routes:
 *   POST /api/hotel/orchestrate          — room search
 *   POST /api/hotel/reserve              — create reservation
 *   POST /api/hotel/pay                  — trigger guest payment
 *   GET  /api/hotel/reservation/:ref     — get reservation
 *   POST /api/hotel/reservation/:ref/cancel
 *   POST /api/hotel/webhook/mpesa        — payment confirmation
 *   GET  /api/hotel/group/info           — group config for widget init
 * ─────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const hotelDirectBookingService = require('../services/hotelDirectBookingService');
const hotelDirectEngine         = require('../engine/hotelDirectEngine');

// ─────────────────────────────
// AUTH MIDDLEWARE
// x-hotel-key header = hotel_groups.slug
// Sets req.hotelGroup on success.
// ─────────────────────────────
async function requireHotelKey(req, res, next) {
  // Accept from header or body (widget sends in body for POST requests)
  const slug = req.headers['x-hotel-key'] || req.body?.groupSlug;

  if (!slug) {
    return res.status(401).json({ success: false, error: 'Hotel key required (x-hotel-key header).' });
  }

  const { data: group, error } = await supabase
    .from('hotel_groups')
    .select('id, name, slug, commission_rate, payment_type, is_active')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();

  if (error || !group) {
    return res.status(401).json({ success: false, error: 'Invalid hotel key.' });
  }

  req.hotelGroup = group;
  next();
}

// ─────────────────────────────
// GET /api/hotel/group/info
// Returns group config needed for widget initialisation.
// Called by the widget embed script on load.
// ─────────────────────────────
router.get('/group/info', requireHotelKey, (req, res) => {
  const g = req.hotelGroup;
  res.json({
    success:      true,
    name:         g.name,
    slug:         g.slug,
    paymentType:  g.payment_type,
  });
});

// ─────────────────────────────
// POST /api/hotel/orchestrate
// Room search — passes groupSlug to the engine, not agencyId.
// ─────────────────────────────
router.post('/orchestrate', requireHotelKey, async (req, res) => {
  try {
    const { prompt, conversationHistory, previousParams } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required.' });
    }

    const result = await hotelDirectEngine.orchestrate(
      prompt,
      req.hotelGroup.slug,   // groupSlug — replaces agencyId
      {
        conversationHistory: conversationHistory || [],
        previousParams:      previousParams      || null,
      }
    );

    logger.info('Hotel orchestrate', {
      groupSlug:  req.hotelGroup.slug,
      packages:   result.packages?.length || 0,
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel orchestrate API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Search failed. Please try again.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/reserve
// Create a reservation. groupSlug comes from the authenticated key.
// ─────────────────────────────
router.post('/reserve', requireHotelKey, async (req, res) => {
  try {
    const {
      pkg,
      selectedAncillaries,
      guestName,
      guestPhone,
      guestEmail,
      specialRequests,
      channel,
    } = req.body;

    if (!pkg || !guestName || !guestPhone) {
      return res.status(400).json({
        success: false,
        error: 'pkg, guestName, and guestPhone are required.',
      });
    }

    const result = await hotelDirectBookingService.createReservation({
      pkg,
      selectedAncillaries: selectedAncillaries || [],
      guestName,
      guestPhone,
      guestEmail,
      specialRequests,
      channel:  channel || 'widget',
      groupId:  req.hotelGroup.id,   // passed explicitly so service doesn't re-fetch
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Hotel reservation created', {
      reservationRef: result.reservationRef,
      groupSlug:      req.hotelGroup.slug,
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel reserve API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/pay
// Trigger payment for a reservation.
// ─────────────────────────────
router.post('/pay', requireHotelKey, async (req, res) => {
  try {
    const { reservationRef, guestPhone, paymentMethod } = req.body;

    if (!reservationRef) {
      return res.status(400).json({ success: false, error: 'reservationRef is required.' });
    }

    const result = await hotelDirectBookingService.triggerGuestPayment({
      reservationRef,
      guestPhone,
      paymentMethod, // 'mpesa' or 'card' — guest chose if hotel supports both
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel pay API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Payment initiation failed.' });
  }
});

// ─────────────────────────────
// GET /api/hotel/reservation/:ref
// Reservation status — widget polls this after payment.
// ─────────────────────────────
router.get('/reservation/:ref', requireHotelKey, async (req, res) => {
  try {
    const reservation = await hotelDirectBookingService.getReservation(req.params.ref);

    if (!reservation) {
      return res.status(404).json({ success: false, error: 'Reservation not found.' });
    }

    // Security: only return reservations belonging to this hotel group
    if (reservation.group_id !== req.hotelGroup.id) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    return res.json({ success: true, reservation });

  } catch (err) {
    logger.error('Hotel reservation fetch error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not fetch reservation.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/reservation/:ref/cancel
// ─────────────────────────────
router.post('/reservation/:ref/cancel', requireHotelKey, async (req, res) => {
  try {
    const result = await hotelDirectBookingService.cancelReservation({
      reservationRef: req.params.ref,
      reason:         req.body.reason      || 'Cancelled via API',
      cancelledBy:    req.body.cancelledBy || 'guest',
    });
    return res.json(result);
  } catch (err) {
    logger.error('Hotel cancel API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Cancellation failed.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/webhook/mpesa
// IntaSend M-Pesa webhook — no auth header needed (IntaSend calls this).
// Looks up reservation by api_ref = reservationRef.
// ─────────────────────────────
router.post('/webhook/mpesa', async (req, res) => {
  try {
    const payload = req.body;
    logger.info('Hotel M-Pesa webhook', { state: payload.state, api_ref: payload.api_ref });

    if (payload.state !== 'COMPLETE') {
      return res.json({ received: true });
    }

    const reservationRef   = payload.api_ref;
    const paymentReference = payload.invoice_id || payload.receipt_number || null;

    if (!reservationRef?.startsWith('HTL-')) {
      logger.warn('Hotel M-Pesa webhook: unrecognized api_ref', { api_ref: reservationRef });
      return res.json({ received: true });
    }

    const result = await hotelDirectBookingService.markPaid({
      reservationRef,
      paymentReference,
      markedBy: 'mpesa_webhook',
    });

    logger.info('Hotel M-Pesa webhook processed', {
      reservationRef,
      success: result.success,
    });

    return res.json({ received: true });

  } catch (err) {
    logger.error('Hotel M-Pesa webhook error', { error: err.message });
    return res.status(200).json({ received: true }); // always 200 to IntaSend
  }
});

module.exports = router;