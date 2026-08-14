/**
 * AGENCY ROUTES
 * ─────────────────────────────────────────────
 * Self-service agency signup and management
 *
 * Public:             /register, /signup, /login, /forgot-password
 * Session-protected:  /me, /logout, /dashboard, /settings, /ask,
 *                     /trips, /trips/:id/events, /trips/:id/resolve,
 *                     /searches, /conversations
 * API-key-protected:  /:agencyId/regenerate-key, /whatsapp/:agencyId
 * ─────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const crypto = require('crypto');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const { authenticateAgency } = require('../middleware/auth');
const { authenticateSession } = require('../middleware/authSession');
const dataQueryService = require('../services/dataQueryService');
const emailService = require('../services/emailService');

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
const generateApiKey = (agencyId) => {
  const random = crypto.randomBytes(32).toString('hex');
  return `bdr_${agencyId}_${random}`;
};

const generateAgencyId = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 40);
};

// ─────────────────────────────────────────────
// PUBLIC — REGISTER
// ─────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const schema = Joi.object({
    name:             Joi.string().min(2).max(100).required(),
    email:            Joi.string().email().required(),
    phone:            Joi.string().optional().allow(''),
    website:          Joi.string().uri().optional().allow(''),
    contactPerson:    Joi.string().optional().allow(''),
    markupPercentage: Joi.number().min(0).max(50).default(0),
    plan:             Joi.string().valid('starter', 'growth', 'enterprise').default('starter'),
    password:         Joi.string().min(8).required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    const agencyId  = generateAgencyId(value.name);
    const apiKey    = generateApiKey(agencyId);
    const widgetKey = agencyId;

    const { data: existing } = await supabase
      .from('agencies')
      .select('id')
      .or(`email.eq.${value.email},id.eq.${agencyId}`)
      .maybeSingle();

    if (existing) return res.status(409).json({ success: false, error: 'An agency with this name or email already exists' });

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: value.email, password: value.password, email_confirm: true,
      user_metadata: { agency_id: agencyId, agency_name: value.name, contact_person: value.contactPerson || '', role: 'agency' },
    });
    if (authError) return res.status(400).json({ success: false, error: authError.message });

    const authUserId = authData.user.id;

    const { data: agency, error: insertError } = await supabase
      .from('agencies')
      .insert({ id: agencyId, name: value.name, email: value.email, phone: value.phone || null, website: value.website || null, api_key: apiKey, widget_key: widgetKey, plan: value.plan, status: 'active', markup_percentage: value.markupPercentage, markup_type: 'percentage', role: 'agency', created_at: new Date().toISOString() })
      .select().single();

    if (insertError) { await supabase.auth.admin.deleteUser(authUserId); throw insertError; }

    const { error: profileError } = await supabase.from('profiles').insert({ id: authUserId, agency_id: agencyId, role: 'agency', created_at: new Date().toISOString() });
    if (profileError) logger.error('Profile insert failed', { error: profileError.message });

    logger.info('New agency registered', { agencyId, name: value.name });

    const widgetCode      = `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${widgetKey}&name=${encodeURIComponent(value.name)}"></script>`;
    const whatsappWebhook = `https://bodrless-api-v2.onrender.com/api/webhooks/whatsapp?agency_id=${agencyId}`;

    emailService.sendOnboardingEmail({ agencyName: agency.name, agencyEmail: agency.email, widgetCode, whatsappWebhook, plan: agency.plan })
      .then(result => { if (!result.success) logger.warn('Onboarding email did not send', { agencyId, error: result.error }); })
      .catch(err => logger.error('Onboarding email dispatch threw', { agencyId, error: err.message }));

    return res.status(201).json({ success: true, message: 'Agency registered successfully', agency: { id: agency.id, name: agency.name, email: agency.email, plan: agency.plan, markupPercentage: agency.markup_percentage, status: agency.status }, credentials: { apiKey, widgetKey }, integration: { widgetCode, whatsappWebhook } });
  } catch (err) {
    logger.error('Agency registration error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUBLIC — LOGIN
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const schema = Joi.object({ email: Joi.string().email().required(), password: Joi.string().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    const { data, error: authError } = await supabase.auth.signInWithPassword({ email: value.email, password: value.password });
    if (authError) return res.status(401).json({ success: false, error: 'Invalid email or password' });

    const { data: profile } = await supabase.from('profiles').select('agency_id, role').eq('id', data.user.id).single();
    if (!profile) return res.status(403).json({ success: false, error: 'No agency linked to this account' });

    const { data: agency } = await supabase.from('agencies').select('id, name, email, plan, status, markup_percentage, widget_key').eq('id', profile.agency_id).single();
    if (agency?.status !== 'active') return res.status(403).json({ success: false, error: 'This agency account is not active' });

    logger.info('Agency login', { agencyId: agency.id });
    return res.json({ success: true, session: { accessToken: data.session.access_token, refreshToken: data.session.refresh_token, expiresAt: data.session.expires_at }, agency: { id: agency.id, name: agency.name, email: agency.email, plan: agency.plan, markupPercentage: agency.markup_percentage, widgetKey: agency.widget_key } });
  } catch (err) {
    logger.error('Agency login error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// PUBLIC — FORGOT PASSWORD
// ─────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const schema = Joi.object({ email: Joi.string().email().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  try {
    await supabase.auth.resetPasswordForEmail(value.email, { redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL || 'https://your-lovable-app.com/reset-password' });
    return res.json({ success: true, message: 'If an account exists with that email, a password reset link has been sent.' });
  } catch (err) {
    return res.json({ success: true, message: 'If an account exists with that email, a password reset link has been sent.' });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — WHO AM I
// ─────────────────────────────────────────────
router.get('/me', authenticateSession, async (req, res) => {
  try {
    const { data: agency } = await supabase.from('agencies').select('id, name, email, phone, website, plan, status, markup_percentage, widget_key, whatsapp_phone_number_id').eq('id', req.agencyId).single();
    if (!agency) return res.status(404).json({ success: false, error: 'Agency not found' });
    return res.json({ success: true, agency: { id: agency.id, name: agency.name, email: agency.email, phone: agency.phone, website: agency.website, plan: agency.plan, status: agency.status, markupPercentage: agency.markup_percentage, widgetKey: agency.widget_key, widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`, whatsappConfigured: !!agency.whatsapp_phone_number_id } });
  } catch (err) {
    logger.error('Get current agency error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — LOGOUT
// ─────────────────────────────────────────────
router.post('/logout', authenticateSession, async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) await supabase.auth.admin.signOut(token);
    return res.json({ success: true, message: 'Logged out' });
  } catch (err) { return res.json({ success: true, message: 'Logged out' }); }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — ASK MY DATA
// ─────────────────────────────────────────────
router.post('/ask', authenticateSession, async (req, res) => {
  const schema = Joi.object({ question: Joi.string().min(3).max(500).required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  try {
    const result = await dataQueryService.answerQuestion({ agencyId: req.agencyId, question: value.question });
    if (!result.success) return res.status(502).json(result);
    return res.json(result);
  } catch (err) {
    logger.error('Ask endpoint error', { agencyId: req.agencyId, error: err.message });
    return res.status(500).json({ success: false, error: 'Something went wrong answering that question.' });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — DASHBOARD (for Lovable)
// ─────────────────────────────────────────────
router.get('/dashboard', authenticateSession, async (req, res) => {
  req.params.agencyId = req.agencyId;
  return _getDashboardData(req, res);
});

// LEGACY — api-key protected
router.get('/dashboard/:agencyId', authenticateAgency, _getDashboardData);

async function _getDashboardData(req, res) {
  const { agencyId } = req.params;

  try {
    const { data: agency } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
    if (!agency) return res.json({ success: false, error: 'Agency not found' });

    const [
      { data: bookings },
      { data: searches, count: searchCount },
      { data: activeTrips },
    ] = await Promise.all([
      supabase.from('bookings').select('*').eq('agency_id', agencyId).order('created_at', { ascending: false }).limit(200),
      supabase.from('trip_searches').select('*', { count: 'exact' }).eq('agency_id', agencyId).order('created_at', { ascending: false }).limit(1000),
      supabase.from('active_trips_dashboard').select('*').eq('agency_id', agencyId).limit(50)
        .then(r => r)
        .catch(() => ({ data: [] })),
    ]);

    const markupRate        = (agency.markup_percentage || 0) / 100;
    const totalEarnings     = (bookings || []).reduce((sum, b) => sum + (Number(b.total_price || 0) * markupRate), 0);
    const thisMonthEarnings = (bookings || []).filter(b => new Date(b.created_at) > new Date(new Date().setDate(1))).reduce((sum, b) => sum + (Number(b.total_price || 0) * markupRate), 0);
    const recentSearches    = (searches || []).filter(s => new Date(s.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000));

    const customerMap = new Map();
    (bookings || []).forEach(b => {
      const key = b.guest_phone || b.guest_email || b.guest_name || 'unknown';
      if (!customerMap.has(key)) customerMap.set(key, { name: b.guest_name, phone: b.guest_phone, email: b.guest_email, totalBookings: 0, totalSpent: 0, lastTripDate: null, trips: [] });
      const customer = customerMap.get(key);
      customer.totalBookings += 1;
      customer.totalSpent += Number(b.total_price || 0);
      if (!customer.lastTripDate || new Date(b.created_at) > new Date(customer.lastTripDate)) customer.lastTripDate = b.created_at;
      customer.trips.push({ bookingRef: b.booking_ref, route: `${b.origin || '?'} to ${b.destination || '?'}`, nights: b.nights, totalPrice: b.total_price, currency: b.currency || 'KES', status: b.status, bookingStage: b.booking_stage, date: b.created_at });
    });

    const customers = Array.from(customerMap.values()).sort((a, b) => b.totalSpent - a.totalSpent);

    const allTrips = activeTrips || [];
    const tripsSummary = {
      total:     allTrips.length,
      healthy:   allTrips.filter(t => t.health === 'healthy').length,
      attention: allTrips.filter(t => t.health === 'attention').length,
      critical:  allTrips.filter(t => t.health === 'critical').length,
    };

    const totalSearchesCount = searchCount !== null ? searchCount : (searches || []).length;

    return res.json({
      success: true,
      agency: {
        id: agency.id, name: agency.name, email: agency.email, plan: agency.plan,
        markupPercentage: agency.markup_percentage, widgetKey: agency.widget_key,
        widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`,
        whatsappWebhook: `https://bodrless-api-v2.onrender.com/api/webhooks/whatsapp?agency_id=${agency.id}`,
      },
      stats: {
        totalBookings: (bookings || []).length,
        totalEarnings: Math.round(totalEarnings),
        thisMonthEarnings: Math.round(thisMonthEarnings),
        activeCustomers: customers.length,
        totalSearches: totalSearchesCount,
        recentSearches: recentSearches.length,
        conversionRate: totalSearchesCount > 0 ? Math.round(((bookings?.length || 0) / totalSearchesCount) * 100) : 0,
      },
      bookings: (bookings || []).map(b => ({
        bookingRef: b.booking_ref, guestName: b.guest_name, guestPhone: b.guest_phone,
        guestEmail: b.guest_email, destination: b.destination, origin: b.origin,
        nights: b.nights, passengers: b.passengers, totalPrice: b.total_price,
        currency: b.currency || 'KES', status: b.status, bookingStage: b.booking_stage,
        channel: b.channel, createdAt: b.created_at,
      })),
      customers,
      recentActivity: recentSearches.slice(0, 20),
      searches: (searches || []).map(s => ({
        id: s.id,
        destination: s.destination,
        origin: s.origin,
        rawPrompt: s.raw_prompt,
        passengers: s.passengers,
        budget: s.budget,
        nights: s.nights,
        channel: s.channel,
        converted: s.converted,
        packagesReturned: s.packages_returned,
        createdAt: s.created_at,
      })),
      trips: {
        summary: tripsSummary,
        active:  allTrips,
      },
    });
  } catch (err) {
    logger.error('Dashboard error', { error: err.message });
    return res.json({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────
// SESSION-PROTECTED — SEARCHES (paginated)
// GET /api/agencies/searches
// ─────────────────────────────────────────────
router.get('/searches', authenticateSession, async (req, res) => {
  try {
    const { limit = 50, offset = 0, channel, converted, search } = req.query;

    let query = supabase
      .from('trip_searches')
      .select('id,destination,origin,raw_prompt,passengers,budget,nights,channel,converted,packages_returned,created_at', { count: 'exact' })
      .eq('agency_id', req.agencyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (channel)   query = query.eq('channel', channel);
    if (converted !== undefined && converted !== '') query = query.eq('converted', converted === 'true');
    if (search)    query = query.or(`destination.ilike.%${search}%,origin.ilike.%${search}%,raw_prompt.ilike.%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      searches: data || [],
      total: count,
      offset: Number(offset),
      limit: Number(limit),
      hasMore: Number(offset) + Number(limit) < count,
    });
  } catch (err) {
    logger.error('Agency searches fetch failed', { agencyId: req.agencyId, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — CONVERSATIONS (paginated threads)
// GET /api/agencies/conversations
// ─────────────────────────────────────────────
router.get('/conversations', authenticateSession, async (req, res) => {
  try {
    const { limit = 40, offset = 0, channel, converted, search } = req.query;

    // Fetch a larger window of rows to group into threads.
    // limit * 10 gives enough rows to assemble ~limit threads even for
    // sessions with multiple turns. Increase multiplier if agencies have
    // very long conversations.
    const fetchLimit = Number(limit) * 10;

    let query = supabase
      .from('conversations')
      .select('session_id, phone, channel, destination, origin, passengers, converted, created_at, user_message, engine_response, turn_index')
      .eq('agency_id', req.agencyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + fetchLimit - 1);

    if (channel)  query = query.eq('channel', channel);
    if (converted !== undefined && converted !== '') query = query.eq('converted', converted === 'true');
    if (search)   query = query.or(`phone.ilike.%${search}%,destination.ilike.%${search}%,origin.ilike.%${search}%,user_message.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) throw error;

    // Group individual rows into per-session threads
    const threadMap = {};
    for (const row of data || []) {
      if (!threadMap[row.session_id]) {
        threadMap[row.session_id] = {
          session_id:    row.session_id,
          phone:         row.phone,
          channel:       row.channel,
          destination:   row.destination,
          origin:        row.origin,
          passengers:    row.passengers,
          converted:     row.converted,
          started_at:    row.created_at,
          last_activity: row.created_at,
          turns: [],
        };
      }
      const t = threadMap[row.session_id];
      if (row.created_at > t.last_activity) t.last_activity = row.created_at;
      if (row.created_at < t.started_at)    t.started_at    = row.created_at;
      t.turns.push({
        turn: row.turn_index,
        user: row.user_message,
        bot:  row.engine_response,
        at:   row.created_at,
      });
    }

    const threads = Object.values(threadMap)
      .map(t => ({ ...t, turns: t.turns.sort((a, b) => a.turn - b.turn) }))
      .sort((a, b) => new Date(b.last_activity) - new Date(a.last_activity));

    res.json({
      success: true,
      threads,
      total: threads.length,
      offset: Number(offset),
      limit:  Number(limit),
    });
  } catch (err) {
    logger.error('Agency conversations fetch failed', { agencyId: req.agencyId, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — UPDATE SETTINGS
// ─────────────────────────────────────────────
router.patch('/settings', authenticateSession, async (req, res) => {
  req.params.agencyId = req.agencyId;
  return _updateAgencySettings(req, res);
});

router.patch('/:agencyId', authenticateAgency, _updateAgencySettings);

async function _updateAgencySettings(req, res) {
  const { agencyId } = req.params;
  const schema = Joi.object({ name: Joi.string().optional(), email: Joi.string().email().optional(), phone: Joi.string().optional().allow(''), website: Joi.string().uri().optional().allow(''), markupPercentage: Joi.number().min(0).max(50).optional() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });
  try {
    const updates = {};
    if (value.name)                           updates.name              = value.name;
    if (value.email)                          updates.email             = value.email;
    if (value.phone)                          updates.phone             = value.phone;
    if (value.website)                        updates.website           = value.website;
    if (value.markupPercentage !== undefined) updates.markup_percentage = value.markupPercentage;
    await supabase.from('agencies').update(updates).eq('id', agencyId);
    logger.info('Agency settings updated', { agencyId });
    return res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    logger.error('Agency update error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ─────────────────────────────────────────────
// SESSION-PROTECTED — ACTIVE TRIPS
// GET /api/agencies/trips
// ─────────────────────────────────────────────
router.get('/trips', authenticateSession, async (req, res) => {
  try {
    const { data: trips, error } = await supabase
      .from('active_trips_dashboard')
      .select('*')
      .eq('agency_id', req.agencyId)
      .limit(50);

    if (error) throw error;
    const all = trips || [];
    res.json({
      success: true,
      trips: all,
      summary: {
        total:     all.length,
        healthy:   all.filter(t => t.health === 'healthy').length,
        attention: all.filter(t => t.health === 'attention').length,
        critical:  all.filter(t => t.health === 'critical').length,
      },
    });
  } catch (err) {
    logger.error('Agency trips fetch failed', { agencyId: req.agencyId, error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — TRIP EVENT TIMELINE
// GET /api/agencies/trips/:id/events
// ─────────────────────────────────────────────
router.get('/trips/:id/events', authenticateSession, async (req, res) => {
  try {
    const { data: trip } = await supabase
      .from('trips')
      .select('id')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const { data: events, error } = await supabase
      .from('trip_events')
      .select('*')
      .eq('trip_id', req.params.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ success: true, events: events || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — RESOLVE DISRUPTION
// POST /api/agencies/trips/:id/resolve
// ─────────────────────────────────────────────
router.post('/trips/:id/resolve', authenticateSession, async (req, res) => {
  try {
    const { data: trip } = await supabase
      .from('trips')
      .select('id')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    const tripMonitoringService = require('../services/tripMonitoringService');
    await tripMonitoringService.resolveDisruption(req.params.id, 'agency');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// SESSION-PROTECTED — DISABLE TRIP MONITORING
// POST /api/agencies/trips/:id/disable
// ─────────────────────────────────────────────
router.post('/trips/:id/disable', authenticateSession, async (req, res) => {
  try {
    const { data: trip } = await supabase
      .from('trips')
      .select('id')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (!trip) return res.status(404).json({ success: false, error: 'Trip not found' });

    await supabase.from('trips').update({ monitoring_enabled: false }).eq('id', req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PUBLIC — LEGACY SIGNUP
// ─────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const schema = Joi.object({ name: Joi.string().required(), email: Joi.string().email().required(), phone: Joi.string().optional(), website: Joi.string().optional() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.json({ success: false, error: error.details[0].message });
  try {
    const agencyId = generateAgencyId(value.name);
    const apiKey   = generateApiKey(agencyId);
    const widgetKey = agencyId;
    const { data: existing } = await supabase.from('agencies').select('id').eq('email', value.email).single();
    if (existing) return res.json({ success: false, error: 'An agency with this email already exists' });
    const { data, error: insertError } = await supabase.from('agencies').insert({ id: agencyId, name: value.name, email: value.email, phone: value.phone || null, website: value.website || null, api_key: apiKey, widget_key: widgetKey, plan: 'starter', status: 'active', markup_percentage: 0, markup_type: 'percentage', role: 'agency' }).select().single();
    if (insertError) throw insertError;
    logger.info('New agency signed up (legacy)', { agencyId, name: value.name });
    return res.json({ success: true, agency: { id: data.id, name: data.name, email: data.email, apiKey: data.api_key, widgetKey: data.widget_key, plan: data.plan }, widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${widgetKey}&name=${encodeURIComponent(value.name)}"></script>` });
  } catch (err) {
    logger.error('Agency signup error', { error: err.message });
    return res.json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PROTECTED — REGENERATE API KEY
// ─────────────────────────────────────────────
router.post('/:agencyId/regenerate-key', authenticateAgency, async (req, res) => {
  const { agencyId } = req.params;
  try {
    const newApiKey = generateApiKey(agencyId);
    await supabase.from('agencies').update({ api_key: newApiKey }).eq('id', agencyId);
    logger.info('API key regenerated', { agencyId });
    return res.json({ success: true, message: 'API key regenerated — store this securely, it will not be shown again', apiKey: newApiKey });
  } catch (err) {
    logger.error('Key regeneration error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PROTECTED — GET WIDGET CODE
// ─────────────────────────────────────────────
router.get('/widget-code/:agencyId', authenticateAgency, async (req, res) => {
  const { agencyId } = req.params;
  try {
    const { data: agency } = await supabase.from('agencies').select('*').eq('id', agencyId).single();
    if (!agency) return res.json({ success: false, error: 'Agency not found' });
    return res.json({ success: true, widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`, widgetKey: agency.widget_key });
  } catch (err) { return res.json({ success: false, error: err.message }); }
});

// ─────────────────────────────────────────────
// PROTECTED — UPDATE WHATSAPP NUMBER
// ─────────────────────────────────────────────
router.post('/whatsapp/:agencyId', authenticateAgency, async (req, res) => {
  const { agencyId } = req.params;
  const { phoneNumberId } = req.body;
  try {
    await supabase.from('agencies').update({ whatsapp_phone_number_id: phoneNumberId }).eq('id', agencyId);
    return res.json({ success: true, message: 'WhatsApp number updated' });
  } catch (err) { return res.json({ success: false, error: err.message }); }
});

module.exports = router;