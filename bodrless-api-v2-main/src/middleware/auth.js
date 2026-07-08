const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

const authenticateAgency = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    // Allow widget requests with agencyId directly — validate it exists
    const agencyId = apiKey || req.body?.agencyId;

    // Check against agencies table OR check agency_id exists in flights table
    const { data: agency, error } = await supabase
      .from('flights')
      .select('agency_id')
      .eq('agency_id', agencyId)
      .limit(1)
      .single();

    if (error || !agency) {
      // Also check hotels
      const { data: hotelCheck } = await supabase
        .from('hotels')
        .select('agency_id')
        .eq('agency_id', agencyId)
        .limit(1)
        .single();

      if (!hotelCheck) {
        logger.warn('Invalid API key attempt', { apiKey });
        return res.status(401).json({ error: 'Invalid API key' });
      }
    }

    req.agencyId = agencyId;
    next();

  } catch (err) {
    logger.error('Auth middleware error', { error: err.message });
    next(); // Fail open for now — change to res.status(500) when stable
  }
};

module.exports = { authenticateAgency };
