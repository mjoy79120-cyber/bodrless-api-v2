/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Converts natural language traveler prompts into structured
 * trip parameters the orchestration engine can work with.
 *
 * Input:  "Nairobi to Zanzibar, 2 people, mid-budget, last week of April"
 * Output: { origin: 'NBO', destination: 'ZNZ', passengers: 2, ... }
 *
 * Uses Google Gemini to parse the prompt reliably.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

const CITY_CODES = {
  // EAST AFRICA
  'nairobi': 'NBO', 'nbo': 'NBO',
  'mombasa': 'MBA', 'mba': 'MBA',
  'zanzibar': 'ZNZ', 'znz': 'ZNZ',
  'dar es salaam': 'DAR', 'dar': 'DAR',
  'kigali': 'KGL', 'kgl': 'KGL',
  'kampala': 'EBB', 'entebbe': 'EBB',
  'addis ababa': 'ADD', 'add': 'ADD',
  'diani': 'UKA', 'ukunda': 'UKA',
  'masai mara': 'MRE', 'maasai mara': 'MRE', 'mara': 'MRE',
  'amboseli': 'ASV',
  'kilifi': 'MBA',
  'naivasha': 'NBO',
  'arusha': 'ARK',

  // WEST AFRICA
  'lagos': 'LOS', 'los': 'LOS',
  'accra': 'ACC', 'acc': 'ACC',
  'dakar': 'DKR',
  'abidjan': 'ABJ',
  'douala': 'DLA',

  // SOUTHERN AFRICA
  'johannesburg': 'JNB', 'jnb': 'JNB', 'joburg': 'JNB', 'jozi': 'JNB',
  'cape town': 'CPT', 'cpt': 'CPT',
  'victoria falls': 'VFA',
  'livingstone': 'LVI',
  'lusaka': 'LUN',
  'harare': 'HRE',

  // NORTH AFRICA
  'cairo': 'CAI', 'cai': 'CAI',
  'casablanca': 'CMN', 'cmn': 'CMN',
  'marrakech': 'RAK',
  'tunis': 'TUN',

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
  'kuala lumpur': 'KUL',
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
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [{
          text: `Extract trip details from this travel prompt and return ONLY valid JSON. No explanation, no markdown, no code blocks.

Prompt: "${prompt}"

Return JSON with these fields:
{
  "origin": "full city name in lowercase (e.g. nairobi, cape town, zanzibar)",
  "destination": "full city name in lowercase (e.g. nairobi, cape town, zanzibar)",
  "departureDate": "YYYY-MM-DD or null",
  "returnDate": "YYYY-MM-DD or null",
  "passengers": number,
  "budget": "low|mid|high|luxury",
  "nights": number or null,
  "tripType": "round_trip|one_way",
  "preferences": []
}

IMPORTANT:
- Always use full city names, never abbreviations or codes (not "LA", use "los angeles"; not "CPT", use "cape town")
- origin and destination must be full city names in lowercase
- origin is where the traveler is coming FROM, destination is where they want to GO
- Today's date: ${new Date().toISOString().split('T')[0]}
- If dates are relative (e.g. "next month", "last week of April"), resolve them to actual dates.
- If a field is not mentioned, use null for strings and 1 for passengers.`
        }]
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 500,
      }
    },
    {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

  const content = response.data.candidates[0].content.parts[0].text;
  const cleaned = content.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

function _parseWithRules(prompt) {
  const lower = prompt.toLowerCase();

  const passengerMatch = lower.match(/(\d+)\s*(people|persons|passengers|adults|pax)/);
  const passengers = passengerMatch ? parseInt(passengerMatch[1]) : 1;

  let budget = 'mid';
  if (lower.includes('luxury') || lower.includes('5 star') || lower.includes('five star')) budget = 'luxury';
  else if (lower.includes('high budget') || lower.includes('premium') || lower.includes('business')) budget = 'high';
  else if (lower.includes('low budget') || lower.includes('budget') || lower.includes('cheap')) budget = 'low';
  else if (lower.includes('mid budget') || lower.includes('moderate')) budget = 'mid';

  // Sort longest first to avoid partial matches
  const sortedCities = Object.keys(CITY_CODES).sort((a, b) => b.length - a.length);
  let origin = null;
  let destination = null;

  // Look for "from X to Y" pattern first
  const fromToMatch = lower.match(/from\s+([a-z\s]+?)\s+to\s+([a-z\s]+?)(?:\s*,|\s*\d|$)/);
  if (fromToMatch) {
    const fromCity = fromToMatch[1].trim();
    const toCity = fromToMatch[2].trim();
    for (const city of sortedCities) {
      if (fromCity.includes(city) && !origin) origin = city;
      if (toCity.includes(city) && !destination) destination = city;
    }
  }

  // Fallback: pick first two cities found
  if (!origin || !destination) {
    for (const city of sortedCities) {
      if (lower.includes(city)) {
        if (!origin) origin = city;
        else if (!destination && city !== origin) {
          destination = city;
          break;
        }
      }
    }
  }

  const nightsMatch = lower.match(/(\d+)\s*(nights?|days?)/);
  const nights = nightsMatch ? parseInt(nightsMatch[1]) : 3;

  const departureDate = _extractDate(lower) || _resolveRelativeDate(lower) || _defaultDepartureDate();

  return {
    origin,
    destination,
    departureDate,
    returnDate: null,
    passengers,
    budget,
    nights,
    tripType: lower.includes('one way') ? 'one_way' : 'round_trip',
    preferences: [],
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
  const lower = city.toLowerCase();
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

function _resolveRelativeDate(prompt) {
  const now = new Date();
  if (prompt.includes('next month')) {
    now.setMonth(now.getMonth() + 1);
    return now.toISOString().split('T')[0];
  }
  if (prompt.includes('next week')) {
    now.setDate(now.getDate() + 7);
    return now.toISOString().split('T')[0];
  }
  return null;
}

module.exports = { parsePrompt };