/**
 * TRAVELPORT ADAPTER (wrapper)
 * v0.4: search + hold-only booking verified step by step against pre-production (ticketing NOT wired yet).
 * Same shape as duffel.js: `module.exports = new TravelportAdapter()`, same method names where they map
 * (search, getOffer, book, cancel, getOrder). The Travelport-specific plumbing (auth, headers, retries,
 * redaction, unknown-outcome handling) lives in ./travelport/.
 *
 * STATUS (v0.3): searchRaw() works against pre-production. search() returns [] until _normalizeOffers is
 * written from a REAL response (do not guess the response shape). book/cancel are thin and untested live.
 *
 * Env: TP_ENV (preprod|prod), TP_USERNAME, TP_PASSWORD, TP_CLIENT_ID, TP_CLIENT_SECRET, TP_PCC, TP_ACCESS_GROUP
 */
const { logger } = require('../utils/logger');
const { TravelportAdapter: Core, stripPcSuffix } = require('./travelport/core');
const { normalizeTravelportSearch } = require('./travelport/normalize');
const { buildSearch, buildAddOfferReference, buildTraveller, buildCommit } = require('./travelport/builders');
const { normalizeTravelportBooking } = require('./travelport/normalize-booking');

// Travelport returns carrier codes only. Common carriers; unknown codes fall back to the code itself.
const AIRLINES = { KQ: 'Kenya Airways', ET: 'Ethiopian Airlines', SA: 'South African Airways', '4Z': 'Airlink', FA: 'FlySafair',
  QR: 'Qatar Airways', EK: 'Emirates', TK: 'Turkish Airlines', EY: 'Etihad Airways', WB: 'RwandAir', UR: 'Uganda Airlines', PW: 'Precision Air',
  AA: 'American Airlines', UA: 'United Airlines', DL: 'Delta Air Lines', AS: 'Alaska Airlines', BA: 'British Airways', AF: 'Air France',
  KL: 'KLM', LH: 'Lufthansa', LX: 'SWISS', MS: 'EgyptAir', AT: 'Royal Air Maroc', WY: 'Oman Air', SV: 'Saudia', SQ: 'Singapore Airlines', AI: 'Air India', MK: 'Air Mauritius', HM: 'Air Seychelles', TC: 'Air Tanzania', FZ: 'flydubai', G9: 'Air Arabia' };

class TravelportSupplier {
  constructor() {
    this.supplier = 'travelport';
    this.environment = process.env.TP_ENV || 'preprod';
    this.core = new Core({
      environment: this.environment,
      onCall: (l) => logger.info('Travelport call', l), // already redacted
      timeoutMs: Number(process.env.TP_TIMEOUT_MS) || 30000,
    });
  }

  _ctx(extra = {}) {
    const e = process.env;
    return {
      creds: { tenantKey: 'default', username: e.TP_USERNAME, password: e.TP_PASSWORD, clientId: e.TP_CLIENT_ID, clientSecret: e.TP_CLIENT_SECRET },
      pcc: e.TP_PCC || undefined,
      accessGroup: e.TP_ACCESS_GROUP || undefined,
      ...extra,
    };
  }

  // Raw search for testing: returns { data, traceId, status }
  async searchRaw({ origin, destination, date, returnDate = null, passengers = 1, children = 0, infants = 0, cabinClass, carriers, ndc = false }) {
    const trips = [{ from: origin, to: destination, date }];
    if (returnDate) trips.push({ from: destination, to: origin, date: returnDate });
    const body = buildSearch({ trips, adults: passengers, children, infants, cabin: cabinClass, carriers, sources: ndc ? ['GDS', 'NDC'] : ['GDS'] });
    return this.core.search(this._ctx(), body);
  }

  // Engine-facing search. Same contract as duffel.js: never throws, returns [] on supplier failure.
  // Accepts what cachedSearch passes (origin/destination may be city names, date or departureDate).
  // Cabin is NOT forwarded yet: Travelport's cabin values are unverified, so we filter nothing by cabin.
  async search(params = {}) {
    try {
      const date = params.date || params.departureDate;
      const [origin, destination] = await Promise.all([this._iata(params.origin), this._iata(params.destination)]);
      if (!origin || !destination || !date) {
        logger.warn('Travelport: skipping search, could not resolve airports or date', { origin: params.origin, destination: params.destination, date });
        return [];
      }
      const r = await this.searchRaw({
        origin, destination, date, passengers: params.passengers || 1, children: params.children || 0,
        returnDate: null, ndc: process.env.TP_NDC === 'true',
      });
      let flights = this._normalizeOffers(r.data, r.traceId);
      // A city-pair search returns nearby airports too (e.g. LGA>BUR for JFK>LAX). Keep only the airports asked for,
      // unless TP_NEARBY_AIRPORTS=true.
      if (process.env.TP_NEARBY_AIRPORTS !== 'true') {
        flights = flights.filter((f) => f.originIata === origin && f.destIata === destination);
      }
      const ttlMs = (process.env.TP_NDC === 'true' ? 25 : 10) * 60 * 1000; // cached ids die in ~12 min (GDS)
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();
      flights = flights.map((f) => ({ ...f, expiresAt, airline: AIRLINES[f.airlineCode] || f.airline, airlineCode: f.airlineCode }));
      return this._filterByTime(flights, params.timePreference);
    } catch (err) {
      logger.error('Travelport search failed', { error: err.message, status: err.status, detail: err.body });
      return [];
    }
  }

