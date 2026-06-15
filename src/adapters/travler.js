/**
 * IABIRI ADAPTER (Travler Bus)
 * ─────────────────────────────────────────────
 * Normalizes IABIRI/99Synergy API responses into
 * Bodrless standard format
 *
 * Base URL:  http://bossapi.99synergy.com  (search/book)
 *            https://api.iabiri.com        (boarding/dropping points)
 * Auth:      Static API key in `authorization` header
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

class IabiriAdapter {

  constructor() {
    this.baseUrl       = process.env.IABIRI_API_URL      || 'http://bossapi.99synergy.com';
    this.pointsUrl     = process.env.IABIRI_POINTS_URL   || 'https://api.iabiri.com';
    this.apiKey        = process.env.IABIRI_API_KEY;
    this.currencyId    = process.env.IABIRI_CURRENCY_ID  || '1';   // 1 = KES
    this.timeout       = 12000;
    this.supplier      = 'iabiri';
  }

  // ─────────────────────────────────────────────
  // SEARCH BUSES
  // Resolves city names → IDs then calls filterBuses
  // ─────────────────────────────────────────────
  async search({ origin, destination, date, passengers = 1, timePreference = null }) {
    try {
      logger.info('IABIRI: searching buses', { origin, destination, date });

      // Resolve city names to IABIRI city IDs
      const [sourceCityId, destCityId] = await Promise.all([
        this._resolveCityId(origin),
        this._resolveCityId(destination),
      ]);

      if (!sourceCityId || !destCityId) {
        logger.warn('IABIRI: could not resolve city IDs', { origin, destination });
        return [];
      }

      const response = await axios.post(
        `${this.baseUrl}/globalApi/Trips/filterBuses`,
        {
          source_city_id:      String(sourceCityId),
          destination_city_id: String(destCityId),
          travel_date:         this._formatDate(date),
          avg_rating:          null,
          departure_time:      'asc',
          fare:                null,
          seat_type:           '',
          travels:             '',
          boarding_points:     [],
          dropping_points:     [],
          bus_with_amenities:  [],
          high_rating:         false,
          bus_with_live_tracking: false,
          cabs:                false,
          hot_deals:           false,
          on_time:             false,
          bus_type:            [],
          time_range:          [],
          record_type:         'data',
          currencyId:          this.currencyId,
          company_id:          [],
          delayBus:            true,
          sourcetype:          'web',
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      const buses = this._normalizeBuses(response.data, sourceCityId, destCityId, date);
      return this._filterByTime(buses, timePreference);

    } catch (err) {
      logger.error('IABIRI search failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // GET SEAT LAYOUT + PRICING
  // Call after search to get seat map for a specific bus
  // ─────────────────────────────────────────────
  async getSeatAvailability({ busId, sourceCityId, destCityId, date, delayedFlag = 0, delayedDate = null }) {
    try {
      logger.info('IABIRI: fetching seat layout', { busId });

      const travelDate = this._formatDate(date);
      const response = await axios.post(
        `${this.baseUrl}/globalApi/trips/getTripSeatsPrice`,
        {
          source_city_id:      String(sourceCityId),
          destination_city_id: String(destCityId),
          travel_date:         travelDate,
          bus_id:              String(busId),
          delayedFlag:         delayedFlag,
          delayedDate:         delayedDate || this._toUnixTimestamp(date),
          sourcetype:          'web',
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeSeats(response.data);

    } catch (err) {
      logger.error('IABIRI seat fetch failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // GET BOARDING & DROPPING POINTS
  // Call before booking to show pickup/dropoff options
  // ─────────────────────────────────────────────
  async getBoardingDroppingPoints({ sourceCityId, destCityId, tripId, date, delayedFlag = 0, delayedDate = null }) {
    try {
      logger.info('IABIRI: fetching boarding/dropping points', { tripId });

      const response = await axios.post(
        `${this.pointsUrl}/globalApi/trips/getBoardingDroppingPoints`,
        {
          source:       String(sourceCityId),
          destination:  String(destCityId),
          trip:         String(tripId),
          booking_date: this._formatDate(date),
          delayedFlag:  delayedFlag,
          delayedDate:  delayedDate || this._toUnixTimestamp(date),
          sourcetype:   'web',
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeBoardingPoints(response.data);

    } catch (err) {
      logger.error('IABIRI boarding points fetch failed', { error: err.message });
      return { boardingPoints: [], droppingPoints: [] };
    }
  }

  // ─────────────────────────────────────────────
  // BOOK (One-way)
  // Creates a reservation — follow up with payment init
  // ─────────────────────────────────────────────
  async book({ tripId, routeId, token, pickupId, returnId, sourceCityName, destCityName,
               bookingDate, seats, passengerDetails, agencyId }) {
    try {
      logger.info('IABIRI: creating booking', { tripId, seats });

      const response = await axios.post(
        `${this.baseUrl}/globalApi/ticket/RoundBooking`,
        {
          ticketDetail: {
            onwardticket: {
              booking_date: this._formatDate(bookingDate),
              route_id:     String(routeId),
              token:        token,
              pickup_id:    String(pickupId),
              return_id:    String(returnId),
              source_city:  sourceCityName.toUpperCase(),
              dest_city:    destCityName.toUpperCase(),
              seats:        seats,                   // array of seat numbers
              passengers:   passengerDetails,        // array of passenger objects
              sourcetype:   'web',
            },
          },
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeBooking(response.data);

    } catch (err) {
      logger.error('IABIRI booking failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // INIT PAYMENT
  // Trigger payment gateway after booking is created
  // ─────────────────────────────────────────────
  async initPayment({ bookingRef, phoneNumber, isWalletApply = false }) {
    try {
      logger.info('IABIRI: initiating payment', { bookingRef });

      const response = await axios.post(
        `${this.baseUrl}/globalApi/paymentGateway/init`,
        {
          bookingRef:    bookingRef,
          queryoption:   2,                // 2 = phone/MPESA
          queryvalue:    phoneNumber,      // e.g. "254712345678"
          requestType:   'ticket',
          isWalletApply: isWalletApply,
          sourcetype:    'web',
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data;

    } catch (err) {
      logger.error('IABIRI payment init failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET TICKET DETAILS
  // ─────────────────────────────────────────────
  async getStatus(ticketId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/globalApi/ticket/ticketDetails`,
        { ticketId, sourcetype: 'web' },
        { headers: this._headers(), timeout: this.timeout }
      );
      return response.data;
    } catch (err) {
      logger.error('IABIRI ticket status check failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOKING HISTORY (Agency-level)
  // ─────────────────────────────────────────────
  async getBookingHistory({ page = 1, perPage = 10, startDate, endDate, status = 'confirmed' }) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/globalApi/agency/bookingHistory`,
        {
          page,
          perPage:    String(perPage),
          search:     '',
          startDate:  this._formatDate(startDate),
          endDate:    this._formatDate(endDate),
          userId:     '',
          currencyId: this.currencyId,
          status,
          sourcetype: 'web',
        },
        { headers: this._headers(), timeout: this.timeout }
      );
      return response.data;
    } catch (err) {
      logger.error('IABIRI booking history fetch failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // CITY ID RESOLVER
  // IABIRI uses numeric city IDs — cache them to avoid
  // repeated lookups. Populate IABIRI_CITY_MAP in your
  // env or Supabase once you have their city list.
  // ─────────────────────────────────────────────
  async _resolveCityId(cityName) {
    // 1. Check in-memory cache first
    const cached = this._cityCache()[cityName?.toLowerCase()];
    if (cached) return cached;

    // 2. Fallback: log and return null so search returns []
    // rather than calling with wrong IDs
    logger.warn('IABIRI: unmapped city name', { cityName });
    return null;
  }

  // City name → IABIRI city ID map
  // Expand this as you onboard routes — or load from Supabase
  _cityCache() {
    const envMap = process.env.IABIRI_CITY_MAP
      ? JSON.parse(process.env.IABIRI_CITY_MAP)
      : {};

    return {
      // Kenya defaults (add more as needed)
      'nairobi':   '1',
      'mombasa':   '114',
      'kisumu':    '12',
      'nakuru':    '8',
      'eldoret':   '15',
      'thika':     '6',
      'kampala':   '200',  // Uganda
      'dar es salaam': '300', // Tanzania
      ...envMap,
    };
  }

  // ─────────────────────────────────────────────
  // NORMALIZERS
  // Map IABIRI → Bodrless standard format
  // ─────────────────────────────────────────────
  _normalizeBuses(data, sourceCityId, destCityId, date) {
    const buses = data?.data || data?.buses || data?.trips || data || [];
    if (!Array.isArray(buses)) return [];

    return buses.map(bus => ({
      // Bodrless standard fields
      supplier:       this.supplier,
      type:           'bus',
      transportType:  'bus',

      // Trip identifiers (needed for seat/booking calls)
      tripId:         bus.trip_id || bus.id,
      busId:          bus.bus_id || bus.id,
      routeId:        bus.route_id || null,
      token:          bus.token || null,          // needed for RoundBooking
      sourceCityId,
      destCityId,

      // Route info
      route:          `${bus.source_city || bus.from}-${bus.destination_city || bus.to}`,
      origin:         bus.source_city || bus.from,
      destination:    bus.destination_city || bus.to,

      // Times
      departureTime:  bus.departure_time || bus.departs_at || bus.start_time,
      arrivalTime:    bus.arrival_time   || bus.arrives_at  || bus.end_time,
      duration:       bus.duration || null,
      travelDate:     this._formatDate(date),

      // Provider
      provider:       bus.travels || bus.operator || bus.company_name || bus.bus_company,
      busType:        bus.bus_type || bus.coach_type || 'Standard',
      busNumber:      bus.bus_number || bus.vehicle_no || null,

      // Amenities
      amenities:      bus.amenities || bus.bus_amenities || [],
      hasLiveTracking: bus.live_tracking || false,
      rating:         bus.avg_rating || bus.rating || null,

      // Pricing
      price:          Number(bus.fare || bus.price || bus.amount || 0),
      currency:       'KES',

      // Availability
      availableSeats: bus.available_seats || bus.seats_available || null,
      totalSeats:     bus.total_seats || bus.capacity || null,

      // Delay info
      isDelayed:      bus.is_delayed || false,
      delayedFlag:    bus.delayedFlag || 0,
      delayedDate:    bus.delayedDate || null,

      // Extras
      cancellationPolicy: bus.cancellation_policy || 'Non-refundable',
      supplierBookingReference: null, // set after booking
    }));
  }

  _normalizeSeats(data) {
    const seats = data?.seats || data?.seat_data || data?.data || data || [];
    if (!Array.isArray(seats)) return [];

    return seats.map(seat => ({
      supplier:     this.supplier,
      seatNumber:   seat.seat_number || seat.number || seat.seatNo,
      status:       seat.status || (seat.available ? 'available' : 'booked'),
      type:         seat.seat_type || seat.type || 'standard',
      deck:         seat.deck || seat.floor || 'lower',
      position:     seat.position || null,         // window / aisle
      price:        Number(seat.price || seat.fare || 0),
      currency:     'KES',
    }));
  }

  _normalizeBoardingPoints(data) {
    const bp = data?.boarding_points || data?.boardingPoints || [];
    const dp = data?.dropping_points || data?.droppingPoints || [];

    const normalize = (points) => points.map(p => ({
      id:       p.id || p.point_id,
      name:     p.name || p.point_name,
      time:     p.time || p.pickup_time || null,
      address:  p.address || p.location || null,
      landmark: p.landmark || null,
    }));

    return {
      boardingPoints: normalize(bp),
      droppingPoints: normalize(dp),
    };
  }

  _normalizeBooking(data) {
    const ticket = data?.ticket || data?.data || data;
    return {
      supplier:                  this.supplier,
      supplierBookingReference:  ticket?.booking_ref || ticket?.bookingRef || ticket?.reference || ticket?.id,
      ticketId:                  ticket?.ticket_id   || ticket?.ticketId   || null,
      bodrlessRef:               null, // set by booking handler
      status:                    ticket?.status || 'pending',
      tripId:                    ticket?.trip_id || null,
      seats:                     ticket?.seats   || ticket?.seat_numbers || [],
      totalAmount:               Number(ticket?.total_amount || ticket?.amount || ticket?.fare || 0),
      currency:                  'KES',
      passengerDetails:          ticket?.passengers || [],
      ticketUrl:                 ticket?.ticket_url  || ticket?.ticket || null,
      boardingPoint:             ticket?.boarding_point || null,
      droppingPoint:             ticket?.dropping_point || null,
      confirmedAt:               ticket?.confirmed_at || new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────
  _filterByTime(buses, timePreference) {
    if (!timePreference) return buses;

    return buses.filter(bus => {
      if (!bus.departureTime) return true;
      // Handle both full ISO strings and "HH:MM" strings
      const raw  = bus.departureTime;
      const hour = raw.includes('T')
        ? new Date(raw).getHours()
        : parseInt(raw.split(':')[0], 10);

      if (timePreference === 'morning')   return hour >= 5  && hour < 12;
      if (timePreference === 'afternoon') return hour >= 12 && hour < 17;
      if (timePreference === 'evening')   return hour >= 17 && hour < 21;
      if (timePreference === 'night')     return hour >= 21 || hour  < 5;
      return true;
    });
  }

  _formatDate(date) {
    if (!date) return new Date().toISOString().split('T')[0];
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return new Date(date).toISOString().split('T')[0];
  }

  _toUnixTimestamp(date) {
    return Math.floor(new Date(this._formatDate(date)).getTime() / 1000);
  }

  _headers() {
    return {
      'authorization': this.apiKey,
      'Content-Type':  'application/json',
    };
  }
}

module.exports = new IabiriAdapter();