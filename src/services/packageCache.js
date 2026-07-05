/**
 * PACKAGE CACHE
 * ─────────────────────────────────────────────────────────────
 * Durable, per-phone cache of the most recently shown trip packages
 * — what "reply with the option number" refers to.
 *
 * BUG FIX (found via a real "conversation memory" review,
 * 2026-07-05): previously lived ONLY as an in-memory Map
 * (recentPackagesByPhone) inside webhooks.js — completely wiped on
 * every Render restart/redeploy. A traveler who paused mid-
 * conversation (e.g. to show a friend the options, exactly the real
 * use case this was built for) and came back after any restart
 * would reply "2" to a list that no longer existed anywhere, and
 * the message would silently fall through into normal orchestration,
 * which would try to parse "2" as a brand-new trip search. Moved
 * into Supabase so this survives restarts exactly like
 * whatsapp_contacts.previous_params and whatsapp_booking_sessions
 * already do.
 *
 * STALE vs EXPIRED: a cache more than an hour old is still used, but
 * flagged `isStale` so the caller can say "just double-checking
 * availability" before proceeding — real prices/availability CAN
 * have moved on, and this is the same honest posture as an agent
 * re-confirming before booking. A cache older than 24 hours is
 * treated as if it doesn't exist at all — dates/context are too
 * likely to be stale to trust silently.
 *
 * REQUIRES A MIGRATION — this table does not exist yet:
 *   create table whatsapp_package_cache (
 *     phone text primary key,
 *     packages jsonb not null,
 *     trip_params jsonb,
 *     cached_at timestamptz not null default now()
 *   );
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

const STALE_AFTER_MS   = 60 * 60 * 1000;      // 1 hour — still usable, worth a "double-checking" note
const EXPIRED_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours — too old to trust at all

class PackageCache {
  async save(phone, packages, tripParams = null) {
    try {
      const { error } = await supabase
        .from('whatsapp_package_cache')
        .upsert({
          phone,
          packages,
          trip_params: tripParams,
          cached_at: new Date().toISOString(),
        }, { onConflict: 'phone' });
      if (error) logger.error('packageCache.save failed', { phone, error: error.message });
    } catch (err) {
      logger.error('packageCache.save threw', { phone, error: err.message });
    }
  }

  // Returns null if nothing cached OR the cache is EXPIRED (>24h).
  // Returns { packages, tripParams, isStale } otherwise.
  async get(phone) {
    try {
      const { data, error } = await supabase
        .from('whatsapp_package_cache')
        .select('*')
        .eq('phone', phone)
        .maybeSingle();

      if (error) {
        logger.error('packageCache.get failed', { phone, error: error.message });
        return null;
      }
      if (!data || !Array.isArray(data.packages) || data.packages.length === 0) return null;

      const ageMs = Date.now() - new Date(data.cached_at).getTime();
      if (ageMs > EXPIRED_AFTER_MS) {
        logger.info('packageCache.get: cache too old, treating as absent', { phone, ageMs });
        return null;
      }

      return {
        packages: data.packages,
        tripParams: data.trip_params || null,
        isStale: ageMs > STALE_AFTER_MS,
      };
    } catch (err) {
      logger.error('packageCache.get threw', { phone, error: err.message });
      return null;
    }
  }

  async clear(phone) {
    try {
      await supabase.from('whatsapp_package_cache').delete().eq('phone', phone);
    } catch (err) {
      logger.error('packageCache.clear failed', { phone, error: err.message });
    }
  }
}

module.exports = new PackageCache();