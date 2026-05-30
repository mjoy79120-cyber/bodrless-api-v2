/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Converts natural language traveler prompts into structured
 * trip parameters the orchestration engine can work with.
 *
 * Supports: English, Swahili, shorthand, vague requests
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
  'diani': 'UKA', 'ukunda': 'UKA', 'diani beach': 'UKA',
  'masai mara': 'MRE', 'maasai mara': 'MRE', 'mara': 'MRE', 'masai': 'MRE',
  'amboseli': 'ASV',
  'kilifi': 'MBA',
  'naivasha': 'NBO', 'lake naivasha': 'NBO',
  'arusha': 'ARK',
  'serengeti': 'ARK',
  'ngorongoro': 'ARK',
  'lake victoria': 'KGL',
  'jinja': 'EBB',

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
  'kruger': 'HRE',

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

// Swahili → English destination mappings
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

async function parsePrompt(prompt) {
  try {
    const parsed = await _parseWithGemini(prompt);
    return _enrichParams(parsed);
  } catch (error) {
    logger.warn('Gemini parsing failed, falling back to rule-based parser', {
      error: error.message
    });
    const parsed = _parseWithRules(prompt);
    return _enrichParams(parsed);
  }
}

async function _parseWithGemini(prompt) {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [{
          text: `You are a travel booking assistant. Extract trip details from this prompt and return ONLY valid JSON with no explanation, no markdown, no code blocks.

Prompt: "${prompt}"

The prompt may be in English, Swahili, or mixed. Common Swahili travel words:
- "nataka kwenda" = I want to go to
- "safari" = trip/journey
- "usiku" = night(s)
- "watu/wenza" = people
- "bei nafuu" = budget/cheap
- "bei ya juu" = expensive/luxury
- "wiki ijayo" = next week
- "mwezi ujao" = next month

Return JSON:
{
  "origin": "full city name in lowercase (e.g. nairobi, cape town, zanzibar) or null if not mentioned",
  "destination": "full city name in lowercase — the place they want to VISIT",
  "departureDate": "YYYY-MM-DD or null",
  "returnDate": "YYYY-MM-DD or null",
  "passengers": number (default 1),
  "budget": "low|mid|high|luxury",
  "nights": number (default 3),
  "tripType": "round_trip|one_way",
  "preferences": ["beach", "safari", "culture", "adventure", "family", "honeymoon", "business"] (pick relevant ones)
}

RULES:
- NEVER use abbreviations — always full city names in lowercase
- origin = where they are coming FROM (often Nairobi if not mentioned for Kenyan context)
- destination = where they want to GO — this is the most important field
- If only one city mentioned, it is the destination; assume origin is nairobi
- "cape town" not "CPT", "zanzibar" not "ZNZ"
- Resolve relative dates: today is ${new Date().toISOString().split('T')[0]}
- "next week" → date 7 days from today
- "next month" → date 30 days from today  
- "christmas" → ${new Date().getFullYear()}-12-25
- "new year" → ${new Date().getFullYear() + 1}-01-01
- If budget not mentioned, use "mid"
- If nights not mentioned but days mentioned, subtract 1
- For "weekend" use nights: 2
- For "week" use nights: 7`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 600,
      }
    },
    {
      headers: { 'Content-Type': 'application/json' }
    }
  );

  const content = response.data.candidates[0].content.parts[0].text;
  const cleaned = content.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);

  // If no origin, default to nairobi
  if (!parsed.origin) parsed.origin = 'nairobi';

  return parsed;
}

