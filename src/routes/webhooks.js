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
const { logger } = require('../utils/logger');

// In-memory cache of each phone number's most recent search results,
// so we know what package "1" or "2" refers to when they reply.
// NOTE: this resets on server restart — fine for short-lived selection
// windows, but if conversations need to survive restarts, move this to
// Supabase the same way whatsapp_booking_sessions works.
const recentPackagesByPhone = new Map();

// Matches a free-text passenger-detail line, e.g. "Name: John Doe" or
// "DOB: 1990-05-21". Used only to detect a traveler replying with
// passenger details outside of an active booking session — see Step
// 2.5 below. Intentionally loose (any single matching line trips it)
// since a partially-remembered format from an expired session is
// exactly the case we want to catch.
const PASSENGER_DETAIL_LINE = /^(name|id\/passport no|id\/passport|id|passport|gender|phone|email|dob|date of birth)\s*:/im;

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

    // ── Step 0: welcome message + name capture ──
    // First-ever contact from this number -> send the welcome message,
    // mark them as awaiting a name reply, and stop (this message was
    // just "hi"/the trigger, not a trip request — nothing to parse).
    // If they're already awaiting a name, THIS message is their name
    // reply (or, if it doesn't look like a name at all, we skip the
    // name step gracefully and let it fall through to normal handling
    // below rather than blocking trip planning on it).
    const contact = await _getOrCreateContact(from);

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
      // Didn't look like a name — quietly stop asking and fall through
      // to normal handling below, so trip planning isn't blocked on it.
      await _clearAwaitingName(from);
    }

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

    // ── Step 2.5: passenger-detail safety net ──
    // Step 1 only catches this if a booking session is already active.
    // If a traveler free-types passenger details (Name:/ID:/Phone:/DOB:
    // lines) with NO active session — e.g. the session expired, they
    // already completed a booking, or they never actually started one —
    // letting this fall through to orchestrate() below would have it
    // treated as a fresh trip search prompt, producing corrupted bookings
    // (parser tries to extract a destination/dates out of passenger text).
    // Catch it here instead and point them back to search first.
    if (PASSENGER_DETAIL_LINE.test(prompt.trim())) {
      const hasSession = await whatsappBookingFlow.hasActiveSession(from);
      if (!hasSession) {
        await whatsappService.sendText(phoneNumberId, from,
          "It looks like you're sending traveler details, but I don't have an active booking for you right now. Please search for a trip first, then reply with the option number to start booking — I'll ask for traveler details at that point."
        );
        return;
      }
    }

    // ── Step 3: normal search/orchestration ──
    await whatsappService.sendText(phoneNumberId, from,
      "Got it! Give me a moment while I check the options for you..."
    );

    // FIX: previously called orchestrate(prompt, agencyId, from) —
    // passing the phone number STRING where engine.js expects a real
    // context object ({ conversationHistory, previousParams }).
    // context.conversationHistory/previousParams silently came back
    // undefined every time (a string has no such properties), so
    // every WhatsApp message was treated as a brand-new search and
    // follow-up detection ("cheaper options", "make it 5 nights
    // instead", etc.) never worked over WhatsApp — same conversation
    // memory the widget already keeps in browser variables, just
    // missing on this channel. Loaded from whatsapp_contacts (see
    // migration 002) since a WhatsApp conversation can span far
    // longer than a browser tab stays open.
    const result = await orchestrationEngine.orchestrate(prompt, agencyId, {
      conversationHistory: contact.conversation_history || [],
      previousParams: contact.previous_params || null,
      channel: 'whatsapp',
    });

    // Persist whatever the engine returned back onto the contact row,
    // mirroring the widget's "if (data.tripParams) previousParams = ..."
    // pattern — so the NEXT message from this number has the updated
    // state available, the same way the widget's browser variables do.
    await _saveConversationState(from, result.conversationHistory, result.tripParams);

    // A multi-destination prompt with an ambiguous leg (no origin
    // restated, and it doesn't match the previous stop) — engine.js
    // stops before searching anything and asks instead. No packages,
    // no booking cache update; the traveler's reply becomes a fresh
    // prompt that should carry enough info to resolve it.
    if (result.needsClarification) {
      await whatsappService.sendText(phoneNumberId, from, result.text);
      return;
    }

    // Multi-destination prompts that split into independent trips
    // (e.g. "Nairobi to Zanzibar 4 nights then Nairobi to Kampala 3
    // nights") come back as tripResults — one labeled block per trip,
    // sent in the order the traveler stated them. A single continuous
    // itinerary or a normal single-destination search has no
    // tripResults and falls through to the original one-block flow.
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

