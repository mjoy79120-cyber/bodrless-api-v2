/**
 * HOTELBEDS ADAPTER
 * ─────────────────────────────────────────────
 * Normalizes HotelBeds API responses into
 * Bodrless standard hotel format
 *
 * Base URL:  https://api.test.hotelbeds.com (sandbox)
 *            https://api.hotelbeds.com (production)
 * Auth:      Api-key header + X-Signature (SHA256 of apiKey + secret + timestamp)
 * Docs:      https://developer.hotelbeds.com
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

class HotelBedsAdapter {

  constructor() {
    this.apiKey  = process.env.HOTELBEDS_API_KEY  || '9ec6d226c814617a769830d6debfa22a';
    this.secret  = process.env.HOTELBEDS_SECRET   || 'VuyrB8sJ0N';
    this.sandbox = process.env.HOTELBEDS_SANDBOX  !== 'false'; // default: sandbox ON
    this.baseUrl = this.sandbox
      ? 'https://api.test.hotelbeds.com'
      : 'https://api.hotelbeds.com';
    this.supplier = 'hotelbeds';
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS
  // ─────────────────────────────────────────────
  async search({
    destination,
    checkIn,
    checkOut,
    passengers = 1,
    nights = 1,
    budget = 'mid',
    rooms = 1,
  }) {
    try {
      logger.info('HotelBeds: searching hotels', { destination, checkIn, checkOut, passengers });

      // Resolve destination to HotelBeds destination code
      const destCode = await this._resolveDestination(destination);
      if (!destCode) {
        logger.warn('HotelBeds: could not resolve destination code', { destination });
        return [];
      }

      const checkInDate  = this._formatDate(checkIn);
      const checkOutDate = checkOut
        ? this._formatDate(checkOut)
        : this._addDays(checkInDate, nights);

      const payload = {
        stay: {
          checkIn:  checkInDate,
          checkOut: checkOutDate,
        },
        occupancies: [
          {
            rooms:  rooms,
            adults: passengers,
            children: 0,
          },
        ],
        destination: {
          code: destCode,
        },
        filter: {
          maxHotels: 10,
          minRate:   this._budgetMinRate(budget),
          maxRate:   this._budgetMaxRate(budget),
          paymentType: 'AT_WEB',
        },
      };

      console.log('HOTELBEDS REQUEST:', JSON.stringify({ destCode, checkInDate, checkOutDate, passengers, budget }, null, 2));

      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/hotels`,
        payload,
        { headers: this._headers(), timeout: 30000 }
      );

      console.log('HOTELBEDS RAW RESPONSE:', JSON.stringify(response.data?.hotels?.hotels?.slice(0, 2), null, 2));

      const hotels = response.data?.hotels?.hotels || [];
      logger.info('HotelBeds: results', { count: hotels.length });

      return this._normalizeHotels(hotels, nights);

    } catch (err) {
      console.log('HOTELBEDS ERROR DETAIL:', JSON.stringify({
        message: err.message,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));
      logger.error('HotelBeds search failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // RESOLVE DESTINATION CODE
  // Uses HotelBeds Locations API to get dest code
  // Falls back to hardcoded map for common cities
  // ─────────────────────────────────────────────
  async _resolveDestination(cityName) {
    if (!cityName) return null;

    // Confirmed HotelBeds destination codes (verified against /locations/destinations)
    const map = {
      'mombasa':        'MBA',
      'diani':          'MBA', // Ukunda-Diani Beach is a zone within MBA
      'ukunda':         'MBA',
      'nairobi':        'NAI',
      'malindi':        'MYD',
      'watamu':         'MYD',
      'kilifi':         'MYD',
      'lamu':           'UAM',
      'masai mara':     'MAS',
      'nakuru':         'LEK',
      'naivasha':       'LAV',
      'amboseli':       'ASV',
      'tsavo':          'TNP',
      'taita hills':    'TAI',
      'kisumu':         'KSI',
      'eldoret':        'UAS',
      'kitale':         'UAS',
      'samburu':        'UAS',
      'mt kenya':       'MKN',
      'nanyuki':        'MKN',
      // Outside Kenya — best-effort, not yet verified against HotelBeds list
      'zanzibar':       'ZNZ',
      'dar es salaam':  'DAR',
      'arusha':         'ARU',
      'kigali':         'KGL',
      'kampala':        'KMP',
      'entebbe':        'KMP',
      'addis ababa':    'ADD',
      'johannesburg':   'JNB',
      'cape town':      'CPT',
      'dubai':          'DXB',
      'london':         'LON',
      'paris':          'PAR',
      'new york':       'NYC',
      'amsterdam':      'AMS',
      'istanbul':       'IST',
      'cairo':          'CAI',
      'marrakech':      'RAK',
      'bali':           'DPS',
      'bangkok':        'BKK',
      'singapore':      'SIN',
      'miami':          'MIA',
      'barcelona':      'BCN',
      'rome':           'ROM',
      'athens':         'ATH',
      'maldives':       'MLE',
      'seychelles':     'SEZ',
      'mauritius':      'MRU',
    };

    const key = cityName.toLowerCase().trim();
    if (map[key]) return map[key];

    // Fuzzy match — check if any map key is contained in the city name
    for (const [k, v] of Object.entries(map)) {
      if (key.includes(k) || k.includes(key)) return v;
    }

    // Try HotelBeds locations API as last resort
    try {
      const response = await axios.get(
        `${this.baseUrl}/hotel-content-api/1.0/locations/destinations`,
        {
          headers: this._headers(),
          params: { fields: 'all', language: 'ENG', from: 1, to: 5 },
          timeout: 10000,
        }
      );
      const destinations = response.data?.destinations || [];
      const match = destinations.find(d =>
        (d.name?.content || '').toLowerCase().includes(key)
      );
      return match?.code || null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE HOTELS
  // ─────────────────────────────────────────────
  _normalizeHotels(hotels, nights) {
    return hotels.map(hotel => {
      const cheapestRoom = this._cheapestRoom(hotel.rooms || []);
      const bestRate      = this._bestRate(cheapestRoom?.rates);
      const totalRate     = Number(bestRate?.net || hotel.minRate || 0);
      const pricePerNight = nights > 0 ? Math.round(totalRate / nights) : totalRate;

      return {
        supplier:      this.supplier,
        hotelCode:     hotel.code,
        name:          hotel.name,
        stars:         Number(hotel.categoryCode?.replace(/[^0-9]/g, '') || hotel.categoryName?.charAt(0) || 3),
        rating:        Number(hotel.reviews?.[0]?.rate || 4.0),
        category:      hotel.categoryName || '',
        location:      hotel.zoneName     || hotel.destinationName || '',
        city:          hotel.destinationName || '',
        address:       hotel.address?.content || '',
        latitude:      hotel.latitude  || hotel.coordinates?.latitude  || null,
        longitude:     hotel.longitude || hotel.coordinates?.longitude || null,
        pricePerNight: pricePerNight,
        totalRate:     totalRate,
        currency:      bestRate?.currency || hotel.currency || 'EUR',
        mealPlan:      this._boardName(bestRate?.boardCode),
        mealPlanCode:  bestRate?.boardCode || null,
        roomType:      cheapestRoom?.name || null,
        rateKey:       bestRate?.rateKey  || null,
        isRefundable:  bestRate?.rateClass !== 'NRF',
        cancellationPolicies: bestRate?.cancellationPolicies || [],
        images:        (hotel.images || []).slice(0, 3).map(img => img.path),
        reviews:       hotel.reviews || [],
        amenities:     (hotel.facilities || []).map(f => f.facilityName).filter(Boolean).slice(0, 10),
      };
    });
  }

  _cheapestRoom(rooms) {
    if (!rooms.length) return null;
    return rooms.reduce((cheapest, room) => {
      const roomRate  = Number(this._bestRate(room.rates)?.net || Infinity);
      const cheapRate = Number(this._bestRate(cheapest.rates)?.net || Infinity);
      return roomRate < cheapRate ? room : cheapest;
    });
  }

  // Picks the cheapest rate within a room, preferring refundable (NOR)
  // over non-refundable (NRF) so travelers aren't silently defaulted
  // into a non-refundable booking.
  _bestRate(rates) {
    if (!rates || !rates.length) return null;
    const refundable = rates.filter(r => r.rateClass !== 'NRF');
    const pool = refundable.length > 0 ? refundable : rates;
    return pool.reduce((cheapest, r) =>
      Number(r.net) < Number(cheapest.net) ? r : cheapest
    );
  }

  _boardName(code) {
    const map = { RO: 'Room Only', BB: 'Bed & Breakfast', HB: 'Half Board', FB: 'Full Board', AI: 'All Inclusive' };
    return map[code] || code || null;
  }

  // ─────────────────────────────────────────────
  // BUDGET → RATE RANGES (EUR per stay, not per night —
  // HotelBeds filter.minRate/maxRate apply to total stay cost)
  // Widened based on observed sandbox rates (~130-400 EUR/night)
  // ─────────────────────────────────────────────
  _budgetMinRate(budget) {
    const map = { low: 0, mid: 0, high: 0, luxury: 0 };
    return map[budget] || 0;
  }

  _budgetMaxRate(budget) {
    // Generous ceiling — filter loosely server-side, rank by budget client-side instead
    const map = { low: 99999, mid: 99999, high: 99999, luxury: 99999 };
    return map[budget] || 99999;
  }

  // ─────────────────────────────────────────────
  // AUTH HEADERS
  // X-Signature = SHA256(apiKey + secret + timestamp)
  // ─────────────────────────────────────────────
  _headers() {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash('sha256')
      .update(this.apiKey + this.secret + timestamp)
      .digest('hex');

    return {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Api-key':      this.apiKey,
      'X-Signature':  signature,
    };
  }

  _formatDate(date) {
    if (!date) return new Date().toISOString().split('T')[0];
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return new Date(date).toISOString().split('T')[0];
  }

  _addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }
}

module.exports = new HotelBedsAdapter();