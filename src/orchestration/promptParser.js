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
 */

const Groq = require('groq-sdk');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// PROPERTY TYPE DESCRIPTORS
// Words that describe a hotel's location/style, NOT a hotel name.
// When Groq or rules detect these, they go into propertyType,
// never into preferredHotel.
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
// Split into two categories:
//   SAFARI  — full game-reserve trip leg; needs lodge + transport
//   EXCURSION — in-destination activity; noted in response only
// ─────────────────────────────────────────────

// Safari = game reserve destination, treated as a full trip leg.
// The actual park/reserve is resolved from the traveler's base city.
const SAFARI_PATTERN = /\bsafari\b|\bgame\s+(?:drive|park|reserve)\b|\bgame\s+viewing\b/i;

// Excursions = in-destination activities, NOT booked as trip legs.
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

// Safari destination resolver:
// Given the traveler's primary destination / origin city, return the
// most appropriate game reserve to add as a trip leg.
const SAFARI_DESTINATIONS = {
  // Tanzania / Indian Ocean coast → Serengeti or Ngorongoro
  tanzania:   'Serengeti',
  zanzibar:   'Serengeti',
  'dar es salaam': 'Serengeti',
  arusha:     'Serengeti',
  moshi:      'Serengeti',
  // Kenya → Masai Mara (default), Amboseli near Nairobi/Mombasa
  kenya:      'Masai Mara',
  nairobi:    'Masai Mara',
  mombasa:    'Amboseli',
  diani:      'Amboseli',
  malindi:    'Amboseli',
  // Uganda
  kampala:    'Bwindi',
  entebbe:    'Bwindi',
  // Rwanda
  kigali:     'Akagera',
  // South Africa
  johannesburg: 'Kruger',
  'cape town':  'Kruger',
  durban:       'Kruger',
  // Default fallback
  _default:   'Masai Mara',
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
    if (pattern.test(text) && !excursions.includes(label)) {
      excursions.push(label);
    }
  }
  return { hasSafari, excursions };
}

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
// DATE HELPERS
// ─────────────────────────────────────────────
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
  'masai mara':   'Nairobi',
  'maasai mara':  'Nairobi',
  'serengeti':    'Arusha',
  'ngorongoro':   'Arusha',
  'amboseli':     'Nairobi',
  'tsavo':        'Mombasa',
  'samburu':      'Nairobi',
  'lake nakuru':  'Nairobi',
  'naivasha':     'Nairobi',
  'ol pejeta':    'Nanyuki',
  'bwindi':       'Entebbe',
  'kruger':       'Johannesburg',
  'kruger park':  'Johannesburg',
  'machu picchu': 'Cusco',
  'ha long bay':  'Hanoi',
  'positano':     'Naples',
  'amalfi coast': 'Naples',
  'tuscany':      'Rome',
  'garden route': 'George',
  'franschhoek':  'Cape Town',
  'hermanus':     'Cape Town',
  'sun city':     'Johannesburg',
  'petra':        'Amman',
  'ubud':         'Bali',
  'hoi an':       'Da Nang',
  'diani':        'Mombasa',
  'diani beach':  'Mombasa',
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

  const lastLeg     = trips[trips.length - 1];
  const lastDest    = (lastLeg.destination || '').toLowerCase().trim();
  const lastIsReturnHome = lastDest === homeNorm;
  const lastOriginFlyable = !_isNonFlyable(lastLeg.origin || '');
  const datesCorrect = lastLeg.departureDate === returnDate;

  if (lastIsReturnHome && lastOriginFlyable && datesCorrect) {
    return trips;
  }

  let internal = trips.filter(t =>
    (t.destination || '').toLowerCase().trim() !== homeNorm
  );

  if (internal.length === 0) return trips;

  const lastInternal = internal[internal.length - 1];
  if (_isNonFlyable(lastInternal.destination)) {
    const hub = _hubFor(lastInternal.destination);
    if (hub && hub.toLowerCase() !== homeNorm) {
      internal.push({
        destination:  hub,
        origin:       lastInternal.destination,
        nights:       0,
        departureDate: null,
        returnDate:   null,
        _transitLeg:  true,
      });
    }
  }

  const totalNights    = _diffDays(departureDate, returnDate);
  const specifiedNights = internal
    .filter((_, i) => i > 0)
    .reduce((s, t) => s + (t.nights || 0), 0);
  const firstNights = Math.max(0, totalNights - specifiedNights);

  let cursor = departureDate;
  const rebuilt = internal.map((leg, i) => {
    const nights  = i === 0 ? firstNights : (leg.nights || 0);
    const depDate = cursor;
    const retDate = nights > 0 ? _addDays(cursor, nights) : null;
    if (nights > 0) cursor = _addDays(cursor, nights);
    return { ...leg, departureDate: depDate, nights, returnDate: retDate };
  });

  const lastRebuilt = rebuilt[rebuilt.length - 1];
  rebuilt.push({
    destination:  homeOrigin,
    origin:       lastRebuilt.destination,
    nights:       0,
    departureDate: returnDate,
    returnDate:   null,
    _returnLeg:   true,
    needsOriginClarification: false,
  });

  logger.info('PromptParser: post-processed bookend trip', {
    homeOrigin, departureDate, returnDate, firstNights,
    totalLegs: rebuilt.length,
    legs: rebuilt.map(t => `${t.origin}→${t.destination} (${t.departureDate}, ${t.nights}n)`),
  });

  return rebuilt;
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
  'washington': 'Washington',
  'washington dc': 'Washington',
  'washington d.c.': 'Washington',
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
  'dubai': 'DXB', 'london': 'LHR', 'new york': 'JFK', 'washington': 'IAD',
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
// DESTINATION NORMALIZER
// ─────────────────────────────────────────────
const DESTINATION_FIXES = {
  'capetown': 'Cape Town', 'cape-town': 'Cape Town', 'cpt': 'Cape Town',
  'joburg': 'Johannesburg', 'jozi': 'Johannesburg', 'jhb': 'Johannesburg',
  'johanesburg': 'Johannesburg', 'johannesberg': 'Johannesburg',
  'daressalaam': 'Dar es Salaam', 'dares salaam': 'Dar es Salaam', 'dar': 'Dar es Salaam',
  'addisababa': 'Addis Ababa', 'addis': 'Addis Ababa',
  'nbi': 'Nairobi', 'msa': 'Mombasa',
  'masaimara': 'Masai Mara', 'maasaimara': 'Masai Mara',
  'sharmelsheikh': 'Sharm el Sheikh', 'sharmelshekh': 'Sharm el Sheikh', 'sharm': 'Sharm el Sheikh',
  'abudhabi': 'Abu Dhabi', 'abu-dhabi': 'Abu Dhabi',
  'kualalumpur': 'Kuala Lumpur', 'kuala-lumpur': 'Kuala Lumpur', 'kl': 'Kuala Lumpur',
  'hongkong': 'Hong Kong', 'hong-kong': 'Hong Kong', 'hk': 'Hong Kong',
  'siemreap': 'Siem Reap', 'siem-reap': 'Siem Reap',
  'hochiminhcity': 'Ho Chi Minh City', 'hochiminh': 'Ho Chi Minh City', 'hcmc': 'Ho Chi Minh City',
  'phnompenh': 'Phnom Penh', 'phnom-penh': 'Phnom Penh',
  'koalumpur': 'Kuala Lumpur',
  'newyork': 'New York', 'new-york': 'New York', 'nyc': 'New York',
  'losangeles': 'Los Angeles', 'los-angeles': 'Los Angeles', 'la': 'Los Angeles',
  'sanfrancisco': 'San Francisco', 'san-francisco': 'San Francisco', 'sf': 'San Francisco',
  'saopaulo': 'Sao Paulo', 'são paulo': 'Sao Paulo',
  'riodejaneiro': 'Rio de Janeiro', 'rio': 'Rio de Janeiro',
  'buenosaires': 'Buenos Aires', 'buenos-aires': 'Buenos Aires',
  'mexicocity': 'Mexico City', 'mexico-city': 'Mexico City', 'cdmx': 'Mexico City',
  'costarica': 'San Jose',
  'newyorkcity': 'New York',
  'washington dc': 'Washington',
  'washington d.c.': 'Washington',
  'washingtondc': 'Washington',
  'dc': 'Washington',
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
  if (/^(help|plan|book|find|get|arrange|organize|visit|travel|go|take|show|give|tell)$/.test(firstWord)) return false;
  return true;
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
    if (day && month) {
      returnDate = `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
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

  // ── Property type vs hotel name ───────────────────────────────────────────
  // Check for property type descriptors FIRST. If matched, don't set preferredHotel.
  const propertyType = _extractPropertyType(prompt);
  let preferredHotel = null;

  // Only set preferredHotel if it looks like an actual hotel brand/name
  const hotelNameMatch = lower.match(/\b(?:at|in|stay(?:ing)?\s+at|book(?:ing)?\s+at|hotel)\s+([a-z][a-z\s]{2,30}?)(?:\s+hotel)?\b/i);
  if (hotelNameMatch) {
    const candidate = hotelNameMatch[1].trim();
    // Make sure it's not a property type descriptor
    if (!_extractPropertyType(candidate)) {
      preferredHotel = candidate;
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // ── Activity extraction ───────────────────────────────────────────────────
  const { hasSafari, excursions } = _extractActivities(prompt);
  const activityRequests = excursions;

  // Safari: resolve the game reserve based on the traveler's base city.
  // The engine will add it as a full trip leg (with lodge + transfers).
  const safariDestination = hasSafari
    ? resolveSafariDestination(destination || origin)
    : null;
  // ─────────────────────────────────────────────────────────────────────────

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
    const totalNights    = _diffDays(departureDate, returnDate);
    const knownNights    = stops.reduce((s, st) => s + st.nights, 0);
    const firstNights    = Math.max(0, totalNights - knownNights);
    const allStops       = [{ destination, nights: firstNights }, ...stops];

    let cursor = departureDate;
    const trips = allStops.map((st, i) => {
      const legOrigin = i === 0 ? origin : allStops[i - 1].destination;
      const depDate   = cursor;
      const retDate   = st.nights > 0 ? _addDays(cursor, st.nights) : null;
      if (st.nights > 0) cursor = _addDays(cursor, st.nights);
      return {
        origin:       legOrigin,
        destination:  st.destination,
        nights:       st.nights,
        departureDate: depDate,
        returnDate:   retDate,
        needsOriginClarification: false,
      };
    });

    const lastStop = allStops[allStops.length - 1];
    const lastHub  = _isNonFlyable(lastStop.destination)
      ? (_hubFor(lastStop.destination) || lastStop.destination)
      : lastStop.destination;

    if (_isNonFlyable(lastStop.destination) && lastHub.toLowerCase() !== lastStop.destination.toLowerCase()) {
      trips.push({
        origin:       lastStop.destination,
        destination:  lastHub,
        nights:       0,
        departureDate: returnDate,
        returnDate:   null,
        needsOriginClarification: false,
        _transitLeg:  true,
      });
    }

    trips.push({
      origin:       lastHub,
      destination:  origin,
      nights:       0,
      departureDate: returnDate,
      returnDate:   null,
      needsOriginClarification: false,
      _returnLeg:   true,
    });

    logger.info('Rule parser: detected multi-stop trip', {
      stops: trips.map(l => `${l.origin}→${l.destination} (${l.departureDate}, ${l.nights}n)`),
    });

    return {
      destination, origin, nights: totalNights, passengers, children, childAges, budget,
      departureDate, returnDate, outboundTransportMode, returnTransportMode, mealPlan,
      seatPreference, timePreference, needsOriginClarification: false,
      isMultiDestination: true,
      trips,
      legs: [],
      preferredTransportProvider: null,
      preferredHotel,
      propertyType,
      activityRequests,
      safariDestination,
      _parsedBy: 'rules-multi',
    };
  }
  // ── end multi-stop detection ──────────────────────────────────────────────

  return {
    destination, origin, nights: nights || null, passengers, children, childAges, budget,
    departureDate, returnDate, outboundTransportMode, returnTransportMode, mealPlan,
    seatPreference, timePreference, needsOriginClarification, isMultiDestination: false, legs: [],
    preferredTransportProvider: null,
    preferredHotel,
    propertyType,
    activityRequests,
    safariDestination,
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
ALWAYS assume the current year is 2026. If a user says "August 15th", resolve it to "2026-08-15".

CRITICAL RULE — CAPTURE ALL LEGS INCLUDING RETURN:
If the user describes a journey visiting multiple cities and then returning home,
EVERY leg must appear as a separate entry in trips[]. This includes the final
return leg home ("fly back to Nairobi", "then back home", "return to Nairobi").

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
WRONG — never drop the return leg. Never emit only 2 trips when 3+ are described.

PROPERTY TYPE vs HOTEL NAME:
- "beachfront hotel", "ocean view", "with a pool", "lodge", "tented camp" → propertyType field, preferredHotel: null
- "Sarova", "Serena", "Marriott", "Hilton", "Hemingways" → preferredHotel field, propertyType: null
- NEVER put descriptive words like "beachfront" or "ocean view" into preferredHotel

ACTIVITIES:
- "safari", "day trip", "snorkelling", "game drive", "diving", "spice tour", "sunset cruise" → activityRequests[]
- These are excursions, not destinations. List all mentioned.

Rules:
- destination must be a real place name (1-4 words max). Never a sentence.
- When trips[] is present, it must contain ALL trips — never drop one.
- Always include the return-to-origin leg as the final trips[] entry.
- nights: 0 and returnDate: null for transit/return-home legs.
- The final leg destination must ALWAYS be an airport city — never a safari park.
- Shared fields (passengers, budget, etc.) go at the top level.

Return this shape for a SINGLE trip:
{
  "trips": null,
  "destination": "city only",
  "origin": "city",
  "nights": number,
  "passengers": number,
  "children": number,
  "childAges": [],
  "budget": "low"|"mid"|"high"|"luxury"|null,
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

For multi-city trips use trips[]. Include ALL legs including the return home.
Never end trips[] on a safari park — always end on an airport city.
"beachfront", "oceanfront", "with pool" → propertyType (not preferredHotel).
"safari", "day trip", "snorkelling" → activityRequests[].

{
  "trips": [
    { "origin": "city", "destination": "city", "nights": number, "departureDate": "YYYY-MM-DD", "returnDate": "YYYY-MM-DD", "needsOriginClarification": false }
  ],
  "destination": "first destination city",
  "origin": "departure city",
  "nights": total_nights_number,
  "passengers": 1,
  "children": 0,
  "childAges": [],
  "budget": null,
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

    if (Array.isArray(parsed.trips)) {
      parsed.trips = parsed.trips.map(t => ({
        ...t,
        departureDate: sanitizeDate(t.departureDate),
        returnDate:    sanitizeDate(t.returnDate),
        destination:   t.destination ? resolveCountryToCity(t.destination) : t.destination,
        origin:        t.origin      ? resolveCountryToCity(t.origin)      : t.origin,
      }));

      parsed.trips = parsed.trips.filter(t => t.destination && _isPlausiblePlaceName(t.destination));

      if (parsed.trips.length >= 2 && parsed.returnDate) {
        const homeOrigin = parsed.trips[0]?.origin || parsed.origin;
        parsed.trips = _postProcessBookendTrip(
          parsed.trips,
          homeOrigin,
          parsed.departureDate,
          parsed.returnDate
        );
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

    if (parsed.destination && !_isPlausiblePlaceName(parsed.destination)) {
      logger.warn('Groq returned implausible destination', { returned: parsed.destination?.slice(0, 80) });
      return null;
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

    // ── Property type safety net ──────────────────────────────────────────
    // If Groq put a property descriptor into preferredHotel, rescue it.
    if (parsed.preferredHotel) {
      const pt = _extractPropertyType(parsed.preferredHotel);
      if (pt) {
        logger.info('PromptParser: rescued property type from preferredHotel', {
          was: parsed.preferredHotel, now: pt,
        });
        parsed.propertyType   = parsed.propertyType || pt;
        parsed.preferredHotel = null;
      }
    }

    // ── Activity requests: merge Groq output with rule-based extraction ───
    const { hasSafari, excursions: ruleExcursions } = _extractActivities(prompt);
    const groqActivities = Array.isArray(parsed.activityRequests) ? parsed.activityRequests : [];
    parsed.activityRequests = [...new Set([...groqActivities, ...ruleExcursions])];

    // Safari: resolve game reserve destination from primary city.
    // Groq may set activityRequests: ['safari'] — we convert that to a
    // safariDestination field and remove it from activityRequests so the
    // engine treats it as a full trip leg, not an excursion note.
    const groqSaidSafari = groqActivities.some(a => a === 'safari' || a === 'game_drive');
    parsed.activityRequests = parsed.activityRequests.filter(a => a !== 'safari' && a !== 'game_drive');

    if (hasSafari || groqSaidSafari) {
      const baseCity = parsed.destination || parsed.origin;
      parsed.safariDestination = parsed.safariDestination || resolveSafariDestination(baseCity);
      logger.info('PromptParser: safari detected', {
        baseCity, resolvedTo: parsed.safariDestination,
      });
    } else {
      parsed.safariDestination = parsed.safariDestination ?? null;
    }
    // ─────────────────────────────────────────────────────────────────────

    parsed.preferredTransportProvider = parsed.preferredTransportProvider ?? null;
    parsed.preferredHotel             = parsed.preferredHotel             ?? null;
    parsed.propertyType               = parsed.propertyType               ?? null;
    parsed.activityRequests           = parsed.activityRequests           ?? [];
    parsed.safariDestination          = parsed.safariDestination          ?? null;
    parsed.legs                       = parsed.legs                       ?? [];
    parsed.isMultiDestination         = parsed.isMultiDestination         ?? false;
    parsed.children                   = parsed.children                   ?? 0;
    parsed.childAges                  = parsed.childAges                  ?? [];
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
async function parsePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) return _parseWithRules('');
  const groqResult = await _parseWithGroq(prompt);
  if (groqResult) {
    if (Array.isArray(groqResult.trips) && groqResult.trips.length > 1) {
      logger.info('Prompt parsed via Groq — multi-trip', {
        tripCount:    groqResult.trips.length,
        destinations: groqResult.trips.map(t => t.destination).join(', '),
      });
    } else {
      logger.info('Prompt parsed via Groq', { destination: groqResult.destination, origin: groqResult.origin });
    }
    return groqResult;
  }
  logger.info('Falling back to rule-based parser', { prompt: prompt.slice(0, 80) });
  return _parseWithRules(prompt);
}

module.exports = { parsePrompt, resolveCountryToCity, normalizeDestination, resolveSafariDestination };