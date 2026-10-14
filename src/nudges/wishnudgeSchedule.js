/**
 * WISH NUDGE SCHEDULER
 * ─────────────────────────────────────────────────────────────
 * Runs every 6 hours via a Render cron job.
 * Cron URL: GET /api/internal/nudge-run
 * Secured with the INTERNAL_CRON_SECRET header.
 *
 * For each open wish it:
 *   1. Refreshes packages if the cache is stale (> 6h)
 *   2. Builds a readiness-aware nudge message
 *   3. EMAIL: if the visitor opted in and the wish has a price drop or is
 *      14 days or less away, sends one email (quota-guarded, see emailService)
 *   4. WHATSAPP: sends if a phone is linked and WHATSAPP_ENABLED=true
 *   5. WIDGET: otherwise writes pending_nudge, shown when the visitor
 *      next opens the widget (also written after an email, so the widget
 *      tells the same story)
 *   6. Records the nudge so it doesn't fire again too soon
 *
 * Add to app.js:
 *   const nudgeRouter = require('./routes/nudgeScheduler');
 *   app.use('/api/internal', nudgeRouter);
 *
 * Render cron job:
 *   Command:  curl -s -o /dev/null -H "x-cron-secret: $INTERNAL_CRON_SECRET" \
 *             https://bodrless-api-v2.onrender.com/api/internal/nudge-run
 *   Schedule: 0 STAR/6 * * *   (every 6 hours; write STAR as an asterisk)
 * ─────────────────────────────────────────────────────────────
 */

