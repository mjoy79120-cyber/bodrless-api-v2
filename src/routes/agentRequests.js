/**
 * AGENT REQUESTS ROUTES  (v2)
 * ─────────────────────────────────────────────────────────────
 * Dashboard endpoints for the package approval flow.
 * Mount:  app.use('/api/agent', authenticateSession, agentRequests);
 *
 * Changes from v1 (only approve / decline / _deliver differ):
 *  - Empty editedPackages ([]) no longer wins over the original packages.
 *  - Edited packages must at least carry a `summary` object.
 *  - _deliver reports success/failure; result is stored in
 *    delivery_status / delivery_error / delivered_at and returned to the
 *    dashboard so an agent isn't told "approved" when nothing arrived.
 *  - WhatsApp: approved packages are saved to packageCache BEFORE sending,
 *    so the traveler replying "1" actually starts a booking.
 *  - Send errors are no longer swallowed individually.
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
function _getPackageCache() {
  try { return require('../services/packageCache'); } catch { return null; }
}

// ─────────────────────────────────────────────
// GET /requests
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
      .select('id, session_key, channel, traveler_phone, trip_params, packages, edited_packages, agent_note, status, rebuild_count, delivery_status, delivery_error, created_at, updated_at, decided_at', { count: 'exact' })
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
// GET /requests/count
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
    editedPackages: Joi.array()
      .items(Joi.object({ summary: Joi.object().required() }).unknown(true))
      .max(4)
      .optional(),
    agentNote: Joi.string().max(500).allow('', null).optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    // Treat an empty edit list as "no edits"
    const edited = value.editedPackages?.length ? value.editedPackages : null;

    // Atomic claim — prevents two agents deciding the same request
    const { data: claimed, error: claimErr } = await supabase
      .from('package_requests')
      .update({
        status:          'approved',
        decided_by:      req.agencyUser.id,
        decided_at:      new Date().toISOString(),
        edited_packages: edited,
        agent_note:      value.agentNote || null,
      })
      .eq('id', req.params.id)
      .eq('agency_id', req.agencyId)
      .eq('status', 'pending')
      .select()
      .single();

    if (claimErr || !claimed) {
      return res.status(409).json({ success: false, error: 'Request already decided or not found' });
    }

    const packagesToSend = claimed.edited_packages?.length ? claimed.edited_packages : (claimed.packages || []);
    const delivery = await _deliver(claimed, packagesToSend, 'approved');
    await _recordDelivery(claimed.id, delivery);

    logger.info('agentRequests: approved', { id: claimed.id, agencyId: req.agencyId, delivery: delivery.status });
    return res.json({ success: true, request: claimed, delivery });

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

    const delivery = await _deliver(claimed, [], 'declined');
    await _recordDelivery(claimed.id, delivery);

    logger.info('agentRequests: declined', { id: claimed.id, agencyId: req.agencyId, delivery: delivery.status });
    return res.json({ success: true, request: claimed, delivery });

  } catch (err) {
    logger.error('agentRequests POST /decline', { error: err.message });
    return res.status(500).json({ success: false, error: 'Decline failed' });
  }
});

// ─────────────────────────────────────────────
// POST /requests/:id/rebuild
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
// POST /build
// ─────────────────────────────────────────────
router.post('/build', async (req, res) => {
  const schema = Joi.object({
    prompt:              Joi.string().min(3).max(600).required(),
    previousParams:      Joi.object().allow(null).optional(),
    conversationHistory: Joi.array().optional(),
  });
  const { error: valErr, value } = schema.validate(req.body);
  if (valErr) return res.status(400).json({ success: false, error: valErr.details[0].message });

  try {
    const result = await packageBuilder.buildFromPrompt({
      agencyId:            req.agencyId,
      prompt:              value.prompt,
      previousParams:      value.previousParams      || null,
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
// Returns { status: 'delivered' | 'failed' | 'skipped', error?: string }
// ─────────────────────────────────────────────
async function _deliver(request, packages, outcome) {
  const { session_key, channel, traveler_phone, agent_note, trip_params } = request;

  try {
    if (channel === 'widget') {
      const widgetMemory = _getWidgetDelivery();
      if (!widgetMemory?.resolveRequest) {
        return { status: 'skipped', error: 'widgetMemory.resolveRequest not available' };
      }
      await widgetMemory.resolveRequest(session_key, {
        packages,
        agentNote: agent_note || null,
        outcome,
      });
      return { status: 'delivered' };
    }

    if (channel === 'whatsapp' && traveler_phone) {
      const ws = _getWhatsApp();
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (!ws || !phoneNumberId) {
        return { status: 'skipped', error: 'WhatsApp service or WHATSAPP_PHONE_NUMBER_ID missing' };
      }

      if (outcome === 'declined') {
        const reason = agent_note
          ? `Sorry, we couldn't put together options for your trip — ${agent_note}. Please try a different search.`
          : "Sorry, we couldn't find suitable options for your trip right now. Please try again with different dates or destinations.";
        await ws.sendText(phoneNumberId, traveler_phone, reason);
        return { status: 'delivered' };
      }

      if (packages.length === 0) {
        return { status: 'skipped', error: 'No packages to send' };
      }

      // Save BEFORE sending: once the traveler sees the options and replies "1",
      // the webhook's selection flow reads this cache.
      const cache = _getPackageCache();
      if (cache?.save) {
        await cache.save(session_key, packages, trip_params || null);
      } else {
        logger.warn('agentRequests: packageCache unavailable — traveler will not be able to pick by number');
      }

      const intro = agent_note
        ? `Here are your options! ${agent_note}`
        : "Here are the options we put together for you:";
      await ws.sendText(phoneNumberId, traveler_phone, intro);
      await ws.sendPackages(phoneNumberId, traveler_phone, packages);
      await ws.sendText(phoneNumberId, traveler_phone,
        `Reply with the option number (1-${packages.length}) to book.`
      );
      return { status: 'delivered' };
    }

    return { status: 'skipped', error: `No delivery route for channel "${channel}"` };

  } catch (err) {
    // Typical cause on WhatsApp: free-form message outside the 24h window.
    logger.error('agentRequests: delivery failed', { requestId: request.id, channel, error: err.message, alert: true });
    return { status: 'failed', error: err.message };
  }
}

async function _recordDelivery(requestId, delivery) {
  try {
    const { error } = await supabase
      .from('package_requests')
      .update({
        delivery_status: delivery.status,
        delivery_error:  delivery.error || null,
        delivered_at:    delivery.status === 'delivered' ? new Date().toISOString() : null,
      })
      .eq('id', requestId);
    if (error) logger.warn('agentRequests: could not record delivery status', { requestId, error: error.message });
  } catch (err) {
    logger.warn('agentRequests: recordDelivery threw', { requestId, error: err.message });
  }
}

module.exports = router;
module.exports._deliver = _deliver;   // exported for tests