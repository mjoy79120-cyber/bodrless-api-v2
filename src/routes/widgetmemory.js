/**
 * WIDGET MEMORY ROUTES  (mount at /api/widget)
 * ─────────────────────────────────────────────────────────────
 * Server side of the widget's long-term memory:
 *
 *   GET  /wishes                  open trip wishes for this visitor, incl. any
 *                                 pending_nudge written by the scheduler, plus
 *                                 whether email alerts are already on
 *   GET  /wishes/:id/packages     cached packages for one wish
 *   POST /wishes/:id/nudge-seen   widget has shown the pending nudge
 *   POST /optin                   { email, name? } turn on email alerts
 *   POST /optout                  turn email alerts off
 *   GET  /unsubscribe?token=      confirmation page (public, from emails)
 *   POST /unsubscribe?token=      performs the unsubscribe (also RFC 8058 one-click)
 *   GET  /otp/status              WhatsApp linking is paused: always unverified
 *
 * Identity: the widget sends x-visitor-token (random id kept in the visitor's
 * browser) and x-api-key / x-hotel-key (agency key). The visitor token is the
 * only credential, so every query is scoped to it.
 *
 * Unsubscribe is GET-shows-a-button / POST-does-it so email link scanners
 * that prefetch links can't unsubscribe people by accident.
 *
 * Mount in app.js:  app.use('/api/widget', require('./routes/widgetMemory'));
 * ─────────────────────────────────────────────────────────────
 */

const express         = require('express');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const tripWishService = require('../services/tripWishService');

const router = express.Router();
router.use(express.json({ limit: '20kb' }));

const VISITOR_RE = /^v_[a-z0-9_]{6,64}$/i;
const AGENCY_RE  = /^[a-z0-9_-]{1,40}$/i;
const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE   = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const NAME_RE    = /^[\p{L}\s'-]{1,30}$/u;
const HOUR       = 3600000;

// ── tiny in-memory rate limiter (per process) ─────────────────
const _hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  if (_hits.size > 5000) {
    for (const [k, v] of _hits) if (now - v.start > v.windowMs) _hits.delete(k);
  }
  let h = _hits.get(key);
  if (!h || now - h.start > windowMs) { h = { start: now, n: 0, windowMs }; _hits.set(key, h); }
  h.n++;
  return h.n > max;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'unknown';
}

function maskEmail(e) {
  const [u, d] = String(e).split('@');
  return (u.slice(0, 1) + '***@' + (d || ''));
}

function page(title, bodyHtml) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>' + title + '</title></head>' +
    '<body style="font-family:Arial,Helvetica,sans-serif;background:#f6f4ef;color:#1b2240;margin:0">' +
    '<div style="max-width:420px;margin:64px auto;background:#fff;border:1px solid #e7e2d9;border-radius:14px;padding:28px;text-align:center">' +
    '<h2 style="margin:0 0 14px;font-size:20px">' + title + '</h2>' + bodyHtml +
    '<p style="font-size:11px;color:#8b857c;margin:22px 0 0">Powered by Bodrless</p></div></body></html>';
}

// ─────────────────────────────────────────────
// UNSUBSCRIBE (public: no visitor headers, token comes from the email link)
// ─────────────────────────────────────────────
router.get('/unsubscribe', (req, res) => {
  const token = String(req.query.token || '');
  res.set('Cache-Control', 'no-store').type('html');
  if (!UUID_RE.test(token)) {
    return res.status(400).send(page('Link not valid', '<p>This unsubscribe link is not valid.</p>'));
  }
  // no action attribute: the form posts back to this same URL, token included
  res.send(page('Stop trip alerts?',
    '<p style="font-size:14px;color:#5a5a5a">You will no longer get price-drop or trip emails from us.</p>' +
    '<form method="POST"><button type="submit" style="background:#1b2240;color:#fff;border:none;padding:12px 24px;border-radius:22px;font-size:14px;font-weight:600;cursor:pointer">Unsubscribe</button></form>'));
});

router.post('/unsubscribe', async (req, res) => {
  const token = String(req.query.token || '');
  res.set('Cache-Control', 'no-store').type('html');
  if (!UUID_RE.test(token)) {
    return res.status(400).send(page('Link not valid', '<p>This unsubscribe link is not valid.</p>'));
  }
  try {
    const { data, error } = await supabase
      .from('widget_visitors')
      .update({ email_opt_in: false, email_unsubscribed_at: new Date().toISOString() })
      .eq('unsubscribe_token', token)
      .select('visitor_id');
    if (error) throw new Error(error.message);
    if (!data || !data.length) {
      return res.status(404).send(page('Link not valid', '<p>We could not find that subscription.</p>'));
    }
    return res.send(page('You are unsubscribed', '<p style="font-size:14px;color:#5a5a5a">You will not get any more trip alert emails.</p>'));
  } catch (err) {
    logger.error('WidgetMemory: unsubscribe failed', { error: err.message });
    return res.status(500).send(page('Something went wrong', '<p>Please try again in a moment.</p>'));
  }
});

