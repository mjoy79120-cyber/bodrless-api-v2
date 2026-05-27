/**
 * WEBHOOK ROUTES (FIXED FOR STRICT ORCHESTRATION)
 */

const express = require('express');
const router = express.Router();
const orchestrationEngine = require('../orchestration/engine');
const whatsappService = require('../services/whatsapp');
const { logger } = require('../utils/logger');

// ── GET verification ───────────────────────────────
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === 'bodrless-webhook-secret') {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ── POST webhook ───────────────────────────────
router.post('/whatsapp', async (req, res) => {

  // MUST respond immediately
  res.status(200).send('OK');

  try {

    const body = req.body;

    const message =
      body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return;

    const phoneNumberId =
      body.entry[0].changes[0].value.metadata.phone_number_id;

    const from = message.from;

    logger.info('Incoming WhatsApp message', { from, type: message.type });

    // Only text messages
    if (message.type !== 'text') {

      await whatsappService.sendText(
        phoneNumberId,
        from,
        "Please send your trip details (destination, dates, travelers)."
      );

      return;
    }

    const prompt = message.text.body;

    // 🔥 FIX: ensure real agencyId (IMPORTANT)
    let agencyId = await _resolveAgencyFromPhoneNumber(phoneNumberId);

    if (!agencyId || agencyId === 'agency_placeholder') {
      agencyId = 'epic-travels'; // fallback to your test agency
    }

    // Acknowledge user
    await whatsappService.sendText(
      phoneNumberId,
      from,
      "Got it 👍 Building your travel options now..."
    );

    // Run engine
    const result =
      await orchestrationEngine.orchestrate(prompt, agencyId);

    const packages = Array.isArray(result?.packages)
      ? result.packages
      : [];

    // EMPTY RESULT HANDLING
    if (!packages.length) {

      await whatsappService.sendText(
        phoneNumberId,
        from,
        "I couldn't find matching packages. Try including destination, dates, and travelers."
      );

      return;
    }

    // ── FORMAT MESSAGE FOR WHATSAPP ──
    const formatted = packages.slice(0, 3).map((p, i) => {

      return `
✈️ *Package ${i + 1}*

📍 ${p.summary?.route || "Trip"}
📅 ${p.summary?.dates || ""}
👥 ${p.summary?.passengers || 1} travellers

✈️ ${p.transport?.providerName || p.transport?.airline || "Transport"}
🏨 ${p.hotel?.name || "Hotel"}
🚗 ${p.transfers?.provider || "Transfer"}

💰 Total: $${p.summary?.totalPrice || 0}
💰 Per person: $${p.summary?.pricePerPerson || 0}
      `;
    }).join("\n-------------------\n");

    await whatsappService.sendText(
      phoneNumberId,
      from,
      formatted
    );

  } catch (error) {

    logger.error('WhatsApp webhook error', {
      error: error.message
    });

    // optional fallback message
  }
});

// ── Helper ───────────────────────────────
async function _resolveAgencyFromPhoneNumber(phoneNumberId) {

  // TODO: replace with DB lookup later
  // for now we hardbind to your test agency

  return 'epic-travels';
}

module.exports = router;
