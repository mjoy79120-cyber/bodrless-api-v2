/**
 * HOTEL REVENUE DASHBOARD
 * ─────────────────────────────────────────────────────────────
 * Revenue manager view — mounted at /hotel-admin/revenue
 * Plug into your existing hotelAdmin.js router:
 *
 *   const revenueRouter = require('./hotelRevenueAdmin');
 *   router.use('/revenue', revenueRouter);
 *
 * (revenueRouter inherits requireHotelAuth via the parent mount,
 *  but we re-run auth here so this file is self-contained.)
 *
 * SECTIONS:
 *   GET  /hotel-admin/revenue                  — main dashboard
 *   GET  /hotel-admin/revenue/rates            — rate management + Opera push
 *   POST /hotel-admin/revenue/rates/update     — update rate + push to Opera
 *   GET  /hotel-admin/revenue/guests           — guest / client intelligence
 *   GET  /hotel-admin/revenue/competitors      — competitor rate tracker
 *   POST /hotel-admin/revenue/competitors/add  — add competitor rate entry
 *
 * PMS RATE PUSH:
 *   pushRateToOpera() routes to Opera Cloud or Opera 5 based on
 *   hotel_properties.pms_type. Falls back silently to Supabase-only
 *   update if the PMS call fails (logs the error).
 *
 * METRICS:
 *   Occupancy %     = booked room-nights / total room-nights in period
 *   ADR             = total room revenue / rooms sold
 *   RevPAR          = ADR × occupancy %
 *   Conversion rate = confirmed bookings / total enquiries (widget sessions)
 * ─────────────────────────────────────────────────────────────
 */

const express  = require('express');
const router   = express.Router();
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const pmsIntegrations = require('../integrations/pmsIntegrations');

// ─────────────────────────────
// RE-USE AUTH FROM PARENT
// Parent mounts requireHotelAuth before this router,
// but we grab the group from the cookie ourselves so
// this file works standalone too.
// ─────────────────────────────
async function requireHotelAuth(req, res, next) {
  const token = req.cookies?.hotel_token;
  if (!token) return res.redirect('/hotel-admin/login');
  const { data: group } = await supabase
    .from('hotel_groups').select('*')
    .eq('admin_token', token).eq('is_active', true).single();
  if (!group) { res.clearCookie('hotel_token'); return res.redirect('/hotel-admin/login?error=invalid'); }
  req.hotelGroup = group;
  next();
}

