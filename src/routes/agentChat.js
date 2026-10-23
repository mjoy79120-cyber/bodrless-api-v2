/**
 * AGENT LIVE CHAT ROUTES
 * ─────────────────────────────────────────────────────────────
 * Dashboard endpoints for the agent side of live chat.
 * All routes require authenticateSession (Supabase JWT).
 *
 * Mount in server.js (after the existing /api/agent mount):
 *   app.use('/api/agent', authenticateSession, agentChat);
 *
 * Or add to the existing agentRequests mount — same middleware,
 * just a second router on the same path prefix.
 *
 * Endpoints:
 *   GET  /chat/inbox           list open threads for this agency
 *   GET  /chat/inbox/count     unread badge count
 *   GET  /chat/thread/:id      full thread with all messages
 *   POST /chat/thread/:id/reply   agent sends a message (+ optional packages)
 *   POST /chat/thread/:id/close   agent closes the thread
 * ─────────────────────────────────────────────────────────────
 */

const express    = require('express');
const router     = express.Router();
const Joi        = require('joi');
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

// Lazy-load so tests can stub it
function _getResend() {
  try { return require('../services/emailService'); } catch { return null; }
}

const MAX_MSG_LEN  = 2000;
const POLL_LIMIT   = 50;   // messages per thread fetch

/**
 * Build a one-line human-readable context summary for the agent.
 * E.g. "Jane · Nairobi → Cape Town · 10 Nov–17 Nov · 2 pax · honeymoon"
 */
function _contextSummary(thread) {
  const p     = thread.trip_params || {};
  const parts = [];

  if (thread.traveler_name) parts.push(thread.traveler_name);

  // Occasion and group type
  if (p.occasion)  parts.push(p.occasion.replace(/_/g, ' '));
  if (p.groupType) parts.push(p.groupType);

  const route = [p.origin, p.destination].filter(Boolean).join(' → ');
  if (route) parts.push(route);

  if (p.departureDate || p.returnDate) {
    const fmt = d => {
      try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }
      catch { return d; }
    };
    parts.push([p.departureDate, p.returnDate].filter(Boolean).map(fmt).join('–'));
  }

  if (p.nights)     parts.push(`${p.nights} nights`);
  if (p.passengers) parts.push(`${p.passengers} pax${p.children ? ` (${p.children} child)` : ''}`);
  if (p.budget)     parts.push(`budget: ${p.budget}`);
  if (p.mealPlan)   parts.push(p.mealPlan);

  const activities = (p.activityRequests || []).filter(Boolean);
  if (activities.length) parts.push(activities.join(', '));

  if (p.specialRequests) parts.push(`note: ${p.specialRequests}`);

  const pkgCount = thread.last_packages?.length || 0;
  if (pkgCount) parts.push(`${pkgCount} pkg${pkgCount !== 1 ? 's' : ''} shown`);

  return parts.join(' · ') || null;
}

