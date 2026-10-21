/**
 * HOTEL LIVE CHAT ROUTES
 * ─────────────────────────────────────────────────────────────
 * Handles guest ↔ hotel team live chat sessions.
 * Auth: x-hotel-key header = hotel_groups.slug
 *
 * Mount in server.js:
 *   app.use('/api/hotel', require('./routes/hotelChat'));
 *
 * Routes:
 *   POST /api/hotel/chat/start   — guest requests live chat
 *   POST /api/hotel/chat/send    — guest sends a message
 *   GET  /api/hotel/chat/poll    — guest polls for new agent messages
 *   POST /api/hotel/chat/back    — guest returns to bot
 *
 *   POST /api/hotel/chat/admin/reply   — hotel staff replies (uses cookie auth)
 *   POST /api/hotel/chat/admin/close   — hotel staff closes thread
 *   GET  /api/hotel/chat/admin/threads — list open threads (uses cookie auth)
 * ─────────────────────────────────────────────────────────────
 *
 * DB tables required (run migration SQL first):
 *   hotel_chat_threads
 *   hotel_chat_messages
 */

const express    = require('express');
const router     = express.Router();
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────
// GUEST AUTH — x-hotel-key
// ─────────────────────────────
async function requireHotelKey(req, res, next) {
  const slug = req.headers['x-hotel-key'] || req.body?.groupSlug;
  if (!slug) return res.status(401).json({ success: false, error: 'Hotel key required.' });

  const { data: group } = await supabase
    .from('hotel_groups')
    .select('id, name, slug, notification_email, notification_phone')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();

  if (!group) return res.status(401).json({ success: false, error: 'Invalid hotel key.' });

  req.hotelGroup = group;
  next();
}

// ─────────────────────────────
// ADMIN AUTH — cookie
// Reuses same cookie as hotelAdmin.js
// ─────────────────────────────
async function requireHotelAdmin(req, res, next) {
  const token = req.cookies?.hotel_token;
  if (!token) return res.status(401).json({ success: false, error: 'Not authenticated.' });

  const { data: group } = await supabase
    .from('hotel_groups')
    .select('id, name, slug')
    .eq('admin_token', token)
    .eq('is_active', true)
    .maybeSingle();

  if (!group) return res.status(401).json({ success: false, error: 'Invalid session.' });

  req.hotelGroup = group;
  next();
}

// ─────────────────────────────────────────────────────────────
// GUEST ROUTES
// ─────────────────────────────────────────────────────────────