function _parseWithRules(prompt) {
  let lower = prompt.toLowerCase().trim();

  // Translate Swahili destination hints
  for (const [swahili, english] of Object.entries(SWAHILI_DESTINATIONS)) {
    lower = lower.replace(swahili, english);
  }

  // Swahili passenger patterns
  const swahiliPassengerMatch = lower.match(/(\d+)\s*(watu|wenza|watu\s*wawili)/);
  const passengerMatch = lower.match(/(\d+)\s*(people|persons|passengers|adults|pax|travelers?|travellers?)/);
  const passengers = swahiliPassengerMatch
    ? parseInt(swahiliPassengerMatch[1])
    : passengerMatch
      ? parseInt(passengerMatch[1])
      : lower.includes('wawili') || lower.includes('sisi wawili') ? 2
      : lower.includes('familia') || lower.includes('family') ? 4
      : 1;

  // Budget
  let budget = 'mid';
  if (lower.match(/luxury|5[\s-]?star|five[\s-]?star|premium|first[\s-]?class/)) budget = 'luxury';
  else if (lower.match(/high[\s-]?budget|business[\s-]?class|expensive/)) budget = 'high';
  else if (lower.match(/low[\s-]?budget|cheap|budget|affordable|bei[\s-]?nafuu|economy/)) budget = 'low';
  else if (lower.match(/mid[\s-]?budget|moderate|reasonable/)) budget = 'mid';

  // Nights
  const nightsMatch = lower.match(/(\d+)\s*(nights?|usiku|giku)/);
  const daysMatch = lower.match(/(\d+)\s*(days?|siku)/);
  const nights = nightsMatch
    ? parseInt(nightsMatch[1])
    : daysMatch
      ? parseInt(daysMatch[1]) - 1
      : lower.includes('weekend') ? 2
      : lower.includes('week') && !lower.includes('next week') ? 7
      : 3;

  // Sort longest first to avoid partial matches
  const sortedCities = Object.keys(CITY_CODES).sort((a, b) => b.length - a.length);
  let origin = null;
  let destination = null;

  // Pattern: "from X to Y" or "X to Y" or "nataka kwenda Y"
  const fromToMatch = lower.match(/(?:from\s+)?([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s*[,\d]|$)/);
  const kwendaMatch = lower.match(/(?:nataka\s+kwenda|kwenda|going\s+to|travel\s+to|trip\s+to|visit)\s+([a-z\s]+?)(?:\s*[,\d]|$)/);

  if (fromToMatch) {
    const fromCity = fromToMatch[1].trim();
    const toCity = fromToMatch[2].trim();
    for (const city of sortedCities) {
      if (fromCity.includes(city) && !origin) origin = city;
      if (toCity.includes(city) && !destination) destination = city;
    }
  }

  if (kwendaMatch && !destination) {
    const toCity = kwendaMatch[1].trim();
    for (const city of sortedCities) {
      if (toCity.includes(city)) { destination = city; break; }
    }
  }

  // Fallback: pick cities found in text
  if (!destination) {
    for (const city of sortedCities) {
      if (lower.includes(city)) {
        if (!origin) origin = city;
        else if (city !== origin) { destination = city; break; }
      }
    }
    // Swap if only one found — it's the destination
    if (origin && !destination) { destination = origin; origin = null; }
  }

  // Default origin to nairobi for Kenyan context
  if (!origin) origin = 'nairobi';

  // Preferences
  const preferences = [];
  if (lower.match(/beach|coast|ocean|bahari|pwani/)) preferences.push('beach');
  if (lower.match(/safari|game|wildlife|mara|serengeti|wanyama/)) preferences.push('safari');
  if (lower.match(/honeymoon|romantic|anniversary|mapenzi/)) preferences.push('honeymoon');
  if (lower.match(/family|kids|children|watoto|familia/)) preferences.push('family');
  if (lower.match(/adventure|hiking|climb|mountain|mlima/)) preferences.push('adventure');
  if (lower.match(/culture|history|museum|utamaduni/)) preferences.push('culture');
  if (lower.match(/business|conference|meeting|mkutano/)) preferences.push('business');

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
  };
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

  // "last week of April" → last 7 days of that month
  const lastWeekMatch = prompt.match(/last\s+week\s+of\s+(january|february|march|april|may|june|july|august|september|october|november|december)/i);
  if (lastWeekMatch) {
    const month = months[lastWeekMatch[1].toLowerCase()];
    const year = new Date().getFullYear();
    return `${year}-${month}-22`;
  }

  const slashMatch = prompt.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[1].padStart(2, '0')}`;
  }

  const isoMatch = prompt.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  const monthYearMatch = prompt.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i);
  if (monthYearMatch) {
    const month = months[monthYearMatch[1].toLowerCase()];
    return `${monthYearMatch[2]}-${month}-01`;
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
  if (prompt.includes('christmas')) {
    return `${now.getFullYear()}-12-25`;
  }
  if (prompt.match(/new\s+year/)) {
    return `${now.getFullYear() + 1}-01-01`;
  }
  if (prompt.match(/easter/)) {
    return `${now.getFullYear()}-04-20`;
  }

  return null;
}

function _enrichParams(parsed) {
  const originCode = _resolveToCode(parsed.origin);
  const destinationCode = _resolveToCode(parsed.destination);

  const requiresBus = _isBusRoute(originCode, destinationCode);
  const requiresFlight = true;

  const nights = parsed.nights || _defaultNights(parsed.departureDate, parsed.returnDate);

  const returnDate = parsed.returnDate ||
    (parsed.departureDate ? _addDays(parsed.departureDate, nights) : null);

  return {
    ...parsed,
    originCode,
    destinationCode,
    origin: parsed.origin,
    destination: parsed.destination,
    nights,
    returnDate,
    requiresFlight,
    requiresBus,
    passengers: parsed.passengers || 1,
    budget: parsed.budget || 'mid',
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