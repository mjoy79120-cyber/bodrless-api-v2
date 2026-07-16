require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const https = require('https');
const { logger } = require('./utils/logger');

const tripRoutes            = require('./routes/trips');
const webhookRoutes         = require('./routes/webhooks');
const intasendWebhookRoutes = require('./routes/intasend');
const duffelWebhookRoutes   = require('./routes/duffelWebhooks');
const agencyRoutes          = require('./routes/agencies');
const healthRoutes          = require('./routes/health');
const uploadRoutes          = require('./routes/uploads');
const widgetRoutes          = require('./routes/widget');
const apiV1Routes           = require('./routes/api');
const adminRoutes           = require('./routes/admin');
const tripMonitoringRoutes  = require('./routes/tripMonitoring');
const { startSweeper }      = require('./services/paymentSweeper');
const monitoringWorker      = require('./workers/monitoringWorker');
const tracking              = require('./services/trackingService');
const insightsEngine        = require('./services/insightsEngine');
const hotelbedsContent      = require('./services/hotelbedsContent');

const cookieParser     = require('cookie-parser');
const hotelRoutes      = require('./routes/hotelRoutes');
const hotelAdminRouter = require('./routes/hotelAdmin');

const app  = express();
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
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); },
}));

app.use(cookieParser());
app.set('trust proxy', 1);

// ── Public Webhook Routes (no auth, no rate limit) ────────────
app.use('/api/webhooks', webhookRoutes);
app.use('/api/webhooks', intasendWebhookRoutes);
app.use('/api/webhooks', duffelWebhookRoutes);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  message: { error: 'Too many requests, please try again later.' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Rate limit exceeded. Max 30 requests per minute.' },
});
app.use('/api/', limiter);
app.use('/api/v1/', apiLimiter);

app.use('/widget.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// ── Routes ────────────────────────────────────────────────────
app.use('/health',       healthRoutes);
app.use('/widget.js',    widgetRoutes);
app.use('/api/hotel',    hotelRoutes);
app.use('/hotel-admin',  hotelAdminRouter);
app.use('/api/v1',       apiV1Routes);
app.use('/api/agencies', agencyRoutes);
app.use('/admin',        adminRoutes);

const { authenticateAgency } = require('./middleware/auth');
app.use('/api/trips',      authenticateAgency, tripRoutes);
app.use('/api/uploads',    authenticateAgency, uploadRoutes);
app.use('/api/monitoring', authenticateAgency, tripMonitoringRoutes);

app.get('/test-widget.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'test-widget.html'));
});

