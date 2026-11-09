'use strict';
// Deterministic multi-destination itinerary builder.
// The LLM only extracts: origin, finalDestination, departureDate, stops[{city,nights}].
// Every date is computed here. No Date.toISOString() on unchecked input.

const MS_DAY = 86400000;

function parseISO(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Invalid date: ${s}`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}
function addDays(s, n) {
  if (!Number.isInteger(n)) throw new Error(`addDays: days must be an integer, got ${n}`);
  return new Date(parseISO(s).getTime() + n * MS_DAY).toISOString().slice(0, 10);
}

const LONG_HAUL_REGIONS = new Set(['washington', 'houston', 'new york', 'london', 'dubai']);
const isLongHaul = (city) => LONG_HAUL_REGIONS.has(String(city).toLowerCase());

function validateInput(p) {
  const errs = [];
  if (!p.origin) errs.push('origin missing');
  if (!p.finalDestination) errs.push('finalDestination missing (ask: where do they fly home to?)');
  if (!Array.isArray(p.stops) || !p.stops.length) errs.push('stops missing');
  (p.stops || []).forEach((s, i) => {
    if (!s.city) errs.push(`stop ${i}: city missing`);
    if (!Number.isInteger(s.nights) || s.nights < 1) errs.push(`stop ${i} (${s.city}): nights must be an integer >= 1`);
  });
  try { parseISO(p.departureDate); } catch (e) { errs.push(e.message); }
  return errs;
}

/**
 * @param {object} p { origin, finalDestination, departureDate, stops:[{city,nights}], arrivalOffsetDays? }
 * arrivalOffsetDays: days between leaving origin and reaching stop 1. Default 1 for long haul, else 0.
 * Replace with the real arrival date from the chosen flight once known.
 */
function buildItinerary(p) {
  const errs = validateInput(p);
  if (errs.length) return { ok: false, errors: errs };

  const offset = Number.isInteger(p.arrivalOffsetDays) ? p.arrivalOffsetDays : (isLongHaul(p.origin) ? 1 : 0);
  const assumptions = [];
  if (!Number.isInteger(p.arrivalOffsetDays) && offset) assumptions.push(`Overnight flight: arrives ${offset} day after departure`);

  const segments = [];
  const legs = []; // legacy shape: {origin,destination,departureDate,stayNights}
  let cursor = addDays(p.departureDate, offset);
  let prev = { city: p.origin, leaveDate: p.departureDate };

  p.stops.forEach((stop, i) => {
    const checkIn = cursor;
    const checkOut = addDays(checkIn, stop.nights);
    segments.push({ type: 'travel', from: prev.city, to: stop.city, departDate: prev.leaveDate, arriveDate: checkIn, longHaul: i === 0 && offset > 0 });
    segments.push({ type: 'stay', city: stop.city, checkIn, checkOut, nights: stop.nights });
    legs.push({ origin: prev.city, destination: stop.city, departureDate: prev.leaveDate, stayNights: stop.nights });
    prev = { city: stop.city, leaveDate: checkOut };
    cursor = checkOut;
  });

  const returnOffset = isLongHaul(p.finalDestination) ? 0 : 0; // departure date = arrival date of the return flight is computed by the supplier
  segments.push({ type: 'travel', from: prev.city, to: p.finalDestination, departDate: prev.leaveDate, arriveDate: null, longHaul: isLongHaul(p.finalDestination) });
  legs.push({ origin: prev.city, destination: p.finalDestination, departureDate: prev.leaveDate, stayNights: 0 });

  const totalNights = p.stops.reduce((a, s) => a + s.nights, 0);
  const openJaw = String(p.origin).toLowerCase() !== String(p.finalDestination).toLowerCase();
  if (openJaw) assumptions.push(`Open-jaw: out of ${p.origin}, home from ${p.finalDestination} (price as two one-ways or multi-city)`);

  // Self-check: dates must chain with no gaps or overlaps.
  const stays = segments.filter((s) => s.type === 'stay');
  for (let i = 1; i < stays.length; i++) {
    if (stays[i].checkIn !== stays[i - 1].checkOut) return { ok: false, errors: [`date gap between stay ${i - 1} and ${i}`] };
  }

  // Engine-shaped trips[] (what _classifyTripLegs / _orchestrateClassifiedTrip consume).
  // departureDate = day you travel INTO the stop; checkIn/checkOut = hotel dates; returnDate = checkOut.
  const trips = [];
  segments.forEach((seg, i) => {
    if (seg.type !== 'stay') return;
    const travel = segments[i - 1];
    trips.push({ origin: travel.from, destination: seg.city, nights: seg.nights, departureDate: travel.departDate,
      checkIn: seg.checkIn, checkOut: seg.checkOut, returnDate: seg.checkOut, needsOriginClarification: false });
  });
  const last = segments[segments.length - 1];
  trips.push({ origin: last.from, destination: last.to, nights: 0, departureDate: last.departDate, returnDate: null,
    needsOriginClarification: false, _returnLeg: true });

  return {
    ok: true, openJaw, totalNights, trips,
    tripDays: totalNights + offset + 1,
    returnDate: prev.leaveDate,
    segments, legs, assumptions,
  };
}


// Rule-based stop extraction, used when Groq fails or returns no stops.
// "2 nights in nairobi 5 days maasai mara then 1 day back in nairobi before going back to houston"
function parseStopsWithRules(prompt) {
  const t = String(prompt || '').toLowerCase().replace(/\bone\b/g,'1').replace(/\btwo\b/g,'2').replace(/\bthree\b/g,'3')
    .replace(/\bfour\b/g,'4').replace(/\bfive\b/g,'5').replace(/\bsix\b/g,'6').replace(/\bseven\b/g,'7');
  const re = /(\d+)\s*(?:nights?|days?)\s+(?:back\s+)?(?:(?:in|at|to)\s+)?([a-z][a-z ]{2,25}?)(?=\s*(?:,|\.|;|$)|\s+(?:then|and|before|after|with)\b|\s+\d)/g;
  const stops = [];
  let m;
  while ((m = re.exec(t))) stops.push({ city: m[2].trim(), nights: parseInt(m[1], 10) });
  const f = [...t.matchAll(/(?:back|fly(?:ing)?|return(?:ing)?|home)\s+to\s+([a-z][a-z ]{2,25}?)\s*(?:[.,;]|$)/g)].pop();
  return { stops: stops.length >= 2 ? stops : [], finalDestination: f ? f[1].trim() : null };
}

module.exports = { buildItinerary, addDays, parseISO, validateInput, parseStopsWithRules };