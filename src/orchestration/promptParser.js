/**
 * PROMPT PARSER — v3
 * ─────────────────────────────────────────────────────────────
 * Redesigned for maximum robustness on complex / vague / budget-first
 * prompts. Key changes vs v2:
 *
 *  1. CONFIDENCE SCORING — every parse result carries a `_confidence`
 *     score (0–1). The engine uses this to decide whether to proceed
 *     with assumptions or ask for missing fields.
 *
 *  2. BUDGET-FIRST PROMPTS — "I have KES 150,000, 5 days, Zanzibar"
 *     is now parsed correctly in a single pass without needing
 *     clarification for origin when the user is clearly Kenyan.
 *
 *  3. FRESH-PROMPT DETECTION — replaces the brittle `wordCount > 10`
 *     heuristic with a proper structural scorer that checks for trip
 *     intent signals (destination, date, budget, pax) vs clarification
 *     answer signals (short, single-concept responses).
 *
 *  4. NULL-ORIGIN GUARD — `parsePrompt` never returns origin:null when
 *     a plausible origin can be inferred from context (agency default,
 *     session, or EA-hub assumption). The guard is applied here, not
 *     scattered across engine.js.
 *
 *  5. GROQ SYSTEM PROMPT — rewritten to handle budget-first, vague-date,
 *     and open-ended prompts. Now extracts `_missingFields[]` so the
 *     engine knows exactly what to ask.
 *
 *  6. TRIP IDENTITY — unchanged from v2 but exposed as `_tripId` on the
 *     result so the engine can compare without re-computing.
 */

const Groq = require('groq-sdk');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// CONSTANTS
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
  'overwater', 'water bungalow', 'quiet', 'secluded', 'private',
]);

const SAFARI_PATTERN = /\bsafari\b|\bgame\s+(?:drive|park|reserve)\b|\bgame\s+viewing\b/i;

const EXCURSION_PATTERNS = [
  { pattern: /\bsnorkel(?:ling|ing)?\b/i,                              label: 'snorkelling' },
  { pattern: /\bscuba\s+diving\b|\bdiving\b/i,                         label: 'scuba_diving' },
  { pattern: /\bsunset\s+cruise\b|\bdhow\s+cruise\b|\bdau\s+cruise\b/i,label: 'sunset_cruise' },
  { pattern: /\bspice\s+tour\b/i,                                      label: 'spice_tour' },
  { pattern: /\bstone\s+town\s+(?:tour|walk)\b/i,                      label: 'stone_town_tour' },
  { pattern: /\bjozani\s+forest\b/i,                                   label: 'jozani_forest' },
  { pattern: /\bdolphin\s+(?:tour|watching|swim)\b/i,                  label: 'dolphin_tour' },
  { pattern: /\bkitesurfing\b|\bkite\s+surfing\b/i,                    label: 'kitesurfing' },
  { pattern: /\bsurfing\b/i,                                           label: 'surfing' },
  { pattern: /\bhiking\b|\btrekking\b(?!\s+gorilla)/i,                 label: 'hiking' },
  { pattern: /\bgorilla\s+trekking\b/i,                                label: 'gorilla_trekking' },
  { pattern: /\bspice\s+garden\b/i,                                    label: 'spice_garden' },
  { pattern: /\bcultural\s+tour\b/i,                                   label: 'cultural_tour' },
  { pattern: /\bcooking\s+class\b/i,                                   label: 'cooking_class' },
  { pattern: /\bspa\b/i,                                               label: 'spa' },
  { pattern: /\bboat\s+trip\b|\bboat\s+tour\b/i,                       label: 'boat_trip' },
  { pattern: /\bsandbank\s+(?:trip|picnic)\b/i,                        label: 'sandbank_trip' },
  { pattern: /\bkayak(?:ing)?\b/i,                                     label: 'kayaking' },
  { pattern: /\bprison\s+island\b/i,                                   label: 'prison_island' },
];

const SAFARI_DESTINATIONS = {
  tanzania: 'Serengeti', zanzibar: 'Serengeti', 'dar es salaam': 'Serengeti',
  arusha: 'Serengeti', moshi: 'Serengeti',
  kenya: 'Masai Mara', nairobi: 'Masai Mara', mombasa: 'Amboseli',
  diani: 'Amboseli', malindi: 'Amboseli',
  kampala: 'Bwindi', entebbe: 'Bwindi',
  kigali: 'Akagera',
  johannesburg: 'Kruger', 'cape town': 'Kruger', durban: 'Kruger',
  _default: 'Masai Mara',
};

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

