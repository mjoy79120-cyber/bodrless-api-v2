/**
 * WISH NUDGE SCHEDULER
 * ─────────────────────────────────────────────────────────────
 * Runs every 6 hours via Render cron job.
 * Cron URL: GET /api/internal/nudge-run
 * Secured with INTERNAL_CRON_SECRET header.
 *
 * For each open wish it:
 *   1. Refreshes packages if cache is stale (> 6h)
 *   2. Builds a readiness-aware nudge message
 *   3. Sends via WhatsApp if phone is verified
 *   4. Writes pending_nudge to the row if widget only
 *   5. Records nudge sent so it doesn't fire again too soon
 *
 * Add to app.js / index.js:
 *   const nudgeRouter = require('./routes/nudgeScheduler');
 *   app.use('/api/internal', nudgeRouter);
 *
 * Add to Render cron jobs:
 *   Command:  curl -s -o /dev/null -H "x-cron-secret: $INTERNAL_CRON_SECRET"
 *             https://bodrless-api-v2.onrender.com/api/internal/nudge-run
 *   Schedule: 0 * /6 * * *   (every 6 hours)
 * ─────────────────────────────────────────────────────────────
 */

const express         = require('express');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');
const tripWishService = require('../services/tripWishService');

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
  const results   = { processed: 0, nudgedWhatsapp: 0, nudgedWidget: 0, refreshed: 0, skipped: 0, errors: 0 };

  try {
    // Load all open wishes not yet expired or booked
    // Filter by departure_date > today OR no date set (open-ended wishes)
    const { data: wishes, error } = await supabase
      .from('trip_wishes')
      .select('*')
      .in('status', ['watching', 'nudged'])
      .or('departure_date.is.null,departure_date.gte.' + new Date().toISOString().split('T')[0])
      .order('last_nudged_at', { ascending: true, nullsFirst: true })
      .limit(200);  // process max 200 per run to stay within Render free-tier timeouts

    if (error) {
      logger.error('NudgeScheduler: failed to load wishes', { error: error.message });
      return res.status(500).json({ error: error.message });
    }

    if (!wishes || !wishes.length) {
      logger.info('NudgeScheduler: no wishes to process');
      return res.json({ ...results, durationMs: Date.now() - startedAt });
    }

    logger.info('NudgeScheduler: processing wishes', { count: wishes.length });

    for (const wish of wishes) {
      try {
        results.processed++;

        // ── Refresh stale cache before nudging ────────────────
        const cacheAge = wish.cached_at
          ? (Date.now() - new Date(wish.cached_at).getTime()) / 3600000
          : Infinity;

        if (cacheAge > 6 || !wish.cache_valid) {
          // fire background search, don't await — next run will have fresh data
          tripWishService._backgroundSearch(wish.id, {
            destination:   wish.destination,
            origin:        wish.origin,
            departureDate: wish.departure_date,
            passengers:    wish.passengers,
            agencyId:      wish.agency_id,
          }).catch(() => {});
          results.refreshed++;

          // if no cached packages yet, skip nudge this round
          if (!wish.cache_valid || !wish.packages_cached) {
            results.skipped++;
            continue;
          }
        }

        // ── Load traveller name if available ──────────────────
        let travelerName = null;
        if (wish.phone) {
          try {
            const { data: traveler } = await supabase
              .from('travelers')
              .select('full_name')
              .eq('phone', wish.phone)
              .maybeSingle();
            if (traveler?.full_name) {
              travelerName = traveler.full_name.split(' ')[0]; // first name only
            }
          } catch (_) {}
        }

        // ── Build nudge ───────────────────────────────────────
        const channel = wish.phone ? wish.channel || 'whatsapp' : 'widget';
        const nudge   = tripWishService.buildNudge(wish, channel, travelerName);

        if (!nudge) {
          results.skipped++;
          continue;
        }

        // ── Send ──────────────────────────────────────────────
        if (wish.phone && process.env.WHATSAPP_ENABLED === 'true') {
          await _sendWhatsApp(wish.phone, nudge);
          results.nudgedWhatsapp++;
          logger.info('NudgeScheduler: WhatsApp nudge sent', {
            wishId:      wish.id,
            destination: wish.destination,
            readiness:   wish.readiness,
            phone:       wish.phone.slice(0, 7) + '****',
          });
        } else {
          // No verified phone or WhatsApp not enabled → write to pending_nudge
          // Widget will show it on next open
          await tripWishService.writePendingNudge(wish.id, nudge);
          results.nudgedWidget++;
          logger.info('NudgeScheduler: pending widget nudge written', {
            wishId:      wish.id,
            destination: wish.destination,
            readiness:   wish.readiness,
          });
        }

        await tripWishService.recordNudgeSent(wish.id);

        // Small delay between sends to avoid hammering the WhatsApp API
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

// ── Also expire stale wishes ─────────────────────────────────
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
async function _sendWhatsApp(phone, message) {
  // Reuse your existing WhatsApp send utility.
  // Adjust the import path to match your project structure.
  try {
    const { sendWhatsAppMessage } = require('../services/whatsappService');
    await sendWhatsAppMessage(phone, message);
  } catch (err) {
    logger.error('NudgeScheduler: WhatsApp send failed', { error: err.message });
    throw err;
  }
}

module.exports = router;