/**
 * AGENT CHAT ROUTES
 * ─────────────────────────────────────────────────────────────
 * Dashboard endpoints for the live chat inbox.
 * All routes require a valid Supabase session token via
 * authenticateSession (already on app.use('/api/agent', ...)).
 *
 * Mount is already handled by server.js via /api/agent.
 * These endpoints live at /api/agent/chat/...
 *
 * Endpoints:
 *   GET  /chat/inbox            — open threads for this agency
 *   GET  /chat/inbox/count      — unread badge count
 *   GET  /chat/thread/:id       — full thread with messages
 *   POST /chat/thread/:id/reply — agent sends a message (+ optional packages)
 *   POST /chat/thread/:id/close — agent closes the thread
 * ─────────────────────────────────────────────────────────────
 */

const express    = require('express');
const router     = express.Router();
const Joi        = require('joi');
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// GET /chat/inbox
// Returns open threads for this agency, newest first.
// ─────────────────────────────────────────────
router.get('/chat/inbox', async (req, res) => {
  try {
    const { status = 'open', limit = 50, offset = 0 } = req.query;
    const validStatuses = ['open', 'closed', 'timeout', 'all'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status filter' });
    }

    let query = supabase
      .from('chat_threads')
      .select('id, visitor_id, status, trip_params, last_packages, started_at, last_activity_at, closed_at, agent_id', { count: 'exact' })
      .eq('agency_id', req.agencyId)
      .order('last_activity_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status !== 'all') query = query.eq('status', status);

    const { data, count, error } = await query;
    if (error) throw error;

    // For each thread, get the last message preview
    const threads = await Promise.all((data || []).map(async (thread) => {
      const { data: lastMsg } = await supabase
        .from('chat_messages')
        .select('sender, body, created_at')
        .eq('thread_id', thread.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      // Count unread traveler messages (no agent reply after them)
      const { count: unread } = await supabase
        .from('chat_messages')
        .select('id', { count: 'exact', head: true })
        .eq('thread_id', thread.id)
        .eq('sender', 'traveler')
        .eq('read_by_agent', false);

      return { ...thread, lastMessage: lastMsg || null, unreadCount: unread || 0 };
    }));

    return res.json({ success: true, threads, total: count || 0 });
  } catch (err) {
    logger.error('agentChat GET /inbox', { error: err.message, agencyId: req.agencyId });
    return res.status(500).json({ success: false, error: 'Failed to load inbox' });
  }
});

// ─────────────────────────────────────────────
// GET /chat/inbox/count  — unread badge
// ─────────────────────────────────────────────
router.get('/chat/inbox/count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('chat_threads')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', req.agencyId)
      .eq('status', 'open');

    if (error) throw error;
    return res.json({ success: true, count: count || 0 });
  } catch (err) {
    logger.error('agentChat GET /inbox/count', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to get count' });
  }
});

// ─────────────────────────────────────────────
// GET /chat/thread/:id
// Full thread with all messages. Marks traveler messages as read.
// ─────────────────────────────────────────────
router.get('/chat/thread/:id', async (req, res) => {
  try {
    // Load thread — scoped to agency
    const { data: thread, error: threadErr } = await supabase
      .from('chat_threads')
      .select('*')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (threadErr || !thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    // Load all messages
    const { data: messages, error: msgErr } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true });

    if (msgErr) throw msgErr;

    // Mark unread traveler messages as read
    await supabase
      .from('chat_messages')
      .update({ read_by_agent: true })
      .eq('thread_id', thread.id)
      .eq('sender', 'traveler')
      .eq('read_by_agent', false);

    return res.json({ success: true, thread, messages: messages || [] });
  } catch (err) {
    logger.error('agentChat GET /thread/:id', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load thread' });
  }
});

// ─────────────────────────────────────────────
// POST /chat/thread/:id/reply
// Body: { body: string, packages?: array }
// ─────────────────────────────────────────────
router.post('/chat/thread/:id/reply', async (req, res) => {
  const schema = Joi.object({
    body:     Joi.string().min(1).max(4000).required(),
    packages: Joi.array().items(Joi.object()).max(4).optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    // Verify thread belongs to this agency and is open
    const { data: thread, error: threadErr } = await supabase
      .from('chat_threads')
      .select('id, status, visitor_id, agency_id')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (threadErr || !thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }
    if (thread.status !== 'open') {
      return res.status(409).json({ success: false, error: 'Thread is already closed' });
    }

    const now = new Date().toISOString();

    // Insert agent message
    const { data: message, error: insertErr } = await supabase
      .from('chat_messages')
      .insert({
        thread_id:  thread.id,
        sender:     'agent',
        body:       value.body,
        packages:   value.packages || null,
        agent_id:   req.agencyUser.id,
        created_at: now,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    // Update thread last_activity_at and agent_id
    await supabase
      .from('chat_threads')
      .update({
        last_activity_at: now,
        agent_id:         req.agencyUser.id,
      })
      .eq('id', thread.id);

    logger.info('agentChat: reply sent', { threadId: thread.id, agencyId: req.agencyId });
    return res.json({ success: true, message });

  } catch (err) {
    logger.error('agentChat POST /reply', { error: err.message });
    return res.status(500).json({ success: false, error: 'Reply failed' });
  }
});

// ─────────────────────────────────────────────
// POST /chat/thread/:id/close
// Body: { reason?: string }
// ─────────────────────────────────────────────
router.post('/chat/thread/:id/close', async (req, res) => {
  const schema = Joi.object({
    reason: Joi.string().max(300).allow('', null).optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const now = new Date().toISOString();

    const { data: thread, error: closeErr } = await supabase
      .from('chat_threads')
      .update({
        status:           'closed',
        closed_at:        now,
        last_activity_at: now,
        close_reason:     value.reason || 'agent_closed',
      })
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .eq('status', 'open')
      .select()
      .single();

    if (closeErr || !thread) {
      return res.status(409).json({ success: false, error: 'Thread not found or already closed' });
    }

    // Insert system message so traveler sees it in the widget
    await supabase
      .from('chat_messages')
      .insert({
        thread_id:  thread.id,
        sender:     'system',
        body:       value.reason || 'The agent has closed this chat. You can continue with the assistant.',
        created_at: now,
      });

    logger.info('agentChat: thread closed', { threadId: thread.id, agencyId: req.agencyId });
    return res.json({ success: true, thread });

  } catch (err) {
    logger.error('agentChat POST /close', { error: err.message });
    return res.status(500).json({ success: false, error: 'Close failed' });
  }
});

module.exports = router;