const express         = require('express');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const tripWishService = require('../services/tripWishService');
const emailService    = require('../services/emailService');

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────
router.use((req, res, next) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.INTERNAL_CRON_SECRET || secret !== process.env.INTERNAL_CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// ── Main run endpoint ─────────────────────────────────────────
router.get('/nudge-run', async (req, res) => {
  const startedAt = Date.now();
  const results   = {
    processed: 0, emailed: 0, emailCapped: 0, emailFailed: 0,
    nudgedWhatsapp: 0, nudgedWidget: 0, refreshed: 0, skipped: 0, errors: 0,
  };

  try {
    const { data: wishes, error } = await supabase
      .from('trip_wishes')
      .select('*')
      .in('status', ['watching', 'nudged'])
      .or('departure_date.is.null,departure_date.gte.' + new Date().toISOString().split('T')[0])
      .order('last_nudged_at', { ascending: true, nullsFirst: true })
      .limit(200);  // max 200 per run to stay inside Render timeouts

    if (error) {
      logger.error('NudgeScheduler: failed to load wishes', { error: error.message });
      return res.status(500).json({ error: error.message });
    }

    if (!wishes || !wishes.length) {
      logger.info('NudgeScheduler: no wishes to process');
      return res.json({ ...results, durationMs: Date.now() - startedAt });
    }

    logger.info('NudgeScheduler: processing wishes', { count: wishes.length });

    // Load every visitor's consent state once, not once per wish
    const visitors = new Map();
    const visitorIds = [...new Set(wishes.map(w => w.visitor_id).filter(Boolean))];
    if (visitorIds.length) {
      const { data: vrows, error: verr } = await supabase
        .from('widget_visitors')
        .select('visitor_id,name,email,email_opt_in,email_unsubscribed_at,last_emailed_at,unsubscribe_token')
        .in('visitor_id', visitorIds);
      if (verr) logger.warn('NudgeScheduler: could not load visitors', { error: verr.message });
      (vrows || []).forEach(v => visitors.set(v.visitor_id, v));
    }
    let emailCapReached = false;

    for (const wish of wishes) {
      try {
        results.processed++;

        // ── Refresh stale cache before nudging ────────────────
        const cacheAge = wish.cached_at
          ? (Date.now() - new Date(wish.cached_at).getTime()) / 3600000
          : Infinity;

        if (cacheAge > 6 || !wish.cache_valid) {
          tripWishService._backgroundSearch(wish.id, {
            destination:   wish.destination,
            origin:        wish.origin,
            departureDate: wish.departure_date,
            passengers:    wish.passengers,
            agencyId:      wish.agency_id,
          }).catch(() => {});
          results.refreshed++;

          if (!wish.cache_valid || !wish.packages_cached) {
            results.skipped++;
            continue;
          }
        }

        const visitor = wish.visitor_id ? visitors.get(wish.visitor_id) : null;

        // ── Traveller first name ──────────────────────────────
        let travelerName = visitor && visitor.name ? String(visitor.name).split(' ')[0] : null;
        if (!travelerName && wish.phone) {
          try {
            const { data: traveler } = await supabase
              .from('travelers')
              .select('full_name')
              .eq('phone', wish.phone)
              .maybeSingle();
            if (traveler?.full_name) travelerName = traveler.full_name.split(' ')[0];
          } catch (_) {}
        }

        // ── Build nudge ───────────────────────────────────────
        const channel = wish.phone ? wish.channel || 'whatsapp' : 'widget';
        const nudge   = tripWishService.buildNudge(wish, channel, travelerName);

        if (!nudge) {
          results.skipped++;
          continue;
        }

        // ── EMAIL (opted-in visitors, high-signal events only) ─
        if (visitor && !emailCapReached && emailService.canEmail(visitor) && emailService.composeMessage(wish)) {
          const r = await emailService.sendNudge({ visitor, wish });
          if (r.sent) {
            results.emailed++;
            visitor.last_emailed_at = new Date().toISOString();   // one email per visitor per run
          } else if (r.reason === 'daily_cap') {
            emailCapReached = true;
            results.emailCapped++;
            logger.warn('NudgeScheduler: daily email cap reached, remaining nudges stay in-widget');
          } else if (r.reason === 'send_failed') {
            results.emailFailed++;
          }
        }

        // ── WhatsApp or widget ────────────────────────────────
        if (wish.phone && process.env.WHATSAPP_ENABLED === 'true') {
          await _sendWhatsApp(wish.phone, nudge);
          results.nudgedWhatsapp++;
          logger.info('NudgeScheduler: WhatsApp nudge sent', {
            wishId: wish.id, destination: wish.destination, readiness: wish.readiness,
            phone: wish.phone.slice(0, 7) + '****',
          });
        } else {
          await tripWishService.writePendingNudge(wish.id, nudge);
          results.nudgedWidget++;
          logger.info('NudgeScheduler: pending widget nudge written', {
            wishId: wish.id, destination: wish.destination, readiness: wish.readiness,
          });
        }

        await tripWishService.recordNudgeSent(wish.id);
        await new Promise(r => setTimeout(r, 300));

      } catch (err) {
        results.errors++;
        logger.error('NudgeScheduler: error processing wish', { wishId: wish.id, error: err.message });
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.info('NudgeScheduler: run complete', { ...results, durationMs });
    res.json({ ...results, durationMs });

  } catch (err) {
    logger.error('NudgeScheduler: run threw', { error: err.message });
    res.status(500).json({ error: err.message, ...results });
  }
});

// ── Expire stale wishes ──────────────────────────────────────
// Run separately: GET /api/internal/wish-cleanup
router.get('/wish-cleanup', async (req, res) => {
  try {
    // expire wishes whose departure date has passed by more than 7 days
    const { error: e1 } = await supabase
      .from('trip_wishes')
      .update({ status: 'expired', cache_valid: false, updated_at: new Date().toISOString() })
      .in('status', ['watching', 'nudged'])
      .not('departure_date', 'is', null)
      .lt('departure_date', new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]);

    // expire dreaming wishes with no activity for 180 days
    const { error: e2 } = await supabase
      .from('trip_wishes')
      .update({ status: 'expired', cache_valid: false, updated_at: new Date().toISOString() })
      .eq('readiness', 'dreaming')
      .eq('status', 'watching')
      .lt('updated_at', new Date(Date.now() - 180 * 86400000).toISOString());

    // expire planning/ready wishes with no activity for 90 days
    const { error: e3 } = await supabase
      .from('trip_wishes')
      .update({ status: 'expired', cache_valid: false, updated_at: new Date().toISOString() })
      .in('readiness', ['planning', 'ready'])
      .in('status', ['watching', 'nudged'])
      .lt('updated_at', new Date(Date.now() - 90 * 86400000).toISOString());

    if (e1 || e2 || e3) {
      logger.warn('NudgeScheduler: cleanup partial errors', {
        e1: e1?.message, e2: e2?.message, e3: e3?.message,
      });
    }

    logger.info('NudgeScheduler: cleanup complete');
    res.json({ ok: true });
  } catch (err) {
    logger.error('NudgeScheduler: cleanup threw', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── WhatsApp send helper ─────────────────────────────────────
// Uses the real service: services/whatsapp exports an instance with
// sendText(phoneNumberId, to, text). Only runs when WHATSAPP_ENABLED=true.
async function _sendWhatsApp(phone, message) {
  try {
    const whatsappService = require('../services/whatsapp');
    const phoneNumberId   = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID not set');
    await whatsappService.sendText(phoneNumberId, phone, message);
  } catch (err) {
    logger.error('NudgeScheduler: WhatsApp send failed', { error: err.message });
    throw err;
  }
}

module.exports = router;