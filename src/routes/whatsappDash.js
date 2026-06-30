/**
 * WHATSAPP DASHBOARD ROUTES
 * ─────────────────────────────────────────────────────────────
 * Data endpoints for the WhatsApp section of:
 *   - Agency dashboard (Lovable/TanStack) — /api/whatsapp/stats
 *   - Bodrless ops dashboard               — /admin/api/whatsapp/overview
 *     (the ops overview lives in admin.js, unchanged — it's
 *     protected by BODRLESS_ADMIN_KEY, not agency auth)
 *
 * AUTH: this router sits behind authenticateSession (Supabase Auth
 * JWT), NOT authenticateAgency (raw api_key) — the Lovable/TanStack
 * dashboard logs a human in via Supabase Auth, and authenticateSession
 * resolves that session to req.agencyId via the profiles table.
 * That's the same auth path your apiFetch(path, opts, true) helper
 * already uses (Authorization: Bearer <supabase JWT>).
 *
 * Mount in server.js:
 *   const { authenticateSession } = require('./middleware/sessionAuth');
 *   const whatsappDashRoutes = require('./routes/whatsappDash');
 *   app.use('/api/whatsapp', authenticateSession, whatsappDashRoutes);
 * ─────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// GET /api/whatsapp/stats
// Returns everything an agency needs to render their WhatsApp
// section: their number, contact count, search/booking volume,
// recent conversations, and active sessions.
//
// req.agencyId is set by authenticateSession (NOT req.agency.id —
// that shape belongs to the other middleware, authenticateAgency,
// which this route does not use).
// ─────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const agencyId = req.agencyId;
    if (!agencyId) return res.status(401).json({ success: false, error: 'Agency not identified.' });

    // Agency row — contains whatsapp_number and whatsapp_phone_number_id
    const { data: agency } = await supabase
      .from('agencies')
      .select('id,name,whatsapp_number,whatsapp_phone_number_id')
      .eq('id', agencyId)
      .single();

    // Contacts scoped directly by agency_id now that the column
    // exists on whatsapp_contacts (see migration_whatsapp_contacts_
    // agency_id.sql + webhooks.js's _getOrCreateContact, which stamps
    // this at first contact). Previously this had to be inferred from
    // bookings/sessions downstream, which missed pure-searcher contacts
    // who never booked — this is now a direct, complete query.
    const { data: contacts } = await supabase
      .from('whatsapp_contacts')
      .select('phone,name,awaiting_name,first_seen_at,updated_at,conversation_history')
      .eq('agency_id', agencyId)
      .order('updated_at', { ascending: false })
      .limit(300);

    // Searches from WhatsApp channel for this agency
    const { data: searches } = await supabase
      .from('trip_searches')
      .select('id,session_id,destination,origin,passengers,budget,converted,created_at')
      .eq('agency_id', agencyId)
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(500);

    // Bookings from WhatsApp channel for this agency
    const { data: bookings } = await supabase
      .from('bookings')
      .select('booking_ref,destination,total_price,currency,booking_stage,payment_status,created_at,guest_name,guest_phone')
      .eq('agency_id', agencyId)
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(200);

    // ── Widget channel — same shape, for the channel comparison ──
    // Pulled alongside WhatsApp so the agency can see which channel
    // is actually driving traffic, in one call rather than two.
    const { data: widgetSearches } = await supabase
      .from('trip_searches')
      .select('id,destination,converted,created_at')
      .eq('agency_id', agencyId)
      .eq('channel', 'widget')
      .order('created_at', { ascending: false })
      .limit(500);

    const { data: widgetBookings } = await supabase
      .from('bookings')
      .select('booking_ref,total_price,currency,booking_stage,payment_status,created_at')
      .eq('agency_id', agencyId)
      .eq('channel', 'widget')
      .order('created_at', { ascending: false })
      .limit(200);

    // Active booking sessions right now, for this agency
    const { data: activeSessions } = await supabase
      .from('whatsapp_booking_sessions')
      .select('phone,current_step,created_at')
      .eq('agency_id', agencyId);

    const allContacts = contacts || [];
    const allSearches = searches || [];
    const allBookings = bookings || [];
    const allSessions = activeSessions || [];
    const allWidgetSearches = widgetSearches || [];
    const allWidgetBookings = widgetBookings || [];

    // Shared GMV conversion — same currency assumptions used elsewhere
    // (bookings.currency defaults to USD per the schema; KES and EUR
    // are converted to KES for a single comparable total).
    const toKES = (price, currency) => {
      const cur = (currency || 'USD').toUpperCase();
      return cur === 'KES' ? price : cur === 'EUR' ? price * 130 : price * 129;
    };

    // allContacts is already scoped to this agency via the query above
    // (agency_id filter) — no inference needed anymore.
    const scopedContacts = allContacts;

    // Stats
    const confirmedBookings = allBookings.filter(b =>
      b.payment_status === 'paid' || b.booking_stage === 'paid'
    );
    const totalGMV = confirmedBookings.reduce((sum, b) => sum + toKES(Number(b.total_price || 0), b.currency), 0);

    const conversionRate = allSearches.length > 0
      ? Number(((confirmedBookings.length / allSearches.length) * 100).toFixed(1))
      : 0;

    // Build the conversation list
    const contactMap = {};
    for (const c of scopedContacts) {
      const history = Array.isArray(c.conversation_history) ? c.conversation_history : [];
      const lastMsg = history[history.length - 1];
      contactMap[c.phone] = {
        phone:        c.phone,
        name:         c.name || null,
        lastMessage:  lastMsg?.content || null,
        lastSeen:     c.updated_at,
        firstSeen:    c.first_seen_at,
        messageCount: history.length,
        bookingRef:   null,
        bookingStage: null,
        destination:  null,
        isActive:     false,
      };
    }

    for (const sess of allSessions) {
      if (contactMap[sess.phone]) {
        contactMap[sess.phone].isActive = true;
        contactMap[sess.phone].currentStep = sess.current_step;
      } else {
        // Session exists but no whatsapp_contacts row yet — still show it
        contactMap[sess.phone] = {
          phone: sess.phone, name: null, lastMessage: null,
          lastSeen: sess.created_at, isActive: true, currentStep: sess.current_step,
          bookingRef: null, bookingStage: null, destination: null,
        };
      }
    }

    for (const b of allBookings) {
      if (b.guest_phone) {
        if (!contactMap[b.guest_phone]) {
          contactMap[b.guest_phone] = {
            phone: b.guest_phone, name: b.guest_name || null, lastMessage: null,
            lastSeen: b.created_at, isActive: false,
            bookingRef: null, bookingStage: null, destination: null,
          };
        }
        contactMap[b.guest_phone].bookingRef   = b.booking_ref;
        contactMap[b.guest_phone].bookingStage = b.booking_stage;
        contactMap[b.guest_phone].destination  = b.destination;
        if (!contactMap[b.guest_phone].name && b.guest_name) {
          contactMap[b.guest_phone].name = b.guest_name;
        }
      }
    }

    const recentConversations = Object.values(contactMap)
      .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0))
      .slice(0, 20);

    // Searches by day (last 14 days)
    const days = {};
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days[d.toISOString().split('T')[0]] = 0;
    }
    for (const s of allSearches) {
      const day = (s.created_at || '').slice(0, 10);
      if (days[day] !== undefined) days[day]++;
    }
    const searchesByDay = Object.entries(days).map(([date, count]) => ({ date, count }));

    // Top destinations
    const destCounts = {};
    for (const s of allSearches) {
      if (s.destination) {
        const d = s.destination.toLowerCase();
        destCounts[d] = (destCounts[d] || 0) + 1;
      }
    }
    const topDestinations = Object.entries(destCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({
        name: name.charAt(0).toUpperCase() + name.slice(1),
        count,
      }));

    // ── Channel comparison ────────────────────────────────────
    // WhatsApp vs Widget, side by side, in the SAME response so the
    // agency can answer "where is my traffic actually coming from"
    // without a second call. widgetKey presence tells us whether the
    // widget has ever been issued, separate from whether it's been
    // embedded anywhere (we can only infer embedding from actual
    // search traffic on that channel).
    const widgetConfirmed = allWidgetBookings.filter(b =>
      b.payment_status === 'paid' || b.booking_stage === 'paid'
    );
    const widgetGMV = widgetConfirmed.reduce((sum, b) => sum + toKES(Number(b.total_price || 0), b.currency), 0);
    const widgetConversion = allWidgetSearches.length > 0
      ? Number(((widgetConfirmed.length / allWidgetSearches.length) * 100).toFixed(1))
      : 0;

    const totalSearchesBothChannels = allSearches.length + allWidgetSearches.length;
    const channelComparison = {
      whatsapp: {
        searches:    allSearches.length,
        bookings:    confirmedBookings.length,
        gmvKES:      Math.round(totalGMV),
        conversion:  conversionRate,
        share:       totalSearchesBothChannels > 0
          ? Number((allSearches.length / totalSearchesBothChannels * 100).toFixed(1))
          : 0,
      },
      widget: {
        searches:    allWidgetSearches.length,
        bookings:    widgetConfirmed.length,
        gmvKES:      Math.round(widgetGMV),
        conversion:  widgetConversion,
        share:       totalSearchesBothChannels > 0
          ? Number((allWidgetSearches.length / totalSearchesBothChannels * 100).toFixed(1))
          : 0,
      },
    };

    res.json({
      success: true,
      whatsapp: {
        number:        agency?.whatsapp_number || null,
        phoneNumberId: agency?.whatsapp_phone_number_id || null,
        isConnected:   !!agency?.whatsapp_phone_number_id,
      },
      channelComparison,
      stats: {
        totalContacts:     scopedContacts.length,
        totalSearches:     allSearches.length,
        totalBookings:     allBookings.length,
        confirmedBookings: confirmedBookings.length,
        totalGMVKES:       Math.round(totalGMV),
        conversionRate,
        activeSessionsNow: allSessions.length,
      },
      recentConversations,
      searchesByDay,
      topDestinations,
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    logger.error('WhatsApp stats failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/whatsapp/conversations/:phone
// Full conversation history for one contact, scoped to this agency.
// ─────────────────────────────────────────────
router.get('/conversations/:phone', async (req, res) => {
  try {
    const agencyId = req.agencyId;
    if (!agencyId) return res.status(401).json({ success: false, error: 'Agency not identified.' });

    const { phone } = req.params;

    // Scoped to agency_id — without this, any authenticated agency
    // could pull ANY contact's full profile/conversation_history by
    // guessing or enumerating phone numbers, regardless of whether
    // that contact ever talked to them. Real access-control gap,
    // closed now that whatsapp_contacts carries agency_id.
    const { data: contact } = await supabase
      .from('whatsapp_contacts')
      .select('*')
      .eq('phone', phone)
      .eq('agency_id', agencyId)
      .maybeSingle();

    const { data: searches } = await supabase
      .from('trip_searches')
      .select('session_id,prompt,destination,packages_returned,converted,created_at')
      .eq('agency_id', agencyId)
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(50);

    const { data: bookings } = await supabase
      .from('bookings')
      .select('booking_ref,destination,total_price,currency,booking_stage,payment_status,created_at')
      .eq('agency_id', agencyId)
      .eq('guest_phone', phone)
      .order('created_at', { ascending: false });

    // Full message-level history, if the tracking service has been
    // logging turns (see trackingService.js / engine.js). Falls back
    // gracefully to an empty array if the conversations table is
    // empty or doesn't exist yet — never throws.
    let convTurns = [];
    try {
      const { data } = await supabase
        .from('conversations')
        .select('*')
        .eq('phone', phone)
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: true })
        .limit(100);
      convTurns = data || [];
    } catch (_) {
      convTurns = [];
    }

    res.json({
      success:  true,
      contact:  contact || null,
      turns:    convTurns,
      searches: searches || [],
      bookings: bookings || [],
    });

  } catch (err) {
    logger.error('WhatsApp conversation fetch failed', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;