  // 3-letter codes pass through; names ("nairobi") are resolved with the Duffel adapter's resolver.
  async _iata(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
    try { return await require('./duffel')._resolveIata(s); } catch { return null; }
  }

  _normalizeOffers(data, traceId) {
    return normalizeTravelportSearch(data, traceId);
  }

  // Travelport times are LOCAL to the airport (no timezone), so the hour is read directly.
  _filterByTime(flights, pref) {
    if (!pref) return flights;
    return flights.filter((f) => {
      const h = Number(String(f.departureTime || '').slice(11, 13));
      if (!Number.isFinite(h)) return true;
      if (pref === 'morning') return h >= 5 && h < 12;
      if (pref === 'afternoon') return h >= 12 && h < 17;
      if (pref === 'evening') return h >= 17 && h < 21;
      if (pref === 'night') return h >= 21 || h < 5;
      return true;
    });
  }

  // Bodrless passenger -> builder input. Phone: +254... is split; other countries are sent whole (check per market).
  _toTraveller(p) {
    const g = String(p.gender || '').toLowerCase().charAt(0);
    let phone = p.phone ? String(p.phone).trim() : null;
    let countryCode;
    if (phone) {
      const d = phone.replace(/[^\d]/g, '');
      if (/^0\d{9}$/.test(d)) { countryCode = '254'; phone = d.slice(1); }
      else if (/^254\d{9}$/.test(d)) { countryCode = '254'; phone = d.slice(3); }
      else phone = d;
    }
    return {
      given: (p.firstName || p.given || '').toUpperCase(),
      surname: (p.lastName || p.surname || '').toUpperCase(),
      birthDate: p.dateOfBirth || p.birthDate,
      gender: g === 'f' ? 'Female' : g === 'm' ? 'Male' : undefined,
      email: p.email,
      phone, countryCode,
      passengerTypeCode: p.passengerTypeCode || 'ADT',
    };
  }

  _commitResult(r) {
    const resp = Object.values(r.data || {})[0] || {};
    const receipts = (resp.Reservation?.Receipt || []).map((x) => x.Confirmation).filter(Boolean);
    const loc = receipts.find((c) => c.Locator?.source === '1G')?.Locator?.value || null;
    const warnings = (resp.Result?.Warning || []).map((w) => w.Message || JSON.stringify(w));
    return { loc, warnings };
  }

  /**
   * HOLD (no payment, no ticket). Offer ids come from search results:
   *   { catalogOfferingsId, catalogOfferingId, productIds, passengers|travellers }
   * Returns { status: 'held' | 'needs_confirmation', ... }. needs_confirmation = schedule/price changed since search:
   * show warnings to the traveller, then call confirmHeldBooking({ workbenchId }). Commit is NEVER retried blindly.
   * Book soon after search: cached ids expire in ~12 min (GDS).
   */
  async createHeldBooking({ catalogOfferingsId, catalogOfferingId, offerId, productIds = [], passengers, travellers, agencyDetails } = {}) {
    const people = (passengers || travellers || []).map((p) => this._toTraveller(p));
    if (!people.length) throw new Error('Travelport: at least one passenger is required');
    const offeringId = catalogOfferingId || (offerId && !String(offerId).includes('|') ? offerId : null);
    if (!catalogOfferingsId || !offeringId || !productIds.length) throw new Error('Travelport: catalogOfferingsId, catalogOfferingId and productIds are required (use the fields from the search result)');
    const ctx = this._ctx();
    const wb = await this.core.createWorkbench(ctx);
    const wbId = wb.data?.ReservationResponse?.Reservation?.Identifier?.value;
    if (!wbId) throw new Error('Travelport: could not read workbench id from response');
    await this.core.addOfferReference(ctx, wbId, buildAddOfferReference({ catalogOfferingsId: stripPcSuffix(catalogOfferingsId), offerId: offeringId, productIds }));
    for (let i = 0; i < people.length; i++) await this.core.addTraveller(ctx, wbId, buildTraveller(people[i], i + 1));
    if (agencyDetails) await this.core.setTravelAgency(ctx, wbId, agencyDetails);
    return this._finishCommit(ctx, wbId, await this.core.commitReservation(ctx, wbId, buildCommit({ twoStep: true })));
  }

