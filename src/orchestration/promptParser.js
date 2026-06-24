/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Converts natural language traveler prompts into structured
 * trip parameters the orchestration engine can work with.
 *
 * Supports: Multi-modal legs (e.g., bus going, flight returning),
 * English, Swahili, shorthand, vague requests,
 * accessibility needs, meal plans, seat preferences, fuzzy/typo
 * tolerant city matching, explicit origin-clarification when
 * the traveler doesn't state where they're departing from, and
 * multi-destination itineraries (e.g. "5 days Maasai Mara then
 * 4 days Mombasa").
 *
 * NOTE on CITY_CODES: this map is only for places that ARE
 * themselves airports/cities (Nairobi, Mombasa, Zanzibar, London,
 * Dubai, etc.) — used purely to detect bus-route eligibility and
 * give a quick code hint. Destinations that are NOT airports
 * (Maasai Mara, Amboseli, Kilifi, Watamu, Diani, Naivasha, etc.)
 * are intentionally NOT in this map. Those are resolved via
 * destinationIntel.js, which knows the real per-mode access
 * pattern (e.g. Maasai Mara requires a charter/airstrip, Kilifi
 * is reached via Mombasa + transfer) — conflating "destination"
 * with "airport" for those was the original architectural bug.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

const CITY_CODES = {
  // EAST AFRICA
  'nairobi': 'NBO', 'nbo': 'NBO', 'nai': 'NBO',
  'mombasa': 'MBA', 'mba': 'MBA',
  'zanzibar': 'ZNZ', 'znz': 'ZNZ', 'zan': 'ZNZ',
  'dar es salaam': 'DAR', 'dar': 'DAR', 'dar es': 'DAR',
  'kigali': 'KGL', 'kgl': 'KGL',
  'kampala': 'EBB', 'entebbe': 'EBB',
  'addis ababa': 'ADD', 'addis': 'ADD', 'add': 'ADD',
  'arusha': 'ARK',

  // WEST AFRICA
  'lagos': 'LOS', 'los': 'LOS',
  'accra': 'ACC', 'acc': 'ACC',
  'dakar': 'DKR',
  'abidjan': 'ABJ',
  'douala': 'DLA',

  // SOUTHERN AFRICA
  'johannesburg': 'JNB', 'jnb': 'JNB', 'joburg': 'JNB', 'jozi': 'JNB', 'jhb': 'JNB',
  'cape town': 'CPT', 'cpt': 'CPT', 'capetown': 'CPT', 'cape': 'CPT',
  'victoria falls': 'VFA', 'vic falls': 'VFA',
  'livingstone': 'LVI',
  'lusaka': 'LUN',
  'harare': 'HRE',
  'durban': 'DUR',

  // NORTH AFRICA
  'cairo': 'CAI', 'cai': 'CAI',
  'casablanca': 'CMN', 'cmn': 'CMN', 'casa': 'CMN',
  'marrakech': 'RAK', 'marrakesh': 'RAK',
  'tunis': 'TUN',
  'sharm el sheikh': 'SSH', 'sharm': 'SSH',
  'hurghada': 'HRG',

  // MIDDLE EAST
  'dubai': 'DXB', 'dxb': 'DXB',
  'abu dhabi': 'AUH',
  'doha': 'DOH',
  'riyadh': 'RUH',
  'muscat': 'MCT',
  'istanbul': 'IST',

  // ASIA
  'bangkok': 'BKK', 'bkk': 'BKK',
  'bali': 'DPS', 'denpasar': 'DPS',
  'tokyo': 'NRT', 'nrt': 'NRT',
  'singapore': 'SIN', 'sin': 'SIN',
  'mumbai': 'BOM', 'bombay': 'BOM',
  'delhi': 'DEL', 'new delhi': 'DEL',
  'kuala lumpur': 'KUL', 'kl': 'KUL',
  'seoul': 'ICN',
  'beijing': 'PEK',
  'shanghai': 'PVG',
  'hong kong': 'HKG',
  'chiang mai': 'CNX',
  'phuket': 'HKT',

  // EUROPE
  'london': 'LHR', 'lhr': 'LHR',
  'paris': 'CDG', 'cdg': 'CDG',
  'amsterdam': 'AMS', 'ams': 'AMS',
  'barcelona': 'BCN', 'bcn': 'BCN',
  'madrid': 'MAD',
  'rome': 'FCO',
  'milan': 'MXP',
  'frankfurt': 'FRA',
  'zurich': 'ZRH',
  'vienna': 'VIE',
  'brussels': 'BRU',
  'lisbon': 'LIS',
  'athens': 'ATH',
  'prague': 'PRG',

  // AMERICAS
  'new york': 'JFK', 'nyc': 'JFK', 'jfk': 'JFK',
  'miami': 'MIA', 'mia': 'MIA',
  'los angeles': 'LAX', 'lax': 'LAX',
  'toronto': 'YYZ',
  'cancun': 'CUN',
  'mexico city': 'MEX',
  'sao paulo': 'GRU',
  'buenos aires': 'EZE',
  'bogota': 'BOG',
};

// Destinations that are NOT airports themselves — used only by the
// rules-based multi-destination fallback to recognize leg names
// when Gemini is unavailable. Resolution of HOW to actually reach
// them is destinationIntel.js's job, not this list's.
const KNOWN_NON_AIRPORT_DESTINATIONS = [
  'maasai mara', 'masai mara', 'mara',
  'amboseli', 'ol pejeta', 'samburu', 'tsavo', 'lake nakuru',
  'naivasha', 'lake naivasha', 'lake victoria', 'jinja',
  'kilifi', 'watamu', 'diani', 'diani beach', 'lamu',
  'serengeti', 'ngorongoro',
];

const SWAHILI_DESTINATIONS = {
  'pwani': 'mombasa',
  'bahari': 'mombasa',
  'mlima': 'nairobi',
  'jiji': 'nairobi',
  'visiwa': 'zanzibar',
  'misitu': 'masai mara',
  'msitu': 'masai mara',
};

const BUS_ROUTES = [
  ['NBO', 'MBA'],
  ['NBO', 'KGL'],
  ['NBO', 'EBB'],
];

const ACCESSIBILITY_KEYWORDS = [
  'wheelchair', 'wheel chair', 'disabled', 'disability',
  'accessible', 'accessibility', 'mobility', 'mobility impaired',
  'handicapped', 'special needs', 'physically challenged',
  'crutches', 'walking aid', 'walker', 'blind', 'visually impaired',
  'deaf', 'hearing impaired', 'elderly', 'senior citizen',
  'ramp', 'elevator access', 'lift access', 'ground floor',
  'kiti cha magurudumu',
  'ulemavu',
  'mzee',
];

const BUS_SEAT_POSITIONS = {
  window: { preference: 'window', columns: ['A', 'D'], note: 'Window seat requested' },
  aisle:  { preference: 'aisle', columns: ['B', 'C'], note: 'Aisle seat requested' },
  front:  { preference: 'front', rows: [1, 2, 3, 4, 5], note: 'Front seat requested' },
  back:   { preference: 'back', rows: [10, 11, 12, 13, 14], note: 'Back seat requested' },
};

async function parsePrompt(prompt) {
  try {
    const parsed = await _parseWithGemini(prompt);

    // ─────────────────────────────────────────────
    // MULTI-DESTINATION BRANCH
    // Gemini returns isMultiDestination + legs[] in the same
    // call as the normal single-destination shape. If it set
    // this flag, return early with the multi-destination shape
    // — none of the single-destination detection below applies
    // to a multi-leg itinerary.
    // ─────────────────────────────────────────────
    if (parsed.isMultiDestination && Array.isArray(parsed.legs) && parsed.legs.length >= 2) {
      return _enrichMultiDestinationParams(parsed);
    }

    // Always run local detection on top of LLM result
    parsed.accessibility = _detectAccessibility(prompt);
    parsed.seatPreference = parsed.seatPreference || _detectSeatPreference(prompt);
    parsed.mealPlan = parsed.mealPlan || _detectMealPlan(prompt);
    parsed.trainClass = parsed.trainClass || _detectTrainClass(prompt);
    parsed.timePreference = parsed.timePreference || _detectTimePreference(prompt);

    // Multi-modal fallback overlay
    const { outbound, returnLeg } = _detectMultiModalTransport(prompt);
    parsed.outboundTransportMode = parsed.outboundTransportMode || outbound;
    parsed.returnTransportMode = parsed.returnTransportMode || returnLeg;

    // Legacy mapping for generic searches
    if (!parsed.outboundTransportMode && parsed.transportMode) {
        parsed.outboundTransportMode = parsed.transportMode;
        parsed.returnTransportMode = parsed.transportMode;
    }

    parsed.busSeatPosition = _resolveBusSeatPosition(parsed.seatPreference);

    if (parsed.accessibility) {
      if (!parsed.preferences) parsed.preferences = [];
      if (!parsed.preferences.includes('accessible')) {
        parsed.preferences.push('accessible');
      }
    }

    return _enrichParams(parsed);
  } catch (error) {
    logger.warn('Gemini parsing failed, falling back to rule-based parser', { error: error.message });

    // Rule-based multi-destination check runs first — if Gemini is
    // down, a multi-destination prompt should still be recognized
    // as one, not silently collapsed into a broken single-destination
    // parse.
    const multiDest = _detectMultiDestinationRules(prompt);
    if (multiDest) {
      return _enrichMultiDestinationParams(multiDest);
    }

    const parsed = _parseWithRules(prompt);
    return _enrichParams(parsed);
  }
}

// ─────────────────────────────────────────────
// DETECTION FUNCTIONS
// ─────────────────────────────────────────────

function _detectAccessibility(prompt) {
  const lower = prompt.toLowerCase();
  return ACCESSIBILITY_KEYWORDS.some(keyword => lower.includes(keyword));
}

function _detectSeatPreference(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.match(/window\s*seat|seat.*window|dirisha/)) return 'window';
  if (lower.match(/aisle\s*seat|seat.*aisle|njia/)) return 'aisle';
  if (lower.match(/middle\s*seat|seat.*middle/)) return 'middle';
  if (lower.match(/extra\s*legroom|leg\s*room|more\s*space/)) return 'extra_legroom';
  if (lower.match(/front\s*seat|seat.*front|mbele/)) return 'front';
  if (lower.match(/back\s*seat|seat.*back|nyuma/)) return 'back';
  if (lower.match(/upper\s*(deck|floor)|top\s*deck/)) return 'upper_deck';
  if (lower.match(/lower\s*(deck|floor)|bottom\s*deck/)) return 'lower_deck';
  return null;
}

