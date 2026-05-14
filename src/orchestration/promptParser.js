/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Converts natural language traveler prompts into structured
 * trip parameters the orchestration engine can work with.
 *
 * Input:  "Nairobi to Zanzibar, 2 people, mid-budget, last week of April"
 * Output: { origin: 'NBO', destination: 'ZNZ', passengers: 2, ... }
 *
 * This uses an LLM (Claude) to parse the prompt reliably.
 * We always validate the output before passing to the engine.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

// African city → airport/location code mapping
// Expand this as you add more corridors
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
  'masai mara': 'MRE', 'mara': 'MRE',
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
  'los angeles': 'LAX', 'la': 'LAX',
  'toronto': 'YYZ',
  'cancun': 'CUN',
  'mexico city': 'MEX',
  'sao paulo': 'GRU',
  'buenos aires': 'EZE',
  'bogota': 'BOG',
};

// Routes where bus is preferred/available over flight
const BUS_ROUTES = [
  ['NBO', 'MBA'], // Nairobi ↔ Mombasa
  ['NBO', 'KGL'], // Nairobi ↔ Kigali (via bus)
  ['NBO', 'EBB'], // Nairobi ↔ Kampala
];

/**
 * Parse a natural language prompt into structured trip parameters
 */
async function parsePrompt(prompt) {
  try {
    const parsed = await _parseWithLLM(prompt);
    return _enrichParams(parsed);
  } catch (error) {
    logger.warn('LLM parsing failed, falling back to rule-based parser', {
      error: error.message
    });
    const parsed = _parseWithRules(prompt);
    return _enrichParams(parsed); // Always enrich — this sets originCode, requiresFlight etc
  }
}

/**
 * Use Claude to parse the prompt — most accurate
 */
async function _parseWithLLM(prompt) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Extract trip details from this travel prompt and return ONLY valid JSON. No explanation, no markdown.

Prompt: "${prompt}"

Return JSON with these fields:
{
  "origin": "city name",
  "destination": "city name", 
  "departureDate": "YYYY-MM-DD or null",
  "returnDate": "YYYY-MM-DD or null",
  "passengers": number,
  "budget": "low|mid|high|luxury",
  "nights": number or null,
  "tripType": "round_trip|one_way",
  "preferences": []
}

Today's date: ${new Date().toISOString().split('T')[0]}
If dates are relative (e.g. "next month", "last week of April"), resolve them to actual dates.
If a field is not mentioned, use null for strings and 1 for passengers.`
      }]
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );

  const content = response.data.content[0].text;
  const cleaned = content.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

/**
 * Rule-based fallback parser
 */
function _parseWithRules(prompt) {
  const lower = prompt.toLowerCase();

  // Extract passengers
  const passengerMatch = lower.match(/(\d+)\s*(people|persons|passengers|adults|pax)/);
  const passengers = passengerMatch ? parseInt(passengerMatch[1]) : 1;

  // Extract budget
  let budget = 'mid';
  if (lower.includes('luxury') || lower.includes('5 star') || lower.includes('five star')) budget = 'luxury';
  else if (lower.includes('high budget') || lower.includes('premium') || lower.includes('business')) budget = 'high';
  else if (lower.includes('low budget') || lower.includes('budget') || lower.includes('cheap')) budget = 'low';
  else if (lower.includes('mid budget') || lower.includes('moderate')) budget = 'mid';

  // Extract cities
  let origin = null;
  let destination = null;
  for (const [city, code] of Object.entries(CITY_CODES)) {
    if (lower.includes(city)) {
      if (!origin) origin = city;
      else if (!destination) destination = city;
    }
  }

  // Extract nights
  const nightsMatch = lower.match(/(\d+)\s*(nights?|days?)/);
  const nights = nightsMatch ? parseInt(nightsMatch[1]) : 3;

  // Extract explicit date — supports formats like:
  // "24 April 2026", "April 24 2026", "24/04/2026", "2026-04-24"
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

/**
 * Extract an explicit date from the prompt
 */
function _extractDate(prompt) {
  const months = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
    jan: '01', feb: '02', mar: '03', apr: '04',
    jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };

  // Match "24 April 2026" or "April 24 2026"
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

  // Match "24/04/2026" or "04/24/2026"
  const slashMatch = prompt.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[1].padStart(2, '0')}`;
  }

  // Match ISO format "2026-04-24"
  const isoMatch = prompt.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return isoMatch[0];

  // Match just month + year e.g. "April 2026"
  const monthYearMatch = prompt.match(/(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i);
  if (monthYearMatch) {
    const month = months[monthYearMatch[1].toLowerCase()];
    return `${monthYearMatch[2]}-${month}-01`;
  }

  return null;
}

/**
 * Default departure date — 2 weeks from today
 */
function _defaultDepartureDate() {
  const date = new Date();
  date.setDate(date.getDate() + 14);
  return date.toISOString().split('T')[0];
}

/**
 * Enrich parsed params with derived values
 */
function _enrichParams(parsed) {
  const originCode = _resolveToCode(parsed.origin);
  const destinationCode = _resolveToCode(parsed.destination);

  // Determine transport type based on route
  const requiresBus = _isBusRoute(originCode, destinationCode);
  const requiresFlight = true; // Always search flights as primary option

  // Default nights if not specified
  const nights = parsed.nights || _defaultNights(parsed.departureDate, parsed.returnDate);

  // Set return date if not provided
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

// ── Helper functions ──────────────────────────────────────────

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
