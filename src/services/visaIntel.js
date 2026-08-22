/**
 * VISA INTEL
 * ─────────────────────────────────────────────────────────────
 * Returns a short visa note for a given origin → destination
 * corridor. Shown inline on WhatsApp package cards.
 *
 * Data lives in the Supabase `visa_rules` table — update rows
 * there directly; no code changes or deploys needed.
 *
 * Lookup cascade (same as before):
 *   1. exact city  → exact city
 *   2. origin country → destination city
 *   3. origin city  → destination country
 *   4. origin country → destination country
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger }   = require('../utils/logger');

// City → country normalisation map (stays in code — structural,
// not data that changes with visa policy).
const CITY_TO_COUNTRY = {
  'nairobi': 'kenya', 'mombasa': 'kenya', 'diani': 'kenya', 'malindi': 'kenya',
  'kampala': 'uganda', 'entebbe': 'uganda',
  'dar es salaam': 'tanzania', 'arusha': 'tanzania', 'zanzibar': 'zanzibar',
  'kigali': 'rwanda',
  'addis ababa': 'ethiopia',
  'cape town': 'south africa', 'johannesburg': 'south africa', 'durban': 'south africa',
  'maputo': 'mozambique',
  'harare': 'zimbabwe',
  'lusaka': 'zambia',
  'windhoek': 'namibia',
  'lagos': 'nigeria', 'abuja': 'nigeria',
  'accra': 'ghana',
  'dakar': 'senegal',
  'cairo': 'egypt',
  'casablanca': 'morocco', 'marrakech': 'morocco',
  'antananarivo': 'madagascar',
  'dubai': 'dubai', 'abu dhabi': 'abu dhabi',
  'doha': 'qatar',
  'muscat': 'oman',
  'delhi': 'india', 'mumbai': 'india',
  'bangkok': 'thailand', 'phuket': 'thailand',
  'bali': 'bali',
  'istanbul': 'turkey',
  'london': 'united kingdom',
  'paris': 'france',
  'berlin': 'germany', 'frankfurt': 'germany',
  'amsterdam': 'netherlands',
  'barcelona': 'spain', 'madrid': 'spain',
  'rome': 'italy', 'milan': 'italy',
  'new york': 'united states', 'los angeles': 'united states', 'washington': 'united states',
  'toronto': 'canada', 'vancouver': 'canada',
  'sydney': 'australia', 'melbourne': 'australia',
  'beijing': 'china', 'shanghai': 'china',
  'tokyo': 'japan', 'osaka': 'japan',
};

/**
 * Look up a single origin→destination pair in visa_rules.
 * Returns the note string or null.
 * @param {string} origin
 * @param {string} destination
 */
async function _lookup(origin, destination) {
  const { data, error } = await supabase
    .from('visa_rules')
    .select('note')
    .eq('origin', origin)
    .eq('destination', destination)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows found — that's fine, anything else is worth logging
    logger.warn('visa_rules lookup error', { origin, destination, error: error.message });
  }

  return data?.note || null;
}

/**
 * Get a visa note for a given origin → destination pair.
 *
 * Tries exact city match first, then falls back through country
 * combinations. Returns null if no corridor is found.
 *
 * @param {string} origin      — e.g. "Nairobi"
 * @param {string} destination — e.g. "Cape Town"
 * @returns {Promise<string|null>}
 */
async function getVisaNote(origin, destination) {
  if (!origin || !destination) return null;

  const o = origin.toLowerCase().trim();
  const d = destination.toLowerCase().trim();

  const oCountry = CITY_TO_COUNTRY[o] || o;
  const dCountry = CITY_TO_COUNTRY[d] || d;

  const candidates = [
    [o,        d       ],   // 1. exact city → exact city
    [oCountry, d       ],   // 2. origin country → destination city
    [o,        dCountry],   // 3. origin city → destination country
    [oCountry, dCountry],   // 4. origin country → destination country
  ];

  for (const [from, to] of candidates) {
    const note = await _lookup(from, to);
    if (note) return note;
  }

  return null;
}

module.exports = { getVisaNote };