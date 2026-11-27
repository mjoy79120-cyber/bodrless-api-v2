'use strict';
// Thin adapter between engine session params and itineraryEditor. Pure (no I/O).
// Usage in engine.orchestrate(): const g = tryEdit(prompt, previousParams); see integration notes.
const E = require('./itineraryEditor');

const ORD = { first: 0, '1st': 0, one: 0, '1': 0, second: 1, '2nd': 1, two: 1, '2': 1, third: 2, '3rd': 2, three: 2, '3': 2, fourth: 3, '4th': 3, four: 3, '4': 3 };

function hasItinerary(p) {
  return !!(p && p._itineraryBuilt && Array.isArray(p.stops) && p.stops.length && p.origin && p.departureDate);
}

function pickChoice(text, options) {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (/^(last|the last one|latter)$/.test(t)) return options[options.length - 1];
  const m = /^(?:the |option |number |no )?(first|second|third|fourth|1st|2nd|3rd|4th|one|two|three|four|[1-4])(?: one| stay)?$/.exec(t);
  if (m && ORD[m[1]] != null && options[ORD[m[1]]]) return options[ORD[m[1]]];
  return null;
}

function toParams(prev, draft, plan) {
  return {
    ...prev,
    origin: draft.origin, finalDestination: draft.finalDestination, departureDate: draft.departureDate,
    stops: draft.stops.map(({ city, nights }) => ({ city, nights })),
    _pendingEditChoice: undefined,
    // _continueOrchestration rebuilds trips from stops; clear stale legs so nothing leaks through
    trips: undefined, returnDate: plan.returnDate,
  };
}

function tryEdit(prompt, prev) {
  if (!hasItinerary(prev)) return null;
  const draft = E.createDraft(prev);
  const prevPlan = E.buildPlan(draft);
  if (!prevPlan.ok) return null;

  // 1) answering an earlier "which one?" question
  if (Array.isArray(prev._pendingEditChoice) && prev._pendingEditChoice.length) {
    const picked = pickChoice(prompt, prev._pendingEditChoice);
    if (picked) return finish(prev, draft, prevPlan, picked.op);
    // anything else abandons the pending question and is treated as a fresh message below
  }

  // 2) a fresh edit
  const parsed = E.parseEdit(prompt, draft);
  if (!parsed) return null;
  if (parsed.needsChoice) {
    return {
      kind: 'ask', question: parsed.needsChoice.question,
      pendingChoice: parsed.needsChoice.options.map(({ label, op }) => ({ label, op })),
    };
  }
  return finish(prev, draft, prevPlan, parsed.op);
}

function finish(prev, draft, prevPlan, op) {
  const res = E.applyOp(draft, op);
  if (!res.ok) return { kind: 'error', message: res.error };
  return {
    kind: 'applied', message: res.message, op,
    tripParams: toParams(prev, res.draft, res.plan),
    diff: res.diff, prevTrips: prevPlan.trips, nextTrips: res.plan.trips,
  };
}

module.exports = { tryEdit, hasItinerary, pickChoice };
