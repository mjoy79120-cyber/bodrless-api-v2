/**
 * HOTELBEDS ADAPTER
 * ─────────────────────────────────────────────────────────────
 * Search and book hotels via HotelBeds (APItude API).
 *
 * DESTINATION RESOLUTION (five-tier):
 *
 * Tier 1: HotelBeds live /locations/destinations lookup — preferred
 *         when a destination code exists; more accurate than geo for
 *         cities HotelBeds knows about (e.g. Maputo, Cairo).
 * Tier 2: Static geo overrides — hand-verified EA/global coords,
 *         never hits any network. Fixes Nominatim misidentifying
 *         East African towns as places in other countries.
 * Tier 3: Process-level in-memory cache — instant, zero network.
 * Tier 4: Supabase geocode_cache — persisted across restarts,
 *         populated by past Nominatim calls.
 * Tier 5: Nominatim geocoding — free, no API key, any city on earth.
 *         Rate limited to 1 req/sec per OSM usage policy.
 *         Result is written to geocode_cache for future calls.
 *
 * When both a destination code AND geolocation are available,
 * both are returned and search() prefers the destination code.
 * ─────────────────────────────────────────────────────────────
 */

const axios    = require('axios');
const { logger }  = require('../utils/logger');
const supabase = require('../utils/supabase');

