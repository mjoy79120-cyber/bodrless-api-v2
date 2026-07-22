/**
 * WEBHOOK ROUTES
 * ─────────────────────────────────────────────────────────────
 * Handles incoming messages from WhatsApp Business API.
 *
 * Flow:
 * Traveler messages agency WhatsApp
 * → WhatsApp sends webhook to Bodrless
 * → First-ever message: send welcome, ask name, stop
 * → Awaiting name: capture it, greet, stop
 * → Drop-off recovery: returning traveler after 30+ min gap —
 *   offer resume vs fresh start before anything else runs
 * → Resume/fresh choice: re-show cached packages or clear and start over
 * → Disruption tap (disruption_alt_* / disruption_keep_*) — handled
 *   by disruptionFlow before any other button handler
 * → Cancellation flow (post-booking cancel with ref)
 * → Flight change flow
 * → Active booking session (passenger detail collection)
 * → Mid-booking cancel ("cancel" while in booking flow) —
 *   clears session, preserves context, re-shows packages
 * → LEG FLOW (multi-leg trip, one leg at a time):
 *     • Active leg flow + option selection → save leg, show running
 *       total, advance to next leg OR show final summary
 *     • Active leg flow + non-numeric message → treat as leg
 *       modification or let user ask to restart
 * → Package selection (1/2/3/4) → start booking
 * → Mid-conversation modify (change nights/budget/hotel while
 *   a package is held) — patch in place or re-search
 * → Normal orchestration with durable conversation memory
 *   → if result.isClassifiedTrip → start leg flow, present leg 1
 *   → otherwise → send packages normally
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

const PASSENGER_DETAIL_LINE = /^(name|id\/passport no|id\/passport|id|passport|gender|phone|email|dob|date of birth)\s*:/im;

// Short-lived in-memory map for the resume/fresh-start choice.
const _pendingResumeChoice = new Map();

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
    if (!body?.entry?.[0]?.changes?.[0]?.value?.messages) return;

    const message       = body.entry[0].changes[0].value.messages[0];
    const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id;
    const from          = message.from;

    logger.info('Incoming WhatsApp message', { from, type: message.type });

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
        logger.info('Disruption tap received', { buttonId, from });
        disruptionFlow.handleAlternativeTap(buttonId, from).catch(err => {
          logger.error('DisruptionFlow tap handler failed', { buttonId, error: err.message });
        });
        return;
      }

      // ── TAP-TO-REVEAL PHOTO ────────────────────────────
      if (buttonId) {
        const photoMatch = buttonId.match(/^photo_(\d+)$/);
        if (photoMatch) {
          const idx    = parseInt(photoMatch[1], 10);
          const cached = await packageCache.get(from);
          const pkg    = cached?.packages?.[idx];
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

      // Booking flow interactive (gender/type list taps etc.)
      const handledByBooking = await whatsappBookingFlow.handleMessage({
        phoneNumberId, from, text: null, interactive: message.interactive,
      });
      if (handledByBooking) return;

      await whatsappService.sendText(phoneNumberId, from, "Got it, thanks!");
      return;
    }

    // ── NON-TEXT MESSAGES ──────────────────────────────────
    if (message.type !== 'text') {
      await whatsappService.sendText(phoneNumberId, from,
        "Hi! I can help you plan a trip. Just describe what you're looking for — destination, dates, number of travelers and your budget."
      );
      return;
    }

    const prompt   = message.text.body;
    const agencyId = await _resolveAgency(phoneNumberId);
    const contact  = await _getOrCreateContact(from, agencyId);

    // ── FIRST-EVER MESSAGE ─────────────────────────────────
    if (contact.justCreated) {
      await whatsappService.sendText(phoneNumberId, from,
        `Hey there! 👋 Welcome to Rove.\nThink of me as your personal travel guy, I'll sort out your transportation, stays and transfers\n\nBefore we get into it though, what's your name? I'd rather not just call you "traveler" the whole time`
      );
      return;
    }

    // ── AWAITING NAME ──────────────────────────────────────
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

    // ── DROP-OFF RECOVERY ──────────────────────────────────
    const resumePending = _pendingResumeChoice.get(from);
    if (resumePending && Date.now() < resumePending.expiresAt) {
      _pendingResumeChoice.delete(from);
      const choice = prompt.trim();

      const wantsResume = choice === '1' || /\b(resume|continue|pick up|yes|go on)\b/i.test(choice);

      if (wantsResume && resumePending.dropOff.hasPreviousSearch) {
        const { cachedPackages, previousDestination } = resumePending.dropOff;

        if (cachedPackages?.length > 0) {
          const destPhrase = previousDestination ? ` for ${_titleCase(previousDestination)}` : '';
          await whatsappService.sendText(phoneNumberId, from,
            `Welcome back! Here are the options you were looking at${destPhrase}:`
          );
          await whatsappService.sendPackages(phoneNumberId, from, cachedPackages);
          await whatsappService.sendText(phoneNumberId, from,
            `Reply with the option number to book, or tell me any changes you'd like.`
          );
          await packageCache.save(from, cachedPackages, resumePending.dropOff.previousParams);
          await conversationMemory.upsertContact(from, agencyId, {
            drop_off_at: new Date().toISOString(),
          });
          return;
        }
      }

      await conversationMemory.clearConversation(from, agencyId);
      await whatsappService.sendText(phoneNumberId, from,
        "Fresh start! Tell me about your next trip — where to, when, and how many of you?"
      );
      return;
    }

    const dropOff = await conversationMemory.checkDropOff(from, agencyId);
    if (dropOff.isDropOff) {
      const welcomeMsg = conversationMemory.buildDropOffWelcome({
        minutesAway:         dropOff.minutesAway,
        previousDestination: dropOff.previousDestination,
        hasPreviousSearch:   dropOff.hasPreviousSearch,
      });
      await whatsappService.sendText(phoneNumberId, from, welcomeMsg);

      if (dropOff.hasPreviousSearch) {
        _pendingResumeChoice.set(from, {
          dropOff,
          agencyId,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
      } else {
        await conversationMemory.upsertContact(from, agencyId, {
          drop_off_at: new Date().toISOString(),
        });
      }
      return;
    }

    // ── POST-BOOKING CANCEL FLOW ───────────────────────────
    const handledByCancel = await whatsappCancelFlow.handleMessage({
      phoneNumberId, from, text: prompt, agencyId,
    });
    if (handledByCancel) return;

    // ── FLIGHT CHANGE FLOW ─────────────────────────────────
    const handledByChange = await whatsappChangeFlow.handleMessage({
      phoneNumberId, from, text: prompt,
    });
    if (handledByChange) return;

    // ── MID-BOOKING CANCEL ─────────────────────────────────
    if (/^cancel$/i.test(prompt.trim())) {
      const hadSession = await whatsappBookingFlow.hasActiveSession(from);
      if (hadSession) {
        await conversationMemory.cancelMidBooking(from, agencyId);
        await whatsappService.sendText(phoneNumberId, from,
          "Booking cancelled — no problem at all. Your previous search results are still available if you'd like to pick a different option, or just tell me where you'd like to go!"
        );
        const cached = await packageCache.get(from);
        if (cached?.packages?.length > 0) {
          await whatsappService.sendPackages(phoneNumberId, from, cached.packages);
          await whatsappService.sendText(phoneNumberId, from,
            `Reply with the option number (1-${cached.packages.length}) to book, or describe what you'd like instead.`
          );
        }
        return;
      }
    }

    // ── ACTIVE BOOKING SESSION ─────────────────────────────
    const handledByBooking = await whatsappBookingFlow.handleMessage({
      phoneNumberId, from, text: prompt, interactive: null,
    });
    if (handledByBooking) return;

    // ═══════════════════════════════════════════════════════
    // LEG FLOW STATE MACHINE
    // ─────────────────────────────────────────────────────
    // Checked BEFORE package selection so that "1" during an
    // active leg flow selects a LEG OPTION, not a full package
    // from the global cache. The leg flow takes priority.
    // ═══════════════════════════════════════════════════════
    const activeLegFlow = await conversationMemory.loadLegFlow(from, agencyId);

    if (activeLegFlow) {
      const handled = await _handleLegFlowMessage({
        phoneNumberId, from, agencyId, prompt, activeLegFlow,
      });
      if (handled) return;
      // If _handleLegFlowMessage returned false, the user sent
      // something that doesn't look like a leg selection (e.g. a
      // fresh trip search) — fall through to normal orchestration,
      // which will clear the leg flow and start fresh.
    }

    // ─────────────────────────────────────────────────────
    // END LEG FLOW STATE MACHINE
    // ═══════════════════════════════════════════════════════

    // ── PACKAGE SELECTION (1 / 2 / 3 / 4) ─────────────────
    const selectionMatch = prompt.trim().match(/^(?:option\s*)?([1-4])$/i);
    if (selectionMatch) {
      const cached = await packageCache.get(from);
      if (cached?.packages?.length > 0) {
        const idx             = parseInt(selectionMatch[1], 10) - 1;
        const selectedPackage = cached.packages[idx];
        if (selectedPackage) {
          if (cached.isStale) {
            await whatsappService.sendText(phoneNumberId, from,
              "One moment — just double-checking that's still available before we begin..."
            );
          }
          await conversationMemory.saveSelectedPackage(from, agencyId, selectedPackage);
          await whatsappBookingFlow.startBooking({ phoneNumberId, from, agencyId, selectedPackage });
          return;
        }
      }
      await whatsappService.sendText(phoneNumberId, from,
        "I don't have a recent list of options for you anymore — could you search again? For example: \"Nairobi to Zanzibar, 3 nights\"."
      );
      return;
    }

    // ── STRAY PASSENGER DETAILS ────────────────────────────
    if (PASSENGER_DETAIL_LINE.test(prompt.trim())) {
      const hasSession = await whatsappBookingFlow.hasActiveSession(from);
      if (!hasSession) {
        await whatsappService.sendText(phoneNumberId, from,
          "It looks like you're sending traveler details, but I don't have an active booking for you right now. Please search for a trip first, then reply with the option number to start booking."
        );
        return;
      }
    }

    // ── MID-CONVERSATION MODIFY ────────────────────────────
    const memCtx = await conversationMemory.getConversationContext(from, agencyId);

    if (memCtx.selectedPackage) {
      const intent = orchestrationEngine._detectIntent(prompt, memCtx.previousParams);
      const hasAdjustments = Object.keys(intent.adjustments || {}).length > 0;

      if (intent.isFollowUp && hasAdjustments) {
        const modifyResult = await conversationMemory.handleModify(
          from, agencyId, intent, memCtx.previousParams
        );

        if (modifyResult.action === 'patch') {
          const pkg    = modifyResult.updatedPackage;
          const nights = intent.adjustments.nights;
          await whatsappService.sendText(phoneNumberId, from,
            `Updated to *${nights} nights* — here's your revised package:`
          );
          await whatsappService.sendPackages(phoneNumberId, from, [pkg]);
          await whatsappService.sendText(phoneNumberId, from,
            "Reply *book* to proceed, or tell me anything else you'd like to change."
          );
          await conversationMemory.saveTurn(from, agencyId, {
            userMessage:    prompt,
            engineResponse: `Updated to ${nights} nights`,
            tripParams:     modifyResult.updatedParams,
            packages:       [pkg],
          });
          return;
        }
        // 'research' — fall through to normal orchestrate()
      }
    }

    // ── NORMAL ORCHESTRATION ───────────────────────────────
    // Any active leg flow is implicitly abandoned when the user
    // sends a fresh search — clear it so state doesn't bleed.
    if (activeLegFlow) {
      logger.info('LegFlow: user sent fresh search — clearing active flow', { from });
      await conversationMemory.clearLegFlow(from, agencyId);
    }

    await whatsappService.sendText(phoneNumberId, from, _pickAcknowledgment());

    const result = await orchestrationEngine.orchestrate(prompt, agencyId, {
      conversationHistory: memCtx.conversationHistory,
      previousParams:      memCtx.previousParams,
      channel:             'whatsapp',
      phone:               from,
    });

    // ── SAVE TO DURABLE MEMORY ─────────────────────────────
    await conversationMemory.saveTurn(from, agencyId, {
      userMessage:    prompt,
      engineResponse: result.text,
      tripParams:     result.tripParams,
      packages:       result.packages || [],
      sessionId:      result.sessionId,
    });

    // ── SEND RESULTS ───────────────────────────────────────
    if (result.needsClarification) {
      await whatsappService.sendText(phoneNumberId, from, result.text);
      return;
    }

    // ── CLASSIFIED TRIP → START LEG FLOW ──────────────────
    // Engine returned a multi-leg classified trip.
    // Instead of dumping all legs at once, start the leg flow
    // and present only the first leg.
    if (result.isClassifiedTrip && result.tripResults?.length > 0) {
      const actionableLegs = result.tripResults.filter(r => r.packages?.length > 0);

      if (actionableLegs.length === 0) {
        await whatsappService.sendText(phoneNumberId, from,
          "I searched your whole trip but couldn't find options for any of the legs. Try adjusting your dates or destinations."
        );
        return;
      }

      // Store all leg packages in global cache too — useful if the
      // user later asks to see all options again.
      const allPackages = actionableLegs.flatMap(r => r.packages);
      await packageCache.save(from, allPackages, result.tripParams);

      if (actionableLegs.length === 1) {
        // Only one actionable leg — no need for a flow, just show it normally
        await whatsappService.sendText(phoneNumberId, from, result.text);
        await whatsappService.sendPackages(phoneNumberId, from, actionableLegs[0].packages);
        await whatsappService.sendText(phoneNumberId, from,
          `Reply with the option number (1-${actionableLegs[0].packages.length}) to book.`
        );
        return;
      }

      // Start the leg flow
      const flow = await conversationMemory.startLegFlow(from, agencyId, {
        legs:       actionableLegs,
        tripParams: result.tripParams,
      });

      if (!flow) {
        // Fallback: couldn't start flow, dump everything
        await whatsappService.sendText(phoneNumberId, from, result.text);
        await whatsappService.sendPackages(phoneNumberId, from, allPackages);
        return;
      }

      // Intro message
      const totalLegs   = flow.legs.length;
      const tripSummary = result.tripParams?.trips
        ? result.tripParams.trips.map(t => `${t.origin || ''} → ${t.destination}`).join(', ')
        : (result.tripParams?.destination || 'your trip');

      await whatsappService.sendText(phoneNumberId, from,
        `✅ Found options for all *${totalLegs} legs* of your trip to *${_titleCase(tripSummary)}*.\n\nI'll walk you through one leg at a time — pick your preferred option for each leg, then I'll show you the total and let you pay all at once or leg by leg.`
      );

      // Present leg 0
      await _sendCurrentLeg(phoneNumberId, from, flow);
      return;
    }

    // ── MULTI-TRIP RESULTS (separate independent trips) ────
    if (result.tripResults && result.tripResults.length > 1) {
      const allPackages = [];

      for (let i = 0; i < result.tripResults.length; i++) {
        const trip     = result.tripResults[i];
        const introLine = i === 0
          ? `Here are options for *Trip 1 — ${trip.label}*:`
          : `And here are options for *Trip ${i + 1} — ${trip.label}*:`;

        await whatsappService.sendText(phoneNumberId, from, introLine);

        if (trip.packages?.length > 0) {
          await whatsappService.sendPackages(phoneNumberId, from, trip.packages);
          allPackages.push(...trip.packages);
        } else {
          await whatsappService.sendText(phoneNumberId, from,
            `Sorry, I couldn't find any options for ${trip.label}.`
          );
        }
      }

      if (allPackages.length > 0) {
        await packageCache.save(from, allPackages, result.tripParams);
        await whatsappService.sendText(phoneNumberId, from,
          `Reply with the option number (1-${allPackages.length}) to book any of the above.`
        );
      }
      return;
    }

    // ── SINGLE-TRIP RESULTS ────────────────────────────────
    await whatsappService.sendText(phoneNumberId, from, result.text);

    if (result.packages?.length > 0) {
      await whatsappService.sendPackages(phoneNumberId, from, result.packages);
      await packageCache.save(from, result.packages, result.tripParams);
      await whatsappService.sendText(phoneNumberId, from,
        `Reply with the option number (1-${result.packages.length}) to book that option.`
      );
    }

  } catch (error) {
    logger.error('WhatsApp webhook error', { error: error.message, stack: error.stack });
  }
});

// ═════════════════════════════════════════════════════════════
// LEG FLOW MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────
// Called when an active leg flow exists. Interprets the traveler's
// message as either:
//   a) An option selection (1/2/3/4) → save, advance, send next leg
//      or final summary if all legs done
//   b) A modification request ("cheaper", "different hotel") →
//      resend current leg with an acknowledgment
//   c) An "abandon" keyword → clear the flow and return false
//      so the caller falls through to normal orchestration
//   d) Anything that looks like a fresh trip search → return false
//
// Returns true if the message was handled, false if it should
// fall through to the normal orchestration path.
// ═════════════════════════════════════════════════════════════
async function _handleLegFlowMessage({ phoneNumberId, from, agencyId, prompt, activeLegFlow }) {
  const flow    = activeLegFlow;
  const trimmed = prompt.trim();

  // ── "Start over" / "New search" → abandon flow ──────────
  const isAbandonment = /\b(start over|new search|fresh start|forget it|cancel|restart|different trip)\b/i.test(trimmed);
  if (isAbandonment) {
    await conversationMemory.clearLegFlow(from, agencyId);
    return false; // fall through to orchestration
  }

  const currentLeg = flow.legs[flow.currentLegIndex];
  if (!currentLeg) {
    // Flow is done but wasn't cleared — clean up
    await conversationMemory.clearLegFlow(from, agencyId);
    return false;
  }

  // ── "Show all" / "See all legs" → send summary of what's left ──
  if (/\b(show all|all legs|whole trip|see all|overview)\b/i.test(trimmed)) {
    const remaining = flow.legs.slice(flow.currentLegIndex);
    await whatsappService.sendText(phoneNumberId, from,
      `You're on leg *${flow.currentLegIndex + 1} of ${flow.legs.length}*. Here's what's coming:\n\n` +
      remaining.map((l, i) => `*${flow.currentLegIndex + i + 1}.* ${l.roleLabel || l.label}`).join('\n') +
      `\n\nReply with your option choice (1–${currentLeg.packages.length}) to continue.`
    );
    return true;
  }

  // ── Option selection (1/2/3/4) ──────────────────────────
  const selectionMatch = trimmed.match(/^(?:option\s*)?([1-4])$/i);
  if (selectionMatch) {
    const optionNum      = parseInt(selectionMatch[1], 10);
    const selectedPackage = currentLeg.packages[optionNum - 1];

    if (!selectedPackage) {
      await whatsappService.sendText(phoneNumberId, from,
        `I only have ${currentLeg.packages.length} option${currentLeg.packages.length > 1 ? 's' : ''} for this leg. Reply *1*${currentLeg.packages.length > 1 ? `–*${currentLeg.packages.length}*` : ''} to choose.`
      );
      return true;
    }

    // Save this leg's selection and advance
    const updatedFlow = await conversationMemory.saveLegSelection(from, agencyId, {
      legIndex:        flow.currentLegIndex,
      selectedPackage,
    });

    if (!updatedFlow) {
      await whatsappService.sendText(phoneNumberId, from,
        "Something went wrong saving your choice — please try again."
      );
      return true;
    }

    // Confirm selection with a brief acknowledgment
    const legPrice    = selectedPackage.summary?.totalPrice || 0;
    const legCurrency = selectedPackage.summary?.currency || 'KES';
    await whatsappService.sendText(phoneNumberId, from,
      `✅ Got it — *Option ${optionNum}* selected for *${currentLeg.roleLabel || currentLeg.label}* (${legCurrency} ${legPrice.toLocaleString()})`
    );

    // ── All legs done → show final summary ──────────────
    if (!updatedFlow.active) {
      // Save all selected packages to the global cache so booking
      // can be initiated from the final summary screen
      const allSelected = Object.values(updatedFlow.selections).map(s => s.package);
      await packageCache.save(from, allSelected, updatedFlow.tripParams);

      const finalSummary = conversationMemory.buildFinalLegSummary(updatedFlow);
      await whatsappService.sendText(phoneNumberId, from, finalSummary);

      // Clear the leg flow — it's complete
      await conversationMemory.clearLegFlow(from, agencyId);
      return true;
    }

    // ── More legs to go → show running total then next leg ──
    const summaryBlock = conversationMemory.getLegFlowSummary(updatedFlow);
    if (summaryBlock) {
      await whatsappService.sendText(phoneNumberId, from, summaryBlock);
    }

    // Small pause before next leg so messages don't blur together
    await new Promise(resolve => setTimeout(resolve, 800));

    await _sendCurrentLeg(phoneNumberId, from, updatedFlow);
    return true;
  }

  // ── Modification request while in leg flow ───────────────
  // e.g. "cheaper option", "different hotel", "morning flight"
  const looksLikeModification = /\b(cheaper|different|another|change|morning|evening|upgrade|luxury|budget|hotel|flight|bus)\b/i.test(trimmed);
  if (looksLikeModification) {
    await whatsappService.sendText(phoneNumberId, from,
      `Here are the options again for *${currentLeg.roleLabel || currentLeg.label}* — reply with *1*${currentLeg.packages.length > 1 ? `–*${currentLeg.packages.length}*` : ''} to choose:`
    );
    // Re-send the current leg's packages
    await whatsappService.sendLegPackages(phoneNumberId, from, {
      leg:             currentLeg,
      legIndex:        flow.currentLegIndex,
      totalLegs:       flow.legs.length,
      runningTotalKES: flow.runningTotalKES || 0,
    });
    return true;
  }

  // ── Looks like a fresh search — return false to fall through ──
  const looksLikeFreshSearch = trimmed.split(/\s+/).length > 6
    || /\bto\b.{2,30}\bfrom\b/i.test(trimmed)
    || /\d+\s*nights?\b/i.test(trimmed);

  if (looksLikeFreshSearch) {
    logger.info('LegFlow: message looks like fresh search — abandoning flow', { from, preview: trimmed.slice(0, 80) });
    await conversationMemory.clearLegFlow(from, agencyId);
    return false;
  }

  // ── Unclear message — nudge the traveler ────────────────
  await whatsappService.sendText(phoneNumberId, from,
    `We're working through your trip leg by leg. Reply with *1*${currentLeg.packages.length > 1 ? `–*${currentLeg.packages.length}*` : ''} to pick an option for *${currentLeg.roleLabel || currentLeg.label}*.\n\nSay "show all" to see all remaining legs, or "start over" for a new search.`
  );
  return true;
}

// ─────────────────────────────────────────────
// SEND CURRENT LEG
// Helper — presents whichever leg the flow is currently on.
// ─────────────────────────────────────────────
async function _sendCurrentLeg(phoneNumberId, from, flow) {
  const leg = flow.legs[flow.currentLegIndex];
  if (!leg) return;

  await whatsappService.sendLegPackages(phoneNumberId, from, {
    leg,
    legIndex:        flow.currentLegIndex,
    totalLegs:       flow.legs.length,
    runningTotalKES: flow.runningTotalKES || 0,
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

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
  if (error) logger.error('whatsapp_contacts name save failed', { error: error.message, phone });
}

async function _clearAwaitingName(phone) {
  const { error } = await supabase
    .from('whatsapp_contacts')
    .update({ awaiting_name: false, updated_at: new Date().toISOString() })
    .eq('phone', phone);
  if (error) logger.error('whatsapp_contacts awaiting_name clear failed', { error: error.message, phone });
}

function _titleCase(str) {
  if (!str) return '';
  return String(str).replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = router;