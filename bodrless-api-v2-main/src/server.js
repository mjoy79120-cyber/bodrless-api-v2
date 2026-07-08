require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { logger } = require('./utils/logger');
const { authenticateAgency } = require('./middleware/auth');

const tripRoutes = require('./routes/trips');
const webhookRoutes = require('./routes/webhooks');
const agencyRoutes = require('./routes/agencies');
const healthRoutes = require('./routes/health');
const uploadRoutes = require('./routes/uploads');
const widgetRoutes = require('./routes/widget');

const app = express();

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// SECURITY
// ─────────────────────────────────────────────

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  })
);

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'x-api-key',
      'Authorization',
    ],
  })
);

app.use(express.json());

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again later.',
  },
});

app.use('/api/', limiter);

// ─────────────────────────────────────────────
// WIDGET CACHE CONTROL
// ─────────────────────────────────────────────

app.use('/widget.js', (req, res, next) => {
  res.setHeader(
    'Cache-Control',
    'no-cache, no-store, must-revalidate'
  );

  res.setHeader(
    'Content-Type',
    'application/javascript'
  );

  next();
});

// ─────────────────────────────────────────────
// PUBLIC ROUTES
// ─────────────────────────────────────────────

app.use('/health', healthRoutes);

app.use('/api/webhooks', webhookRoutes);

app.use('/widget.js', widgetRoutes);

// ─────────────────────────────────────────────
// PROTECTED ROUTES
// ─────────────────────────────────────────────

app.use(
  '/api/trips',
  authenticateAgency,
  tripRoutes
);

app.use(
  '/api/uploads',
  authenticateAgency,
  uploadRoutes
);

app.use(
  '/api/agencies',
  authenticateAgency,
  agencyRoutes
);

// ─────────────────────────────────────────────
// TEST PAGE
// ─────────────────────────────────────────────

app.get('/test-widget.html', (req, res) => {

  res.setHeader(
    'Cache-Control',
    'no-cache, no-store, must-revalidate'
  );

  res.sendFile(
    path.join(
      __dirname,
      '../test-widget.html'
    )
  );
});

// ─────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────

app.get('/', (req, res) => {

  res.json({
    success: true,
    message: 'Bodrless API is running',
    environment:
      process.env.NODE_ENV || 'development',
  });
});

// ─────────────────────────────────────────────
// ERROR HANDLER
// ─────────────────────────────────────────────

app.use((err, req, res, next) => {

  logger.error('Unhandled Error', {
    message: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message:
      process.env.NODE_ENV === 'development'
        ? err.message
        : undefined,
  });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

const server = app.listen(
  PORT,
  '0.0.0.0',
  () => {

    logger.info(
      `🚀 Bodrless API running on port ${PORT}`
    );

    logger.info(
      `🌍 Environment: ${
        process.env.NODE_ENV || 'development'
      }`
    );

  }
);

module.exports = app;