  /** Second step after needs_confirmation: accepts the changed schedule/price and books. */
  async confirmHeldBooking({ workbenchId }) {
    const ctx = this._ctx();
    return this._finishCommit(ctx, workbenchId, await this.core.commitReservation(ctx, workbenchId, buildCommit({ twoStep: false })));
  }

  async _finishCommit(ctx, wbId, r) {
    const { loc, warnings } = this._commitResult(r);
    if (!loc) return { supplier: this.supplier, status: 'needs_confirmation', workbenchId: wbId, warnings, traceId: r.traceId };
    return this._toHold(await this.core.retrieveReservation(ctx, loc), r.traceId);
  }

  // Shape the Duffel-style fields bookingService already reads (type, awaitingPayment, paymentRequiredBy, ...).
  _toHold(retrieved, traceId) {
    const b = normalizeTravelportBooking(retrieved.data);
    const first = b?.segments?.[0] || {};
    return {
      supplier: this.supplier,
      status: 'held',
      type: 'hold',
      orderId: b.locator,
      supplierBookingReference: b.airlineLocators?.[0]?.locator || b.locator,
      travelportLocator: b.locator,
      airlineLocators: b.airlineLocators,
      awaitingPayment: true,
      paymentRequiredBy: b.paymentTimeLimit,
      totalAmount: b.price.total,
      currency: b.price.currency,
      originIata: first.origin,
      destIata: b.segments?.[b.segments.length - 1]?.destination,
      departureTime: first.departureTime,
      flightNumber: first.flightNumber,
      isRefundable: b.isRefundable,
      booking: b,
      traceId,
    };
  }

  async getOrder(locator) { return this._toHold(await this.core.retrieveReservation(this._ctx(), locator)); }
  async getStatus(locator) { const o = await this.getOrder(locator); return { status: o.booking.status, paymentRequiredBy: o.paymentRequiredBy }; }
  async cancel(locator) { return this.core.cancelReservation(this._ctx(), locator, {}); }

  // TRAVELPORT-TICKETING: issue a ticket for a held booking. Safe by construction:
  //  - off unless TRAVELPORT_TICKETING_ENABLED === 'true'
  //  - idempotent: if the booking already has ticket numbers it returns them and issues nothing
  //  - NEVER retries the commit; after a 5xx/timeout it reconciles with a retrieve and reports 'unknown' if still unclear
  //  - returns the Travelport error body + trace id on failure so support can be given exact evidence
  // Result: { status: 'ticketed'|'failed'|'unknown', locator, ticketNumbers[], stage, traceId, errors[], errorBody, alreadyTicketed }
  _ticketNumbers(data) {
    const s = JSON.stringify(data || {});
    const out = new Set();
    for (const m of s.matchAll(/"(?:ticketNumber|TicketNumber)":\s*"(\d{13})"/g)) out.add(m[1]);
    return [...out];
  }