function _detectMealPlan(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.match(/all\s*inclusive|all inclusive|everything\s*included/)) return 'all_inclusive';
  if (lower.match(/full\s*board|full board|breakfast.*lunch.*dinner|chakula\s*chote/)) return 'full_board';
  if (lower.match(/half\s*board|half board|breakfast.*dinner|dinner.*breakfast/)) return 'half_board';
  if (lower.match(/bed.*breakfast|b&b|bb|breakfast\s*only|breakfast\s*included/)) return 'bed_and_breakfast';
  if (lower.match(/room\s*only|no\s*meals|without\s*meals|chumba\s*tu/)) return 'room_only';
  if (lower.match(/breakfast/)) return 'bed_and_breakfast';
  return null;
}

function _detectTrainClass(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.match(/first\s*class|1st\s*class|daraja\s*ya\s*kwanza|business\s*class\s*train/)) return 'first_class';
  if (lower.match(/economy\s*class|economy\s*train|daraja\s*ya\s*pili|second\s*class/)) return 'economy';
  if (lower.match(/premium\s*class|premium\s*train/)) return 'premium';
  if (lower.match(/sgr|standard\s*gauge|madaraka\s*express/)) return 'sgr';
  return null;
}

function _detectTimePreference(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.match(/morning|early|asubuhi|alfajiri|6am|7am|8am|9am|10am|11am/)) return 'morning';
  if (lower.match(/afternoon|mchana|alasiri|12pm|1pm|2pm|3pm|4pm/)) return 'afternoon';
  if (lower.match(/evening|jioni|5pm|6pm|7pm|8pm/)) return 'evening';
  // FIX: word boundary on "night" — without it, "3 nights" (a duration)
  // was matching as a "night" time-of-day preference, which then made
  // _filterByTime() in travelduqa.js silently reject every flight that
  // didn't depart between 21:00-05:00 EAT, even normal daytime flights.
  if (lower.match(/\bnight\b|usiku|late|9pm|10pm|11pm|midnight/)) return 'night';
  return null;
}

