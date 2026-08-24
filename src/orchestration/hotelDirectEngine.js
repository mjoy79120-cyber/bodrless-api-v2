// HOTEL DIRECT ENGINE — v9.1
// Changes from v9.0:
// - Added isValidDate guard to prevent crashes from malformed LLM dates
// - Added prompt length cap (1500 chars) to prevent token/cost spikes
// - Added room selection validation to catch hallucinated room names/indexes
// - Added null-safety in _buildRoomPackage for dummy data with missing fields
// - Price-match log insert now warns on failure instead of swallowing silently
// - All v9.0 logic preserved

const { v4: uuidv4 } = require('uuid');
const Groq            = require('groq-sdk');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const pmsIntegrations = require('../integrations/pmsIntegrations');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MEAL_LABELS = {
  room_only:         'Room Only',
  bed_and_breakfast: 'Bed & Breakfast',
  half_board:        'Half Board',
  full_board:        'Full Board',
  all_inclusive:     'All Inclusive',
};

const INTENT_UPSELL_MAP = {
  honeymoon:   ['honeymoon', 'spa', 'wellness', 'romantic'],
  wedding:     ['honeymoon', 'spa', 'wellness', 'romantic', 'upgrade'],
  anniversary: ['honeymoon', 'spa', 'wellness', 'romantic'],
  birthday:    ['upgrade', 'wellness', 'spa'],
  celebration: ['upgrade', 'wellness', 'spa'],
  spa:         ['spa', 'wellness'],
  wellness:    ['spa', 'wellness'],
  business:    ['business', 'transfer', 'upgrade'],
  corporate:   ['business', 'transfer', 'upgrade'],
  family:      ['family', 'adventure'],
  adventure:   ['adventure'],
  safari:      ['adventure', 'transfer'],
  beach:       ['adventure', 'honeymoon'],
  romantic:    ['honeymoon', 'spa', 'wellness', 'romantic'],
};

const TRANSFER_CATEGORIES = ['transfer'];

const PREFERENCE_FEATURE_MAP = {
  beach:      ['beach', 'beachfront', 'ocean', 'coast', 'coastal', 'sea'],
  spa:        ['spa', 'wellness', 'massage'],
  pool:       ['pool', 'swimming'],
  safari:     ['safari', 'game', 'wildlife', 'bush', 'lodge', 'camp'],
  adventure:  ['adventure', 'hiking', 'safari', 'wildlife', 'outdoor'],
  city:       ['city', 'cbd', 'nairobi', 'urban', 'business district'],
  business:   ['business', 'conference', 'meetings', 'corporate'],
  family:     ['family', 'kids', 'children', 'playground'],
  romantic:   ['romantic', 'couples', 'honeymoon', 'intimate'],
  luxury:     ['luxury', 'premium', 'five-star', '5-star'],
  budget:     ['budget', 'affordable', 'value'],
  airport:    ['airport', 'jkia', 'wilson', 'transit'],
  lake:       ['lake', 'lakeside', 'naivasha', 'nakuru', 'victoria'],
  mountain:   ['mountain', 'highland', 'aberdare', 'kilimanjaro', 'kenya'],
};

