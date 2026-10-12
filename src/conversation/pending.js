'use strict';

const { norm, words, titleCase } = require('./text');
const { extractPlaceFromAnswer, findPlaceMention } = require('./places');
const { parseDateLoose, isFlexibleDateAnswer } = require('./dates');

/**
 * The engine marks "I'm waiting for an answer" with flags on tripParams.
 * This module reads those flags, decides whether a new message really IS the answer,
 * and (crucially) lets every other message through without being swallowed.
 */

const FLAG_KEYS = ['_awaitingHotelFollowUp', '_awaitingClarification', '_awaitingRestoreConfirm'];

function derivePending(params) {
  if (!params) return null;
  if (params._awaitingHotelFollowUp) return { type: 'hotel_followup' };
  const m = params._awaitingClarification;
  if (m && typeof m === 'object' && m.type) return { type: m.type, marker: m };
  if (params._awaitingRestoreConfirm) return { type: 'restore_confirm' };
  return null;
}

function stripFlags(params) {
  if (!params) return params;
  const out = { ...params };
  for (const k of FLAG_KEYS) delete out[k];
  return out;
}

const YES = /^(?:yes|y|yeah|yep|yup|yah|sure|ok|okay|okey|add|include|ndio|sawa|naam|go ahead|please do|do it|yes please|yes add|add (?:a )?hotels?|add them|include hotels?|sure thing)[!. ]*$/;
const NO = /^(?:no|n|nope|nah|skip|hapana|no thanks|no thank you|not now|just the flight|just flight|flight only|only flight|only the flight|just flights?|book it|no hotel|no hotels|i'?m good|dont|don'?t)[!. ]*$/;

function yesNo(text) {
  const t = norm(text).replace(/[,]/g, '');
  if (YES.test(t)) return 'yes';
  if (NO.test(t)) return 'no';
  return null;
}

const ORIGIN_TYPES = new Set(['single_origin', 'overall_origin', 'leg_origin']);

function questionFor(pending, params = {}) {
  const dest = params.destination ? titleCase(params.destination) : 'your destination';
  switch (pending?.type) {
    case 'departure_date': return `When are you looking to travel to ${dest}? A rough date or month is fine.`;
    case 'single_origin':
    case 'overall_origin': {
      const prev = params._lastConfirmedOrigin || params.origin;
      return prev
        ? `Flying from ${titleCase(prev)} again? Or tell me a different city.`
        : `Which city will you be flying from? (For example Nairobi, Kampala, Cairo or London.)`;
    }
    case 'leg_origin': return `Which city will you be leaving from${pending.marker?.destination ? ` for ${titleCase(pending.marker.destination)}` : ''}?`;
    case 'hotel_followup': return `Would you like me to add hotels in ${dest} to your flight options? Reply yes or no.`;
    case 'destination': return `Where would you like to travel to?`;
    case 'child_age': return `How old ${(params.children || 0) === 1 ? 'is the child' : 'are the children'} travelling? I need the age to price the hotel.`;
    case 'restore_confirm': return `Would you like to continue your saved trip? Reply yes to continue or no to start fresh.`;
    default: return null;
  }
}

/**
 * Does `text` answer the pending question?
 *   { ok: true,  delegateText }  -> hand delegateText to the engine (canonicalised)
 *   { ok: false, reject: true, text } -> it looked like an answer but is invalid; re-ask, keep pending
 *   { ok: false }                -> not an answer; let normal intent routing handle it
 */
async function accepts(pending, text, { now = new Date(), params = {}, resolvePlace = null } = {}) {
  const t = norm(text);
  const toks = words(text);
  const hasPlace = !!findPlaceMention(t);

  switch (pending.type) {
    case 'hotel_followup': {
      const yn = yesNo(text);
      return yn ? { ok: true, delegateText: yn } : { ok: false };
    }
    case 'restore_confirm': {
      const yn = yesNo(text);
      if (yn || /^(?:1|2|continue|fresh|new|start over)$/.test(t)) return { ok: true, delegateText: yn || t };
      return { ok: false };
    }
    case 'departure_date': {
      if (isFlexibleDateAnswer(t) && toks.length <= 8) return { ok: true, delegateText: text };
      const d = parseDateLoose(t, now);
      // a date inside a bigger trip sentence ("go to mombasa on 20 oct") is a NEW trip, not an answer
      if (d && toks.length <= 8 && !hasPlace && !/\b(plan|book|trip|fly|flight|travel)\b/.test(t)) {
        return { ok: true, delegateText: d.iso };
      }
      if (d) return { ok: false };
      if (toks.length <= 3 && !hasPlace && !yesNo(text) && /\d/.test(t)) {
        return { ok: false, reject: true, text: `I couldn't read that as a date, or it's in the past. Try something like "20 Nov", "early December", or just "December".` };
      }
      return { ok: false };
    }
    case 'single_origin':
    case 'overall_origin':
    case 'leg_origin': {
      // "yes" confirms the city we already suggested in the question
      const yn = yesNo(text);
      if (yn === 'yes') {
        const confirmed = params._lastConfirmedOrigin || params.origin;
        if (confirmed) return { ok: true, delegateText: confirmed };
      }
      if (yn === 'no') return { ok: false }; // let them type a different city — don't consume as miss

      let place = extractPlaceFromAnswer(text);
      if (!place && typeof resolvePlace === 'function' && toks.length <= 3 && toks.length > 0) {
        try { const r = await resolvePlace(text); place = typeof r === 'string' ? r : r?.name || null; } catch { /* ignore */ }
      }
      if (place) {
        if (params.destination && norm(place) === norm(params.destination) && pending.type !== 'leg_origin') {
          return { ok: false, reject: true, text: `That's the same place you're travelling to (${titleCase(place)}). Which city will you be flying from instead?` };
        }
        return { ok: true, delegateText: place };
      }
      // short, answer-shaped but not a place we know
      if (toks.length >= 1 && toks.length <= 3 && !/\b(plan|book|trip|fly|flight|travel|am|i|you|thinking|coming|going)\b/.test(t) && !t.includes('?')) {
        return { ok: false, reject: true, text: `I couldn't match "${text.slice(0, 40)}" to a city or airport. Which city will you be flying from? (For example Nairobi, Kampala, Cairo or London.)` };
      }
      return { ok: false };
    }
    case 'destination': {
      const place = extractPlaceFromAnswer(text);
      if (place) return { ok: true, delegateText: place };
      return { ok: false };
    }
    case 'child_age': {
      const nums = (t.match(/\b\d{1,2}\b/g) || []).map(Number).filter((n) => n >= 0 && n < 18);
      if (nums.length && toks.length <= 8 && !hasPlace) return { ok: true, delegateText: text };
      return { ok: false };
    }
    default:
      return { ok: false };
  }
}

module.exports = { FLAG_KEYS, derivePending, stripFlags, yesNo, questionFor, accepts, ORIGIN_TYPES };
