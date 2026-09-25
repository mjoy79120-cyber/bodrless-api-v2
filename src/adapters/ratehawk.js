/**
 * RATEHAWK ADAPTER  (ETG WorldOTA B2B v3)
 * ─────────────────────────────────────────────────────────────
 * Search and book hotels via RateHawk / Emerging Travel Group.
 *
 * AUTH: HTTP Basic — RATEHAWK_KEY_ID : RATEHAWK_TOKEN
 *
 * RATE LIMITS (ETG enforced):
 *   search/serp/region/ — 10 requests per 60 seconds
 *   search/serp/geo/    — 10 requests per 60 seconds
 *   search/multicomplete/ — 30 requests per 60 seconds
 *   booking endpoints   — 30 requests per 60 seconds
 *
 * BOOKING FLOW (ETG required order):
 *   1. search()        — SERP: get hotels + search_hash / match_hash
 *   2. getHotelPage()  — HP:   get h-... book_hash for chosen hotel
 *   3. prebook()       — Confirms availability; h-... → p-... hash
 *   4. book()          — form → finish → poll for final status
 *
 * PASSENGER SHAPING:
 *   Use passengerMapper.toRateHawkRooms() before calling book().
 *   Do NOT pass raw WhatsApp passenger objects directly.
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const axios      = require('axios');
const { logger } = require('../utils/logger');
const supabase   = require('../utils/supabase');

// ─────────────────────────────────────────────
// SERP RATE LIMITER
// ETG allows 10 SERP requests per 60 seconds.
// We enforce 9/60s to give a safety margin.
// ─────────────────────────────────────────────
const SERP_MAX_PER_WINDOW = 9;
const SERP_WINDOW_MS      = 60000;

const _serpTimestamps = [];
const _serpQueue      = [];
let   _serpDraining   = false;

function _enqueueSerpCall(fn) {
  return new Promise((resolve, reject) => {
    _serpQueue.push({ fn, resolve, reject });
    if (!_serpDraining) _drainSerpQueue();
  });
}

async function _drainSerpQueue() {
  _serpDraining = true;
  while (_serpQueue.length > 0) {
    const now = Date.now();
    while (_serpTimestamps.length > 0 && now - _serpTimestamps[0] > SERP_WINDOW_MS) {
      _serpTimestamps.shift();
    }
    if (_serpTimestamps.length < SERP_MAX_PER_WINDOW) {
      const { fn, resolve, reject } = _serpQueue.shift();
      _serpTimestamps.push(Date.now());
      try { resolve(await fn()); } catch (err) { reject(err); }
    } else {
      const waitMs = SERP_WINDOW_MS - (Date.now() - _serpTimestamps[0]) + 100;
      logger.info('RateHawk: SERP rate limit reached — waiting', {
        waitMs, queued: _serpQueue.length,
      });
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  _serpDraining = false;
}

// ─────────────────────────────────────────────
// STATIC GEO OVERRIDES
// ─────────────────────────────────────────────
const STATIC_GEO_OVERRIDES = {
  'diani':            { lat: -4.2833,  lng: 39.5667,  radius: 30 },
  'diani beach':      { lat: -4.2833,  lng: 39.5667,  radius: 30 },
  'ukunda':           { lat: -4.2833,  lng: 39.5667,  radius: 30 },
  'watamu':           { lat: -3.3667,  lng: 40.0167,  radius: 30 },
  'malindi':          { lat: -3.2175,  lng: 40.1169,  radius: 30 },
  'lamu':             { lat: -2.2686,  lng: 40.9020,  radius: 20 },
  'kilifi':           { lat: -3.6333,  lng: 39.8500,  radius: 30 },
  'shimba hills':     { lat: -4.2167,  lng: 39.3833,  radius: 25 },
  'nairobi':          { lat: -1.2921,  lng: 36.8219,  radius: 25 },
  'naivasha':         { lat: -0.7167,  lng: 36.4333,  radius: 50 },
  'nakuru':           { lat: -0.3031,  lng: 36.0800,  radius: 40 },
  'nanyuki':          { lat:  0.0167,  lng: 37.0667,  radius: 40 },
  'nyeri':            { lat: -0.4167,  lng: 36.9500,  radius: 30 },
  'thika':            { lat: -1.0333,  lng: 37.0833,  radius: 25 },
  'mombasa':          { lat: -4.0435,  lng: 39.6682,  radius: 20 },
  'masai mara':       { lat: -1.5167,  lng: 35.1500,  radius: 80 },
  'maasai mara':      { lat: -1.5167,  lng: 35.1500,  radius: 80 },
  'amboseli':         { lat: -2.6527,  lng: 37.2606,  radius: 60 },
  'tsavo':            { lat: -3.3667,  lng: 38.5000,  radius: 80 },
  'samburu':          { lat:  0.6167,  lng: 37.5333,  radius: 60 },
  'lake nakuru':      { lat: -0.3667,  lng: 36.0833,  radius: 40 },
  'ol pejeta':        { lat:  0.0167,  lng: 36.9333,  radius: 40 },
  'aberdare':         { lat: -0.4000,  lng: 36.7333,  radius: 50 },
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
  'kampala':          { lat:  0.3476,  lng: 32.5825,  radius: 25 },
  'entebbe':          { lat:  0.0644,  lng: 32.4600,  radius: 20 },
  'bwindi':           { lat: -1.0500,  lng: 29.6667,  radius: 40 },
  'lake victoria':    { lat: -1.0000,  lng: 33.0000,  radius: 50 },
  'kigali':           { lat: -1.9441,  lng: 30.0619,  radius: 20 },
  'akagera':          { lat: -1.9333,  lng: 30.7500,  radius: 50 },
  'addis ababa':      { lat:  9.0222,  lng: 38.7468,  radius: 25 },
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
  'dubai':            { lat: 25.2048,  lng: 55.2708,  radius: 20 },
  'abu dhabi':        { lat: 24.4539,  lng: 54.3773,  radius: 20 },
  'doha':             { lat: 25.2854,  lng: 51.5310,  radius: 20 },
  'muscat':           { lat: 23.5880,  lng: 58.3829,  radius: 20 },
  'istanbul':         { lat: 41.0082,  lng: 28.9784,  radius: 20 },
  'amman':            { lat: 31.9454,  lng: 35.9284,  radius: 20 },
  'bali':             { lat: -8.4095,  lng: 115.1889, radius: 30 },
  'phuket':           { lat:  7.8804,  lng: 98.3923,  radius: 30 },
  'bangkok':          { lat: 13.7563,  lng: 100.5018, radius: 20 },
  'singapore':        { lat:  1.3521,  lng: 103.8198, radius: 15 },
  'delhi':            { lat: 28.6139,  lng: 77.2090,  radius: 20 },
  'mumbai':           { lat: 19.0760,  lng: 72.8777,  radius: 20 },
  'goa':              { lat: 15.2993,  lng: 74.1240,  radius: 30 },
  'tokyo':            { lat: 35.6762,  lng: 139.6503, radius: 20 },
  'hong kong':        { lat: 22.3193,  lng: 114.1694, radius: 15 },
  'london':           { lat: 51.5074,  lng: -0.1278,  radius: 20 },
  'paris':            { lat: 48.8566,  lng:  2.3522,  radius: 15 },
  'amsterdam':        { lat: 52.3676,  lng:  4.9041,  radius: 15 },
  'rome':             { lat: 41.9028,  lng: 12.4964,  radius: 15 },
  'barcelona':        { lat: 41.3851,  lng:  2.1734,  radius: 15 },
  'madrid':           { lat: 40.4168,  lng: -3.7038,  radius: 15 },
  'new york':         { lat: 40.7128,  lng: -74.0060, radius: 15 },
  'miami':            { lat: 25.7617,  lng: -80.1918, radius: 15 },
  'cancun':           { lat: 21.1619,  lng: -86.8515, radius: 20 },
  'sydney':           { lat: -33.8688, lng: 151.2093, radius: 20 },
  'melbourne':        { lat: -37.8136, lng: 144.9631, radius: 20 },
  // Sandbox test coordinates (ETG documented)
  'los angeles':      { lat: 34.077194, lng: -118.36068, radius: 30 },
};

// ─────────────────────────────────────────────
// NOMINATIM RATE LIMITER  (1 req/sec per OSM policy)
// ─────────────────────────────────────────────
const _memCache          = {};
let   _nominatimLastCall = 0;
const _nominatimQueue    = [];
let   _nominatimRunning  = false;

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
// CONSTANTS
// ─────────────────────────────────────────────

// Errors that mean the booking is definitively dead — stop polling.
const TERMINAL_ERRORS = new Set([
  'soldout', 'book_limit', 'booking_finish_did_not_succeed',
  'provider', '3ds', 'block', 'charge', 'not_allowed',
]);

// Errors on /booking/form/ that mean stop immediately (don't retry).
const TERMINAL_FORM_ERRORS = new Set([
  'contract_mismatch', 'hotel_not_found', 'insufficient_b2b_balance',
  'reservation_is_not_allowed', 'rate_not_found', 'sandbox_restriction',
]);

// Errors on /booking/finish/ that mean stop immediately.
const TERMINAL_FINISH_ERRORS = new Set([
  'booking_form_expired', 'rate_not_found', 'return_path_required',
  'email', 'incorrect_guests_number', 'incorrect_children_data',
  'incorrect_rooms_number', 'unauthorized_group_booking',
]);

const MEAL_PLAN_MAP = {
  'nomeal':        'Room Only',
  'breakfast':     'Bed & Breakfast',
  'half_board':    'Half Board',
  'full_board':    'Full Board',
  'all_inclusive': 'All Inclusive',
};

function _normalizeMealPlan(mealCode) {
  if (!mealCode) return null;
  return MEAL_PLAN_MAP[mealCode.toLowerCase()] || mealCode;
}

// ─────────────────────────────────────────────
// ADAPTER
// ─────────────────────────────────────────────
class RateHawkAdapter {

  constructor() {
    this.keyId          = process.env.RATEHAWK_KEY_ID;
    this.token          = process.env.RATEHAWK_TOKEN;
    this.isSandbox = process.env.RATEHAWK_SANDBOX === 'true';
this.baseUrl   = this.isSandbox
  ? 'https://api-sandbox.ratehawk.com/api/b2b/v3'
  : 'https://api.ratehawk.com/api/b2b/v3';
    this.timeout        = Number(process.env.RATEHAWK_TIMEOUT_MS)         || 20000;
    this.searchTimeout  = Number(process.env.RATEHAWK_SEARCH_TIMEOUT_MS)  || 18000;
    this.prebookTimeout = Number(process.env.RATEHAWK_PREBOOK_TIMEOUT_MS) || 60000;
    this.pollAttempts   = Number(process.env.RATEHAWK_POLL_ATTEMPTS)      || 30;
    this.pollIntervalMs = Number(process.env.RATEHAWK_POLL_INTERVAL_MS)   || 5000;
  }

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

  async _post(path, body, timeoutMs) {
    const url = `${this.baseUrl}${path}`;
    console.log('RateHawk request URL:', url);
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

  // ─────────────────────────────────────────────
  // GEO RESOLUTION — FIVE TIERS
  // ─────────────────────────────────────────────
  async _lookupSupabaseCache(cityKey) {
    try {
      const { data, error } = await supabase
        .from('geocode_cache')
        .select('latitude, longitude, radius, display_name')
        .eq('city_key', cityKey)
        .maybeSingle();
      if (error || !data) return null;
      logger.info('RateHawk: Supabase geo cache hit', { cityKey });
      return {
        latitude:  parseFloat(data.latitude),
        longitude: parseFloat(data.longitude),
        radius:    data.radius || 30,
      };
    } catch (err) {
      logger.warn('RateHawk: Supabase geo cache lookup failed', { cityKey, error: err.message });
      return null;
    }
  }

  async _writeSupabaseCache(cityKey, cityName, geo, displayName) {
    try {
      await supabase.from('geocode_cache').upsert({
        city_key:     cityKey,
        city_name:    cityName,
        latitude:     geo.latitude,
        longitude:    geo.longitude,
        radius:       geo.radius,
        display_name: displayName || cityName,
        cached_at:    new Date().toISOString(),
      }, { onConflict: 'city_key' });
    } catch (err) {
      logger.warn('RateHawk: Supabase geo cache write failed', { cityKey, error: err.message });
    }
  }

  async _geocodeViaNominatim(cityName, cityKey) {
    return _enqueueNominatim(async () => {
      try {
        const response = await axios.get('https://nominatim.openstreetmap.org/search', {
          params:  { q: cityName, format: 'json', limit: 1 },
          headers: { 'User-Agent': 'Bodrless/1.0 (travel booking platform; petermwasi32@gmail.com)' },
          timeout: 6000,
        });
        const result = response.data?.[0];
        if (!result) return null;
        const radius = STATIC_GEO_OVERRIDES[cityKey]?.radius || 30;
        const geo    = { latitude: parseFloat(result.lat), longitude: parseFloat(result.lon), radius };
        await this._writeSupabaseCache(cityKey, cityName, geo, result.display_name);
        return geo;
      } catch (err) {
        logger.warn('RateHawk: Nominatim geocoding failed', { cityName, error: err.message });
        return null;
      }
    });
  }

  async _lookupRegionId(cityName) {
    if (!this._hasCredentials()) return null;
    try {
      const data    = await this._post('/search/multicomplete/', { query: cityName, language: 'en' }, 6000);
      const regions = data?.data?.regions || [];
      const cities  = data?.data?.cities  || [];
      const matches = [...regions, ...cities];
      if (matches.length === 0) return null;
      const key   = cityName.toLowerCase().trim();
      const exact = matches.find(m => (m.name || '').toLowerCase() === key);
      const best  = exact || matches[0];
      logger.info('RateHawk: region lookup resolved', { cityName, regionId: best.id, name: best.name });
      return best.id ? String(best.id) : null;
    } catch (err) {
      logger.warn('RateHawk: region lookup failed', { cityName, error: err.message });
      return null;
    }
  }

  async _resolveDestination(cityName) {
    if (!cityName) return { regionId: null, geolocation: null };
    const key = cityName.toLowerCase().trim();

    const regionId = await this._lookupRegionId(cityName);

    let geolocation = null;

    const staticGeo = STATIC_GEO_OVERRIDES[key];
    if (staticGeo) {
      geolocation = { latitude: staticGeo.lat, longitude: staticGeo.lng, radius: staticGeo.radius };
      logger.info('RateHawk: static geo override hit', { cityName });
      _memCache[key] = geolocation;
    }

    if (!geolocation && _memCache[key]) {
      geolocation = _memCache[key];
    }

    if (!geolocation) {
      const supabaseGeo = await this._lookupSupabaseCache(key);
      if (supabaseGeo) { geolocation = supabaseGeo; _memCache[key] = supabaseGeo; }
    }

    if (!geolocation) {
      const nominatimGeo = await this._geocodeViaNominatim(cityName, key);
      if (nominatimGeo) { geolocation = nominatimGeo; _memCache[key] = nominatimGeo; }
    }

    logger.info('RateHawk: _resolveDestination', {
      cityName,
      regionId:    regionId ?? 'null — will use geo',
      geoResolved: !!geolocation,
    });

    return { regionId, geolocation };
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS  (SERP)
  // ─────────────────────────────────────────────
  async search(params) {
    if (!this._hasCredentials()) {
      logger.warn('RateHawk: credentials not configured — skipping');
      return [];
    }
    return _enqueueSerpCall(() => this._doSearch(params));
  }

  async _doSearch({
    destination, checkIn, checkOut,
    adults = 1, children = 0, childAges = [], rooms = 1,
    nights, budget, residency,
    departureDate, returnDate,
  }) {
    const resolvedCheckIn  = checkIn  || departureDate;
    const resolvedCheckOut = checkOut || returnDate;
    const resolvedResidency = (residency || 'ke').toLowerCase();

    const { regionId, geolocation } = await this._resolveDestination(destination);

    if (!regionId && !geolocation) {
      logger.warn('RateHawk: could not resolve destination', { destination });
      return [];
    }

    // Build ETG guests array — children as array of integer ages per room
    const adultsPerRoom = Math.max(1, Math.ceil(adults / rooms));
    const childrenSlice = childAges.slice();

    const guests = [];
    for (let r = 0; r < rooms; r++) {
      const roomChildAges = childrenSlice.splice(0, Math.ceil((childAges.length - r) / rooms));
      guests.push({
        adults:   adultsPerRoom,
        children: roomChildAges,
      });
    }

    const body = {
      checkin:   resolvedCheckIn,
      checkout:  resolvedCheckOut,
      guests,
      language:  'en',
      currency:  'USD',
      residency: resolvedResidency,
    };

    if (regionId) {
      body.region_id = Number(regionId);
    } else {
      body.latitude  = geolocation.latitude;
      body.longitude = geolocation.longitude;
      body.radius    = geolocation.radius || 30;
    }

    const endpoint = regionId ? '/search/serp/region/' : '/search/serp/geo/';

    logger.info('RateHawk SERP request', {
      destination, checkIn: resolvedCheckIn, checkOut: resolvedCheckOut,
      adults, children, rooms, residency: resolvedResidency, endpoint,
      resolvedAs: regionId
        ? `regionId:${regionId}`
        : `geo:${geolocation?.latitude},${geolocation?.longitude} radius:${geolocation?.radius}km`,
    });

    try {
      const data   = await this._post(endpoint, body, this.searchTimeout);
      const hotels = data?.data?.hotels || [];

      logger.info('RateHawk SERP results', {
        destination, count: hotels.length,
        resolvedAs: regionId ? `regionId:${regionId}` : 'geo',
      });

      if (hotels.length === 0) {
        logger.warn('RateHawk: zero results', {
          destination,
          note: 'Sandbox only returns results for region_ids 2011/2395/2734/6053839 and specific geo coords',
        });
      }

      return this._normalizeHotels(hotels, {
        checkIn: resolvedCheckIn, checkOut: resolvedCheckOut, nights, adults, budget, rooms,
      });

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
  // HOTEL PAGE  (Step 2 of booking flow)
  // ─────────────────────────────────────────────
  async getHotelPage({ hotelId, checkIn, checkOut, guests, residency = 'ke' }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');

    const isNumeric = /^\d+$/.test(String(hotelId));
    const body = {
      checkin:   checkIn,
      checkout:  checkOut,
      guests,
      language:  'en',
      currency:  'USD',
      residency: residency.toLowerCase(),
    };
    if (isNumeric) {
      body.hid = Number(hotelId);
    } else {
      body.id = hotelId;
    }

    logger.info('RateHawk: getHotelPage', { hotelId, checkIn, checkOut });

    const data   = await this._post('/search/hp/', body, this.searchTimeout);
    const hotels = data?.data?.hotels || [];

    if (hotels.length === 0) {
      throw new Error(`RateHawk hotelpage: no results for hotel ${hotelId}`);
    }

    return hotels[0];
  }

  // ─────────────────────────────────────────────
  // PREBOOK  (Step 3 of booking flow)
  //
  // FIX: newBookHash is at data.data.hotels[0].rates[0].book_hash
  // (same nested shape as HP response — confirmed against ETG docs
  // and sandbox response example in doc index 10).
  // The p-... hash lives inside the rates array, not at top level.
  // FIX: field name is "hash" not "book_hash".
  // FIX: timeout is 60s minimum per ETG requirement.
  // ─────────────────────────────────────────────
  async prebook({ bookHash }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');

    if (!bookHash?.startsWith('h-')) {
      logger.warn('RateHawk prebook: expected h-... hash from HP step', {
        bookHash: bookHash?.slice(0, 20),
      });
    }

    const data = await this._post('/hotel/prebook/', {
      hash:                   bookHash,
      price_increase_percent: Number(process.env.RATEHAWK_PRICE_INCREASE_PCT) || 2,
    }, this.prebookTimeout);

    // ETG prebook response shape (from sandbox doc, index 10):
    // { data: { hotels: [{ rates: [{ book_hash: 'p-...', ... }] }], changes: { price_changed } } }
    const hotels = data?.data?.hotels || [];
    if (hotels.length === 0) throw new Error('RateHawk prebook: empty hotels in response');

    const rate        = hotels[0]?.rates?.[0];
    const newBookHash = rate?.book_hash;

    if (!newBookHash?.startsWith('p-')) {
      throw new Error(
        `RateHawk prebook: expected p-... hash in rates[0].book_hash, got "${newBookHash?.slice(0, 20)}". ` +
        'Check ETG prebook response structure.'
      );
    }

    const paymentType  = rate.payment_options?.payment_types?.find(pt => pt.type === 'deposit')
                      || rate.payment_options?.payment_types?.[0];
    const priceChanged = data?.data?.changes?.price_changed || false;

    logger.info('RateHawk prebook success', {
      oldHash:      bookHash.slice(0, 20),
      newHash:      newBookHash.slice(0, 20),
      priceChanged,
      showAmount:   paymentType?.show_amount,
    });

    if (priceChanged) {
      logger.warn('RateHawk prebook: price changed — must notify agency before proceeding', {
        newAmount: paymentType?.show_amount,
        currency:  paymentType?.show_currency_code,
      });
    }

    return {
      bookHash:     newBookHash,
      netPrice:     Number(paymentType?.amount      || 0),
      showPrice:    Number(paymentType?.show_amount  || 0),
      currency:     paymentType?.show_currency_code || paymentType?.currency_code || 'USD',
      priceChanged,
      roomName:     rate.room_name || null,
      mealPlan:     _normalizeMealPlan(rate.meal),
      freeCancellationBefore: paymentType?.cancellation_penalties?.free_cancellation_before || null,
      excludedTaxes: (paymentType?.tax_data?.taxes || [])
        .filter(t => !t.included_by_supplier)
        .map(t => ({ name: t.name, amount: t.amount, currency: t.currency_code })),
    };
  }

  // ─────────────────────────────────────────────
  // BOOKING FORM  (Step 4a)
  //
  // FIX: user_ip is required per ETG docs.
  // FIX: book_hash must be the p-... hash from prebook.
  // ─────────────────────────────────────────────
  async _openBookingForm({ partnerOrderId, bookHash, userIp }) {
    if (!bookHash?.startsWith('p-')) {
      throw new Error(
        `RateHawk booking form: expected p-... hash, got "${bookHash?.slice(0, 20)}"`
      );
    }

    const data = await this._post('/hotel/order/booking/form/', {
      partner_order_id: partnerOrderId,
      book_hash:        bookHash,
      language:         'en',
      user_ip:          userIp || '0.0.0.0',
    });

    if (data?.error && TERMINAL_FORM_ERRORS.has(data.error)) {
      throw new Error(`RateHawk booking form terminal error: ${data.error}`);
    }

    // Handle double_booking_form — caller should retry with new partner_order_id
    if (data?.error === 'double_booking_form') {
      const err = new Error('RateHawk booking form: double_booking_form');
      err.code = 'DOUBLE_BOOKING_FORM';
      throw err;
    }

    const formData     = data?.data || {};
    const paymentTypes = formData.payment_types || [];

    logger.info('RateHawk: booking form opened', {
      partnerOrderId,
      orderId:        formData.order_id,
      paymentOptions: paymentTypes.map(pt => `${pt.type}:${pt.amount}${pt.currency_code}`),
    });

    return formData;
  }

  // ─────────────────────────────────────────────
  // BOOKING FINISH  (Step 4b)
  //
  // FIX: bookHash is now destructured and included in body.
  // FIX: rooms structure is correct — array of { guests: [...] }.
  // FIX: children need is_child:true AND age (integer).
  //   The age field alone does NOT mark a guest as a child (ETG docs).
  // FIX: payment_type field name (not "payment").
  // FIX: at least one real adult per room required.
  //
  // CALLER RESPONSIBILITY:
  //   guestsByRoom must come from passengerMapper.toRateHawkRooms()
  //   so that type/age/isChild are already in ETG format.
  // ─────────────────────────────────────────────
  async _finishBooking({ partnerOrderId, bookHash, holder, guestsByRoom, formData }) {
    // bookHash is now correctly destructured and used
    if (!bookHash?.startsWith('p-')) {
      throw new Error(
        `RateHawk finish: expected p-... hash, got "${bookHash?.slice(0, 20)}"`
      );
    }

    // guestsByRoom: array of arrays, one per room
    // Each inner array contains ETG guest objects from passengerMapper
    const rooms = (guestsByRoom || [[{
      first_name: holder.firstName,
      last_name:  holder.lastName,
    }]]).map(roomGuests => ({ guests: roomGuests }));

    // Match payment exactly to what the form returned
    const formPayment = formData?.payment_types?.find(pt => pt.type === 'deposit')
                     || formData?.payment_types?.[0];

    const body = {
      language: 'en',
      partner: {
        partner_order_id: partnerOrderId,
        comment:          'Bodrless booking',
      },
      payment_type: {
        type:          'deposit',
        amount:        formPayment?.amount        || '0',
        currency_code: formPayment?.currency_code || 'USD',
      },
      rooms,
      user: {
        // B2B: ETG expects a fixed corporate email, not guest email
        email:   process.env.RATEHAWK_CORPORATE_EMAIL || holder.email,
        phone:   holder.phone || null,
        comment: null,
      },
    };

    // supplier_data: required if ETG contract mandates it
    if (holder.firstName && holder.lastName) {
      body.supplier_data = {
        first_name_original: holder.firstName,
        last_name_original:  holder.lastName,
        phone:               holder.phone || null,
        email:               holder.email || process.env.RATEHAWK_CORPORATE_EMAIL,
      };
    }

    return await this._post('/hotel/order/booking/finish/', body);
  }

  // ─────────────────────────────────────────────
  // GET BOOKING STATUS  (Step 4c — poll this)
  //
  // FIX: status and orderId live at data.data, not data.
  // Confirmed against ETG docs (index 16):
  //   { data: { partner_order_id, percent }, status: 'ok'|'error'|'processing', error: null }
  // The top-level `status` field IS the booking status.
  // The top-level `error` field IS the error code when status === 'error'.
  // data.data.partner_order_id is the order reference.
  // ─────────────────────────────────────────────
  async getBookingStatus({ partnerOrderId }) {
    const response = await this._post('/hotel/order/booking/finish/status/', {
      partner_order_id: partnerOrderId,
    });

    // ETG response shape:
    // { status: 'ok'|'processing'|'error'|'3ds', error: 'soldout'|null|..., data: { partner_order_id, percent } }
    // Top-level status and error are what we act on.
    return {
      status:    response?.status    || 'unknown',
      errorCode: response?.error     || null,
      orderId:   response?.data?.partner_order_id || partnerOrderId,
    };
  }

  // ─────────────────────────────────────────────
  // BOOK  (orchestrates form → finish → poll)
  //
  // IMPORTANT: guestsByRoom must be pre-shaped via
  // passengerMapper.toRateHawkRooms() before calling this.
  // ─────────────────────────────────────────────
  async book({ partnerOrderId, bookHash, holder, guestsByRoom, userIp }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');

    if (!bookHash?.startsWith('p-')) {
      throw new Error(
        `RateHawk book: expected p-... hash from prebook, got "${bookHash?.slice(0, 20)}". ` +
        'Call prebook() first.'
      );
    }

    logger.info('RateHawk: opening booking form', { partnerOrderId });
    const formData = await this._openBookingForm({ partnerOrderId, bookHash, userIp });

    logger.info('RateHawk: sending booking finish', { partnerOrderId });
    const finishResult = await this._finishBooking({
      partnerOrderId,
      bookHash,      // FIX: now correctly passed through
      holder,
      guestsByRoom,
      formData,
    });

    // Terminal finish errors — stop immediately
    if (finishResult?.error && TERMINAL_FINISH_ERRORS.has(finishResult.error)) {
      throw new Error(`RateHawk booking finish failed: ${finishResult.error}`);
    }

    // Poll status until confirmed, failed, or timeout
    for (let attempt = 1; attempt <= this.pollAttempts; attempt++) {
      await new Promise(r => setTimeout(r, this.pollIntervalMs));

      const { status, orderId, errorCode } = await this.getBookingStatus({ partnerOrderId });
      logger.info('RateHawk: booking poll', { partnerOrderId, attempt, status, errorCode, orderId });

      if (status === 'ok') {
        logger.info('RateHawk: booking confirmed', { partnerOrderId, orderId });
        return { status: 'confirmed', partnerOrderId, supplierOrderId: orderId, bookHash };
      }

      if (TERMINAL_ERRORS.has(status) || TERMINAL_ERRORS.has(errorCode)) {
        throw new Error(`RateHawk booking failed: ${errorCode || status}`);
      }

      // status: processing | timeout | unknown | 5xx → keep polling
    }

    // ETG: always send a final status request at the last second
    const { status: finalStatus, orderId, errorCode } = await this.getBookingStatus({ partnerOrderId });
    if (finalStatus === 'ok') {
      return { status: 'confirmed', partnerOrderId, supplierOrderId: orderId, bookHash };
    }

    logger.warn('RateHawk: poll timed out — awaiting_confirmation', { partnerOrderId });
    return { status: 'awaiting_confirmation', partnerOrderId, supplierOrderId: null, bookHash };
  }

  // ─────────────────────────────────────────────
  // GET ORDER  (post-booking only, not for status checks)
  // ETG: wait 1-2 min after confirmation before calling this
  // ─────────────────────────────────────────────
  async getOrder({ partnerOrderId }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');
    const data = await this._post('/hotel/order/info/', {
      ordering:   { ordering_type: 'desc', ordering_by: 'created_at' },
      pagination: { page_size: 1, page_number: 1 },
      search:     { partner_data: { partner_order_id: partnerOrderId } },
      language:   'en',
    });
    return data?.data?.orders?.[0] || null;
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel({ partnerOrderId }) {
    if (!this._hasCredentials()) throw new Error('RateHawk credentials not configured');
    try {
      const data   = await this._post('/hotel/order/cancel/', { partner_order_id: partnerOrderId });
      const result = data?.data;
      logger.info('RateHawk: cancellation result', { partnerOrderId, result });
      return {
        partnerOrderId,
        status:         data?.status || 'cancelled',
        amountRefunded: result?.amount_refunded?.amount ? Number(result.amount_refunded.amount) : 0,
        amountPayable:  result?.amount_payable?.amount  ? Number(result.amount_payable.amount)  : 0,
        currency:       result?.amount_refunded?.currency_code || 'USD',
      };
    } catch (err) {
      logger.error('RateHawk cancel failed', { partnerOrderId, error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE HOTELS
  // ─────────────────────────────────────────────
  _normalizeHotels(hotels, { checkIn, checkOut, nights, adults, budget, rooms = 1 }) {
    const results = [];

    for (const hotel of hotels) {
      const rates = hotel.rates || [];
      if (rates.length === 0) continue;

      rates.sort((a, b) => {
        const priceA = Number(a.payment_options?.payment_types?.[0]?.show_amount || 0);
        const priceB = Number(b.payment_options?.payment_types?.[0]?.show_amount || 0);
        return priceA - priceB;
      });

      const rate        = rates[0];
      const paymentType = rate.payment_options?.payment_types?.find(pt => pt.type === 'deposit')
                       || rate.payment_options?.payment_types?.[0];

      const totalRate     = Number(paymentType?.show_amount || paymentType?.amount || 0);
      const nightCount    = nights || this._nightsBetween(checkIn, checkOut) || 1;
      const pricePerNight = nightCount > 0 ? totalRate / nightCount : totalRate;
      const currency      = paymentType?.show_currency_code || paymentType?.currency_code || 'USD';

      const freeCancellationBefore = paymentType?.cancellation_penalties?.free_cancellation_before || null;
      const isRefundable           = !!freeCancellationBefore;

      const excludedTaxes = (paymentType?.tax_data?.taxes || [])
        .filter(t => !t.included_by_supplier)
        .map(t => ({ name: t.name, amount: t.amount, currency: t.currency_code }));

      const cancellationPolicies = paymentType?.cancellation_penalties?.policies || [];

      const images = (hotel.images || [])
        .map(img => typeof img === 'string' ? img : img?.url || '')
        .filter(Boolean)
        .slice(0, 10);

      results.push({
        supplier:             'ratehawk',
        hotelCode:            String(hotel.hid || hotel.id),
        hotelId:              hotel.hid  ? Number(hotel.hid) : null,
        hotelSlug:            hotel.id   || null,
        name:                 hotel.name,
        stars:                hotel.star_rating ? Number(hotel.star_rating) : null,
        // Use actual rating float if available; fall back to filter tag floor
        rating:               hotel.rating
                                ? Number(hotel.rating)
                                : (hotel.serp_filters?.includes('rating_above_8') ? 8 : null),
        location:             hotel.region?.name || hotel.area?.name || null,
        latitude:             hotel.latitude  || hotel.coordinates?.latitude  || null,
        longitude:            hotel.longitude || hotel.coordinates?.longitude || null,
        images,
        checkIn,
        checkOut,
        nights:               nightCount,
        pricePerNight:        Math.round(pricePerNight * 100) / 100,
        totalRate:            Math.round(totalRate     * 100) / 100,
        currency,
        rateKey:              rate.book_hash,
        matchHash:            rate.match_hash || null,
        rateType:             isRefundable ? 'REF' : 'NOR',
        isRefundable,
        freeCancellationBefore,
        excludedTaxes,
        cancellationPolicies,
        rateComments:         _normalizeMealPlan(rate.meal),
        mealPlan:             _normalizeMealPlan(rate.meal),
        boardType:            rate.meal || null,
        roomName:             rate.room_name || null,
        promotions:           [],
        rooms,
        adults,
        supplier_tag:         rate.book_hash ? rate.book_hash.slice(0, 20) : null,
      });
    }

    return results;
  }

  _nightsBetween(checkIn, checkOut) {
    if (!checkIn || !checkOut) return null;
    return Math.round((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24));
  }
}

module.exports = new RateHawkAdapter();