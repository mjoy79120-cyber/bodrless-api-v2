/**
 * PACKAGE BUILDER SERVICE
 * ─────────────────────────────────────────────────────────────
 * Prompt-driven package creation and rebuild.
 * Used by:
 *  - agentRequests.js  POST /rebuild  (refine an existing request)
 *  - agentRequests.js  POST /build    (create from scratch)
 *
 * Calls the orchestration engine directly (not via HTTP) so it
 * can run server-side without needing a self-referencing fetch.
 * ─────────────────────────────────────────────────────────────
 */

const orchestrationEngine = require('../orchestration/engine');
const supabase             = require('../utils/supabase');
const { logger }           = require('../utils/logger');

const MAX_REBUILDS_PER_REQUEST = 5;   // hard cap per package_request row
const MAX_OPTIONS_IN_RESULT    = 4;   // never return more than 4 options

/**
 * Build packages from a plain-English prompt.
 * Used for the "Package Builder" page — no existing request.
 *
 * @param {object} opts
 * @param {string} opts.agencyId
 * @param {string} opts.prompt
 * @param {object} [opts.previousParams]   carry over trip params from prior build
 * @param {Array}  [opts.conversationHistory]
 * @returns {{ success, packages, tripParams, text, sessionId }}
 */
async function buildFromPrompt({ agencyId, prompt, previousParams = null, conversationHistory = [] }) {
  logger.info('PackageBuilder: buildFromPrompt', { agencyId, prompt: prompt.slice(0, 80) });

  const result = await orchestrationEngine.orchestrate(prompt, agencyId, {
    conversationHistory,
    previousParams,
    channel: 'widget',           // widget channel — no WhatsApp formatting
  });

  const packages = (result.packages || []).slice(0, MAX_OPTIONS_IN_RESULT);

  return {
    success:             packages.length > 0 || result.needsClarification,
    packages,
    tripParams:          result.tripParams  || null,
    text:                result.text        || null,
    sessionId:           result.sessionId   || null,
    needsClarification:  result.needsClarification || false,
    conversationHistory: result.conversationHistory || conversationHistory,
  };
}

/**
 * Rebuild packages for an existing request using a new prompt.
 * Enforces per-request rebuild cap and logs each attempt.
 *
 * @param {object} opts
 * @param {string} opts.requestId    uuid — package_requests.id
 * @param {string} opts.agencyId
 * @param {string} opts.prompt       agent's refinement instruction
 * @param {string} opts.agentUserId  profiles.id of the acting agent
 * @returns {{ success, packages, tripParams, text, limitReached }}
 */
async function rebuildRequest({ requestId, agencyId, prompt, agentUserId }) {
  logger.info('PackageBuilder: rebuildRequest', { requestId, agencyId, prompt: prompt.slice(0, 80) });

  // Load the existing request
  const { data: req, error: fetchErr } = await supabase
    .from('package_requests')
    .select('id, agency_id, status, rebuild_count, rebuild_log, trip_params, packages')
    .eq('id', requestId)
    .eq('agency_id', agencyId)
    .single();

  if (fetchErr || !req) {
    return { success: false, error: 'Request not found' };
  }
  if (req.status !== 'pending') {
    return { success: false, error: `Request is already ${req.status}` };
  }
  if (req.rebuild_count >= MAX_REBUILDS_PER_REQUEST) {
    return { success: false, limitReached: true, error: `Rebuild limit (${MAX_REBUILDS_PER_REQUEST}) reached` };
  }

  // Sanitise prompt — strip anything that looks like a prompt injection
  const safePrompt = _sanitisePrompt(prompt);
  if (!safePrompt) {
    return { success: false, error: 'Prompt is empty after sanitisation' };
  }

  // Orchestrate with the original trip params as context
  const result = await orchestrationEngine.orchestrate(safePrompt, agencyId, {
    conversationHistory: [],
    previousParams: req.trip_params || null,
    channel: 'widget',
  });

  const newPackages = (result.packages || []).slice(0, MAX_OPTIONS_IN_RESULT);

  // Append to rebuild log
  const logEntry = {
    at:         new Date().toISOString(),
    agentId:    agentUserId,
    prompt:     safePrompt,
    resultCount: newPackages.length,
  };
  const newLog = [...(req.rebuild_log || []), logEntry];

  // Persist: bump count, store new packages as edited_packages, log the attempt
  const { error: updateErr } = await supabase
    .from('package_requests')
    .update({
      rebuild_count:   req.rebuild_count + 1,
      rebuild_log:     newLog,
      edited_packages: newPackages.length > 0 ? newPackages : req.packages,
      trip_params:     result.tripParams || req.trip_params,
    })
    .eq('id', requestId);

  if (updateErr) {
    logger.error('PackageBuilder: rebuild update failed', { requestId, error: updateErr.message });
  }

  return {
    success:    true,
    packages:   newPackages,
    tripParams: result.tripParams || req.trip_params,
    text:       result.text       || null,
    rebuildsLeft: MAX_REBUILDS_PER_REQUEST - req.rebuild_count - 1,
  };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function _sanitisePrompt(raw) {
  if (!raw || typeof raw !== 'string') return null;
  // Strip common injection patterns
  const cleaned = raw
    .replace(/\bsystem\s*:/gi, '')
    .replace(/\bignore\s+(previous|all|above)\b/gi, '')
    .replace(/\bact\s+as\b/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();
  if (cleaned.length < 3 || cleaned.length > 600) return null;
  return cleaned;
}

module.exports = { buildFromPrompt, rebuildRequest };