'use strict';

const { norm, lev } = require('./text');

// Canonical city names (what the rest of the engine already expects).
const CITIES = [
  'Nairobi', 'Mombasa', 'Kisumu', 'Nakuru', 'Eldoret', 'Malindi', 'Diani', 'Thika', 'Nanyuki',
  'Kampala', 'Entebbe', 'Dar es Salaam', 'Arusha', 'Zanzibar', 'Mwanza', 'Kigali', 'Addis Ababa', 'Juba',
  'Cairo', 'Alexandria', 'Lagos', 'Abuja', 'Accra', 'Johannesburg', 'Cape Town', 'Durban', 'Lusaka', 'Harare',
  'Windhoek', 'Maputo', 'Luanda', 'Kinshasa', 'Casablanca', 'Marrakech', 'Tunis', 'Algiers', 'Dakar', 'Douala',
  'Mogadishu', 'Djibouti', 'Khartoum', 'Bujumbura', 'Lilongwe', 'Gaborone', 'Mauritius', 'Mahe', 'Dubai',
  'Abu Dhabi', 'Doha', 'Istanbul', 'London', 'Paris', 'Amsterdam', 'Frankfurt', 'Brussels', 'Madrid', 'Barcelona',
  'Rome', 'Zurich', 'New York', 'Washington', 'Atlanta', 'Toronto', 'Mumbai', 'Delhi', 'Bangkok', 'Singapore',
  'Hong Kong', 'Guangzhou', 'Beijing', 'Shanghai', 'Tokyo', 'Sydney', 'Riyadh', 'Jeddah', 'Muscat', 'Kuwait',
];

const ALIASES = {
  nbi: 'Nairobi', jkia: 'Nairobi', msa: 'Mombasa', ebb: 'Entebbe', dar: 'Dar es Salaam', dsm: 'Dar es Salaam',
  addis: 'Addis Ababa', joburg: 'Johannesburg', jozi: 'Johannesburg', jnb: 'Johannesburg', cpt: 'Cape Town',
  capetown: 'Cape Town', nyc: 'New York', lhr: 'London', dxb: 'Dubai', cai: 'Cairo', kgl: 'Kigali', los: 'Lagos',
  acc: 'Accra', 'dar es salam': 'Dar es Salaam', daressalaam: 'Dar es Salaam', 'washington dc': 'Washington',
  'washington d.c.': 'Washington', hk: 'Hong Kong', abudhabi: 'Abu Dhabi', newyork: 'New York',
  // countries -> the city the engine already maps them to
  kenya: 'Nairobi', tanzania: 'Dar es Salaam', uganda: 'Kampala', rwanda: 'Kigali', ethiopia: 'Addis Ababa',
  'south africa': 'Johannesburg', egypt: 'Cairo', morocco: 'Marrakech', ghana: 'Accra', nigeria: 'Lagos',
  uae: 'Dubai', 'united arab emirates': 'Dubai', qatar: 'Doha', turkey: 'Istanbul', uk: 'London',
  'united kingdom': 'London', england: 'London', france: 'Paris', netherlands: 'Amsterdam', germany: 'Frankfurt',
  usa: 'New York', 'united states': 'New York', america: 'New York', india: 'Delhi', japan: 'Tokyo',
  china: 'Beijing', zambia: 'Lusaka', zimbabwe: 'Harare', namibia: 'Windhoek', mozambique: 'Maputo',
  senegal: 'Dakar', cameroon: 'Douala', somalia: 'Mogadishu', sudan: 'Khartoum', burundi: 'Bujumbura',
  malawi: 'Lilongwe', botswana: 'Gaborone', australia: 'Sydney', canada: 'Toronto', singapore: 'Singapore',
};

const EXACT = new Map();
for (const c of CITIES) EXACT.set(norm(c), c);
for (const [k, v] of Object.entries(ALIASES)) EXACT.set(norm(k), v);

const stripPunct = (s) => norm(s).replace(/[^a-z0-9' .]/g, ' ').replace(/\.+$/g, '').replace(/\s+/g, ' ').trim();

/** Exact (alias/city/country) match only. */
function resolveExact(text) {
  return EXACT.get(stripPunct(text)) || null;
}

/** Exact match, then a conservative single-candidate fuzzy match ("kairo" -> Cairo). */
function resolvePlaceLocal(text) {
  const t = stripPunct(text);
  if (!t || t.length > 40) return null;
  const hit = EXACT.get(t);
  if (hit) return hit;
  if (t.length < 5) return null;
  const maxDist = t.length >= 8 ? 2 : 1;
  let best = null;
  let bestD = Infinity;
  let tie = false;
  for (const [key, city] of EXACT) {
    if (key.length < 5 || Math.abs(key.length - t.length) > maxDist) continue;
    const d = lev(t, key);
    if (d <= maxDist) {
      if (d < bestD) { best = city; bestD = d; tie = false; }
      else if (d === bestD && city !== best) tie = true;
    }
  }
  return tie ? null : best;
}

/** Scan 1-3 word windows for an exact known place anywhere in a sentence. */
function findPlaceMention(text) {
  const toks = stripPunct(text).split(' ').filter(Boolean);
  for (let n = 3; n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      const hit = EXACT.get(toks.slice(i, i + n).join(' '));
      if (hit) return hit;
    }
  }
  return null;
}

const LEAD_IN = /^(?:(?:hi+|hello+|hey+)[, ]+|(?:it'?s|its|it is|i am|i'm|im|am|i will be|i'll be|will be|we are|we're|coming|flying|departing|leaving|travelling|traveling|starting|based|living|staying|from|in|out of|at|the)\s+)/i;
const TRAIL = /\s*(?:please|pls|thanks|thank you|thx)\s*[.!]*$/i;

/**
 * Pull a place out of a short *answer* ("am coming from kairo" -> Cairo).
 * Returns canonical name or null. Never returns text that is not a known/fuzzy place.
 */
function extractPlaceFromAnswer(text) {
  let t = norm(text, 120).replace(/[?!]+$/g, '').replace(TRAIL, '').trim();
  if (!t) return null;
  for (let i = 0; i < 6; i++) {
    const next = t.replace(LEAD_IN, '').trim();
    if (next === t) break;
    t = next;
  }
  t = t.replace(/[.,;:]+$/g, '').trim();
  if (!t || t.split(' ').length > 3) return null;
  return resolvePlaceLocal(t);
}

module.exports = { CITIES, resolveExact, resolvePlaceLocal, findPlaceMention, extractPlaceFromAnswer };