// ─────────────────────────────
// SHARED SHELL (mirrors hotelAdmin.js shell)
// ─────────────────────────────
function shell(title, body, group) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Revenue · Bodrless Hotels</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --navy:#1E2A5E; --red:#C0392B; --white:#fff; --cream:#F8F9FC;
      --border:#E4E8F0; --muted:#8892A4; --green:#27ae60; --amber:#f0ad4e;
      --teal:#0f7b8c; --radius:10px;
    }
    body { font-family: Arial, sans-serif; background: var(--cream); color: var(--navy); min-height:100vh; }
    .nav { background:var(--navy); padding:0 24px; display:flex; align-items:center; justify-content:space-between; height:56px; border-bottom:3px solid var(--red); }
    .nav-brand { display:flex; align-items:center; gap:10px; color:white; font-weight:700; font-size:15px; }
    .nav-links { display:flex; align-items:center; gap:18px; }
    .nav-links a { color:rgba(255,255,255,0.8); text-decoration:none; font-size:13px; }
    .nav-links a:hover, .nav-links a.active { color:white; border-bottom:2px solid var(--amber); padding-bottom:2px; }
    .nav-logout { background:var(--red)!important; color:white!important; padding:6px 14px; border-radius:20px; font-size:12px!important; border-bottom:none!important; }
    .page { max-width:1200px; margin:0 auto; padding:28px 20px; }
    .page-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:10px; }
    .page-title { font-size:22px; font-weight:700; }
    .sub-nav { display:flex; gap:8px; margin-bottom:24px; flex-wrap:wrap; }
    .sub-nav a { padding:7px 16px; border-radius:20px; font-size:12px; font-weight:700; text-decoration:none; border:1.5px solid var(--border); color:var(--navy); background:white; }
    .sub-nav a.active, .sub-nav a:hover { background:var(--navy); color:white; border-color:var(--navy); }
    .period-tabs { display:flex; gap:6px; flex-wrap:wrap; }
    .period-tabs a { padding:5px 14px; border-radius:20px; font-size:11px; font-weight:700; text-decoration:none; border:1.5px solid var(--border); color:var(--muted); }
    .period-tabs a.active { background:var(--navy); color:white; border-color:var(--navy); }
    .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px,1fr)); gap:14px; margin-bottom:24px; }
    .stat { background:white; border:1px solid var(--border); border-radius:var(--radius); padding:18px; border-top:3px solid var(--navy); position:relative; }
    .stat-value { font-size:26px; font-weight:700; color:var(--navy); }
    .stat-label { font-size:11px; color:var(--muted); margin-top:4px; text-transform:uppercase; letter-spacing:0.5px; }
    .stat-delta { font-size:11px; margin-top:6px; font-weight:700; }
    .delta-up   { color:var(--green); }
    .delta-down { color:var(--red); }
    .stat.green { border-top-color:var(--green); }
    .stat.amber { border-top-color:var(--amber); }
    .stat.teal  { border-top-color:var(--teal); }
    .stat.red   { border-top-color:var(--red); }
    .card { background:white; border:1px solid var(--border); border-radius:var(--radius); padding:20px; margin-bottom:16px; }
    .card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
    .card-title { font-size:13px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--navy); }
    .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .grid-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th { text-align:left; padding:10px 12px; font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; border-bottom:2px solid var(--border); white-space:nowrap; }
    td { padding:11px 12px; border-bottom:1px solid var(--border); vertical-align:middle; }
    tr:last-child td { border-bottom:none; }
    tr:hover td { background:var(--cream); }
    .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700; }
    .badge-green  { background:#E8F8EE; color:#1B7A3D; }
    .badge-amber  { background:#FFF3E0; color:#B05A00; }
    .badge-red    { background:#FDECEA; color:var(--red); }
    .badge-navy   { background:#EEF1F8; color:var(--navy); }
    .badge-teal   { background:#E0F4F7; color:var(--teal); }
    .btn { display:inline-block; padding:8px 16px; border-radius:20px; border:none; cursor:pointer; font-size:12px; font-weight:700; text-decoration:none; }
    .btn-primary { background:var(--navy); color:white; }
    .btn-green   { background:var(--green); color:white; }
    .btn-red     { background:var(--red); color:white; }
    .btn-amber   { background:var(--amber); color:white; }
    .btn-outline { background:white; color:var(--navy); border:1.5px solid var(--border); }
    .btn-sm      { padding:5px 12px; font-size:11px; }
    .btn:hover   { opacity:0.88; }
    form.inline  { display:inline; }
    input, select, textarea { padding:9px 12px; border:1.5px solid var(--border); border-radius:8px; font-size:13px; color:var(--navy); background:var(--cream); outline:none; }
    input:focus, select:focus { border-color:var(--navy); }
    .form-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .form-group { display:flex; flex-direction:column; gap:5px; }
    label { font-size:11px; font-weight:700; color:var(--navy); text-transform:uppercase; letter-spacing:0.4px; }
    .alert-success { background:#E8F8EE; color:#1B7A3D; border:1px solid #B2DFCA; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:14px; }
    .alert-error   { background:#FDECEA; color:var(--red); border:1px solid #F5C6C2; padding:10px 14px; border-radius:8px; font-size:13px; margin-bottom:14px; }
    .empty { text-align:center; padding:40px; color:var(--muted); font-size:13px; }
    .breadcrumb { font-size:12px; color:var(--muted); margin-bottom:14px; }
    .breadcrumb a { color:var(--navy); text-decoration:none; }
    .heatmap-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:3px; }
    .heatmap-cell { height:32px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; cursor:default; }
    .occ-0  { background:#F0F4FF; color:#8892A4; }
    .occ-25 { background:#C7D2F0; color:#1E2A5E; }
    .occ-50 { background:#7B93D6; color:white; }
    .occ-75 { background:#3B5BBF; color:white; }
    .occ-100{ background:#1E2A5E; color:white; }
    .progress-bar { background:var(--border); border-radius:8px; height:8px; overflow:hidden; }
    .progress-fill { height:100%; border-radius:8px; background:var(--navy); }
    .progress-fill.green { background:var(--green); }
    .progress-fill.amber { background:var(--amber); }
    .progress-fill.red   { background:var(--red); }
    .rate-input { width:100px; text-align:right; font-weight:700; }
    .pms-tag { font-size:10px; padding:2px 7px; border-radius:10px; font-weight:700; background:#E0F4F7; color:var(--teal); }
    .section-actions { display:flex; gap:8px; flex-wrap:wrap; }
    .modal-overlay { display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index:1000; align-items:center; justify-content:center; }
    .modal-overlay.open { display:flex; }
    .modal { background:white; border-radius:var(--radius); padding:24px; width:90%; max-width:540px; max-height:90vh; overflow-y:auto; }
    .modal-title { font-size:16px; font-weight:700; margin-bottom:16px; }
    .modal-actions { display:flex; gap:8px; margin-top:16px; justify-content:flex-end; }
    @media(max-width:700px) { .grid-2,.grid-3 { grid-template-columns:1fr; } .form-row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<nav class="nav">
  <div class="nav-brand"><span>📊</span><span>${group?.name || 'Revenue'}</span></div>
  <div class="nav-links">
    <a href="/hotel-admin/dashboard">Operations</a>
    <a href="/hotel-admin/revenue" class="active">Revenue</a>
    <a href="/hotel-admin/properties">Properties</a>
    <a href="/hotel-admin/reservations">Reservations</a>
    <a href="/hotel-admin/logout" class="nav-logout">Logout</a>
  </div>
</nav>
<div class="page">
${body}
</div>
<script>
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
</script>
</body>
</html>`;
}

// ─────────────────────────────
// HELPERS
// ─────────────────────────────
function periodDates(period) {
  const now  = new Date();
  const y    = now.getFullYear();
  const m    = now.getMonth();
  switch (period) {
    case 'week': {
      const start = new Date(now); start.setDate(now.getDate() - now.getDay());
      const end   = new Date(start); end.setDate(start.getDate() + 6);
      return { start: fmt(start), end: fmt(end), label: 'This Week' };
    }
    case 'month':
      return { start: fmt(new Date(y, m, 1)), end: fmt(new Date(y, m+1, 0)), label: 'This Month' };
    case 'quarter': {
      const qStart = new Date(y, Math.floor(m / 3) * 3, 1);
      const qEnd   = new Date(y, Math.floor(m / 3) * 3 + 3, 0);
      return { start: fmt(qStart), end: fmt(qEnd), label: 'This Quarter' };
    }
    case '6m':
      return { start: fmt(new Date(y, m - 5, 1)), end: fmt(new Date(y, m+1, 0)), label: 'Last 6 Months' };
    case 'yoy':
      return { start: fmt(new Date(y - 1, 0, 1)), end: fmt(new Date(y, 11, 31)), label: 'Year over Year' };
    default: // month
      return { start: fmt(new Date(y, m, 1)), end: fmt(new Date(y, m+1, 0)), label: 'This Month' };
  }
}

function fmt(d) { return d.toISOString().split('T')[0]; }
function fmtNum(n) { return Math.round(n).toLocaleString(); }
function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }
function delta(cur, prev) {
  if (!prev) return '';
  const pct = ((cur - prev) / prev * 100).toFixed(1);
  const cls = cur >= prev ? 'delta-up' : 'delta-down';
  const arrow = cur >= prev ? '▲' : '▼';
  return `<div class="stat-delta ${cls}">${arrow} ${Math.abs(pct)}% vs prev period</div>`;
}

function occClass(pct) {
  if (pct >= 0.9) return 'occ-100';
  if (pct >= 0.6) return 'occ-75';
  if (pct >= 0.35) return 'occ-50';
  if (pct > 0) return 'occ-25';
  return 'occ-0';
}

// Push rate update to Opera Cloud or Opera 5
async function pushRateToOpera(property, rateData) {
  if (!property) return { success: false, reason: 'no_property' };
  try {
    if (property.pms_type === 'opera_cloud') {
      await pmsIntegrations.updateRateOperaCloud(property, rateData);
      return { success: true, pms: 'opera_cloud' };
    }
    if (property.pms_type === 'opera_5') {
      await pmsIntegrations.updateRateOpera5(property, rateData);
      return { success: true, pms: 'opera_5' };
    }
    return { success: false, reason: 'supabase_only' };
  } catch (err) {
    logger.error('[REVENUE] PMS rate push failed', { propertyId: property?.id, error: err.message });
    return { success: false, reason: err.message };
  }
}

// ─────────────────────────────
// MAIN DASHBOARD
// GET /hotel-admin/revenue
// ─────────────────────────────
router.get('/', requireHotelAuth, async (req, res) => {
  const group    = req.hotelGroup;
  const period   = req.query.period || 'month';
  const { start, end, label } = periodDates(period);

  // Fetch all properties for this group
  const { data: properties } = await supabase
    .from('hotel_properties').select('id, name, destination, currency')
    .eq('group_id', group.id).eq('is_active', true).order('sort_order');

  const propIds = (properties || []).map(p => p.id);
  const currency = (properties || [])[0]?.currency || 'KES';

  // Reservations in period
  const { data: reservations } = await supabase
    .from('hotel_reservations')
    .select('gross_amount, room_total, nights, adults, children, status, payment_status, check_in, check_out, created_at, channel, property_id, hotel_properties(name)')
    .eq('group_id', group.id)
    .gte('check_in', start)
    .lte('check_in', end)
    .neq('status', 'cancelled');

  // Widget sessions for conversion rate — table may not exist yet, guard it
  let sessions = [];
  try {
    const { data: sessData } = await supabase
      .from('widget_sessions')
      .select('id, converted, group_slug')
      .eq('group_slug', group.slug)
      .gte('created_at', start + 'T00:00:00')
      .lte('created_at', end + 'T23:59:59');
    sessions = sessData || [];
  } catch (_) { sessions = []; }

  // Room types to compute total capacity — skip if no properties
  let roomTypes = [];
  if (propIds.length) {
    const { data: rtData } = await supabase
      .from('room_types').select('id, property_id, max_adults, total_rooms')
      .in('property_id', propIds).eq('is_active', true);
    roomTypes = rtData || [];
  }

  // Competitor rates (most recent)
  const { data: compRates } = await supabase
    .from('competitor_rates').select('*')
    .eq('group_slug', group.slug).eq('is_current', true)
    .order('check_in').limit(10);

  // Previous period for deltas
  const periodDays = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  const prevEnd    = fmt(new Date(new Date(start).getTime() - 86400000));
  const prevStart  = fmt(new Date(new Date(prevEnd).getTime() - (periodDays - 1) * 86400000));

  const { data: prevReservations } = await supabase
    .from('hotel_reservations')
    .select('gross_amount, room_total, nights')
    .eq('group_id', group.id)
    .gte('check_in', prevStart)
    .lte('check_in', prevEnd)
    .neq('status', 'cancelled');

  // ── Metrics ────────────────────────────────────────────────
  const res_   = reservations || [];
  const prev_  = prevReservations || [];
  const sess_  = sessions || [];

  const totalRevenue  = res_.reduce((s, r) => s + Number(r.gross_amount), 0);
  const prevRevenue   = prev_.reduce((s, r) => s + Number(r.gross_amount), 0);
  const roomRevenue   = res_.reduce((s, r) => s + Number(r.room_total || r.gross_amount), 0);
  const roomsSold     = res_.reduce((s, r) => s + (r.nights || 1), 0); // room-nights
  const ADR           = roomsSold > 0 ? roomRevenue / roomsSold : 0;

  // prevADR is null when there's no prior data — avoids misleading deltas
  const prevRoomNights = prev_.reduce((s, r) => s + (r.nights || 1), 0);
  const prevADR        = prev_.length > 0 && prevRoomNights > 0
    ? prev_.reduce((s, r) => s + Number(r.room_total || r.gross_amount), 0) / prevRoomNights
    : null;

  // Use total_rooms column if present, fall back to 1 per room type
  const totalRoomNights = roomTypes.reduce((s, r) => s + (r.total_rooms || 1), 0) * periodDays;
  const occupancy     = totalRoomNights > 0 ? roomsSold / totalRoomNights : 0;
  const RevPAR        = ADR * occupancy;
  const prevOccupancy = totalRoomNights > 0 ? prevRoomNights / totalRoomNights : null;
  const prevRevPAR    = prevADR !== null && prevOccupancy !== null ? prevADR * prevOccupancy : null;

  const totalSessions = sess_.length;
  const converted     = sess_.filter(s => s.converted).length;
  const convRate      = totalSessions > 0 ? converted / totalSessions : 0;

  // ── Revenue by property ────────────────────────────────────
  const byProperty = {};
  for (const r of res_) {
    const name = r.hotel_properties?.name || r.property_id;
    if (!byProperty[name]) byProperty[name] = { revenue: 0, bookings: 0, roomNights: 0 };
    byProperty[name].revenue    += Number(r.gross_amount);
    byProperty[name].bookings   += 1;
    byProperty[name].roomNights += (r.nights || 1);
  }

  // ── Revenue by channel ─────────────────────────────────────
  const byChannel = {};
  for (const r of res_) {
    const ch = r.channel || 'direct';
    if (!byChannel[ch]) byChannel[ch] = { revenue: 0, bookings: 0 };
    byChannel[ch].revenue  += Number(r.gross_amount);
    byChannel[ch].bookings += 1;
  }

  // ── 90-day occupancy heatmap data ─────────────────────────
  // Group bookings by check_in date for the forward 90 days
  const today     = new Date();
  const heatDays  = 90;
  const occByDate = {};
  const { data: futureRes } = await supabase
    .from('hotel_reservations')
    .select('check_in, check_out, nights')
    .eq('group_id', group.id)
    .gte('check_in', fmt(today))
    .lte('check_in', fmt(new Date(today.getTime() + heatDays * 86400000)))
    .neq('status', 'cancelled');

  // Expand each booking across all its nights so mid-stay dates show as occupied
  for (const r of (futureRes || [])) {
    const nights = r.nights || 1;
    for (let i = 0; i < nights; i++) {
      const d = new Date(r.check_in);
      d.setDate(d.getDate() + i);
      const key = fmt(d);
      occByDate[key] = (occByDate[key] || 0) + 1;
    }
  }

  const totalRooms = (roomTypes || []).length || 1;
  const heatCells  = [];
  for (let i = 0; i < 90; i++) {
    const d   = new Date(today); d.setDate(today.getDate() + i);
    const key = fmt(d);
    const pct = Math.min(1, (occByDate[key] || 0) / totalRooms);
    heatCells.push({ date: key, day: d.getDate(), pct, cls: occClass(pct) });
  }

  // ── Chart data (revenue by week/month in period) ───────────
  const weeklyRevenue = {};
  for (const r of res_) {
    const weekStart = new Date(r.check_in);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    const wk = fmt(weekStart);
    weeklyRevenue[wk] = (weeklyRevenue[wk] || 0) + Number(r.gross_amount);
  }
  const chartLabels = Object.keys(weeklyRevenue).sort();
  const chartData   = chartLabels.map(k => weeklyRevenue[k]);

  // ── Property rows ──────────────────────────────────────────
  const propRows = Object.entries(byProperty).map(([name, d]) => {
    const adr     = d.roomNights > 0 ? d.revenue / d.roomNights : 0;
    const occ     = totalRoomNights > 0 ? d.roomNights / (totalRoomNights / Math.max(1, propIds.length)) : 0;
    const occPct  = Math.min(100, occ * 100);
    return `
    <tr>
      <td><strong>${name}</strong></td>
      <td>${d.bookings}</td>
      <td>${currency} ${fmtNum(adr)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="progress-bar" style="flex:1;min-width:60px;">
            <div class="progress-fill ${occPct > 75 ? 'green' : occPct > 40 ? 'amber' : 'red'}" style="width:${occPct.toFixed(0)}%"></div>
          </div>
          <span style="font-size:12px;font-weight:700;min-width:36px;">${occPct.toFixed(0)}%</span>
        </div>
      </td>
      <td><strong>${currency} ${fmtNum(d.revenue)}</strong></td>
    </tr>`;
  }).join('') || `<tr><td colspan="5" class="empty">No bookings in this period.</td></tr>`;

  // ── Channel rows ───────────────────────────────────────────
  const totalBk = res_.length || 1;
  const channelRows = Object.entries(byChannel).sort((a, b) => b[1].revenue - a[1].revenue).map(([ch, d]) => `
    <tr>
      <td><span class="badge badge-navy">${ch}</span></td>
      <td>${d.bookings}</td>
      <td>${fmtPct(d.bookings / totalBk)}</td>
      <td>${currency} ${fmtNum(d.revenue)}</td>
    </tr>`).join('') || `<tr><td colspan="4" class="empty">No data.</td></tr>`;

  // ── Heatmap HTML ───────────────────────────────────────────
  const dayLabels = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const heatHTML = `
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:6px;">
      ${dayLabels.map(d => `<div style="text-align:center;font-size:10px;color:var(--muted);font-weight:700;">${d}</div>`).join('')}
    </div>
    <div class="heatmap-grid">
      ${heatCells.map(c => `
        <div class="heatmap-cell ${c.cls}" title="${c.date}: ${Math.round(c.pct*100)}% occupied">
          ${c.day}
        </div>`).join('')}
    </div>
    <div style="display:flex;gap:12px;margin-top:8px;font-size:10px;color:var(--muted);flex-wrap:wrap;">
      <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;border-radius:2px;background:#F0F4FF;display:inline-block;"></span> 0%</span>
      <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;border-radius:2px;background:#C7D2F0;display:inline-block;"></span> 1–25%</span>
      <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;border-radius:2px;background:#7B93D6;display:inline-block;"></span> 26–60%</span>
      <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;border-radius:2px;background:#3B5BBF;display:inline-block;"></span> 61–89%</span>
      <span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:12px;border-radius:2px;background:#1E2A5E;display:inline-block;"></span> 90%+</span>
    </div>`;

  // ── Period tabs ────────────────────────────────────────────
  const periodTabs = ['week','month','quarter','6m','yoy'].map(p =>
    `<a href="?period=${p}" class="${period === p ? 'active' : ''}">${
      {week:'Week',month:'Month',quarter:'Quarter','6m':'6 Months',yoy:'YoY'}[p]
    }</a>`
  ).join('');

  res.send(shell('Revenue Dashboard', `
    <div class="page-header">
      <h1 class="page-title">Revenue Dashboard</h1>
      <div class="period-tabs">${periodTabs}</div>
    </div>

    <div class="sub-nav">
      <a href="/hotel-admin/revenue" class="active">Overview</a>
      <a href="/hotel-admin/revenue/rates">Rate Management</a>
      <a href="/hotel-admin/revenue/guests">Guest Intelligence</a>
      <a href="/hotel-admin/revenue/competitors">Competitors</a>
    </div>

    <!-- KPI STATS -->
    <div class="stat-grid">
      <div class="stat">
        <div class="stat-value">${fmtPct(occupancy)}</div>
        <div class="stat-label">Occupancy — ${label}</div>
        ${delta(occupancy, prevOccupancy)}
      </div>
      <div class="stat green">
        <div class="stat-value">${currency} ${fmtNum(ADR)}</div>
        <div class="stat-label">ADR (Average Daily Rate)</div>
        ${delta(ADR, prevADR)}
      </div>
      <div class="stat teal">
        <div class="stat-value">${currency} ${fmtNum(RevPAR)}</div>
        <div class="stat-label">RevPAR</div>
        ${delta(RevPAR, prevRevPAR)}
      </div>
      <div class="stat amber">
        <div class="stat-value">${currency} ${fmtNum(totalRevenue)}</div>
        <div class="stat-label">Total Revenue</div>
        ${delta(totalRevenue, prevRevenue)}
      </div>
      <div class="stat">
        <div class="stat-value">${res_.length}</div>
        <div class="stat-label">Bookings</div>
      </div>
      <div class="stat ${convRate > 0.15 ? 'green' : convRate > 0.07 ? 'amber' : 'red'}">
        <div class="stat-value">${fmtPct(convRate)}</div>
        <div class="stat-label">Conversion Rate</div>
        <div class="stat-delta" style="color:var(--muted);font-weight:400;">${converted} / ${totalSessions} sessions</div>
      </div>
    </div>

    <div class="grid-2">
      <!-- Revenue chart -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Revenue by Week</div>
        </div>
        <canvas id="revenueChart" height="180"></canvas>
        <script>
          (function() {
            const ctx = document.getElementById('revenueChart').getContext('2d');
            new Chart(ctx, {
              type: 'bar',
              data: {
                labels: ${JSON.stringify(chartLabels)},
                datasets: [{
                  label: 'Revenue (${currency})',
                  data: ${JSON.stringify(chartData)},
                  backgroundColor: '#3B5BBF',
                  borderRadius: 6,
                }]
              },
              options: {
                responsive: true, plugins: { legend: { display: false } },
                scales: {
                  y: { ticks: { callback: v => '${currency} ' + v.toLocaleString() }, grid: { color: '#E4E8F0' } },
                  x: { grid: { display: false } }
                }
              }
            });
          })();
        </script>
      </div>

      <!-- 90-day occupancy heatmap -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">90-Day Occupancy Forecast</div>
          <a href="/hotel-admin/revenue/rates" class="btn btn-outline btn-sm">Adjust Rates</a>
        </div>
        ${heatHTML}
      </div>
    </div>

    <div class="grid-2">
      <!-- Property breakdown -->
      <div class="card">
        <div class="card-title">Performance by Property</div>
        <table>
          <thead><tr><th>Property</th><th>Bookings</th><th>ADR</th><th>Occupancy</th><th>Revenue</th></tr></thead>
          <tbody>${propRows}</tbody>
        </table>
      </div>

      <!-- Channel mix -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">Channel Mix</div>
        </div>
        <canvas id="channelChart" height="160" style="margin-bottom:12px;"></canvas>
        <table>
          <thead><tr><th>Channel</th><th>Bookings</th><th>Share</th><th>Revenue</th></tr></thead>
          <tbody>${channelRows}</tbody>
        </table>
        <script>
          (function() {
            const ctx = document.getElementById('channelChart').getContext('2d');
            new Chart(ctx, {
              type: 'doughnut',
              data: {
                labels: ${JSON.stringify(Object.keys(byChannel))},
                datasets: [{
                  data: ${JSON.stringify(Object.values(byChannel).map(d => d.bookings))},
                  backgroundColor: ['#1E2A5E','#3B5BBF','#0f7b8c','#27ae60','#f0ad4e','#C0392B'],
                  borderWidth: 0,
                }]
              },
              options: {
                responsive: true, cutout: '65%',
                plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } }
              }
            });
          })();
        </script>
      </div>
    </div>

    <!-- Competitor snapshot -->
    ${compRates && compRates.length ? `
    <div class="card">
      <div class="card-header">
        <div class="card-title">Competitor Rates (Latest)</div>
        <a href="/hotel-admin/revenue/competitors" class="btn btn-outline btn-sm">Full View</a>
      </div>
      <table>
        <thead><tr><th>OTA</th><th>Check-in</th><th>Rate / night</th><th>vs Your ADR</th><th>Added</th></tr></thead>
        <tbody>
          ${compRates.slice(0, 5).map(r => {
            const gap = ADR - r.ota_rate;
            const gapPct = ADR > 0 ? (gap / ADR * 100).toFixed(0) : 0;
            const gapCls = gap > 0 ? 'delta-up' : 'delta-down';
            return `<tr>
              <td><span class="badge badge-navy">${r.ota_name}</span></td>
              <td>${r.check_in}</td>
              <td>${currency} ${fmtNum(r.ota_rate)}</td>
              <td class="${gapCls}">${gap > 0 ? '▼ You are ' + Math.abs(gapPct) + '% above' : '▲ They are ' + Math.abs(gapPct) + '% above'}</td>
              <td style="color:var(--muted);font-size:11px;">${new Date(r.created_at || Date.now()).toLocaleDateString()}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : ''}

  `, group));
});

// ─────────────────────────────
// RATE MANAGEMENT
// GET /hotel-admin/revenue/rates
// ─────────────────────────────
router.get('/rates', requireHotelAuth, async (req, res) => {
  const group = req.hotelGroup;

  const { data: properties } = await supabase
    .from('hotel_properties').select('id, name, pms_type, currency')
    .eq('group_id', group.id).eq('is_active', true).order('sort_order');

  const propId = req.query.property || (properties || [])[0]?.id;
  const success = req.query.success;
  const error   = req.query.error;

  let rates = [];
  let selectedProp = null;

  if (propId) {
    selectedProp = (properties || []).find(p => p.id === propId);
    const { data: roomTypes } = await supabase
      .from('room_types').select('id, name')
      .eq('property_id', propId).eq('is_active', true);

    const roomIds = (roomTypes || []).map(r => r.id);
    if (roomIds.length) {
      const { data: ratePlans } = await supabase
        .from('rate_plans').select('*, room_types(name)')
        .in('room_type_id', roomIds).eq('is_active', true).order('sort_order');
      rates = ratePlans || [];
    }
  }

  const mealLabels = { room_only: 'RO', bed_and_breakfast: 'BB', half_board: 'HB', full_board: 'FB', all_inclusive: 'AI' };
  const pmsTag = selectedProp?.pms_type
    ? `<span class="pms-tag">${selectedProp.pms_type === 'opera_cloud' ? '☁ Opera Cloud' : selectedProp.pms_type === 'opera_5' ? '🖥 Opera 5' : selectedProp.pms_type}</span>`
    : '<span class="pms-tag">Supabase</span>';

  const propTabs = (properties || []).map(p =>
    `<a href="?property=${p.id}" class="btn ${p.id === propId ? 'btn-primary' : 'btn-outline'} btn-sm">${p.name}</a>`
  ).join('');

  const rateRows = rates.map(r => `
    <tr>
      <td>
        <strong>${r.room_types?.name}</strong><br>
        <span style="font-size:11px;color:var(--muted);">${r.name}</span>
      </td>
      <td><span class="badge badge-navy">${mealLabels[r.meal_plan] || r.meal_plan}</span></td>
      <td style="font-size:11px;color:var(--muted);">${r.season_start ? r.season_start + ' → ' + r.season_end : 'Year-round'}</td>
      <td>
        <form method="POST" action="/hotel-admin/revenue/rates/update" style="display:flex;align-items:center;gap:8px;">
          <input type="hidden" name="rate_plan_id" value="${r.id}">
          <input type="hidden" name="property_id" value="${propId}">
          <input type="hidden" name="currency" value="${r.currency}">
          <span style="font-size:11px;color:var(--muted);">${r.currency}</span>
          <input class="rate-input" type="number" name="price_per_night" value="${r.price_per_night}" min="0" step="1">
          <button class="btn btn-green btn-sm">Update</button>
        </form>
      </td>
      <td>${r.is_refundable ? '<span class="badge badge-green">Refundable</span>' : '<span class="badge badge-red">Non-refund.</span>'}</td>
      <td style="font-size:11px;color:var(--muted);">
        ${r.extra_adult_surcharge > 0 ? '+' + r.currency + ' ' + r.extra_adult_surcharge + '/extra adult' : '—'}
      </td>
    </tr>
  `).join('') || `<tr><td colspan="6" class="empty">No active rate plans for this property.</td></tr>`;

  res.send(shell('Rate Management', `
    <div class="sub-nav">
      <a href="/hotel-admin/revenue">Overview</a>
      <a href="/hotel-admin/revenue/rates" class="active">Rate Management</a>
      <a href="/hotel-admin/revenue/guests">Guest Intelligence</a>
      <a href="/hotel-admin/revenue/competitors">Competitors</a>
    </div>

    <div class="page-header">
      <h1 class="page-title">Rate Management ${pmsTag}</h1>
      <div class="section-actions">${propTabs}</div>
    </div>

    ${success ? `<div class="alert-success">✓ Rate updated${success === 'pms' ? ' and pushed to PMS' : ' in Supabase (no PMS connected)'}.</div>` : ''}
    ${error   ? `<div class="alert-error">⚠ Rate saved locally but PMS push failed: ${decodeURIComponent(error)}.</div>` : ''}

    ${selectedProp?.pms_type ? `
    <div class="card" style="background:#E0F4F7;border-color:var(--teal);margin-bottom:16px;">
      <p style="font-size:12px;color:var(--teal);">
        <strong>${pmsTag}</strong> — Rate updates will be pushed live to your PMS after saving.
        Changes reflect in Opera within ~30 seconds.
      </p>
    </div>` : `
    <div class="card" style="background:#FFF3E0;border-color:var(--amber);margin-bottom:16px;">
      <p style="font-size:12px;color:#B05A00;">
        ⚠ This property is on <strong>Supabase inventory</strong>. No PMS connected.
        Rate changes only affect the Bodrless widget — not Opera.
      </p>
    </div>`}

    <div class="card">
      <div class="card-header">
        <div class="card-title">Active Rate Plans — ${selectedProp?.name || ''}</div>
        <a href="/hotel-admin/properties/${propId}/rooms" class="btn btn-outline btn-sm">Manage Rooms</a>
      </div>
      <table>
        <thead><tr><th>Room / Plan</th><th>Board</th><th>Season</th><th>Rate / Night</th><th>Policy</th><th>Surcharges</th></tr></thead>
        <tbody>${rateRows}</tbody>
      </table>
    </div>

    <!-- Bulk % adjustment -->
    <div class="card">
      <div class="card-title">Bulk Rate Adjustment</div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:14px;">
        Apply a percentage increase or decrease to all rates for this property at once.
        Changes push to PMS if connected.
      </p>
      <form method="POST" action="/hotel-admin/revenue/rates/bulk-adjust" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
        <input type="hidden" name="property_id" value="${propId}">
        <div class="form-group">
          <label>Adjustment %</label>
          <input type="number" name="pct" placeholder="e.g. 10 or -5" style="width:120px;">
        </div>
        <div class="form-group">
          <label>Apply To</label>
          <select name="meal_plan">
            <option value="">All meal plans</option>
            <option value="room_only">Room Only</option>
            <option value="bed_and_breakfast">Bed & Breakfast</option>
            <option value="half_board">Half Board</option>
            <option value="full_board">Full Board</option>
            <option value="all_inclusive">All Inclusive</option>
          </select>
        </div>
        <button type="submit" class="btn btn-amber" onclick="return confirm('Apply bulk rate change?')">Apply Adjustment</button>
      </form>
    </div>
  `, group));
});

// POST — single rate update
router.post('/rates/update', requireHotelAuth, async (req, res) => {
  const { rate_plan_id, property_id, price_per_night, currency } = req.body;
  const newRate = parseFloat(price_per_night);

  if (!rate_plan_id || isNaN(newRate)) return res.redirect('/hotel-admin/revenue/rates?error=invalid');

  // Update Supabase
  const { error: updateErr } = await supabase.from('rate_plans').update({ price_per_night: newRate }).eq('id', rate_plan_id);
  if (updateErr) {
    logger.error('[REVENUE] rate plan update failed', { error: updateErr.message });
    return res.redirect(`/hotel-admin/revenue/rates?property=${property_id}&error=` + encodeURIComponent(updateErr.message));
  }

  // Push to PMS if connected
  const { data: property } = await supabase.from('hotel_properties').select('*').eq('id', property_id).single();
  const pushResult = await pushRateToOpera(property, {
    ratePlanId:    rate_plan_id,
    pricePerNight: newRate,
    currency:      currency || property?.currency || 'KES',
  });

  const redirectBase = `/hotel-admin/revenue/rates?property=${property_id}`;
  if (pushResult.success) return res.redirect(redirectBase + '&success=pms');
  if (pushResult.reason === 'supabase_only') return res.redirect(redirectBase + '&success=local');
  return res.redirect(redirectBase + '&error=' + encodeURIComponent(pushResult.reason));
});

// POST — bulk % adjustment
router.post('/rates/bulk-adjust', requireHotelAuth, async (req, res) => {
  const { property_id, pct, meal_plan } = req.body;
  const multiplier = 1 + (parseFloat(pct) / 100);
  if (isNaN(multiplier)) return res.redirect(`/hotel-admin/revenue/rates?property=${property_id}&error=invalid`);

  const { data: roomTypes } = await supabase
    .from('room_types').select('id').eq('property_id', property_id).eq('is_active', true);
  const roomIds = (roomTypes || []).map(r => r.id);
  if (!roomIds.length) return res.redirect(`/hotel-admin/revenue/rates?property=${property_id}`);

  let query = supabase.from('rate_plans').select('id, price_per_night').in('room_type_id', roomIds).eq('is_active', true);
  if (meal_plan) query = query.eq('meal_plan', meal_plan);
  const { data: plans } = await query;

  for (const plan of (plans || [])) {
    const newPrice = Math.round(plan.price_per_night * multiplier);
    await supabase.from('rate_plans').update({ price_per_night: newPrice }).eq('id', plan.id);
  }

  const { data: property } = await supabase.from('hotel_properties').select('*').eq('id', property_id).single();
  if (property?.pms_type) {
    logger.info('[REVENUE] Bulk adjust — PMS push skipped (individual plan push required)', { property_id });
  }

  res.redirect(`/hotel-admin/revenue/rates?property=${property_id}&success=local`);
});

// ─────────────────────────────
// GUEST INTELLIGENCE
// GET /hotel-admin/revenue/guests
// ─────────────────────────────
router.get('/guests', requireHotelAuth, async (req, res) => {
  const group  = req.hotelGroup;
  const period = req.query.period || 'month';
  const { start, end, label } = periodDates(period);

  const { data: reservations } = await supabase
    .from('hotel_reservations')
    .select('guest_name, guest_phone, guest_email, gross_amount, nights, adults, children, channel, check_in, special_requests, meal_plan, created_at, hotel_properties(name)')
    .eq('group_id', group.id)
    .gte('check_in', start)
    .lte('check_in', end)
    .neq('status', 'cancelled')
    .order('gross_amount', { ascending: false });

  const res_ = reservations || [];
  const currency = group.currency || 'KES';

  // Repeat guests (same phone in multiple bookings)
  const phoneCount = {};
  for (const r of res_) { if (r.guest_phone) phoneCount[r.guest_phone] = (phoneCount[r.guest_phone] || 0) + 1; }
  const repeatGuests = Object.values(phoneCount).filter(c => c > 1).length;
  const avgStay   = res_.length ? (res_.reduce((s, r) => s + (r.nights || 1), 0) / res_.length).toFixed(1) : 0;
  const avgSpend  = res_.length ? res_.reduce((s, r) => s + Number(r.gross_amount), 0) / res_.length : 0;
  const avgParty  = res_.length ? (res_.reduce((s, r) => s + (r.adults || 1) + (r.children || 0), 0) / res_.length).toFixed(1) : 0;

  // Top channels by revenue
  const byChannel = {};
  for (const r of res_) {
    const ch = r.channel || 'direct';
    if (!byChannel[ch]) byChannel[ch] = 0;
    byChannel[ch] += Number(r.gross_amount);
  }

  const periodTabs = ['week','month','quarter','6m','yoy'].map(p =>
    `<a href="?period=${p}" class="${period === p ? 'active' : ''}">${{week:'Week',month:'Month',quarter:'Quarter','6m':'6 Months',yoy:'YoY'}[p]}</a>`
  ).join('');

  const guestRows = res_.slice(0, 50).map(r => `
    <tr>
      <td>
        <strong>${r.guest_name}</strong><br>
        <span style="font-size:11px;color:var(--muted);">${r.guest_phone || ''}</span>
      </td>
      <td>${r.hotel_properties?.name || '—'}</td>
      <td>${r.check_in}</td>
      <td>${r.nights} night${r.nights !== 1 ? 's' : ''}</td>
      <td>${r.adults}A${r.children ? ' ' + r.children + 'C' : ''}</td>
      <td><strong>${currency} ${fmtNum(Number(r.gross_amount))}</strong></td>
      <td><span class="badge badge-navy">${r.channel || 'direct'}</span></td>
      <td>${r.meal_plan ? `<span class="badge badge-teal">${r.meal_plan.replace(/_/g,' ')}</span>` : '—'}</td>
      ${phoneCount[r.guest_phone] > 1 ? '<td><span class="badge badge-green">Repeat</span></td>' : '<td style="color:var(--muted);font-size:11px;">1st visit</td>'}
    </tr>`).join('') || `<tr><td colspan="9" class="empty">No guests in this period.</td></tr>`;

  res.send(shell('Guest Intelligence', `
    <div class="sub-nav">
      <a href="/hotel-admin/revenue">Overview</a>
      <a href="/hotel-admin/revenue/rates">Rate Management</a>
      <a href="/hotel-admin/revenue/guests" class="active">Guest Intelligence</a>
      <a href="/hotel-admin/revenue/competitors">Competitors</a>
    </div>

    <div class="page-header">
      <h1 class="page-title">Guest Intelligence — ${label}</h1>
      <div class="period-tabs">${periodTabs}</div>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="stat-value">${res_.length}</div><div class="stat-label">Total Guests</div></div>
      <div class="stat green"><div class="stat-value">${repeatGuests}</div><div class="stat-label">Repeat Guests</div></div>
      <div class="stat amber"><div class="stat-value">${avgStay}</div><div class="stat-label">Avg Stay (nights)</div></div>
      <div class="stat teal"><div class="stat-value">${currency} ${fmtNum(avgSpend)}</div><div class="stat-label">Avg Spend / Guest</div></div>
      <div class="stat"><div class="stat-value">${avgParty}</div><div class="stat-label">Avg Party Size</div></div>
    </div>

    <div class="grid-2" style="margin-bottom:16px;">
      <div class="card">
        <div class="card-title">Revenue by Channel</div>
        <canvas id="guestChannelChart" height="180"></canvas>
        <script>
          (function(){
            const ctx = document.getElementById('guestChannelChart').getContext('2d');
            new Chart(ctx, {
              type: 'bar',
              data: {
                labels: ${JSON.stringify(Object.keys(byChannel))},
                datasets: [{ label: 'Revenue', data: ${JSON.stringify(Object.values(byChannel))},
                  backgroundColor: ['#1E2A5E','#3B5BBF','#0f7b8c','#27ae60','#f0ad4e'],
                  borderRadius: 6 }]
              },
              options: { responsive:true, plugins:{legend:{display:false}},
                scales:{ y:{ticks:{callback:v=>'${currency} '+v.toLocaleString()},grid:{color:'#E4E8F0'}}, x:{grid:{display:false}} } }
            });
          })();
        </script>
      </div>
      <div class="card">
        <div class="card-title">Top 5 by Spend</div>
        <table>
          <thead><tr><th>Guest</th><th>Property</th><th>Spend</th></tr></thead>
          <tbody>
            ${res_.slice(0, 5).map(r => `
              <tr>
                <td><strong>${r.guest_name}</strong><br><span style="font-size:11px;color:var(--muted);">${r.guest_phone||''}</span></td>
                <td style="font-size:12px;">${r.hotel_properties?.name||'—'}</td>
                <td><strong>${currency} ${fmtNum(Number(r.gross_amount))}</strong></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">All Guests — ${label}</div>
      </div>
      <table>
        <thead><tr><th>Guest</th><th>Property</th><th>Check-in</th><th>Stay</th><th>Party</th><th>Spend</th><th>Channel</th><th>Board</th><th>History</th></tr></thead>
        <tbody>${guestRows}</tbody>
      </table>
    </div>
  `, group));
});

// ─────────────────────────────
// COMPETITOR RATES
// GET /hotel-admin/revenue/competitors
// ─────────────────────────────
router.get('/competitors', requireHotelAuth, async (req, res) => {
  const group = req.hotelGroup;

  const { data: compRates } = await supabase
    .from('competitor_rates')
    .select('*')
    .eq('group_slug', group.slug)
    .order('check_in')
    .limit(100);

  const { data: reservations } = await supabase
    .from('hotel_reservations')
    .select('room_total, nights')
    .eq('group_id', group.id)
    .gte('check_in', fmt(new Date()))
    .neq('status', 'cancelled');

  const roomNights = (reservations || []).reduce((s, r) => s + (r.nights || 1), 0);
  const ADR = roomNights > 0
    ? (reservations || []).reduce((s, r) => s + Number(r.room_total || 0), 0) / roomNights : 0;

  const currency = group.currency || 'KES';
  const success  = req.query.success;

  const rows = (compRates || []).map(r => {
    const gap    = ADR - r.ota_rate;
    const gapPct = ADR > 0 ? (gap / ADR * 100).toFixed(1) : 0;
    const badge  = r.is_current ? '<span class="badge badge-green">Current</span>' : '<span class="badge badge-navy">Historical</span>';
    return `<tr>
      <td><span class="badge badge-navy">${r.ota_name}</span></td>
      <td>${r.check_in}</td>
      <td style="font-size:11px;color:var(--muted);">${r.room_name || '—'}</td>
      <td><strong>${currency} ${fmtNum(r.ota_rate)}</strong></td>
      <td><strong>${currency} ${fmtNum(ADR)}</strong></td>
      <td class="${gap > 0 ? 'delta-up' : 'delta-down'}" style="font-weight:700;">
        ${gap > 0 ? '▼ -' : '▲ +'}${Math.abs(gapPct)}%
      </td>
      <td>${badge}</td>
      <td style="color:var(--muted);font-size:11px;">${new Date(r.created_at||Date.now()).toLocaleDateString()}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="empty">No competitor rates logged yet. Add your first entry below.</td></tr>`;

  res.send(shell('Competitor Rates', `
    <div class="sub-nav">
      <a href="/hotel-admin/revenue">Overview</a>
      <a href="/hotel-admin/revenue/rates">Rate Management</a>
      <a href="/hotel-admin/revenue/guests">Guest Intelligence</a>
      <a href="/hotel-admin/revenue/competitors" class="active">Competitors</a>
    </div>

    <div class="page-header">
      <h1 class="page-title">Competitor Rate Tracker</h1>
      <button class="btn btn-primary" onclick="openModal('add-comp-modal')">+ Log Rate</button>
    </div>

    <div class="stat-grid">
      <div class="stat teal"><div class="stat-value">${currency} ${fmtNum(ADR)}</div><div class="stat-label">Your ADR (upcoming)</div></div>
      ${compRates && compRates.length ? `
        <div class="stat ${(compRates[0].ota_rate < ADR) ? 'green' : 'red'}">
          <div class="stat-value">${currency} ${fmtNum(compRates[0].ota_rate)}</div>
          <div class="stat-label">Latest Comp Rate — ${compRates[0].ota_name}</div>
        </div>` : ''}
    </div>

    ${success ? '<div class="alert-success">✓ Competitor rate logged.</div>' : ''}

    <div class="card">
      <div class="card-header">
        <div class="card-title">Rate Log</div>
        <span style="font-size:11px;color:var(--muted);">
          Log rates manually, or connect your channel manager to auto-pull.
        </span>
      </div>
      <table>
        <thead><tr><th>OTA</th><th>Check-in</th><th>Room</th><th>Their Rate</th><th>Your ADR</th><th>Gap</th><th>Status</th><th>Logged</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="modal-overlay" id="add-comp-modal">
      <div class="modal">
        <div class="modal-title">Log Competitor Rate</div>
        <form method="POST" action="/hotel-admin/revenue/competitors/add">
          <div class="form-row">
            <div class="form-group">
              <label>OTA / Competitor</label>
              <select name="ota_name">
                <option>Booking.com</option><option>Expedia</option><option>Airbnb</option>
                <option>Hotels.com</option><option>Agoda</option><option>Trip.com</option>
                <option>Jumia Travel</option><option>Other</option>
              </select>
            </div>
            <div class="form-group">
              <label>Check-in Date</label>
              <input type="date" name="check_in" required>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Rate per Night (${currency})</label>
              <input type="number" name="ota_rate" required min="0" placeholder="8500">
            </div>
            <div class="form-group">
              <label>Room / Category (optional)</label>
              <input type="text" name="room_name" placeholder="Deluxe Room, Superior...">
            </div>
          </div>
          <div class="form-group">
            <label>Notes (optional)</label>
            <input type="text" name="notes" placeholder="Breakfast included, weekend rate...">
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline" onclick="closeModal('add-comp-modal')">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Rate</button>
          </div>
        </form>
      </div>
    </div>
  `, group));
});

router.post('/competitors/add', requireHotelAuth, async (req, res) => {
  const { ota_name, check_in, ota_rate, room_name, notes } = req.body;
  const { error: insertErr } = await supabase.from('competitor_rates').insert({
    group_slug:  req.hotelGroup.slug,
    ota_name,
    check_in,
    ota_rate:    parseFloat(ota_rate),
    room_name:   room_name || null,
    notes:       notes || null,
    is_current:  true,
  });
  if (insertErr) {
    logger.error('[REVENUE] competitor rate insert failed', { error: insertErr.message });
    return res.redirect('/hotel-admin/revenue/competitors?error=' + encodeURIComponent(insertErr.message));
  }
  // Mark older entries for this OTA + check-in as not current
  await supabase.from('competitor_rates')
    .update({ is_current: false })
    .eq('group_slug', req.hotelGroup.slug)
    .eq('ota_name', ota_name)
    .eq('check_in', check_in)
    .neq('ota_rate', parseFloat(ota_rate));

  res.redirect('/hotel-admin/revenue/competitors?success=1');
});

module.exports = router;