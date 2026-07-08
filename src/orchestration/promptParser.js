/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Fixed: Added Year-2026 enforcement to System Prompt and 
 * Post-Processing Sanitization Layer.
 */

const Groq = require('groq-sdk');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// DATE NORMALIZATION HELPER
// ─────────────────────────────────────────────
function _normalizeYear(yearInput) {
  const currentYear = new Date().getFullYear();
  let yr = parseInt(yearInput, 10);
  if (yr < 100) yr += 2000;
  if (yr < currentYear) return currentYear;
  return yr;
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

const FILLER_WORDS = /\b(help|plan|me|us|vacation|trip|travel|book|want|need|would|like|going|visit|please|can|could|shall|lets|let's|arrange|organize|organise|find|sort|make|get|a|the|and|or|but|for|from|to|in|on|at|with|holiday|journey|getaway|adventure|safari|honeymoon|weekend|escape|tour|package|cheap|affordable|cheapest|best)\b/i;

function _isPlausiblePlaceName(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 4) return false;
  if (wordCount > 2 && FILLER_WORDS.test(trimmed)) return false;
  const firstWord = trimmed.split(/\s+/)[0].toLowerCase();
  if (/^(help|plan|book|find|get|arrange|organize|visit|travel|go|take|show|give|tell)$/.test(firstWord)) return false;
  return true;
}

// ─────────────────────────────────────────────
// DESTINATION NORMALIZER
// Fixes concatenated/abbreviated city names before
// they reach HotelBeds. Covers common cases worldwide.
// ─────────────────────────────────────────────
const DESTINATION_FIXES = {
  // South Africa
  'capetown': 'Cape Town', 'cape-town': 'Cape Town',
  'joburg': 'Johannesburg', 'jozi': 'Johannesburg', 'jhb': 'Johannesburg',
  'johanesburg': 'Johannesburg', 'johannesberg': 'Johannesburg',
  // East Africa
  'dar': 'Dar es Salaam', 'dares salaam': 'Dar es Salaam', 'daressalaam': 'Dar es Salaam',
  'addis': 'Addis Ababa', 'addisababa': 'Addis Ababa',
  'nbi': 'Nairobi', 'msa': 'Mombasa',
  'masaimara': 'Masai Mara', 'maasaimara': 'Masai Mara',
  // Middle East
  'sharmelshekh': 'Sharm el Sheikh', 'sharm': 'Sharm el Sheikh',
  'abudhabi': 'Abu Dhabi', 'abu-dhabi': 'Abu Dhabi',
  'kualalumpur': 'Kuala Lumpur', 'kl': 'Kuala Lumpur', 'kuala-lumpur': 'Kuala Lumpur',
  // Europe
  'newyork': 'New York', 'new-york': 'New York', 'nyc': 'New York',
  'losangeles': 'Los Angeles', 'la': 'Los Angeles', 'los-angeles': 'Los Angeles',
  'sanfrancisco': 'San Francisco', 'sf': 'San Francisco',
  'saopaulo': 'Sao Paulo', 'rio': 'Rio de Janeiro',
  'riodejaneiro': 'Rio de Janeiro',
  // Asia
  'hongkong': 'Hong Kong', 'hong-kong': 'Hong Kong', 'hk': 'Hong Kong',
  'koalumpur': 'Kuala Lumpur',
  'siemreap': 'Siem Reap', 'siem-reap': 'Siem Reap',
  'hochiminh': 'Ho Chi Minh City', 'hochiminhcity': 'Ho Chi Minh City',
  'phnompenh': 'Phnom Penh', 'phnom-penh': 'Phnom Penh',
  'costarica': 'San Jose',
  // General
  'uk': 'London', 'uae': 'Dubai',
};

function normalizeDestination(name) {
  if (!name) return name;
  // Remove spaces and lowercase for lookup
  const nospaces = name.toLowerCase().replace(/[\s-]/g, '');
  if (DESTINATION_FIXES[nospaces]) return DESTINATION_FIXES[nospaces];
  // Also try with original spacing lowercased
  const lower = name.toLowerCase().trim();
  if (DESTINATION_FIXES[lower]) return DESTINATION_FIXES[lower];
  return name;
}

// ─────────────────────────────────────────────
// DESTINATION NORMALIZER
// Fixes concatenated/abbreviated city names before
// they reach HotelBeds. Covers common cases worldwide.
// ─────────────────────────────────────────────


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

  if (destination) destination = resolveCountryToCity(destination.trim());

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

  // ── IMPROVED DATE PARSING ──────────────────
  let departureDate = null;
  const months = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
    january:1, february:2, march:3, april:4, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };
  
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
  if (departureDate && nights) {
    const dep = new Date(departureDate);
    dep.setDate(dep.getDate() + nights);
    returnDate = dep.toISOString().split('T')[0];
  }

  let budget = 'mid';
  if (/\b(luxury|premium|high.?end|5.?star|five.?star|splurge|lavish)\b/i.test(lower)) budget = 'luxury';
  else if (/\b(cheap(?:est)?|budget|affordable|low.?cost|economic|value|bei nafuu)\b/i.test(lower)) budget = 'low';
  else if (/\b(mid|moderate|reasonable|standard|normal|average)\b/i.test(lower)) budget = 'mid';
  else if (/\b(high|upscale|4.?star|four.?star|nice|good|quality)\b/i.test(lower)) budget = 'high';

  let outboundTransportMode = null;
  let returnTransportMode = null;
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

  const isHotelOnly = /\b(hotel only|just a hotel|only hotel|accommodation only|stay only)\b/i.test(lower);
  const needsOriginClarification = !origin && !isHotelOnly;
  
  return {
    destination, origin, nights: nights || null, passengers, children, childAges, budget,
    departureDate, returnDate, outboundTransportMode, returnTransportMode, mealPlan,
    seatPreference, timePreference, needsOriginClarification, isMultiDestination: false, legs: [],
    _parsedBy: 'rules',
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
ALWAYS assume the current year is 2026. If a user says a date like "August 19th", resolve it to "2026-08-19".
{
  "destination": "city/place", "origin": "city", "nights": number, "passengers": number, "children": number, "childAges": [],
  "budget": "low"|"mid"|"high"|"luxury", "departureDate": "YYYY-MM-DD", "returnDate": "YYYY-MM-DD",
  "outboundTransportMode": "flight"|"bus"|"train", "returnTransportMode": "flight"|"bus"|"train",
  "mealPlan": "all_inclusive"|... , "seatPreference": "window"|..., "timePreference": "morning"|...,
  "needsOriginClarification": boolean
}`;

async function _parseWithGroq(prompt) {
  if (!groqClient) return null;
  try {
    const completion = await groqClient.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: GROQ_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      temperature: 0.1, max_tokens: 500, response_format: { type: 'json_object' },
    });
    const content = completion.choices[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content);

    // ────────────────────────────────────────────────────────
    // SANITIZATION LAYER: Force current/future year (2026+)
    // ────────────────────────────────────────────────────────
    const currentYear = new Date().getFullYear();
    const sanitizeDate = (dateStr) => {
        if (!dateStr || typeof dateStr !== 'string') return dateStr;
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        if (d.getFullYear() < currentYear) {
            d.setFullYear(currentYear);
            return d.toISOString().split('T')[0];
        }
        return dateStr;
    };

    if (parsed.departureDate) parsed.departureDate = sanitizeDate(parsed.departureDate);
    if (parsed.returnDate) parsed.returnDate = sanitizeDate(parsed.returnDate);

    // Validate Place Name
    if (parsed.destination && !_isPlausiblePlaceName(parsed.destination)) return null;

    if (parsed.destination) parsed.destination = resolveCountryToCity(parsed.destination);
    if (parsed.origin) parsed.origin = resolveCountryToCity(parsed.origin);

    if (!parsed.origin) {
      const ruleResult = _parseWithRules(prompt);
      if (ruleResult.origin) parsed.origin = ruleResult.origin;
    }
    if (!parsed.destination) {
      const ruleResult = _parseWithRules(prompt);
      if (ruleResult.destination) parsed.destination = ruleResult.destination;
    }
    
    parsed._parsedBy = 'groq';
    return parsed;
  } catch (err) { return null; }
}

async function parsePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) return _parseWithRules('');
  const groqResult = await _parseWithGroq(prompt);
  if (groqResult) return groqResult;
  return _parseWithRules(prompt);
}

module.exports = { parsePrompt, resolveCountryToCity, normalizeDestination };
