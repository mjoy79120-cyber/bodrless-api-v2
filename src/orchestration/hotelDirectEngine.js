// HOTEL DIRECT ENGINE — v4
// Fixed: destination extraction is now property-first (match raw prompt against
// known property names/aliases/destinations before falling back to strip-based
// extraction). Handles any prompt phrasing without needing exhaustive verb lists.

const { v4: uuidv4 } = require('uuid');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// NOISE PATTERNS — everything that is NOT the property/destination name.
// Order matters: strip longer phrases before single words.
// ─────────────────────────────────────────────────────────────────────────────
const NOISE_PATTERNS = [
  /\b(?:can\s+(?:you\s+)?(?:please\s+)?)?(?:find|search|look\s+up|look\s+for|show|get|book|reserve|check|need|want|require|suggest|recommend)(?:\s+(?:me|us))?\b/gi,
  /\bi(?:'d|\s+would)\s+like(?:\s+to)?(?:\s+(?:book|reserve|find|get))?\b/gi,
  /\bi\s+(?:want|need)(?:\s+to)?(?:\s+(?:book|reserve|find|get))?\b/gi,
  /\bplease\b/gi,
  /\bhelp\s+(?:me|us)\b/gi,
  /\bcan\s+(?:i|we)\s+(?:get|have|book|reserve)\b/gi,
  /\b(?:a\s+)?(?:room|rooms|suite|suites|deluxe|standard|superior|junior|double|twin|single|king|queen|family\s+room|bed)\b/gi,
  /\b(?:all[\s-]inclusive|full[\s-]board|half[\s-]board|bed\s+and\s+breakfast|b&b|room\s+only|no\s+meals|with\s+breakfast|including\s+breakfast)\b/gi,
  /\bfor\s+\d+\s*nights?\b/gi,
  /\d+\s*(?:nights?|nts?)\b/gi,
  /\bfor\s+\d+\s*(?:people|persons?|pax|adults?|guests?|of\s+us|travelers?)\b/gi,
  /\b\d+\s*(?:people|persons?|pax|adults?|guests?|of\s+us|travelers?)\b/gi,
  /\bcouple\b|\btwo\s+of\s+us\b|\b2\s+of\s+us\b|\bfor\s+two\b|\bfor\s+2\b/gi,
  /\bfrom\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b/gi,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?\b/gi,
  /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+\d{4})?\b/gi,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b(?:this\s+weekend|next\s+week(?:end)?|tomorrow|today|tonight)\b/gi,
  /\b(?:next|this|coming)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
  /\b(?:starting|arriving?|check(?:ing)?[\s-]in|departure|from|on|by)\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b/gi,
  /\b(?:luxury|premium|budget|affordable|cheap|5[\s-]?star|five[\s-]?star|4[\s-]?star|four[\s-]?star|3[\s-]?star)\b/gi,
  /\b(?:honeymoon|romantic|anniversary|family|business|corporate|beach|safari|game\s+drive|spa|wellness|relaxation|vacation|holiday|trip|getaway|escape|stay|visit)\b/gi,
  /\b(?:my|our|your|their|his|her|its)\b/gi,
  /\b(?:at\s+the|at\s+a|in\s+the|in\s+a|for\s+a|for\s+the)\b/gi,
  /\b(?:^|\s)(?:in|at|the|a|an|for|us|me|with|of|from|some|any|on)\b/gi,
];

