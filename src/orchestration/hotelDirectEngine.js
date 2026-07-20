// HOTEL DIRECT ENGINE — v6.2
// Conversational AI layer: Groq (llama-3.3-70b) handles intent, context, and follow-ups.
// Supabase layer: rooms, rates, availability, reservations (unchanged).

const { v4: uuidv4 } = require('uuid');
const Groq           = require('groq-sdk');
const supabase       = require('../utils/supabase');
const { logger }     = require('../utils/logger');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MEAL_LABELS = {
  room_only:         'Room Only',
  bed_and_breakfast: 'Bed & Breakfast',
  half_board:        'Half Board',
  full_board:        'Full Board',
  all_inclusive:     'All Inclusive',
};

function buildSystemPrompt(group, allProperties) {
  const propList = allProperties.map(p =>
    `- ${p.name} (id: ${p.id}) — ${p.destination || p.location || ''}`
  ).join('\n');

  return `You are a warm, professional hotel concierge for ${group.name}.
You help guests find and book rooms across our properties.

OUR PROPERTIES:
${propList}

YOUR JOB:
Understand what the guest wants — no matter how they phrase it, across multiple turns — and return a JSON object so the system can search availability.

ALWAYS respond with valid JSON in this exact shape:
{
  "intent": "search" | "refine" | "question" | "clarify" | "manage" | "chitchat",
  "replyText": "Your warm, natural reply to the guest (1-3 sentences). For search/refine, briefly confirm what you're looking for. For question, answer it from context. For clarify, ask the one missing thing.",
  "searchParams": {
    "legs": [
      {
        "propertyId": "<uuid or null>",
        "propertyName": "<name or null>",
        "checkIn": "YYYY-MM-DD or null",
        "checkOut": "YYYY-MM-DD or null",
        "nights": <number or null>
      }
    ],
    "propertyId": "<uuid or null — first leg or single property>",
    "propertyName": "<name or null — first leg or single property>",
    "checkIn": "YYYY-MM-DD or null",
    "checkOut": "YYYY-MM-DD or null",
    "nights": <number or null>,
    "adults": <number or null>,
    "children": <number or null>,
    "mealPlan": "room_only|bed_and_breakfast|half_board|full_board|all_inclusive or null",
    "budget": "low|mid|luxury or null",
    "preferences": ["honeymoon","family","business","beach","safari","spa"] or [],
    "shouldSearch": <true if we have enough to search, false if we need more info>
  },
  "clarifyQuestion": "<single question to ask if intent=clarify, else null>"
}

RULES:
- Today is ${new Date().toISOString().split('T')[0]}.
- If the guest says yes, sure, go ahead, sounds good, check it, that works — this is a CONFIRMATION. Use the property and params from the previous assistant message and set shouldSearch=true.
- If the guest mentions multiple properties or destinations (e.g. "mara and mombasa", "3 nights in X then 2 nights in Y"), populate the "legs" array with one entry per property. Set shouldSearch=true if at least one leg is resolvable. Set top-level propertyId/checkIn to the FIRST leg.
- If the guest doesn't specify a property but we can infer one from context (e.g. "the beach one", "that lodge"), use it.
- If the guest refines (e.g. "what about full board?", "do you have suites?", "make it 5 nights", "1 adult and 1 child"), update ONLY the changed fields and keep everything else from context.
- If dates are relative ("this weekend", "next Friday", "tomorrow"), resolve them to YYYY-MM-DD.
- If no check-in is given, default to tomorrow. If no nights, default to 3. If no adults, default to 1.
- Only set shouldSearch=true when you have at minimum: a clear property match AND checkIn.
- If the guest asks about a location we don't have a property in, suggest the closest matching property by context (beach request = suggest coastal property) and set shouldSearch=false with a clarifyQuestion asking if they would like to check that property instead.
- For intent=question (e.g. "what's the cancellation policy?", "is breakfast included?"), answer from conversation context and set shouldSearch=false.
- For intent=manage (cancel/modify/view booking), set shouldSearch=false — the widget handles this.
- Keep replyText warm and concise. Never list room prices in replyText — the system renders cards.
- Never make up room prices or availability — the system fetches live data.`;
}

function resolveCheckOut(checkIn, nights) {
  if (!checkIn) return null;
  const d = new Date(checkIn);
  d.setDate(d.getDate() + (nights || 3));
  return d.toISOString().split('T')[0];
}

