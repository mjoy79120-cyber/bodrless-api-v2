/**
 * AGENCY ROUTES
 * ─────────────────────────────────────────────
 * Self-service agency signup and management
 * Public:    /register, /signup
 * Protected: everything else (uses x-api-key)
 * ─────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const crypto = require('crypto');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const { authenticateAgency } = require('../middleware/auth');

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

    // Check duplicate
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

    // Create Supabase Auth user
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

    // Create agency record
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
      // Rollback auth user
      await supabase.auth.admin.deleteUser(authUserId);
      throw insertError;
    }

    // Link auth user to agency via profiles
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
        apiKey,    // shown once only
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
// PROTECTED — REGENERATE API KEY
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
// PROTECTED — GET DASHBOARD DATA
// GET /api/agencies/dashboard/:agencyId
// ─────────────────────────────────────────────
router.get('/dashboard/:agencyId', authenticateAgency, async (req, res) => {
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
      .limit(50);

    const { data: searches } = await supabase
      .from('trip_searches')
      .select('*')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(100);

    const markupRate       = (agency.markup_percentage || 0) / 100;
    const totalEarnings    = (bookings || []).reduce((sum, b) => sum + (Number(b.total_price || 0) * markupRate), 0);
    const thisMonthEarnings = (bookings || [])
      .filter(b => new Date(b.created_at) > new Date(new Date().setDate(1)))
      .reduce((sum, b) => sum + (Number(b.total_price || 0) * markupRate), 0);

    const uniqueGuests   = new Set((bookings || []).map(b => b.guest_phone || b.guest_email || b.guest_name));
    const recentSearches = (searches || []).filter(s =>
      new Date(s.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

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
        activeCustomers:   uniqueGuests.size,
        totalSearches:     (searches || []).length,
        recentSearches:    recentSearches.length,
        conversionRate:    searches?.length > 0
          ? Math.round(((bookings?.length || 0) / searches.length) * 100)
          : 0,
      },
      bookings:       bookings || [],
      recentActivity: recentSearches.slice(0, 20),
    });

  } catch (err) {
    logger.error('Dashboard error', { error: err.message });
    return res.json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// PROTECTED — UPDATE AGENCY SETTINGS
// PATCH /api/agencies/:agencyId
// ─────────────────────────────────────────────
router.patch('/:agencyId', authenticateAgency, async (req, res) => {
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