// ─────────────────────────────────────────────
// TIER 2: STATIC GEO OVERRIDES
// Hand-verified coordinates for destinations Nominatim commonly
// misidentifies (e.g. "Diani" → Guinea instead of Kenya coast).
// These are ground-truth and never go to any external service.
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
  'stellenbosch':     { lat: -33.9321, lng: 18.8602,  radius: 20 },
  'hermanus':         { lat: -34.4200, lng: 19.2345,  radius: 30 },
  'knysna':           { lat: -34.0357, lng: 23.0465,  radius: 25 },
  'garden route':     { lat: -33.9667, lng: 22.4667,  radius: 40 },
  'sun city':         { lat: -25.3406, lng: 27.0942,  radius: 20 },
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
  'grand baie':       { lat: -20.0131, lng: 57.5831,  radius: 15 },
  'flic en flac':     { lat: -20.3000, lng: 57.3667,  radius: 15 },
  'male':             { lat:  4.1755,  lng: 73.5093,  radius: 15 },
  'maldives':         { lat:  4.1755,  lng: 73.5093,  radius: 30 },
  'nosy be':          { lat: -13.3333, lng: 48.2667,  radius: 20 },
  'comoros':          { lat: -11.6455, lng: 43.3333,  radius: 25 },
  'reunion':          { lat: -21.1151, lng: 55.5364,  radius: 30 },
  'la reunion':       { lat: -21.1151, lng: 55.5364,  radius: 30 },

  // ── Middle East ───────────────────────────────────────────────
  'dubai':            { lat: 25.2048,  lng: 55.2708,  radius: 20 },
  'abu dhabi':        { lat: 24.4539,  lng: 54.3773,  radius: 20 },
  'sharjah':          { lat: 25.3462,  lng: 55.4211,  radius: 15 },
  'doha':             { lat: 25.2854,  lng: 51.5310,  radius: 20 },
  'muscat':           { lat: 23.5880,  lng: 58.3829,  radius: 20 },
  'riyadh':           { lat: 24.6877,  lng: 46.7219,  radius: 25 },
  'jeddah':           { lat: 21.5433,  lng: 39.1728,  radius: 20 },
  'istanbul':         { lat: 41.0082,  lng: 28.9784,  radius: 20 },
  'amman':            { lat: 31.9454,  lng: 35.9284,  radius: 20 },
  'petra':            { lat: 30.3285,  lng: 35.4444,  radius: 15 },
  'aqaba':            { lat: 29.5267,  lng: 35.0078,  radius: 15 },

  // ── Asia ──────────────────────────────────────────────────────
  'bali':             { lat: -8.4095,  lng: 115.1889, radius: 30 },
  'ubud':             { lat: -8.5069,  lng: 115.2625, radius: 15 },
  'seminyak':         { lat: -8.6906,  lng: 115.1614, radius: 10 },
  'lombok':           { lat: -8.6500,  lng: 116.3239, radius: 25 },
  'phuket':           { lat:  7.8804,  lng: 98.3923,  radius: 30 },
  'koh samui':        { lat:  9.5120,  lng: 100.0136, radius: 20 },
  'krabi':            { lat:  8.0863,  lng: 98.9063,  radius: 25 },
  'chiang mai':       { lat: 18.7883,  lng: 98.9853,  radius: 20 },
  'bangkok':          { lat: 13.7563,  lng: 100.5018, radius: 20 },
  'singapore':        { lat:  1.3521,  lng: 103.8198, radius: 15 },
  'kuala lumpur':     { lat:  3.1390,  lng: 101.6869, radius: 20 },
  'delhi':            { lat: 28.6139,  lng: 77.2090,  radius: 20 },
  'mumbai':           { lat: 19.0760,  lng: 72.8777,  radius: 20 },
  'goa':              { lat: 15.2993,  lng: 74.1240,  radius: 30 },
  'colombo':          { lat:  6.9271,  lng: 79.8612,  radius: 20 },
  'kathmandu':        { lat: 27.7172,  lng: 85.3240,  radius: 20 },
  'tokyo':            { lat: 35.6762,  lng: 139.6503, radius: 20 },
  'osaka':            { lat: 34.6937,  lng: 135.5023, radius: 20 },
  'hong kong':        { lat: 22.3193,  lng: 114.1694, radius: 15 },
  'seoul':            { lat: 37.5665,  lng: 126.9780, radius: 20 },
  'beijing':          { lat: 39.9042,  lng: 116.4074, radius: 20 },
  'shanghai':         { lat: 31.2304,  lng: 121.4737, radius: 20 },
  'siem reap':        { lat: 13.3671,  lng: 103.8448, radius: 20 },
  'hoi an':           { lat: 15.8801,  lng: 108.3380, radius: 15 },
  'hanoi':            { lat: 21.0278,  lng: 105.8342, radius: 20 },
  'ho chi minh':      { lat: 10.8231,  lng: 106.6297, radius: 20 },

  // ── Europe ────────────────────────────────────────────────────
  'london':           { lat: 51.5074,  lng: -0.1278,  radius: 20 },
  'paris':            { lat: 48.8566,  lng:  2.3522,  radius: 15 },
  'amsterdam':        { lat: 52.3676,  lng:  4.9041,  radius: 15 },
  'rome':             { lat: 41.9028,  lng: 12.4964,  radius: 15 },
  'barcelona':        { lat: 41.3851,  lng:  2.1734,  radius: 15 },
  'madrid':           { lat: 40.4168,  lng: -3.7038,  radius: 15 },
  'athens':           { lat: 37.9838,  lng: 23.7275,  radius: 15 },
  'santorini':        { lat: 36.3932,  lng: 25.4615,  radius: 15 },
  'mykonos':          { lat: 37.4467,  lng: 25.3289,  radius: 10 },
  'crete':            { lat: 35.2401,  lng: 24.8093,  radius: 40 },
  'lisbon':           { lat: 38.7223,  lng: -9.1393,  radius: 15 },
  'porto':            { lat: 41.1579,  lng: -8.6291,  radius: 15 },
  'dubrovnik':        { lat: 42.6507,  lng: 18.0944,  radius: 15 },
  'ibiza':            { lat: 38.9067,  lng:  1.4206,  radius: 15 },
  'mallorca':         { lat: 39.6953,  lng:  2.9022,  radius: 25 },
  'zurich':           { lat: 47.3769,  lng:  8.5417,  radius: 15 },
  'vienna':           { lat: 48.2082,  lng: 16.3738,  radius: 15 },
  'prague':           { lat: 50.0755,  lng: 14.4378,  radius: 15 },
  'budapest':         { lat: 47.4979,  lng: 19.0402,  radius: 15 },
  'reykjavik':        { lat: 64.1265,  lng: -21.8174, radius: 15 },

  // ── Americas ──────────────────────────────────────────────────
  'new york':         { lat: 40.7128,  lng: -74.0060, radius: 15 },
  'miami':            { lat: 25.7617,  lng: -80.1918, radius: 15 },
  'los angeles':      { lat: 34.0522,  lng: -118.2437,radius: 20 },
  'cancun':           { lat: 21.1619,  lng: -86.8515, radius: 20 },
  'punta cana':       { lat: 18.5601,  lng: -68.3725, radius: 20 },
  'havana':           { lat: 23.1136,  lng: -82.3666, radius: 15 },
  'cusco':            { lat: -13.5319, lng: -71.9675, radius: 20 },
  'rio de janeiro':   { lat: -22.9068, lng: -43.1729, radius: 20 },
  'buenos aires':     { lat: -34.6037, lng: -58.3816, radius: 20 },

  // ── Australia / Pacific ───────────────────────────────────────
  'sydney':           { lat: -33.8688, lng: 151.2093, radius: 20 },
  'melbourne':        { lat: -37.8136, lng: 144.9631, radius: 20 },
  'auckland':         { lat: -36.8485, lng: 174.7633, radius: 15 },
  'queenstown':       { lat: -45.0312, lng: 168.6626, radius: 15 },
  'fiji':             { lat: -17.7134, lng: 178.0650, radius: 30 },
};

