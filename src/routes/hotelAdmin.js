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
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const hotelDirectBookingService = require('../services/hotelDirectBookingService');

// ─────────────────────────────
// AUTH MIDDLEWARE
// Every /hotel-admin/* route (except /login) requires a valid
// hotel token in the cookie. Sets req.hotelGroup on success.
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
// SHARED HTML SHELL
// Every page wraps in this shell — consistent nav, branding,
// no external framework needed.
// ─────────────────────────────
function shell(title, body, group = null) {
  const nav = group ? `
    <nav class="nav">
      <div class="nav-brand">
        <span class="nav-logo">🏨</span>
        <span>${group.name}</span>
      </div>
      <div class="nav-links">
        <a href="/hotel-admin/dashboard">Dashboard</a>
        <a href="/hotel-admin/properties">Properties</a>
        <a href="/hotel-admin/reservations">Reservations</a>
        <a href="/hotel-admin/commission">Commission</a>
        <a href="/hotel-admin/logout" class="nav-logout">Logout</a>
      </div>
    </nav>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Bodrless Hotels</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --navy: #1E2A5E; --red: #C0392B; --white: #fff;
      --cream: #F8F9FC; --border: #E4E8F0; --muted: #8892A4;
      --green: #27ae60; --amber: #f0ad4e; --radius: 10px;
    }
    body { font-family: Arial, sans-serif; background: var(--cream); color: var(--navy); min-height: 100vh; }
    .nav { background: var(--navy); padding: 0 24px; display: flex; align-items: center; justify-content: space-between; height: 56px; border-bottom: 3px solid var(--red); }
    .nav-brand { display: flex; align-items: center; gap: 10px; color: white; font-weight: 700; font-size: 15px; }
    .nav-logo { font-size: 20px; }
    .nav-links { display: flex; align-items: center; gap: 20px; }
    .nav-links a { color: rgba(255,255,255,0.8); text-decoration: none; font-size: 13px; }
    .nav-links a:hover { color: white; }
    .nav-logout { background: var(--red) !important; color: white !important; padding: 6px 14px; border-radius: 20px; font-size: 12px !important; }
    .page { max-width: 1100px; margin: 0 auto; padding: 28px 20px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    .page-title { font-size: 22px; font-weight: 700; color: var(--navy); }
    .card { background: white; border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
    .card-title { font-size: 14px; font-weight: 700; color: var(--navy); margin-bottom: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .stat { background: white; border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; border-top: 3px solid var(--navy); }
    .stat-value { font-size: 26px; font-weight: 700; color: var(--navy); }
    .stat-label { font-size: 11px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .stat.green { border-top-color: var(--green); }
    .stat.red   { border-top-color: var(--red); }
    .stat.amber { border-top-color: var(--amber); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 10px 12px; font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid var(--border); }
    td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: var(--cream); }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; }
    .badge-green  { background: #E8F8EE; color: #1B7A3D; }
    .badge-amber  { background: #FFF3E0; color: #B05A00; }
    .badge-red    { background: #FDECEA; color: var(--red); }
    .badge-navy   { background: #EEF1F8; color: var(--navy); }
    .btn { display: inline-block; padding: 9px 18px; border-radius: 20px; border: none; cursor: pointer; font-size: 12px; font-weight: 700; text-decoration: none; }
    .btn-primary   { background: var(--navy); color: white; }
    .btn-red       { background: var(--red); color: white; }
    .btn-green     { background: var(--green); color: white; }
    .btn-outline   { background: white; color: var(--navy); border: 1.5px solid var(--border); }
    .btn-sm        { padding: 5px 12px; font-size: 11px; }
    .btn:hover     { opacity: 0.88; }
    form { display: flex; flex-direction: column; gap: 14px; }
    .form-group { display: flex; flex-direction: column; gap: 5px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    label { font-size: 11px; font-weight: 700; color: var(--navy); text-transform: uppercase; letter-spacing: 0.4px; }
    input, select, textarea {
      padding: 10px 12px; border: 1.5px solid var(--border); border-radius: 8px;
      font-size: 13px; color: var(--navy); background: var(--cream); outline: none;
    }
    input:focus, select:focus, textarea:focus { border-color: var(--navy); }
    textarea { min-height: 80px; resize: vertical; }
    .alert { padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; }
    .alert-success { background: #E8F8EE; color: #1B7A3D; border: 1px solid #B2DFCA; }
    .alert-error   { background: #FDECEA; color: var(--red); border: 1px solid #F5C6C2; }
    .empty { text-align: center; padding: 40px; color: var(--muted); font-size: 13px; }
    .breadcrumb { font-size: 12px; color: var(--muted); margin-bottom: 16px; }
    .breadcrumb a { color: var(--navy); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .section-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.open { display: flex; }
    .modal { background: white; border-radius: var(--radius); padding: 24px; width: 90%; max-width: 520px; max-height: 90vh; overflow-y: auto; }
    .modal-title { font-size: 16px; font-weight: 700; margin-bottom: 18px; }
    .modal-actions { display: flex; gap: 8px; margin-top: 18px; justify-content: flex-end; }
  </style>
</head>
<body>
${nav}
<div class="page">
${body}
</div>
<script>
function openModal(id) { document.getElementById(id).classList.add('open'); }
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
  res.send(shell('Login', `
    <div style="max-width:400px;margin:80px auto;">
      <div style="text-align:center;margin-bottom:28px;">
        <div style="font-size:40px;">🏨</div>
        <h2 style="color:var(--navy);margin-top:8px;">Bodrless Hotel Portal</h2>
        <p style="color:var(--muted);font-size:13px;margin-top:6px;">Sign in with your hotel access key</p>
      </div>
      ${error ? '<div class="alert alert-error">Invalid access key. Please try again or contact Bodrless support.</div>' : ''}
      <div class="card">
        <form method="POST" action="/hotel-admin/login">
          <div class="form-group">
            <label>Hotel Access Key</label>
            <input type="password" name="token" placeholder="Your hotel access key" required autofocus>
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;justify-content:center;">Sign In</button>
        </form>
      </div>
      <p style="text-align:center;font-size:11px;color:var(--muted);margin-top:16px;">
        Need access? Contact <a href="mailto:support@bodrless.com" style="color:var(--navy);">support@bodrless.com</a>
      </p>
    </div>
  `));
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
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
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
router.get('/dashboard', requireHotelAuth, async (req, res) => {
  const groupId = req.hotelGroup.id;
  const currency = 'KES';

  // Fetch summary stats
  const [{ data: reservations }, { data: pending }, { data: ledger }] = await Promise.all([
    supabase.from('hotel_reservations').select('gross_amount, status, payment_status, created_at').eq('group_id', groupId),
    supabase.from('hotel_reservations').select('id').eq('group_id', groupId).eq('payment_status', 'pending').neq('status', 'cancelled'),
    supabase.from('commission_ledger').select('commission_amount, status').eq('group_id', groupId),
  ]);

  const totalRevenue   = (reservations || []).filter(r => r.payment_status === 'paid').reduce((s, r) => s + Number(r.gross_amount), 0);
  const pendingCount   = (pending || []).length;
  const commissionOwed = (ledger || []).filter(l => l.status === 'pending').reduce((s, l) => s + Number(l.commission_amount), 0);
  const totalBookings  = (reservations || []).filter(r => r.status !== 'cancelled').length;

  // Recent reservations
  const { data: recent } = await supabase
    .from('hotel_reservations')
    .select('reservation_ref, guest_name, guest_phone, check_in, check_out, nights, gross_amount, status, payment_status, channel, created_at, hotel_properties(name)')
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(10);

  const recentRows = (recent || []).map(r => `
    <tr>
      <td><strong>${r.reservation_ref}</strong></td>
      <td>${r.guest_name}<br><span style="color:var(--muted);font-size:11px;">${r.guest_phone || ''}</span></td>
      <td>${r.hotel_properties?.name || ''}</td>
      <td>${r.check_in} → ${r.check_out}<br><span style="color:var(--muted);font-size:11px;">${r.nights} night(s)</span></td>
      <td><strong>${currency} ${Number(r.gross_amount).toLocaleString()}</strong></td>
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

  res.send(shell('Dashboard', `
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <span style="font-size:12px;color:var(--muted);">Welcome back, ${req.hotelGroup.name}</span>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="stat-value">${totalBookings}</div>
        <div class="stat-label">Total Bookings</div>
      </div>
      <div class="stat green">
        <div class="stat-value">${currency} ${Math.round(totalRevenue).toLocaleString()}</div>
        <div class="stat-label">Total Revenue</div>
      </div>
      <div class="stat amber">
        <div class="stat-value">${pendingCount}</div>
        <div class="stat-label">Awaiting Payment</div>
      </div>
      <div class="stat red">
        <div class="stat-value">${currency} ${Math.round(commissionOwed).toLocaleString()}</div>
        <div class="stat-label">Commission Owed</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Recent Reservations</div>
      ${recentRows.length ? `
        <table>
          <thead><tr>
            <th>Ref</th><th>Guest</th><th>Property</th>
            <th>Dates</th><th>Amount</th><th>Status</th><th>Payment</th><th>Action</th>
          </tr></thead>
          <tbody>${recentRows}</tbody>
        </table>
      ` : '<div class="empty">No reservations yet.</div>'}
    </div>
  `, req.hotelGroup));
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

  const rows = (properties || []).map(p => `
    <tr>
      <td><strong>${p.name}</strong><br><span style="color:var(--muted);font-size:11px;">${p.slug}</span></td>
      <td>${p.destination}</td>
      <td>${p.location || '—'}</td>
      <td>${p.stars ? '⭐'.repeat(p.stars) : '—'}</td>
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
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Name</th><th>Destination</th><th>Location</th><th>Stars</th><th>Inventory</th><th>Status</th><th>Actions</th></tr></thead>
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
  await supabase.from('hotel_properties').insert({
    group_id: req.hotelGroup.id,
    name: b.name, slug: b.slug, destination: b.destination,
    location: b.location, address: b.address,
    stars: parseInt(b.stars) || null,
    description: b.description,
    currency: b.currency || 'KES',
    check_in_time: b.check_in_time || '14:00',
    check_out_time: b.check_out_time || '11:00',
    is_active: b.is_active === 'on',
  });
  res.redirect('/hotel-admin/properties?success=created');
});

router.post('/properties/:id/edit', requireHotelAuth, async (req, res) => {
  const b = req.body;
  await supabase.from('hotel_properties').update({
    name: b.name, destination: b.destination,
    location: b.location, address: b.address,
    stars: parseInt(b.stars) || null,
    description: b.description,
    currency: b.currency || 'KES',
    check_in_time: b.check_in_time || '14:00',
    check_out_time: b.check_out_time || '11:00',
    is_active: b.is_active === 'on',
  }).eq('id', req.params.id).eq('group_id', req.hotelGroup.id);
  res.redirect('/hotel-admin/properties?success=updated');
});

function propertyForm(p, group) {
  const v = p || {};
  return `
    <div class="breadcrumb"><a href="/hotel-admin/properties">Properties</a> › ${p ? 'Edit' : 'New Property'}</div>
    <div class="page-header"><h1 class="page-title">${p ? 'Edit Property' : 'Add Property'}</h1></div>
    <div class="card">
      <form method="POST" action="/hotel-admin/properties/${p ? p.id + '/edit' : 'new'}">
        <div class="form-row">
          <div class="form-group"><label>Property Name</label><input name="name" value="${v.name || ''}" required placeholder="Sarova Stanley"></div>
          <div class="form-group"><label>Slug (URL-safe ID)</label><input name="slug" value="${v.slug || ''}" ${p ? 'readonly' : 'required'} placeholder="sarova-stanley"></div>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Destination City</label><input name="destination" value="${v.destination || ''}" required placeholder="Nairobi"></div>
          <div class="form-group"><label>Stars</label>
            <select name="stars">
              ${[1,2,3,4,5].map(s => `<option value="${s}" ${v.stars == s ? 'selected' : ''}>${s} Star${s>1?'s':''}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group"><label>Location / Neighbourhood</label><input name="location" value="${v.location || ''}" placeholder="Corner of Kimathi St & Kenyatta Ave"></div>
        <div class="form-group"><label>Full Address</label><input name="address" value="${v.address || ''}" placeholder="Harry Thuku Rd, Nairobi"></div>
        <div class="form-group"><label>Description</label><textarea name="description">${v.description || ''}</textarea></div>
        <div class="form-row">
          <div class="form-group"><label>Currency</label>
            <select name="currency">
              <option value="KES" ${v.currency === 'KES' || !v.currency ? 'selected' : ''}>KES — Kenyan Shilling</option>
              <option value="USD" ${v.currency === 'USD' ? 'selected' : ''}>USD — US Dollar</option>
              <option value="EUR" ${v.currency === 'EUR' ? 'selected' : ''}>EUR — Euro</option>
              <option value="TZS" ${v.currency === 'TZS' ? 'selected' : ''}>TZS — Tanzanian Shilling</option>
              <option value="UGX" ${v.currency === 'UGX' ? 'selected' : ''}>UGX — Ugandan Shilling</option>
              <option value="RWF" ${v.currency === 'RWF' ? 'selected' : ''}>RWF — Rwandan Franc</option>
            </select>
          </div>
          <div class="form-group"><label>Check-in Time</label><input name="check_in_time" value="${v.check_in_time || '14:00'}" placeholder="14:00"></div>
          <div class="form-group"><label>Check-out Time</label><input name="check_out_time" value="${v.check_out_time || '11:00'}" placeholder="11:00"></div>
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
    ${success ? '<div class="alert alert-success">Room type saved successfully.</div>' : ''}
    <div class="card">
      ${rows.length ? `
        <table>
          <thead><tr><th>Name</th><th>Bed Type</th><th>View</th><th>Capacity</th><th>Size</th><th>Status</th><th>Actions</th></tr></thead>
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
    property_id: req.params.id,
    name: b.name, slug: b.slug, description: b.description,
    bed_type: b.bed_type, view: b.view,
    max_adults: parseInt(b.max_adults) || 2,
    max_children: parseInt(b.max_children) || 2,
    max_occupancy: (parseInt(b.max_adults) || 2) + (parseInt(b.max_children) || 2),
    size_sqm: parseFloat(b.size_sqm) || null,
    is_active: true,
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

  const currencies = ['KES','USD','EUR','TZS','UGX','RWF'];

  res.send(shell('Rate Plans', `
    <div class="breadcrumb">
      <a href="/hotel-admin/properties">Properties</a> ›
      <a href="/hotel-admin/properties/${req.params.pid}/rooms">${room.hotel_properties.name}</a> ›
      ${room.name} › Rate Plans
    </div>
    <div class="page-header">
      <h1 class="page-title">Rate Plans — ${room.name}</h1>
      <button class="btn btn-primary" onclick="openModal('add-rate-modal')">+ Add Rate Plan</button>
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
              <select name="meal_plan" id="meal-plan-select">
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
  const basisLabels = { flat: 'flat', per_person: 'per person', per_night: 'per night' };

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
              ${['honeymoon','family','business','spa','transfer','adventure','wellness'].map(tag =>
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

  const filterBtns = ['all','confirmed','paid','cancelled'].map(s =>
    `<a href="/hotel-admin/reservations?status=${s}" class="btn ${status === s ? 'btn-primary' : 'btn-outline'} btn-sm">${s.charAt(0).toUpperCase() + s.slice(1)}</a>`
  ).join('');

  const rows = (reservations || []).map(r => `
    <tr>
      <td><a href="/hotel-admin/reservations/${r.reservation_ref}" style="color:var(--navy);font-weight:700;">${r.reservation_ref}</a></td>
      <td>${r.guest_name}<br><span style="font-size:11px;color:var(--muted);">${r.guest_phone || ''}</span></td>
      <td>${r.hotel_properties?.name || ''}<br><span style="font-size:11px;color:var(--muted);">${r.room_types?.name || ''}</span></td>
      <td>${r.check_in}<br><span style="font-size:11px;color:var(--muted);">${r.nights} night(s)</span></td>
      <td><strong>${r.currency} ${Number(r.gross_amount).toLocaleString()}</strong></td>
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
            <input name="payment_reference" placeholder="M-Pesa / card ref (optional)" class="name-input" style="display:inline;width:200px;">
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
        <div class="stat-value">5%</div>
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