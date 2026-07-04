/**
 * WEBHOOK ROUTES
 * ─────────────────────────────────────────────────────────────
 * Handles incoming messages from WhatsApp Business API.
 * This is where traveler conversations enter Bodrless.
 *
 * Flow:
 * Traveler messages agency WhatsApp
 * → WhatsApp sends webhook to Bodrless
 * → If this is the traveler's first-ever message, send the welcome
 *   message and ask for their name, then stop — nothing else runs
 *   on this message
 * → If we're awaiting a name reply from this number, capture it (or
 *   skip gracefully if it doesn't look like a name) before anything else
 * → If this message looks like a cancellation request (or is a
 *   yes/no reply to a pending cancellation confirmation), the
 *   cancel flow handles it — checked BEFORE the normal booking flow,
 *   since a traveler cancelling should never accidentally get routed
 *   into passenger-detail collection or option selection instead.
 * → If an active booking conversation exists for this phone number,
 *   the message is handled by whatsappBookingFlow instead of search
 * → Otherwise, if the message looks like a package selection ("1",
 *   "2", "option 2", etc.) AND we have recent packages cached for this
 *   phone number, kick off the booking flow
 * → Otherwise, if the message looks like raw passenger details
 *   (Name:/ID:/Phone:/DOB: lines) but there's no active booking
 *   session, redirect the traveler to search first instead of letting
 *   it fall into normal orchestration (which would otherwise try to
 *   parse trip params out of passenger text and corrupt the booking)
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
const whatsappCancelFlow = require('../services/whatsappCancelFlow');
const whatsappChangeFlow = require('../services/whatsappChangeFlow');
const { logger } = require('../utils/logger');

const recentPackagesByPhone = new Map();

const PASSENGER_DETAIL_LINE = /^(name|id\/passport no|id\/passport|id|passport|gender|phone|email|dob|date of birth)\s*:/im;

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

    // INTERACTIVE REPLIES (button taps and list-menu taps).
    // Checked BEFORE the generic non-text fallback below, since
    // these have message.type === 'interactive', not 'text', and
    // would otherwise fall into the generic "Hi! I can help you
    // plan a trip..." message instead of being handled properly.
    if (message.type === 'interactive') {
      const buttonId = message.interactive?.button_reply?.id || null;

      // TAP-TO-REVEAL PHOTO — traveler tapped the "📷 View Photo"
      // button sent alongside a package card (see whatsapp.js's
      // _sendPackageCard/sendButtons). The button's id was set to
      // `photo_<index>` where index matches directly into the SAME
      // recentPackagesByPhone cache already used for "reply with
      // the option number to book" — no separate correlation table
      // needed. Not tied to any booking session, so checked first.
      if (buttonId) {
        const photoMatch = buttonId.match(/^photo_(\d+)$/);
        if (photoMatch) {
          const idx = parseInt(photoMatch[1], 10);
          const cached = recentPackagesByPhone.get(from);
          const pkg = cached?.packages?.[idx];
          const imageUrl = pkg?.hotel?.images?.[0];
          if (imageUrl) {
            await whatsappService.sendImage(phoneNumberId, from, imageUrl, pkg.hotel.name || null);
          } else {
            await whatsappService.sendText(phoneNumberId, from,
              "Sorry, that photo isn't available anymore — try searching again."
            );
          }
          return;
        }
      }

      // Any other interactive reply (list-menu taps like the
      // Gender+Traveler-type selection during booking — see
      // whatsappBooking.js) — only the booking flow knows what to
      // do with these, so pass the raw interactive payload through.
      // If there's no active booking session, handleMessage()
      // returns false and we fall through to a generic ack rather
      // than silently doing nothing.
      const handledByBooking = await whatsappBookingFlow.handleMessage({ phoneNumberId, from, text: null, interactive: message.interactive });
      if (handledByBooking) return;

      await whatsappService.sendText(phoneNumberId, from, "Got it, thanks!");
      return;
    }

    if (message.type !== 'text') {
      await whatsappService.sendText(phoneNumberId, from,
        "Hi! I can help you plan a trip. Just describe what you're looking for — destination, dates, number of travelers and your budget."
      );
      return;
    }

    const prompt = message.text.body;
    const agencyId = await _resolveAgency(phoneNumberId);

    const contact = await _getOrCreateContact(from, agencyId);

    if (contact.justCreated) {
      await whatsappService.sendText(phoneNumberId, from,
        `Hey there! 👋 Welcome to Rove.\nThink of me as your personal travel guy, I'll sort out your transportation, stays and transfers\n\nBefore we get into it though, what's your name? I'd rather not just call you "traveler" the whole time`
      );
      return;
    }

    if (contact.awaiting_name) {
      const extractedName = _extractName(prompt);
      if (extractedName) {
        await _saveContactName(from, extractedName);
        await whatsappService.sendText(phoneNumberId, from,
          `Good to meet you, ${extractedName}! Alright — tell me about the trip you're dreaming up. Where to, when, how many of you, and roughly what budget you're working with. I'll handle the rest.`
        );
        return;
      }
      await _clearAwaitingName(from);
    }

    // CANCELLATION FLOW — checked before the normal booking flow.
    // Covers both a fresh cancel request ("cancel my booking") and a
    // yes/no reply to a cancellation confirmation already in
    // progress for this number. Returns true if it handled the
    // message (either case), false if this message has nothing to
    // do with cancelling and normal handling should continue.
    const handledByCancel = await whatsappCancelFlow.handleMessage({ phoneNumberId, from, text: prompt });
    if (handledByCancel) return;

    // CHANGE-FLIGHT FLOW — same "checked before normal booking flow"
    // posture as cancellation above. Always asks for the booking
    // reference explicitly (see whatsappChangeFlow.js's file header
    // for why) rather than guessing which booking is meant.
    const handledByChange = await whatsappChangeFlow.handleMessage({ phoneNumberId, from, text: prompt });
    if (handledByChange) return;

    const handledByBooking = await whatsappBookingFlow.handleMessage({ phoneNumberId, from, text: prompt });
    if (handledByBooking) return;

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
    }

    if (PASSENGER_DETAIL_LINE.test(prompt.trim())) {
      const hasSession = await whatsappBookingFlow.hasActiveSession(from);
      if (!hasSession) {
        await whatsappService.sendText(phoneNumberId, from,
          "It looks like you're sending traveler details, but I don't have an active booking for you right now. Please search for a trip first, then reply with the option number to start booking — I'll ask for traveler details at that point."
        );
        return;
      }
    }

    await whatsappService.sendText(phoneNumberId, from, _pickAcknowledgment());

    const result = await orchestrationEngine.orchestrate(prompt, agencyId, {
      conversationHistory: contact.conversation_history || [],
      previousParams: contact.previous_params || null,
      channel: 'whatsapp',
      phone: from,
    });

    await _saveConversationState(from, result.conversationHistory, result.tripParams);

    if (result.needsClarification) {
      await whatsappService.sendText(phoneNumberId, from, result.text);
      return;
    }

    if (result.tripResults && result.tripResults.length > 1) {
      const allPackagesInOrder = [];

      for (let i = 0; i < result.tripResults.length; i++) {
        const trip = result.tripResults[i];
        const introLine = i === 0
          ? `Let's start with ${trip.label}:`
          : `Now for ${trip.label}:`;

        await whatsappService.sendText(phoneNumberId, from, introLine);

        if (trip.packages && trip.packages.length > 0) {
          await whatsappService.sendPackages(phoneNumberId, from, trip.packages);
          allPackagesInOrder.push(...trip.packages);
        } else {
          await whatsappService.sendText(phoneNumberId, from, `Sorry, I couldn't find any matching options for ${trip.label}.`);
        }
      }

      if (allPackagesInOrder.length > 0) {
        recentPackagesByPhone.set(from, { packages: allPackagesInOrder, cachedAt: Date.now() });
        await whatsappService.sendText(phoneNumberId, from,
          `Reply with the option number (1-${allPackagesInOrder.length}) to book one of the options above.`
        );
      }
      return;
    }

    await whatsappService.sendText(phoneNumberId, from, result.text);

    if (result.packages && result.packages.length > 0) {
      await whatsappService.sendPackages(phoneNumberId, from, result.packages);
      recentPackagesByPhone.set(from, { packages: result.packages, cachedAt: Date.now() });

      await whatsappService.sendText(phoneNumberId, from,
        `Reply with the option number (1-${result.packages.length}) to book that option.`
      );
    }

  } catch (error) {
    logger.error('WhatsApp webhook error', { error: error.message });
  }
});

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

/**
 * GET OR CREATE WHATSAPP CONTACT
 * Looks up whatsapp_contacts by phone. If no row exists, this is
 * the traveler's first-ever message — insert one with
 * awaiting_name: true and flag justCreated so the caller knows to
 * send the welcome message rather than treat this as a normal reply.
 *
 * FIX: now stamps agency_id at creation time, resolved from the
 * phone_number_id the message arrived on (same resolution
 * _resolveAgency already does for routing). Previously this column
 * didn't exist on the table at all, so "which agency does this
 * contact belong to" had to be inferred downstream from bookings/
 * sessions — which missed any contact who'd only searched and never
 * booked. Setting it here, once, at the moment of first contact, is
 * the single source of truth going forward.
 *
 * If a contact somehow already exists with agency_id still NULL
 * (pre-migration row, or a backfill miss), we opportunistically set
 * it now rather than leaving it unset forever — cheap and harmless
 * since a phone number realistically only ever talks to one agency's
 * WhatsApp number in this architecture (each agency has its own
 * number/phone_number_id).
 */
