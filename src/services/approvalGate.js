/**
 * APPROVAL GATE
 * ─────────────────────────────────────────────────────────────
 * Called from webhooks.js and widget delivery, AFTER orchestration
 * returns packages, BEFORE they are sent to the traveler.
 *
 * If the agency is in manual mode:
 *  - Packages are saved as a pending package_request
 *  - The traveler gets a holding message
 *  - Returns { held: true }
 *
 * If auto (or Triply), the gate is a no-op:
 *  - Returns { held: false }
 *
 * Usage in webhooks.js — replace the existing _sendOrchestrationResult
 * call at the bottom of the main handler with:
 *
 *   const gate = require('../services/approvalGate');
 *   const held = await gate.check({
 *     agencyRow, result, userKey, channel: 'whatsapp',
 *     phone: recipient,
 *     send: (msg) => whatsappService.sendText(phoneNumberId, recipient, msg),
 *   });
 *   if (!held) await _sendOrchestrationResult({ phoneNumberId, recipient, userKey, result });
 *
 * Usage in widget trips.js — wrap the response the same way:
 *   const gate = require('../services/approvalGate');
 *   const held = await gate.check({
 *     agencyRow, result, userKey: sessionId, channel: 'widget',
 *     send: () => {},   // widget polls, no push needed
 *   });
 *   if (held) {
 *     return res.json({ success: true, held: true, holdMessage: gate.HOLD_MSG });
 *   }
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

const HOLD_MSG = "Your agent is putting together the best options and will confirm shortly. Hang tight! 🙏";

/**
 * @param {object} opts
 * @param {object} opts.agencyRow    { integration_type, approval_mode }
 * @param {object} opts.result       orchestration result with .packages, .tripParams
 * @param {string} opts.userKey      session key / phone
 * @param {string} opts.channel      'whatsapp' | 'widget'
 * @param {string} [opts.phone]      traveler phone (WhatsApp only)
 * @param {function} opts.send       async (message: string) => void — sends to traveler
 * @returns {Promise<boolean>}       true if packages were held (do not send)
 */
async function check({ agencyRow, result, userKey, channel, phone, send }) {
  // Triply agencies are never gated
  if (agencyRow?.integration_type === 'triply') return false;

  // Auto agencies pass straight through
  if (!agencyRow || agencyRow.approval_mode !== 'manual') return false;

  // No packages to gate — let the clarification or no-results response through
  if (!result.packages?.length) return false;

  try {
    const { error } = await supabase
      .from('package_requests')
      .insert({
        agency_id:      agencyRow.id || null,  // caller must include id in agencyRow select
        session_key:    userKey,
        channel,
        traveler_phone: phone || null,
        trip_params:    result.tripParams   || {},
        packages:       result.packages     || [],
        status:         'pending',
      });

    if (error) {
      logger.error('approvalGate: insert failed — falling through to direct send', { error: error.message, userKey });
      return false;   // fail open: better to send than to silently drop
    }

    logger.info('approvalGate: packages held for agent review', { userKey, channel, count: result.packages.length });
    await send(HOLD_MSG).catch(() => {});
    return true;

  } catch (err) {
    logger.error('approvalGate: unexpected error — falling through', { error: err.message });
    return false;
  }
}

module.exports = { check, HOLD_MSG };