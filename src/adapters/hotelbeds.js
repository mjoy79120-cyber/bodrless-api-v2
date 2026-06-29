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
  // BUILD OCCUPANCY
  // Produces a HotelBeds occupancy node from a real adult/child split.
  // Per HotelBeds rules, the `children` count MUST equal the number of
  // CH entries in `paxes`, and every child needs an `age` — otherwise
  // E_REQUEST_CHILDRENDONTMATCH / E_REQUEST_AGESDONTMATCH (400). To make
  // that impossible to violate, the child count is derived from the
  // number of valid ages we actually have, not a separate counter.
  // ─────────────────────────────────────────────
  _buildOccupancy({ rooms = 1, adults = 1, children = 0, childAges = [] }) {
    const ages = (Array.isArray(childAges) ? childAges : [])
      .map(a => parseInt(a, 10))
      .filter(a => Number.isFinite(a) && a >= 0 && a < 18);

    // Guarantee children count and paxes ages are always consistent.
    const childCount = Math.min(Math.max(0, children || 0), ages.length);
    const occ = {
      rooms,
      adults: Math.max(1, adults || 1), // HotelBeds requires >=1 adult
      children: childCount,
    };
    if (childCount > 0) {
      occ.paxes = ages.slice(0, childCount).map(age => ({ type: 'CH', age }));
    }
    return occ;
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS
  // ─────────────────────────────────────────────
  async search({
    destination,
    checkIn,
    checkOut,
    passengers = 1,
    adults = null,
    children = 0,
    childAges = [],
    nights = 1,
    budget = 'mid',
    rooms = 1,
    hotelCode = null,
  }) {
    try {
      logger.info('HotelBeds: searching hotels', { destination, checkIn, checkOut, passengers, children, hotelCode });

      const checkInDate  = this._formatDate(checkIn);
      const checkOutDate = checkOut
        ? this._formatDate(checkOut)
        : this._addDays(checkInDate, nights);

      const occupancy = this._buildOccupancy({
        rooms,
        adults: adults != null ? adults : passengers,
        children,
        childAges,
      });

      const payload = {
        stay: {
          checkIn:  checkInDate,
          checkOut: checkOutDate,
        },
        occupancies: [occupancy],
      };

      // Selector: either a specific hotel (used by the booking-side
      // re-fetch to re-price one exact hotel at a corrected occupancy)
      // or a destination code (normal search).
      if (hotelCode) {
        payload.hotels = { hotel: [Number(hotelCode) || hotelCode] };
      } else {
        const destCode = await this._resolveDestination(destination);
        if (!destCode) {
          logger.warn('HotelBeds: could not resolve destination code', { destination });
          return [];
        }
        payload.destination = { code: destCode };
      }

      payload.filter = {
        maxHotels: hotelCode ? 1 : 10,
        minRate:   this._budgetMinRate(budget),
        maxRate:   this._budgetMaxRate(budget),
        paymentType: 'AT_WEB',
      };

      console.log('HOTELBEDS REQUEST:', JSON.stringify({ destination, hotelCode, checkInDate, checkOutDate, occupancy, budget }, null, 2));

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
  // REFETCH RATE — re-price one hotel at a corrected occupancy
  // Used by the booking flow when a child's true age (from DOB) differs
  // from what was searched. Returns the cheapest refundable rate for the
  // exact hotel at the corrected occupancy: { rateKey, pricePerNight,
  // totalRate, currency } or null if nothing comes back.
  // ─────────────────────────────────────────────
  async refetchRate({ hotelCode, checkIn, checkOut, nights = 1, adults = 1, children = 0, childAges = [], rooms = 1 }) {
    if (!hotelCode) return null;
    const results = await this.search({
      hotelCode, checkIn, checkOut, nights, adults, children, childAges, rooms,
      budget: 'mid', // wide rate band; we just need the rate for this exact hotel
    });
    if (!results || results.length === 0) return null;
    const hotel = results[0];
    return {
      rateKey:       hotel.rateKey,
      pricePerNight: hotel.pricePerNight,
      totalRate:     hotel.totalRate,
      currency:      hotel.currency,
    };
  }

  // ─────────────────────────────────────────────
  // CHECK RATE
  // Only required when rateType === 'RECHECK' (dynamic/cached rates
  // that need a live refresh before booking). Most BOOKABLE rates
  // from search() can skip straight to book(). Call this first if
  // unsure, since booking a stale RECHECK rate directly will fail.
  // ─────────────────────────────────────────────
  async checkRate(rateKey) {
    try {
      logger.info('HotelBeds: checking rate', { rateKey: rateKey?.slice(0, 30) + '...' });

      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/checkrates`,
        { rooms: [{ rateKey }] },
        { headers: this._headers(), timeout: 20000 }
      );

      const hotel = response.data?.hotel;
      if (!hotel) return null;

      const room = hotel.rooms?.[0];
      const rate = room?.rates?.[0];

      return {
        rateKey:  rate?.rateKey || rateKey,
        net:      Number(rate?.net || 0),
        currency: response.data?.currency || 'EUR',
        rateClass: rate?.rateClass,
        cancellationPolicies: rate?.cancellationPolicies || [],
      };

    } catch (err) {
      console.log('HOTELBEDS CHECKRATE ERROR:', JSON.stringify({
        message: err.message,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));
      logger.error('HotelBeds checkRate failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOK
  // Confirms a real reservation against a rateKey from search().
  // guests: array of { firstName, lastName, type: 'adult'|'child', roomId, age }
  // holder: { firstName, lastName, email, phone } — the lead/contact guest,
  // must also appear as a pax in room 1 per HotelBeds requirements.
  // ─────────────────────────────────────────────
  async book({ rateKey, holder, guests, clientReference, remark }) {
    try {
      logger.info('HotelBeds: creating booking', { guestCount: guests?.length });

      const paxes = (guests || []).map(g => ({
        roomId:  g.roomId || 1,
        type:    g.type === 'child' ? 'CH' : 'AD',
        name:    g.firstName,
        surname: g.lastName,
        ...(g.type === 'child' && g.age ? { age: g.age } : {}),
      }));

      const payload = {
        holder: {
          name:    holder.firstName,
          surname: holder.lastName,
        },
        rooms: [
          {
            rateKey,
            paxes,
          },
        ],
        clientReference: clientReference || `BDR-${Date.now()}`,
        remark: remark || '',
        tolerance: 2.0, // allow up to 2 currency units of price drift between search and booking
      };

      console.log('HOTELBEDS BOOK REQUEST:', JSON.stringify(payload, null, 2));

      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/bookings`,
        payload,
        { headers: this._headers(), timeout: 30000 }
      );

      console.log('HOTELBEDS BOOK RESPONSE:', JSON.stringify(response.data, null, 2));

      const booking = response.data?.booking;
      if (!booking) {
        throw new Error('HotelBeds booking response missing booking object');
      }

      return {
        supplier:                 this.supplier,
        supplierBookingReference: booking.reference,
        status:                   booking.status, // CONFIRMED | PENDING_TARIFF_ERROR | etc.
        hotelName:                booking.hotel?.name,
        checkIn:                  booking.hotel?.checkIn,
        checkOut:                 booking.hotel?.checkOut,
        totalAmount:              Number(booking.totalNet || 0),
        currency:                 booking.currency || 'EUR',
        holder:                   booking.holder,
        rooms:                    booking.hotel?.rooms || [],
        confirmedAt:              new Date().toISOString(),
      };

    } catch (err) {
      console.log('HOTELBEDS BOOK ERROR:', JSON.stringify({
        message: err.message,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));
      logger.error('HotelBeds book failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL BOOKING
  // ─────────────────────────────────────────────
  async cancel(bookingReference) {
    try {
      const response = await axios.delete(
        `${this.baseUrl}/hotel-api/1.0/bookings/${bookingReference}`,
        { headers: this._headers(), timeout: 20000 }
      );
      return response.data;
    } catch (err) {
      logger.error('HotelBeds cancel failed', { error: err.message });
      throw err;
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