async function _getOrCreateContact(phone, agencyId) {
  const { data: existing, error: selectError } = await supabase
    .from('whatsapp_contacts')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (selectError) {
    logger.error('whatsapp_contacts lookup failed', { error: selectError.message });
    return { justCreated: false, awaiting_name: false, name: null, conversation_history: [], previous_params: null };
  }

  if (existing) {
    if (!existing.agency_id && agencyId) {
      // Opportunistic backfill — don't block the response on this.
      supabase
        .from('whatsapp_contacts')
        .update({ agency_id: agencyId })
        .eq('phone', phone)
        .then(() => {})
        .catch(err => logger.error('whatsapp_contacts agency_id backfill failed', { error: err.message, phone }));
    }
    return { ...existing, justCreated: false };
  }

  const { error: insertError } = await supabase
    .from('whatsapp_contacts')
    .insert({ phone, name: null, awaiting_name: true, agency_id: agencyId || null });

  if (insertError) {
    logger.error('whatsapp_contacts insert failed', { error: insertError.message });
    return { justCreated: false, awaiting_name: false, name: null, conversation_history: [], previous_params: null };
  }

  return { justCreated: true, awaiting_name: true, name: null };
}

// ─────────────────────────────────────────────
// PICK ACKNOWLEDGMENT MESSAGE
// Replaces a single robotic "Got it! Give me a moment..." line with
// a small rotating set, matching the same "personal travel guy"
// warmth already established in the welcome message
// (_getOrCreateContact's justCreated branch). Picked at random each
// time so back-to-back searches in one conversation don't feel like
// the same canned bot line repeating.
// ─────────────────────────────────────────────
const ACKNOWLEDGMENT_MESSAGES = [
  "On it! 🔍 Let me pull together some great options for you...",
  "Say less — searching now, one moment...",
  "Great, let me see what I can find for you...",
  "Got it! Give me a second to line up some options...",
  "Alright, let's find you something good — one moment...",
  "Perfect, searching now — won't be long...",
];

