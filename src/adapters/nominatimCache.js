/**
 * NOMINATIM CACHE SERVICE
 * ─────────────────────────────────────────────────────────────
 * Persistent Supabase-backed cache for Nominatim geocoding results.
 * Prevents repeated Nominatim calls for the same city — once
 * Mombasa is geocoded it's cached in Supabase forever.
 *
 * Two-tier cache:
 *   Tier 1: In-memory (_geoCache) — instant, resets on deploy
 *   Tier 2: Supabase (geocode_cache) — persistent across deploys
 *
 * This eliminates 429 errors for repeat searches entirely.
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// In-memory cache — fastest lookup, resets on deploy
const _memCache = {};

class NominatimCacheService {

  async get(cityName) {
    const key = this._key(cityName);

    // Tier 1: memory
    if (_memCache[key]) return _memCache[key];

    // Tier 2: Supabase
    try {
      const { data } = await supabase
        .from('geocode_cache')
        .select('latitude, longitude, radius, display_name')
        .eq('city_key', key)
        .maybeSingle();

      if (data) {
        const geo = {
          latitude:  data.latitude,
          longitude: data.longitude,
          radius:    data.radius || 30,
          unit:      'km',
        };
        _memCache[key] = geo; // promote to memory
        return geo;
      }
    } catch (err) {
      logger.warn('NominatimCache: Supabase get failed', { cityName, error: err.message });
    }

    return null;
  }

  async set(cityName, geo, displayName = null) {
    const key = this._key(cityName);

    // Always write to memory
    _memCache[key] = geo;

    // Write to Supabase
    try {
      await supabase.from('geocode_cache').upsert({
        city_key:     key,
        city_name:    cityName,
        latitude:     geo.latitude,
        longitude:    geo.longitude,
        radius:       geo.radius,
        display_name: displayName,
        cached_at:    new Date().toISOString(),
      }, { onConflict: 'city_key' });
    } catch (err) {
      logger.warn('NominatimCache: Supabase set failed', { cityName, error: err.message });
      // Not critical — memory cache still works
    }
  }

  _key(cityName) {
    return (cityName || '').toLowerCase().trim().replace(/\s+/g, '_');
  }
}

module.exports = new NominatimCacheService();