class HotelDirectEngine {

  async orchestrate(prompt, groupSlug, context = {}) {
    const sessionId = uuidv4();
    const { conversationHistory = [], previousParams = null } = context;

    logger.info(`[HOTEL DIRECT][${sessionId}] Started`, { groupSlug, prompt });

    try {
      const group = await this._getHotelGroup(groupSlug);
      if (!group) {
        return this._buildResponse(sessionId, {}, conversationHistory,
          `I couldn't find a hotel configuration for "${groupSlug}". Please contact support.`, []);
      }

      const allProperties = await this._getAllProperties(group.id);
      const systemPrompt  = buildSystemPrompt(group, allProperties);

      // Build conversation history for Groq — last 20 turns
      const messages = [];
      const history  = conversationHistory.slice(-20);
      for (const h of history) {
        const role    = h.role === 'assistant' ? 'assistant' : 'user';
        const content = (h.content || '').trim();
        if (!content) continue;
        if (messages.length && messages[messages.length - 1].role === role) continue;
        messages.push({ role, content });
      }
      if (messages.length && messages[messages.length - 1].role === 'user') {
        messages.push({ role: 'assistant', content: 'Understood.' });
      }
      messages.push({ role: 'user', content: prompt });

      // ── Call Groq ─────────────────────────────────────────────────────
      let groqResult;
      try {
        const response = await groq.chat.completions.create({
          model:           'llama-3.3-70b-versatile',
          response_format: { type: 'json_object' },
          max_tokens:      600,
          temperature:     0.2,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
          ],
        });

        const raw  = response.choices[0]?.message?.content || '{}';
        groqResult = JSON.parse(raw);
      } catch (err) {
        logger.error('[HOTEL DIRECT] Groq parse failed', { error: err.message });
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          "I didn't quite catch that. Could you tell me which property you'd like and your preferred dates?", []);
      }

      const { intent, replyText, searchParams, clarifyQuestion } = groqResult;

      console.log('[HOTEL DIRECT] Groq intent:', intent, '| shouldSearch:', searchParams?.shouldSearch);
      console.log('[HOTEL DIRECT] Search params:', JSON.stringify(searchParams));

