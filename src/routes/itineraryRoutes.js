/**
 * ITINERARY ROUTES
 * ─────────────────────────────────────────────────────────────
 * Endpoints called by the widget to persist leg-flow state
 * cross-channel (widget ↔ WhatsApp via phone number).
 *
 * Mount in server.js:
 *   const itineraryRoutes = require('./routes/itineraryRoutes');
 *   app.use('/api/trips/itinerary', itineraryRoutes);
 */

const express = require('express');
const router  = express.Router();
const pendingItinerary = require('../services/pendingItineraryService');
const { logger } = require('../utils/logger');

// ── Auth helper — same x-api-key pattern as trips routes ─────
function getAgencyId(req) {
  return req.headers['x-api-key'] || req.body?.agencyId || null;
}

// ─────────────────────────────────────────────────────────────
// POST /api/trips/itinerary/save
// Called after every leg selection to persist state.
// Returns itineraryId (new or existing).
// ─────────────────────────────────────────────────────────────
router.post('/save', async (req, res) => {
  try {
    const agencyId = getAgencyId(req);
    if (!agencyId) return res.status(401).json({ success: false, error: 'Missing agency key' });

    const {
      itineraryId,
      sessionId,
      channel   = 'widget',
      tripParams,
      legFlow,
      status    = 'active',
      bookedLegs  = [],
      pendingLegs = [],
      priceSnapshot = {},
    } = req.body;

    const id = await pendingItinerary.save({
      itineraryId:   itineraryId || null,
      agencyId,
      sessionId:     sessionId  || null,
      channel,
      tripParams:    tripParams  || null,
      legFlow:       legFlow     || null,
      status,
      bookedLegs,
      pendingLegs,
      priceSnapshot,
    });

    if (!id) return res.status(500).json({ success: false, error: 'Failed to save itinerary' });

    res.json({ success: true, itineraryId: id });
  } catch (err) {
    logger.error('itineraryRoutes /save error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/trips/itinerary/:id/attach-phone
// Called when traveler provides phone at booking time.
// Links widget session to phone so WhatsApp can restore state.
// ─────────────────────────────────────────────────────────────
router.post('/:id/attach-phone', async (req, res) => {
  try {
    const agencyId = getAgencyId(req);
    if (!agencyId) return res.status(401).json({ success: false, error: 'Missing agency key' });

    const { id } = req.params;
    const { phone } = req.body;

    if (!phone) return res.status(400).json({ success: false, error: 'Phone required' });

    await pendingItinerary.attachPhone(id, phone, agencyId);
    res.json({ success: true });
  } catch (err) {
    logger.error('itineraryRoutes /attach-phone error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/trips/itinerary/:id/abandon
// Called when traveler starts a fresh search.
// Archives the old itinerary silently.
// ─────────────────────────────────────────────────────────────
router.post('/:id/abandon', async (req, res) => {
  try {
    const { id } = req.params;
    await pendingItinerary.markAbandoned(id);
    res.json({ success: true });
  } catch (err) {
    logger.error('itineraryRoutes /abandon error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/trips/itinerary/restore
// Called on widget init when a returning user is detected.
// Looks up by sessionId (widget) or phone (cross-channel).
// ─────────────────────────────────────────────────────────────
router.get('/restore', async (req, res) => {
  try {
    const agencyId = req.headers['x-api-key'] || req.query.agencyId;
    if (!agencyId) return res.status(401).json({ success: false, error: 'Missing agency key' });

    const { phone, sessionId } = req.query;
    if (!phone && !sessionId) return res.status(400).json({ success: false, error: 'phone or sessionId required' });

    const itinerary = await pendingItinerary.restore({ phone, sessionId, agencyId });
    if (!itinerary) return res.json({ success: true, found: false });

    // Check prices if due
    let nudges = [];
    if (pendingItinerary.shouldCheckPrices(itinerary)) {
      nudges = await pendingItinerary.checkPrices(itinerary);
    }

    const nudgeMessage = nudges.length > 0
      ? pendingItinerary.formatNudgeMessage(nudges, itinerary.currency)
      : null;

    const restorePrompt = pendingItinerary.buildRestorePrompt(itinerary);

    res.json({
      success:       true,
      found:         true,
      itineraryId:   itinerary.id,
      itinerary,
      restorePrompt,
      nudgeMessage,
      nudges,
    });
  } catch (err) {
    logger.error('itineraryRoutes /restore error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/trips/itinerary/:id/partially-booked
// Called when some legs are booked but others are saved for later.
// ─────────────────────────────────────────────────────────────
router.post('/:id/partially-booked', async (req, res) => {
  try {
    const { id } = req.params;
    const { bookedLegs = [], pendingLegs = [] } = req.body;
    await pendingItinerary.markPartiallyBooked(id, bookedLegs, pendingLegs);
    res.json({ success: true });
  } catch (err) {
    logger.error('itineraryRoutes /partially-booked error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/trips/itinerary/:id/completed
// Called when all legs are booked.
// ─────────────────────────────────────────────────────────────
router.post('/:id/completed', async (req, res) => {
  try {
    const { id } = req.params;
    await pendingItinerary.markCompleted(id);
    res.json({ success: true });
  } catch (err) {
    logger.error('itineraryRoutes /completed error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/trips/itinerary/:id/deposit
// Returns deposit breakdown for the trip summary screen.
// ─────────────────────────────────────────────────────────────
router.get('/:id/deposit', async (req, res) => {
  try {
    const agencyId = req.headers['x-api-key'] || req.query.agencyId;
    const { id } = req.params;

    const { data: itin } = await require('../utils/supabase')
      .from('pending_itineraries')
      .select('leg_flow, currency')
      .eq('id', id)
      .single();

    if (!itin) return res.status(404).json({ success: false, error: 'Itinerary not found' });

    const deposit = pendingItinerary.calculateDeposit(itin.leg_flow);
    res.json({ success: true, deposit });
  } catch (err) {
    logger.error('itineraryRoutes /deposit error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;