// ─────────────────────────────────────────────────────────────────────────────
// BUILD SYSTEM PROMPT — with soul
// Uses concierge_voice, brand_tagline, description, highlights and best_for
// from hotel_groups and hotel_properties tables.
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(group, allProperties, guestMemory = null) {
  const voice   = group.concierge_voice || 'warm and professional';
  const tagline = group.brand_tagline   || '';

  const propList = allProperties.map(p => {
    const features   = (p.features      || []).join(', ') || 'N/A';
    const locTags    = (p.location_tags || []).join(', ') || 'N/A';
    const highlights = (p.highlights    || []).join(', ') || 'N/A';
    const bestFor    = (p.best_for      || []).join(', ') || 'N/A';
    const type       = p.property_type  || 'hotel';
    const desc       = p.description    || '';

    return [
      `- ${p.name} (id: ${p.id})`,
      `  Location: ${p.destination || p.location || 'Kenya'}`,
      `  Type: ${type}`,
      `  About: ${desc}`,
      `  Highlights: ${highlights}`,
      `  Best for: ${bestFor}`,
      `  Features: ${features}`,
      `  Tags: ${locTags}`,
    ].join('\n');
  }).join('\n\n');

  const guestContext = guestMemory ? `
RETURNING GUEST:
Name: ${guestMemory.guest_name || 'Guest'}
Last stay: ${guestMemory.last_property || 'unknown'} on ${guestMemory.last_check_in || 'unknown'}
Previous preferences: ${(guestMemory.preferences || []).join(', ') || 'none recorded'}
Note: Acknowledge them warmly as a returning guest in your first replyText. Personalise the suggestion based on their history.
` : '';

  return `You are the personal concierge for ${group.name}${tagline ? ` — "${tagline}"` : ''}.
Your voice: ${voice}.
You know every ${group.name} property intimately — not just the facts, but the feeling of being there.
When a guest asks about a property, speak about it the way a trusted friend who has stayed there would.
Mention what makes it special for their occasion. Never be generic.
${guestContext}
OUR PROPERTIES:
${propList}

YOUR JOB:
Understand what the guest wants and return a JSON object so the system can search availability.
Use what you know about each property to match guests to the right one — and when you confirm
a search, say something genuine about why that property fits their request.

SOUL RULES:
- For honeymoon/anniversary/romantic: mention the atmosphere, the sunset, the privacy — not just the room.
- For safari/adventure: mention the wildlife, the remoteness, the magic of being in the bush.
- For beach: mention the ocean, the reef, the sound of waves — make them feel it.
- For business: be efficient and precise — they want confirmation, not poetry.
- For family: be practical and warm — mention what kids love about the property.
- When no rooms are available: don't just say "no rooms". Suggest the next best dates or sister property with genuine enthusiasm.
- replyText should never sound like a search engine. It should sound like someone who cares.

INTENT DETECTION:
- "honeymoon", "honeymooners" → preferences: ["honeymoon"]
- "wedding", "just married", "newlyweds" → preferences: ["wedding"]
- "anniversary" → preferences: ["anniversary"]
- "birthday" → preferences: ["birthday"]
- "celebration", "special occasion" → preferences: ["celebration"]
- "spa", "spa getaway", "wellness retreat" → preferences: ["spa"]
- "business trip", "corporate", "work trip" → preferences: ["business"]
- "family", "kids", "children" → preferences: ["family"]
- "adventure", "safari", "hiking" → preferences: ["adventure"]
- "romantic", "couples getaway" → preferences: ["romantic"]
- "beach", "beachfront", "coastal" → preferences: ["beach"]
- Multiple can apply: "honeymoon safari" → preferences: ["honeymoon", "adventure"]

ROOM SELECTION DETECTION:
When the guest picks a specific room or says something like:
"I'll take the Deluxe Room", "book the suite", "I want room 2", "that one looks good",
"the second option", "the superior room please", "go with the junior suite" —
set intent to "select" and extract the room name or selection index.

ALWAYS respond with valid JSON:
{
  "intent": "search" | "refine" | "select" | "question" | "clarify" | "manage" | "chitchat",
  "replyText": "Warm, genuine reply (1-3 sentences). Sound like a person, not a search engine. For special occasions be warm and personal. For returning guests acknowledge them warmly. For select intent, confirm the room warmly. Never list prices.",
  "searchParams": {
    "legs": [],
    "propertyId": "<uuid or null>",
    "propertyName": "<name or null>",
    "checkIn": "YYYY-MM-DD or null",
    "checkOut": "YYYY-MM-DD or null",
    "nights": <number or null>,
    "adults": <number or null>,
    "children": <number or null>,
    "mealPlan": "room_only|bed_and_breakfast|half_board|full_board|all_inclusive or null",
    "budget": "low|mid|luxury or null",
    "preferences": [],
    "shouldSearch": <true/false>,
    "featureRequest": "<what feature the guest wants if no exact property match, or null>",
    "selectedRoomName": "<room name if intent=select, else null>",
    "selectedRoomIndex": <0-based index if guest said 'the second one' etc, else null>
  },
  "clarifyQuestion": "<single question if intent=clarify, else null>"
}

PROPERTY MATCHING RULES:
- Match by name first. If no name match, use features, highlights and best_for tags.
- If NO property matches, set shouldSearch=false, featureRequest to what they want.

RULES:
- Today is ${new Date().toISOString().split('T')[0]}.
- Confirmations ("yes", "sure", "go ahead", "sounds good") → use previous params, shouldSearch=true.
- Multi-property: populate legs array.
- Relative dates → resolve to YYYY-MM-DD.
- No check-in → default tomorrow. No nights → default 3. No adults → default 1.
- Honeymoon/wedding → default 2 adults.
- shouldSearch=true when property match AND any time reference.
- Never list room prices in replyText.`;
}

function isValidDate(str) {
  if (!str || typeof str !== 'string') return false;
  const d = new Date(str);
  return !isNaN(d.getTime());
}

function resolveCheckOut(checkIn, nights) {
  if (!isValidDate(checkIn)) return null;
  const d = new Date(checkIn);
  d.setDate(d.getDate() + (nights || 3));
  return d.toISOString().split('T')[0];
}

function resolveUpsellTags(preferences = []) {
  const tags = new Set();
  for (const pref of preferences) {
    const mapped = INTENT_UPSELL_MAP[pref.toLowerCase()] || [];
    mapped.forEach(t => tags.add(t));
  }
  tags.add('transfer');
  return [...tags];
}