function stripNoise(text) {
  let s = text;
  for (const pattern of NOISE_PATTERNS) {
    s = s.replace(pattern, ' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

function parseHotelPrompt(prompt) {
  const lower = (prompt || '').toLowerCase().trim();

  const legSplitMatch = lower.match(
    /^(.*?)\s+(?:and\s+then|then|and\s+also|followed\s+by)\s+(.+)$/i
  );

  if (legSplitMatch) {
    const p1 = parseHotelPrompt(legSplitMatch[1]);
    const p2 = parseHotelPrompt(legSplitMatch[2]);

    if (p1.destination && p2.destination) {
      return {
        destination:         null,
        nights:              p1.nights,
        adults:              p1.adults,
        passengers:          p1.adults,
        children:            p1.children,
        childAges:           [],
        mealPlan:            p1.mealPlan || p2.mealPlan,
        departureDate:       p1.departureDate,
        returnDate:          p1.returnDate,
        budget:              p1.budget,
        preferences:         [...new Set([...p1.preferences, ...p2.preferences])],
        isMultiDestination:  true,
        legs: [
          { destination: p1.destination, nights: p1.nights, departureDate: p1.departureDate },
          { destination: p2.destination, nights: p2.nights, departureDate: p2.departureDate },
        ],
        needsOriginClarification: false,
        requiresFlight: false,
        requiresBus:    false,
        _parsedBy:      'hotel_rules_multi',
        _originalPrompt: prompt,
      };
    }
  }

  let nights = 3;
  const nightsMatch = lower.match(/(\d+)\s*(?:night|nights|nts?)\b/i);
  if (nightsMatch) nights = parseInt(nightsMatch[1], 10);

  let adults = 1;
  const adultMatch = lower.match(/(\d+)\s*(?:people|persons?|pax|adults?|guests?|of\s+us|travelers?)\b/i);
  if (adultMatch) adults = Math.max(1, parseInt(adultMatch[1], 10));
  if (/\bcouple\b|two\s+of\s+us|2\s+of\s+us/i.test(lower)) adults = Math.max(adults, 2);
  if (/\bfamily\b/i.test(lower) && adults < 2) adults = 2;
  if (/\bfor\s+two\b|\bfor\s+2\b/i.test(lower)) adults = Math.max(adults, 2);

  let children = 0;
  const childMatch = lower.match(/(\d+)\s*(?:child(?:ren)?|kid(?:s)?)\b/i);
  if (childMatch) children = parseInt(childMatch[1], 10);

  let mealPlan = null;
  if      (/all[\s-]?inclusive/i.test(lower))               mealPlan = 'all_inclusive';
  else if (/full[\s-]?board/i.test(lower))                  mealPlan = 'full_board';
  else if (/half[\s-]?board/i.test(lower))                  mealPlan = 'half_board';
  else if (/bed[\s-]?and[\s-]?breakfast|b&b|\bbb\b/i.test(lower)) mealPlan = 'bed_and_breakfast';
  else if (/room[\s-]?only|no\s+meals/i.test(lower))        mealPlan = 'room_only';
  else if (/\bbreakfast\b/i.test(lower))                    mealPlan = 'bed_and_breakfast';

  let departureDate = null;
  const months = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,
    september:9,october:10,november:11,december:12,
  };

  const dateMatch =
    lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/i) ||
    lower.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/i);

  if (dateMatch) {
    const yr = new Date().getFullYear();
    let day, month, year;
    if (/^\d/.test(dateMatch[1] || '')) {
      day   = parseInt(dateMatch[1], 10);
      month = months[(dateMatch[2] || '').toLowerCase().slice(0, 3)];
      year  = parseInt(dateMatch[3] || yr, 10);
    } else {
      month = months[(dateMatch[1] || '').toLowerCase().slice(0, 3)];
      day   = parseInt(dateMatch[2], 10);
      year  = parseInt(dateMatch[3] || yr, 10);
    }
    if (day && month) {
      departureDate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }

  if (!departureDate) {
    const d = new Date();
    if      (/\btoday\b|\btonight\b/i.test(lower))     { /* use today */ }
    else if (/\btomorrow\b/i.test(lower))               d.setDate(d.getDate() + 1);
    else if (/this\s+weekend/i.test(lower))             d.setDate(d.getDate() + (6 - d.getDay()));
    else if (/next\s+week/i.test(lower))                d.setDate(d.getDate() + 7);
    else                                                 d.setDate(d.getDate() + 1);
    departureDate = d.toISOString().split('T')[0];
  }

  const dep = new Date(departureDate);
  dep.setDate(dep.getDate() + nights);
  const returnDate = dep.toISOString().split('T')[0];

  const destination = stripNoise(prompt).toLowerCase() || null;

  let budget = 'mid';
  if (/luxury|premium|5[\s-]?star|five[\s-]?star/i.test(lower)) budget = 'luxury';
  else if (/cheap|budget|affordable/i.test(lower))               budget = 'low';

  const preferences = [];
  if (/honeymoon|romantic/i.test(lower))    preferences.push('honeymoon');
  if (/family|kids|children/i.test(lower))  preferences.push('family');
  if (/business|corporate/i.test(lower))    preferences.push('business');
  if (/beach|ocean|sea|coast/i.test(lower)) preferences.push('beach');
  if (/safari|game|wildlife/i.test(lower))  preferences.push('safari');
  if (/spa|wellness|relax/i.test(lower))    preferences.push('spa');

  return {
    destination,
    nights,
    adults,
    passengers: adults,
    children,
    childAges: [],
    mealPlan,
    departureDate,
    returnDate,
    budget,
    preferences,
    isMultiDestination: false,
    legs: [],
    needsOriginClarification: false,
    requiresFlight: false,
    requiresBus: false,
    _parsedBy: 'hotel_rules',
    _originalPrompt: prompt,
  };
}

class HotelDirectEngine {

  async orchestrate(prompt, groupSlug, context = {}) {
    const sessionId = uuidv4();
    const { conversationHistory = [], previousParams = null } = context;

    logger.info(`[HOTEL DIRECT][${sessionId}] Started`, { groupSlug, prompt });

    try {
      const tripParams = parseHotelPrompt(prompt);
      tripParams.groupSlug = groupSlug;

      console.log('[HOTEL DIRECT] Parsed params:', tripParams);

      const group = await this._getHotelGroup(groupSlug);
      if (!group) {
        return this._buildResponse(
          sessionId, tripParams, conversationHistory,
          `I couldn't find a hotel configuration for "${groupSlug}". Please contact support.`,
          []
        );
      }

      if (tripParams.isMultiDestination && Array.isArray(tripParams.legs) && tripParams.legs.length > 0) {
        return this._orchestrateMultiProperty(tripParams, group, sessionId, prompt, conversationHistory);
      }

      return this._orchestrateSingleDestination(tripParams, group, sessionId, prompt, conversationHistory);

    } catch (err) {
      logger.error('[HOTEL DIRECT] Engine failure', { error: err.message, stack: err.stack });
      return this._buildResponse(
        sessionId, { groupSlug }, conversationHistory,
        "I had trouble with that search. Could you tell me which property and dates you're looking for?",
        []
      );
    }
  }

  async _orchestrateSingleDestination(tripParams, group, sessionId, prompt, conversationHistory) {
    const destination = tripParams.destination || '';
    const checkIn     = tripParams.departureDate;
    const checkOut    = tripParams.returnDate;
    const nights      = tripParams.nights || 1;
    const adults      = tripParams.adults || tripParams.passengers || 1;
    const children    = tripParams.children || 0;
    const childAges   = tripParams.childAges || [];
    const mealPlan    = tripParams.mealPlan || null;
    const budget      = tripParams.budget || 'mid';

    const properties = await this._findProperties(group.id, destination, tripParams._originalPrompt);

    if (properties.length === 0) {
      const allProps = await this._getAllProperties(group.id);
      const propList = allProps
        .map((p, i) => `${i + 1}. ${p.name} — ${p.destination}`)
        .join('\n');
      const context = tripParams.preferences.length
        ? ` For your ${tripParams.preferences.join(' & ')} stay`
        : '';
      return this._buildResponse(
        sessionId, tripParams, conversationHistory,
        `${context ? context + ', which' : 'Which'} ${group.name} property would you like?\n\n${propList}`,
        []
      );
    }

    const propertyResults = await Promise.all(
      properties.map(property =>
        this._searchRooms(property, {
          checkIn, checkOut, nights, adults, children, childAges, mealPlan, budget,
        }).then(rooms => ({ property, rooms }))
      )
    );

    const packages = [];
    for (const { property, rooms } of propertyResults) {
      if (!rooms.length) continue;
      const ancillaries = await this._getAncillaryServices(property.id, tripParams);
      for (const room of rooms.slice(0, 3)) {
        packages.push(this._buildRoomPackage(room, property, ancillaries, tripParams, group));
      }
    }

    if (!packages.length) {
      return this._buildResponse(
        sessionId, tripParams, conversationHistory,
        `No rooms are available at ${properties.map(p => p.name).join(' or ')} for your requested dates. Please try different dates or contact us directly.`,
        []
      );
    }

    // ── PRICE MATCH — check competitor rates and adjust if OTA is cheaper ──
    const matchedPackages = await this._applyPriceMatch(
      packages, group.slug, checkIn, nights
    );
    // ───────────────────────────────────────────────────────────────────────

    const text = matchedPackages.length === 1
      ? `Here is what we have available at ${properties[0].name}:`
      : properties.length > 1
        ? `I found ${matchedPackages.length} options across ${properties.length} of our properties:`
        : `I found ${matchedPackages.length} room option${matchedPackages.length > 1 ? 's' : ''} at ${properties[0].name}:`;

    return this._buildResponse(sessionId, tripParams, conversationHistory, text, matchedPackages);
  }

  // ── PRICE MATCH ENGINE ───────────────────────────────────────────────────
  // Silently checks competitor_rates table and adjusts package prices if an
  // OTA is beating the direct rate by more than 3%. Guest sees the best rate
  // automatically with a green badge — no action required from them.
  // ─────────────────────────────────────────────────────────────────────────
  async _applyPriceMatch(packages, groupSlug, checkIn, nights) {
    try {
      // Fetch the best (lowest) competitor rate for this group + date
      const { data: rates } = await supabase
        .from('competitor_rates')
        .select('*')
        .eq('group_slug', groupSlug)
        .eq('check_in', checkIn)
        .eq('is_current', true)
        .order('ota_rate', { ascending: true })
        .limit(1);

      if (!rates || !rates.length) return packages; // no data yet — return as-is

      const bestOTA = rates[0];

      return packages.map(pkg => {
        const hotel      = pkg.hotel || {};
        const directRate = hotel.pricePerNight;
        if (!directRate) return pkg;

        const gap = directRate - bestOTA.ota_rate;

        // Only match if OTA is more than 3% cheaper
        if (gap <= directRate * 0.03) return pkg;

        // Beat OTA by 1%
        const matchedRate    = Math.floor(bestOTA.ota_rate * 0.99);
        const savingPerNight = directRate - matchedRate;
        const newTotal       = matchedRate * (nights || 1);

        // Log it (fire and forget — don't block the response)
        supabase.from('price_match_log').insert({
          group_slug:       groupSlug,
          property_name:    hotel.propertyName,
          check_in:         checkIn,
          nights:           nights || 1,
          original_rate:    directRate,
          ota_rate:         bestOTA.ota_rate,
          matched_rate:     matchedRate,
          ota_name:         bestOTA.ota_name,
          saving_per_night: savingPerNight,
          currency:         hotel.currency || 'KES',
        }).then(() => {}).catch(() => {});

        logger.info('[PRICE MATCH] Applied', {
          property:      hotel.propertyName,
          checkIn,
          directRate,
          otaRate:       bestOTA.ota_rate,
          matchedRate,
          savingPerNight,
          ota:           bestOTA.ota_name,
        });

        return {
          ...pkg,
          hotel: {
            ...hotel,
            pricePerNight:     matchedRate,
            totalRate:         newTotal,
            priceMatchApplied: true,
            priceMatchOta:     bestOTA.ota_name,
            priceMatchSaving:  savingPerNight,
            originalRate:      directRate,
          },
          summary: {
            ...pkg.summary,
            totalPrice:     newTotal,
            pricePerPerson: Math.round(newTotal / (pkg.summary.passengers || 1)),
          },
        };
      });

    } catch (err) {
      // Never break the search if price match fails
      logger.warn('[PRICE MATCH] Failed silently', { error: err.message });
      return packages;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  async _orchestrateMultiProperty(tripParams, group, sessionId, prompt, conversationHistory) {
    const legs     = tripParams.legs || [];
    const packages = [];
    const foundLegs = [];

    for (const leg of legs) {
      const properties = await this._findProperties(group.id, leg.destination);

      if (!properties.length) {
        const allProps = await this._getAllProperties(group.id);
        const propList = allProps.map(p => p.name).join(', ');
        return this._buildResponse(
          sessionId, tripParams, conversationHistory,
          `I couldn't find a property matching "${leg.destination}". Available properties: ${propList}.`,
          []
        );
      }

      const property = properties[0];
      foundLegs.push({ leg, property });

      const legTripParams = {
        ...tripParams,
        departureDate: leg.departureDate || tripParams.departureDate,
        returnDate:    this._addDays(leg.departureDate || tripParams.departureDate, leg.nights || tripParams.nights || 1),
        nights:        leg.nights || tripParams.nights || 1,
      };

      const rooms = await this._searchRooms(property, {
        checkIn:   legTripParams.departureDate,
        checkOut:  legTripParams.returnDate,
        nights:    legTripParams.nights,
        adults:    tripParams.adults || tripParams.passengers || 1,
        children:  tripParams.children || 0,
        childAges: tripParams.childAges || [],
        mealPlan:  tripParams.mealPlan,
        budget:    tripParams.budget,
      });

      const ancillaries = await this._getAncillaryServices(property.id, tripParams);

      for (const room of rooms.slice(0, 3)) {
        const pkg = this._buildRoomPackage(room, property, ancillaries, legTripParams, group);
        pkg.legIndex  = legs.indexOf(leg);
        pkg.totalLegs = legs.length;
        pkg.legLabel  = `${property.name} — Leg ${legs.indexOf(leg) + 1} of ${legs.length}`;
        packages.push(pkg);
      }
    }

    if (!packages.length) {
      return this._buildResponse(
        sessionId, tripParams, conversationHistory,
        `No rooms are available for your requested dates. Please try different dates or contact us directly.`,
        []
      );
    }

    const propNames   = foundLegs.map(l => l.property.name).join(' → ');
    const totalNights = legs.reduce((sum, l) => sum + (l.nights || tripParams.nights || 1), 0);
    const text = `I found ${packages.length} room options across your ${totalNights}-night itinerary: ${propNames}. Select a room for each leg:`;

    return this._buildResponse(sessionId, tripParams, conversationHistory, text, packages);
  }

  async _searchRooms(property, params) {
    if (property.pms_type === 'opera_cloud') return this._searchRoomsOperaCloud(property, params);
    if (property.pms_type === 'opera_5')     return this._searchRoomsOpera5(property, params);
    return this._searchRoomsSupabase(property, params);
  }

  async _searchRoomsSupabase(property, {
    checkIn, checkOut, nights = 1, adults = 1,
    children = 0, childAges = [], mealPlan = null, budget = 'mid',
  }) {
    try {
      const { data: roomTypes, error } = await supabase
        .from('room_types')
        .select('*')
        .eq('property_id', property.id)
        .eq('is_active', true)
        .gte('max_adults', adults)
        .order('sort_order');

      if (error) throw error;
      if (!roomTypes?.length) return [];

      const results = [];

      for (const roomType of roomTypes) {
        const available = await this._checkAvailability(
          roomType.id, checkIn, checkOut || this._addDays(checkIn, nights)
        );
        if (!available) continue;

        const ratePlans = await this._getRatePlans(roomType.id, checkIn, mealPlan, budget);
        if (!ratePlans.length) continue;

        const bestRate    = ratePlans.find(r => r.is_refundable) || ratePlans[0];
        const extraAdults = Math.max(0, adults - bestRate.base_occupancy);
        const nightsCount = nights || 1;

        const totalPrice = (
          (bestRate.price_per_night * nightsCount) +
          (bestRate.extra_adult_surcharge * extraAdults * nightsCount) +
          (bestRate.child_surcharge * children * nightsCount)
        );

        const { data: policy } = await supabase
          .from('cancellation_policies')
          .select('*')
          .eq('rate_plan_id', bestRate.id)
          .maybeSingle();

        results.push({
          roomType,
          ratePlan:           bestRate,
          property,
          checkIn,
          checkOut:           checkOut || this._addDays(checkIn, nights),
          nights:             nightsCount,
          adults,
          children,
          childAges,
          totalPrice,
          pricePerNight:      bestRate.price_per_night,
          currency:           bestRate.currency || property.currency || 'KES',
          mealPlan:           bestRate.meal_plan,
          cancellationPolicy: policy || null,
          allRates:           ratePlans,
        });
      }

      return results;

    } catch (err) {
      logger.error('[HOTEL DIRECT] Supabase room search failed', {
        error: err.message, propertyId: property.id,
      });
      return [];
    }
  }

  async _searchRoomsOperaCloud(property, params) {
    logger.warn('[HOTEL DIRECT] Opera Cloud not yet implemented — falling back to Supabase', { propertyId: property.id });
    return this._searchRoomsSupabase(property, params);
  }

  async _searchRoomsOpera5(property, params) {
    logger.warn('[HOTEL DIRECT] Opera 5 not yet implemented — falling back to Supabase', { propertyId: property.id });
    return this._searchRoomsSupabase(property, params);
  }

  async _checkAvailability(roomTypeId, checkIn, checkOut) {
    if (!checkIn) return true;
    const { data: blocks } = await supabase
      .from('availability_blocks')
      .select('date_from, date_to, rooms_available')
      .eq('room_type_id', roomTypeId)
      .lte('date_from', checkIn)
      .gte('date_to', checkOut || checkIn);
    if (!blocks?.length) return true;
    return blocks.every(b => b.rooms_available > 0);
  }

  async _getRatePlans(roomTypeId, checkIn, mealPlan = null, budget = 'mid') {
    let query = supabase
      .from('rate_plans')
      .select('*')
      .eq('room_type_id', roomTypeId)
      .eq('is_active', true);
    if (mealPlan) query = query.eq('meal_plan', mealPlan);
    const { data: plans } = await query;
    if (!plans?.length) return [];
    const date = checkIn ? new Date(checkIn) : new Date();
    return plans
      .filter(plan => {
        if (!plan.season_start && !plan.season_end) return true;
        const start = plan.season_start ? new Date(plan.season_start) : null;
        const end   = plan.season_end   ? new Date(plan.season_end)   : null;
        if (start && end) return date >= start && date <= end;
        if (start) return date >= start;
        if (end)   return date <= end;
        return true;
      })
      .sort((a, b) => a.price_per_night - b.price_per_night);
  }

  async _getAncillaryServices(propertyId, tripParams) {
    try {
      const { data: services } = await supabase
        .from('ancillary_services')
        .select('*')
        .eq('property_id', propertyId)
        .eq('is_active', true)
        .order('sort_order');
      if (!services?.length) return [];
      const tripTags = [
        ...(tripParams.preferences || []),
        tripParams.mealPlan ? 'dining' : null,
        (tripParams.passengers || 1) > 2 ? 'family' : null,
        tripParams.mealPlan === 'all_inclusive' ? 'wellness' : null,
      ].filter(Boolean);
      return services.filter(service => {
        const tags = Array.isArray(service.upsell_tags) ? service.upsell_tags : [];
        if (tags.length === 0) return true;
        if (service.category === 'transfer') return true;
        return tags.some(tag => tripTags.includes(tag));
      });
    } catch (err) {
      logger.warn('[HOTEL DIRECT] Could not fetch ancillary services', { error: err.message });
      return [];
    }
  }

  _buildRoomPackage(room, property, ancillaries, tripParams, group) {
    const nights     = room.nights || 1;
    const passengers = tripParams.passengers || tripParams.adults || 1;
    const currency   = room.currency;

    const cancellationNote = this._formatCancellationNote(room.cancellationPolicy, room.ratePlan);

    const ancillaryTotal = ancillaries
      .filter(a => a.requires_booking)
      .reduce((sum, a) => {
        if (a.price_basis === 'per_person') return sum + (a.price * passengers);
        if (a.price_basis === 'per_night')  return sum + (a.price * nights);
        return sum + a.price;
      }, 0);

    const totalPrice       = room.totalPrice + ancillaryTotal;
    const commissionRate   = group.commission_rate || 0.05;
    const commissionAmount = Math.round(totalPrice * commissionRate * 100) / 100;

    return {
      packageId:     require('crypto').randomUUID(),
      isHotelDirect: true,
      groupSlug:     group.slug,
      groupId:       group.id,

      summary: {
        route:           property.destination,
        nights,
        passengers,
        totalPrice,
        roomTotal:       room.totalPrice,
        ancillaryTotal,
        pricePerPerson:  Math.round(totalPrice / passengers),
        currency,
        mealPlan:        room.mealPlan,
        transportType:   'none',
        commissionRate,
        commissionAmount,
      },

      transport:       null,
      returnTransport: null,

      hotel: {
        name:          `${property.name} — ${room.roomType.name}`,
        propertyName:  property.name,
        stars:         property.stars,
        location:      property.location,
        address:       property.address,
        latitude:      property.latitude,
        longitude:     property.longitude,
        pricePerNight: room.pricePerNight,
        totalRate:     room.totalPrice,
        currency,
        mealPlan:      room.mealPlan,
        roomType:      room.roomType.name,
        bedType:       room.roomType.bed_type,
        view:          room.roomType.view,
        amenities:     room.roomType.amenities || [],
        checkIn:       room.checkIn,
        checkOut:      room.checkOut,
        nights,
        images:        room.roomType.images || property.images || [],
        isRefundable:  room.ratePlan.is_refundable,
        policySummary: cancellationNote,
        availableRates: (room.allRates || []).map(r => ({
          ratePlanId:    r.id,
          mealPlan:      r.meal_plan,
          pricePerNight: r.price_per_night,
          currency:      r.currency,
          isRefundable:  r.is_refundable,
          seasonName:    r.season_name || null,
        })),
        propertyId:  property.id,
        roomTypeId:  room.roomType.id,
        ratePlanId:  room.ratePlan.id,
        groupId:     group.id,
        groupSlug:   group.slug,
      },

      transfers: [],

      ancillaryServices: ancillaries.map(a => ({
        id:              a.id,
        name:            a.name,
        description:     a.description,
        category:        a.category,
        price:           a.price,
        currency:        a.currency,
        priceBasis:      a.price_basis,
        requiresBooking: a.requires_booking,
        images:          a.images || [],
      })),

      status: 'available',
    };
  }

  async _findProperties(groupId, destination, rawPrompt = null) {
    if (!destination && !rawPrompt) return this._getAllProperties(groupId);

    const { data: properties } = await supabase
      .from('hotel_properties')
      .select('*')
      .eq('group_id', groupId)
      .eq('is_active', true);

    if (!properties?.length) return [];

    const raw         = (rawPrompt  || '').toLowerCase().trim();
    const search      = (destination || '').toLowerCase().trim();
    const searchWords = search.split(/\s+/).filter(Boolean);
    const rawWords    = raw.split(/\s+/).filter(Boolean);

    const allNameWords = properties.map(p =>
      (p.name || '').toLowerCase().split(/\s+/).filter(Boolean)
    );
    const brandWords = allNameWords.length > 1
      ? allNameWords[0].filter(w => allNameWords.every(nws => nws.includes(w)))
      : [];

    const scored = properties.map(p => {
      const name      = (p.name        || '').toLowerCase();
      const dest      = (p.destination || '').toLowerCase();
      const location  = (p.location    || '').toLowerCase();
      const aliases   = Array.isArray(p.search_aliases) ? p.search_aliases : [];
      const nameWords = name.split(/\s+/).filter(Boolean);

      const distinctWords = nameWords.filter(w => !brandWords.includes(w));
      const matchWords    = distinctWords.length > 0 ? distinctWords : nameWords;

      let score = 0;

      if (raw && name && raw.includes(name))
        score = Math.max(score, 100);

      if (search && name && search.includes(name))
        score = Math.max(score, 90);

      if (aliases.some(a => {
        const al = String(a).toLowerCase();
        return (raw && raw.includes(al)) ||
               (search && (search.includes(al) || al.includes(search)));
      })) score = Math.max(score, 80);

      if (raw) {
        if (dest     && dest.length     > 3 && raw.includes(dest))     score = Math.max(score, 70);
        if (location && location.length > 3 && raw.includes(location)) score = Math.max(score, 70);
      }

      if (raw && matchWords.length > 0 && matchWords.every(mw =>
        rawWords.some(rw => rw === mw || rw.startsWith(mw) || mw.startsWith(rw))
      )) score = Math.max(score, 60);

      if (search && matchWords.length > 0 && matchWords.every(mw =>
        searchWords.some(sw => sw === mw || sw.startsWith(mw) || mw.startsWith(sw))
      )) score = Math.max(score, 50);

      if (raw && matchWords.length > 0 && matchWords.every(mw =>
        rawWords.some(rw =>
          rw === mw ||
          rw.startsWith(mw) ||
          mw.startsWith(rw) ||
          (mw.length > 4 && _levenshtein(rw, mw) <= 1)
        )
      )) score = Math.max(score, 40);

      return { p, score };
    }).filter(s => s.score > 0);

    if (!scored.length) return [];

    const topScore  = Math.max(...scored.map(s => s.score));
    const threshold = topScore >= 60 ? topScore - 10 : topScore;

    return scored
      .filter(s  => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .map(s  => s.p);
  }

  async _getAllProperties(groupId) {
    const { data } = await supabase
      .from('hotel_properties')
      .select('*')
      .eq('group_id', groupId)
      .eq('is_active', true)
      .order('sort_order');
    return data || [];
  }

  async _getHotelGroup(slug) {
    if (!slug) return null;
    const { data, error } = await supabase
      .from('hotel_groups')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();
    if (error) {
      logger.warn('[HOTEL DIRECT] Hotel group not found', { slug, error: error.message });
      return null;
    }
    return data || null;
  }

  _formatCancellationNote(policy, ratePlan) {
    if (policy) {
      if (policy.free_cancellation_days > 0) {
        return `Free cancellation up to ${policy.free_cancellation_days} day${policy.free_cancellation_days > 1 ? 's' : ''} before check-in${policy.penalty_percentage > 0 ? `, then ${policy.penalty_percentage}% penalty` : ''}.`;
      }
      if (policy.penalty_percentage === 100) return 'Non-refundable.';
      return policy.policy_name || policy.notes || 'See cancellation policy.';
    }
    if (ratePlan?.is_refundable === false) return 'Non-refundable.';
    if (ratePlan?.is_refundable === true)  return 'Refundable — conditions apply.';
    return 'Cancellation policy confirmed at booking.';
  }

  _buildResponse(sessionId, tripParams, conversationHistory, text, packages) {
    const updatedHistory = [
      ...conversationHistory,
      { role: 'user',      content: tripParams._originalPrompt || '' },
      { role: 'assistant', content: text, packageCount: packages.length },
    ].slice(-10);

    return {
      sessionId,
      text,
      packages,
      tripParams,
      conversationHistory: updatedHistory,
      generatedAt: new Date().toISOString(),
      isHotelDirect: true,
    };
  }

  _addDays(dateStr, days) {
    if (!dateStr) {
      const d = new Date();
      d.setDate(d.getDate() + (days || 1));
      return d.toISOString().split('T')[0];
    }
    const d = new Date(dateStr);
    d.setDate(d.getDate() + (days || 1));
    return d.toISOString().split('T')[0];
  }
}

function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

module.exports = new HotelDirectEngine();