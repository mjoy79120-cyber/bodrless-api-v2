/**
 * BODRLESS PUBLIC API v2.1 — PRODUCTION READY
 * ─────────────────────────────────────────────────────────────────────────────
 * Single endpoint. BYO LLM (per-request, never stored). BYO Inventory.
 * Async search. Saga bookings. Idempotency. Webhooks. Sandbox. Zero breaking changes.
 * LIVE INVENTORY ADAPTER v2.1 — Booking.com / Expedia ready
 *
 * Install:
 *   npm install express helmet cors hpp express-rate-limit rate-limit-redis \
 *               joi bull ioredis uuid nanoid axios winston compression dotenv \
 *               @supabase/supabase-js jsdom dompurify
 *
 * Run API server:  node api_v2.js
 * Run workers:     node api_v2.js --worker
 *
 * Render env vars required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   REDIS_URL
 *   BODRLESS_LLM_ENDPOINT       (Groq endpoint — default LLM)
 *   BODRLESS_LLM_KEY            (Groq API key — default LLM)
 *   ALLOWED_ORIGINS             (comma-separated, e.g. https://wakanow.com,https://api.wakanow.com)
 *   ADAPTER_ENCRYPTION_KEY      (32-byte hex — generate: openssl rand -hex 32)
 *
 * Render setup — two services:
 *   Web:    node api_v2.js
 *   Worker: node api_v2.js --worker
 *
 * Supabase migration (run once):
 *   ALTER TABLE agencies ADD COLUMN IF NOT EXISTS inventory_adapters jsonb DEFAULT NULL;
 *   CREATE INDEX IF NOT EXISTS idx_agencies_inventory_adapters
 *     ON agencies USING gin(inventory_adapters) WHERE inventory_adapters IS NOT NULL;
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
  apiVersion:     '2.1.0',
  apiVersionDate: '2026-08-21',

  rateLimits: {
    free:       { search: 10,   book: 5,   inventory: 5,    notify: 10   },
    growth:     { search: 100,  book: 50,  inventory: 50,   notify: 100  },
    enterprise: { search: 1000, book: 500, inventory: 500,  notify: 1000 },
  },

  cacheTtl: {
    agency:        300,
    inventory:     60,
    searchResults: 600,
    package:       1800,
  },

  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  redisUrl:    process.env.REDIS_URL || 'redis://localhost:6379',

  // Default LLM is Groq. Partners can override per-request with any
  // OpenAI-compatible provider (ChatGPT, Anthropic, Gemini, etc.)
  // The partner's api_key is used in-flight only — never stored or logged.
  defaultLlm: {
    provider: 'groq',
    model:    process.env.BODRLESS_LLM_MODEL || 'llama-3.3-70b-versatile',
    endpoint: process.env.BODRLESS_LLM_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions',
    apiKey:   process.env.BODRLESS_LLM_KEY,
  },

  // auth_config encryption key — 32-byte hex string
  // Generate: openssl rand -hex 32
  // Set in Render env vars as ADAPTER_ENCRYPTION_KEY
  adapterEncryptionKey: process.env.ADAPTER_ENCRYPTION_KEY || null,

  // Agency portal — where new agencies sign up
  agencyPortalUrl: 'https://bodrless-agency-portal.vercel.app/dashboard',
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
// STARTUP CHECKS
// ═══════════════════════════════════════════════════════════════════════════

if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

if (!CONFIG.defaultLlm.apiKey || !CONFIG.defaultLlm.endpoint) {
  logger.warn(
    'BODRLESS_LLM_KEY or BODRLESS_LLM_ENDPOINT not set — ' +
    'default Groq LLM is not configured. ' +
    'All search requests must include a per-request llm override, ' +
    'otherwise searches will return clarifying questions with low confidence.'
  );
}

if (!CONFIG.adapterEncryptionKey) {
  logger.warn(
    'ADAPTER_ENCRYPTION_KEY not set — ' +
    'live inventory adapter auth_config will be stored unencrypted. ' +
    'Generate with: openssl rand -hex 32'
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════════════════════════════════════

const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { persistSession: false },
});

async function dbHealthCheck() {
  const { error } = await supabase.from('agencies').select('id').limit(1);
  return !error;
}

// ═══════════════════════════════════════════════════════════════════════════
// REDIS
// ═══════════════════════════════════════════════════════════════════════════

const redis = new Redis(CONFIG.redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    if (times > 3) return null;
    return Math.min(times * 100, 3000);
  },
});

redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
redis.on('connect', () => logger.info('Redis connected'));

// ═══════════════════════════════════════════════════════════════════════════
// JOB QUEUES
// FIX: Parse REDIS_URL properly so queues work on Render managed Redis,
// Upstash, or any remote Redis — not just localhost:6379.
// ═══════════════════════════════════════════════════════════════════════════

function buildBullRedisConfig(redisUrl) {
  try {
    const url = new URL(redisUrl);
    const config = {
      host:     url.hostname,
      port:     parseInt(url.port, 10) || 6379,
      password: url.password || undefined,
    };
    // rediss:// means TLS — required for Upstash and some managed Redis providers
    if (url.protocol === 'rediss:') {
      config.tls = {};
    }
    return { redis: config };
  } catch {
    // Fallback to localhost if URL is malformed
    logger.warn('Could not parse REDIS_URL — falling back to localhost:6379');
    return { redis: { host: 'localhost', port: 6379 } };
  }
}

const redisConfig = buildBullRedisConfig(CONFIG.redisUrl);

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
// AUTH CONFIG ENCRYPTION
// Adapter credentials (OAuth tokens, API keys, HMAC secrets) are encrypted
// at rest using AES-256-CBC before being written to Supabase.
// The plaintext key never leaves memory and is never logged.
// ═══════════════════════════════════════════════════════════════════════════

function encryptAuthConfig(authConfig) {
  if (!authConfig || !CONFIG.adapterEncryptionKey) return authConfig;
  try {
    const iv      = crypto.randomBytes(16);
    const key     = Buffer.from(CONFIG.adapterEncryptionKey, 'hex');
    const cipher  = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(authConfig), 'utf8'),
      cipher.final(),
    ]);
    return {
      _encrypted: true,
      iv:         iv.toString('hex'),
      data:       encrypted.toString('hex'),
    };
  } catch (err) {
    logger.error('auth_config encryption failed', { error: err.message });
    return authConfig;
  }
}

function decryptAuthConfig(stored) {
  if (!stored || !stored._encrypted || !CONFIG.adapterEncryptionKey) return stored;
  try {
    const key      = Buffer.from(CONFIG.adapterEncryptionKey, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(stored.iv, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(stored.data, 'hex')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    logger.error('auth_config decryption failed', { error: err.message });
    return null;
  }
}

function encryptAdapterConfig(adapterConfig) {
  if (!adapterConfig) return adapterConfig;
  const encrypted = {};
  for (const [component, adapter] of Object.entries(adapterConfig)) {
    if (!adapter) continue;
    encrypted[component] = {
      ...adapter,
      auth_config: adapter.auth_config ? encryptAuthConfig(adapter.auth_config) : null,
    };
  }
  return encrypted;
}

function decryptAdapterConfig(adapterConfig) {
  if (!adapterConfig) return adapterConfig;
  const decrypted = {};
  for (const [component, adapter] of Object.entries(adapterConfig)) {
    if (!adapter) continue;
    decrypted[component] = {
      ...adapter,
      auth_config: adapter.auth_config ? decryptAuthConfig(adapter.auth_config) : null,
    };
  }
  return decrypted;
}

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
  api_key:  Joi.string().max(500).optional(),
}).optional();

const searchSchema = Joi.object({
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
  session_id:           Joi.string().uuid().allow(null).optional(),
  conversation_history: Joi.array().items(
    Joi.object({
      role:      Joi.string().valid('user', 'assistant', 'system').required(),
      content:   Joi.string().max(2000).required(),
      timestamp: Joi.string().isoDate().optional(),
    })
  ).max(20).optional(),
  previous_params: Joi.object().allow(null).optional(),
  inventory: Joi.object({
    flights:   Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    hotels:    Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    buses:     Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    trains:    Joi.string().valid('mine', 'bodrless', 'both').default('both'),
    transfers: Joi.string().valid('mine', 'bodrless', 'both').default('both'),
  }).optional(),
  llm: llmSchema,
  max_results: Joi.number().integer().min(1).max(20).default(4),
  currency:    Joi.string().length(3).uppercase().default('USD'),
}).or('prompt', 'destination');

const bookSchema = Joi.object({
  idempotency_key: Joi.string().uuid().required(),
  package_id:      Joi.string().max(100).required(),
  booking_mode: Joi.string().valid('bodrless_fills', 'bodrless_full').default('bodrless_fills'),
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

const bookingsQuerySchema = Joi.object({
  status:    Joi.string().valid('confirmed', 'failed', 'cancelled').optional(),
  from_date: Joi.string().isoDate().optional(),
  to_date:   Joi.string().isoDate().optional(),
  limit:     Joi.number().integer().min(1).max(100).default(100),
  offset:    Joi.number().integer().min(0).default(0),
});

const liveComponentAdapterSchema = Joi.object({
  search_url:  Joi.string().uri().max(500).required(),
  hold_url:    Joi.string().uri().max(500).required(),
  confirm_url: Joi.string().uri().max(500).required(),
  cancel_url:  Joi.string().uri().max(500).required(),
  auth_type:   Joi.string().valid('bearer', 'hmac', 'api_key', 'none').default('bearer'),
  auth_config: Joi.object().optional(),
  timeout_ms:  Joi.number().integer().min(1000).max(30000).default(10000),
  version:     Joi.string().valid('v1').default('v1'),
}).optional();

const agencyAdapterConfigSchema = Joi.object({
  flights:   liveComponentAdapterSchema,
  hotels:    liveComponentAdapterSchema,
  transfers: liveComponentAdapterSchema,
  buses:     liveComponentAdapterSchema,
  trains:    liveComponentAdapterSchema,
}).optional();

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
// PACKAGE CACHE
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
  if (cached) {
    const agency = JSON.parse(cached);
    // Decrypt adapter auth_config after loading from cache
    if (agency.inventory_adapters) {
      agency.inventory_adapters = decryptAdapterConfig(agency.inventory_adapters);
    }
    return agency;
  }

  const { data: agency, error } = await supabase
    .from('agencies')
    .select('id, name, plan, status, webhook_url, llm_config, inventory_config, rate_limits, allowed_ips, signing_secret, created_at, inventory_adapters')
    .eq('key_prefix', prefix)
    .eq('status', 'active')
    .single();

  if (error || !agency) return null;

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const { data: keyData } = await supabase
    .from('api_keys')
    .select('key_hash')
    .eq('agency_id', agency.id)
    .eq('key_hash', keyHash)
    .single();

  if (!keyData) return null;

  // Parse JSON fields stored as strings
  ['llm_config', 'inventory_config', 'rate_limits', 'allowed_ips', 'inventory_adapters'].forEach(field => {
    if (agency[field] && typeof agency[field] === 'string') {
      try { agency[field] = JSON.parse(agency[field]); } catch { agency[field] = null; }
    }
  });

  // Cache the encrypted form, decrypt after retrieval
  await redis.setex(cacheKey, CONFIG.cacheTtl.agency, JSON.stringify(agency));

  // Decrypt for in-memory use
  if (agency.inventory_adapters) {
    agency.inventory_adapters = decryptAdapterConfig(agency.inventory_adapters);
  }

  return agency;
}

function checkIpAllowlist(req, agency) {
  const allowedIps = agency.allowed_ips;
  if (!Array.isArray(allowedIps) || allowedIps.length === 0) return true;

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || req.ip;

  if (!allowedIps.includes(clientIp)) {
    logger.warn('IP allowlist rejected', { clientIp, agencyId: agency.id, allowed: allowedIps });
    return false;
  }
  return true;
}

function verifyRequestSignature(req, agency) {
  const secret    = agency.signing_secret;
  const signature = req.headers['x-bodrless-signature'];
  const timestamp = req.headers['x-bodrless-timestamp'];

  if (!secret) return true;
  if (!signature || !timestamp) {
    logger.warn('Request signature missing for signed agency', { agencyId: agency.id });
    return false;
  }

  const tsSeconds = parseInt(timestamp, 10);
  if (isNaN(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    logger.warn('Request timestamp expired or invalid', { agencyId: agency.id, timestamp });
    return false;
  }

  const body     = req.body ? JSON.stringify(req.body) : '';
  const payload  = `${timestamp}.${req.method}.${req.path}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const received = signature.replace('sha256=', '');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(received.padEnd(expected.length, '0').slice(0, expected.length), 'hex')
    );
  } catch {
    return false;
  }
}

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
      const err = new Error(
        `Invalid or missing API key. Sign up at ${CONFIG.agencyPortalUrl}`
      );
      err.code = 'AUTH_REQUIRED';
      err.statusCode = 401;
      return next(err);
    }

    if (!checkIpAllowlist(req, agency)) {
      const err = new Error('Request origin IP is not allowlisted for this API key');
      err.code = 'IP_NOT_ALLOWED';
      err.statusCode = 403;
      return next(err);
    }

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
    keyGenerator: (req) => req.context?.agency?.id || req.socket.remoteAddress || req.ip,
    validate: { ipv6SubnetOrKeyGenerator: false },
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
    VALIDATION_ERROR:           err.message,
    RATE_LIMIT_EXCEEDED:        'Rate limit exceeded. Please retry later.',
    AUTH_REQUIRED:              `Authentication required. Pass a valid x-api-key header. Sign up at ${CONFIG.agencyPortalUrl}`,
    IP_NOT_ALLOWED:             'Request origin IP is not allowlisted for this API key.',
    SIGNATURE_INVALID:          'Request signature invalid or timestamp expired. Check X-Bodrless-Timestamp and X-Bodrless-Signature headers.',
    NOT_FOUND:                  err.message || 'Resource not found',
    PACKAGE_EXPIRED:            'Package expired. Please search again.',
    PROMPT_SANITIZATION_FAILED: 'Prompt failed security validation.',
    IDEMPOTENCY_CONFLICT:       'Duplicate request detected.',
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
// LLM SERVICE
// Default: Groq (llama-3.3-70b-versatile) — fast, cheap, great for parsing.
// Partners can override per-request with any OpenAI-compatible provider:
// ChatGPT, Anthropic, Gemini, Azure, or a custom endpoint.
// The partner's api_key is used in-flight only — never written to DB or logs.
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

async function parsePrompt(prompt, agency, conversationHistory = [], llmOverride = null) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(conversationHistory.slice(-5)),
    { role: 'user',   content: prompt },
  ];

  let llmEndpoint, llmModel, llmApiKey, providerLabel;

  // Priority 1: per-request partner LLM override (ChatGPT, Anthropic, Gemini, etc.)
  // The partner's api_key is used here and nowhere else — never stored.
  if (llmOverride?.endpoint && llmOverride?.api_key) {
    llmEndpoint   = llmOverride.endpoint;
    llmModel      = llmOverride.model || 'default';
    llmApiKey     = llmOverride.api_key;
    providerLabel = `partner:${llmOverride.provider || 'custom'}`;

  // Priority 2: agency-level LLM config (set in their portal settings)
  } else if (agency.llm_config?.endpoint) {
    llmEndpoint   = agency.llm_config.endpoint;
    llmModel      = agency.llm_config.model || 'default';
    llmApiKey     = agency.llm_config.api_key || CONFIG.defaultLlm.apiKey;
    providerLabel = `agency:${agency.llm_config.provider || 'custom'}`;

  // Priority 3: Bodrless default — Groq / llama-3.3-70b-versatile
  } else {
    llmEndpoint   = CONFIG.defaultLlm.endpoint;
    llmModel      = CONFIG.defaultLlm.model;
    llmApiKey     = CONFIG.defaultLlm.apiKey;
    providerLabel = 'bodrless:groq';
  }

  try {
    logger.info('Calling LLM', { agencyId: agency.id, provider: providerLabel, model: llmModel });

    const response = await axios.post(llmEndpoint, {
      model: llmModel, messages, temperature: 0.1, max_tokens: 1500,
    }, {
      headers: { 'Authorization': `Bearer ${llmApiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });

    const content = response.data.choices?.[0]?.message?.content
      || response.data.content || response.data.text || response.data.response;

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
// LIVE ADAPTER CLIENT
// ═══════════════════════════════════════════════════════════════════════════

async function resolveAdapterAuth(adapter) {
  const cfg = adapter.auth_config || {};
  if (adapter.auth_type === 'bearer')  return cfg.token  || '';
  if (adapter.auth_type === 'hmac')    return cfg.secret || '';
  if (adapter.auth_type === 'api_key') return cfg.key    || '';
  return '';
}

function buildAdapterHeaders(agency, adapter, payloadBody, authToken) {
  const headers = {
    'Content-Type':         'application/json',
    'X-Bodrless-Version':   CONFIG.apiVersion,
    'X-Bodrless-Agency-ID': agency.id,
    'User-Agent':           'Bodrless-Adapter/2.0',
  };
  if (adapter.auth_type === 'bearer')  headers['Authorization'] = `Bearer ${authToken}`;
  if (adapter.auth_type === 'api_key') headers['X-API-Key']     = authToken;
  if (adapter.auth_type === 'hmac' && adapter.auth_config?.secret) {
    const sig = crypto.createHmac('sha256', adapter.auth_config.secret)
      .update(JSON.stringify(payloadBody)).digest('hex');
    headers['X-Bodrless-Signature'] = `sha256=${sig}`;
  }
  return headers;
}

async function callLiveAdapter(agency, component, action, payload) {
  const adapter = agency.inventory_adapters?.[component];
  if (!adapter) return null;

  const urlKey = `${action}_url`;
  const url    = adapter[urlKey];
  if (!url) return null;

  const requestId = uuidv4();
  const body = {
    bodrless_request_id: requestId,
    action,
    version:   adapter.version || 'v1',
    agency_id: agency.id,
    timestamp: new Date().toISOString(),
    payload,
  };

  const authToken = await resolveAdapterAuth(adapter);
  const headers   = buildAdapterHeaders(agency, adapter, body, authToken);

  try {
    const { data } = await axios.post(url, body, {
      headers,
      timeout:        adapter.timeout_ms || 10000,
      validateStatus: (s) => s < 500,
    });
    return normalizeAdapterResponse(component, action, data, adapter);
  } catch (err) {
    logger.error('Live adapter call failed', {
      agencyId: agency.id, component, action, url, error: err.message,
    });
    return null;
  }
}

function normalizeAdapterResponse(component, action, raw, adapter) {
  if (action === 'search') {
    const rawItems = raw.items || raw.results || raw.data || raw.flights || raw.hotels || [];
    return {
      items: rawItems.map(item => ({
        external_id:     item.external_id || item.id || item.sku || uuidv4(),
        airline:         item.airline     || item.carrier   || item.operator || null,
        flight_number:   item.flight_number || item.number  || item.code     || null,
        operator:        item.operator    || item.carrier   || item.provider || null,
        train_number:    item.train_number || item.number   || null,
        name:            item.name        || item.hotel_name || item.property_name || null,
        location:        item.location    || item.address   || item.city     || null,
        origin:          item.origin      || item.from      || item.departure || null,
        destination:     item.destination || item.to        || item.arrival  || null,
        departure_time:  item.departure_time || item.departure || item.departs_at || null,
        arrival_time:    item.arrival_time   || item.arrival   || item.arrives_at || null,
        price:           Number(item.price       || item.amount || item.rate || 0),
        price_per_night: Number(item.price_per_night || item.nightly_rate || item.rate || 0),
        currency:        (item.currency || 'USD').toUpperCase(),
        seats_available: Number(item.seats_available || item.availability || item.seats || 0),
        rooms_available: Number(item.rooms_available || item.room_count || 0),
        stars:           item.stars       || item.rating    || null,
        rating:          item.rating      || item.review_score || null,
        meal_plan:       item.meal_plan   || item.board     || null,
        vehicle_type:    item.vehicle_type || item.vehicle  || null,
        provider:        item.provider    || item.company   || null,
        transport_type:  component === 'flights'   ? 'flight'
                       : component === 'buses'     ? 'bus'
                       : component === 'trains'    ? 'train'
                       : component,
        _source:  'ota_live',
        _adapter: {
          component,
          version: adapter.version,
          urls: {
            hold:    adapter.hold_url,
            confirm: adapter.confirm_url,
            cancel:  adapter.cancel_url,
          },
        },
        metadata: item.metadata || { raw_id: item.id },
      })).filter(i => i.price > 0 && i.external_id),
    };
  }

  if (action === 'hold') {
    return {
      status:   raw.status || 'held',
      holdRef:  raw.hold_ref || raw.hold_reference || raw.pnr || raw.reference || `HOLD-${nanoid(8)}`,
      expiresAt: raw.expires_at || raw.expiry || null,
      metadata: raw.metadata || {},
      _source:  'ota_live',
    };
  }

  if (action === 'confirm') {
    return {
      status:          raw.status || 'confirmed',
      confirmationRef: raw.confirmation_ref || raw.ticket_number || raw.reference || `CNF-${nanoid(8)}`,
      metadata:        raw.metadata || {},
      _source:         'ota_live',
    };
  }

  if (action === 'cancel') {
    return { status: raw.status || 'cancelled', metadata: raw.metadata || {} };
  }

  return raw;
}

// ═══════════════════════════════════════════════════════════════════════════
// INVENTORY SERVICE
// ═══════════════════════════════════════════════════════════════════════════

async function searchAgencyInventory(agency, component, tripParams) {
  if (agency.inventory_adapters?.[component]) {
    const liveResult = await callLiveAdapter(agency, component, 'search', {
      origin:         tripParams.origin,
      destination:    tripParams.destination,
      departure_date: tripParams.departureDate,
      return_date:    tripParams.returnDate,
      passengers:     tripParams.passengers || 1,
      nights:         tripParams.nights,
      currency:       tripParams.currency || 'USD',
      budget:         tripParams.budget,
    });
    if (liveResult?.items?.length) {
      return liveResult.items.map(item => ({ ...item, source: 'ota_live' }));
    }
  }

  const table = component;
  let query = supabase.from(table).select('*')
    .eq('agency_id', agency.id)
    .eq('is_active', true);
  if (tripParams.destination) query = query.ilike('destination', `%${tripParams.destination}%`);
  if (tripParams.origin)      query = query.ilike('origin', `%${tripParams.origin}%`);
  if (tripParams.departureDate) {
    const d     = new Date(tripParams.departureDate);
    const start = new Date(d); start.setDate(d.getDate() - 1);
    const end   = new Date(d); end.setDate(d.getDate() + 1);
    query = query.gte('departure_time', start.toISOString()).lte('departure_time', end.toISOString());
  }
  const { data, error } = await query.limit(20);
  if (error) throw error;
  return (data || []).map(item => ({ ...item, source: 'ota' }));
}

async function searchInventory(agency, tripParams, options = {}) {
  const { inventoryControl = {}, maxResults = 4, transportMode = 'any' } = options;

  const control = {
    flights:   inventoryControl.flights   || 'both',
    hotels:    inventoryControl.hotels    || 'both',
    buses:     inventoryControl.buses     || 'both',
    trains:    inventoryControl.trains    || 'both',
    transfers: inventoryControl.transfers || 'both',
  };

  const cacheKey = `inv:${agency.id}:${tripParams.destination}:${tripParams.departureDate}:${transportMode}:${JSON.stringify(control)}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const results = { flights: [], hotels: [], transfers: [], buses: [], trains: [], sources: [] };

  try {
    if (control.flights !== 'bodrless') {
      const r = await searchAgencyInventory(agency, 'flights', tripParams);
      results.flights.push(...r);
      if (r.length) results.sources.push('ota:flights');
    }
    if (control.flights !== 'mine' && results.flights.length < maxResults) {
      const r = await searchBodrlessInventory('flights', tripParams, maxResults - results.flights.length);
      results.flights.push(...r.map(f => ({ ...f, source: 'bodrless', margin_applied: true })));
      if (r.length) results.sources.push('bodrless:flights');
    }

    if (control.hotels !== 'bodrless') {
      const r = await searchAgencyInventory(agency, 'hotels', tripParams);
      results.hotels.push(...r);
      if (r.length) results.sources.push('ota:hotels');
    }
    if (control.hotels !== 'mine' && results.hotels.length < maxResults) {
      const r = await searchBodrlessInventory('hotels', tripParams, maxResults - results.hotels.length);
      results.hotels.push(...r.map(h => ({ ...h, source: 'bodrless', margin_applied: true })));
      if (r.length) results.sources.push('bodrless:hotels');
    }

    if (control.transfers !== 'bodrless') {
      const r = await searchAgencyInventory(agency, 'transfers', tripParams);
      results.transfers.push(...r);
      if (r.length) results.sources.push('ota:transfers');
    }
    if (control.transfers !== 'mine' && results.transfers.length < 2) {
      const r = await searchBodrlessInventory('transfers', tripParams, 2 - results.transfers.length);
      results.transfers.push(...r.map(t => ({ ...t, source: 'bodrless', margin_applied: true })));
      if (r.length) results.sources.push('bodrless:transfers');
    }

    if (transportMode === 'bus' || transportMode === 'any') {
      if (control.buses !== 'bodrless') {
        const r = await searchAgencyInventory(agency, 'buses', tripParams);
        results.buses.push(...r);
        if (r.length) results.sources.push('ota:buses');
      }
      if (control.buses !== 'mine') {
        const r = await searchBodrlessInventory('buses', tripParams, maxResults);
        results.buses.push(...r.map(b => ({ ...b, source: 'bodrless', margin_applied: true })));
        if (r.length) results.sources.push('bodrless:buses');
      }
    }

    if (transportMode === 'train' || transportMode === 'any') {
      if (control.trains !== 'bodrless') {
        const r = await searchAgencyInventory(agency, 'trains', tripParams);
        results.trains.push(...r);
        if (r.length) results.sources.push('ota:trains');
      }
      if (control.trains !== 'mine') {
        const r = await searchBodrlessInventory('trains', tripParams, maxResults);
        results.trains.push(...r.map(t => ({ ...t, source: 'bodrless', margin_applied: true })));
        if (r.length) results.sources.push('bodrless:trains');
      }
    }

    results.sources = [...new Set(results.sources)];
    await redis.setex(cacheKey, CONFIG.cacheTtl.inventory, JSON.stringify(results));
    return results;

  } catch (err) {
    logger.error('Inventory search failed', { agencyId: agency.id, error: err.message });
    throw err;
  }
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
  const table = { hotel: 'hotels', transfer: 'transfers', bus: 'buses', train: 'trains' }[type] || 'flights';
  const results = { processed: 0, failed: 0, errors: [] };

  if (replaceAll) {
    await supabase.from(table).update({ is_active: false }).eq('agency_id', agencyId);
  }

  for (const item of items) {
    try {
      const record = { ...item, agency_id: agencyId, is_active: true, updated_at: new Date().toISOString() };
      const { error } = await supabase.from(table).upsert(record, { onConflict: 'external_id,agency_id', ignoreDuplicates: false });
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

  const llmResult  = await parsePrompt(searchPrompt, agency, conversationHistory, llmOverride);
  const tripParams = llmResult.data.tripParams || {};

  if (previousParams) {
    Object.keys(previousParams).forEach(key => {
      if (tripParams[key] === null || tripParams[key] === undefined) {
        tripParams[key] = previousParams[key];
      }
    });
  }

  const inventory = await searchInventory(agency, tripParams, {
    inventoryControl,
    maxResults,
    transportMode: tripParams.transportMode || 'any',
  });

  const packages = buildPackages(inventory, tripParams, { maxResults, currency });
  await cachePackages(agency.id, packages);

  const updatedHistory = [
    ...conversationHistory,
    { role: 'user',      content: searchPrompt,                                                                    timestamp: new Date().toISOString() },
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
    sources:      inventory.sources,
    llm_provider: llmResult.provider,
    generatedAt:  new Date().toISOString(),
    duration_ms:  Date.now() - startTime,
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
    const hotel     = hotels[i % Math.max(hotels.length, 1)]    || null;
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
        route:          `${transport.origin} → ${transport.destination}`,
        passengers,     nights,
        totalPrice:     Math.round(totalPrice * 100) / 100,
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
        _source:       transport.source || 'bodrless',
        _adapter:      transport._adapter || null,
      },
      hotel: hotel ? {
        name:          hotel.name,
        location:      hotel.location,
        stars:         hotel.stars,
        rating:        hotel.rating,
        pricePerNight: hotel.price_per_night,
        mealPlan:      hotel.meal_plan,
        source:        hotel.source || 'bodrless',
        _source:       hotel.source || 'bodrless',
        _adapter:      hotel._adapter || null,
      } : null,
      transfers: transfer ? {
        provider:    transfer.provider,
        vehicleType: transfer.vehicle_type,
        price:       transfer.price,
        source:      transfer.source || 'bodrless',
        _source:     transfer.source || 'bodrless',
        _adapter:    transfer._adapter || null,
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
// BOOKING SAGA
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
    sagaState.steps.hold_transport = await holdComponent('flights', bookingData.transport, agency, sandbox);
    await updateSagaStep(sagaId, 'hold_transport', sagaState.steps.hold_transport);

    if (bookingData.hotel?.name) {
      sagaState.steps.hold_hotel = await holdComponent('hotels', bookingData.hotel, agency, sandbox);
      await updateSagaStep(sagaId, 'hold_hotel', sagaState.steps.hold_hotel);
    }

    if (bookingData.transfer?.provider) {
      sagaState.steps.hold_transfer = await holdComponent('transfers', bookingData.transfer, agency, sandbox);
      await updateSagaStep(sagaId, 'hold_transfer', sagaState.steps.hold_transfer);
    }

    sagaState.steps.process_payment = await processPayment(bookingData, sandbox);
    await updateSagaStep(sagaId, 'process_payment', sagaState.steps.process_payment);

    sagaState.steps.confirm_all = await confirmAllComponents(sagaState.steps, agency, sandbox);
    await updateSagaStep(sagaId, 'confirm_all', sagaState.steps.confirm_all);

    await saveBooking(bookingRef, bookingData, agency, sagaState, 'confirmed');
    await saveIdempotency(bookingData.idempotencyKey, agency.id, bookingRef, 'confirmed');

    sagaState.status = 'confirmed';
    await updateSagaStatus(sagaId, 'confirmed');
    logger.info('Booking saga confirmed', { bookingRef, agencyId: agency.id, sagaId });

    return { success: true, bookingRef, status: 'confirmed', sagaId, steps: sagaState.steps };

  } catch (err) {
    logger.error('Booking saga failed — compensating', {
      bookingRef, agencyId: agency.id, error: err.message,
    });
    await compensateComponents(sagaState.steps, agency, sandbox);
    sagaState.status = 'failed';
    await updateSagaStatus(sagaId, 'failed', err.message);
    throw err;
  }
}

async function holdComponent(type, item, agency, sandbox) {
  if (!item || (!item.external_id && !item._source)) return { status: 'skipped' };
  if (sandbox) return { status: 'held', holdRef: `HOLD-SANDBOX-${nanoid(6)}`, sandbox: true };

  if (item._source === 'ota_live') {
    const result = await callLiveAdapter(agency, type, 'hold', {
      item,
      passengers: item.passengers || 1,
    });
    if (result) return result;
    throw Object.assign(new Error(`Live ${type} hold failed`), { step: type });
  }

  if (type === 'flights' || type === 'buses' || type === 'trains') {
    return { status: 'held', holdRef: `HOLD-${(item.airline || item.operator || type).toString().replace(/\s+/g, '-')}-${nanoid(8)}` };
  }
  if (type === 'hotels')    return { status: 'held', holdRef: `HOLD-HOTEL-${nanoid(8)}` };
  if (type === 'transfers') return { status: 'held', holdRef: `HOLD-TRANSFER-${nanoid(8)}` };
  return { status: 'skipped' };
}

async function confirmComponent(type, step, agency, sandbox) {
  if (sandbox) return { status: 'confirmed', sandbox: true };
  if (!step || step.status !== 'held') return { status: 'skipped' };

  if (step._source === 'ota_live') {
    const result = await callLiveAdapter(agency, type, 'confirm', { hold_ref: step.holdRef });
    if (result) return result;
    throw Object.assign(new Error(`Live ${type} confirm failed`), { step: type });
  }

  return { status: 'confirmed' };
}

async function cancelComponent(type, step, agency) {
  if (!step || step.status !== 'held') return;
  if (step.sandbox) { logger.info('Sandbox: skipping live cancel'); return; }

  if (step._source === 'ota_live') {
    await callLiveAdapter(agency, type, 'cancel', { hold_ref: step.holdRef });
    return;
  }

  logger.info(`Cancelling ${type} hold`, { holdRef: step.holdRef });
}

async function confirmAllComponents(steps, agency, sandbox) {
  if (sandbox) return { status: 'confirmed', sandbox: true };
  const results = {};
  if (steps.hold_transport?.status === 'held') results.transport = await confirmComponent('flights',   steps.hold_transport, agency, sandbox);
  if (steps.hold_hotel?.status     === 'held') results.hotel     = await confirmComponent('hotels',    steps.hold_hotel,     agency, sandbox);
  if (steps.hold_transfer?.status  === 'held') results.transfer  = await confirmComponent('transfers', steps.hold_transfer,  agency, sandbox);
  return { status: 'confirmed', components: results };
}

async function compensateComponents(steps, agency, sandbox) {
  if (sandbox) return;
  if (steps.confirm_all?.status === 'confirmed') {
    if (steps.confirm_all.components?.transport) await cancelComponent('flights',   steps.hold_transport, agency);
    if (steps.confirm_all.components?.hotel)     await cancelComponent('hotels',    steps.hold_hotel,     agency);
    if (steps.confirm_all.components?.transfer)  await cancelComponent('transfers', steps.hold_transfer,  agency);
  } else {
    if (steps.hold_transfer?.status  === 'held') await cancelComponent('transfers', steps.hold_transfer,  agency);
    if (steps.hold_hotel?.status     === 'held') await cancelComponent('hotels',    steps.hold_hotel,     agency);
    if (steps.hold_transport?.status === 'held') await cancelComponent('flights',   steps.hold_transport, agency);
  }
}

async function processPayment(bookingData, sandbox) {
  if (sandbox) return { status: 'processed', transactionId: `TXN-SANDBOX-${nanoid(8)}`, sandbox: true };
  if (!bookingData.paymentToken) return { status: 'skipped', reason: 'no_payment_token' };
  return { status: 'processed', transactionId: `TXN-${nanoid(12)}` };
}

async function saveBooking(bookingRef, data, agency, sagaState, status) {
  const { error } = await supabase.from('bookings').insert({
    booking_ref: bookingRef, agency_id: agency.id,
    guest_name: data.guest.name, guest_email: data.guest.email, guest_phone: data.guest.phone,
    passengers: data.passengers, total_price: data.totalPrice,
    destination: data.transport?.destination || null, origin: data.transport?.origin || null,
    nights: data.nights || null, channel: 'api',
    flight_details: data.transport, hotel_details: data.hotel, transfer_details: data.transfer,
    trip_params: data.summary, special_requests: data.specialRequests || 'None',
    status, currency: data.currency || 'USD',
    saga_id: sagaState.sagaId, idempotency_key: data.idempotencyKey, sandbox: data.sandbox || false,
  });
  if (error) throw error;
}

async function updateSagaStep(sagaId, step, result) {
  await supabase.from('booking_saga_steps').insert({
    saga_id: sagaId, step_name: step, status: result.status, result,
    created_at: new Date().toISOString(),
  });
}

async function updateSagaStatus(sagaId, status, errorMessage = null) {
  await supabase.from('booking_sagas').update({
    status, error_message: errorMessage, completed_at: new Date().toISOString(),
  }).eq('id', sagaId);
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS & WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════════

async function notifyBookingConfirmed({ booking, flight, hotel, transfer }) {
  const events = [{ type: 'booking.confirmed', payload: { ...booking, flight, hotel, transfer } }];
  if (hotel?.source    === 'bodrless') events.push({ type: 'hotel.notification',    payload: { bookingRef: booking.bookingRef, hotelName: hotel.name,        guestName: booking.guestName, checkIn: booking.checkIn, passengers: booking.passengers } });
  if (transfer?.source === 'bodrless') events.push({ type: 'transfer.notification', payload: { bookingRef: booking.bookingRef, provider: transfer.provider, guestName: booking.guestName, guestPhone: booking.guestPhone } });
  for (const event of events) {
    await notificationQueue.add(event.type, { ...event, agencyId: booking.agencyId, timestamp: new Date().toISOString() }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  }
  logger.info('Booking notifications queued', { bookingRef: booking.bookingRef, count: events.length });
}

async function notifyFlightDelay({ booking, flight, hotel, transfer, delayMinutes, newArrivalTime, reason }) {
  const events = [{ type: 'flight.delayed', payload: { ...booking, flight, delayMinutes, newArrivalTime, reason } }];
  if (hotel)    events.push({ type: 'hotel.delay_update',    payload: { bookingRef: booking.bookingRef, hotelName: hotel.name,        newArrivalTime, delayMinutes } });
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
    'Content-Type': 'application/json', 'X-Bodrless-Event': event,
    'X-Bodrless-Webhook-ID': webhookId, 'X-Bodrless-Timestamp': timestamp,
    'User-Agent': 'Bodrless-Webhook/2.0',
  };

  if (agency.webhook_secret) {
    headers['X-Bodrless-Signature'] = `sha256=${
      crypto.createHmac('sha256', agency.webhook_secret).update(JSON.stringify(body)).digest('hex')
    }`;
  }

  await supabase.from('webhook_deliveries').insert({ id: webhookId, agency_id: agencyId, event, payload: body, status: 'pending', created_at: new Date().toISOString() });

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

app.use((req, res, next) => {
  if (CONFIG.env === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.status(301).redirect('https://' + req.headers.host + req.url);
  }
  next();
});

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (CONFIG.env !== 'production') return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    logger.warn('CORS rejected', { origin });
    callback(new Error('Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Sandbox', 'X-Request-ID', 'X-Bodrless-Timestamp', 'X-Bodrless-Signature'],
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(requestContext);

app.get('/health', async (req, res) => {
  const dbHealthy = await dbHealthCheck();
  res.status(dbHealthy ? 200 : 503).json({
    status:    dbHealthy ? 'healthy' : 'unhealthy',
    version:   CONFIG.apiVersion,
    llm:       CONFIG.defaultLlm.apiKey ? 'groq:configured' : 'not_configured',
    timestamp: new Date().toISOString(),
  });
});

const apiV1 = express.Router();
apiV1.use(auditLog);
apiV1.use(authenticate);

apiV1.get('/', (req, res) => {
  res.json({
    name: 'Bodrless API', version: CONFIG.apiVersion,
    description: 'Single endpoint. BYO LLM. BYO Inventory. Live Adapters. Saga bookings. Webhooks. Sandbox. Zero breaking changes.',
    what_you_get: [
      'Natural language parsing — any language, your LLM or ours (Groq / llama-3.3-70b-versatile)',
      'Trip orchestration: flights + hotels + buses + trains + transfers',
      'Live inventory adapters — plug in Booking.com, Expedia, any GDS via 4 endpoints',
      'Inventory control per-request: yours first, Bodrless fills gaps',
      'Async search — 202 + job_id, never times out under load',
      'Saga booking — partial failure auto-rollbacks, no partial charges',
      'Idempotency — retry on any network failure, no duplicate bookings',
      'Webhooks with HMAC signatures — search, booking, delay, price events',
      'Sandbox mode — full test environment, no real charges',
      'Everything we add in future — automatically included, zero breaking changes',
    ],
    endpoints: {
      'GET  /api/v1':                          'This docs page',
      'GET  /api/v1/capabilities':             'What is live on your plan',
      'POST /api/v1/search':                   'Async search (202)',
      'GET  /api/v1/search/:job_id':           'Poll search results',
      'POST /api/v1/book':                     'Book with saga + idempotency',
      'GET  /api/v1/book/status/:job_id':      'Poll booking status',
      'POST /api/v1/inventory/upload':         'Upload static inventory (202)',
      'GET  /api/v1/inventory/upload/:job_id': 'Poll upload status',
      'POST /api/v1/agency/adapters':          'Register live inventory adapter endpoints',
      'GET  /api/v1/agency/adapters':          'View current adapter configuration',
      'GET  /api/v1/bookings':                 'List your bookings',
      'POST /api/v1/notify/delay':             'Trigger flight delay notifications',
      'POST /api/v1/webhooks/configure':       'Configure webhook delivery',
    },
    authentication: 'x-api-key: your_key',
    signup:         CONFIG.agencyPortalUrl,
    sandbox:        'X-Sandbox: true — no real charges, no real holds',
    contact:        'hello@bodrless.com',
  });
});

apiV1.get('/capabilities', (req, res) => {
  const plan = req.context.agency.plan || 'free';
  res.json({
    api_version: CONFIG.apiVersion, plan,
    inventory: {
      flights:   { bodrless_supplier: 'TravelDuqa', bring_your_own: true,  live_adapter: true  },
      hotels:    { bodrless_supplier: 'HotelBeds',  bring_your_own: true,  live_adapter: true  },
      buses:     { bodrless_supplier: 'Travler',    bring_your_own: true,  live_adapter: true  },
      trains:    { bodrless_supplier: 'SGR',        bring_your_own: false, live_adapter: false },
      transfers: { bodrless_supplier: 'HolidayTaxis + flat-rate', bring_your_own: true, live_adapter: true },
    },
    booking_modes: {
      bodrless_fills: { description: 'You book flights/hotels; Bodrless confirms gap components only.', use_case: 'Wakanow, TravelStart', components: ['bus', 'train', 'transfer'] },
      bodrless_full:  { description: 'Bodrless runs full saga — hold, payment, confirm, notify.',        use_case: 'Agencies without a booking stack', components: ['flight', 'hotel', 'bus', 'train', 'transfer'] },
    },
    llm: {
      default:     'Groq / llama-3.3-70b-versatile',
      bring_your_own: true,
      providers:   ['openai', 'anthropic', 'gemini', 'groq', 'azure', 'custom'],
      note:        'Pass llm.endpoint + llm.api_key per search request. Your key is used in-flight only — never stored.',
    },
    features: {
      natural_language: true, languages: ['en', 'sw', 'fr', 'ar', 'any'],
      multi_destination: true, multi_leg_routing: true, accessibility: true,
      bring_your_own_llm: true, async_search: true, saga_bookings: true,
      idempotency: true, webhooks: true, sandbox_mode: true,
      inventory_control: true, gap_fill_only: true, live_inventory_adapters: true,
    },
    live_inventory_adapters: {
      description: '4 REST endpoints per component. Bodrless calls them during search and booking. auth_config encrypted at rest (AES-256-CBC).',
      components: ['flights', 'hotels', 'transfers', 'buses'],
      auth_types: ['bearer', 'hmac', 'api_key', 'none'],
      fallback:   'live adapter → static upload → Bodrless inventory → empty (never errors)',
    },
    rate_limits: CONFIG.rateLimits[plan],
    request_id:  req.context.requestId,
    generated_at: new Date().toISOString(),
  });
});

apiV1.post('/search', createRateLimiter('search'), validate(searchSchema), async (req, res, next) => {
  try {
    let searchPrompt = req.body.prompt;
    if (searchPrompt) searchPrompt = sanitizePrompt(searchPrompt);

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
      agencyId: req.context.agency.id,   // FIX: pass agencyId only — worker fetches fresh from DB
      options: {
        conversationHistory: req.body.conversation_history || [],
        previousParams:      req.body.previous_params || null,
        inventoryControl:    req.body.inventory || {},
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
      success: true, message: 'Search accepted', job_id: job.id, status: 'processing',
      poll_url: `/api/v1/search/${job.id}`, estimated_seconds: 5,
      api_version: CONFIG.apiVersion, request_id: req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.get('/search/:job_id', async (req, res, next) => {
  try {
    const job = await searchQueue.getJob(req.params.job_id);
    if (!job) { const err = new Error('Search job not found'); err.code = 'NOT_FOUND'; err.statusCode = 404; throw err; }
    const state  = await job.getState();
    const result = job.returnvalue;
    if (state === 'completed' && result) return res.json({ success: true, status: 'completed', ...result, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    if (state === 'failed')             return res.status(500).json({ success: false, status: 'failed', error: { message: 'Search processing failed', code: 'SEARCH_FAILED' }, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    res.json({ success: true, status: 'processing', job_id: req.params.job_id, progress: job.progress(), api_version: CONFIG.apiVersion, request_id: req.context.requestId });
  } catch (err) { next(err); }
});

apiV1.post('/book', createRateLimiter('book'), validate(bookSchema), async (req, res, next) => {
  try {
    const existing = await checkIdempotency(req.body.idempotency_key, req.context.agency.id);
    if (existing.exists) {
      return res.json({ success: true, booking_ref: existing.data.booking_ref, status: existing.data.status, message: 'Booking already processed (idempotent response)', idempotent: true, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    }

    const resolvedPkg = await resolvePackage(req.context.agency.id, req.body.package_id);
    const bookingMode = req.body.booking_mode || 'bodrless_fills';
    const components  = req.body.components   || {};

    const bookingData = {
      idempotencyKey: req.body.idempotency_key,
      packageId:      req.body.package_id,
      bookingMode, components,
      guest: { name: req.body.guest_name, email: req.body.guest_email, phone: req.body.guest_phone },
      passengers:      req.body.passengers,
      totalPrice:      resolvedPkg.summary?.totalPrice || 0,
      currency:        resolvedPkg.summary?.currency   || 'USD',
      nights:          resolvedPkg.summary?.nights     || null,
      transport:       resolvedPkg.transport,
      hotel:           resolvedPkg.hotel,
      transfer:        resolvedPkg.transfers,
      summary:         resolvedPkg.summary,
      specialRequests: req.body.special_requests || 'None',
      paymentToken:    req.body.payment_token    || null,
      sandbox:         req.context.sandbox,
    };

    if (bookingMode === 'bodrless_fills') {
      const bookingRef = `BDR-FILL-${nanoid(10).toUpperCase()}`;
      const confirmed  = [];
      if (components.bus      && resolvedPkg.transport?.transportType === 'bus')   confirmed.push('bus');
      if (components.train    && resolvedPkg.transport?.transportType === 'train') confirmed.push('train');
      if (components.transfer && resolvedPkg.transfers)                            confirmed.push('transfer');

      await supabase.from('bookings').insert({
        booking_ref: bookingRef, agency_id: req.context.agency.id,
        guest_name: req.body.guest_name, guest_email: req.body.guest_email, guest_phone: req.body.guest_phone,
        passengers: req.body.passengers, total_price: 0,
        destination: resolvedPkg.transport?.destination || null, origin: resolvedPkg.transport?.origin || null,
        nights: resolvedPkg.summary?.nights || null, channel: 'api',
        flight_details: null, hotel_details: null,
        transfer_details: components.transfer ? resolvedPkg.transfers : null,
        trip_params: resolvedPkg.summary, special_requests: req.body.special_requests || 'None',
        status: 'confirmed', currency: resolvedPkg.summary?.currency || 'USD',
        idempotency_key: req.body.idempotency_key, booking_mode: 'bodrless_fills',
        bodrless_components: confirmed, sandbox: req.context.sandbox,
      }).catch(err => logger.error('Gap booking record failed', { error: err.message }));

      await saveIdempotency(req.body.idempotency_key, req.context.agency.id, bookingRef, 'confirmed');

      if (confirmed.length > 0 && !req.context.sandbox) {
        await notificationQueue.add('booking.confirmed', {
          booking: { bookingRef, guestName: req.body.guest_name, guestPhone: req.body.guest_phone, passengers: req.body.passengers, agencyId: req.context.agency.id, totalPrice: 0, specialRequests: req.body.special_requests || 'None' },
          flight: null, hotel: null, transfer: components.transfer ? resolvedPkg.transfers : null,
        }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
      }

      getRequestLogger(req).info('Gap booking confirmed', { bookingRef, components: confirmed });

      return res.json({
        success: true, booking_ref: bookingRef, booking_mode: 'bodrless_fills', status: 'confirmed',
        bodrless_components: confirmed,
        message: confirmed.length > 0
          ? `Bodrless confirmed: ${confirmed.join(', ')}. Your flights and hotels are handled by your own system.`
          : 'No Bodrless components requested — booking recorded for tracking only.',
        api_version: CONFIG.apiVersion, request_id: req.context.requestId,
      });
    }

    const job = await bookingQueue.add('book', {
      bookingData,
      agencyId: req.context.agency.id,  // FIX: pass agencyId only — worker fetches fresh from DB
      requestId: req.context.requestId,
    }, { attempts: 1, timeout: 60000 });

    getRequestLogger(req).info('Full booking saga queued', { jobId: job.id });

    res.status(202).json({
      success: true, booking_mode: 'bodrless_full', message: 'Booking accepted for processing',
      job_id: job.id, status: 'processing', poll_url: `/api/v1/book/status/${job.id}`,
      idempotency_key: req.body.idempotency_key,
      api_version: CONFIG.apiVersion, request_id: req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.get('/book/status/:job_id', async (req, res, next) => {
  try {
    const job = await bookingQueue.getJob(req.params.job_id);
    if (!job) { const err = new Error('Booking job not found'); err.code = 'NOT_FOUND'; err.statusCode = 404; throw err; }
    const state  = await job.getState();
    const result = job.returnvalue;
    if (state === 'completed' && result) return res.json({ success: true, status: result.status, booking_ref: result.bookingRef, saga_id: result.sagaId, message: 'Booking confirmed. Hotel, transfer and agency notified.', api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    if (state === 'failed')             return res.status(500).json({ success: false, status: 'failed', error: { message: 'Booking failed. No charges were applied.', code: 'BOOKING_FAILED' }, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    res.json({ success: true, status: 'processing', job_id: req.params.job_id, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
  } catch (err) { next(err); }
});

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
      agencyId: req.context.agency.id, type, items: validItems, replaceAll: replace_all, requestId: req.context.requestId,
    }, { attempts: 3, timeout: 120000 });

    getRequestLogger(req).info('Inventory upload queued', { jobId: job.id, count: validItems.length });

    res.status(202).json({
      success: true, message: 'Inventory upload accepted', job_id: job.id, status: 'processing',
      items_received: items.length, items_valid: validItems.length, poll_url: `/api/v1/inventory/upload/${job.id}`,
      api_version: CONFIG.apiVersion, request_id: req.context.requestId,
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
    if (state === 'failed')             return res.status(500).json({ success: false, status: 'failed', error: { message: 'Upload failed', code: 'UPLOAD_FAILED' }, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
    res.json({ success: true, status: 'processing', job_id: req.params.job_id, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
  } catch (err) { next(err); }
});

apiV1.get('/bookings', async (req, res, next) => {
  try {
    // Validate query params to prevent malformed date strings reaching Supabase
    const { error: qError, value: qValue } = bookingsQuerySchema.validate(req.query, { stripUnknown: true });
    if (qError) {
      const err = new Error(qError.details.map(d => d.message).join('; '));
      err.code = 'VALIDATION_ERROR'; err.statusCode = 400; throw err;
    }

    const { status, from_date, to_date, limit, offset } = qValue;

    let query = supabase.from('bookings').select('*')
      .eq('agency_id', req.context.agency.id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status)    query = query.eq('status', status);
    if (from_date) query = query.gte('created_at', from_date);
    if (to_date)   query = query.lte('created_at', to_date);

    const { data, error } = await query;
    if (error) throw error;

    res.json({
      success: true, bookings: data || [], count: (data || []).length,
      pagination: { limit, offset },
      api_version: CONFIG.apiVersion, request_id: req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.post('/notify/delay', createRateLimiter('notify'), validate(delayNotifySchema), async (req, res, next) => {
  try {
    const { booking_ref, delay_minutes, new_arrival_time, reason } = req.body;
    const { data: booking, error } = await supabase.from('bookings').select('*').eq('booking_ref', booking_ref).eq('agency_id', req.context.agency.id).single();
    if (error || !booking) { const err = new Error('Booking not found'); err.code = 'NOT_FOUND'; err.statusCode = 404; throw err; }

    await notifyFlightDelay({
      booking: { bookingRef: booking.booking_ref, guestName: booking.guest_name, passengers: booking.passengers, agencyId: req.context.agency.id },
      flight: booking.flight_details || {}, hotel: booking.hotel_details || null, transfer: booking.transfer_details || null,
      delayMinutes: delay_minutes, newArrivalTime: new_arrival_time, reason: reason || 'Operational delay',
    });

    getRequestLogger(req).info('Delay notification triggered', { bookingRef: booking_ref, delayMinutes: delay_minutes });
    res.json({
      success: true, message: `Delay notifications queued for ${booking_ref}`,
      affected_parties: ['agency', booking.hotel_details ? 'hotel' : null, booking.transfer_details ? 'transfer' : null].filter(Boolean),
      api_version: CONFIG.apiVersion, request_id: req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.post('/webhooks/configure', validate(webhookConfigSchema), async (req, res, next) => {
  try {
    const { url, events, secret } = req.body;
    const { error } = await supabase.from('agencies').update({ webhook_url: url, webhook_events: events, webhook_secret: secret || null, updated_at: new Date().toISOString() }).eq('id', req.context.agency.id);
    if (error) throw error;
    await redis.del(`agency:key:${req.headers['x-api-key']?.substring(0, 16)}`);
    getRequestLogger(req).info('Webhook configured', { agencyId: req.context.agency.id, events });
    res.json({ success: true, message: 'Webhook configuration updated', webhook: { url, events, hmac_enabled: !!secret }, api_version: CONFIG.apiVersion, request_id: req.context.requestId });
  } catch (err) { next(err); }
});

apiV1.post('/agency/adapters', validate(agencyAdapterConfigSchema), async (req, res, next) => {
  try {
    const encryptedConfig = encryptAdapterConfig(req.body);

    const { error } = await supabase.from('agencies').update({
      inventory_adapters: encryptedConfig,
      updated_at:         new Date().toISOString(),
    }).eq('id', req.context.agency.id);

    if (error) throw error;

    await redis.del(`agency:key:${req.headers['x-api-key']?.substring(0, 16)}`);

    getRequestLogger(req).info('Agency adapters configured', {
      agencyId:   req.context.agency.id,
      components: Object.keys(req.body),
    });

    res.json({
      success:    true,
      message:    'Live inventory adapters configured. auth_config encrypted at rest.',
      components: Object.keys(req.body),
      note:       'Bodrless will call your endpoints during search and booking. Falls back to static uploads or Bodrless inventory if your endpoint is unavailable.',
      api_version: CONFIG.apiVersion,
      request_id:  req.context.requestId,
    });
  } catch (err) { next(err); }
});

apiV1.get('/agency/adapters', async (req, res, next) => {
  try {
    const adapters = req.context.agency.inventory_adapters || {};

    // Strip credentials before returning — never expose auth_config in API responses
    const safeAdapters = {};
    Object.entries(adapters).forEach(([component, adapter]) => {
      if (!adapter) return;
      safeAdapters[component] = {
        search_url:  adapter.search_url,
        hold_url:    adapter.hold_url,
        confirm_url: adapter.confirm_url,
        cancel_url:  adapter.cancel_url,
        auth_type:   adapter.auth_type,
        auth_config: adapter.auth_config ? '[configured — encrypted]' : null,
        timeout_ms:  adapter.timeout_ms,
        version:     adapter.version,
      };
    });

    res.json({
      success:    true,
      components: safeAdapters,
      status: Object.keys(adapters).map(c => ({
        component:  c,
        configured: !!adapters[c]?.search_url,
        version:    adapters[c]?.version   || 'v1',
        auth_type:  adapters[c]?.auth_type || 'bearer',
      })),
      api_version: CONFIG.apiVersion,
      request_id:  req.context.requestId,
    });
  } catch (err) { next(err); }
});

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
// WORKERS
// FIX: Workers now fetch the agency fresh from DB using agencyId.
// This avoids the encrypt/decrypt mismatch that occurred when the full
// agency object (already decrypted in memory) was serialised into Bull
// and then decrypted again in the worker — silently corrupting adapter config.
// ═══════════════════════════════════════════════════════════════════════════

async function fetchAgencyForWorker(agencyId) {
  const { data: agency, error } = await supabase
    .from('agencies')
    .select('id, name, plan, status, webhook_url, llm_config, inventory_config, rate_limits, allowed_ips, signing_secret, created_at, inventory_adapters')
    .eq('id', agencyId)
    .single();

  if (error || !agency) throw new Error(`Worker could not load agency ${agencyId}: ${error?.message}`);

  // Parse JSON fields stored as strings
  ['llm_config', 'inventory_config', 'rate_limits', 'allowed_ips', 'inventory_adapters'].forEach(field => {
    if (agency[field] && typeof agency[field] === 'string') {
      try { agency[field] = JSON.parse(agency[field]); } catch { agency[field] = null; }
    }
  });

  // Decrypt adapter config fresh from DB — always encrypted at rest
  if (agency.inventory_adapters) {
    agency.inventory_adapters = decryptAdapterConfig(agency.inventory_adapters);
  }

  return agency;
}

if (process.argv.includes('--worker')) {

  searchQueue.process(async (job) => {
    const { agencyId, options, requestId } = job.data;
    logger.info('Processing search', { jobId: job.id, agencyId });

    // FIX: fetch agency fresh from DB — credentials decrypted cleanly here
    const agency = await fetchAgencyForWorker(agencyId);

    const result = await orchestrate(job.data.searchPrompt, agency, {
      conversationHistory: options.conversationHistory,
      previousParams:      options.previousParams,
      inventoryControl:    options.inventoryControl || {},
      llmOverride:         options.llmOverride || null,
      maxResults:          options.maxResults,
      currency:            options.currency,
    });

    await supabase.from('trip_searches').insert({
      agency_id: agencyId, session_id: options.sessionId || result.sessionId,
      prompt: job.data.searchPrompt, destination: result.tripParams?.destination || null,
      origin: result.tripParams?.origin || null, passengers: result.tripParams?.passengers || 1,
      budget: result.tripParams?.budget || null, nights: result.tripParams?.nights || null,
      packages_returned: result.packages?.length || 0, channel: 'api', converted: false,
      job_id: job.id, created_at: new Date().toISOString(),
    }).catch(() => {});

    if (agency.webhook_url) {
      await webhookQueue.add('webhook', {
        agencyId, event: 'search.completed',
        payload: { job_id: job.id, session_id: result.sessionId, package_count: result.packages?.length || 0, trip_params: result.tripParams, sources: result.sources },
      });
    }

    return result;
  });

  inventoryQueue.process(async (job) => {
    logger.info('Processing inventory upload', { jobId: job.id, agencyId: job.data.agencyId });
    return await processInventoryUpload(job);
  });

  bookingQueue.process(async (job) => {
    const { bookingData, agencyId } = job.data;
    logger.info('Processing booking saga', { jobId: job.id, agencyId });

    // FIX: fetch agency fresh from DB — credentials decrypted cleanly here
    const agency = await fetchAgencyForWorker(agencyId);

    const result = await executeBookingSaga(bookingData, agency, { sandbox: bookingData.sandbox });

    if (result.success) {
      await notifyBookingConfirmed({
        booking: {
          bookingRef: result.bookingRef, guestName: bookingData.guest.name, guestPhone: bookingData.guest.phone,
          passengers: bookingData.passengers, agencyId, totalPrice: bookingData.totalPrice,
          checkIn: bookingData.summary?.departureDate, specialRequests: bookingData.specialRequests,
        },
        flight:   bookingData.transport?.airline ? bookingData.transport : null,
        hotel:    bookingData.hotel?.name        ? bookingData.hotel     : null,
        transfer: bookingData.transfer?.provider ? bookingData.transfer  : null,
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

  logger.info('Bodrless workers running...');

} else {

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received — shutting down gracefully');
    process.exit(0);
  });

  app.listen(CONFIG.port, () => {
    logger.info(`Bodrless API v${CONFIG.apiVersion} running on port ${CONFIG.port}`);
  });
}

module.exports = app;