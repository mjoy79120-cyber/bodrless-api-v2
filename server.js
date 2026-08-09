require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const https = require('https');
const { logger } = require('./src/utils/logger');

const tripRoutes = require('./src/routes/trips');
const webhookRoutes = require('./src/routes/webhooks');
const intasendWebhookRoutes = require('./src/routes/intasend');
const duffelWebhookRoutes = require('./src/routes/duffelWebhooks');
const agencyRoutes = require('./src/routes/agencies');
const healthRoutes = require('./src/routes/health');
const uploadRoutes = require('./src/routes/uploads');
const widgetRoutes = require('./src/routes/widget');
const adminRoutes = require('./src/routes/admin');
const itineraryRoutes = require('./src/routes/itineraryRoutes');
const { startSweeper } = require('./src/services/paymentSweeper');
const tracking = require('./src/services/trackingService');
const insightsEngine = require('./src/services/insightsEngine');
const hotelbedsContent = require('./src/services/hotelbedsContent');

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

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

app.set('trust proxy', 1);

// ── Public Webhook Routes (no auth, no rate limit) ────
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', intasendWebhookRoutes);
app.use('/api/webhooks', duffelWebhookRoutes);

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

app.use('/api/', limiter);
app.use('/api/v1/', apiLimiter);

// Cache busting for widget
app.use('/widget.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// ── Other Public Routes (no auth) ─────────────────────
app.use('/health', healthRoutes);
app.use('/widget.js', widgetRoutes);

// ── Agency routes (auth handled inside the router) ───
app.use('/api/agencies', agencyRoutes);

// ── Admin dashboard (protected by BODRLESS_ADMIN_KEY) ─
app.use('/admin', adminRoutes);

// ── Other Protected Routes ────────────────────────────
const { authenticateAgency } = require('./src/middleware/auth');
app.use('/api/trips',            authenticateAgency, tripRoutes);
app.use('/api/trips/itinerary',  itineraryRoutes);
app.use('/api/uploads',          authenticateAgency, uploadRoutes);

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
      duffel_webhook:   '/api/webhooks/duffel',
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

  startSweeper();

  setInterval(() => tracking.checkStuckPayments(), 5 * 60 * 1000);
  logger.info('Stuck payment checker started (every 5 min)');

  insightsEngine.refreshAll().catch(err => logger.error('Initial insights refresh failed', { error: err.message }));
  setInterval(() => insightsEngine.refreshAll(), 60 * 60 * 1000);
  logger.info('Insights engine scheduled (hourly, plus on startup)');

  if (process.env.ENABLE_HOTELBEDS_CONTENT_SYNC === 'true') {
    hotelbedsContent.syncAll().catch(err =>
      logger.error('Initial HotelBeds content sync failed', { error: err.message })
    );

    const HOTELBEDS_CONTENT_SYNC_INTERVAL_MS =
      Number(process.env.HOTELBEDS_CONTENT_SYNC_INTERVAL_MS) ||
      24 * 60 * 60 * 1000;

    setInterval(
      () => hotelbedsContent.syncAll().catch(err =>
        logger.error('Scheduled HotelBeds content sync failed', { error: err.message })
      ),
      HOTELBEDS_CONTENT_SYNC_INTERVAL_MS
    );

    logger.info('HotelBeds content sync scheduled (every 24h, plus on startup)');
  } else {
    logger.info('HotelBeds content sync is disabled.');
  }
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