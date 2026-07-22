/**
 * HOTELBEDS ADAPTER
 * ─────────────────────────────────────────────────────────────
 * Search and book hotels via HotelBeds (APItude API).
 *
 * DESTINATION RESOLUTION (three-tier HOTFIX):
 * BUG FIX: Previously evaluated hardcoded IATA codes first (NBO, MBA, etc.).
 * HotelBeds uses proprietary destination codes, so passing IATA codes returned
 * zero results or matched wrong locations (e.g. NBO -> Negombo, Sri Lanka).
 *
 * Resolution Order:
 *   Tier 1: Geolocation search using known city coordinates (Lat/Lng + 20km radius).
 *           Covers 99%+ of queries instantly without code lookups.
 *   Tier 2: Live HotelBeds /locations/destinations API lookup for unlisted cities.
 *   Tier 3: Legacy hardcoded destination map as a last resort.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

// Process-level cache for live destination lookups — same pattern
// as duffel.js's _placesCache. Keyed by normalized city name.
// Resets on deploy, which is fine (destination codes don't change).
const _destinationCodeCache = {};

// Known city coordinates for geolocation search (Tier 1 Priority).
// Prevents HotelBeds IATA code mismatch bug.
const CITY_COORDINATES = {
  // Kenya
  'nairobi':          { lat: -1.2921,   lng: 36.8219 },
  'mombasa':          { lat: -4.0435,   lng: 39.6682 },
  'kisumu':           { lat: -0.0917,   lng: 34.7679 },
  'nakuru':           { lat: -0.3031,   lng: 36.0800 },
  'malindi':          { lat: -3.2138,   lng: 40.1169 },
  'diani':            { lat: -4.3172,   lng: 39.5721 },
  'ukunda':           { lat: -4.3172,   lng: 39.5721 },
  'eldoret':          { lat:  0.5143,   lng: 35.2698 },
  'lamu':             { lat: -2.2717,   lng: 40.9020 },
  'amboseli':         { lat: -2.6527,   lng: 37.2606 },
  'masai mara':       { lat: -1.5121,   lng: 35.1439 },
  'maasai mara':      { lat: -1.5121,   lng: 35.1439 },
  'samburu':          { lat:  0.5766,   lng: 37.5333 },
  'tsavo':            { lat: -2.9833,   lng: 38.4667 },
  'lake nakuru':      { lat: -0.3600,   lng: 36.0833 },
  'nanyuki':          { lat:  0.0167,   lng: 37.0722 },

  // Tanzania
  'zanzibar':         { lat: -6.1659,   lng: 39.2026 },
  'dar es salaam':    { lat: -6.7924,   lng: 39.2083 },
  'arusha':           { lat: -3.3869,   lng: 36.6830 },
  'serengeti':        { lat: -2.3333,   lng: 34.8333 },
  'ngorongoro':       { lat: -3.1847,   lng: 35.5799 },
  'kilimanjaro':      { lat: -3.0674,   lng: 37.3556 },
  'mwanza':           { lat: -2.5167,   lng: 32.9000 },
  'pemba':            { lat: -5.1333,   lng: 39.7500 },

  // Uganda, Rwanda, Burundi, South Sudan, Ethiopia
  'kampala':          { lat:  0.3476,   lng: 32.5825 },
  'entebbe':          { lat:  0.0612,   lng: 32.4597 },
  'kigali':           { lat: -1.9441,   lng: 30.0619 },
  'addis ababa':      { lat:  9.0300,   lng: 38.7400 },
  'bujumbura':        { lat: -3.3822,   lng: 29.3644 },
  'juba':             { lat:  4.8594,   lng: 31.5713 },

  // Southern Africa
  'lusaka':           { lat: -15.4167,  lng: 28.2833 },
  'zambia':           { lat: -15.4167,  lng: 28.2833 },
  'windhoek':         { lat: -22.5609,  lng: 17.0658 },
  'maputo':           { lat: -25.9692,  lng: 32.5732 },
  'antananarivo':     { lat: -18.9137,  lng: 47.5361 },
  'harare':           { lat: -17.8252,  lng: 31.0335 },
  'gaborone':         { lat: -24.6541,  lng: 25.9087 },
  'lilongwe':         { lat: -13.9626,  lng: 33.7741 },
  'luanda':           { lat: -8.8368,   lng: 13.2343 },
  'victoria falls':   { lat: -17.9244,  lng: 25.8559 },
  'livingstone':      { lat: -17.8419,  lng: 25.8543 },
  'johannesburg':     { lat: -26.2041,  lng: 28.0473 },
  'cape town':        { lat: -33.9249,  lng: 18.4241 },
  'durban':           { lat: -29.8587,  lng: 31.0218 },

  // West & North Africa
  'accra':            { lat:  5.6037,   lng: -0.1870 },
  'lagos':            { lat:  6.5244,   lng:  3.3792 },
  'dakar':            { lat: 14.6937,   lng: -17.4441 },
  'abidjan':          { lat:  5.3600,   lng: -4.0083 },
  'douala':           { lat:  4.0511,   lng:  9.7679 },
  'cairo':            { lat: 30.0444,   lng: 31.2357 },
  'marrakech':        { lat: 31.6295,   lng: -7.9811 },
  'casablanca':       { lat: 33.5731,   lng: -7.5898 },

  // Indian Ocean Islands & Middle East
  'seychelles':       { lat: -4.6796,   lng: 55.4920 },
  'mahe':             { lat: -4.6796,   lng: 55.4920 },
  'mauritius':        { lat: -20.3484,  lng: 57.5522 },
  'port louis':       { lat: -20.1609,  lng: 57.5012 },
  'male':             { lat:  4.1755,   lng: 73.5093 },
  'maldives':         { lat:  4.1755,   lng: 73.5093 },
  'dubai':            { lat: 25.2048,   lng: 55.2708 },
  'abu dhabi':        { lat: 24.4539,   lng: 54.3773 },
  'doha':             { lat: 25.2854,   lng: 51.5310 },
  'istanbul':         { lat: 41.0082,   lng: 28.9784 },

  // Europe & Asia & Americas
  'london':           { lat: 51.5074,   lng: -0.1278 },
  'paris':            { lat: 48.8566,   lng:  2.3522 },
  'barcelona':        { lat: 41.3851,   lng:  2.1734 },
  'madrid':           { lat: 40.4168,   lng: -3.7038 },
  'rome':             { lat: 41.9028,   lng: 12.4964 },
  'amsterdam':        { lat: 52.3676,   lng:  4.9041 },
  'berlin':           { lat: 52.5200,   lng: 13.4050 },
  'lisbon':           { lat: 38.7223,   lng: -9.1393 },
  'bangkok':          { lat: 13.7563,   lng: 100.5018 },
  'tokyo':            { lat: 35.6762,   lng: 139.6503 },
  'singapore':        { lat:  1.3521,   lng: 103.8198 },
  'bali':             { lat: -8.3405,   lng: 115.0920 },
  'phuket':           { lat:  7.8804,   lng: 98.3923  },
  'new york':         { lat: 40.7128,   lng: -74.0060 },
  'miami':            { lat: 25.7617,   lng: -80.1918 },
  'cancun':           { lat: 21.1619,   lng: -86.8515 },
  'los angeles':      { lat: 34.0522,   lng: -118.2437 },
};

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
      'Api-key': this.apiKey,
      'X-Signature': this._signature(),
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/json',
    };
  }

  // ─────────────────────────────────────────────
  // GEOLOCATION FALLBACK LOOKUP
  // ─────────────────────────────────────────────
  _getGeolocationFallback(cityName) {
    const key = (cityName || '').toLowerCase().trim();
    return CITY_COORDINATES[key] || null;
  }

  // ─────────────────────────────────────────────
  // TIER 2: LIVE HOTELBEDS DESTINATION LOOKUP
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
            fields: 'all',
            language: 'ENG',
            from: 1,
            to: 5,
            useSecondaryLanguages: false,
            name: cityName,
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

      const normalizedCity = key;
      const best = destinations.find(d =>
        (d.name?.content || '').toLowerCase() === normalizedCity
      ) || destinations[0];

      const code = best?.code || null;
      logger.info('HotelBeds: live destination lookup resolved', { cityName, code, name: best?.name?.content });
      _destinationCodeCache[key] = code;
      return code;

    } catch (err) {
      logger.warn('HotelBeds: live destination lookup failed', { cityName, error: err.message });
      _destinationCodeCache[key] = null;
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // TIER 3: LEGACY HARDCODED DESTINATION CODE MAP
  // ─────────────────────────────────────────────
  _getHardcodedDestinationCode(cityName) {
    const CODES = {
      'nairobi': 'NBO', 'mombasa': 'MBA', 'kisumu': 'KIS', 'eldoret': 'EDL',
      'malindi': 'MYD', 'lamu': 'LAU', 'diani': 'UKA', 'ukunda': 'UKA',
      'nakuru': 'NUU', 'nanyuki': 'NYK', 'maasai mara': 'MRE',
      'masai mara': 'MRE', 'amboseli': 'ASV', 'samburu': 'UAS',
      'tsavo': 'MBA', 'nyahururu': 'NYK', 'zanzibar': 'ZNZ', 'dar es salaam': 'DAR',
      'arusha': 'ARK', 'kilimanjaro': 'JRO', 'mwanza': 'MWZ', 'serengeti': 'SEU',
      'ngorongoro': 'JRO', 'pemba': 'PMA', 'mafia': 'MFA', 'kampala': 'EBB',
      'entebbe': 'EBB', 'kigali': 'KGL', 'addis ababa': 'ADD', 'bujumbura': 'BJM',
      'juba': 'JUB', 'mogadishu': 'MGQ', 'lusaka': 'LUN', 'zambia': 'LUN',
      'windhoek': 'WDH', 'namibia': 'WDH', 'maputo': 'MPM', 'mozambique': 'MPM',
      'beira': 'BEW', 'antananarivo': 'TNR', 'madagascar': 'TNR', 'harare': 'HRE',
      'zimbabwe': 'HRE', 'bulawayo': 'BUQ', 'gaborone': 'GBE', 'botswana': 'GBE',
      'lilongwe': 'LLW', 'malawi': 'LLW', 'blantyre': 'BLZ', 'luanda': 'LAD',
      'angola': 'LAD', 'mbabane': 'MTS', 'maseru': 'MSU', 'victoria falls': 'VFA',
      'livingstone': 'LVI', 'ndola': 'NLA', 'johannesburg': 'JNB', 'cape town': 'CPT',
      'durban': 'DUR', 'port elizabeth': 'PLZ', 'east london': 'ELS', 'nelspruit': 'MQP',
      'kruger': 'MQP', 'sun city': 'PTG', 'accra': 'ACC', 'lagos': 'LOS', 'abuja': 'ABV',
      'dakar': 'DKR', 'abidjan': 'ABJ', 'douala': 'DLA', 'yaounde': 'YAO', 'cairo': 'CAI',
      'marrakech': 'RAK', 'casablanca': 'CMN', 'dubai': 'DXB', 'abu dhabi': 'AUH',
      'doha': 'DOH', 'london': 'LON', 'paris': 'PAR', 'rome': 'ROM', 'barcelona': 'BCN',
      'madrid': 'MAD', 'new york': 'NYC', 'miami': 'MIA', 'los angeles': 'LAX'
    };

    const key = (cityName || '').toLowerCase().trim();
    return CODES[key] || null;
  }

  // ─────────────────────────────────────────────
  // MAIN DESTINATION RESOLUTION (HOTFIX UPDATED)
  // ─────────────────────────────────────────────
  async _resolveDestination(cityName) {
    if (!cityName) return { destinationCode: null, geolocation: null };

    // TIER 1 (HOTFIX): Geolocation FIRST using exact coordinates
    // Bypasses bad IATA codes (like NBO/MBA) that cause zero hotel results in HotelBeds
    const geo = this._getGeolocationFallback(cityName);
    if (geo) {
      logger.info('HotelBeds: using geolocation strategy for destination', { cityName, geo });
      return {
        destinationCode: null,
        geolocation: { latitude: geo.lat, longitude: geo.lng, radius: 20, unit: 'km' }
      };
    }

    // TIER 2: Live HotelBeds API destination code lookup
    const live = await this._lookupDestinationCodeLive(cityName);
    if (live) return { destinationCode: live, geolocation: null };

    // TIER 3: Legacy hardcoded destination map (last resort fallback)
    const hardcoded = this._getHardcodedDestinationCode(cityName);
    if (hardcoded) {
      logger.warn('HotelBeds: falling back to legacy hardcoded destination code', { cityName, hardcoded });
      return { destinationCode: hardcoded, geolocation: null };
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

    const adultsPerRoom = Math.max(1, Math.ceil(adults / rooms));
    const childrenPerRoom = Math.ceil(children / rooms);
    const pax = [];
    for (let a = 0; a < adultsPerRoom; a++) pax.push({ type: 'AD' });
    for (let c = 0; c < childrenPerRoom; c++) {
      const age = childAges[c] ?? 8;
      pax.push({ type: 'CH', age });
    }
    const occupancies = [{ rooms, adults: adultsPerRoom, children: childrenPerRoom, paxes: pax }];

    const body = {
      stay: { checkIn, checkOut },
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
      destinationCode: destinationCode || 'geolocation',
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
          headers: this._headers(),
          timeout: this.searchTimeout,
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
        logger.error('HotelBeds search failed', { destination, status, detail: JSON.stringify(detail)?.slice(0, 200), error: err.message });
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
      const room = hotel?.rooms?.[0];
      const rate = room?.rates?.[0];
      if (!rate) return null;

      return {
        rateKey: rate.rateKey,
        net: Number(rate.net || 0),
        sellingRate: Number(rate.sellingRate || rate.net || 0),
        rateType: rate.rateType,
        cancellationPolicies: rate.cancellationPolicies || [],
        rateComments: rate.rateComments || null,
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
      paxes: [{ roomId: g.roomId || 1, type: g.type === 'child' ? 'CH' : 'AD', name: g.lastName, surname: g.firstName }],
    }));

    const body = {
      holder: { name: holder.firstName, surname: holder.lastName },
      rooms: guestRooms,
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
        { headers: this._headers(), timeout: this.timeout, params: { cancellationFlag: 'CANCELLATION' }, decompress: true }
      );

      const booking = response.data?.booking;
      return {
        bookingRef: booking?.reference,
        status: booking?.status,
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

      const totalRate = Number(rate.sellingRate || rate.net || 0);
      const nightCount = nights || this._nightsBetween(checkIn, checkOut) || 1;
      const pricePerNight = nightCount > 0 ? totalRate / nightCount : totalRate;

      const isRefundable = rate.rateType !== 'NOR';

      results.push({
        supplier: 'hotelbeds',
        hotelCode: String(hotel.code),
        name: hotel.name,
        stars: hotel.categoryCode ? this._parseStars(hotel.categoryCode) : null,
        rating: hotel.reviewScore || null,
        location: hotel.zoneName || hotel.destinationName || null,
        latitude: hotel.coordinates?.latitude || null,
        longitude: hotel.coordinates?.longitude || null,
        images: hotel.imageUrls || [],
        checkIn,
        checkOut,
        nights: nightCount,
        pricePerNight: Math.round(pricePerNight * 100) / 100,
        totalRate: Math.round(totalRate * 100) / 100,
        currency: 'EUR',
        rateKey: rate.rateKey,
        rateType: rate.rateType,
        isRefundable,
        cancellationPolicies: rate.cancellationPolicies || [],
        rateComments: rate.rateComments || null,
        mealPlan: this._normalizeMealPlan(rate.boardCode),
        boardType: rate.boardCode,
        promotions: rate.promotions || [],
        rooms: rate.rooms || 1,
        adults,
        supplier_tag: rate.rateKey ? rate.rateKey.slice(0, 20) : null,
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
      status: booking.status,
      clientReference: booking.clientReference,
      checkIn: booking.hotel?.checkIn,
      checkOut: booking.hotel?.checkOut,
      totalRate: Number(booking.totalNet || booking.totalSellingRate || 0),
      currency: 'EUR',
      rateKey: rate?.rateKey || null,
      cancellationPolicies: rate?.cancellationPolicies || [],
      rateComments: rate?.rateComments || null,
      hotelName: booking.hotel?.name || null,
      hotelAddress: booking.hotel?.address || null,
      hotelPhone: booking.hotel?.phoneNumber || null,
      hotelEmail: booking.hotel?.email || null,
      supplier_tag: rate?.rateKey ? rate.rateKey.slice(0, 20) : null,
    };
  }

  _normalizeMealPlan(boardCode) {
    const plans = {
      'RO': 'Room Only', 'BB': 'Bed & Breakfast', 'HB': 'Half Board',
      'FB': 'Full Board', 'AI': 'All Inclusive', 'UAI': 'Ultra All Inclusive',
      'SC': 'Self Catering',
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