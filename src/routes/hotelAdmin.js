/**
 * HOTEL ADMIN PANEL
 * ─────────────────────────────────────────────────────────────
 * Server-rendered HTML panel for hotel groups.
 * Mounted at /hotel-admin on the existing Express app.
 * Accessed via hotels.bodrless.com (pointed at same Render instance).
 *
 * AUTH: simple token-based. Hotel logs in with their admin_token
 * from hotel_groups. Token stored in a cookie for the session.
 * Hotels only ever see their own group's data — enforced both
 * in SQL queries (group_id filter) and in the auth middleware.
 *
 * SECTIONS:
 *   /hotel-admin/login          — login page
 *   /hotel-admin/dashboard      — overview: reservations, revenue, commission
 *   /hotel-admin/properties     — list + add/edit properties
 *   /hotel-admin/properties/:id/rooms      — room types for a property
 *   /hotel-admin/properties/:id/rooms/:rid/rates  — rate plans for a room
 *   /hotel-admin/properties/:id/rooms/:rid/availability — availability blocks
 *   /hotel-admin/properties/:id/ancillaries — ancillary services
 *   /hotel-admin/reservations   — all reservations, mark paid, cancel
 *   /hotel-admin/commission     — ledger + invoice history
 *   /hotel-admin/revenue/*      — revenue manager dashboard (hotelRevenueAdmin.js)
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const hotelDirectBookingService = require('../services/hotelDirectBookingService');

// Mount revenue dashboard
const revenueRouter = require('./hotelRevenueAdmin');
router.use('/revenue', revenueRouter);

// ─────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────
async function requireHotelAuth(req, res, next) {
  const token = req.cookies?.hotel_token;
  if (!token) return res.redirect('/hotel-admin/login');

  const { data: group } = await supabase
    .from('hotel_groups')
    .select('*')
    .eq('admin_token', token)
    .eq('is_active', true)
    .single();

  if (!group) {
    res.clearCookie('hotel_token');
    return res.redirect('/hotel-admin/login?error=invalid');
  }

  req.hotelGroup = group;
  next();
}

// ─────────────────────────────
// SHARED HTML SHELL — premium sidebar layout
// ─────────────────────────────
function shell(title, body, group = null, activePage = '') {
  const currentPath = activePage;

  const sidebarLinks = group ? [
    { href: '/hotel-admin/dashboard',    icon: '▦',  label: 'Dashboard'    },
    { href: '/hotel-admin/revenue',      icon: '↗',  label: 'Revenue'      },
    { href: '/hotel-admin/reservations', icon: '⊟',  label: 'Reservations' },
    { href: '/hotel-admin/properties',   icon: '⊞',  label: 'Properties'   },
    { href: '/hotel-admin/commission',   icon: '◈',  label: 'Commission'   },
  ] : [];

  const sidebar = group ? `
  <aside class="sidebar">
    <div class="sidebar-brand">
      <div class="brand-icon">B</div>
      <div class="brand-text">
        <div class="brand-name">${group.name}</div>
        <div class="brand-sub">Hotel Portal</div>
      </div>
    </div>
    <nav class="sidebar-nav">
      ${sidebarLinks.map(l => `
      <a href="${l.href}" class="nav-item ${currentPath === l.href || (currentPath === '' && l.href.includes('dashboard')) ? 'active' : ''}">
        <span class="nav-icon">${l.icon}</span>
        <span>${l.label}</span>
      </a>`).join('')}
    </nav>
    <div class="sidebar-footer">
      <div class="sidebar-user">
        <div class="user-avatar">${(group.name || 'H')[0].toUpperCase()}</div>
        <div class="user-info">
          <div class="user-name">${group.name}</div>
          <div class="user-role">Administrator</div>
        </div>
      </div>
      <a href="/hotel-admin/logout" class="logout-btn" title="Sign out">⏻</a>
    </div>
  </aside>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — ${group ? group.name : 'Bodrless'} Portal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:wght@600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --ink:    #0F1117;
      --dark:   #161B2E;
      --panel:  #1E253C;
      --rail:   #252D45;
      --gold:   #C9A84C;
      --gold-lt:#E8C96A;
      --cream:  #F7F5F0;
      --white:  #FFFFFF;
      --border: #E8E4DC;
      --muted:  #9099B2;
      --green:  #22C55E;
      --amber:  #F59E0B;
      --red:    #EF4444;
      --teal:   #0EA5E9;
      --radius: 12px;
      --sidebar-w: 220px;
    }
    body {
      font-family: 'Inter', sans-serif;
      background: var(--cream);
      color: var(--ink);
      min-height: 100vh;
      display: flex;
    }

    /* ── SIDEBAR ── */
    .sidebar {
      width: var(--sidebar-w);
      min-height: 100vh;
      background: var(--dark);
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0; left: 0; bottom: 0;
      z-index: 100;
    }
    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 24px 20px 20px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .brand-icon {
      width: 36px; height: 36px;
      background: var(--gold);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Playfair Display', serif;
      font-size: 18px; font-weight: 600;
      color: var(--dark);
      flex-shrink: 0;
    }
    .brand-name { font-size: 13px; font-weight: 600; color: white; line-height: 1.2; }
    .brand-sub  { font-size: 10px; color: var(--muted); letter-spacing: 0.5px; margin-top: 2px; }
    .sidebar-nav { flex: 1; padding: 16px 12px; display: flex; flex-direction: column; gap: 2px; }
    .nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 12px;
      border-radius: 8px;
      text-decoration: none;
      font-size: 13px; font-weight: 500;
      color: var(--muted);
      transition: all 0.15s;
    }
    .nav-item:hover { background: rgba(255,255,255,0.06); color: white; }
    .nav-item.active { background: rgba(201,168,76,0.15); color: var(--gold); }
    .nav-icon { font-size: 15px; width: 18px; text-align: center; }
    .sidebar-footer {
      padding: 16px 12px;
      border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; align-items: center; gap: 10px;
    }
    .user-avatar {
      width: 32px; height: 32px;
      background: var(--panel);
      border: 1.5px solid var(--gold);
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700; color: var(--gold);
      flex-shrink: 0;
    }
    .user-info { flex: 1; min-width: 0; }
    .user-name { font-size: 12px; font-weight: 600; color: white; truncate: ellipsis; }
    .user-role { font-size: 10px; color: var(--muted); }
    .logout-btn {
      color: var(--muted); text-decoration: none;
      font-size: 16px; padding: 4px;
      transition: color 0.15s;
    }
    .logout-btn:hover { color: var(--red); }

    /* ── MAIN CONTENT ── */
    .main {
      margin-left: var(--sidebar-w);
      flex: 1;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .topbar {
      background: white;
      border-bottom: 1px solid var(--border);
      padding: 0 32px;
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky; top: 0; z-index: 50;
    }
    .topbar-title { font-size: 15px; font-weight: 600; color: var(--ink); }
    .topbar-right { display: flex; align-items: center; gap: 12px; }
    .topbar-date { font-size: 12px; color: var(--muted); }
    .page { padding: 28px 32px; flex: 1; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    .page-title { font-size: 20px; font-weight: 700; color: var(--ink); }

    /* ── STAT CARDS ── */
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat {
      background: white;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 22px;
      position: relative;
      overflow: hidden;
    }
    .stat::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--dark);
    }
    .stat.gold::before  { background: var(--gold); }
    .stat.green::before { background: var(--green); }
    .stat.amber::before { background: var(--amber); }
    .stat.red::before   { background: var(--red); }
    .stat.teal::before  { background: var(--teal); }
    .stat-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin-bottom: 8px;
    }
    .stat-value { font-size: 28px; font-weight: 700; color: var(--ink); line-height: 1; }
    .stat-sub   { font-size: 11px; color: var(--muted); margin-top: 6px; }

    /* ── CARDS ── */
    .card {
      background: white;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0;
      margin-bottom: 20px;
      overflow: hidden;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }
    .card-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--ink);
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .card-body { padding: 20px; }

    /* ── TABLES ── */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left;
      padding: 11px 16px;
      font-size: 10px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.8px;
      background: #FAFAF8;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    td { padding: 13px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: #FAFAF8; }
    .td-primary { font-weight: 600; color: var(--ink); font-size: 13px; }
    .td-sub     { font-size: 11px; color: var(--muted); margin-top: 2px; }

    /* ── BADGES ── */
    .badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .badge::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: 0.7; }
    .badge-green { background: #DCFCE7; color: #16A34A; }
    .badge-amber { background: #FEF3C7; color: #D97706; }
    .badge-red   { background: #FEE2E2; color: #DC2626; }
    .badge-navy  { background: #EEF2FF; color: #4338CA; }
    .badge-muted { background: #F1F5F9; color: #64748B; }

    /* ── BUTTONS ── */
    .btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 8px 16px; border-radius: 8px; border: none;
      cursor: pointer; font-size: 12px; font-weight: 600;
      text-decoration: none; font-family: 'Inter', sans-serif;
      transition: all 0.15s; white-space: nowrap;
    }
    .btn-primary { background: var(--dark); color: white; }
    .btn-primary:hover { background: var(--panel); }
    .btn-gold    { background: var(--gold); color: var(--dark); }
    .btn-gold:hover { background: var(--gold-lt); }
    .btn-green   { background: #22C55E; color: white; }
    .btn-green:hover { background: #16A34A; }
    .btn-red     { background: var(--red); color: white; }
    .btn-red:hover { background: #DC2626; }
    .btn-outline { background: white; color: var(--ink); border: 1.5px solid var(--border); }
    .btn-outline:hover { border-color: #CBD5E1; background: #F8FAFC; }
    .btn-sm      { padding: 5px 12px; font-size: 11px; border-radius: 6px; }

    /* ── FORMS ── */
    form { display: flex; flex-direction: column; gap: 16px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    label { font-size: 11px; font-weight: 600; color: #374151; text-transform: uppercase; letter-spacing: 0.5px; }
    input, select, textarea {
      padding: 10px 13px;
      border: 1.5px solid var(--border);
      border-radius: 8px;
      font-size: 13px;
      color: var(--ink);
      background: white;
      outline: none;
      font-family: 'Inter', sans-serif;
      transition: border-color 0.15s;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(201,168,76,0.1); }
    textarea { min-height: 80px; resize: vertical; }
    .hint { font-size: 11px; color: var(--muted); margin-top: 3px; }

    /* ── ALERTS ── */
    .alert { padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .alert-success { background: #DCFCE7; color: #15803D; border: 1px solid #BBF7D0; }
    .alert-error   { background: #FEE2E2; color: #B91C1C; border: 1px solid #FECACA; }

    /* ── MISC ── */
    .empty { text-align: center; padding: 48px; color: var(--muted); font-size: 13px; }
    .breadcrumb { font-size: 12px; color: var(--muted); margin-bottom: 16px; display: flex; align-items: center; gap: 6px; }
    .breadcrumb a { color: var(--ink); text-decoration: none; }
    .breadcrumb a:hover { color: var(--gold); }
    .breadcrumb-sep { color: var(--border); }
    .section-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    /* ── MODALS ── */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(15,17,23,0.6); backdrop-filter: blur(4px); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.open { display: flex; }
    .modal { background: white; border-radius: 16px; padding: 28px; width: 90%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: 0 24px 64px rgba(0,0,0,0.18); }
    .modal-title { font-size: 17px; font-weight: 700; margin-bottom: 20px; }
    .modal-actions { display: flex; gap: 8px; margin-top: 20px; justify-content: flex-end; }

    /* ── NO SIDEBAR (login) ── */
    body.no-sidebar { display: block; }
    body.no-sidebar .main { margin-left: 0; }

    @media (max-width: 768px) {
      .sidebar { display: none; }
      .main { margin-left: 0; }
      .form-row { grid-template-columns: 1fr; }
      .page { padding: 20px 16px; }
    }
  </style>
</head>
<body${!group ? ' class="no-sidebar"' : ''}>
${sidebar}
<div class="main">
  ${group ? `
  <div class="topbar">
    <span class="topbar-title">${title}</span>
    <div class="topbar-right">
      <span class="topbar-date">${new Date().toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short', year:'numeric' })}</span>
      <a href="/hotel-admin/revenue" class="btn btn-gold btn-sm">↗ Revenue</a>
    </div>
  </div>` : ''}
  <div class="page">
  ${body}
  </div>
</div>
<script>
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
</script>
</body>
</html>`;
}

// ─────────────────────────────
// LOGIN
// ─────────────────────────────
router.get('/login', (req, res) => {
  const error = req.query.error;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — Bodrless Hotel Portal</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Playfair+Display:wght@600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --gold: #C9A84C; --dark: #161B2E; --ink: #0F1117; --border: #E8E4DC; --muted: #9099B2; --red: #EF4444; }
    body {
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      display: grid;
      grid-template-columns: 1fr 1fr;
      background: #F7F5F0;
    }
    .login-left {
      background: var(--dark);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 48px;
      position: relative;
      overflow: hidden;
    }
    .login-left::before {
      content: '';
      position: absolute;
      bottom: -80px; right: -80px;
      width: 320px; height: 320px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(201,168,76,0.18) 0%, transparent 70%);
    }
    .login-logo {
      display: flex; align-items: center; gap: 12px;
    }
    .logo-mark {
      width: 40px; height: 40px;
      background: var(--gold);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-family: 'Playfair Display', serif;
      font-size: 20px; color: var(--dark); font-weight: 600;
    }
    .logo-text { font-size: 18px; font-weight: 700; color: white; letter-spacing: -0.3px; }
    .login-headline {
      position: relative; z-index: 1;
    }
    .login-headline h1 {
      font-family: 'Playfair Display', serif;
      font-size: 42px;
      color: white;
      line-height: 1.15;
      margin-bottom: 16px;
    }
    .login-headline p { font-size: 15px; color: rgba(255,255,255,0.5); line-height: 1.7; }
    .login-hotels {
      display: flex; gap: 8px; flex-wrap: wrap;
      position: relative; z-index: 1;
    }
    .hotel-chip {
      padding: 5px 12px;
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      font-size: 11px; color: rgba(255,255,255,0.5);
    }
    .login-right {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 48px;
    }
    .login-form-wrap { width: 100%; max-width: 360px; }
    .login-form-wrap h2 { font-size: 22px; font-weight: 700; color: var(--ink); margin-bottom: 6px; }
    .login-form-wrap p  { font-size: 14px; color: var(--muted); margin-bottom: 32px; }
    .form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
    label { font-size: 11px; font-weight: 600; color: #374151; text-transform: uppercase; letter-spacing: 0.5px; }
    input {
      padding: 12px 14px;
      border: 1.5px solid var(--border);
      border-radius: 10px;
      font-size: 14px;
      color: var(--ink);
      background: white;
      outline: none;
      font-family: 'Inter', sans-serif;
      transition: border-color 0.15s, box-shadow 0.15s;
      width: 100%;
    }
    input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px rgba(201,168,76,0.12); }
    .sign-in-btn {
      width: 100%;
      padding: 13px;
      background: var(--dark);
      color: white;
      border: none;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: background 0.15s;
      margin-top: 8px;
    }
    .sign-in-btn:hover { background: #252D45; }
    .error-msg {
      background: #FEE2E2;
      color: #B91C1C;
      border: 1px solid #FECACA;
      border-radius: 8px;
      padding: 11px 14px;
      font-size: 13px;
      margin-bottom: 16px;
    }
    .support-link { font-size: 12px; color: var(--muted); text-align: center; margin-top: 24px; }
    .support-link a { color: var(--ink); }
    @media (max-width: 700px) {
      body { grid-template-columns: 1fr; }
      .login-left { display: none; }
    }
  </style>
</head>
<body>
  <div class="login-left">
    <div class="login-logo">
      <div class="logo-mark">B</div>
      <span class="logo-text">Bodrless</span>
    </div>
    <div class="login-headline">
      <h1>Your hotel,<br>your portal.</h1>
      <p>Manage reservations, rates, and revenue<br>across all your properties in one place.</p>
    </div>
    <div class="login-hotels">
      <span class="hotel-chip">Sarova Hotels</span>
      <span class="hotel-chip">PrideInn Hotels</span>
      <span class="hotel-chip">Serena Hotels</span>
    </div>
  </div>
  <div class="login-right">
    <div class="login-form-wrap">
      <h2>Welcome back</h2>
      <p>Sign in with your hotel access key</p>
      ${error ? '<div class="error-msg">⚠ Invalid access key. Please try again or contact support.</div>' : ''}
      <form method="POST" action="/hotel-admin/login">
        <div class="form-group">
          <label>Hotel Access Key</label>
          <input type="password" name="token" placeholder="Enter your access key" required autofocus>
        </div>
        <button type="submit" class="sign-in-btn">Sign in →</button>
      </form>
      <div class="support-link">
        Need access? <a href="mailto:support@bodrless.com">support@bodrless.com</a>
      </div>
    </div>
  </div>
</body>
</html>`);
});

router.post('/login', async (req, res) => {
  const { token } = req.body;
  const { data: group } = await supabase
    .from('hotel_groups')
    .select('id, name, is_active')
    .eq('admin_token', token)
    .single();

  if (!group || !group.is_active) {
    return res.redirect('/hotel-admin/login?error=invalid');
  }

  res.cookie('hotel_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000,
    sameSite: 'lax',
  });
  res.redirect('/hotel-admin/dashboard');
});

router.get('/logout', (req, res) => {
  res.clearCookie('hotel_token');
  res.redirect('/hotel-admin/login');
});

// ─────────────────────────────
// DASHBOARD
// ─────────────────────────────
const hotelTracking = (() => {
  try { return require('./hotelTracking'); }
  catch(e) { return { getLiveStats: async () => ({ activePlanners:0, activeDetails:[], todayVisits:0, weekVisits:0, todaySessions:0, convRate:0, hourlyVisits:Array(24).fill(0) }) }; }
})();

router.get('/dashboard', requireHotelAuth, async (req, res) => {
  const groupId  = req.hotelGroup.id;
  const groupSlug = req.hotelGroup.slug;
  const currency = req.hotelGroup.currency || 'KES';

  const [
    { data: reservations },
    { data: pending },
    { data: ledger },
    liveStats,
  ] = await Promise.all([
    supabase.from('hotel_reservations').select('gross_amount, status, payment_status, created_at').eq('group_id', groupId),
    supabase.from('hotel_reservations').select('id').eq('group_id', groupId).eq('payment_status', 'pending').neq('status', 'cancelled'),
    supabase.from('commission_ledger').select('commission_amount, status').eq('group_id', groupId),
    hotelTracking.getLiveStats(groupSlug),
  ]);

  const totalRevenue   = (reservations || []).filter(r => r.payment_status === 'paid').reduce((s, r) => s + Number(r.gross_amount), 0);
  const pendingCount   = (pending || []).length;
  const commissionOwed = (ledger || []).filter(l => l.status === 'pending').reduce((s, l) => s + Number(l.commission_amount), 0);
  const totalBookings  = (reservations || []).filter(r => r.status !== 'cancelled').length;

  const { data: recent } = await supabase
    .from('hotel_reservations')
    .select('reservation_ref, guest_name, guest_phone, check_in, check_out, nights, gross_amount, status, payment_status, channel, created_at, hotel_properties(name)')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(10);

  // ── Live stats HTML ──────────────────────────────────────
  const maxHourly   = Math.max(...liveStats.hourlyVisits, 1);
  const sparkBars   = liveStats.hourlyVisits.map((v, h) => {
    const pct = Math.round((v / maxHourly) * 100);
    const isNow = h === new Date().getHours();
    return `<div title="${h}:00 — ${v} visit${v!==1?'s':''}" style="flex:1;height:${Math.max(pct,4)}%;background:${isNow?'var(--gold)':'rgba(201,168,76,0.3)'};border-radius:2px 2px 0 0;transition:height 0.3s;"></div>`;
  }).join('');

  const activePlannerRows = liveStats.activeDetails.length
    ? liveStats.activeDetails.map(d => {
        const ago = Math.round((Date.now() - new Date(d.lastSeen)) / 60000);
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
          <div style="width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0;box-shadow:0 0 0 3px rgba(34,197,94,0.2);"></div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;font-weight:500;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${d.intent || 'Browsing…'}</div>
            <div style="font-size:10px;color:var(--muted);">${ago === 0 ? 'Just now' : ago + ' min ago'}</div>
          </div>
        </div>`;
      }).join('')
    : `<div style="text-align:center;padding:20px 0;color:var(--muted);font-size:12px;">No active planners right now</div>`;

  const recentRows = (recent || []).map(r => `
    <tr>
      <td><span class="td-primary">${r.reservation_ref}</span></td>
      <td>
        <div class="td-primary">${r.guest_name}</div>
        <div class="td-sub">${r.guest_phone || ''}</div>
      </td>
      <td><div class="td-primary">${r.hotel_properties?.name || ''}</div></td>
      <td>
        <div class="td-primary">${r.check_in} → ${r.check_out}</div>
        <div class="td-sub">${r.nights} night${r.nights !== 1 ? 's' : ''}</div>
      </td>
      <td><span class="td-primary">${currency} ${Number(r.gross_amount).toLocaleString()}</span></td>
      <td>${statusBadge(r.status)}</td>
      <td>${paymentBadge(r.payment_status)}</td>
      <td>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <a href="/hotel-admin/reservations/${r.reservation_ref}" class="btn btn-outline btn-sm">View</a>
          ${r.payment_status === 'pending' && r.status !== 'cancelled' ? `
            <form method="POST" action="/hotel-admin/reservations/${r.reservation_ref}/mark-paid" style="display:inline;">
              <button class="btn btn-green btn-sm">Mark Paid</button>
            </form>` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  res.send(shell('Dashboard', `
    <div class="page-header">
      <div>
        <div class="page-title">Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'} 👋</div>
        <div style="font-size:13px;color:var(--muted);margin-top:4px;">Here's what's happening at ${req.hotelGroup.name}</div>
      </div>
      <a href="/hotel-admin/reservations" class="btn btn-primary">View all reservations</a>
    </div>

    <div class="stat-grid">
      <div class="stat gold">
        <div class="stat-label">Total Bookings</div>
        <div class="stat-value">${totalBookings}</div>
        <div class="stat-sub">All time, excl. cancelled</div>
      </div>
      <div class="stat green">
        <div class="stat-label">Revenue Collected</div>
        <div class="stat-value">${currency} ${Math.round(totalRevenue).toLocaleString()}</div>
        <div class="stat-sub">Paid reservations only</div>
      </div>
      <div class="stat amber">
        <div class="stat-label">Awaiting Payment</div>
        <div class="stat-value">${pendingCount}</div>
        <div class="stat-sub">Confirmed but unpaid</div>
      </div>
      <div class="stat red">
        <div class="stat-label">Commission Owed</div>
        <div class="stat-value">${currency} ${Math.round(commissionOwed).toLocaleString()}</div>
        <div class="stat-sub">Pending invoices</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Recent Reservations</span>
        <a href="/hotel-admin/reservations" class="btn btn-outline btn-sm">View all</a>
      </div>
      ${recentRows.length ? `
        <table>
          <thead><tr>
            <th>Ref</th><th>Guest</th><th>Property</th>
            <th>Dates</th><th>Amount</th><th>Status</th><th>Payment</th><th>Actions</th>
          </tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      ` : '<div class="empty">No reservations yet. Bookings made via your widget will appear here.</div>'}
    </div>
  `, req.hotelGroup, '/hotel-admin/dashboard'));
});

// ─────────────────────────────
// PROPERTIES — list
// ─────────────────────────────
router.get('/properties', requireHotelAuth, async (req, res) => {
  const { data: properties } = await supabase
    .from('hotel_properties')
    .select('*, room_types(count)')
    .eq('group_id', req.hotelGroup.id)
    .order('sort_order');

  const success = req.query.success;

  const rows = (properties || []).map(p => `
    <tr>
      <td>
        <strong>${p.name}</strong><br>
        <span style="color:var(--muted);font-size:11px;">${p.slug}</span>
        ${p.property_type ? `<br><span style="font-size:10px;color:var(--muted);">${p.property_type}</span>` : ''}
      </td>
      <td>${p.destination}</td>
      <td>${p.location || '—'}</td>
      <td>${p.stars ? '⭐'.repeat(p.stars) : '—'}</td>
      <td>
        ${p.features?.length ? `<span style="font-size:11px;color:var(--muted);">${p.features.slice(0,3).join(', ')}${p.features.length > 3 ? '…' : ''}</span>` : '—'}
      </td>
      <td>${p.pms_type ? `<span class="badge badge-amber">${p.pms_type}</span>` : '<span class="badge badge-navy">Supabase</span>'}</td>
      <td>${p.is_active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Inactive</span>'}</td>
      <td>
        <a href="/hotel-admin/properties/${p.id}/rooms" class="btn btn-outline btn-sm">Rooms</a>
        <a href="/hotel-admin/properties/${p.id}/ancillaries" class="btn btn-outline btn-sm">Add-ons</a>
        <a href="/hotel-admin/properties/${p.id}/edit" class="btn btn-outline btn-sm">Edit</a>
      </td>
    </tr>
  `).join('');

  res.send(shell('Properties', `
    <div class="page-header">
      <h1 class="page-title">Properties</h1>
      <a href="/hotel-admin/properties/new" class="btn btn-primary">+ Add Property</a>
    </div>
    ${success === 'created' ? '<div class="alert alert-success">✓ Property created successfully.</div>' : ''}
    ${success === 'updated' ? '<div class="alert alert-success">✓ Property updated successfully.</div>' : ''}
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Name</th><th>Destination</th><th>Location</th><th>Stars</th><th>Features</th><th>Inventory</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No properties yet. Add your first property to get started.</div>'}
    </div>
  `, req.hotelGroup));
});

// ─────────────────────────────
// PROPERTIES — new/edit form
// ─────────────────────────────
router.get('/properties/new', requireHotelAuth, (req, res) => {
  res.send(shell('Add Property', propertyForm(null, req.hotelGroup), req.hotelGroup));
});

router.get('/properties/:id/edit', requireHotelAuth, async (req, res) => {
  const { data: property } = await supabase.from('hotel_properties').select('*').eq('id', req.params.id).eq('group_id', req.hotelGroup.id).single();
  if (!property) return res.redirect('/hotel-admin/properties');
  res.send(shell('Edit Property', propertyForm(property, req.hotelGroup), req.hotelGroup));
});

router.post('/properties/new', requireHotelAuth, async (req, res) => {
  const b = req.body;
  const { error } = await supabase.from('hotel_properties').insert({
    group_id:      req.hotelGroup.id,
    name:          b.name,
    slug:          b.slug,
    destination:   b.destination,
    location:      b.location,
    address:       b.address,
    stars:         parseInt(b.stars) || null,
    description:   b.description,
    currency:      b.currency || 'KES',
    check_in_time:  b.check_in_time || '14:00',
    check_out_time: b.check_out_time || '11:00',
    property_type:  b.property_type || 'hotel',
    features:       b.features ? b.features.split(',').map(s => s.trim()).filter(Boolean) : [],
    location_tags:  b.location_tags ? b.location_tags.split(',').map(s => s.trim()).filter(Boolean) : [],
    is_active:      b.is_active === 'on',
  });
  if (error) {
    logger.error('[HOTEL ADMIN] property insert failed', { error: error.message });
    return res.redirect('/hotel-admin/properties/new?error=' + encodeURIComponent(error.message));
  }
  res.redirect('/hotel-admin/properties?success=created');
});

router.post('/properties/:id/edit', requireHotelAuth, async (req, res) => {
  const b = req.body;
  const { error } = await supabase.from('hotel_properties').update({
    name:           b.name,
    destination:    b.destination,
    location:       b.location,
    address:        b.address,
    stars:          parseInt(b.stars) || null,
    description:    b.description,
    currency:       b.currency || 'KES',
    check_in_time:  b.check_in_time || '14:00',
    check_out_time: b.check_out_time || '11:00',
    property_type:  b.property_type || 'hotel',
    features:       b.features ? b.features.split(',').map(s => s.trim()).filter(Boolean) : [],
    location_tags:  b.location_tags ? b.location_tags.split(',').map(s => s.trim()).filter(Boolean) : [],
    is_active:      b.is_active === 'on',
  }).eq('id', req.params.id).eq('group_id', req.hotelGroup.id);
  if (error) {
    logger.error('[HOTEL ADMIN] property update failed', { error: error.message });
    return res.redirect(`/hotel-admin/properties/${req.params.id}/edit?error=` + encodeURIComponent(error.message));
  }
  res.redirect('/hotel-admin/properties?success=updated');
});

function propertyForm(p, group) {
  const v = p || {};
  const featuresVal = Array.isArray(v.features) ? v.features.join(', ') : (v.features || '');
  const tagsVal     = Array.isArray(v.location_tags) ? v.location_tags.join(', ') : (v.location_tags || '');
  const errorMsg    = '';

  return `
    <div class="breadcrumb"><a href="/hotel-admin/properties">Properties</a> › ${p ? 'Edit' : 'New Property'}</div>
    <div class="page-header"><h1 class="page-title">${p ? 'Edit Property' : 'Add Property'}</h1></div>
    <div class="card">
      <form method="POST" action="/hotel-admin/properties/${p ? p.id + '/edit' : 'new'}">

        <div class="form-row">
          <div class="form-group">
            <label>Property Name</label>
            <input name="name" value="${v.name || ''}" required placeholder="Sarova Stanley">
          </div>
          <div class="form-group">
            <label>Slug (URL-safe ID)</label>
            <input name="slug" value="${v.slug || ''}" ${p ? 'readonly style="opacity:0.6;"' : 'required'} placeholder="sarova-stanley">
            <span class="hint">Lowercase, hyphens only. Cannot be changed after creation.</span>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Destination City</label>
            <input name="destination" value="${v.destination || ''}" required placeholder="Nairobi">
          </div>
          <div class="form-group">
            <label>Stars</label>
            <select name="stars">
              ${[1,2,3,4,5].map(s => `<option value="${s}" ${v.stars == s ? 'selected' : ''}>${s} Star${s>1?'s':''}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Property Type</label>
            <select name="property_type">
              <option value="hotel"      ${v.property_type === 'hotel'      || !v.property_type ? 'selected' : ''}>Hotel</option>
              <option value="resort"     ${v.property_type === 'resort'     ? 'selected' : ''}>Resort</option>
              <option value="lodge"      ${v.property_type === 'lodge'      ? 'selected' : ''}>Lodge</option>
              <option value="camp"       ${v.property_type === 'camp'       ? 'selected' : ''}>Tented Camp</option>
              <option value="aparthotel" ${v.property_type === 'aparthotel' ? 'selected' : ''}>Aparthotel</option>
            </select>
            <span class="hint">Used by the AI to match guests to the right property type.</span>
          </div>
          <div class="form-group">
            <label>Currency</label>
            <select name="currency">
              <option value="KES" ${v.currency === 'KES' || !v.currency ? 'selected' : ''}>KES — Kenyan Shilling</option>
              <option value="USD" ${v.currency === 'USD' ? 'selected' : ''}>USD — US Dollar</option>
              <option value="EUR" ${v.currency === 'EUR' ? 'selected' : ''}>EUR — Euro</option>
              <option value="TZS" ${v.currency === 'TZS' ? 'selected' : ''}>TZS — Tanzanian Shilling</option>
              <option value="UGX" ${v.currency === 'UGX' ? 'selected' : ''}>UGX — Ugandan Shilling</option>
              <option value="RWF" ${v.currency === 'RWF' ? 'selected' : ''}>RWF — Rwandan Franc</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label>Features <span style="font-weight:400;text-transform:none;">(comma-separated)</span></label>
          <input name="features" value="${featuresVal}" placeholder="beach, pool, spa, restaurant, gym, conference, watersports">
          <span class="hint">The AI uses these to match guests asking for specific amenities e.g. "something with a pool".</span>
        </div>

        <div class="form-group">
          <label>Location Tags <span style="font-weight:400;text-transform:none;">(comma-separated)</span></label>
          <input name="location_tags" value="${tagsVal}" placeholder="mombasa, coast, beachfront, ocean, cbd, airport, lakeside">
          <span class="hint">Helps guests find you by area e.g. "near the airport" or "beachfront".</span>
        </div>

        <div class="form-group">
          <label>Location / Neighbourhood</label>
          <input name="location" value="${v.location || ''}" placeholder="Corner of Kimathi St & Kenyatta Ave">
        </div>

        <div class="form-group">
          <label>Full Address</label>
          <input name="address" value="${v.address || ''}" placeholder="Harry Thuku Rd, Nairobi">
        </div>

        <div class="form-group">
          <label>Description</label>
          <textarea name="description">${v.description || ''}</textarea>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Check-in Time</label>
            <input name="check_in_time" value="${v.check_in_time || '14:00'}" placeholder="14:00">
          </div>
          <div class="form-group">
            <label>Check-out Time</label>
            <input name="check_out_time" value="${v.check_out_time || '11:00'}" placeholder="11:00">
          </div>
        </div>

        <div class="form-group">
          <label><input type="checkbox" name="is_active" ${v.is_active !== false ? 'checked' : ''}> &nbsp;Active (visible to guests)</label>
        </div>

        <div style="display:flex;gap:10px;">
          <button type="submit" class="btn btn-primary">${p ? 'Save Changes' : 'Create Property'}</button>
          <a href="/hotel-admin/properties" class="btn btn-outline">Cancel</a>
        </div>
      </form>
    </div>`;
}

// ─────────────────────────────
// ROOMS — list + add
// ─────────────────────────────
router.get('/properties/:id/rooms', requireHotelAuth, async (req, res) => {
  const { data: property } = await supabase.from('hotel_properties').select('*').eq('id', req.params.id).eq('group_id', req.hotelGroup.id).single();
  if (!property) return res.redirect('/hotel-admin/properties');

  const { data: rooms } = await supabase.from('room_types').select('*').eq('property_id', req.params.id).order('sort_order');

  const success = req.query.success;
  const rows = (rooms || []).map(r => `
    <tr>
      <td><strong>${r.name}</strong></td>
      <td>${r.bed_type || '—'}</td>
      <td>${r.view || '—'}</td>
      <td>${r.max_adults} adults, ${r.max_children} children</td>
      <td>${r.total_rooms || 1} room${(r.total_rooms || 1) !== 1 ? 's' : ''}</td>
      <td>${r.size_sqm ? r.size_sqm + ' m²' : '—'}</td>
      <td>${r.is_active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Inactive</span>'}</td>
      <td>
        <a href="/hotel-admin/properties/${property.id}/rooms/${r.id}/rates" class="btn btn-outline btn-sm">Rate Plans</a>
        <a href="/hotel-admin/properties/${property.id}/rooms/${r.id}/availability" class="btn btn-outline btn-sm">Availability</a>
      </td>
    </tr>
  `).join('');

  res.send(shell('Rooms', `
    <div class="breadcrumb"><a href="/hotel-admin/properties">Properties</a> › ${property.name} › Rooms</div>
    <div class="page-header">
      <h1 class="page-title">Room Types — ${property.name}</h1>
      <button class="btn btn-primary" onclick="openModal('add-room-modal')">+ Add Room Type</button>
    </div>
    ${success ? '<div class="alert alert-success">✓ Room type saved successfully.</div>' : ''}
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Name</th><th>Bed Type</th><th>View</th><th>Capacity</th><th>Inventory</th><th>Size</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No room types yet. Add your first room type.</div>'}
    </div>

    <div class="modal-overlay" id="add-room-modal">
      <div class="modal">
        <div class="modal-title">Add Room Type</div>
        <form method="POST" action="/hotel-admin/properties/${property.id}/rooms/new">
          <div class="form-group"><label>Room Name</label><input name="name" required placeholder="Deluxe Room, Junior Suite..."></div>
          <div class="form-group"><label>Slug</label><input name="slug" required placeholder="deluxe-room"></div>
          <div class="form-group"><label>Description</label><textarea name="description" placeholder="Spacious room with..."></textarea></div>
          <div class="form-row">
            <div class="form-group"><label>Bed Type</label>
              <select name="bed_type">
                <option>King</option><option>Queen</option><option>Twin</option><option>Double</option><option>Single</option>
              </select>
            </div>
            <div class="form-group"><label>View</label><input name="view" placeholder="Garden View, Sea View..."></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>Max Adults</label><input name="max_adults" type="number" value="2" min="1"></div>
            <div class="form-group"><label>Max Children</label><input name="max_children" type="number" value="2" min="0"></div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Total Physical Rooms of This Type</label>
              <input name="total_rooms" type="number" value="1" min="1" placeholder="e.g. 12">
              <span class="hint" style="font-size:10px;color:var(--muted);">Used for occupancy calculations in revenue dashboard.</span>
            </div>
            <div class="form-group"><label>Size (m²)</label><input name="size_sqm" type="number" placeholder="32"></div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline" onclick="closeModal('add-room-modal')">Cancel</button>
            <button type="submit" class="btn btn-primary">Add Room Type</button>
          </div>
        </form>
      </div>
    </div>
  `, req.hotelGroup));
});

router.post('/properties/:id/rooms/new', requireHotelAuth, async (req, res) => {
  const b = req.body;
  await supabase.from('room_types').insert({
    property_id:   req.params.id,
    name:          b.name,
    slug:          b.slug,
    description:   b.description,
    bed_type:      b.bed_type,
    view:          b.view,
    max_adults:    parseInt(b.max_adults) || 2,
    max_children:  parseInt(b.max_children) || 2,
    max_occupancy: (parseInt(b.max_adults) || 2) + (parseInt(b.max_children) || 2),
    total_rooms:   parseInt(b.total_rooms) || 1,
    size_sqm:      parseFloat(b.size_sqm) || null,
    is_active:     true,
  });
  res.redirect(`/hotel-admin/properties/${req.params.id}/rooms?success=created`);
});

// ─────────────────────────────
// RATE PLANS
// ─────────────────────────────
router.get('/properties/:pid/rooms/:rid/rates', requireHotelAuth, async (req, res) => {
  const { data: room } = await supabase.from('room_types').select('*, hotel_properties(name, group_id)').eq('id', req.params.rid).single();
  if (!room || room.hotel_properties?.group_id !== req.hotelGroup.id) return res.redirect('/hotel-admin/properties');

  const { data: rates } = await supabase.from('rate_plans').select('*').eq('room_type_id', req.params.rid).order('sort_order');

  const mealLabels = { room_only: 'Room Only', bed_and_breakfast: 'Bed & Breakfast', half_board: 'Half Board', full_board: 'Full Board', all_inclusive: 'All Inclusive' };
  const currencies = ['KES','USD','EUR','TZS','UGX','RWF'];

  const rows = (rates || []).map(r => `
    <tr>
      <td><strong>${r.name}</strong></td>
      <td>${mealLabels[r.meal_plan] || r.meal_plan}</td>
      <td>${r.currency} ${Number(r.price_per_night).toLocaleString()}/night</td>
      <td>${r.season_start ? r.season_start + ' → ' + r.season_end : 'Year-round'}</td>
      <td>${r.is_refundable ? '<span class="badge badge-green">Refundable</span>' : '<span class="badge badge-red">Non-refundable</span>'}</td>
      <td>${r.is_active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Inactive</span>'}</td>
    </tr>
  `).join('');

  res.send(shell('Rate Plans', `
    <div class="breadcrumb">
      <a href="/hotel-admin/properties">Properties</a> ›
      <a href="/hotel-admin/properties/${req.params.pid}/rooms">${room.hotel_properties.name}</a> ›
      ${room.name} › Rate Plans
    </div>
    <div class="page-header">
      <h1 class="page-title">Rate Plans — ${room.name}</h1>
      <div class="section-actions">
        <a href="/hotel-admin/revenue/rates?property=${req.params.pid}" class="btn btn-outline btn-sm">📊 Manage in Revenue</a>
        <button class="btn btn-primary" onclick="openModal('add-rate-modal')">+ Add Rate Plan</button>
      </div>
    </div>
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Name</th><th>Meal Plan</th><th>Price</th><th>Season</th><th>Refundable</th><th>Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No rate plans yet. Add your first rate plan.</div>'}
    </div>

    <div class="modal-overlay" id="add-rate-modal">
      <div class="modal">
        <div class="modal-title">Add Rate Plan</div>
        <form method="POST" action="/hotel-admin/properties/${req.params.pid}/rooms/${req.params.rid}/rates/new">
          <div class="form-group"><label>Rate Plan Name</label><input name="name" required placeholder="BB Peak Season, AI Low Season..."></div>
          <div class="form-row">
            <div class="form-group"><label>Meal Plan</label>
              <select name="meal_plan">
                <option value="room_only">Room Only</option>
                <option value="bed_and_breakfast">Bed & Breakfast</option>
                <option value="half_board">Half Board</option>
                <option value="full_board">Full Board</option>
                <option value="all_inclusive">All Inclusive</option>
              </select>
            </div>
            <div class="form-group"><label>Currency</label>
              <select name="currency">
                ${currencies.map(c => `<option value="${c}" ${c === 'KES' ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>Price Per Night</label><input name="price_per_night" type="number" required min="0" placeholder="5000"></div>
            <div class="form-group"><label>Base Occupancy (adults)</label><input name="base_occupancy" type="number" value="2" min="1"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>Extra Adult Surcharge/night</label><input name="extra_adult_surcharge" type="number" value="0" min="0"></div>
            <div class="form-group"><label>Child Surcharge/night</label><input name="child_surcharge" type="number" value="0" min="0"></div>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px;">Leave season dates empty for a flat year-round rate.</div>
          <div class="form-row">
            <div class="form-group"><label>Season Start (optional)</label><input name="season_start" type="date"></div>
            <div class="form-group"><label>Season End (optional)</label><input name="season_end" type="date"></div>
          </div>
          <div class="form-group">
            <label><input type="checkbox" name="is_refundable" checked> &nbsp;Refundable rate</label>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline" onclick="closeModal('add-rate-modal')">Cancel</button>
            <button type="submit" class="btn btn-primary">Add Rate Plan</button>
          </div>
        </form>
      </div>
    </div>
  `, req.hotelGroup));
});

router.post('/properties/:pid/rooms/:rid/rates/new', requireHotelAuth, async (req, res) => {
  const b = req.body;
  await supabase.from('rate_plans').insert({
    room_type_id:          req.params.rid,
    name:                  b.name,
    meal_plan:             b.meal_plan,
    price_per_night:       parseFloat(b.price_per_night),
    currency:              b.currency || 'KES',
    base_occupancy:        parseInt(b.base_occupancy) || 2,
    extra_adult_surcharge: parseFloat(b.extra_adult_surcharge) || 0,
    child_surcharge:       parseFloat(b.child_surcharge) || 0,
    season_start:          b.season_start || null,
    season_end:            b.season_end || null,
    is_refundable:         b.is_refundable === 'on',
    is_active:             true,
  });
  res.redirect(`/hotel-admin/properties/${req.params.pid}/rooms/${req.params.rid}/rates?success=created`);
});

// ─────────────────────────────
// AVAILABILITY BLOCKS
// ─────────────────────────────
router.get('/properties/:pid/rooms/:rid/availability', requireHotelAuth, async (req, res) => {
  const { data: room } = await supabase.from('room_types').select('*, hotel_properties(name, group_id)').eq('id', req.params.rid).single();
  if (!room || room.hotel_properties?.group_id !== req.hotelGroup.id) return res.redirect('/hotel-admin/properties');

  const { data: blocks } = await supabase
    .from('availability_blocks')
    .select('*')
    .eq('room_type_id', req.params.rid)
    .order('date_from', { ascending: false });

  const rows = (blocks || []).map(b => `
    <tr>
      <td>${b.date_from} → ${b.date_to}</td>
      <td>
        ${b.rooms_available === 0
          ? '<span class="badge badge-red">Sold Out</span>'
          : `<span class="badge badge-green">${b.rooms_available} room(s)</span>`}
      </td>
      <td>${b.notes || '—'}</td>
      <td>
        <form method="POST" action="/hotel-admin/properties/${req.params.pid}/rooms/${req.params.rid}/availability/${b.id}/delete" style="display:inline;">
          <button class="btn btn-red btn-sm">Remove</button>
        </form>
      </td>
    </tr>
  `).join('');

  res.send(shell('Availability', `
    <div class="breadcrumb">
      <a href="/hotel-admin/properties">Properties</a> ›
      <a href="/hotel-admin/properties/${req.params.pid}/rooms">${room.hotel_properties.name}</a> ›
      ${room.name} › Availability
    </div>
    <div class="page-header">
      <h1 class="page-title">Availability — ${room.name}</h1>
      <button class="btn btn-primary" onclick="openModal('add-block-modal')">+ Add Block</button>
    </div>
    <div class="card" style="background:#EEF1F8;border-color:var(--border);margin-bottom:16px;">
      <p style="font-size:12px;color:var(--navy);">
        💡 <strong>How this works:</strong> If no availability block exists for a date range, the room is assumed available.
        Add a block with 0 rooms to mark dates as sold out, or a positive number to cap how many rooms can be booked.
      </p>
    </div>
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Date Range</th><th>Rooms Available</th><th>Notes</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No availability blocks set. All dates are currently open.</div>'}
    </div>

    <div class="modal-overlay" id="add-block-modal">
      <div class="modal">
        <div class="modal-title">Add Availability Block</div>
        <form method="POST" action="/hotel-admin/properties/${req.params.pid}/rooms/${req.params.rid}/availability/new">
          <div class="form-row">
            <div class="form-group"><label>From Date</label><input name="date_from" type="date" required></div>
            <div class="form-group"><label>To Date</label><input name="date_to" type="date" required></div>
          </div>
          <div class="form-group"><label>Rooms Available (0 = sold out)</label><input name="rooms_available" type="number" value="0" min="0" required></div>
          <div class="form-group"><label>Notes (optional)</label><input name="notes" placeholder="Group block, event restriction..."></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline" onclick="closeModal('add-block-modal')">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Block</button>
          </div>
        </form>
      </div>
    </div>
  `, req.hotelGroup));
});

router.post('/properties/:pid/rooms/:rid/availability/new', requireHotelAuth, async (req, res) => {
  const b = req.body;
  await supabase.from('availability_blocks').insert({
    room_type_id:    req.params.rid,
    date_from:       b.date_from,
    date_to:         b.date_to,
    rooms_available: parseInt(b.rooms_available) || 0,
    notes:           b.notes || null,
  });
  res.redirect(`/hotel-admin/properties/${req.params.pid}/rooms/${req.params.rid}/availability?success=created`);
});

router.post('/properties/:pid/rooms/:rid/availability/:bid/delete', requireHotelAuth, async (req, res) => {
  await supabase.from('availability_blocks').delete().eq('id', req.params.bid);
  res.redirect(`/hotel-admin/properties/${req.params.pid}/rooms/${req.params.rid}/availability`);
});

// ─────────────────────────────
// ANCILLARY SERVICES
// ─────────────────────────────
router.get('/properties/:id/ancillaries', requireHotelAuth, async (req, res) => {
  const { data: property } = await supabase.from('hotel_properties').select('*').eq('id', req.params.id).eq('group_id', req.hotelGroup.id).single();
  if (!property) return res.redirect('/hotel-admin/properties');

  const { data: services } = await supabase.from('ancillary_services').select('*').eq('property_id', req.params.id).order('sort_order');

  const categoryIcons = { spa: '💆', transfer: '🚗', dining: '🍽️', activity: '🏄', upgrade: '⬆️', wellness: '🧘', other: '✨' };
  const basisLabels   = { flat: 'flat', per_person: 'per person', per_night: 'per night' };

  const rows = (services || []).map(s => `
    <tr>
      <td>${categoryIcons[s.category] || '✨'} <strong>${s.name}</strong></td>
      <td><span class="badge badge-navy">${s.category}</span></td>
      <td>${property.currency || 'KES'} ${Number(s.price).toLocaleString()} ${basisLabels[s.price_basis] || ''}</td>
      <td>${Array.isArray(s.upsell_tags) ? s.upsell_tags.join(', ') || '—' : '—'}</td>
      <td>${s.is_active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Inactive</span>'}</td>
      <td>
        <form method="POST" action="/hotel-admin/properties/${req.params.id}/ancillaries/${s.id}/toggle" style="display:inline;">
          <button class="btn btn-outline btn-sm">${s.is_active ? 'Deactivate' : 'Activate'}</button>
        </form>
      </td>
    </tr>
  `).join('');

  res.send(shell('Add-on Services', `
    <div class="breadcrumb"><a href="/hotel-admin/properties">Properties</a> › ${property.name} › Add-on Services</div>
    <div class="page-header">
      <h1 class="page-title">Add-on Services — ${property.name}</h1>
      <button class="btn btn-primary" onclick="openModal('add-service-modal')">+ Add Service</button>
    </div>
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Service</th><th>Category</th><th>Price</th><th>Tags</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No add-on services yet. Add spa, transfers, dining packages and activities here.</div>'}
    </div>

    <div class="modal-overlay" id="add-service-modal">
      <div class="modal">
        <div class="modal-title">Add Service / Add-on</div>
        <form method="POST" action="/hotel-admin/properties/${req.params.id}/ancillaries/new">
          <div class="form-group"><label>Service Name</label><input name="name" required placeholder="Couples Spa Package, Airport Transfer..."></div>
          <div class="form-group"><label>Description</label><textarea name="description" placeholder="What's included..."></textarea></div>
          <div class="form-row">
            <div class="form-group"><label>Category</label>
              <select name="category">
                <option value="spa">💆 Spa</option>
                <option value="transfer">🚗 Transfer</option>
                <option value="dining">🍽️ Dining</option>
                <option value="activity">🏄 Activity</option>
                <option value="upgrade">⬆️ Upgrade</option>
                <option value="wellness">🧘 Wellness</option>
                <option value="other">✨ Other</option>
              </select>
            </div>
            <div class="form-group"><label>Price Basis</label>
              <select name="price_basis">
                <option value="flat">Flat (one price total)</option>
                <option value="per_person">Per person</option>
                <option value="per_night">Per night</option>
              </select>
            </div>
          </div>
          <div class="form-group"><label>Price (${property.currency || 'KES'})</label><input name="price" type="number" required min="0" placeholder="2500"></div>
          <div class="form-group">
            <label>Upsell Tags — who to show this to</label>
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
              ${['honeymoon','family','business','spa','transfer','adventure','wellness','upgrade','romantic'].map(tag =>
                `<label style="display:flex;align-items:center;gap:4px;font-size:12px;text-transform:none;letter-spacing:0;">
                  <input type="checkbox" name="tags" value="${tag}"> ${tag}
                </label>`
              ).join('')}
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline" onclick="closeModal('add-service-modal')">Cancel</button>
            <button type="submit" class="btn btn-primary">Add Service</button>
          </div>
        </form>
      </div>
    </div>
  `, req.hotelGroup));
});

router.post('/properties/:id/ancillaries/new', requireHotelAuth, async (req, res) => {
  const b = req.body;
  const tags = Array.isArray(b.tags) ? b.tags : (b.tags ? [b.tags] : []);
  await supabase.from('ancillary_services').insert({
    property_id:  req.params.id,
    name:         b.name,
    description:  b.description || null,
    category:     b.category,
    price:        parseFloat(b.price),
    price_basis:  b.price_basis,
    upsell_tags:  tags,
    is_active:    true,
  });
  res.redirect(`/hotel-admin/properties/${req.params.id}/ancillaries?success=created`);
});

router.post('/properties/:id/ancillaries/:sid/toggle', requireHotelAuth, async (req, res) => {
  const { data: s } = await supabase.from('ancillary_services').select('is_active').eq('id', req.params.sid).single();
  if (s) await supabase.from('ancillary_services').update({ is_active: !s.is_active }).eq('id', req.params.sid);
  res.redirect(`/hotel-admin/properties/${req.params.id}/ancillaries`);
});

// ─────────────────────────────
// RESERVATIONS — list + detail
// ─────────────────────────────
router.get('/reservations', requireHotelAuth, async (req, res) => {
  const status = req.query.status || 'all';
  let query = supabase
    .from('hotel_reservations')
    .select('*, hotel_properties(name), room_types(name)')
    .eq('group_id', req.hotelGroup.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (status !== 'all') query = query.eq(status === 'unpaid' ? 'payment_status' : 'status', status === 'unpaid' ? 'pending' : status);

  const { data: reservations } = await query;
  const currency = req.hotelGroup.currency || 'KES';

  const filterBtns = ['all','confirmed','paid','cancelled'].map(s =>
    `<a href="/hotel-admin/reservations?status=${s}" class="btn ${status === s ? 'btn-primary' : 'btn-outline'} btn-sm">${s.charAt(0).toUpperCase() + s.slice(1)}</a>`
  ).join('');

  const rows = (reservations || []).map(r => `
    <tr>
      <td><a href="/hotel-admin/reservations/${r.reservation_ref}" style="color:var(--navy);font-weight:700;">${r.reservation_ref}</a></td>
      <td>${r.guest_name}<br><span style="font-size:11px;color:var(--muted);">${r.guest_phone || ''}</span></td>
      <td>${r.hotel_properties?.name || ''}<br><span style="font-size:11px;color:var(--muted);">${r.room_types?.name || ''}</span></td>
      <td>${r.check_in}<br><span style="font-size:11px;color:var(--muted);">${r.nights} night(s)</span></td>
      <td><strong>${r.currency || currency} ${Number(r.gross_amount).toLocaleString()}</strong></td>
      <td>${statusBadge(r.status)}</td>
      <td>${paymentBadge(r.payment_status)}</td>
      <td>
        <a href="/hotel-admin/reservations/${r.reservation_ref}" class="btn btn-outline btn-sm">View</a>
        ${r.payment_status === 'pending' && r.status !== 'cancelled' ? `
          <form method="POST" action="/hotel-admin/reservations/${r.reservation_ref}/mark-paid" style="display:inline;">
            <button class="btn btn-green btn-sm">Mark Paid</button>
          </form>` : ''}
      </td>
    </tr>
  `).join('');

  res.send(shell('Reservations', `
    <div class="page-header">
      <h1 class="page-title">Reservations</h1>
      <div class="section-actions">${filterBtns}</div>
    </div>
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Ref</th><th>Guest</th><th>Room</th><th>Check-in</th><th>Amount</th><th>Status</th><th>Payment</th><th>Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      ` : '<div class="empty">No reservations found.</div>'}
    </div>
  `, req.hotelGroup));
});

router.get('/reservations/:ref', requireHotelAuth, async (req, res) => {
  const { data: r } = await supabase
    .from('hotel_reservations')
    .select('*, hotel_groups(name), hotel_properties(name, address, check_in_time, check_out_time), room_types(name, bed_type, view), rate_plans(name, meal_plan)')
    .eq('reservation_ref', req.params.ref)
    .eq('group_id', req.hotelGroup.id)
    .single();

  if (!r) return res.redirect('/hotel-admin/reservations');

  const ancillaryLines = Array.isArray(r.ancillary_services) && r.ancillary_services.length > 0
    ? r.ancillary_services.map(a => `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--border);">
          <span>${a.name}</span>
          <span>${r.currency} ${Number(a.price).toLocaleString()}</span>
        </div>`).join('')
    : '<div style="color:var(--muted);font-size:12px;">No add-ons selected</div>';

  res.send(shell(`Reservation ${r.reservation_ref}`, `
    <div class="breadcrumb"><a href="/hotel-admin/reservations">Reservations</a> › ${r.reservation_ref}</div>
    <div class="page-header">
      <h1 class="page-title">Reservation ${r.reservation_ref}</h1>
      <div class="section-actions">
        ${r.payment_status === 'pending' && r.status !== 'cancelled' ? `
          <form method="POST" action="/hotel-admin/reservations/${r.reservation_ref}/mark-paid">
            <input name="payment_reference" placeholder="M-Pesa / card ref (optional)" style="display:inline;width:200px;">
            <button class="btn btn-green">✓ Mark as Paid</button>
          </form>` : ''}
        ${r.status !== 'cancelled' ? `
          <form method="POST" action="/hotel-admin/reservations/${r.reservation_ref}/cancel">
            <button class="btn btn-red" onclick="return confirm('Cancel this reservation?')">Cancel</button>
          </form>` : ''}
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
      <div class="card">
        <div class="card-title">Guest Details</div>
        <p><strong>${r.guest_name}</strong></p>
        <p style="margin-top:6px;font-size:13px;color:var(--muted);">${r.guest_phone || 'No phone'}</p>
        <p style="font-size:13px;color:var(--muted);">${r.guest_email || 'No email'}</p>
        ${r.special_requests ? `<p style="margin-top:10px;font-size:12px;background:var(--cream);padding:8px;border-radius:6px;">${r.special_requests}</p>` : ''}
      </div>
      <div class="card">
        <div class="card-title">Status</div>
        <p>${statusBadge(r.status)} &nbsp; ${paymentBadge(r.payment_status)}</p>
        ${r.payment_reference ? `<p style="margin-top:8px;font-size:12px;color:var(--muted);">Payment ref: ${r.payment_reference}</p>` : ''}
        <p style="margin-top:8px;font-size:12px;color:var(--muted);">Booked via: ${r.channel} · ${new Date(r.created_at).toLocaleDateString()}</p>
      </div>
      <div class="card">
        <div class="card-title">Stay Details</div>
        <p><strong>${r.hotel_properties?.name || ''}</strong></p>
        <p style="font-size:13px;margin-top:4px;">${r.room_types?.name || ''} ${r.room_types?.view ? '— ' + r.room_types.view : ''}</p>
        <p style="font-size:13px;color:var(--muted);">Bed: ${r.room_types?.bed_type || '—'}</p>
        <p style="font-size:13px;color:var(--muted);margin-top:8px;">
          Check-in: <strong>${r.check_in}</strong> from ${r.hotel_properties?.check_in_time || '14:00'}<br>
          Check-out: <strong>${r.check_out}</strong> by ${r.hotel_properties?.check_out_time || '11:00'}<br>
          ${r.nights} night(s) · ${r.adults} adult(s), ${r.children || 0} child(ren)
        </p>
        <p style="font-size:13px;margin-top:8px;">Meal plan: <strong>${r.rate_plans?.meal_plan || r.meal_plan || 'Room only'}</strong></p>
      </div>
      <div class="card">
        <div class="card-title">Pricing</div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed var(--border);">
          <span>Room total</span><span>${r.currency} ${Number(r.room_total).toLocaleString()}</span>
        </div>
        ${ancillaryLines}
        <div style="display:flex;justify-content:space-between;padding:8px 0;font-size:16px;font-weight:700;color:var(--navy);">
          <span>Total</span><span>${r.currency} ${Number(r.gross_amount).toLocaleString()}</span>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--muted);">
          Bodrless commission (${(r.commission_rate * 100).toFixed(1)}%): ${r.currency} ${Number(r.commission_amount).toLocaleString()} — invoiced monthly
        </div>
      </div>
    </div>
  `, req.hotelGroup));
});

router.post('/reservations/:ref/mark-paid', requireHotelAuth, async (req, res) => {
  const result = await hotelDirectBookingService.markPaid({
    reservationRef:   req.params.ref,
    paymentReference: req.body.payment_reference || null,
    markedBy:         'hotel_admin',
  });
  res.redirect(`/hotel-admin/reservations/${req.params.ref}?${result.success ? 'success=paid' : 'error=1'}`);
});

router.post('/reservations/:ref/cancel', requireHotelAuth, async (req, res) => {
  await hotelDirectBookingService.cancelReservation({
    reservationRef: req.params.ref,
    reason:         req.body.reason || 'Cancelled by hotel',
    cancelledBy:    'hotel_admin',
  });
  res.redirect(`/hotel-admin/reservations/${req.params.ref}`);
});

// ─────────────────────────────
// COMMISSION
// ─────────────────────────────
router.get('/commission', requireHotelAuth, async (req, res) => {
  const groupId = req.hotelGroup.id;

  const [{ data: ledger }, { data: invoices }] = await Promise.all([
    supabase.from('commission_ledger').select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(50),
    supabase.from('commission_invoices').select('*').eq('group_id', groupId).order('period', { ascending: false }),
  ]);

  const pendingTotal = (ledger || []).filter(l => l.status === 'pending').reduce((s, l) => s + Number(l.commission_amount), 0);
  const currency = req.hotelGroup.currency || 'KES';
  const commissionRate = req.hotelGroup.commission_rate || 0.05;

  const ledgerRows = (ledger || []).map(l => `
    <tr>
      <td>${l.reservation_ref}</td>
      <td>${l.period}</td>
      <td>${l.currency} ${Number(l.gross_amount).toLocaleString()}</td>
      <td>${(l.commission_rate * 100).toFixed(1)}%</td>
      <td><strong>${l.currency} ${Number(l.commission_amount).toLocaleString()}</strong></td>
      <td>${l.status === 'pending' ? '<span class="badge badge-amber">Pending</span>' : l.status === 'paid' ? '<span class="badge badge-green">Paid</span>' : '<span class="badge badge-navy">' + l.status + '</span>'}</td>
    </tr>
  `).join('');

  const invoiceRows = (invoices || []).map(inv => `
    <tr>
      <td>${inv.period}</td>
      <td>${inv.total_bookings}</td>
      <td>${inv.currency} ${Number(inv.gross_total).toLocaleString()}</td>
      <td><strong>${inv.currency} ${Number(inv.commission_total).toLocaleString()}</strong></td>
      <td>${inv.status === 'paid' ? '<span class="badge badge-green">Paid</span>' : inv.status === 'sent' ? '<span class="badge badge-amber">Sent</span>' : '<span class="badge badge-navy">Pending</span>'}</td>
      <td>${inv.due_date || '—'}</td>
    </tr>
  `).join('');

  res.send(shell('Commission', `
    <div class="page-header"><h1 class="page-title">Commission</h1></div>
    <div class="stat-grid">
      <div class="stat red">
        <div class="stat-value">${currency} ${Math.round(pendingTotal).toLocaleString()}</div>
        <div class="stat-label">Commission Owed (pending invoices)</div>
      </div>
      <div class="stat">
        <div class="stat-value">${(commissionRate * 100).toFixed(1)}%</div>
        <div class="stat-label">Current Commission Rate</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Invoices</div>
      ${invoiceRows.length ? `
        <table>
          <thead><tr><th>Period</th><th>Bookings</th><th>Gross Revenue</th><th>Commission</th><th>Status</th><th>Due Date</th></tr></thead>
          <tbody>${invoiceRows}</tbody>
        </table>
      ` : '<div class="empty">No invoices yet. Invoices are generated monthly by Bodrless.</div>'}
    </div>
    <div class="card">
      <div class="card-title">Commission Ledger</div>
      ${ledgerRows.length ? `
        <table>
          <thead><tr><th>Reservation</th><th>Period</th><th>Gross Amount</th><th>Rate</th><th>Commission</th><th>Status</th></tr></thead>
          <tbody>${ledgerRows}</tbody>
        </table>
      ` : '<div class="empty">No commission entries yet.</div>'}
    </div>
  `, req.hotelGroup));
});

// ─────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────
function statusBadge(status) {
  const map = { confirmed: 'badge-green', paid: 'badge-green', pending: 'badge-amber', cancelled: 'badge-red', no_show: 'badge-red' };
  return `<span class="badge ${map[status] || 'badge-navy'}">${status || 'unknown'}</span>`;
}

function paymentBadge(status) {
  const map = { paid: 'badge-green', pending: 'badge-amber', refunded: 'badge-navy', waived: 'badge-navy' };
  return `<span class="badge ${map[status] || 'badge-navy'}">${status || 'unknown'}</span>`;
}

module.exports = router;