      // ── Non-search intents ────────────────────────────────────────────
      if (intent === 'clarify' || !searchParams?.shouldSearch) {
        const msg = clarifyQuestion || replyText || "Could you give me a bit more detail?";
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          msg, [], { needsClarification: true });
      }

      if (intent === 'question' || intent === 'manage' || intent === 'chitchat') {
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          replyText || "How can I help?", []);
      }

      // ── Resolve first/single property ────────────────────────────────
      let property = null;
      if (searchParams.propertyId) {
        property = allProperties.find(p => p.id === searchParams.propertyId) || null;
      }
      if (!property && searchParams.propertyName) {
        const name = (searchParams.propertyName || '').toLowerCase();
        property   = allProperties.find(p =>
          p.name.toLowerCase().includes(name) || name.includes(p.name.toLowerCase())
        ) || null;
      }

      // ── Build shared tripParams ───────────────────────────────────────
      const nights   = searchParams.nights  || 3;
      const checkIn  = searchParams.checkIn || (() => {
        const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0];
      })();
      const checkOut = searchParams.checkOut || resolveCheckOut(checkIn, nights);
      const adults   = searchParams.adults   || 1;
      const children = searchParams.children || 0;
      const mealPlan = searchParams.mealPlan || null;
      const budget   = searchParams.budget   || 'mid';

      const tripParams = {
        propertyId:   property?.id || null,
        propertyName: property?.name || null,
        destination:  property?.destination || property?.location || null,
        nights, adults, passengers: adults, children, childAges: [],
        mealPlan, departureDate: checkIn, returnDate: checkOut,
        budget, preferences: searchParams.preferences || [],
        groupSlug, _originalPrompt: prompt,
      };

      // ── Multi-leg search ──────────────────────────────────────────────
      const legs = Array.isArray(searchParams.legs) ? searchParams.legs : [];
      if (legs.length > 1) {
        const allPackages = [];
        let legCheckInCursor = checkIn;

        for (const leg of legs) {
          let legProperty = null;
          if (leg.propertyId) {
            legProperty = allProperties.find(p => p.id === leg.propertyId) || null;
          }
          if (!legProperty && leg.propertyName) {
            const name = (leg.propertyName || '').toLowerCase();
            legProperty = allProperties.find(p =>
              p.name.toLowerCase().includes(name) || name.includes(p.name.toLowerCase())
            ) || null;
          }
          if (!legProperty) continue;

          const legNights   = leg.nights || 3;
          const legCheckIn  = leg.checkIn  || legCheckInCursor;
          const legCheckOut = leg.checkOut || resolveCheckOut(legCheckIn, legNights);
          legCheckInCursor  = legCheckOut; // next leg starts where this one ends

          const rooms = await this._searchRooms(legProperty, {
            checkIn: legCheckIn, checkOut: legCheckOut,
            nights: legNights, adults, children, childAges: [], mealPlan, budget,
          });
          if (!rooms.length) continue;

          const ancillaries = await this._getAncillaryServices(legProperty.id, {
            ...tripParams, propertyId: legProperty.id, propertyName: legProperty.name,
            nights: legNights, departureDate: legCheckIn, returnDate: legCheckOut,
          });

          const legPackages = rooms.slice(0, 12).map(room =>
            this._buildRoomPackage(room, legProperty, ancillaries, {
              ...tripParams,
              propertyId: legProperty.id, propertyName: legProperty.name,
              nights: legNights, departureDate: legCheckIn, returnDate: legCheckOut,
            }, group)
          );
          allPackages.push(...legPackages);
        }

        if (allPackages.length) {
          const matched = await this._applyPriceMatch(allPackages, groupSlug, checkIn, nights);
          logger.info('Hotel orchestrate', { groupSlug, packages: matched.length });
          return this._buildResponse(sessionId, tripParams, conversationHistory,
            replyText || `Here are options across your requested properties:`, matched);
        }

        // All legs returned no rooms
        return this._buildResponse(sessionId, tripParams, conversationHistory,
          replyText || `Unfortunately I couldn't find availability across those properties for your dates. Would you like to try different dates?`, []);
      }

      // ── Single property fallback ──────────────────────────────────────
      if (!property) {
        const propList = allProperties
          .map((p, i) => `${i + 1}. ${p.name} — ${p.destination || p.location || ''}`)
          .join('\n');
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          `${replyText || "Which of our properties would you like?"}\n\n${propList}`, []);
      }

      // ── Search rooms ──────────────────────────────────────────────────
      const rooms = await this._searchRooms(property, {
        checkIn, checkOut, nights, adults, children, childAges: [], mealPlan, budget,
      });

      if (!rooms.length) {
        return this._buildResponse(sessionId, tripParams, conversationHistory,
          `${replyText ? replyText + ' ' : ''}Unfortunately there are no rooms available at ${property.name} for those dates. Would you like to try different dates or a different property?`,
          []);
      }

      const ancillaries    = await this._getAncillaryServices(property.id, tripParams);
      const mealPlansFound = new Set(rooms.map(r => r.mealPlan));
      const packages       = rooms.slice(0, 12).map(room =>
        this._buildRoomPackage(room, property, ancillaries, tripParams, group)
      );

      // ── Apply price match silently ────────────────────────────────────
      const matchedPackages = await this._applyPriceMatch(packages, groupSlug, checkIn, nights);

      // ── Build reply text ──────────────────────────────────────────────
      const foundLabels    = [...mealPlansFound].map(m => MEAL_LABELS[m] || m);
      const requestedLabel = mealPlan ? (MEAL_LABELS[mealPlan] || mealPlan) : null;

      let text = replyText || '';
      if (!text) {
        if (!mealPlan) {
          const planNote = foundLabels.length === 1
            ? `on ${foundLabels[0]}`
            : `on ${foundLabels.slice(0,-1).join(', ')} and ${foundLabels[foundLabels.length-1]}`;
          text = `Here's what we have at ${property.name} — ${nights} night${nights!==1?'s':''} for ${adults} guest${adults!==1?'s':''}, ${planNote}:`;
        } else if ([...mealPlansFound].includes(mealPlan)) {
          text = `Here are the ${requestedLabel} options at ${property.name}:`;
        } else {
          const planNote = foundLabels.length === 1
            ? foundLabels[0]
            : `${foundLabels.slice(0,-1).join(', ')} and ${foundLabels[foundLabels.length-1]}`;
          text = `${property.name} operates on ${planNote} rather than ${requestedLabel}. Here's what's available:`;
        }
      }

      logger.info('Hotel orchestrate', { groupSlug, packages: matchedPackages.length });
      return this._buildResponse(sessionId, tripParams, conversationHistory, text, matchedPackages);

    } catch (err) {
      logger.error('[HOTEL DIRECT] Engine failure', { error: err.message, stack: err.stack });
      return this._buildResponse(sessionId, {}, conversationHistory,
        "I had a moment of trouble there. Could you tell me which property and dates you're looking for?", []);
    }
  }

  // ── PRICE MATCH ───────────────────────────────────────────────────────────
  async _applyPriceMatch(packages, groupSlug, checkIn, nights) {
    try {
      const { data: rates } = await supabase
        .from('competitor_rates')
        .select('*')
        .eq('group_slug', groupSlug)
        .eq('check_in', checkIn)
        .eq('is_current', true)
        .order('ota_rate', { ascending: true })
        .limit(1);

      if (!rates || !rates.length) return packages;
      const bestOTA = rates[0];

      return packages.map(pkg => {
        const hotel      = pkg.hotel || {};
        const directRate = hotel.pricePerNight;
        if (!directRate) return pkg;

        const gap = directRate - bestOTA.ota_rate;
        if (gap <= directRate * 0.03) return pkg;

        const matchedRate    = Math.floor(bestOTA.ota_rate * 0.99);
        const savingPerNight = directRate - matchedRate;
        const newTotal       = matchedRate * (nights || 1);

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
          property: hotel.propertyName, checkIn,
          directRate, matchedRate, ota: bestOTA.ota_name,
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
      logger.warn('[PRICE MATCH] Failed silently', { error: err.message });
      return packages;
    }
  }

  // ── ROOM SEARCH ───────────────────────────────────────────────────────────
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
        .from('room_types').select('*')
        .eq('property_id', property.id).eq('is_active', true)
        .gte('max_adults', adults).order('sort_order');
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

        // Push a result for every rate plan, not just the best one
        for (const ratePlan of ratePlans) {
          const extraAdults = Math.max(0, adults - (ratePlan.base_occupancy || adults));
          const nightsCount = nights || 1;
          const totalPrice  = (ratePlan.price_per_night * nightsCount) +
            ((ratePlan.extra_adult_surcharge || 0) * extraAdults * nightsCount) +
            ((ratePlan.child_surcharge       || 0) * children    * nightsCount);

          const { data: policy } = await supabase
            .from('cancellation_policies').select('*')
            .eq('rate_plan_id', ratePlan.id).maybeSingle();

          results.push({
            roomType, ratePlan, property, checkIn,
            checkOut:           checkOut || this._addDays(checkIn, nights),
            nights:             nightsCount, adults, children, childAges, totalPrice,
            pricePerNight:      ratePlan.price_per_night,
            currency:           ratePlan.currency || property.currency || 'KES',
            mealPlan:           ratePlan.meal_plan,
            cancellationPolicy: policy || null,
            allRates:           ratePlans,
            mealPlanMatched:    !mealPlan || ratePlan.meal_plan === mealPlan,
          });
        }
      }
      return results;
    } catch (err) {
      logger.error('[HOTEL DIRECT] Supabase room search failed', { error: err.message, propertyId: property.id });
      return [];
    }
  }

  async _searchRoomsOperaCloud(property, params) {
    logger.warn('[HOTEL DIRECT] Opera Cloud not yet implemented — falling back', { propertyId: property.id });
    return this._searchRoomsSupabase(property, params);
  }

  async _searchRoomsOpera5(property, params) {
    logger.warn('[HOTEL DIRECT] Opera 5 not yet implemented — falling back', { propertyId: property.id });
    return this._searchRoomsSupabase(property, params);
  }

  async _checkAvailability(roomTypeId, checkIn, checkOut) {
    if (!checkIn) return true;
    const { data: blocks } = await supabase
      .from('availability_blocks').select('date_from, date_to, rooms_available')
      .eq('room_type_id', roomTypeId).lte('date_from', checkIn).gte('date_to', checkOut || checkIn);
    if (!blocks?.length) return true;
    return blocks.every(b => b.rooms_available > 0);
  }

  async _getRatePlans(roomTypeId, checkIn, mealPlan = null) {
    const { data: plans } = await supabase
      .from('rate_plans').select('*')
      .eq('room_type_id', roomTypeId).eq('is_active', true);
    if (!plans?.length) return [];

    const date = checkIn ? new Date(checkIn) : new Date();
    const seasonFiltered = plans.filter(plan => {
      if (!plan.season_start && !plan.season_end) return true;
      const start = plan.season_start ? new Date(plan.season_start) : null;
      const end   = plan.season_end   ? new Date(plan.season_end)   : null;
      if (start && end) return date >= start && date <= end;
      if (start) return date >= start;
      if (end)   return date <= end;
      return true;
    }).sort((a, b) => a.price_per_night - b.price_per_night);

    if (!seasonFiltered.length) return [];
    if (mealPlan) {
      const exact = seasonFiltered.filter(p => p.meal_plan === mealPlan);
      if (exact.length) return exact;
    }
    return seasonFiltered;
  }

  async _getAncillaryServices(propertyId, tripParams) {
    try {
      const { data: services } = await supabase
        .from('ancillary_services').select('*')
        .eq('property_id', propertyId).eq('is_active', true).order('sort_order');
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

    const ancillaryTotal = ancillaries.filter(a => a.requires_booking).reduce((sum, a) => {
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
        route: property.destination, nights, passengers, totalPrice,
        roomTotal: room.totalPrice, ancillaryTotal,
        pricePerPerson: Math.round(totalPrice / passengers),
        currency, mealPlan: room.mealPlan,
        transportType: 'none', commissionRate, commissionAmount,
      },
      transport: null, returnTransport: null,
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
        currency, mealPlan: room.mealPlan,
        roomType:  room.roomType.name,
        bedType:   room.roomType.bed_type,
        view:      room.roomType.view,
        amenities: room.roomType.amenities || [],
        checkIn:   room.checkIn,
        checkOut:  room.checkOut,
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
        id: a.id, name: a.name, description: a.description,
        category: a.category, price: a.price, currency: a.currency,
        priceBasis: a.price_basis, requiresBooking: a.requires_booking,
        images: a.images || [],
      })),
      status: 'available',
    };
  }

  async _getAllProperties(groupId) {
    const { data } = await supabase
      .from('hotel_properties').select('*')
      .eq('group_id', groupId).eq('is_active', true).order('sort_order');
    return data || [];
  }

  async _getHotelGroup(slug) {
    if (!slug) return null;
    const { data, error } = await supabase
      .from('hotel_groups').select('*')
      .eq('slug', slug).eq('is_active', true).single();
    if (error) {
      logger.warn('[HOTEL DIRECT] Hotel group not found', { slug, error: error.message });
      return null;
    }
    return data || null;
  }

  _formatCancellationNote(policy, ratePlan) {
    if (policy) {
      if (policy.free_cancellation_days > 0)
        return `Free cancellation up to ${policy.free_cancellation_days} day${policy.free_cancellation_days > 1 ? 's' : ''} before check-in${policy.penalty_percentage > 0 ? `, then ${policy.penalty_percentage}% penalty` : ''}.`;
      if (policy.penalty_percentage === 100) return 'Non-refundable.';
      return policy.policy_name || policy.notes || 'See cancellation policy.';
    }
    if (ratePlan?.is_refundable === false) return 'Non-refundable.';
    if (ratePlan?.is_refundable === true)  return 'Refundable — conditions apply.';
    return 'Cancellation policy confirmed at booking.';
  }

  _buildResponse(sessionId, tripParams, conversationHistory, text, packages, meta = {}) {
    const updatedHistory = [
      ...conversationHistory,
      { role: 'user',      content: tripParams._originalPrompt || '' },
      { role: 'assistant', content: text, packageCount: packages.length },
    ].slice(-20);

    return {
      sessionId, text, packages, tripParams,
      conversationHistory: updatedHistory,
      generatedAt: new Date().toISOString(),
      isHotelDirect: true,
      ...meta,
    };
  }

  _addDays(dateStr, days) {
    if (!dateStr) {
      const d = new Date(); d.setDate(d.getDate() + (days || 1));
      return d.toISOString().split('T')[0];
    }
    const d = new Date(dateStr); d.setDate(d.getDate() + (days || 1));
    return d.toISOString().split('T')[0];
  }
}

module.exports = new HotelDirectEngine();