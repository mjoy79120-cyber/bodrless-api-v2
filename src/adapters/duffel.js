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
    // Duffel's own age bands, from their passenger docs — used to
    // validate/clamp incoming ages and to pick a sane default only
    // as a last resort (see _resolveChildAge below).
    this.INFANT_MAX_AGE = 1;  // 0-1 (Duffel: under-2s should be 'infant' type territory, but Bodrless
                               // has no bassinet/lap-infant distinction upstream yet, so infants[] below
                               // still gets a flat default; child ages here cover the 2-17 band).
    this.CHILD_MIN_AGE  = 2;
    this.CHILD_MAX_AGE  = 17;
    this.DEFAULT_CHILD_AGE = 10; // fallback ONLY when no real age is available at all
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
  //
  // childAges: array of real ages (numbers, 2-17), one per child,
  // sourced from promptParser's childAges field and threaded through
  // engine.js -> adapters/index.js -> here. Falls back to the
  // `children` COUNT (with DEFAULT_CHILD_AGE per child) only when
  // childAges is missing/empty/shorter than the children count — this
  // keeps the adapter resilient to older callers or partially-parsed
  // prompts ("2 children" with no ages given) instead of throwing.
  // infantAges: same idea for infants (0-1), defaults to age 1 (the
  // safe non-lap-infant end of the band) when not supplied — lap-
  // infant fare handling (Duffel's true "infant" passenger type/
  // discount) is still not wired; see KNOWN GAPS in session notes.
  // ─────────────────────────────────────────────
  async search({ origin, destination, date, returnDate = null, passengers = 1,
                 cabinClass = 'economy', timePreference = null, children = 0, infants = 0,
                 childAges = [], infantAges = [] }) {
    try {
      logger.info('Duffel: searching flights', { origin, destination, date });

      const [originIata, destIata] = await Promise.all([
        this._resolveIata(origin),
        this._resolveIata(destination),
      ]);

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
      // both"). Real ages now come from promptParser's childAges/
      // infantAges when available (threaded through engine.js and
      // adapters/index.js's searchTransport call); only when a real
      // age is genuinely unavailable for a given passenger does this
      // fall back to a logged default, instead of silently defaulting
      // every child the way this used to.
      const passengerList = [];
      for (let i = 0; i < passengers; i++) passengerList.push({ type: 'adult' });

      for (let i = 0; i < children; i++) {
        const age = this._resolveChildAge(childAges[i], i);
        passengerList.push({ age });
      }

      for (let i = 0; i < infants; i++) {
        const age = this._resolveInfantAge(infantAges[i], i);
        passengerList.push({ age });
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
  // Resolve a single child's age for the passengers[] payload.
  // - Real numeric age in range -> use it, clamped to Duffel's child
  //   band (2-17) in case upstream parsing produced something like 1
  //   (should've been an infant) or 18+ (should've been an adult).
  // - Missing/invalid -> DEFAULT_CHILD_AGE, logged with the index so
  //   it's traceable to which child in the party got defaulted.
  // ─────────────────────────────────────────────
  _resolveChildAge(rawAge, index) {
    const age = Number(rawAge);
    if (Number.isFinite(age) && age >= this.CHILD_MIN_AGE && age <= this.CHILD_MAX_AGE) {
      return age;
    }
    if (Number.isFinite(age) && age >= 0) {
      const clamped = Math.min(Math.max(age, this.CHILD_MIN_AGE), this.CHILD_MAX_AGE);
      logger.warn('Duffel: child age out of 2-17 band, clamped', { childIndex: index, rawAge, clamped });
      return clamped;
    }
    logger.warn('Duffel: no real age for child, defaulting', { childIndex: index, default: this.DEFAULT_CHILD_AGE });
    return this.DEFAULT_CHILD_AGE;
  }

  _resolveInfantAge(rawAge, index) {
    const age = Number(rawAge);
    if (Number.isFinite(age) && age >= 0 && age <= this.INFANT_MAX_AGE) {
      return age;
    }
    if (Number.isFinite(age) && age >= 0) {
      logger.warn('Duffel: infant age out of 0-1 band, clamped', { infantIndex: index, rawAge });
      return this.INFANT_MAX_AGE;
    }
    logger.warn('Duffel: no real age for infant, defaulting', { infantIndex: index, default: this.INFANT_MAX_AGE });
    return this.INFANT_MAX_AGE;
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
  // NORMALIZE PHONE NUMBER TO E.164
  // BUG FIX (found via a real WhatsApp sandbox booking, 2026-07-04):
  // Duffel's API requires phone_number in strict E.164 format
  // (e.g. "+254712345678") and rejects anything else with a 422
  // invalid_phone_number error. Bodrless's WhatsApp booking flow
  // (whatsappBooking.js) takes the traveler's typed phone number at
  // face value — a Kenyan traveler will naturally type a local
  // format like "0712345678", not E.164 — and this was passed
  // straight through unchanged, so every real Duffel booking
  // attempt with a locally-formatted phone number would fail at the
  // book() step, right after a flight was successfully offered.
  //
  // Handles the formats a real Kenyan traveler is likely to type:
  //   "0712345678"     -> "+254712345678"  (local, leading 0)
  //   "254712345678"    -> "+254712345678"  (country code, no +)
  //   "+254712345678"   -> unchanged        (already E.164)
  //   anything else     -> returned unchanged, and Duffel's own
  //                        validation is left to catch genuine
  //                        garbage rather than guessing wrong and
  //                        silently sending a malformed number.
  //
  // Deliberately conservative: this only transforms patterns it can
  // be confident about for this platform's primary market (Kenya).
  // A number from a different country typed in local format (e.g.
  // a UK "07...") would NOT be safely convertible without knowing
  // the traveler's actual country, so those are left untouched and
  // will still surface Duffel's own clear validation error rather
  // than being silently mis-converted to a wrong country code.
  // ─────────────────────────────────────────────
  _normalizePhoneNumber(raw) {
    if (!raw) return raw;
    const trimmed = String(raw).trim();

    if (trimmed.startsWith('+')) return trimmed; // already E.164 — leave as-is

    const digitsOnly = trimmed.replace(/[^\d]/g, '');

    // Local Kenyan format: 07xxxxxxxx or 01xxxxxxxx (10 digits, leading 0)
    if (/^0\d{9}$/.test(digitsOnly)) {
      return `+254${digitsOnly.slice(1)}`;
    }

    // Country code without the leading +: 254712345678 (12 digits)
    if (/^254\d{9}$/.test(digitsOnly)) {
      return `+${digitsOnly}`;
    }

    // Unrecognized shape — don't guess. Return unchanged so Duffel's
    // own validation surfaces a clear error rather than us silently
    // sending a malformed number.
    logger.warn('Duffel: phone number did not match a recognized normalizable format, sending as-is', { raw });
    return trimmed;
  }

  // ─────────────────────────────────────────────
  // BOOK (create order)
  // payments.type: 'balance' requires Duffel Managed Content/wallet
  // balance — same model as Duffel's own getting-started guide. If
  // Bodrless ever needs arc_bsp_cash (registered IATA agent using
  // your own airline relationships) that's a different payment type,
  // not something this method should silently assume.
  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // BOOK (create order)
  // BUG FIX (found via a real "build Duffel flight booking" request,
  // 2026-07-03): this previously ALWAYS included `payments` (paying
  // immediately from Duffel's account balance) and never specified
  // the REQUIRED `type` field at all. That meant every booking
  // attempt would pay Duffel's real balance for the flight BEFORE
  // the traveler had paid Bodrless anything via M-Pesa — backwards
  // from the hold-now/pay-after-traveler-pays pattern used
  // everywhere else in this codebase (see travelduqa.js's
  // paymentType: 'hold' + completeHoldBooking()).
  //
  // Now defaults to `type: 'hold'` (payments key OMITTED entirely,
  // per Duffel's own validation rule) whenever the offer supports
  // it. Only uses `type: 'instant'` (payments included, paid
  // immediately) when explicitly requested — callers should only do
  // this for offers where offer.payment_requirements
  // .requires_instant_payment is true, since those can't be held at
  // all (see the new paymentRequirements field on search results).
  //
  // SEAT SELECTION CAVEAT — GENUINELY UNRESOLVED, FLAG THIS:
  // Duffel's current Orders documentation lists
  // `services_not_allowed_for_order_type` as an active validation
  // error for hold orders, but a 2023 Duffel changelog claims hold
  // orders WITH services (seats) were explicitly enabled. These two
  // sources contradict each other and I could not resolve which is
  // current without a real sandbox test. `services` is included
  // here when provided regardless — if Duffel's sandbox rejects it
  // for a hold order, the error will surface clearly via the normal
  // error handling below (not silently swallowed), telling us
  // definitively which is true. Do not assume this works until
  // confirmed against a real response.
  //
  // BUG FIX (found via a real WhatsApp sandbox booking, 2026-07-04):
  // phone_number now goes through _normalizePhoneNumber() before
  // being sent — see that method's comment for why. Previously the
  // raw, possibly-local-format phone string was sent unchanged and
  // Duffel rejected it with a 422 invalid_phone_number error.
  // ─────────────────────────────────────────────
  async book({ offerId, passengers, totalAmount, totalCurrency, type = 'hold', services = null }) {
    try {
      logger.info('Duffel: creating order', { offerId, passengers: passengers.length, type });

      const data = {
        type,
        selected_offers: [offerId],
        passengers: passengers.map(p => {
          const genderChar = (p.gender || 'm').toLowerCase().charAt(0); // Duffel wants 'm'/'f'
          // FIX: previously defaulted to 'mr' unconditionally when no
          // explicit title was given — meaning a female passenger with
          // no title supplied would incorrectly get "mr". Derive a
          // reasonable default from gender instead ('ms' is used
          // rather than 'mrs' since marital status isn't something
          // Bodrless collects or should assume).
          const title = p.title || (genderChar === 'f' ? 'ms' : 'mr');
          return {
            id:          p.duffelPassengerId, // REQUIRED — the real passenger_id echoed back on the offer, not invented
            title:       title.toLowerCase(),
            gender:      genderChar,
            given_name:  p.firstName,
            family_name: p.lastName,
            born_on:     p.dateOfBirth,
            email:       p.email,
            phone_number: this._normalizePhoneNumber(p.phone),
            ...(p.infantPassengerId ? { infant_passenger_id: p.infantPassengerId } : {}),
          };
        }),
      };

      // `payments` is REQUIRED for instant orders, and must be
      // OMITTED ENTIRELY for hold orders (Duffel rejects a hold
      // order that includes it — validation code
      // payments_not_allowed_for_order_type).
      if (type === 'instant') {
        data.payments = [{
          type:     'balance',
          currency: totalCurrency,
          amount:   String(totalAmount),
        }];
      }

      if (Array.isArray(services) && services.length > 0) {
        data.services = services.map(s => ({ id: s.serviceId, quantity: 1 }));
      }

      const payload = { data };

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

      // BUG FIX (found via a real WhatsApp sandbox booking, 2026-07-04):
      // Duffel's invalid_order_create_type error means this specific
      // offer genuinely requires instant payment and cannot be held —
      // even when the pre-booking check couldn't tell, because
      // offer.payment_requirements.requires_instant_payment came back
      // null/unconfirmed at search time rather than an explicit true
      // (see _normalizeOffers). Since Bodrless's whole architecture is
      // hold-then-collect-via-M-Pesa, we do NOT retry with
      // type: 'instant' here — that would pay Duffel's real balance
      // immediately, before the traveler has paid Bodrless anything,
      // which is the exact backwards pattern already fixed elsewhere
      // this session. Instead, surface a structured, identifiable
      // error so bookingService.js can show the same clean "this fare
      // requires instant payment, please choose a different flight"
      // message the pre-check was meant to produce, rather than a raw
      // supplier error reaching the traveler.
      const errorCode = err.response?.data?.errors?.[0]?.code;
      if (errorCode === 'invalid_order_create_type' && type === 'hold') {
        const structuredErr = new Error('This fare requires instant payment and cannot be held.');
        structuredErr.code = 'REQUIRES_INSTANT_PAYMENT';
        structuredErr.duffelResponse = err.response?.data;
        throw structuredErr;
      }

      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL — via order cancellations resource
  // ─────────────────────────────────────────────
  // ─────────────────────────────────────────────
  // CANCEL (order cancellation — two real steps, per Duffel's docs)
  // BUG FIX (found via a real Duffel Order Cancellation doc share,
  // 2026-07-03): this previously only ever created a PENDING
  // cancellation (step 1) and returned it — it never confirmed it
  // (step 2, POST .../actions/confirm). Per Duffel's own docs, the
  // booking is NOT actually cancelled with the airline until that
  // confirm call succeeds — the earlier version would report a
  // "successful" cancellation that never actually took effect on
  // Duffel's side.
  //
  // Mirrors TravelDuqa's own existing multi-step cancellation
  // pattern in this codebase (cancel -> getCancellationStatus ->
  // confirmCancellation) — split into two real methods here too, so
  // a caller CAN inspect refund_amount before confirming for a paid/
  // ticketed order. cancel() itself auto-confirms immediately,
  // which is safe for Bodrless's actual use case (cancelling unpaid
  // HOLD orders, where Duffel's docs confirm refund_amount is always
  // 0.00) — for a paid order needing refund review first, call
  // createOrderCancellation/confirmOrderCancellation separately
  // instead of this convenience wrapper.
  // ─────────────────────────────────────────────
  async createOrderCancellation(orderId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/air/order_cancellations`,
        { data: { order_id: orderId } },
        { headers: this._headers(), timeout: this.timeout }
      );
      const c = response.data?.data;
      return c ? {
        cancellationId:  c.id,
        orderId:         c.order_id,
        refundAmount:    c.refund_amount != null ? Number(c.refund_amount) : null,
        refundCurrency:  c.refund_currency || null,
        refundTo:        c.refund_to || null,
        expiresAt:       c.expires_at || null,
        confirmedAt:     c.confirmed_at || null,
      } : null;
    } catch (err) {
      logger.error('Duffel createOrderCancellation failed', { orderId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  async confirmOrderCancellation(cancellationId) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/air/order_cancellations/${cancellationId}/actions/confirm`,
        {},
        { headers: this._headers(), timeout: this.timeout }
      );
      const c = response.data?.data;
      return c ? {
        cancellationId:  c.id,
        orderId:         c.order_id,
        refundAmount:    c.refund_amount != null ? Number(c.refund_amount) : null,
        refundCurrency:  c.refund_currency || null,
        refundTo:        c.refund_to || null,
        confirmedAt:     c.confirmed_at || null,
      } : null;
    } catch (err) {
      logger.error('Duffel confirmOrderCancellation failed', { cancellationId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  async cancel(orderId) {
    const pending = await this.createOrderCancellation(orderId);
    if (!pending?.cancellationId) {
      throw new Error('Duffel did not return a usable cancellation ID.');
    }
    logger.info('Duffel: order cancellation created, confirming now', {
      orderId, cancellationId: pending.cancellationId, refundAmount: pending.refundAmount,
    });
    return this.confirmOrderCancellation(pending.cancellationId);
  }

  // ─────────────────────────────────────────────
  // GET ORDER (fetch current state/price)
  // Duffel's own documented best practice: "Before paying, you
  // should always get the latest price by retrieving the order to
  // minimise the risk that the price you have is different from the
  // latest price" — a stale amount/currency on the payment call
  // fails with a price_changed validation error. Always call this
  // immediately before payHoldOrder() rather than trusting whatever
  // total was captured at booking time.
  // ─────────────────────────────────────────────
  async getOrder(orderId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/air/orders/${orderId}`,
        { headers: this._headers(), timeout: this.timeout }
      );
      return this._normalizeOrder(response.data?.data);
    } catch (err) {
      logger.error('Duffel getOrder failed', { orderId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // REQUEST AN ORDER CHANGE (change flight dates/route on an
  // existing PAID order) — real endpoint/payload confirmed from
  // Duffel's own docs, 2026-07-03.
  //
  // This only CREATES the change request and returns whatever
  // order_change_offers the airline is willing to offer (may be
  // empty — a real, valid outcome meaning no change is possible for
  // the requested new dates/route). Nothing is booked or charged
  // yet. Only the summary fields actually needed for display are
  // extracted here — the full response includes complete airport/
  // city/segment detail for every offer, which isn't needed to show
  // a traveler "here's what changing costs."
  //
  // Full flow (all real, all confirmed as of 2026-07-03):
  //   1. requestOrderChange() — see real offers and their cost
  //   2. createOrderChange(offer.offerId) — create a pending change
  //   3. confirmOrderChange({...}) — actually apply it and pay/refund
  // ─────────────────────────────────────────────
  async requestOrderChange({ orderId, removeSliceId, addOrigin, addDestination, addDepartureDate, cabinClass = 'economy' }) {
    try {
      logger.info('Duffel: requesting order change', { orderId, removeSliceId, addOrigin, addDestination, addDepartureDate });

      const response = await axios.post(
        `${this.baseUrl}/air/order_change_requests`,
        {
          data: {
            order_id: orderId,
            slices: {
              remove: [{ slice_id: removeSliceId }],
              add: [{
                origin: addOrigin,
                destination: addDestination,
                departure_date: addDepartureDate,
                cabin_class: cabinClass,
              }],
            },
          },
        },
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeOrderChangeRequest(response.data?.data);
    } catch (err) {
      logger.error('Duffel requestOrderChange failed', { orderId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  async getOrderChangeRequest(changeRequestId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/air/order_change_requests/${changeRequestId}`,
        { headers: this._headers(), timeout: this.timeout }
      );
      return this._normalizeOrderChangeRequest(response.data?.data);
    } catch (err) {
      logger.error('Duffel getOrderChangeRequest failed', { changeRequestId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  _normalizeOrderChangeRequest(data) {
    if (!data) return null;
    const offers = Array.isArray(data.order_change_offers) ? data.order_change_offers : [];
    return {
      changeRequestId: data.id,
      orderId:         data.order_id,
      createdAt:       data.created_at,
      // Sorted cheapest-change-cost first — the most likely one a
      // traveler would want to see first, though the caller can
      // re-sort if a different priority makes more sense (e.g.
      // soonest expiring).
      offers: offers.map(o => this._normalizeOrderChangeOffer(o))
        .sort((a, b) => a.changeTotalAmount - b.changeTotalAmount),
    };
  }

  _normalizeOrderChangeOffer(o) {
    if (!o) return null;
    return {
      // CORRECTED (2026-07-03, once createOrderChange's real payload
      // was confirmed): offerId (this offer's own id, oco_...) is
      // what gets passed to createOrderChange as
      // selected_order_change_offer — NOT orderChangeId below, which
      // is a different field only populated if a change was already
      // created from this offer previously.
      offerId:            o.id,
      orderChangeId:      o.order_change_id,
      newTotalAmount:     Number(o.new_total_amount || 0),
      newTotalCurrency:   o.new_total_currency || null,
      changeTotalAmount:  Number(o.change_total_amount || 0), // what's actually charged/refunded (may be negative = refund)
      changeTotalCurrency: o.change_total_currency || null,
      penaltyAmount:      Number(o.penalty_total_amount || 0),
      penaltyCurrency:    o.penalty_total_currency || null,
      expiresAt:          o.expires_at || null,
      refundAllowed:      o.conditions?.refund_before_departure?.allowed ?? null,
      changeAllowed:      o.conditions?.change_before_departure?.allowed ?? null,
    };
  }

  // ─────────────────────────────────────────────
  // LIST ORDER CHANGE OFFERS — real endpoint confirmed 2026-07-03.
  // Mostly redundant with the offers already embedded in
  // requestOrderChange()'s response, but useful if you already have
  // a changeRequestId and want a fresh/differently-sorted list
  // without recreating the whole request. sort: 'change_total_amount'
  // | 'total_duration' (prefix with '-' for descending, per Duffel's
  // own convention — passed through as-is).
  // ─────────────────────────────────────────────
  async listOrderChangeOffers(changeRequestId, { sort = null, maxConnections = null } = {}) {
    try {
      const params = { order_change_request_id: changeRequestId };
      if (sort) params.sort = sort;
      if (maxConnections != null) params.max_connections = maxConnections;

      const response = await axios.get(
        `${this.baseUrl}/air/order_change_offers`,
        { params, headers: this._headers(), timeout: this.timeout }
      );
      const offers = Array.isArray(response.data?.data) ? response.data.data : [];
      return offers.map(o => this._normalizeOrderChangeOffer(o));
    } catch (err) {
      logger.error('Duffel listOrderChangeOffers failed', { changeRequestId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  async getOrderChangeOffer(offerId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/air/order_change_offers/${offerId}`,
        { headers: this._headers(), timeout: this.timeout }
      );
      return this._normalizeOrderChangeOffer(response.data?.data);
    } catch (err) {
      logger.error('Duffel getOrderChangeOffer failed', { offerId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CREATE A PENDING ORDER CHANGE
  // This is the step that was genuinely missing before — real
  // endpoint/payload confirmed 2026-07-03. Takes the OFFER's own id
  // (the oco_... id returned by requestOrderChange/
  // getOrderChangeOffer — NOT orderChangeId/order_change_id, which
  // is a different field only present if a change was already
  // created from this offer previously). Nothing is charged yet —
  // this only creates a pending change, same create->confirm shape
  // as order cancellations.
  // ─────────────────────────────────────────────
  async createOrderChange(selectedOrderChangeOfferId) {
    try {
      logger.info('Duffel: creating pending order change', { selectedOrderChangeOfferId });
      const response = await axios.post(
        `${this.baseUrl}/air/order_changes`,
        { data: { selected_order_change_offer: selectedOrderChangeOfferId } },
        { headers: this._headers(), timeout: this.timeout }
      );
      return this._normalizeOrderChange(response.data?.data);
    } catch (err) {
      logger.error('Duffel createOrderChange failed', { selectedOrderChangeOfferId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CONFIRM AN ORDER CHANGE
  // The step that actually applies the change with the airline and
  // charges/refunds the difference. Per Duffel's own documented
  // rule: payment is ONLY included when change_total_amount > 0 —
  // omitted entirely for a zero or negative (refund) amount. Uses
  // the same 'balance' payment type as payHoldOrder (Bodrless's
  // funded Duffel account balance), consistent with every other
  // real charge in this codebase.
  // ─────────────────────────────────────────────
  async confirmOrderChange({ changeId, changeTotalAmount, changeTotalCurrency }) {
    try {
      const data = {};
      if (Number(changeTotalAmount) > 0) {
        data.payment = {
          type: 'balance',
          currency: changeTotalCurrency,
          amount: String(changeTotalAmount),
        };
      }
      logger.info('Duffel: confirming order change', { changeId, changeTotalAmount, changeTotalCurrency, paymentIncluded: !!data.payment });

      const response = await axios.post(
        `${this.baseUrl}/air/order_changes/${changeId}/actions/confirm`,
        { data },
        { headers: this._headers(), timeout: this.timeout }
      );
      return this._normalizeOrderChange(response.data?.data);
    } catch (err) {
      logger.error('Duffel confirmOrderChange failed', { changeId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  async getOrderChange(changeId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/air/order_changes/${changeId}`,
        { headers: this._headers(), timeout: this.timeout }
      );
      return this._normalizeOrderChange(response.data?.data);
    } catch (err) {
      logger.error('Duffel getOrderChange failed', { changeId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  _normalizeOrderChange(data) {
    if (!data) return null;
    return {
      changeId:            data.id,
      orderId:             data.order_id,
      confirmedAt:         data.confirmed_at || null,
      expiresAt:           data.expires_at || null,
      newTotalAmount:      Number(data.new_total_amount || 0),
      newTotalCurrency:    data.new_total_currency || null,
      changeTotalAmount:   Number(data.change_total_amount || 0),
      changeTotalCurrency: data.change_total_currency || null,
      penaltyAmount:       Number(data.penalty_total_amount || 0),
      penaltyCurrency:     data.penalty_total_currency || null,
      refundTo:            data.refund_to || null,
    };
  }

  // ─────────────────────────────────────────────
  // PAY FOR A HOLD ORDER
  // Called once the traveler's M-Pesa payment has actually
  // succeeded — the Duffel-side equivalent of travelduqa.js's
  // completeHoldBooking(). Real payload confirmed from Duffel's own
  // docs (developers.duffel.com/docs/api/payments/create-payment).
  // amount/currency MUST match the order's CURRENT total_amount/
  // total_currency exactly (see getOrder above) or this fails with
  // payment_amount_does_not_match_order_amount /
  // payment_currency_does_not_match_order_currency.
  // ─────────────────────────────────────────────
  async payHoldOrder({ orderId, amount, currency }) {
    try {
      logger.info('Duffel: paying for hold order', { orderId, amount, currency });
      const response = await axios.post(
        `${this.baseUrl}/air/payments`,
        {
          data: {
            order_id: orderId,
            payment: {
              type:     'balance',
              currency,
              amount:   String(amount),
            },
          },
        },
        { headers: this._headers(), timeout: this.timeout }
      );
      return response.data?.data;
    } catch (err) {
      logger.error('Duffel payHoldOrder failed', { orderId, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // IATA RESOLUTION
  // Three-tier approach for maximum global coverage:
  //   1. Static map (_iataMap) — instant, covers ~100 common
  //      destinations. No API call, no latency.
  //   2. Fuzzy match on the static map — catches typos and
  //      minor variants of known cities.
  //   3. Duffel Places API live lookup — covers EVERY airport
  //      worldwide that Duffel knows about. Only fires when tiers
  //      1 and 2 both miss. Result is cached in memory for the
  //      process lifetime so the same city never calls the API
  //      twice per deployment.
  //
  // This means "Queenstown", "Reykjavik", "Tulum", "Bora Bora" —
  // any city a traveler names that Duffel flies to — will resolve
  // correctly without needing to be manually added to the map.
  // ─────────────────────────────────────────────
  async _resolveIata(value) {
    if (!value) return null;
    const normalized = String(value).trim().toLowerCase();

    // Tier 1a: Already a 3-letter IATA code
    if (/^[a-z]{3}$/.test(normalized)) return normalized.toUpperCase();

    // Tier 1b: Static map hit (instant)
    const map = this._iataMap();
    if (map[normalized]) return map[normalized];

    // Tier 1c: Fuzzy match on static map
    const fuzzyMatch = this._fuzzyMatch(normalized, Object.keys(map));
    if (fuzzyMatch) {
      logger.info('Duffel: fuzzy-matched city name', { input: value, matched: fuzzyMatch });
      return map[fuzzyMatch];
    }

    // Tier 2: Duffel Places API live lookup
    // Uses our existing token — same auth, no extra setup.
    // Result cached in process memory (_placesCache) so the same
    // city name only ever calls the API once per deployment.
    return this._resolveIataViaDuffelPlaces(normalized, value);
  }

  async _resolveIataViaDuffelPlaces(normalized, original) {
    // Check process-level cache first
    if (DuffelAdapter._placesCache[normalized]) {
      return DuffelAdapter._placesCache[normalized];
    }

    if (!this.token) {
      logger.warn('Duffel: no token for Places lookup', { value: original });
      return null;
    }

    try {
      logger.info('Duffel: Places API lookup', { query: original });
      const response = await axios.get(
        `${this.baseUrl}/places/suggestions`,
        {
          params: { query: original },
          headers: this._headers(),
          timeout: 5000, // short timeout — this is a fast lookup endpoint
        }
      );

      const suggestions = response.data?.data || [];
      if (!suggestions.length) {
        logger.warn('Duffel: Places API returned no suggestions', { value: original });
        DuffelAdapter._placesCache[normalized] = null; // cache the miss too
        return null;
      }

      // Prefer airport type results over city type; take the first one
      // (Duffel returns results sorted by relevance — first is best match)
      const best = suggestions.find(s => s.type === 'airport') || suggestions[0];
      const iata = best.iata_code || best.iata_city_code || null;

      if (iata) {
        logger.info('Duffel: Places API resolved IATA', { query: original, iata, name: best.name });
        // Add to runtime map so other adapters / future calls in this
        // request benefit without another API call
        DuffelAdapter._placesCache[normalized] = iata;
      } else {
        logger.warn('Duffel: Places API suggestion had no IATA code', { value: original, suggestion: best });
        DuffelAdapter._placesCache[normalized] = null;
      }

      return iata;

    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        logger.warn('Duffel: Places API lookup timed out', { value: original });
      } else {
        logger.error('Duffel: Places API lookup failed', { value: original, error: err.message });
      }
      // Don't cache errors — let it retry next time (transient failures)
      return null;
    }
  }

  // Same city->IATA map as travelduqa.js's _iataMap() — kept as a
  // duplicate rather than a shared import for now, matching this
  // codebase's existing pattern of each adapter being self-contained.
  _iataMap() {
    return {
      // City-level aliases added to fix "mahe", "port louis", "male" etc.
      // after promptParser correctly resolves countries→cities but those
      // city names weren't in the IATA map. Rule: every entry in
      // COUNTRY_TO_CITY in promptParser needs a matching entry here.
      'mahe': 'SEZ', 'seychelles': 'SEZ', 'praslin': 'SEZ',
      'port louis': 'MRU', 'mauritius': 'MRU', 'grand baie': 'MRU',
      'male': 'MLE', 'maldives': 'MLE',
      'antananarivo': 'TNR', 'madagascar': 'TNR',
      'bali': 'DPS', 'denpasar': 'DPS',
      'phuket': 'HKT', 'bangkok': 'BKK', 'chiang mai': 'CNX',
      'singapore': 'SIN', 'kuala lumpur': 'KUL',
      'delhi': 'DEL', 'mumbai': 'BOM', 'goa': 'GOI',
      'tokyo': 'TYO', 'osaka': 'KIX',
      'paris': 'CDG', 'amsterdam': 'AMS', 'istanbul': 'IST',
      'doha': 'DOH', 'abu dhabi': 'AUH', 'muscat': 'MCT',
      'cairo': 'CAI', 'sharm el sheikh': 'SSH', 'hurghada': 'HRG',
      'marrakech': 'RAK', 'casablanca': 'CMN',
      'accra': 'ACC', 'lagos': 'LOS',
      'harare': 'HRE', 'lusaka': 'LUN', 'windhoek': 'WDH',
      'maputo': 'MPM', 'luanda': 'LAD',
      'durban': 'DUR',
      'santorini': 'JTR', 'mykonos': 'JMK', 'athens': 'ATH',
      'barcelona': 'BCN', 'madrid': 'MAD', 'rome': 'FCO',
      'miami': 'MIA', 'los angeles': 'LAX', 'cancun': 'CUN',
      'sydney': 'SYD', 'auckland': 'AKL',
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
  // FUZZY MATCH — same three guards built earlier this session for
  // the TravelDuqa adapter, applied here too:
  //  1. inputs under 3 chars never fuzzy-match (too coincidental)
  //  2. length-gap cap (a genuine typo barely changes word length)
  //  3. 75% similarity floor (rejects loose "within edit-distance"
  //     matches on unrelated words, not just literal garbage)
  // ─────────────────────────────────────────────
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
    const inputLen = (input || '').length;
    if (inputLen < 3) return null;

    let best = null;
    let bestDistance = Infinity;

    for (const candidate of candidates) {
      if (Math.abs(candidate.length - inputLen) > 2) continue;

      const distance = this._levenshtein(input, candidate);
      const maxAllowed = candidate.length <= 5 ? 1 : candidate.length <= 9 ? 2 : 3;
      const similarity = 1 - distance / Math.max(inputLen, candidate.length);

      if (distance <= maxAllowed && similarity >= 0.75 && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
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
        // BUG FIX (found via a real "make the refund status clear"
        // request, 2026-07-02): Duffel's real conditions object
        // (refund_before_departure.allowed + penalty_amount) was
        // previously only captured in the separate, unused
        // _normalizeSingleOffer path — never on actual search
        // results. Every flight's refund status was completely
        // invisible to the traveler, papered over with a vague
        // "Subject to airline fare rules" line that told them
        // nothing actionable. Captured here now so every real
        // search result carries an explicit, honest refund status.
        // null (not false) when Duffel simply didn't return
        // conditions for this offer — genuinely unknown is a
        // different signal from "confirmed non-refundable".
        isRefundable:          offer.conditions?.refund_before_departure
          ? !!offer.conditions.refund_before_departure.allowed
          : null,
        refundPenalty:         offer.conditions?.refund_before_departure?.penalty_amount != null
          ? Number(offer.conditions.refund_before_departure.penalty_amount)
          : null,
        refundPenaltyCurrency: offer.conditions?.refund_before_departure?.penalty_currency || null,
        // NEW (found while building real Duffel order creation,
        // 2026-07-03): whether this specific offer can be held and
        // paid for later, or requires payment at booking time.
        // Bodrless's whole architecture is "hold now, collect M-Pesa
        // payment, pay the supplier after" — an offer with
        // requiresInstantPayment: true genuinely cannot go through
        // that flow (Duffel will reject type: 'hold' for it). Needed
        // BEFORE attempting to book, not discovered via a failed
        // booking call — see bookingService.js's handling.
        requiresInstantPayment: offer.payment_requirements?.requires_instant_payment ?? null,
        paymentRequiredBy:      offer.payment_requirements?.payment_required_by || null,
        priceGuaranteeExpiresAt: offer.payment_requirements?.price_guarantee_expires_at || null,
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
      // BUG FIX: order.status doesn't exist in Duffel's real order
      // schema — this always silently fell back to 'confirmed'
      // regardless of real payment state, which is actively
      // misleading for a hold order that hasn't been paid yet.
      // Duffel's real signal is payment_status.awaiting_payment.
      type:              order.type || null, // 'hold' | 'instant'
      awaitingPayment:   order.payment_status?.awaiting_payment ?? null,
      paymentRequiredBy: order.payment_status?.payment_required_by || null,
      priceGuaranteeExpiresAt: order.payment_status?.price_guarantee_expires_at || null,
      // NEW — needed to specify removeSliceId when requesting a
      // flight change (see requestOrderChange). Always fetch this
      // fresh via getOrder() rather than trusting a stored value,
      // since it's the authoritative current state of the order.
      sliceId:       slice.id || null,
      originIata:    slice.origin?.iata_code || null,
      destIata:      slice.destination?.iata_code || null,
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

// Process-level cache for Duffel Places API lookups.
// Keyed by normalized city name (lowercase, trimmed).
// Persists for the lifetime of the Render process — resets on deploy,
// which is fine since IATA codes don't change frequently.
DuffelAdapter._placesCache = {};