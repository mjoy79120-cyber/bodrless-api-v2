/**
 * WEBHOOK ROUTES
 * ─────────────────────────────────────────────────────────────
 * Handles incoming messages from WhatsApp Business API.
 * Supports both phone-based (from/wa_id) and user_id-based identities.
 *
 * Added (2026-08-17): Child age interception before orchestration.
 * When parsePrompt returns needsChildAge: true (a child is mentioned
 * but no age was given), the webhook asks "How old is the child?"
 * before running the search engine. The answer is stored in the
 * conversation session so the follow-up turn inherits childAges[]
 * and runs orchestration with the correct fare class from the start.
 *
 * State key: conversationMemory stores `pendingChildAgeCapture: true`
 * in previousParams. On the next turn, if that flag is set and the
 * message looks like an age answer, childAges is populated and
 * orchestration runs with the completed params.
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
const packageCache = require('../services/packageCache');
const conversationMemory = require('../services/conversationMemoryService');
const disruptionFlow = require('../services/disruptionFlow');
const { logger } = require('../utils/logger');

const PASSENGER_DETAIL_LINE = /^(name|id\/passport no|id\/passport|id|passport|gender|type|dob|date of birth|seat)\s*:/im;
const _pendingResumeChoice = new Map();

// ─────────────────────────────────────────────
// CHILD AGE ANSWER PARSER
// Tries to extract a child age from a short reply like:
//   "6", "6 years old", "she's 8", "age 3", "3 and 7"
// Returns array of ages, or null if it doesn't look like an age reply.
// ─────────────────────────────────────────────
function _parseChildAgeAnswer(text) {
  const t = text.trim().toLowerCase();

  // Must be a short reply — long messages are trip prompts, not age answers
  if (t.split(/\s+/).length > 8) return null;

  const ages = [];

  // "6 years old", "6yo", "6yrs"
  const yearOldPattern = /(\d{1,2})\s*[-–]?\s*(?:year[s]?[-\s]?old|yr[s]?[-\s]?old|y\.?o\.?|yrs?)\b/gi;
  let m;
  while ((m = yearOldPattern.exec(t)) !== null) {
    const age = parseInt(m[1], 10);
    if (age >= 0 && age < 18) ages.push(age);
  }

  // "age 6", "aged 3"
  const agedPattern = /aged?\s+(\d{1,2})/gi;
  while ((m = agedPattern.exec(t)) !== null) {
    const age = parseInt(m[1], 10);
    if (age >= 0 && age < 18 && !ages.includes(age)) ages.push(age);
  }

  // Plain numbers: "6", "3 and 7", "3, 7"
  if (ages.length === 0) {
    const nums = t.match(/\b(\d{1,2})\b/g) || [];
    nums.forEach(n => {
      const age = parseInt(n, 10);
      // Only treat as age if plausible (0–17) and not a year
      if (age >= 0 && age < 18) ages.push(age);
    });
  }

  return ages.length > 0 ? ages : null;
}

// ─────────────────────────────────────────────
// VERIFY WEBHOOK
// ─────────────────────────────────────────────
router.get('/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─────────────────────────────────────────────
// INCOMING MESSAGE
// ─────────────────────────────────────────────
router.post('/whatsapp', async (req, res) => {
  res.status(200).send('OK');

  try {
    const body = req.body;

    // ── TOP GUARD: unexpected payload shape ────────────────
    if (!body?.entry?.[0]?.changes?.[0]?.value?.messages) {
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      if (value?.statuses) {
        // Read receipts / delivery updates — ignore silently
      } else {
        logger.warn('Webhook: unexpected payload shape', {
          keys: Object.keys(value || {}).join(','),
        });
      }
      return;
    }

    const message       = body.entry[0].changes[0].value.messages[0];
    const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;

    // ── RESOLVE IDENTITY (phone vs user_id) ────────────────
    const identity = _resolveIdentity(body, message);

    if (!identity.userKey) {
      logger.warn('Webhook: message has no identifiable sender — ignoring', {
        type:      message.type,
        messageId: message.id,
        payload:   JSON.stringify(message).slice(0, 300),
      });
      return;
    }

    logger.info('Incoming WhatsApp message', {
      userKey:   identity.userKey,
      phone:     identity.phone,
      userId:    identity.userId,
      username:  identity.username,
      isBsuid:   identity.isBsuid,
      type:      message.type,
      preview:   message.text?.body?.slice(0, 60),
    });

    const { userKey, phone, userId, username, recipient } = identity;

    // ── INTERACTIVE REPLIES (button/list taps) ─────────────
    if (message.type === 'interactive') {
      const buttonId = message.interactive?.button_reply?.id
        || message.interactive?.list_reply?.id
        || null;

      // ── DISRUPTION TAP ─────────────────────────────────
      if (buttonId && (
        buttonId.startsWith('disruption_alt_') ||
        buttonId.startsWith('disruption_keep_')
      )) {
        logger.info('Disruption tap received', { buttonId, userKey });
        disruptionFlow.handleAlternativeTap(buttonId, userKey).catch(err => {
          logger.error('DisruptionFlow tap handler failed', { buttonId, error: err.message });
        });
        return;
      }

      // ── TAP-TO-REVEAL PHOTO ────────────────────────────
      if (buttonId) {
        const photoMatch = buttonId.match(/^photo_(\d+)$/);
        if (photoMatch) {
          const idx    = parseInt(photoMatch[1], 10);
          const cached = await packageCache.get(userKey);
          const pkg    = cached?.packages?.[idx];
          const imageUrl = pkg?.hotel?.images?.[0];
          if (imageUrl) {
            await whatsappService.sendImage(phoneNumberId, recipient, imageUrl, pkg.hotel.name || null);
          } else {
            await whatsappService.sendText(phoneNumberId, recipient,
              "Sorry, that photo isn't available anymore — try searching again."
            );
          }
          return;
        }
      }

      // Booking flow interactive (gender/type list taps etc.)
      const handledByBooking = await whatsappBookingFlow.handleMessage({
        phoneNumberId, from: userKey, text: null, interactive: message.interactive,
      });
      if (handledByBooking) return;

      await whatsappService.sendText(phoneNumberId, recipient, "Got it, thanks!");
      return;
    }

    // ── CONTACTS WEBHOOK (user shared phone via REQUEST_CONTACT_INFO) ──
    if (message.type === 'contacts') {
      const sharedPhone = message.contacts?.[0]?.phones?.[0]?.phone;
      if (sharedPhone && userId) {
        logger.info('Webhook: user shared phone number via contact button', { userKey, sharedPhone });
        await supabase
          .from('whatsapp_contacts')
          .update({ phone: sharedPhone, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
      }
      return;
    }

    // ── NON-TEXT MESSAGES ──────────────────────────────────
    if (message.type !== 'text') {
      await whatsappService.sendText(phoneNumberId, recipient,
        "Hi! I can help you plan a trip. Just describe what you're looking for — destination, dates, number of travelers and your budget."
      );
      return;
    }

    const prompt = message.text.body;
    const agencyId = await _resolveAgency(phoneNumberId);

    // ── GET OR CREATE CONTACT ──────────────────────────────
    const contact = await _getOrCreateContact({ phone, userId, username, agencyId });

    // ── FIRST-EVER MESSAGE ─────────────────────────────────
    if (contact.justCreated) {
      await whatsappService.sendText(phoneNumberId, recipient,
        `Hey there! 👋 Welcome to Rove.\nThink of me as your personal travel guy, I'll sort out your transportation, stays and transfers\n\nBefore we get into it though, what's your name? I'd rather not just call you "traveler" the whole time`
      );
      return;
    }

    // ── AWAITING NAME ──────────────────────────────────────
    if (contact.awaiting_name) {
      const extractedName = _extractName(prompt);
      if (extractedName) {
        await _saveContactName({ phone, userId, name: extractedName });
        await whatsappService.sendText(phoneNumberId, recipient,
          `Good to meet you, ${extractedName}! Alright — tell me about the trip you're dreaming up. Where to, when, how many of you, and roughly what budget you're working with. I'll handle the rest.`
        );
        return;
      }
      await _clearAwaitingName({ phone, userId });
    }

    // ── DROP-OFF RECOVERY ──────────────────────────────────
    const resumePending = _pendingResumeChoice.get(userKey);
    if (resumePending && Date.now() < resumePending.expiresAt) {
      _pendingResumeChoice.delete(userKey);
      const choice = prompt.trim();
      const wantsResume = choice === '1' || /\b(resume|continue|pick up|yes|go on)\b/i.test(choice);

      if (wantsResume && resumePending.dropOff.hasPreviousSearch) {
        const { cachedPackages, previousDestination } = resumePending.dropOff;
        if (cachedPackages?.length > 0) {
          const destPhrase = previousDestination ? ` for ${_titleCase(previousDestination)}` : '';
          await whatsappService.sendText(phoneNumberId, recipient,
            `Welcome back! Here are the options you were looking at${destPhrase}:`
          );
          await whatsappService.sendPackages(phoneNumberId, recipient, cachedPackages);
          await whatsappService.sendText(phoneNumberId, recipient,
            `Reply with the option number to book, or tell me any changes you'd like.`
          );
          await packageCache.save(userKey, cachedPackages, resumePending.dropOff.previousParams);
          await conversationMemory.upsertContact(userKey, agencyId, { drop_off_at: new Date().toISOString() });
          return;
        }
      }

      await conversationMemory.clearConversation(userKey, agencyId);
      await whatsappBookingFlow.clearSession(userKey);
      await whatsappService.sendText(phoneNumberId, recipient,
        "Fresh start! Tell me about your next trip — where to, when, and how many of you?"
      );
      return;
    }

    // Only check drop-off if the user isn't clearly asking for a new trip
    if (!_looksLikeFreshTripRequest(prompt)) {
      const dropOff = await conversationMemory.checkDropOff(userKey, agencyId);
      if (dropOff.isDropOff) {
        const welcomeMsg = conversationMemory.buildDropOffWelcome({
          minutesAway:         dropOff.minutesAway,
          previousDestination: dropOff.previousDestination,
          hasPreviousSearch:   dropOff.hasPreviousSearch,
        });
        await whatsappService.sendText(phoneNumberId, recipient, welcomeMsg);

        if (dropOff.hasPreviousSearch) {
          _pendingResumeChoice.set(userKey, { dropOff, agencyId, expiresAt: Date.now() + 5 * 60 * 1000 });
        } else {
          await conversationMemory.upsertContact(userKey, agencyId, { drop_off_at: new Date().toISOString() });
        }
        return;
      }
    }

    // ── POST-BOOKING CANCEL FLOW ───────────────────────────
    const handledByCancel = await whatsappCancelFlow.handleMessage({
      phoneNumberId, from: userKey, text: prompt, agencyId,
    });
    if (handledByCancel) return;

    // ── FLIGHT CHANGE FLOW ─────────────────────────────────
    const handledByChange = await whatsappChangeFlow.handleMessage({
      phoneNumberId, from: userKey, text: prompt,
    });
    if (handledByChange) return;

    // ── CONTROL WORD GUARD + MID-BOOKING CANCEL ────────────
    const CONTROL_WORDS = /^(stop|quit|exit|abort|nevermind|never mind|forget it|reset|clear|acha|hapana|no thanks)$/i;
    const isNakedCancel = /^cancel$/i.test(prompt.trim());
    const hasBookingSession = await whatsappBookingFlow.hasActiveSession(userKey);

    if (CONTROL_WORDS.test(prompt.trim()) || (isNakedCancel && !hasBookingSession)) {
      await conversationMemory.clearConversation(userKey, agencyId);
      await conversationMemory.clearLegFlow(userKey, agencyId);
      await whatsappBookingFlow.clearSession(userKey);
      await whatsappService.sendText(phoneNumberId, recipient,
        "Got it — cleared. Just send me a destination whenever you're ready! ✈️"
      );
      return;
    }

    if (isNakedCancel && hasBookingSession) {
      await conversationMemory.cancelMidBooking(userKey, agencyId);
      await whatsappService.sendText(phoneNumberId, recipient,
        "Booking cancelled — no problem at all. Your previous search results are still available if you'd like to pick a different option, or just tell me where you'd like to go!"
      );
      const cached = await packageCache.get(userKey);
      if (cached?.packages?.length > 0) {
        await whatsappService.sendPackages(phoneNumberId, recipient, cached.packages);
        await whatsappService.sendText(phoneNumberId, recipient,
          `Reply with the option number (1-${cached.packages.length}) to book, or describe what you'd like instead.`
        );
      }
      return;
    }

    // ── ACTIVE BOOKING SESSION ─────────────────────────────
    const _looksLikeFreshSearch = (text) => {
      const t = text.trim();
      if (/^(new booking|new search|start over|restart|cancel)$/i.test(t)) return true;
      if (/\b(to|from)\b.{3,}/i.test(t) && t.split(/\s+/).length >= 4) return true;
      if (/\d+\s*nights?\b/i.test(t)) return true;
      if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i.test(t)) return true;
      if (/\d+\s*(st|nd|rd|th)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) return true;
      return false;
    };

    if (_looksLikeFreshSearch(prompt)) {
      if (hasBookingSession) {
        logger.info('Booking session: clearing stale session — fresh search detected', { userKey, preview: prompt.slice(0, 80) });
        await whatsappBookingFlow.clearSession(userKey);
      }
    } else {
      const handledByBooking = await whatsappBookingFlow.handleMessage({
        phoneNumberId, from: userKey, text: prompt, interactive: null,
      });
      if (handledByBooking) return;
    }

    // ═══════════════════════════════════════════════════════
    // LEG FLOW STATE MACHINE
    // ═══════════════════════════════════════════════════════
    const activeLegFlow = await conversationMemory.loadLegFlow(userKey, agencyId);
    if (activeLegFlow) {
      const handled = await _handleLegFlowMessage({
        phoneNumberId, recipient, userKey, agencyId, prompt, activeLegFlow,
      });
      if (handled) return;
    }

    // ── PACKAGE SELECTION (1 / 2 / 3 / 4) ─────────────────
    const selectionMatch = prompt.trim().match(/^(?:option\s*)?([1-4])$/i);
    if (selectionMatch) {
      const cached = await packageCache.get(userKey);
      if (cached?.packages?.length > 0) {
        const idx = parseInt(selectionMatch[1], 10) - 1;
        const selectedPackage = cached.packages[idx];
        if (selectedPackage) {
          if (cached.isStale) {
            await whatsappService.sendText(phoneNumberId, recipient,
              "One moment — just double-checking that's still available before we begin..."
            );
          }
          await conversationMemory.saveSelectedPackage(userKey, agencyId, selectedPackage);

          const isTrain = selectedPackage?.summary?.transportType === 'train'
                       || selectedPackage?.transport?.transportType === 'train';

          if (isTrain) {
            const trainBookingService = require('../services/trainBookingService');
            const bookingRef = `BDL-${Date.now()}`;
            await whatsappService.sendText(phoneNumberId, recipient, `🚆 Booking your SGR ticket now — one moment...`);
            const trainResult = await trainBookingService.book({ bookingRef, agencyId, tripParams: cached.previousParams || {} });
            if (trainResult.success) {
              const refLine = trainResult.krcRef ? `\n\n📋 *KRC Reference: ${trainResult.krcRef}*` : '';
              await whatsappService.sendText(phoneNumberId, recipient,
                `✅ Your SGR ticket has been submitted!${refLine}\n\n📱 *Check your phone* — M-Pesa will prompt you to pay KES ${selectedPackage.summary?.totalPrice?.toLocaleString() || ''}. Enter your PIN within 2 minutes to confirm.\n\nYou'll receive an SMS from Kenya Railways once the payment goes through. Show that SMS at the station to collect your ticket.`
              );
            } else {
              await whatsappService.sendText(phoneNumberId, recipient,
                `⚠️ We couldn't auto-book your SGR ticket this time.\n\nBook directly at: *metickets.krc.co.ke*\nOr call KRC: *0709 388 887*\n\nYour trip details are saved — reply if you need help.`
              );
            }
            return;
          }

          await whatsappBookingFlow.startBooking({ phoneNumberId, from: userKey, agencyId, selectedPackage });
          return;
        }
      }
      await whatsappService.sendText(phoneNumberId, recipient,
        "I don't have a recent list of options for you anymore — could you search again? For example: \"Nairobi to Zanzibar, 3 nights\"."
      );
      return;
    }

    // ── STRAY PASSENGER DETAILS ────────────────────────────
    if (PASSENGER_DETAIL_LINE.test(prompt.trim())) {
      if (!hasBookingSession) {
        await whatsappService.sendText(phoneNumberId, recipient,
          "It looks like you're sending traveler details, but I don't have an active booking for you right now. Please search for a trip first, then reply with the option number to start booking."
        );
        return;
      }
    }

    // ── LOAD CONVERSATION CONTEXT ──────────────────────────
    const memCtx = await conversationMemory.getConversationContext(userKey, agencyId);

    // ═══════════════════════════════════════════════════════
    // CHILD AGE INTERCEPTION
    // If the previous turn asked "how old is the child?" and this
    // reply looks like an age answer, inject it into params and
    // run orchestration with the completed config.
    // ═══════════════════════════════════════════════════════
    if (memCtx.previousParams?.pendingChildAgeCapture) {
      const childAges = _parseChildAgeAnswer(prompt);
      if (childAges) {
        logger.info('Webhook: child age captured from reply', { userKey, childAges });

        const resumedParams = {
          ...memCtx.previousParams,
          childAges,
          children:            Math.max(memCtx.previousParams.children || 0, childAges.length),
          needsChildAge:       false,
          pendingChildAgeCapture: false,
        };

        await whatsappService.sendText(phoneNumberId, recipient, _pickAcknowledgment());

        const result = await orchestrationEngine.orchestrate(null, agencyId, {
          conversationHistory: memCtx.conversationHistory,
          previousParams:      resumedParams,
          skipParsing:         true,
          channel:             'whatsapp',
          phone:               phone || userKey,
        });

        await conversationMemory.saveTurn(userKey, agencyId, {
          userMessage:    prompt,
          engineResponse: result.text,
          tripParams:     result.tripParams,
          packages:       result.packages || [],
          sessionId:      result.sessionId,
        });

        await _sendOrchestrationResult({ phoneNumberId, recipient, userKey, result });
        return;
      }

      // Reply didn't look like an age — could be a new trip prompt.
      // Clear the pending flag and fall through to normal orchestration.
      logger.info('Webhook: pendingChildAgeCapture set but reply was not an age — falling through', {
        userKey, preview: prompt.slice(0, 60),
      });
      // Don't clear previousParams here — let normal orchestration handle it
    }

    // ── ORIGIN CLARIFICATION RESUME ───────────────────────
    if (memCtx.previousParams?.needsOriginClarification && !memCtx.previousParams?.origin) {
      const candidateOrigin = prompt.trim();
      const looksLikePlace =
        candidateOrigin.split(/\s+/).length <= 3 &&
        !/\d+\s*nights?\b/i.test(candidateOrigin) &&
        !/\bto\b.{3,}/i.test(candidateOrigin) &&
        !/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i.test(candidateOrigin);

      if (looksLikePlace) {
        logger.info('Clarification resume: injecting origin from reply', {
          userKey, origin: candidateOrigin, previousDestination: memCtx.previousParams.destination,
        });
        await whatsappService.sendText(phoneNumberId, recipient, _pickAcknowledgment());

        const resumedParams = {
          ...memCtx.previousParams,
          origin: candidateOrigin.replace(/\.$/, '').trim(),
          needsOriginClarification: false,
        };

        const result = await orchestrationEngine.orchestrate(null, agencyId, {
          conversationHistory: memCtx.conversationHistory,
          previousParams:      resumedParams,
          skipParsing:         true,
          channel:             'whatsapp',
          phone:               phone || userKey,
        });

        await conversationMemory.saveTurn(userKey, agencyId, {
          userMessage: prompt, engineResponse: result.text, tripParams: result.tripParams,
          packages: result.packages || [], sessionId: result.sessionId,
        });

        if (result.needsClarification) {
          await whatsappService.sendText(phoneNumberId, recipient, result.text);
          return;
        }

        await whatsappService.sendText(phoneNumberId, recipient, result.text);
        if (result.packages?.length > 0) {
          await whatsappService.sendPackages(phoneNumberId, recipient, result.packages);
          await packageCache.save(userKey, result.packages, result.tripParams);
          await whatsappService.sendText(phoneNumberId, recipient,
            `Reply with the option number (1-${result.packages.length}) to book that option.`
          );
        }
        return;
      }
    }

    // ── MID-CONVERSATION MODIFY ────────────────────────────
    if (memCtx.selectedPackage) {
      const intent = orchestrationEngine._detectIntent(prompt, memCtx.previousParams);
      const hasAdjustments = Object.keys(intent.adjustments || {}).length > 0;
      if (intent.isFollowUp && hasAdjustments) {
        const modifyResult = await conversationMemory.handleModify(userKey, agencyId, intent, memCtx.previousParams);
        if (modifyResult.action === 'patch') {
          const pkg = modifyResult.updatedPackage;
          const nights = intent.adjustments.nights;
          await whatsappService.sendText(phoneNumberId, recipient, `Updated to *${nights} nights* — here's your revised package:`);
          await whatsappService.sendPackages(phoneNumberId, recipient, [pkg]);
          await whatsappService.sendText(phoneNumberId, recipient, "Reply *book* to proceed, or tell me anything else you'd like to change.");
          await conversationMemory.saveTurn(userKey, agencyId, {
            userMessage: prompt, engineResponse: `Updated to ${nights} nights`,
            tripParams: modifyResult.updatedParams, packages: [pkg],
          });
          return;
        }
      }
    }

    // ── NORMAL ORCHESTRATION ───────────────────────────────
    if (activeLegFlow) {
      logger.info('LegFlow: user sent fresh search — clearing active flow', { userKey });
      await conversationMemory.clearLegFlow(userKey, agencyId);
    }

    await whatsappService.sendText(phoneNumberId, recipient, _pickAcknowledgment());
    logger.info('Webhook: calling orchestrationEngine...', { userKey, prompt: prompt.slice(0, 80) });

    const result = await orchestrationEngine.orchestrate(prompt, agencyId, {
      conversationHistory: memCtx.conversationHistory,
      previousParams:      memCtx.previousParams,
      channel:             'whatsapp',
      phone:               phone || userKey,
    });

    logger.info('Webhook: orchestration returned', {
      userKey,
      hasText:            !!result.text,
      textLength:         result.text?.length,
      packagesCount:      result.packages?.length,
      tripResultsCount:   result.tripResults?.length,
      isClassifiedTrip:   result.isClassifiedTrip,
      needsClarification: result.needsClarification,
      needsChildAge:      result.tripParams?.needsChildAge,
    });

    // ── CHILD AGE INTERCEPTION — after orchestration parse ─
    // If orchestration parsed the prompt and found a child mention
    // with no age, intercept here before sending results.
    if (result.tripParams?.needsChildAge && !result.tripParams?.childAges?.length) {
      logger.info('Webhook: needsChildAge detected — asking before search', { userKey });

      const childCount = result.tripParams.children || 1;
      const question = childCount > 1
        ? `How old are the children? (e.g. "6 and 8")`
        : `How old is the child?`;

      // Save params with pending flag so the next turn knows to inject the age
      await conversationMemory.saveTurn(userKey, agencyId, {
        userMessage:    prompt,
        engineResponse: question,
        tripParams: {
          ...result.tripParams,
          pendingChildAgeCapture: true,
        },
        packages:  [],
        sessionId: result.sessionId,
      });

      await whatsappService.sendText(phoneNumberId, recipient, question);
      return;
    }

    // ── SEND RESULTS (fire-and-forget memory save) ─────────
    conversationMemory.saveTurn(userKey, agencyId, {
      userMessage:    prompt,
      engineResponse: result.text,
      tripParams:     result.tripParams,
      packages:       result.packages || [],
      sessionId:      result.sessionId,
    }).catch(err => logger.error('Webhook: saveTurn failed (non-blocking)', { error: err.message, userKey }));

    // ── TRAIN WARM-UP ──────────────────────────────────────
    if (result.packages?.length > 0) {
      const hasTrain = result.packages.some(p =>
        p.summary?.transportType === 'train' || p.transport?.transportType === 'train'
      );
      if (hasTrain && result.tripParams?.origin && result.tripParams?.destination) {
        const trainBookingService = require('../services/trainBookingService');
        const pendingRef = `TRN-${Date.now()}`;
        trainBookingService.warmUp(result.tripParams, pendingRef);
        logger.info('Train warm-up triggered', { userKey, pendingRef });
      }
    }

    await _sendOrchestrationResult({ phoneNumberId, recipient, userKey, result });

  } catch (error) {
    logger.error('WhatsApp webhook error', { error: error.message, stack: error.stack });
  }
});

// ─────────────────────────────────────────────
// SEND ORCHESTRATION RESULT
// Extracted so both the normal path and the child-age-resume
// path can share the same send logic without duplication.
// ─────────────────────────────────────────────
async function _sendOrchestrationResult({ phoneNumberId, recipient, userKey, result }) {

  if (result.needsClarification) {
    logger.info('Webhook: sending clarification', { userKey, textPreview: result.text?.slice(0, 60) });
    await whatsappService.sendText(phoneNumberId, recipient, result.text);
    return;
  }

  // ── CLASSIFIED TRIP → LEG FLOW ─────────────────────────
  if (result.isClassifiedTrip && result.tripResults?.length > 0) {
    const actionableLegs = result.tripResults.filter(r => r.packages?.length > 0);
    if (actionableLegs.length === 0) {
      await whatsappService.sendText(phoneNumberId, recipient,
        "I searched your whole trip but couldn't find options for any of the legs. Try adjusting your dates or destinations."
      );
      return;
    }

    const tripGroups = [];
    let currentGroup = [];
    for (const leg of actionableLegs) {
      if (leg.role === 'arrival' && currentGroup.length > 0) {
        tripGroups.push(currentGroup);
        currentGroup = [leg];
      } else {
        currentGroup.push(leg);
      }
    }
    if (currentGroup.length > 0) tripGroups.push(currentGroup);

    if (tripGroups.length > 1) {
      for (let t = 0; t < tripGroups.length; t++) {
        const group = tripGroups[t];
        const dest = group[0]?.label?.split('→')[1]?.trim() || `Trip ${t + 1}`;
        const groupPackages = group.flatMap(r => r.packages);

        await whatsappService.sendText(phoneNumberId, recipient,
          `✈️ *Trip ${t + 1} — ${_titleCase(dest)}*\n━━━━━━━━━━━━━━━━`
        );

        if (group.length === 1) {
          await whatsappService.sendPackages(phoneNumberId, recipient, group[0].packages);
          await packageCache.save(userKey, groupPackages, result.tripParams);
          await whatsappService.sendText(phoneNumberId, recipient,
            `Reply *1*${group[0].packages.length > 1 ? `–*${group[0].packages.length}*` : ''} to select your option for this trip.`
          );
        } else {
          const flow = await conversationMemory.startLegFlow(userKey, result.agencyId || null, {
            legs: group, tripParams: result.tripParams,
          });
          if (flow) {
            await whatsappService.sendText(phoneNumberId, recipient,
              `I'll walk you through *${group.length} legs* for this trip. Pick an option for each leg.`
            );
            await _sendCurrentLeg(phoneNumberId, recipient, flow);
          } else {
            await whatsappService.sendPackages(phoneNumberId, recipient, groupPackages);
            await packageCache.save(userKey, groupPackages, result.tripParams);
          }
        }

        if (t < tripGroups.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          await whatsappService.sendText(phoneNumberId, recipient,
            `─────────────────\nNow let's sort *Trip ${t + 2}*:`
          );
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      const allPackages = actionableLegs.flatMap(r => r.packages);
      await packageCache.save(userKey, allPackages, result.tripParams);
      return;
    }

    const allPackages = actionableLegs.flatMap(r => r.packages);
    await packageCache.save(userKey, allPackages, result.tripParams);

    if (actionableLegs.length === 1) {
      await whatsappService.sendText(phoneNumberId, recipient, result.text);
      await whatsappService.sendPackages(phoneNumberId, recipient, actionableLegs[0].packages);
      await whatsappService.sendText(phoneNumberId, recipient,
        `Reply with the option number (1-${actionableLegs[0].packages.length}) to book.`
      );
      return;
    }

    const flow = await conversationMemory.startLegFlow(userKey, result.agencyId || null, {
      legs: actionableLegs, tripParams: result.tripParams,
    });
    if (!flow) {
      await whatsappService.sendText(phoneNumberId, recipient, result.text);
      await whatsappService.sendPackages(phoneNumberId, recipient, allPackages);
      return;
    }

    const totalLegs = flow.legs.length;
    const tripSummary = result.tripParams?.destination || 'your trip';
    await whatsappService.sendText(phoneNumberId, recipient,
      `✅ Found options for all *${totalLegs} legs* of your trip to *${_titleCase(tripSummary)}*.\n\nI'll walk you through one leg at a time.`
    );
    await _sendCurrentLeg(phoneNumberId, recipient, flow);
    return;
  }

  // ── MULTI-TRIP RESULTS ─────────────────────────────────
  if (result.tripResults && result.tripResults.length > 1) {
    logger.info('Webhook: sending multi-trip results', { userKey, tripCount: result.tripResults.length });
    const allPackages = [];
    for (let i = 0; i < result.tripResults.length; i++) {
      const trip = result.tripResults[i];
      const introLine = i === 0
        ? `Here are options for *Trip 1 — ${trip.label}*:`
        : `And here are options for *Trip ${i + 1} — ${trip.label}*:`;
      await whatsappService.sendText(phoneNumberId, recipient, introLine);
      if (trip.packages?.length > 0) {
        await whatsappService.sendPackages(phoneNumberId, recipient, trip.packages);
        allPackages.push(...trip.packages);
      } else {
        await whatsappService.sendText(phoneNumberId, recipient, `Sorry, I couldn't find any options for ${trip.label}.`);
      }
    }
    if (allPackages.length > 0) {
      await packageCache.save(userKey, allPackages, result.tripParams);
      await whatsappService.sendText(phoneNumberId, recipient,
        `Reply with the option number (1-${allPackages.length}) to book any of the above.`
      );
    }
    return;
  }

  // ── SINGLE-TRIP RESULTS ────────────────────────────────
  logger.info('Webhook: sending single-trip results', { userKey, hasText: !!result.text, packages: result.packages?.length });

  const textToSend = result.text || "Here are some options I found for you:";
  await whatsappService.sendText(phoneNumberId, recipient, textToSend);

  if (result.packages?.length > 0) {
    logger.info('Webhook: sending packages', { userKey, count: result.packages.length });
    await whatsappService.sendPackages(phoneNumberId, recipient, result.packages);
    await packageCache.save(userKey, result.packages, result.tripParams);
    await whatsappService.sendText(phoneNumberId, recipient,
      `Reply with the option number (1-${result.packages.length}) to book that option.`
    );
  } else {
    logger.warn('Webhook: no packages to send', { userKey, resultKeys: Object.keys(result) });
  }
}

// ═════════════════════════════════════════════════════════════
// LEG FLOW MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════
async function _handleLegFlowMessage({ phoneNumberId, recipient, userKey, agencyId, prompt, activeLegFlow }) {
  const flow = activeLegFlow;
  const trimmed = prompt.trim();

  const isAbandonment = /\b(start over|new search|fresh start|forget it|cancel|restart|different trip)\b/i.test(trimmed);
  if (isAbandonment) {
    await conversationMemory.clearLegFlow(userKey, agencyId);
    return false;
  }

  const currentLeg = flow.legs[flow.currentLegIndex];
  if (!currentLeg) {
    await conversationMemory.clearLegFlow(userKey, agencyId);
    return false;
  }

  if (/\b(show all|all legs|whole trip|see all|overview)\b/i.test(trimmed)) {
    const remaining = flow.legs.slice(flow.currentLegIndex);
    await whatsappService.sendText(phoneNumberId, recipient,
      `You're on leg *${flow.currentLegIndex + 1} of ${flow.legs.length}*. Here's what's coming:\n\n` +
      remaining.map((l, i) => `*${flow.currentLegIndex + i + 1}.* ${l.roleLabel || l.label}`).join('\n') +
      `\n\nReply with your option choice (1–${currentLeg.packages.length}) to continue.`
    );
    return true;
  }

  const selectionMatch = trimmed.match(/^(?:option\s*)?([1-4])$/i);
  if (selectionMatch) {
    const optionNum = parseInt(selectionMatch[1], 10);
    const selectedPackage = currentLeg.packages[optionNum - 1];
    if (!selectedPackage) {
      await whatsappService.sendText(phoneNumberId, recipient,
        `I only have ${currentLeg.packages.length} option${currentLeg.packages.length > 1 ? 's' : ''} for this leg. Reply *1*${currentLeg.packages.length > 1 ? `–*${currentLeg.packages.length}*` : ''} to choose.`
      );
      return true;
    }

    const updatedFlow = await conversationMemory.saveLegSelection(userKey, agencyId, {
      legIndex: flow.currentLegIndex, selectedPackage,
    });
    if (!updatedFlow) {
      await whatsappService.sendText(phoneNumberId, recipient, "Something went wrong saving your choice — please try again.");
      return true;
    }

    const legPrice = selectedPackage.summary?.totalPrice || 0;
    const legCurrency = selectedPackage.summary?.currency || 'KES';
    await whatsappService.sendText(phoneNumberId, recipient,
      `✅ Got it — *Option ${optionNum}* selected for *${currentLeg.roleLabel || currentLeg.label}* (${legCurrency} ${legPrice.toLocaleString()})`
    );

    if (!updatedFlow.active) {
      const allSelected = Object.values(updatedFlow.selections).map(s => s.package);
      await packageCache.save(userKey, allSelected, updatedFlow.tripParams);
      const finalSummary = conversationMemory.buildFinalLegSummary(updatedFlow);
      await whatsappService.sendText(phoneNumberId, recipient, finalSummary);
      await conversationMemory.clearLegFlow(userKey, agencyId);
      return true;
    }

    const summaryBlock = conversationMemory.getLegFlowSummary(updatedFlow);
    if (summaryBlock) await whatsappService.sendText(phoneNumberId, recipient, summaryBlock);
    await new Promise(resolve => setTimeout(resolve, 800));
    await _sendCurrentLeg(phoneNumberId, recipient, flow);
    return true;
  }

  const looksLikeModification = /\b(cheaper|different|another|change|morning|evening|upgrade|luxury|budget|hotel|flight|bus)\b/i.test(trimmed);
  if (looksLikeModification) {
    await whatsappService.sendText(phoneNumberId, recipient,
      `Here are the options again for *${currentLeg.roleLabel || currentLeg.label}* — reply with *1*${currentLeg.packages.length > 1 ? `–*${currentLeg.packages.length}*` : ''} to choose:`
    );
    await whatsappService.sendLegPackages(phoneNumberId, recipient, {
      leg: currentLeg, legIndex: flow.currentLegIndex, totalLegs: flow.legs.length, runningTotalKES: flow.runningTotalKES || 0,
    });
    return true;
  }

  const looksLikeFreshSearch = trimmed.split(/\s+/).length > 6
    || /\bto\b.{2,30}\bfrom\b/i.test(trimmed)
    || /\d+\s*nights?\b/i.test(trimmed);

  if (looksLikeFreshSearch) {
    logger.info('LegFlow: message looks like fresh search — abandoning flow', { userKey, preview: trimmed.slice(0, 80) });
    await conversationMemory.clearLegFlow(userKey, agencyId);
    return false;
  }

  await whatsappService.sendText(phoneNumberId, recipient,
    `We're working through your trip leg by leg. Reply with *1*${currentLeg.packages.length > 1 ? `–*${currentLeg.packages.length}*` : ''} to pick an option for *${currentLeg.roleLabel || currentLeg.label}*.\n\nSay "show all" to see all remaining legs, or "start over" for a new search.`
  );
  return true;
}

// ─────────────────────────────────────────────
// SEND CURRENT LEG
// ─────────────────────────────────────────────
async function _sendCurrentLeg(phoneNumberId, recipient, flow) {
  const leg = flow.legs[flow.currentLegIndex];
  if (!leg) return;
  await whatsappService.sendLegPackages(phoneNumberId, recipient, {
    leg, legIndex: flow.currentLegIndex, totalLegs: flow.legs.length, runningTotalKES: flow.runningTotalKES || 0,
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function _looksLikeFreshTripRequest(text) {
  const t = text.trim().toLowerCase();
  if (
    /\b(plan|book|find|search|looking for|help me|i want|i'd like|i would like|can you help)\b/.test(t) &&
    /\b(trip|travel|flight|hotel|holiday|vacation|visit|go to|fly to)\b/.test(t)
  ) return true;
  if (/\bto\b.{3,}/i.test(t) && t.split(/\s+/).length >= 4) return true;
  if (/\d+\s*nights?\b/i.test(t)) return true;
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d/i.test(t)) return true;
  return false;
}

function _resolveIdentity(body, message) {
  const value    = body.entry[0].changes[0].value;
  const contacts = value.contacts || [];

  const phone     = message.from || contacts[0]?.wa_id || null;
  const rawUserId = message.from_user_id || contacts[0]?.user_id || null;
  const userId    = rawUserId || null;
  const username  = contacts[0]?.profile?.username || contacts[0]?.profile?.name || null;
  const userKey   = userId || phone || null;
  const isBsuid   = !phone && !!rawUserId;
  const recipient = phone || rawUserId || null;

  return { phone, userId, rawUserId, username, userKey, isBsuid, recipient };
}

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

async function _getOrCreateContact({ phone, userId, username, agencyId }) {
  if (phone && !userId && username) {
    const { data: anonymousContact, error: mergeErr } = await supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('username', username)
      .is('phone', null)
      .not('user_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (mergeErr) logger.error('whatsapp_contacts merge lookup failed', { error: mergeErr.message, username });

    if (anonymousContact) {
      logger.info('whatsapp_contacts: merging anonymous user_id contact with new phone', {
        userId: anonymousContact.user_id, phone,
      });
      const { error: updateErr } = await supabase
        .from('whatsapp_contacts')
        .update({ phone, agency_id: agencyId || anonymousContact.agency_id })
        .eq('id', anonymousContact.id);

      if (updateErr) {
        logger.error('whatsapp_contacts merge update failed', { error: updateErr.message });
      } else {
        return { ...anonymousContact, phone, agency_id: agencyId || anonymousContact.agency_id, justCreated: false };
      }
    }
  }

  if (phone) {
    const { data: byPhone, error: phoneErr } = await supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();

    if (phoneErr) logger.error('whatsapp_contacts lookup by phone failed', { error: phoneErr.message, phone });

    if (byPhone) {
      if (userId && !byPhone.user_id) {
        supabase.from('whatsapp_contacts').update({ user_id: userId }).eq('phone', phone)
          .then(() => {}).catch(err => logger.error('whatsapp_contacts user_id backfill failed', { error: err.message }));
      }
      if (!byPhone.agency_id && agencyId) {
        supabase.from('whatsapp_contacts').update({ agency_id: agencyId }).eq('phone', phone)
          .then(() => {}).catch(err => logger.error('whatsapp_contacts agency_id backfill failed', { error: err.message }));
      }
      return { ...byPhone, justCreated: false };
    }
  }

  if (userId) {
    const { data: byUserId, error: userIdErr } = await supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (userIdErr) logger.error('whatsapp_contacts lookup by user_id failed', { error: userIdErr.message, userId });

    if (byUserId) {
      if (phone && !byUserId.phone) {
        supabase.from('whatsapp_contacts').update({ phone }).eq('user_id', userId)
          .then(() => {}).catch(err => logger.error('whatsapp_contacts phone backfill failed', { error: err.message }));
      }
      if (!byUserId.agency_id && agencyId) {
        supabase.from('whatsapp_contacts').update({ agency_id: agencyId }).eq('user_id', userId)
          .then(() => {}).catch(err => logger.error('whatsapp_contacts agency_id backfill failed', { error: err.message }));
      }
      return { ...byUserId, justCreated: false };
    }
  }

  const insertPayload = {
    phone:         phone || null,
    user_id:       userId || null,
    username:      username || null,
    name:          username || null,
    awaiting_name: !username,
    agency_id:     agencyId || null,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('whatsapp_contacts')
    .insert(insertPayload)
    .select()
    .single();

  if (insertError) {
    logger.error('whatsapp_contacts insert failed', { error: insertError.message, phone, userId });
    return { justCreated: false, awaiting_name: false, name: username || null, conversation_history: [], previous_params: null };
  }

  return { ...inserted, justCreated: true, awaiting_name: !username, name: username || null };
}

async function _saveContactName({ phone, userId, name }) {
  const query = supabase.from('whatsapp_contacts').update({
    name, awaiting_name: false, updated_at: new Date().toISOString(),
  });
  if (phone) {
    const { error } = await query.eq('phone', phone);
    if (error) logger.error('whatsapp_contacts name save by phone failed', { error: error.message, phone });
  } else if (userId) {
    const { error } = await query.eq('user_id', userId);
    if (error) logger.error('whatsapp_contacts name save by user_id failed', { error: error.message, userId });
  }
}

async function _clearAwaitingName({ phone, userId }) {
  const query = supabase.from('whatsapp_contacts').update({
    awaiting_name: false, updated_at: new Date().toISOString(),
  });
  if (phone) {
    const { error } = await query.eq('phone', phone);
    if (error) logger.error('whatsapp_contacts awaiting_name clear by phone failed', { error: error.message, phone });
  } else if (userId) {
    const { error } = await query.eq('user_id', userId);
    if (error) logger.error('whatsapp_contacts awaiting_name clear by user_id failed', { error: error.message, userId });
  }
}

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
  return cleaned.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function _titleCase(str) {
  if (!str) return '';
  return String(str).replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = router;