// ─────────────────────────────────────────────
// GET OR CREATE WHATSAPP CONTACT
// Looks up whatsapp_contacts by phone. If no row exists, this is
// the traveler's first-ever message — insert one with
// awaiting_name: true and flag justCreated so the caller knows to
// send the welcome message rather than treat this as a normal reply.
// ─────────────────────────────────────────────
async function _getOrCreateContact(phone) {
  const { data: existing, error: selectError } = await supabase
    .from('whatsapp_contacts')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();

  if (selectError) {
    logger.error('whatsapp_contacts lookup failed', { error: selectError.message });
    // Fail open — treat as an existing, name-known contact so a
    // Supabase hiccup never blocks trip planning behind a welcome
    // message loop. No conversation memory available this turn, but
    // that degrades gracefully (same as a brand-new conversation)
    // rather than crashing.
    return { justCreated: false, awaiting_name: false, name: null, conversation_history: [], previous_params: null };
  }

  if (existing) {
    return { ...existing, justCreated: false };
  }

  const { error: insertError } = await supabase
    .from('whatsapp_contacts')
    .insert({ phone, name: null, awaiting_name: true });

  if (insertError) {
    logger.error('whatsapp_contacts insert failed', { error: insertError.message });
    return { justCreated: false, awaiting_name: false, name: null, conversation_history: [], previous_params: null };
  }

  return { justCreated: true, awaiting_name: true, name: null };
}

// ─────────────────────────────────────────────
// EXTRACT NAME FROM REPLY
// Loose, human-friendly extraction — strips common filler
// ("it's", "i'm", "call me", "my name is", etc.) and keeps the
// rest as the name. Returns null if the reply doesn't look like
// a name at all (too long, looks like a trip prompt, empty after
// stripping) — callers treat null as "skip the name step, don't
// block trip planning on it."
// ─────────────────────────────────────────────
function _extractName(text) {
  let cleaned = text.trim();

  cleaned = cleaned.replace(/^(it'?s|i'?m|i am|my name is|call me|this is|am)\s+/i, '').trim();
  cleaned = cleaned.replace(/[.!]+$/, '').trim();

  if (!cleaned) return null;

  // A real name reply is short. Anything long, or containing digits/
  // trip-prompt signals (to/from/nights/days/budget keywords), is
  // almost certainly not a name — likely the traveler skipped ahead
  // straight into describing a trip.
  const looksLikeTripPrompt = /\d|\bto\b|\bfrom\b|\bnight|\bday|\bbudget|\btrip\b|\bbook\b|\bflight|\bhotel/i.test(cleaned);
  if (looksLikeTripPrompt) return null;
  if (cleaned.split(/\s+/).length > 4) return null;
  if (cleaned.length > 40) return null;

  // Title-case each word for a clean greeting (e.g. "rove" -> "Rove").
  return cleaned
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ─────────────────────────────────────────────
// SAVE CONTACT NAME
// ─────────────────────────────────────────────
async function _saveContactName(phone, name) {
  const { error } = await supabase
    .from('whatsapp_contacts')
    .update({ name, awaiting_name: false, updated_at: new Date().toISOString() })
    .eq('phone', phone);

  if (error) {
    logger.error('whatsapp_contacts name save failed', { error: error.message, phone });
  }
}

// ─────────────────────────────────────────────
// CLEAR AWAITING_NAME (without saving a name)
// Used when the traveler's reply to "what's your name?" didn't
// look like a name — stop asking, but don't block trip planning.
// ─────────────────────────────────────────────
async function _clearAwaitingName(phone) {
  const { error } = await supabase
    .from('whatsapp_contacts')
    .update({ awaiting_name: false, updated_at: new Date().toISOString() })
    .eq('phone', phone);

  if (error) {
    logger.error('whatsapp_contacts awaiting_name clear failed', { error: error.message, phone });
  }
}

// ─────────────────────────────────────────────
// SAVE CONVERSATION STATE
// Persists conversationHistory/tripParams returned by orchestrate()
// back onto the contact row, so the NEXT message from this phone
// number has them available — the server-side equivalent of the
// widget overwriting its browser-memory variables after each
// response (see widget.js's "if (data.tripParams) previousParams =
// ..." pattern). Best-effort: a failure here shouldn't crash the
// current response, since the traveler already got their answer —
// it just means follow-up detection won't have memory on their
// NEXT message, same as if this were their first message ever.
// ─────────────────────────────────────────────
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