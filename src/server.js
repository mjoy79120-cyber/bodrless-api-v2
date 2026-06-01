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
const agencyRoutes = require('./routes/agencies');
const healthRoutes = require('./routes/health');
const uploadRoutes = require('./routes/uploads');
const widgetRoutes = require('./routes/widget');

const app = express();

const PORT = process.env.PORT;

// ─── Security Middleware ─────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
}));

app.use(express.json());

// ─── Rate Limiting ───────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  trustProxy: true,
});

app.set('trust proxy', 1);
app.use('/api/', limiter);

// ─── Cache busting for widget ────────────────────────
app.use('/widget.js', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Content-Type', 'application/javascript');
  next();
});

// ─── Routes ──────────────────────────────────────────
app.use('/api/trips', tripRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/agencies', agencyRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/health', healthRoutes);
app.use('/widget.js', widgetRoutes);

// ─── Test Page ────────────────────────────────────────
app.get('/test-widget.html', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '../test-widget.html'));
});

// ─── Root ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'Bodrless API is running' });
});

// ─── Global Error Handler ─────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Something went wrong',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ─── Server Start ─────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Bodrless API running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV}`);
});

// ─── Keep Alive ───────────────────────────────────────
setInterval(() => {
  https
    .get('https://bodrless-api-v2.onrender.com/health', (res) => {
      console.log('Keep alive ping:', res.statusCode);
    })
    .on('error', (err) => {
      console.log('Keep alive error:', err.message);
    });
}, 4 * 60 * 1000);

module.exports = app;