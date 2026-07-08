/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Converts a freeform WhatsApp/widget travel request into
 * structured tripParams. Two-tier approach:
 *
 *   1. Groq LLM (primary) — handles natural language well, but
 *      can hallucinate or return the whole sentence as a field.
 *      All results go through a sanity-check gate before use.
 *
 *   2. Rule-based fallback (_parseWithRules) — fires when Groq
 *      fails/times out OR when the sanity check rejects Groq's
 *      output. Regex-based, predictable, zero hallucination risk.
 *
 * BUG FIXES (found via a real WhatsApp test, 2026-07-06):
 *   - Groq was returning the ENTIRE prompt as `destination` for
 *     phrasing like "help me plan a vacation in Zanzibar from
 *     Nairobi" — the sanity check now detects this (>3 words, or
 *     contains filler/verb words) and falls back to the rule parser
 *     instead of accepting a sentence as a place name.
 *   - The rule parser's "from X" origin pattern had a lookahead
 *     that required a keyword AFTER the origin city, so "from
 *     nairobi" at the end of a sentence was never matched. Fixed.
 *   - The rule parser had no "in X" destination pattern at all —
 *     "vacation in Zanzibar", "holiday in Cape Town", "stay in
 *     Maldives" all fell through to null. Added.
 * ─────────────────────────────────────────────────────────────
 */

const Groq = require('groq-sdk');
const { logger } = require('../utils/logger');

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
};

const CITY_CODES = {
  'nairobi': 'NBO', 'mombasa': 'MBA', 'kisumu': 'KIS', 'eldoret': 'EDL',
  'lamu': 'LAU', 'malindi': 'MYD', 'diani': 'UKA', 'ukunda': 'UKA',
  'zanzibar': 'ZNZ', 'dar es salaam': 'DAR', 'kilimanjaro': 'JRO',
  'arusha': 'ARK', 'mwanza': 'MWZ', 'kampala': 'EBB', 'entebbe': 'EBB',
  'kigali': 'KGL', 'addis ababa': 'ADD', 'johannesburg': 'JNB',
  'cape town': 'CPT', 'durban': 'DUR', 'cairo': 'CAI',
  'sharm el sheikh': 'SSH', 'hurghada': 'HRG', 'marrakech': 'RAK',
  'casablanca': 'CMN', 'accra': 'ACC', 'lagos': 'LOS', 'abuja': 'ABV',
  'mahe': 'SEZ', 'port louis': 'MRU', 'male': 'MLE',
  'antananarivo': 'TNR', 'harare': 'HRE', 'lusaka': 'LUN',
  'windhoek': 'WDH', 'maputo': 'MPM', 'luanda': 'LAD',
  'bali': 'DPS', 'denpasar': 'DPS', 'phuket': 'HKT', 'bangkok': 'BKK',
  'chiang mai': 'CNX', 'singapore': 'SIN', 'kuala lumpur': 'KUL',
  'delhi': 'DEL', 'mumbai': 'BOM', 'goa': 'GOI',
  'tokyo': 'TYO', 'osaka': 'KIX', 'paris': 'CDG', 'amsterdam': 'AMS',
  'istanbul': 'IST', 'doha': 'DOH', 'abu dhabi': 'AUH', 'muscat': 'MCT',
  'dubai': 'DXB', 'london': 'LHR', 'new york': 'JFK',
  'los angeles': 'LAX', 'miami': 'MIA', 'cancun': 'CUN',
  'sydney': 'SYD', 'auckland': 'AKL',
  'santorini': 'JTR', 'mykonos': 'JMK', 'athens': 'ATH',
  'barcelona': 'BCN', 'madrid': 'MAD', 'rome': 'FCO',
  'masai mara': 'MRE', 'maasai mara': 'MRE', 'amboseli': 'ASV',
  'samburu': 'UAS', 'tsavo': 'MBA', 'serengeti': 'JRO',
  'ngorongoro': 'JRO', 'pemba': 'PMA', 'mafia': 'MFA',
  'praslin': 'SEZ', 'grand baie': 'MRU', 'four seasons': null,
};

