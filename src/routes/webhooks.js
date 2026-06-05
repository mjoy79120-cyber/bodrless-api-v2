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
const supabase = require('../utils/supabase');
const orchestrationEngine = require('../orchestration/engine');
const whatsappService = require('../services/whatsapp');
const { logger } = require('../utils/logger');

// ── GET /api/webhooks/whatsapp ───────────────────────────────
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── POST /api/webhooks/whatsapp ──────────────────────────────
router.post('/whatsapp', async (req, res) => {
  res.status(200).send('OK');

  try {
    const body = req.body;

    if (!body?.entry?.[0]?.changes?.[0]?.value?.messages) {
      return;
    }

    const message = body.entry[0].changes[0].value.messages[0];
    const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
    const from = message.from;

    logger.info('Incoming WhatsApp message', { from, type: message.type });

    if (message.type !== 'text') {
      await whatsappService.sendText(phoneNumberId, from,
        "Hi! I can help you plan a trip. Just describe what you're looking for — destination, dates, number of travelers and your budget."
      );
      return;
    }

    const prompt = message.text.body;

    // Resolve agency from phone number ID
    const agencyId = await _resolveAgency(phoneNumberId);

    await whatsappService.sendText(phoneNumberId, from,
      "Got it! Give me a moment while I put together some options for you."
    );

    const result = await orchestrationEngine.orchestrate(prompt, agencyId);

    if (!result.packages || result.packages.length === 0) {
      await whatsappService.sendText(phoneNumberId, from,
        "I couldn't find packages matching your request. Could you share more details? Destination, dates, number of travelers and budget would help!"
      );
      return;
    }

    await whatsappService.sendPackages(phoneNumberId, from, result.packages);

  } catch (error) {
    logger.error('WhatsApp webhook error', { error: error.message });
  }
});

// ── Helper ───────────────────────────────────────────────────
async function _resolveAgency(phoneNumberId) {
  try {
    const { data } = await supabase
      .from('agencies')
      .select('id')
      .eq('whatsapp_phone_number_id', phoneNumberId)
      .single();

    if (data) return data.id;
  } catch (err) {
    logger.warn('Could not resolve agency from phone number', { phoneNumberId });
  }

  // Fallback for test number
  return process.env.DEFAULT_AGENCY_ID || 'accessible-travel';
}

module.exports = router;