function _pickAcknowledgment() {
  return ACKNOWLEDGMENT_MESSAGES[Math.floor(Math.random() * ACKNOWLEDGMENT_MESSAGES.length)];
}

function _extractName(text) {
  let cleaned = text.trim();

  cleaned = cleaned.replace(/^(it'?s|i'?m|i am|my name is|call me|this is|am)\s+/i, '').trim();
  cleaned = cleaned.replace(/[.!]+$/, '').trim();

  if (!cleaned) return null;

  const looksLikeTripPrompt = /\d|\bto\b|\bfrom\b|\bnight|\bday|\bbudget|\btrip\b|\bbook\b|\bflight|\bhotel/i.test(cleaned);
  if (looksLikeTripPrompt) return null;
  if (cleaned.split(/\s+/).length > 4) return null;
  if (cleaned.length > 40) return null;

  return cleaned
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

async function _saveContactName(phone, name) {
  const { error } = await supabase
    .from('whatsapp_contacts')
    .update({ name, awaiting_name: false, updated_at: new Date().toISOString() })
    .eq('phone', phone);

  if (error) {
    logger.error('whatsapp_contacts name save failed', { error: error.message, phone });
  }
}

async function _clearAwaitingName(phone) {
  const { error } = await supabase
    .from('whatsapp_contacts')
    .update({ awaiting_name: false, updated_at: new Date().toISOString() })
    .eq('phone', phone);

  if (error) {
    logger.error('whatsapp_contacts awaiting_name clear failed', { error: error.message, phone });
  }
}

async function _saveConversationState(phone, conversationHistory, tripParams) {
  const { error } = await supabase
    .from('whatsapp_contacts')
    .update({
      conversation_history: conversationHistory || [],
      previous_params: tripParams || null,
      updated_at: new Date().toISOString(),
    })
    .eq('phone', phone);

  if (error) {
    logger.error('whatsapp_contacts conversation state save failed', { error: error.message, phone });
  }
}

module.exports = router;