function findBestPropertyMatch(allProperties, featureRequest, preferences = []) {
  if (!featureRequest && !preferences.length) return null;

  const wantedTags = new Set();

  if (featureRequest) {
    const req = featureRequest.toLowerCase();
    for (const [pref, tags] of Object.entries(PREFERENCE_FEATURE_MAP)) {
      if (tags.some(t => req.includes(t)) || req.includes(pref)) {
        tags.forEach(t => wantedTags.add(t));
      }
    }
    req.split(/\s+/).forEach(w => wantedTags.add(w));
  }

  for (const pref of preferences) {
    const tags = PREFERENCE_FEATURE_MAP[pref.toLowerCase()] || [];
    tags.forEach(t => wantedTags.add(t));
  }

  if (!wantedTags.size) return null;

  const scored = allProperties.map(p => {
    const propTags = [
      ...(p.features      || []),
      ...(p.location_tags || []),
      ...(p.highlights    || []),
      ...(p.best_for      || []),
      p.property_type || '',
      (p.destination || '').toLowerCase(),
      (p.location    || '').toLowerCase(),
    ].map(t => t.toLowerCase());

    const score = [...wantedTags].reduce((sum, tag) =>
      sum + (propTags.some(pt => pt.includes(tag) || tag.includes(pt)) ? 1 : 0), 0
    );

    return { property: p, score };
  }).filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.property || null;
}

function buildNoMatchSuggestion(group, allProperties, featureRequest, bestMatch) {
  if (bestMatch) {
    const highlights = (bestMatch.highlights || bestMatch.features || []).slice(0, 3).join(', ');
    return `We don't have a dedicated ${featureRequest} property, but ${bestMatch.name} in ${bestMatch.destination || bestMatch.location || 'Kenya'} is our closest option${highlights ? ` — it offers ${highlights}` : ''}. Would you like to see what's available there?`;
  }

  const propList = allProperties
    .map(p => `${p.name} (${p.destination || p.location || 'Kenya'})`)
    .join(', ');
  return `We don't currently have a property matching "${featureRequest}", but here's where ${group.name} is present: ${propList}. Would any of these work for you?`;
}

class HotelDirectEngine {

