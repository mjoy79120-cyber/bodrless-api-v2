/**
 * PROMPT PARSER
 * ─────────────────────────────────────────────────────────────
 * Converts natural language traveler prompts into structured
 * trip parameters the orchestration engine can work with.
 *
 * Supports: English, Swahili, shorthand, vague requests,
 *           accessibility needs, meal plans, seat preferences,
 *           train classes, bus seat selection, time preferences
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

// ─────────────────────────────────────────────
// SEAT POSITION MAPPING FOR BUSES
// When Travler integration is live, these map
// to actual seat numbers from the seat map
// ─────────────────────────────────────────────
const BUS_SEAT_POSITIONS = {
  // Window seats — typically A and D columns
  window: {
    preference: 'window',
    columns: ['A', 'D'],
    note: 'Window seat requested — will select from A or D column when seat map is available'
  },
  // Aisle seats — typically B and C columns
  aisle: {
    preference: 'aisle',
    columns: ['B', 'C'],
    note: 'Aisle seat requested — will select from B or C column when seat map is available'
  },
  // Front seats — rows 1-5
  front: {
    preference: 'front',
    rows: [1, 2, 3, 4, 5],
    note: 'Front seat requested — will select from rows 1-5 when seat map is available'
  },
  // Back seats — rows 10+
  back: {
    preference: 'back',
    rows: [10, 11, 12, 13, 14],
    note: 'Back seat requested — will select from rows 10+ when seat map is available'
  },
};

async function parsePrompt(prompt) {
  try {
    const parsed = await _parseWithGemini(prompt);

    // Always run local detection on top of LLM result
    parsed.accessibility = _detectAccessibility(prompt);
    parsed.seatPreference = parsed.seatPreference || _detectSeatPreference(prompt);
    parsed.mealPlan = parsed.mealPlan || _detectMealPlan(prompt);
    parsed.trainClass = parsed.trainClass || _detectTrainClass(prompt);
    parsed.timePreference = parsed.timePreference || _detectTimePreference(prompt);
    parsed.transportMode = parsed.transportMode || _detectTransportMode(prompt);
    parsed.busSeatPosition = _resolveBusSeatPosition(parsed.seatPreference);

    if (parsed.accessibility) {
      if (!parsed.preferences) parsed.preferences = [];
      if (!parsed.preferences.includes('accessible')) {
        parsed.preferences.push('accessible');
      }
    }

    return _enrichParams(parsed);
  } catch (error) {
    logger.warn('Gemini parsing failed, falling back to rule-based parser', {
      error: error.message
    });
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

  // Flight seat preferences
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

  // Hotel meal plans
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

  // SGR and general train classes
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
  if (lower.match(/night|usiku|late|9pm|10pm|11pm|midnight/)) return 'night';

  return null;
}

function _detectTransportMode(prompt) {
  const lower = prompt.toLowerCase();

  if (lower.match(/\bbus\b|coach|basi|matatu/)) return 'bus';
  if (lower.match(/\btrain\b|sgr|rail|treni|madaraka/)) return 'train';
  if (lower.match(/\bflight\b|\bfly\b|ndege|airline|airways/)) return 'flight';
  if (lower.match(/\bdrive\b|road\s*trip|self\s*drive|gari/)) return 'drive';

  return null;
}

function _resolveBusSeatPosition(seatPreference) {
  if (!seatPreference) return null;
  return BUS_SEAT_POSITIONS[seatPreference] || null;
}

// ─────────────────────────────────────────────
// GEMINI PARSER
// ─────────────────────────────────────────────
async function _parseWithGemini(prompt) {
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [{
          text: `You are a travel booking assistant for East Africa. Extract trip details from this prompt and return ONLY valid JSON with no explanation, no markdown, no code blocks.

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
- "kiti cha magurudumu" = wheelchair
- "ulemavu" = disability
- "mzee" = elderly
- "asubuhi" = morning
- "mchana" = afternoon
- "jioni" = evening
- "basi" = bus
- "treni" = train
- "ndege" = plane/flight
- "dirisha" = window
- "chakula chote" = all inclusive

Return JSON:
{
  "origin": "full city name in lowercase",
  "destination": "full city name in lowercase",
  "departureDate": "YYYY-MM-DD or null",
  "returnDate": "YYYY-MM-DD or null",
  "passengers": number (default 1),
  "budget": "low|mid|high|luxury",
  "nights": number (default 3),
  "tripType": "round_trip|one_way",
  "transportMode": "flight|bus|train|drive|null",
  "seatPreference": "window|aisle|middle|extra_legroom|front|back|upper_deck|lower_deck|null",
  "mealPlan": "all_inclusive|full_board|half_board|bed_and_breakfast|room_only|null",
  "trainClass": "first_class|economy|premium|sgr|null",
  "timePreference": "morning|afternoon|evening|night|null",
  "accessibility": true or false,
  "preferences": ["beach", "safari", "culture", "adventure", "family", "honeymoon", "business", "accessible"]
}

RULES:
- NEVER use abbreviations — always full city names in lowercase
- origin = where they are coming FROM (default nairobi for Kenya context)
- destination = where they want to GO
- transportMode: if they say bus use bus, train use train, flight use flight
- seatPreference: window seat = window, aisle seat = aisle, front = front, back = back
- mealPlan: all inclusive = all_inclusive, breakfast included = bed_and_breakfast, full board = full_board
- trainClass: SGR first class = first_class, SGR economy = economy, Madaraka Express = sgr
- timePreference: morning bus = morning, evening train = evening
- For bus seat window/aisle — note this will be resolved to actual seat numbers from Travler seat map
- Today: ${new Date().toISOString().split('T')[0]}
- "next week" = ${_addDaysStr(7)}
- "next month" = ${_addDaysStr(30)}
- "christmas" = ${new Date().getFullYear()}-12-25
- "new year" = ${new Date().getFullYear() + 1}-01-01
- If budget not mentioned use "mid"
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

  if (!parsed.origin) parsed.origin = 'nairobi';

  return parsed;
}

// ─────────────────────────────────────────────
// RULE-BASED FALLBACK
// ─────────────────────────────────────────────
function _parseWithRules(prompt) {
  let lower = prompt.toLowerCase().trim();

  for (const [swahili, english] of Object.entries(SWAHILI_DESTINATIONS)) {
    lower = lower.replace(swahili, english);
  }

  const swahiliPassengerMatch = lower.match(/(\d+)\s*(watu|wenza|watu\s*wawili)/);
  const passengerMatch = lower.match(/(\d+)\s*(people|persons|passengers|adults|pax|travelers?|travellers?)/);
  const passengers = swahiliPassengerMatch
    ? parseInt(swahiliPassengerMatch[1])
    : passengerMatch
      ? parseInt(passengerMatch[1])
      : lower.includes('wawili') || lower.includes('sisi wawili') ? 2
      : lower.includes('familia') || lower.includes('family') ? 4
      : 1;

  let budget = 'mid';
  if (lower.match(/luxury|5[\s-]?star|five[\s-]?star|premium|first[\s-]?class/)) budget = 'luxury';
  else if (lower.match(/high[\s-]?budget|business[\s-]?class|expensive/)) budget = 'high';
  else if (lower.match(/low[\s-]?budget|cheap|budget|affordable|bei[\s-]?nafuu|economy/)) budget = 'low';
  else if (lower.match(/mid[\s-]?budget|moderate|reasonable/)) budget = 'mid';

  const nightsMatch = lower.match(/(\d+)\s*(nights?|usiku|giku)/);
  const daysMatch = lower.match(/(\d+)\s*(days?|siku)/);
  const nights = nightsMatch
    ? parseInt(nightsMatch[1])
    : daysMatch
      ? parseInt(daysMatch[1]) - 1
      : lower.includes('weekend') ? 2
      : lower.includes('week') && !lower.includes('next week') ? 7
      : 3;

  const sortedCities = Object.keys(CITY_CODES).sort((a, b) => b.length - a.length);
  let origin = null;
  let destination = null;

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

  if (!destination) {
    for (const city of sortedCities) {
      if (lower.includes(city)) {
        if (!origin) origin = city;
        else if (city !== origin) { destination = city; break; }
      }
    }
    if (origin && !destination) { destination = origin; origin = null; }
  }

  if (!origin) origin = 'nairobi';

  const preferences = [];
  if (lower.match(/beach|coast|ocean|bahari|pwani/)) preferences.push('beach');
  if (lower.match(/safari|game|wildlife|mara|serengeti|wanyama/)) preferences.push('safari');
  if (lower.match(/honeymoon|romantic|anniversary|mapenzi/)) preferences.push('honeymoon');
  if (lower.match(/family|kids|children|watoto|familia/)) preferences.push('family');
  if (lower.match(/adventure|hiking|climb|mountain|mlima/)) preferences.push('adventure');
  if (lower.match(/culture|history|museum|utamaduni/)) preferences.push('culture');
  if (lower.match(/business|conference|meeting|mkutano/)) preferences.push('business');

  const accessibility = _detectAccessibility(lower);
  if (accessibility) preferences.push('accessible');

  const seatPreference = _detectSeatPreference(lower);
  const mealPlan = _detectMealPlan(lower);
  const trainClass = _detectTrainClass(lower);
  const timePreference = _detectTimePreference(lower);
  const transportMode = _detectTransportMode(lower);
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
    transportMode,
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
  if (prompt.includes('christmas')) return `${now.getFullYear()}-12-25`;
  if (prompt.match(/new\s+year/)) return `${now.getFullYear() + 1}-01-01`;
  if (prompt.match(/easter/)) return `${now.getFullYear()}-04-20`;

  return null;
}

// ─────────────────────────────────────────────
// ENRICH PARAMS
// ─────────────────────────────────────────────
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
    accessibility: parsed.accessibility || false,
    seatPreference: parsed.seatPreference || null,
    mealPlan: parsed.mealPlan || null,
    trainClass: parsed.trainClass || null,
    timePreference: parsed.timePreference || null,
    transportMode: parsed.transportMode || null,
    busSeatPosition: parsed.busSeatPosition || null,
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