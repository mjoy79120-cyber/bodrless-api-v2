/**
 * HOTEL DIRECT ENGINE — v2
 * ─────────────────────────────────────────────────────────────
 * Rewritten to match the new schema where hotel_groups are
 * independent tenants — no agency_id, no agencies table dependency.
 *
 * IDENTIFIER CHANGE:
 *   Old: orchestrate(prompt, agencyId, context)
 *        → _getHotelGroup(agencyId) queried hotel_groups.agency_id
 *   New: orchestrate(prompt, groupSlug, context)
 *        → _getHotelGroup(slug) queries hotel_groups.slug
 *
 *   groupSlug is the hotel's unique identifier everywhere:
 *   - Widget embed: <script src="/widget.js?key=sarova">
 *   - WhatsApp session: stored as group_slug in conversation state
 *   - API routes: x-hotel-key header = group slug
 *
 * FIXES APPLIED vs v1:
 *   #1 CRITICAL — _getHotelGroup now queries by slug, no agency_id
 *   #2 HIGH     — ancillary total included in package totalPrice
 *   #3 MEDIUM   — availability logic documented, MVP behaviour kept
 *   #4 LOW      — child age pricing stubbed with age-band comments
 *   #5 MEDIUM   — destination aliases supported via search_aliases JSONB
 *
 * PMS INTEGRATION (Phase 2 — unchanged):
 *   pms_type: null          → Supabase-managed (today)
 *   pms_type: 'opera_cloud' → OHIP REST adapter
 *   pms_type: 'opera_5'     → OXI SOAP adapter
 * ─────────────────────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const { parsePrompt } = require('./promptParser');

class HotelDirectEngine {

  // ─────────────────────────────
  // MAIN ORCHESTRATE
  // groupSlug replaces agencyId everywhere. The slug is the stable
  // public identifier for a hotel group (e.g. 'sarova', 'serena').
  // ─────────────────────────────
  async orchestrate(prompt, groupSlug, context = {}) {
    const sessionId = uuidv4();
    const { conversationHistory = [], previousParams = null } = context;

    logger.info(`[HOTEL DIRECT][${sessionId}] Started`, { groupSlug, prompt });

    try {
      const tripParams = await parsePrompt(prompt);
      // Store groupSlug on params so downstream helpers can use it
      // without it being passed through every call chain.
      tripParams.groupSlug = groupSlug;

      console.log('[HOTEL DIRECT] Parsed params:', tripParams);

      // Resolve the hotel group by slug
      const group = await this._getHotelGroup(groupSlug);
      if (!group) {
        return this._buildResponse(
          sessionId, tripParams, conversationHistory,
          `I couldn't find a hotel configuration for "${groupSlug}". Please contact support.`,
          []
        );
      }

      // Multi-destination → multi-property itinerary
      if (tripParams.isMultiDestination && Array.isArray(tripParams.legs)) {
        return this._orchestrateMultiProperty(
          tripParams, group, sessionId, prompt, conversationHistory
        );
      }

      // Single destination → room search
      return this._orchestrateSingleDestination(
        tripParams, group, sessionId, prompt, conversationHistory
      );

    } catch (err) {
      logger.error('[HOTEL DIRECT] Engine failure', { error: err.message, stack: err.stack });
      return this._buildResponse(
        sessionId, { groupSlug }, conversationHistory,
        "I had trouble with that search. Could you tell me which property and dates you're looking for?",
        []
      );
    }
  }

  // ─────────────────────────────
  // SINGLE DESTINATION SEARCH
  // ─────────────────────────────
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
        `We don't have a property in ${destination || 'that location'}. ${group.name} has: ${propList}. Which would you like?`,
        []
      );
    }

    // Search all matching properties in parallel
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
      // Max 3 room options per property
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

  // ─────────────────────────────
  // MULTI-PROPERTY ITINERARY
  // e.g. "2 nights Stanley, 3 nights Mara, 4 nights Whitesands"
  // ─────────────────────────────
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
      legResults.push({ leg, property, room: rooms[0] || null, ancillaries });
    }

    const itinerary = this._buildMultiPropertyItinerary(legResults, tripParams, group);
    const totalNights = legs.reduce((sum, l) => sum + (l.nights || 1), 0);
    const text = `Here's a ${totalNights}-night itinerary across ${legResults.length} of our properties:`;

    return this._buildResponse(sessionId, tripParams, conversationHistory, text, [itinerary]);
  }

  // ─────────────────────────────
  // SEARCH ROOMS
  // Routes to correct inventory source based on pms_type.
  // ─────────────────────────────
  async _searchRooms(property, params) {
    if (property.pms_type === 'opera_cloud') {
      return this._searchRoomsOperaCloud(property, params);
    }
    if (property.pms_type === 'opera_5') {
      return this._searchRoomsOpera5(property, params);
    }
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
        // Check availability for the date window
        const available = await this._checkAvailability(
          roomType.id,
          checkIn,
          checkOut || this._addDays(checkIn, nights)
        );
        if (!available) continue;

        // Get applicable rate plans
        const ratePlans = await this._getRatePlans(roomType.id, checkIn, mealPlan, budget);
        if (!ratePlans.length) continue;

        // Pick best rate — cheapest refundable first, else cheapest overall
        const bestRate = ratePlans.find(r => r.is_refundable) || ratePlans[0];

        // Calculate total price with occupancy surcharges
        const extraAdults = Math.max(0, adults - bestRate.base_occupancy);
        const nightsCount = nights || 1;

        // FIX #4 (LOW): child surcharge applied flat per child for now.
        // TODO: age-band pricing — 0-5 free, 6-12 discounted, 13+ adult rate.
        // childAges is available here when that logic is added.
        const totalPrice = (
          (bestRate.price_per_night * nightsCount) +
          (bestRate.extra_adult_surcharge * extraAdults * nightsCount) +
          (bestRate.child_surcharge * children * nightsCount)
        );

        // Fetch cancellation policy for this rate plan
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

  // ─────────────────────────────
  // PHASE 2 STUBS
  // ─────────────────────────────
  async _searchRoomsOperaCloud(property, params) {
    logger.warn('[HOTEL DIRECT] Opera Cloud adapter not yet implemented — falling back to Supabase', {
      propertyId: property.id,
    });
    return this._searchRoomsSupabase(property, params);
  }

  async _searchRoomsOpera5(property, params) {
    logger.warn('[HOTEL DIRECT] Opera 5 (OXI) adapter not yet implemented — falling back to Supabase', {
      propertyId: property.id,
    });
    return this._searchRoomsSupabase(property, params);
  }

  // ─────────────────────────────
  // CHECK AVAILABILITY
  // No block = assumed available (MVP).
  // A block with rooms_available = 0 = sold out.
  // FIX #3: documented MVP behaviour. Phase 2 will enforce
  // per-night inventory from Opera or a proper inventory counter.
  // ─────────────────────────────
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

  // ─────────────────────────────
  // GET RATE PLANS
  // Returns flat rates (season_start null) and seasonal rates
  // where check-in falls within the season window. Filtered by
  // meal plan if specified. Sorted cheapest first.
  // ─────────────────────────────
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

  // ─────────────────────────────
  // GET ANCILLARY SERVICES
  // FIX #5 (partial): destination aliases handled in _findProperties.
  // Here: filter by upsell_tags matching trip profile.
  // Transfers always shown. Services with no tags always shown.
  // ─────────────────────────────
  async _getAncillaryServices(propertyId, tripParams) {
    try {
      const { data: services } = await supabase
        .from('ancillary_services')
        .select('*')
        .eq('property_id', propertyId)
        .eq('is_active', true)
        .order('sort_order');

      if (!services?.length) return [];

      // Build a tag set from the trip context
      const tripTags = [
        ...(tripParams.preferences || []),
        tripParams.mealPlan ? 'dining' : null,
        (tripParams.passengers || 1) > 2 ? 'family' : null,
        tripParams.mealPlan === 'all_inclusive' ? 'wellness' : null,
      ].filter(Boolean);

      return services.filter(service => {
        const tags = Array.isArray(service.upsell_tags) ? service.upsell_tags : [];
        if (tags.length === 0)            return true; // no filter — always show
        if (service.category === 'transfer') return true; // transfers always offered
        return tags.some(tag => tripTags.includes(tag));
      });

    } catch (err) {
      logger.warn('[HOTEL DIRECT] Could not fetch ancillary services', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────
  // BUILD ROOM PACKAGE
  // FIX #2: ancillary total now included in summary.totalPrice.
  // Ancillaries that require_booking contribute to the total;
  // walk-in services are shown but not summed (guest decides at hotel).
  // ─────────────────────────────
  _buildRoomPackage(room, property, ancillaries, tripParams, group) {
    const nights     = room.nights || 1;
    const passengers = tripParams.passengers || tripParams.adults || 1;
    const currency   = room.currency;

    // Cancellation policy summary
    const cancellationNote = this._formatCancellationNote(
      room.cancellationPolicy, room.ratePlan
    );

    // FIX #2: sum ancillaries that require pre-booking into total
    const ancillaryTotal = ancillaries
      .filter(a => a.requires_booking)
      .reduce((sum, a) => {
        if (a.price_basis === 'per_person') return sum + (a.price * passengers);
        if (a.price_basis === 'per_night')  return sum + (a.price * nights);
        return sum + a.price;
      }, 0);

    const totalPrice = room.totalPrice + ancillaryTotal;

    // Commission rate from the group (default 5%)
    const commissionRate   = group.commission_rate || 0.05;
    const commissionAmount = Math.round(totalPrice * commissionRate * 100) / 100;

    return {
      packageId:      require('crypto').randomUUID(),
      isHotelDirect:  true,
      groupSlug:      group.slug,
      groupId:        group.id,

      summary: {
        route:            property.destination,
        nights,
        passengers,
        totalPrice,
        roomTotal:        room.totalPrice,
        ancillaryTotal,
        pricePerPerson:   Math.round(totalPrice / passengers),
        currency,
        mealPlan:         room.mealPlan,
        transportType:    'none',
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

        // All available rates — widget uses these for the meal plan dropdown
        availableRates: (room.allRates || []).map(r => ({
          ratePlanId:    r.id,
          mealPlan:      r.meal_plan,
          pricePerNight: r.price_per_night,
          currency:      r.currency,
          isRefundable:  r.is_refundable,
          seasonName:    r.season_name || null,
        })),

        // Booking identifiers — used by hotelDirectBookingService
        propertyId:  property.id,
        roomTypeId:  room.roomType.id,
        ratePlanId:  room.ratePlan.id,
        groupId:     group.id,
        groupSlug:   group.slug,
      },

      transfers: [],

      // Ancillary upsells — split into pre-bookable and walk-in
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

  // ─────────────────────────────
  // BUILD MULTI-PROPERTY ITINERARY
  // FIX #2: ancillary totals included per leg and in grand total.
  // ─────────────────────────────
  _buildMultiPropertyItinerary(legResults, tripParams, group) {
    const passengers   = tripParams.passengers || tripParams.adults || 1;
    const totalNights  = legResults.reduce((sum, l) => sum + (l.leg.nights || 1), 0);
    const currency     = legResults[0]?.room?.currency || group.currency || 'KES';

    const commissionRate = group.commission_rate || 0.05;

    let grandTotal = 0;

    const legs = legResults.map((l, i) => {
      const roomTotal = l.room?.totalPrice || 0;
      const ancTotal  = (l.ancillaries || [])
        .filter(a => a.requires_booking)
        .reduce((sum, a) => {
          if (a.price_basis === 'per_person') return sum + (a.price * passengers);
          if (a.price_basis === 'per_night')  return sum + (a.price * (l.leg.nights || 1));
          return sum + a.price;
        }, 0);

      const legTotal = roomTotal + ancTotal;
      grandTotal += legTotal;

      return {
        destination:   l.leg.destination,
        nights:        l.leg.nights,
        checkIn:       l.leg.departureDate || tripParams.departureDate,
        checkOut:      this._addDays(
          l.leg.departureDate || tripParams.departureDate, l.leg.nights || 1
        ),
        hotel: l.room ? {
          name:          `${l.property.name} — ${l.room.roomType.name}`,
          propertyName:  l.property.name,
          stars:         l.property.stars,
          location:      l.property.location,
          pricePerNight: l.room.pricePerNight,
          totalRate:     l.room.totalPrice,
          ancillaryTotal: ancTotal,
          legTotal,
          currency:      l.room.currency,
          mealPlan:      l.room.mealPlan,
          roomType:      l.room.roomType.name,
          bedType:       l.room.roomType.bed_type,
          view:          l.room.roomType.view,
          isRefundable:  l.room.ratePlan.is_refundable,
          policySummary: this._formatCancellationNote(
            l.room.cancellationPolicy, l.room.ratePlan
          ),
          propertyId:    l.property.id,
          roomTypeId:    l.room.roomType.id,
          ratePlanId:    l.room.ratePlan.id,
          groupId:       group.id,
          groupSlug:     group.slug,
        } : null,
        ancillaryServices: (l.ancillaries || []).map(a => ({
          id: a.id, name: a.name, category: a.category,
          price: a.price, currency: a.currency,
          priceBasis: a.price_basis,
          requiresBooking: a.requires_booking,
        })),
      };
    });

    const commissionAmount = Math.round(grandTotal * commissionRate * 100) / 100;

    return {
      packageId:          require('crypto').randomUUID(),
      isMultiDestination: true,
      isHotelDirect:      true,
      groupSlug:          group.slug,
      groupId:            group.id,

      summary: {
        route:            legResults.map(l => l.property.name).join(' → '),
        totalNights,
        totalPrice:       grandTotal,
        pricePerPerson:   Math.round(grandTotal / passengers),
        currency,
        passengers,
        commissionRate,
        commissionAmount,
      },

      legs,
      status: 'available',
    };
  }

  // ─────────────────────────────
  // FIND PROPERTIES
  // FIX #5: checks destination, name, location AND search_aliases
  // (JSONB array on hotel_properties — add this column if not present).
  // Falls back gracefully if search_aliases column doesn't exist yet.
  // ─────────────────────────────
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
      // Standard fields
      if ((p.destination || '').toLowerCase().includes(search)) return true;
      if ((p.name       || '').toLowerCase().includes(search)) return true;
      if ((p.location   || '').toLowerCase().includes(search)) return true;

      // FIX #5: search_aliases — e.g. ["mara","masai mara","maasai mara"]
      const aliases = Array.isArray(p.search_aliases) ? p.search_aliases : [];
      if (aliases.some(a => String(a).toLowerCase().includes(search) ||
                            search.includes(String(a).toLowerCase()))) return true;

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

  // ─────────────────────────────
  // GET HOTEL GROUP BY SLUG
  // FIX #1 CRITICAL: queries by slug, not agency_id.
  // slug is the stable public identifier (e.g. 'sarova').
  // ─────────────────────────────
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

  // ─────────────────────────────
  // FORMAT CANCELLATION NOTE
  // Builds a human-readable policy summary from the cancellation
  // policy row + rate plan refundable flag.
  // ─────────────────────────────
  _formatCancellationNote(policy, ratePlan) {
    if (policy) {
      if (policy.free_cancellation_days > 0) {
        return `Free cancellation up to ${policy.free_cancellation_days} day${policy.free_cancellation_days > 1 ? 's' : ''} before check-in${policy.penalty_percentage > 0 ? `, then ${policy.penalty_percentage}% penalty` : ''}.`;
      }
      if (policy.penalty_percentage === 100) {
        return 'Non-refundable.';
      }
      return policy.policy_name || policy.notes || 'See cancellation policy.';
    }
    if (ratePlan?.is_refundable === false) return 'Non-refundable.';
    if (ratePlan?.is_refundable === true)  return 'Refundable — conditions apply.';
    return 'Cancellation policy confirmed at booking.';
  }

  // ─────────────────────────────
  // BUILD RESPONSE
  // Standard response shape — same as agency engine so webhooks.js
  // and widget.js need no changes to call either engine.
  // ─────────────────────────────
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

  // ─────────────────────────────
  // HELPERS
  // ─────────────────────────────
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