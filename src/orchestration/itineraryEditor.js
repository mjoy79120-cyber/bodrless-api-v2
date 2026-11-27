'use strict';
/**
 * itineraryEditor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure, deterministic edits on a multi-stop itinerary "draft".
 * No I/O, no LLM. Sits on top of itineraryBuilder.buildItinerary, so every date
 * is recomputed by the same code that built the trip in the first place.
 *
 *   draft = { origin, finalDestination, departureDate, arrivalOffsetDays?,
 *             stops: [{ id, city, nights }] }
 *
 *   createDraft(tripParams)            -> draft (adds stable ids)
 *   applyOp(draft, op)                 -> { ok, draft, plan, diff, message } | { ok:false, error }
 *   parseEdit(text, draft)             -> { op } | { needsChoice } | null   (null = not an edit, let the LLM/engine handle it)
 *   diffPlans(prevTrips, nextTrips)    -> which legs are untouched (keep picks) vs need a re-search
 *
 * ops: setNights, addNights, addStop, removeStop, moveStop, renameStop,
 *      setStartDate, setFinal, setOrigin
 */

const { buildItinerary } = require('./itineraryBuilder');

const CONFIG = { maxStops: 8, maxNightsPerStop: 30 };

const ALIASES = {
  'mara': 'maasai mara', 'masai mara': 'maasai mara', 'maasai mara': 'maasai mara', 'mara safari': 'maasai mara',
  'nbo': 'nairobi', 'msa': 'mombasa', 'dar': 'dar es salaam', 'nyc': 'new york', 'ny': 'new york',
  'dc': 'washington', 'washington dc': 'washington', 'joburg': 'johannesburg', 'capetown': 'cape town',
};
const NOT_A_PLACE = new Set(['hotel', 'hotels', 'flight', 'flights', 'transfer', 'transfers', 'night', 'nights', 'room', 'rooms',
  'breakfast', 'option', 'options', 'car', 'bus', 'train', 'insurance', 'tour', 'activity', 'activities', 'seat', 'bag', 'baggage']);
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// ── helpers ──────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const canon = (s) => { const n = norm(s).replace(/^the /, ''); return ALIASES[n] || n; };
const title = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const fmtDate = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const words2digits = (s) => s.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (m) => NUM_WORDS[m]);
const ORDINAL = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };
const ordinalWord = (n) => ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][n - 1] || `#${n}`;

function nextId(draft) { draft._seq = (draft._seq || 0) + 1; return `s${draft._seq}`; }
const clone = (d) => JSON.parse(JSON.stringify(d));

function createDraft(p) {
  const draft = {
    origin: p.origin, finalDestination: p.finalDestination || p.origin, departureDate: p.departureDate,
    arrivalOffsetDays: Number.isInteger(p.arrivalOffsetDays) ? p.arrivalOffsetDays : undefined,
    stops: [], _seq: 0,
  };
  (p.stops || []).forEach((s) => draft.stops.push({ id: nextId(draft), city: s.city, nights: parseInt(s.nights, 10) }));
  return draft;
}

function buildPlan(draft) {
  return buildItinerary({
    origin: draft.origin, finalDestination: draft.finalDestination, departureDate: draft.departureDate,
    arrivalOffsetDays: draft.arrivalOffsetDays,
    stops: draft.stops.map(({ city, nights }) => ({ city, nights })),
  });
}

function stayInfo(draft) {
  const plan = buildPlan(draft);
  if (!plan.ok) return [];
  return plan.segments.filter((s) => s.type === 'stay');
}