// ─────────────────────────────────────────────
// Visitor + agency context for everything below
// ─────────────────────────────────────────────
router.use((req, res, next) => {
  const visitorId = String(req.headers['x-visitor-token'] || '');
  const agencyId  = String(req.headers['x-api-key'] || req.headers['x-hotel-key'] || '');
  if (!VISITOR_RE.test(visitorId) || !AGENCY_RE.test(agencyId)) {
    return res.status(400).json({ error: 'bad_request' });
  }
  req.visitorId = visitorId;
  req.agencyId  = agencyId;
  next();
});

// ─────────────────────────────────────────────
// WISHES
// ─────────────────────────────────────────────
router.get('/wishes', async (req, res) => {
  try {
    const wishes = await tripWishService.loadWishes({ visitorId: req.visitorId, limit: 10 });

    let email = null;
    const { data: v } = await supabase
      .from('widget_visitors')
      .select('email,email_opt_in,email_unsubscribed_at')
      .eq('visitor_id', req.visitorId)
      .maybeSingle();
    if (v && v.email && v.email_opt_in && !v.email_unsubscribed_at) email = maskEmail(v.email);

    res.json({ wishes, alerts: { email } });
  } catch (err) {
    logger.error('WidgetMemory: /wishes failed', { error: err.message });
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/wishes/:id/packages', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    const w = await tripWishService.getWishPackages(req.params.id, { visitorId: req.visitorId });
    if (!w) return res.status(404).json({ error: 'not_found' });
    res.json({
      id:              w.id,
      destination:     w.destination,
      departure_month: w.departure_month,
      departure_date:  w.departure_date,
      packages_cached: w.packages_cached || [],
      cached_at:       w.cached_at,
      best_price_kes:  w.best_price_kes,
    });
  } catch (err) {
    logger.error('WidgetMemory: wish packages failed', { error: err.message });
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/wishes/:id/nudge-seen', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    await supabase
      .from('trip_wishes')
      .update({ pending_nudge: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('visitor_id', req.visitorId);
    res.json({ ok: true });
  } catch (err) {
    logger.error('WidgetMemory: nudge-seen failed', { error: err.message });
    res.status(500).json({ error: 'server_error' });
  }
});

// ─────────────────────────────────────────────
// EMAIL ALERTS OPT-IN / OPT-OUT
// ─────────────────────────────────────────────
router.post('/optin', async (req, res) => {
  try {
    const body  = req.body || {};
    const email = String(body.email || '').trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ ok: false, error: 'invalid_email' });
    }
    if (limited('optin:' + req.visitorId, 5, HOUR) || limited('optin-ip:' + clientIp(req), 30, HOUR)) {
      return res.status(429).json({ ok: false, error: 'too_many_requests' });
    }

    const now = new Date().toISOString();
    const row = {
      visitor_id:            req.visitorId,
      agency_id:             req.agencyId,
      email,
      email_opt_in:          true,
      email_opted_in_at:     now,
      email_unsubscribed_at: null,
      last_seen_at:          now,
    };
    const name = String(body.name || '').trim();
    if (name && NAME_RE.test(name)) row.name = name;

    const { error } = await supabase.from('widget_visitors').upsert(row, { onConflict: 'visitor_id' });
    if (error) throw new Error(error.message);

    logger.info('WidgetMemory: email alerts on', { visitorId: req.visitorId, agencyId: req.agencyId });
    res.json({ ok: true, email: maskEmail(email) });
  } catch (err) {
    logger.error('WidgetMemory: optin failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

router.post('/optout', async (req, res) => {
  try {
    await supabase
      .from('widget_visitors')
      .update({ email_opt_in: false, email_unsubscribed_at: new Date().toISOString() })
      .eq('visitor_id', req.visitorId);
    res.json({ ok: true });
  } catch (err) {
    logger.error('WidgetMemory: optout failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// WhatsApp number linking (OTP) is paused while the WhatsApp accounts are
// disabled. The widget still calls this in a couple of places.
router.get('/otp/status', (req, res) => res.json({ verified: false, disabled: true }));

module.exports = router;