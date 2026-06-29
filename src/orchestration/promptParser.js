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

    parsed._originalPrompt = prompt;
    return _enrichParams(parsed);
  } catch (error) {
    // Surface the ACTUAL provider error, not just "Request failed with
    // status code 400". axios puts the API's JSON error body on
    // error.response.data — without logging it you're blind to the real
    // cause (e.g. a decommissioned model, an unsupported param). This is
    // what would have shown the llama-3.1-8b-instant deprecation
    // immediately instead of via a week of bad parses.
    logger.warn('LLM (Groq) parsing failed, falling back to rule-based parser', {
      error: error.message,
      status: error.response?.status,
      providerError: error.response?.data,
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b',
    });

    // Rule-based multi-destination check runs first — if Gemini is
    // down, a multi-destination prompt should still be recognized
    // as one, not silently collapsed into a broken single-destination
    // parse.
    const multiDest = _detectMultiDestinationRules(prompt);
    if (multiDest) {
      return _enrichMultiDestinationParams(multiDest);
    }

    const parsed = _parseWithRules(prompt);
    parsed._originalPrompt = prompt;
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
// LLM PARSER (Groq — OpenAI-compatible chat completions)
// NOTE: this function is historically named _parseWithGemini and the
// fallback log still says "Gemini" — the actual provider is Groq
// (https://api.groq.com), called via its OpenAI-compatible endpoint.
// The model is set by GROQ_MODEL (default openai/gpt-oss-20b). Groq's
// response_format: json_object returns clean JSON, but we still parse
// defensively via _safeParseJson in case a reasoning model wraps it.
// ─────────────────────────────────────────────

// Tolerant JSON extraction: returns the parsed object, pulling the
// first balanced {...} block out of any surrounding prose or ```json
// fences a model might add. Throws if no valid JSON object is found,
// so the caller falls back to the rule-based parser as before.
function _safeParseJson(raw) {
  if (typeof raw !== 'string') throw new Error('LLM content not a string');
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch (_) { /* fall through to extraction */ }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  throw new Error('No JSON object found in LLM response');
}

async function _parseWithGemini(prompt) {
  // Model is env-configurable so a Groq model deprecation never again
  // silently breaks parsing without a code change. Default is
  // openai/gpt-oss-20b — Groq's official replacement for
  // llama-3.1-8b-instant, which Groq decommissioned on 2026-06-17
  // (that decommission is what caused every request to 400 and fall
  // back to the rule-based parser). Override via GROQ_MODEL on Render.
  const model = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';

  const requestBody = {
    model,
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_completion_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are a travel booking assistant for East Africa. Extract trip details from this prompt and return ONLY valid JSON with no explanation, no markdown, no code blocks.

Prompt: "${prompt}"

FIRST, decide: is this a MULTI-DESTINATION itinerary (the traveler names 2 or more distinct places they want to visit in sequence, e.g. "5 days in Maasai Mara then 4 days in Mombasa", "3 nights Zanzibar and 2 nights Diani")? If yes, return ONLY this shape:

{
  "isMultiDestination": true,
  "origin": "full city name in lowercase, or null if not stated — this is the origin for the FIRST leg only",
  "legs": [
    { "destination": "full place name in lowercase", "nights": number, "origin": "full city name in lowercase, or null", "departureDate": "YYYY-MM-DD or null" },
    { "destination": "full place name in lowercase", "nights": number, "origin": "full city name in lowercase, or null", "departureDate": "YYYY-MM-DD or null" }
  ],
  "departureDate": "YYYY-MM-DD or null — the FIRST leg's departure date only, if stated",
  "passengers": number (default 1),
  "adults": number — count of adult travelers (default: equal to passengers when no children are mentioned),
  "children": number — count of child travelers (default 0; a "child"/"kid"/"toddler"/"baby"/"infant" or a stated age under 18 counts),
  "childAges": array of integers — the age in years of each child IF stated (e.g. "a 7 year old and a 4 year old" -> [7, 4]); use an empty array [] if children are mentioned but no ages given, or if there are no children,
  "budget": choose exactly ONE: "low" or "mid" or "high" or "luxury" (default "mid" if not stated),
  "accessibility": true or false,
  "preferredTransportProvider": "the transport company name exactly as the traveler said it — could be an airline (e.g. 'Emirates', 'Qatar Airways'), a bus company (e.g. 'Buscar Dreamline', 'Modern Coast'), or a train/SGR operator. Capture it regardless of transport mode. null if not mentioned",
  "preferredHotel": "the hotel name exactly as the traveler said it (e.g. 'JW Marriott', 'Sarova Stanley'), or null if not mentioned",
  "preferences": an array containing ONLY the categories that genuinely apply, chosen from: "beach", "safari", "culture", "adventure", "family", "honeymoon", "business", "accessible" — return an EMPTY array [] if none are clearly implied by the prompt
}

CRITICAL rule for each leg's "origin" field (this is separate from the top-level "origin", which only applies to leg 1):
- Set a leg's "origin" to null if the traveler did NOT restate a departure city for that specific leg (e.g. "...then 4 days in Mombasa" — no origin restated for Mombasa, so origin: null).
- Set a leg's "origin" to the stated city ONLY if the traveler explicitly named a departure city for that specific leg (e.g. "...then from Nairobi to Kampala 3 nights" — origin: "nairobi" for the Kampala leg, even if "nairobi" was already used as the origin for an earlier leg).
- Do NOT infer or fill in a leg's origin from context, from the previous leg's destination, or from the top-level origin. If the traveler did not type a departure city for that leg, it is null — leave it null and let a later step decide what it means.
- The traveler may restate the SAME origin city for multiple legs — this is normal and means each leg is a separate trip from that city, NOT that the second mention is a mistake or should be dropped. Always capture every explicitly stated origin, even if it repeats a city already used elsewhere in the prompt.

CRITICAL rule for each leg's "departureDate" field (separate from the top-level "departureDate", which only applies to leg 1):
- Set a leg's "departureDate" to null if the traveler did NOT state a specific date for that particular leg.
- Set it to a real date ONLY if the traveler explicitly gave a date tied to that specific leg (e.g. "on the 28th of June" appearing right next to that leg's mention).
- Do NOT copy the top-level departureDate, a previous leg's date, or today's date into a leg's departureDate just to fill the field. A leg with no date of its own gets null — a later step calculates a sensible date for it.

WORKED EXAMPLE (read this carefully — this exact pattern has caused mistakes before):
Prompt: "Plan me a trip nairobi to mombasa 3 nights on the 28th of June and nairobi to dar es salaam 4 nights"
This names TWO separate trips, each explicitly starting from nairobi. Only the FIRST trip has a date stated ("on the 28th of June" sits right next to the Mombasa mention) — the second trip (Dar es Salaam) has no date stated at all. Correct output:
{
  "isMultiDestination": true,
  "origin": "nairobi",
  "legs": [
    { "destination": "mombasa", "nights": 3, "origin": null, "departureDate": null },
    { "destination": "dar es salaam", "nights": 4, "origin": "nairobi", "departureDate": null }
  ],
  "departureDate": "2026-06-28",
  ...
}
Notice: the FIRST "nairobi" (before "mombasa") fills the TOP-LEVEL "origin" field, not leg 1's own origin field — leg 1 never needs its own origin field populated, since the top-level origin already covers it. The SECOND "nairobi" (before "dar es salaam") is a genuine, deliberate restatement by the traveler and MUST be captured as leg 2's "origin" — do not drop it, blank it, or assume it was already accounted for just because the word "nairobi" appeared earlier in the prompt for a different leg. Likewise, "28th of June" belongs to the top-level "departureDate" (it described the Mombasa leg, which is leg 1) — it must NOT be copied into leg 2's "departureDate", since the traveler never gave Dar es Salaam its own date.


OTHERWISE (single destination), return ONLY this shape:

{
  "isMultiDestination": false,
  "origin": "full city name in lowercase, or null if not stated",
  "destination": "full city name in lowercase",
  "departureDate": "YYYY-MM-DD or null",
  "returnDate": "YYYY-MM-DD or null",
  "passengers": number (default 1),
  "adults": number — count of adult travelers (default: equal to passengers when no children are mentioned),
  "children": number — count of child travelers (default 0; a "child"/"kid"/"toddler"/"baby"/"infant" or a stated age under 18 counts),
  "childAges": array of integers — the age in years of each child IF stated (e.g. "a 7 year old and a 4 year old" -> [7, 4]); use an empty array [] if children are mentioned but no ages given, or if there are no children,
  "budget": choose exactly ONE: "low" or "mid" or "high" or "luxury" (default "mid" if not stated),
  "nights": number (default 3),
  "tripType": choose exactly ONE: "round_trip" or "one_way" (default "round_trip" unless the traveler explicitly says one-way),
  "outboundTransportMode": choose exactly ONE: "flight" or "bus" or "train" or "drive", or null if not stated,
  "returnTransportMode": choose exactly ONE: "flight" or "bus" or "train" or "drive", or null if not stated,
  "seatPreference": choose exactly ONE: "window" or "aisle" or "middle" or "extra_legroom" or "front" or "back" or "upper_deck" or "lower_deck", or null if not stated,
  "mealPlan": choose exactly ONE: "all_inclusive" or "full_board" or "half_board" or "bed_and_breakfast" or "room_only", or null if not stated,
  "trainClass": choose exactly ONE: "first_class" or "economy" or "premium" or "sgr", or null if not stated,
  "timePreference": choose exactly ONE: "morning" or "afternoon" or "evening" or "night", or null if not stated,
  "accessibility": true or false,
  "preferredTransportProvider": "the transport company name exactly as the traveler said it — could be an airline (e.g. 'Emirates', 'Qatar Airways'), a bus company (e.g. 'Buscar Dreamline', 'Modern Coast'), or a train/SGR operator. Capture it regardless of transport mode. null if not mentioned",
  "preferredHotel": "the hotel name exactly as the traveler said it (e.g. 'JW Marriott', 'Sarova Stanley'), or null if not mentioned",
  "preferences": an array containing ONLY the categories that genuinely apply, chosen from: "beach", "safari", "culture", "adventure", "family", "honeymoon", "business", "accessible" — return an EMPTY array [] if none are clearly implied by the prompt
}

CRITICAL OUTPUT RULE: every field above describing a choice between options (e.g. "choose exactly ONE: A or B or C") means you must output ONE of those literal values (e.g. just "mid", not the word "or" or any list). NEVER output a field's full list of possible values joined together — that is always wrong. If genuinely unsure which single value applies, use the stated default or null, never the full option list.

RULES:
- CRITICAL occupancy rule: passengers = adults + children (the total headcount). Count "adults" and "children" separately. A "child", "kid", "toddler", "baby", "infant", "son", "daughter", or anyone given an age under 18 is a CHILD, not an adult. Examples: "2 adults and a child" -> passengers 3, adults 2, children 1, childAges []. "me my wife and our 7 year old" -> passengers 3, adults 2, children 1, childAges [7]. "family of 4 with kids aged 5 and 8" -> passengers 4, adults 2, children 2, childAges [5,8]. "2 people" with no children mentioned -> passengers 2, adults 2, children 0, childAges []. Only put an age in childAges if it was actually stated; if a child is mentioned with no age, leave childAges shorter than children (e.g. children 1, childAges []).
- CRITICAL: Pay attention to directional transport. If a user says "bus going and flight coming back", set outboundTransportMode="bus" and returnTransportMode="flight".
- If only one transport mode is mentioned (e.g. "fly to Mombasa"), apply it to both outbound and return.
- CRITICAL tripType rule: if the traveler mentions a number of nights or days (e.g. "4 nights", "3 days"), that means they want to come back — set tripType="round_trip". Only use tripType="one_way" if the traveler explicitly says "one way", "single trip", "not coming back", or gives no return timeframe of any kind. A stated nights/days duration is ALWAYS a round-trip signal, never one-way.
- origin = where they are coming FROM. A simple "X to Y" phrasing (e.g. "Nairobi to Mombasa") means X is the origin — extract it. Only set origin to null if the prompt truly gives no departure location at all (e.g. "I want to go to Mombasa" with no "from" stated). Do NOT guess a city if none is given, but DO extract one that is clearly stated, including in plain "X to Y" form.
- CRITICAL — word order is NOT a reliable cue for which city is the origin. The destination is frequently stated FIRST and the origin LAST, especially after the word "from". In "I'd like to visit Zanzibar travelling from Nairobi", "visit Mombasa from Nairobi", or "Zanzibar, departing from Nairobi", the destination is Zanzibar/Mombasa and the origin is Nairobi — the city after "from" is ALWAYS the origin, no matter where it appears in the sentence. Do not assume the first city mentioned is the origin. Ignore conversational filler like "I'd like to", "I want to go to", "fly to", "visit" when deciding — anchor on the actual place names and the word "from".
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
  };

  // gpt-oss models are reasoning models — keep the reasoning overhead
  // minimal so this stays fast (we have a tight latency budget) while
  // still returning clean JSON. Only sent for gpt-oss models, since
  // other models reject an unknown reasoning_effort param with a 400.
  if (/gpt-oss/i.test(model)) {
    requestBody.reasoning_effort = 'low';
  }

  const response = await axios.post(
    `https://api.groq.com/openai/v1/chat/completions`,
    requestBody,
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      timeout: 10000
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM returned no content');
  }
  // response_format json_object should return a bare JSON object, but
  // some reasoning models occasionally wrap it in prose or ```json
  // fences. Extract the first {...} block defensively before parsing
  // so a stray wrapper doesn't force a fallback to the rule parser.
  const parsed = _safeParseJson(content);

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
//
// Per-leg origin extraction here is intentionally conservative —
// it only looks for an explicit "from <city>" immediately preceding
// a fragment's place name. Anything it can't confidently extract is
// left null (same "don't guess" rule as the Groq path), which is
// the safe default since the engine treats null as "ask the
// traveler" rather than silently assuming continuity.
// ─────────────────────────────────────────────
function _detectMultiDestinationRules(prompt) {
  const lower = prompt.toLowerCase().trim();

  // Needs at least two "<N> nights/days ... <place>" fragments,
  // joined by then/and/followed by, to count as multi-destination.
  // Captures an optional leading "from <city> to" so per-leg origin
  // can be extracted (group 1), separate from the place name itself
  // (group 3).
  const fragmentPattern = /(?:from\s+([a-z\s]+?)\s+to\s+)?(\d+)\s*(?:days?|nights?)\s*(?:in|at|to)?\s*([a-z\s]+?)(?=\s*(?:,|\.|then|and|followed by|after that|next|$))/g;
  const fragments = [...lower.matchAll(fragmentPattern)];

  if (fragments.length < 2) return null;

  const sortedPlaces = [...KNOWN_NON_AIRPORT_DESTINATIONS, ...Object.keys(CITY_CODES)]
    .sort((a, b) => b.length - a.length);
  const sortedCities = Object.keys(CITY_CODES).sort((a, b) => b.length - a.length);

  const legs = [];
  for (const match of fragments) {
    const legOriginRaw = match[1] ? match[1].trim() : null;
    const nights = parseInt(match[2]);
    const rawPlace = match[3].trim();
    const resolvedPlace = _resolveCityFuzzy(rawPlace, sortedPlaces) || rawPlace;
    const legOrigin = legOriginRaw ? (_resolveCityFuzzy(legOriginRaw, sortedCities) || legOriginRaw) : null;
    if (resolvedPlace) legs.push({ destination: resolvedPlace, nights, origin: legOrigin });
  }

  if (legs.length < 2) return null;

  // Top-level origin: look for "from <city>" preceding the FIRST
  // fragment specifically (not anywhere in the prompt, since a later
  // "from <city>" belongs to that leg, not leg 1). Falls back to
  // leg[0]'s own extracted origin if the fragment pattern already
  // captured one.
  const origin = legs[0].origin || null;

  const passengerMatch = lower.match(/(\d+)\s*(people|persons|passengers|adults|pax|travelers?)/);
  const passengersBase = passengerMatch ? parseInt(passengerMatch[1]) : 1;

  const occ = _extractOccupancy(lower);
  const children = occ.children || 0;
  const childAges = occ.childAges || [];
  const passengers = occ.passengers != null ? occ.passengers : passengersBase;
  const adults = occ.adults != null ? occ.adults : Math.max(1, passengers - children);

  let budget = 'mid';
  if (lower.match(/luxury|5[\s-]?star|five[\s-]?star|premium/)) budget = 'luxury';
  else if (lower.match(/cheap|budget|affordable|bei[\s-]?nafuu/)) budget = 'low';

  return {
    isMultiDestination: true,
    origin,
    legs,
    departureDate: _extractDate(lower) || _resolveRelativeDate(lower) || null,
    passengers,
    adults,
    children,
    childAges,
    budget,
    accessibility: _detectAccessibility(lower),
    preferences: [],
  };
}

// ─────────────────────────────────────────────
// PLACE-LIKE TOKEN GUARD
// The rule-based extractors below grab loose text around "to"/"from"
// keywords. Conversational phrasing means those captures are often
// NOT places — e.g. "I'd like to visit X" leaves "d like" before the
// "to", "fly to X" leaves "fly", "I want to go to X" leaves "i want".
// Previously such garbage was kept verbatim as the origin/destination
// (the "deline"/"d like" bug). _looksLikePlace lets a capture through
// only if it contains at least one substantive, non-filler word — so
// real non-hub places ("meru", "watamu", "kilifi") still pass, but
// filler fragments are rejected, leaving origin null so the engine
// asks "where are you departing from?" instead of inventing a city.
// ─────────────────────────────────────────────
const _PLACE_FILLER_WORDS = new Set([
  // pronoun/contraction fragments (apostrophes are stripped upstream)
  'i', 'id', 'im', 'ill', 'd', 'll', 'm', 're', 've', 's', 't', 'we', 'us', 'my', 'our',
  // intent verbs / politeness / filler
  'like', 'want', 'wanna', 'love', 'would', 'will', 'can', 'could', 'please', 'help',
  'me', 'go', 'going', 'goin', 'travel', 'travelling', 'traveling', 'fly', 'flying',
  'visit', 'visiting', 'trip', 'holiday', 'vacation', 'need', 'gonna', 'looking',
  'book', 'booking', 'plan', 'planning', 'take', 'get', 'head', 'heading', 'a', 'an',
  'the', 'to', 'from', 'for', 'on', 'in', 'at', 'and', 'then', 'next', 'this', 'some',
]);

function _looksLikePlace(token) {
  if (!token) return false;
  const words = String(token).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  // A plausible place has at least one word that is reasonably long
  // AND not a known filler word. "meru"/"watamu" pass; "d like",
  // "i want", "fly", "visit" do not.
  return words.some(w => w.length >= 3 && !_PLACE_FILLER_WORDS.has(w));
}

// ─────────────────────────────────────────────
// OCCUPANCY EXTRACTION (rule-based fallback)
// Best-effort adults/children/childAges parsing for when Groq is
// unavailable. Groq is the primary (and far more capable) path; this
// just needs to catch the common shapes ("2 adults and a child",
// "family of 4 with a 7 year old") and never crash. Anything it
// can't determine is left for the engine's child-age clarification.
// Returns { adults, children, childAges, passengers } where any of
// adults/passengers may be null (caller applies defaults).
// ─────────────────────────────────────────────
function _extractOccupancy(text) {
  const lower = String(text || '').toLowerCase();

  const adultMatch = lower.match(/(\d+)\s*adults?\b/);
  let adults = adultMatch ? parseInt(adultMatch[1], 10) : null;

  let children = 0;
  const childCountMatch = lower.match(/(\d+)\s*(?:children|kids|child|toddlers?|infants?|babies)\b/);
  if (childCountMatch) {
    children = parseInt(childCountMatch[1], 10);
  }

  // child ages: "7 year old", "7-year-old", "7yo", then "aged 5 and 8"
  const childAges = [];
  const yearOldRe = /(\d{1,2})\s*(?:-|\s)?(?:years?|yrs?|y\/o|yo)\b(?:[\s-]*old)?/gi;
  let m;
  while ((m = yearOldRe.exec(lower)) !== null) childAges.push(parseInt(m[1], 10));
  if (childAges.length === 0) {
    const agedMatch = lower.match(/\bage[ds]?\s+([\d,\sand&]+)/);
    if (agedMatch) {
      const nums = agedMatch[1].match(/\d{1,2}/g);
      if (nums) nums.forEach(n => childAges.push(parseInt(n, 10)));
    }
  }

  // If no explicit child count but a child word or ages appeared, infer it.
  if (children === 0) {
    if (childAges.length > 0) children = childAges.length;
    else if (/\b(?:child|kids?|children|toddler|infant|baby|son|daughter)\b/.test(lower)) children = 1;
  }
  const cappedAges = childAges.slice(0, children);

  const paxMatch = lower.match(/(\d+)\s*(?:people|persons|passengers|pax|travel?ers?|of us)\b/);
  let passengers = paxMatch ? parseInt(paxMatch[1], 10) : null;

  // Reconcile: passengers = adults + children.
  if (passengers === null && adults !== null) passengers = adults + children;
  if (adults === null && passengers !== null) adults = Math.max(0, passengers - children);

  return { adults, children, childAges: cappedAges, passengers };
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
  const passengersBase = passengerMatch
      ? parseInt(passengerMatch[1])
      : lower.includes('wawili') || lower.includes('sisi wawili') ? 2
      : lower.includes('familia') || lower.includes('family') ? 4
      : 1;

  // Occupancy breakdown (adults/children/ages). Falls back to treating
  // everyone as adults when no children are mentioned, so existing
  // adult-only behaviour is unchanged.
  const occ = _extractOccupancy(lower);
  const children = occ.children || 0;
  const childAges = occ.childAges || [];
  const passengers = occ.passengers != null ? occ.passengers : passengersBase;
  const adults = occ.adults != null ? occ.adults : Math.max(1, passengers - children);

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

  // ── Explicit "from <origin>" FIRST ─────────────────────────
  // The strongest, least ambiguous origin signal, and word-order
  // independent — it works whether the traveler writes "from Nairobi
  // to Mombasa", "visit Zanzibar from Nairobi" (destination stated
  // first), or buries "from Nairobi" at the end of a sentence. We
  // capture it and REMOVE the clause from the working string so a
  // trailing "from <city>" can't pollute destination extraction
  // below — that pollution is what turned "fly to mombasa from
  // nairobi" into a trip whose DESTINATION resolved to nairobi.
  let work = lower;
  const fromMatch = lower.match(/\bfrom\s+([a-z][a-z\s]*?)(?=\s*(?:,|\.|\bto\b|\bon\b|\bfor\b|\bnext\b|\bthis\b|\bdeparting\b|\bleaving\b|\bvia\b|\d|$))/);
  if (fromMatch) {
    const cand = fromMatch[1].trim();
    origin = _resolveCityFuzzy(cand, sortedCities) || (_looksLikePlace(cand) ? cand : null);
    work = lower.replace(fromMatch[0], ' ');
  }

  // ── "X to Y" on the cleaned string ─────────────────────────
  // Guarded so the conversational "to" in "like to visit" / "want
  // to go" / "fly to" can't hijack the match: a captured token is
  // accepted as origin/destination only if it resolves to a known
  // city OR _looksLikePlace() (a plausible non-hub place name like
  // "meru"/"watamu") — never raw filler like "d like"/"i want"/"fly".
  const fromToMatch = work.match(/(?:from\s+)?([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s*[,\d]|$)/);
  if (fromToMatch) {
    const t1 = fromToMatch[1].trim();
    const t2 = fromToMatch[2].trim();
    const c1 = _resolveCityFuzzy(t1, sortedCities) || (_looksLikePlace(t1) ? t1 : null);
    const c2 = _resolveCityFuzzy(t2, sortedCities) || (_looksLikePlace(t2) ? t2 : null);
    if (c1 && c2) {
      // Genuine "origin to destination" (both sides are real places).
      if (!origin)      origin = c1;
      if (!destination) destination = c2;
    } else if (c2 && !destination) {
      // "<filler> to <place>" e.g. "fly to mombasa" — only the
      // destination side is real; origin stays whatever "from" found
      // (or null -> clarification).
      destination = c2;
    }
  }

  // ── Destination via "visit / go to / travel to <dest>" ─────
  const kwendaMatch = work.match(/(?:nataka\s+kwenda|kwenda|going\s+to|go\s+to|travel\s+to|trip\s+to|fly\s+to|visit)\s+([a-z\s]+?)(?:\s*[,\d]|$)/);
  if (kwendaMatch && !destination) {
    const cand = kwendaMatch[1].trim();
    destination = _resolveCityFuzzy(cand, sortedCities) || (_looksLikePlace(cand) ? cand : null);
  }

  // ── Last resort: scan the cleaned string for any known place ──
  if (!destination) {
    const words = work.split(/\s+/).filter(w => w.length > 2);
    const scanOrigin = origin; // remember whether origin pre-existed (e.g. from "from")
    for (const word of words) {
      const match = _fuzzyMatchCity(word, sortedCities) ||
        sortedCities.find(city => word.includes(city) || city.includes(word));
      if (match) {
        if (!origin) origin = match;
        else if (match !== origin) { destination = match; break; }
      }
    }
    // Reinterpret a lone SCAN-found place as the destination — but
    // NEVER reassign an origin that came from an explicit "from <city>",
    // or "from nairobi" alone would wrongly become the destination.
    if (!scanOrigin && origin && !destination) { destination = origin; origin = null; }
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
    adults,
    children,
    childAges,
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

  // FIX: day + month with NO year (e.g. "28th of June", "28 June",
  // "June 28th"). Previously the fallback parser only understood a
  // full 4-digit year, so the exact natural phrasing travelers use
  // most ("28th of June") returned null whenever Groq was down,
  // silently degrading date handling on the highest-traffic pattern.
  // The (?!\d) guard stops the day group from swallowing the first
  // digits of a year ("June 2026" must not parse as day 20). Year is
  // inferred as the current year, rolled to next year if that date
  // has already passed ("June 28" said in July means next June).
  // Runs only AFTER the 4-digit-year branches above have failed, so
  // explicit-year prompts are never affected.
  const dayMonth = prompt.match(/(\d{1,2})(?!\d)(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i);
  const monthDay = prompt.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?\b/i);
  const noYear = dayMonth || monthDay;
  if (noYear) {
    const day = (dayMonth ? noYear[1] : noYear[2]).padStart(2, '0');
    const monthName = (dayMonth ? noYear[2] : noYear[1]).toLowerCase();
    const month = months[monthName];
    if (month) {
      const now = new Date();
      let year = now.getFullYear();
      const candidate = new Date(`${year}-${month}-${day}`);
      // Roll to next year only if the date is valid AND already past.
      if (!isNaN(candidate.getTime()) && candidate < now) year += 1;
      return `${year}-${month}-${day}`;
    }
  }

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
// NORMALIZE OCCUPANCY
// Produces a consistent { adults, children, childAges, passengers }
// from whatever the parser captured, enforcing the invariants the
// rest of the system (and HotelBeds) rely on:
//   - passengers === adults + children, always
//   - at least 1 adult (HotelBeds rejects child-only with
//     E_REQUEST_ATLEASTONEADULT)
//   - childAges holds only valid <18 ages and never exceeds children
//     (a shorter childAges than children is the signal that an age is
//     still missing — the engine asks for it before searching hotels)
// Backward compatible: when no children are present, adults =
// passengers exactly as before, so adult-only trips are unchanged.
// ─────────────────────────────────────────────
function _normalizeOccupancy(parsed) {
  let children = Number.isFinite(parsed.children) ? Math.max(0, Math.floor(parsed.children)) : 0;

  let childAges = Array.isArray(parsed.childAges)
    ? parsed.childAges.map(a => parseInt(a, 10)).filter(a => Number.isFinite(a) && a >= 0 && a < 18)
    : [];
  if (childAges.length > children) childAges = childAges.slice(0, children);

  const totalStated = Number.isFinite(parsed.passengers) ? Math.max(1, Math.floor(parsed.passengers)) : null;
  let adults = Number.isFinite(parsed.adults) ? Math.max(0, Math.floor(parsed.adults)) : null;

  if (adults == null) {
    adults = totalStated != null ? Math.max(1, totalStated - children) : 1;
  }
  if (adults < 1) adults = 1; // HotelBeds requires at least one adult

  const passengers = adults + children;
  return { adults, children, childAges, passengers };
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

  // FIX: returnDate previously only computed when departureDate was
  // already present — if the traveler gave a nights count but no
  // specific date ("4 nights" with no date), departureDate stayed
  // null, so returnDate ALSO stayed null regardless of tripType,
  // which silently skipped the entire return-leg search in
  // engine.js (gated on tripParams.returnDate being truthy). Default
  // departureDate here too, mirroring the [FLIGHT FALLBACK] used in
  // engine.js's _searchFlights, so returnDate always computes
  // correctly whenever a nights count is known.
  const departureDate = parsed.departureDate || _defaultDepartureDate();

  // Defensive backstop: a stated nights/days duration is a strong,
  // unambiguous round-trip signal — if the LLM said tripType
  // "one_way" despite the traveler explicitly giving a nights
  // value (e.g. "4 nights"), that's a self-contradiction. Correct
  // it here rather than relying solely on prompt wording, since
  // smaller models don't always follow instructions reliably.
  const explicitOneWaySignal = /\bone[\s-]?way\b|\bsingle\s+trip\b|\bnot\s+coming\s+back\b/i.test(String(parsed._originalPrompt || ''));
  const sanitizedTripType = _sanitizeEnum(parsed.tripType, ['round_trip', 'one_way'], 'round_trip');
  const correctedTripType = (parsed.nights && sanitizedTripType === 'one_way' && !explicitOneWaySignal)
    ? 'round_trip'
    : sanitizedTripType;

  // FIX: returnDate is only computed for genuine round trips. Before,
  // it was set unconditionally, so a real one-way ("Nairobi to Mombasa
  // one way") still got a returnDate — and engine.js's return-leg
  // search is gated on tripParams.returnDate being truthy, so it
  // searched, priced, and displayed a return leg the traveler never
  // asked for. Now a one-way (AFTER the round-trip-when-nights-stated
  // correction above) gets null, correctly skipping the return search.
  // Hotels are unaffected: _searchHotels falls back to checkIn + nights
  // when returnDate is null, so accommodation still spans the full stay.
  const returnDate = correctedTripType === 'one_way'
    ? null
    : (parsed.returnDate || _addDays(departureDate, nights));

  return {
    ...parsed,
    isMultiDestination: false,
    originCode,
    destinationCode,
    origin: parsed.origin || null,
    destination: parsed.destination,
    departureDate,
    nights,
    returnDate,
    requiresFlight,
    requiresBus,
    needsOriginClarification,
    ..._normalizeOccupancy(parsed),
    budget: _sanitizeEnum(parsed.budget, ['low', 'mid', 'high', 'luxury'], 'mid'),
    tripType: correctedTripType,
    accessibility: parsed.accessibility || false,
    seatPreference: _sanitizeEnum(parsed.seatPreference, ['window', 'aisle', 'middle', 'extra_legroom', 'front', 'back', 'upper_deck', 'lower_deck'], null),
    mealPlan: _sanitizeEnum(parsed.mealPlan, ['all_inclusive', 'full_board', 'half_board', 'bed_and_breakfast', 'room_only'], null),
    trainClass: _sanitizeEnum(parsed.trainClass, ['first_class', 'economy', 'premium', 'sgr'], null),
    timePreference: _sanitizeEnum(parsed.timePreference, ['morning', 'afternoon', 'evening', 'night'], null),
    outboundTransportMode: _sanitizeEnum(parsed.outboundTransportMode, ['flight', 'bus', 'train', 'drive'], null),
    returnTransportMode: _sanitizeEnum(parsed.returnTransportMode, ['flight', 'bus', 'train', 'drive'], null),
    preferredTransportProvider: _sanitizeFreeText(parsed.preferredTransportProvider),
    preferredHotel: _sanitizeFreeText(parsed.preferredHotel),
    preferences: _sanitizePreferences(parsed.preferences),
    busSeatPosition: parsed.busSeatPosition || null,
    _originalPrompt: undefined, // internal scratch field, not part of tripParams
  };
}

// ─────────────────────────────────────────────
// SANITIZE ENUM VALUE
// Defensive guard against any LLM provider returning something
// other than a single valid value for a constrained field — e.g.
// echoing the schema's option list back literally ("low|mid|high
// |luxury" or "low, mid, high, luxury") instead of picking one.
// Falls back to the given default rather than letting a malformed
// value flow downstream into supplier searches/pricing logic.
// ─────────────────────────────────────────────
function _sanitizeEnum(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

// ─────────────────────────────────────────────
// SANITIZE FREE-TEXT VALUE
// For fields like preferredTransportProvider/preferredHotel that
// aren't a fixed enum (any airline/bus company/train operator or
// hotel name is valid) — just guards against non-string garbage and
// trims whitespace, no allowed-value list to check against. A
// genuinely empty string after trimming is treated the same as null
// (no preference stated), since "" and null mean the same thing to
// every downstream consumer of this field.
// ─────────────────────────────────────────────
function _sanitizeFreeText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ─────────────────────────────────────────────
// SANITIZE PREFERENCES ARRAY
// Same defensive intent as _sanitizeEnum, but for the preferences
// array — keeps only values that are actually in the allowed set,
// so a malformed response (e.g. the full option list returned
// regardless of relevance) doesn't silently bias ranking/recommendations.
// ─────────────────────────────────────────────
function _sanitizePreferences(value) {
  const allowed = ['beach', 'safari', 'culture', 'adventure', 'family', 'honeymoon', 'business', 'accessible'];
  if (!Array.isArray(value)) return [];

  const cleaned = value
    .filter(v => typeof v === 'string')
    .map(v => v.trim().toLowerCase())
    .filter(v => allowed.includes(v));

  // If every single allowed value is present, that's the same
  // failure pattern as the enum-echo bug — a model returning the
  // whole option list rather than genuinely selecting relevant
  // ones (it is extremely unlikely a real prompt implies beach
  // AND safari AND culture AND business AND honeymoon all at
  // once). Treat this as malformed and reset to empty rather
  // than letting it silently bias ranking toward every category.
  const uniqueValues = new Set(cleaned);
  if (allowed.every(a => uniqueValues.has(a))) {
    return [];
  }

  return cleaned;
}

// ─────────────────────────────────────────────
// ENRICH PARAMS — MULTI-DESTINATION
// Mirrors _enrichParams's defaulting/clarification behavior, but
// for the legs[] shape. Per-leg destination-to-airport resolution
// is intentionally NOT done here — that's destinationIntel.js's
// job inside engine.js, since it needs the validated, per-mode
// access data (charter vs flight vs transfer), not just a code.
//
// Per-leg origin is passed through as-is (null or a stated city) —
// classifying what a leg's origin MEANS (continuous vs. independent
// trip vs. needs clarification) is engine.js's job in
// _classifyLegTransitions, since that decision also depends on the
// PREVIOUS leg's destination, which this function doesn't have
// visibility into on a per-field basis the way the engine's
// sequential loop does.
// ─────────────────────────────────────────────
function _enrichMultiDestinationParams(parsed) {
  const topLevelDepartureDate = parsed.departureDate || _defaultDepartureDate();

  const legs = (parsed.legs || []).map((leg, i) => ({
    destination: leg.destination,
    nights: leg.nights || 1,
    origin: leg.origin || null,
    // Leg 1's date IS the top-level departureDate (same field,
    // covered already — see the origin defensive backfill below for
    // the analogous situation). Leg 2+ keep whatever the model
    // returned: null if genuinely unstated (engine.js calculates a
    // sensible date for these — see _classifyMultiDestinationLegs/
    // _continueOrchestration's independent-leg handling), or the
    // explicit date if the traveler gave one for that specific leg.
    departureDate: i === 0 ? topLevelDepartureDate : (leg.departureDate || null),
  }));

  // DEFENSIVE BACKFILL: a known misparse pattern (seen in production
  // logs) has the model put the traveler's stated origin on LEG 1's
  // own "origin" field instead of the top-level "origin" field the
  // schema asks for — e.g. top-level origin comes back null, but
  // legs[0].origin comes back "nairobi". Per the schema, leg 1 never
  // needs its own origin (the top-level field covers it), so if we
  // see this shape, recover the value rather than silently losing it
  // and forcing an unnecessary clarification question.
  let origin = parsed.origin || null;
  if (!origin && legs[0]?.origin) {
    origin = legs[0].origin;
    legs[0] = { ...legs[0], origin: null };
  }

  const needsOriginClarification = !origin;

  return {
    isMultiDestination: true,
    origin,
    legs,
    departureDate: topLevelDepartureDate,
    ..._normalizeOccupancy(parsed),
    budget: _sanitizeEnum(parsed.budget, ['low', 'mid', 'high', 'luxury'], 'mid'),
    accessibility: parsed.accessibility || false,
    preferredTransportProvider: _sanitizeFreeText(parsed.preferredTransportProvider),
    preferredHotel: _sanitizeFreeText(parsed.preferredHotel),
    preferences: _sanitizePreferences(parsed.preferences),
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