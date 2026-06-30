/**
 * DUFFEL ADAPTER
 * ─────────────────────────────────────────────
 * Normalizes Duffel API responses into
 * Bodrless standard flight format. Runs as a SECOND, PARALLEL
 * flight supplier alongside TravelDuqa (see adapters/index.js
 * searchTransport) — not a replacement. Duffel covers routes/
 * airlines TravelDuqa's sandbox doesn't have inventory for.
 *
 * Base URL:  https://api.duffel.com
 * Auth:      Bearer token (DUFFEL_ACCESS_TOKEN) + Duffel-Version header
 * Docs:      https://duffel.com/docs/api/overview/welcome
 *
 * Test vs live mode is determined entirely by which token you use —
 * test tokens start with "duffel_test_" and only ever return/access
 * test-mode resources (Duffel Airways, IATA code ZZ, unrealistic
 * prices/schedules — same purpose as TravelDuqa's "Test Environment"
 * content field). There is no separate sandbox base URL to switch,
 * unlike HotelBeds — same api.duffel.com host for both modes.
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

class DuffelAdapter {

  constructor() {
    this.baseUrl   = 'https://api.duffel.com';
    this.token     = process.env.DUFFEL_ACCESS_TOKEN;
    this.version   = process.env.DUFFEL_API_VERSION || 'v2';
    this.timeout       = Number(process.env.DUFFEL_TIMEOUT_MS) || 15000;
    // SEARCH hot path. Mirrors travelduqa.js's reasoning exactly: the
    // engine can run this in parallel with TravelDuqa+bus search, and
    // a single supplier's own slow timeout shouldn't be allowed to eat
    // the whole product latency budget. Duffel's own supplier_timeout
    // query param (sent below, capped 2s-60s per their docs) tells
    // Duffel itself how long to wait on individual airlines — this is
    // the OUTER axios timeout, the backstop if Duffel's own response
    // takes longer than expected even after their internal cutoff.
    this.searchTimeout = Number(process.env.DUFFEL_SEARCH_TIMEOUT_MS) || 9000;
    // Duffel's own per-airline wait budget (ms) — passed as
    // ?supplier_timeout= on offer_request creation. Kept comfortably
    // under this.searchTimeout so Duffel has time to respond with
    // whatever it collected before our own axios timeout fires.
    this.supplierTimeout = Number(process.env.DUFFEL_SUPPLIER_TIMEOUT_MS) || 7000;
    this.supplier = 'duffel';
  }

  // ─────────────────────────────────────────────
  // SEARCH
  // Mirrors travelduqa.js's search({ origin, destination, date,
  // returnDate, passengers, ... }) signature exactly, since both are
  // called identically from adapters/index.js's searchTransport.
  // Duffel slices use plain IATA codes directly (no separate
  // city->IATA resolution step the way TravelDuqa needed — Duffel
  // accepts city codes like "NYC" too, but Bodrless already resolves
  // to airport IATA upstream in promptParser/CITY_CODES, so we pass
  // those straight through).
  // ─────────────────────────────────────────────
  async search({ origin, destination, date, returnDate = null, passengers = 1,
                 cabinClass = 'economy', timePreference = null, children = 0, infants = 0 }) {
    try {
      logger.info('Duffel: searching flights', { origin, destination, date });

      const originIata = this._resolveIata(origin);
      const destIata    = this._resolveIata(destination);

      if (!originIata || !destIata) {
        logger.warn('Duffel: could not resolve IATA codes', { origin, destination });
        return [];
      }

      const slices = [{ origin: originIata, destination: destIata, departure_date: this._formatDate(date) }];
      if (returnDate) {
        slices.push({ origin: destIata, destination: originIata, departure_date: this._formatDate(returnDate) });
      }

      // Adults get type:"adult"; anyone under 18 needs a real age per
      // Duffel's docs ("you may only specify an age or a type — not
      // both"). children/infants here are counts, not ages — Bodrless's
      // child-age flow (see promptParser childAges) should be threaded
      // through as real ages once multi-supplier child pricing is
      // wired end-to-end; until then this defaults young passengers to
      // age 10 (a safe, conservative non-infant child fare) rather
      // than silently dropping them from the search, and logs a
      // warning so this default is visible, not silent.
      const passengerList = [];
      for (let i = 0; i < passengers; i++) passengerList.push({ type: 'adult' });
      for (let i = 0; i < children; i++) passengerList.push({ age: 10 });
      for (let i = 0; i < infants; i++) passengerList.push({ age: 1 });
      if (children > 0) {
        logger.warn('Duffel: child ages not yet threaded through from search params — defaulting to age 10', { children });
      }

      const payload = {
        data: {
          slices,
          passengers: passengerList,
          cabin_class: this._mapCabinClass(cabinClass),
          max_connections: 1,
        },
      };

      console.log('DUFFEL REQUEST PAYLOAD:', JSON.stringify({
        token: this.token ? `${this.token.slice(0, 14)}...` : 'MISSING',
        ...payload.data,
      }, null, 2));

      const response = await axios.post(
        `${this.baseUrl}/air/offer_requests`,
        payload,
        {
          headers: this._headers(),
          params: { return_offers: true, supplier_timeout: this.supplierTimeout },
          timeout: this.searchTimeout,
        }
      );

      const offers = response.data?.data?.offers || [];
      const offerRequestId = response.data?.data?.id || null;

      console.log('DUFFEL RESULTS:', offers.length, 'offers, offer_request_id:', offerRequestId);

      const flights = this._normalizeOffers(offers, offerRequestId);
      return this._filterByTime(flights, timePreference);

    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');

      console.log('DUFFEL ERROR DETAIL:', JSON.stringify({
        message: err.message,
        isTimeout,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));

      if (isTimeout) {
        logger.error(`Duffel search timed out after ${this.searchTimeout}ms`);
      } else {
        logger.error('Duffel search failed', { error: err.message, detail: err.response?.data });
      }
      // Same contract as travelduqa.js: a supplier failure returns
      // empty, never throws — the engine's Promise.all across
      // suppliers must not have one bad supplier take down the whole
      // search. TravelDuqa/bus results still come through.
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // GET SINGLE OFFER (re-fetch before booking)
  // Per Duffel's own docs: "search prices returned by airlines are
  // not guaranteed to be available at the time of booking" — you
  // MUST re-fetch via this endpoint right before creating an order
  // to get the current total_amount/total_currency. This is the
  // same structural requirement as HotelBeds' checkRate() and the
  // DOB-age reconciliation built earlier this session — search-time
  // and booking-time can legitimately disagree, and the booking flow
  // must reconcile against the freshest data, not the stale search
  // result, before charging anyone.
  // ─────────────────────────────────────────────
  async getOffer(offerId) {
    try {
      logger.info('Duffel: refetching offer', { offerId });

      const response = await axios.get(
        `${this.baseUrl}/air/offers/${offerId}`,
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeSingleOffer(response.data?.data);

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.error(`Duffel getOffer timed out after ${this.timeout}ms`);
      } else {
        logger.error('Duffel getOffer failed', { error: err.message, detail: err.response?.data });
      }
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOK (create order)
  // payments.type: 'balance' requires Duffel Managed Content/wallet
  // balance — same model as Duffel's own getting-started guide. If
  // Bodrless ever needs arc_bsp_cash (registered IATA agent using
  // your own airline relationships) that's a different payment type,
  // not something this method should silently assume.
  // ─────────────────────────────────────────────
  async book({ offerId, offerRequestId, passengers, totalAmount, totalCurrency }) {
    try {
      logger.info('Duffel: creating order', { offerId, passengers: passengers.length });

      const payload = {
        data: {
          selected_offers: [offerId],
          payments: [{
            type:     'balance',
            currency: totalCurrency,
            amount:   String(totalAmount),
          }],
          passengers: passengers.map(p => ({
            id:          p.duffelPassengerId, // from the offer request's echoed passengers[].id
            title:       (p.title || 'mr').toLowerCase(),
            gender:      (p.gender || 'm').toLowerCase().charAt(0), // Duffel wants 'm'/'f'
            given_name:  p.firstName,
            family_name: p.lastName,
            born_on:     p.dateOfBirth,
            email:       p.email,
            phone_number: p.phone,
            ...(p.infantPassengerId ? { infant_passenger_id: p.infantPassengerId } : {}),
          })),
        },
      };

      console.log('DUFFEL ORDER REQUEST:', JSON.stringify(payload, null, 2));

      const response = await axios.post(
        `${this.baseUrl}/air/orders`,
        payload,
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeOrder(response.data?.data);

    } catch (err) {
      console.log('DUFFEL ORDER ERROR:', JSON.stringify({
        message: err.message,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));
      logger.error('Duffel book failed', { error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL — via order cancellations resource
  // ─────────────────────────────────────────────
  async cancel(orderId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/air/order_cancellations`,
        { data: { order_id: orderId } },
        { headers: this._headers(), timeout: this.timeout }
      );
      return response.data?.data;
    } catch (err) {
      logger.error('Duffel cancel failed', { error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // IATA RESOLUTION
  // Unlike TravelDuqa, Duffel doesn't require a separate locations
  // API call — it accepts IATA codes (airport or city) directly in
  // the slice. Bodrless already resolves city names to IATA codes
  // upstream (promptParser's CITY_CODES / destinationIntel), so this
  // is a thin pass-through + sanity check, not a real resolution
  // step. Kept as its own method (rather than inlined) so a real
  // lookup can be added later without touching search()'s shape.
  // ─────────────────────────────────────────────
  _resolveIata(value) {
    if (!value) return null;
    const trimmed = String(value).trim();
    // Already looks like an IATA code (3 letters) — pass through.
    if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
    // Not a recognizable code — Bodrless's upstream resolution should
    // have handled this already; log so a real gap is visible rather
    // than silently failing the search.
    logger.warn('Duffel: received a non-IATA value for origin/destination, expected upstream resolution', { value: trimmed });
    return null;
  }

  _mapCabinClass(cabinClass) {
    const map = {
      economy: 'economy', business: 'business', first: 'first',
      premium_economy: 'premium_economy', premium: 'premium_economy',
    };
    return map[(cabinClass || '').toLowerCase()] || 'economy';
  }

  // ─────────────────────────────────────────────
  // NORMALIZE OFFERS (search results)
  // Same output shape as travelduqa.js's _normalizeOffers, so
  // engine.js/packageRanker.js handle both suppliers identically
  // without knowing which one a given result came from.
  // ─────────────────────────────────────────────
  _normalizeOffers(offers, offerRequestId) {
    if (!Array.isArray(offers)) return [];
    return offers.map(offer => {
      const slices    = offer.slices || [];
      const isReturn  = slices.length > 1;
      const outSlice  = slices[0] || {};
      const outSegs   = outSlice.segments || [];
      const firstSeg  = outSegs[0] || {};
      const lastSeg   = outSegs[outSegs.length - 1] || firstSeg;
      const carrier   = firstSeg.marketing_carrier || firstSeg.operating_carrier || {};

      const retSlice  = slices[1] || null;
      const retSegs   = retSlice?.segments || [];
      const retFirst  = retSegs[0] || {};
      const retLast   = retSegs[retSegs.length - 1] || retFirst;
      const retCarrier = retFirst.marketing_carrier || retFirst.operating_carrier || {};

      const stops = Math.max(0, outSegs.length - 1);

      return {
        supplier:      this.supplier,
        type:          'flight',
        transportType: 'flight',
        offerId:        offer.id,
        offerRequestId: offerRequestId,
        // Duffel echoes back passenger IDs on the offer request, not
        // the offer itself — book() needs these to attach passenger
        // details. Carried on the offer so engine.js doesn't need a
        // second round-trip to look them up.
        duffelPassengerIds: (offer.passengers || []).map(p => p.id),
        expiresAt:     offer.expires_at,
        origin:        outSlice.origin?.city_name      || outSlice.origin?.iata_code,
        destination:   outSlice.destination?.city_name || outSlice.destination?.iata_code,
        originIata:    outSlice.origin?.iata_code,
        destIata:      outSlice.destination?.iata_code,
        originAirport: outSlice.origin?.name,
        destAirport:   outSlice.destination?.name,
        departureTime: firstSeg.departing_at,
        arrivalTime:   lastSeg.arriving_at,
        duration:      outSlice.duration,
        stops:         stops,
        airline:       carrier.name,
        airlineCode:   carrier.iata_code,
        airlineLogo:   carrier.logo_symbol_url || null,
        flightNumber:  firstSeg.marketing_carrier_flight_number,
        isReturn,
        returnLeg: retSlice ? {
          origin:        retSlice.origin?.city_name      || retSlice.origin?.iata_code,
          destination:   retSlice.destination?.city_name || retSlice.destination?.iata_code,
          originIata:    retSlice.origin?.iata_code,
          destIata:      retSlice.destination?.iata_code,
          departureTime: retFirst.departing_at,
          arrivalTime:   retLast.arriving_at,
          duration:      retSlice.duration,
          stops:         Math.max(0, retSegs.length - 1),
          airline:       retCarrier.name,
          airlineCode:   retCarrier.iata_code,
          airlineLogo:   retCarrier.logo_symbol_url || null,
          flightNumber:  retFirst.marketing_carrier_flight_number,
        } : null,
        cabinClass:  firstSeg.passengers?.[0]?.cabin_class || 'economy',
        checkedBags: firstSeg.passengers?.[0]?.baggages?.find(b => b.type === 'checked')?.quantity || 0,
        carryOn:     firstSeg.passengers?.[0]?.baggages?.find(b => b.type === 'carry_on')?.quantity || 0,
        price:     Number(offer.total_amount || 0),
        currency:  offer.total_currency || 'KES',
        canBook:   true,  // Duffel offers are bookable unless expired; no separate flag like TravelDuqa's offer_terms
        canHold:   false, // Duffel doesn't have a TravelDuqa-style "hold" payment type in this adapter
        passengerIds: (offer.passengers || []).map(p => p.id),
        slices,
        supplierBookingReference: null,
      };
    });
  }

  _normalizeSingleOffer(offer) {
    if (!offer) return null;
    const normalized = this._normalizeOffers([offer], offer.offer_request_id || null)[0];
    normalized.conditions = offer.conditions || null;
    return normalized;
  }

  _normalizeOrder(order) {
    if (!order) return null;
    const slice   = order.slices?.[0]    || {};
    const segment = slice.segments?.[0]  || {};
    return {
      supplier:                 this.supplier,
      supplierBookingReference: order.booking_reference,
      orderId:                  order.id,
      status:                   order.status || 'confirmed',
      origin:        slice.origin?.city_name,
      destination:   slice.destination?.city_name,
      departureTime: segment.departing_at,
      arrivalTime:   segment.arriving_at,
      airline:       segment.operating_carrier?.name || segment.marketing_carrier?.name,
      flightNumber:  segment.marketing_carrier_flight_number,
      totalAmount:   Number(order.total_amount || 0),
      currency:      order.total_currency || 'KES',
      passengerDetails: order.passengers || [],
      documents:        order.documents  || [],
      confirmedAt: new Date().toISOString(),
    };
  }

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
      const utcMs = new Date(dateStr).getTime();
      const eatMs = utcMs + 3 * 60 * 60 * 1000; // EAT = UTC+3
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
      'Content-Type':    'application/json',
      'Accept':          'application/json',
      'Accept-Encoding': 'gzip',
      'Duffel-Version':  this.version,
      'Authorization':   `Bearer ${this.token}`,
    };
  }
}

module.exports = new DuffelAdapter();