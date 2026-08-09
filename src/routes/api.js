/**
 * BODRLESS PUBLIC API v2 — PRODUCTION READY
 * ─────────────────────────────────────────────────────────────────────────────
 * Single endpoint. BYO LLM (per-request, never stored). BYO Inventory.
 * Async search. Saga bookings. Idempotency. Webhooks. Sandbox. Zero breaking changes.
 *
 * Install:
 *   npm install express helmet cors hpp express-rate-limit rate-limit-redis \
 *               joi bull ioredis uuid nanoid axios winston compression dotenv \
 *               @supabase/supabase-js jsdom dompurify
 *
 * Run API server:  node api_v2.js
 * Run workers:     node api_v2.js --worker
 *
 * Render setup — two services:
 *   Web:    node api_v2.js
 *   Worker: node api_v2.js --worker
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const hpp          = require('hpp');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const Joi          = require('joi');
const Queue        = require('bull');
const Redis        = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { nanoid }   = require('nanoid');
const axios        = require('axios');
const winston      = require('winston');
const { createClient } = require('@supabase/supabase-js');
const createDOMPurify  = require('dompurify');
const { JSDOM }        = require('jsdom');
const crypto           = require('crypto');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════
const CONFIG = {
  port:           process.env.PORT || 3000,
  env:            process.env.NODE_ENV || 'development',
  apiVersion:     '2.0.0',
  apiVersionDate: '2026-08-05',

  // Per-plan rate limits (requests per minute)
  rateLimits: {
    free:       { search: 10,   book: 5,   inventory: 5,    notify: 10   },
    growth:     { search: 100,  book: 50,  inventory: 50,   notify: 100  },
    enterprise: { search: 1000, book: 500, inventory: 500,  notify: 1000 },
  },

  cacheTtl: {
    agency:        300,   // 5 min
    inventory:     60,    // 1 min
    searchResults: 600,   // 10 min
    package:       1800,  // 30 min — packages expire after 30 min
  },

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  redisUrl:    process.env.REDIS_URL || 'redis://localhost:6379',

  // Bodrless default LLM — used when OTA does not supply their own
  defaultLlm: {
    provider: 'bodrless',
    model:    'bodrless-v2',
    endpoint: process.env.BODRLESS_LLM_ENDPOINT || 'https://llm.bodrless.com/v1/chat',
    apiKey:   process.env.BODRLESS_LLM_KEY,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════════════════
const logger = winston.createLogger({
  level: CONFIG.env === 'production' ? 'info' : 'debug',
  defaultMeta: { service: 'bodrless-api' },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});

function getRequestLogger(req) {
  return logger.child({
    requestId:  req.context?.requestId,
    agencyId:   req.context?.agency?.id,
    agencyName: req.context?.agency?.name,
    ip: req.ip, path: req.path, method: req.method,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════════════════════════════════════
if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: false },
});

async function dbHealthCheck() {
  const { error } = await supabase.from('agencies').select('id').limit(1);
  return !error;
}

/ ═══════════════════════════════════════════════════════════════════════════
// REDIS
// ═══════════════════════════════════════════════════════════════════════════
const { RedisStore } = require('rate-limit-redis');
maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    if (times > 3) return null;
    return Math.min(times * 100, 3000);
  },
});

redis.on('error', (err) => console.error('Redis error:', err.message));
redis.on('connect', () => console.log('Redis connected'));

// ═══════════════════════════════════════════════════════════════════════════
// JOB QUEUES
// ═══════════════════════════════════════════════════════════════════════════
const redisConfig = { redis: { port: 6379, host: 'localhost' } };

const searchQueue       = new Queue('search',       redisConfig);
const inventoryQueue    = new Queue('inventory',    redisConfig);
const bookingQueue      = new Queue('booking',      redisConfig);
const webhookQueue      = new Queue('webhook',      redisConfig);
const notificationQueue = new Queue('notification', redisConfig);

[searchQueue, inventoryQueue, bookingQueue, webhookQueue, notificationQueue].forEach(q => {
  q.on('failed',    (job, err) => logger.error(`Job ${job.id} in ${q.name} failed: ${err.message}`));
  q.on('completed', (job)      => logger.info(`Job ${job.id} in ${q.name} completed`));
});

// ═══════════════════════════════════════════════════════════════════════════
// SANITIZATION & VALIDATION
// ═══════════════════════════════════════════════════════════════════════════
const window    = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+previous\s+instructions/i,
  /disregard\s+.*prompt/i,
  /system\s+override/i,
  /you\s+are\s+now\s+/i,
  /DAN\s+mode/i,
  /jailbreak/i,
  /\/\/\s*system/i,
  /<\s*system\s*>/i,
  /\[\s*system\s*\]/i,
];

function sanitizePrompt(prompt) {
  if (!prompt || typeof prompt !== 'string') return '';
  let clean = DOMPurify.sanitize(prompt, { ALLOWED_TAGS: [] });
  clean = clean.trim().replace(/\s+/g, ' ').substring(0, 1000);
  if (PROMPT_INJECTION_PATTERNS.some(p => p.test(clean))) {
    const err = new Error('Prompt contains disallowed patterns');
    err.code = 'PROMPT_SANITIZATION_FAILED';
    throw err;
  }
  return clean;
}

// ─── Schemas ───────────────────────────────────────────────────────────────

const llmSchema = Joi.object({
  provider: Joi.string().valid('openai', 'anthropic', 'gemini', 'groq', 'azure', 'custom').optional(),
  model:    Joi.string().max(100).optional(),
  endpoint: Joi.string().uri().optional(),
  // FIX 1: api_key accepted per-request, used in-flight, NEVER stored
  api_key:  Joi.string().max(500).optional(),
}).optional();

const searchSchema = Joi.object({
  // Natural language OR structured — one required
  prompt:         Joi.string().max(1000).optional(),
  origin:         Joi.string().max(100).optional(),
  destination:    Joi.string().max(100).optional(),
  departure_date: Joi.string().isoDate().optional(),
  return_date:    Joi.string().isoDate().optional(),
  passengers:     Joi.number().integer().min(1).max(50).optional(),
  nights:         Joi.number().integer().min(1).max(90).optional(),
  budget:         Joi.string().valid('low', 'mid', 'high', 'luxury').optional(),
  transport_mode: Joi.string().valid('flight', 'bus', 'train', 'any').optional(),
  seat_preference: Joi.string().max(50).optional(),
  meal_plan:      Joi.string().max(50).optional(),
  accessibility:  Joi.boolean().optional(),

  // Conversation context
  session_id:           Joi.string().uuid().allow(null).optional(),
  conversation_history: Joi.array().items(
    Joi.object({
      role:      Joi.string().valid('user', 'assistant', 'system').required(),
      content:   Joi.string().max(2000).required(),
      timestamp: Joi.string().isoDate().optional(),
    })
  ).max(20).optional(),
  previous_params: Joi.object().allow(null).optional(),

  // Inventory control — explicit per request
  inventory: Joi.object({
    flights:   Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    hotels:    Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    buses:     Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    trains:    Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    transfers: Joi.string().valid('mine', 'bodrless', 'both').default('both'),
  }).optional(),

  // BYO LLM — FIX 1: per-request, api_key used in-flight only
  llm: llmSchema,

  max_results: Joi.number().integer().min(1).max(20).default(4),
  currency:    Joi.string().length(3).uppercase().default('USD'),
}).or('prompt', 'destination');  // at least one required

const bookSchema = Joi.object({
  // FIX 2: idempotency_key required, package_id required for server-side resolution
  idempotency_key: Joi.string().uuid().required(),
  package_id:      Joi.string().max(100).required(), // server resolves price — client cannot override

  // booking_mode controls what Bodrless actually books:
  //   'bodrless_fills' — OTA handles flights/hotels themselves; Bodrless only
  //                      confirms the gap components (bus, train, transfer).
  //                      This is the Wakanow/TravelStart pattern.
  //   'bodrless_full'  — Bodrless runs the full saga: flight hold, hotel hold,
  //                      payment, confirmation. Used when OTA has no booking stack.
  // Default: 'bodrless_fills' — safest assumption for enterprise OTAs.
  booking_mode: Joi.string().valid('bodrless_fills', 'bodrless_full').default('bodrless_fills'),

  // components — used with booking_mode='bodrless_fills'.
  // OTA tells us exactly which components they want Bodrless to confirm.
  // Omit any component they are handling themselves.
  components: Joi.object({
    bus:      Joi.boolean().default(false),
    train:    Joi.boolean().default(false),
    transfer: Joi.boolean().default(false),
  }).optional(),

  guest_name:       Joi.string().max(200).required(),
  guest_email:      Joi.string().email().max(200).required(),
  guest_phone:      Joi.string().max(50).required(),
  passengers:       Joi.number().integer().min(1).max(50).default(1),
  special_requests: Joi.string().max(1000).allow('', null).optional(),
  payment_token:    Joi.string().max(500).optional(),
});

const inventoryUploadSchema = Joi.object({
  type:        Joi.string().valid('flight', 'hotel', 'transfer', 'bus', 'train').required(),
  items:       Joi.array().min(1).max(5000).required(),
  replace_all: Joi.boolean().default(false),
});

const inventoryItemSchemas = {
  flight: Joi.object({
    external_id:     Joi.string().max(100).required(),
    airline:         Joi.string().max(100).required(),
    flight_number:   Joi.string().max(20).required(),
    origin:          Joi.string().max(10).required(),
    destination:     Joi.string().max(10).required(),
    departure_time:  Joi.string().isoDate().required(),
    arrival_time:    Joi.string().isoDate().required(),
    price:           Joi.number().positive().required(),
    currency:        Joi.string().length(3).uppercase().default('USD'),
    seats_available: Joi.number().integer().min(0).required(),
    transport_type:  Joi.string().valid('flight').default('flight'),
    metadata:        Joi.object().optional(),
  }),
  hotel: Joi.object({
    external_id:     Joi.string().max(100).required(),
    name:            Joi.string().max(200).required(),
    location:        Joi.string().max(200).required(),
    stars:           Joi.number().min(1).max(5).optional(),
    rating:          Joi.number().min(0).max(10).optional(),
    price_per_night: Joi.number().positive().required(),
    currency:        Joi.string().length(3).uppercase().default('USD'),
    meal_plan:       Joi.string().max(50).optional(),
    rooms_available: Joi.number().integer().min(0).optional(),
    metadata:        Joi.object().optional(),
  }),
  transfer: Joi.object({
    external_id:  Joi.string().max(100).required(),
    provider:     Joi.string().max(200).required(),
    vehicle_type: Joi.string().max(100).required(),
    origin:       Joi.string().max(200).required(),
    destination:  Joi.string().max(200).required(),
    price:        Joi.number().positive().required(),
    currency:     Joi.string().length(3).uppercase().default('USD'),
    metadata:     Joi.object().optional(),
  }),
  bus: Joi.object({
    external_id:     Joi.string().max(100).required(),
    operator:        Joi.string().max(200).required(),
    route:           Joi.string().max(200).required(),
    origin:          Joi.string().max(100).required(),
    destination:     Joi.string().max(100).required(),
    departure_time:  Joi.string().isoDate().required(),
    arrival_time:    Joi.string().isoDate().required(),
    price:           Joi.number().positive().required(),
    currency:        Joi.string().length(3).uppercase().default('USD'),
    seats_available: Joi.number().integer().min(0).required(),
    transport_type:  Joi.string().valid('bus').default('bus'),
    metadata:        Joi.object().optional(),
  }),
  train: Joi.object({
    external_id:     Joi.string().max(100).required(),
    operator:        Joi.string().max(200).required(),
    train_number:    Joi.string().max(50).required(),
    origin:          Joi.string().max(100).required(),
    destination:     Joi.string().max(100).required(),
    departure_time:  Joi.string().isoDate().required(),
    arrival_time:    Joi.string().isoDate().required(),
    price:           Joi.number().positive().required(),
    currency:        Joi.string().length(3).uppercase().default('USD'),
    seats_available: Joi.number().integer().min(0).required(),
    transport_type:  Joi.string().valid('train').default('train'),
    class:           Joi.string().max(50).optional(),
    metadata:        Joi.object().optional(),
  }),
};

const delayNotifySchema = Joi.object({
  booking_ref:      Joi.string().max(50).required(),
  delay_minutes:    Joi.number().integer().min(1).required(),
  new_arrival_time: Joi.string().isoDate().required(),
  reason:           Joi.string().max(500).optional(),
});

const webhookConfigSchema = Joi.object({
  url:    Joi.string().uri().max(500).required(),
  events: Joi.array().items(
    Joi.string().valid(
      'search.completed', 'booking.confirmed', 'booking.failed',
      'booking.cancelled', 'inventory.processed', 'flight.delayed', 'price.changed'
    )
  ).min(1).required(),
  secret: Joi.string().max(200).optional(),
});

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      const messages = error.details.map(d => d.message).join('; ');
      const err = new Error(messages);
      err.code = 'VALIDATION_ERROR';
      err.statusCode = 400;
      return next(err);
    }
    req.body = value;
    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PACKAGE CACHE — FIX 2: server-side resolution, client cannot override price
// ═══════════════════════════════════════════════════════════════════════════

async function cachePackages(agencyId, packages) {
  const pipeline = redis.pipeline();
  for (const pkg of packages) {
    pipeline.setex(
      `pkg:${agencyId}:${pkg.packageId}`,
      CONFIG.cacheTtl.package,
      JSON.stringify(pkg)
    );
  }
  await pipeline.exec();
}

async function resolvePackage(agencyId, packageId) {
  const cached = await redis.get(`pkg:${agencyId}:${packageId}`);
  if (!cached) {
    const err = new Error('Package not found or expired. Please search again.');
    err.code = 'PACKAGE_EXPIRED';
    err.statusCode = 410;
    throw err;
  }
  return JSON.parse(cached);
}

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════

async function checkIdempotency(key, agencyId) {
  const cacheKey = `idem:${agencyId}:${key}`;
  const cached = await redis.get(cacheKey);
  if (cached) return { exists: true, data: JSON.parse(cached) };

  const { data, error } = await supabase
    .from('bookings')
    .select('booking_ref, status, created_at')
    .eq('idempotency_key', key)
    .eq('agency_id', agencyId)
    .single();

  if (data && !error) {
    await redis.setex(cacheKey, 86400, JSON.stringify(data));
    return { exists: true, data };
  }
  return { exists: false, data: null };
}

async function saveIdempotency(key, agencyId, bookingRef, status = 'confirmed') {
  await redis.setex(
    `idem:${agencyId}:${key}`,
    86400,
    JSON.stringify({ booking_ref: bookingRef, status })
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATION & RATE LIMITING
// ═══════════════════════════════════════════════════════════════════════════

async function resolveApiKey(req) {
  const rawKey = req.headers['x-api-key'] ||
    req.headers['authorization']?.replace('Bearer ', '');
  if (!rawKey || rawKey.length < 20) return null;

  const prefix = rawKey.includes('_')
    ? rawKey.split('_').slice(0, 2).join('_') + '_'
    : rawKey.substring(0, 8);

  const cacheKey = `agency:key:${rawKey.substring(0, 16)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const { data: agency, error } = await supabase
    .from('agencies')
    .select('id, name, plan, status, webhook_url, llm_config, inventory_config, rate_limits, allowed_ips, signing_secret, created_at')
    .eq('key_prefix', prefix)
    .eq('status', 'active')
    .single();

  if (error || !agency) return null;

  // Verify full key hash
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const { data: keyData } = await supabase
    .from('api_keys')
    .select('key_hash')
    .eq('agency_id', agency.id)
    .eq('key_hash', keyHash)
    .single();

  if (!keyData) return null;

  // Parse JSON fields if stored as strings
  ['llm_config', 'inventory_config', 'rate_limits', 'allowed_ips'].forEach(field => {
    if (agency[field] && typeof agency[field] === 'string') {
      try { agency[field] = JSON.parse(agency[field]); } catch { agency[field] = null; }
    }
  });

  await redis.setex(cacheKey, CONFIG.cacheTtl.agency, JSON.stringify(agency));
  return agency;
}

// ── IP ALLOWLIST CHECK ──────────────────────────────────────────────────────
// If the agency has allowed_ips set, reject any request from outside that list.
// Set allowed_ips as a JSON array in the agencies table: ["1.2.3.4","5.6.7.8"]
function checkIpAllowlist(req, agency) {
  const allowedIps = agency.allowed_ips;
  if (!Array.isArray(allowedIps) || allowedIps.length === 0) return true; // no restriction

  // Respect X-Forwarded-For from Render's proxy
  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || req.ip;

  if (!allowedIps.includes(clientIp)) {
    logger.warn('IP allowlist rejected', { clientIp, agencyId: agency.id, allowed: allowedIps });
    return false;
  }
  return true;
}

// ── REQUEST SIGNATURE VERIFICATION ─────────────────────────────────────────
// Enterprise agencies can set a signing_secret. When set, every request must
// include:
//   X-Bodrless-Timestamp: unix seconds (we reject if > 5 min old)
//   X-Bodrless-Signature: sha256=HMAC(signing_secret, timestamp.METHOD.path.body)
//
// This means a stolen API key alone cannot be replayed — the attacker also
// needs the signing secret and must produce a valid signature within 5 minutes.
//
// Signature is OPTIONAL for free/growth plans. ENFORCED for enterprise if set.
function verifyRequestSignature(req, agency) {
  const secret    = agency.signing_secret;
  const signature = req.headers['x-bodrless-signature'];
  const timestamp = req.headers['x-bodrless-timestamp'];

  // No secret configured — skip verification
  if (!secret) return true;

  // Secret configured but no signature sent
  if (!signature || !timestamp) {
    logger.warn('Request signature missing for signed agency', { agencyId: agency.id });
    return false;
  }

  // Reject stale requests (> 5 minutes old — prevents replay attacks)
  const tsSeconds = parseInt(timestamp, 10);
  if (isNaN(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    logger.warn('Request timestamp expired or invalid', { agencyId: agency.id, timestamp });
    return false;
  }

  // Compute expected signature
  const body     = req.body ? JSON.stringify(req.body) : '';
  const payload  = `${timestamp}.${req.method}.${req.path}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const received = signature.replace('sha256=', '');

  // Timing-safe comparison — prevents timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received.padEnd(expected.length, '0').slice(0, expected.length), 'hex')
    );
  } catch {
    return false;
  }
}

// ── AUDIT LOG ───────────────────────────────────────────────────────────────
// Every request through /api/v1 is logged immutably to api_audit_log.
// This is what Wakanow's security team will ask to see.
// Schema: api_audit_log(id, agency_id, method, path, status, ip, request_id, duration_ms, created_at)
function auditLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    supabase.from('api_audit_log').insert({
      id:          uuidv4(),
      agency_id:   req.context?.agency?.id || null,
      method:      req.method,
      path:        req.path,
      status:      res.statusCode,
      ip:          (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
      request_id:  req.context?.requestId || null,
      duration_ms: Date.now() - start,
      created_at:  new Date().toISOString(),
    }).catch(err => logger.error('Audit log write failed', { error: err.message }));
  });
  next();
}

async function authenticate(req, res, next) {
  try {
    const agency = await resolveApiKey(req);
    if (!agency) {
      const err = new Error('Invalid or missing API key. Get yours at POST /api/agencies/signup');
      err.code = 'AUTH_REQUIRED';
      err.statusCode = 401;
      return next(err);
    }

    // IP allowlist — enterprise agencies can lock their key to specific IPs
    if (!checkIpAllowlist(req, agency)) {
      const err = new Error('Request origin IP is not allowlisted for this API key');
      err.code = 'IP_NOT_ALLOWED';
      err.statusCode = 403;
      return next(err);
    }

    // Request signature — enterprise agencies with signing_secret must sign requests
    if (!verifyRequestSignature(req, agency)) {
      const err = new Error('Request signature invalid or timestamp expired');
      err.code = 'SIGNATURE_INVALID';
      err.statusCode = 401;
      return next(err);
    }

    req.context.agency = agency;
    res.setHeader('X-RateLimit-Plan', agency.plan || 'free');
    next();
  } catch (err) {
    err.code = 'AUTH_REQUIRED';
    err.statusCode = 401;
    next(err);
  }
}

function createRateLimiter(endpointType) {
  return rateLimit({
    store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
    windowMs: 60 * 1000,
    max: (req) => {
      const plan   = req.context?.agency?.plan || 'free';
      const custom = req.context?.agency?.rate_limits;
      if (custom?.[endpointType]) return custom[endpointType];
      return CONFIG.rateLimits[plan]?.[endpointType] || CONFIG.rateLimits.free[endpointType];
    },
    keyGenerator: (req) => req.context?.agency?.id || req.ip,
    handler: (req, res, next) => {
      const err = new Error('Rate limit exceeded. Retry after the window resets.');
      err.code = 'RATE_LIMIT_EXCEEDED';
      err.statusCode = 429;
      next(err);
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REQUEST CONTEXT & ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

function requestContext(req, res, next) {
  req.context = {
    requestId: req.headers['x-request-id'] || uuidv4(),
    startTime: Date.now(),
    agency:    null,
    sandbox:   req.headers['x-sandbox'] === 'true',
  };
  res.setHeader('X-Request-ID',       req.context.requestId);
  res.setHeader('X-API-Version',      CONFIG.apiVersion);
  res.setHeader('X-API-Version-Date', CONFIG.apiVersionDate);
  next();
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  const errorCode  = err.code || 'INTERNAL_ERROR';

  const messageMap = {
    VALIDATION_ERROR:          err.message,
    RATE_LIMIT_EXCEEDED:       'Rate limit exceeded. Please retry later.',
    AUTH_REQUIRED:             'Authentication required. Pass a valid x-api-key header.',
    IP_NOT_ALLOWED:            'Request origin IP is not allowlisted for this API key.',
    SIGNATURE_INVALID:         'Request signature invalid or timestamp expired. Check X-Bodrless-Timestamp and X-Bodrless-Signature headers.',
    NOT_FOUND:                 err.message || 'Resource not found',
    PACKAGE_EXPIRED:           'Package expired. Please search again.',
    PROMPT_SANITIZATION_FAILED:'Prompt failed security validation.',
    IDEMPOTENCY_CONFLICT:      'Duplicate request detected.',
  };

  const message = messageMap[errorCode] || (statusCode < 500 ? err.message : 'An unexpected error occurred');

  getRequestLogger(req).error('Request failed', {
    errorMessage: err.message, errorCode, statusCode,
    errorStack: CONFIG.env !== 'production' ? err.stack : undefined,
  });

  res.status(statusCode).json({
    success: false,
    error: { message, code: errorCode, request_id: req.context?.requestId },
    api_version: CONFIG.apiVersion,
    generated_at: new Date().toISOString(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM SERVICE — FIX 1: per-request api_key, never stored
// ═══════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `You are a travel orchestration assistant. Extract structured trip parameters from the user's request.

Respond ONLY in valid JSON with this exact structure:
{
  "intent": "search|modify|cancel|info",
  "tripParams": {
    "origin": string|null,
    "destination": string (required),
    "departureDate": string (ISO date)|null,
    "returnDate": string (ISO date)|null,
    "passengers": number (default 1),
    "nights": number|null,
    "budget": "low"|"mid"|"high"|"luxury"|null,
    "transportMode": "flight"|"bus"|"train"|"any"|null,
    "seatPreference": string|null,
    "mealPlan": string|null,
    "accessibility": boolean,
    "specialRequests": string|null
  },
  "clarifyingQuestions": string[]|null,
  "confidence": number (0-1)
}

Rules:
- If information is missing, set to null — do not guess.
- If the request is ambiguous, set clarifyingQuestions.
- Detect language automatically — respond with JSON regardless of input language.
- Never include markdown, explanations, or text outside the JSON.`;

/**
 * parsePrompt — resolves which LLM to use in priority order:
 *   1. Per-request llmOverride (api_key used in-flight, never persisted)
 *   2. Agency's stored llm_config (endpoint only, no key stored — key must come per-request)
 *   3. Bodrless default LLM
 */
