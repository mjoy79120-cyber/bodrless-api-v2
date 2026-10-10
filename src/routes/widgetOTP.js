/**
 * WIDGET OTP — phone verification routes
 * Mount alongside widgetMemory: app.use('/api/widget', require('./widgetOtp'));
 *
 * Flow:
 *   POST /api/widget/otp/send    → generates code, sends WhatsApp message
 *   POST /api/widget/otp/verify  → checks code, marks visitor verified, links traveler
 *
 * Requires x-visitor-token header (same as widgetMemory routes).
 * The WhatsApp send is gated behind WHATSAPP_ENABLED env var so it
 * builds and tests fine while the Meta account is being reinstated.
 */

const express         = require('express');
const crypto          = require('crypto');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const travelerIntel   = require('../services/travelerIntelligence');
const tripWishService = require('../services/tripWishService');

const router = express.Router();
router.use(express.json());

const TOKEN_RE  = /^[a-f0-9]{48}$/;
const PHONE_RE  = /^\+?[1-9]\d{7,14}$/;
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');

const h = fn => (req, res) =>
  fn(req, res).catch(e => {
    logger.error('[widgetOtp]', e.message);
    res.status(500).json({ error: 'server error' });
  });

async function findVisitor(req) {
  const token = String(req.headers['x-visitor-token'] || '');
  if (!TOKEN_RE.test(token)) return null;
  const { data } = await supabase
    .from('widget_visitors')
    .select('*')
    .eq('agency_id', String(req.headers['x-api-key'] || '').slice(0, 80))
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  return data || null;
}

function normalisePhone(raw) {
  // Accept 07xxxxxxxx or +2547xxxxxxxx or 2547xxxxxxxx
  let p = String(raw || '').replace(/[\s\-()]/g, '');
  if (/^07\d{8}$/.test(p))  p = '+254' + p.slice(1);
  if (/^2547\d{8}$/.test(p)) p = '+' + p;
  return PHONE_RE.test(p) ? p : null;
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Send OTP ──────────────────────────────────────────────────
router.post('/otp/send', h(async (req, res) => {
  const visitor = await findVisitor(req);
  if (!visitor) return res.status(400).json({ error: 'invalid token' });

  if (visitor.verified_phone) {
    return res.json({ ok: true, alreadyVerified: true, phone: visitor.verified_phone });
  }

  const phone = normalisePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'invalid phone number' });

  // rate limit: max 3 OTPs per visitor per 10 minutes
  const { count } = await supabase
    .from('widget_phone_otps')
    .select('id', { count: 'exact', head: true })
    .eq('visitor_id', visitor.id)
    .eq('verified', false)
    .gt('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString());

  if (count >= 3) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 10 minutes.' });
  }

  const code = generateCode();

  await supabase.from('widget_phone_otps').insert({
    visitor_id: visitor.id,
    phone,
    code,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  // Send via WhatsApp — gated behind env var while Meta account is being reinstated
  if (process.env.WHATSAPP_ENABLED === 'true') {
    try {
      // Use your existing WhatsApp send utility — adjust the import path if needed
      const { sendWhatsAppMessage } = require('../services/whatsappService');
      await sendWhatsAppMessage(
        phone,
        `Your ${visitor.agency_id} verification code is *${code}*. It expires in 10 minutes. Never share this code with anyone.`
      );
      logger.info('[widgetOtp] OTP sent', { phone: phone.slice(0, 7) + '****' });
    } catch (err) {
      logger.warn('[widgetOtp] WhatsApp send failed — returning code in dev mode', { error: err.message });
      // In dev/staging, return the code so you can test without WhatsApp
      if (process.env.NODE_ENV !== 'production') {
        return res.json({ ok: true, _devCode: code });
      }
      return res.status(503).json({ error: 'Could not send verification message. Please try again.' });
    }
  } else {
    // WhatsApp not enabled yet — return code for testing
    logger.warn('[widgetOtp] WHATSAPP_ENABLED not set — returning code for testing');
    return res.json({ ok: true, _devCode: code, note: 'WhatsApp not enabled — use this code for testing' });
  }

  res.json({ ok: true });
}));

// ── Verify OTP ────────────────────────────────────────────────
router.post('/otp/verify', h(async (req, res) => {
  const visitor = await findVisitor(req);
  if (!visitor) return res.status(400).json({ error: 'invalid token' });

  if (visitor.verified_phone) {
    return res.json({ ok: true, alreadyVerified: true });
  }

  const phone = normalisePhone(req.body.phone);
  const code  = String(req.body.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'invalid phone or code' });
  }

  // find latest unverified OTP for this visitor + phone
  const { data: otp } = await supabase
    .from('widget_phone_otps')
    .select('*')
    .eq('visitor_id', visitor.id)
    .eq('phone', phone)
    .eq('verified', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otp) {
    return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
  }

  // increment attempts
  await supabase.from('widget_phone_otps')
    .update({ attempts: otp.attempts + 1 })
    .eq('id', otp.id);

  if (otp.attempts >= 5) {
    return res.status(400).json({ error: 'Too many wrong attempts. Request a new code.' });
  }

  if (otp.code !== code) {
    return res.status(400).json({ error: 'Wrong code. Please try again.' });
  }

  // mark verified
  await supabase.from('widget_phone_otps').update({ verified: true }).eq('id', otp.id);

  // link phone to visitor
  await supabase.from('widget_visitors').update({
    verified_phone: phone,
    updated_at:     new Date().toISOString(),
  }).eq('id', visitor.id);

  // ensure traveler row exists and link visitor name if we have it
  const traveler = await travelerIntel.getOrCreateTraveler(phone);
  if (traveler && visitor.first_name) {
    await travelerIntel.savePreference(phone, 'full_name', visitor.first_name);
  }

  // link phone to any open wishes this visitor has
  await tripWishService.linkPhoneToWishes(visitor.id, phone);

  logger.info('[widgetOtp] phone verified and linked', {
    visitorId: visitor.id,
    phone:     phone.slice(0, 7) + '****',
  });

  res.json({ ok: true, verified: true });
}));

// ── Check verification status ─────────────────────────────────
router.get('/otp/status', h(async (req, res) => {
  const visitor = await findVisitor(req);
  if (!visitor) return res.status(400).json({ error: 'invalid token' });
  res.json({ verified: !!visitor.verified_phone });
}));

module.exports = router;