  async issueTicket({ locator, fop = 'cash', invoiceNumber } = {}) {
    if (process.env.TRAVELPORT_TICKETING_ENABLED !== 'true') {
      return { status: 'failed', locator, stage: 'disabled', ticketNumbers: [], errors: [{ code: 'TICKETING_DISABLED', message: 'TRAVELPORT_TICKETING_ENABLED is not true' }] };
    }
    if (!locator) return { status: 'failed', locator, stage: 'input', ticketNumbers: [], errors: [{ code: 'NO_LOCATOR', message: 'locator is required' }] };
    if (!['cash', 'invoice'].includes(fop)) return { status: 'failed', locator, stage: 'input', ticketNumbers: [], errors: [{ code: 'BAD_FOP', message: 'fop must be cash or invoice' }] };
    const ctx = () => this._ctx();
    const fail = (stage, e) => {
      const body = e && e.body !== undefined ? e.body : undefined;
      const errors = (e && e.softErrors) || [{ code: (e && e.status) || 'ERROR', message: (e && e.message) || String(e) }];
      logger.error('Travelport ticketing failed', { locator, stage, traceId: e && e.traceId, status: e && e.status, errors, body: body ? JSON.stringify(body).slice(0, 2000) : undefined });
      return { status: 'failed', locator, stage, ticketNumbers: [], traceId: e && e.traceId, errors, errorBody: body };
    };
    const soft = (r) => (r && r.softErrors && r.softErrors.length ? { traceId: r.traceId, softErrors: r.softErrors, message: 'Travelport reported errors' } : null);
    try {
      // 1. Current state. Already ticketed? Return it, issue nothing.
      let cur = await this.core.retrieveReservation(ctx(), locator);
      const existing = this._ticketNumbers(cur.data);
      if (existing.length) return { status: 'ticketed', locator, ticketNumbers: existing, alreadyTicketed: true };
      const offer = cur.data && cur.data.ReservationResponse && cur.data.ReservationResponse.Reservation && cur.data.ReservationResponse.Reservation.Offer && cur.data.ReservationResponse.Reservation.Offer[0];
      if (!offer) return fail('retrieve', { message: 'No offer on the booking (cancelled or expired)' });
      const amount = offer.Price && offer.Price.TotalPrice;
      const currency = offer.Price && offer.Price.CurrencyCode && offer.Price.CurrencyCode.value;

      // 2. Ticketing workbench, form of payment, payment.
      const wbRes = await this.core.createTicketingWorkbench(ctx(), locator);
      let e = soft(wbRes); if (e) return fail('workbench', e);
      const wb = wbRes.data && wbRes.data.ReservationResponse && wbRes.data.ReservationResponse.Identifier && wbRes.data.ReservationResponse.Identifier.value;
      if (!wb) return fail('workbench', { message: 'No workbench id returned', traceId: wbRes.traceId });
      const wbOffer = (wbRes.data.ReservationResponse.Reservation && wbRes.data.ReservationResponse.Reservation.Offer && wbRes.data.ReservationResponse.Reservation.Offer[0]) || offer;
      const fopId = 'formOfPayment_1';
      const ident = { authority: 'Travelport', value: `bodrless-fop-${locator}` };
      const fopBody = fop === 'cash'
        ? { FormOfPaymentCash: { id: fopId, FormOfPaymentRef: fopId, Identifier: ident } }
        : { FormOfPaymentInvoice: { id: fopId, FormOfPaymentRef: fopId, Identifier: ident, InvoiceNumber: String(invoiceNumber || '') } };
      if (fop === 'invoice' && !invoiceNumber) return fail('fop', { message: 'invoiceNumber is required for invoice' });
      const fopRes = await this.core.addFormOfPayment(ctx(), wb, fopBody);
      e = soft(fopRes); if (e) return fail('fop', e);
      const fopIdentifier = (fopRes.data && fopRes.data.FormofPaymentResponse && fopRes.data.FormofPaymentResponse.Identifier && fopRes.data.FormofPaymentResponse.Identifier.value) || ident.value;
      const offerId = wbOffer.id || 'offer_1';
      const offerIdentifier = (wbOffer.Identifier && wbOffer.Identifier.value) || (offer.Identifier && offer.Identifier.value);
      const payRes = await this.core.addPayment(ctx(), wb, { Payment: {
        id: 'payment_1',
        Identifier: { authority: 'Travelport', value: `bodrless-payment-${locator}` },
        Amount: { code: currency, minorUnit: 2, currencySource: 'Charged', value: amount },
        FormOfPaymentIdentifier: { id: fopId, FormOfPaymentRef: fopId, Identifier: { authority: 'Travelport', value: fopIdentifier } },
        OfferIdentifier: [{ id: offerId, offerRef: offerId, Identifier: { authority: 'Travelport', value: offerIdentifier } }],
      } });
      e = soft(payRes); if (e) return fail('payment', e);

      // 3. Commit ONCE. Never retried.
      let commit;
      try { commit = await this.core.commitTicketing(ctx(), wb, {}); }
      catch (err) {
        // 5xx or timeout: outcome unknown. Reconcile, do not retry.
        const failed = fail('commit', err);
        try {
          const after = await this.core.retrieveReservation(ctx(), locator);
          const nums = this._ticketNumbers(after.data);
          if (nums.length) return { status: 'ticketed', locator, ticketNumbers: nums, stage: 'commit', traceId: err.traceId, reconciled: true };
        } catch (_) { /* fall through */ }
        return { ...failed, status: err.unknownOutcome ? 'unknown' : 'failed' };
      }
      e = soft(commit); if (e) return fail('commit', e);

      // 4. Verify with a retrieve.
      const after = await this.core.retrieveReservation(ctx(), locator);
      const nums = this._ticketNumbers(after.data).length ? this._ticketNumbers(after.data) : this._ticketNumbers(commit.data);
      if (!nums.length) return { status: 'unknown', locator, ticketNumbers: [], stage: 'verify', traceId: commit.traceId, errors: [{ code: 'NO_TICKET_FOUND', message: 'Commit succeeded but no ticket number found; check manually' }] };
      return { status: 'ticketed', locator, ticketNumbers: nums, traceId: commit.traceId };
    } catch (err) {
      return fail('unexpected', err);
    }
  }
}

module.exports = new TravelportSupplier();
