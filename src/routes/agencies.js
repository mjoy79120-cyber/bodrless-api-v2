/**
 * AGENCY ROUTES
 * ─────────────────────────────────────────────
 * Self-service agency signup and management
 * ─────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// SIGNUP — create new agency
// ─────────────────────────────────────────────
router.post('/signup', async (req, res) => {

  const schema = Joi.object({
    name: Joi.string().required(),
    email: Joi.string().email().required(),
    phone: Joi.string().optional(),
    website: Joi.string().optional(),
  });

  const { error, value } = schema.validate(req.body);

  if (error) {
    return res.json({ success: false, error: error.details[0].message });
  }

  try {
    // Generate agency ID from name
    const agencyId = value.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const apiKey = `bdr_${agencyId}_${Date.now()}`;
    const widgetKey = agencyId;

    // Check if agency already exists
    const { data: existing } = await supabase
      .from('agencies')
      .select('id')
      .eq('email', value.email)
      .single();

    if (existing) {
      return res.json({
        success: false,
        error: 'An agency with this email already exists'
      });
    }

    // Create agency
    const { data, error: insertError } = await supabase
      .from('agencies')
      .insert({
        id: agencyId,
        name: value.name,
        email: value.email,
        phone: value.phone || null,
        website: value.website || null,
        api_key: apiKey,
        widget_key: widgetKey,
        plan: 'free',
        status: 'active',
      })
      .select()
      .single();

    if (insertError) throw insertError;

    logger.info('New agency signed up', { agencyId, name: value.name });

    return res.json({
      success: true,
      agency: {
        id: data.id,
        name: data.name,
        email: data.email,
        apiKey: data.api_key,
        widgetKey: data.widget_key,
        plan: data.plan,
      },
      widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${widgetKey}&name=${encodeURIComponent(value.name)}"></script>`,
      whatsappSetup: `Set WHATSAPP_PHONE_NUMBER_ID in your environment and add your phone number ID to the agencies table`,
    });

  } catch (err) {
    logger.error('Agency signup error', { error: err.message });
    return res.json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// GET AGENCY DASHBOARD DATA
// ─────────────────────────────────────────────
router.get('/dashboard/:agencyId', async (req, res) => {
  const { agencyId } = req.params;

  try {
    // Get agency details
    const { data: agency } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (!agency) {
      return res.json({ success: false, error: 'Agency not found' });
    }

    // Get bookings
    const { data: bookings } = await supabase
      .from('bookings')
      .select('*')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(50);

    // Get recent searches
    const { data: searches } = await supabase
      .from('trip_searches')
      .select('*')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(100);

    // Calculate earnings
    const totalEarnings = (bookings || []).reduce((sum, b) => sum + (b.total_price * 0.05), 0);
    const thisMonthEarnings = (bookings || [])
      .filter(b => new Date(b.created_at) > new Date(new Date().setDate(1)))
      .reduce((sum, b) => sum + (b.total_price * 0.05), 0);

    // Active customers (unique guests)
    const uniqueGuests = new Set((bookings || []).map(b => b.guest_phone || b.guest_email || b.guest_name));

    // Real time — searches in last 24 hours
    const recentSearches = (searches || []).filter(s =>
      new Date(s.created_at) > new Date(Date.now() - 24 * 60 * 60 * 1000)
    );

    return res.json({
      success: true,
      agency: {
        id: agency.id,
        name: agency.name,
        email: agency.email,
        plan: agency.plan,
        widgetKey: agency.widget_key,
        apiKey: agency.api_key,
        widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`,
      },
      stats: {
        totalBookings: (bookings || []).length,
        totalEarnings: Math.round(totalEarnings),
        thisMonthEarnings: Math.round(thisMonthEarnings),
        activeCustomers: uniqueGuests.size,
        totalSearches: (searches || []).length,
        recentSearches: recentSearches.length,
        conversionRate: searches?.length > 0
          ? Math.round(((bookings?.length || 0) / searches.length) * 100)
          : 0,
      },
      bookings: bookings || [],
      recentActivity: recentSearches.slice(0, 20),
    });

  } catch (err) {
    logger.error('Dashboard error', { error: err.message });
    return res.json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// GET WIDGET CODE
// ─────────────────────────────────────────────
router.get('/widget-code/:agencyId', async (req, res) => {
  const { agencyId } = req.params;

  try {
    const { data: agency } = await supabase
      .from('agencies')
      .select('*')
      .eq('id', agencyId)
      .single();

    if (!agency) {
      return res.json({ success: false, error: 'Agency not found' });
    }

    return res.json({
      success: true,
      widgetCode: `<script src="https://bodrless-api-v2.onrender.com/widget.js?key=${agency.widget_key}&name=${encodeURIComponent(agency.name)}"></script>`,
      apiKey: agency.api_key,
      widgetKey: agency.widget_key,
    });

  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});


// ─────────────────────────────────────────────
// UPDATE WHATSAPP NUMBER
// ─────────────────────────────────────────────
router.post('/whatsapp/:agencyId', async (req, res) => {
  const { agencyId } = req.params;
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
