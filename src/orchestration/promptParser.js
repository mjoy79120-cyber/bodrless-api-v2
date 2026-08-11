/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Fixed: Added Year-2026 enforcement to System Prompt and
 * Post-Processing Sanitization Layer.
 * Fixed: Universal destination normalizer for worldwide cities.
 * Fixed: Multi-trip support — returns trips[] for independent trips.
 * Fixed: Groq now captures return legs as explicit trips[].
 * Fixed: Post-processor enforces bookend dates, distributes nights,
 *        injects transit legs for non-flyable destinations (Mara etc),
 *        and fixes impossible return legs (Mara → Washington).
 * Fixed: Retry logic on json_validate_failed.
 * Fixed: Washington DC normalization.
 * Fixed: Groq model corrected to llama-3.3-70b-versatile.
 * Fixed: Markdown fence strip in Groq response catch block.
 * Fixed: Rule-based fallback now detects multi-stop trips and emits
 *        trips[] so Mombasa/Maasai Mara are never silently dropped.
 * Fixed: activityRequests extraction (safari, snorkelling, etc).
 * Fixed: propertyType vs preferredHotel distinction — "beachfront"
 *        is a property type, not a hotel name, and must never be
 *        passed as preferredHotel or it wipes out all hotel results.
 * Fixed: Destination sanitizer — strips conversational filler from
 *        destination field (e.g. "Diani, use the details from the
 *        previous prompt" → "Diani").
 * Fixed: Follow-up session inheritance — if a follow-up parse returns
 *        a null/dirty destination, the previous session destination
 *        is inherited rather than propagating the dirty value.
 * Fixed: Stale returnDate guard — if a new departureDate is parsed
 *        fresh but returnDate was inherited from a prior session and
 *        predates the new departure, returnDate is recalculated from
 *        departureDate + nights (or nulled out) so HotelBeds never
 *        receives checkOut < checkIn.
 * Fixed: Origin field — Groq no longer invents route text for origin.
 * Fixed: budgetKES field — captures explicit KES amounts as raw numbers.
 * Fixed: Trip leg normalization — session context (origin, dates) is
 *        propagated into trips[] legs and missing first legs are
 *        prepended so the engine never receives origin:null or date:null.
 * Fixed: _normalizeTripLegsFromSession — three-way match (origin +
 *        destination + date) prevents duplicate prepend when Groq
 *        already returns the full round-trip including the first leg.
 */

const Groq = require('groq-sdk');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// PROPERTY TYPE DESCRIPTORS
// ─────────────────────────────────────────────
const PROPERTY_TYPE_KEYWORDS = new Set([
  'beachfront', 'beach front', 'beach-front', 'beachside', 'on the beach',
  'oceanfront', 'ocean front', 'seafront', 'sea front',
  'lakefront', 'lake front', 'lakeside', 'lake side',
  'poolside', 'pool', 'with pool', 'has pool',
  'city view', 'city centre', 'city center', 'downtown',
  'mountain view', 'mountain', 'hillside', 'hilltop',
  'garden view', 'garden', 'jungle', 'forest',
  'boutique', 'resort', 'lodge', 'tented camp', 'camp', 'eco lodge',
  'all inclusive', 'adults only', 'family friendly',
  'budget', 'hostel', 'guesthouse', 'airbnb',
  'rooftop', 'infinity pool', 'private pool', 'villa',
  'overwater', 'water bungalow',
]);

function _extractPropertyType(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  for (const kw of PROPERTY_TYPE_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
}

// ─────────────────────────────────────────────
// ACTIVITY KEYWORDS
// ─────────────────────────────────────────────
const SAFARI_PATTERN = /\bsafari\b|\bgame\s+(?:drive|park|reserve)\b|\bgame\s+viewing\b/i;

const EXCURSION_PATTERNS = [
  { pattern: /\bsnorkel(?:ling|ing)?\b/i,                         label: 'snorkelling' },
  { pattern: /\bscuba\s+diving\b|\bdiving\b/i,                    label: 'scuba_diving' },
  { pattern: /\bsunset\s+cruise\b|\bdhow\s+cruise\b|\bdau\s+cruise\b/i, label: 'sunset_cruise' },
  { pattern: /\bspice\s+tour\b/i,                                 label: 'spice_tour' },
  { pattern: /\bstone\s+town\s+(?:tour|walk)\b/i,                 label: 'stone_town_tour' },
  { pattern: /\bjozani\s+forest\b/i,                              label: 'jozani_forest' },
  { pattern: /\bdolphin\s+(?:tour|watching|swim)\b/i,             label: 'dolphin_tour' },
  { pattern: /\bkitesurfing\b|\bkite\s+surfing\b/i,               label: 'kitesurfing' },
  { pattern: /\bsurfing\b/i,                                      label: 'surfing' },
  { pattern: /\bhiking\b|\btrekking\b(?!\s+gorilla)/i,            label: 'hiking' },
  { pattern: /\bgorilla\s+trekking\b/i,                           label: 'gorilla_trekking' },
  { pattern: /\bspice\s+garden\b/i,                               label: 'spice_garden' },
  { pattern: /\bcultural\s+tour\b/i,                              label: 'cultural_tour' },
  { pattern: /\bcooking\s+class\b/i,                              label: 'cooking_class' },
  { pattern: /\bspa\b/i,                                          label: 'spa' },
  { pattern: /\bboat\s+trip\b|\bboat\s+tour\b/i,                  label: 'boat_trip' },
  { pattern: /\bsandbank\s+(?:trip|picnic)\b/i,                   label: 'sandbank_trip' },
  { pattern: /\bkayak(?:ing)?\b/i,                                label: 'kayaking' },
  { pattern: /\bprison\s+island\b/i,                              label: 'prison_island' },
];

const SAFARI_DESTINATIONS = {
  tanzania:   'Serengeti', zanzibar: 'Serengeti', 'dar es salaam': 'Serengeti',
  arusha: 'Serengeti', moshi: 'Serengeti',
  kenya: 'Masai Mara', nairobi: 'Masai Mara', mombasa: 'Amboseli',
  diani: 'Amboseli', malindi: 'Amboseli',
  kampala: 'Bwindi', entebbe: 'Bwindi',
  kigali: 'Akagera',
  johannesburg: 'Kruger', 'cape town': 'Kruger', durban: 'Kruger',
  _default: 'Masai Mara',
};

function resolveSafariDestination(primaryCity) {
  if (!primaryCity) return SAFARI_DESTINATIONS._default;
  const lower = (primaryCity || '').toLowerCase().trim();
  return SAFARI_DESTINATIONS[lower] || SAFARI_DESTINATIONS._default;
}

function _extractActivities(text) {
  if (!text) return { hasSafari: false, excursions: [] };
  const hasSafari = SAFARI_PATTERN.test(text);
  const excursions = [];
  for (const { pattern, label } of EXCURSION_PATTERNS) {
    if (pattern.test(text) && !excursions.includes(label)) excursions.push(label);
  }
  return { hasSafari, excursions };
}

// ─────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────
function _normalizeYear(yearInput) {
  const currentYear = new Date().getFullYear();
  let yr = parseInt(yearInput, 10);
  if (yr < 100) yr += 2000;
  if (yr < currentYear) return currentYear;
  return yr;
}

function _addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function _diffDays(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// ─────────────────────────────────────────────
// NON-FLYABLE DESTINATIONS
// ─────────────────────────────────────────────
const NON_FLYABLE_HUBS = {
  'masai mara': 'Nairobi', 'maasai mara': 'Nairobi', 'serengeti': 'Arusha',
  'ngorongoro': 'Arusha', 'amboseli': 'Nairobi', 'tsavo': 'Mombasa',
  'samburu': 'Nairobi', 'lake nakuru': 'Nairobi', 'naivasha': 'Nairobi',
  'ol pejeta': 'Nanyuki', 'bwindi': 'Entebbe', 'kruger': 'Johannesburg',
  'kruger park': 'Johannesburg', 'machu picchu': 'Cusco', 'ha long bay': 'Hanoi',
  'positano': 'Naples', 'amalfi coast': 'Naples', 'tuscany': 'Rome',
  'garden route': 'George', 'franschhoek': 'Cape Town', 'hermanus': 'Cape Town',
  'sun city': 'Johannesburg', 'petra': 'Amman', 'ubud': 'Bali', 'hoi an': 'Da Nang',
  'diani': 'Mombasa', 'diani beach': 'Mombasa',
};

function _isNonFlyable(dest) {
  return !!(NON_FLYABLE_HUBS[(dest || '').toLowerCase().trim()]);
}

function _hubFor(dest) {
  return NON_FLYABLE_HUBS[(dest || '').toLowerCase().trim()] || null;
}

// ─────────────────────────────────────────────
// MULTI-LEG POST-PROCESSOR
// ─────────────────────────────────────────────
function _postProcessBookendTrip(trips, homeOrigin, departureDate, returnDate) {
  if (!Array.isArray(trips) || trips.length < 2) return trips;
  if (!departureDate || !returnDate) return trips;

  const homeNorm = (homeOrigin || '').toLowerCase().trim();

  const lastLeg = trips[trips.length - 1];
  const lastDest = (lastLeg.destination || '').toLowerCase().trim();
  const lastIsReturnHome = lastDest === homeNorm;
  const lastOriginFlyable = !_isNonFlyable(lastLeg.origin || '');
  const datesCorrect = lastLeg.departureDate === returnDate;

  if (lastIsReturnHome && lastOriginFlyable && datesCorrect) return trips;

  let internal = trips.filter(t =>
    (t.destination || '').toLowerCase().trim() !== homeNorm
  );

  if (internal.length === 0) return trips;

  const lastInternal = internal[internal.length - 1];
  if (_isNonFlyable(lastInternal.destination)) {
    const hub = _hubFor(lastInternal.destination);
    if (hub && hub.toLowerCase() !== homeNorm) {
      internal.push({
        destination: hub, origin: lastInternal.destination,
        nights: 0, departureDate: null, returnDate: null, _transitLeg: true,
      });
    }
  }

  const totalNights = _diffDays(departureDate, returnDate);
  const specifiedNights = internal.filter((_, i) => i > 0).reduce((s, t) => s + (t.nights || 0), 0);
  const firstNights = Math.max(0, totalNights - specifiedNights);

  let cursor = departureDate;
  const rebuilt = internal.map((leg, i) => {
    const nights = i === 0 ? firstNights : (leg.nights || 0);
    const depDate = cursor;
    const retDate = nights > 0 ? _addDays(cursor, nights) : null;
    if (nights > 0) cursor = _addDays(cursor, nights);
    return { ...leg, departureDate: depDate, nights, returnDate: retDate };
  });

  const lastRebuilt = rebuilt[rebuilt.length - 1];
  rebuilt.push({
    destination: homeOrigin, origin: lastRebuilt.destination,
    nights: 0, departureDate: returnDate, returnDate: null,
    _returnLeg: true, needsOriginClarification: false,
  });

  logger.info('PromptParser: post-processed bookend trip', {
    homeOrigin, departureDate, returnDate, firstNights,
    totalLegs: rebuilt.length,
    legs: rebuilt.map(t => `${t.origin}→${t.destination} (${t.departureDate}, ${t.nights}n)`),
  });

  return rebuilt;
}

// ─────────────────────────────────────────────
// TRIP LEG NORMALIZER — session context propagation
// ─────────────────────────────────────────────
function _normalizeTripLegsFromSession(trips, topLevel) {
  const sessionOrigin    = topLevel.origin;
  const sessionDeparture = topLevel.departureDate;
  const sessionNights    = topLevel.nights;

  // ── PATCH 1: Three-way match prevents duplicate prepend ───────────────────
  // When Groq correctly returns the full round-trip (including the outbound
  // leg), the old code would prepend a duplicate because it only checked
  // destination. Now we match origin + destination + date — all three must
  // differ before we prepend the missing first leg.
  const firstTripDest   = (trips[0]?.destination || '').toLowerCase().trim();
  const firstTripOrigin = (trips[0]?.origin       || '').toLowerCase().trim();
  const sessionDest     = (topLevel.destination   || '').toLowerCase().trim();
  const sessionOrigNorm = (sessionOrigin          || '').toLowerCase().trim();

  const firstLegMatchesSession =
    firstTripDest   === sessionDest     &&
    firstTripOrigin === sessionOrigNorm &&
    (trips[0]?.departureDate || '') === (sessionDeparture || '');

  const needsPrepend = !firstLegMatchesSession && !!sessionOrigin && !!sessionDeparture && !!sessionDest;
  // ─────────────────────────────────────────────────────────────────────────

  const fullTrips = needsPrepend
    ? [
        {
          origin:                   sessionOrigin,
          destination:              topLevel.destination,
          nights:                   sessionNights || 0,
          departureDate:            sessionDeparture,
          returnDate:               null,
          needsOriginClarification: false,
          _prependedFromSession:    true,
        },
        ...trips,
      ]
    : trips;

  // Sequentially derive dates for any leg that is missing them
  let cursor = sessionDeparture;

  const normalized = fullTrips.map((leg, i) => {
    const nights  = leg.nights ?? 0;
    const depDate = leg.departureDate || cursor;
    const retDate = nights > 0 ? _addDays(depDate, nights) : null;

    if (nights > 0) cursor = _addDays(depDate, nights);
    else if (depDate) cursor = depDate;

    const inferredOrigin = i === 0
      ? sessionOrigin
      : (fullTrips[i - 1]?.destination || null);

    return {
      ...leg,
      origin:                   leg.origin || inferredOrigin,
      departureDate:            depDate,
      returnDate:               retDate,
      needsOriginClarification: false,
    };
  });

  logger.info('PromptParser: normalized trip legs from session', {
    legCount: normalized.length,
    legs: normalized.map(t => `${t.origin}→${t.destination} (${t.departureDate}, ${t.nights}n)`),
  });

  return normalized;
}

// ─────────────────────────────────────────────
// CITY / COUNTRY RESOLUTION MAPS
// ─────────────────────────────────────────────
const COUNTRY_TO_CITY = {
  'kenya': 'nairobi', 'tanzania': 'dar es salaam', 'uganda': 'kampala',
  'rwanda': 'kigali', 'ethiopia': 'addis ababa', 'south africa': 'johannesburg',
  'egypt': 'cairo', 'morocco': 'marrakech', 'ghana': 'accra', 'nigeria': 'lagos',
  'seychelles': 'mahe', 'mauritius': 'port louis', 'maldives': 'male',
  'indonesia': 'bali', 'thailand': 'phuket', 'india': 'delhi', 'japan': 'tokyo',
  'france': 'paris', 'united kingdom': 'london', 'uk': 'london',
  'uae': 'dubai', 'united arab emirates': 'dubai', 'qatar': 'doha',
  'oman': 'muscat', 'turkey': 'istanbul', 'greece': 'athens',
  'spain': 'barcelona', 'italy': 'rome', 'netherlands': 'amsterdam',
  'australia': 'sydney', 'new zealand': 'auckland',
  'usa': 'new york', 'united states': 'new york', 'america': 'new york',
  'mexico': 'cancun', 'brazil': 'rio de janeiro',
  'madagascar': 'antananarivo', 'zimbabwe': 'harare',
  'zambia': 'lusaka', 'namibia': 'windhoek', 'mozambique': 'maputo',
  'angola': 'luanda', 'cameroon': 'douala', 'senegal': 'dakar',
  'washington': 'Washington', 'washington dc': 'Washington',
  'washington d.c.': 'Washington',
};

const DESTINATION_FIXES = {
  'capetown': 'Cape Town', 'cape-town': 'Cape Town', 'cpt': 'Cape Town',
  'joburg': 'Johannesburg', 'jozi': 'Johannesburg', 'jhb': 'Johannesburg',
  'daressalaam': 'Dar es Salaam', 'dares salaam': 'Dar es Salaam', 'dar': 'Dar es Salaam',
  'addisababa': 'Addis Ababa', 'addis': 'Addis Ababa',
  'nbi': 'Nairobi', 'msa': 'Mombasa',
  'masaimara': 'Masai Mara', 'maasaimara': 'Masai Mara',
  'abudhabi': 'Abu Dhabi', 'kualalumpur': 'Kuala Lumpur', 'kl': 'Kuala Lumpur',
  'hongkong': 'Hong Kong', 'hk': 'Hong Kong',
  'newyork': 'New York', 'nyc': 'New York',
  'losangeles': 'Los Angeles', 'la': 'Los Angeles',
  'sanfrancisco': 'San Francisco', 'sf': 'San Francisco',
  'washington dc': 'Washington', 'washington d.c.': 'Washington',
  'washingtondc': 'Washington', 'dc': 'Washington',
};

function normalizeDestination(name) {
  if (!name) return name;
  const nospaces = name.toLowerCase().replace(/[\s-]/g, '');
  if (DESTINATION_FIXES[nospaces]) return DESTINATION_FIXES[nospaces];
  const lower = name.toLowerCase().trim();
  if (DESTINATION_FIXES[lower]) return DESTINATION_FIXES[lower];
  return name;
}

function resolveCountryToCity(name) {
  if (!name) return name;
  const lower = name.toLowerCase().trim();
  const city = COUNTRY_TO_CITY[lower] || name;
  return normalizeDestination(city);
}

// ─────────────────────────────────────────────
// PLACE NAME SANITY CHECK
// ─────────────────────────────────────────────
const FILLER_WORDS = /\b(help|plan|me|us|vacation|trip|travel|book|want|need|would|like|going|visit|please|can|could|shall|lets|let's|arrange|organize|organise|find|sort|make|get|a|the|and|or|but|for|from|to|in|on|at|with|holiday|journey|getaway|adventure|safari|honeymoon|weekend|escape|tour|package|cheap|affordable|cheapest|best)\b/i;

function _isPlausiblePlaceName(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 4) return false;
  if (wordCount > 2 && FILLER_WORDS.test(trimmed)) return false;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (/^(help|plan|book|find|get|arrange|organize|visit|travel|go|take|show|give|tell|use|same|previous|any)$/.test(firstWord)) return false;
  return true;
}

// ─────────────────────────────────────────────
// DESTINATION SANITIZER
// ─────────────────────────────────────────────
const FILLER_SPLIT_PATTERN = /,|\s*\(.*\)\s*|\s+(?:use|same|as|please|ok|okay|yes|from|with|but|and|for|the|previous|last|prior|above|that|those|details|info|trip|search|prompt|context|session)\b/i;

function _sanitizeDestination(dest) {
  if (!dest || typeof dest !== 'string') return null;
  const cleaned = dest.split(FILLER_SPLIT_PATTERN)[0].trim();
  if (!cleaned) return null;
  return _isPlausiblePlaceName(cleaned) ? resolveCountryToCity(cleaned) : null;
}

// ─────────────────────────────────────────────
// RULE-BASED PARSER
// ─────────────────────────────────────────────
function _parseWithRules(prompt) {
  const lower = prompt.toLowerCase().trim();
  const INTENT_STRIP = /^(?:(?:can you |please |could you |i want to |i'?d like to |i would like to |help me |i need |arrange |book me |find me |plan me |plan a |sort out |organize |organise |i'?m (?:looking|thinking|planning)|we |let'?s )+)(?:a |an |my |the )?(?:(?:trip|vacation|holiday|travel|journey|getaway|adventure|safari|honeymoon|weekend(?: away)?|city break|tour|package)\s+)?/i;
  const stripped = lower.replace(INTENT_STRIP, '').trim() || lower;

  let destination = null;
  const simpleRoute = lower.match(/^([a-z][a-z\s]{1,20}?)\s+to\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|and|\d)|[,.]|$)/i);
  if (simpleRoute) destination = simpleRoute[2].trim();

  if (!destination) {
    const toMatch = (stripped || lower).match(/\bto\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|and|\d)|[,.]|$)/i);
    if (toMatch) destination = toMatch[1].trim();
  }

  if (!destination) {
    const inMatch = (stripped || lower).match(/\b(?:in|visiting|visit)\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|with|and|\d)|[,.]|$)/i);
    if (inMatch) destination = inMatch[1].trim();
  }

  if (!destination && stripped && stripped !== lower) {
    const firstWordMatch = stripped.match(/^(?:to\s+|in\s+|for\s+)?([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|\d)|[,.]|$)/i);
    if (firstWordMatch && _isPlausiblePlaceName(firstWordMatch[1])) {
      destination = firstWordMatch[1].trim();
    }
  }

  if (destination) {
    destination = _sanitizeDestination(destination) || _sanitizeDestination(resolveCountryToCity(destination.trim()));
  }

  let origin = null;
  if (simpleRoute) origin = simpleRoute[1].trim();

  if (!origin) {
    const fromMatch = lower.match(/\bfrom\s+((?:[a-z]+(?:\s+[a-z]+){0,2}?))(?=\s+(?:to|on|for|in|with|and|\d)|[,.]|$)/i);
    if (fromMatch) {
      const candidate = fromMatch[1].trim();
      const notAPlace = /^(me|us|a|the|my|our|here|there|home|anywhere|2|3|4|5|6|7|8|9|people|persons|adults|travelers?)$/i.test(candidate);
      if (!notAPlace) origin = candidate;
    }
  }
  if (origin) origin = resolveCountryToCity(origin.trim());
  if (origin && destination && origin.toLowerCase() === destination.toLowerCase()) origin = null;

  let nights = null;
  const nightsMatch = lower.match(/(\d+)\s*(?:night|nights|nts?)\b/i);
  if (nightsMatch) nights = parseInt(nightsMatch[1], 10);

  let passengers = 1;
  const passMatch = lower.match(/(\d+)\s*(?:people|persons|pax|adults?|travelers?|of us|guests?|passengers?)\b/i);
  if (passMatch) passengers = Math.max(1, parseInt(passMatch[1], 10));
  if (/\b(?:couple|two of us|2 of us)\b/i.test(lower)) passengers = Math.max(passengers, 2);
  if (/\bfamily\b/i.test(lower) && passengers < 2) passengers = 2;

  let children = 0;
  let childAges = [];
  const childMatch = lower.match(/(\d+)\s*(?:child(?:ren)?|kid(?:s)?|minor(?:s)?)\b/i);
  if (childMatch) children = parseInt(childMatch[1], 10);
  const ageMatches = lower.match(/(?:age(?:d)?|aged?)\s*(\d{1,2})(?:\s*(?:and|&|,)\s*(\d{1,2}))?/gi) || [];
  ageMatches.forEach(m => {
    const nums = m.match(/\d{1,2}/g) || [];
    nums.forEach(n => { const age = parseInt(n, 10); if (age < 18 && age >= 0) childAges.push(age); });
  });

  let departureDate = null;
  const months = {
    jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
    january:1, february:2, march:3, april:4, june:6, july:7, august:8,
    september:9, october:10, november:11, december:12,
  };

  const dateMatch = lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(?:(\d{4})|(\d{2}))?/i)
    || lower.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/i);

  if (dateMatch) {
    let day, month, yr;
    if (/^\d/.test(dateMatch[1] || '')) {
      day = parseInt(dateMatch[1], 10);
      const mKey = (dateMatch[2] || '').toLowerCase().slice(0, 3);
      month = months[mKey] || months[(dateMatch[2] || '').toLowerCase()];
      yr = _normalizeYear(dateMatch[3] || dateMatch[4] || new Date().getFullYear());
    } else {
      const mKey = (dateMatch[1] || '').toLowerCase().slice(0, 3);
      month = months[mKey] || months[(dateMatch[1] || '').toLowerCase()];
      day = parseInt(dateMatch[2], 10);
      yr = _normalizeYear(dateMatch[3] || new Date().getFullYear());
    }
    if (day && month) departureDate = `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  if (!departureDate) {
    const isoMatch = lower.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) departureDate = isoMatch[1];
  }

  if (!departureDate) {
    const today = new Date();
    if (/next week/i.test(lower)) { today.setDate(today.getDate() + 7); departureDate = today.toISOString().split('T')[0]; }
    else if (/this weekend/i.test(lower)) { const d = today.getDay(); today.setDate(today.getDate() + (6 - d)); departureDate = today.toISOString().split('T')[0]; }
    else if (/tomorrow/i.test(lower)) { today.setDate(today.getDate() + 1); departureDate = today.toISOString().split('T')[0]; }
  }

  let returnDate = null;
  const returnDateMatch = lower.match(/\b(?:return(?:ing)?|back|fly\s+back)\s+(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)/i);
  if (returnDateMatch) {
    const day   = parseInt(returnDateMatch[1], 10);
    const mKey  = returnDateMatch[2].toLowerCase().slice(0, 3);
    const month = months[mKey];
    const yr    = new Date().getFullYear();
    if (day && month) returnDate = `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  if (!returnDate && departureDate && nights) {
    const dep = new Date(departureDate);
    dep.setDate(dep.getDate() + nights);
    returnDate = dep.toISOString().split('T')[0];
  }

  let budget = 'mid';
  if (/\b(luxury|premium|high.?end|5.?star|five.?star|splurge|lavish)\b/i.test(lower)) budget = 'luxury';
  else if (/\b(cheap(?:est)?|budget|affordable|low.?cost|economic|value|bei nafuu)\b/i.test(lower)) budget = 'low';
  else if (/\b(mid|moderate|reasonable|standard|normal|average)\b/i.test(lower)) budget = 'mid';
  else if (/\b(high|upscale|4.?star|four.?star|nice|good|quality)\b/i.test(lower)) budget = 'high';

  let budgetKES = null;
  const kesMatch = lower.match(/(\d[\d,]*(?:\.\d+)?)\s*k?\s*(?:ksh|kes|shillings?|bob)\b/i)
    || lower.match(/(?:ksh|kes)\s*(\d[\d,]*(?:\.\d+)?)\b/i);
  if (kesMatch) {
    const raw = kesMatch[1].replace(/,/g, '');
    budgetKES = parseFloat(raw);
  }
  if (!budgetKES) {
    const kMatch = lower.match(/\bbudget\b.*?(\d+)k\b|\b(\d+)k\b.*?\bbudget\b/i);
    if (kMatch) {
      const num = parseInt(kMatch[1] || kMatch[2], 10);
      if (num >= 1 && num <= 10000) budgetKES = num * 1000;
    }
  }

  let outboundTransportMode = null;
  if (/\bflight|fly|flying\b/i.test(lower)) outboundTransportMode = 'flight';
  else if (/\bbus|coach\b/i.test(lower)) outboundTransportMode = 'bus';
  else if (/\btrain|sgr|madaraka\b/i.test(lower)) outboundTransportMode = 'train';

  let mealPlan = null;
  if (/\ball.?inclusive\b/i.test(lower)) mealPlan = 'all_inclusive';
  else if (/\bfull.?board\b/i.test(lower)) mealPlan = 'full_board';
  else if (/\bhalf.?board\b/i.test(lower)) mealPlan = 'half_board';
  else if (/\bbed.?and.?breakfast|b.?&.?b|b&b\b/i.test(lower)) mealPlan = 'bed_and_breakfast';
  else if (/\broom.?only|self.?catering\b/i.test(lower)) mealPlan = 'room_only';
  else if (/\bbreakfast\b/i.test(lower)) mealPlan = 'bed_and_breakfast';

  let seatPreference = null;
  if (/\bwindow\s+seat\b/i.test(lower)) seatPreference = 'window';
  else if (/\baisle\s+seat\b/i.test(lower)) seatPreference = 'aisle';
  else if (/\bexit\s+row\b/i.test(lower)) seatPreference = 'exit_row';

  let timePreference = null;
  if (/\b(morning|early)\s+flight\b/i.test(lower)) timePreference = 'morning';
  else if (/\b(evening|night)\s+flight\b/i.test(lower)) timePreference = 'evening';
  else if (/\bafternoon\s+flight\b/i.test(lower)) timePreference = 'afternoon';

  const propertyType = _extractPropertyType(prompt);
  let preferredHotel = null;
  const hotelNameMatch = lower.match(/\b(?:at|in|stay(?:ing)?\s+at|book(?:ing)?\s+at|hotel)\s+([a-z][a-z\s]{2,30}?)(?:\s+hotel)?\b/i);
  if (hotelNameMatch) {
    const candidate = hotelNameMatch[1].trim();
    if (!_extractPropertyType(candidate)) preferredHotel = candidate;
  }

  const { hasSafari, excursions } = _extractActivities(prompt);
  const activityRequests = excursions;
  const safariDestination = hasSafari ? resolveSafariDestination(destination || origin) : null;

  const isHotelOnly = /\b(hotel only|just a hotel|only hotel|accommodation only|stay only|find me a hotel|looking for a hotel|need a hotel|hotel in|hotels? near|where to stay)\b/i.test(lower);
  const needsOriginClarification = !origin && !isHotelOnly;

  // ── Multi-stop detection ──────────────────────────────────────────────────
  const stopPattern = /(\d+)\s*nights?\s+(?:in\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  const stops = [];
  let stopMatch;

  while ((stopMatch = stopPattern.exec(prompt)) !== null) {
    const stopNights = parseInt(stopMatch[1], 10);
    const stopCity   = resolveCountryToCity(stopMatch[2].trim());
    if (stopCity.toLowerCase() !== (destination || '').toLowerCase()) {
      stops.push({ destination: stopCity, nights: stopNights });
    }
  }

  if (stops.length > 0 && destination && origin && departureDate && returnDate) {
    const totalNights = _diffDays(departureDate, returnDate);
    const knownNights = stops.reduce((s, st) => s + st.nights, 0);
    const firstNights = Math.max(0, totalNights - knownNights);
    const allStops    = [{ destination, nights: firstNights }, ...stops];

    let cursor = departureDate;
    const trips = allStops.map((st, i) => {
      const legOrigin = i === 0 ? origin : allStops[i - 1].destination;
      const depDate   = cursor;
      const retDate   = st.nights > 0 ? _addDays(cursor, st.nights) : null;
      if (st.nights > 0) cursor = _addDays(cursor, st.nights);
      return { origin: legOrigin, destination: st.destination, nights: st.nights, departureDate: depDate, returnDate: retDate, needsOriginClarification: false };
    });

    const lastStop = allStops[allStops.length - 1];
    const lastHub  = _isNonFlyable(lastStop.destination)
      ? (_hubFor(lastStop.destination) || lastStop.destination)
      : lastStop.destination;

    if (_isNonFlyable(lastStop.destination) && lastHub.toLowerCase() !== lastStop.destination.toLowerCase()) {
      trips.push({ origin: lastStop.destination, destination: lastHub, nights: 0, departureDate: returnDate, returnDate: null, needsOriginClarification: false, _transitLeg: true });
    }

    trips.push({ origin: lastHub, destination: origin, nights: 0, departureDate: returnDate, returnDate: null, needsOriginClarification: false, _returnLeg: true });

    return {
      destination, origin, nights: totalNights, passengers, children, childAges, budget, budgetKES,
      departureDate, returnDate, outboundTransportMode, returnTransportMode: null, mealPlan,
      seatPreference, timePreference, needsOriginClarification: false,
      isMultiDestination: true, trips, legs: [],
      preferredTransportProvider: null, preferredHotel, propertyType,
      activityRequests, safariDestination, _parsedBy: 'rules-multi',
    };
  }

  return {
    destination, origin, nights: nights || null, passengers, children, childAges, budget, budgetKES,
    departureDate, returnDate, outboundTransportMode, returnTransportMode: null, mealPlan,
    seatPreference, timePreference, needsOriginClarification, isMultiDestination: false, legs: [],
    preferredTransportProvider: null, preferredHotel, propertyType,
    activityRequests, safariDestination, _parsedBy: 'rules',
  };
}

// ─────────────────────────────────────────────
// GROQ LLM PARSER
// ─────────────────────────────────────────────
let groqClient = null;
try {
  if (process.env.GROQ_API_KEY) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
} catch (e) { logger.warn('Groq client init failed', { error: e.message }); }

const GROQ_SYSTEM_PROMPT = `You are a travel intent parser. Extract structured trip information. Return ONLY valid JSON.
ALWAYS assume the current year is 2026. If a user says "August 15th", resolve it to "2026-08-15".

CRITICAL RULE — CAPTURE ALL LEGS INCLUDING RETURN:
If the user describes a journey visiting multiple cities and then returning home,
EVERY leg must appear as a separate entry in trips[]. This includes the final
return leg home ("fly back to Nairobi", "then back home", "return to Nairobi").

DESTINATION FIELD — STRICT RULES:
- destination must be a real place name only: 1–4 words, no sentences.
- If the user says "Diani, use the details from before" → destination: "Diani"
- If the user says "same destination" or "previous trip" with no new place → destination: null
- NEVER put conversational text into destination. Strip everything after a comma or
  filler phrase like "use the", "same as", "as before", "from the previous", "please".

ORIGIN FIELD — STRICT RULES:
- "origin": The departure city only. Must be a single city name with no additional text.
  If the user does not mention a departure city, return null.
  NEVER guess, infer, or construct the origin from context.
  NEVER include route text like "to Kampala" or "nairobi to kampala".
  Examples of correct values: "Nairobi", "Mombasa", null
  Examples of WRONG values: "nairobi to kampala", "nairobi. to kampala", "from nairobi"

Example: "Nairobi to Zanzibar on Aug 10, 4 nights, then Mombasa for 5 nights, fly back to Nairobi"
CORRECT trips[]:
  1. origin: Nairobi,  destination: Zanzibar,  departureDate: 2026-08-10, nights: 4, returnDate: 2026-08-14
  2. origin: Zanzibar, destination: Mombasa,   departureDate: 2026-08-14, nights: 5, returnDate: 2026-08-19
  3. origin: Mombasa,  destination: Nairobi,   departureDate: 2026-08-19, nights: 0, returnDate: null

BOOKEND TRIPS — when the user gives a hard departure AND return date with internal stops:
Example: "Washington to Nairobi Aug 10 returning Aug 20, 3 nights Mombasa and 2 nights Masai Mara"
CORRECT trips[]:
  1. origin: Washington, destination: Nairobi,    departureDate: 2026-08-10, nights: 5
  2. origin: Nairobi,    destination: Mombasa,    departureDate: 2026-08-15, nights: 3
  3. origin: Mombasa,    destination: Masai Mara, departureDate: 2026-08-18, nights: 2
  4. origin: Masai Mara, destination: Nairobi,    departureDate: 2026-08-20, nights: 0
  5. origin: Nairobi,    destination: Washington, departureDate: 2026-08-20, nights: 0

WRONG — never end on Masai Mara, Serengeti, Amboseli or any safari/park destination.
WRONG — never drop the return leg.

PROPERTY TYPE vs HOTEL NAME:
- "beachfront hotel", "ocean view", "with a pool", "lodge", "tented camp" → propertyType field, preferredHotel: null
- "Sarova", "Serena", "Marriott", "Hilton" → preferredHotel field, propertyType: null
- NEVER put descriptive words like "beachfront" or "ocean view" into preferredHotel

ACTIVITIES:
- "safari", "snorkelling", "game drive", "diving", "spice tour" → activityRequests[]

BUDGET:
- budget: tier classification only: "low"|"mid"|"high"|"luxury"|null
- budgetKES: the user's stated budget as a raw number in KES. Extract whenever the user
  gives an explicit amount in KSH, KES, or shillings.
  Examples: "100,000ksh" → 100000, "50k" → 50000, "80,000 shillings" → 80000
  Return null if no explicit amount is given. NEVER put a tier string here.

Rules:
- destination must be a real place name (1-4 words max). Never a sentence.
- When trips[] is present, it must contain ALL trips.
- Always include the return-to-origin leg as the final trips[] entry.
- nights: 0 and returnDate: null for transit/return-home legs.
- The final leg destination must ALWAYS be an airport city.

Return this shape for a SINGLE trip:
{
  "trips": null,
  "destination": "city only",
  "origin": "city or null",
  "nights": number,
  "passengers": number,
  "children": number,
  "childAges": [],
  "budget": "low"|"mid"|"high"|"luxury"|null,
  "budgetKES": number|null,
  "departureDate": "YYYY-MM-DD",
  "returnDate": "YYYY-MM-DD",
  "outboundTransportMode": "flight"|"bus"|"train"|null,
  "returnTransportMode": "flight"|"bus"|"train"|null,
  "mealPlan": "all_inclusive"|"full_board"|"half_board"|"bed_and_breakfast"|"room_only"|null,
  "seatPreference": "window"|"aisle"|"exit_row"|null,
  "timePreference": "morning"|"afternoon"|"evening"|null,
  "needsOriginClarification": false,
  "isMultiDestination": false,
  "legs": [],
  "preferredTransportProvider": null,
  "preferredHotel": null,
  "propertyType": "beachfront"|"oceanfront"|"lodge"|"tented camp"|"villa"|"boutique"|null,
  "activityRequests": []
}

Return this shape for MULTIPLE TRIPS:
{
  "trips": [
    { "destination": "Zanzibar",  "origin": "Nairobi",  "nights": 4, "departureDate": "2026-08-10", "returnDate": "2026-08-14", "needsOriginClarification": false },
    { "destination": "Mombasa",   "origin": "Zanzibar", "nights": 5, "departureDate": "2026-08-14", "returnDate": "2026-08-19", "needsOriginClarification": false },
    { "destination": "Nairobi",   "origin": "Mombasa",  "nights": 0, "departureDate": "2026-08-19", "returnDate": null,          "needsOriginClarification": false }
  ],
  "destination": "Zanzibar",
  "origin": "Nairobi",
  "nights": 9,
  "passengers": 1,
  "children": 0,
  "childAges": [],
  "budget": null,
  "budgetKES": null,
  "departureDate": "2026-08-10",
  "returnDate": "2026-08-19",
  "outboundTransportMode": null,
  "returnTransportMode": null,
  "mealPlan": null,
  "seatPreference": null,
  "timePreference": null,
  "needsOriginClarification": false,
  "isMultiDestination": false,
  "legs": [],
  "preferredTransportProvider": null,
  "preferredHotel": null,
  "propertyType": null,
  "activityRequests": []
}`;

const GROQ_SYSTEM_PROMPT_SIMPLE = `Extract travel info. Return ONLY valid JSON. Current year is 2026.

destination must be a real place name only (1-4 words). Strip everything after a comma or
conversational filler like "use the", "same as", "as before", "from the previous".
If no clean destination is extractable, set destination: null.

origin must be a single departure city name only. Return null if the user does not
explicitly state a departure city. NEVER construct or guess the origin.
NEVER include route text like "to Kampala" in the origin field.

For multi-city trips use trips[]. Include ALL legs including the return home.
Never end trips[] on a safari park.
"beachfront", "oceanfront", "with pool" → propertyType (not preferredHotel).
"safari", "snorkelling" → activityRequests[].
budget: tier only ("low"|"mid"|"high"|"luxury"|null).
budgetKES: explicit KES amount as a raw number (e.g. 100000), or null.

{
  "trips": null,
  "destination": "first destination city or null",
  "origin": "departure city or null",
  "nights": total_nights_number,
  "passengers": 1,
  "children": 0,
  "childAges": [],
  "budget": null,
  "budgetKES": null,
  "departureDate": "YYYY-MM-DD",
  "returnDate": "YYYY-MM-DD",
  "outboundTransportMode": null,
  "returnTransportMode": null,
  "mealPlan": null,
  "seatPreference": null,
  "timePreference": null,
  "needsOriginClarification": false,
  "isMultiDestination": false,
  "legs": [],
  "preferredTransportProvider": null,
  "preferredHotel": null,
  "propertyType": null,
  "activityRequests": []
}`;

// ─────────────────────────────────────────────
// GROQ ATTEMPT
// ─────────────────────────────────────────────
async function _groqAttempt(prompt, systemPrompt) {
  try {
    const completion = await groqClient.chat.completions.create({
      model:           'llama-3.3-70b-versatile',
      messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      temperature:     0.1,
      max_tokens:      1000,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const cleaned = content
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```json|```/g, '')
        .trim();
      parsed = JSON.parse(cleaned);
    }

    const currentYear  = new Date().getFullYear();
    const sanitizeDate = (dateStr) => {
      if (!dateStr || typeof dateStr !== 'string') return dateStr;
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      if (d.getFullYear() < currentYear) { d.setFullYear(currentYear); return d.toISOString().split('T')[0]; }
      return dateStr;
    };

    if (parsed.departureDate) parsed.departureDate = sanitizeDate(parsed.departureDate);
    if (parsed.returnDate)    parsed.returnDate    = sanitizeDate(parsed.returnDate);

    // ── Sanitize destination ───────────────────────────────────────────────
    if (parsed.destination) {
      const clean = _sanitizeDestination(parsed.destination);
      if (!clean) {
        logger.warn('PromptParser: Groq destination failed sanitization — clearing', {
          original: parsed.destination?.slice(0, 80),
        });
        parsed.destination = null;
      } else {
        parsed.destination = clean;
      }
    }

    // ── Sanitize origin — strip any route text ─────────────────────────────
    if (parsed.origin) {
      const routeStripped = parsed.origin.split(/\s+to\s+/i)[0].trim();
      const fromStripped = routeStripped.replace(/^from\s+/i, '').trim();
      const wordCount = fromStripped.split(/\s+/).length;
      if (!fromStripped || wordCount > 3 || /[.,;]/.test(fromStripped)) {
        logger.warn('PromptParser: Groq origin looked like route text — clearing', {
          original: parsed.origin?.slice(0, 80),
          stripped: fromStripped,
        });
        parsed.origin = null;
      } else {
        parsed.origin = resolveCountryToCity(fromStripped);
      }
    }

    // ── Normalize budgetKES ────────────────────────────────────────────────
    if (parsed.budgetKES !== null && parsed.budgetKES !== undefined) {
      const raw = parsed.budgetKES;
      if (typeof raw === 'string') {
        const num = parseFloat(raw.replace(/,/g, ''));
        parsed.budgetKES = isNaN(num) ? null : num;
      } else if (typeof raw === 'number') {
        parsed.budgetKES = raw > 0 ? raw : null;
      } else {
        parsed.budgetKES = null;
      }
    } else {
      parsed.budgetKES = parsed.budgetKES ?? null;
    }

    if (Array.isArray(parsed.trips)) {
      parsed.trips = parsed.trips.map(t => ({
        ...t,
        departureDate: sanitizeDate(t.departureDate),
        returnDate:    sanitizeDate(t.returnDate),
        destination:   t.destination ? (_sanitizeDestination(t.destination) || resolveCountryToCity(t.destination)) : t.destination,
        origin:        t.origin      ? resolveCountryToCity(t.origin)      : t.origin,
      }));

      parsed.trips = parsed.trips.filter(t => t.destination && _isPlausiblePlaceName(t.destination));

      if (parsed.trips.length >= 2 && parsed.returnDate) {
        const homeOrigin = parsed.trips[0]?.origin || parsed.origin;
        parsed.trips = _postProcessBookendTrip(parsed.trips, homeOrigin, parsed.departureDate, parsed.returnDate);
      }

      if (parsed.trips.length === 1) {
        const sole        = parsed.trips[0];
        parsed.destination   = sole.destination;
        parsed.origin        = sole.origin || parsed.origin;
        parsed.departureDate = sole.departureDate || parsed.departureDate;
        parsed.returnDate    = sole.returnDate    || parsed.returnDate;
        parsed.nights        = sole.nights        || parsed.nights;
        parsed.trips = null;
      } else if (parsed.trips.length === 0) {
        parsed.trips = null;
      }
    }

    // Final plausibility check on destination
    if (parsed.destination && !_isPlausiblePlaceName(parsed.destination)) {
      logger.warn('Groq returned implausible destination', { returned: parsed.destination?.slice(0, 80) });
      parsed.destination = null;
    }

    if (parsed.destination) parsed.destination = resolveCountryToCity(parsed.destination);
    if (parsed.origin)      parsed.origin      = resolveCountryToCity(parsed.origin);

    if (!parsed.origin) {
      const rule = _parseWithRules(prompt);
      if (rule.origin) { parsed.origin = rule.origin; logger.info('Groq missed origin — filled from rules', { origin: parsed.origin }); }
    }
    if (!parsed.destination && !Array.isArray(parsed.trips)) {
      const rule = _parseWithRules(prompt);
      if (rule.destination) { parsed.destination = rule.destination; logger.info('Groq missed destination — filled from rules', { destination: parsed.destination }); }
    }

    // Property type safety net
    if (parsed.preferredHotel) {
      const pt = _extractPropertyType(parsed.preferredHotel);
      if (pt) {
        logger.info('PromptParser: rescued property type from preferredHotel', { was: parsed.preferredHotel, now: pt });
        parsed.propertyType   = parsed.propertyType || pt;
        parsed.preferredHotel = null;
      }
    }

    // Activity requests: merge Groq output with rule-based extraction
    const { hasSafari, excursions: ruleExcursions } = _extractActivities(prompt);
    const groqActivities = Array.isArray(parsed.activityRequests) ? parsed.activityRequests : [];
    parsed.activityRequests = [...new Set([...groqActivities, ...ruleExcursions])];

    const groqSaidSafari = groqActivities.some(a => a === 'safari' || a === 'game_drive');
    parsed.activityRequests = parsed.activityRequests.filter(a => a !== 'safari' && a !== 'game_drive');

    if (hasSafari || groqSaidSafari) {
      const baseCity = parsed.destination || parsed.origin;
      parsed.safariDestination = parsed.safariDestination || resolveSafariDestination(baseCity);
      logger.info('PromptParser: safari detected', { baseCity, resolvedTo: parsed.safariDestination });
    } else {
      parsed.safariDestination = parsed.safariDestination ?? null;
    }

    // Merge rule-based budgetKES if Groq missed it
    if (!parsed.budgetKES) {
      const rule = _parseWithRules(prompt);
      if (rule.budgetKES) {
        parsed.budgetKES = rule.budgetKES;
        logger.info('PromptParser: budgetKES filled from rules', { budgetKES: parsed.budgetKES });
      }
    }

    parsed.preferredTransportProvider = parsed.preferredTransportProvider ?? null;
    parsed.preferredHotel             = parsed.preferredHotel             ?? null;
    parsed.propertyType               = parsed.propertyType               ?? null;
    parsed.activityRequests           = parsed.activityRequests           ?? [];
    parsed.safariDestination          = parsed.safariDestination          ?? null;
    parsed.legs                       = parsed.legs                       ?? [];
    parsed.isMultiDestination         = parsed.isMultiDestination         ?? false;
    parsed.children                   = parsed.children                   ?? 0;
    parsed.childAges                  = parsed.childAges                  ?? [];
    parsed.budgetKES                  = parsed.budgetKES                  ?? null;
    parsed._parsedBy = 'groq';

    return parsed;

  } catch (err) {
    logger.warn('Groq attempt failed', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────
// MAIN GROQ PARSER — with retry on failure
// ─────────────────────────────────────────────
async function _parseWithGroq(prompt) {
  if (!groqClient) return null;
  const result = await _groqAttempt(prompt, GROQ_SYSTEM_PROMPT);
  if (result) return result;
  logger.info('Groq: retrying with simplified prompt', { prompt: prompt.slice(0, 80) });
  return await _groqAttempt(prompt, GROQ_SYSTEM_PROMPT_SIMPLE);
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────

/**
 * parsePrompt — parse a single user message.
 *
 * @param {string} prompt       — the raw user message
 * @param {object} [session]    — optional previous session params.
 *                                When provided, any field that the
 *                                current parse leaves null/undefined
 *                                will inherit the session value.
 */
async function parsePrompt(prompt, session = null) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) return _parseWithRules('');

  const groqResult = await _parseWithGroq(prompt);
  const raw = groqResult || _parseWithRules(prompt);

  if (!groqResult) {
    logger.info('Falling back to rule-based parser', { prompt: prompt.slice(0, 80) });
  } else {
    if (Array.isArray(groqResult.trips) && groqResult.trips.length > 1) {
      logger.info('Prompt parsed via Groq — multi-trip', {
        tripCount:    groqResult.trips.length,
        destinations: groqResult.trips.map(t => t.destination).join(', '),
      });
    } else {
      logger.info('Prompt parsed via Groq', { destination: groqResult.destination, origin: groqResult.origin });
    }
  }

  // ── Session inheritance ───────────────────────────────────────────────────
  if (session) {
    const INHERITABLE = [
      'destination', 'origin', 'nights', 'passengers', 'children', 'childAges',
      'budget', 'budgetKES', 'departureDate', 'returnDate', 'mealPlan', 'propertyType',
      'safariDestination', 'preferredHotel', 'preferredTransportProvider',
    ];

    for (const key of INHERITABLE) {
      const currentVal = raw[key];
      const sessionVal = session[key];
      const isEmpty = currentVal === null || currentVal === undefined ||
                      (Array.isArray(currentVal) && currentVal.length === 0);
      const hasSession = sessionVal !== null && sessionVal !== undefined &&
                         !(Array.isArray(sessionVal) && sessionVal.length === 0);
      if (isEmpty && hasSession) {
        raw[key] = sessionVal;
        logger.info('PromptParser: inherited from session', { key, value: String(sessionVal).slice(0, 40) });
      }
    }

    // ── Stale returnDate guard ────────────────────────────────────────────
    if (raw.returnDate && raw.departureDate) {
      if (new Date(raw.returnDate) <= new Date(raw.departureDate)) {
        const staleReturn = raw.returnDate;
        if (raw.nights) {
          raw.returnDate = _addDays(raw.departureDate, raw.nights);
          logger.warn('PromptParser: stale returnDate recalculated from departureDate + nights', {
            staleReturn,
            departureDate: raw.departureDate,
            nights: raw.nights,
            newReturn: raw.returnDate,
          });
        } else {
          raw.returnDate = null;
          logger.warn('PromptParser: stale returnDate cleared — predates new departureDate', {
            staleReturn,
            departureDate: raw.departureDate,
          });
        }
      }
    }

    // Destination-specific: if sanitizer cleared a dirty destination
    // but session has a good one, use it.
    if (!raw.destination && session.destination) {
      raw.destination = session.destination;
      logger.info('PromptParser: restored destination from session after sanitization', {
        sessionDestination: session.destination,
      });
    }

    // ── Trip leg normalization from session ───────────────────────────────
    // If Groq returned trips[] but legs are missing origin/dates that exist
    // in the session, propagate session context into each leg and prepend
    // any missing first leg (e.g. Nairobi→Diani when the follow-up only
    // describes Diani→Lamu→Nairobi).
    if (Array.isArray(raw.trips) && raw.trips.length > 0 && raw.departureDate) {
      raw.trips = _normalizeTripLegsFromSession(raw.trips, raw);
    }
    // ─────────────────────────────────────────────────────────────────────
  }

  return raw;
}

module.exports = { parsePrompt, resolveCountryToCity, normalizeDestination, resolveSafariDestination };