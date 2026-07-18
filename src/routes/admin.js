/**
 * BODRLESS ADMIN DASHBOARD
 * ─────────────────────────────────────────────────────────────
 * Internal ops dashboard for the Bodrless team.
 * Protected by BODRLESS_ADMIN_KEY env var (Bearer token).
 * Mount at: app.use('/admin', require('./routes/admin'))
 * Access at: https://your-api.onrender.com/admin/dashboard
 * ─────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

function requireAdminKey(req, res, next) {
  const adminKey = process.env.BODRLESS_ADMIN_KEY;
  if (!adminKey) {
    logger.warn('BODRLESS_ADMIN_KEY not set — admin dashboard is unprotected');
    return next();
  }
  const authHeader = req.headers.authorization || '';
  const bearerKey  = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryKey   = req.query.key;
  if (bearerKey === adminKey || queryKey === adminKey) return next();
  res.status(401).json({ error: 'Unauthorized.' });
}

// ── Data queries ──────────────────────────────────────────────
async function getOverviewStats() {
  const [
    { data: bookings },
    { data: searches },
    { data: agencies },
    { data: contacts },
    { data: sessions },
  ] = await Promise.all([
    supabase.from('bookings').select('agency_id,total_price,currency,status,payment_status,booking_stage,channel,passengers,created_at'),
    supabase.from('trip_searches').select('agency_id,destination,channel,converted,created_at,passengers').order('created_at', { ascending: false }).limit(500),
    supabase.from('agencies').select('id,name,created_at'),
    supabase.from('whatsapp_contacts').select('phone,created_at'),
    supabase.from('whatsapp_booking_sessions').select('phone,agency_id,current_step,created_at'),
  ]);

  const allBookings  = bookings  || [];
  const allSearches  = searches  || [];
  const allAgencies  = agencies  || [];
  const allContacts  = contacts  || [];
  const allSessions  = sessions  || [];

  const confirmedBookings = allBookings.filter(b =>
    b.payment_status === 'paid' || b.booking_stage === 'paid' || b.status === 'confirmed'
  );
  const totalGMV = confirmedBookings.reduce((sum, b) => {
    const price = Number(b.total_price || 0);
    const cur = (b.currency || 'USD').toUpperCase();
    if (cur === 'KES') return sum + price;
    if (cur === 'EUR') return sum + price * 130;
    return sum + price * 129;
  }, 0);

  const bodrlessCut = totalGMV * 0.15;
  const agencyCut   = totalGMV * 0.85;

  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const liveSearches = allSearches.filter(s => s.created_at > oneDayAgo);
  const pendingPayments = allBookings.filter(b =>
    b.booking_stage === 'awaiting_payment' || b.booking_stage === 'hotel_confirmed'
  );

  const agencyMap = {};
  for (const a of allAgencies) {
    agencyMap[a.id] = { id: a.id, name: a.name, created: a.created_at, searches: 0, bookings: 0, gmvKES: 0, travelers: 0, channels: new Set() };
  }
  for (const s of allSearches) {
    if (agencyMap[s.agency_id]) { agencyMap[s.agency_id].searches++; if (s.channel) agencyMap[s.agency_id].channels.add(s.channel); }
  }
  for (const b of confirmedBookings) {
    if (agencyMap[b.agency_id]) {
      agencyMap[b.agency_id].bookings++;
      agencyMap[b.agency_id].travelers += (Number(b.passengers) || 1);
      const price = Number(b.total_price || 0);
      const cur = (b.currency || 'USD').toUpperCase();
      agencyMap[b.agency_id].gmvKES += cur === 'KES' ? price : cur === 'EUR' ? price * 130 : price * 129;
      if (b.channel) agencyMap[b.agency_id].channels.add(b.channel);
    }
  }

  const destCounts = {};
  for (const s of allSearches) {
    if (s.destination) { const d = s.destination.toLowerCase(); destCounts[d] = (destCounts[d] || 0) + 1; }
  }
  const topDestinations = Object.entries(destCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), count }));

  const recentSearchEvents = allSearches.slice(0, 10).map(s => ({ type: 'search', destination: s.destination || 'Unknown', agencyId: s.agency_id, channel: s.channel || 'unknown', ts: s.created_at }));
  const recentBookingEvents = allBookings.filter(b => b.booking_stage === 'awaiting_payment' || b.booking_stage === 'paid').slice(0, 10).map(b => ({ type: b.booking_stage === 'paid' ? 'confirmed' : 'payment', destination: b.destination || 'Unknown', agencyId: b.agency_id, channel: b.channel || 'unknown', price: Number(b.total_price || 0), currency: b.currency || 'KES', ts: b.created_at }));
  const recentActivity = [...recentSearchEvents, ...recentBookingEvents].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 15);

  const days = {};
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days[d.toISOString().split('T')[0]] = { count: 0, gmvKES: 0 }; }
  for (const b of confirmedBookings) {
    const day = (b.created_at || '').slice(0, 10);
    if (days[day]) { days[day].count++; const price = Number(b.total_price || 0); days[day].gmvKES += b.currency === 'EUR' ? price * 130 : b.currency === 'USD' ? price * 129 : price; }
  }
  const bookingsByDay = Object.entries(days).map(([date, v]) => ({ date, ...v }));

  const channelCounts = { whatsapp: 0, widget: 0, other: 0 };
  for (const s of allSearches) { const ch = (s.channel || 'other').toLowerCase(); if (ch === 'whatsapp') channelCounts.whatsapp++; else if (ch === 'widget') channelCounts.widget++; else channelCounts.other++; }

  const totalTravelers = confirmedBookings.reduce((s, b) => s + (Number(b.passengers) || 1), 0);
  const conversionRate = allSearches.length > 0 ? (confirmedBookings.length / allSearches.length * 100).toFixed(1) : 0;

  return {
    totalAgencies: allAgencies.length,
    activeAgencies: Object.values(agencyMap).filter(a => a.searches > 0 || a.bookings > 0).length,
    agencies: Object.values(agencyMap).map(a => ({ ...a, channels: [...a.channels] })),
    totalSearches: allSearches.length, totalBookings: allBookings.length, confirmedBookings: confirmedBookings.length,
    totalGMVKES: Math.round(totalGMV), bodrlessCutKES: Math.round(bodrlessCut), agencyCutKES: Math.round(agencyCut),
    avgBookingValueKES: confirmedBookings.length > 0 ? Math.round(totalGMV / confirmedBookings.length) : 0,
    totalTravelers, conversionRate, topDestinations, recentActivity, bookingsByDay, channelCounts,
    liveSearchCount: liveSearches.length, pendingPaymentCount: pendingPayments.length,
    totalContacts: allContacts.length, activeSessions: allSessions.length,
  };
}

// ── Conversations API ─────────────────────────────────────────
router.get('/api/conversations', requireAdminKey, async (req, res) => {
  try {
    const { phone, session_id, booking_ref, agency_id, limit = 50, offset = 0 } = req.query;
    let query = supabase.from('conversations').select('*').order('created_at', { ascending: false }).range(Number(offset), Number(offset) + Number(limit) - 1);
    if (phone)       query = query.eq('phone', phone);
    if (session_id)  query = query.eq('session_id', session_id);
    if (booking_ref) query = query.eq('booking_ref', booking_ref);
    if (agency_id)   query = query.eq('agency_id', agency_id);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ success: true, conversations: data || [], total: count });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Alerts API ────────────────────────────────────────────────
router.get('/api/alerts', requireAdminKey, async (req, res) => {
  try {
    const { resolved = 'false', limit = 50 } = req.query;
    const { data, error } = await supabase.from('alerts').select('*').eq('resolved', resolved === 'true').order('created_at', { ascending: false }).limit(Number(limit));
    if (error) throw error;
    res.json({ success: true, alerts: data || [] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/api/alerts/:id/resolve', requireAdminKey, async (req, res) => {
  try {
    const tracking = require('../services/trackingService');
    await tracking.resolveAlert(req.params.id, 'admin');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Providers API ─────────────────────────────────────────────
router.get('/api/providers', requireAdminKey, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - 30);
    const { data, error } = await supabase.from('trip_searches').select('preferred_transport_provider, preferred_transport_mode, preferred_fulfilled, agency_id, created_at').not('preferred_transport_provider', 'is', null).gte('created_at', since.toISOString());
    if (error) throw error;
    const rows = data || [];
    const byMode = { flight: {}, bus: {}, train: {}, other: {} };
    for (const r of rows) {
      const mode = r.preferred_transport_mode || 'other';
      const bucket = byMode[mode] || (byMode[mode] = {});
      const name = r.preferred_transport_provider;
      if (!bucket[name]) bucket[name] = { name, requested: 0, fulfilled: 0 };
      bucket[name].requested++;
      if (r.preferred_fulfilled === true) bucket[name].fulfilled++;
    }
    const toList = (bucket) => Object.values(bucket).sort((a, b) => b.requested - a.requested).slice(0, 10);
    res.json({ success: true, providers: { flight: toList(byMode.flight), bus: toList(byMode.bus), train: toList(byMode.train), other: toList(byMode.other) }, totalWithPreference: rows.length, generatedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Insights API ──────────────────────────────────────────────
router.get('/api/insights', requireAdminKey, async (req, res) => {
  try {
    const { type, agency_id } = req.query;
    let query = supabase.from('insights').select('*').order('severity', { ascending: false }).order('computed_at', { ascending: false });
    if (type)      query = query.eq('type', type);
    if (agency_id) query = query.eq('agency_id', agency_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, insights: data || [] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/api/insights/refresh', requireAdminKey, async (req, res) => {
  try {
    const insightsEngine = require('../services/insightsEngine');
    const result = await insightsEngine.refreshAll();
    res.json({ success: true, result });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── WhatsApp overview ─────────────────────────────────────────
router.get('/api/whatsapp/overview', requireAdminKey, async (req, res) => {
  try {
    const [{ data: agencies }, { data: contacts }, { data: searches }, { data: bookings }, { data: sessions }, { data: widgetSearches }, { data: widgetBookings }] = await Promise.all([
      supabase.from('agencies').select('id,name,whatsapp_number,whatsapp_phone_number_id,widget_key,ops_whatsapp_number'),
      supabase.from('whatsapp_contacts').select('phone,name,first_seen_at,updated_at').order('updated_at', { ascending: false }).limit(500),
      supabase.from('trip_searches').select('agency_id,converted,created_at').eq('channel', 'whatsapp'),
      supabase.from('bookings').select('agency_id,total_price,currency,booking_stage,payment_status,created_at').eq('channel', 'whatsapp'),
      supabase.from('whatsapp_booking_sessions').select('phone,agency_id,current_step,created_at'),
      supabase.from('trip_searches').select('agency_id,converted,created_at').eq('channel', 'widget'),
      supabase.from('bookings').select('agency_id,total_price,currency,booking_stage,payment_status,created_at').eq('channel', 'widget'),
    ]);
    const toKES = (price, currency) => { const cur = (currency || 'USD').toUpperCase(); return cur === 'KES' ? price : cur === 'EUR' ? price * 130 : price * 129; };
    const allAgencies = agencies || []; const allContacts = contacts || []; const allSearches = searches || []; const allBookings = bookings || []; const allSessions = sessions || [];
    const allWidgetSearches = widgetSearches || []; const allWidgetBookings = widgetBookings || [];
    const agencyStats = allAgencies.map(a => {
      const agSearches = allSearches.filter(s => s.agency_id === a.id);
      const agBookings = allBookings.filter(b => b.agency_id === a.id);
      const agSessions = allSessions.filter(s => s.agency_id === a.id);
      const confirmed = agBookings.filter(b => b.payment_status === 'paid' || b.booking_stage === 'paid');
      const gmv = confirmed.reduce((sum, b) => sum + toKES(Number(b.total_price || 0), b.currency), 0);
      const agWidgetSearches = allWidgetSearches.filter(s => s.agency_id === a.id);
      const agWidgetBookings = allWidgetBookings.filter(b => b.agency_id === a.id);
      const widgetConfirmed = agWidgetBookings.filter(b => b.payment_status === 'paid' || b.booking_stage === 'paid');
      const widgetGmv = widgetConfirmed.reduce((sum, b) => sum + toKES(Number(b.total_price || 0), b.currency), 0);
      const totalChannelSearches = agSearches.length + agWidgetSearches.length;
      return { agencyId: a.id, agencyName: a.name, whatsapp: { number: a.whatsapp_number || null, isConnected: !!a.whatsapp_phone_number_id, searches: agSearches.length, bookings: confirmed.length, gmvKES: Math.round(gmv), activeSessions: agSessions.length, conversion: agSearches.length > 0 ? Number((confirmed.length / agSearches.length * 100).toFixed(1)) : 0 }, widget: { isConfigured: !!a.widget_key, searches: agWidgetSearches.length, bookings: widgetConfirmed.length, gmvKES: Math.round(widgetGmv), conversion: agWidgetSearches.length > 0 ? Number((widgetConfirmed.length / agWidgetSearches.length * 100).toFixed(1)) : 0 }, primaryChannel: totalChannelSearches === 0 ? 'none' : agSearches.length >= agWidgetSearches.length ? 'whatsapp' : 'widget', whatsappShare: totalChannelSearches > 0 ? Number((agSearches.length / totalChannelSearches * 100).toFixed(1)) : 0 };
    });
    const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
    const recentContacts = allContacts.filter(c => c.updated_at > oneDayAgo).slice(0, 20);
    const totalConfirmed = allBookings.filter(b => b.payment_status === 'paid' || b.booking_stage === 'paid');
    const totalGMV = totalConfirmed.reduce((sum, b) => sum + toKES(Number(b.total_price || 0), b.currency), 0);
    const widgetTotalConfirmed = allWidgetBookings.filter(b => b.payment_status === 'paid' || b.booking_stage === 'paid');
    const widgetTotalGMV = widgetTotalConfirmed.reduce((sum, b) => sum + toKES(Number(b.total_price || 0), b.currency), 0);
    const opsNumber = allAgencies.find(a => a.ops_whatsapp_number)?.ops_whatsapp_number || null;
    res.json({ success: true, opsNumber, totals: { totalContacts: allContacts.length, activeNow: allSessions.length, whatsappSearches: allSearches.length, whatsappBookings: totalConfirmed.length, whatsappGMVKES: Math.round(totalGMV), recentContacts24h: recentContacts.length, widgetSearches: allWidgetSearches.length, widgetBookings: widgetTotalConfirmed.length, widgetGMVKES: Math.round(widgetTotalGMV), totalSearches: allSearches.length + allWidgetSearches.length, totalGMVKES: Math.round(totalGMV + widgetTotalGMV) }, agencyBreakdown: agencyStats, recentContacts, generatedAt: new Date().toISOString() });
  } catch (err) { logger.error('WhatsApp overview failed', { error: err.message }); res.status(500).json({ success: false, error: err.message }); }
});

// ── Stats API ─────────────────────────────────────────────────
router.get('/api/stats', requireAdminKey, async (req, res) => {
  try {
    const stats = await getOverviewStats();
    res.json({ success: true, stats, generatedAt: new Date().toISOString() });
  } catch (err) { logger.error('Admin stats query failed', { error: err.message }); res.status(500).json({ success: false, error: err.message }); }
});

// ── ACTIVE TRIPS API ──────────────────────────────────────────
// GET /admin/api/trips — all active trips across all agencies
router.get('/api/trips', requireAdminKey, async (req, res) => {
  try {
    const { health, agency_id, limit = 100 } = req.query;
    let query = supabase.from('active_trips_dashboard').select('*').limit(Number(limit));
    if (health)    query = query.eq('health', health);
    if (agency_id) query = query.eq('agency_id', agency_id);
    const { data: trips, error } = await query;
    if (error) throw error;
    const all = trips || [];
    res.json({ success: true, trips: all, summary: { total: all.length, healthy: all.filter(t => t.health === 'healthy').length, attention: all.filter(t => t.health === 'attention').length, critical: all.filter(t => t.health === 'critical').length } });
  } catch (err) { logger.error('Admin trips query failed', { error: err.message }); res.status(500).json({ success: false, error: err.message }); }
});

// GET /admin/api/trips/:id/events — event timeline for one trip
router.get('/api/trips/:id/events', requireAdminKey, async (req, res) => {
  try {
    const { data: events, error } = await supabase.from('trip_events').select('*').eq('trip_id', req.params.id).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    res.json({ success: true, events: events || [] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /admin/api/trips/:id/resolve — manually resolve a disruption
router.post('/api/trips/:id/resolve', requireAdminKey, async (req, res) => {
  try {
    const tripMonitoringService = require('../services/tripMonitoringService');
    await tripMonitoringService.resolveDisruption(req.params.id, 'admin');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Dashboard HTML ────────────────────────────────────────────
router.get('/dashboard', requireAdminKey, async (req, res) => {
  const adminKey = process.env.BODRLESS_ADMIN_KEY || '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bodrless ops</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--navy:#0f1a2e;--navy-mid:#1a2d4a;--navy-light:#243d60;--accent:#2563eb;--green:#16a34a;--amber:#d97706;--red:#dc2626;--surface:#f8f9fb;--card:#ffffff;--border:#e4e8f0;--text:#0f172a;--muted:#64748b;--mono:'SF Mono','Fira Code',Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
body{font-family:var(--sans);background:var(--surface);color:var(--text);display:flex;min-height:100vh;font-size:14px;line-height:1.5}
#sidebar{width:220px;flex-shrink:0;background:var(--navy);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
#sidebar-logo{padding:24px 20px 16px;border-bottom:1px solid var(--navy-light)}
#sidebar-logo .brand{font-size:17px;font-weight:600;color:#fff;letter-spacing:-0.02em}
#sidebar-logo .brand span{color:var(--accent)}
#sidebar-logo .env{font-size:10px;color:#4a7aad;margin-top:3px;font-family:var(--mono);letter-spacing:0.05em}
#sidebar nav{padding:12px 0;flex:1}
.nav-section{padding:4px 20px 8px;font-size:10px;font-weight:600;color:#4a7aad;text-transform:uppercase;letter-spacing:0.08em;margin-top:8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:13px;color:#8ba9cc;cursor:pointer;border-left:2px solid transparent;transition:all 0.12s}
.nav-item:hover{color:#fff;background:var(--navy-mid)}
.nav-item.active{color:#fff;border-left-color:var(--accent);background:var(--navy-mid)}
.nav-item svg{width:16px;height:16px;opacity:0.7;flex-shrink:0}
.nav-item.active svg{opacity:1}
#sidebar-foot{padding:16px 20px;border-top:1px solid var(--navy-light)}
.live-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#4ade80}
.live-dot{width:6px;height:6px;border-radius:50%;background:#4ade80;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
#main{flex:1;overflow:auto;min-width:0}
#topbar{position:sticky;top:0;z-index:10;background:rgba(248,249,251,0.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--border);padding:12px 28px;display:flex;align-items:center;justify-content:space-between}
#topbar h1{font-size:15px;font-weight:500;color:var(--text)}
.topbar-right{display:flex;align-items:center;gap:12px}
#last-updated{font-size:12px;color:var(--muted);font-family:var(--mono)}
.refresh-btn{padding:6px 14px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--muted);cursor:pointer}
.refresh-btn:hover{background:#f1f5f9;color:var(--text)}
#content{padding:24px 28px;max-width:1100px}
.section{display:none}.section.active{display:block}
.section-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.07em;margin-bottom:16px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px 18px}
.kpi-label{font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:500}
.kpi-value{font-size:26px;font-weight:600;color:var(--text);font-family:var(--mono);letter-spacing:-0.02em;line-height:1}
.kpi-sub{font-size:11px;color:var(--muted);margin-top:4px}
.kpi.hi .kpi-value{color:var(--accent)}.kpi.go .kpi-value{color:var(--green)}.kpi.warn .kpi-value{color:var(--amber)}
.gmv-hero{background:var(--navy);border-radius:12px;padding:28px 28px 24px;margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between}
.gmv-hero-left .label{font-size:11px;color:#4a7aad;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px}
.gmv-amount{font-size:52px;font-weight:700;color:#fff;font-family:var(--mono);letter-spacing:-0.03em;line-height:1}
.gmv-amount .currency{font-size:20px;color:#4a7aad;vertical-align:super;margin-right:4px}
.gmv-usd{font-size:14px;color:#4a7aad;margin-top:4px;font-family:var(--mono)}
.gmv-hero-right{display:grid;grid-template-columns:1fr 1fr;gap:10px;min-width:240px}
.gmv-card{background:var(--navy-mid);border-radius:8px;padding:12px 14px}
.gmv-card-label{font-size:10px;color:#4a7aad;margin-bottom:4px;font-weight:500}
.gmv-card-value{font-size:18px;font-weight:600;font-family:var(--mono);letter-spacing:-0.02em}
.gmv-card.b .gmv-card-value{color:#60a5fa}.gmv-card.a .gmv-card-value{color:#4ade80}
.gmv-card-sub{font-size:10px;color:#4a7aad;margin-top:2px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:18px}
.card-title{font-size:13px;font-weight:600;margin-bottom:14px;color:var(--text)}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px}
@media(max-width:800px){.two-col{grid-template-columns:1fr}.gmv-hero{flex-direction:column;gap:16px}.gmv-hero-right{min-width:0;width:100%}}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;padding:0 0 10px;border-bottom:1px solid var(--border)}
td{padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
.mono{font-family:var(--mono);font-size:12px}
.pill{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px}
.pill.wa{background:#dcfce7;color:#15803d}.pill.widget{background:#dbeafe;color:#1d4ed8}.pill.paid{background:#dcfce7;color:#15803d}.pill.pending{background:#fef9c3;color:#92400e}.pill.search{background:#ede9fe;color:#6d28d9}.pill.confirmed{background:#dcfce7;color:#15803d}
.avatar{width:30px;height:30px;border-radius:50%;background:var(--navy-mid);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;color:#60a5fa;flex-shrink:0;font-family:var(--mono)}
.dest-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #f1f5f9}.dest-row:last-child{border-bottom:none}
.dest-name{flex:1;font-size:13px}.dest-bar-wrap{width:100px;height:5px;background:#f1f5f9;border-radius:3px}.dest-bar{height:100%;background:var(--accent);border-radius:3px}.dest-count{font-size:12px;color:var(--muted);font-family:var(--mono);min-width:28px;text-align:right}
.live-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px}.live-row:last-child{border-bottom:none}
.live-dest{flex:1;font-weight:500}.live-time{font-size:11px;color:var(--muted);font-family:var(--mono)}.live-channel{font-size:10px;color:var(--muted)}
.chart-wrap{position:relative;width:100%;height:200px}
.loading{padding:60px 0;text-align:center;color:var(--muted)}
.err{padding:16px;background:#fef2f2;border-radius:8px;color:var(--red);font-size:13px;border:1px solid #fecaca}
.empty{font-size:12px;color:var(--muted);padding:20px 0;text-align:center}
.pkg-detail-toggle{font-size:11px;color:var(--accent);cursor:pointer;margin-top:4px;display:inline-block;user-select:none}
.pkg-detail-toggle:hover{text-decoration:underline}
.pkg-detail-list{margin-top:8px;display:none}.pkg-detail-list.open{display:block}
.pkg-detail-card{background:#f8f9fb;border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:12px}.pkg-detail-card:last-child{margin-bottom:0}
.pkg-detail-row{display:flex;justify-content:space-between;gap:10px;padding:3px 0}.pkg-detail-row .k{color:var(--muted);flex-shrink:0}.pkg-detail-row .v{text-align:right;font-weight:500}
.pkg-detail-price{font-size:13px;font-weight:600;color:var(--text);margin-top:6px;padding-top:6px;border-top:1px dashed var(--border)}
/* Trip monitoring styles */
.h-badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:12px}
.h-badge.healthy{background:#dcfce7;color:#15803d}.h-badge.attention{background:#fef9c3;color:#92400e}.h-badge.critical{background:#fee2e2;color:#b91c1c}
.h-dot{width:5px;height:5px;border-radius:50%;display:inline-block}
.h-dot.healthy{background:#16a34a}.h-dot.attention{background:#d97706}.h-dot.critical{background:#dc2626;animation:blink 1s infinite}
.stage-pill{font-size:10px;padding:2px 7px;border-radius:10px}
.disruption-banner{background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:12px;color:#9a3412}
.trip-row-item{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #f1f5f9}.trip-row-item:last-child{border-bottom:none}
</style>
</head>
<body>
<aside id="sidebar">
  <div id="sidebar-logo">
    <div class="brand">Bodr<span>less</span></div>
    <div class="env">OPS DASHBOARD</div>
  </div>
  <nav>
    <div class="nav-section">Analytics</div>
    <div class="nav-item active" onclick="showSection('overview',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      Overview
    </div>
    <div class="nav-item" onclick="showSection('agencies',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      Agencies
    </div>
    <div class="nav-item" onclick="showSection('bookings',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="m9 12 2 2 4-4"/></svg>
      Bookings
    </div>
    <div class="nav-item" onclick="showSection('destinations',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
      Destinations
    </div>
    <div class="nav-section">Live</div>
    <div class="nav-item" onclick="showSection('live',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Activity
    </div>
    <div class="nav-item" onclick="showSection('trips',this)" id="nav-trips">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z"/><circle cx="12" cy="10" r="3"/></svg>
      Active Trips
      <span id="trips-critical-badge" style="display:none;background:#dc2626;color:#fff;font-size:10px;padding:1px 6px;border-radius:10px;margin-left:4px"></span>
    </div>
    <div class="nav-item" onclick="showSection('conversations',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Conversations
    </div>
    <div class="nav-item" onclick="showSection('alerts',this)" id="nav-alerts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      Alerts <span id="alert-badge" style="display:none;background:#dc2626;color:#fff;font-size:10px;padding:1px 6px;border-radius:10px;margin-left:4px"></span>
    </div>
    <div class="nav-item" onclick="showSection('insights',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9.663 17h4.673M12 3v1m6.364 1.636-.707.707M21 12h-1M4 12H3m3.343-5.657-.707-.707m2.828 9.9a5 5 0 1 1 6.364 0M9.5 17a3.5 3.5 0 0 0 5 0"/></svg>
      Insights
    </div>
    <div class="nav-item" onclick="showSection('providers',this)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
      Providers
    </div>
  </nav>
  <div id="sidebar-foot"><div class="live-pill"><span class="live-dot"></span> Live</div></div>
</aside>

<div id="main">
  <div id="topbar">
    <h1 id="page-title">Overview</h1>
    <div class="topbar-right">
      <span id="last-updated">—</span>
      <button class="refresh-btn" onclick="loadData()">Refresh</button>
    </div>
  </div>
  <div id="content">
    <div id="section-overview" class="section active"><div id="overview-body"><div class="loading">Loading...</div></div></div>
    <div id="section-agencies" class="section"><div id="agencies-body"><div class="loading">Loading...</div></div></div>
    <div id="section-bookings" class="section"><div id="bookings-body"><div class="loading">Loading...</div></div></div>
    <div id="section-destinations" class="section"><div id="destinations-body"><div class="loading">Loading...</div></div></div>
    <div id="section-live" class="section"><div id="live-body"><div class="loading">Loading...</div></div></div>

    <!-- ACTIVE TRIPS -->
    <div id="section-trips" class="section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <p style="font-size:12px;color:var(--muted);max-width:560px">All active trips across every agency — sorted by health. Critical first. Monitoring starts automatically when a booking is confirmed.</p>
        <button class="refresh-btn" onclick="loadTrips()">Refresh</button>
      </div>
      <div id="trips-body"><div class="loading">Loading...</div></div>
    </div>

    <div id="section-conversations" class="section">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <input type="text" id="conv-search" placeholder="Search by phone, session ID or booking ref..." style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--card);color:var(--text)"/>
        <button class="refresh-btn" onclick="loadConversations()">Search</button>
      </div>
      <div id="conversations-body"><div class="loading">Loading...</div></div>
    </div>
    <div id="section-alerts" class="section">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
        <label style="font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px"><input type="checkbox" id="show-resolved" onchange="loadAlerts()"> Show resolved</label>
      </div>
      <div id="alerts-body"><div class="loading">Loading...</div></div>
    </div>
    <div id="section-insights" class="section">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <p style="font-size:12px;color:var(--muted);max-width:560px">Patterns detected from your real search and booking data — refreshed hourly.</p>
        <button class="refresh-btn" onclick="refreshInsights()" id="insights-refresh-btn">Refresh now</button>
      </div>
      <div id="insights-body"><div class="loading">Loading...</div></div>
    </div>
    <div id="section-providers" class="section">
      <p style="font-size:12px;color:var(--muted);margin-bottom:16px;max-width:560px">Airlines, bus companies, and train operators travelers have named in their prompts — last 30 days.</p>
      <div id="providers-body"><div class="loading">Loading...</div></div>
    </div>
  </div>
</div>

<script>
const ADMIN_KEY = '${adminKey}';
const KES_TO_USD = 0.0077;
let DATA = null;
let gmvChart = null;

function fmt(n){return Math.round(n||0).toLocaleString('en-KE')}
function kes(n){return 'KES\u00a0'+fmt(n)}
function usd(n){return '$'+fmt((n||0)*KES_TO_USD)}
function pct(a,b){return b>0?Math.round(a/b*100)+'%':'0%'}
function ago(ts){
  const m=Math.floor((Date.now()-new Date(ts))/60000);
  if(m<1)return 'just now';if(m<60)return m+'m ago';
  const h=Math.floor(m/60);if(h<24)return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function initials(name){return (name||'??').split(/[\s\-_]/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('')}
function pill(type){
  const map={whatsapp:'<span class="pill wa">WhatsApp</span>',widget:'<span class="pill widget">Widget</span>',paid:'<span class="pill paid">Paid</span>',confirmed:'<span class="pill confirmed">Confirmed</span>',awaiting_payment:'<span class="pill pending">Awaiting payment</span>',hotel_confirmed:'<span class="pill pending">Pending payment</span>',search:'<span class="pill search">Search</span>'};
  return map[type]||'<span class="pill">'+type+'</span>';
}

function showSection(id, el){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('section-'+id).classList.add('active');
  if(el) el.classList.add('active');
  const titles={overview:'Overview',agencies:'Agencies',bookings:'Bookings',destinations:'Destinations',live:'Live activity',trips:'Active Trips',conversations:'Conversations',alerts:'Alerts',insights:'Insights',providers:'Top Providers'};
  document.getElementById('page-title').textContent = titles[id]||id;
  if(id==='conversations') loadConversations();
  else if(id==='alerts') loadAlerts();
  else if(id==='insights') loadInsights();
  else if(id==='providers') loadProviders();
  else if(id==='trips') loadTrips();
  else if(DATA) renderSection(id);
}

async function loadData(){
  document.getElementById('last-updated').textContent = 'Updating...';
  try {
    const r = await fetch('/admin/api/stats?key='+encodeURIComponent(ADMIN_KEY));
    if(!r.ok) throw new Error('HTTP '+r.status);
    const j = await r.json();
    if(!j.success) throw new Error(j.error||'Unknown error');
    DATA = j.stats;
    document.getElementById('last-updated').textContent = new Date().toLocaleTimeString('en-KE',{hour:'2-digit',minute:'2-digit'});
    ['overview','agencies','bookings','destinations','live'].forEach(renderSection);
  } catch(e){
    document.getElementById('last-updated').textContent = 'Error';
    document.getElementById('overview-body').innerHTML='<div class="err">Failed to load: '+e.message+'</div>';
  }
}

function renderSection(id){
  if(!DATA) return;
  if(id==='overview') renderOverview(DATA);
  if(id==='agencies') renderAgencies(DATA);
  if(id==='bookings') renderBookings(DATA);
  if(id==='destinations') renderDestinations(DATA);
  if(id==='live') renderLive(DATA);
}

function renderOverview(d){
  const el = document.getElementById('overview-body');
  el.innerHTML = \`
    <div class="gmv-hero">
      <div class="gmv-hero-left">
        <div class="label">Total GMV</div>
        <div class="gmv-amount"><span class="currency">KES</span>\${fmt(d.totalGMVKES)}</div>
        <div class="gmv-usd">\${usd(d.totalGMVKES)} · \${d.confirmedBookings} confirmed bookings</div>
      </div>
      <div class="gmv-hero-right">
        <div class="gmv-card b"><div class="gmv-card-label">Bodrless cut</div><div class="gmv-card-value">\${kes(d.bodrlessCutKES)}</div><div class="gmv-card-sub">\${pct(d.bodrlessCutKES,d.totalGMVKES)} of GMV</div></div>
        <div class="gmv-card a"><div class="gmv-card-label">Agency earnings</div><div class="gmv-card-value">\${kes(d.agencyCutKES)}</div><div class="gmv-card-sub">\${pct(d.agencyCutKES,d.totalGMVKES)} of GMV</div></div>
        <div class="gmv-card"><div class="gmv-card-label">Avg booking</div><div class="gmv-card-value" style="color:#fff">\${kes(d.avgBookingValueKES)}</div><div class="gmv-card-sub">\${usd(d.avgBookingValueKES)}</div></div>
        <div class="gmv-card"><div class="gmv-card-label">Conversion</div><div class="gmv-card-value" style="color:#fbbf24">\${d.conversionRate}%</div><div class="gmv-card-sub">search → booking</div></div>
      </div>
    </div>
    <div class="kpi-grid">
      <div class="kpi hi"><div class="kpi-label">Agencies</div><div class="kpi-value">\${d.totalAgencies}</div><div class="kpi-sub">\${d.activeAgencies} active</div></div>
      <div class="kpi"><div class="kpi-label">Total searches</div><div class="kpi-value">\${fmt(d.totalSearches)}</div><div class="kpi-sub">last 500 loaded</div></div>
      <div class="kpi go"><div class="kpi-label">Live searches</div><div class="kpi-value">\${d.liveSearchCount}</div><div class="kpi-sub">last 24 hours</div></div>
      <div class="kpi warn"><div class="kpi-label">Awaiting payment</div><div class="kpi-value">\${d.pendingPaymentCount}</div><div class="kpi-sub">open sessions</div></div>
      <div class="kpi"><div class="kpi-label">Travelers</div><div class="kpi-value">\${fmt(d.totalTravelers)}</div><div class="kpi-sub">confirmed bookings</div></div>
      <div class="kpi"><div class="kpi-label">WhatsApp contacts</div><div class="kpi-value">\${fmt(d.totalContacts)}</div><div class="kpi-sub">\${d.activeSessions} active sessions</div></div>
    </div>
    <div class="two-col">
      <div class="card"><div class="card-title">Bookings over 14 days</div><div class="chart-wrap"><canvas id="gmvChart"></canvas></div></div>
      <div class="card"><div class="card-title">Channel split</div><div class="chart-wrap"><canvas id="channelChart"></canvas></div></div>
    </div>\`;
  if(gmvChart){gmvChart.destroy();gmvChart=null;}
  const ctx=document.getElementById('gmvChart');
  if(ctx&&d.bookingsByDay){gmvChart=new Chart(ctx,{type:'bar',data:{labels:d.bookingsByDay.map(r=>r.date.slice(5)),datasets:[{label:'GMV (KES)',data:d.bookingsByDay.map(r=>r.gmvKES),backgroundColor:'#2563eb',borderRadius:3,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:v=>'KES '+fmt(v.raw)}}},scales:{x:{grid:{display:false},ticks:{font:{size:10},color:'#94a3b8',maxRotation:45}},y:{grid:{color:'#f1f5f9'},ticks:{font:{size:10},color:'#94a3b8',callback:v=>v===0?'0':'KES '+fmt(v)}}}}})}
  const ctx2=document.getElementById('channelChart');
  if(ctx2&&d.channelCounts){const total=d.channelCounts.whatsapp+d.channelCounts.widget+(d.channelCounts.other||0);new Chart(ctx2,{type:'doughnut',data:{labels:['WhatsApp','Widget','Other'],datasets:[{data:[d.channelCounts.whatsapp,d.channelCounts.widget,d.channelCounts.other||0],backgroundColor:['#16a34a','#2563eb','#94a3b8'],borderWidth:2,borderColor:'#fff'}]},options:{responsive:true,maintainAspectRatio:false,cutout:'65%',plugins:{legend:{display:false},tooltip:{callbacks:{label:v=>{const p=total>0?Math.round(v.raw/total*100):0;return v.label+': '+v.raw+' ('+p+'%)'}}}}}})}
}

function renderAgencies(d){
  const el=document.getElementById('agencies-body');
  if(!d.agencies||!d.agencies.length){el.innerHTML='<div class="card"><div class="empty">No agencies found</div></div>';return;}
  const sorted=[...d.agencies].sort((a,b)=>(b.gmvKES||0)-(a.gmvKES||0));
  el.innerHTML='<div class="card"><div class="card-title">All agencies</div><table><thead><tr><th>Agency</th><th>Channels</th><th>Searches</th><th>Bookings</th><th>Travelers</th><th>GMV</th></tr></thead><tbody>'+sorted.map(a=>'<tr><td><div style="display:flex;align-items:center;gap:10px"><div class="avatar">'+initials(a.name)+'</div><div><div style="font-weight:500">'+( a.name||a.id)+'</div><div class="mono" style="color:var(--muted);font-size:10px">'+a.id+'</div></div></div></td><td>'+(a.channels||[]).map(c=>pill(c)).join(' ')+'</td><td class="mono">'+fmt(a.searches)+'</td><td class="mono">'+fmt(a.bookings)+'</td><td class="mono">'+fmt(a.travelers)+'</td><td><div class="mono" style="font-weight:600">'+kes(a.gmvKES)+'</div><div class="mono" style="color:var(--muted);font-size:11px">'+usd(a.gmvKES)+'</div></td></tr>').join('')+'</tbody></table></div>';
}

function renderBookings(d){
  const el=document.getElementById('bookings-body');
  el.innerHTML='<div class="kpi-grid" style="margin-bottom:20px"><div class="kpi go"><div class="kpi-label">Confirmed</div><div class="kpi-value">'+fmt(d.confirmedBookings)+'</div><div class="kpi-sub">'+pct(d.confirmedBookings,d.totalBookings)+' of all</div></div><div class="kpi warn"><div class="kpi-label">Pending payment</div><div class="kpi-value">'+d.pendingPaymentCount+'</div><div class="kpi-sub">awaiting M-Pesa</div></div><div class="kpi"><div class="kpi-label">Total initiated</div><div class="kpi-value">'+fmt(d.totalBookings)+'</div><div class="kpi-sub">all stages</div></div><div class="kpi hi"><div class="kpi-label">Avg value</div><div class="kpi-value">'+kes(d.avgBookingValueKES)+'</div><div class="kpi-sub">'+usd(d.avgBookingValueKES)+'</div></div></div><div class="card"><div class="card-title">Booking funnel</div>'+[{label:'Trips searched',val:d.totalSearches},{label:'Bookings initiated',val:d.totalBookings},{label:'Payment triggered',val:d.totalBookings-d.pendingPaymentCount},{label:'Confirmed & paid',val:d.confirmedBookings}].map((step,i,arr)=>{const max=arr[0].val||1;const w=Math.max(4,Math.round(step.val/max*100));return '<div style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:12px"><span>'+step.label+'</span><span class="mono">'+fmt(step.val)+'</span></div><div style="height:8px;background:#f1f5f9;border-radius:4px"><div style="height:100%;width:'+w+'%;background:var(--accent);border-radius:4px;transition:width 0.4s"></div></div></div>'}).join('')+'</div>';
}

function renderDestinations(d){
  const el=document.getElementById('destinations-body');
  const max=d.topDestinations[0]?.count||1;
  el.innerHTML='<div class="card"><div class="card-title">Most searched destinations</div>'+(d.topDestinations||[]).map(dest=>'<div class="dest-row"><span class="dest-name">'+dest.name+'</span><div class="dest-bar-wrap"><div class="dest-bar" style="width:'+Math.round(dest.count/max*100)+'%"></div></div><span class="dest-count">'+dest.count+'</span></div>').join('')+'</div>';
}

function renderLive(d){
  const el=document.getElementById('live-body');
  el.innerHTML='<div class="kpi-grid" style="margin-bottom:16px"><div class="kpi go"><div class="kpi-label">Searches today</div><div class="kpi-value">'+d.liveSearchCount+'</div><div class="kpi-sub">last 24 hours</div></div><div class="kpi warn"><div class="kpi-label">Open sessions</div><div class="kpi-value">'+d.activeSessions+'</div><div class="kpi-sub">WhatsApp booking flows</div></div><div class="kpi"><div class="kpi-label">Pending payments</div><div class="kpi-value">'+d.pendingPaymentCount+'</div><div class="kpi-sub">awaiting M-Pesa</div></div></div><div class="card"><div class="card-title" style="display:flex;align-items:center;gap:8px"><span class="live-dot"></span> Recent activity</div>'+(d.recentActivity||[]).slice(0,15).map(a=>'<div class="live-row">'+pill(a.type)+'<span class="live-dest">'+(a.destination||'Unknown')+'</span><span class="live-channel">'+(a.channel||'')+'</span>'+(a.price?'<span class="mono" style="color:var(--muted)">'+kes(a.price)+'</span>':'')+'<span class="live-time">'+ago(a.ts)+'</span></div>').join('')+'</div>';
}

// ── ACTIVE TRIPS ───────────────────────────────────────────────
async function loadTrips() {
  const el = document.getElementById('trips-body');
  if (!el) return;
  el.innerHTML = '<div class="loading">Loading trips...</div>';
  try {
    const r = await fetch('/admin/api/trips?key='+encodeURIComponent(ADMIN_KEY));
    const j = await r.json();
    if (!j.success) throw new Error(j.error);
    renderAdminTrips(j.trips, j.summary);
    updateTripsBadge(j.summary);
  } catch(e) { el.innerHTML = '<div class="err">'+e.message+'</div>'; }
}

function updateTripsBadge(summary) {
  const badge = document.getElementById('trips-critical-badge');
  if (!badge) return;
  if (summary.critical > 0) { badge.textContent = summary.critical; badge.style.display = 'inline'; }
  else badge.style.display = 'none';
}

function renderAdminTrips(trips, summary) {
  const el = document.getElementById('trips-body');
  if (!trips || !trips.length) {
    el.innerHTML = '<div class="card"><div class="empty">No active trips yet — trips appear here automatically when bookings are confirmed. The monitoring engine is running and ready.</div></div>';
    return;
  }
  const critical = trips.filter(t => t.health === 'critical');
  const attention = trips.filter(t => t.health === 'attention');
  const healthy = trips.filter(t => t.health === 'healthy');

  const hBadge = (h) => {
    const map = { healthy: 'background:#dcfce7;color:#15803d', attention: 'background:#fef9c3;color:#92400e', critical: 'background:#fee2e2;color:#b91c1c' };
    const dotC = { healthy: '#16a34a', attention: '#d97706', critical: '#dc2626' };
    return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:2px 8px;border-radius:12px;'+( map[h]||'')+'">' +
      '<span style="width:5px;height:5px;border-radius:50%;background:'+(dotC[h]||'#94a3b8')+';display:inline-block'+(h==='critical'?';animation:blink 1s infinite':'')+'">' +
      '</span>'+h.charAt(0).toUpperCase()+h.slice(1)+'</span>';
  };

  const stagePill = (s) => {
    const c={booked:'background:#ede9fe;color:#6d28d9',pre_departure:'background:#dbeafe;color:#1d4ed8',in_destination:'background:#dcfce7;color:#15803d',returning:'background:#fef9c3;color:#92400e'};
    return '<span style="font-size:10px;padding:2px 7px;border-radius:10px;'+(c[s]||'background:#f1f5f9;color:#64748b')+'">'+(s||'').replace(/_/g,' ')+'</span>';
  };

  const tripRow = (t) => {
    const ini = (t.guest_name||'??').split(' ').slice(0,2).map(w=>w[0]||'').join('').toUpperCase();
    const disruption = t.active_disruption
      ? '<div class="disruption-banner">⚠ '+(t.disruption_type||'disruption').replace(/_/g,' ')+' detected'+(t.last_event_title?' — '+t.last_event_title:'')+
        '<button onclick="resolveAdminTrip(\''+t.id+'\',this)" style="margin-left:10px;padding:2px 8px;font-size:10px;border:1px solid #fed7aa;border-radius:4px;background:transparent;color:#9a3412;cursor:pointer">Resolve</button></div>' : '';
    return '<div class="trip-row-item">' +
      '<div style="width:32px;height:32px;border-radius:50%;background:#1a2d4a;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;color:#60a5fa;flex-shrink:0;font-family:var(--mono)">'+ini+'</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-weight:500;font-size:13px">'+(t.guest_name||'Unknown')+'</span>'+hBadge(t.health)+'</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:2px">'+(t.origin||'?')+' → '+(t.destination||'?')+' · <span style="font-family:var(--mono)">'+(t.agency_id||'')+'</span></div>' +
        '<div style="display:flex;gap:6px;margin-top:4px;align-items:center;flex-wrap:wrap">'+(t.flight_number?'<span style="font-size:11px;font-family:var(--mono)">'+t.flight_number+'</span>':'')+(t.hotel_name?'<span style="font-size:11px;color:var(--muted)">· '+t.hotel_name+'</span>':'')+stagePill(t.stage)+'</div>' +
        disruption +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:12px;font-family:var(--mono)">'+(t.departure_date||'TBC')+'</div>' +
        '<div style="font-size:10px;color:var(--muted);margin-top:2px">'+(t.last_event_title||'No events yet')+'</div>' +
        '<div style="font-size:10px;color:var(--muted)">'+(t.last_event_at?ago(t.last_event_at):'')+'</div>' +
      '</div>' +
    '</div>';
  };

  const block = (title, color, list) => {
    if (!list.length) return '';
    return '<div class="card" style="margin-bottom:14px">' +
      '<div class="card-title"><span style="width:8px;height:8px;border-radius:50%;background:'+color+';display:inline-block;margin-right:6px"></span>'+title+
      '<span style="font-size:11px;color:var(--muted);margin-left:auto">'+list.length+' trip'+(list.length>1?'s':'')+'</span></div>' +
      list.map(tripRow).join('') + '</div>';
  };

  const kpis = '<div class="kpi-grid" style="margin-bottom:16px">' +
    '<div class="kpi go"><div class="kpi-label">Healthy</div><div class="kpi-value">'+summary.healthy+'</div><div class="kpi-sub">no issues</div></div>' +
    '<div class="kpi warn"><div class="kpi-label">Attention</div><div class="kpi-value">'+summary.attention+'</div><div class="kpi-sub">minor disruption</div></div>' +
    '<div class="kpi"><div class="kpi-label">Critical</div><div class="kpi-value" style="color:#dc2626">'+summary.critical+'</div><div class="kpi-sub">action required</div></div>' +
    '<div class="kpi hi"><div class="kpi-label">Total active</div><div class="kpi-value">'+summary.total+'</div><div class="kpi-sub">being monitored</div></div>' +
  '</div>';

  el.innerHTML = kpis + block('Critical', '#dc2626', critical) + block('Attention', '#d97706', attention) + block('Healthy', '#16a34a', healthy);
}

async function resolveAdminTrip(tripId, btn) {
  btn.disabled = true; btn.textContent = 'Resolving...';
  try {
    const r = await fetch('/admin/api/trips/'+tripId+'/resolve?key='+encodeURIComponent(ADMIN_KEY), { method: 'POST' });
    const j = await r.json();
    if (j.success) loadTrips();
    else { btn.disabled = false; btn.textContent = 'Resolve'; alert('Failed: '+j.error); }
  } catch(e) { btn.disabled = false; btn.textContent = 'Resolve'; }
}

// ── Conversations ─────────────────────────────────────────────
async function loadConversations(){
  const el=document.getElementById('conversations-body');
  const q=document.getElementById('conv-search')?.value.trim()||'';
  el.innerHTML='<div class="loading">Loading conversations...</div>';
  try {
    let url='/admin/api/conversations?limit=40&key='+encodeURIComponent(ADMIN_KEY);
    if(q){if(/^[0-9]{9,15}$/.test(q))url+='&phone='+encodeURIComponent(q);else if(/^BDR-/i.test(q))url+='&booking_ref='+encodeURIComponent(q);else url+='&session_id='+encodeURIComponent(q);}
    const r=await fetch(url);const j=await r.json();if(!j.success)throw new Error(j.error);
    renderConversations(j.conversations);
  }catch(e){el.innerHTML='<div class="err">'+e.message+'</div>';}
}

function togglePkgDetail(id){const el=document.getElementById(id);if(!el)return;el.classList.toggle('open');const toggle=document.getElementById(id+'-toggle');if(toggle)toggle.textContent=el.classList.contains('open')?'Hide packages ▲':'View packages ▼';}

function renderPackageDetail(pkg){
  const parts=[];
  if(pkg.airline)parts.push('<div class="pkg-detail-row"><span class="k">Transport</span><span class="v">'+pkg.airline+(pkg.destination?' → '+pkg.destination:'')+'</span></div>');
  if(pkg.hotelName)parts.push('<div class="pkg-detail-row"><span class="k">Hotel</span><span class="v">'+pkg.hotelName+'</span></div>');
  if(pkg.nights)parts.push('<div class="pkg-detail-row"><span class="k">Nights</span><span class="v">'+pkg.nights+'</span></div>');
  const price=pkg.totalPrice?(pkg.currency||'KES')+' '+Math.round(pkg.totalPrice).toLocaleString('en-KE'):null;
  return '<div class="pkg-detail-card">'+(pkg.route?'<div style="font-weight:600;margin-bottom:4px">'+pkg.route+'</div>':'')+parts.join('')+(price?'<div class="pkg-detail-price">'+price+(pkg.passengers?' · '+pkg.passengers+' traveller(s)':'')+'</div>':'')+'</div>';
}

function renderConversations(convs){
  const el=document.getElementById('conversations-body');
  if(!convs||!convs.length){el.innerHTML='<div class="card"><div class="empty">No conversations found.</div></div>';return;}
  const sessions={};for(const c of convs){if(!sessions[c.session_id])sessions[c.session_id]=[];sessions[c.session_id].push(c);}
  let ctr=0;
  el.innerHTML=Object.entries(sessions).map(([sid,turns])=>{
    const first=turns[turns.length-1];const converted=turns.some(t=>t.converted);const bookingRef=turns.find(t=>t.booking_ref)?.booking_ref;
    return '<div class="card" style="margin-bottom:12px"><div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px"><div><div style="font-size:13px;font-weight:600;margin-bottom:3px">'+(first.phone||'Widget session')+' · '+pill(first.channel)+'</div><div class="mono" style="font-size:10px;color:var(--muted)">'+sid+'</div></div><div style="text-align:right">'+(converted?pill('confirmed'):'')+'<div class="mono" style="font-size:11px;color:var(--muted);margin-top:4px">'+ago(first.created_at)+'</div></div></div>'+
    (bookingRef?'<div style="font-size:12px;margin-bottom:10px;padding:6px 10px;background:#f8f9fb;border-radius:6px;font-family:var(--mono)">Booking ref: <strong>'+bookingRef+'</strong></div>':'')+
    [...turns].reverse().map(t=>{
      let pkgSection='';
      if(t.packages_count>0){if(Array.isArray(t.packages_shown)&&t.packages_shown.length>0){ctr++;const did='pkg-detail-'+ctr;pkgSection='<span class="pkg-detail-toggle" id="'+did+'-toggle" onclick="togglePkgDetail(\''+did+'\')">View packages ▼</span><div class="pkg-detail-list" id="'+did+'">'+t.packages_shown.map(renderPackageDetail).join('')+'</div>';}else{pkgSection='<div style="font-size:11px;color:var(--muted);font-style:italic;margin-top:4px">'+t.packages_count+' packages shown</div>';}}
      return '<div style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #f1f5f9"><div style="background:#f1f5f9;border-radius:8px;padding:8px 12px;margin-bottom:6px;font-size:12px"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">'+ago(t.created_at)+' · '+(t.destination||'no destination')+'</div>'+t.user_message+'</div>'+(t.engine_response?'<div style="font-size:12px;color:var(--muted);padding:0 4px">'+t.engine_response.slice(0,200)+(t.engine_response.length>200?'...':'')+'</div>':'')+pkgSection+'</div>';
    }).join('')+'</div>';
  }).join('');
}

// ── Alerts ────────────────────────────────────────────────────
async function loadAlerts(){
  const el=document.getElementById('alerts-body');
  const showResolved=document.getElementById('show-resolved')?.checked||false;
  el.innerHTML='<div class="loading">Loading alerts...</div>';
  try{
    const r=await fetch('/admin/api/alerts?resolved='+(showResolved?'true':'false')+'&limit=50&key='+encodeURIComponent(ADMIN_KEY));
    const j=await r.json();if(!j.success)throw new Error(j.error);renderAlerts(j.alerts);updateAlertBadge(j.alerts);
  }catch(e){el.innerHTML='<div class="err">'+e.message+'</div>';}
}
function updateAlertBadge(alerts){const unresolved=(alerts||[]).filter(a=>!a.resolved).length;const badge=document.getElementById('alert-badge');if(!badge)return;if(unresolved>0){badge.textContent=unresolved;badge.style.display='inline';}else badge.style.display='none';}
async function checkAlertBadge(){try{const r=await fetch('/admin/api/alerts?resolved=false&limit=50&key='+encodeURIComponent(ADMIN_KEY));const j=await r.json();if(j.success)updateAlertBadge(j.alerts);}catch(e){}}
function renderAlerts(alerts){
  const el=document.getElementById('alerts-body');
  if(!alerts||!alerts.length){el.innerHTML='<div class="card"><div class="empty">No unresolved alerts.</div></div>';return;}
  const sc={info:'#2563eb',warning:'#d97706',error:'#dc2626',critical:'#7f1d1d'};const sb={info:'#dbeafe',warning:'#fef9c3',error:'#fee2e2',critical:'#fee2e2'};
  el.innerHTML=alerts.map(a=>'<div class="card" style="margin-bottom:10px;border-left:3px solid '+(sc[a.severity]||'#94a3b8')+'"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div style="flex:1"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:'+(sb[a.severity])+';color:'+(sc[a.severity])+'">'+a.severity.toUpperCase()+'</span><span style="font-size:10px;color:var(--muted);font-family:var(--mono)">'+a.type+'</span><span style="font-size:11px;color:var(--muted)">'+ago(a.created_at)+'</span></div><div style="font-size:13px;font-weight:500;margin-bottom:4px">'+a.title+'</div>'+(a.detail?'<div style="font-size:12px;color:var(--muted);margin-bottom:6px">'+a.detail.slice(0,300)+'</div>':'')+'<div style="display:flex;gap:10px;font-size:11px;color:var(--muted)">'+(a.booking_ref?'<span class="mono">'+a.booking_ref+'</span>':'')+(a.phone?'<span>'+a.phone+'</span>':'')+(a.agency_id?'<span>'+a.agency_id+'</span>':'')+'</div></div>'+(!a.resolved?'<button onclick="resolveAlert(\''+a.id+'\',this)" style="padding:6px 12px;font-size:11px;border:1px solid var(--border);border-radius:6px;background:var(--card);cursor:pointer;flex-shrink:0">Resolve</button>':'<span style="font-size:11px;color:var(--muted)">Resolved</span>')+'</div></div>').join('');
}
async function resolveAlert(id,btn){btn.disabled=true;btn.textContent='Resolving...';try{const r=await fetch('/admin/api/alerts/'+id+'/resolve?key='+encodeURIComponent(ADMIN_KEY),{method:'POST'});const j=await r.json();if(j.success)loadAlerts();else{btn.disabled=false;btn.textContent='Resolve';alert('Failed: '+j.error);}}catch(e){btn.disabled=false;btn.textContent='Resolve';}}

// ── Insights ──────────────────────────────────────────────────
async function loadInsights(){
  const el=document.getElementById('insights-body');el.innerHTML='<div class="loading">Loading insights...</div>';
  try{const r=await fetch('/admin/api/insights?key='+encodeURIComponent(ADMIN_KEY));const j=await r.json();if(!j.success)throw new Error(j.error);renderInsights(j.insights);}catch(e){el.innerHTML='<div class="err">'+e.message+'</div>';}
}
async function refreshInsights(){const btn=document.getElementById('insights-refresh-btn');btn.disabled=true;btn.textContent='Refreshing...';try{const r=await fetch('/admin/api/insights/refresh?key='+encodeURIComponent(ADMIN_KEY),{method:'POST'});const j=await r.json();if(!j.success)throw new Error(j.error);await loadInsights();}catch(e){alert('Refresh failed: '+e.message);}finally{btn.disabled=false;btn.textContent='Refresh now';}}
const INSIGHT_LABELS={dead_end_destination:'Dead-end destination',parser_struggle:'Parser struggle',conversion_gap:'Conversion gap',channel_friction:'Channel friction',repeat_no_booking:'Repeat, no booking',supplier_drift:'Supplier drift'};
function renderInsights(insights){
  const el=document.getElementById('insights-body');
  if(!insights||!insights.length){el.innerHTML='<div class="card"><div class="empty">No patterns detected yet — insights need real search/booking volume.</div></div>';return;}
  const sc={info:'#2563eb',notable:'#d97706',high:'#dc2626'};const sb={info:'#dbeafe',notable:'#fef9c3',high:'#fee2e2'};
  const byType={};for(const i of insights){if(!byType[i.type])byType[i.type]=[];byType[i.type].push(i);}
  el.innerHTML=Object.entries(byType).map(([type,items])=>'<div style="margin-bottom:20px"><div class="section-title" style="margin-top:0">'+(INSIGHT_LABELS[type]||type)+'</div>'+items.map(i=>'<div class="card" style="margin-bottom:10px;border-left:3px solid '+(sc[i.severity]||'#94a3b8')+'"><div style="display:flex;align-items:center;gap:8px;margin-bottom:4px"><span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:'+(sb[i.severity]||'#f1f5f9')+';color:'+(sc[i.severity]||'#64748b')+'">'+(i.severity||'info').toUpperCase()+'</span>'+(i.agency_id?'<span style="font-size:11px;color:var(--muted)">'+i.agency_id+'</span>':'<span style="font-size:11px;color:var(--muted)">platform-wide</span>')+'</div><div style="font-size:13px;font-weight:500;margin-bottom:4px">'+i.title+'</div>'+(i.detail?'<div style="font-size:12px;color:var(--muted)">'+i.detail+'</div>':'')+'</div>').join('')+'</div>').join('');
}

// ── Providers ─────────────────────────────────────────────────
async function loadProviders(){
  const el=document.getElementById('providers-body');el.innerHTML='<div class="loading">Loading...</div>';
  try{const r=await fetch('/admin/api/providers?key='+encodeURIComponent(ADMIN_KEY));const j=await r.json();if(!j.success)throw new Error(j.error);renderProviders(j.providers,j.totalWithPreference);}catch(e){el.innerHTML='<div class="err">'+e.message+'</div>';}
}
function renderProviders(providers,total){
  const el=document.getElementById('providers-body');
  const modes=[{key:'flight',label:'Airlines',color:'#2563eb',icon:'✈'},{key:'bus',label:'Bus companies',color:'#16a34a',icon:'🚌'},{key:'train',label:'Train operators',color:'#d97706',icon:'🚆'}];
  const hasAny=modes.some(m=>(providers[m.key]||[]).length>0);
  if(!hasAny){el.innerHTML='<div class="card"><div class="empty">No named provider preferences recorded yet.</div></div>';return;}
  el.innerHTML='<div style="font-size:12px;color:var(--muted);margin-bottom:12px">'+total+' searches with a named provider preference in the last 30 days</div>'+modes.map(m=>{const list=providers[m.key]||[];if(!list.length)return'';const maxReq=list[0].requested||1;return'<div class="card" style="margin-bottom:14px"><div class="section-title" style="margin-top:0;color:'+m.color+'">'+m.icon+' '+m.label+'</div>'+list.map(p=>{const reqPct=Math.round((p.requested/maxReq)*100);const fulPct=Math.round((p.fulfilled/maxReq)*100);const fulRate=p.requested>0?Math.round((p.fulfilled/p.requested)*100):0;return'<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px"><span style="font-weight:500">'+p.name+'</span><span style="color:var(--muted)">'+p.fulfilled+'/'+p.requested+' fulfilled ('+fulRate+'%)</span></div><div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;position:relative;margin-bottom:2px"><div style="height:100%;width:'+reqPct+'%;background:'+m.color+'33;border-radius:3px;position:absolute"></div><div style="height:100%;width:'+fulPct+'%;background:'+m.color+';border-radius:3px;position:absolute"></div></div></div>';}).join('')+'</div>';}).join('');
}

// ── Polling ───────────────────────────────────────────────────
setInterval(loadData, 60000);
setInterval(checkAlertBadge, 30000);
setInterval(async () => {
  try { const r=await fetch('/admin/api/trips?key='+encodeURIComponent(ADMIN_KEY)); const j=await r.json(); if(j.success) updateTripsBadge(j.summary); } catch(e) {}
}, 60000);

loadData();
</script>
</body>
</html>`);
});

module.exports = router;