// POST /api/hotel/chat/start
// Guest clicks "Talk to the team"
// Creates a thread, seeds it with bot history so staff have context
router.post('/chat/start', requireHotelKey, async (req, res) => {
  try {
    const {
      botHistory    = [],
      tripParams    = null,
      lastPackages  = [],
      visitorToken  = null,
    } = req.body;

    // Build a readable context summary for staff
    let contextSummary = null;
    if (tripParams) {
      const parts = [];
      if (tripParams.propertyName) parts.push(`Property: ${tripParams.propertyName}`);
      if (tripParams.departureDate) parts.push(`Check-in: ${tripParams.departureDate}`);
      if (tripParams.returnDate)    parts.push(`Check-out: ${tripParams.returnDate}`);
      if (tripParams.nights)        parts.push(`${tripParams.nights} nights`);
      if (tripParams.adults)        parts.push(`${tripParams.adults} adult(s)`);
      if (tripParams.children)      parts.push(`${tripParams.children} child(ren)`);
      if (parts.length) contextSummary = parts.join(' · ');
    }

    // Pick up a package the guest was looking at
    const packageSummary = lastPackages?.[0]
      ? `${lastPackages[0].hotel?.roomType || 'Room'} — ${lastPackages[0].hotel?.currency || 'KES'} ${Math.round(lastPackages[0].hotel?.pricePerNight || 0).toLocaleString()}/night`
      : null;

    // Create the thread
    const { data: thread, error: threadErr } = await supabase
      .from('hotel_chat_threads')
      .insert({
        group_id:        req.hotelGroup.id,
        visitor_token:   visitorToken || null,
        status:          'open',
        context_summary: contextSummary || null,
        package_summary: packageSummary || null,
        bot_history:     botHistory.slice(-10), // last 10 turns for context
      })
      .select('id')
      .single();

    if (threadErr || !thread) {
      logger.error('[HOTEL CHAT] thread create failed', { error: threadErr?.message });
      return res.status(500).json({ success: false, error: 'Could not start chat.' });
    }

    // Insert system message so staff see the context
    if (contextSummary || packageSummary) {
      const systemText = [
        '— Guest context —',
        contextSummary,
        packageSummary ? `Looking at: ${packageSummary}` : null,
      ].filter(Boolean).join('\n');

      await supabase.from('hotel_chat_messages').insert({
        thread_id: thread.id,
        sender:    'system',
        text:      systemText,
      });
    }

    // Insert system "chat started" message visible to guest
    await supabase.from('hotel_chat_messages').insert({
      thread_id: thread.id,
      sender:    'system',
      text:      `Chat started with ${req.hotelGroup.name}. A team member will be with you shortly.`,
    });

    // Notify hotel staff by email if configured
    if (req.hotelGroup.notification_email) {
      _notifyStaff(req.hotelGroup, thread.id, contextSummary, packageSummary).catch(() => {});
    }

    logger.info('[HOTEL CHAT] Thread opened', {
      threadId:  thread.id,
      groupSlug: req.hotelGroup.slug,
    });

    return res.json({ success: true, threadId: thread.id });

  } catch (err) {
    logger.error('[HOTEL CHAT] start error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// POST /api/hotel/chat/send
// Guest sends a message in an open thread
router.post('/chat/send', requireHotelKey, async (req, res) => {
  try {
    const { threadId, text } = req.body;

    if (!threadId || !text?.trim()) {
      return res.status(400).json({ success: false, error: 'threadId and text required.' });
    }

    // Verify thread belongs to this group
    const { data: thread } = await supabase
      .from('hotel_chat_threads')
      .select('id, status, group_id')
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id)
      .maybeSingle();

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found.' });
    if (thread.status === 'closed') return res.status(400).json({ success: false, error: 'Chat has ended.' });

    const { data: msg } = await supabase
      .from('hotel_chat_messages')
      .insert({
        thread_id: threadId,
        sender:    'guest',
        text:      text.trim(),
      })
      .select('id, created_at')
      .single();

    // Update thread last_message_at
    await supabase
      .from('hotel_chat_threads')
      .update({ last_message_at: new Date().toISOString(), has_unread: true })
      .eq('id', threadId);

    return res.json({ success: true, messageId: msg?.id });

  } catch (err) {
    logger.error('[HOTEL CHAT] send error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// GET /api/hotel/chat/poll?threadId=...&after=...
// Guest polls for new messages from agent/system
router.get('/chat/poll', requireHotelKey, async (req, res) => {
  try {
    const { threadId, after } = req.query;

    if (!threadId) return res.status(400).json({ success: false, error: 'threadId required.' });

    // Check thread status
    const { data: thread } = await supabase
      .from('hotel_chat_threads')
      .select('status')
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id)
      .maybeSingle();

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found.' });

    // Fetch messages since last poll
    let query = supabase
      .from('hotel_chat_messages')
      .select('id, sender, text, created_at')
      .eq('thread_id', threadId)
      .in('sender', ['agent', 'system'])
      .order('created_at', { ascending: true });

    if (after) query = query.gt('id', after);

    const { data: messages } = await query;

    return res.json({
      success:  true,
      status:   thread.status,          // 'open' | 'closed'
      messages: (messages || []).map(m => ({
        id:     m.id,
        sender: m.sender,
        text:   m.text,
        time:   m.created_at,
      })),
    });

  } catch (err) {
    logger.error('[HOTEL CHAT] poll error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// POST /api/hotel/chat/back
// Guest clicks "Back to assistant" — closes the thread
router.post('/chat/back', requireHotelKey, async (req, res) => {
  try {
    const { threadId } = req.body;
    if (!threadId) return res.json({ success: true });

    await supabase
      .from('hotel_chat_threads')
      .update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: 'guest' })
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id);

    await supabase.from('hotel_chat_messages').insert({
      thread_id: threadId,
      sender:    'system',
      text:      'Guest returned to the assistant.',
    });

    return res.json({ success: true });

  } catch (err) {
    logger.error('[HOTEL CHAT] back error', { error: err.message });
    return res.json({ success: true }); // never block the guest
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES (cookie auth)
// ─────────────────────────────────────────────────────────────

// GET /api/hotel/chat/admin/threads
// Used by the admin inbox to fetch open threads (JSON)
router.get('/chat/admin/threads', requireHotelAdmin, async (req, res) => {
  try {
    const status = req.query.status || 'open';

    const { data: threads } = await supabase
      .from('hotel_chat_threads')
      .select('id, status, context_summary, package_summary, has_unread, created_at, last_message_at, closed_at')
      .eq('group_id', req.hotelGroup.id)
      .eq('status', status)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(50);

    return res.json({ success: true, threads: threads || [] });

  } catch (err) {
    return res.json({ success: false, threads: [] });
  }
});

// POST /api/hotel/chat/admin/reply
// Hotel staff sends a reply
router.post('/chat/admin/reply', requireHotelAdmin, async (req, res) => {
  try {
    const { threadId, text } = req.body;

    if (!threadId || !text?.trim()) {
      return res.status(400).json({ success: false, error: 'threadId and text required.' });
    }

    // Verify ownership
    const { data: thread } = await supabase
      .from('hotel_chat_threads')
      .select('id, status')
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id)
      .maybeSingle();

    if (!thread) return res.status(404).json({ success: false, error: 'Thread not found.' });
    if (thread.status === 'closed') return res.status(400).json({ success: false, error: 'Thread is closed.' });

    await supabase.from('hotel_chat_messages').insert({
      thread_id: threadId,
      sender:    'agent',
      text:      text.trim(),
    });

    await supabase
      .from('hotel_chat_threads')
      .update({ last_message_at: new Date().toISOString(), has_unread: false })
      .eq('id', threadId);

    return res.json({ success: true });

  } catch (err) {
    logger.error('[HOTEL CHAT] admin reply error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// POST /api/hotel/chat/admin/close
// Hotel staff closes a thread
router.post('/chat/admin/close', requireHotelAdmin, async (req, res) => {
  try {
    const { threadId } = req.body;
    if (!threadId) return res.status(400).json({ success: false, error: 'threadId required.' });

    await supabase
      .from('hotel_chat_threads')
      .update({ status: 'closed', closed_at: new Date().toISOString(), closed_by: 'agent' })
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id);

    await supabase.from('hotel_chat_messages').insert({
      thread_id: threadId,
      sender:    'system',
      text:      'Chat closed by the team.',
    });

    return res.json({ success: true });

  } catch (err) {
    logger.error('[HOTEL CHAT] admin close error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
});

// ─────────────────────────────
// STAFF EMAIL NOTIFICATION
// ─────────────────────────────
async function _notifyStaff(group, threadId, contextSummary, packageSummary) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const adminUrl = `${process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com'}/hotel-admin/chats/${threadId}`;

    await resend.emails.send({
      from:    process.env.RESEND_FROM || 'noreply@bodrless.com',
      to:      group.notification_email,
      subject: `💬 New live chat — ${group.name}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
          <div style="background:#1C2B4A;padding:20px 24px;border-radius:8px 8px 0 0;">
            <div style="color:#C9A84C;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px;">${group.name}</div>
            <div style="color:white;font-size:16px;font-weight:700;">A guest wants to chat</div>
          </div>
          <div style="background:white;padding:24px;border:1px solid #e4e4e4;border-top:none;border-radius:0 0 8px 8px;">
            ${contextSummary ? `<p style="font-size:13px;color:#555;margin:0 0 8px;"><strong>Context:</strong> ${contextSummary}</p>` : ''}
            ${packageSummary ? `<p style="font-size:13px;color:#555;margin:0 0 16px;"><strong>Looking at:</strong> ${packageSummary}</p>` : ''}
            <a href="${adminUrl}" style="display:inline-block;background:#1C2B4A;color:white;padding:11px 24px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:700;">Open Chat →</a>
          </div>
        </div>`,
    });
  } catch (err) {
    logger.warn('[HOTEL CHAT] Staff notify failed', { error: err.message });
  }
}

module.exports = router;