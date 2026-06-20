/**
 * SESSION AUTH MIDDLEWARE
 * ─────────────────────────────────────────────────────────────
 * Validates a Supabase Auth session token (JWT) sent as
 * "Authorization: Bearer <token>" — used by the Lovable dashboard
 * for logged-in agency users, separate from authenticateAgency
 * (which validates the long-lived api_key for server-side/widget use).
 *
 * On success, sets req.agencyId and req.agencyUser for downstream
 * route handlers to use.
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

const authenticateSession = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({ success: false, error: 'No session token provided' });
    }

    const { data: userData, error: userError } = await supabase.auth.getUser(token);

    if (userError || !userData?.user) {
      return res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('agency_id, role')
      .eq('id', userData.user.id)
      .single();

    if (profileError || !profile) {
      return res.status(403).json({ success: false, error: 'No agency linked to this account' });
    }

    const { data: agency } = await supabase
      .from('agencies')
      .select('id, status')
      .eq('id', profile.agency_id)
      .single();

    if (!agency || agency.status !== 'active') {
      return res.status(403).json({ success: false, error: 'Agency account is not active' });
    }

    req.agencyId   = profile.agency_id;
    req.agencyUser = userData.user;
    next();

  } catch (err) {
    logger.error('Session auth middleware error', { error: err.message });
    return res.status(500).json({ success: false, error: 'Authentication error' });
  }
};

module.exports = { authenticateSession };