  // ─────────────────────────────────────────────────────────────────────────
  // GUEST MEMORY — look up returning guest by phone or email
  // Reads from hotel_guest_sessions table (create with SQL below).
  // Returns last session data or null if first visit.
  // ─────────────────────────────────────────────────────────────────────────
  async _getGuestMemory(groupId, guestPhone, guestEmail) {
    if (!guestPhone && !guestEmail) return null;
    try {
      let query = supabase
        .from('hotel_guest_sessions')
        .select('*')
        .eq('group_id', groupId)
        .order('last_seen_at', { ascending: false })
        .limit(1);

      if (guestPhone) {
        query = query.eq('guest_phone', guestPhone);
      } else {
        query = query.eq('guest_email', guestEmail);
      }

      const { data } = await query.maybeSingle();
      return data || null;
    } catch (err) {
      logger.warn('[HOTEL DIRECT] Guest memory lookup failed', { error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SAVE GUEST SESSION — upsert after each conversation
  // ─────────────────────────────────────────────────────────────────────────
  async _saveGuestSession(groupId, tripParams, guestPhone, guestEmail) {
    if (!guestPhone && !guestEmail) return;
    try {
      const sessionData = {
        group_id:        groupId,
        guest_phone:     guestPhone  || null,
        guest_email:     guestEmail  || null,
        last_property:   tripParams.propertyName || null,
        last_check_in:   tripParams.departureDate || null,
        preferences:     tripParams.preferences  || [],
        last_seen_at:    new Date().toISOString(),
      };

      await supabase
        .from('hotel_guest_sessions')
        .upsert(sessionData, {
          onConflict: guestPhone ? 'group_id,guest_phone' : 'group_id,guest_email',
        });
    } catch (err) {
      logger.warn('[HOTEL DIRECT] Guest session save failed', { error: err.message });
    }
  }

  async orchestrate(prompt, groupSlug, context = {}) {
    const sessionId = uuidv4();
    const { conversationHistory = [], previousParams = null } = context;

    logger.info(`[HOTEL DIRECT][${sessionId}] Started`, { groupSlug, prompt });

    prompt = (prompt || '').trim().slice(0, 1500);
    if (!prompt) {
      return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
        "I didn't catch that — could you tell me what you're looking for?", [], {}, '');
    }

    try {
      const group = await this._getHotelGroup(groupSlug);
      if (!group) {
        return this._buildResponse(sessionId, {}, conversationHistory,
          `I couldn't find a hotel configuration for "${groupSlug}". Please contact support.`, [], {}, prompt);
      }

      const allProperties = await this._getAllProperties(group.id);

      // ── Guest memory lookup ──────────────────────────────────────────
      const guestPhone = previousParams?.guestPhone || context.guestPhone || null;
      const guestEmail = previousParams?.guestEmail || context.guestEmail || null;
      const guestMemory = await this._getGuestMemory(group.id, guestPhone, guestEmail);

      if (guestMemory) {
        logger.info('[HOTEL DIRECT] Returning guest detected', {
          guestPhone, lastProperty: guestMemory.last_property,
        });
      }

      const systemPrompt = buildSystemPrompt(group, allProperties, guestMemory);

      // Build Groq message history
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

      // ── Call Groq ──────────────────────────────────────────────────────
      let groqResult;
      try {
        const response = await groq.chat.completions.create({
          model:           'llama3-70b-8192',
          response_format: { type: 'json_object' },
          max_tokens:      700,
          temperature:     0.2,
          messages: [{ role: 'system', content: systemPrompt }, ...messages],
        });
        groqResult = JSON.parse(response.choices[0]?.message?.content || '{}');
      } catch (err) {
        logger.error('[HOTEL DIRECT] Groq parse failed', { error: err.message });
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          "I didn't quite catch that. Could you tell me which property you'd like and your preferred dates?", [], {}, prompt);
      }

      const { intent, replyText, searchParams, clarifyQuestion } = groqResult;

      logger.info('[HOTEL DIRECT] Groq intent', {
        intent, shouldSearch: searchParams?.shouldSearch,
        preferences: searchParams?.preferences, featureRequest: searchParams?.featureRequest,
      });

      // ── Room selection ───────────────────────────────────────────────
      if (intent === 'select') {
        return await this._handleRoomSelection(
          sessionId, groqResult, conversationHistory, previousParams, prompt, group
        );
      }

      // ── Auto-resolve shouldSearch ────────────────────────────────────
      if (!searchParams?.shouldSearch && searchParams) {
        const hasProperty = !!(searchParams.propertyId || searchParams.propertyName ||
          searchParams.featureRequest ||
          (Array.isArray(searchParams.legs) && searchParams.legs.length > 0));
        const monthMatch  = prompt.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
        const hasTimeRef  = !!(searchParams.checkIn || monthMatch ||
          /\b(today|tomorrow|tonight|this week|next week|this weekend|next weekend)\b/i.test(prompt));

        if (hasProperty && hasTimeRef) {
          if (!searchParams.checkIn && monthMatch) {
            const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
            const monthIdx   = monthNames.indexOf(monthMatch[1].toLowerCase());
            const year       = new Date().getMonth() > monthIdx
              ? new Date().getFullYear() + 1
              : new Date().getFullYear();
            searchParams.checkIn  = `${year}-${String(monthIdx + 1).padStart(2, '0')}-01`;
            searchParams.checkOut = resolveCheckOut(searchParams.checkIn, searchParams.nights || 3);
          }
          searchParams.shouldSearch = true;
          logger.info('[HOTEL DIRECT] Auto-resolved shouldSearch=true', { checkIn: searchParams.checkIn });
        }
      }

      // ── Non-search intents ───────────────────────────────────────────
      if (intent === 'clarify' || !searchParams?.shouldSearch) {
        const msg = clarifyQuestion || replyText || "Could you give me a bit more detail?";
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          msg, [], { needsClarification: true }, prompt);
      }

      if (intent === 'question' || intent === 'manage' || intent === 'chitchat') {
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          replyText || "How can I help?", [], {}, prompt);
      }

      // ── Resolve property ─────────────────────────────────────────────
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

      const featureRequest = searchParams?.featureRequest || null;
      const preferences    = searchParams.preferences || [];

      if (!property && (featureRequest || preferences.length)) {
        const bestMatch = findBestPropertyMatch(allProperties, featureRequest, preferences);

        if (bestMatch) {
          logger.info('[HOTEL DIRECT] Feature match found', {
            featureRequest, matchedProperty: bestMatch.name,
          });
          property = bestMatch;

          if (featureRequest && !replyText) {
            const highlights = (bestMatch.highlights || bestMatch.features || []).slice(0, 3).join(', ');
            searchParams._suggestionText = `We don't have a dedicated ${featureRequest} property, but ${bestMatch.name}${highlights ? ` offers ${highlights}` : ''} and is our closest match — here's what's available:`;
          }
        } else {
          const suggestionText = buildNoMatchSuggestion(group, allProperties, featureRequest, null);
          return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
            suggestionText, [], { noPropertyMatch: true, featureRequest }, prompt);
        }
      }

      const upsellTags        = resolveUpsellTags(preferences);
      const isSpecialOccasion = preferences.some(p =>
        ['honeymoon','wedding','anniversary','birthday','celebration','romantic'].includes(p)
      );

      const nights   = searchParams.nights  || 3;
      const checkIn  = searchParams.checkIn || (() => {
        const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0];
      })();
      const checkOut  = searchParams.checkOut || resolveCheckOut(checkIn, nights);
      const adults    = searchParams.adults   || (isSpecialOccasion ? 2 : 1);
      const children  = searchParams.children || 0;
      const mealPlan  = searchParams.mealPlan || null;
      const budget    = searchParams.budget   || 'mid';

      const tripParams = {
        propertyId:   property?.id || null,
        propertyName: property?.name || null,
        destination:  property?.destination || property?.location || null,
        nights, adults, passengers: adults, children, childAges: [],
        mealPlan, departureDate: checkIn, returnDate: checkOut,
        budget, preferences, upsellTags, isSpecialOccasion,
        groupSlug, _originalPrompt: prompt,
      };

