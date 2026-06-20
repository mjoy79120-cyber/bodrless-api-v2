/**
 * AGENCY ROUTES
 * ─────────────────────────────────────────────
 * Self-service agency signup and management
 *
 * Public:             /register, /signup, /login, /forgot-password
 * Session-protected:  /me, /logout, /dashboard, /settings, /ask
 *                      (uses Supabase session JWT — for the Lovable
 *                      dashboard, logged-in agency users)
 * API-key-protected:  /:agencyId/regenerate-key, /whatsapp/:agencyId
 *                      (uses x-api-key — for server-side/widget use)
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

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
const generateApiKey = (agencyId) => {
  const random = crypto.randomBytes(32).toString('hex');
  return `bdr_${agencyId}_${random}`;
};

const generateAgencyId = (name) => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 40);
};

// ─────────────────────────────────────────────
// PUBLIC — REGISTER
// POST /api/agencies/register
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

    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'An agency with this name or email already exists',
      });
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email:         value.email,
      password:      value.password,
      email_confirm: true,
      user_metadata: {
        agency_id:      agencyId,
        agency_name:    value.name,
        contact_person: value.contactPerson || '',
        role:           'agency',
      },
    });

    if (authError) {
      logger.error('Auth user creation failed', { error: authError.message });
      return res.status(400).json({ success: false, error: authError.message });
    }

    const authUserId = authData.user.id;

    const { data: agency, error: insertError } = await supabase
      .from('agencies')
      .insert({
        id:                agencyId,
        name:              value.name,
        email:             value.email,
        phone:             value.phone   || null,
        website:           value.website || null,
        api_key:           apiKey,
        widget_key:        widgetKey,
        plan:              value.plan,
        status:            'active',
        markup_percentage: value.markupPercentage,
        markup_type:       'percentage',
        role:              'agency',
        created_at:        new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      await supabase.auth.admin.deleteUser(authUserId);
      throw insertError;
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .insert({
        id:         authUserId,
        agency_id:  agencyId,
        role:       'agency',
        created_at: new Date().toISOString(),
      });

    if (profileError) {
      logger.error('Profile insert failed', { error: profileError.message });
    }

    logger.info('New agency registered', { agencyId, name: value.name });

    return res.status(201).json({
      success: true,
      message: 'Agency registered successfully',
      agency: {
        id:               agency.id,
        name:             agency.name,
        email:            agency.email,
        plan:             agency.plan,
        markupPercentage: agency.markup_percentage,
        status:           agency.status,
      },
      credentials: {
        apiKey,    // shown once only — for server-side widget/API use, NOT for dashboard login
        widgetKey,
      },
      integration: {
        widgetCode:      `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${widgetKey}&name=${encodeURIComponent(value.name)}"></script>`,
        whatsappWebhook: `https://bodrless-api-v2.onrender.com/api/webhooks/whatsapp?agency_id=${agencyId}`,
      },
    });

  } catch (err) {
    logger.error('Agency registration error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// PUBLIC — LOGIN
// POST /api/agencies/login
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const schema = Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: value.email,
      password: value.password,
    });

    if (authError) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('agency_id, role')
      .eq('id', data.user.id)
      .single();

    if (!profile) {
      return res.status(403).json({ success: false, error: 'No agency linked to this account' });
    }

    const { data: agency } = await supabase
      .from('agencies')
      .select('id, name, email, plan, status, markup_percentage, widget_key')
      .eq('id', profile.agency_id)
      .single();

    if (agency?.status !== 'active') {
      return res.status(403).json({ success: false, error: 'This agency account is not active' });
    }

    logger.info('Agency login', { agencyId: agency.id });

    return res.json({
      success: true,
      session: {
        accessToken:  data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresAt:    data.session.expires_at,
      },
      agency: {
        id:               agency.id,
        name:             agency.name,
        email:            agency.email,
        plan:             agency.plan,
        markupPercentage: agency.markup_percentage,
        widgetKey:        agency.widget_key,
      },
    });

  } catch (err) {
    logger.error('Agency login error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});


// ─────────────────────────────────────────────
// PUBLIC — REQUEST PASSWORD RESET
// POST /api/agencies/forgot-password
// ─────────────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  const schema = Joi.object({ email: Joi.string().email().required() });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    await supabase.auth.resetPasswordForEmail(value.email, {
      redirectTo: process.env.PASSWORD_RESET_REDIRECT_URL || 'https://your-lovable-app.com/reset-password',
    });

    return res.json({
      success: true,
      message: 'If an account exists with that email, a password reset link has been sent.',
    });

  } catch (err) {
    logger.error('Password reset request error', { error: err.message });
    return res.json({
      success: true,
      message: 'If an account exists with that email, a password reset link has been sent.',
    });
  }
});


// ─────────────────────────────────────────────
// SESSION-PROTECTED — WHO AM I
// GET /api/agencies/me
// ─────────────────────────────────────────────
router.get('/me', authenticateSession, async (req, res) => {
  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('id, name, email, phone, website, plan, status, markup_percentage, widget_key, whatsapp_phone_number_id')
      .eq('id', req.agencyId)
      .single();

    if (!agency) return res.status(404).json({ success: false, error: 'Agency not found' });

    return res.json({
      success: true,
      agency: {
        id:               agency.id,
        name:             agency.name,
        email:            agency.email,
        phone:            agency.phone,
        website:          agency.website,
        plan:             agency.plan,
        status:           agency.status,
        markupPercentage: agency.markup_percentage,
        widgetKey:        agency.widget_key,
        widgetCode:       `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`,
        whatsappConfigured: !!agency.whatsapp_phone_number_id,
      },
    });

  } catch (err) {
    logger.error('Get current agency error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// SESSION-PROTECTED — LOGOUT
// POST /api/agencies/logout
// ─────────────────────────────────────────────
router.post('/logout', authenticateSession, async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) {
      await supabase.auth.admin.signOut(token);
    }
    return res.json({ success: true, message: 'Logged out' });
  } catch (err) {
    return res.json({ success: true, message: 'Logged out' });
  }
});


// ─────────────────────────────────────────────
// SESSION-PROTECTED — TALK TO MY DATA
// POST /api/agencies/ask
// Body: { question: "How much did I earn last month?" }
// Answers grounded strictly in the agency's real Supabase data —
// see services/dataQueryService.js for how the answer is generated.
// ─────────────────────────────────────────────
router.post('/ask', authenticateSession, async (req, res) => {
  const schema = Joi.object({
    question: Joi.string().min(3).max(500).required(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    const result = await dataQueryService.answerQuestion({
      agencyId: req.agencyId,
      question: value.question,
    });

    if (!result.success) {
      return res.status(502).json(result);
    }

    return res.json(result);

  } catch (err) {
    logger.error('Ask endpoint error', { agencyId: req.agencyId, error: err.message });
    return res.status(500).json({ success: false, error: 'Something went wrong answering that question.' });
  }
});


// ─────────────────────────────────────────────
// SESSION-PROTECTED — DASHBOARD (for Lovable)
// GET /api/agencies/dashboard
// ─────────────────────────────────────────────
router.get('/dashboard', authenticateSession, async (req, res) => {
  req.params.agencyId = req.agencyId;
  return _getDashboardData(req, res);
});


// ─────────────────────────────────────────────
// LEGACY — GET DASHBOARD DATA (api-key protected)
// GET /api/agencies/dashboard/:agencyId
// ─────────────────────────────────────────────
router.get('/dashboard/:agencyId', authenticateAgency, _getDashboardData);

async function _getDashboardData(req, res) {
  const { agencyId } = req.params;

  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (!agency) return res.json({ success: false, error: 'Agency not found' });

    const { data: bookings } = await supabase
      .from('bookings')
      .select('*')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(200);

    const { data: searches } = await supabase
      .from('trip_searches')
      .select('*')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(200);

    const markupRate        = (agency.markup_percentage || 0) / 100;
    const totalEarnings     = (bookings || []).reduce((sum, b) => sum + (Number(b.total_price || 0) * markupRate), 0);
    const thisMonthEarnings = (bookings || [])
      .filter(b => new Date(b.created_at) > new Date(new Date().setDate(1)))
      .reduce((sum, b) => sum + (Number(b.total_price || 0) * markupRate), 0);

    const recentSearches = (searches || []).filter(s =>
      new Date(s.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    // ── Per-customer breakdown ──────────────────────
    // Groups bookings by guest (phone, falling back to email/name) so
    // an agency can see each customer's total spend and trip history.
    const customerMap = new Map();
    (bookings || []).forEach(b => {
      const key = b.guest_phone || b.guest_email || b.guest_name || 'unknown';
      if (!customerMap.has(key)) {
        customerMap.set(key, {
          name: b.guest_name,
          phone: b.guest_phone,
          email: b.guest_email,
          totalBookings: 0,
          totalSpent: 0,
          lastTripDate: null,
          trips: [],
        });
      }
      const customer = customerMap.get(key);
      customer.totalBookings += 1;
      customer.totalSpent += Number(b.total_price || 0);
      if (!customer.lastTripDate || new Date(b.created_at) > new Date(customer.lastTripDate)) {
        customer.lastTripDate = b.created_at;
      }
      customer.trips.push({
        bookingRef:    b.booking_ref,
        route:         `${b.origin || '?'} to ${b.destination || '?'}`,
        nights:        b.nights,
        totalPrice:    b.total_price,
        currency:      b.currency || 'KES',
        status:        b.status,
        bookingStage:  b.booking_stage,
        date:          b.created_at,
      });
    });

    const customers = Array.from(customerMap.values())
      .sort((a, b) => b.totalSpent - a.totalSpent);

    return res.json({
      success: true,
      agency: {
        id:               agency.id,
        name:             agency.name,
        email:            agency.email,
        plan:             agency.plan,
        markupPercentage: agency.markup_percentage,
        widgetKey:        agency.widget_key,
        widgetCode:       `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`,
        whatsappWebhook:  `https://bodrless-api-v2.onrender.com/api/webhooks/whatsapp?agency_id=${agency.id}`,
      },
      stats: {
        totalBookings:     (bookings || []).length,
        totalEarnings:     Math.round(totalEarnings),
        thisMonthEarnings: Math.round(thisMonthEarnings),
        activeCustomers:   customers.length,
        totalSearches:     (searches || []).length,
        recentSearches:    recentSearches.length,
        conversionRate:    searches?.length > 0
          ? Math.round(((bookings?.length || 0) / searches.length) * 100)
          : 0,
      },
      bookings: (bookings || []).map(b => ({
        bookingRef:   b.booking_ref,
        guestName:    b.guest_name,
        guestPhone:   b.guest_phone,
        guestEmail:   b.guest_email,
        destination:  b.destination,
        origin:       b.origin,
        nights:       b.nights,
        passengers:   b.passengers,
        totalPrice:   b.total_price,
        currency:     b.currency || 'KES',
        status:       b.status,
        bookingStage: b.booking_stage,
        channel:      b.channel,
        createdAt:    b.created_at,
      })),
      customers,
      recentActivity: recentSearches.slice(0, 20),
    });

  } catch (err) {
    logger.error('Dashboard error', { error: err.message });
    return res.json({ success: false, error: err.message });
  }
}


// ─────────────────────────────────────────────
// SESSION-PROTECTED — UPDATE SETTINGS (for Lovable)
// PATCH /api/agencies/settings
// ─────────────────────────────────────────────
router.patch('/settings', authenticateSession, async (req, res) => {
  req.params.agencyId = req.agencyId;
  return _updateAgencySettings(req, res);
});

// LEGACY — api-key protected version
router.patch('/:agencyId', authenticateAgency, _updateAgencySettings);

async function _updateAgencySettings(req, res) {
  const { agencyId } = req.params;

  const schema = Joi.object({
    name:             Joi.string().optional(),
    email:            Joi.string().email().optional(),
    phone:            Joi.string().optional().allow(''),
    website:          Joi.string().uri().optional().allow(''),
    markupPercentage: Joi.number().min(0).max(50).optional(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ success: false, error: error.details[0].message });

  try {
    const updates = {};
    if (value.name)                          updates.name              = value.name;
    if (value.email)                         updates.email             = value.email;
    if (value.phone)                         updates.phone             = value.phone;
    if (value.website)                       updates.website           = value.website;
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
// PUBLIC — SIGNUP (legacy)
// POST /api/agencies/signup
// ─────────────────────────────────────────────
router.post('/signup', async (req, res) => {

  const schema = Joi.object({
    name:    Joi.string().required(),
    email:   Joi.string().email().required(),
    phone:   Joi.string().optional(),
    website: Joi.string().optional(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) return res.json({ success: false, error: error.details[0].message });

  try {
    const agencyId  = generateAgencyId(value.name);
    const apiKey    = generateApiKey(agencyId);
    const widgetKey = agencyId;

    const { data: existing } = await supabase
      .from('agencies')
      .select('id')
      .eq('email', value.email)
      .single();

    if (existing) {
      return res.json({ success: false, error: 'An agency with this email already exists' });
    }

    const { data, error: insertError } = await supabase
      .from('agencies')
      .insert({
        id:                agencyId,
        name:              value.name,
        email:             value.email,
        phone:             value.phone   || null,
        website:           value.website || null,
        api_key:           apiKey,
        widget_key:        widgetKey,
        plan:              'starter',
        status:            'active',
        markup_percentage: 0,
        markup_type:       'percentage',
        role:              'agency',
      })
      .select()
      .single();

    if (insertError) throw insertError;

    logger.info('New agency signed up (legacy)', { agencyId, name: value.name });

    return res.json({
      success: true,
      agency: {
        id:        data.id,
        name:      data.name,
        email:     data.email,
        apiKey:    data.api_key,
        widgetKey: data.widget_key,
        plan:      data.plan,
      },
      widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${widgetKey}&name=${encodeURIComponent(value.name)}"></script>`,
    });

  } catch (err) {
    logger.error('Agency signup error', { error: err.message });
    return res.json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// PROTECTED — REGENERATE API KEY (api-key protected — sensitive)
// POST /api/agencies/:agencyId/regenerate-key
// ─────────────────────────────────────────────
router.post('/:agencyId/regenerate-key', authenticateAgency, async (req, res) => {
  const { agencyId } = req.params;

  try {
    const newApiKey = generateApiKey(agencyId);

    await supabase
      .from('agencies')
      .update({ api_key: newApiKey })
      .eq('id', agencyId);

    logger.info('API key regenerated', { agencyId });

    return res.json({
      success: true,
      message: 'API key regenerated — store this securely, it will not be shown again',
      apiKey:  newApiKey,
    });

  } catch (err) {
    logger.error('Key regeneration error', { error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// PROTECTED — GET WIDGET CODE
// GET /api/agencies/widget-code/:agencyId
// ─────────────────────────────────────────────
router.get('/widget-code/:agencyId', authenticateAgency, async (req, res) => {
  const { agencyId } = req.params;

  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (!agency) return res.json({ success: false, error: 'Agency not found' });

    return res.json({
      success:    true,
      widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`,
      widgetKey:  agency.widget_key,
    });

  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// PROTECTED — UPDATE WHATSAPP NUMBER
// POST /api/agencies/whatsapp/:agencyId
// ─────────────────────────────────────────────
router.post('/whatsapp/:agencyId', authenticateAgency, async (req, res) => {
  const { agencyId }      = req.params;
  const { phoneNumberId } = req.body;

  try {
    await supabase
      .from('agencies')
      .update({ whatsapp_phone_number_id: phoneNumberId })
      .eq('id', agencyId);

    return res.json({ success: true, message: 'WhatsApp number updated' });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

module.exports = router;