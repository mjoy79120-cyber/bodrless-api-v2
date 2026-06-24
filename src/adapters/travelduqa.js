/**
 * TRAVELDUQA ADAPTER
 * ─────────────────────────────────────────────
 * Normalizes TravelDuqa API responses into
 * Bodrless standard format
 *
 * Base URL:  https://www.app.travelduqa.africa/connect
 * Auth:      Bearer token (TRAVELDUQA_ACCESS_TOKEN)
 * Version:   Travelduqa-Version: v1
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

// EAT = UTC+3 — used for all time parsing to avoid host TZ issues
const EAT_OFFSET_HOURS = 3;

class TravelDuqaAdapter {

  constructor() {
    this.baseUrl      = 'https://www.app.travelduqa.africa/connect';
    this.token        = process.env.TRAVELDUQA_ACCESS_TOKEN;
    this.version      = process.env.TRAVELDUQA_API_VERSION || 'v1';
    this.timeout        = 15000;
    this.searchTimeout  = 30000;
    this.supplier = 'travelduqa';

    this._iataCache = null;
  }

  // ─────────────────────────────────────────────
  // SEARCH FLIGHTS
  // ─────────────────────────────────────────────
  async search({ origin, destination, date, returnDate = null, passengers = 1,
                 cabinClass = 'economy', timePreference = null, children = 0, infants = 0 }) {
    try {
      console.log('CRITICAL: TravelDuqa search invoked with:', { origin, destination, date });
      logger.info('TravelDuqa: searching flights', { origin, destination, date });

      const [depIata, arrIata] = await Promise.all([
        this._resolveIata(origin),
        this._resolveIata(destination),
      ]);

      console.log('CRITICAL: Resolved IATA codes:', { depIata, arrIata });

      if (!depIata || !arrIata) {
        console.log(`CRITICAL: Bailing out because IATA failed for ${origin} -> ${destination}`);
        logger.warn('TravelDuqa: could not resolve IATA codes', { origin, destination });
        return [];
      }

      const flightType = returnDate ? 'return' : 'oneway';

      const payload = {
        journey: {
          flight_type:    flightType,
          cabin_class:    cabinClass,
          depature:      depIata,                // FIXED: spelling
          arrival:        arrIata,
          depature_date: this._formatDate(date), // FIXED: spelling
          arrival_date:   returnDate ? this._formatDate(returnDate) : "", // FIXED: Removed hyphen
          adult_count:    passengers,
          child_count:    children,
          infant_count:   infants,
          currency:       'KES',
          page:           { length: 10 },         // FIXED: Passed as integer
        },
      };

      console.log('TRAVELDUQA REQUEST PAYLOAD:', JSON.stringify({
        token: this.token ? `${this.token.slice(0, 8)}...` : 'MISSING',
        version: this.version,
        ...payload.journey
      }, null, 2));

      const response = await axios.post(
        `${this.baseUrl}/getOffers`,
        payload,
        { headers: this._headers(), timeout: this.searchTimeout }
      );

      console.log('TRAVELDUQA RAW RESPONSE:', JSON.stringify(response.data, null, 2));

      const offers   = response.data?.data       || [];
      const resultId = response.data?.result_id  || null;

      const flights = this._normalizeOffers(offers, resultId);
      return this._filterByTime(flights, timePreference);

    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');

      console.log('TRAVELDUQA ERROR DETAIL:', JSON.stringify({
        message: err.message,
        isTimeout,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));

      if (isTimeout) {
        logger.error(`TravelDuqa search timed out after ${this.searchTimeout}ms`);
      } else {
        logger.error('TravelDuqa search failed', { error: err.message });
      }
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // SELECT OFFER
  // ─────────────────────────────────────────────
  async selectOffer({ resultId, offerId }) {
    try {
      logger.info('TravelDuqa: selecting offer', { offerId });

      const response = await axios.post(
        `${this.baseUrl}/selectOffer`,
        { result_id: resultId, offer_id: offerId },
        { headers: this._headers(), timeout: this.timeout }
      );

      console.log('TRAVELDUQA SELECTOFFER RAW RESPONSE:', JSON.stringify(response.data, null, 2));

      return this._normalizeSingleOffer(response.data);

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa selectOffer timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa selectOffer failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOK FLIGHT
  // paymentType: 'balance' (instant) | 'hold'
  // ─────────────────────────────────────────────
  async book({ resultId, offerId, passengers, totalAmount, currency = 'KES',
                paymentType = 'balance', sendEticket = true }) {
    try {
      logger.info('TravelDuqa: creating booking', { offerId, passengers: passengers.length });

      const response = await axios.post(
        `${this.baseUrl}/createBooking`,
        {
          result_id:  resultId,
          offer_id:   offerId,
          passengers: passengers.map((p, index) => {
            const row = {
              born_on:     p.dateOfBirth  || p.born_on,
              title:       p.title        || 'Mr',
              gender:      (p.gender      || 'male').toLowerCase(),
              family_name: p.lastName     || p.family_name,
              given_name:  p.firstName    || p.given_name,
              type:        p.type         || 'adult',
            };

            if (index === 0) {
              const { code, number } = this._parsePhone(p.phone || p.phoneNumber, p.phoneCode);
              row.phone_number = number;
              row.phone_code   = code;
              row.email        = p.email;
            }

            return row;
          }),
          payments: {
            type:     paymentType,
            currency: currency,
            amount:   String(totalAmount),
          },
          eticket: sendEticket,
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeBooking(response.data?.booking_data);

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa booking timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa booking failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // COMPLETE HELD BOOKING
  // ─────────────────────────────────────────────
  async completeHoldBooking({ orderId, sendEticket = false }) {
    try {
      const response = await axios.put(
        `${this.baseUrl}/updateBookingState`,
        {
          id:       orderId,
          payments: { type: 'balance' },
          eticket:  sendEticket,
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeBooking(response.data?.booking_data);

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa completeHold timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa completeHold failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET BOOKING STATUS
  // ─────────────────────────────────────────────
  async getStatus(orderId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/getBooking`,
        { id: orderId },
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeBooking(response.data);

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa getStatus timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa getStatus failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET ALL BOOKINGS
  // ─────────────────────────────────────────────
  async getBookingHistory({ page = 1, perPage = 10 } = {}) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/getAllBookings`,
        { page: { length: perPage, page_level: page } },
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data?.bookings || [];

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa getBookingHistory timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa getBookingHistory failed', { error: err.message });
      }
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL BOOKING
  // ─────────────────────────────────────────────
  async cancel(orderId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/cancelBooking`,
        { order_id: orderId },
        { headers: this._headers(), timeout: this.timeout }
      );

      return {
        cancellationId: response.data?.cancellation_id,
        message:        response.data?.message,
      };

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa cancel timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa cancel failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET CANCELLATION STATUS
  // ─────────────────────────────────────────────
  async getCancellationStatus(cancellationId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/getBookingCancellationStatus`,
        { cancellation_id: cancellationId },
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data;

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa getCancellationStatus timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa getCancellationStatus failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CONFIRM CANCELLATION (refund)
  // ─────────────────────────────────────────────
  async confirmCancellation({ cancellationId, amount, currency = 'KES' }) {
    try {
      const response = await axios.put(
        `${this.baseUrl}/confirmCancellation`,
        {
          cancellation_id: cancellationId,
          payments: { type: 'refund', currency, amount },
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data;

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa confirmCancellation timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa confirmCancellation failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOKING CHANGE REQUESTS
  // ─────────────────────────────────────────────
  async requestChange({ orderId, changeType, changeData }) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/bookingChange`,
        {
          order_id:       orderId,
          change_request: [{ type_of_change: changeType, change_data: changeData }],
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return {
        changeId: response.data?.order_change_request_id,
        message:  response.data?.message,
      };

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa requestChange timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa requestChange failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // PAY CHANGE FEE
  // ─────────────────────────────────────────────
  async payChangeFee({ changeId, amount, currency = 'KES' }) {
    try {
      const response = await axios.put(
        `${this.baseUrl}/payChangeFees`,
        {
          change_id: changeId,
          payments:  { type: 'balance', currency, amount },
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data;

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa payChangeFee timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa payChangeFee failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET CHANGE STATUS
  // ─────────────────────────────────────────────
  async getChangeStatus(changeId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/getBookingChangeStatus`,
        { change_id: changeId },
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data;

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa getChangeStatus timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa getChangeStatus failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET LOCATIONS
  // ─────────────────────────────────────────────
  async getLocations({ filter = 'none', value = 'all' } = {}) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/getLocation`,
        { filter, value },
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data || [];

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa getLocations timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa getLocations failed', { error: err.message });
      }
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // GET AIRLINES
  // ─────────────────────────────────────────────
  async getAirlines() {
    try {
      const response = await axios.post(
        `${this.baseUrl}/getAirlines`,
        {},
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data?.data || [];

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa getAirlines timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa getAirlines failed', { error: err.message });
      }
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // GET WALLET STATUS
  // ─────────────────────────────────────────────
  async getWalletStatus() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/getWalletStatus`,
        { headers: this._headers(), timeout: this.timeout }
      );

      return response.data;

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`TravelDuqa getWalletStatus timed out after ${this.timeout}ms`);
      } else {
        logger.error('TravelDuqa getWalletStatus failed', { error: err.message });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // IATA RESOLVER
  // ─────────────────────────────────────────────
  async _resolveIata(cityName) {
    if (!cityName) return null;

    const normalized = cityName.toLowerCase().trim();

    const hardcoded = this._iataMap()[normalized];
    if (hardcoded) return hardcoded;

    try {
      if (!this._iataCache) {
        const locations  = await this.getLocations({ filter: 'none', value: 'all' });
        this._iataCache  = {};
        for (const loc of locations) {
          if (loc.city) this._iataCache[loc.city.toLowerCase()]    = loc.iata;
          if (loc.name) this._iataCache[loc.name.toLowerCase()]    = loc.iata;
          if (loc.iata) this._iataCache[loc.iata.toLowerCase()]    = loc.iata;
        }
      }

      const exact = this._iataCache[normalized];
      if (exact) return exact;

      const fuzzyFromMap = this._fuzzyMatch(normalized, Object.keys(this._iataMap()));
      if (fuzzyFromMap) {
        logger.info('TravelDuqa: fuzzy-matched city name', { input: cityName, matched: fuzzyFromMap });
        return this._iataMap()[fuzzyFromMap];
      }

      const fuzzyFromCache = this._fuzzyMatch(normalized, Object.keys(this._iataCache));
      if (fuzzyFromCache) {
        logger.info('TravelDuqa: fuzzy-matched city name (live cache)', { input: cityName, matched: fuzzyFromCache });
        return this._iataCache[fuzzyFromCache];
      }

      return null;

    } catch {
      const fuzzyFromMap = this._fuzzyMatch(normalized, Object.keys(this._iataMap()));
      return fuzzyFromMap ? this._iataMap()[fuzzyFromMap] : null;
    }
  }

  // ─────────────────────────────────────────────
  // CHECK IF AN AIRPORT IS IN TRAVELDUQA'S NETWORK
  // ─────────────────────────────────────────────
  async isAirportSupported(iataCode) {
    if (!iataCode) return false;
    const normalized = iataCode.toLowerCase();

    try {
      if (!this._iataCache) {
        const locations = await this.getLocations({ filter: 'none', value: 'all' });
        this._iataCache = {};
        for (const loc of locations) {
          if (loc.city) this._iataCache[loc.city.toLowerCase()] = loc.iata;
          if (loc.name) this._iataCache[loc.name.toLowerCase()] = loc.iata;
          if (loc.iata) this._iataCache[loc.iata.toLowerCase()] = loc.iata;
        }
      }
      return Object.values(this._iataCache).some(code => code?.toLowerCase() === normalized);
    } catch (err) {
      logger.error('TravelDuqa isAirportSupported check failed', { error: err.message });
      return false; 
    }
  }

  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  _fuzzyMatch(input, candidates) {
    let best = null;
    let bestDistance = Infinity;

    for (const candidate of candidates) {
      const distance = this._levenshtein(input, candidate);
      const maxAllowed = candidate.length <= 5 ? 1 : candidate.length <= 9 ? 2 : 3;
      if (distance <= maxAllowed && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }

    return best;
  }

  _iataMap() {
    return {
      'nairobi': 'NBO', 'jkia': 'NBO', 'mombasa': 'MBA', 'kisumu': 'KIS',
      'eldoret': 'EDL', 'lamu': 'LAU', 'malindi': 'MYD',
      'ukunda': 'UKA', 'diani': 'UKA', 'diani beach': 'UKA',
      'lodwar': 'LOK', 'wajir': 'WJR', 'kitale': 'KTL', 'kakamega': 'GGM',
      'wilson': 'WIL', 'dar es salaam': 'DAR', 'zanzibar': 'ZNZ',
      'kilimanjaro': 'JRO', 'arusha': 'ARK', 'mwanza': 'MWZ',
      'kampala': 'EBB', 'entebbe': 'EBB', 'kigali': 'KGL',
      'addis ababa': 'ADD', 'johannesburg': 'JNB', 'cape town': 'CPT',
      'dubai': 'DXB', 'london': 'LHR', 'new york': 'JFK',
    };
  }

  // ─────────────────────────────────────────────
  // DYNAMIC PHONE PARSER
  // ─────────────────────────────────────────────
  _parsePhone(rawPhone, explicitCode) {
    if (!rawPhone) return { code: '+254', number: '' };

    const cleaned = String(rawPhone).replace(/\s+/g, '');

    if (explicitCode) {
      const strippedCode = explicitCode.replace(/^\+/, '');
      const number = cleaned.startsWith('+' + strippedCode)
        ? cleaned.slice(strippedCode.length + 1)
        : cleaned.startsWith(strippedCode)
          ? cleaned.slice(strippedCode.length)
          : cleaned;
      return { code: explicitCode.startsWith('+') ? explicitCode : '+' + explicitCode, number };
    }

    const countryCodeMap = [
      { prefix: '+254', code: '+254' },
      { prefix: '+256', code: '+256' },
      { prefix: '+255', code: '+255' },
      { prefix: '+250', code: '+250' },
      { prefix: '+251', code: '+251' },
      { prefix: '+27',  code: '+27'  },
      { prefix: '+1',   code: '+1'   },
      { prefix: '+44',  code: '+44'  },
    ];

    for (const { prefix, code } of countryCodeMap) {
      if (cleaned.startsWith(prefix)) {
        return { code, number: cleaned.slice(prefix.length) };
      }
    }

    return {
      code:   '+254',
      number: cleaned.startsWith('0') ? cleaned.slice(1) : cleaned,
    };
  }

  // ─────────────────────────────────────────────
  // NORMALIZERS
  // ─────────────────────────────────────────────
  _normalizeOffers(offers, resultId) {
    if (!Array.isArray(offers)) return [];

    return offers.map(offer => {
      const slices   = offer.slices || [];
      const isReturn = slices.length > 1;

      const outSlice   = slices[0]    || {};
      const outSegment = outSlice.segments?.[0] || {};
      const outCarrier = outSegment.marketing_carrier || outSegment.operating_carrier || {};
      const baggage    = outSegment.passengers?.[0]?.baggages || [];

      const retSlice   = slices[1]    || null;
      const retSegment = retSlice?.segments?.[0] || null;
      const retCarrier = retSegment?.marketing_carrier || retSegment?.operating_carrier || {};

      return {
        supplier:      this.supplier,
        type:          'flight',
        transportType: 'flight',

        offerId:   offer.id,
        resultId:  resultId,
        expiresAt: offer.expires_at,

        origin:        outSlice.origin?.city_name      || outSlice.origin?.iata_code,
        destination:   outSlice.destination?.city_name || outSlice.destination?.iata_code,
        originIata:    outSlice.origin?.iata_code,
        destIata:      outSlice.destination?.iata_code,
        originAirport: outSlice.origin?.name,
        destAirport:   outSlice.destination?.name,
        departureTime: outSlice.departing_day   || outSegment.departing_at,
        arrivalTime:   outSlice.arriving_day    || outSegment.arriving_at,
        duration:      outSlice.duration,
        stops:         outSlice.stops           || 'Non Stop',
        airline:       outCarrier.name,
        airlineCode:   outCarrier.iata_code,
        airlineLogo:   outCarrier.logo          || null,
        flightNumber:  outSegment.marketing_carrier_flight_number,

        isReturn,
        returnLeg: retSlice ? {
          origin:        retSlice.origin?.city_name      || retSlice.origin?.iata_code,
          destination:   retSlice.destination?.city_name || retSlice.destination?.iata_code,
          originIata:    retSlice.origin?.iata_code,
          destIata:      retSlice.destination?.iata_code,
          departureTime: retSlice.departing_day   || retSegment?.departing_at,
          arrivalTime:   retSlice.arriving_day    || retSegment?.arriving_at,
          duration:      retSlice.duration,
          stops:         retSlice.stops           || 'Non Stop',
          airline:       retCarrier.name,
          airlineCode:   retCarrier.iata_code,
          airlineLogo:   retCarrier.logo          || null,
          flightNumber:  retSegment?.marketing_carrier_flight_number,
        } : null,

        cabinClass:  outSegment.passengers?.[0]?.cabin_class_marketing_name || 'Economy',
        baggage,
        checkedBags: baggage.find(b => b.type === 'checked')?.quantity || 0,
        carryOn:     baggage.find(b => b.type === 'carry_on' || b.type === 'carryon')?.quantity || 0,

        price:     Number(offer.total_amount || 0),
        currency:  offer.total_currency || 'KES',
        emissions: offer.total_emmissions_kg || null,

        canBook: offer.offer_terms?.create_booking === 'true',
        canHold: offer.offer_terms?.hold === 'true',

        passengerIds: offer.passengers || [],

        slices,

        supplierBookingReference: null,
      };
    });
  }

  _normalizeSingleOffer(offer) {
    if (!offer) return null;
    const normalized = this._normalizeOffers([offer], null)[0];
    normalized.conditions     = offer.conditions || [];
    normalized.originTerminal = offer.slices?.[0]?.segments?.[0]?.origin_terminal      || null;
    normalized.destTerminal   = offer.slices?.[0]?.segments?.[0]?.destination_terminal || null;
    return normalized;
  }

  _normalizeBooking(data) {
    if (!data) return null;

    const slice   = data.slices?.[0]    || {};
    const segment = slice.segments?.[0] || {};

    return {
      supplier:                 this.supplier,
      supplierBookingReference: data.BookingReference || data.reference_id,
      orderId:                  data.id,
      bodrlessRef:              null,
      status:                   data.status    || 'success',
      holdPeriod:               data.hold_period || null,

      origin:        slice.origin?.city_name,
      destination:   slice.destination?.city_name,
      departureTime: slice.departing_day  || segment.departing_at,
      arrivalTime:   slice.arriving_day   || segment.arriving_at,
      airline:       segment.operating_carrier?.name || segment.marketing_carrier?.name,
      flightNumber:  segment.marketing_carrier_flight_number,

      ticketReference: data.TicketReference || [],
      ticketNumber:    data.TicketReference?.[0]?.number || null,

      totalAmount:   Number(data.TotalPrice?.amount || 0),
      currency:      data.TotalPrice?.currency || 'KES',

      walletBalance: data.receipt?.wallet_balance || null,
      bookingAmount: data.receipt?.booking_amount || null,
      feeAmount:     data.receipt?.fee_amount     || null,

      passengerDetails: data.passengers || [],
      slices:           data.slices     || [],

      confirmedAt: new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────
  // TIME FILTER USING EAT (UTC+3)
  // ─────────────────────────────────────────────
  _filterByTime(flights, timePreference) {
    if (!timePreference) return flights;

    return flights.filter(f => {
      if (!f.departureTime) return true;
      const hour = this._eatHour(f.departureTime);

      if (timePreference === 'morning')   return hour >= 5  && hour < 12;
      if (timePreference === 'afternoon') return hour >= 12 && hour < 17;
      if (timePreference === 'evening')   return hour >= 17 && hour < 21;
      if (timePreference === 'night')     return hour >= 21 || hour < 5;
      return true;
    });
  }

  _eatHour(dateStr) {
    try {
      const utcMs  = new Date(dateStr).getTime();
      const eatMs  = utcMs + EAT_OFFSET_HOURS * 60 * 60 * 1000;
      return new Date(eatMs).getUTCHours();
    } catch {
      return 0;
    }
  }

  _formatDate(date) {
    if (!date) return new Date().toISOString().split('T')[0];
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return new Date(date).toISOString().split('T')[0];
  }

  _headers() {
    return {
      'Content-Type':       'application/json',
      'Accept':             'application/json',
      'Travelduqa-Version': this.version,
      'Authorization':      `Bearer ${this.token}`,
    };
  }
}

module.exports = new TravelDuqaAdapter();