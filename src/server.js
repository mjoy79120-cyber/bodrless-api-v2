require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const https = require('https');
const { logger } = require('./utils/logger');

const tripRoutes = require('./routes/trips');
const webhookRoutes = require('./routes/webhooks');
const intasendWebhookRoutes = require('./routes/webhooks-intasend');
const agencyRoutes = require('./routes/agencies');
const healthRoutes = require('./routes/health');
const uploadRoutes = require('./routes/uploads');
const widgetRoutes = require('./routes/widget');
const apiV1Routes = require('./routes/api');
const { startSweeper } = require('./services/paymentSweeper');

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

// Rate limiting
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
app.use('/api/webhooks', intasendWebhookRoutes); // adds POST /api/webhooks/intasend
app.use('/health', healthRoutes);
app.use('/widget.js', widgetRoutes);

// ── Public API v1 (OTA/partner API) ──────────────────
app.use('/api/v1', apiV1Routes);

// ── Agency routes (auth handled inside the router) ───
app.use('/api/agencies', agencyRoutes);

// ── Other Protected Routes ────────────────────────────
const { authenticateAgency } = require('./middleware/auth');
app.use('/api/trips',   authenticateAgency, tripRoutes);
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
      public_api:  '/api/v1',
      widget:      '/widget.js?key=YOUR_AGENCY_ID',
      webhooks:    '/api/webhooks/whatsapp',
      intasend_webhook: '/api/webhooks/intasend',
      health:      '/health',
      signup:      'POST /api/agencies/signup',
      register:    'POST /api/agencies/register',
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

  // Start the payment sweeper — auto-cancels stale unpaid HotelBeds
  // bookings past their payment deadline (the Option C safety net).
  startSweeper();
});

// Keep alive — production only
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