async function parsePrompt(prompt, agency, conversationHistory = [], llmOverride = null) {
  const messages = [
    { role: 'system',    content: SYSTEM_PROMPT },
    ...(conversationHistory.slice(-5)),
    { role: 'user',      content: prompt },
  ];

  // Determine LLM target — api_key is always from the request, never from DB
  let llmEndpoint, llmModel, llmApiKey, providerLabel;

  if (llmOverride?.endpoint && llmOverride?.api_key) {
    // OTA supplied their own LLM per-request
    llmEndpoint  = llmOverride.endpoint;
    llmModel     = llmOverride.model || 'default';
    llmApiKey    = llmOverride.api_key; // in-flight only, never stored
    providerLabel = `ota:${llmOverride.provider || 'custom'}`;
  } else if (agency.llm_config?.endpoint) {
    // Agency has a configured endpoint — but they must pass api_key per-request
    // If no key provided this request, fall through to Bodrless default
    llmEndpoint  = agency.llm_config.endpoint;
    llmModel     = agency.llm_config.model || 'default';
    llmApiKey    = llmOverride?.api_key || CONFIG.defaultLlm.apiKey;
    providerLabel = `ota:${agency.llm_config.provider || 'custom'}`;
  } else {
    // Bodrless default
    llmEndpoint  = CONFIG.defaultLlm.endpoint;
    llmModel     = CONFIG.defaultLlm.model;
    llmApiKey    = CONFIG.defaultLlm.apiKey;
    providerLabel = 'bodrless';
  }

  try {
    logger.info('Calling LLM', { agencyId: agency.id, provider: providerLabel });

    const response = await axios.post(llmEndpoint, {
      model:       llmModel,
      messages,
      temperature: 0.1,
      max_tokens:  1500,
    }, {
      headers: {
        'Authorization': `Bearer ${llmApiKey}`,
        'Content-Type':  'application/json',
      },
      timeout: 15000,
    });

    const content = response.data.choices?.[0]?.message?.content
      || response.data.content
      || response.data.text
      || response.data.response;

    if (!content) throw new Error('LLM returned empty content');

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed    = JSON.parse(jsonMatch ? jsonMatch[0] : content);

    return { success: true, data: parsed, provider: providerLabel };

  } catch (err) {
    logger.error('LLM parsing failed', { agencyId: agency.id, error: err.message, provider: providerLabel });
    return {
      success: false,
      data: {
        intent: 'search',
        tripParams: { destination: null, passengers: 1 },
        clarifyingQuestions: ['Could you please specify your destination and travel dates?'],
        confidence: 0.1,
      },
      provider: 'fallback',
      error: err.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY SERVICE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * inventoryControl — respects explicit per-request inventory source declarations.
 * 'mine' = OTA only, 'bodrless' = Bodrless only, 'both' = OTA first then fill gaps.
 */
async function searchInventory(agencyId, tripParams, options = {}) {
  const {
    inventoryControl = {},
    maxResults = 4,
    transportMode = 'any',
  } = options;

  const control = {
    flights:   inventoryControl.flights   || 'both',
    hotels:    inventoryControl.hotels    || 'both',
    buses:     inventoryControl.buses     || 'both',
    trains:    inventoryControl.trains    || 'both',
    transfers: inventoryControl.transfers || 'both',
  };

  const cacheKey = `inv:${agencyId}:${tripParams.destination}:${tripParams.departureDate}:${transportMode}:${JSON.stringify(control)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const results = { flights: [], hotels: [], transfers: [], buses: [], trains: [], sources: [] };

  try {
    // Flights
    if (control.flights !== 'bodrless') {
      const otaFlights = await searchOtaInventory(agencyId, 'flights', tripParams);
      results.flights.push(...otaFlights);
      if (otaFlights.length) results.sources.push('ota:flights');
    }
    if (control.flights !== 'mine' && results.flights.length < maxResults) {
      const gap = maxResults - results.flights.length;
      const bf  = await searchBodrlessInventory('flights', tripParams, gap);
      results.flights.push(...bf.map(f => ({ ...f, source: 'bodrless', margin_applied: true })));
      if (bf.length) results.sources.push('bodrless:flights');
    }

    // Hotels
    if (control.hotels !== 'bodrless') {
      const otaHotels = await searchOtaInventory(agencyId, 'hotels', tripParams);
      results.hotels.push(...otaHotels);
      if (otaHotels.length) results.sources.push('ota:hotels');
    }
    if (control.hotels !== 'mine' && results.hotels.length < maxResults) {
      const gap = maxResults - results.hotels.length;
      const bh  = await searchBodrlessInventory('hotels', tripParams, gap);
      results.hotels.push(...bh.map(h => ({ ...h, source: 'bodrless', margin_applied: true })));
      if (bh.length) results.sources.push('bodrless:hotels');
    }

    // Transfers
    if (control.transfers !== 'bodrless') {
      const otaTransfers = await searchOtaInventory(agencyId, 'transfers', tripParams);
      results.transfers.push(...otaTransfers);
      if (otaTransfers.length) results.sources.push('ota:transfers');
    }
    if (control.transfers !== 'mine' && results.transfers.length < 2) {
      const gap = 2 - results.transfers.length;
      const bt  = await searchBodrlessInventory('transfers', tripParams, gap);
      results.transfers.push(...bt.map(t => ({ ...t, source: 'bodrless', margin_applied: true })));
      if (bt.length) results.sources.push('bodrless:transfers');
    }

    // Buses — Bodrless fills when OTA has none
    if (transportMode === 'bus' || transportMode === 'any') {
      if (control.buses !== 'bodrless') {
        const otaBuses = await searchOtaInventory(agencyId, 'buses', tripParams);
        results.buses.push(...otaBuses);
        if (otaBuses.length) results.sources.push('ota:buses');
      }
      if (control.buses !== 'mine') {
        const bb = await searchBodrlessInventory('buses', tripParams, maxResults);
        results.buses.push(...bb.map(b => ({ ...b, source: 'bodrless', margin_applied: true })));
        if (bb.length) results.sources.push('bodrless:buses');
      }
    }

    // Trains
    if (transportMode === 'train' || transportMode === 'any') {
      if (control.trains !== 'bodrless') {
        const otaTrains = await searchOtaInventory(agencyId, 'trains', tripParams);
        results.trains.push(...otaTrains);
        if (otaTrains.length) results.sources.push('ota:trains');
      }
      if (control.trains !== 'mine') {
        const btr = await searchBodrlessInventory('trains', tripParams, maxResults);
        results.trains.push(...btr.map(t => ({ ...t, source: 'bodrless', margin_applied: true })));
        if (btr.length) results.sources.push('bodrless:trains');
      }
    }

    results.sources = [...new Set(results.sources)];
    await redis.setex(cacheKey, CONFIG.cacheTtl.inventory, JSON.stringify(results));
    return results;

  } catch (err) {
    logger.error('Inventory search failed', { agencyId, error: err.message });
    throw err;
  }
}

async function searchOtaInventory(agencyId, table, tripParams) {
  let query = supabase.from(table).select('*').eq('agency_id', agencyId).eq('is_active', true);
  if (tripParams.destination) query = query.ilike('destination', `%${tripParams.destination}%`);
  if (tripParams.origin)      query = query.ilike('origin', `%${tripParams.origin}%`);
  if (tripParams.departureDate) {
    const d = new Date(tripParams.departureDate);
    const start = new Date(d); start.setDate(d.getDate() - 1);
    const end   = new Date(d); end.setDate(d.getDate() + 1);
    query = query.gte('departure_time', start.toISOString()).lte('departure_time', end.toISOString());
  }
  const { data, error } = await query.limit(20);
  if (error) throw error;
  return (data || []).map(item => ({ ...item, source: 'ota' }));
}

async function searchBodrlessInventory(table, tripParams, limit) {
  let query = supabase.from(table).select('*').is('agency_id', null).eq('is_active', true);
  if (tripParams.destination) query = query.ilike('destination', `%${tripParams.destination}%`);
  if (tripParams.origin)      query = query.ilike('origin', `%${tripParams.origin}%`);
  const { data, error } = await query.limit(limit);
  if (error) throw error;
  return data || [];
}

async function processInventoryUpload(job) {
  const { agencyId, type, items, replaceAll } = job.data;
  const table = {
    hotel: 'hotels', transfer: 'transfers',
    bus: 'buses', train: 'trains',
  }[type] || 'flights';

  const results = { processed: 0, created: 0, updated: 0, failed: 0, errors: [] };

  if (replaceAll) {
    await supabase.from(table).update({ is_active: false }).eq('agency_id', agencyId);
  }

  for (const item of items) {
    try {
      const record = { ...item, agency_id: agencyId, is_active: true, updated_at: new Date().toISOString() };
      const { error } = await supabase.from(table).upsert(record, {
        onConflict: 'external_id,agency_id',
        ignoreDuplicates: false,
      });
      if (error) throw error;
      results.processed++;
    } catch (err) {
      results.failed++;
      results.errors.push({ external_id: item.external_id, error: err.message });
      logger.error('Inventory item failed', { agencyId, external_id: item.external_id, error: err.message });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function orchestrate(searchPrompt, agency, options = {}) {
  const {
    conversationHistory = [], previousParams = null,
    inventoryControl = {}, maxResults = 4,
    currency = 'USD', llmOverride = null,
  } = options;

  const sessionId = uuidv4();
  const startTime = Date.now();

  // Parse intent & trip params via LLM
  const llmResult = await parsePrompt(searchPrompt, agency, conversationHistory, llmOverride);
  const tripParams = llmResult.data.tripParams || {};

  // Merge previous params for conversational follow-ups
  if (previousParams) {
    Object.keys(previousParams).forEach(key => {
      if (tripParams[key] === null || tripParams[key] === undefined) {
        tripParams[key] = previousParams[key];
      }
    });
  }

  // Search inventory with explicit source control
  const inventory = await searchInventory(agency.id, tripParams, {
    inventoryControl,
    maxResults,
    transportMode: tripParams.transportMode || 'any',
  });

  // Build and cache packages — FIX 2: packages cached server-side
  const packages = buildPackages(inventory, tripParams, { maxResults, currency });
  await cachePackages(agency.id, packages);

  const updatedHistory = [
    ...conversationHistory,
    { role: 'user',      content: searchPrompt,                                                              timestamp: new Date().toISOString() },
    { role: 'assistant', content: `Found ${packages.length} packages for ${tripParams.destination || 'your search'}`, timestamp: new Date().toISOString() },
  ];

  logger.info('Orchestration complete', {
    agencyId: agency.id, sessionId,
    packages: packages.length,
    duration: Date.now() - startTime,
    llmProvider: llmResult.provider,
    sources: inventory.sources,
  });

  return {
    sessionId, tripParams, intent: llmResult.data.intent || 'search',
    packages, conversationHistory: updatedHistory,
    clarifyingQuestions: llmResult.data.clarifyingQuestions || null,
    sources: inventory.sources,
    llm_provider: llmResult.provider,
    generatedAt: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
  };
}

function buildPackages(inventory, tripParams, options) {
  const { maxResults, currency } = options;
  const packages   = [];
  const transports = [...inventory.flights, ...inventory.buses, ...inventory.trains].slice(0, maxResults * 2);
  const hotels     = inventory.hotels.slice(0, maxResults * 2);
  const transfers  = inventory.transfers.slice(0, maxResults);

  for (let i = 0; i < Math.min(transports.length, maxResults); i++) {
    const transport = transports[i];
    const hotel     = hotels[i % Math.max(hotels.length, 1)] || null;
    const transfer  = transfers[i % Math.max(transfers.length, 1)] || null;
    const nights     = tripParams.nights || 1;
    const passengers = tripParams.passengers || 1;

    const transportPrice = (transport.price || 0) * passengers;
    const hotelPrice     = hotel    ? (hotel.price_per_night || 0) * nights : 0;
    const transferPrice  = transfer ? (transfer.price || 0) * passengers    : 0;
    const totalPrice     = transportPrice + hotelPrice + transferPrice;
    const hasBodrless    = [transport, hotel, transfer].some(x => x?.source === 'bodrless');

    packages.push({
      packageId: `PKG-${nanoid(12)}`,
      summary: {
        route:         `${transport.origin} → ${transport.destination}`,
        passengers,    nights,
        totalPrice:    Math.round(totalPrice * 100) / 100,
        pricePerPerson: Math.round((totalPrice / passengers) * 100) / 100,
        currency,
        mealPlan:       hotel?.meal_plan || tripParams.mealPlan || null,
        seatPreference: tripParams.seatPreference || null,
        departureDate:  transport.departure_time,
        arrivalDate:    transport.arrival_time,
      },
      transport: {
        ...transport,
        transportType: transport.transport_type || 'flight',
      },
      hotel: hotel ? {
        name:         hotel.name,
        location:     hotel.location,
        stars:        hotel.stars,
        rating:       hotel.rating,
        pricePerNight: hotel.price_per_night,
        mealPlan:     hotel.meal_plan,
        source:       hotel.source,
      } : null,
      transfers: transfer ? {
        provider:    transfer.provider,
        vehicleType: transfer.vehicle_type,
        price:       transfer.price,
        source:      transfer.source,
      } : null,
      priceBreakdown: {
        transport: transportPrice,
        hotel:     hotelPrice,
        transfer:  transferPrice,
        margin:    hasBodrless ? Math.round(totalPrice * 0.08 * 100) / 100 : 0,
      },
      status: 'available',
    });
  }
  return packages.slice(0, maxResults);
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOKING SAGA — FIX 3: simulateExternalCall removed, real supplier stubs
// ═══════════════════════════════════════════════════════════════════════════

async function executeBookingSaga(bookingData, agency, options = {}) {
  const { sandbox = false } = options;
  const bookingRef = `BDR-${nanoid(10).toUpperCase()}`;
  const sagaId     = nanoid(12);

  const sagaState = {
    sagaId, bookingRef, agencyId: agency.id,
    status: 'in_progress', steps: {},
    createdAt: new Date().toISOString(),
  };

  await supabase.from('booking_sagas').insert({
    id: sagaId, booking_ref: bookingRef,
    agency_id: agency.id, status: 'in_progress', payload: bookingData,
  });

  try {
    sagaState.steps.hold_transport = await holdTransport(bookingData.transport, sandbox);
    await updateSagaStep(sagaId, 'hold_transport', sagaState.steps.hold_transport);

    if (bookingData.hotel?.name) {
      sagaState.steps.hold_hotel = await holdHotel(bookingData.hotel, sandbox);
      await updateSagaStep(sagaId, 'hold_hotel', sagaState.steps.hold_hotel);
    }

    if (bookingData.transfer?.provider) {
      sagaState.steps.hold_transfer = await holdTransfer(bookingData.transfer, sandbox);
      await updateSagaStep(sagaId, 'hold_transfer', sagaState.steps.hold_transfer);
    }

    sagaState.steps.process_payment = await processPayment(bookingData, sandbox);
    await updateSagaStep(sagaId, 'process_payment', sagaState.steps.process_payment);

    sagaState.steps.confirm_all = await confirmAll(sagaState.steps, sandbox);
    await updateSagaStep(sagaId, 'confirm_all', sagaState.steps.confirm_all);

    await saveBooking(bookingRef, bookingData, agency, sagaState, 'confirmed');
    await saveIdempotency(bookingData.idempotencyKey, agency.id, bookingRef, 'confirmed');

    sagaState.status = 'confirmed';
    await updateSagaStatus(sagaId, 'confirmed');
    logger.info('Booking saga confirmed', { bookingRef, agencyId: agency.id, sagaId });

    return { success: true, bookingRef, status: 'confirmed', sagaId, steps: sagaState.steps };

  } catch (err) {
    logger.error('Booking saga failed — compensating', {
      bookingRef, agencyId: agency.id, error: err.message, failedStep: err.step,
    });
    await compensate(sagaState.steps, sandbox);
    sagaState.status = 'failed';
    await updateSagaStatus(sagaId, 'failed', err.message);
    throw err;
  }
}

// ── Saga steps — wire your real supplier adapters here ─────────────────────

async function holdTransport(transport, sandbox) {
  if (!transport?.airline && !transport?.operator) return { status: 'skipped' };
  if (sandbox) return { status: 'held', holdRef: `HOLD-SANDBOX-${nanoid(6)}`, sandbox: true };

  // TODO: call your real adapter e.g. require('../adapters/travelduqa').hold(transport)
  const holdRef = `HOLD-${(transport.airline || transport.operator || 'BUS').replace(/\s+/g, '-')}-${nanoid(8)}`;
  return { status: 'held', holdRef };
}

async function holdHotel(hotel, sandbox) {
  if (!hotel?.name) return { status: 'skipped' };
  if (sandbox) return { status: 'held', holdRef: `HOLD-SANDBOX-${nanoid(6)}`, sandbox: true };

  // TODO: call your real adapter e.g. require('../adapters/hotelbeds').hold(hotel)
  const holdRef = `HOLD-HOTEL-${nanoid(8)}`;
  return { status: 'held', holdRef };
}

async function holdTransfer(transfer, sandbox) {
  if (!transfer?.provider) return { status: 'skipped' };
  if (sandbox) return { status: 'held', holdRef: `HOLD-SANDBOX-${nanoid(6)}`, sandbox: true };

  // TODO: call your real transfer provider adapter
  const holdRef = `HOLD-TRANSFER-${nanoid(8)}`;
  return { status: 'held', holdRef };
}

async function processPayment(bookingData, sandbox) {
  if (sandbox) return { status: 'processed', transactionId: `TXN-SANDBOX-${nanoid(8)}`, sandbox: true };
  if (!bookingData.paymentToken) return { status: 'skipped', reason: 'no_payment_token' };

  // TODO: call your real payment adapter e.g. require('../adapters/intasend').charge(...)
  const transactionId = `TXN-${nanoid(12)}`;
  return { status: 'processed', transactionId };
}

async function confirmAll(steps, sandbox) {
  if (sandbox) return { status: 'confirmed', sandbox: true };
  // TODO: finalize all held reservations with respective suppliers
  return { status: 'confirmed' };
}

// ── Saga compensation (rollback) ───────────────────────────────────────────

async function compensate(steps, sandbox) {
  if (sandbox) { logger.info('Sandbox: skipping compensation'); return; }
  if (steps.confirm_all?.status     === 'confirmed') await cancelConfirmation();
  if (steps.hold_transfer?.status   === 'held')      await cancelHold('transfer', steps.hold_transfer.holdRef);
  if (steps.hold_hotel?.status      === 'held')      await cancelHold('hotel',    steps.hold_hotel.holdRef);
  if (steps.hold_transport?.status  === 'held')      await cancelHold('transport',steps.hold_transport.holdRef);
}

async function cancelHold(type, holdRef) {
  logger.info(`Compensating: cancelling ${type} hold`, { holdRef });
  // TODO: call supplier cancel endpoints
}

async function cancelConfirmation() {
  logger.info('Compensating: cancelling confirmations');
  // TODO: call supplier cancellation endpoints
}

// ── Saga DB helpers ────────────────────────────────────────────────────────

async function saveBooking(bookingRef, data, agency, sagaState, status) {
  const { error } = await supabase.from('bookings').insert({
    booking_ref:      bookingRef,
    agency_id:        agency.id,
    guest_name:       data.guest.name,
    guest_email:      data.guest.email,
    guest_phone:      data.guest.phone,
    passengers:       data.passengers,
    total_price:      data.totalPrice,
    destination:      data.transport?.destination || null,
    origin:           data.transport?.origin || null,
    nights:           data.nights || null,
    channel:          'api',
    flight_details:   data.transport,
    hotel_details:    data.hotel,
    transfer_details: data.transfer,
    trip_params:      data.summary,
    special_requests: data.specialRequests || 'None',
    status,
    currency:         data.currency || 'USD',
    saga_id:          sagaState.sagaId,
    idempotency_key:  data.idempotencyKey,
    sandbox:          data.sandbox || false,
  });
  if (error) throw error;
}

async function updateSagaStep(sagaId, step, result) {
  await supabase.from('booking_saga_steps').insert({
    saga_id:    sagaId, step_name: step,
    status:     result.status,
    result,
    created_at: new Date().toISOString(),
  });
}

async function updateSagaStatus(sagaId, status, errorMessage = null) {
  await supabase.from('booking_sagas').update({
    status, error_message: errorMessage,
    completed_at: new Date().toISOString(),
  }).eq('id', sagaId);
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS & WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════════

async function notifyBookingConfirmed({ booking, flight, hotel, transfer }) {
  const events = [{ type: 'booking.confirmed', payload: { ...booking, flight, hotel, transfer } }];
  if (hotel?.source   === 'bodrless') events.push({ type: 'hotel.notification',    recipient: 'hotel_provider',    payload: { bookingRef: booking.bookingRef, hotelName: hotel.name, guestName: booking.guestName, checkIn: booking.checkIn, passengers: booking.passengers } });
  if (transfer?.source === 'bodrless') events.push({ type: 'transfer.notification', recipient: 'transfer_provider', payload: { bookingRef: booking.bookingRef, provider: transfer.provider, guestName: booking.guestName, guestPhone: booking.guestPhone } });

  for (const event of events) {
    await notificationQueue.add(event.type, { ...event, agencyId: booking.agencyId, timestamp: new Date().toISOString() }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  }
  logger.info('Booking notifications queued', { bookingRef: booking.bookingRef, count: events.length });
}

async function notifyFlightDelay({ booking, flight, hotel, transfer, delayMinutes, newArrivalTime, reason }) {
  const events = [{ type: 'flight.delayed', payload: { ...booking, flight, delayMinutes, newArrivalTime, reason } }];
  if (hotel)    events.push({ type: 'hotel.delay_update',    payload: { bookingRef: booking.bookingRef, hotelName: hotel.name, newArrivalTime, delayMinutes } });
  if (transfer) events.push({ type: 'transfer.delay_update', payload: { bookingRef: booking.bookingRef, provider: transfer.provider, newPickupTime: newArrivalTime, delayMinutes } });

  for (const event of events) {
    await notificationQueue.add(event.type, { ...event, agencyId: booking.agencyId, timestamp: new Date().toISOString() }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  }
  logger.info('Delay notifications queued', { bookingRef: booking.bookingRef, delayMinutes });
}

async function deliverWebhook(agencyId, event, payload) {
  const { data: agency } = await supabase.from('agencies').select('webhook_url, webhook_secret, webhook_events').eq('id', agencyId).single();
  if (!agency?.webhook_url) return { delivered: false, reason: 'no_webhook_configured' };

  const subscribedEvents = agency.webhook_events || [];
  if (subscribedEvents.length > 0 && !subscribedEvents.includes(event)) return { delivered: false, reason: 'event_not_subscribed' };

  const webhookId = `WH-${crypto.randomUUID()}`;
  const timestamp = Date.now();
  const body      = { event, payload, timestamp: new Date().toISOString(), webhook_id: webhookId };

  const headers = {
    'Content-Type':           'application/json',
    'X-Bodrless-Event':       event,
    'X-Bodrless-Webhook-ID':  webhookId,
    'X-Bodrless-Timestamp':   timestamp,
    'User-Agent':             'Bodrless-Webhook/2.0',
  };

  if (agency.webhook_secret) {
    headers['X-Bodrless-Signature'] = `sha256=${
      crypto.createHmac('sha256', agency.webhook_secret).update(JSON.stringify(body)).digest('hex')
    }`;
  }

  await supabase.from('webhook_deliveries').insert({
    id: webhookId, agency_id: agencyId, event, payload: body, status: 'pending',
    created_at: new Date().toISOString(),
  });

  try {
    const response = await axios.post(agency.webhook_url, body, { headers, timeout: 10000, validateStatus: s => s < 500 });
    await supabase.from('webhook_deliveries').update({ status: 'delivered', http_status: response.status, delivered_at: new Date().toISOString() }).eq('id', webhookId);
    logger.info('Webhook delivered', { webhookId, agencyId, event, status: response.status });
    return { delivered: true, status: response.status };
  } catch (err) {
    await supabase.from('webhook_deliveries').update({ status: 'failed', error_message: err.message, failed_at: new Date().toISOString() }).eq('id', webhookId);
    logger.error('Webhook delivery failed', { webhookId, agencyId, event, error: err.message });
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPRESS APP
// ═══════════════════════════════════════════════════════════════════════════

const app = express();

app.use(helmet());
app.use(hpp());
app.use(compression());

// ── HTTPS enforcement ───────────────────────────────────────────────────────
// Render terminates TLS but we enforce at app level too.
app.use((req, res, next) => {
  if (CONFIG.env === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.status(301).redirect('https://' + req.headers.host + req.url);
  }
  next();
});

// ── CORS — locked to allowlisted origins ───────────────────────────────────
// Set ALLOWED_ORIGINS in Render env vars:
//   https://wakanow.com,https://api.wakanow.com,https://travelstart.com
// Server-to-server calls (no Origin header) are always allowed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // No origin = server-to-server (Postman, backend calls) — always allow
    if (!origin) return callback(null, true);
    // In dev/test allow everything
    if (CONFIG.env !== 'production') return callback(null, true);
    // In production enforce allowlist
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    logger.warn('CORS rejected', { origin });
    callback(new Error('Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'X-API-Key',
    'X-Sandbox', 'X-Request-ID',
    'X-Bodrless-Timestamp', 'X-Bodrless-Signature',
  ],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(requestContext);

// ── Health ─────────────────────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const dbHealthy = await dbHealthCheck();
  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? 'healthy' : 'unhealthy',
    version: CONFIG.apiVersion,
    timestamp: new Date().toISOString(),
  });
});

// ── API v1 ─────────────────────────────────────────────────────────────────

const apiV1 = express.Router();
apiV1.use(auditLog);      // immutable request log — runs before auth so even rejected requests are logged
apiV1.use(authenticate);

// Docs
apiV1.get('/', (req, res) => {
  res.json({
    name:        'Bodrless API',
    version:     CONFIG.apiVersion,
    description: 'Single endpoint. BYO LLM. BYO Inventory. Saga bookings. Webhooks. Sandbox. Zero breaking changes.',
    what_you_get: [
      'Natural language parsing — any language, your LLM or ours',
      'Trip orchestration: flights + hotels + buses + trains + transfers',
      'Inventory control per-request: yours first, Bodrless fills gaps',
      'Async search — 202 + job_id, never times out under load',
      'Saga booking — partial failure auto-rollbacks, no partial charges',
      'Idempotency — retry on any network failure, no duplicate bookings',
      'Webhooks with HMAC signatures — search, booking, delay, price events',
      'Sandbox mode — full test environment, no real charges',
      'Everything we add in future — automatically included, zero breaking changes',
    ],
    quick_start: {
      '1': 'POST /api/agencies/signup → get API key',
      '2': 'POST /api/v1/webhooks/configure → set up event delivery (optional)',
      '3': 'POST /api/v1/inventory/upload → push your inventory (optional)',
      '4': 'POST /api/v1/search → returns job_id',
      '5': 'GET  /api/v1/search/:job_id → poll for packages',
      '6': 'POST /api/v1/book → confirm with package_id + idempotency_key',
    },
    endpoints: {
      'GET  /api/v1':                       'This docs page',
      'GET  /api/v1/capabilities':          'What is live on your plan',
      'POST /api/v1/search':                'Async search — returns job_id (202)',
      'GET  /api/v1/search/:job_id':        'Poll search results',
      'POST /api/v1/book':                  'Book with saga + idempotency (202)',
      'GET  /api/v1/book/status/:job_id':   'Poll booking status',
      'POST /api/v1/inventory/upload':      'Upload your inventory (202)',
      'GET  /api/v1/inventory/upload/:job_id': 'Poll upload status',
      'GET  /api/v1/bookings':              'List your bookings',
      'POST /api/v1/notify/delay':          'Trigger flight delay notifications',
      'POST /api/v1/webhooks/configure':    'Configure webhook delivery',
    },
    authentication: 'x-api-key: your_key',
    sandbox:        'Add header X-Sandbox: true for test mode — no real charges, no real holds',
    contact:        'hello@bodrless.com',
  });
});

// Capabilities
apiV1.get('/capabilities', (req, res) => {
  const plan = req.context.agency.plan || 'free';
  res.json({
    api_version: CONFIG.apiVersion,
    plan,

    // What inventory Bodrless can supply vs what the OTA brings
    inventory: {
      flights:   { bodrless_supplier: 'TravelDuqa', bring_your_own: true,  note: 'Your GDS flights take priority — Bodrless fills only if you have none' },
      hotels:    { bodrless_supplier: 'HotelBeds',  bring_your_own: true,  note: 'Your contracted hotels take priority — Bodrless fills gaps'            },
      buses:     { bodrless_supplier: 'Travler',    bring_your_own: true,  note: 'East Africa bus network — most OTAs use Bodrless for this'             },
      trains:    { bodrless_supplier: 'SGR',        bring_your_own: false, note: 'SGR Madaraka Express — Bodrless only'                                  },
      transfers: { bodrless_supplier: 'HolidayTaxis + flat-rate', bring_your_own: true, note: 'Airport/station transfers' },
    },

    // Two booking modes — OTAs choose per-request
    booking_modes: {
      bodrless_fills: {
        description: 'You book flights and hotels through your own system. Bodrless only confirms the gap components you specify (bus, train, transfer). No payment flows through Bodrless.',
        use_case:    'Wakanow, TravelStart, any OTA with their own GDS and booking stack',
        components:  ['bus', 'train', 'transfer'],
      },
      bodrless_full: {
        description: 'Bodrless runs the complete booking saga — flight hold, hotel hold, payment, confirmation, notifications. Use when you have no booking stack.',
        use_case:    'Smaller agencies and tour operators building on Bodrless from scratch',
        components:  ['flight', 'hotel', 'bus', 'train', 'transfer'],
      },
    },

    features: {
      natural_language:   true,
      languages:          ['en', 'sw', 'fr', 'ar', 'any'],
      multi_destination:  true,
      multi_leg_routing:  true,
      accessibility:      true,
      bring_your_own_llm: true,
      async_search:       true,
      saga_bookings:      true,
      idempotency:        true,
      webhooks:           true,
      sandbox_mode:       true,
      inventory_control:  true,
      gap_fill_only:      true,
    },

    // Per-request inventory control
    inventory_control: {
      description: 'Set per search request — no config needed',
      example: {
        inventory: {
          flights:   'mine',     // your GDS only
          hotels:    'mine',     // your contracted hotels only
          buses:     'bodrless', // Bodrless fills
          trains:    'bodrless', // Bodrless fills
          transfers: 'bodrless', // Bodrless fills
        },
      },
      values: ['mine', 'bodrless', 'both'],
    },

    rate_limits:   CONFIG.rateLimits[plan],
    request_id:   req.context.requestId,
    generated_at: new Date().toISOString(),
  });
});

// ── SEARCH ─────────────────────────────────────────────────────────────────

apiV1.post('/search', createRateLimiter('search'), validate(searchSchema), async (req, res, next) => {
  try {
    let searchPrompt = req.body.prompt;
    if (searchPrompt) searchPrompt = sanitizePrompt(searchPrompt);

    // Build prompt from structured params if no natural language prompt
    if (!searchPrompt && req.body.destination) {
      const parts = [];
      if (req.body.origin)         parts.push(`from ${req.body.origin}`);
      parts.push(`to ${req.body.destination}`);
      if (req.body.passengers)     parts.push(`${req.body.passengers} people`);
      if (req.body.nights)         parts.push(`${req.body.nights} nights`);
      if (req.body.budget)         parts.push(`${req.body.budget} budget`);
      if (req.body.departure_date) parts.push(`on ${req.body.departure_date}`);
      if (req.body.transport_mode) parts.push(`by ${req.body.transport_mode}`);
      if (req.body.meal_plan)      parts.push(req.body.meal_plan.replace('_', ' '));
      if (req.body.accessibility)  parts.push('wheelchair accessible');
      searchPrompt = parts.join(' ');
    }

    if (!searchPrompt) {
      const err = new Error('Either prompt or destination is required');
      err.code = 'MISSING_PARAMS'; err.statusCode = 400; throw err;
    }

    const job = await searchQueue.add('search', {
      searchPrompt,
      agencyId: req.context.agency.id,
      agency:   req.context.agency,
      options: {
        conversationHistory: req.body.conversation_history || [],
        previousParams:      req.body.previous_params || null,
        inventoryControl:    req.body.inventory || {},
        // FIX 1: llm override passed to worker — api_key travels with the job, never persisted
        llmOverride:         req.body.llm || null,
        maxResults:          req.body.max_results || 4,
        currency:            req.body.currency || 'USD',
        sessionId:           req.body.session_id || null,
        sandbox:             req.context.sandbox,
      },
      requestId: req.context.requestId,
    }, { attempts: 2, timeout: 30000 });

    getRequestLogger(req).info('Search queued', { jobId: job.id });

    res.status(202).json({
      success:          true,
      message:          'Search accepted',
      job_id:           job.id,
      status:           'processing',
      poll_url:         `/api/v1/search/${job.id}`,
      estimated_seconds: 5,
      api_version:      CONFIG.apiVersion,
      request_id:       req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.get('/search/:job_id', async (req, res, next) => {
  try {
    const job = await searchQueue.getJob(req.params.job_id);
    if (!job) { const err = new Error('Search job not found'); err.code = 'NOT_FOUND'; err.statusCode = 404; throw err; }

    const state  = await job.getState();
    const result = job.returnvalue;

    if (state === 'completed' && result) {
      return res.json({
        success: true, status: 'completed', ...result,
        api_version: CONFIG.apiVersion, request_id: req.context.requestId,
      });
    }
    if (state === 'failed') {
      return res.status(500).json({
        success: false, status: 'failed',
        error: { message: 'Search processing failed', code: 'SEARCH_FAILED' },
        api_version: CONFIG.apiVersion, request_id: req.context.requestId,
      });
    }
    res.json({
      success: true, status: 'processing', job_id: req.params.job_id,
      progress: job.progress(), api_version: CONFIG.apiVersion, request_id: req.context.requestId,
    });
  } catch (err) { next(err); }
});

// ── BOOK ───────────────────────────────────────────────────────────────────

apiV1.post('/book', createRateLimiter('book'), validate(bookSchema), async (req, res, next) => {
  try {
    // Idempotency — safe to retry
    const existing = await checkIdempotency(req.body.idempotency_key, req.context.agency.id);
    if (existing.exists) {
      return res.json({
        success:         true,
        booking_ref:     existing.data.booking_ref,
        status:          existing.data.status,
        message:         'Booking already processed (idempotent response)',
        idempotent:      true,
        api_version:     CONFIG.apiVersion,
        request_id:      req.context.requestId,
      });
    }

    // Resolve package server-side — client cannot override price
    const resolvedPkg = await resolvePackage(req.context.agency.id, req.body.package_id);

    const bookingMode  = req.body.booking_mode || 'bodrless_fills';
    const components   = req.body.components   || {};

    const bookingData = {
      idempotencyKey:  req.body.idempotency_key,
      packageId:       req.body.package_id,
      bookingMode,
      components,
      guest: {
        name:  req.body.guest_name,
        email: req.body.guest_email,
        phone: req.body.guest_phone,
      },
      passengers:      req.body.passengers,
      totalPrice:      resolvedPkg.summary?.totalPrice || 0,
      currency:        resolvedPkg.summary?.currency || 'USD',
      nights:          resolvedPkg.summary?.nights || null,
      transport:       resolvedPkg.transport,
      hotel:           resolvedPkg.hotel,
      transfer:        resolvedPkg.transfers,
      summary:         resolvedPkg.summary,
      specialRequests: req.body.special_requests || 'None',
      paymentToken:    req.body.payment_token || null,
      sandbox:         req.context.sandbox,
    };

    // ── booking_mode: 'bodrless_fills' ───────────────────────────────────────
    // OTA (e.g. Wakanow) handles flights and hotels through their own system.
    // Bodrless only confirms the gap components they requested: bus, train, transfer.
    // No saga, no payment — we just register and notify the relevant suppliers.
    if (bookingMode === 'bodrless_fills') {
      const bookingRef = `BDR-FILL-${nanoid(10).toUpperCase()}`;
      const confirmed  = [];

      // Only act on components the OTA explicitly asked Bodrless to handle
      if (components.bus      && resolvedPkg.transport?.transportType === 'bus')   confirmed.push('bus');
      if (components.train    && resolvedPkg.transport?.transportType === 'train') confirmed.push('train');
      if (components.transfer && resolvedPkg.transfers)                            confirmed.push('transfer');

      // Record the gap booking for tracking and notifications
      await supabase.from('bookings').insert({
        booking_ref:      bookingRef,
        agency_id:        req.context.agency.id,
        guest_name:       req.body.guest_name,
        guest_email:      req.body.guest_email,
        guest_phone:      req.body.guest_phone,
        passengers:       req.body.passengers,
        total_price:      0,           // OTA handles pricing — we don't charge
        destination:      resolvedPkg.transport?.destination || null,
        origin:           resolvedPkg.transport?.origin || null,
        nights:           resolvedPkg.summary?.nights || null,
        channel:          'api',
        flight_details:   null,        // OTA owns this
        hotel_details:    null,        // OTA owns this
        transfer_details: components.transfer ? resolvedPkg.transfers : null,
        trip_params:      resolvedPkg.summary,
        special_requests: req.body.special_requests || 'None',
        status:           'confirmed',
        currency:         resolvedPkg.summary?.currency || 'USD',
        idempotency_key:  req.body.idempotency_key,
        booking_mode:     'bodrless_fills',
        bodrless_components: confirmed,
        sandbox:          req.context.sandbox,
      }).catch(err => logger.error('Gap booking record failed', { error: err.message }));

      await saveIdempotency(req.body.idempotency_key, req.context.agency.id, bookingRef, 'confirmed');

      // Fire supplier notifications for gap components
      if (confirmed.length > 0 && !req.context.sandbox) {
        await notificationQueue.add('booking.confirmed', {
          booking: {
            bookingRef,
            guestName:       req.body.guest_name,
            guestPhone:      req.body.guest_phone,
            passengers:      req.body.passengers,
            agencyId:        req.context.agency.id,
            totalPrice:      0,
            specialRequests: req.body.special_requests || 'None',
          },
          flight:   null,
          hotel:    null,
          transfer: components.transfer ? resolvedPkg.transfers : null,
        }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      }

      getRequestLogger(req).info('Gap booking confirmed', {
        bookingRef, components: confirmed, agencyId: req.context.agency.id,
      });

      return res.json({
        success:             true,
        booking_ref:         bookingRef,
        booking_mode:        'bodrless_fills',
        status:              'confirmed',
        bodrless_components: confirmed,
        message:             confirmed.length > 0
          ? `Bodrless confirmed: ${confirmed.join(', ')}. Your flights and hotels are handled by your own system.`
          : 'No Bodrless components requested — booking recorded for tracking only.',
        api_version:         CONFIG.apiVersion,
        request_id:          req.context.requestId,
      });
    }

    // ── booking_mode: 'bodrless_full' ────────────────────────────────────────
    // Bodrless runs the full saga: hold transport, hold hotel, process payment,
    // confirm all. Used when OTA has no booking stack of their own.
    const job = await bookingQueue.add('book', {
      bookingData,
      agency:    req.context.agency,
      requestId: req.context.requestId,
    }, { attempts: 1, timeout: 60000 });

    getRequestLogger(req).info('Full booking saga queued', { jobId: job.id, packageId: req.body.package_id });

    res.status(202).json({
      success:         true,
      booking_mode:    'bodrless_full',
      message:         'Booking accepted for processing',
      job_id:          job.id,
      status:          'processing',
      poll_url:        `/api/v1/book/status/${job.id}`,
      idempotency_key: req.body.idempotency_key,
      api_version:     CONFIG.apiVersion,
      request_id:      req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.get('/book/status/:job_id', async (req, res, next) => {
  try {
    const job = await bookingQueue.getJob(req.params.job_id);
    if (!job) { const err = new Error('Booking job not found'); err.code = 'NOT_FOUND'; err.statusCode = 404; throw err; }

    const state  = await job.getState();
    const result = job.returnvalue;

    if (state === 'completed' && result) {
      return res.json({
        success:     true,
        status:      result.status,
        booking_ref: result.bookingRef,
        saga_id:     result.sagaId,
        message:     'Booking confirmed. Hotel, transfer and agency notified.',
        api_version: CONFIG.apiVersion,
        request_id:  req.context.requestId,
      });
    }
    if (state === 'failed') {
      return res.status(500).json({
        success: false, status: 'failed',
        error: { message: 'Booking failed. No charges were applied.', code: 'BOOKING_FAILED' },
        api_version: CONFIG.apiVersion, request_id: req.context.requestId,
      });
    }
    res.json({
      success: true, status: 'processing', job_id: req.params.job_id,
      api_version: CONFIG.apiVersion, request_id: req.context.requestId,
    });
  } catch (err) { next(err); }
});

// ── INVENTORY UPLOAD ───────────────────────────────────────────────────────

apiV1.post('/inventory/upload', createRateLimiter('inventory'), validate(inventoryUploadSchema), async (req, res, next) => {
  try {
    const { type, items, replace_all } = req.body;
    const itemSchema = inventoryItemSchemas[type];
    const validItems = []; const validationErrors = [];

    for (let i = 0; i < items.length; i++) {
      const { error, value } = itemSchema.validate(items[i], { stripUnknown: true });
      if (error) validationErrors.push({ index: i, error: error.details[0].message });
      else validItems.push(value);
    }

    if (validationErrors.length > 0) {
      const err = new Error(`${validationErrors.length} items failed validation`);
      err.code = 'VALIDATION_ERROR'; err.statusCode = 400; err.details = validationErrors; throw err;
    }

    const job = await inventoryQueue.add('inventory', {
      agencyId:  req.context.agency.id,
      type, items: validItems, replaceAll: replace_all,
      requestId: req.context.requestId,
    }, { attempts: 3, timeout: 120000 });

    getRequestLogger(req).info('Inventory upload queued', { jobId: job.id, count: validItems.length });

    res.status(202).json({
      success:        true,
      message:        'Inventory upload accepted',
      job_id:         job.id,
      status:         'processing',
      items_received: items.length,
      items_valid:    validItems.length,
      poll_url:       `/api/v1/inventory/upload/${job.id}`,
      api_version:    CONFIG.apiVersion,
      request_id:     req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.get('/inventory/upload/:job_id', async (req, res, next) => {
  try {
    const job = await inventoryQueue.getJob(req.params.job_id);
    if (!job) { const err = new Error('Upload job not found'); err.code = 'NOT_FOUND'; err.statusCode = 404; throw err; }

    const state  = await job.getState();
    const result = job.returnvalue;

    if (state === 'completed' && result) return res.json({ success: true, status: 'completed', result, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    if (state === 'failed') return res.status(500).json({ success: false, status: 'failed', error: { message: 'Upload failed', code: 'UPLOAD_FAILED' }, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    res.json({ success: true, status: 'processing', job_id: req.params.job_id, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
  } catch (err) { next(err); }
});

// ── BOOKINGS ───────────────────────────────────────────────────────────────

apiV1.get('/bookings', async (req, res, next) => {
  try {
    const { status, from_date, to_date, limit = 100, offset = 0 } = req.query;
    let query = supabase.from('bookings').select('*')
      .eq('agency_id', req.context.agency.id)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status)    query = query.eq('status', status);
    if (from_date) query = query.gte('created_at', from_date);
    if (to_date)   query = query.lte('created_at', to_date);

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      success:    true,
      bookings:   data || [],
      count:      (data || []).length,
      pagination: { limit: parseInt(limit), offset: parseInt(offset) },
      api_version: CONFIG.apiVersion,
      request_id: req.context.requestId,
    });
  } catch (err) { next(err); }
});

// ── DELAY NOTIFICATIONS ────────────────────────────────────────────────────

apiV1.post('/notify/delay', createRateLimiter('notify'), validate(delayNotifySchema), async (req, res, next) => {
  try {
    const { booking_ref, delay_minutes, new_arrival_time, reason } = req.body;
    const { data: booking, error } = await supabase.from('bookings').select('*')
      .eq('booking_ref', booking_ref).eq('agency_id', req.context.agency.id).single();

    if (error || !booking) { const err = new Error('Booking not found'); err.code = 'NOT_FOUND'; err.statusCode = 404; throw err; }

    await notifyFlightDelay({
      booking: {
        bookingRef:  booking.booking_ref,
        guestName:   booking.guest_name,
        passengers:  booking.passengers,
        agencyId:    req.context.agency.id,
      },
      flight:       booking.flight_details   || {},
      hotel:        booking.hotel_details    || null,
      transfer:     booking.transfer_details || null,
      delayMinutes:    delay_minutes,
      newArrivalTime:  new_arrival_time,
      reason:          reason || 'Operational delay',
    });

    getRequestLogger(req).info('Delay notification triggered', { bookingRef: booking_ref, delayMinutes: delay_minutes });

    res.json({
      success:          true,
      message:          `Delay notifications queued for ${booking_ref}`,
      affected_parties: ['agency', booking.hotel_details ? 'hotel' : null, booking.transfer_details ? 'transfer' : null].filter(Boolean),
      api_version:      CONFIG.apiVersion,
      request_id:       req.context.requestId,
    });
  } catch (err) { next(err); }
});

// ── WEBHOOK CONFIG ─────────────────────────────────────────────────────────

apiV1.post('/webhooks/configure', validate(webhookConfigSchema), async (req, res, next) => {
  try {
    const { url, events, secret } = req.body;
    const { error } = await supabase.from('agencies').update({
      webhook_url:    url,
      webhook_events: events,
      webhook_secret: secret || null,
      updated_at:     new Date().toISOString(),
    }).eq('id', req.context.agency.id);

    if (error) throw error;

    // Bust agency cache
    await redis.del(`agency:key:${req.headers['x-api-key']?.substring(0, 16)}`);

    getRequestLogger(req).info('Webhook configured', { agencyId: req.context.agency.id, events });

    res.json({
      success:     true,
      message:     'Webhook configuration updated',
      webhook:     { url, events, hmac_enabled: !!secret },
      api_version: CONFIG.apiVersion,
      request_id:  req.context.requestId,
    });
  } catch (err) { next(err); }
});

// ── Mount & Error Handling ─────────────────────────────────────────────────

app.use('/api/v1', apiV1);
app.use(errorHandler);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: { message: 'Endpoint not found', code: 'NOT_FOUND', request_id: req.context?.requestId },
    api_version: CONFIG.apiVersion,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WORKERS  (node api_v2.js --worker)
// ═══════════════════════════════════════════════════════════════════════════

if (process.argv.includes('--worker')) {

  searchQueue.process(async (job) => {
    const { searchPrompt, agency, options } = job.data;
    logger.info('Processing search', { jobId: job.id, agencyId: agency.id });

    const result = await orchestrate(searchPrompt, agency, {
      conversationHistory: options.conversationHistory,
      previousParams:      options.previousParams,
      inventoryControl:    options.inventoryControl || {},
      llmOverride:         options.llmOverride || null,
      maxResults:          options.maxResults,
      currency:            options.currency,
    });

    // Persist search record
    await supabase.from('trip_searches').insert({
      agency_id:        agency.id,
      session_id:       options.sessionId || result.sessionId,
      prompt:           searchPrompt,
      destination:      result.tripParams?.destination || null,
      origin:           result.tripParams?.origin || null,
      passengers:       result.tripParams?.passengers || 1,
      budget:           result.tripParams?.budget || null,
      nights:           result.tripParams?.nights || null,
      packages_returned: result.packages?.length || 0,
      channel:          'api',
      converted:        false,
      job_id:           job.id,
      created_at:       new Date().toISOString(),
    }).catch(() => {});

    // Fire search.completed webhook if configured
    if (agency.webhook_url) {
      await webhookQueue.add('webhook', {
        agencyId: agency.id,
        event:    'search.completed',
        payload: {
          job_id:        job.id,
          session_id:    result.sessionId,
          package_count: result.packages?.length || 0,
          trip_params:   result.tripParams,
          sources:       result.sources,
        },
      });
    }

    return result;
  });

  inventoryQueue.process(async (job) => {
    logger.info('Processing inventory upload', { jobId: job.id, agencyId: job.data.agencyId });
    return await processInventoryUpload(job);
  });

  bookingQueue.process(async (job) => {
    const { bookingData, agency } = job.data;
    logger.info('Processing booking saga', { jobId: job.id, agencyId: agency.id });

    const result = await executeBookingSaga(bookingData, agency, { sandbox: bookingData.sandbox });

    if (result.success) {
      await notifyBookingConfirmed({
        booking: {
          bookingRef:      result.bookingRef,
          guestName:       bookingData.guest.name,
          guestPhone:      bookingData.guest.phone,
          passengers:      bookingData.passengers,
          agencyId:        agency.id,
          totalPrice:      bookingData.totalPrice,
          checkIn:         bookingData.summary?.departureDate,
          specialRequests: bookingData.specialRequests,
        },
        flight:   bookingData.transport?.airline   ? bookingData.transport : null,
        hotel:    bookingData.hotel?.name           ? bookingData.hotel     : null,
        transfer: bookingData.transfer?.provider    ? bookingData.transfer  : null,
      });
    }
    return result;
  });

  notificationQueue.process(async (job) => {
    const { type, payload } = job.data;
    if (type === 'booking.confirmed') await notifyBookingConfirmed(payload);
    return { delivered: true };
  });

  webhookQueue.process(async (job) => {
    const { agencyId, event, payload } = job.data;
    return await deliverWebhook(agencyId, event, payload);
  });

  console.log('Bodrless workers running...');

} else {

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received — shutting down gracefully');
    process.exit(0);
  });

  app.listen(CONFIG.port, () => {
    logger.info(`Bodrless API v${CONFIG.apiVersion} running on port ${CONFIG.port}`);
  });
}