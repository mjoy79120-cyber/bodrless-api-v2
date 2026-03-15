/**
 * TRIP ROUTES
 * ─────────────────────────────────────────────────────────────
 * Core API endpoints for trip orchestration.
 * These are what agencies call when a traveler sends a prompt.
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const orchestrationEngine = require('../orchestration/engine');
const { authenticateAgency } = require('../middleware/auth');
const { logger } = require('../utils/logger');

// ── POST /api/trips/orchestrate ──────────────────────────────
// Main endpoint — takes a traveler prompt and returns packages
router.post('/orchestrate', authenticateAgency, async (req, res) => {
  const schema = Joi.object({
    prompt: Joi.string().min(5).max(500).required(),
    agencyId: Joi.string().required(),
    channelType: Joi.string().valid('whatsapp', 'widget', 'api').default('api'),
    sessionId: Joi.string().optional(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  try {
    const result = await orchestrationEngine.orchestrate(
      value.prompt,
      value.agencyId
    );

    res.json({
      success: true,
      ...result,
    });

  } catch (err) {
    logger.error('Orchestration endpoint error', { error: err.message });

    // Handle missing parameters gracefully
    if (err.message.includes('Missing required')) {
      return res.status(422).json({
        success: false,
        error: 'incomplete_prompt',
        message: err.message,
        missingFields: _extractMissingFields(err.message),
      });
    }

    res.status(500).json({ success: false, error: 'Orchestration failed' });
  }
});

// ── POST /api/trips/book ─────────────────────────────────────
// Book a specific package from orchestration results
router.post('/book', authenticateAgency, async (req, res) => {
  const schema = Joi.object({
    packageId: Joi.string().required(),
    sessionId: Joi.string().required(),
    agencyId: Joi.string().required(),
    travelerDetails: Joi.object({
      name: Joi.string().required(),
      email: Joi.string().email().required(),
      phone: Joi.string().required(),
      passportNumber: Joi.string().optional(),
    }).required(),
    paymentMethod: Joi.string().valid('mpesa', 'card', 'bank_transfer').required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  try {
    // TODO: Implement booking flow
    // 1. Lock the package (prevent double booking)
    // 2. Initiate payment
    // 3. On payment success — book flight first, then hotel, then transfers
    // 4. Return booking confirmation

    res.json({
      success: true,
      message: 'Booking initiated',
      bookingId: `BDR-${Date.now()}`,
      status: 'pending_payment',
    });

  } catch (err) {
    logger.error('Booking endpoint error', { error: err.message });
    res.status(500).json({ success: false, error: 'Booking failed' });
  }
});

// ── GET /api/trips/booking/:bookingId ────────────────────────
// Get booking status
router.get('/booking/:bookingId', authenticateAgency, async (req, res) => {
  try {
    // TODO: Fetch booking status from database
    res.json({
      bookingId: req.params.bookingId,
      status: 'confirmed',
      message: 'Booking status endpoint — connect to your database',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// ── Helper ───────────────────────────────────────────────────
function _extractMissingFields(message) {
  const match = message.match(/Missing required trip parameters: (.+)/);
  return match ? match[1].split(', ') : [];
}

module.exports = router;
