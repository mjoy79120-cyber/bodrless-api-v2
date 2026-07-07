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
const intasendWebhookRoutes = require('./routes/intasend');
const duffelWebhookRoutes = require('./routes/duffelWebhooks');
const agencyRoutes = require('./routes/agencies');
const healthRoutes = require('./routes/health');
const uploadRoutes = require('./routes/uploads');
const widgetRoutes = require('./routes/widget');
const apiV1Routes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const { startSweeper } = require('./services/paymentSweeper');
const tracking = require('./services/trackingService');
const insightsEngine = require('./services/insightsEngine');
const hotelbedsContent = require('./services/hotelbedsContent');

// ── Hotel direct ──────────────────────────────────────────────
const cookieParser     = require('cookie-parser');
const hotelRoutes      = require('./routes/hotelRoutes');
const hotelAdminRouter = require('./routes/hotelAdmin');
// ─────────────────────────────────────────────────────────────

const app = express();

const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-hotel-key', 'Authorization'],
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

app.use(cookieParser());
app.set('trust proxy', 1);

// ── Public Webhook Routes (no auth, no rate limit) ────
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', intasendWebhookRoutes);
app.use('/api/webhooks', duffelWebhookRoutes);

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

app.use('/widget.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// ── Public Routes ─────────────────────────────────────
app.use('/health', healthRoutes);
app.use('/widget.js', widgetRoutes);

// ── Hotel Direct API ──────────────────────────────────
app.use('/api/hotel', hotelRoutes);

// ── Hotel Admin Panel ─────────────────────────────────
app.use('/hotel-admin', hotelAdminRouter);

// ── Public API v1 ─────────────────────────────────────
app.use('/api/v1', apiV1Routes);

// ── Agency routes ─────────────────────────────────────
app.use('/api/agencies', agencyRoutes);

// ── Admin dashboard ───────────────────────────────────
app.use('/admin', adminRoutes);

// ── Protected Routes ──────────────────────────────────
const { authenticateAgency } = require('./middleware/auth');
app.use('/api/trips',   authenticateAgency, tripRoutes);
app.use('/api/uploads', authenticateAgency, uploadRoutes);

// ── Existing test page ────────────────────────────────
app.get('/test-widget.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../test-widget.html'));
});

// ── Hotel direct test page ────────────────────────────
// Usage: /test-hotel.html?hotel=sarova
// Works for any hotel slug in hotel_groups table.
app.get('/test-hotel.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  const hotelSlug = req.query.hotel || 'sarova';
  const apiBase   = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';

  const hotelMeta = {
    sarova:   { name: 'Sarova Hotels',   searches: [
      'Deluxe room Stanley Nairobi 3 nights from August 10, half board',
      'Sea view room Whitesands Mombasa 5 nights all inclusive',
      'Honeymoon package Mombasa 7 nights',
      '2 nights Stanley Nairobi then 3 nights Masai Mara then 4 nights Whitesands',
      'Safari lodge Samburu 3 nights full board 2 adults',
      'Family room Nairobi 2 adults 2 kids bed and breakfast',
    ]},
    serena:   { name: 'Serena Hotels',   searches: ['Book a room for 3 nights'] },
    prideinn: { name: 'PrideInn Hotels', searches: ['Book a room for 3 nights'] },
  };

  const meta     = hotelMeta[hotelSlug] || { name: hotelSlug + ' Hotels', searches: ['Book a room for 3 nights'] };
  const hotelName = meta.name;
  const searches  = meta.searches;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${hotelName} — Book Direct</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #f0f2f5; min-height: 100vh; }
    .hero {
      background: linear-gradient(135deg, #1E2A5E 0%, #2d3f82 100%);
      color: white; padding: 60px 24px; text-align: center;
      border-bottom: 4px solid #C0392B;
    }
    .hero h1 { font-size: 32px; margin: 0 0 8px 0; }
    .hero p  { font-size: 16px; opacity: 0.8; margin: 0 0 12px 0; }
    .badge   { display: inline-block; background: rgba(255,255,255,0.15); color: white; border-radius: 20px; padding: 4px 12px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; }
    .content { max-width: 800px; margin: 40px auto; padding: 0 24px; }
    .card    { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); margin-bottom: 20px; }
    .card h3 { color: #1E2A5E; margin: 0 0 14px 0; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
    .searches { display: flex; flex-direction: column; gap: 8px; }
    .search-pill {
      background: #F8F9FC; border: 1px solid #E4E8F0; border-radius: 8px;
      padding: 12px 16px; font-size: 13px; color: #1E2A5E; cursor: pointer;
      text-align: left; transition: all 0.15s; line-height: 1.4;
    }
    .search-pill:hover { background: #1E2A5E; color: white; border-color: #1E2A5E; }
    .search-pill::before { content: "💬 "; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>🏨 ${hotelName}</h1>
    <p>Book direct — instant confirmation, best rates</p>
    <span class="badge">Powered by Bodrless</span>
  </div>
  <div class="content">
    <div class="card">
      <h3>Try these searches</h3>
      <div class="searches">
        ${searches.map(s => `<button class="search-pill" onclick="sendSearch(this.getAttribute('data-search'))" data-search="${s}">${s}</button>`).join('\n        ')}
      </div>
    </div>
  </div>
  <script>
    function sendSearch(text) {
      var trigger = document.getElementById('bodrless-trigger');
      if (trigger) { trigger.click(); }
      setTimeout(function() {
        var input = document.getElementById('bodrless-input');
        if (input) {
          input.value = text;
          var sendBtn = document.getElementById('bodrless-send');
          if (sendBtn) sendBtn.click();
        }
      }, 400);
    }
  </script>
  <script src="${apiBase}/widget.js?key=${hotelSlug}&name=${encodeURIComponent(hotelName)}&mode=hotel_direct"></script>
</body>
</html>`);
});

// ── API docs ──────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: 'Bodrless API',
    version: '1.0',
    description: 'Trip planning and booking infrastructure for travel agents, OTAs and hotels',
    endpoints: {
      public_api:          '/api/v1',
      widget:              '/widget.js?key=YOUR_AGENCY_ID',
      hotel_widget:        '/widget.js?key=sarova&mode=hotel_direct',
      hotel_test_page:     '/test-hotel.html?hotel=sarova',
      hotel_admin:         '/hotel-admin/login',
      hotel_api:           '/api/hotel/orchestrate',
      hotel_mpesa_webhook: '/api/hotel/webhook/mpesa',
      webhooks:            '/api/webhooks/whatsapp',
      intasend_webhook:    '/api/webhooks/intasend',
      duffel_webhook:      '/api/webhooks/duffel',
      health:              '/health',
      signup:              'POST /api/agencies/signup',
    },
    docs: 'https://bodrless-api-v2.onrender.com/api/v1',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Something went wrong',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

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
      Number(process.env.HOTELBEDS_CONTENT_SYNC_INTERVAL_MS) || 24 * 60 * 60 * 1000;
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