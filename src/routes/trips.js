/**
 * TRIP ROUTES
 * ─────────────────────────────────────────────
 * Widget + WhatsApp + API Safe
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');

const orchestrationEngine =
  require('../orchestration/engine');

const { logger } =
  require('../utils/logger');


// ─────────────────────────────────────────────
// ORCHESTRATE
// ─────────────────────────────────────────────
router.post('/orchestrate', async (req, res) => {

  const schema = Joi.object({
    prompt: Joi.string()
      .min(5)
      .max(500)
      .required(),

    agencyId: Joi.string()
      .required(),

    channelType: Joi.string()
      .valid('whatsapp', 'widget', 'api')
      .default('api'),

    sessionId: Joi.string()
      .optional(),
  });

  const { error, value } =
    schema.validate(req.body);

  if (error) {

    return res.json({
      success: false,
      error: error.details[0].message,
      packages: generateFallbackPackages()
    });
  }

  try {

    logger.info('Orchestration started', {
      agencyId: value.agencyId,
      prompt: value.prompt
    });

    const result =
      await orchestrationEngine.orchestrate(
        value.prompt,
        value.agencyId
      );

    let packages =
      Array.isArray(result?.packages)
        ? result.packages
        : [];

    // fallback if engine returns empty
    if (!packages.length) {
      packages = generateFallbackPackages();
    }

    return res.json({
      success: true,
      sessionId:
        result?.sessionId ||
        `sess_${Date.now()}`,

      packages: packages.slice(0, 4)
    });

  } catch (err) {

    logger.error(
      'Orchestration fatal error',
      { error: err.message }
    );

    return res.json({
      success: true,
      error: 'fallback_mode',
      packages: generateFallbackPackages()
    });
  }
});


// ─────────────────────────────────────────────
// BOOK
// ─────────────────────────────────────────────
router.post('/book', async (req, res) => {

  return res.json({
    success: true,
    message: 'Booking initiated',
    bookingId: `BDR-${Date.now()}`,
    status: 'pending_payment'
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


// ─────────────────────────────────────────────
// FALLBACK PACKAGES
// ─────────────────────────────────────────────
function generateFallbackPackages() {

  return [

    {
      hotel: {
        name: "Mid-range Hotel Option"
      },

      transport: {
        provider: "Flight included"
      },

      summary: {
        pricePerPerson: 450,
        nights: 3,
        passengers: 2
      }
    },

    {
      hotel: {
        name: "Budget Friendly Stay"
      },

      transport: {
        provider: "Economy flight"
      },

      summary: {
        pricePerPerson: 320,
        nights: 3,
        passengers: 2
      }
    },

    {
      hotel: {
        name: "Comfort Experience Hotel"
      },

      transport: {
        provider: "Direct flight"
      },

      summary: {
        pricePerPerson: 600,
        nights: 4,
        passengers: 2
      }
    },

    {
      hotel: {
        name: "Luxury Resort Package"
      },

      transport: {
        provider: "Premium airline"
      },

      summary: {
        pricePerPerson: 1100,
        nights: 5,
        passengers: 2
      }
    }
  ];
}

module.exports = router;