// ─────────────────────────────────────────────────────────────
// HOTEL LANDING PAGE
// /hotel/sarova          — clean URL for each hotel group
// /test-hotel.html       — legacy alias
// ─────────────────────────────────────────────────────────────
async function serveHotelLanding(req, res) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  const hotelSlug = req.params.slug || req.query.hotel || 'sarova';
  const apiBase   = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';
  const supabase  = require('./utils/supabase');

  let group      = null;
  let properties = [];

  try {
    const { data: g } = await supabase
      .from('hotel_groups')
      .select('id, name, slug, logo_url, primary_color')
      .eq('slug', hotelSlug)
      .eq('is_active', true)
      .single();
    group = g;

    if (group) {
      const { data: props } = await supabase
        .from('hotel_properties')
        .select('id, name, destination, location, stars, images, description')
        .eq('group_id', group.id)
        .eq('is_active', true)
        .order('sort_order');
      properties = props || [];
    }
  } catch (err) {
    logger.warn('Hotel landing: Supabase fetch failed', { hotelSlug, error: err.message });
  }

  if (!group) {
    return res.status(404).send(`<!DOCTYPE html><html><body style="font-family:'Inter',sans-serif;padding:60px;color:#114B43;">
      <h2>Hotel group "${hotelSlug}" not found.</h2>
      <p style="margin-top:12px;color:#666;">Check the slug matches hotel_groups.slug with is_active = true.</p>
    </body></html>`);
  }

  const primaryColor = group.primary_color || '#114B43';
  const groupName    = group.name;

  // Build conversation starter prompts from real property names
  const prompts = [];
  properties.forEach(p => {
    const n = p.name.toLowerCase();
    if (n.includes('mara') || n.includes('safari') || n.includes('lodge') || n.includes('camp') || n.includes('shaba')) {
      prompts.push(`Family stay at ${p.name} for 2 adults and 2 children, full board.`);
    } else if ((p.destination || '').toLowerCase().includes('mombasa')) {
      prompts.push(`Sea view room at ${p.name} from 12–15 August, all inclusive.`);
    } else if (n.includes('panafric') || n.includes('woodlands') || n.includes('imperial')) {
      prompts.push(`Business stay at ${p.name} tonight for 1 adult.`);
    } else {
      prompts.push(`Book me a room for two at ${p.name} this weekend.`);
    }
  });
  if (properties.length >= 2) {
    const p1 = properties[0];
    const p2 = properties[Math.min(2, properties.length - 1)];
    prompts.push(`2 nights ${p1.destination || p1.name} then 3 nights ${p2.destination || p2.name}.`);
  }
  prompts.push(`Recommend the best ${groupName} property for our anniversary.`);

  const promptsHTML = prompts.slice(0, 4).map(p => {
    const safe = p.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return `<button class="prompt" onclick="sendPrompt(this.dataset.p)" data-p="${safe}">${p}</button>`;
  }).join('\n        ');

  // Property photo grid — only properties with images
  const featuredProps = properties.filter(p => Array.isArray(p.images) && p.images.length > 0).slice(0, 6);
  const propCardsHTML = featuredProps.length > 0 ? `
  <section class="properties">
    <div class="properties-inner">
      <div class="section-eyebrow">Our Collection</div>
      <h2 class="properties-title">Discover our properties</h2>
      <div class="prop-grid">
        ${featuredProps.map(p => {
          const img   = p.images[0];
          const stars = p.stars ? '★'.repeat(Math.min(p.stars, 5)) : '';
          const safep = `Book a room at ${p.name} 3 nights`.replace(/'/g, "\\'");
          return `<div class="prop-card" onclick="sendPrompt('${safep}')">
          <div class="prop-img" style="background-image:url('${img}')"></div>
          <div class="prop-overlay">
            <div class="prop-stars">${stars}</div>
            <div class="prop-name">${p.name}</div>
            <div class="prop-location">${p.location || p.destination || ''}</div>
            <div class="prop-book-cta">Book now →</div>
          </div>
        </div>`;
        }).join('\n        ')}
      </div>
    </div>
  </section>` : '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${groupName} | Book Your Stay</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { font-family: 'Inter', sans-serif; background: #f8f6f2; color: #222; line-height: 1.6; }

    /* HERO */
    .hero {
      position: relative; min-height: 100vh;
      background-image: url("https://images.unsplash.com/photo-1566073771259-6a8506099945?q=80&w=2070&auto=format&fit=crop");
      background-size: cover; background-position: center;
      display: flex; align-items: center; justify-content: center;
    }
    .overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.52); }
    .hero-content {
      position: relative; z-index: 2;
      max-width: 850px; text-align: center;
      color: white; padding: 30px;
    }
    .logo { letter-spacing: 8px; font-size: 13px; font-weight: 600; margin-bottom: 28px; color: #d4af37; text-transform: uppercase; }
    .hero h1 { font-family: 'Playfair Display', serif; font-size: clamp(42px, 7vw, 70px); line-height: 1.1; margin-bottom: 22px; }
    .hero p  { max-width: 560px; margin: 0 auto; font-size: 20px; color: #ececec; font-weight: 300; line-height: 1.75; }
    .hero-btn {
      display: inline-block; margin-top: 44px;
      padding: 18px 44px; background: #b28a2e; color: white;
      text-decoration: none; border-radius: 40px; font-size: 15px;
      font-weight: 500; transition: 0.25s; cursor: pointer;
      border: none; font-family: 'Inter', sans-serif;
    }
    .hero-btn:hover { background: #8f6b1d; transform: translateY(-3px); }

    /* PROPERTIES */
    .properties { background: #fff; }
    .properties-inner { max-width: 1200px; margin: 0 auto; padding: 90px 20px; }
    .section-eyebrow { font-size: 10px; font-weight: 600; letter-spacing: 4px; text-transform: uppercase; color: #b28a2e; margin-bottom: 12px; }
    .properties-title { font-family: 'Playfair Display', serif; font-size: clamp(28px, 4vw, 42px); margin-bottom: 44px; }
    .prop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 3px; }
    .prop-card { position: relative; cursor: pointer; overflow: hidden; height: 280px; background: ${primaryColor}; }
    .prop-img { width: 100%; height: 100%; background-size: cover; background-position: center; transition: transform 0.5s, filter 0.3s; filter: brightness(0.72); }
    .prop-card:hover .prop-img { transform: scale(1.06); filter: brightness(0.5); }
    .prop-overlay { position: absolute; bottom: 0; left: 0; right: 0; padding: 20px; background: linear-gradient(to top, rgba(0,0,0,0.82) 0%, transparent 100%); color: white; transition: padding 0.3s; }
    .prop-card:hover .prop-overlay { padding-bottom: 26px; }
    .prop-stars    { font-size: 10px; color: #d4af37; letter-spacing: 3px; margin-bottom: 6px; }
    .prop-name     { font-family: 'Playfair Display', serif; font-size: 20px; line-height: 1.2; }
    .prop-location { font-size: 11px; color: rgba(255,255,255,0.55); margin-top: 3px; letter-spacing: 0.5px; }
    .prop-book-cta { font-size: 11px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; margin-top: 10px; color: #d4af37; opacity: 0; transition: opacity 0.3s; }
    .prop-card:hover .prop-book-cta { opacity: 1; }

    /* CONCIERGE */
    .concierge { max-width: 1200px; margin: 0 auto; padding: 90px 20px; }
    .section-title { text-align: center; margin-bottom: 56px; }
    .section-title h2 { font-family: 'Playfair Display', serif; font-size: clamp(32px, 5vw, 48px); margin-bottom: 14px; }
    .section-title p  { font-size: 19px; color: #666; font-weight: 300; }
    .widget-card { background: white; border-radius: 22px; overflow: hidden; box-shadow: 0 30px 70px rgba(0,0,0,0.09); }
    .widget-header { background: ${primaryColor}; color: white; padding: 16px 24px; display: flex; align-items: center; }
    .dot { width: 12px; height: 12px; border-radius: 50%; margin-right: 7px; }
    .dot-r { background: #ff605c; } .dot-y { background: #ffbd44; } .dot-g { background: #00ca4e; }
    .widget-header span { margin-left: 8px; font-weight: 600; font-size: 14px; }
    .widget-body { padding: 40px; }
    .welcome { font-size: 19px; margin-bottom: 26px; color: #333; line-height: 1.65; }
    .welcome strong { color: ${primaryColor}; }
    .prompt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .prompt {
      padding: 18px 20px; border: 1.5px solid #e8e3da; cursor: pointer;
      border-radius: 14px; background: #faf9f6; text-align: left;
      transition: 0.22s; font-size: 14px; font-family: 'Inter', sans-serif;
      color: #333; line-height: 1.55;
    }
    .prompt:hover { background: ${primaryColor}; color: white; border-color: ${primaryColor}; transform: translateY(-3px); box-shadow: 0 8px 24px rgba(0,0,0,0.13); }

    /* Widget embedded in page — fills the widget-container div */
    .widget-container { margin-top: 8px; }
    #bodrless-chat.embedded { height: 620px; }

    /* WHY */
    .why { padding: 0 20px 90px; }
    .why-card { max-width: 1200px; margin: 0 auto; }
    .why-card h3 { font-family: 'Playfair Display', serif; font-size: clamp(28px, 4vw, 42px); margin-bottom: 44px; text-align: center; }
    .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 24px; }
    .feature { background: white; padding: 30px; border-radius: 18px; box-shadow: 0 12px 36px rgba(0,0,0,0.06); border-top: 3px solid #d4af37; }
    .feature h4 { color: ${primaryColor}; margin-bottom: 10px; font-size: 15px; }
    .feature p  { color: #666; font-size: 14px; line-height: 1.6; }

    /* FOOTER */
    footer { background: ${primaryColor}; color: white; padding: 70px 20px; }
    .footer-inner { max-width: 1100px; margin: 0 auto; text-align: center; }
    .footer-inner h3   { font-family: 'Playfair Display', serif; font-size: 38px; margin-bottom: 10px; }
    .footer-inner p    { color: rgba(255,255,255,0.7); font-size: 16px; font-weight: 300; }
    .footer-inner span { display: block; margin-top: 28px; color: rgba(255,255,255,0.3); font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; }

    @media (max-width: 768px) {
      .hero h1 { font-size: 40px; }
      .hero p  { font-size: 17px; }
      .widget-body { padding: 24px; }
      .welcome { font-size: 16px; }
      .prompt-grid { grid-template-columns: 1fr; }
      .prop-grid   { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

<section class="hero">
  <div class="overlay"></div>
  <div class="hero-content">
    <div class="logo">${groupName.toUpperCase()}</div>
    <h1>Book Your Stay<br>Naturally</h1>
    <p>Tell us where you'd like to stay,<br>your travel dates, and how many guests.<br>We'll take care of the rest.</p>
    <a href="#concierge" class="hero-btn">Start Planning</a>
  </div>
</section>

${propCardsHTML}

<section id="concierge" class="concierge">
  <div class="section-title">
    <h2>Meet Your ${groupName} Concierge</h2>
    <p>Simply describe your stay — no forms, no dropdowns.</p>
  </div>
  <div class="widget-card">
    <div class="widget-header">
      <div class="dot dot-r"></div>
      <div class="dot dot-y"></div>
      <div class="dot dot-g"></div>
      <span>${groupName} Concierge</span>
    </div>
    <div class="widget-body">
      <div class="welcome">
        👋 <strong>Welcome.</strong><br>
        I'm here to help you book your perfect ${groupName} stay. Try something like:
      </div>
      <div class="prompt-grid">
        ${promptsHTML}
      </div>
      <div class="widget-container" id="hotel-widget-mount"></div>
    </div>
  </div>
</section>

<section class="why">
  <div class="why-card">
    <h3>Why Book Direct?</h3>
    <div class="features">
      <div class="feature">
        <h4>Instant Availability</h4>
        <p>Real-time room availability across all ${groupName} properties, with live pricing.</p>
      </div>
      <div class="feature">
        <h4>Secure Payments</h4>
        <p>Pay safely using M-Pesa or card, directly to ${groupName}.</p>
      </div>
      <div class="feature">
        <h4>Natural Language</h4>
        <p>Our concierge understands plain English — no forms, no dropdowns.</p>
      </div>
      <div class="feature">
        <h4>Complete in Seconds</h4>
        <p>Search, select add-ons, and pay without leaving the conversation.</p>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="footer-inner">
    <h3>${groupName}</h3>
    <p>Refreshing African Hospitality</p>
    <span>Booking powered by Bodrless Infrastructure</span>
  </div>
</footer>

<script>
  // Inject conversation starters
  window.bodrlessStarters = [
    ${prompts.slice(0, 4).map(p => {
      const safe = p.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `{ icon: "🏨", title: "${p.split(' ').slice(0, 3).join(' ')}...", text: '${safe}' }`;
    }).join(',\n    ')}
  ];

  function sendPrompt(text) {
    var input = document.getElementById('bodrless-input');
    var btn   = document.getElementById('bodrless-send');
    if (input && btn) {
      input.value = text;
      btn.click();
      document.getElementById('concierge').scrollIntoView({ behavior: 'smooth' });
    }
  }

  // "Start Planning" scrolls to concierge and focuses input
  document.querySelector('.hero-btn').addEventListener('click', function(e) {
    e.preventDefault();
    document.getElementById('concierge').scrollIntoView({ behavior: 'smooth' });
    setTimeout(function() {
      var input = document.getElementById('bodrless-input');
      if (input) input.focus();
    }, 600);
  });
</script>

<script src="${apiBase}/widget.js?key=${encodeURIComponent(hotelSlug)}&name=${encodeURIComponent(groupName)}&mode=hotel_direct&embed=hotel-widget-mount"></script>

</body>
</html>`);
}

app.get('/hotel/:slug',     serveHotelLanding);
app.get('/test-hotel.html', serveHotelLanding);

app.get('/', (req, res) => {
  res.json({
    name: 'Bodrless API',
    version: '1.0',
    endpoints: {
      hotel_demo:          '/hotel/sarova',
      hotel_admin:         '/hotel-admin/login',
      hotel_api:           '/api/hotel/orchestrate',
      hotel_mpesa_webhook: '/api/hotel/webhook/mpesa',
      widget:              '/widget.js?key=YOUR_AGENCY_ID',
      health:              '/health',
      monitoring:          '/api/monitoring/trips',
    },
  });
});

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

  insightsEngine.refreshAll().catch(err =>
    logger.error('Initial insights refresh failed', { error: err.message })
  );
  setInterval(() => insightsEngine.refreshAll(), 60 * 60 * 1000);

  if (process.env.ENABLE_HOTELBEDS_CONTENT_SYNC === 'true') {
    hotelbedsContent.syncAll().catch(err =>
      logger.error('Initial HotelBeds content sync failed', { error: err.message })
    );
    const interval = Number(process.env.HOTELBEDS_CONTENT_SYNC_INTERVAL_MS) || 24 * 60 * 60 * 1000;
    setInterval(() =>
      hotelbedsContent.syncAll().catch(err =>
        logger.error('Scheduled HotelBeds content sync failed', { error: err.message })
      ), interval
    );
  }

  // ── TRIP MONITORING WORKER ────────────────────────────────
  // Starts the frequency-aware background cron that monitors all
  // active trips (flight status, stage advancement, disruption
  // detection). Fires every 15 minutes internally but respects
  // per-trip check_interval_mins so trips far from departure
  // are only actually checked every 2 hours.
  monitoringWorker.start();
  // ── END TRIP MONITORING WORKER ────────────────────────────
});

if (process.env.NODE_ENV === 'production') {
  const renderUrl = process.env.RENDER_EXTERNAL_URL || 'https://bodrless-api-v2.onrender.com';
  setInterval(() => {
    https.get(renderUrl + '/health', (r) => {
      console.log('Keep alive ping:', r.statusCode);
    }).on('error', (e) => console.log('Keep alive error:', e.message));
  }, 4 * 60 * 1000);
}

// ── Rate Scraper Cron ─────────────────────────────────────────
const cron = require('node-cron');
const { runScraper } = require('./workers/rateScraper');

// Run every 6 hours: midnight, 6am, noon, 6pm
cron.schedule('0 0,6,12,18 * * *', async () => {
  logger.info('[Cron] Firing rate scraper');
  try { await runScraper(); }
  catch (err) { logger.error('[Cron] Scraper error:', { error: err.message }); }
});

// Run once on startup after 10 seconds
setTimeout(async () => {
  logger.info('[Startup] Running initial rate scrape...');
  try { await runScraper(); }
  catch (err) { logger.error('[Startup scraper] Error:', { error: err.message }); }
}, 10000);

module.exports = app;