// ── stop lookup ──────────────────────────────────────────────────────────────
/** target: stop id | index | text ("mara", "second nairobi") -> { stop } | { ambiguous:[stops] } | { missing:true } */
function resolveStop(draft, target) {
  const stops = draft.stops;
  if (target == null) return { missing: true };
  if (Number.isInteger(target)) return stops[target] ? { stop: stops[target] } : { missing: true };
  if (typeof target === 'string' && /^s\d+$/.test(target)) {
    const s = stops.find((x) => x.id === target);
    return s ? { stop: s } : { missing: true };
  }
  let text = norm(target);
  let ord = null;
  const m = /^(first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(.+)$/.exec(text);
  if (m) { ord = m[1]; text = m[2]; }
  const c = canon(text.replace(/\b(stay|stop|leg|part|one)\b/g, '').trim());
  if (!c) return { missing: true };
  let hits = stops.filter((s) => canon(s.city) === c);
  if (!hits.length && c.length >= 4) hits = stops.filter((s) => canon(s.city).includes(c));
  if (!hits.length) return { missing: true };
  if (ord) {
    const pick = ord === 'last' ? hits[hits.length - 1] : hits[ORDINAL[ord] - 1];
    return pick ? { stop: pick } : { missing: true };
  }
  return hits.length > 1 ? { ambiguous: hits } : { stop: hits[0] };
}

function describeChoice(draft, hits, build) {
  const stays = stayInfo(draft);
  const options = hits.map((s) => {
    const idx = draft.stops.findIndex((x) => x.id === s.id);
    const nth = hits.indexOf(s) + 1;
    const st = stays[idx];
    const label = `the ${ordinalWord(nth)} ${title(s.city)} stay` + (st ? ` (${fmtDate(st.checkIn)} to ${fmtDate(st.checkOut)})` : '');
    return { id: s.id, label, op: build(s.id) };
  });
  return { question: `Which ${title(hits[0].city)} stay do you mean, ${options.map((o) => o.label).join(' or ')}?`, options };
}

// ── leg diff (what to re-search, what to keep) ──────────────────────────────
const sig = (t) => [norm(t.origin), norm(t.destination), t.departureDate || '', t.nights == null ? 0 : t.nights].join('|');

/** kept: next indexes unchanged (carry[next] = prev index so selections survive); changed: next indexes to re-search;
 *  moved: changed leg -> removed prev leg to the same place (offer the old pick as a one-tap suggestion). */
function diffPlans(prev = [], next = []) {
  const pool = new Map();
  prev.forEach((t, i) => { const k = sig(t); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(i); });
  const kept = [], changed = [], carry = {};
  next.forEach((t, i) => {
    const q = pool.get(sig(t));
    if (q && q.length) { carry[i] = q.shift(); kept.push(i); } else changed.push(i);
  });
  const used = new Set(Object.values(carry));
  const removed = prev.map((_, i) => i).filter((i) => !used.has(i));
  const moved = {};
  const freeRemoved = [...removed];
  changed.forEach((i) => {
    const j = freeRemoved.findIndex((r) => norm(prev[r].destination) === norm(next[i].destination));
    if (j >= 0) { moved[i] = freeRemoved[j]; freeRemoved.splice(j, 1); }
  });
  return { kept, changed, removed, carry, moved, firstChanged: changed.length ? Math.min(...changed) : -1 };
}

// ── applying ops ─────────────────────────────────────────────────────────────
function tail(before, after, laterStops) {
  const shift = before.ok ? daysBetween(before.returnDate, after.returnDate) : 0;
  const later = laterStops ? ' The stops after it move too.' : '';
  if (!shift) return `${later} Your flight home stays on ${fmtDate(after.returnDate)}.`.trim();
  const dir = shift > 0 ? 'later' : 'earlier';
  return `${later} Your flight home moves ${plural(Math.abs(shift), 'day')} ${dir}, to ${fmtDate(after.returnDate)}.`.trim();
}

function validNights(n) { return Number.isInteger(n) && n >= 1 && n <= CONFIG.maxNightsPerStop; }

function applyOp(draft, op) {
  const before = buildPlan(draft);
  const next = clone(draft);
  let message = '';
  const find = (t) => resolveStop(next, t);
  const need = (r, what) => (r.stop ? null : { ok: false, error: r.ambiguous ? `ambiguous ${what}` : `can't find ${what}` });

  switch (op && op.type) {
    case 'setNights': {
      const r = find(op.target); const bad = need(r, 'that stop'); if (bad) return bad;
      if (!validNights(op.nights)) return { ok: false, error: `nights must be 1-${CONFIG.maxNightsPerStop}` };
      const old = r.stop.nights; r.stop.nights = op.nights;
      const later = next.stops.indexOf(r.stop) < next.stops.length - 1;
      message = old === op.nights ? `${title(r.stop.city)} is already ${plural(old, 'night')}.`
        : `${title(r.stop.city)} is now ${plural(op.nights, 'night')}.`;
      next._tailLater = later;
      break;
    }
    case 'addNights': {
      const r = find(op.target); const bad = need(r, 'that stop'); if (bad) return bad;
      const n = r.stop.nights + op.delta;
      if (!validNights(n)) return { ok: false, error: `nights must be 1-${CONFIG.maxNightsPerStop}` };
      r.stop.nights = n;
      message = `${title(r.stop.city)} is now ${plural(n, 'night')}.`;
      next._tailLater = next.stops.indexOf(r.stop) < next.stops.length - 1;
      break;
    }
    case 'addStop': {
      if (next.stops.length >= CONFIG.maxStops) return { ok: false, error: `max ${CONFIG.maxStops} stops` };
      const city = String(op.city || '').trim();
      if (!city || NOT_A_PLACE.has(norm(city)) || city.split(/\s+/).length > 3) return { ok: false, error: 'invalid city' };
      const nights = op.nights == null ? 2 : op.nights;
      if (!validNights(nights)) return { ok: false, error: `nights must be 1-${CONFIG.maxNightsPerStop}` };
      let index = next.stops.length;
      if (op.position === 'start') index = 0;
      else if (op.afterId) { const i = next.stops.findIndex((s) => s.id === op.afterId); if (i < 0) return { ok: false, error: "can't find that stop" }; index = i + 1; }
      else if (op.beforeId) { const i = next.stops.findIndex((s) => s.id === op.beforeId); if (i < 0) return { ok: false, error: "can't find that stop" }; index = i; }
      next.stops.splice(index, 0, { id: nextId(next), city: title(city), nights });
      const where = index === next.stops.length - 1 ? 'at the end' : index === 0 ? 'at the start' : `as stop ${index + 1}`;
      message = `Added ${title(city)} for ${plural(nights, 'night')} ${where}.`;
      break;
    }
    case 'removeStop': {
      const r = find(op.target); const bad = need(r, 'that stop'); if (bad) return bad;
      if (next.stops.length <= 1) return { ok: false, error: 'a trip needs at least one stop' };
      next.stops = next.stops.filter((s) => s.id !== r.stop.id);
      message = `Removed ${title(r.stop.city)} (${plural(r.stop.nights, 'night')}).`;
      break;
    }
    case 'moveStop': {
      const r = find(op.target); const bad = need(r, 'that stop'); if (bad) return bad;
      const from = next.stops.findIndex((s) => s.id === r.stop.id);
      const to = Math.max(0, Math.min(next.stops.length - 1, op.toIndex));
      const [s] = next.stops.splice(from, 1); next.stops.splice(to, 0, s);
      message = `Moved ${title(s.city)} to stop ${to + 1}.`;
      break;
    }
    case 'renameStop': {
      const r = find(op.target); const bad = need(r, 'that stop'); if (bad) return bad;
      const old = r.stop.city; r.stop.city = title(op.city);
      message = `Swapped ${title(old)} for ${title(op.city)}.`;
      break;
    }
    case 'setStartDate': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(op.date || '')) return { ok: false, error: 'invalid date' };
      next.departureDate = op.date;
      message = `Now leaving on ${fmtDate(op.date)}.`;
      break;
    }
    case 'setFinal': {
      if (!op.city) return { ok: false, error: 'city missing' };
      next.finalDestination = title(op.city);
      message = `Flying home to ${title(op.city)}.`;
      break;
    }
    case 'setOrigin': {
      if (!op.city) return { ok: false, error: 'city missing' };
      next.origin = title(op.city);
      message = `Departing from ${title(op.city)}.`;
      break;
    }
    default:
      return { ok: false, error: `unknown op ${op && op.type}` };
  }

  const later = next._tailLater; delete next._tailLater;
  const after = buildPlan(next);
  if (!after.ok) return { ok: false, error: after.errors.join('; ') };
  message = `${message} ${tail(before, after, later)}`.trim();
  return { ok: true, draft: next, plan: after, diff: diffPlans(before.ok ? before.trips : [], after.trips), message, op };
}

