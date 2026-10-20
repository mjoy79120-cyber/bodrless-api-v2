/**
 * HOTEL WISHES ROUTES
 * Mount in server.js:
 *   app.use('/api/hotel', require('./routes/hotelWishes'));
 *
 * Endpoints:
 *   POST /api/hotel/wishes/save    — auto-save a search (no opt-in)
 *   POST /api/hotel/wishes/optin   — save with email for nudges
 *   GET  /api/hotel/wishes/pending — widget checks for pending nudge
 */

const express    = require('express');
const router     = express.Router();
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

async function _resolveGroup(req) {
  const slug = req.headers['x-hotel-key'] || req.body?.groupSlug;
  if (!slug) return null;
  const { data } = await supabase
    .from('hotel_groups')
    .select('id, name, slug')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle();
  return data || null;
}

// POST /wishes/save — auto-save search, no email required
router.post('/wishes/save', async (req, res) => {
  try {
    const group = await _resolveGroup(req);
    if (!group) return res.status(401).json({ success: false });

    const {
      sessionKey, propertyId, propertyName, checkIn, checkOut,
      nights, adults, children, preferences, lastPriceSeen, currency,
    } = req.body;

    if (!sessionKey || !propertyId) return res.json({ success: true }); // silent

    // Upsert — one wish per session+property+checkIn combo
    await supabase.from('hotel_wishes').upsert({
      group_id:       group.id,
      property_id:    propertyId,
      session_key:    sessionKey,
      check_in:       checkIn    || null,
      check_out:      checkOut   || null,
      nights:         nights     || null,
      adults:         adults     || 1,
      children:       children   || 0,
      preferences:    preferences || [],
      last_price_seen: lastPriceSeen || null,
      currency:       currency   || 'KES',
      updated_at:     new Date().toISOString(),
    }, {
      onConflict: 'session_key,property_id,check_in',
      ignoreDuplicates: false,
    });

    return res.json({ success: true });
  } catch (err) {
    logger.warn('[HOTEL WISHES] save failed', { error: err.message });
    return res.json({ success: true }); // fail silently
  }
});

// POST /wishes/optin — save with email for nudge alerts
router.post('/wishes/optin', async (req, res) => {
  try {
    const group = await _resolveGroup(req);
    if (!group) return res.status(401).json({ success: false });

    const {
      sessionKey, email, guestName, propertyId, propertyName,
      checkIn, checkOut, nights, adults,
    } = req.body;

    if (!email || !sessionKey) {
      return res.status(400).json({ success: false, error: 'email and sessionKey required' });
    }

    // Update existing wish for this session, or insert new
    const { data: existing } = await supabase
      .from('hotel_wishes')
      .select('id')
      .eq('session_key', sessionKey)
      .eq('group_id', group.id)
      .maybeSingle();

    if (existing) {
      await supabase.from('hotel_wishes').update({
        guest_email: email,
        guest_name:  guestName || null,
        updated_at:  new Date().toISOString(),
      }).eq('id', existing.id);
    } else {
      await supabase.from('hotel_wishes').insert({
        group_id:    group.id,
        property_id: propertyId || null,
        session_key: sessionKey,
        guest_email: email,
        guest_name:  guestName || null,
        check_in:    checkIn   || null,
        check_out:   checkOut  || null,
        nights:      nights    || null,
        adults:      adults    || 1,
        status:      'active',
      });
    }

    logger.info('[HOTEL WISHES] optin saved', { email, groupId: group.id, propertyId });
    return res.json({ success: true, email });

  } catch (err) {
    logger.error('[HOTEL WISHES] optin failed', { error: err.message });
    return res.status(500).json({ success: false });
  }
});

// GET /wishes/pending?sessionKey=... — widget checks on load for pending nudge
router.get('/wishes/pending', async (req, res) => {
  try {
    const group = await _resolveGroup(req);
    if (!group) return res.json({ pending: null });

    const { sessionKey } = req.query;
    if (!sessionKey) return res.json({ pending: null });

    const { data } = await supabase
      .from('hotel_wishes')
      .select('id, pending_nudge, hotel_properties(name)')
      .eq('session_key', sessionKey)
      .eq('group_id', group.id)
      .not('pending_nudge', 'is', null)
      .maybeSingle();

    if (!data?.pending_nudge) return res.json({ pending: null });

    // Clear the pending nudge so it doesn't show again
    await supabase.from('hotel_wishes').update({ pending_nudge: null }).eq('id', data.id);

    return res.json({
      pending:      data.pending_nudge,
      propertyName: data.hotel_properties?.name || null,
    });
  } catch (err) {
    return res.json({ pending: null });
  }
});

module.exports = router;