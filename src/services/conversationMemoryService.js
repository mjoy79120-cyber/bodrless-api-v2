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
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// How long before we consider a conversation "dropped off"
// and offer the resume prompt. 30 minutes felt right —
// long enough that a quick bathroom break doesn't trigger it,
// short enough that someone returning the next day always gets it.
const DROP_OFF_THRESHOLD_MS = 30 * 60 * 1000;

// How long to keep a selected package in context while the user
// modifies params mid-conversation (e.g. "change it to 7 nights").
// After this, the package is cleared and a fresh search runs.
const PACKAGE_HOLD_TTL_MS = 60 * 60 * 1000; // 1 hour

class ConversationMemoryService {

  // ─────────────────────────────────────────────
  // LOAD CONTACT
  // Returns the full whatsapp_contacts row for this phone,
  // or null if this is a brand new traveler.
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
  // Creates or updates the contact row. Called on every message
  // so the contact record is always current.
  // ─────────────────────────────────────────────
  async upsertContact(phone, agencyId, updates = {}) {
    try {
      const { error } = await supabase
        .from('whatsapp_contacts')
        .upsert({
          phone,
          agency_id: agencyId,
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
  // SAVE TURN
  // Appends user + assistant turn to conversation_history,
  // updates previous_params, and caches packages shown.
  // Keeps last 20 turns (10 exchanges) to stay within context limits.
  // ─────────────────────────────────────────────
  async saveTurn(phone, agencyId, {
    userMessage,
    engineResponse,
    tripParams = null,
    packages = [],
    sessionId = null,
  }) {
    try {
      const contact = await this.loadContact(phone, agencyId);
      const existing = contact?.conversation_history || [];

      const newTurns = [
        { role: 'user',      content: userMessage,    timestamp: new Date().toISOString() },
        { role: 'assistant', content: engineResponse, timestamp: new Date().toISOString() },
      ];

      const history = [...existing, ...newTurns].slice(-20); // keep last 20 turns

      const updates = {
        conversation_history: history,
        drop_off_at: new Date().toISOString(),
        session_id: sessionId || contact?.session_id || null,
      };

      if (tripParams) updates.previous_params = tripParams;
      if (packages && packages.length > 0) updates.cached_packages = packages;

      await this.upsertContact(phone, agencyId, updates);
    } catch (err) {
      logger.error('ConversationMemory: saveTurn threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // SAVE SELECTED PACKAGE
  // Called when the user taps "Book" on a package — holds it in
  // whatsapp_contacts so mid-conversation modifications know which
  // package to modify rather than starting over.
  // ─────────────────────────────────────────────
  async saveSelectedPackage(phone, agencyId, pkg) {
    try {
      await this.upsertContact(phone, agencyId, {
        selected_package: {
          package: pkg,
          selectedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      logger.error('ConversationMemory: saveSelectedPackage threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // LOAD SELECTED PACKAGE
  // Returns the held package if it's still within the TTL,
  // null if it's expired or never set.
  // ─────────────────────────────────────────────
  async loadSelectedPackage(phone, agencyId) {
    try {
      const contact = await this.loadContact(phone, agencyId);
      if (!contact?.selected_package) return null;

      const { package: pkg, selectedAt } = contact.selected_package;
      const age = Date.now() - new Date(selectedAt).getTime();

      if (age > PACKAGE_HOLD_TTL_MS) {
        // Expired — clear it
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
  // Called after booking completes or when user cancels mid-booking.
  // ─────────────────────────────────────────────
  async clearSelectedPackage(phone, agencyId) {
    try {
      await this.upsertContact(phone, agencyId, { selected_package: null });
    } catch (err) {
      logger.error('ConversationMemory: clearSelectedPackage threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // CHECK DROP-OFF
  // Returns the drop-off state for a returning traveler:
  //   { isDropOff: false }  — new user or recent message, proceed normally
  //   { isDropOff: true, contact, minutesAway, hasPreviousSearch }
  //                         — show resume prompt before doing anything
  // ─────────────────────────────────────────────
  async checkDropOff(phone, agencyId) {
    try {
      const contact = await this.loadContact(phone, agencyId);

      // Brand new traveler — no drop-off possible
      if (!contact) return { isDropOff: false };

      // No drop_off_at recorded yet — old row before this feature
      if (!contact.drop_off_at) return { isDropOff: false };

      const gapMs = Date.now() - new Date(contact.drop_off_at).getTime();

      if (gapMs < DROP_OFF_THRESHOLD_MS) return { isDropOff: false };

      const hasPreviousSearch = !!(
        contact.previous_params?.destination ||
        (contact.cached_packages?.length > 0)
      );

      const minutesAway = Math.round(gapMs / 60000);

      return {
        isDropOff: true,
        contact,
        minutesAway,
        hasPreviousSearch,
        previousDestination: contact.previous_params?.destination || null,
        cachedPackages: contact.cached_packages || [],
        conversationHistory: contact.conversation_history || [],
        previousParams: contact.previous_params || null,
      };
    } catch (err) {
      logger.error('ConversationMemory: checkDropOff threw', { phone, error: err.message });
      return { isDropOff: false };
    }
  }

  // ─────────────────────────────────────────────
  // GET CONVERSATION CONTEXT
  // Returns what the orchestrator needs for a new message:
  // the last N turns of history and the previous trip params.
  // This is what gets threaded into orchestrate() as `context`.
  // ─────────────────────────────────────────────
  async getConversationContext(phone, agencyId) {
    try {
      const contact = await this.loadContact(phone, agencyId);
      if (!contact) return { conversationHistory: [], previousParams: null };

      return {
        conversationHistory: (contact.conversation_history || []).slice(-10),
        previousParams: contact.previous_params || null,
        cachedPackages: contact.cached_packages || [],
        selectedPackage: contact.selected_package?.package || null,
        sessionId: contact.session_id || null,
      };
    } catch (err) {
      logger.error('ConversationMemory: getConversationContext threw', { phone, error: err.message });
      return { conversationHistory: [], previousParams: null };
    }
  }

  // ─────────────────────────────────────────────
  // BUILD DROP-OFF WELCOME MESSAGE
  // Returns a friendly welcome-back string based on how long
  // they were away and what they were last doing.
  // ─────────────────────────────────────────────
  buildDropOffWelcome({ minutesAway, previousDestination, hasPreviousSearch }) {
    const hoursAway = Math.round(minutesAway / 60);
    const daysAway  = Math.round(hoursAway / 24);

    let timePhrase;
    if (minutesAway < 60)      timePhrase = `${minutesAway} minutes`;
    else if (hoursAway < 24)   timePhrase = `${hoursAway} hour${hoursAway > 1 ? 's' : ''}`;
    else if (daysAway === 1)   timePhrase = 'yesterday';
    else                       timePhrase = `${daysAway} days`;

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
  // Called when the orchestrator detects a modification intent
  // (change nights, budget, hotel etc.) while a package is selected.
  //
  // Strategy:
  //   - If package is held AND the change is to a field that doesn't
  //     require a new supplier search (nights/dates only) → patch
  //     the package in place and return it
  //   - If the change requires a new search (budget, destination,
  //     airline, hotel) → clear the package hold and let the
  //     orchestrator run a fresh search with the adjusted params
  //
  // Returns: { action: 'patch'|'resarch', updatedPackage?, updatedParams }
  // ─────────────────────────────────────────────
  async handleModify(phone, agencyId, intent, previousParams) {
    const heldPackage = await this.loadSelectedPackage(phone, agencyId);
    const adjustments = intent.adjustments || {};

    // Fields that require a full re-search
    const needsResearch = !!(
      adjustments.destination ||
      adjustments.budget      ||
      adjustments.transportMode ||
      adjustments.passengers
    );

    if (needsResearch || !heldPackage) {
      // Clear the held package — fresh search will run
      await this.clearSelectedPackage(phone, agencyId);
      return { action: 'research', updatedPackage: null, updatedParams: previousParams };
    }

    // Only nights/dates changed — patch in place
    if (adjustments.nights) {
      const nights = adjustments.nights;
      const depDate = previousParams?.departureDate;
      let returnDate = previousParams?.returnDate;

      if (depDate) {
        const dep = new Date(depDate);
        dep.setDate(dep.getDate() + nights);
        returnDate = dep.toISOString().split('T')[0];
      }

      const updatedParams = { ...previousParams, nights, returnDate };
      const updatedPackage = this._patchPackageNights(heldPackage, nights, returnDate);

      // Save the updated package back
      await this.saveSelectedPackage(phone, agencyId, updatedPackage);

      return { action: 'patch', updatedPackage, updatedParams };
    }

    // No recognised field changed — treat as research
    await this.clearSelectedPackage(phone, agencyId);
    return { action: 'research', updatedPackage: null, updatedParams: previousParams };
  }

  // ─────────────────────────────────────────────
  // PATCH PACKAGE NIGHTS
  // Updates nights and hotel total in an existing package object
  // without re-searching. Recalculates totalPrice based on the
  // new night count × existing pricePerNight.
  // ─────────────────────────────────────────────
  _patchPackageNights(pkg, newNights, newReturnDate) {
    const updated = JSON.parse(JSON.stringify(pkg)); // deep clone

    if (updated.summary) {
      updated.summary.nights = newNights;
      if (updated.summary.occupancy) {
        updated.summary.occupancy.nights  = newNights;
        updated.summary.occupancy.checkOut = newReturnDate || updated.summary.occupancy.checkOut;
      }
    }

    if (updated.hotel) {
      const pricePerNight = updated.hotel.pricePerNight || 0;
      const hotelTotal    = pricePerNight * newNights;

      updated.hotel.nights   = newNights;
      updated.hotel.checkOut = newReturnDate || updated.hotel.checkOut;
      updated.hotel.totalRate = hotelTotal;

      // Recalculate package total
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
  // Called when user explicitly asks to start over.
  // Clears history, params, and package hold but keeps
  // the contact record itself (name, etc).
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
      });
    } catch (err) {
      logger.error('ConversationMemory: clearConversation threw', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL MID-BOOKING
  // Clears the whatsapp_booking_session without touching the
  // conversation memory — so the user can immediately pivot
  // to a different package or search without losing context.
  // ─────────────────────────────────────────────
  async cancelMidBooking(phone, agencyId) {
    try {
      // Delete active booking session
      const supabaseClient = require('../utils/supabase');
      await supabaseClient
        .from('whatsapp_booking_sessions')
        .delete()
        .eq('phone', phone);

      // Clear the selected package hold — they abandoned it
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