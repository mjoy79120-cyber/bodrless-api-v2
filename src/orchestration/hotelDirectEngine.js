/**
 * HOTEL DIRECT ENGINE — v2
 * Hotel groups are independent tenants — no agency_id dependency.
 * Uses its own hotel-specific prompt parser (no flights, no origin).
 */

const { v4: uuidv4 } = require('uuid');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// HOTEL PROMPT PARSER
// Self-contained — no Groq, no flight fields, no IATA codes.
// Only extracts what a hotel booking needs.
// ─────────────────────────────────────────────────────────────
function parseHotelPrompt(prompt) {
  const lower = (prompt || '').toLowerCase().trim();

  // ── MULTI-PROPERTY DETECTION ─────────────────────────────
  const legSplitMatch = lower.match(
    /^(.*?)\s+(?:and\s+then|then|and\s+also|followed\s+by|and)\s+(.+)$/i
  );
  
  if (legSplitMatch) {
    const p1 = parseHotelPrompt(legSplitMatch[1]);
    const p2 = parseHotelPrompt(legSplitMatch[2]);
    
    if (p1.destination && p2.destination) {
      p1._originalPrompt = prompt; 
      
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
        _originalPrompt: prompt
      };
    }
  }

  // ── NIGHTS ────────────────────────────────────────────────
  let nights = 3;
  const nightsMatch = lower.match(/(\d+)\s*(?:night|nights|nts?)\b/i);
  if (nightsMatch) nights = parseInt(nightsMatch[1], 10);

  // ── GUESTS ────────────────────────────────────────────────
  let adults = 1;
  const adultMatch = lower.match(/(\d+)\s*(?:people|persons|pax|adults?|guests?|of us|travelers?)\b/i);
  if (adultMatch) adults = Math.max(1, parseInt(adultMatch[1], 10));
  if (/\bcouple\b|two of us|2 of us/i.test(lower)) adults = Math.max(adults, 2);
  if (/\bfamily\b/i.test(lower) && adults < 2) adults = 2;
  if (/\bfor two\b|\bfor 2\b/i.test(lower)) adults = Math.max(adults, 2);

  // ── CHILDREN ──────────────────────────────────────────────
  let children = 0;
  const childMatch = lower.match(/(\d+)\s*(?:child(?:ren)?|kid(?:s)?)\b/i);
  if (childMatch) children = parseInt(childMatch[1], 10);

  // ── MEAL PLAN ─────────────────────────────────────────────
  let mealPlan = null;
  if (/all.?inclusive/i.test(lower))                     mealPlan = 'all_inclusive';
  else if (/full.?board/i.test(lower))                    mealPlan = 'full_board';
  else if (/half.?board/i.test(lower))                    mealPlan = 'half_board';
  else if (/bed.?and.?breakfast|b&b|\bbb\b/i.test(lower))  mealPlan = 'bed_and_breakfast';
  else if (/room.?only|no meals/i.test(lower))              mealPlan = 'room_only';
  else if (/\bbreakfast\b/i.test(lower))                    mealPlan = 'bed_and_breakfast';

  // ── DATES ─────────────────────────────────────────────────
  let departureDate = null;
  const months = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,
    september:9,october:10,november:11,december:12,
  };
  const dateMatch = lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/i)
    || lower.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/i);

  if (dateMatch) {
    const yr = new Date().getFullYear();
    let day, month, year;
    if (/^\d/.test(dateMatch[1] || '')) {
      day   = parseInt(dateMatch[1], 10);
      const mk = (dateMatch[2] || '').toLowerCase().slice(0, 3);
      month = months[mk];
      year  = parseInt(dateMatch[3] || yr, 10);
    } else {
      const mk = (dateMatch[1] || '').toLowerCase().slice(0, 3);
      month = months[mk];
      day   = parseInt(dateMatch[2], 10);
      year  = parseInt(dateMatch[3] || yr, 10);
    }
    if (day && month) {
      departureDate = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }

  if (!departureDate) {
    const d = new Date();
    if      (/\btoday\b/i.test(lower))        { /* use today as-is */ }
    else if (/\btomorrow\b/i.test(lower))      d.setDate(d.getDate() + 1);
    else if (/this\s+weekend/i.test(lower))    d.setDate(d.getDate() + (6 - d.getDay()));
    else if (/next\s+week/i.test(lower))       d.setDate(d.getDate() + 7);
    else                                       d.setDate(d.getDate() + 1);
    departureDate = d.toISOString().split('T')[0];
  }

  // ── RETURN DATE ───────────────────────────────────────────
  const dep = new Date(departureDate);
  dep.setDate(dep.getDate() + nights);
  const returnDate = dep.toISOString().split('T')[0];

  // ── DESTINATION STRIPPING ─────────────────────────────────
  const destRaw = prompt
    .replace(/\b(?:book(?:\s+me)?|reserve|i(?:'d|\s+would)\s+like(?:\s+to)?(?:\s+book)?|i\s+want(?:\s+to)?(?:\s+book)?|can\s+i\s+(?:get|have|book)|get\s+me|please|help\s+me)\b/gi, '')
    .replace(/\b(?:a\s+)?(?:room|suite|deluxe|standard|superior|junior|double|twin|single|king|queen|family\s+room)\b/gi, '')
    .replace(/\d+\s*nights?\b/gi, '')
    .replace(/\bfrom\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?(?:\s+(?:of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december))?\b/gi, '')
    .replace(/\bfor\s+\d+\s*(?:people|adults?|guests?|of us|pax|persons?)\b/gi, '')
    .replace(/\b(?:bed\s+and\s+breakfast|all\s+inclusive|full\s+board|half\s+board|room\s+only|breakfast)\b/gi, '')
    .replace(/\b(?:this\s+weekend|next\s+week|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?\b/gi, '')
    .replace(/\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+\d{4})?\b/gi, '')
    .replace(/\b(?:in|for|at|the|a|an|me|us|with|and)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const destination = destRaw.toLowerCase() || null;

  // ── BUDGET ────────────────────────────────────────────────
  let budget = 'mid';
  if (/luxury|premium|5.?star|five.?star/i.test(lower))  budget = 'luxury';
  else if (/cheap|budget|affordable/i.test(lower))         budget = 'low';

  // ── PREFERENCES ───────────────────────────────────────────
  const preferences = [];
  if (/honeymoon|romantic/i.test(lower))   preferences.push('honeymoon');
  if (/family|kids|children/i.test(lower)) preferences.push('family');
  if (/business|corporate/i.test(lower))   preferences.push('business');
  if (/beach|ocean|sea|coast/i.test(lower)) preferences.push('beach');
  if (/safari|game|wildlife/i.test(lower)) preferences.push('safari');
  if (/spa|wellness|relax/i.test(lower))   preferences.push('spa');

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
    _originalPrompt: prompt
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

    const properties = await this._findProperties(group.id, destination);

    if (properties.length === 0) {
      const allProps = await this._getAllProperties(group.id);
      const propList = allProps.map(p => `${p.name} (${p.destination})`).join(', ');
      return this._buildResponse(
        sessionId, tripParams, conversationHistory,
        `We don't have a property matching "${destination || 'that location'}". ${group.name} properties: ${propList}. Which would you like?`,
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

    const text = packages.length === 1
      ? `Here is what we have available at ${properties[0].name}:`
      : properties.length > 1
        ? `I found ${packages.length} options across ${properties.length} of our properties:`
        : `I found ${packages.length} room option${packages.length > 1 ? 's' : ''} at ${properties[0].name}:`;

    return this._buildResponse(sessionId, tripParams, conversationHistory, text, packages);
  }

  async _orchestrateMultiProperty(tripParams, group, sessionId, prompt, conversationHistory) {
    const legs = tripParams.legs || [];
    const legResults = [];

    for (const leg of legs) {
      const properties = await this._findProperties(group.id, leg.destination);
      if (!properties.length) {
        return this._buildResponse(
          sessionId, tripParams, conversationHistory,
          `We don't have a property in ${leg.destination}. Let me know if you'd like to adjust your itinerary.`,
          []
        );
      }
      const property = properties[0];
      const rooms = await this._searchRooms(property, {
        checkIn:   leg.departureDate || tripParams.departureDate,
        nights:    leg.nights,
        adults:    tripParams.adults || tripParams.passengers || 1,
        children:  tripParams.children || 0,
        childAges: tripParams.childAges || [],
        mealPlan:  tripParams.mealPlan,
        budget:    tripParams.budget,
      });
      const ancillaries = await this._getAncillaryServices(property.id, tripParams);
      
      // Store all found rooms (up to 3) so the frontend can choose
      legResults.push({ leg, property, rooms: rooms.slice(0, 3), ancillaries });
    }

    const itinerary = this._buildMultiPropertyItinerary(legResults, tripParams, group);
    const totalNights = legs.reduce((sum, l) => sum + (l.nights || 1), 0);
    const text = `Here are the available room options for your ${totalNights}-night itinerary across our properties:`;
    
    return this._buildResponse(sessionId, tripParams, conversationHistory, text, [itinerary]);
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

        const bestRate = ratePlans.find(r => r.is_refundable) || ratePlans[0];
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
    logger.warn('[HOTEL DIRECT] Opera Cloud adapter not yet implemented — falling back to Supabase', { propertyId: property.id });
    return this._searchRoomsSupabase(property, params);
  }

  async _searchRoomsOpera5(property, params) {
    logger.warn('[HOTEL DIRECT] Opera 5 (OXI) adapter not yet implemented — falling back to Supabase', { propertyId: property.id });
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

  _buildMultiPropertyItinerary(legResults, tripParams, group) {
    const passengers  = tripParams.passengers || tripParams.adults || 1;
    const totalNights = legResults.reduce((sum, l) => sum + (l.leg.nights || 1), 0);
    const currency    = legResults[0]?.rooms[0]?.currency || group.currency || 'KES';
    const commissionRate = group.commission_rate || 0.05;
    
    // Calculate a default base total for the whole trip (using first room option per leg)
    let grandTotal = legResults.reduce((sum, l) => {
      if (!l.rooms[0]) return sum;
      return sum + l.rooms[0].totalPrice;
    }, 0);

    const legs = legResults.map(l => {
      // Map all room options (with ancillaries already calculated in the package builder)
      const roomOptions = l.rooms.map(room => {
          return this._buildRoomPackage(room, l.property, l.ancillaries, tripParams, group).hotel;
      });

      return {
        destination: l.leg.destination,
        nights:      l.leg.nights,
        checkIn:     l.leg.departureDate || tripParams.departureDate,
        checkOut:    this._addDays(l.leg.departureDate || tripParams.departureDate, l.leg.nights || 1),
        roomOptions: roomOptions, // The array of choices for the UI
        ancillaryServices: (l.ancillaries || []).map(a => ({
          id: a.id, name: a.name, category: a.category,
          price: a.price, currency: a.currency,
          priceBasis: a.price_basis, requiresBooking: a.requires_booking,
        })),
      };
    });

    return {
      packageId:          require('crypto').randomUUID(),
      isMultiDestination: true,
      isHotelDirect:      true,
      groupSlug:          group.slug,
      groupId:            group.id,
      summary: {
        route:           legResults.map(l => l.property.name).join(' → '),
        totalNights,
        totalPrice:      grandTotal,
        pricePerPerson:  Math.round(grandTotal / passengers),
        currency,
        passengers,
        commissionRate,
        commissionAmount: Math.round(grandTotal * commissionRate * 100) / 100,
      },
      legs,
      status: 'available',
    };
  }

  async _findProperties(groupId, destination) {
    if (!destination) return this._getAllProperties(groupId);

    const { data: properties } = await supabase
      .from('hotel_properties')
      .select('*')
      .eq('group_id', groupId)
      .eq('is_active', true);

    if (!properties?.length) return [];

    const search = destination.toLowerCase().trim();

    return properties.filter(p => {
      if ((p.destination || '').toLowerCase().includes(search)) return true;
      if ((p.name         || '').toLowerCase().includes(search)) return true;
      if ((p.location    || '').toLowerCase().includes(search)) return true;
      if (search.includes((p.name || '').toLowerCase())) return true;
      const aliases = Array.isArray(p.search_aliases) ? p.search_aliases : [];
      if (aliases.some(a => {
        const al = String(a).toLowerCase();
        return al.includes(search) || search.includes(al);
      })) return true;
      return false;
    });
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
      { role: 'user',       content: tripParams._originalPrompt || '' },
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

module.exports = new HotelDirectEngine();