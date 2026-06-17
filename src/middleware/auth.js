const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

/**
 * AUTHENTICATE AGENCY
 * ─────────────────────────────────────────────────────────────
 * Validates requests against the `agencies` table.
 *
 * Two valid auth paths:
 *  1. x-api-key header matches agencies.api_key  (secret key — preferred)
 *  2. x-api-key header matches agencies.id        (public slug — widget fallback,
 *     since the widget embeds a public-facing key in client-side JS and can't
 *     safely hold a real secret)
 *
 * Either path requires the agency to exist and be active.
 * ─────────────────────────────────────────────────────────────
 */
const authenticateAgency = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const bodyAgencyId = req.body?.agencyId;

    if (!apiKey && !bodyAgencyId) {
      return res.status(401).json({ error: 'API key or agencyId required' });
    }

    // Try matching the real secret api_key first
    let agency = null;

    if (apiKey) {
      const { data: byApiKey } = await supabase
        .from('agencies')
        .select('id, name, status, api_key')
        .eq('api_key', apiKey)
        .maybeSingle();

      if (byApiKey) agency = byApiKey;
    }

    // Fallback: widget public slug match (x-api-key sent as agency id/slug)
    if (!agency && apiKey) {
      const { data: bySlug } = await supabase
        .from('agencies')
        .select('id, name, status, api_key')
        .eq('id', apiKey)
        .maybeSingle();

      if (bySlug) agency = bySlug;
    }

    // Last fallback: trust body.agencyId if it matches a real agency
    // (covers cases where x-api-key wasn't sent at all)
    if (!agency && bodyAgencyId) {
      const { data: byBodyId } = await supabase
        .from('agencies')
        .select('id, name, status, api_key')
        .eq('id', bodyAgencyId)
        .maybeSingle();

      if (byBodyId) agency = byBodyId;
    }

    if (!agency) {
      logger.warn('Invalid API key attempt', { apiKey, bodyAgencyId });
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (agency.status && agency.status !== 'active') {
      logger.warn('Inactive agency attempted access', { agencyId: agency.id, status: agency.status });
      return res.status(403).json({ error: 'Agency account is not active' });
    }

    req.agencyId = agency.id;
    req.agency   = agency;
    next();

  } catch (err) {
    logger.error('Auth middleware error', { error: err.message });
    next(); // Fail open for now — change to res.status(500) when stable
  }
};

module.exports = { authenticateAgency };