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
 *   POST /start        start a live chat thread
 *   POST /send         traveler sends a message
 *   GET  /poll         traveler polls for new agent messages
 *   POST /back         traveler goes back to bot assistant
 *   GET  /config       widget checks if live chat is available
 * ─────────────────────────────────────────────────────────────
 */

const express    = require('express');
const router     = express.Router();
const Joi        = require('joi');
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

const TIMEOUT_MS   = 30 * 60 * 1000;   // 30 min — offer "keep waiting" nudge
const NUDGE_MSG    = "Still there? Your agent hasn't replied yet. Would you like to keep waiting or go back to the assistant?";
const MAX_MSG_LEN  = 1000;

// ── resolve agency from api-key header ────────────────────────
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
// GET /config  — widget checks availability before showing button
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
// POST /start  — traveler hands off from bot to agent
// Body: { botHistory, tripParams, lastPackages, travelerName }
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

    // Guard: Triply never uses live chat
    if (agency.integration_type === 'triply') {
      return res.status(403).json({ success: false, error: 'Live chat not available for this agency' });
    }
    if (!agency.live_chat_enabled) {
      return res.status(403).json({ success: false, error: 'Live chat is not enabled for this agency' });
    }

    const sessionKey = _visitorToken(req);
    if (!sessionKey) return res.status(400).json({ success: false, error: 'Visitor token required' });

    // Close any existing open thread for this visitor first
    await supabase
      .from('chat_threads')
      .update({ status: 'closed', closed_by: 'traveler', closed_at: new Date().toISOString() })
      .eq('session_key', sessionKey)
      .eq('agency_id', agency.id)
      .eq('status', 'open');

    // Create new thread
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

    // Post system message so agent sees context immediately
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
// POST /send  — traveler sends a message
// Body: { threadId, text }
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

    // Verify thread belongs to this visitor + agency
    const { data: thread } = await supabase
      .from('chat_threads')
      .select('id, status, agency_id')
      .eq('id', value.threadId)
      .eq('session_key', sessionKey)
      .eq('agency_id', agency.id)
      .single();

    if (!thread)            return res.status(404).json({ success: false, error: 'Thread not found' });
    if (thread.status !== 'open') return res.status(409).json({ success: false, error: 'Thread is closed' });

    // Sanitise: strip HTML tags before storing
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
// GET /poll  — traveler polls for new messages
// Query: threadId, after (ISO timestamp, optional)
// ─────────────────────────────────────────────
router.get('/poll', async (req, res) => {
  const { threadId, after } = req.query;
  if (!threadId) return res.status(400).json({ success: false, error: 'threadId required' });

  try {
    const sessionKey = _visitorToken(req);
    const agency     = await _resolveAgency(req);
    if (!agency) return res.status(401).json({ success: false, error: 'Invalid agency key' });

    // Verify ownership
    const { data: thread } = await supabase
      .from('chat_threads')
      .select('id, status, nudge_sent_at, created_at')
      .eq('id', threadId)
      .eq('session_key', sessionKey)
      .eq('agency_id', agency.id)
      .single();

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found' });

    // Fetch messages newer than `after`
    let query = supabase
      .from('chat_messages')
      .select('id, sender, text, packages, agent_note, created_at')
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true });

    if (after) query = query.gt('created_at', after);

    const { data: messages, error: msgErr } = await query;
    if (msgErr) throw msgErr;

    // Check if we should send a timeout nudge
    // (thread open, no agent reply, >30 min since start, nudge not yet sent)
    let nudgeSent = false;
    if (thread.status === 'open' && !thread.nudge_sent_at) {
      const age = Date.now() - new Date(thread.created_at).getTime();
      if (age > TIMEOUT_MS) {
        // Check if agent has ever replied
        const { count } = await supabase
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('thread_id', threadId)
          .eq('sender', 'agent');

        if (!count || count === 0) {
          // Insert nudge as system message and mark it sent
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
// POST /back  — traveler returns to bot assistant
// Body: { threadId }
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

    // Close the thread
    await supabase
      .from('chat_threads')
      .update({ status: 'closed', closed_by: 'traveler', closed_at: new Date().toISOString() })
      .eq('id', thread.id);

    // Post system message for agent awareness
    await supabase.from('chat_messages').insert({
      thread_id: thread.id,
      agency_id: agency.id,
      sender:    'system',
      text:      'Traveler has returned to the bot assistant.',
    });

    logger.info('widgetChat: traveler returned to bot', { threadId: thread.id });

    // Return bot context so widget can resume conversation seamlessly
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

module.exports = router;