function _detectTransportMode(text) {
  const lower = text.toLowerCase();
  if (lower.match(/\bbus\b|coach|basi|matatu/)) return 'bus';
  if (lower.match(/\btrain\b|sgr|rail|treni|madaraka/)) return 'train';
  if (lower.match(/\bflight\b|\bfly\b|ndege|airline|airways/)) return 'flight';
  if (lower.match(/\bdrive\b|road\s*trip|self\s*drive|gari/)) return 'drive';
  return null;
}

function _detectMultiModalTransport(prompt) {
  const lower = prompt.toLowerCase();
  let outbound = null;
  let returnLeg = null;

  const returnMatch = lower.match(/(return|back|kurudi|coming back).{0,30}(flight|fly|bus|train|drive|ndege|basi|treni)/);
  const outMatch = lower.match(/(go|going|kwenda|departing).{0,30}(flight|fly|bus|train|drive|ndege|basi|treni)/);

  if (returnMatch) returnLeg = _detectTransportMode(returnMatch[2]);
  if (outMatch) outbound = _detectTransportMode(outMatch[2]);

  if (!outbound && !returnLeg) {
    const general = _detectTransportMode(lower);
    outbound = general;
    returnLeg = general;
  }

  return { outbound, returnLeg };
}

function _resolveBusSeatPosition(seatPreference) {
  if (!seatPreference) return null;
  return BUS_SEAT_POSITIONS[seatPreference] || null;
}

