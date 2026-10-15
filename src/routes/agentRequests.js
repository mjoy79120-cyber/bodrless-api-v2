/**
 * AGENT REQUESTS ROUTES
 * ─────────────────────────────────────────────────────────────
 * Dashboard endpoints for the package approval flow.
 * All routes require a valid Supabase session token
 * (Authorization: Bearer <token>) via authenticateSession.
 *
 * Mount in server.js / app.js:
 *   const agentRequests = require('./routes/agentRequests');
 *   app.use('/api/agent', authenticateSession, agentRequests);
 *
 * Endpoints:
 *   GET  /requests              list pending (and recent decided) requests
 *   GET  /requests/count        badge count — pending only
 *   GET  /requests/:id          single request detail
 *   POST /requests/:id/approve  approve as-is or with edits
 *   POST /requests/:id/decline  decline with optional reason
 *   POST /requests/:id/rebuild  re-run search with a new prompt
 *   POST /build                 create a new package from a prompt (Builder page)
 * ─────────────────────────────────────────────────────────────
 */

const express        = require('express');
const router         = express.Router();
const Joi            = require('joi');
const supabase       = require('../utils/supabase');
const { logger }     = require('../utils/logger');
const packageBuilder = require('../services/packageBuilder');

// ── Lazy-load delivery services so they can be stubbed in tests ───────────
function _getWidgetDelivery() {
  try { return require('../services/widgetMemory'); } catch { return null; }
}
function _getWhatsApp() {
  try { return require('../services/whatsapp'); } catch { return null; }
}

