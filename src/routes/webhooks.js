/**
 * WEBHOOK ROUTES
 * ─────────────────────────────────────────────────────────────
 * Handles incoming messages from WhatsApp Business API.
 * This is where traveler conversations enter Bodrless.
 *
 * Flow:
 *   Traveler messages agency WhatsApp
 *   → WhatsApp sends webhook to Bodrless
 *   → Bodrless runs orchestration
 *   → Bodrless replies with packages via WhatsApp
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const orchestrationEngine = require('../orchestration/engine');
const whatsappService = require('../services/whatsapp');
const { logger } = require('../utils/logger');

// ── GET /api/webhooks/whatsapp ───────────────────────────────
// WhatsApp webhook verification (required by Meta)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === 'bodrless-webhook-secret') {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── POST /api/webhooks/whatsapp ──────────────────────────────
// Incoming WhatsApp messages
router.post('/whatsapp', async (req, res) => {
  // Always acknowledge immediately — WhatsApp requires fast response
  res.status(200).send('OK');

  try {
    const body = req.body;

    if (!body?.entry?.[0]?.changes?.[0]?.value?.messages) {
      return; // Not a message event
    }

    const message = body.entry[0].changes[0].value.messages[0];
    const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
    const from = message.from; // Traveler's phone number

    logger.info('Incoming WhatsApp message', { from, type: message.type });

    // Only process text messages for now
    if (message.type !== 'text') {
      await whatsappService.sendText(phoneNumberId, from,
        "Hi! I can help you plan a trip. Just describe what you're looking for — destination, dates, number of travelers and your budget."
      );
      return;
    }

    const prompt = message.text.body;

    // TEMP: hardcoded for test number — replace with DB lookup when going live
    const agencyId = 'epic-travels';

    // Send acknowledgment immediately
    await whatsappService.sendText(phoneNumberId, from,
      "Got it! Give me a moment while I put together some options for you ✈️"
    );

    // Run orchestration
    const result = await orchestrationEngine.orchestrate(prompt, agencyId);

    if (!result.packages || result.packages.length === 0) {
      await whatsappService.sendText(phoneNumberId, from,
        "I couldn't find packages matching your request. Could you share more details? Destination, dates, number of travelers and budget would help!"
      );
      return;
    }

    // Send packages back via WhatsApp
    await whatsappService.sendPackages(phoneNumberId, from, result.packages);

  } catch (error) {
    logger.error('WhatsApp webhook error', { error: error.message });
  }
});

module.exports = router;