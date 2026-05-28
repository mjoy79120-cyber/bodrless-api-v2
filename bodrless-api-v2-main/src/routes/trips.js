/**
 * TRIP ROUTES
 * ─────────────────────────────────────────────
 * Handles orchestration for widget and API.
 * Resolves agency from api key in header.
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const orchestrationEngine = require('../orchestration/engine');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// RESOLVE AGENCY FROM API KEY
// ─────────────────────────────────────────────
async function resolveAgency(apiKey, agencyId) {
  if (apiKey) {
    const { data } = await supabase
      .from('agencies')
      .select('id, name')
      .eq('api_key', apiKey)
      .single();
    if (data) return data.id;
  }
  if (agencyId) return agencyId;
  return null;
}

// ─────────────────────────────────────────────
// ORCHESTRATE
// ─────────────────────────────────────────────
router.post('/orchestrate', async (req, res) => {

  const schema = Joi.object({
    prompt: Joi.string().min(5).max(500).required(),
    agencyId: Joi.string().optional(),
    channelType: Joi.string().valid('whatsapp', 'widget', 'api').default('api'),
    sessionId: Joi.string().optional(),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    return res.json({
      success: false,
      packages: [],
      error: error.details[0].message
    });
  }

  try {
    const apiKey = req.headers['x-api-key'] || null;
    const resolvedAgencyId = await resolveAgency(apiKey, value.agencyId);

    if (!resolvedAgencyId) {
      return res.json({
        success: false,
        packages: [],
        error: 'Invalid agency key. Please check your API key.'
      });
    }

    logger.info('Orchestration started', {
      agencyId: resolvedAgencyId,
      prompt: value.prompt
    });

    const result = await orchestrationEngine.orchestrate(
      value.prompt,
      resolvedAgencyId
    );

    const packages = Array.isArray(result?.packages) ? result.packages : [];

    return res.json({
      success: true,
      packages: packages.slice(0, 4),
      sessionId: result?.sessionId || `sess_${Date.now()}`
    });

  } catch (err) {
    logger.error('Orchestration error', { error: err.message });
    return res.json({
      success: false,
      packages: [],
      error: err.message
    });
  }
});

// ─────────────────────────────────────────────
// BOOKING
// ─────────────────────────────────────────────
router.post('/book', async (req, res) => {

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
    paymentMethod: Joi.string()
      .valid('mpesa', 'card', 'bank_transfer')
      .required(),
  });

  const { error } = schema.validate(req.body);

  if (error) {
    return res.json({ success: false, error: error.details[0].message });
  }

  return res.json({
    success: true,
    message: 'Booking initiated',
    bookingId: `BDR-${Date.now()}`,
    status: 'pending_payment',
  });
});

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