// ─────────────────────────────────────────────
// FUZZY CITY MATCHING
// Tolerates typos ("zanibar" -> "zanzibar", "mombsa" -> "mombasa")
// using Levenshtein distance, so a small spelling mistake doesn't
// silently fail a search the way an unrecognized city name would.
// ─────────────────────────────────────────────
function _levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function _fuzzyMatchCity(input, candidates) {
  let best = null;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = _levenshtein(input, candidate);
    const maxAllowed = candidate.length <= 5 ? 1 : candidate.length <= 9 ? 2 : 3;
    if (distance <= maxAllowed && distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

function _resolveCityFuzzy(rawToken, sortedCities) {
  if (!rawToken) return null;
  const cleaned = rawToken.trim();

  for (const city of sortedCities) {
    if (cleaned.includes(city)) return city;
  }

  const words = cleaned.split(/\s+/).filter(w => w.length > 2);
  for (const word of words) {
    const match = _fuzzyMatchCity(word, sortedCities);
    if (match) return match;
  }

  return _fuzzyMatchCity(cleaned, sortedCities);
}

// ─────────────────────────────────────────────
// GEMINI PARSER
// ─────────────────────────────────────────────
async function _parseWithGemini(prompt) {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [{
          text: `You are a travel booking assistant for East Africa. Extract trip details from this prompt and return ONLY valid JSON with no explanation, no markdown, no code blocks.

Prompt: "${prompt}"

FIRST, decide: is this a MULTI-DESTINATION itinerary (the traveler names 2 or more distinct places they want to visit in sequence, e.g. "5 days in Maasai Mara then 4 days in Mombasa", "3 nights Zanzibar and 2 nights Diani")? If yes, return ONLY this shape:

{
  "isMultiDestination": true,
  "origin": "full city name in lowercase, or null if not stated",
  "legs": [
    { "destination": "full place name in lowercase", "nights": number },
    { "destination": "full place name in lowercase", "nights": number }
  ],
  "departureDate": "YYYY-MM-DD or null",
  "passengers": number (default 1),
  "budget": "low|mid|high|luxury",
  "accessibility": true or false,
  "preferences": ["beach", "safari", "culture", "adventure", "family", "honeymoon", "business", "accessible"]
}

OTHERWISE (single destination), return ONLY this shape:

{
  "isMultiDestination": false,
  "origin": "full city name in lowercase, or null if not stated",
  "destination": "full city name in lowercase",
  "departureDate": "YYYY-MM-DD or null",
  "returnDate": "YYYY-MM-DD or null",
  "passengers": number (default 1),
  "budget": "low|mid|high|luxury",
  "nights": number (default 3),
  "tripType": "round_trip|one_way",
  "outboundTransportMode": "flight|bus|train|drive|null",
  "returnTransportMode": "flight|bus|train|drive|null",
  "seatPreference": "window|aisle|middle|extra_legroom|front|back|upper_deck|lower_deck|null",
  "mealPlan": "all_inclusive|full_board|half_board|bed_and_breakfast|room_only|null",
  "trainClass": "first_class|economy|premium|sgr|null",
  "timePreference": "morning|afternoon|evening|night|null",
  "accessibility": true or false,
  "preferences": ["beach", "safari", "culture", "adventure", "family", "honeymoon", "business", "accessible"]
}

RULES:
- CRITICAL: Pay attention to directional transport. If a user says "bus going and flight coming back", set outboundTransportMode="bus" and returnTransportMode="flight".
- If only one transport mode is mentioned (e.g. "fly to Mombasa"), apply it to both outbound and return.
- origin = where they are coming FROM. If the prompt does NOT clearly state where the traveler is departing from, set origin to null — do NOT guess or default to any city. We will ask the traveler to clarify separately.
- destination (single) / each leg's destination (multi) = where they want to GO. Use the place name as stated (e.g. "maasai mara", "kilifi", "watamu") — do NOT convert it to a nearby airport or city name. Place name resolution happens in a separate step.
- If a city name appears to be a misspelling of a real city (e.g. "zanibar", "mombsa", "nairobii"), correct it to the real city name in your response rather than treating it as unrecognized.
- For multi-destination prompts, preserve the ORDER the traveler stated the destinations in — legs[0] is visited first.
- Today: ${new Date().toISOString().split('T')[0]}
- "next week" = ${_addDaysStr(7)}
- "next month" = ${_addDaysStr(30)}
- "christmas" = ${new Date().getFullYear()}-12-25
- "new year" = ${new Date().getFullYear() + 1}-01-01
- For "weekend" use nights: 2, for "week" use nights: 7`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 800,
      }
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    }
  );

  const content = response.data.candidates[0].content.parts[0].text;
  const cleaned = content.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  // NOTE: no longer defaulting origin to 'nairobi' here — a missing
  // origin is now a real signal (needsOriginClarification, set in
  // _enrichParams) rather than a silently guessed value. A traveler
  // could genuinely be coming from Kigali, London, or anywhere else.

  return parsed;
}

// ─────────────────────────────────────────────
// RULE-BASED MULTI-DESTINATION FALLBACK
// Only used if the Gemini call fails entirely. Recognizes simple
// "<N> days/nights in <place> then/and <N> days/nights in <place>"
// patterns using the known-place list, so a Gemini outage doesn't
// silently downgrade a multi-destination prompt into a broken
// single-destination parse.
// ─────────────────────────────────────────────
function _detectMultiDestinationRules(prompt) {
  const lower = prompt.toLowerCase().trim();

  // Two phrasing styles need to be supported:
  //   "5 days in maasai mara then 4 days in mombasa"  (number BEFORE place)
  //   "nairobi to mombasa 3 days then to zanzibar 4 days" (place BEFORE number)
  // The original pattern only matched the first style — "place N days"
  // phrasing (very common: "X to Y N days") produced garbage captures
  // (e.g. a lone space or trailing "s") because the place name sits
  // before the number, not after it.
  const numberFirstPattern = /(\d+)\s*(?:days?|nights?)\s*(?:in|at)\s+([a-z\s]+?)(?=\s*(?:,|\.|then|and|followed by|after that|next|$))/g;
  const placeFirstPattern  = /(?:to|in|at)\s+([a-z\s]+?)\s+(\d+)\s*(?:days?|nights?)/g;

  const sortedPlaces = [...KNOWN_NON_AIRPORT_DESTINATIONS, ...Object.keys(CITY_CODES)]
    .sort((a, b) => b.length - a.length);

  // Try number-first phrasing ("5 days in Mara") first. Only fall
  // back to place-first phrasing ("Mara 5 days") if the first
  // pattern didn't find enough legs — running both unconditionally
  // on the same prompt let the second pattern re-match fragments
  // already captured by the first, producing phantom duplicate legs.
  let legs = [];
  for (const match of lower.matchAll(numberFirstPattern)) {
    const nights = parseInt(match[1]);
    const rawPlace = match[2].trim();
    const resolvedPlace = _resolveCityFuzzy(rawPlace, sortedPlaces) || (rawPlace.length > 2 ? rawPlace : null);
    if (resolvedPlace && nights) legs.push({ destination: resolvedPlace, nights });
  }

  if (legs.length < 2) {
    legs = [];
    for (const match of lower.matchAll(placeFirstPattern)) {
      const rawPlace = match[1].trim();
      const nights = parseInt(match[2]);
      const resolvedPlace = _resolveCityFuzzy(rawPlace, sortedPlaces) || (rawPlace.length > 2 ? rawPlace : null);
      if (resolvedPlace && nights) legs.push({ destination: resolvedPlace, nights });
    }
  }

  if (legs.length < 2) return null;

  // Origin: look for "from <city>" anywhere in the prompt, OR the
  // first city mentioned before "to" in "X to Y" phrasing (e.g.
  // "nairobi to mombasa..." -> origin is nairobi). Otherwise leave
  // null so the engine can ask for clarification.
  const fromMatch = lower.match(/from\s+([a-z\s]+?)(?:\s|,|$)/);
  const sortedCities = Object.keys(CITY_CODES).sort((a, b) => b.length - a.length);
  let origin = fromMatch ? _resolveCityFuzzy(fromMatch[1], sortedCities) : null;

  if (!origin) {
    const xToYMatch = lower.match(/([a-z\s]+?)\s+to\s+([a-z\s]+?)(?=\s+\d+\s*(?:days?|nights?))/);
    if (xToYMatch) {
      origin = _resolveCityFuzzy(xToYMatch[1].trim(), sortedCities);
    }
  }

  const passengerMatch = lower.match(/(\d+)\s*(people|persons|passengers|adults|pax|travelers?)/);
  const passengers = passengerMatch ? parseInt(passengerMatch[1]) : 1;

  let budget = 'mid';
  if (lower.match(/luxury|5[\s-]?star|five[\s-]?star|premium/)) budget = 'luxury';
  else if (lower.match(/cheap|budget|affordable|bei[\s-]?nafuu/)) budget = 'low';

  return {
    isMultiDestination: true,
    origin,
    legs,
    departureDate: _extractDate(lower) || _resolveRelativeDate(lower) || null,
    passengers,
    budget,
    accessibility: _detectAccessibility(lower),
    preferences: [],
  };
}

// ─────────────────────────────────────────────
// RULE-BASED FALLBACK
// ─────────────────────────────────────────────
function _parseWithRules(prompt) {
  let lower = prompt.toLowerCase().trim();

  for (const [swahili, english] of Object.entries(SWAHILI_DESTINATIONS)) {
    lower = lower.replace(swahili, english);
  }

  const passengerMatch = lower.match(/(\d+)\s*(watu|wenza|watu\s*wawili|people|persons|passengers|adults|pax|travelers?)/);
  const passengers = passengerMatch
      ? parseInt(passengerMatch[1])
      : lower.includes('wawili') || lower.includes('sisi wawili') ? 2
      : lower.includes('familia') || lower.includes('family') ? 4
      : 1;

  let budget = 'mid';
  if (lower.match(/luxury|5[\s-]?star|five[\s-]?star|premium|first[\s-]?class/)) budget = 'luxury';
  else if (lower.match(/high[\s-]?budget|business[\s-]?class|expensive/)) budget = 'high';
  else if (lower.match(/low[\s-]?budget|cheap|budget|affordable|bei[\s-]?nafuu|economy/)) budget = 'low';

  const nightsMatch = lower.match(/(\d+)\s*(nights?|usiku|giku)/);
  const daysMatch = lower.match(/(\d+)\s*(days?|siku)/);
  const nights = nightsMatch
    ? parseInt(nightsMatch[1])
    : daysMatch
      ? parseInt(daysMatch[1]) - 1
      : lower.includes('weekend') ? 2
      : lower.includes('week') && !lower.includes('next week') ? 7
      : 3;

  // Places (airport cities + known non-airport destinations) used
  // for fuzzy matching in the single-destination rules path. Using
  // the combined list here (not just CITY_CODES) so a prompt like
  // "kilifi" or "watamu" with no Gemini available still resolves
  // to the right destination NAME — _resolveToCode() below is what
  // decides whether that name maps to a real airport code or needs
  // destinationIntel resolution downstream in the engine.
  const sortedCities = [...KNOWN_NON_AIRPORT_DESTINATIONS, ...Object.keys(CITY_CODES)]
    .sort((a, b) => b.length - a.length);

  let origin = null;
  let destination = null;

  const fromToMatch = lower.match(/(?:from\s+)?([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s*[,\d]|$)/);
  const kwendaMatch = lower.match(/(?:nataka\s+kwenda|kwenda|going\s+to|travel\s+to|trip\s+to|visit)\s+([a-z\s]+?)(?:\s*[,\d]|$)/);

  if (fromToMatch) {
    const fromCity = fromToMatch[1].trim();
    const toCity = fromToMatch[2].trim();
    // Use fuzzy matching so a typo in either city doesn't silently fail
    origin = _resolveCityFuzzy(fromCity, sortedCities) || origin;
    destination = _resolveCityFuzzy(toCity, sortedCities) || destination;
  }

  if (kwendaMatch && !destination) {
    const toCity = kwendaMatch[1].trim();
    destination = _resolveCityFuzzy(toCity, sortedCities) || destination;
  }

  if (!destination) {
    const words = lower.split(/\s+/).filter(w => w.length > 2);
    for (const word of words) {
      const match = _fuzzyMatchCity(word, sortedCities) ||
        sortedCities.find(city => word.includes(city) || city.includes(word));
      if (match) {
        if (!origin) origin = match;
        else if (match !== origin) { destination = match; break; }
      }
    }
    if (origin && !destination) { destination = origin; origin = null; }
  }

  // CHANGED: no longer silently defaulting origin to 'nairobi'. A missing
  // origin is now left as null and surfaced as a clarification need in
  // _enrichParams, since the traveler could be coming from anywhere.

  const preferences = [];
  if (lower.match(/beach|coast|ocean|bahari|pwani/)) preferences.push('beach');
  if (lower.match(/safari|game|wildlife|mara|serengeti/)) preferences.push('safari');
  if (lower.match(/business|conference/)) preferences.push('business');

  const accessibility = _detectAccessibility(lower);
  if (accessibility) preferences.push('accessible');

  const seatPreference = _detectSeatPreference(lower);
  const mealPlan = _detectMealPlan(lower);
  const trainClass = _detectTrainClass(lower);
  const timePreference = _detectTimePreference(lower);

  const { outbound, returnLeg } = _detectMultiModalTransport(lower);
  const busSeatPosition = _resolveBusSeatPosition(seatPreference);

  const departureDate = _extractDate(lower) || _resolveRelativeDate(lower) || _defaultDepartureDate();

  return {
    origin,
    destination,
    departureDate,
    returnDate: null,
    passengers,
    budget,
    nights,
    tripType: lower.match(/one[\s-]?way|kwenda\s+tu/) ? 'one_way' : 'round_trip',
    preferences,
    accessibility,
    seatPreference,
    mealPlan,
    trainClass,
    timePreference,
    outboundTransportMode: outbound,
    returnTransportMode: returnLeg || outbound,
    busSeatPosition,
  };
}

// ─────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────
function _addDaysStr(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

function _extractDate(prompt) {
  const months = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
    jan: '01', feb: '02', mar: '03', apr: '04',
    jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  const longMatch = prompt.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i)
    || prompt.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\s+(\d{4})/i);

  if (longMatch) {
    const day = longMatch[1].length <= 2 && !isNaN(longMatch[1])
      ? longMatch[1].padStart(2, '0')
      : longMatch[2].padStart(2, '0');
    const monthName = isNaN(longMatch[1]) ? longMatch[1].toLowerCase() : longMatch[2].toLowerCase();
    const year = longMatch[3] || longMatch[longMatch.length - 1];
    const month = months[monthName];
    if (month) return `${year}-${month}-${day}`;
  }

  const isoMatch = prompt.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  return null;
}

function _defaultDepartureDate() {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return date.toISOString().split('T')[0];
}

function _resolveRelativeDate(prompt) {
  const now = new Date();

  if (prompt.match(/next\s+week|wiki\s+ijayo/)) {
    now.setDate(now.getDate() + 7);
    return now.toISOString().split('T')[0];
  }
  if (prompt.match(/next\s+month|mwezi\s+ujao/)) {
    now.setMonth(now.getMonth() + 1);
    return now.toISOString().split('T')[0];
  }
  if (prompt.match(/this\s+weekend|weekend\s+hii/)) {
    const day = now.getDay();
    const daysUntilSat = (6 - day + 7) % 7 || 7;
    now.setDate(now.getDate() + daysUntilSat);
    return now.toISOString().split('T')[0];
  }

  return null;
}

// ─────────────────────────────────────────────
// ENRICH PARAMS — SINGLE DESTINATION
// ─────────────────────────────────────────────
function _enrichParams(parsed) {
  // Origin is now allowed to be genuinely unknown — surfaced as a flag
  // the engine checks before running any supplier search, so it can
  // ask "Where are you traveling from?" instead of silently guessing.
  const needsOriginClarification = !parsed.origin;

  const originCode = _resolveToCode(parsed.origin);
  const destinationCode = _resolveToCode(parsed.destination);

  const requiresBus = _isBusRoute(originCode, destinationCode);
  const requiresFlight = true;

  const nights = parsed.nights || _defaultNights(parsed.departureDate, parsed.returnDate);

  const returnDate = parsed.returnDate ||
    (parsed.departureDate ? _addDays(parsed.departureDate, nights) : null);

  return {
    ...parsed,
    isMultiDestination: false,
    originCode,
    destinationCode,
    origin: parsed.origin || null,
    destination: parsed.destination,
    nights,
    returnDate,
    requiresFlight,
    requiresBus,
    needsOriginClarification,
    passengers: parsed.passengers || 1,
    budget: parsed.budget || 'mid',
    accessibility: parsed.accessibility || false,
    seatPreference: parsed.seatPreference || null,
    mealPlan: parsed.mealPlan || null,
    trainClass: parsed.trainClass || null,
    timePreference: parsed.timePreference || null,
    outboundTransportMode: parsed.outboundTransportMode || null,
    returnTransportMode: parsed.returnTransportMode || null,
    busSeatPosition: parsed.busSeatPosition || null,
  };
}

// ─────────────────────────────────────────────
// ENRICH PARAMS — MULTI-DESTINATION
// Mirrors _enrichParams's defaulting/clarification behavior, but
// for the legs[] shape. Per-leg destination-to-airport resolution
// is intentionally NOT done here — that's destinationIntel.js's
// job inside engine.js, since it needs the validated, per-mode
// access data (charter vs flight vs transfer), not just a code.
// ─────────────────────────────────────────────
function _enrichMultiDestinationParams(parsed) {
  const needsOriginClarification = !parsed.origin;

  const legs = (parsed.legs || []).map(leg => ({
    destination: leg.destination,
    nights: leg.nights || 1,
  }));

  return {
    isMultiDestination: true,
    origin: parsed.origin || null,
    legs,
    departureDate: parsed.departureDate || _defaultDepartureDate(),
    passengers: parsed.passengers || 1,
    budget: parsed.budget || 'mid',
    accessibility: parsed.accessibility || false,
    preferences: parsed.preferences || [],
    needsOriginClarification,
    // Destination, for logging/display purposes only — engine.js
    // builds the real route label from resolved leg data.
    destination: legs.map(l => l.destination).join(' + '),
  };
}

function _resolveToCode(city) {
  if (!city) return null;
  const lower = city.toLowerCase().trim();
  return CITY_CODES[lower] || city.toUpperCase().slice(0, 3);
}

function _isBusRoute(origin, destination) {
  return BUS_ROUTES.some(
    ([a, b]) => (a === origin && b === destination) || (a === destination && b === origin)
  );
}

function _defaultNights(departure, returnDate) {
  if (departure && returnDate) {
    const diff = new Date(returnDate) - new Date(departure);
    return Math.round(diff / (1000 * 60 * 60 * 24));
  }
  return 3;
}

function _addDays(dateStr, days) {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}

module.exports = { parsePrompt };