// ─────────────────────────────────────────────
// GET /requests  — list for the Requests page
// ─────────────────────────────────────────────
router.get('/requests', async (req, res) => {
  try {
    const { status = 'pending', limit = 40, offset = 0 } = req.query;
    const validStatuses = ['pending', 'approved', 'declined', 'expired', 'all'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status filter' });
    }

    let query = supabase
      .from('package_requests')
      .select('id, session_key, channel, traveler_phone, trip_params, packages, edited_packages, agent_note, status, rebuild_count, created_at, updated_at, decided_at', { count: 'exact' })
      .eq('agency_id', req.agencyId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (status !== 'all') query = query.eq('status', status);

    const { data, count, error } = await query;
    if (error) throw error;

    return res.json({ success: true, requests: data || [], total: count || 0 });
  } catch (err) {
    logger.error('agentRequests GET /requests', { error: err.message, agencyId: req.agencyId });
    return res.status(500).json({ success: false, error: 'Failed to load requests' });
  }
});

// ─────────────────────────────────────────────
// GET /requests/count  — navbar badge
// ─────────────────────────────────────────────
router.get('/requests/count', async (req, res) => {
  try {
    const { count, error } = await supabase
      .from('package_requests')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', req.agencyId)
      .eq('status', 'pending');

    if (error) throw error;
    return res.json({ success: true, count: count || 0 });
  } catch (err) {
    logger.error('agentRequests GET /requests/count', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to get count' });
  }
});

// ─────────────────────────────────────────────
// GET /requests/:id
// ─────────────────────────────────────────────
router.get('/requests/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('package_requests')
      .select('*')
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Not found' });
    return res.json({ success: true, request: data });
  } catch (err) {
    logger.error('agentRequests GET /requests/:id', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to load request' });
  }
});

// ─────────────────────────────────────────────
// POST /requests/:id/approve
// Body: { editedPackages?: [...], agentNote?: string }
// ─────────────────────────────────────────────
router.post('/requests/:id/approve', async (req, res) => {
  const schema = Joi.object({
    editedPackages: Joi.array().items(Joi.object()).max(4).optional(),
    agentNote:      Joi.string().max(500).allow('', null).optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    // Atomic claim — prevents two agents deciding the same request
    const { data: claimed, error: claimErr } = await supabase
      .from('package_requests')
      .update({
        status:          'approved',
        decided_by:      req.agencyUser.id,
        decided_at:      new Date().toISOString(),
        edited_packages: value.editedPackages || null,
        agent_note:      value.agentNote      || null,
      })
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .eq('status', 'pending')           // only claim if still pending
      .select()
      .single();

    if (claimErr || !claimed) {
      return res.status(409).json({ success: false, error: 'Request already decided or not found' });
    }

    // Deliver to traveler
    const packagesToSend = claimed.edited_packages || claimed.packages || [];
    await _deliver(claimed, packagesToSend, 'approved');

    logger.info('agentRequests: approved', { id: claimed.id, agencyId: req.agencyId });
    return res.json({ success: true, request: claimed });

  } catch (err) {
    logger.error('agentRequests POST /approve', { error: err.message });
    return res.status(500).json({ success: false, error: 'Approval failed' });
  }
});

// ─────────────────────────────────────────────
// POST /requests/:id/decline
// Body: { reason?: string }
// ─────────────────────────────────────────────
router.post('/requests/:id/decline', async (req, res) => {
  const schema = Joi.object({
    reason: Joi.string().max(400).allow('', null).optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const { data: claimed, error: claimErr } = await supabase
      .from('package_requests')
      .update({
        status:     'declined',
        decided_by: req.agencyUser.id,
        decided_at: new Date().toISOString(),
        agent_note: value.reason || null,
      })
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .eq('status', 'pending')
      .select()
      .single();

    if (claimErr || !claimed) {
      return res.status(409).json({ success: false, error: 'Request already decided or not found' });
    }

    await _deliver(claimed, [], 'declined');

    logger.info('agentRequests: declined', { id: claimed.id, agencyId: req.agencyId });
    return res.json({ success: true, request: claimed });

  } catch (err) {
    logger.error('agentRequests POST /decline', { error: err.message });
    return res.status(500).json({ success: false, error: 'Decline failed' });
  }
});

// ─────────────────────────────────────────────
// POST /requests/:id/rebuild
// Body: { prompt: string }
// ─────────────────────────────────────────────
router.post('/requests/:id/rebuild', async (req, res) => {
  const schema = Joi.object({
    prompt: Joi.string().min(3).max(600).required(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const result = await packageBuilder.rebuildRequest({
      requestId:   req.params.id,
      agencyId:    req.agencyId,
      prompt:      value.prompt,
      agentUserId: req.agencyUser.id,
    });

    if (!result.success) {
      const statusCode = result.limitReached ? 429 : 400;
      return res.status(statusCode).json({ success: false, error: result.error, limitReached: result.limitReached });
    }

    return res.json({
      success:      true,
      packages:     result.packages,
      tripParams:   result.tripParams,
      text:         result.text,
      rebuildsLeft: result.rebuildsLeft,
    });

  } catch (err) {
    logger.error('agentRequests POST /rebuild', { error: err.message });
    return res.status(500).json({ success: false, error: 'Rebuild failed' });
  }
});

// ─────────────────────────────────────────────
// POST /build  — Package Builder page
// Body: { prompt: string, previousParams?: object, conversationHistory?: array }
// ─────────────────────────────────────────────
router.post('/build', async (req, res) => {
  const schema = Joi.object({
    prompt:             Joi.string().min(3).max(600).required(),
    previousParams:     Joi.object().allow(null).optional(),
    conversationHistory: Joi.array().optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const result = await packageBuilder.buildFromPrompt({
      agencyId:           req.agencyId,
      prompt:             value.prompt,
      previousParams:     value.previousParams     || null,
      conversationHistory: value.conversationHistory || [],
    });

    return res.json({
      success:             result.success,
      packages:            result.packages,
      tripParams:          result.tripParams,
      text:                result.text,
      sessionId:           result.sessionId,
      needsClarification:  result.needsClarification,
      conversationHistory: result.conversationHistory,
    });

  } catch (err) {
    logger.error('agentRequests POST /build', { error: err.message });
    return res.status(500).json({ success: false, error: 'Build failed' });
  }
});

// ─────────────────────────────────────────────
// Internal: deliver result to traveler
// ─────────────────────────────────────────────
async function _deliver(request, packages, outcome) {
  const { session_key, channel, traveler_phone, agent_note, trip_params } = request;

  if (channel === 'widget') {
    const widgetMemory = _getWidgetDelivery();
    if (widgetMemory?.resolveRequest) {
      await widgetMemory.resolveRequest(session_key, {
        packages,
        agentNote: agent_note || null,
        outcome,
      }).catch(err => logger.warn('widgetMemory.resolveRequest failed', { error: err.message }));
    }
    return;
  }

  if (channel === 'whatsapp' && traveler_phone) {
    const ws = _getWhatsApp();
    if (!ws) return;

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) return;

    if (outcome === 'declined') {
      const reason = agent_note
        ? `Sorry, we couldn't put together options for your trip — ${agent_note}. Please try a different search.`
        : "Sorry, we couldn't find suitable options for your trip right now. Please try again with different dates or destinations.";
      await ws.sendText(phoneNumberId, traveler_phone, reason).catch(() => {});
      return;
    }

    if (packages.length === 0) return;

    const intro = agent_note
      ? `Here are your options! ${agent_note}`
      : "Here are the options we put together for you:";
    await ws.sendText(phoneNumberId, traveler_phone, intro).catch(() => {});
    await ws.sendPackages(phoneNumberId, traveler_phone, packages).catch(() => {});
    await ws.sendText(phoneNumberId, traveler_phone,
      `Reply with the option number (1-${packages.length}) to book.`
    ).catch(() => {});
  }
}

module.exports = router;