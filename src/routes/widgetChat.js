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
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

const TIMEOUT_MS   = 30 * 60 * 1000;
const NUDGE_MSG    = "Still there? Your agent hasn't replied yet. Would you like to keep waiting or go back to the assistant?";
const MAX_MSG_LEN  = 1000;

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
      .select('id, status, agency_id')
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

    if (after) query = query.gt('created_at', after);

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
// Widget polls this every 6s while in held (manual approval) state.
// Query: sessionId
// Returns { resolved: false } while pending,
//         { resolved: true, outcome, packages?, agentNote?, message? } once decided.
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

    // Expired
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