      // ── Multi-leg ────────────────────────────────────────────────────
      const legs = Array.isArray(searchParams.legs) ? searchParams.legs : [];
      if (legs.length > 1) {
        const allPackages  = [];
        const legSummaries = [];
        let legCheckInCursor = checkIn;

        for (const leg of legs) {
          let legProperty = null;
          if (leg.propertyId) legProperty = allProperties.find(p => p.id === leg.propertyId) || null;
          if (!legProperty && leg.propertyName) {
            const name = (leg.propertyName || '').toLowerCase();
            legProperty = allProperties.find(p =>
              p.name.toLowerCase().includes(name) || name.includes(p.name.toLowerCase())
            ) || null;
          }
          if (!legProperty && leg.featureRequest) {
            legProperty = findBestPropertyMatch(allProperties, leg.featureRequest, preferences);
          }
          if (!legProperty) continue;

          const legNights   = leg.nights || 3;
          const legCheckIn  = leg.checkIn  || legCheckInCursor;
          const legCheckOut = leg.checkOut || resolveCheckOut(legCheckIn, legNights);
          legCheckInCursor  = legCheckOut;

          const rooms = await this._searchRooms(legProperty, {
            checkIn: legCheckIn, checkOut: legCheckOut,
            nights: legNights, adults, children, childAges: [], mealPlan, budget,
          });
          if (!rooms.length) continue;

          const ancillaries = await this._getAncillaryServices(legProperty.id, {
            ...tripParams, propertyId: legProperty.id, propertyName: legProperty.name,
            nights: legNights, departureDate: legCheckIn, returnDate: legCheckOut, upsellTags,
          });

          const legTripParams = {
            ...tripParams, propertyId: legProperty.id, propertyName: legProperty.name,
            nights: legNights, departureDate: legCheckIn, returnDate: legCheckOut,
          };

          const legPackages = rooms.slice(0, 12).map(room =>
            this._buildRoomPackage(room, legProperty, ancillaries, legTripParams, group)
          );

          legPackages.forEach(pkg => {
            pkg._legIndex             = legSummaries.length;
            pkg._legProperty          = legProperty.name;
            pkg._requiresLegSelection = true;
          });

          allPackages.push(...legPackages);
          legSummaries.push({
            propertyId: legProperty.id, propertyName: legProperty.name,
            checkIn: legCheckIn, checkOut: legCheckOut, nights: legNights,
          });
        }

        if (allPackages.length) {
          const matched = await this._applyPriceMatch(allPackages, groupSlug, checkIn, nights);
          const multiText = replyText || (isSpecialOccasion
            ? `Here are our options across both properties for your ${preferences[0]} — select a room at each and we'll combine into one booking:`
            : `Here are options across both properties — select your preferred room at each and we'll handle checkout together:`);

          return this._buildResponse(sessionId, tripParams, conversationHistory, multiText, matched, {
            isMultiLeg: true, legSummaries, legCount: legSummaries.length,
            requiresAllLegsSelected: true,
          });
        }

        return this._buildResponse(sessionId, tripParams, conversationHistory,
          replyText || `Unfortunately I couldn't find availability across those properties for your dates. Would you like to try different dates?`, []);
      }