const _memCache = {};

// Nominatim rate limiter — 1 req/sec per OSM policy
let _nominatimLastCall = 0;
const _nominatimQueue  = [];
let _nominatimRunning  = false;

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
// RADIUS SCALING
// ─────────────────────────────────────────────
const RADIUS_OVERRIDES = {
  'masai mara': 80, 'maasai mara': 80, 'amboseli': 60, 'tsavo': 80,
  'samburu': 60, 'lake nakuru': 40, 'aberdare': 50, 'mount kenya': 50,
  'ol pejeta': 40, 'serengeti': 80, 'ngorongoro': 60, 'tarangire': 60,
  'selous': 60, 'naivasha': 50, 'nakuru': 40, 'elementaita': 40,
  'bogoria': 40, 'baringo': 50, 'diani': 30, 'malindi': 30,
  'watamu': 30, 'lamu': 20, 'nanyuki': 40, 'laikipia': 60,
  'nairobi': 25, 'mombasa': 20, 'kampala': 25, 'dar es salaam': 25,
  'addis ababa': 25, 'kigali': 20, 'zanzibar': 25,
  'dubai': 20, 'london': 20, 'paris': 15, 'new york': 15, 'bangkok': 20,
};

function _getRadius(cityName) {
  const key = (cityName || '').toLowerCase().trim();
  return RADIUS_OVERRIDES[key] || 30;
}

class HotelBedsAdapter {

  constructor() {
    this.apiKey        = process.env.HOTELBEDS_API_KEY;
    this.apiSecret     = process.env.HOTELBEDS_API_SECRET || process.env.HOTELBEDS_SECRET;
    this.baseUrl       = process.env.HOTELBEDS_BASE_URL || 'https://api.test.hotelbeds.com';
    this.timeout       = Number(process.env.HOTELBEDS_TIMEOUT_MS) || 20000;
    this.searchTimeout = Number(process.env.HOTELBEDS_SEARCH_TIMEOUT_MS) || 18000;
  }

  _signature() {
    const crypto    = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    return crypto
      .createHash('sha256')
      .update(this.apiKey + this.apiSecret + timestamp)
      .digest('hex');
  }

  _headers() {
    return {
      'Api-key':         this.apiKey,
      'X-Signature':     this._signature(),
      'Accept':          'application/json',
      'Accept-Encoding': 'gzip',
      'Content-Type':    'application/json',
    };
  }

