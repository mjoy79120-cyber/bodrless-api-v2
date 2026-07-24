/**
 * TRAVELER INTELLIGENCE SERVICE
 * ─────────────────────────────────────────────────────────────
 * Two responsibilities merged into one service:
 *
 * 1. REAL-TIME ANALYSIS (per prompt)
 *    Analyses the current prompt to understand this trip —
 *    purpose, budget sensitivity, scoring weights, orchestration
 *    hints. Used by the engine on every search.
 *
 * 2. CROSS-SESSION MEMORY (per traveler)
 *    Stores preferences across trips so Bodrless remembers
 *    what the traveler loves — seat, cabin, loyalty programs,
 *    hotel brands, points balances. Follows them across agencies
 *    and channels (WhatsApp + web).
 *
 * 3. LEARNING LOOP
 *    When strong signals are detected in a prompt (business trip,
 *    refund sensitivity, luxury preference), they are persisted
 *    to the travelers table so the next trip benefits automatically.
 *    This is the Waze layer — every interaction makes Bodrless smarter.
 *
 * Usage:
 *   // Real-time analysis only
 *   const profile = travelerIntelligence.analyze(parsedTrip, prompt);
 *
 *   // Analysis + persist learning (preferred — use this in the engine)
 *   const profile = await travelerIntelligence.analyzeAndLearn(parsedTrip, prompt, phone);
 *
 *   // Apply stored preferences to search params before every search
 *   const enriched = await travelerIntelligence.applyToSearchParams(phone, searchParams);
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// PREFERENCE EXTRACTION PATTERNS
// ─────────────────────────────────────────────

const SEAT_PATTERNS = [
  { pattern: /exit\s*row/i,                      value: 'exit_row' },
  { pattern: /window\s*seat|by\s*the\s*window/i, value: 'window'   },
  { pattern: /aisle\s*seat|on\s*the\s*aisle/i,   value: 'aisle'    },
];

const CABIN_PATTERNS = [
  { pattern: /business\s*class|in\s*business/i,              value: 'business'         },
  { pattern: /premium\s*economy|premium\s*eco/i,             value: 'premium_economy'  },
  { pattern: /first\s*class/i,                               value: 'first'            },
  { pattern: /economy\s*class|in\s*economy|just\s*economy/i, value: 'economy'          },
];

const WORK_ON_FLIGHT_PATTERNS = [
  /work\s*on\s*(the\s*)?flight/i,
  /i\s*work\s*(on|during)\s*(flights|planes)/i,
  /need\s*to\s*(work|type|write)\s*(on|during)\s*(the\s*)?(flight|plane)/i,
  /do\s*my\s*(best\s*)?(work|writing)\s*(on|in)\s*(planes|flights)/i,
  /productive\s*on\s*(the\s*)?(flight|plane)/i,
];

const BAGGAGE_PATTERNS = [
  { pattern: /carry[\s-]*on\s*only|just\s*carry[\s-]*on|prefer\s*carry[\s-]*on/i, value: 'carry_on' },
  { pattern: /check\s*(my\s*)?bag|checked\s*bag|i\s*check\s*luggage/i,            value: 'checked'  },
];

const HOTEL_BRAND_PATTERNS = [
  'Marriott', 'Sheraton', 'Westin', 'Hilton', 'Hyatt', 'Radisson',
  'Sarova', 'Serena', 'Fairmont', 'Four Seasons', 'Intercontinental',
  'IHG', 'Accor', 'Novotel', 'Ibis', 'Mövenpick', 'Kempinski',
  'Best Western', 'Holiday Inn', 'Crowne Plaza', 'Protea',
];

const ROOM_PREFERENCE_PATTERNS = [
  { pattern: /quiet\s*room|away\s*from\s*(noise|elevator|lift|traffic)/i, value: 'quiet'              },
  { pattern: /away\s*from\s*(the\s*)?(elevator|lift)/i,                   value: 'away_from_elevator' },
  { pattern: /high\s*floor|upper\s*floor|top\s*floor/i,                   value: 'high_floor'         },
  { pattern: /low\s*floor|ground\s*floor|lower\s*floor/i,                 value: 'low_floor'          },
  { pattern: /dark\s*room|blackout\s*curtains/i,                          value: 'dark_room'          },
  { pattern: /non[\s-]*smoking/i,                                          value: 'non_smoking'        },
  { pattern: /city\s*view|ocean\s*view|pool\s*view/i,                     value: 'view'               },
];

const LOYALTY_PATTERNS = [
  { airline: 'KQ', program: 'Asante',        pattern: /KQ[\s-]?(\w{6,10})/i                                          },
  { airline: 'ET', program: 'ShebaMiles',    pattern: /ET[\s-]?(\w{6,10})|shebamiles[\s#:]+(\w{6,10})/i             },
  { airline: 'EK', program: 'Skywards',      pattern: /skywards[\s#:]+(\w{6,10})|EK[\s-]?(\d{9,10})/i              },
  { airline: 'QR', program: 'Privilege Club', pattern: /privilege[\s-]?club[\s#:]+(\w{6,10})|QR[\s-]?(\w{6,10})/i  },
  { airline: 'UA', program: 'MileagePlus',   pattern: /mileage[\s-]?plus[\s#:]+(\w{6,10})/i                         },
  { airline: 'AF', program: 'Flying Blue',   pattern: /flying[\s-]?blue[\s#:]+(\w{6,10})/i                          },
  { airline: 'BA', program: 'Avios',         pattern: /avios[\s#:]+(\w{6,10})|executive[\s-]?club[\s#:]+(\w{6,10})/i },
  { airline: 'LH', program: 'Miles & More',  pattern: /miles\s*&?\s*more[\s#:]+(\w{6,10})/i                         },
];

const POINTS_BALANCE_PATTERNS = [
  { pattern: /i\s*(have|got|earned)\s*(about\s*)?(\d[\d,k\.]+)\s*(KQ|kenya\s*airways?)\s*(miles?|points?)/i,  airline: 'KQ', program: 'Asante'      },
  { pattern: /i\s*(have|got|earned)\s*(about\s*)?(\d[\d,k\.]+)\s*skywards\s*(miles?|points?)/i,              airline: 'EK', program: 'Skywards'    },
  { pattern: /i\s*(have|got|earned)\s*(about\s*)?(\d[\d,k\.]+)\s*flying[\s-]?blue\s*(miles?|points?)/i,      airline: 'AF', program: 'Flying Blue'  },
  { pattern: /i\s*(have|got|earned)\s*(about\s*)?(\d[\d,k\.]+)\s*avios/i,                                    airline: 'BA', program: 'Avios'        },
];

// ─────────────────────────────────────────────
// CONFIDENCE THRESHOLDS FOR LEARNING
// Only persist signals above these thresholds
// to avoid learning from one-off requests.
// ─────────────────────────────────────────────
const LEARN_THRESHOLDS = {
  refundSensitivity:   8,   // persist if >= 8
  luxuryPreference:    8,   // persist if >= 8
  conveniencePriority: 8,   // persist if >= 8
};

class TravelerIntelligenceService {

  // ═════════════════════════════════════════════════════════════
  // PART 1: REAL-TIME PROMPT ANALYSIS
  // ═════════════════════════════════════════════════════════════

  /**
   * Analyse a single prompt and return a full traveler profile.
   * Pure function — no DB calls. Fast.
   */
  analyze(parsedTrip = {}, originalPrompt = '') {
    const text = (originalPrompt || '').toLowerCase();

    const profile = {
      travelerType:        this.detectTravelerType(parsedTrip, text),
      tripPurpose:         this.detectTripPurpose(parsedTrip, text),
      budgetSensitivity:   this.detectBudgetSensitivity(parsedTrip, text),
      conveniencePriority: this.detectConveniencePriority(text),
      luxuryPreference:    this.detectLuxuryPreference(parsedTrip, text),
      familyFriendly:      this.detectFamilyFriendly(text),
      preferredTransport:  this.detectTransportPreference(parsedTrip, text),
      maxStops:            this.detectMaxStops(text),
      hotelPreferences:    this.detectHotelPreferences(parsedTrip, text),
      beachAffinity:       this.detectBeachAffinity(parsedTrip, text),
      safariAffinity:      this.detectSafariAffinity(parsedTrip, text),
      adventureAffinity:   this.detectAdventureAffinity(text),
      confidence:          1.0,
    };

    profile.refundSensitivity   = this.detectRefundSensitivity(text);
    profile.timeCritical        = this.detectTimeCritical(text);
    profile.transferTolerance   = this.detectTransferTolerance(profile, text);
    profile.riskTolerance       = this.detectRiskTolerance(profile, text);
    profile.scoringWeights      = this.buildScoringWeights(profile);

    profile.orchestrationHints = {
      prioritizeRefundable: profile.refundSensitivity >= 8,
      avoidTransfers:       profile.transferTolerance === 0,
      prioritizeArrivalTime: profile.timeCritical,
      prioritizeComfort:    profile.tripPurpose === 'honeymoon' || profile.familyFriendly,
      prioritizeLowestPrice: profile.budgetSensitivity === 'high',
    };

    logger.info('TravelerIntelligence: profile generated', {
      travelerType: profile.travelerType,
      tripPurpose:  profile.tripPurpose,
      budgetSensitivity: profile.budgetSensitivity,
    });

    return profile;
  }

  /**
   * Analyse prompt AND persist strong signals to travelers table.
   * Use this in the engine — it's the learning loop entry point.
   * Falls back gracefully if phone is null (anonymous/widget users).
   */
  async analyzeAndLearn(parsedTrip = {}, originalPrompt = '', phone = null) {
    const profile = this.analyze(parsedTrip, originalPrompt);

    if (phone) {
      await this._persistLearningSignals(phone, profile, originalPrompt);
    }

    return profile;
  }

  /**
   * Merge stored traveler preferences into an analyzed profile.
   * Call after analyzeAndLearn to get the full picture —
   * real-time signals + long-term memory combined.
   */
  async mergeWithStoredPreferences(phone, profile) {
    if (!phone) return profile;

    try {
      const stored = await this.loadPreferences(phone);
      if (!stored) return profile;

      const merged = { ...profile };

      // Stored seat preference overrides prompt default (not explicit override)
      if (stored.seat_preference && !profile._explicitSeat) {
        merged.seatPreference = stored.seat_preference;
      }

      // Stored cabin preference
      if (stored.cabin_preference && !profile._explicitCabin) {
        merged.cabinPreference = stored.cabin_preference;
      }

      // Work on flight — always apply if stored
      if (stored.work_on_flight) {
        merged.workOnFlight   = true;
        merged.seatPreference = 'exit_row';
        if (!merged.cabinPreference || merged.cabinPreference === 'economy') {
          merged.preferPremiumEconomy = true;
        }
      }

      // Hotel brands
      if (stored.hotel_brands?.length > 0) {
        merged.preferredHotelBrands = stored.hotel_brands;
      }

      // Room preferences
      if (stored.room_preferences?.length > 0) {
        merged.roomPreferences = stored.room_preferences;
      }

      // Loyalty programs — pass to flight search
      if (stored.loyalty_programs?.length > 0) {
        merged.loyaltyPrograms = stored.loyalty_programs;
      }

      // Baggage preference
      if (stored.baggage_preference) {
        merged.baggagePreference = stored.baggage_preference;
      }

      // Always refundable preference (learned from past trips)
      if (stored.extra_preferences?.alwaysRefundable) {
        merged.orchestrationHints.prioritizeRefundable = true;
        merged.scoringWeights.refundFlexibility = 10;
      }

      logger.info('TravelerIntelligence: merged with stored preferences', {
        phone,
        seatPreference:       merged.seatPreference,
        cabinPreference:      merged.cabinPreference,
        preferredHotelBrands: merged.preferredHotelBrands,
        loyaltyPrograms:      merged.loyaltyPrograms?.map(lp => lp.airline),
      });

      return merged;

    } catch (err) {
      logger.error('TravelerIntelligence: mergeWithStoredPreferences threw', { phone, error: err.message });
      return profile;
    }
  }

  // ─────────────────────────────────────────────
  // LEARNING LOOP — persist strong signals
  // ─────────────────────────────────────────────
  async _persistLearningSignals(phone, profile, originalPrompt) {
    try {
      const updates = {};
      const text    = (originalPrompt || '').toLowerCase();

      // Business traveler → prefer refundable always
      if (profile.tripPurpose === 'business') {
        const extra = await this._getExtraPreferences(phone);
        updates.extra_preferences = {
          ...extra,
          alwaysRefundable:   true,
          preferredPurpose:   'business',
        };
        // Business travelers implicitly prefer premium economy minimum
        if (!updates.cabin_preference) {
          updates.cabin_preference = 'premium_economy';
        }
      }

      // Honeymoon → luxury flag
      if (profile.tripPurpose === 'honeymoon') {
        const extra = await this._getExtraPreferences(phone);
        updates.extra_preferences = {
          ...extra,
          honeymooner: true,
        };
      }

      // High refund sensitivity
      if (profile.refundSensitivity >= LEARN_THRESHOLDS.refundSensitivity) {
        const extra = await this._getExtraPreferences(phone);
        updates.extra_preferences = {
          ...(updates.extra_preferences || extra),
          alwaysRefundable: true,
        };
      }

      // Explicit seat from prompt
      for (const { pattern, value } of SEAT_PATTERNS) {
        if (pattern.test(originalPrompt)) {
          updates.seat_preference = value;
          profile._explicitSeat   = true;
          break;
        }
      }

      // Work on flight
      if (WORK_ON_FLIGHT_PATTERNS.some(p => p.test(originalPrompt))) {
        updates.work_on_flight  = true;
        updates.seat_preference = updates.seat_preference || 'exit_row';
        profile._explicitSeat   = true;
      }

      // Explicit cabin from prompt
      for (const { pattern, value } of CABIN_PATTERNS) {
        if (pattern.test(originalPrompt)) {
          updates.cabin_preference = value;
          profile._explicitCabin   = true;
          break;
        }
      }

      // Hotel brands
      const mentionedBrands = HOTEL_BRAND_PATTERNS.filter(brand =>
        new RegExp(brand, 'i').test(originalPrompt)
      );
      if (mentionedBrands.length > 0) {
        const stored = await this.loadPreferences(phone);
        const existing = stored?.hotel_brands || [];
        updates.hotel_brands = [...new Set([...existing, ...mentionedBrands])];
      }

      // Room preferences
      const mentionedRoomPrefs = ROOM_PREFERENCE_PATTERNS
        .filter(({ pattern }) => pattern.test(originalPrompt))
        .map(({ value }) => value);
      if (mentionedRoomPrefs.length > 0) {
        const stored   = await this.loadPreferences(phone);
        const existing = stored?.room_preferences || [];
        updates.room_preferences = [...new Set([...existing, ...mentionedRoomPrefs])];
      }

      // Baggage preference
      for (const { pattern, value } of BAGGAGE_PATTERNS) {
        if (pattern.test(originalPrompt)) {
          updates.baggage_preference = value;
          break;
        }
      }

      // Loyalty programs
      for (const { airline, program, pattern } of LOYALTY_PATTERNS) {
        const match = originalPrompt.match(pattern);
        if (match) {
          const number = match[1] || match[2] || null;
          if (number) await this.saveLoyaltyProgram(phone, { airline, program, number });
        }
      }

      // Points balances
      for (const { pattern, airline, program } of POINTS_BALANCE_PATTERNS) {
        const match = originalPrompt.match(pattern);
        if (match) {
          const balance = this._parseBalance(match[3] || match[2] || '0');
          if (balance > 0) await this.savePointsBalance(phone, { airline, program, balance });
        }
      }

      // Only upsert if we have something to save
      if (Object.keys(updates).length > 0) {
        const { error } = await supabase
          .from('travelers')
          .upsert({
            phone,
            ...updates,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'phone' });

        if (error) {
          logger.warn('TravelerIntelligence: failed to persist learning signals', { phone, error: error.message });
        } else {
          logger.info('TravelerIntelligence: learning signals persisted', { phone, keys: Object.keys(updates) });
        }
      }

    } catch (err) {
      logger.error('TravelerIntelligence: _persistLearningSignals threw', { phone, error: err.message });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PART 2: CROSS-SESSION MEMORY
  // ═════════════════════════════════════════════════════════════

  async getOrCreateTraveler(phone) {
    try {
      const { data, error } = await supabase
        .from('travelers')
        .upsert({ phone }, { onConflict: 'phone' })
        .select('*')
        .single();

      if (error) {
        logger.warn('TravelerIntelligence: getOrCreateTraveler failed', { phone, error: error.message });
        return null;
      }
      return data;
    } catch (err) {
      logger.error('TravelerIntelligence: getOrCreateTraveler threw', { phone, error: err.message });
      return null;
    }
  }

  async loadPreferences(phone) {
    try {
      const { data, error } = await supabase
        .from('travelers')
        .select('*')
        .eq('phone', phone)
        .maybeSingle();

      if (error || !data) return null;
      return data;
    } catch (err) {
      logger.error('TravelerIntelligence: loadPreferences threw', { phone, error: err.message });
      return null;
    }
  }

  async savePreference(phone, key, value) {
    const allowed = [
      'seat_preference', 'cabin_preference', 'work_on_flight',
      'baggage_preference', 'hotel_brands', 'room_preferences',
      'extra_preferences', 'full_name',
    ];
    if (!allowed.includes(key)) {
      logger.warn('TravelerIntelligence: savePreference unknown key', { phone, key });
      return;
    }
    try {
      const { error } = await supabase
        .from('travelers')
        .upsert({ phone, [key]: value, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

      if (error) logger.warn('TravelerIntelligence: savePreference failed', { phone, key, error: error.message });
      else       logger.info('TravelerIntelligence: preference saved', { phone, key, value });
    } catch (err) {
      logger.error('TravelerIntelligence: savePreference threw', { phone, key, error: err.message });
    }
  }

  async saveLoyaltyProgram(phone, { airline, program, number }) {
    try {
      const traveler = await this.loadPreferences(phone);
      const existing = traveler?.loyalty_programs || [];
      const updated  = existing.filter(lp => lp.airline !== airline);
      updated.push({ airline, program, number, addedAt: new Date().toISOString() });

      const { error } = await supabase
        .from('travelers')
        .upsert({ phone, loyalty_programs: updated, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

      if (error) logger.warn('TravelerIntelligence: saveLoyaltyProgram failed', { phone, error: error.message });
      else       logger.info('TravelerIntelligence: loyalty saved', { phone, airline, program, number });
    } catch (err) {
      logger.error('TravelerIntelligence: saveLoyaltyProgram threw', { phone, error: err.message });
    }
  }

  async savePointsBalance(phone, { airline, program, balance, currency = 'miles' }) {
    try {
      const traveler = await this.loadPreferences(phone);
      const existing = traveler?.points_balances || [];
      const updated  = existing.filter(pb => pb.airline !== airline);
      updated.push({ airline, program, balance, currency, updatedAt: new Date().toISOString(), source: 'self_reported' });

      const { error } = await supabase
        .from('travelers')
        .upsert({ phone, points_balances: updated, updated_at: new Date().toISOString() }, { onConflict: 'phone' });

      if (error) logger.warn('TravelerIntelligence: savePointsBalance failed', { phone, error: error.message });
      else       logger.info('TravelerIntelligence: points saved', { phone, airline, balance });
    } catch (err) {
      logger.error('TravelerIntelligence: savePointsBalance threw', { phone, error: err.message });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PART 3: SEARCH PARAM ENRICHMENT
  // ═════════════════════════════════════════════════════════════

  async applyToSearchParams(phone, searchParams) {
    try {
      const prefs = await this.loadPreferences(phone);
      if (!prefs) return searchParams;

      const enriched = { ...searchParams };

      if (prefs.seat_preference && !enriched.seatPreference)
        enriched.seatPreference = prefs.seat_preference;

      if (prefs.work_on_flight) {
        enriched.seatPreference = 'exit_row';
        if (!enriched.cabinClass || enriched.cabinClass === 'economy')
          enriched.preferPremiumEconomy = true;
      }

      if (prefs.cabin_preference && !enriched.cabinClass)
        enriched.cabinClass = prefs.cabin_preference;

      if (prefs.baggage_preference && !enriched.baggagePreference)
        enriched.baggagePreference = prefs.baggage_preference;

      if (prefs.hotel_brands?.length > 0 && !enriched.preferredHotelBrands)
        enriched.preferredHotelBrands = prefs.hotel_brands;

      if (prefs.room_preferences?.length > 0 && !enriched.roomPreferences)
        enriched.roomPreferences = prefs.room_preferences;

      if (prefs.loyalty_programs?.length > 0 && !enriched.loyaltyPrograms)
        enriched.loyaltyPrograms = prefs.loyalty_programs;

      if (prefs.extra_preferences?.alwaysRefundable)
        enriched.preferRefundable = true;

      logger.info('TravelerIntelligence: search params enriched', {
        phone,
        seatPreference:       enriched.seatPreference,
        cabinClass:           enriched.cabinClass,
        preferredHotelBrands: enriched.preferredHotelBrands,
        preferRefundable:     enriched.preferRefundable,
      });

      return enriched;
    } catch (err) {
      logger.error('TravelerIntelligence: applyToSearchParams threw', { phone, error: err.message });
      return searchParams;
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PART 4: WHATSAPP OUTPUT HELPERS
  // ═════════════════════════════════════════════════════════════

  async buildPointsSummary(phone, airlines = []) {
    try {
      const prefs = await this.loadPreferences(phone);
      if (!prefs?.points_balances?.length) return null;

      const relevant = airlines.length > 0
        ? prefs.points_balances.filter(pb => airlines.includes(pb.airline))
        : prefs.points_balances;

      if (relevant.length === 0) return null;

      const lines = ['💳 *Your points balances:*'];
      for (const pb of relevant) {
        lines.push(`  ${pb.program || pb.airline}: *${pb.balance.toLocaleString()} ${pb.currency}*`);
      }
      return lines.join('\n');
    } catch (err) {
      logger.error('TravelerIntelligence: buildPointsSummary threw', { phone, error: err.message });
      return null;
    }
  }

  buildPreferenceConfirmation(changed = []) {
    if (!changed || changed.length === 0) return null;
    const messages = [];

    if (changed.some(c => c.includes('exit_row') || c.includes('work_on_flight')))
      messages.push("Got it — I'll always look for exit row seats for you 💺");
    else if (changed.some(c => c.includes('seat: window')))
      messages.push("Noted — window seat it is 🪟");
    else if (changed.some(c => c.includes('seat: aisle')))
      messages.push("Noted — aisle seat preference saved ✓");

    if (changed.some(c => c.includes('cabin: business')))
      messages.push("Business class preference saved ✓");
    else if (changed.some(c => c.includes('cabin: premium_economy')))
      messages.push("Premium economy preference saved ✓");

    if (changed.some(c => c.includes('hotel_brands')))
      messages.push("Hotel brand preference noted ✓");

    if (changed.some(c => c.includes('room_prefs')))
      messages.push("Room preference saved — I'll filter for that next time 🏨");

    if (changed.some(c => c.includes('loyalty')))
      messages.push("Frequent flyer number saved — I'll look for earning opportunities 🎯");

    if (changed.some(c => c.includes('points')))
      messages.push("Points balance noted — I'll let you know when you can redeem ✨");

    return messages.length > 0 ? messages.join('\n') : null;
  }

  /**
   * Extract preferences from a raw message and save them.
   * Returns { extracted, changed } for confirmation display.
   */
  async extractAndSave(phone, message) {
    const text    = message || '';
    const changed = [];
    const extracted = {};

    for (const { pattern, value } of SEAT_PATTERNS) {
      if (pattern.test(text)) {
        extracted.seat_preference = value;
        await this.savePreference(phone, 'seat_preference', value);
        changed.push(`seat: ${value}`);
        break;
      }
    }

    if (WORK_ON_FLIGHT_PATTERNS.some(p => p.test(text))) {
      extracted.work_on_flight  = true;
      extracted.seat_preference = extracted.seat_preference || 'exit_row';
      await this.savePreference(phone, 'work_on_flight', true);
      await this.savePreference(phone, 'seat_preference', extracted.seat_preference);
      changed.push('work_on_flight: true');
    }

    for (const { pattern, value } of CABIN_PATTERNS) {
      if (pattern.test(text)) {
        extracted.cabin_preference = value;
        await this.savePreference(phone, 'cabin_preference', value);
        changed.push(`cabin: ${value}`);
        break;
      }
    }

    for (const { pattern, value } of BAGGAGE_PATTERNS) {
      if (pattern.test(text)) {
        extracted.baggage_preference = value;
        await this.savePreference(phone, 'baggage_preference', value);
        changed.push(`baggage: ${value}`);
        break;
      }
    }

    const mentionedBrands = HOTEL_BRAND_PATTERNS.filter(brand =>
      new RegExp(brand, 'i').test(text)
    );
    if (mentionedBrands.length > 0) {
      const traveler      = await this.loadPreferences(phone);
      const existingBrands = traveler?.hotel_brands || [];
      const merged        = [...new Set([...existingBrands, ...mentionedBrands])];
      extracted.hotel_brands = merged;
      await this.savePreference(phone, 'hotel_brands', merged);
      changed.push(`hotel_brands: ${mentionedBrands.join(', ')}`);
    }

    const mentionedRoomPrefs = ROOM_PREFERENCE_PATTERNS
      .filter(({ pattern }) => pattern.test(text))
      .map(({ value }) => value);
    if (mentionedRoomPrefs.length > 0) {
      const traveler          = await this.loadPreferences(phone);
      const existingRoomPrefs = traveler?.room_preferences || [];
      const merged            = [...new Set([...existingRoomPrefs, ...mentionedRoomPrefs])];
      extracted.room_preferences = merged;
      await this.savePreference(phone, 'room_preferences', merged);
      changed.push(`room_prefs: ${mentionedRoomPrefs.join(', ')}`);
    }

    for (const { airline, program, pattern } of LOYALTY_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const number = match[1] || match[2] || null;
        if (number) {
          extracted.loyalty = extracted.loyalty || [];
          extracted.loyalty.push({ airline, program, number });
          await this.saveLoyaltyProgram(phone, { airline, program, number });
          changed.push(`loyalty: ${program} ${number}`);
        }
      }
    }

    for (const { pattern, airline, program } of POINTS_BALANCE_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const balance = this._parseBalance(match[3] || match[2] || '0');
        if (balance > 0) {
          extracted.points = extracted.points || [];
          extracted.points.push({ airline, program, balance });
          await this.savePointsBalance(phone, { airline, program, balance });
          changed.push(`points: ${program || airline} ${balance.toLocaleString()}`);
        }
      }
    }

    if (changed.length > 0) {
      logger.info('TravelerIntelligence: extracted from message', { phone, changed });
    }

    return { extracted, changed };
  }

  // ═════════════════════════════════════════════════════════════
  // REAL-TIME DETECTION METHODS (from original TravelerIntelligence)
  // ═════════════════════════════════════════════════════════════

  detectTravelerType(parsedTrip, text) {
    const travelers = parsedTrip.passengers || parsedTrip.travelers || 1;
    if (text.match(/wife|husband|girlfriend|boyfriend|partner|honeymoon|mke|mume|mchumba|mpenzi/)) return 'couple';
    if (text.match(/family|kids|children|familia|watoto|mtoto/) || parsedTrip.preferences?.includes('family')) return 'family';
    if (travelers >= 5) return 'group';
    return travelers === 1 ? 'solo' : 'group';
  }

  detectTripPurpose(parsedTrip, text) {
    if (parsedTrip.preferences?.includes('business') || text.match(/business|conference|meeting|mkutano|kazi/)) return 'business';
    if (parsedTrip.preferences?.includes('honeymoon') || text.includes('honeymoon')) return 'honeymoon';
    if (parsedTrip.preferences?.includes('safari') || text.match(/safari|hiking|trekking|porini/)) return 'adventure';
    return 'vacation';
  }

  detectBudgetSensitivity(parsedTrip, text) {
    if (parsedTrip.budget) {
      if (parsedTrip.budget === 'low') return 'high';
      if (parsedTrip.budget === 'luxury' || parsedTrip.budget === 'high') return 'low';
      return 'medium';
    }
    const highBudgetWords = ['cheap', 'budget', 'affordable', 'low cost', 'economical', 'save money', 'rahisi', 'bei nafuu'];
    const luxuryWords     = ['luxury', 'premium', '5 star', 'five star', 'exclusive', 'vip', 'kifahari'];
    if (highBudgetWords.some(w => text.includes(w))) return 'high';
    if (luxuryWords.some(w => text.includes(w)))     return 'low';
    return 'medium';
  }

  detectConveniencePriority(text) {
    return text.match(/direct|non stop|no layovers|fastest|quickest|bila kusimama|haraka/) ? 10 : 5;
  }

  detectLuxuryPreference(parsedTrip, text) {
    if (parsedTrip.budget === 'luxury') return 10;
    return text.match(/luxury|premium|5 star|exclusive|vip|honeymoon|kifahari/) ? 10 : 5;
  }

  detectFamilyFriendly(text) {
    return !!text.match(/family|kids|children|familia|watoto|mtoto/);
  }

  detectTransportPreference(parsedTrip, text) {
    if (parsedTrip.outboundTransportMode) {
      return parsedTrip.outboundTransportMode === 'flight' ? 'air' : parsedTrip.outboundTransportMode;
    }
    if (text.match(/flight|fly|ndege/))       return 'air';
    if (text.match(/bus|coach|basi|matatu/))   return 'bus';
    if (text.match(/train|sgr|treni/))         return 'train';
    return 'any';
  }

  detectMaxStops(text) {
    return text.match(/direct|non stop|no layovers|bila kusimama/) ? 0 : null;
  }

  detectHotelPreferences(parsedTrip, text) {
    const preferences = [];
    if (text.match(/beach|pwani|bahari/) || parsedTrip.preferences?.includes('beach')) preferences.push('beachfront');
    if (text.match(/pool|kuogelea/))                                                    preferences.push('pool');
    if (parsedTrip.mealPlan === 'all_inclusive' || text.match(/all inclusive|chakula chote/)) preferences.push('all_inclusive');
    if (text.includes('spa'))                                                           preferences.push('spa');
    return preferences;
  }

  detectBeachAffinity(parsedTrip, text) {
    return (text.match(/beach|zanzibar|diani|watamu|kilifi|lamu|pwani|bahari/) || parsedTrip.preferences?.includes('beach')) ? 10 : 5;
  }

  detectSafariAffinity(parsedTrip, text) {
    return (text.match(/safari|maasai mara|mara|serengeti|amboseli|tsavo|porini/) || parsedTrip.preferences?.includes('safari')) ? 10 : 5;
  }

  detectAdventureAffinity(text) {
    return text.match(/hiking|trekking|climbing|kupanda|milima/) ? 10 : 5;
  }

  detectRefundSensitivity(text) {
    return text.match(/refundable|flexible|may change|might change|tentative|not sure|change dates|cancel|cancellation|kubadilisha|kughairi|kurudisha pesa/) ? 10 : 5;
  }

  detectTransferTolerance(profile, text) {
    if (text.match(/direct|non stop|no layovers|bila kusimama/)) return 0;
    if (profile.budgetSensitivity === 'high')  return 3;
    if (profile.tripPurpose === 'business')    return 1;
    return 2;
  }

  detectRiskTolerance(profile, text) {
    if (text.match(/elderly|senior|old parents|grandmother|grandfather|wazee|babu|nyanya/)) return 'low';
    if (profile.familyFriendly || profile.tripPurpose === 'business') return 'low';
    return 'medium';
  }

  detectTimeCritical(text) {
    return !!text.match(/must arrive|need to be|conference|meeting|event starts|before|deadline|wedding|appointment|lazima|haraka|harusi|mkutano/);
  }

  buildScoringWeights(profile) {
    const weights = { price: 5, convenience: 5, hotelQuality: 5, transferComfort: 5, refundFlexibility: 5 };

    if (profile.budgetSensitivity === 'high') {
      weights.price = 10; weights.convenience = 4; weights.hotelQuality = 3;
    }
    if (profile.tripPurpose === 'business') {
      weights.price = 3; weights.convenience = 10; weights.hotelQuality = 8; weights.refundFlexibility = 9;
    }
    if (profile.tripPurpose === 'honeymoon') {
      weights.price = 3; weights.hotelQuality = 10; weights.transferComfort = 9;
    }
    if (profile.familyFriendly) {
      weights.transferComfort = 9; weights.convenience = 8;
    }
    if (profile.refundSensitivity >= 8)  weights.refundFlexibility = 10;
    if (profile.timeCritical)            weights.convenience = 10;

    return weights;
  }

  // ═════════════════════════════════════════════════════════════
  // UTILITIES
  // ═════════════════════════════════════════════════════════════

  async _getExtraPreferences(phone) {
    try {
      const stored = await this.loadPreferences(phone);
      return stored?.extra_preferences || {};
    } catch {
      return {};
    }
  }

  _parseBalance(raw) {
    if (!raw) return 0;
    const str = String(raw).replace(/,/g, '').toLowerCase().trim();
    if (str.endsWith('k')) return Math.round(parseFloat(str) * 1000);
    if (str.endsWith('m')) return Math.round(parseFloat(str) * 1000000);
    return parseInt(str, 10) || 0;
  }
}

module.exports = new TravelerIntelligenceService();