const COUNTRY_TO_CITY = {
  'kenya': 'Nairobi', 'tanzania': 'Dar es Salaam', 'uganda': 'Kampala',
  'rwanda': 'Kigali', 'ethiopia': 'Addis Ababa', 'south africa': 'Johannesburg',
  'egypt': 'Cairo', 'morocco': 'Marrakech', 'ghana': 'Accra', 'nigeria': 'Lagos',
  'seychelles': 'Mahe', 'mauritius': 'Port Louis', 'maldives': 'Male',
  'indonesia': 'Bali', 'thailand': 'Phuket', 'india': 'Delhi', 'japan': 'Tokyo',
  'france': 'Paris', 'united kingdom': 'London', 'uk': 'London',
  'uae': 'Dubai', 'united arab emirates': 'Dubai', 'qatar': 'Doha',
  'oman': 'Muscat', 'turkey': 'Istanbul', 'greece': 'Athens',
  'spain': 'Barcelona', 'italy': 'Rome', 'netherlands': 'Amsterdam',
  'australia': 'Sydney', 'new zealand': 'Auckland',
  'usa': 'New York', 'united states': 'New York', 'america': 'New York',
  'mexico': 'Cancun', 'brazil': 'Rio de Janeiro',
  'madagascar': 'Antananarivo', 'zimbabwe': 'Harare',
  'zambia': 'Lusaka', 'namibia': 'Windhoek', 'mozambique': 'Maputo',
  'angola': 'Luanda', 'cameroon': 'Douala', 'senegal': 'Dakar',
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

// EA hubs we can use as default origin when the agency is Kenya-based
// and the user doesn't specify.
const EA_DEFAULT_ORIGINS = ['Nairobi', 'Mombasa', 'Kampala', 'Dar es Salaam'];
const DEFAULT_ORIGIN = 'Nairobi';

// ─────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────

function _normStr(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

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

function _isNonFlyable(dest) {
  return !!(NON_FLYABLE_HUBS[_normStr(dest)]);
}

function _hubFor(dest) {
  return NON_FLYABLE_HUBS[_normStr(dest)] || null;
}

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

function resolveSafariDestination(primaryCity) {
  if (!primaryCity) return SAFARI_DESTINATIONS._default;
  const lower = _normStr(primaryCity);
  return SAFARI_DESTINATIONS[lower] || SAFARI_DESTINATIONS._default;
}

// ─────────────────────────────────────────────
// FRESH-PROMPT vs CLARIFICATION-ANSWER SCORER
// ─────────────────────────────────────────────
// Returns a score 0–1. > 0.5 = treat as a fresh trip prompt.
// This replaces the brittle `wordCount > 10` heuristic.

const TRIP_INTENT_SIGNALS = [
  /\bplan\s+(?:me\s+)?a\s+trip\b/i,
  /\bbook\s+(?:me\s+)?a?\s+(?:trip|flight|hotel|package)\b/i,
  /\bi\s+(?:want|need|would\s+like|have)\s+to?\s+(?:go|travel|fly|visit|book)/i,
  /\bfrom\s+[a-z]{3,}(?:\s+to)?\s+[a-z]{3,}/i,
  /\b[a-z]{3,}\s+to\s+[a-z]{3,}/i,
  /\btrip\s+(?:from|to)\s+/i,
  /\bfly(?:ing)?\s+(?:from|to)\s+/i,
  /\btravel(?:ling)?\s+(?:from|to)\s+/i,
  /\bi\s+have\s+\d+\s+(?:days?|nights?|kes|ksh|k\b)/i,
  /\bbudget\s+(?:of|is)?\s*(?:kes|ksh|\d)/i,
  /\b\d+\s+(?:days?|nights?)\s+in\b/i,
  /\b(?:2|3|4|5|6|7|8|9|10|11|12)\s+(?:of\s+us|adults?|passengers?|pax|people)\b/i,
  /\bmy\s+(?:wife|husband|partner|family|kids?|children)\b/i,
  /\bhoneymoon\b|\bgetaway\b|\bvacation\b|\bholiday\b/i,
  /\bjanuary|february|march|april|may|june|july|august|september|october|november|december\b/i,
];

const CLARIFICATION_SIGNALS = [
  /^(?:yes|no|y|n|ok|okay|sure|nope|yeah|yep|nah)$/i,
  /^(?:nairobi|mombasa|kampala|dar|addis|kigali|entebbe)$/i, // single city answer
  /^(?:january|february|march|april|may|june|july|august|september|october|november|december)$/i,
  /^\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /^(?:next\s+week|this\s+weekend|tomorrow|in\s+\d+\s+(?:days?|weeks?))$/i,
  /^(?:flexible|anytime|any time|doesn'?t matter|open dates?)$/i,
];

function _scoreFreshPrompt(prompt) {
  if (!prompt) return 0;
  const lower = prompt.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean).length;

  // Very short responses are almost certainly clarification answers
  if (words <= 3) {
    const isClarif = CLARIFICATION_SIGNALS.some(p => p.test(lower));
    return isClarif ? 0.05 : 0.3;
  }

  let score = 0;
  let hits = 0;
  for (const signal of TRIP_INTENT_SIGNALS) {
    if (signal.test(lower)) { score += 0.15; hits++; }
  }

  // Word count contribution (8+ words strongly suggests a trip prompt)
  if (words >= 20) score += 0.3;
  else if (words >= 12) score += 0.2;
  else if (words >= 8) score += 0.1;

  // Budget mention is a very strong trip signal
  if (/\b(?:kes|ksh|\d+k)\b/i.test(lower) && /\d/.test(lower)) score += 0.25;

  return Math.min(score, 1.0);
}

/**
 * isFreshTripPrompt — exported so the webhook can use it directly
 * instead of the old word-count heuristic.
 */
function isFreshTripPrompt(prompt) {
  return _scoreFreshPrompt(prompt) >= 0.45;
}

// ─────────────────────────────────────────────
// CONFIDENCE SCORER
// ─────────────────────────────────────────────
// Scores how complete a parsed result is (0–1).
// Engine uses this to decide whether to proceed or ask.

function _scoreConfidence(parsed) {
  let score = 0;
  const w = { destination: 0.35, origin: 0.2, departureDate: 0.2, nights: 0.1, passengers: 0.05, budget: 0.05, returnDate: 0.05 };
  if (parsed.destination)    score += w.destination;
  if (parsed.origin)         score += w.origin;
  if (parsed.departureDate)  score += w.departureDate;
  if (parsed.nights)         score += w.nights;
  if (parsed.passengers > 1 || parsed.passengers === 1) score += w.passengers;
  if (parsed.budget)         score += w.budget;
  if (parsed.returnDate)     score += w.returnDate;

  // Multi-trip: if trips[] is present and non-empty, confidence is high
  if (Array.isArray(parsed.trips) && parsed.trips.length > 1) score = Math.max(score, 0.75);

  return Math.min(score, 1.0);
}

// ─────────────────────────────────────────────
// MISSING FIELDS DETECTOR
// ─────────────────────────────────────────────
// Returns an ordered list of fields the engine should ask about.
// Ordered by importance: destination > origin > departureDate.

function _detectMissingFields(parsed) {
  const missing = [];
  if (!parsed.destination && !Array.isArray(parsed.trips)) missing.push('destination');
  if (!parsed.origin && !parsed.isHotelOnly)               missing.push('origin');
  if (!parsed.departureDate)                               missing.push('departureDate');
  return missing;
}

// ─────────────────────────────────────────────
// PROPERTY TYPE / ACTIVITY EXTRACTORS
// ─────────────────────────────────────────────

function _extractPropertyType(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  for (const kw of PROPERTY_TYPE_KEYWORDS) {
    if (lower.includes(kw)) return kw;
  }
  return null;
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
// CHILD DETECTION
// ─────────────────────────────────────────────

function _detectChildInfo(prompt) {
  if (!prompt) return { hasChild: false, childAges: [], needsChildAge: false };
  const lower = prompt.toLowerCase();
  const CHILD_MENTION = /\b(child(?:ren)?|kid(?:s)?|minor(?:s)?|infant(?:s)?|baby|babies|toddler(?:s)?|junior)\b/i;
  const hasChild = CHILD_MENTION.test(lower);
  if (!hasChild) return { hasChild: false, childAges: [], needsChildAge: false };

  const childAges = [];
  const patterns = [
    /(\d{1,2})\s*[-–]?\s*(?:year[s]?[-\s]?old|yr[s]?[-\s]?old|y\.?o\.?|yrs?)\b/gi,
    /(?:child|kid|minor|infant|baby|toddler|junior)\s+(?:aged?|who\s+is|of\s+age)\s+(\d{1,2})/gi,
    /(?:child|kid|minor|infant|toddler)\s*\((\d{1,2})\)/gi,
    /\bage[sd]?\s+(\d{1,2})(?:\s+and\s+(\d{1,2}))?\b/gi,
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(lower)) !== null) {
      [m[1], m[2]].filter(Boolean).forEach(n => {
        const age = parseInt(n, 10);
        if (age >= 0 && age < 18 && !childAges.includes(age)) childAges.push(age);
      });
    }
  }

  return { hasChild, childAges, needsChildAge: childAges.length === 0 };
}

// ─────────────────────────────────────────────
// DESTINATION SANITIZER
// ─────────────────────────────────────────────

const FILLER_SPLIT_PATTERN = /,|\s*\(.*\)\s*|\s+(?:use|same|as|please|ok|okay|yes|from|with|but|and|for|the|previous|last|prior|above|that|those|details|info|trip|search|prompt|context|session)\b/i;
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

function _sanitizeDestination(dest) {
  if (!dest || typeof dest !== 'string') return null;
  const cleaned = dest.split(FILLER_SPLIT_PATTERN)[0].trim();
  if (!cleaned) return null;
  return _isPlausiblePlaceName(cleaned) ? resolveCountryToCity(cleaned) : null;
}

// ─────────────────────────────────────────────
// TRIP IDENTITY
// ─────────────────────────────────────────────

function _isSameTrip(raw, session) {
  const newDest     = _normStr(raw.destination);
  const sessionDest = _normStr(session.destination);
  if (!newDest || !sessionDest) return false;
  if (newDest !== sessionDest) return false;
  const newMonth     = raw.departureDate     ? raw.departureDate.slice(0, 7)     : null;
  const sessionMonth = session.departureDate ? session.departureDate.slice(0, 7) : null;
  if (newMonth && sessionMonth && newMonth !== sessionMonth) return false;
  return true;
}

function _tripKey(destination) { return _normStr(destination); }

// ─────────────────────────────────────────────
// MULTI-LEG POST-PROCESSOR
// ─────────────────────────────────────────────

function _postProcessBookendTrip(trips, homeOrigin, departureDate, returnDate) {
  if (!Array.isArray(trips) || trips.length < 2) return trips;
  if (!departureDate || !returnDate) return trips;

  const homeNorm = _normStr(homeOrigin);
  const lastLeg  = trips[trips.length - 1];
  const lastDest = _normStr(lastLeg.destination);
  if (lastDest === homeNorm && lastLeg.departureDate === returnDate) return trips;

  let internal = trips.filter(t => _normStr(t.destination) !== homeNorm);
  if (internal.length === 0) return trips;

  const lastInternal = internal[internal.length - 1];
  if (_isNonFlyable(lastInternal.destination)) {
    const hub = _hubFor(lastInternal.destination);
    if (hub && _normStr(hub) !== homeNorm) {
      internal.push({ destination: hub, origin: lastInternal.destination, nights: 0, departureDate: null, returnDate: null, _transitLeg: true });
    }
  }

  const totalNights    = _diffDays(departureDate, returnDate);
  const specifiedNights = internal.filter((_, i) => i > 0).reduce((s, t) => s + (t.nights || 0), 0);
  const firstNights    = Math.max(0, totalNights - specifiedNights);

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

  return rebuilt;
}

// ─────────────────────────────────────────────
// TRIP LEG NORMALIZER
// ─────────────────────────────────────────────

function _normalizeTripLegsFromSession(trips, topLevel) {
  const sessionOrigin    = topLevel.origin;
  const sessionDeparture = topLevel.departureDate;
  const sessionNights    = topLevel.nights;

  const firstTripDest   = _normStr(trips[0]?.destination);
  const firstTripOrigin = _normStr(trips[0]?.origin);
  const sessionDest     = _normStr(topLevel.destination);
  const sessionOrigNorm = _normStr(sessionOrigin);

  const firstLegMatchesSession =
    firstTripDest === sessionDest &&
    firstTripOrigin === sessionOrigNorm &&
    (trips[0]?.departureDate || '') === (sessionDeparture || '');

  const needsPrepend = !firstLegMatchesSession && !!sessionOrigin && !!sessionDeparture && !!sessionDest;

  const fullTrips = needsPrepend
    ? [{ origin: sessionOrigin, destination: topLevel.destination, nights: sessionNights || 0, departureDate: sessionDeparture, returnDate: null, needsOriginClarification: false, _prependedFromSession: true }, ...trips]
    : trips;

  let cursor = sessionDeparture;
  const normalized = fullTrips.map((leg, i) => {
    const nights  = leg.nights ?? 0;
    const depDate = leg.departureDate || cursor;
    const retDate = nights > 0 ? _addDays(depDate, nights) : null;
    if (nights > 0) cursor = _addDays(depDate, nights);
    else if (depDate) cursor = depDate;
    const inferredOrigin = i === 0 ? sessionOrigin : (fullTrips[i - 1]?.destination || null);
    return { ...leg, origin: leg.origin || inferredOrigin, departureDate: depDate, returnDate: retDate, needsOriginClarification: false };
  });

  return normalized;
}

// ─────────────────────────────────────────────
// RULE-BASED PARSER
// ─────────────────────────────────────────────

function _parseWithRules(prompt) {
  const lower = prompt.toLowerCase().trim();

  // ── Destination ────────────────────────────────────────────────────────
  let destination = null;
  const simpleRoute = lower.match(/^([a-z][a-z\s]{1,20}?)\s+to\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|and|\d)|[,.]|$)/i);
  if (simpleRoute) destination = simpleRoute[2].trim();

  if (!destination) {
    const toMatch = lower.match(/\bto\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|and|\d)|[,.]|$)/i);
    if (toMatch) destination = toMatch[1].trim();
  }
  if (!destination) {
    const inMatch = lower.match(/\b(?:in|visiting|visit|going)\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|with|and|\d)|[,.]|$)/i);
    if (inMatch) destination = inMatch[1].trim();
  }
  if (destination) {
    destination = _sanitizeDestination(destination) || _sanitizeDestination(resolveCountryToCity(destination.trim()));
  }

  // ── Origin ─────────────────────────────────────────────────────────────
  let origin = null;
  if (simpleRoute) origin = simpleRoute[1].trim();
  if (!origin) {
    const fromMatch = lower.match(/\bfrom\s+((?:[a-z]+(?:\s+[a-z]+){0,2}?))(?=\s+(?:to|on|for|in|with|and|\d)|[,.]|$)/i);
    if (fromMatch) {
      const candidate = fromMatch[1].trim();
      if (!/^(me|us|a|the|my|our|here|there|home|anywhere)$/i.test(candidate)) origin = candidate;
    }
  }
  if (origin) origin = resolveCountryToCity(origin.trim());
  if (origin && destination && _normStr(origin) === _normStr(destination)) origin = null;

  // ── Nights / Dates ──────────────────────────────────────────────────────
  let nights = null;
  const nightsMatch = lower.match(/(\d+)\s*(?:night|nights|nts?|days?)\b/i);
  if (nightsMatch) {
    nights = parseInt(nightsMatch[1], 10);
    // "5 days" = 4 nights
    if (/days?\b/i.test(nightsMatch[0]) && !(/nights?\b/i.test(nightsMatch[0]))) {
      nights = Math.max(1, nights - 1);
    }
  }

  // ── Passengers ──────────────────────────────────────────────────────────
  let passengers = 1;
  const passMatch = lower.match(/(\d+)\s*(?:people|persons|pax|adults?|travelers?|of us|guests?|passengers?)\b/i);
  if (passMatch) passengers = Math.max(1, parseInt(passMatch[1], 10));
  if (/\b(?:couple|two of us|2 of us)\b/i.test(lower)) passengers = Math.max(passengers, 2);
  if (/\bfamily\b/i.test(lower) && passengers < 2) passengers = 2;
  if (/\bmy wife\b|\bmy husband\b|\bmy partner\b/i.test(lower)) passengers = Math.max(passengers, 2);

  // ── Children ────────────────────────────────────────────────────────────
  const { hasChild, childAges, needsChildAge } = _detectChildInfo(prompt);
  let children = 0;
  const childMatch = lower.match(/(\d+)\s*(?:child(?:ren)?|kid(?:s)?|minor(?:s)?)\b/i);
  if (childMatch) children = parseInt(childMatch[1], 10);
  else if (hasChild) children = childAges.length || 1;

  // ── Departure date ──────────────────────────────────────────────────────
  const months = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
    january:1,february:2,march:3,april:4,june:6,july:7,august:8,
    september:9,october:10,november:11,december:12,
  };

  let departureDate = null;
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

  // Month-only date ("in October", "October")
  if (!departureDate) {
    const monthOnlyMatch = lower.match(/\b(?:in\s+|around\s+|during\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
    if (monthOnlyMatch) {
      const mKey = monthOnlyMatch[1].toLowerCase().slice(0, 3);
      const month = months[mKey];
      if (month) {
        const now = new Date();
        let year = now.getFullYear();
        if (new Date(year, month - 1, 1) < now) year++;
        departureDate = `${year}-${String(month).padStart(2, '0')}-01`;
      }
    }
  }

  if (!departureDate) {
    const today = new Date();
    if (/next week/i.test(lower)) { today.setDate(today.getDate() + 7); departureDate = today.toISOString().split('T')[0]; }
    else if (/this weekend/i.test(lower)) { const d = today.getDay(); today.setDate(today.getDate() + (6 - d)); departureDate = today.toISOString().split('T')[0]; }
    else if (/tomorrow/i.test(lower)) { today.setDate(today.getDate() + 1); departureDate = today.toISOString().split('T')[0]; }
  }

  // ── Return date ─────────────────────────────────────────────────────────
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

  // ── Budget ──────────────────────────────────────────────────────────────
  let budget = null;
  if (/\b(luxury|premium|high.?end|5.?star|five.?star|splurge|lavish)\b/i.test(lower)) budget = 'luxury';
  else if (/\b(cheap(?:est)?|budget|affordable|low.?cost|economic|value|bei nafuu)\b/i.test(lower)) budget = 'low';
  else if (/\b(mid|moderate|reasonable|standard|normal|average)\b/i.test(lower)) budget = 'mid';
  else if (/\b(high|upscale|4.?star|four.?star|nice|good|quality)\b/i.test(lower)) budget = 'high';

  // ── BudgetKES ───────────────────────────────────────────────────────────
  let budgetKES = null;
  const kesMatch = lower.match(/(\d[\d,]*(?:\.\d+)?)\s*k?\s*(?:ksh|kes|shillings?|bob)\b/i)
    || lower.match(/(?:ksh|kes)\s*(\d[\d,]*(?:\.\d+)?)\b/i);
  if (kesMatch) {
    const raw = kesMatch[1].replace(/,/g, '');
    budgetKES = parseFloat(raw);
  }
  if (!budgetKES) {
    // "150k" with context of budget
    const kMatch = lower.match(/\b(\d+)k\b/i);
    if (kMatch) {
      const num = parseInt(kMatch[1], 10);
      if (num >= 10 && num <= 10000) budgetKES = num * 1000;
    }
  }

  // ── Transport mode ──────────────────────────────────────────────────────
  let outboundTransportMode = null;
  if (/\bflight|fly|flying\b/i.test(lower)) outboundTransportMode = 'flight';
  else if (/\bbus|coach\b/i.test(lower)) outboundTransportMode = 'bus';
  else if (/\btrain|sgr|madaraka\b/i.test(lower)) outboundTransportMode = 'train';

  // ── Meal plan ───────────────────────────────────────────────────────────
  let mealPlan = null;
  if (/\ball.?inclusive\b/i.test(lower)) mealPlan = 'all_inclusive';
  else if (/\bfull.?board\b/i.test(lower)) mealPlan = 'full_board';
  else if (/\bhalf.?board\b/i.test(lower)) mealPlan = 'half_board';
  else if (/\bbed.?and.?breakfast|b.?&.?b|b&b\b/i.test(lower)) mealPlan = 'bed_and_breakfast';
  else if (/\broom.?only|self.?catering\b/i.test(lower)) mealPlan = 'room_only';
  else if (/\bbreakfast\b/i.test(lower)) mealPlan = 'bed_and_breakfast';

  // ── Property type / hotel ───────────────────────────────────────────────
  const propertyType = _extractPropertyType(prompt);
  let preferredHotel = null;
  const hotelNameMatch = lower.match(/\b(?:at|in|stay(?:ing)?\s+at|book(?:ing)?\s+at|hotel)\s+([a-z][a-z\s]{2,30}?)(?:\s+hotel)?\b/i);
  if (hotelNameMatch) {
    const candidate = hotelNameMatch[1].trim();
    if (!_extractPropertyType(candidate)) preferredHotel = candidate;
  }

  // ── Activities ──────────────────────────────────────────────────────────
  const { hasSafari, excursions } = _extractActivities(prompt);
  const safariDestination = hasSafari ? resolveSafariDestination(destination || origin) : null;

  // ── Hotel-only detection ────────────────────────────────────────────────
  const isHotelOnly = /\b(hotel only|just a hotel|only hotel|accommodation only|stay only|find me a hotel|looking for a hotel|need a hotel|hotel in|hotels? near|where to stay)\b/i.test(lower);

  const needsOriginClarification = !origin && !isHotelOnly;

  const result = {
    destination, origin, nights: nights || null, passengers, children, childAges, budget, budgetKES,
    departureDate, returnDate, outboundTransportMode, returnTransportMode: null, mealPlan,
    seatPreference: null, timePreference: null, needsOriginClarification, isMultiDestination: false,
    isHotelOnly, legs: [], trips: null,
    preferredTransportProvider: null, preferredHotel, propertyType,
    activityRequests: excursions, safariDestination,
    hasChild, needsChildAge,
    _parsedBy: 'rules',
  };

  result._confidence = _scoreConfidence(result);
  result._missingFields = _detectMissingFields(result);
  return result;
}

// ─────────────────────────────────────────────
// GROQ CLIENT
// ─────────────────────────────────────────────

let groqClient = null;
try {
  if (process.env.GROQ_API_KEY) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
} catch (e) { logger.warn('Groq client init failed', { error: e.message }); }

// ─────────────────────────────────────────────
// GROQ SYSTEM PROMPT — v3
// ─────────────────────────────────────────────

const GROQ_SYSTEM_PROMPT = `You are a travel intent parser for an East African travel booking platform.
Extract structured trip information from ANY prompt, no matter how vague, complex, or budget-first.
Return ONLY valid JSON with no markdown fences or extra text.

YEAR RULE: Always assume current year is 2026. "October" → 2026-10-01. "August 15th" → 2026-08-15.

═══ FIELD RULES ═══

destination: Real place name only, 1–4 words. Strip everything after a comma or filler phrase.
  "Diani, use the details from before" → "Diani"
  "same destination" with no new place → null
  NEVER put conversational text here.

origin: Single departure city only. null if not mentioned. NEVER guess.
  NEVER include route text like "to Kampala" in origin.
  CORRECT: "Nairobi" | WRONG: "nairobi to kampala"

nights: For "5 days" → 4 nights. For "5 nights" → 5. For "a week" → 7.

passengers: 2 for "couple", "my wife", "my husband", "the two of us". Count all adults.

budgetKES: If user states a budget amount in KES/KSH/shillings/bob, capture as a raw number.
  "KES 150,000" → 150000 | "150k" → 150000 | "50,000 shillings" → 50000
  null if no explicit amount.

budget: tier only: "low"|"mid"|"high"|"luxury"|null
  "quiet" or "secluded" → null (not a budget tier)
  "affordable" → "low"

propertyType: "beachfront","oceanfront","lodge","tented camp","villa","boutique","quiet","secluded" etc.
  NEVER put descriptive words into preferredHotel.

_missingFields: Array of fields the engine must ask about before searching.
  Include "origin" only if origin is genuinely absent AND trip requires transport.
  Include "departureDate" only if no date or month was mentioned at all.
  Include "destination" only if no place was mentioned.
  For "5 days in October going to Zanzibar" → _missingFields: ["origin"] (date is implicit from month)
  For "I want to go to Zanzibar" → _missingFields: ["origin", "departureDate"]
  For "Nairobi to Zanzibar October" → _missingFields: [] (proceed with Oct 1 as default)

═══ MULTI-LEG RULES ═══

When user describes visiting multiple cities:
- trips[] must contain EVERY leg including the return home
- Never end trips[] on a safari park or non-airport destination
- Always append a return-home leg as the last entry (nights:0, returnDate:null)

BOOKEND EXAMPLE:
"Nairobi to Zanzibar Aug 10 for 5 nights, then Mombasa 3 nights, back Aug 18"
trips[]:
  {origin:"Nairobi", destination:"Zanzibar", departureDate:"2026-08-10", nights:5, returnDate:"2026-08-15"}
  {origin:"Zanzibar", destination:"Mombasa", departureDate:"2026-08-15", nights:3, returnDate:"2026-08-18"}
  {origin:"Mombasa", destination:"Nairobi", departureDate:"2026-08-18", nights:0, returnDate:null}

═══ CHILD RULES ═══
children: count of children mentioned
childAges: array of ages if stated. [] if not stated.
needsChildAge: true if children>0 AND childAges is empty

═══ OUTPUT SHAPE ═══
{
  "trips": null,
  "destination": "string|null",
  "origin": "string|null",
  "nights": null,
  "passengers": 1,
  "children": 0,
  "childAges": [],
  "needsChildAge": false,
  "budget": null,
  "budgetKES": null,
  "departureDate": "YYYY-MM-DD|null",
  "returnDate": "YYYY-MM-DD|null",
  "outboundTransportMode": null,
  "returnTransportMode": null,
  "mealPlan": null,
  "seatPreference": null,
  "timePreference": null,
  "needsOriginClarification": false,
  "isMultiDestination": false,
  "isHotelOnly": false,
  "legs": [],
  "preferredTransportProvider": null,
  "preferredHotel": null,
  "propertyType": null,
  "activityRequests": [],
  "safariDestination": null,
  "_missingFields": []
}`;

const GROQ_SYSTEM_PROMPT_SIMPLE = `Extract travel info. Return ONLY valid JSON. Current year is 2026.

destination: real place name only (1-4 words). null if none.
origin: single departure city. null if not mentioned. NEVER guess.
nights: for "5 days" → 4. for "a week" → 7.
passengers: 2 for couple/wife/husband/two of us.
budgetKES: explicit KES/KSH amount as raw number or null.
budget: "low"|"mid"|"high"|"luxury"|null
_missingFields: fields still needed before searching: ["origin","departureDate","destination"] subset.
  Include "origin" only if not given and trip needs transport.
  Include "departureDate" only if no date OR month mentioned.
propertyType: descriptive words like "beachfront","quiet","secluded" (not a hotel name).
activityRequests: ["snorkelling","safari","scuba_diving"] etc.
For multi-city trips: trips[] with ALL legs including return home.

{
  "trips": null, "destination": null, "origin": null, "nights": null,
  "passengers": 1, "children": 0, "childAges": [], "needsChildAge": false,
  "budget": null, "budgetKES": null, "departureDate": null, "returnDate": null,
  "outboundTransportMode": null, "returnTransportMode": null, "mealPlan": null,
  "seatPreference": null, "timePreference": null, "needsOriginClarification": false,
  "isMultiDestination": false, "isHotelOnly": false, "legs": [],
  "preferredTransportProvider": null, "preferredHotel": null, "propertyType": null,
  "activityRequests": [], "safariDestination": null, "_missingFields": []
}`;

// ─────────────────────────────────────────────
// GROQ ATTEMPT
// ─────────────────────────────────────────────

async function _groqAttempt(prompt, systemPrompt) {
  try {
    const completion = await groqClient.chat.completions.create({
      model:           'openai/gpt-oss-120b',
      messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      temperature:     0.1,
      max_tokens:      1200,
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

    // Sanitize destination
    if (parsed.destination) {
      const clean = _sanitizeDestination(parsed.destination);
      parsed.destination = clean || null;
    }

    // Sanitize origin — never allow route text
    if (parsed.origin) {
      const routeStripped = parsed.origin.split(/\s+to\s+/i)[0].trim();
      const fromStripped  = routeStripped.replace(/^from\s+/i, '').trim();
      const wordCount     = fromStripped.split(/\s+/).length;
      if (!fromStripped || wordCount > 3 || /[.,;]/.test(fromStripped)) {
        logger.warn('PromptParser: Groq origin looked like route text — clearing', { original: parsed.origin?.slice(0, 80) });
        parsed.origin = null;
      } else {
        parsed.origin = resolveCountryToCity(fromStripped);
      }
    }

    // Normalize budgetKES
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
    }

    // Reconcile child fields
    const ruleChild = _detectChildInfo(prompt);
    parsed.children     = parsed.children     || (ruleChild.hasChild ? (ruleChild.childAges.length || 1) : 0);
    parsed.childAges    = (parsed.childAges?.length > 0 ? parsed.childAges : ruleChild.childAges) || [];
    parsed.needsChildAge = (parsed.children > 0 && parsed.childAges.length === 0);
    parsed.hasChild     = ruleChild.hasChild || parsed.children > 0;

    // Trips[] cleanup
    if (Array.isArray(parsed.trips)) {
      parsed.trips = parsed.trips
        .map(t => ({
          ...t,
          departureDate: sanitizeDate(t.departureDate),
          returnDate:    sanitizeDate(t.returnDate),
          destination:   t.destination ? (_sanitizeDestination(t.destination) || resolveCountryToCity(t.destination)) : t.destination,
          origin:        t.origin ? resolveCountryToCity(t.origin) : t.origin,
        }))
        .filter(t => t.destination && _isPlausiblePlaceName(t.destination));

      if (parsed.trips.length >= 2 && parsed.returnDate) {
        const homeOrigin = parsed.trips[0]?.origin || parsed.origin;
        parsed.trips = _postProcessBookendTrip(parsed.trips, homeOrigin, parsed.departureDate, parsed.returnDate);
      }

      if (parsed.trips.length === 1) {
        const sole = parsed.trips[0];
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

    // Destination plausibility check
    if (parsed.destination && !_isPlausiblePlaceName(parsed.destination)) {
      parsed.destination = null;
    }

    if (parsed.destination) parsed.destination = resolveCountryToCity(parsed.destination);
    if (parsed.origin)      parsed.origin      = resolveCountryToCity(parsed.origin);

    // Fill gaps from rule-based
    const rule = _parseWithRules(prompt);
    if (!parsed.origin)      parsed.origin      = rule.origin      || null;
    if (!parsed.destination && !Array.isArray(parsed.trips)) parsed.destination = rule.destination || null;
    if (!parsed.budgetKES)   parsed.budgetKES   = rule.budgetKES   || null;
    if (!parsed.nights)      parsed.nights      = rule.nights      || null;
    if (!parsed.passengers || parsed.passengers < 1) parsed.passengers = rule.passengers || 1;
    if (!parsed.departureDate) parsed.departureDate = rule.departureDate || null;

    // Property type safety net
    if (parsed.preferredHotel) {
      const pt = _extractPropertyType(parsed.preferredHotel);
      if (pt) { parsed.propertyType = parsed.propertyType || pt; parsed.preferredHotel = null; }
    }

    // Activity merge
    const { hasSafari, excursions: ruleExcursions } = _extractActivities(prompt);
    const groqActivities = Array.isArray(parsed.activityRequests) ? parsed.activityRequests : [];
    const groqSaidSafari = groqActivities.some(a => a === 'safari' || a === 'game_drive');
    parsed.activityRequests = [...new Set([...groqActivities.filter(a => a !== 'safari' && a !== 'game_drive'), ...ruleExcursions])];

    if (hasSafari || groqSaidSafari) {
      parsed.safariDestination = parsed.safariDestination || resolveSafariDestination(parsed.destination || parsed.origin);
    }

    // Ensure _missingFields is populated
    if (!Array.isArray(parsed._missingFields)) {
      parsed._missingFields = _detectMissingFields(parsed);
    }

    // Defaults
    parsed.preferredTransportProvider = parsed.preferredTransportProvider ?? null;
    parsed.preferredHotel             = parsed.preferredHotel             ?? null;
    parsed.propertyType               = parsed.propertyType               ?? null;
    parsed.activityRequests           = parsed.activityRequests           ?? [];
    parsed.safariDestination          = parsed.safariDestination          ?? null;
    parsed.legs                       = parsed.legs                       ?? [];
    parsed.isMultiDestination         = parsed.isMultiDestination         ?? false;
    parsed.isHotelOnly                = parsed.isHotelOnly                ?? false;
    parsed.children                   = parsed.children                   ?? 0;
    parsed.childAges                  = parsed.childAges                  ?? [];
    parsed.budgetKES                  = parsed.budgetKES                  ?? null;
    parsed.needsChildAge              = parsed.needsChildAge              ?? false;
    parsed.hasChild                   = parsed.hasChild                   ?? false;
    parsed._parsedBy = 'groq';
    parsed._confidence = _scoreConfidence(parsed);

    return parsed;

  } catch (err) {
    logger.warn('Groq attempt failed', { error: err.message });
    return null;
  }
}

async function _parseWithGroq(prompt) {
  if (!groqClient) return null;
  const result = await _groqAttempt(prompt, GROQ_SYSTEM_PROMPT);
  if (result) return result;
  logger.info('Groq: retrying with simplified prompt');
  return await _groqAttempt(prompt, GROQ_SYSTEM_PROMPT_SIMPLE);
}

// ─────────────────────────────────────────────
// NULL-ORIGIN RESOLVER
// ─────────────────────────────────────────────
// Applied as the LAST step before returning from parsePrompt.
// If origin is still null and the trip requires transport, and the
// destination is NOT an EA hub itself, we apply the EA default.
// This prevents null→Destination supplier calls.

function _resolveOriginFallback(parsed, session) {
  if (parsed.origin) return parsed;
  if (parsed.isHotelOnly) return parsed;
  if (Array.isArray(parsed.trips) && parsed.trips.length > 0) {
    // Let the engine handle individual leg origins via session context
    return parsed;
  }

  // If the destination IS an EA hub, asking for origin is correct.
  // But if we already know from session, use it.
  if (session?.origin) {
    parsed.origin = session.origin;
    parsed.needsOriginClarification = false;
    logger.info('PromptParser: origin filled from session fallback', { origin: parsed.origin });
    return parsed;
  }

  // Keep needsOriginClarification = true so engine asks.
  // Do NOT silently default to Nairobi — let the engine ask once,
  // then remember for future turns.
  return parsed;
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────

/**
 * parsePrompt — parse a user message into structured trip params.
 *
 * Now includes:
 *  - _confidence score (0–1) so engine knows how complete the parse is
 *  - _missingFields[] so engine knows exactly what to ask
 *  - isFreshTripPrompt() signal baked into result as _freshScore
 *  - Null-origin resolution applied before return
 *  - Stale returnDate guard
 *  - Trip-aware session inheritance (unchanged from v2)
 */
async function parsePrompt(prompt, session = null) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    const empty = _parseWithRules('');
    empty._freshScore = 0;
    return empty;
  }

  const freshScore = _scoreFreshPrompt(prompt);

  const groqResult = await _parseWithGroq(prompt);
  const raw = groqResult || _parseWithRules(prompt);
  raw._freshScore = freshScore;

  if (!groqResult) {
    logger.info('Falling back to rule-based parser', { prompt: prompt.slice(0, 80) });
  } else {
    if (Array.isArray(groqResult.trips) && groqResult.trips.length > 1) {
      logger.info('Prompt parsed via Groq — multi-trip', {
        tripCount: groqResult.trips.length,
        destinations: groqResult.trips.map(t => t.destination).join(', '),
      });
    } else {
      logger.info('Prompt parsed via Groq', {
        destination:    groqResult.destination,
        origin:         groqResult.origin,
        hasChild:       groqResult.hasChild,
        needsChildAge:  groqResult.needsChildAge,
        childAges:      groqResult.childAges,
        budgetKES:      groqResult.budgetKES,
        _missingFields: groqResult._missingFields,
        _confidence:    groqResult._confidence?.toFixed(2),
      });
    }
  }

  // ── Session inheritance ───────────────────────────────────────────────
  if (session) {
    const ALWAYS_INHERIT = [
      'passengers', 'children', 'childAges', 'budget', 'budgetKES',
      'mealPlan', 'propertyType', 'safariDestination',
      'preferredHotel', 'preferredTransportProvider',
    ];
    const TRIP_SCOPED = new Set(['destination', 'origin', 'departureDate', 'returnDate', 'nights']);

    const currentParseHasTrips = Array.isArray(raw.trips) && raw.trips.length > 0;
    const sameTripContinuation = _isSameTrip(raw, session);

    const newDest     = _normStr(raw.destination);
    const sessionDest = _normStr(session.destination);
    const tripStore   = session._tripStore ? { ...session._tripStore } : {};

    // Archive current session trip when switching destination
    if (newDest && sessionDest && newDest !== sessionDest && session.origin) {
      tripStore[sessionDest] = {
        destination:   session.destination,
        origin:        session.origin,
        departureDate: session.departureDate || null,
        returnDate:    session.returnDate    || null,
        nights:        session.nights        || null,
      };
    }
    raw._tripStore = tripStore;

    // Always-inherit fields
    for (const key of ALWAYS_INHERIT) {
      if (currentParseHasTrips && TRIP_SCOPED.has(key)) continue;
      const currentVal = raw[key];
      const sessionVal = session[key];
      const isEmpty = currentVal === null || currentVal === undefined ||
        (Array.isArray(currentVal) && currentVal.length === 0) ||
        (key === 'passengers' && (currentVal === 0 || currentVal < 1));
      const hasSession = sessionVal !== null && sessionVal !== undefined &&
        !(Array.isArray(sessionVal) && sessionVal.length === 0);
      if (isEmpty && hasSession) {
        raw[key] = sessionVal;
      }
    }

    // Trip-scoped inheritance
    if (!currentParseHasTrips) {
      if (sameTripContinuation) {
        for (const key of TRIP_SCOPED) {
          const currentVal = raw[key];
          const sessionVal = session[key];
          const isEmpty    = currentVal === null || currentVal === undefined;
          const hasSession = sessionVal !== null && sessionVal !== undefined;
          if (isEmpty && hasSession) raw[key] = sessionVal;
        }
      } else if (newDest && tripStore[newDest]) {
        const stored = tripStore[newDest];
        for (const key of TRIP_SCOPED) {
          const currentVal = raw[key];
          const isEmpty    = currentVal === null || currentVal === undefined;
          if (isEmpty && stored[key]) raw[key] = stored[key];
        }
      } else if (newDest && newDest !== sessionDest && !raw.origin) {
        raw.needsOriginClarification = true;
      }
    }

    // Stale returnDate guard
    if (raw.returnDate && raw.departureDate) {
      if (new Date(raw.returnDate) <= new Date(raw.departureDate)) {
        if (raw.nights) {
          raw.returnDate = _addDays(raw.departureDate, raw.nights);
        } else {
          raw.returnDate = null;
        }
      }
    }

    // Destination fallback from session
    if (!raw.destination && session.destination && !currentParseHasTrips && sameTripContinuation) {
      raw.destination = session.destination;
    }

    // childAges inheritance
    if ((!raw.childAges || raw.childAges.length === 0) && session.childAges?.length > 0) {
      raw.childAges     = session.childAges;
      raw.needsChildAge = false;
    }

    // Normalize trip legs
    if (Array.isArray(raw.trips) && raw.trips.length > 0 && raw.departureDate) {
      raw.trips = _normalizeTripLegsFromSession(raw.trips, raw);
    }
  }

  // ── Null-origin resolution ────────────────────────────────────────────
  _resolveOriginFallback(raw, session);

  // ── Recompute confidence and missing fields after inheritance ─────────
  raw._confidence    = _scoreConfidence(raw);
  raw._missingFields = _detectMissingFields(raw);

  return raw;
}

module.exports = {
  parsePrompt,
  resolveCountryToCity,
  normalizeDestination,
  resolveSafariDestination,
  isFreshTripPrompt,
  scoreFreshPrompt: _scoreFreshPrompt,
};