// ─────────────────────────────────────────────
// GET /chat/inbox  — agent's open thread list
// Query: status (open|closed|all), limit, offset
// ─────────────────────────────────────────────
router.get('/chat/inbox', async (req, res) => {
  try {
    const { status = 'open', limit = 40, offset = 0 } = req.query;
    const validStatuses = ['open', 'closed', 'all'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status filter' });
    }

    let query = supabase
      .from('chat_threads')
      .select(
        'id, session_key, channel, traveler_name, trip_params, last_packages, status, ' +
        'closed_by, assigned_to, nudge_sent_at, created_at, updated_at',
        { count: 'exact' }
      )
      .eq('agency_id', req.agencyId)
      .order('updated_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status !== 'all') query = query.eq('status', status);

    const { data: threads, count, error } = await query;
    if (error) throw error;

    // For each thread, attach the last message preview and unread count
    const threadIds = (threads || []).map(t => t.id);
    let lastMessages = {};
    let unreadCounts = {};

    if (threadIds.length > 0) {
      // Last message per thread
      const { data: msgs } = await supabase
        .from('chat_messages')
        .select('thread_id, sender, text, created_at')
        .in('thread_id', threadIds)
        .order('created_at', { ascending: false });

      if (msgs) {
        msgs.forEach(m => {
          if (!lastMessages[m.thread_id]) lastMessages[m.thread_id] = m;
        });
        // Unread = traveler messages with no agent reply after them
        const travelerMsgs = msgs.filter(m => m.sender === 'traveler');
        travelerMsgs.forEach(m => {
          const agentAfter = msgs.find(
            a => a.thread_id === m.thread_id &&
                 a.sender === 'agent' &&
                 new Date(a.created_at) > new Date(m.created_at)
          );
          if (!agentAfter) {
            unreadCounts[m.thread_id] = (unreadCounts[m.thread_id] || 0) + 1;
          }
        });
      }
    }

    const enriched = (threads || []).map(t => ({
      ...t,
      lastMessage:    lastMessages[t.id] || null,
      unreadCount:    unreadCounts[t.id]  || 0,
      contextSummary: _contextSummary(t),
    }));

    return res.json({ success: true, threads: enriched, total: count || 0 });
  } catch (err) {
    logger.error('agentChat GET /chat/inbox', { error: err.message, agencyId: req.agencyId });
    return res.status(500).json({ success: false, error: 'Failed to load inbox' });
  }
});

// ─────────────────────────────────────────────
// GET /chat/inbox/count  — badge: open threads with unread traveler messages
// ─────────────────────────────────────────────
router.get('/chat/inbox/count', async (req, res) => {
  try {
    // Count open threads that have at least one traveler message
    // with no agent reply after it
    const { data: openThreads, error } = await supabase
      .from('chat_threads')
      .select('id')
      .eq('agency_id', req.agencyId)
      .eq('status', 'open');

    if (error) throw error;
    if (!openThreads?.length) return res.json({ success: true, count: 0 });

    const ids = openThreads.map(t => t.id);

    const { data: msgs } = await supabase
      .from('chat_messages')
      .select('thread_id, sender, created_at')
      .in('thread_id', ids)
      .in('sender', ['traveler', 'agent'])
      .order('created_at', { ascending: false });

    if (!msgs?.length) return res.json({ success: true, count: openThreads.length });

    // A thread is "unread" if its most recent non-system message is from the traveler
    const latestPerThread = {};
    msgs.forEach(m => {
      if (!latestPerThread[m.thread_id]) latestPerThread[m.thread_id] = m;
    });

    const unread = Object.values(latestPerThread).filter(m => m.sender === 'traveler').length;
    return res.json({ success: true, count: unread });

  } catch (err) {
    logger.error('agentChat GET /chat/inbox/count', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to get count' });
  }
});

// ─────────────────────────────────────────────
// GET /chat/thread/:id  — full thread detail with messages
// ─────────────────────────────────────────────
router.get('/chat/thread/:id', async (req, res) => {
  try {
    const { data: thread, error: threadErr } = await supabase
      .from('chat_threads')
      .select('*')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (threadErr || !thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }

    const { data: messages, error: msgErr } = await supabase
      .from('chat_messages')
      .select('id, sender, text, packages, agent_note, agent_id, created_at')
      .eq('thread_id', thread.id)
      .order('created_at', { ascending: true })
      .limit(POLL_LIMIT);

    if (msgErr) throw msgErr;

    // Auto-assign to this agent if unassigned and thread is open
    if (thread.status === 'open' && !thread.assigned_to) {
      supabase
        .from('chat_threads')
        .update({ assigned_to: req.agencyUser.id })
        .eq('id', thread.id)
        .then(() => {})
        .catch(err => logger.warn('agentChat: auto-assign failed', { error: err.message }));
    }

    return res.json({
      success:        true,
      thread:         { ...thread, contextSummary: _contextSummary(thread) },
      messages:       messages || [],
    });
  } catch (err) {
    logger.error('agentChat GET /chat/thread/:id', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load thread' });
  }
});

// ─────────────────────────────────────────────
// POST /chat/thread/:id/reply
// Body: { text?: string, packages?: [...], agentNote?: string }
// At least one of text or packages is required.
// ─────────────────────────────────────────────
router.post('/chat/thread/:id/reply', async (req, res) => {
  const schema = Joi.object({
    text:      Joi.string().max(MAX_MSG_LEN).allow('', null).optional(),
    packages:  Joi.array().items(Joi.object()).max(4).optional(),
    agentNote: Joi.string().max(500).allow('', null).optional(),
  }).custom((value, helpers) => {
    if (!value.text?.trim() && !value.packages?.length) {
      return helpers.error('any.invalid');
    }
    return value;
  }, 'text or packages required');

  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) {
    return res.status(400).json({ success: false, error: 'Provide text, packages, or both' });
  }

  try {
    // Verify thread belongs to this agency and is open
    const { data: thread, error: threadErr } = await supabase
      .from('chat_threads')
      .select('id, status, session_key, agency_id')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (threadErr || !thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }
    if (thread.status !== 'open') {
      return res.status(409).json({ success: false, error: 'Thread is closed' });
    }

    // Sanitise agent text — strip HTML
    const safeText = value.text
      ? value.text.replace(/<[^>]*>/g, '').trim()
      : null;

    const { data: msg, error: msgErr } = await supabase
      .from('chat_messages')
      .insert({
        thread_id:  thread.id,
        agency_id:  req.agencyId,
        sender:     'agent',
        text:       safeText || null,
        packages:   value.packages?.length ? value.packages : null,
        agent_note: value.agentNote || null,
        agent_id:   req.agencyUser.id,
      })
      .select()
      .single();

    if (msgErr) throw msgErr;

    // Mark assigned_to this agent if not already
    supabase
      .from('chat_threads')
      .update({ assigned_to: req.agencyUser.id, updated_at: new Date().toISOString() })
      .eq('id', thread.id)
      .then(() => {}).catch(() => {});

    logger.info('agentChat: agent replied', {
      threadId:  thread.id,
      agencyId:  req.agencyId,
      hasText:   !!safeText,
      pkgCount:  value.packages?.length || 0,
    });

    return res.json({ success: true, message: msg });

  } catch (err) {
    logger.error('agentChat POST /chat/thread/:id/reply', { error: err.message });
    return res.status(500).json({ success: false, error: 'Reply failed' });
  }
});

// ─────────────────────────────────────────────
// POST /chat/thread/:id/close
// Body: { reason?: string }
// ─────────────────────────────────────────────
router.post('/chat/thread/:id/close', async (req, res) => {
  const schema = Joi.object({
    reason: Joi.string().max(200).allow('', null).optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const { data: thread, error: threadErr } = await supabase
      .from('chat_threads')
      .select('id, status, session_key')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (threadErr || !thread) {
      return res.status(404).json({ success: false, error: 'Thread not found' });
    }
    if (thread.status !== 'open') {
      return res.status(409).json({ success: false, error: 'Thread already closed' });
    }

    await supabase
      .from('chat_threads')
      .update({
        status:     'closed',
        closed_by:  'agent',
        closed_at:  new Date().toISOString(),
      })
      .eq('id', thread.id);

    // Post a system message so the traveler's poll sees the closure
    await supabase.from('chat_messages').insert({
      thread_id: thread.id,
      agency_id: req.agencyId,
      sender:    'system',
      text:      value.reason
        ? `Chat closed by agent: ${value.reason}`
        : 'The agent has closed this chat. You can continue with the assistant.',
    });

    logger.info('agentChat: thread closed by agent', { threadId: thread.id, agencyId: req.agencyId });
    return res.json({ success: true });

  } catch (err) {
    logger.error('agentChat POST /chat/thread/:id/close', { error: err.message });
    return res.status(500).json({ success: false, error: 'Close failed' });
  }
});

module.exports = router;