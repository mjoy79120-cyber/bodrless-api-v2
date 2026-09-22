const express  = require('express');
const router   = express.Router();
const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const triplyConversationManager = require('../services/triplyConversationManager');

// ── MIDDLEWARE — validates every request is from Triply ───────
const validateTriplyKey = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const key = authHeader.replace('Bearer ', '').trim();

  const { data: partner, error } = await supabase
    .from('partners')
    .select('id, name, slug, status')
    .eq('master_api_key', key)
    .eq('slug', 'triply')
    .single();

  if (error || !partner) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (partner.status !== 'active') {
    return res.status(403).json({ error: 'Partner account is not active' });
  }

  req.partner = partner;
  next();
};

// ── POST /agencies ────────────────────────────────────────────
// Triply registers a new agency
router.post('/agencies', validateTriplyKey, async (req, res) => {
  const {
    agency_name,
    whatsapp_number,
    website_url,
    triply_agency_id,
    approval_mode = 'manual',
  } = req.body;

  if (!agency_name || !triply_agency_id) {
    return res.status(400).json({
      error: 'agency_name and triply_agency_id are required'
    });
  }

  try {
    // Check if already registered
    const { data: existing } = await supabase
      .from('partner_agencies')
      .select('agency_id')
      .eq('partner_agency_id', triply_agency_id)
      .single();

    if (existing) {
      return res.status(409).json({
        error:     'Agency already registered',
        agency_id: existing.agency_id,
      });
    }

    // Create agency record
    const agencyId = uuidv4();
    const { error: agencyError } = await supabase
  .from('agencies')
  .insert({
    id:               agencyId,
    name:             agency_name,
    email:            req.body.email || `${triply_agency_id}@triply.partner`,
    whatsapp_number:  whatsapp_number || null,
    website:          website_url     || null,
    integration_type: 'triply',
    partner_id:       req.partner.id,
    onboarded_via:    'partner_api',
    approval_mode:    approval_mode,
    created_at:       new Date().toISOString(),
  });

    if (agencyError) throw new Error(agencyError.message);

    // Link to Triply in partner_agencies
    const { error: linkError } = await supabase
      .from('partner_agencies')
      .insert({
        id:                uuidv4(),
        partner_id:        req.partner.id,
        agency_id:         agencyId,
        partner_agency_id: triply_agency_id,
        status:            'active',
        created_at:        new Date().toISOString(),
      });

    if (linkError) throw new Error(linkError.message);

    const baseUrl       = process.env.BASE_URL || 'https://bodrless-api-v2.onrender.com';
    const webhookUrl    = `${baseUrl}/api/webhooks/whatsapp/${agencyId}`;
    const widgetSnippet = `<script src="${baseUrl}/widget.js" data-agency="${agencyId}"></script>`;

    logger.info('[Triply] Agency registered', {
      agencyId, agency_name, triply_agency_id,
    });

    res.status(201).json({
      success:        true,
      agency_id:      agencyId,
      agency_name,
      approval_mode,
      webhook_url:    webhookUrl,
      widget_snippet: widgetSnippet,
      created_at:     new Date().toISOString(),
    });

  } catch (err) {
    logger.error('[Triply] Agency registration failed', { error: err.message });
    res.status(500).json({ error: 'Failed to register agency' });
  }
});

// ── PATCH /agencies/:triply_agency_id ─────────────────────────
// Toggle approval mode for an agency
router.patch('/agencies/:triply_agency_id', validateTriplyKey, async (req, res) => {
  const { triply_agency_id } = req.params;
  const { approval_mode }    = req.body;

  if (!['auto', 'manual'].includes(approval_mode)) {
    return res.status(400).json({
      error: 'approval_mode must be auto or manual'
    });
  }

  try {
    const { data: partnerAgency } = await supabase
      .from('partner_agencies')
      .select('agency_id')
      .eq('partner_agency_id', triply_agency_id)
      .single();

    if (!partnerAgency) {
      return res.status(404).json({ error: 'Agency not found' });
    }

    await supabase
      .from('agencies')
      .update({ approval_mode })
      .eq('id', partnerAgency.agency_id);

    logger.info('[Triply] Approval mode updated', {
      triply_agency_id, approval_mode,
    });

    res.json({
      success:          true,
      triply_agency_id,
      approval_mode,
      message: `Agency switched to ${approval_mode} approval`,
    });

  } catch (err) {
    logger.error('[Triply] Approval mode update failed', { error: err.message });
    res.status(500).json({ error: 'Failed to update approval mode' });
  }
});

// ── GET /conversations/:conversation_id ───────────────────────
// Triply fetches current draft to show agent in dashboard
router.get('/conversations/:conversation_id', validateTriplyKey, async (req, res) => {
  const { conversation_id } = req.params;

  try {
    const draft = await triplyConversationManager.getDraft(conversation_id);
    res.json(draft);
  } catch (err) {
    logger.error('[Triply] Get draft failed', { error: err.message });
    res.status(500).json({ error: 'Failed to get draft' });
  }
});

// ── POST /conversations/:conversation_id/approve ──────────────
// Agent approved the itinerary as is
router.post('/conversations/:conversation_id/approve', validateTriplyKey, async (req, res) => {
  const { conversation_id }              = req.params;
  const { agent_id, set_auto_approval = false } = req.body;

  try {
    const result = await triplyConversationManager.approve(
      conversation_id,
      agent_id,
      { setAutoApproval: set_auto_approval }
    );
    res.json(result);
  } catch (err) {
    logger.error('[Triply] Approve failed', { error: err.message });
    res.status(500).json({ error: 'Failed to approve' });
  }
});

// ── POST /conversations/:conversation_id/edit ─────────────────
// Agent edited the itinerary then approved
router.post('/conversations/:conversation_id/edit', validateTriplyKey, async (req, res) => {
  const { conversation_id }       = req.params;
  const { agent_id, modified_draft } = req.body;

  if (!modified_draft) {
    return res.status(400).json({ error: 'modified_draft is required' });
  }

  try {
    const result = await triplyConversationManager.edit(
      conversation_id,
      agent_id,
      modified_draft
    );
    res.json(result);
  } catch (err) {
    logger.error('[Triply] Edit failed', { error: err.message });
    res.status(500).json({ error: 'Failed to edit and approve' });
  }
});

// ── POST /conversations/:conversation_id/rebuild ──────────────
// Agent wants Bodrless to rebuild with new instructions
router.post('/conversations/:conversation_id/rebuild', validateTriplyKey, async (req, res) => {
  const { conversation_id }      = req.params;
  const { agent_id, instruction } = req.body;

  if (!instruction) {
    return res.status(400).json({ error: 'instruction is required' });
  }

  try {
    const result = await triplyConversationManager.rebuild(
      conversation_id,
      agent_id,
      instruction
    );
    res.json(result);
  } catch (err) {
    logger.error('[Triply] Rebuild failed', { error: err.message });
    res.status(500).json({ error: 'Failed to rebuild' });
  }
});

module.exports = { router, validateTriplyKey };