      // ── Single property ──────────────────────────────────────────────
      if (!property) {
        const propList = allProperties
          .map((p, i) => `${i + 1}. ${p.name} — ${p.destination || p.location || ''}`)
          .join('\n');
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          `${replyText || "Which of our properties would you like?"}\n\n${propList}`, []);
      }

      const rooms = await this._searchRooms(property, {
        checkIn, checkOut, nights, adults, children, childAges: [], mealPlan, budget,
      });

      // ── No rooms — smart fallback with nearest available dates ───────
      if (!rooms.length) {
        let nearestDate = null;
        for (let i = 1; i <= 14; i++) {
          const tryDate  = this._addDays(checkIn, i);
          const tryOut   = this._addDays(tryDate, nights);
          const tryRooms = await this._searchRoomsSupabase(property, {
            checkIn: tryDate, checkOut: tryOut, nights, adults, children, childAges: [], mealPlan, budget,
          });
          if (tryRooms.length) { nearestDate = tryDate; break; }
        }

        const altProperty = allProperties.find(p => p.id !== property.id);
        const nearestNote = nearestDate
          ? ` The next availability I can see is from ${nearestDate} — want me to check that?`
          : '';
        const altNote = altProperty && !nearestDate
          ? ` Alternatively, ${altProperty.name} may have rooms — want me to check?`
          : '';

        return this._buildResponse(sessionId, tripParams, conversationHistory,
          `${replyText ? replyText + ' ' : ''}It looks like ${property.name} is fully booked for those dates.${nearestNote}${altNote}`,
          []);
      }

      const ancillaries    = await this._getAncillaryServices(property.id, { ...tripParams, upsellTags });
      const mealPlansFound = new Set(rooms.map(r => r.mealPlan));
      const packages       = rooms.slice(0, 12).map(room =>
        this._buildRoomPackage(room, property, ancillaries, tripParams, group)
      );
      const matchedPackages = await this._applyPriceMatch(packages, groupSlug, checkIn, nights);

      const foundLabels    = [...mealPlansFound].map(m => MEAL_LABELS[m] || m);
      const requestedLabel = mealPlan ? (MEAL_LABELS[mealPlan] || mealPlan) : null;

      let text = searchParams._suggestionText || replyText || '';
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

      // ── Save guest session if we have contact details ────────────────
      if (guestPhone || guestEmail) {
        this._saveGuestSession(group.id, tripParams, guestPhone, guestEmail).catch(() => {});
      }

      logger.info('Hotel orchestrate', {
        groupSlug, packages: matchedPackages.length, preferences, upsellTags,
        featureMatch: !!searchParams._suggestionText,
        returningGuest: !!guestMemory,
      });

      return this._buildResponse(sessionId, tripParams, conversationHistory, text, matchedPackages, {
        upsellTags, isSpecialOccasion, preferences,
        featureMatch: !!searchParams._suggestionText,
        returningGuest: !!guestMemory,
      });

    } catch (err) {
      logger.error('[HOTEL DIRECT] Engine failure', { error: err.message, stack: err.stack });
      return this._buildResponse(sessionId, {}, conversationHistory,
        "I had a moment of trouble there. Could you tell me which property and dates you're looking for?", []);
    }
  }

  async _handleRoomSelection(sessionId, groqResult, conversationHistory, previousParams, prompt, group) {
    try {
      const { replyText, searchParams } = groqResult;
      const selectedRoomName  = searchParams?.selectedRoomName || null;
      const selectedRoomIndex = searchParams?.selectedRoomIndex ?? null;
      const preferences       = previousParams?.preferences || searchParams?.preferences || [];
      const upsellTags        = resolveUpsellTags(preferences);

      if (!selectedRoomName && selectedRoomIndex === null) {
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          "I want to make sure I get this right — which room would you like?", [], {}, prompt);
      }
      if (selectedRoomIndex !== null && (selectedRoomIndex < 0 || selectedRoomIndex > 10)) {
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          "Could you tell me the room name? I want to be sure I book the right one.", [], {}, prompt);
      }

      const propertyId = previousParams?.propertyId || null;
      if (!propertyId) {
        return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
          replyText || "Which room would you like to book? Please let me know the room name.", [], {}, prompt);
      }

      const { upsells, transferPrompt } = await this.enrichPackageWithUpsells(
        null,
        { hotel: { propertyId } },
        { ...previousParams, preferences, upsellTags }
      );

      const roomRef = selectedRoomName
        ? `the ${selectedRoomName}`
        : selectedRoomIndex !== null ? `your selected room` : 'your room';

      const occasionNote = preferences.some(p =>
        ['honeymoon','wedding','anniversary','celebration','romantic'].includes(p)
      ) ? ` — perfect for your ${preferences[0]}` : '';

      const confirmText = replyText ||
        `Lovely choice${occasionNote}! I've noted ${roomRef}. Here are a few extras you might enjoy to complete your stay:`;

      logger.info('[HOTEL DIRECT] Room selected — inline upsells returned', {
        propertyId, selectedRoomName, upsellCount: upsells.length,
      });

      return this._buildResponse(
        sessionId,
        { ...previousParams, selectedRoomName, selectedRoomIndex },
        conversationHistory,
        confirmText,
        [],
        {
          isRoomSelection: true, selectedRoomName, selectedRoomIndex,
          upsells, transferPrompt, readyForCheckout: true,
        },
        prompt
      );

    } catch (err) {
      logger.error('[HOTEL DIRECT] Room selection handler failed', { error: err.message });
      return this._buildResponse(sessionId, previousParams || {}, conversationHistory,
        "I've noted your room choice. Would you like to add any extras before we confirm?", [], {}, prompt);
    }
  }

  async createReservation(property, bookingData) {
    logger.info('[HOTEL DIRECT] createReservation', {
      propertyId: property.id, pmsType: property.pms_type,
    });
    return pmsIntegrations.createReservation(property, bookingData);
  }

  async enrichPackageWithUpsells(packageId, selectedPackage, tripParams) {
    try {
      const propertyId = selectedPackage?.hotel?.propertyId;
      if (!propertyId) return { upsells: [], transferPrompt: null };

      const preferences = tripParams.preferences || [];
      const upsellTags  = resolveUpsellTags(preferences);
      const ancillaries = await this._getAncillaryServices(propertyId, { ...tripParams, upsellTags });

      const transfers    = ancillaries.filter(a => TRANSFER_CATEGORIES.includes(a.category));
      const otherUpsells = ancillaries.filter(a => !TRANSFER_CATEGORIES.includes(a.category));

      const transferPrompt = transfers.length > 0 ? {
        question: 'Would you like to add an airport transfer?',
        followUp: 'Where will you be arriving from?',
        options:  ['Airport', 'Train Station', 'Bus Station', 'CBD / City Centre', 'No transfer needed'],
        services: transfers.map(t => ({
          id: t.id, name: t.name, price: t.price,
          currency: t.currency, priceBasis: t.priceBasis,
          requiresPickupLocation: true,
        })),
      } : null;

      return {
        upsells: otherUpsells.map(a => ({
          id: a.id, name: a.name, description: a.description, category: a.category,
          price: a.price, currency: a.currency, priceBasis: a.priceBasis,
          requiresBooking: a.requiresBooking, images: a.images || [],
          badge: this._getUpsellBadge(a, preferences),
        })),
        transferPrompt,
      };
    } catch (err) {
      logger.error('[HOTEL DIRECT] enrichPackageWithUpsells failed', { error: err.message });
      return { upsells: [], transferPrompt: null };
    }
  }

  _getUpsellBadge(service, preferences = []) {
    const tags = service.upsell_tags || service.upsellTags || [];
    if (preferences.includes('honeymoon')   && tags.includes('honeymoon')) return '💍 Perfect for Honeymoons';
    if (preferences.includes('wedding')     && tags.includes('honeymoon')) return '💒 Wedding Special';
    if (preferences.includes('anniversary') && tags.includes('honeymoon')) return '🥂 Anniversary Package';
    if (preferences.includes('business')    && tags.includes('business'))  return '💼 Business Essential';
    if (preferences.includes('family')      && tags.includes('family'))    return '👨‍👩‍👧 Great for Families';
    if (preferences.includes('adventure')   && tags.includes('adventure')) return '🌿 Adventure Add-on';
    if (tags.includes('spa') || tags.includes('wellness'))                  return '🧖 Wellness';
    if (tags.includes('upgrade'))                                            return '⭐ Room Upgrade';
    return null;
  }

  async _getAncillaryServices(propertyId, tripParams) {
    try {
      const { data: services } = await supabase
        .from('ancillary_services').select('*')
        .eq('property_id', propertyId).eq('is_active', true).order('sort_order');
      if (!services?.length) return [];

      const activeTags = tripParams.upsellTags || resolveUpsellTags(tripParams.preferences || []);

      return services.filter(service => {
        const tags = Array.isArray(service.upsell_tags) ? service.upsell_tags : [];
        if (tags.length === 0) return true;
        if (service.category === 'transfer') return true;
        return tags.some(tag => activeTags.includes(tag));
      });
    } catch (err) {
      logger.warn('[HOTEL DIRECT] Could not fetch ancillary services', { error: err.message });
      return [];
    }
  }

  async _applyPriceMatch(packages, groupSlug, checkIn, nights) {
    try {
      const { data: rates } = await supabase
        .from('competitor_rates').select('*')
        .eq('group_slug', groupSlug).eq('check_in', checkIn).eq('is_current', true)
        .order('ota_rate', { ascending: true }).limit(1);

      if (!rates?.length) return packages;
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
          group_slug: groupSlug, property_name: hotel.propertyName,
          check_in: checkIn, nights: nights || 1,
          original_rate: directRate, ota_rate: bestOTA.ota_rate,
          matched_rate: matchedRate, ota_name: bestOTA.ota_name,
          saving_per_night: savingPerNight, currency: hotel.currency || 'KES',
        }).then(() => {}).catch(err => {
          logger.warn('[PRICE MATCH] Log insert failed', { error: err.message });
        });

        return {
          ...pkg,
          hotel: {
            ...hotel, pricePerNight: matchedRate, totalRate: newTotal,
            priceMatchApplied: true, priceMatchOta: bestOTA.ota_name,
            priceMatchSaving: savingPerNight, originalRate: directRate,
          },
          summary: {
            ...pkg.summary, totalPrice: newTotal,
            pricePerPerson: Math.round(newTotal / (pkg.summary.passengers || 1)),
          },
        };
      });
    } catch (err) {
      logger.warn('[PRICE MATCH] Failed silently', { error: err.message });
      return packages;
    }
  }

  async _searchRooms(property, params) {
    const pmsType = property.pms_type || 'supabase';
    logger.info('[HOTEL DIRECT] _searchRooms', { propertyId: property.id, pmsType });

    switch (pmsType) {
      case 'opera_cloud':     return this._searchRoomsOperaCloud(property, params);
      case 'opera_5':         return this._searchRoomsOpera5(property, params);
      case 'channel_manager': return this._searchRoomsChannelManager(property, params);
      case 'custom_rest':     return this._searchRoomsCustomRest(property, params);
      default:                return this._searchRoomsSupabase(property, params);
    }
  }

  async _searchRoomsOperaCloud(property, params) {
    try {
      const rooms = await pmsIntegrations.searchOperaCloud(property, params);
      if (rooms.length) return rooms;
      return this._searchRoomsSupabase(property, params);
    } catch (err) {
      logger.error('[HOTEL DIRECT] Opera Cloud failed — falling back', { propertyId: property.id, error: err.message });
      return this._searchRoomsSupabase(property, params);
    }
  }

  async _searchRoomsOpera5(property, params) {
    try {
      const rooms = await pmsIntegrations.searchOpera5(property, params);
      if (rooms.length) return rooms;
      return this._searchRoomsSupabase(property, params);
    } catch (err) {
      logger.error('[HOTEL DIRECT] Opera 5 failed — falling back', { propertyId: property.id, error: err.message });
      return this._searchRoomsSupabase(property, params);
    }
  }

  async _searchRoomsChannelManager(property, params) {
    try {
      const rooms = await pmsIntegrations.searchChannelManager(property, params);
      if (rooms.length) return rooms;
      return this._searchRoomsSupabase(property, params);
    } catch (err) {
      logger.error('[HOTEL DIRECT] Channel Manager failed — falling back', { propertyId: property.id, error: err.message });
      return this._searchRoomsSupabase(property, params);
    }
  }

  async _searchRoomsCustomRest(property, params) {
    try {
      const rooms = await pmsIntegrations.searchCustomRest(property, params);
      if (rooms.length) return rooms;
      return this._searchRoomsSupabase(property, params);
    } catch (err) {
      logger.error('[HOTEL DIRECT] Custom REST failed — falling back', { propertyId: property.id, error: err.message });
      return this._searchRoomsSupabase(property, params);
    }
  }

  async _searchRoomsSupabase(property, {
    checkIn, checkOut, nights = 1, adults = 1,
    children = 0, childAges = [], mealPlan = null, budget = 'mid',
  }) {
    if (!isValidDate(checkIn)) {
      logger.warn('[HOTEL DIRECT] Invalid checkIn date', { checkIn });
      return [];
    }
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
      packageId:         require('crypto').randomUUID(),
      isHotelDirect:     true,
      groupSlug:         group.slug,
      groupId:           group.id,
      preferences:       tripParams.preferences || [],
      isSpecialOccasion: tripParams.isSpecialOccasion || false,
      summary: {
        route: property.destination, nights, passengers, totalPrice,
        roomTotal: room.totalPrice, ancillaryTotal,
        pricePerPerson: Math.round(totalPrice / passengers),
        currency, mealPlan: room.mealPlan,
        transportType: 'none', commissionRate, commissionAmount,
      },
      transport: null, returnTransport: null,
      hotel: {
        name:          `${property.name || 'Property'} — ${room.roomType?.name || 'Room'}`,
        propertyName:  property.name || 'Property',
        stars:         property.stars,
        location:      property.location,
        address:       property.address,
        latitude:      property.latitude,
        longitude:     property.longitude,
        pricePerNight: room.pricePerNight,
        totalRate:     room.totalPrice,
        currency, mealPlan: room.mealPlan,
        roomType:  room.roomType?.name || 'Room',
        bedType:   room.roomType?.bed_type || null,
        view:      room.roomType?.view || null,
        amenities: room.roomType?.amenities || [],
        checkIn:   room.checkIn,
        checkOut:  room.checkOut,
        nights,
        images:         room.roomType.images || property.images || [],
        isRefundable:   room.ratePlan.is_refundable,
        policySummary:  cancellationNote,
        availableRates: (room.allRates || []).map(r => ({
          ratePlanId:    r.id,
          mealPlan:      r.meal_plan,
          pricePerNight: r.price_per_night,
          currency:      r.currency,
          isRefundable:  r.is_refundable,
          seasonName:    r.season_name || null,
        })),
        propertyId: property.id,
        roomTypeId: room.roomType.id,
        ratePlanId: room.ratePlan.id,
        groupId:    group.id,
        groupSlug:  group.slug,
        pmsType:    property.pms_type || 'supabase',
      },
      transfers: [],
      ancillaryServices: ancillaries.map(a => ({
        id: a.id, name: a.name, description: a.description, category: a.category,
        price: a.price, currency: a.currency, priceBasis: a.price_basis,
        requiresBooking: a.requires_booking, images: a.images || [],
        upsellTags: a.upsell_tags || [],
        badge: this._getUpsellBadge(a, tripParams.preferences || []),
        requiresPickupLocation: TRANSFER_CATEGORIES.includes(a.category),
        pickupOptions: TRANSFER_CATEGORIES.includes(a.category)
          ? ['Airport', 'Train Station', 'Bus Station', 'CBD / City Centre']
          : null,
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

  _buildResponse(sessionId, tripParams, conversationHistory, text, packages, meta = {}, originalPrompt = '') {
    const updatedHistory = [
      ...conversationHistory,
      { role: 'user',      content: originalPrompt || tripParams._originalPrompt || '' },
      { role: 'assistant', content: text, packageCount: packages.length },
    ].slice(-20);

    return {
      sessionId, text, packages, tripParams,
      conversationHistory: updatedHistory,
      generatedAt:   new Date().toISOString(),
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