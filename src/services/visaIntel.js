/**
 * VISA INTEL
 * ─────────────────────────────────────────────────────────────
 * Returns a short visa note for a given origin → destination
 * corridor. Shown inline on WhatsApp package cards.
 *
 * Format: "origin_destination" (both lowercased)
 *
 * Coverage: Kenya outbound (primary market) + Uganda, Tanzania,
 * Rwanda outbound corridors. Expand as agency network grows.
 * ─────────────────────────────────────────────────────────────
 */

const VISA_NOTES = {

  // ── KENYA OUTBOUND ────────────────────────────────────────────
  'kenya_tanzania':           'Visa-free for Kenyans',
  'kenya_zanzibar':           'Visa-free for Kenyans',
  'kenya_uganda':             'Visa-free for Kenyans',
  'kenya_rwanda':             'Visa-free for Kenyans',
  'kenya_ethiopia':           'Visa on arrival — USD 52',
  'kenya_south africa':       'Visa-free for Kenyans — up to 30 days',
  'kenya_cape town':          'Visa-free for Kenyans — up to 30 days',
  'kenya_johannesburg':       'Visa-free for Kenyans — up to 30 days',
  'kenya_mozambique':         'Visa on arrival — USD 50',
  'kenya_maputo':             'Visa on arrival — USD 50',
  'kenya_zimbabwe':           'Visa on arrival — USD 55',
  'kenya_harare':             'Visa on arrival — USD 55',
  'kenya_zambia':             'Visa on arrival — USD 50',
  'kenya_lusaka':             'Visa on arrival — USD 50',
  'kenya_malawi':             'Visa on arrival — free',
  'kenya_botswana':           'Visa-free for Kenyans — up to 90 days',
  'kenya_namibia':            'Visa-free for Kenyans — up to 90 days',
  'kenya_windhoek':           'Visa-free for Kenyans — up to 90 days',
  'kenya_nigeria':            'Visa required — apply at Nigerian High Commission, Nairobi',
  'kenya_lagos':              'Visa required — apply at Nigerian High Commission, Nairobi',
  'kenya_ghana':              'Visa on arrival — free',
  'kenya_accra':              'Visa on arrival — free',
  'kenya_senegal':            'Visa-free for Kenyans — up to 90 days',
  'kenya_dakar':              'Visa-free for Kenyans — up to 90 days',
  'kenya_egypt':              'Visa on arrival — USD 25',
  'kenya_cairo':              'Visa on arrival — USD 25',
  'kenya_morocco':            'Visa required — apply in advance',
  'kenya_casablanca':         'Visa required — apply in advance',
  'kenya_marrakech':          'Visa required — apply in advance',
  'kenya_seychelles':         'Visa-free for Kenyans — visitor\'s permit on arrival',
  'kenya_mauritius':          'Visa-free for Kenyans — up to 90 days',
  'kenya_madagascar':         'Visa on arrival — USD 35',
  'kenya_antananarivo':       'Visa on arrival — USD 35',
  'kenya_dubai':              'Visa required — apply online at uaevisa.ae (free for Kenyans)',
  'kenya_abu dhabi':          'Visa required — apply online at uaevisa.ae (free for Kenyans)',
  'kenya_qatar':              'Visa on arrival — free for Kenyans',
  'kenya_doha':               'Visa on arrival — free for Kenyans',
  'kenya_oman':               'Visa on arrival — OMR 6',
  'kenya_muscat':             'Visa on arrival — OMR 6',
  'kenya_india':              'e-Visa required — apply at indianvisaonline.gov.in',
  'kenya_delhi':              'e-Visa required — apply at indianvisaonline.gov.in',
  'kenya_mumbai':             'e-Visa required — apply at indianvisaonline.gov.in',
  'kenya_thailand':           'Visa-free for Kenyans — up to 30 days',
  'kenya_bangkok':            'Visa-free for Kenyans — up to 30 days',
  'kenya_phuket':             'Visa-free for Kenyans — up to 30 days',
  'kenya_bali':               'Visa on arrival — USD 35',
  'kenya_indonesia':          'Visa on arrival — USD 35',
  'kenya_turkey':             'e-Visa required — apply at evisa.gov.tr (USD 60)',
  'kenya_istanbul':           'e-Visa required — apply at evisa.gov.tr (USD 60)',
  'kenya_united kingdom':     'Visa required — apply at gov.uk/apply-uk-visa',
  'kenya_london':             'Visa required — apply at gov.uk/apply-uk-visa',
  'kenya_france':             'Schengen visa required — apply at French Embassy, Nairobi',
  'kenya_paris':              'Schengen visa required — apply at French Embassy, Nairobi',
  'kenya_germany':            'Schengen visa required — apply at German Embassy, Nairobi',
  'kenya_berlin':             'Schengen visa required — apply at German Embassy, Nairobi',
  'kenya_netherlands':        'Schengen visa required — apply at Dutch Embassy, Nairobi',
  'kenya_amsterdam':          'Schengen visa required — apply at Dutch Embassy, Nairobi',
  'kenya_spain':              'Schengen visa required — apply at Spanish Embassy, Nairobi',
  'kenya_barcelona':          'Schengen visa required — apply at Spanish Embassy, Nairobi',
  'kenya_italy':              'Schengen visa required — apply at Italian Embassy, Nairobi',
  'kenya_rome':               'Schengen visa required — apply at Italian Embassy, Nairobi',
  'kenya_united states':      'Visa required — apply at ustraveldocs.com',
  'kenya_new york':           'Visa required — apply at ustraveldocs.com',
  'kenya_los angeles':        'Visa required — apply at ustraveldocs.com',
  'kenya_canada':             'eTA or visa required — apply at canada.ca/eta',
  'kenya_toronto':            'eTA or visa required — apply at canada.ca/eta',
  'kenya_australia':          'Visa required — apply at immi.homeaffairs.gov.au',
  'kenya_sydney':             'Visa required — apply at immi.homeaffairs.gov.au',
  'kenya_melbourne':          'Visa required — apply at immi.homeaffairs.gov.au',
  'kenya_china':              'Visa required — apply at Chinese Embassy, Nairobi',
  'kenya_beijing':            'Visa required — apply at Chinese Embassy, Nairobi',
  'kenya_shanghai':           'Visa required — apply at Chinese Embassy, Nairobi',
  'kenya_japan':              'Visa required — apply at Japanese Embassy, Nairobi',
  'kenya_tokyo':              'Visa required — apply at Japanese Embassy, Nairobi',

  // ── UGANDA OUTBOUND ───────────────────────────────────────────
  'uganda_kenya':             'Visa-free for Ugandans',
  'uganda_tanzania':          'Visa-free for Ugandans',
  'uganda_rwanda':            'Visa-free for Ugandans',
  'uganda_south africa':      'Visa-free for Ugandans — up to 30 days',
  'uganda_dubai':             'Visa required — apply online at uaevisa.ae',
  'uganda_united kingdom':    'Visa required — apply at gov.uk/apply-uk-visa',

  // ── TANZANIA OUTBOUND ─────────────────────────────────────────
  'tanzania_kenya':           'Visa-free for Tanzanians',
  'tanzania_uganda':          'Visa-free for Tanzanians',
  'tanzania_rwanda':          'Visa-free for Tanzanians',
  'tanzania_south africa':    'Visa-free for Tanzanians — up to 30 days',
  'tanzania_dubai':           'Visa required — apply online at uaevisa.ae',
  'tanzania_united kingdom':  'Visa required — apply at gov.uk/apply-uk-visa',

  // ── RWANDA OUTBOUND ───────────────────────────────────────────
  'rwanda_kenya':             'Visa-free for Rwandans',
  'rwanda_uganda':            'Visa-free for Rwandans',
  'rwanda_tanzania':          'Visa-free for Rwandans',
  'rwanda_south africa':      'Visa-free for Rwandans — up to 30 days',
  'rwanda_dubai':             'Visa required — apply online at uaevisa.ae',
  'rwanda_united kingdom':    'Visa required — apply at gov.uk/apply-uk-visa',
};

