/**
 * HOTEL DIRECT API ROUTES — v2
 * ─────────────────────────────────────────────────────────────
 * Hotel groups are independent tenants — no agency_id.
 * Auth uses x-hotel-key header = hotel_groups.slug.
 *
 * Mount in server.js:
 *   const hotelRoutes = require('./routes/hotelRoutes');
 *   app.use('/api/hotel', hotelRoutes);
 *
 * Routes:
 *   POST /api/hotel/orchestrate          — room search
 *   POST /api/hotel/reserve              — create reservation
 *   POST /api/hotel/pay                  — trigger guest payment
 *   GET  /api/hotel/reservation          — get reservation (query: ?ref=&phone=)
 *   GET  /api/hotel/reservation/:ref     — get reservation (path param)
 *   POST /api/hotel/reservation/modify   — modify reservation
 *   POST /api/hotel/reservation/cancel   — cancel reservation
 *   POST /api/hotel/reservation/:ref/cancel
 *   POST /api/hotel/webhook/mpesa        — payment confirmation
 *   GET  /api/hotel/group/info           — group config for widget init
 *
 *   POST /api/hotel/chat/start           — guest starts live chat
 *   POST /api/hotel/chat/send            — guest sends message
 *   GET  /api/hotel/chat/poll            — guest polls for agent replies
 *   POST /api/hotel/chat/back            — guest returns to bot
 * ─────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const hotelDirectBookingService = require('../services/hotelDirectBookingService');
const hotelDirectEngine         = require('../orchestration/hotelDirectEngine');

// ─────────────────────────────
// AUTH MIDDLEWARE
// x-hotel-key header = hotel_groups.slug
// Sets req.hotelGroup on success.
// ─────────────────────────────
async function requireHotelKey(req, res, next) {
  const slug = req.headers['x-hotel-key'] || req.body?.groupSlug;

  if (!slug) {
    return res.status(401).json({ success: false, error: 'Hotel key required (x-hotel-key header).' });
  }

  const { data: group, error } = await supabase
    .from('hotel_groups')
    .select('id, name, slug, commission_rate, payment_type, is_active')
    .eq('slug', slug)
    .eq('is_active', true)
    .single();

  if (error || !group) {
    return res.status(401).json({ success: false, error: 'Invalid hotel key.' });
  }

  req.hotelGroup = group;
  next();
}

// ─────────────────────────────
// GET /api/hotel/group/info
// ─────────────────────────────
router.get('/group/info', requireHotelKey, (req, res) => {
  const g = req.hotelGroup;
  res.json({
    success:      true,
    name:         g.name,
    slug:         g.slug,
    paymentType:  g.payment_type,
  });
});

// ─────────────────────────────
// POST /api/hotel/orchestrate
// ─────────────────────────────
router.post('/orchestrate', requireHotelKey, async (req, res) => {
  try {
    const { prompt, conversationHistory, previousParams } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required.' });
    }

    const result = await hotelDirectEngine.orchestrate(
      prompt,
      req.hotelGroup.slug,
      {
        conversationHistory: conversationHistory || [],
        previousParams:      previousParams      || null,
      }
    );

    logger.info('Hotel orchestrate', {
      groupSlug: req.hotelGroup.slug,
      packages:  result.packages?.length || 0,
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel orchestrate API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Search failed. Please try again.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/reserve
// ─────────────────────────────
router.post('/reserve', requireHotelKey, async (req, res) => {
  try {
    const {
      pkg,
      selectedAncillaries,
      guestName,
      guestPhone,
      guestEmail,
      specialRequests,
      channel,
    } = req.body;

    if (!pkg || !guestName || !guestPhone) {
      return res.status(400).json({
        success: false,
        error: 'pkg, guestName, and guestPhone are required.',
      });
    }

    const result = await hotelDirectBookingService.createReservation({
      pkg,
      selectedAncillaries: selectedAncillaries || [],
      guestName,
      guestPhone,
      guestEmail,
      specialRequests,
      channel:  channel || 'widget',
      groupId:  req.hotelGroup.id,
    });

    if (!result.success) {
      return res.status(400).json(result);
    }

    logger.info('Hotel reservation created', {
      reservationRef: result.reservationRef,
      groupSlug:      req.hotelGroup.slug,
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel reserve API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Server error. Please try again.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/pay
// ─────────────────────────────
router.post('/pay', requireHotelKey, async (req, res) => {
  try {
    const { reservationRef, guestPhone, paymentMethod } = req.body;

    if (!reservationRef) {
      return res.status(400).json({ success: false, error: 'reservationRef is required.' });
    }

    const result = await hotelDirectBookingService.triggerGuestPayment({
      reservationRef,
      guestPhone,
      paymentMethod,
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel pay API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Payment initiation failed.' });
  }
});

// ─────────────────────────────
// GET /api/hotel/reservation
// Widget sends ?ref=...&phone=... as query params
// MUST come before /reservation/:ref so Express matches it first
// ─────────────────────────────
router.get('/reservation', requireHotelKey, async (req, res) => {
  try {
    const { ref, phone } = req.query;

    if (!ref) {
      return res.status(400).json({ success: false, error: 'ref query param is required.' });
    }

    const reservation = await hotelDirectBookingService.getReservation(ref);

    if (!reservation) {
      return res.status(404).json({ success: false, error: 'Reservation not found.' });
    }
    if (reservation.group_id !== req.hotelGroup.id) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    // Optional phone verification
    if (phone && reservation.guest_phone) {
      const clean = (s) => s.replace(/\D/g, '').slice(-9);
      if (clean(phone) !== clean(reservation.guest_phone)) {
        return res.status(403).json({ success: false, error: 'Phone number does not match reservation.' });
      }
    }

    return res.json({ success: true, reservation });

  } catch (err) {
    logger.error('Hotel reservation fetch error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not fetch reservation.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/reservation/modify
// MUST come before /reservation/:ref
// ─────────────────────────────
router.post('/reservation/modify', requireHotelKey, async (req, res) => {
  try {
    const { reservationRef, newCheckIn, newCheckOut, specialRequests } = req.body;

    if (!reservationRef || !newCheckIn || !newCheckOut) {
      return res.status(400).json({
        success: false,
        error:   'reservationRef, newCheckIn, and newCheckOut are required.',
      });
    }

    const existing = await hotelDirectBookingService.getReservation(reservationRef);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Reservation not found.' });
    }
    if (existing.group_id !== req.hotelGroup.id) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    const result = await hotelDirectBookingService.modifyReservation({
      reservationRef, newCheckIn, newCheckOut, specialRequests,
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel modify API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Modification failed.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/reservation/cancel
// Widget sends { reservationRef } in body
// MUST come before /reservation/:ref
// ─────────────────────────────
router.post('/reservation/cancel', requireHotelKey, async (req, res) => {
  try {
    const { reservationRef } = req.body;

    if (!reservationRef) {
      return res.status(400).json({ success: false, error: 'reservationRef is required.' });
    }

    const existing = await hotelDirectBookingService.getReservation(reservationRef);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Reservation not found.' });
    }
    if (existing.group_id !== req.hotelGroup.id) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    const result = await hotelDirectBookingService.cancelReservation({
      reservationRef,
      reason:      req.body.reason      || 'Cancelled by guest via widget',
      cancelledBy: req.body.cancelledBy || 'guest',
    });

    return res.json(result);

  } catch (err) {
    logger.error('Hotel cancel API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Cancellation failed.' });
  }
});

// ─────────────────────────────
// GET /api/hotel/reservation/:ref
// Admin / direct lookup by path param
// ─────────────────────────────
router.get('/reservation/:ref', requireHotelKey, async (req, res) => {
  try {
    const reservation = await hotelDirectBookingService.getReservation(req.params.ref);

    if (!reservation) {
      return res.status(404).json({ success: false, error: 'Reservation not found.' });
    }
    if (reservation.group_id !== req.hotelGroup.id) {
      return res.status(403).json({ success: false, error: 'Access denied.' });
    }

    return res.json({ success: true, reservation });

  } catch (err) {
    logger.error('Hotel reservation fetch error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not fetch reservation.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/reservation/:ref/cancel
// Admin cancel by path param
// ─────────────────────────────
router.post('/reservation/:ref/cancel', requireHotelKey, async (req, res) => {
  try {
    const result = await hotelDirectBookingService.cancelReservation({
      reservationRef: req.params.ref,
      reason:         req.body.reason      || 'Cancelled via API',
      cancelledBy:    req.body.cancelledBy || 'guest',
    });
    return res.json(result);
  } catch (err) {
    logger.error('Hotel cancel API error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Cancellation failed.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/webhook/mpesa
// ─────────────────────────────
router.post('/webhook/mpesa', async (req, res) => {
  try {
    const payload = req.body;
    logger.info('Hotel M-Pesa webhook', { state: payload.state, api_ref: payload.api_ref });

    if (payload.state !== 'COMPLETE') {
      return res.json({ received: true });
    }

    const reservationRef   = payload.api_ref;
    const paymentReference = payload.invoice_id || payload.receipt_number || null;

    if (!reservationRef?.startsWith('HTL-')) {
      logger.warn('Hotel M-Pesa webhook: unrecognized api_ref', { api_ref: reservationRef });
      return res.json({ received: true });
    }

    const result = await hotelDirectBookingService.markPaid({
      reservationRef,
      paymentReference,
      markedBy: 'mpesa_webhook',
    });

    logger.info('Hotel M-Pesa webhook processed', {
      reservationRef,
      success: result.success,
    });

    return res.json({ received: true });

  } catch (err) {
    logger.error('Hotel M-Pesa webhook error', { error: err.message });
    return res.status(200).json({ received: true });
  }
});

// ─────────────────────────────────────────────────────────────
// LIVE CHAT ROUTES
// Completely separate from the engine — human agent channel only.
// Tables: hotel_chat_threads, hotel_chat_messages
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────
// POST /api/hotel/chat/start
// Guest taps "Talk to the team".
// Creates a thread, seeds it with bot context as system messages
// so the agent sees what the guest was looking at.
// Returns { success: true, threadId }
// ─────────────────────────────
router.post('/chat/start', requireHotelKey, async (req, res) => {
  try {
    const { botHistory = [], tripParams = {}, lastPackages = [] } = req.body;
    const groupId = req.hotelGroup.id;

    // Build a one-line context summary for the admin inbox
    const contextParts = [];
    if (tripParams.adults)        contextParts.push(`${tripParams.adults} adult${tripParams.adults !== 1 ? 's' : ''}`);
    if (tripParams.children)      contextParts.push(`${tripParams.children} child${tripParams.children !== 1 ? 'ren' : ''}`);
    if (tripParams.propertyName)  contextParts.push(tripParams.propertyName);
    if (tripParams.departureDate) contextParts.push(tripParams.departureDate);
    if (tripParams.returnDate)    contextParts.push(`→ ${tripParams.returnDate}`);
    if (tripParams.nights)        contextParts.push(`${tripParams.nights} night${tripParams.nights !== 1 ? 's' : ''}`);
    const contextSummary = contextParts.length ? contextParts.join(', ') : 'Guest chat';

    // Package summary — what room they were looking at
    const packageSummary = lastPackages[0]?.hotel?.roomType
      || lastPackages[0]?.hotel?.name
      || null;

    // Insert thread
    const { data: thread, error: threadErr } = await supabase
      .from('hotel_chat_threads')
      .insert({
        group_id:        groupId,
        status:          'open',
        has_unread:      false,
        context_summary: contextSummary,
        package_summary: packageSummary,
        last_message_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (threadErr || !thread) {
      logger.error('[CHAT] Thread creation failed', { error: threadErr?.message });
      return res.status(500).json({ success: false, error: 'Could not start chat.' });
    }

    const threadId = thread.id;

    // Seed thread with bot conversation as a system message
    // so the agent has full context without scrolling
    const recentHistory = (botHistory || []).slice(-10);
    if (recentHistory.length) {
      const contextLines = recentHistory
        .filter(m => m.content && m.content.trim())
        .map(m => `[${m.role === 'user' ? 'Guest' : 'Bot'}] ${m.content.trim()}`)
        .join('\n');

      if (contextLines) {
        await supabase.from('hotel_chat_messages').insert({
          thread_id: threadId,
          sender:    'system',
          text:      `— Bot conversation context —\n${contextLines}\n— End of context —`,
        });
      }
    }

    // Also seed trip params as a system message if present
    if (contextSummary !== 'Guest chat') {
      await supabase.from('hotel_chat_messages').insert({
        thread_id: threadId,
        sender:    'system',
        text:      `Guest was planning: ${contextSummary}${packageSummary ? ` · Looking at: ${packageSummary}` : ''}`,
      });
    }

    logger.info('[CHAT] Thread started', { threadId, groupId, contextSummary });

    return res.json({ success: true, threadId });

  } catch (err) {
    logger.error('[CHAT] chat/start error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not start chat.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/chat/send
// Guest sends a message to the agent.
// Body: { threadId, text }
// ─────────────────────────────
router.post('/chat/send', requireHotelKey, async (req, res) => {
  try {
    const { threadId, text } = req.body;

    if (!threadId || !text?.trim()) {
      return res.status(400).json({ success: false, error: 'threadId and text are required.' });
    }

    // Verify thread belongs to this hotel group and is still open
    const { data: thread, error: threadErr } = await supabase
      .from('hotel_chat_threads')
      .select('id, status, group_id')
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id)
      .maybeSingle();

    if (threadErr || !thread) {
      return res.status(404).json({ success: false, error: 'Thread not found.' });
    }
    if (thread.status === 'closed') {
      return res.status(400).json({ success: false, error: 'Chat is closed.' });
    }

    // Insert guest message
    const { error: msgErr } = await supabase
      .from('hotel_chat_messages')
      .insert({
        thread_id: threadId,
        sender:    'guest',
        text:      text.trim(),
      });

    if (msgErr) {
      logger.error('[CHAT] Message insert failed', { error: msgErr.message });
      return res.status(500).json({ success: false, error: 'Could not send message.' });
    }

    // Mark thread as having unread messages for the agent
    await supabase
      .from('hotel_chat_threads')
      .update({
        has_unread:      true,
        last_message_at: new Date().toISOString(),
      })
      .eq('id', threadId);

    return res.json({ success: true });

  } catch (err) {
    logger.error('[CHAT] chat/send error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not send message.' });
  }
});

// ─────────────────────────────
// GET /api/hotel/chat/poll
// Widget polls every 5 seconds for new agent/system messages.
// Query: ?threadId=…&after=<last message id>
// Returns { status, messages: [{ id, sender, text, body }] }
// ─────────────────────────────
router.get('/chat/poll', requireHotelKey, async (req, res) => {
  try {
    const { threadId, after } = req.query;

    if (!threadId) {
      return res.status(400).json({ success: false, error: 'threadId is required.' });
    }

    // Verify ownership and get current status
    const { data: thread, error: threadErr } = await supabase
      .from('hotel_chat_threads')
      .select('id, status, group_id')
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id)
      .maybeSingle();

    if (threadErr || !thread) {
      return res.status(404).json({ success: false, error: 'Thread not found.' });
    }

    // Fetch new agent and system messages since last poll
    let query = supabase
      .from('hotel_chat_messages')
      .select('id, sender, text, created_at')
      .eq('thread_id', threadId)
      .in('sender', ['agent', 'system'])
      .order('created_at', { ascending: true });

    // Only return messages after the last one the widget already has
    if (after) {
      query = query.gt('id', after);
    }

    const { data: messages, error: msgErr } = await query;

    if (msgErr) {
      logger.error('[CHAT] Poll query failed', { error: msgErr.message });
      return res.status(500).json({ success: false, error: 'Poll failed.' });
    }

    return res.json({
      success:  true,
      status:   thread.status,          // 'open' | 'closed' — widget resets bar on 'closed'
      messages: (messages || []).map(m => ({
        id:     m.id,
        sender: m.sender,
        text:   m.text,
        body:   m.text,                 // widget reads either .text or .body
      })),
    });

  } catch (err) {
    logger.error('[CHAT] chat/poll error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Poll failed.' });
  }
});

// ─────────────────────────────
// POST /api/hotel/chat/back
// Guest taps "← Back to assistant".
// Thread stays open — agent can still reply.
// We log a system message so the agent knows.
// Body: { threadId }
// ─────────────────────────────
router.post('/chat/back', requireHotelKey, async (req, res) => {
  try {
    const { threadId } = req.body;

    if (!threadId) {
      return res.status(400).json({ success: false, error: 'threadId is required.' });
    }

    // Verify ownership
    const { data: thread } = await supabase
      .from('hotel_chat_threads')
      .select('id, status, group_id')
      .eq('id', threadId)
      .eq('group_id', req.hotelGroup.id)
      .maybeSingle();

    if (!thread) {
      return res.status(404).json({ success: false, error: 'Thread not found.' });
    }

    // Log it so the agent sees the guest went back to the bot
    // Thread stays open — they can still reply and the guest can come back
    if (thread.status === 'open') {
      await supabase.from('hotel_chat_messages').insert({
        thread_id: threadId,
        sender:    'system',
        text:      'Guest returned to the assistant. Thread remains open.',
      });
    }

    logger.info('[CHAT] Guest returned to assistant', { threadId });

    return res.json({ success: true });

  } catch (err) {
    logger.error('[CHAT] chat/back error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Could not process request.' });
  }
});

module.exports = router;