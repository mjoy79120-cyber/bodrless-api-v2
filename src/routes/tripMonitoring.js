/**
 * TRIP MONITORING DASHBOARD ROUTES
 * ─────────────────────────────────────────────────────────────
 * REST endpoints consumed by the agency dashboard frontend.
 * All routes require agency JWT auth (same middleware as
 * the existing dashboard routes — see server.js).
 *
 * GET  /monitoring/trips              — active trips feed
 * GET  /monitoring/trips/:id          — single trip detail
 * GET  /monitoring/trips/:id/events   — event timeline
 * POST /monitoring/trips/:id/resolve  — manually resolve disruption
 * POST /monitoring/trips/:id/disable  — stop monitoring a trip
 * ─────────────────────────────────────────────────────────────
 */

const express    = require('express');
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');
const tripMonitoringService = require('../services/tripMonitoringService');

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// Reuses the same agency JWT pattern as the existing dashboard.
// Attaches agencyId to req for all routes below.
// ─────────────────────────────────────────────────────────────
async function requireAgencyAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Look up which agency this user belongs to
    const { data: agency, error: agencyErr } = await supabase
      .from('agencies')
      .select('id')
      .eq('user_id', user.id)
      .single();

    if (agencyErr || !agency) {
      return res.status(403).json({ error: 'No agency found for this user' });
    }

    req.agencyId = agency.id;
    req.userId   = user.id;
    next();

  } catch (err) {
    logger.error('TripMonitoring auth failed', { error: err.message });
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

router.use(requireAgencyAuth);

// ─────────────────────────────────────────────────────────────
// GET /monitoring/trips
// Active trips feed for the dashboard.
// Returns trips ordered by health (critical first) then departure.
// Supports ?stage=pre_departure&health=critical filtering.
// ─────────────────────────────────────────────────────────────
router.get('/trips', async (req, res) => {
  try {
    const { stage, health, limit = 50 } = req.query;

    let query = supabase
      .from('active_trips_dashboard')  // the view from migration 004
      .select('*')
      .eq('agency_id', req.agencyId)
      .limit(Number(limit));

    if (stage)  query = query.eq('stage',  stage);
    if (health) query = query.eq('health', health);

    const { data: trips, error } = await query;

    if (error) {
      logger.error('TripMonitoring: GET /trips failed', { error: error.message, agencyId: req.agencyId });
      return res.status(500).json({ error: 'Failed to fetch trips' });
    }

    // Group by health for the dashboard summary
    const summary = {
      total:    trips.length,
      healthy:  trips.filter(t => t.health === 'healthy').length,
      attention: trips.filter(t => t.health === 'attention').length,
      critical:  trips.filter(t => t.health === 'critical').length,
    };

    return res.json({ trips: trips || [], summary });

  } catch (err) {
    logger.error('TripMonitoring: GET /trips threw', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /monitoring/trips/:id
// Full trip detail including booking data.
// ─────────────────────────────────────────────────────────────
router.get('/trips/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { data: trip, error } = await supabase
      .from('trips')
      .select('*')
      .eq('id', id)
      .eq('agency_id', req.agencyId)  // scoped to this agency
      .single();

    if (error || !trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    // Fetch latest booking for full context
    const { data: booking } = await supabase
      .from('bookings')
      .select('flight_details, hotel_details, transfer_details, total_price, currency, payment_status')
      .eq('id', trip.booking_id)
      .single();

    return res.json({ trip, booking: booking || null });

  } catch (err) {
    logger.error('TripMonitoring: GET /trips/:id threw', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /monitoring/trips/:id/events
// Event timeline for a specific trip. Most recent first.
// ─────────────────────────────────────────────────────────────
router.get('/trips/:id/events', async (req, res) => {
  try {
    const { id }    = req.params;
    const { limit = 100 } = req.query;

    // Verify trip belongs to this agency before returning events
    const { data: trip } = await supabase
      .from('trips')
      .select('id')
      .eq('id', id)
      .eq('agency_id', req.agencyId)
      .single();

    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    const events = await tripMonitoringService.getTripEvents(id, { limit: Number(limit) });

    return res.json({ events });

  } catch (err) {
    logger.error('TripMonitoring: GET /trips/:id/events threw', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /monitoring/trips/:id/resolve
// Agency manually resolves a disruption (e.g. after calling the
// airline directly or handling it outside Bodrless).
// ─────────────────────────────────────────────────────────────
router.post('/trips/:id/resolve', async (req, res) => {
  try {
    const { id }     = req.params;
    const { reason } = req.body || {};

    const { data: trip } = await supabase
      .from('trips')
      .select('id, agency_id')
      .eq('id', id)
      .eq('agency_id', req.agencyId)
      .single();

    if (!trip) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    await tripMonitoringService.resolveDisruption(id, 'agency');

    if (reason) {
      await tripMonitoringService.logEvent(id, {
        event_type:  'issue_resolved',
        severity:    'info',
        title:       'Disruption manually resolved by agency',
        description: reason,
        resolved:    true,
      });
    }

    return res.json({ success: true });

  } catch (err) {
    logger.error('TripMonitoring: POST /resolve threw', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /monitoring/trips/:id/disable
// Agency opts a trip out of monitoring (e.g. package trip where
// the supplier handles disruptions directly).
// ─────────────────────────────────────────────────────────────
router.post('/trips/:id/disable', async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('trips')
      .update({ monitoring_enabled: false })
      .eq('id', id)
      .eq('agency_id', req.agencyId);

    if (error) {
      return res.status(500).json({ error: 'Failed to disable monitoring' });
    }

    await tripMonitoringService.logEvent(id, {
      event_type:  'monitoring_disabled',
      severity:    'info',
      title:       'Trip monitoring disabled by agency',
    });

    return res.json({ success: true });

  } catch (err) {
    logger.error('TripMonitoring: POST /disable threw', { error: err.message });
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;