// City → country map for normalizing destination names
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
 * Get a visa note for a given origin → destination pair.
 *
 * Tries exact city match first, then falls back to country-level
 * lookup so "Nairobi → Cape Town" hits the same entry as
 * "Kenya → South Africa".
 *
 * @param {string} origin      — e.g. "Nairobi"
 * @param {string} destination — e.g. "Cape Town"
 * @returns {string|null}      — e.g. "Visa-free for Kenyans — up to 30 days"
 */
function getVisaNote(origin, destination) {
  if (!origin || !destination) return null;

  const o = origin.toLowerCase().trim();
  const d = destination.toLowerCase().trim();

  // 1. Try exact city → city
  const exactKey = `${o}_${d}`;
  if (VISA_NOTES[exactKey]) return VISA_NOTES[exactKey];

  // 2. Try origin country → destination city
  const oCountry = CITY_TO_COUNTRY[o] || o;
  const dCity    = `${oCountry}_${d}`;
  if (VISA_NOTES[dCity]) return VISA_NOTES[dCity];

  // 3. Try origin city → destination country
  const dCountry = CITY_TO_COUNTRY[d] || d;
  const oCity    = `${o}_${dCountry}`;
  if (VISA_NOTES[oCity]) return VISA_NOTES[oCity];

  // 4. Try origin country → destination country
  const countryKey = `${oCountry}_${dCountry}`;
  if (VISA_NOTES[countryKey]) return VISA_NOTES[countryKey];

  return null;
}

module.exports = { getVisaNote };