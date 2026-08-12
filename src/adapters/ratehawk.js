/**
 * RATEHAWK ADAPTER  (ETG WorldOTA B2B v3)
 * ─────────────────────────────────────────────────────────────
 * Search and book hotels via RateHawk / Emerging Travel Group.
 *
 * AUTH: HTTP Basic — RATEHAWK_KEY_ID : RATEHAWK_TOKEN
 *
 * BOOKING LIFECYCLE:
 *   search()   → SERP (geo or region)  → normalized hotel cards
 *   prebook()  → locks rate, returns new book_hash (old one consumed)
 *   book()     → form() then finish()  → kicks off async confirmation
 *   getStatus()→ poll until "ok" or terminal error
 *   cancel()   → cancel order by partner_order_id
 *
 * GEO RESOLUTION:
 *   Reuses the same five-tier geo stack as HotelBeds:
 *   Tier 1: RateHawk region lookup (by name)
 *   Tier 2: Static geo overrides  (hand-verified EA/global coords)
 *   Tier 3: In-memory process cache
 *   Tier 4: Supabase geocode_cache
 *   Tier 5: Nominatim (rate-limited, writes to Supabase)
 *
 * NORMALIZED OUTPUT:
 *   Identical shape to HotelBedsAdapter._normalizeHotels() so the
 *   hotel orchestrator can blend results without any conversion.
 *   supplier field = 'ratehawk'
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const axios    = require('axios');
const { logger }  = require('../utils/logger');
const supabase = require('../utils/supabase');

// ─────────────────────────────────────────────
// STATIC GEO OVERRIDES  (same table as HotelBeds)
// ─────────────────────────────────────────────
const STATIC_GEO_OVERRIDES = {
  // ── Kenya coast ──────────────────────────────────────────────
  'diani':            { lat: -4.2833,  lng: 39.5667,  radius: 30 },
  'diani beach':      { lat: -4.2833,  lng: 39.5667,  radius: 30 },
  'ukunda':           { lat: -4.2833,  lng: 39.5667,  radius: 30 },
  'watamu':           { lat: -3.3667,  lng: 40.0167,  radius: 30 },
  'malindi':          { lat: -3.2175,  lng: 40.1169,  radius: 30 },
  'lamu':             { lat: -2.2686,  lng: 40.9020,  radius: 20 },
  'kilifi':           { lat: -3.6333,  lng: 39.8500,  radius: 30 },
  'shimba hills':     { lat: -4.2167,  lng: 39.3833,  radius: 25 },

  // ── Kenya — Nairobi & surrounds ───────────────────────────────
  'nairobi':          { lat: -1.2921,  lng: 36.8219,  radius: 25 },
  'naivasha':         { lat: -0.7167,  lng: 36.4333,  radius: 50 },
  'nakuru':           { lat: -0.3031,  lng: 36.0800,  radius: 40 },
  'nanyuki':          { lat:  0.0167,  lng: 37.0667,  radius: 40 },
  'nyeri':            { lat: -0.4167,  lng: 36.9500,  radius: 30 },
  'thika':            { lat: -1.0333,  lng: 37.0833,  radius: 25 },

  // ── Kenya — coast city ────────────────────────────────────────
  'mombasa':          { lat: -4.0435,  lng: 39.6682,  radius: 20 },

  // ── Kenya — safari / parks ────────────────────────────────────
  'masai mara':       { lat: -1.5167,  lng: 35.1500,  radius: 80 },
  'maasai mara':      { lat: -1.5167,  lng: 35.1500,  radius: 80 },
  'amboseli':         { lat: -2.6527,  lng: 37.2606,  radius: 60 },
  'tsavo':            { lat: -3.3667,  lng: 38.5000,  radius: 80 },
  'samburu':          { lat:  0.6167,  lng: 37.5333,  radius: 60 },
  'lake nakuru':      { lat: -0.3667,  lng: 36.0833,  radius: 40 },
  'ol pejeta':        { lat:  0.0167,  lng: 36.9333,  radius: 40 },
  'aberdare':         { lat: -0.4000,  lng: 36.7333,  radius: 50 },

  // ── Tanzania ──────────────────────────────────────────────────
  'zanzibar':         { lat: -6.1659,  lng: 39.2026,  radius: 25 },
  'stone town':       { lat: -6.1622,  lng: 39.1921,  radius: 15 },
  'dar es salaam':    { lat: -6.7924,  lng: 39.2083,  radius: 25 },
  'arusha':           { lat: -3.3869,  lng: 36.6830,  radius: 30 },
  'kilimanjaro':      { lat: -3.0674,  lng: 37.3556,  radius: 40 },
  'serengeti':        { lat: -2.3333,  lng: 34.8333,  radius: 80 },
  'ngorongoro':       { lat: -3.2333,  lng: 35.5000,  radius: 60 },
  'tarangire':        { lat: -3.8333,  lng: 35.9167,  radius: 60 },
  'mwanza':           { lat: -2.5167,  lng: 32.9000,  radius: 25 },
  'pemba':            { lat: -5.2500,  lng: 39.7500,  radius: 20 },

  // ── Uganda ────────────────────────────────────────────────────
  'kampala':          { lat:  0.3476,  lng: 32.5825,  radius: 25 },
  'entebbe':          { lat:  0.0644,  lng: 32.4600,  radius: 20 },
  'bwindi':           { lat: -1.0500,  lng: 29.6667,  radius: 40 },
  'lake victoria':    { lat: -1.0000,  lng: 33.0000,  radius: 50 },

  // ── Rwanda ────────────────────────────────────────────────────
  'kigali':           { lat: -1.9441,  lng: 30.0619,  radius: 20 },
  'akagera':          { lat: -1.9333,  lng: 30.7500,  radius: 50 },

  // ── Ethiopia ──────────────────────────────────────────────────
  'addis ababa':      { lat:  9.0222,  lng: 38.7468,  radius: 25 },

  // ── Southern Africa ───────────────────────────────────────────
  'johannesburg':     { lat: -26.2041, lng: 28.0473,  radius: 25 },
  'cape town':        { lat: -33.9249, lng: 18.4241,  radius: 20 },
  'durban':           { lat: -29.8587, lng: 31.0218,  radius: 20 },
  'kruger':           { lat: -24.0000, lng: 31.5000,  radius: 80 },
  'kruger park':      { lat: -24.0000, lng: 31.5000,  radius: 80 },
  'victoria falls':   { lat: -17.9243, lng: 25.8572,  radius: 30 },
  'harare':           { lat: -17.8252, lng: 31.0335,  radius: 25 },
  'lusaka':           { lat: -15.4167, lng: 28.2833,  radius: 25 },
  'windhoek':         { lat: -22.5597, lng: 17.0832,  radius: 25 },
  'maputo':           { lat: -25.9692, lng: 32.5732,  radius: 25 },

  // ── Seychelles / Mauritius / Islands ─────────────────────────
  'mahe':             { lat: -4.6167,  lng: 55.4500,  radius: 20 },
  'seychelles':       { lat: -4.6167,  lng: 55.4500,  radius: 20 },
  'praslin':          { lat: -4.3167,  lng: 55.7333,  radius: 15 },
  'la digue':         { lat: -4.3667,  lng: 55.8333,  radius: 10 },
  'port louis':       { lat: -20.1609, lng: 57.4989,  radius: 20 },
  'mauritius':        { lat: -20.2833, lng: 57.5500,  radius: 30 },
  'male':             { lat:  4.1755,  lng: 73.5093,  radius: 15 },
  'maldives':         { lat:  4.1755,  lng: 73.5093,  radius: 30 },
  'nosy be':          { lat: -13.3333, lng: 48.2667,  radius: 20 },
  'reunion':          { lat: -21.1151, lng: 55.5364,  radius: 30 },
  'la reunion':       { lat: -21.1151, lng: 55.5364,  radius: 30 },

  // ── Middle East ───────────────────────────────────────────────
  'dubai':            { lat: 25.2048,  lng: 55.2708,  radius: 20 },
  'abu dhabi':        { lat: 24.4539,  lng: 54.3773,  radius: 20 },
  'doha':             { lat: 25.2854,  lng: 51.5310,  radius: 20 },
  'muscat':           { lat: 23.5880,  lng: 58.3829,  radius: 20 },
  'istanbul':         { lat: 41.0082,  lng: 28.9784,  radius: 20 },
  'amman':            { lat: 31.9454,  lng: 35.9284,  radius: 20 },

  // ── Asia ──────────────────────────────────────────────────────
  'bali':             { lat: -8.4095,  lng: 115.1889, radius: 30 },
  'phuket':           { lat:  7.8804,  lng: 98.3923,  radius: 30 },
  'bangkok':          { lat: 13.7563,  lng: 100.5018, radius: 20 },
  'singapore':        { lat:  1.3521,  lng: 103.8198, radius: 15 },
  'delhi':            { lat: 28.6139,  lng: 77.2090,  radius: 20 },
  'mumbai':           { lat: 19.0760,  lng: 72.8777,  radius: 20 },
  'goa':              { lat: 15.2993,  lng: 74.1240,  radius: 30 },
  'tokyo':            { lat: 35.6762,  lng: 139.6503, radius: 20 },
  'hong kong':        { lat: 22.3193,  lng: 114.1694, radius: 15 },

  // ── Europe ────────────────────────────────────────────────────
  'london':           { lat: 51.5074,  lng: -0.1278,  radius: 20 },
  'paris':            { lat: 48.8566,  lng:  2.3522,  radius: 15 },
  'amsterdam':        { lat: 52.3676,  lng:  4.9041,  radius: 15 },
  'rome':             { lat: 41.9028,  lng: 12.4964,  radius: 15 },
  'barcelona':        { lat: 41.3851,  lng:  2.1734,  radius: 15 },
  'madrid':           { lat: 40.4168,  lng: -3.7038,  radius: 15 },

  // ── Americas ──────────────────────────────────────────────────
  'new york':         { lat: 40.7128,  lng: -74.0060, radius: 15 },
  'miami':            { lat: 25.7617,  lng: -80.1918, radius: 15 },
  'cancun':           { lat: 21.1619,  lng: -86.8515, radius: 20 },

  // ── Australia ─────────────────────────────────────────────────
  'sydney':           { lat: -33.8688, lng: 151.2093, radius: 20 },
  'melbourne':        { lat: -37.8136, lng: 144.9631, radius: 20 },
};

// ─────────────────────────────────────────────
// RADIUS OVERRIDES (matching HotelBeds)
// ─────────────────────────────────────────────
const RADIUS_OVERRIDES = {
  'masai mara': 80, 'maasai mara': 80, 'amboseli': 60, 'tsavo': 80,
  'samburu': 60,    'lake nakuru': 40, 'aberdare': 50, 'ol pejeta': 40,
  'serengeti': 80,  'ngorongoro': 60,  'tarangire': 60, 'naivasha': 50,
  'nakuru': 40,     'diani': 30,       'malindi': 30,   'watamu': 30,
  'lamu': 20,       'nanyuki': 40,     'nairobi': 25,   'mombasa': 20,
  'kampala': 25,    'dar es salaam': 25, 'kigali': 20,  'zanzibar': 25,
  'dubai': 20,      'london': 20,      'paris': 15,     'new york': 15,
  'bwindi': 40,     'kruger': 80,      'kruger park': 80,
};

function _getRadius(cityName) {
  const key = (cityName || '').toLowerCase().trim();
  return RADIUS_OVERRIDES[key] || 30;
}

// ─────────────────────────────────────────────
// NOMINATIM RATE LIMITER  (1 req/sec per OSM policy)
// ─────────────────────────────────────────────
const _memCache           = {};
let   _nominatimLastCall  = 0;
const _nominatimQueue     = [];
let   _nominatimRunning   = false;

function _enqueueNominatim(fn) {
  return new Promise((resolve, reject) => {
    _nominatimQueue.push({ fn, resolve, reject });
    if (!_nominatimRunning) _drainNominatimQueue();
  });
}

async function _drainNominatimQueue() {
  _nominatimRunning = true;
  while (_nominatimQueue.length > 0) {
    const { fn, resolve, reject } = _nominatimQueue.shift();
    const now  = Date.now();
    const wait = 1100 - (now - _nominatimLastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _nominatimLastCall = Date.now();
    try { resolve(await fn()); } catch (err) { reject(err); }
  }
  _nominatimRunning = false;
}

// ─────────────────────────────────────────────
// TERMINAL BOOKING ERROR CODES
// These are hard failures — do NOT retry.
// ─────────────────────────────────────────────
const TERMINAL_ERRORS = new Set([
  'soldout', 'book_limit', 'booking_finish_did_not_succeed',
  'provider', '3ds', 'block',
]);

// ─────────────────────────────────────────────
// MEAL PLAN NORMALIZER
// RateHawk uses verbose strings; map to common labels
// ─────────────────────────────────────────────
const MEAL_PLAN_MAP = {
  'nomeal':       'Room Only',
  'breakfast':    'Bed & Breakfast',
  'half_board':   'Half Board',
  'full_board':   'Full Board',
  'all_inclusive':'All Inclusive',
};

function _normalizeMealPlan(mealCode) {
  if (!mealCode) return null;
  return MEAL_PLAN_MAP[mealCode.toLowerCase()] || mealCode;
}


class RateHawkAdapter {

  constructor() {
    this.keyId         = process.env.RATEHAWK_KEY_ID;
    this.token         = process.env.RATEHAWK_TOKEN;
    this.isSandbox     = process.env.RATEHAWK_SANDBOX !== 'false'; // default sandbox until you go live
    this.baseUrl       = this.isSandbox
      ? 'https://api-sandbox.ratehawk.com/api/b2b/v3'
      : 'https://api.worldota.net/api/b2b/v3';
    this.timeout       = Number(process.env.RATEHAWK_TIMEOUT_MS)        || 20000;
    this.searchTimeout = Number(process.env.RATEHAWK_SEARCH_TIMEOUT_MS) || 18000;

    // Polling config for async booking confirmation
    this.pollAttempts  = Number(process.env.RATEHAWK_POLL_ATTEMPTS)     || 30;
    this.pollIntervalMs= Number(process.env.RATEHAWK_POLL_INTERVAL_MS)  || 3000;
  }

  // ─────────────────────────────────────────────
  // AUTH HEADER
  // Basic auth: base64(keyId:token)
  // ─────────────────────────────────────────────
  _authHeader() {
    const creds = Buffer.from(`${this.keyId}:${this.token}`).toString('base64');
    return { Authorization: `Basic ${creds}` };
  }

  _headers() {
    return {
      ...this._authHeader(),
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    };
  }

  _hasCredentials() {
    return !!(this.keyId && this.token);
  }

  // ─────────────────────────────────────────────
  // LOW-LEVEL HTTP HELPERS
  // ─────────────────────────────────────────────
  async _post(path, body, timeoutMs) {
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await axios.post(url, body, {
        headers: this._headers(),
        timeout: timeoutMs || this.timeout,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data)?.slice(0, 300);
      logger.error('RateHawk POST failed', { path, status, detail, error: err.message });
      throw err;
    }
  }

  async _get(path, params, timeoutMs) {
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await axios.get(url, {
        headers: this._headers(),
        params,
        timeout: timeoutMs || this.timeout,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const detail = JSON.stringify(err.response?.data)?.slice(0, 300);
      logger.error('RateHawk GET failed', { path, status, detail, error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GEO RESOLUTION — FIVE TIERS
  // ─────────────────────────────────────────────

  // Tier 4: Supabase geocode_cache (shared with HotelBeds)
  async _lookupSupabaseCache(cityKey) {
    try {
      const { data, error } = await supabase
        .from('geocode_cache')
        .select('latitude, longitude, radius, display_name')
        .eq('city_key', cityKey)
        .maybeSingle();

      if (error || !data) return null;

      logger.info('RateHawk: Supabase geo cache hit', { cityKey, displayName: data.display_name });
      return {
        latitude:  parseFloat(data.latitude),
        longitude: parseFloat(data.longitude),
        radius:    data.radius || _getRadius(cityKey),
      };
    } catch (err) {
      logger.warn('RateHawk: Supabase geo cache lookup failed', { cityKey, error: err.message });
      return null;
    }
  }

  async _writeSupabaseCache(cityKey, cityName, geo, displayName) {
    try {
      await supabase
        .from('geocode_cache')
        .upsert({
          city_key:     cityKey,
          city_name:    cityName,
          latitude:     geo.latitude,
          longitude:    geo.longitude,
          radius:       geo.radius,
          display_name: displayName || cityName,
          cached_at:    new Date().toISOString(),
        }, { onConflict: 'city_key' });

      logger.info('RateHawk: wrote geo to Supabase cache', { cityKey });
    } catch (err) {
      logger.warn('RateHawk: Supabase geo cache write failed', { cityKey, error: err.message });
    }
  }

  // Tier 5: Nominatim
  async _geocodeViaNominatim(cityName, cityKey) {
    return _enqueueNominatim(async () => {
      try {
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
          params:  { q: cityName, format: 'json', limit: 1 },
          headers: { 'User-Agent': 'Bodrless/1.0 (travel booking platform; petermwasi32@gmail.com)' },
          timeout: 6000,
        });

        const result = response.data?.[0];
        if (!result) {
          logger.warn('RateHawk: Nominatim returned no results', { cityName });
          return null;
        }

        const radius = _getRadius(cityName);
        const geo    = { latitude: parseFloat(result.lat), longitude: parseFloat(result.lon), radius };

        logger.info('RateHawk: Nominatim geocoded', {
          cityName, lat: geo.latitude, lng: geo.longitude, radius,
        });

        await this._writeSupabaseCache(cityKey, cityName, geo, result.display_name);
        return geo;

      } catch (err) {
        logger.warn('RateHawk: Nominatim geocoding failed', { cityName, error: err.message });
        return null;
      }
    });
  }

  // Tier 1: RateHawk region lookup by city name
  // Returns a region_id string (e.g. "2114") or null
  async _lookupRegionId(cityName) {
    if (!this._hasCredentials()) return null;
    try {
      const data = await this._post('/search/multicomplete/', {
        query:    cityName,
        language: 'en',
      }, 6000);

      // Response contains regions[], cities[], hotels[] arrays
      // We want the first region or city match
      const regions = data?.data?.regions || [];
      const cities  = data?.data?.cities  || [];
      const matches = [...regions, ...cities];

      if (matches.length === 0) {
        logger.warn('RateHawk: region lookup returned no results', { cityName });
        return null;
      }

      // Prefer exact name match, then take first result
      const key   = cityName.toLowerCase().trim();
      const exact = matches.find(m => (m.name || '').toLowerCase() === key);
      const best  = exact || matches[0];

      logger.info('RateHawk: region lookup resolved', {
        cityName, regionId: best.id, name: best.name,
      });
      return best.id ? String(best.id) : null;

    } catch (err) {
      logger.warn('RateHawk: region lookup failed', { cityName, error: err.message });
      return null;
    }
  }

  // Main resolver — returns { regionId, geolocation }
  async _resolveDestination(cityName) {
    if (!cityName) return { regionId: null, geolocation: null };

    const key = cityName.toLowerCase().trim();

    // Tier 1: RateHawk region ID
    const regionId = await this._lookupRegionId(cityName);

    // Tiers 2-5: geo resolution (always attempt — needed as fallback
    // and for logging even when regionId is found)
    let geolocation = null;

    // Tier 2: static override
    const staticGeo = STATIC_GEO_OVERRIDES[key];
    if (staticGeo) {
      geolocation = { latitude: staticGeo.lat, longitude: staticGeo.lng, radius: staticGeo.radius };
      logger.info('RateHawk: static geo override hit', { cityName });
      _memCache[key] = geolocation;
    }

    // Tier 3: in-memory cache
    if (!geolocation && _memCache[key]) {
      geolocation = _memCache[key];
      logger.info('RateHawk: memory geo cache hit', { cityName });
    }

    // Tier 4: Supabase
    if (!geolocation) {
      const supabaseGeo = await this._lookupSupabaseCache(key);
      if (supabaseGeo) {
        geolocation = supabaseGeo;
        _memCache[key] = supabaseGeo;
      }
    }

    // Tier 5: Nominatim
    if (!geolocation) {
      const nominatimGeo = await this._geocodeViaNominatim(cityName, key);
      if (nominatimGeo) {
        geolocation = nominatimGeo;
        _memCache[key] = nominatimGeo;
      }
    }

    logger.info('RateHawk: _resolveDestination', {
      cityName,
      regionId:    regionId   ?? 'null — will use geo',
      geoResolved: !!geolocation,
    });

    return { regionId, geolocation };
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS  (SERP)
  // ─────────────────────────────────────────────
  async search({
    destination, checkIn, checkOut,
    adults = 1, children = 0, childAges = [], rooms = 1,
    nights, budget,
  }) {
    if (!this._hasCredentials()) {
      logger.warn('RateHawk: credentials not configured — skipping');
      return [];
    }

    const { regionId, geolocation } = await this._resolveDestination(destination);

    if (!regionId && !geolocation) {
      logger.warn('RateHawk: could not resolve destination', { destination });
      return [];
    }

    // Build guests array — RateHawk takes a flat guests array per search
    const adultsPerRoom   = Math.max(1, Math.ceil(adults / rooms));
    const childrenPerRoom = Math.ceil(children / rooms);
    const guests          = [{ adults: adultsPerRoom, children: childrenPerRoom }];
    if (rooms > 1) {
      // Duplicate the guest object for each room
      guests.length = 0;
      for (let r = 0; r < rooms; r++) {
        guests.push({ adults: adultsPerRoom, children: childrenPerRoom });
      }
    }

    // Child ages — RateHawk wants them on each room object
    if (childrenPerRoom > 0 && childAges.length > 0) {
      guests.forEach(g => {
        g.children_ages = childAges.slice(0, childrenPerRoom);
      });
    }

    const body = {
      checkin:         checkIn,
      checkout:        checkOut,
      guests,
      language:        'en',
      currency:        'USD',
      residency:       'ke',   // Kenya — adjust per agency if needed
    };

    // Prefer region_id when available; fall back to lat/lng
    if (regionId) {
      body.region_id = regionId;
    } else {
      body.latitude  = geolocation.latitude;
      body.longitude = geolocation.longitude;
      body.radius    = geolocation.radius || 30;
    }

    logger.info('RateHawk SERP request', {
      destination, checkIn, checkOut, adults, children, rooms,
      resolvedAs: regionId
        ? `regionId:${regionId}`
        : `geo:${geolocation?.latitude},${geolocation?.longitude} radius:${geolocation?.radius}km`,
    });

    try {
      const data = await this._post('/search/serp/region/', body, this.searchTimeout);

      // RateHawk SERP returns data.hotels array
      const hotels = data?.data?.hotels || [];

      logger.info('RateHawk SERP results', {
        destination, count: hotels.length,
        resolvedAs: regionId ? `regionId:${regionId}` : 'geo',
      });

      if (hotels.length === 0) {
        logger.warn('RateHawk: zero results', {
          destination,
          regionId:   regionId ?? 'n/a',
          lat:        geolocation?.latitude  ?? 'n/a',
          lng:        geolocation?.longitude ?? 'n/a',
          note: 'May be sandbox geo restriction — check documented sandbox anchors',
        });
      }

      return this._normalizeHotels(hotels, { checkIn, checkOut, nights, adults, budget });

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`RateHawk SERP timed out after ${this.searchTimeout}ms`, { destination });
      } else {
        logger.error('RateHawk SERP failed', { destination, error: err.message });
      }
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // PREBOOK — locks rate, returns a fresh book_hash
  // Call this right before showing the checkout page.
  // The old book_hash is consumed after this call.
  // ─────────────────────────────────────────────
  async prebook({ bookHash }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');

    const data = await this._post('/hotel/prebook/', {
      book_hash:             bookHash,
      // Allow up to 2% price drift silently; surface bigger changes to user
      price_increase_percent: Number(process.env.RATEHAWK_PRICE_INCREASE_PCT) || 2,
    });

    const result = data?.data;
    if (!result) throw new Error('RateHawk prebook: empty response');

    logger.info('RateHawk prebook success', {
      oldHash:   bookHash.slice(0, 20),
      newHash:   result.book_hash?.slice(0, 20),
      netPrice:  result.net_price,
      currency:  result.currency,
    });

    return {
      bookHash:    result.book_hash,        // use this on form + finish
      netPrice:    Number(result.net_price || 0),
      currency:    result.currency || 'USD',
      priceChanged: result.price_changed || false,
      expiresAt:   result.book_hash_expires_at || null,
    };
  }

  // ─────────────────────────────────────────────
  // BOOKING FORM — opens ETG order
  // Returns available payment_types (use 'deposit')
  // ─────────────────────────────────────────────
  async _openBookingForm({ partnerOrderId, bookHash }) {
    const data = await this._post('/hotel/order/booking/form/', {
      partner_order_id: partnerOrderId,
      book_hash:        bookHash,
      language:         'en',
    });

    return data?.data || {};
  }

  // ─────────────────────────────────────────────
  // BOOKING FINISH — triggers supplier-side confirmation
  // Always async — must poll getBookingStatus() after this.
  // ─────────────────────────────────────────────
  async _finishBooking({ partnerOrderId, bookHash, holder, guests }) {
    const body = {
      partner_order_id: partnerOrderId,
      book_hash:        bookHash,
      language:         'en',
      payment: {
        type: 'deposit',   // B2B deposit model — bill to credit line
      },
      // Guest details
      guests: guests.map((g, i) => ({
        first_name: g.firstName,
        last_name:  g.lastName,
        email:      g.email || holder.email || null,
        phone:      g.phone || holder.phone || null,
      })),
      // Lead guest (booker)
      holder: {
        first_name: holder.firstName,
        last_name:  holder.lastName,
        email:      holder.email,
        phone:      holder.phone || null,
      },
    };

    return await this._post('/hotel/order/booking/finish/', body);
  }

  // ─────────────────────────────────────────────
  // GET BOOKING STATUS — poll after finish()
  // ─────────────────────────────────────────────
  async getBookingStatus({ partnerOrderId }) {
    const data = await this._get('/hotel/order/booking/finish/status/', {
      partner_order_id: partnerOrderId,
    });

    return {
      status:    data?.data?.status || 'unknown',
      orderId:   data?.data?.order_id || null,
      errorCode: data?.data?.error_code || null,
    };
  }

  // ─────────────────────────────────────────────
  // BOOK — full flow: form → finish → poll
  //
  // Call prebook() first, pass the resulting bookHash here.
  // This method polls until confirmed or terminal failure.
  // If it times out polling, it returns status:'awaiting_confirmation'
  // — your cron worker (ratehawkConfirmPoller.js) handles those.
  // ─────────────────────────────────────────────
  async book({ partnerOrderId, bookHash, holder, guests }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');

    logger.info('RateHawk: opening booking form', {
      partnerOrderId, hashPrefix: bookHash.slice(0, 20),
    });

    // Step 1: open order
    const formResult = await this._openBookingForm({ partnerOrderId, bookHash });
    logger.info('RateHawk: booking form opened', { partnerOrderId, formResult });

    // Step 2: finish (async)
    logger.info('RateHawk: sending booking finish', { partnerOrderId });
    await this._finishBooking({ partnerOrderId, bookHash, holder, guests });

    // Step 3: poll for confirmation
    logger.info('RateHawk: polling for booking confirmation', {
      partnerOrderId, maxAttempts: this.pollAttempts,
    });

    for (let attempt = 1; attempt <= this.pollAttempts; attempt++) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs));

      const { status, orderId, errorCode } = await this.getBookingStatus({ partnerOrderId });

      logger.info('RateHawk: booking poll', { partnerOrderId, attempt, status, orderId });

      if (status === 'ok') {
        logger.info('RateHawk: booking confirmed', { partnerOrderId, orderId });
        return {
          status:       'confirmed',
          partnerOrderId,
          supplierOrderId: orderId,
          bookHash,
        };
      }

      if (TERMINAL_ERRORS.has(status) || TERMINAL_ERRORS.has(errorCode)) {
        logger.error('RateHawk: booking terminal failure', {
          partnerOrderId, status, errorCode,
        });
        throw new Error(`RateHawk booking failed: ${status || errorCode}`);
      }

      // 'timeout', 'unknown', 5xx — retryable; keep polling
    }

    // Exhausted poll window — hand off to background poller
    logger.warn('RateHawk: booking poll timed out — marking awaiting_confirmation', {
      partnerOrderId,
    });
    return {
      status:         'awaiting_confirmation',
      partnerOrderId,
      supplierOrderId: null,
      bookHash,
    };
  }

  // ─────────────────────────────────────────────
  // GET ORDER INFO  (post-booking retrieval)
  // ─────────────────────────────────────────────
  async getOrder({ partnerOrderId }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');

    const data = await this._get('/hotel/order/info/', { partner_order_id: partnerOrderId });
    return data?.data || null;
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel({ partnerOrderId }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');

    try {
      const data = await this._post('/hotel/order/cancel/', {
        partner_order_id: partnerOrderId,
      });

      const result = data?.data;
      logger.info('RateHawk: cancellation result', { partnerOrderId, result });

      return {
        partnerOrderId,
        status:          result?.status || 'cancelled',
        penaltyAmount:   result?.penalty_amount ? Number(result.penalty_amount) : 0,
        currency:        result?.currency || 'USD',
      };
    } catch (err) {
      logger.error('RateHawk cancel failed', { partnerOrderId, error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE HOTELS
  // Output shape is IDENTICAL to HotelBeds._normalizeHotels()
  // so the orchestrator can merge both arrays without conversion.
  // ─────────────────────────────────────────────
  _normalizeHotels(hotels, { checkIn, checkOut, nights, adults, budget }) {
    const results = [];

    for (const hotel of hotels) {
      // Each hotel has a rates array; pick cheapest
      const rates = hotel.rates || [];
      if (rates.length === 0) continue;

      rates.sort((a, b) => Number(a.daily_prices?.[0] || a.payment_options?.payment_types?.[0]?.show_amount || 0)
                         - Number(b.daily_prices?.[0] || b.payment_options?.payment_types?.[0]?.show_amount || 0));

      const rate = rates[0];

      // Extract price — RateHawk nests it under payment_options
      const paymentType = rate.payment_options?.payment_types?.find(pt => pt.type === 'deposit')
                       || rate.payment_options?.payment_types?.[0];

      const totalRate     = Number(paymentType?.show_amount || paymentType?.amount || 0);
      const nightCount    = nights || this._nightsBetween(checkIn, checkOut) || 1;
      const pricePerNight = nightCount > 0 ? totalRate / nightCount : totalRate;
      const currency      = paymentType?.show_currency_code || paymentType?.currency_code || 'USD';

      // Cancellation policy
      const penalties   = paymentType?.cancellation_penalties?.policies || [];
      const isRefundable = !rate.rg_ext?.nr; // nr = non-refundable flag

      // Images — RateHawk returns image_urls[]
      const images = (hotel.images || []).map(img =>
        typeof img === 'string' ? img : img?.url || ''
      ).filter(Boolean).slice(0, 10);

      results.push({
        // ── Identity ──────────────────────────────────────────────
        supplier:             'ratehawk',
        hotelCode:            String(hotel.id || hotel.hid),
        name:                 hotel.name,
        stars:                hotel.star_rating ? Number(hotel.star_rating) : null,
        rating:               hotel.serp_filters?.includes('rating_above_8') ? 8 : null,

        // ── Location ──────────────────────────────────────────────
        location:             hotel.region?.name || hotel.area?.name || null,
        latitude:             hotel.latitude  || hotel.coordinates?.latitude  || null,
        longitude:            hotel.longitude || hotel.coordinates?.longitude || null,
        images,

        // ── Dates ─────────────────────────────────────────────────
        checkIn,
        checkOut,
        nights:               nightCount,

        // ── Pricing ───────────────────────────────────────────────
        pricePerNight:        Math.round(pricePerNight * 100) / 100,
        totalRate:            Math.round(totalRate     * 100) / 100,
        currency,

        // ── Rate details ──────────────────────────────────────────
        rateKey:              rate.book_hash,   // field name matches what orchestrator passes to prebook()
        rateType:             isRefundable ? 'REF' : 'NOR',
        isRefundable,
        cancellationPolicies: penalties,
        rateComments:         rate.meal ? _normalizeMealPlan(rate.meal) : null,
        mealPlan:             _normalizeMealPlan(rate.meal),
        boardType:            rate.meal || null,
        promotions:           [],

        // ── Occupancy ─────────────────────────────────────────────
        rooms:                adults ? Math.ceil(adults / Math.max(adults, 1)) : 1,
        adults,

        // ── Internal ──────────────────────────────────────────────
        supplier_tag:         rate.book_hash ? rate.book_hash.slice(0, 20) : null,
      });
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // UTIL
  // ─────────────────────────────────────────────
  _nightsBetween(checkIn, checkOut) {
    if (!checkIn || !checkOut) return null;
    const diff = new Date(checkOut) - new Date(checkIn);
    return Math.round(diff / (1000 * 60 * 60 * 24));
  }
}

module.exports = new RateHawkAdapter();