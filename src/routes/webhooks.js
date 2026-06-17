/**
 * WEBHOOK ROUTES
 * ─────────────────────────────────────────────────────────────
 * Handles incoming messages from WhatsApp Business API.
 * This is where traveler conversations enter Bodrless.
 *
 * Flow:
 * Traveler messages agency WhatsApp
 * → WhatsApp sends webhook to Bodrless
 * → If an active booking conversation exists for this phone number,
 *   the message is handled by whatsappBookingFlow instead of search
 * → Otherwise, if the message looks like a package selection ("1",
 *   "2", "option 2", etc.) AND we have recent packages cached for this
 *   phone number, kick off the booking flow
 * → Otherwise, run normal orchestration with persistent memory
 * → Bodrless replies dynamically via WhatsApp
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const supabase = require('../utils/supabase');
const orchestrationEngine = require('../orchestration/engine');
const whatsappService = require('../services/whatsapp');
const whatsappBookingFlow = require('../services/whatsappBooking');
const { logger } = require('../utils/logger');

// In-memory cache of each phone number's most recent search results,
// so we know what package "1" or "2" refers to when they reply.
// NOTE: this resets on server restart — fine for short-lived selection
// windows, but if conversations need to survive restarts, move this to
// Supabase the same way whatsapp_booking_sessions works.
const recentPackagesByPhone = new Map();

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
    const agencyId = await _resolveAgency(phoneNumberId);

    // ── Step 1: is there an active booking conversation for this number? ──
    const handledByBooking = await whatsappBookingFlow.handleMessage({ phoneNumberId, from, text: prompt });
    if (handledByBooking) return;

    // ── Step 2: does this look like a package selection? ──
    const selectionMatch = prompt.trim().match(/^(?:option\s*)?([1-4])$/i);
    if (selectionMatch) {
      const cached = recentPackagesByPhone.get(from);
      if (cached && cached.packages && cached.packages.length > 0) {
        const idx = parseInt(selectionMatch[1], 10) - 1;
        const selectedPackage = cached.packages[idx];
        if (selectedPackage) {
          await whatsappBookingFlow.startBooking({ phoneNumberId, from, agencyId, selectedPackage });
          return;
        }
      }
      // No cached packages to select from — fall through to normal orchestration
      // so something sensible still happens with a bare "1" or "2".
    }

    // ── Step 3: normal search/orchestration ──
    await whatsappService.sendText(phoneNumberId, from,
      "Got it! Give me a moment while I check the options for you..."
    );

    const result = await orchestrationEngine.orchestrate(prompt, agencyId, from);

    await whatsappService.sendText(phoneNumberId, from, result.text);

    if (result.packages && result.packages.length > 0) {
      await whatsappService.sendPackages(phoneNumberId, from, result.packages);
      recentPackagesByPhone.set(from, { packages: result.packages, cachedAt: Date.now() });

      // Let the customer know they can book directly
      await whatsappService.sendText(phoneNumberId, from,
        `Reply with the option number (1-${result.packages.length}) to book that option.`
      );
    }

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

  return process.env.DEFAULT_AGENCY_ID || 'azaki-adventures';
}

module.exports = router;