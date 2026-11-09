'use strict';
// Pure planner + message composer for "your flight is not available, here is what works".
// Code decides what is valid; the text is built from real search results only. No supplier calls here.

const ALIASES = { kq: 'kenyaairways', ek: 'emirates', qr: 'qatarairways', et: 'ethiopianairlines', rw: 'rwandair', kl: 'klm' };
const DISPLAY = { kenyaairways: 'Kenya Airways', emirates: 'Emirates', qatarairways: 'Qatar Airways', ethiopianairlines: 'Ethiopian Airlines', rwandair: 'RwandAir', klm: 'KLM' };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const providerKey = (p) => ALIASES[norm(p)] || norm(p);
const title = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const displayProvider = (p) => (p ? (DISPLAY[providerKey(p)] || title(p)) : null);
const label = (f) => f.airline || f.provider || f.airlineCode || 'Another airline';

function matchesProvider(f, provider) {
  const key = providerKey(provider); if (!key) return true;
  const name = norm(f.airline || f.provider), code = norm(f.airlineCode);
  return !!((name && (name.includes(key) || key.includes(name))) || (code && (code === key || ALIASES[code] === key)));
}
function depMins(f) {
  const s = String(f.departureTime || '');
  const m = /T(\d{2}):(\d{2})/.exec(s) || /(\d{1,2}):(\d{2})/.exec(s);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}
const toMins = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
function fmt12(mins) { const h = Math.floor(mins / 60) % 24, m = mins % 60; return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; }
const money = (f) => (f.price ? ` (${f.currency || 'KES'} ${Math.round(f.price).toLocaleString('en-US')})` : '');
const joinNames = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]);
function onePerAirline(entries, max) {
  const seen = new Set(), out = [];
  for (const e of entries) { const k = norm(label(e.flight)); if (seen.has(k)) continue; seen.add(k); out.push(e); if (out.length >= max) break; }
  return out;
}

function planFlightAlternatives({ provider = null, time = null, flights = [], toleranceMins = 20, sameTimeWindowMins = 45, validate = null }) {
  const wanted = toMins(time);
  const pool = flights
    .filter((f) => (f.transportType || 'flight') === 'flight')
    .map((f) => ({ flight: f, mins: depMins(f) }))
    .filter((e) => e.mins != null && (!validate || validate(e.flight)));
  if (!provider && wanted == null) return { status: 'ok' };
  const mine = pool.filter((e) => matchesProvider(e.flight, provider));
  const diff = (e) => (wanted == null ? 0 : Math.abs(e.mins - wanted));
  const satisfied = mine.filter((e) => wanted == null || diff(e) <= toleranceMins);
  if (satisfied.length) return { status: 'ok', exact: satisfied.map((e) => e.flight) };
  if (!pool.length) return { status: 'none' };

  const byClose = (a, b) => diff(a) - diff(b) || (a.flight.price || 0) - (b.flight.price || 0);
  const sameProvider = provider ? [...mine].sort(byClose).slice(0, 1) : [];
  const others = pool.filter((e) => !matchesProvider(e.flight, provider));
  const sameTimeOthers = wanted == null ? [] : onePerAirline(others.filter((e) => diff(e) <= sameTimeWindowMins).sort(byClose), 2);
  const nearest = onePerAirline([...pool].sort(byClose), 3);
  const options = [...sameProvider, ...sameTimeOthers].map((e) => e.flight);
  return { status: 'alternatives', provider, wantedMins: wanted, sameProvider, sameTimeOthers, nearest,
    options: options.length ? options : nearest.map((e) => e.flight) };
}

function composeMessage(plan) {
  const P = displayProvider(plan.provider), t = plan.wantedMins != null ? fmt12(plan.wantedMins) : null;
  const head = P && t ? `${P}'s ${t} isn't available right now.`
    : t ? `I can't find anything leaving at ${t}.`
    : `${P} doesn't have anything on this route for your date.`;
  const sp = plan.sameProvider[0], oth = plan.sameTimeOthers;
  let body;
  if (sp && oth.length) body = `But there's another ${P} at ${fmt12(sp.mins)}${money(sp.flight)}, or ${joinNames(oth.map((e) => label(e.flight)))} ${oth.length > 1 ? 'have flights' : 'has a flight'} around the same time (${oth.map((e) => fmt12(e.mins)).join(', ')}).`;
  else if (sp) body = `But there's another ${P} at ${fmt12(sp.mins)}${money(sp.flight)}.`;
  else if (oth.length) body = `But ${joinNames(oth.map((e) => label(e.flight)))} ${oth.length > 1 ? 'have flights' : 'has a flight'} around the same time (${oth.map((e) => fmt12(e.mins)).join(', ')}).`;
  else body = `The closest I can see: ${plan.nearest.map((e) => `${label(e.flight)} at ${fmt12(e.mins)}${money(e.flight)}`).join(', ')}.`;
  return `${head} ${body} The options are below.`;
}

// What the engine calls: { text, options } or null when the request is already satisfied / nothing to offer.
function suggestFlightAlternatives(args) {
  const plan = planFlightAlternatives(args);
  if (plan.status !== 'alternatives') return null;
  return { text: composeMessage(plan), options: plan.options };
}

module.exports = { planFlightAlternatives, composeMessage, suggestFlightAlternatives };