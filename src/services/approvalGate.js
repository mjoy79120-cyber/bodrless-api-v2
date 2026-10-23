/**
 * APPROVAL GATE  (v2)
 * ─────────────────────────────────────────────────────────────
 * Called AFTER orchestration returns packages, BEFORE they are sent
 * to the traveler.
 *
 * Manual-mode agency  -> packages saved as ONE pending package_request
 *                        per (agency, session); traveler gets a hold
 *                        message; check() returns true (do not send).
 * Auto / Triply       -> no-op; check() returns false.
 *
 * Changes from v1:
 *  - `send` may be a no-op, sync, or undefined; a send failure can no
 *    longer flip a successful hold into "not held" (which used to send
 *    unapproved packages AND leave a pending request behind).
 *  - A new search while a request is pending supersedes that request
 *    (latest search wins) instead of creating a duplicate row.
 *  - Missing agencyRow.id is logged loudly instead of writing
 *    agency_id = null (a request no dashboard can ever see).
 *  - getPending() lets callers short-circuit "any update?" messages
 *    without re-running orchestration.
 *
 * Needs the partial unique index in migrations/001_approval_flow.sql
 * for race-safety; works without it, just with a small duplicate window.
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const Groq = require('groq-sdk');

const HOLD_MSG = "✈️ Got your trip! Our agent is going through the options and handpicking the best ones for you — we'll send them your way shortly. Hang tight!";
const STILL_HOLDING_MSG = "Still working on it! Our agent is just finalizing your options — won't be long now. We'll ping you as soon as they're ready 🙏";

// ─────────────────────────────────────────────
// GROQ CLIENT (lazy)
// ─────────────────────────────────────────────
let _groq = null;
function _getGroq() {
  if (!_groq && process.env.GROQ_API_KEY) {
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

const CONTEXT_PROMPT = `Extract travel signals from the prompt. Return a single JSON object with these keys (null if not present):
travelerName, occasion (honeymoon/anniversary/birthday/family_holiday/business/romantic_getaway/graduation/babymoon/solo_travel/other), groupType (couple/family/solo/friends/corporate), destination, origin, departureDate (YYYY-MM-DD), returnDate (YYYY-MM-DD), nights (number), passengers (number), children (number), budget (low/mid/high/luxury), budgetKES (number), specialRequests.

Rules: "birthday" → occasion:birthday. "honeymoon/babymoon/anniversary" → occasion field. "couple/wife/husband/two of us" → groupType:couple + passengers:2. "friend/friends" → groupType:friends. "300k" → budgetKES:300000. Assume year 2026 for dates. Return JSON only, no other text.`;

async function _extractContext(prompt) {
  const groq = _getGroq();
  if (!groq || !prompt) return {};
  try {
    const completion = await groq.chat.completions.create({
      model:       'openai/gpt-oss-120b',
      messages:    [
        { role: 'system', content: CONTEXT_PROMPT },
        { role: 'user',   content: prompt },
      ],
      temperature: 0,
      max_tokens:  500,
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    logger.info('approvalGate: raw model output', { raw: raw?.slice(0, 200) });
    if (!raw) return {};
        const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return {};
    const parsed = JSON.parse(match[0]);
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => v !== null && v !== undefined)
    );
  } catch (err) {
    logger.warn('approvalGate: context extraction failed', { error: err.message });
    return {};
  }
}

function isManual(agencyRow) {
  if (!agencyRow) return false;
  if (agencyRow.integration_type === 'triply') return false;
  return agencyRow.approval_mode === 'manual';
}

async function _safeSend(send, msg) {
  if (typeof send !== 'function') return;
  try {
    await send(msg);              // works for sync, async and no-op senders
  } catch (err) {
    logger.warn('approvalGate: hold message send failed (request is still held)', { error: err.message });
  }
}

/**
 * Is there already a pending request for this traveler session?
 * @returns {Promise<{id: string, created_at: string}|null>}
 */
async function getPending(agencyId, userKey) {
  if (!agencyId || !userKey) return null;
  try {
    const { data, error } = await supabase
      .from('package_requests')
      .select('id, created_at')
      .eq('agency_id', agencyId)
      .eq('session_key', userKey)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      logger.warn('approvalGate: getPending failed', { error: error.message, userKey });
      return null;
    }
    return data || null;
  } catch (err) {
    logger.warn('approvalGate: getPending threw', { error: err.message, userKey });
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.agencyRow  { id, integration_type, approval_mode } — id is REQUIRED
 * @param {object} opts.result     orchestration result (.packages, .tripParams)
 * @param {string} opts.userKey    session key / phone — must equal what the traveler's channel resolves with
 * @param {string} opts.channel    'whatsapp' | 'widget'
 * @param {string} [opts.phone]    traveler phone (WhatsApp only)
 * @param {function} [opts.send]   (message) => any — optional, failures are swallowed
 * @returns {Promise<boolean>}     true if packages were held (do NOT send them)
 */
async function check({ agencyRow, result, userKey, channel, phone, send, prompt }) {
  if (!isManual(agencyRow)) return false;
  if (!result?.packages?.length) return false;   // clarifications / no-results pass through

  if (!agencyRow.id || !userKey) {
    // Fail open (don't strand the traveler) but make it impossible to miss.
    logger.error('approvalGate: MANUAL agency but agencyRow.id or userKey missing — packages NOT gated', {
      alert: true, hasAgencyId: !!agencyRow.id, hasUserKey: !!userKey, channel,
    });
    return false;
  }

  const travelerContext = prompt ? await _extractContext(prompt) : {};
  logger.info('approvalGate: extracted context', { userKey, prompt: prompt?.slice(0, 80), travelerContext });

  const fields = {
    trip_params:      result.tripParams || {},
    packages:         result.packages   || [],
    traveler_context: Object.keys(travelerContext).length ? travelerContext : null,
  };

  try {
    // 1) Supersede an existing pending request for this session (latest search wins)
    const { data: updated, error: updErr } = await supabase
      .from('package_requests')
      .update(fields)
      .eq('agency_id', agencyRow.id)
      .eq('session_key', userKey)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();

    if (updErr) throw updErr;

    if (updated) {
      logger.info('approvalGate: pending request superseded by newer search', { userKey, requestId: updated.id });
      await _safeSend(send, HOLD_MSG);
      return true;
    }

    // 2) Nothing pending — create one
    const { error: insErr } = await supabase
      .from('package_requests')
      .insert({
        agency_id:      agencyRow.id,
        session_key:    userKey,
        channel,
        traveler_phone: phone || null,
        status:         'pending',
        ...fields,
      });

    // 23505 = unique violation: a concurrent request just created the pending row. Still held.
    if (insErr && insErr.code !== '23505') throw insErr;

    logger.info('approvalGate: packages held for agent review', { userKey, channel, count: fields.packages.length });
    await _safeSend(send, HOLD_MSG);
    return true;

  } catch (err) {
    logger.error('approvalGate: could not hold packages — falling through to direct send', {
      alert: true, error: err.message, userKey, channel,
    });
    return false;   // fail open: better to send than silently drop
  }
}

module.exports = { check, getPending, isManual, HOLD_MSG, STILL_HOLDING_MSG };