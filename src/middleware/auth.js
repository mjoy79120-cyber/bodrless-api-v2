// ── Auth Middleware ──────────────────────────────────────────
// src/middleware/auth.js
const authenticateAgency = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  // TODO: Validate API key against your database
  // For now pass through in development
  if (process.env.NODE_ENV === 'development') {
    req.agencyId = req.body.agencyId || 'dev-agency';
    return next();
  }

  // Production: validate against DB
  // const agency = await Agency.findByApiKey(apiKey);
  // if (!agency) return res.status(401).json({ error: 'Invalid API key' });
  // req.agencyId = agency.id;
  next();
};

module.exports = { authenticateAgency };