// ── phrase parser (deterministic first pass; anything else falls through to the LLM) ──
function targetOp(draft, targetText, build) {
  const r = resolveStop(draft, targetText);
  if (r.missing) return null;
  if (r.ambiguous) return { needsChoice: describeChoice(draft, r.ambiguous, build) };
  return { op: build(r.stop.id) };
}

function parseLooseDate(str, draft) {
  const t = String(str || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); // keeps digits (norm() strips them)
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(String(str));
  if (iso) return iso[0];
  const baseYear = draft && draft.departureDate ? parseInt(draft.departureDate.slice(0, 4), 10) : new Date().getUTCFullYear();
  let m = /^(?:the\s+)?(\d{1,2})\s*(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})$/.exec(t) || /^([a-z]{3,9})\s+(\d{1,2})(?:\s*(?:st|nd|rd|th))?$/.exec(t);
  if (!m) return null;
  let day, mon;
  if (/^\d/.test(m[1])) { day = parseInt(m[1], 10); mon = MONTHS[m[2].slice(0, 4) === 'sept' ? 'sept' : m[2].slice(0, 3)]; }
  else { mon = MONTHS[m[1].slice(0, 4) === 'sept' ? 'sept' : m[1].slice(0, 3)]; day = parseInt(m[2], 10); }
  if (!mon || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(baseYear, mon - 1, day));
  if (d.getUTCMonth() !== mon - 1) return null;
  return d.toISOString().slice(0, 10);
}

