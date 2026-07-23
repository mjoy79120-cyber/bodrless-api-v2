/**
 * HOTELBEDS ADAPTER
 * ─────────────────────────────────────────────────────────────
 * Search and book hotels via HotelBeds (APItude API).
 *
 * DESTINATION RESOLUTION (three-tier):
 *
 * Tier 1: Process-level cache — instant, zero network cost.
 *         Keyed by normalized city name. Resets on deploy (fine,
 *         destination coords don't change).
 *
 * Tier 2: Nominatim (OpenStreetMap) geocoding — free, no API key,
 *         returns lat/lng for any city on earth. Result cached in
 *         Tier 1 so the penalty only hits once per city per deploy.
 *
 * Tier 3: HotelBeds live /locations/destinations lookup — used when
 *         Nominatim fails (rare). Country-code filtered query.
 *
 * NOTE: All static CITY_COORDINATES and hardcoded destination code
 * maps have been removed. Nominatim covers every city worldwide.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

// Process-level geo cache — keyed by normalized city name.
// Stores { latitude, longitude, radius, unit } objects.
// Resets on deploy which is fine — coords don't change.
const _geoCache = {};

// Process-level HotelBeds destination code cache — keyed by normalized city name.
const _destinationCodeCache = {};

class HotelBedsAdapter {

  constructor() {
    this.apiKey        = process.env.HOTELBEDS_API_KEY;
    this.apiSecret     = process.env.HOTELBEDS_API_SECRET || process.env.HOTELBEDS_SECRET;
    this.baseUrl       = process.env.HOTELBEDS_BASE_URL || 'https://api.test.hotelbeds.com';
    this.timeout       = Number(process.env.HOTELBEDS_TIMEOUT_MS) || 20000;
    this.searchTimeout = Number(process.env.HOTELBEDS_SEARCH_TIMEOUT_MS) || 18000;
  }

  _signature() {
    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hash = crypto
      .createHash('sha256')
      .update(this.apiKey + this.apiSecret + timestamp)
      .digest('hex');
    return hash;
  }

  _headers() {
    return {
      'Api-key':          this.apiKey,
      'X-Signature':      this._signature(),
      'Accept':           'application/json',
      'Accept-Encoding':  'gzip',
      'Content-Type':     'application/json',
    };
  }

  // ─────────────────────────────────────────────
  // TIER 2: NOMINATIM GEOCODING
  // Free, no API key. Requires User-Agent header.
  // Returns { latitude, longitude, radius, unit } or null.
  // ─────────────────────────────────────────────
  async _geocodeCity(cityName) {
    try {
      const response = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: {
          q:      cityName,
          format: 'json',
          limit:  1,
        },
        headers: {
          // Nominatim policy requires a descriptive User-Agent
          'User-Agent': 'Bodrless/1.0 (travel booking platform; petermwasi32@gmail.com)',
        },
        timeout: 6000,
      });

      const result = response.data?.[0];
      if (!result) {
        logger.warn('HotelBeds: Nominatim returned no results', { cityName });
        return null;
      }

      const geo = {
        latitude:  parseFloat(result.lat),
        longitude: parseFloat(result.lon),
        radius:    20,
        unit:      'km',
      };

      logger.info('HotelBeds: Nominatim geocoded city', {
        cityName,
        lat: geo.latitude,
        lng: geo.longitude,
        displayName: result.display_name,
      });

      return geo;

    } catch (err) {
      logger.warn('HotelBeds: Nominatim geocoding failed', { cityName, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // TIER 3: LIVE HOTELBEDS DESTINATION LOOKUP
  // Fallback when Nominatim fails.
  // Uses country-code filtered query (more reliable than name-only).
  // ─────────────────────────────────────────────
  async _lookupDestinationCodeLive(cityName) {
    const key = (cityName || '').toLowerCase().trim();
    if (_destinationCodeCache[key] !== undefined) {
      return _destinationCodeCache[key];
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/hotel-content-api/1.0/locations/destinations`,
        {
          headers: this._headers(),
          params: {
            fields:                 'all',
            language:               'ENG',
            from:                   1,
            to:                     10,
            useSecondaryLanguages:  false,
            name:                   cityName,
          },
          timeout: 8000,
        }
      );

      const destinations = response.data?.data?.destinations || [];
      if (destinations.length === 0) {
        logger.warn('HotelBeds: live destination lookup returned no results', { cityName });
        _destinationCodeCache[key] = null;
        return null;
      }

      // Prefer exact name match, fall back to first result
      const normalizedCity = key;
      const best = destinations.find(d =>
        (d.name?.content || '').toLowerCase() === normalizedCity
      ) || destinations[0];

      const code = best?.code || null;
      logger.info('HotelBeds: live destination lookup resolved', {
        cityName,
        code,
        name: best?.name?.content,
      });

      _destinationCodeCache[key] = code;
      return code;

    } catch (err) {
      logger.warn('HotelBeds: live destination lookup failed', { cityName, error: err.message });
      _destinationCodeCache[key] = null;
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // MAIN DESTINATION RESOLUTION
  //
  // Tier 1: Process-level geo cache (instant)
  // Tier 2: Nominatim geocoding (any city on earth, ~200-400ms, cached after)
  // Tier 3: HotelBeds live destination API (fallback)
  // Fail:   Warn and return nulls — search() returns [] gracefully
  // ─────────────────────────────────────────────
  async _resolveDestination(cityName) {
    if (!cityName) return { destinationCode: null, geolocation: null };

    const key = (cityName || '').toLowerCase().trim();

    // Tier 1: process-level cache
    if (_geoCache[key]) {
      logger.info('HotelBeds: geo cache hit', { cityName });
      return { destinationCode: null, geolocation: _geoCache[key] };
    }

    // Tier 2: Nominatim geocoding — works for any city, neighborhood, or landmark
    const geo = await this._geocodeCity(cityName);
    if (geo) {
      _geoCache[key] = geo;
      return { destinationCode: null, geolocation: geo };
    }

    // Tier 3: HotelBeds live destination API
    const live = await this._lookupDestinationCodeLive(cityName);
    if (live) {
      return { destinationCode: live, geolocation: null };
    }

    logger.warn('HotelBeds: could not resolve destination by any method', { cityName });
    return { destinationCode: null, geolocation: null };
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
      filter: {
        packaging: false,
      },
    };

    if (destinationCode) {
      body.destination = { code: destinationCode };
    } else if (geolocation) {
      body.geolocation = geolocation;
    }

    if (roomType === 'single') {
      body.filter.minRooms = 1;
      body.filter.maxRooms = 1;
    }

    logger.info('HotelBeds search request', {
      destination,
      resolvedAs: destinationCode ? `code:${destinationCode}` : `geo:${geolocation?.latitude},${geolocation?.longitude}`,
      checkIn,
      checkOut,
      adults,
      children,
      rooms,
    });

    try {
      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/hotels`,
        body,
        {
          headers:    this._headers(),
          timeout:    this.searchTimeout,
          decompress: true,
        }
      );

      const hotels = response.data?.hotels?.hotels || [];
      logger.info('HotelBeds search results', { destination, count: hotels.length });

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
        bookingRef:              booking?.reference,
        status:                  booking?.status,
        cancellationReference:   booking?.cancellationReference || null,
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

      const totalRate    = Number(rate.sellingRate || rate.net || 0);
      const nightCount   = nights || this._nightsBetween(checkIn, checkOut) || 1;
      const pricePerNight = nightCount > 0 ? totalRate / nightCount : totalRate;
      const isRefundable = rate.rateType !== 'NOR';

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
      'RO':  'Room Only',
      'BB':  'Bed & Breakfast',
      'HB':  'Half Board',
      'FB':  'Full Board',
      'AI':  'All Inclusive',
      'UAI': 'Ultra All Inclusive',
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