// ── Agency Routes ────────────────────────────────────────────
const express = require('express');
const router = express.Router();

// Register a new agency
router.post('/register', async (req, res) => {
  // TODO: Create agency account, generate API key, set up WhatsApp webhook
  res.json({
    success: true,
    message: 'Agency registration endpoint',
    agencyId: `agency_${Date.now()}`,
    apiKey: `bdr_${Math.random().toString(36).substr(2, 32)}`,
  });
});

// Get agency dashboard stats
router.get('/:agencyId/stats', async (req, res) => {
  // TODO: Return real stats from database
  res.json({
    agencyId: req.params.agencyId,
    totalBookings: 0,
    totalGMV: 0,
    activeAgents: 0,
    message: 'Connect to your database for real stats',
  });
});

module.exports = router;