  // ─────────────────────────────────────────────
  // TIER 4: SUPABASE geocode_cache LOOKUP
  // ─────────────────────────────────────────────
  async _lookupSupabaseCache(cityKey) {
    try {
      const { data, error } = await supabase
        .from('geocode_cache')
        .select('latitude, longitude, radius, display_name')
        .eq('city_key', cityKey)
        .maybeSingle();

      if (error || !data) return null;

      logger.info('HotelBeds: Supabase geo cache hit', { cityKey, displayName: data.display_name });
      return {
        latitude:  parseFloat(data.latitude),
        longitude: parseFloat(data.longitude),
        radius:    data.radius || _getRadius(cityKey),
        unit:      'km',
      };
    } catch (err) {
      logger.warn('HotelBeds: Supabase geo cache lookup failed', { cityKey, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // WRITE TO Supabase geocode_cache
  // ─────────────────────────────────────────────
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

      logger.info('HotelBeds: wrote geo to Supabase cache', { cityKey });
    } catch (err) {
      logger.warn('HotelBeds: Supabase geo cache write failed', { cityKey, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // TIER 5: NOMINATIM GEOCODING
  // Only called when tiers 1-4 all miss.
  // Result is always written to Supabase for next time.
  // ─────────────────────────────────────────────
  async _geocodeViaNominatim(cityName, cityKey) {
    return _enqueueNominatim(async () => {
      try {
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
  params: {
    q:      cityName,
    format: 'json',
    limit:  1,
    // No country bias — EA cities that Nominatim misidentifies
    // (Diani, Watamu, etc.) are all covered by STATIC_GEO_OVERRIDES
    // and never reach this code path.
  },
  headers: { 'User-Agent': 'Bodrless/1.0 (travel booking platform; petermwasi32@gmail.com)' },
  timeout: 6000,
});

const result = response.data?.[0];

        if (!result) {
          logger.warn('HotelBeds: Nominatim returned no results', { cityName });
          return null;
        }

        const radius = _getRadius(cityName);
        const geo    = {
          latitude:  parseFloat(result.lat),
          longitude: parseFloat(result.lon),
          radius,
          unit: 'km',
        };

        logger.info('HotelBeds: Nominatim geocoded city', {
          cityName, lat: geo.latitude, lng: geo.longitude, radius, displayName: result.display_name,
        });

        await this._writeSupabaseCache(cityKey, cityName, geo, result.display_name);
        return geo;

      } catch (err) {
        logger.warn('HotelBeds: Nominatim geocoding failed', { cityName, error: err.message });
        return null;
      }
    });
  }

  // ─────────────────────────────────────────────
  // TIER 1: LIVE HOTELBEDS DESTINATION LOOKUP
  // Now runs first — before any geo fallback.
  // ─────────────────────────────────────────────
  async _lookupDestinationCodeLive(cityName) {
    const key = (cityName || '').toLowerCase().trim();

    try {
      const response = await axios.get(
        `${this.baseUrl}/hotel-content-api/1.0/locations/destinations`,
        {
          headers: this._headers(),
          params:  {
            fields:                'all',
            language:              'ENG',
            from:                  1,
            to:                    10,
            useSecondaryLanguages: false,
            name:                  cityName,
          },
          timeout: 8000,
        }
      );

      const destinations = response.data?.data?.destinations || [];
      if (destinations.length === 0) {
        logger.warn('HotelBeds: live destination lookup returned no results', { cityName });
        return null;
      }

      const best = destinations.find(d =>
        (d.name?.content || '').toLowerCase() === key
      ) || destinations[0];

      const code = best?.code || null;
      logger.info('HotelBeds: live destination lookup resolved', {
        cityName, code, name: best?.name?.content,
      });
      return code;

    } catch (err) {
      logger.warn('HotelBeds: live destination lookup failed', {
        cityName,
        error:  err.message,
        status: err.response?.status,
        detail: JSON.stringify(err.response?.data)?.slice(0, 300),
      });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // MAIN DESTINATION RESOLUTION — FIVE-TIER
  //
  // New order:
  //   1. HotelBeds destination code (preferred — most accurate)
  //   2. Static geo override (hand-verified, instant)
  //   3. In-memory process cache (instant)
  //   4. Supabase geocode_cache (persisted)
  //   5. Nominatim (live geocoding, writes to Supabase)
  //
  // When both a destination code AND geolocation are found,
  // BOTH are returned so search() can prefer the code while
  // still logging the geo for observability.
  // ─────────────────────────────────────────────
  async _resolveDestination(cityName) {
    if (!cityName) return { destinationCode: null, geolocation: null };

    const key = (cityName || '').toLowerCase().trim();

    // ── Tier 1: HotelBeds destination code ───────────────────────
    // Try this first. If HotelBeds knows the city by name, its own
    // destination code will return more complete inventory than a
    // radius-based geo search (which can miss hotels on the edge).
    const destinationCode = await this._lookupDestinationCodeLive(cityName);

    // ── DIAGNOSTIC LOG — remove once Maputo/Cairo are confirmed ──
    logger.info('HotelBeds: _resolveDestination code probe', {
      cityName,
      destinationCode: destinationCode ?? 'null — will use geo',
    });
    // ─────────────────────────────────────────────────────────────

    // ── Tiers 2–5: resolve geolocation (always attempt) ──────────
    // We resolve geo alongside the code so that:
    //   a) search() can log which path it used
    //   b) if the destination code returns 0 results (sandbox gap),
    //      we can fall back to geo in the same request
    let geolocation = null;

    // Tier 2: static geo override
    const staticGeo = STATIC_GEO_OVERRIDES[key];
    if (staticGeo) {
      geolocation = {
        latitude:  staticGeo.lat,
        longitude: staticGeo.lng,
        radius:    staticGeo.radius,
        unit:      'km',
      };
      logger.info('HotelBeds: static geo override hit', {
        cityName, lat: geolocation.latitude, lng: geolocation.longitude,
      });
      _memCache[key] = geolocation; // warm memory cache
    }

    // Tier 3: in-memory cache (skip if we already have geo)
    if (!geolocation && _memCache[key]) {
      geolocation = _memCache[key];
      logger.info('HotelBeds: memory geo cache hit', { cityName });
    }

    // Tier 4: Supabase geocode_cache
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

    if (!destinationCode && !geolocation) {
      logger.warn('HotelBeds: could not resolve destination by any method', { cityName });
    }

    return { destinationCode, geolocation };
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS
  // ─────────────────────────────────────────────
  async search({ destination, checkIn, checkOut, adults = 1, children = 0,
                 childAges = [], rooms = 1, nights, budget, roomType = null }) {
    if (!this.apiKey || !this.apiSecret) {
      logger.warn('HotelBeds: credentials not configured');
      return [];
    }

    const { destinationCode, geolocation } = await this._resolveDestination(destination);

    if (!destinationCode && !geolocation) {
      logger.warn('HotelBeds: could not resolve destination — returning empty results', { destination });
      return [];
    }

    const adultsPerRoom   = Math.max(1, Math.ceil(adults / rooms));
    const childrenPerRoom = Math.ceil(children / rooms);
    const pax = [];
    for (let a = 0; a < adultsPerRoom; a++) pax.push({ type: 'AD' });
    for (let c = 0; c < childrenPerRoom; c++) {
      const age = childAges[c] ?? 8;
      pax.push({ type: 'CH', age });
    }
    const occupancies = [{ rooms, adults: adultsPerRoom, children: childrenPerRoom, paxes: pax }];

    const body = {
      stay:        { checkIn, checkOut },
      occupancies,
      filter:      { packaging: false },
    };

    // Prefer destination code — more accurate inventory coverage.
    // Fall back to geolocation if no code was resolved.
    if (destinationCode) {
      body.destination = { code: destinationCode };
    } else if (geolocation) {
      body.geolocation = geolocation;
    }

    if (roomType === 'single') {
      body.filter.minRooms = 1;
      body.filter.maxRooms = 1;
    }

    // ── Search mode log — tells you exactly which path fired ─────
    logger.info('HotelBeds search request', {
      destination,
      checkIn,
      checkOut,
      adults,
      children,
      rooms,
      resolvedAs: destinationCode
        ? `destinationCode:${destinationCode}`
        : `geo:${geolocation?.latitude},${geolocation?.longitude} radius:${geolocation?.radius}km`,
      using: destinationCode ? 'destinationCode' : 'geolocation',
    });

    try {
      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/hotels`,
        body,
        { headers: this._headers(), timeout: this.searchTimeout, decompress: true }
      );

      const hotels = response.data?.hotels?.hotels || [];
      logger.info('HotelBeds search results', {
        destination,
        count:  hotels.length,
        using:  destinationCode ? 'destinationCode' : 'geolocation',
        radius: geolocation?.radius,
      });

      if (hotels.length === 0) {
        logger.warn('HotelBeds: zero results', {
          destination,
          using:           destinationCode ? 'destinationCode' : 'geolocation',
          destinationCode: destinationCode ?? 'n/a',
          radius:          geolocation?.radius ?? 'n/a',
          lat:             geolocation?.latitude ?? 'n/a',
          lng:             geolocation?.longitude ?? 'n/a',
          note:            destinationCode
            ? 'Destination code found but no inventory — may be sandbox gap'
            : 'Geo search returned nothing — may be radius too small or sandbox gap',
        });
      }

      return this._normalizeHotels(hotels, { checkIn, checkOut, nights, adults, budget });

    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data;
      if (err.code === 'ECONNABORTED') {
        logger.error(`HotelBeds search timed out after ${this.searchTimeout}ms`, { destination });
      } else {
        logger.error('HotelBeds search failed', {
          destination,
          status,
          detail: JSON.stringify(detail)?.slice(0, 200),
          error:  err.message,
        });
      }
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // CHECK RATE
  // ─────────────────────────────────────────────
  async checkRate({ rateKey }) {
    if (!this.apiKey || !this.apiSecret) return null;

    try {
      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/checkrates`,
        { rooms: [{ rateKey }] },
        { headers: this._headers(), timeout: this.timeout, decompress: true }
      );

      const hotel = response.data?.hotel;
      const room  = hotel?.rooms?.[0];
      const rate  = room?.rates?.[0];
      if (!rate) return null;

      return {
        rateKey:              rate.rateKey,
        net:                  Number(rate.net || 0),
        sellingRate:          Number(rate.sellingRate || rate.net || 0),
        rateType:             rate.rateType,
        cancellationPolicies: rate.cancellationPolicies || [],
        rateComments:         rate.rateComments || null,
      };
    } catch (err) {
      logger.error('HotelBeds checkRate failed', { error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOK
  // ─────────────────────────────────────────────
  async book({ rateKey, holder, guests, clientReference, remark }) {
    if (!this.apiKey || !this.apiSecret) throw new Error('HotelBeds credentials not configured');

    const guestRooms = guests.map(g => ({
      rateKey,
      paxes: [{
        roomId:  g.roomId || 1,
        type:    g.type === 'child' ? 'CH' : 'AD',
        name:    g.lastName,
        surname: g.firstName,
      }],
    }));

    const body = {
      holder:          { name: holder.firstName, surname: holder.lastName },
      rooms:           guestRooms,
      clientReference,
      remark,
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/bookings`,
        body,
        { headers: this._headers(), timeout: this.timeout, decompress: true }
      );

      return this._normalizeBooking(response.data?.booking);
    } catch (err) {
      logger.error('HotelBeds book failed', { error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel({ bookingRef }) {
    if (!this.apiKey || !this.apiSecret) throw new Error('HotelBeds credentials not configured');

    try {
      const response = await axios.delete(
        `${this.baseUrl}/hotel-api/1.0/bookings/${bookingRef}`,
        {
          headers:    this._headers(),
          timeout:    this.timeout,
          params:     { cancellationFlag: 'CANCELLATION' },
          decompress: true,
        }
      );

      const booking = response.data?.booking;
      return {
        bookingRef:            booking?.reference,
        status:                booking?.status,
        cancellationReference: booking?.cancellationReference || null,
      };
    } catch (err) {
      logger.error('HotelBeds cancel failed', { bookingRef, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE HOTELS
  // ─────────────────────────────────────────────
  _normalizeHotels(hotels, { checkIn, checkOut, nights, adults, budget }) {
    const results = [];

    for (const hotel of hotels) {
      const room = hotel.rooms?.[0];
      if (!room) continue;

      const rates = room.rates || [];
      if (rates.length === 0) continue;

      rates.sort((a, b) => Number(a.net || 0) - Number(b.net || 0));
      const rate = rates[0];

      const totalRate     = Number(rate.sellingRate || rate.net || 0);
      const nightCount    = nights || this._nightsBetween(checkIn, checkOut) || 1;
      const pricePerNight = nightCount > 0 ? totalRate / nightCount : totalRate;
      const isRefundable  = rate.rateType !== 'NOR';

      results.push({
        supplier:             'hotelbeds',
        hotelCode:            String(hotel.code),
        name:                 hotel.name,
        stars:                hotel.categoryCode ? this._parseStars(hotel.categoryCode) : null,
        rating:               hotel.reviewScore || null,
        location:             hotel.zoneName || hotel.destinationName || null,
        latitude:             hotel.coordinates?.latitude || null,
        longitude:            hotel.coordinates?.longitude || null,
        images:               hotel.imageUrls || [],
        checkIn,
        checkOut,
        nights:               nightCount,
        pricePerNight:        Math.round(pricePerNight * 100) / 100,
        totalRate:            Math.round(totalRate * 100) / 100,
        currency:             'EUR',
        rateKey:              rate.rateKey,
        rateType:             rate.rateType,
        isRefundable,
        cancellationPolicies: rate.cancellationPolicies || [],
        rateComments:         rate.rateComments || null,
        mealPlan:             this._normalizeMealPlan(rate.boardCode),
        boardType:            rate.boardCode,
        promotions:           rate.promotions || [],
        rooms:                rate.rooms || 1,
        adults,
        supplier_tag:         rate.rateKey ? rate.rateKey.slice(0, 20) : null,
      });
    }

    return results;
  }

  _normalizeBooking(booking) {
    if (!booking) return null;
    const room = booking.hotel?.rooms?.[0];
    const rate = room?.rates?.[0];
    return {
      supplierBookingReference: booking.reference,
      status:                   booking.status,
      clientReference:          booking.clientReference,
      checkIn:                  booking.hotel?.checkIn,
      checkOut:                 booking.hotel?.checkOut,
      totalRate:                Number(booking.totalNet || booking.totalSellingRate || 0),
      currency:                 'EUR',
      rateKey:                  rate?.rateKey || null,
      cancellationPolicies:     rate?.cancellationPolicies || [],
      rateComments:             rate?.rateComments || null,
      hotelName:                booking.hotel?.name || null,
      hotelAddress:             booking.hotel?.address || null,
      hotelPhone:               booking.hotel?.phoneNumber || null,
      hotelEmail:               booking.hotel?.email || null,
      supplier_tag:             rate?.rateKey ? rate.rateKey.slice(0, 20) : null,
    };
  }

  _normalizeMealPlan(boardCode) {
    const plans = {
      'RO':  'Room Only',       'BB':  'Bed & Breakfast',
      'HB':  'Half Board',      'FB':  'Full Board',
      'AI':  'All Inclusive',   'UAI': 'Ultra All Inclusive',
      'SC':  'Self Catering',
    };
    return plans[boardCode] || boardCode || null;
  }

  _parseStars(categoryCode) {
    const match = String(categoryCode).match(/(\d)/);
    return match ? parseInt(match[1], 10) : null;
  }

  _nightsBetween(checkIn, checkOut) {
    if (!checkIn || !checkOut) return null;
    const diff = new Date(checkOut) - new Date(checkIn);
    return Math.round(diff / (1000 * 60 * 60 * 24));
  }
}

module.exports = new HotelBedsAdapter();