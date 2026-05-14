require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { logger } = require('./utils/logger');

const tripRoutes = require('./routes/trips');
const webhookRoutes = require('./routes/webhooks');
const agencyRoutes = require('./routes/agencies');
const healthRoutes = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ───────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiting — protect against abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// ─── Routes ───────────────────────────────────────────────
const widgetRoutes = require('./routes/widget');

app.use('/api/trips', tripRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/agencies', agencyRoutes);
app.use('/health', healthRoutes);
app.use('/widget.js', widgetRoutes);

// ✅ FIXED: serve file from ROOT (NOT /src)
app.get('/test-widget.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../test-widget.html'));
});

// ─── Global Error Handler ─────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Something went wrong',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.listen(PORT, () => {
  logger.info(`Bodrless API running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
});

// ─── Keep alive ping every 4 minutes ──────────────────────
const https = require('https');

setInterval(() => {
  https.get('https://bodrless-api-v2.onrender.com/health', (res) => {
    console.log('Keep alive ping:', res.statusCode);
  }).on('error', (err) => {
    console.log('Keep alive error:', err.message);
  });
}, 4 * 60 * 1000);

module.exports = app;
