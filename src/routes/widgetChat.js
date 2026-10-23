/**
 * WIDGET LIVE CHAT — TRAVELER ENDPOINTS
 * ─────────────────────────────────────────────────────────────
 * Handles the traveler side of the live chat flow.
 * All routes are public (authenticated by x-api-key / x-visitor-token).
 *
 * Mount in server.js:
 *   const widgetChat = require('./routes/widgetChat');
 *   app.use('/api/widget/chat', widgetChat);
 *
 * Endpoints:
 *   POST /start              start a live chat thread
 *   POST /send               traveler sends a message
 *   GET  /poll               traveler polls for new agent messages
 *   POST /back               traveler goes back to bot assistant
 *   GET  /config             widget checks if live chat is available
 *   GET  /poll-approval      widget polls for package approval (manual mode)
 * ─────────────────────────────────────────────────────────────
 */

const express    = require('express');
const router     = express.Router();
const Joi        = require('joi');
const Groq       = require('groq-sdk');
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

const TIMEOUT_MS   = 30 * 60 * 1000;
const NUDGE_MSG    = "Still there? Your agent hasn't replied yet. Would you like to keep waiting or go back to the assistant?";
const MAX_MSG_LEN  = 1000;

// ─────────────────────────────────────────────
// GROQ CLIENT (lazy, shared)
// ─────────────────────────────────────────────
let _groq = null;
function _getGroq() {
  if (!_groq && process.env.GROQ_API_KEY) {
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _groq;
}

// ─────────────────────────────────────────────
// CONTEXT EXTRACTION
// Pulls traveler signals from a single message
// and merges them into the thread's trip_params.
// Runs fire-and-forget after /send saves the msg.
// ─────────────────────────────────────────────

const CONTEXT_SYSTEM_PROMPT = `You are a travel context extractor for a live agent dashboard.
Given a traveler's chat message, extract any signals present. Return ONLY valid JSON — no markdown, no extra text.

Extract these fields (null if not present in THIS message):
{
  "travelerName":     "string|null",        // name if they introduced themselves
  "occasion":         "string|null",        // honeymoon|anniversary|birthday|family_holiday|business|romantic_getaway|graduation|babymoon|group_travel|solo_travel|other
  "groupType":        "string|null",        // couple|family|solo|friends|corporate
  "destination":      "string|null",        // place name only, 1-4 words
  "origin":           "string|null",        // departure city only, null if not stated
  "departureDate":    "YYYY-MM-DD|null",
  "returnDate":       "YYYY-MM-DD|null",
  "nights":           "number|null",
  "passengers":       "number|null",        // adults only
  "children":         "number|null",
  "budget":           "low|mid|high|luxury|null",
  "budgetKES":        "number|null",        // raw KES amount if stated
  "mealPlan":         "string|null",        // all_inclusive|full_board|half_board|bed_and_breakfast|room_only
  "propertyType":     "string|null",        // beachfront|lodge|villa|tented_camp|boutique|quiet|secluded etc.
  "activityRequests": [],                   // ["snorkelling","safari","hiking" etc.]
  "specialRequests":  "string|null"         // anything else noteworthy: dietary, accessibility, special setup
}

Rules:
- YEAR: assume 2026 for any date without a year.
- "honeymoon", "babymoon", "anniversary trip" → occasion field, NOT specialRequests.
- "couple", "my wife/husband", "two of us" → groupType: "couple", passengers: 2.
- "family" with kids → groupType: "family".
- Only extract what is EXPLICITLY in this message. Do not infer or guess.
- specialRequests: capture free-text notes that don't fit other fields. Max 120 chars.`;

/**
 * Extract context signals from a single traveler message.
 * Returns an object with only the non-null fields found.
 */
async function _extractContext(text) {
  const groq = _getGroq();
  if (!groq) return {};

  try {
    const completion = await groq.chat.completions.create({
      model:           'openai/gpt-oss-120b',
      messages:        [
        { role: 'system', content: CONTEXT_SYSTEM_PROMPT },
        { role: 'user',   content: text },
      ],
      temperature:     0,
      max_tokens:      400,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return {};

    const parsed = JSON.parse(raw);

    // Strip nulls and empty arrays — only keep what was actually found
    const found = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      found[k] = v;
    }
    return found;

  } catch (err) {
    logger.warn('widgetChat: context extraction failed', { error: err.message });
    return {};
  }
}

/**
 * Merge newly extracted context into the thread's existing trip_params.
 * Existing values are never overwritten — new signals fill in gaps only.
 * Special cases:
 *   - travelerName also updates chat_threads.traveler_name if it was null.
 *   - activityRequests are union-merged (no duplicates).
 *   - specialRequests are appended if a new one differs from existing.
 */
async function _mergeContextIntoThread(threadId, agencyId, existing, extracted) {
  if (!Object.keys(extracted).length) return;

  const current = existing || {};
  const update  = {};

  for (const [k, v] of Object.entries(extracted)) {
    if (k === 'activityRequests') {
      const merged = [...new Set([...(current.activityRequests || []), ...v])];
      if (merged.length > (current.activityRequests || []).length) {
        update.activityRequests = merged;
      }
      continue;
    }

    if (k === 'specialRequests') {
      if (!current.specialRequests) {
        update.specialRequests = v;
      } else if (!current.specialRequests.includes(v)) {
        // Append new note, cap at 300 chars total
        update.specialRequests = `${current.specialRequests}; ${v}`.slice(0, 300);
      }
      continue;
    }

    // All other fields: only fill if missing
    if (current[k] === null || current[k] === undefined) {
      update[k] = v;
    }
  }

  if (!Object.keys(update).length) return;

  const merged = { ...current, ...update };

  const threadUpdate = { trip_params: merged };

  // If we just learned the traveler's name, surface it on the thread row too
  if (update.travelerName) {
    threadUpdate.traveler_name = update.travelerName;
  }

  const { error } = await supabase
    .from('chat_threads')
    .update(threadUpdate)
    .eq('id', threadId)
    .eq('agency_id', agencyId);

  if (error) {
    logger.warn('widgetChat: failed to merge context into thread', { threadId, error: error.message });
  } else {
    logger.info('widgetChat: context merged', { threadId, updatedKeys: Object.keys(update) });
  }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function _resolveAgency(req) {
  const key = req.headers['x-api-key'] || req.headers['x-hotel-key'];
  if (!key) return null;
  const { data } = await supabase
    .from('agencies')
    .select('id, name, integration_type, live_chat_enabled, approval_mode')
    .or(`api_key.eq.${key},id.eq.${key}`)
    .maybeSingle();
  return data || null;
}

function _visitorToken(req) {
  return (req.headers['x-visitor-token'] || '').slice(0, 80);
}

// ─────────────────────────────────────────────
// GET /config
// ─────────────────────────────────────────────
router.get('/config', async (req, res) => {
  try {
    const agency = await _resolveAgency(req);
    if (!agency) return res.json({ liveChatEnabled: false });
    return res.json({
      liveChatEnabled: agency.live_chat_enabled === true &&
                       agency.integration_type  !== 'triply',
      agencyName: agency.name,
    });
  } catch (err) {
    logger.error('widgetChat GET /config', { error: err.message });
    return res.json({ liveChatEnabled: false });
  }
});

// ─────────────────────────────────────────────
// POST /start
// ─────────────────────────────────────────────
router.post('/start', async (req, res) => {
  const schema = Joi.object({
    botHistory:    Joi.array().max(30).optional(),
    tripParams:    Joi.object().allow(null).optional(),
    lastPackages:  Joi.array().max(4).optional(),
    travelerName:  Joi.string().max(60).allow('', null).optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const agency  = await _resolveAgency(req);
    if (!agency) return res.status(401).json({ success: false, error: 'Invalid agency key' });

    if (agency.integration_type === 'triply') {
      return res.status(403).json({ success: false, error: 'Live chat not available for this agency' });
    }
    if (!agency.live_chat_enabled) {
      return res.status(403).json({ success: false, error: 'Live chat is not enabled for this agency' });
    }

    const sessionKey = _visitorToken(req);
    if (!sessionKey) return res.status(400).json({ success: false, error: 'Visitor token required' });

    await supabase
      .from('chat_threads')
      .update({ status: 'closed', closed_by: 'traveler', closed_at: new Date().toISOString() })
      .eq('session_key', sessionKey)
      .eq('agency_id', agency.id)
      .eq('status', 'open');

    const { data: thread, error: insertErr } = await supabase
      .from('chat_threads')
      .insert({
        agency_id:     agency.id,
        session_key:   sessionKey,
        channel:       'widget',
        traveler_name: value.travelerName || null,
        bot_history:   value.botHistory   || [],
        trip_params:   value.tripParams   || null,
        last_packages: value.lastPackages || null,
        status:        'open',
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    await supabase.from('chat_messages').insert({
      thread_id: thread.id,
      agency_id: agency.id,
      sender:    'system',
      text:      `${value.travelerName || 'A traveler'} has requested to chat with an agent.`,
    });

    logger.info('widgetChat: thread started', { threadId: thread.id, agencyId: agency.id, sessionKey });
    return res.json({ success: true, threadId: thread.id });

  } catch (err) {
    logger.error('widgetChat POST /start', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to start chat' });
  }
});

// ─────────────────────────────────────────────
// POST /send
// ─────────────────────────────────────────────
router.post('/send', async (req, res) => {
  const schema = Joi.object({
    threadId: Joi.string().uuid().required(),
    text:     Joi.string().min(1).max(MAX_MSG_LEN).required(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const sessionKey = _visitorToken(req);
    const agency     = await _resolveAgency(req);
    if (!agency) return res.status(401).json({ success: false, error: 'Invalid agency key' });

    const { data: thread } = await supabase
      .from('chat_threads')
      .select('id, status, agency_id, trip_params')
      .eq('id', value.threadId)
      .eq('session_key', sessionKey)
      .eq('agency_id', agency.id)
      .single();

    if (!thread)                  return res.status(404).json({ success: false, error: 'Thread not found' });
    if (thread.status !== 'open') return res.status(409).json({ success: false, error: 'Thread is closed' });

    const safeText = value.text.replace(/<[^>]*>/g, '').trim();

    const { data: msg, error: msgErr } = await supabase
      .from('chat_messages')
      .insert({
        thread_id: thread.id,
        agency_id: agency.id,
        sender:    'traveler',
        text:      safeText,
      })
      .select()
      .single();

    if (msgErr) throw msgErr;

    // ── Context extraction — fire-and-forget ──────────────────────────
    // Runs after we've already responded to the traveler. No await.
    _extractContext(safeText).then(extracted => {
      return _mergeContextIntoThread(thread.id, agency.id, thread.trip_params, extracted);
    }).catch(err => {
      logger.warn('widgetChat: background context extraction error', { error: err.message });
    });
    // ─────────────────────────────────────────────────────────────────

    logger.info('widgetChat: traveler message', { threadId: thread.id, len: safeText.length });
    return res.json({ success: true, messageId: msg.id });

  } catch (err) {
    logger.error('widgetChat POST /send', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to send message' });
  }
});

// ─────────────────────────────────────────────
// GET /poll
// ─────────────────────────────────────────────
router.get('/poll', async (req, res) => {
  const { threadId, after } = req.query;
  if (!threadId) return res.status(400).json({ success: false, error: 'threadId required' });

  try {
    const sessionKey = _visitorToken(req);
    const agency     = await _resolveAgency(req);
    if (!agency) return res.status(401).json({ success: false, error: 'Invalid agency key' });

    const { data: thread } = await supabase
      .from('chat_threads')
      .select('id, status, nudge_sent_at, created_at')
      .eq('id', threadId)
      .eq('session_key', sessionKey)
      .eq('agency_id', agency.id)
      .single();

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

    let query = supabase
      .from('chat_messages')
      .select('id, sender, text, packages, agent_note, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });

    if (after) {
      const afterDate = new Date(after);
      if (!isNaN(afterDate.getTime())) query = query.gt('created_at', after);
    }

    const { data: messages, error: msgErr } = await query;
    if (msgErr) throw msgErr;

    let nudgeSent = false;
    if (thread.status === 'open' && !thread.nudge_sent_at) {
      const age = Date.now() - new Date(thread.created_at).getTime();
      if (age > TIMEOUT_MS) {
        const { count } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('thread_id', threadId)
          .eq('sender', 'agent');

        if (!count || count === 0) {
          await supabase.from('chat_messages').insert({
            thread_id: threadId,
            agency_id: agency.id,
            sender:    'system',
            text:      NUDGE_MSG,
          });
          await supabase
            .from('chat_threads')
            .update({ nudge_sent_at: new Date().toISOString() })
            .eq('id', threadId);
          nudgeSent = true;
        }
      }
    }

    return res.json({
      success:   true,
      messages:  messages || [],
      status:    thread.status,
      nudgeSent,
    });

  } catch (err) {
    logger.error('widgetChat GET /poll', { error: err.message });
    return res.status(500).json({ success: false, error: 'Poll failed' });
  }
});

// ─────────────────────────────────────────────
// POST /back
// ─────────────────────────────────────────────
router.post('/back', async (req, res) => {
  const schema = Joi.object({ threadId: Joi.string().uuid().required() });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const sessionKey = _visitorToken(req);
    const agency     = await _resolveAgency(req);
    if (!agency) return res.status(401).json({ success: false, error: 'Invalid agency key' });

    const { data: thread } = await supabase
      .from('chat_threads')
      .select('id, status, bot_history, trip_params, last_packages')
      .eq('id', value.threadId)
      .eq('session_key', sessionKey)
      .eq('agency_id', agency.id)
      .single();

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

    await supabase
      .from('chat_threads')
      .update({ status: 'closed', closed_by: 'traveler', closed_at: new Date().toISOString() })
      .eq('id', thread.id);

    await supabase.from('chat_messages').insert({
      thread_id: thread.id,
      agency_id: agency.id,
      sender:    'system',
      text:      'Traveler has returned to the bot assistant.',
    });

    logger.info('widgetChat: traveler returned to bot', { threadId: thread.id });

    return res.json({
      success:      true,
      botHistory:   thread.bot_history   || [],
      tripParams:   thread.trip_params   || null,
      lastPackages: thread.last_packages || null,
    });

  } catch (err) {
    logger.error('widgetChat POST /back', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to return to assistant' });
  }
});

// ─────────────────────────────────────────────
// GET /poll-approval
// ─────────────────────────────────────────────
router.get('/poll-approval', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.json({ resolved: false });

  try {
    const agency = await _resolveAgency(req);
    if (!agency) return res.json({ resolved: false });

    const { data, error } = await supabase
      .from('package_requests')
      .select('status, packages, edited_packages, agent_note, delivery_status')
      .eq('session_key', sessionId)
      .eq('agency_id', agency.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return res.json({ resolved: false });

    if (data.status === 'pending') return res.json({ resolved: false });

    if (data.status === 'declined') {
      return res.json({
        resolved: true,
        outcome:  'declined',
        message:  data.agent_note
          ? `Sorry — ${data.agent_note}. Please try a different search.`
          : "Sorry, we couldn't find suitable options right now. Please try a different search.",
      });
    }

    if (data.status === 'approved') {
      const packages = (data.edited_packages?.length ? data.edited_packages : data.packages) || [];
      return res.json({
        resolved:  true,
        outcome:   'approved',
        packages,
        agentNote: data.agent_note || null,
      });
    }

    return res.json({
      resolved: true,
      outcome:  'declined',
      message:  "This request expired. Please search again.",
    });

  } catch (err) {
    logger.error('widgetChat GET /poll-approval', { error: err.message });
    return res.json({ resolved: false });
  }
});

module.exports = router;