// ─────────────────────────────────────────────
// GROQ RESULT SANITY CHECK
// BUG FIX (2026-07-06): Groq sometimes returns the ENTIRE user
// prompt as `destination` for conversational phrasing like "help me
// plan a vacation in Zanzibar from Nairobi". A real place name is
// at most 3 words and contains no filler verbs/nouns. When the
// sanity check fails, the LLM result is discarded and the rule
// parser runs instead — zero hallucination risk, predictable output.
// ─────────────────────────────────────────────
const FILLER_WORDS = /\b(help|plan|me|us|vacation|trip|travel|book|want|need|would|like|going|visit|please|can|could|shall|lets|let's|arrange|organize|organise|find|sort|make|get|a|the|and|or|but|for|from|to|in|on|at|with|holiday|journey|getaway|adventure|safari|honeymoon|weekend|escape|tour|package|cheap|affordable|cheapest|best)\b/i;

function _isPlausiblePlaceName(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 4) return false;
  if (wordCount > 2 && FILLER_WORDS.test(trimmed)) return false;
  // A place name shouldn't start with a verb or filler word
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (/^(help|plan|book|find|get|arrange|organize|visit|travel|go|take|show|give|tell)$/.test(firstWord)) return false;
  return true;
}

function resolveCountryToCity(name) {
  if (!name) return name;
  const lower = name.toLowerCase().trim();
  return COUNTRY_TO_CITY[lower] || name;
}

