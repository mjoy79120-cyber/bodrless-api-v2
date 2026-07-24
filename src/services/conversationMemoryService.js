/**
 * CONVERSATION MEMORY SERVICE
 * ─────────────────────────────────────────────────────────────
 * Durable per-traveler memory across WhatsApp conversations.
 * Backed by whatsapp_contacts (already exists, has conversation_history
 * and previous_params columns — this service just makes them reliable).
 *
 * Responsibilities:
 *   1. Load/save conversation history + trip params per phone
 *   2. Drop-off recovery — detect when a traveler returns after
 *      going quiet, ask resume vs fresh start
 *   3. Mid-conversation modify — hold selected package in memory
 *      while user changes budget/nights/hotel/airline in chat
 *   4. Mid-booking cancel — clear booking session without losing
 *      the conversation context so the user can pivot immediately
 *   5. Platform memory — "what did I search last time?" works
 *      across sessions because history is in Supabase not RAM
 *   6. Leg flow state machine — for multi-leg trips, tracks which
 *      leg is currently being presented, what the user selected
 *      per leg, and the running total so far
 *   7. Traveler intelligence — links every contact to a global
 *      travelers row so preferences and loyalty follow the traveler
 *      across agencies and channels (WhatsApp + web)
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const travelerIntelligence = require('./travelerIntelligence');

const DROP_OFF_THRESHOLD_MS = 30 * 60 * 1000;
const PACKAGE_HOLD_TTL_MS   = 60 * 60 * 1000;
const LEG_FLOW_TTL_MS       = 4 * 60 * 60 * 1000;

class ConversationMemoryService {

  // ─────────────────────────────────────────────
  // LOAD CONTACT
  // ─────────────────────────────────────────────
  async loadContact(phone, agencyId) {
    try {
      const { data, error } = await supabase
        .from('whatsapp_contacts')
        .select('*')
        .eq('phone', phone)
        .maybeSingle();

      if (error) {
        logger.warn('ConversationMemory: loadContact failed', { phone, error: error.message });
        return null;
      }
      return data || null;
    } catch (err) {
      logger.error('ConversationMemory: loadContact threw', { phone, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // UPSERT CONTACT
  // ─────────────────────────────────────────────
  async upsertContact(phone, agencyId, updates = {}) {
    try {
      const { error } = await supabase
        .from('whatsapp_contacts')
        .upsert({
          phone,
          agency_id:  agencyId,
          updated_at: new Date().toISOString(),
          ...updates,
        }, { onConflict: 'phone' });

      if (error) {
        logger.warn('ConversationMemory: upsertContact failed', { phone, error: error.message });
      }
    } catch (err) {
      logger.error('ConversationMemory: upsertContact threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // LINK CONTACT TO GLOBAL TRAVELER
  // Call on every inbound message — ensures whatsapp_contacts
  // is linked to the global travelers row.
  // This is what makes preferences cross-agency.
  // ─────────────────────────────────────────────
  async linkTraveler(phone, agencyId) {
    try {
      const traveler = await travelerIntelligence.getOrCreateTraveler(phone);
      if (!traveler) return null;

      await this.upsertContact(phone, agencyId, {
        traveler_id: traveler.id,
      });

      return traveler;
    } catch (err) {
      logger.error('ConversationMemory: linkTraveler threw', { phone, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // PROCESS MESSAGE FOR PREFERENCES
  // Call on every inbound user message.
  // Silently extracts preferences + loyalty from text.
  // Returns a short confirmation string if anything was detected,
  // null otherwise — append to your response if not null.
  // ─────────────────────────────────────────────
  async processMessageForPreferences(phone, message) {
    try {
      const { changed } = await travelerIntelligence.extractAndSave(phone, message);
      return travelerIntelligence.buildPreferenceConfirmation(changed);
    } catch (err) {
      logger.error('ConversationMemory: processMessageForPreferences threw', { phone, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // LOAD TRAVELER PREFERENCES
  // Returns the full travelers row for this phone.
  // Call before every search.
  // ─────────────────────────────────────────────
  async loadTravelerPreferences(phone) {
    return travelerIntelligence.loadPreferences(phone);
  }

  // ─────────────────────────────────────────────
  // APPLY PREFERENCES TO SEARCH
  // Enriches search params with stored traveler preferences.
  // Always call before running a hotel or flight search.
  //
  // Usage:
  //   const enrichedParams = await memoryService.applyPreferencesToSearch(phone, rawParams);
  //   const results = await flightEngine.search(enrichedParams);
  // ─────────────────────────────────────────────
  async applyPreferencesToSearch(phone, searchParams) {
    return travelerIntelligence.applyToSearchParams(phone, searchParams);
  }

  // ─────────────────────────────────────────────
  // GET POINTS SUMMARY
  // Returns WhatsApp-formatted points summary for this traveler.
  // Pass airline codes to filter to relevant balances,
  // or [] to return all balances.
  // ─────────────────────────────────────────────
  async getPointsSummary(phone, airlines = []) {
    return travelerIntelligence.buildPointsSummary(phone, airlines);
  }

  // ─────────────────────────────────────────────
  // SAVE TURN
  // ─────────────────────────────────────────────
  async saveTurn(phone, agencyId, {
    userMessage,
    engineResponse,
    tripParams = null,
    packages = [],
    sessionId = null,
  }) {
    try {
      const contact  = await this.loadContact(phone, agencyId);
      const existing = contact?.conversation_history || [];

      const newTurns = [
        { role: 'user',      content: userMessage,    timestamp: new Date().toISOString() },
        { role: 'assistant', content: engineResponse, timestamp: new Date().toISOString() },
      ];

      const history = [...existing, ...newTurns].slice(-20);

      const updates = {
        conversation_history: history,
        drop_off_at:          new Date().toISOString(),
        session_id:           sessionId || contact?.session_id || null,
      };

      if (tripParams)                   updates.previous_params  = tripParams;
      if (packages && packages.length)  updates.cached_packages  = packages;

      await this.upsertContact(phone, agencyId, updates);
    } catch (err) {
      logger.error('ConversationMemory: saveTurn threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // SAVE SELECTED PACKAGE
  // ─────────────────────────────────────────────
  async saveSelectedPackage(phone, agencyId, pkg) {
    try {
      await this.upsertContact(phone, agencyId, {
        selected_package: {
          package:    pkg,
          selectedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.error('ConversationMemory: saveSelectedPackage threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // LOAD SELECTED PACKAGE
  // ─────────────────────────────────────────────
  async loadSelectedPackage(phone, agencyId) {
    try {
      const contact = await this.loadContact(phone, agencyId);
      if (!contact?.selected_package) return null;

      const { package: pkg, selectedAt } = contact.selected_package;
      const age = Date.now() - new Date(selectedAt).getTime();

      if (age > PACKAGE_HOLD_TTL_MS) {
        await this.upsertContact(phone, agencyId, { selected_package: null });
        return null;
      }

      return pkg;
    } catch (err) {
      logger.error('ConversationMemory: loadSelectedPackage threw', { phone, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // CLEAR SELECTED PACKAGE
  // ─────────────────────────────────────────────
  async clearSelectedPackage(phone, agencyId) {
    try {
      await this.upsertContact(phone, agencyId, { selected_package: null });
    } catch (err) {
      logger.error('ConversationMemory: clearSelectedPackage threw', { phone, error: err.message });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // LEG FLOW STATE MACHINE
  // ═════════════════════════════════════════════════════════════

  async startLegFlow(phone, agencyId, { legs, tripParams }) {
    try {
      const actionableLegs = legs.filter(l => l.packages && l.packages.length > 0);
      if (actionableLegs.length === 0) {
        logger.warn('LegFlow: no actionable legs — not starting flow', { phone });
        return null;
      }

      const flow = {
        active:          true,
        startedAt:       new Date().toISOString(),
        tripParams,
        legs:            actionableLegs,
        currentLegIndex: 0,
        selections:      {},
        runningTotalKES: 0,
      };

      await this.upsertContact(phone, agencyId, { leg_flow: flow });
      logger.info('LegFlow: started', { phone, legCount: actionableLegs.length });
      return flow;
    } catch (err) {
      logger.error('ConversationMemory: startLegFlow threw', { phone, error: err.message });
      return null;
    }
  }

  async loadLegFlow(phone, agencyId) {
    try {
      const contact = await this.loadContact(phone, agencyId);
      const flow    = contact?.leg_flow;
      if (!flow?.active) return null;

      const age = Date.now() - new Date(flow.startedAt).getTime();
      if (age > LEG_FLOW_TTL_MS) {
        logger.info('LegFlow: expired — clearing', { phone, ageMs: age });
        await this.upsertContact(phone, agencyId, { leg_flow: null });
        return null;
      }

      return flow;
    } catch (err) {
      logger.error('ConversationMemory: loadLegFlow threw', { phone, error: err.message });
      return null;
    }
  }

  async saveLegSelection(phone, agencyId, { legIndex, selectedPackage }) {
    try {
      const flow = await this.loadLegFlow(phone, agencyId);
      if (!flow) {
        logger.warn('LegFlow: saveLegSelection called but no active flow', { phone });
        return null;
      }

      const leg = flow.legs[legIndex];
      if (!leg) {
        logger.warn('LegFlow: invalid legIndex', { phone, legIndex });
        return null;
      }

      flow.selections[legIndex] = {
        packageId: selectedPackage.packageId,
        package:   selectedPackage,
        label:     leg.label,
        role:      leg.role,
      };

      const legPrice       = selectedPackage.summary?.totalPrice || 0;
      flow.runningTotalKES = (flow.runningTotalKES || 0) + legPrice;
      flow.currentLegIndex = legIndex + 1;
      flow.active          = flow.currentLegIndex < flow.legs.length;

      await this.upsertContact(phone, agencyId, { leg_flow: flow });
      logger.info('LegFlow: leg selected', {
        phone, legIndex, nextIndex: flow.currentLegIndex,
        runningTotal: flow.runningTotalKES, flowComplete: !flow.active,
      });

      return flow;
    } catch (err) {
      logger.error('ConversationMemory: saveLegSelection threw', { phone, error: err.message });
      return null;
    }
  }

  async clearLegFlow(phone, agencyId) {
    try {
      await this.upsertContact(phone, agencyId, { leg_flow: null });
    } catch (err) {
      logger.error('ConversationMemory: clearLegFlow threw', { phone, error: err.message });
    }
  }

  getLegFlowSummary(flow) {
    const lines         = [];
    const selectionCount = Object.keys(flow.selections).length;
    if (selectionCount === 0) return null;

    lines.push('*Your selections so far:*');
    lines.push('─────────────────');

    for (let i = 0; i < flow.currentLegIndex; i++) {
      const sel = flow.selections[i];
      if (!sel) continue;
      const leg      = flow.legs[i];
      const pkg      = sel.package;
      const price    = pkg.summary?.totalPrice || 0;
      const currency = pkg.summary?.currency || 'KES';
      lines.push(`${leg.roleLabel || leg.label}: *${currency} ${price.toLocaleString()}*`);
    }

    lines.push('─────────────────');
    lines.push(`*Running total: KES ${(flow.runningTotalKES || 0).toLocaleString()}*`);

    return lines.join('\n');
  }

  buildFinalLegSummary(flow) {
    const lines = [];
    lines.push('*🎉 Your complete trip is ready!*');
    lines.push('━━━━━━━━━━━━━━━━');

    for (let i = 0; i < flow.legs.length; i++) {
      const sel = flow.selections[i];
      if (!sel) continue;

      const leg      = flow.legs[i];
      const pkg      = sel.package;
      const price    = pkg.summary?.totalPrice || 0;
      const currency = pkg.summary?.currency || 'KES';

      lines.push('');
      lines.push(`*${leg.roleLabel || leg.label}*`);
      lines.push(`  Route: ${pkg.summary?.route || leg.label}`);

      if (pkg.transport) {
        const t    = pkg.transport;
        const icon = t.transportType === 'bus' ? '🚌' : t.transportType === 'train' ? '🚆' : '✈️';
        lines.push(`  ${icon} ${t.airline || t.provider || 'TBC'} · ${t.origin || ''} → ${t.destination || ''}`);
      }

      if (pkg.hotel) {
        const stars = pkg.hotel.stars ? '⭐'.repeat(Math.min(Number(pkg.hotel.stars) || 0, 5)) : '';
        lines.push(`  🏨 ${pkg.hotel.name || 'TBC'} ${stars}`.trimEnd());
      }

      lines.push(`  *${currency} ${price.toLocaleString()}*`);
    }

    lines.push('');
    lines.push('━━━━━━━━━━━━━━━━');
    lines.push(`*Total trip cost: KES ${(flow.runningTotalKES || 0).toLocaleString()}*`);

    const passengers = flow.tripParams?.passengers || 1;
    if (passengers > 1) {
      const perPerson = Math.round(flow.runningTotalKES / passengers);
      lines.push(`_(KES ${perPerson.toLocaleString()} per person for ${passengers} travelers)_`);
    }

    lines.push('');
    lines.push('How would you like to proceed?');
    lines.push('*1.* Pay in full now');
    lines.push('*2.* Pay per leg (I\'ll send you each booking separately)');
    lines.push('*3.* Change something');

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────
  // CHECK DROP-OFF
  // ─────────────────────────────────────────────
  async checkDropOff(phone, agencyId) {
    try {
      const contact = await this.loadContact(phone, agencyId);
      if (!contact)            return { isDropOff: false };
      if (!contact.drop_off_at) return { isDropOff: false };

      const gapMs = Date.now() - new Date(contact.drop_off_at).getTime();
      if (gapMs < DROP_OFF_THRESHOLD_MS) return { isDropOff: false };

      const hasPreviousSearch = !!(
        contact.previous_params?.destination ||
        contact.cached_packages?.length > 0
      );

      const minutesAway = Math.round(gapMs / 60000);

      return {
        isDropOff:           true,
        contact,
        minutesAway,
        hasPreviousSearch,
        previousDestination: contact.previous_params?.destination || null,
        cachedPackages:      contact.cached_packages || [],
        conversationHistory: contact.conversation_history || [],
        previousParams:      contact.previous_params || null,
      };
    } catch (err) {
      logger.error('ConversationMemory: checkDropOff threw', { phone, error: err.message });
      return { isDropOff: false };
    }
  }

  // ─────────────────────────────────────────────
  // GET CONVERSATION CONTEXT
  // ─────────────────────────────────────────────
  async getConversationContext(phone, agencyId) {
    try {
      const contact = await this.loadContact(phone, agencyId);
      if (!contact) return { conversationHistory: [], previousParams: null };

      return {
        conversationHistory: (contact.conversation_history || []).slice(-10),
        previousParams:      contact.previous_params || null,
        cachedPackages:      contact.cached_packages || [],
        selectedPackage:     contact.selected_package?.package || null,
        sessionId:           contact.session_id || null,
        legFlow:             contact.leg_flow || null,
      };
    } catch (err) {
      logger.error('ConversationMemory: getConversationContext threw', { phone, error: err.message });
      return { conversationHistory: [], previousParams: null };
    }
  }

  // ─────────────────────────────────────────────
  // BUILD DROP-OFF WELCOME MESSAGE
  // ─────────────────────────────────────────────
  buildDropOffWelcome({ minutesAway, previousDestination, hasPreviousSearch }) {
    const hoursAway = Math.round(minutesAway / 60);
    const daysAway  = Math.round(hoursAway / 24);

    let timePhrase;
    if (minutesAway < 60)     timePhrase = `${minutesAway} minutes`;
    else if (hoursAway < 24)  timePhrase = `${hoursAway} hour${hoursAway > 1 ? 's' : ''}`;
    else if (daysAway === 1)  timePhrase = 'yesterday';
    else                      timePhrase = `${daysAway} days`;

    const destPhrase = previousDestination
      ? ` for ${this._titleCase(previousDestination)}`
      : '';

    if (!hasPreviousSearch) {
      return `Welcome back! 👋 It's been ${timePhrase}. What trip can I help you plan today?`;
    }

    return `Welcome back! 👋 You were looking at trips${destPhrase} ${timePhrase} ago. Would you like to:\n\n*1.* Pick up where you left off\n*2.* Start a fresh search\n\nReply *1* or *2*.`;
  }

  // ─────────────────────────────────────────────
  // HANDLE MODIFY MID-CONVERSATION
  // ─────────────────────────────────────────────
  async handleModify(phone, agencyId, intent, previousParams) {
    const heldPackage  = await this.loadSelectedPackage(phone, agencyId);
    const adjustments  = intent.adjustments || {};

    const needsResearch = !!(
      adjustments.destination   ||
      adjustments.budget        ||
      adjustments.transportMode ||
      adjustments.passengers
    );

    if (needsResearch || !heldPackage) {
      await this.clearSelectedPackage(phone, agencyId);
      return { action: 'research', updatedPackage: null, updatedParams: previousParams };
    }

    if (adjustments.nights) {
      const nights   = adjustments.nights;
      const depDate  = previousParams?.departureDate;
      let returnDate = previousParams?.returnDate;

      if (depDate) {
        const dep = new Date(depDate);
        dep.setDate(dep.getDate() + nights);
        returnDate = dep.toISOString().split('T')[0];
      }

      const updatedParams  = { ...previousParams, nights, returnDate };
      const updatedPackage = this._patchPackageNights(heldPackage, nights, returnDate);

      await this.saveSelectedPackage(phone, agencyId, updatedPackage);
      return { action: 'patch', updatedPackage, updatedParams };
    }

    await this.clearSelectedPackage(phone, agencyId);
    return { action: 'research', updatedPackage: null, updatedParams: previousParams };
  }

  // ─────────────────────────────────────────────
  // PATCH PACKAGE NIGHTS
  // ─────────────────────────────────────────────
  _patchPackageNights(pkg, newNights, newReturnDate) {
    const updated = JSON.parse(JSON.stringify(pkg));

    if (updated.summary) {
      updated.summary.nights = newNights;
      if (updated.summary.occupancy) {
        updated.summary.occupancy.nights   = newNights;
        updated.summary.occupancy.checkOut = newReturnDate || updated.summary.occupancy.checkOut;
      }
    }

    if (updated.hotel) {
      const pricePerNight  = updated.hotel.pricePerNight || 0;
      const hotelTotal     = pricePerNight * newNights;

      updated.hotel.nights    = newNights;
      updated.hotel.checkOut  = newReturnDate || updated.hotel.checkOut;
      updated.hotel.totalRate = hotelTotal;

      if (updated.summary) {
        const flightPrice   = updated.transport?.price || 0;
        const retFlight     = updated.returnTransport?.price || 0;
        const transferTotal = (updated.transfers || []).reduce((s, t) => s + (t.price || 0), 0);
        updated.summary.totalPrice     = flightPrice + retFlight + hotelTotal + transferTotal;
        updated.summary.pricePerPerson = Math.round(updated.summary.totalPrice / (updated.summary.passengers || 1));
      }
    }

    return updated;
  }

  // ─────────────────────────────────────────────
  // CLEAR CONVERSATION
  // ─────────────────────────────────────────────
  async clearConversation(phone, agencyId) {
    try {
      await this.upsertContact(phone, agencyId, {
        conversation_history: [],
        previous_params:      null,
        cached_packages:      [],
        selected_package:     null,
        pending_trip_params:  null,
        drop_off_at:          null,
        session_id:           null,
        leg_flow:             null,
      });
    } catch (err) {
      logger.error('ConversationMemory: clearConversation threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL MID-BOOKING
  // ─────────────────────────────────────────────
  async cancelMidBooking(phone, agencyId) {
    try {
      const supabaseClient = require('../utils/supabase');
      await supabaseClient
        .from('whatsapp_booking_sessions')
        .delete()
        .eq('phone', phone);

      await this.clearSelectedPackage(phone, agencyId);
      logger.info('ConversationMemory: mid-booking cancel, context preserved', { phone });
    } catch (err) {
      logger.error('ConversationMemory: cancelMidBooking threw', { phone, error: err.message });
    }
  }

  _titleCase(str) {
    if (!str) return '';
    return String(str).replace(/\b\w/g, c => c.toUpperCase());
  }
}

module.exports = new ConversationMemoryService();