function parseEdit(text, draft) {
  if (!draft || !Array.isArray(draft.stops) || !draft.stops.length) return null;
  const t = words2digits(String(text || '').toLowerCase().trim().replace(/[.!?]+$/g, '').replace(/^(?:please|pls|can you|could you)\s+/, ''));
  let m;

  // "make the mara 3 nights" / "change mara to 3 nights"
  if ((m = /^(?:make|set|change)\s+(?:the\s+)?(.+?)\s+(?:to\s+|for\s+)?(\d+)\s*nights?$/.exec(t)))
    return targetOp(draft, m[1], (id) => ({ type: 'setNights', target: id, nights: parseInt(m[2], 10) }));
  // "make it 3 nights in the mara" / "3 nights in the mara instead"
  if ((m = /^(?:make it|change it to|do|let'?s do|i want|i'?d like)\s+(\d+)\s*nights?\s+(?:in|at)\s+(?:the\s+)?(.+?)(?:\s+instead)?$/.exec(t))
    || (m = /^(\d+)\s*nights?\s+(?:in|at)\s+(?:the\s+)?(.+?)(?:\s+instead)?$/.exec(t)))
    return targetOp(draft, m[2], (id) => ({ type: 'setNights', target: id, nights: parseInt(m[1], 10) }));
  // "add a night in nairobi" / "one more night in the mara"
  if ((m = /^add\s+(?:(\d+)|an?)\s+(?:(?:more|extra|additional)\s+)?nights?\s+(?:in|at|to)\s+(?:the\s+)?(.+)$/.exec(t))
    || (m = /^(?:(\d+)|an?)\s+(?:more|extra|additional)\s+nights?\s+(?:in|at|to)\s+(?:the\s+)?(.+)$/.exec(t)))
    return targetOp(draft, m[2], (id) => ({ type: 'addNights', target: id, delta: m[1] ? parseInt(m[1], 10) : 1 }));
  // "one less night in nairobi"
  if ((m = /^(?:(\d+)|an?)\s+(?:fewer|less)\s+nights?\s+(?:in|at)\s+(?:the\s+)?(.+)$/.exec(t)))
    return targetOp(draft, m[2], (id) => ({ type: 'addNights', target: id, delta: -(m[1] ? parseInt(m[1], 10) : 1) }));
  // "skip the second nairobi" / "drop mombasa"
  if ((m = /^(?:drop|remove|skip|delete|cancel|scrap|cut)\s+(?:the\s+)?(.+?)(?:\s+(?:stop|stay|leg|part))?$/.exec(t)))
    return targetOp(draft, m[1], (id) => ({ type: 'removeStop', target: id }));
  // "add mombasa for 2 nights at the end" / "also visit zanzibar" / "add a stop in lamu"
  if ((m = /^(?:add|include|also visit|also add|squeeze in|throw in)\s+(?:a\s+stop\s+(?:in|at)\s+)?(?:the\s+)?([a-z][a-z ]{1,24}?)(?:\s+for\s+(\d+)\s*nights?)?(?:\s+(at the end|at the start|at the beginning|first|last|before\s+.+|after\s+.+))?$/.exec(t))) {
    const city = m[1].trim();
    if (NOT_A_PLACE.has(norm(city)) || /\bnights?\b/.test(city) || /^(?:an?)\s/.test(city)) return null;
    const nights = m[2] ? parseInt(m[2], 10) : undefined;
    const pos = (m[3] || '').trim();
    const base = { type: 'addStop', city, nights };
    if (/^(?:at the start|at the beginning|first)$/.test(pos)) return { op: { ...base, position: 'start' } };
    const ba = /^(before|after)\s+(?:the\s+)?(.+)$/.exec(pos);
    if (ba) return targetOp(draft, ba[2], (id) => ({ ...base, [ba[1] === 'before' ? 'beforeId' : 'afterId']: id }));
    return { op: base };
  }
  // "leave on 12 december" / "start on dec 12"
  if ((m = /^(?:start|leave|depart|begin|fly out)\s+(?:on\s+)?(.+)$/.exec(t))) {
    const date = parseLooseDate(m[1], draft);
    return date ? { op: { type: 'setStartDate', date } } : null;
  }
  // "fly home to houston"
  if ((m = /^(?:fly home to|fly back to|return to|going back to|go home to)\s+(?:the\s+)?([a-z][a-z ]{1,24})$/.exec(t)))
    return { op: { type: 'setFinal', city: m[1].trim() } };
  return null;
}

module.exports = { createDraft, buildPlan, applyOp, parseEdit, diffPlans, resolveStop, parseLooseDate, CONFIG };
