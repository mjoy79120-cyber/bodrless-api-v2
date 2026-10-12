'use strict';

const { clean } = require('./text');
const { resolvePlaceLocal } = require('./places');

// Words that mean the "origin" is really a piece of the user's sentence.
const NOT_A_PLACE = /\b(am|i|im|i'm|we|you|thinking|coming|going|want|wanna|need|looking|planning|hoping|trying|would|like|book|plan|find|get|help|please|just|any|same|here|there|home|anywhere|flight|flights|trip|travel|travelling|traveling|visit|visiting|for|with|the|a|an|my|our|and|or|but|to)\b/i;

/**
 * Decide whether a parsed origin is a real place.
 *  known         -> canonical city (fuzzy-matched, e.g. "kairo" -> Cairo)
 *  not_a_place   -> sentence fragment / filler  => null
 *  unknown_place -> looks like a name but we can't verify: kept only if the caller
 *                   has no async resolver (flagged), otherwise validated by it.
 */
async function sanitizeOrigin(raw, { resolvePlace } = {}) {
  if (raw == null) return { origin: null, reason: 'empty' };
  const s = clean(String(raw), 60).replace(/^from\s+/i, '').split(/\s+to\s+/i)[0].trim();
  if (!s) return { origin: null, reason: 'empty' };

  const local = resolvePlaceLocal(s);
  if (local) return { origin: local, reason: 'known' };

  if (s.split(' ').length > 3 || /[.,;:!?]/.test(s) || NOT_A_PLACE.test(s)) {
    return { origin: null, reason: 'not_a_place' };
  }

  if (typeof resolvePlace === 'function') {
    try {
      const r = await resolvePlace(s);
      const name = typeof r === 'string' ? r : r?.name;
      return name ? { origin: name, reason: 'resolved' } : { origin: null, reason: 'unresolvable' };
    } catch {
      /* resolver down: fall through and keep the plausible-looking value */
    }
  }
  return { origin: s, reason: 'unknown_place', unverified: true };
}

/**
 * Wrap promptParser.parsePrompt so an invalid origin can never reach a supplier call.
 *
 *   // bottom of promptParser.js
 *   module.exports.parsePrompt = guardParsePrompt(parsePrompt);
 *
 * It nulls bad origins, forces needsOriginClarification, and fixes _missingFields.
 */
function guardParsePrompt(parsePromptFn, { resolvePlace, logger } = {}) {
  return async function guardedParsePrompt(...args) {
    const parsed = await parsePromptFn(...args);
    if (!parsed || typeof parsed !== 'object') return parsed;

    if (parsed.origin) {
      const { origin, reason, unverified } = await sanitizeOrigin(parsed.origin, { resolvePlace });
      if (!origin) {
        logger?.warn?.('originGuard: rejected parsed origin', { was: String(parsed.origin).slice(0, 60), reason });
        parsed.origin = null;
        if (!parsed.isHotelOnly) parsed.needsOriginClarification = true;
        const mf = new Set(Array.isArray(parsed._missingFields) ? parsed._missingFields : []);
        if (!parsed.isHotelOnly) mf.add('origin');
        parsed._missingFields = [...mf];
        if (typeof parsed._confidence === 'number') parsed._confidence = Math.max(0, parsed._confidence - 0.2);
      } else {
        parsed.origin = origin;
        if (unverified) parsed._originUnverified = true;
      }
    }

    const norm = (v) => String(v || '').toLowerCase().trim();
    if (parsed.origin && parsed.destination && norm(parsed.origin) === norm(parsed.destination)) {
      parsed.origin = null;
      if (!parsed.isHotelOnly) parsed.needsOriginClarification = true;
    }
    return parsed;
  };
}

module.exports = { sanitizeOrigin, guardParsePrompt };