// ─────────────────────────────────────────────
// RULE-BASED PARSER
// Deterministic fallback — fires when Groq fails OR when its output
// fails the sanity check. Handles the most common East African
// travel phrasing patterns with zero hallucination risk.
// ─────────────────────────────────────────────
function _parseWithRules(prompt) {
  const lower = prompt.toLowerCase().trim();

  // Strip conversational intent prefixes before extraction so they
  // don't interfere with place-name matching. E.g. "help me plan a
  // vacation in Zanzibar" → "in Zanzibar" after stripping.
  const INTENT_STRIP = /^(?:(?:can you |please |could you |i want to |i'?d like to |i would like to |help me |i need |arrange |book me |find me |plan me |plan a |sort out |organize |organise |i'?m (?:looking|thinking|planning)|we |let'?s )+)(?:a |an |my |the )?(?:(?:trip|vacation|holiday|travel|journey|getaway|adventure|safari|honeymoon|weekend(?: away)?|city break|tour|package)\s+)?/i;
  const stripped = lower.replace(INTENT_STRIP, '').trim() || lower;

  // ── DESTINATION ────────────────────────────
  // Tried in priority order — first match wins.
  let destination = null;

  // 1. "X to Y" at the start (e.g. "Nairobi to Zanzibar")
  const simpleRoute = lower.match(/^([a-z][a-z\s]{1,20}?)\s+to\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|and|\d)|[,.]|$)/i);
  if (simpleRoute) {
    destination = simpleRoute[2].trim();
  }

  // 2. "to X" pattern (most common: "trip to Zanzibar")
  if (!destination) {
    const toMatch = (stripped || lower).match(/\bto\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|and|\d)|[,.]|$)/i);
    if (toMatch) destination = toMatch[1].trim();
  }

  // 3. BUG FIX (2026-07-06): "vacation/holiday/stay IN X" pattern
  // was completely missing — this is the exact phrasing that caused
  // Groq to return the whole sentence as destination, then the rule
  // fallback to also return null. Now explicitly handled.
  if (!destination) {
    const inMatch = (stripped || lower).match(/\b(?:in|visiting|visit)\s+([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|with|and|\d)|[,.]|$)/i);
    if (inMatch) destination = inMatch[1].trim();
  }

  // 4. After stripping, the first thing left is likely the destination
  // (e.g. "plan me a trip [stripped] → 'to zanzibar from nairobi'"
  //   OR  "help me plan a vacation [stripped] → 'in zanzibar from nairobi'")
  if (!destination && stripped && stripped !== lower) {
    const firstWordMatch = stripped.match(/^(?:to\s+|in\s+|for\s+)?([a-z][a-z\s]{1,25}?)(?=\s+(?:from|for|on|in|with|\d)|[,.]|$)/i);
    if (firstWordMatch && _isPlausiblePlaceName(firstWordMatch[1])) {
      destination = firstWordMatch[1].trim();
    }
  }

  // Resolve country names to their main city
  if (destination) destination = resolveCountryToCity(destination.trim());

  // ── ORIGIN ────────────────────────────────
  // BUG FIX (2026-07-06): the old pattern required a keyword AFTER
  // the origin city (e.g. "from nairobi TO/ON/FOR/IN"), so "from
  // nairobi" at the END of a sentence was never matched. Now uses a
  // lookahead that also matches end-of-string and digits (nights count
  // often follows the origin), and limits the city name to 1-3 words
  // to prevent greedy matching that consumed extra words.
  let origin = null;

  // "X to Y" route — origin is X
  if (simpleRoute) {
    origin = simpleRoute[1].trim();
  }

  // "from X" anywhere in the sentence
  if (!origin) {
    const fromMatch = lower.match(/\bfrom\s+((?:[a-z]+(?:\s+[a-z]+){0,2}?))(?=\s+(?:to|on|for|in|with|and|\d)|[,.]|$)/i);
    if (fromMatch) {
      const candidate = fromMatch[1].trim();
      // Guard: exclude filler words that are not place names
      const notAPlace = /^(me|us|a|the|my|our|here|there|home|anywhere|2|3|4|5|6|7|8|9|people|persons|adults|travelers?)$/i.test(candidate);
      if (!notAPlace) origin = candidate;
    }
  }

  // Resolve country names to their main city
  if (origin) origin = resolveCountryToCity(origin.trim());

  // Don't return origin == destination (can happen with greedy matches)
  if (origin && destination && origin.toLowerCase() === destination.toLowerCase()) {
    origin = null;
  }

  // ── NIGHTS ────────────────────────────────
  let nights = null;
  const nightsMatch = lower.match(/(\d+)\s*(?:night|nights|nts?)\b/i);
  if (nightsMatch) nights = parseInt(nightsMatch[1], 10);

  // ── PASSENGERS ────────────────────────────
  let passengers = 1;
  const passMatch = lower.match(/(\d+)\s*(?:people|persons|pax|adults?|travelers?|of us|guests?|passengers?)\b/i);
  if (passMatch) passengers = Math.max(1, parseInt(passMatch[1], 10));
  // "couple", "two of us", "2 of us"
  if (/\b(?:couple|two of us|2 of us)\b/i.test(lower)) passengers = Math.max(passengers, 2);
  // "family" → at least 2
  if (/\bfamily\b/i.test(lower) && passengers < 2) passengers = 2;

  // ── CHILDREN ──────────────────────────────
  let children = 0;
  let childAges = [];
  const childMatch = lower.match(/(\d+)\s*(?:child(?:ren)?|kid(?:s)?|minor(?:s)?)\b/i);
  if (childMatch) children = parseInt(childMatch[1], 10);
  const ageMatches = lower.match(/(?:age(?:d)?|aged?)\s*(\d{1,2})(?:\s*(?:and|&|,)\s*(\d{1,2}))?/gi) || [];
  ageMatches.forEach(m => {
    const nums = m.match(/\d{1,2}/g) || [];
    nums.forEach(n => { const age = parseInt(n, 10); if (age < 18 && age >= 0) childAges.push(age); });
  });

  // ── DEPARTURE DATE ────────────────────────
  let departureDate = null;
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
    january:1, february:2, march:3, april:4, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
  const dateMatch = lower.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s*(?:(\d{4})|(\d{2}))?/i)
    || lower.match(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?/i);
  if (dateMatch) {
    const year = new Date().getFullYear();
    let day, month, yr;
    if (/^\d/.test(dateMatch[1] || '')) {
      day = parseInt(dateMatch[1], 10);
      const mKey = (dateMatch[2] || '').toLowerCase().slice(0, 3);
      month = months[mKey] || months[(dateMatch[2] || '').toLowerCase()];
      yr = parseInt(dateMatch[3] || dateMatch[4] || year, 10);
    } else {
      const mKey = (dateMatch[1] || '').toLowerCase().slice(0, 3);
      month = months[mKey] || months[(dateMatch[1] || '').toLowerCase()];
      day = parseInt(dateMatch[2], 10);
      yr = parseInt(dateMatch[3] || year, 10);
    }
    if (yr < 100) yr += 2000;
    if (day && month) {
      departureDate = `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // ISO date (YYYY-MM-DD)
  if (!departureDate) {
    const isoMatch = lower.match(/(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) departureDate = isoMatch[1];
  }

  // "next week", "this weekend", "tomorrow"
  if (!departureDate) {
    const today = new Date();
    if (/next week/i.test(lower)) {
      today.setDate(today.getDate() + 7);
      departureDate = today.toISOString().split('T')[0];
    } else if (/this weekend/i.test(lower)) {
      const day = today.getDay();
      today.setDate(today.getDate() + (6 - day));
      departureDate = today.toISOString().split('T')[0];
    } else if (/tomorrow/i.test(lower)) {
      today.setDate(today.getDate() + 1);
      departureDate = today.toISOString().split('T')[0];
    }
  }

  // ── RETURN DATE ───────────────────────────
  let returnDate = null;
  if (departureDate && nights) {
    const dep = new Date(departureDate);
    dep.setDate(dep.getDate() + nights);
    returnDate = dep.toISOString().split('T')[0];
  }

  // ── BUDGET ────────────────────────────────
  let budget = 'mid';
  if (/\b(luxury|premium|high.?end|5.?star|five.?star|splurge|lavish)\b/i.test(lower)) budget = 'luxury';
  else if (/\b(cheap(?:est)?|budget|affordable|low.?cost|economic|value|bei nafuu)\b/i.test(lower)) budget = 'low';
  else if (/\b(mid|moderate|reasonable|standard|normal|average)\b/i.test(lower)) budget = 'mid';
  else if (/\b(high|upscale|4.?star|four.?star|nice|good|quality)\b/i.test(lower)) budget = 'high';

  // ── TRANSPORT MODE ────────────────────────
  let outboundTransportMode = null;
  let returnTransportMode = null;
  if (/\bflight|fly|flying\b/i.test(lower)) outboundTransportMode = 'flight';
  else if (/\bbus|coach\b/i.test(lower)) outboundTransportMode = 'bus';
  else if (/\btrain|sgr|madaraka\b/i.test(lower)) outboundTransportMode = 'train';

  // ── MEAL PLAN ─────────────────────────────
  let mealPlan = null;
  if (/\ball.?inclusive\b/i.test(lower)) mealPlan = 'all_inclusive';
  else if (/\bfull.?board\b/i.test(lower)) mealPlan = 'full_board';
  else if (/\bhalf.?board\b/i.test(lower)) mealPlan = 'half_board';
  else if (/\bbed.?and.?breakfast|b.?&.?b|b&b\b/i.test(lower)) mealPlan = 'bed_and_breakfast';
  else if (/\broom.?only|self.?catering\b/i.test(lower)) mealPlan = 'room_only';
  else if (/\bbreakfast\b/i.test(lower)) mealPlan = 'bed_and_breakfast';

  // ── SEAT PREFERENCE ───────────────────────
  let seatPreference = null;
  if (/\bwindow\s+seat\b/i.test(lower)) seatPreference = 'window';
  else if (/\baisle\s+seat\b/i.test(lower)) seatPreference = 'aisle';
  else if (/\bexit\s+row\b/i.test(lower)) seatPreference = 'exit_row';

  // ── TIME PREFERENCE ───────────────────────
  let timePreference = null;
  if (/\b(morning|early)\s+flight\b/i.test(lower)) timePreference = 'morning';
  else if (/\b(evening|night)\s+flight\b/i.test(lower)) timePreference = 'evening';
  else if (/\bafternoon\s+flight\b/i.test(lower)) timePreference = 'afternoon';

  // ── NEEDS ORIGIN CLARIFICATION ────────────
  // Omit asking for origin if it's a hotel-only request (no transport
  // involved) — same fix already applied in engine.js.
  const isHotelOnly = /\b(hotel only|just a hotel|only hotel|accommodation only|stay only)\b/i.test(lower);
  const needsOriginClarification = !origin && !isHotelOnly;

  // ── MULTI-DESTINATION ─────────────────────
  // Basic multi-destination detection: "X then Y", "X and then Y",
  // "X followed by Y" — kept simple here, engine.js handles the
  // full classification/routing.
  let isMultiDestination = false;
  let legs = [];
  const multiMatch = lower.match(/(.+?)\s+(?:then|and then|followed by|before)\s+(.+)/i);
  if (multiMatch && !simpleRoute) {
    isMultiDestination = true;
    // Let engine.js parse the individual legs — just flag it here
    legs = [];
  }

  return {
    destination,
    origin,
    nights: nights || null,
    passengers,
    children,
    childAges,
    budget,
    departureDate,
    returnDate,
    outboundTransportMode,
    returnTransportMode,
    mealPlan,
    seatPreference,
    timePreference,
    needsOriginClarification,
    isMultiDestination,
    legs,
    _parsedBy: 'rules',
  };
}

// ─────────────────────────────────────────────
// GROQ LLM PARSER
// ─────────────────────────────────────────────
let groqClient = null;
try {
  if (process.env.GROQ_API_KEY) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
} catch (e) {
  logger.warn('Groq client init failed', { error: e.message });
}

const GROQ_SYSTEM_PROMPT = `You are a travel intent parser for an East African travel platform. Extract structured trip information from user messages.

Return ONLY valid JSON with these exact fields (use null for anything not mentioned):
{
  "destination": "city or place name ONLY — NOT a whole sentence. E.g. 'Zanzibar', 'Cape Town', 'Masai Mara'. If you cannot identify a clear single destination, return null.",
  "origin": "departure city name only, e.g. 'Nairobi'. Return null if not mentioned.",
  "nights": number or null,
  "passengers": number (default 1),
  "children": number (default 0),
  "childAges": array of numbers,
  "budget": "low" | "mid" | "high" | "luxury" | null,
  "departureDate": "YYYY-MM-DD" or null,
  "returnDate": "YYYY-MM-DD" or null,
  "outboundTransportMode": "flight" | "bus" | "train" | null,
  "returnTransportMode": "flight" | "bus" | "train" | null,
  "mealPlan": "all_inclusive" | "full_board" | "half_board" | "bed_and_breakfast" | "room_only" | null,
  "seatPreference": "window" | "aisle" | "exit_row" | null,
  "timePreference": "morning" | "afternoon" | "evening" | null,
  "isMultiDestination": boolean,
  "legs": array of {destination, nights, origin} objects for multi-destination trips,
  "preferredTransportProvider": "airline or bus company name" | null,
  "preferredHotel": "hotel name" | null,
  "needsOriginClarification": boolean
}

CRITICAL: destination must be a real place name (1-4 words max). Never return a sentence or phrase as the destination. If the user says "help me plan a vacation in Zanzibar", destination is "Zanzibar", NOT "help me plan a vacation in Zanzibar".`;

async function _parseWithGroq(prompt) {
  if (!groqClient) return null;

  try {
    const completion = await groqClient.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: GROQ_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);

    // ─────────────────────────────────────────
    // SANITY CHECK — BUG FIX (2026-07-06)
    // If Groq's destination doesn't look like a real place name,
    // discard the whole result and fall back to the rule parser.
    // The system prompt already instructs Groq to return only place
    // names, but this is a hard safety net in case it still doesn't.
    // ─────────────────────────────────────────
    if (parsed.destination && !_isPlausiblePlaceName(parsed.destination)) {
      logger.warn('Groq returned an implausible destination — discarding and falling back to rule parser', {
        returnedDestination: parsed.destination?.slice(0, 80),
        prompt: prompt.slice(0, 100),
      });
      return null; // triggers rule-parser fallback in parsePrompt()
    }

    // Resolve country names
    if (parsed.destination) parsed.destination = resolveCountryToCity(parsed.destination);
    if (parsed.origin) parsed.origin = resolveCountryToCity(parsed.origin);

    // If Groq gave us a destination but no origin for a trip that
    // clearly states "from X", the rule parser likely extracted it
    // correctly — merge it in rather than asking a clarification
    // question unnecessarily.
    if (!parsed.origin) {
      const ruleResult = _parseWithRules(prompt);
      if (ruleResult.origin) {
        parsed.origin = ruleResult.origin;
        logger.info('Groq missed origin — filled from rule parser', { origin: parsed.origin });
      }
    }

    // Same for destination — if Groq returned null but rules found one
    if (!parsed.destination) {
      const ruleResult = _parseWithRules(prompt);
      if (ruleResult.destination) {
        parsed.destination = ruleResult.destination;
        logger.info('Groq missed destination — filled from rule parser', { destination: parsed.destination });
      }
    }

    parsed._parsedBy = 'groq';
    return parsed;

  } catch (err) {
    logger.warn('Groq parsing failed — falling back to rule parser', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────
async function parsePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return _parseWithRules('');
  }

  // Try Groq first; fall back to rules if it fails or returns
  // something that fails the sanity check.
  const groqResult = await _parseWithGroq(prompt);
  if (groqResult) {
    logger.info('Prompt parsed via Groq', { destination: groqResult.destination, origin: groqResult.origin });
    return groqResult;
  }

  logger.info('Falling back to rule-based parser', { prompt: prompt.slice(0, 80) });
  const ruleResult = _parseWithRules(prompt);

  // Final safety net: if even the rule parser couldn't find a
  // destination, return what we have — engine.js will detect null
  // destination and ask a clarification question instead of crashing.
  return ruleResult;
}

module.exports = { parsePrompt, resolveCountryToCity };