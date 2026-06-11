require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const https = require('https');
const { logger } = require('./utils/logger');
const { authenticateAgency } = require('./middleware/auth');

const tripRoutes = require('./routes/trips');
const webhookRoutes = require('./routes/webhooks');
const agencyRoutes = require('./routes/agencies');
const healthRoutes = require('./routes/health');
const uploadRoutes = require('./routes/uploads');
const widgetRoutes = require('./routes/widget');
const apiV1Routes = require('./routes/api');

const app = express();

const PORT = process.env.PORT || 3000;

// Security
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
}));

app.use(express.json());

// Rate limiting — stricter for public API
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Rate limit exceeded. Max 30 requests per minute.' },
});

app.set('trust proxy', 1);
app.use('/api/', limiter);
app.use('/api/v1/', apiLimiter);

// Cache busting for widget
app.use('/widget.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// ── Public Routes (no auth) ──────────────────────────
app.use('/api/webhooks', webhookRoutes);
app.use('/health', healthRoutes);
app.use('/widget.js', widgetRoutes);

// ── Public API v1 (OTA/partner API — uses own API key auth inside routes) ──
app.use('/api/v1', apiV1Routes);

// ── Agency signup — public (no auth needed to sign up) ──
app.use('/api/agencies/signup', agencyRoutes);

// ── Protected Routes (auth required) ────────────────
app.use('/api/trips', authenticateAgency, tripRoutes);
app.use('/api/agencies', authenticateAgency, agencyRoutes);
app.use('/api/uploads', authenticateAgency, uploadRoutes);

// Test page
app.get('/test-widget.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../test-widget.html'));
});

// API docs landing
app.get('/', (req, res) => {
  res.json({
    name: 'Bodrless API',
    version: '1.0',
    description: 'Trip planning and booking infrastructure for travel agents and OTAs',
    endpoints: {
      public_api: '/api/v1',
      widget: '/widget.js?key=YOUR_AGENCY_ID',
      webhooks: '/api/webhooks/whatsapp',
      health: '/health',
      signup: 'POST /api/agencies/signup',
    },
    docs: 'https://bodrless-api-v2.onrender.com/api/v1',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Something went wrong',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Server start
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Bodrless API running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
});

// Keep alive — only in production
if (process.env.NODE_ENV === 'production') {
  const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://bodrless-api-v2.onrender.com';
  setInterval(() => {
    https.get(renderUrl + '/health', (res) => {
      console.log('Keep alive ping:', res.statusCode);
    }).on('error', (err) => {
      console.log('Keep alive error:', err.message);
    });
  }, 4 * 60 * 1000);
}

module.exports = app;