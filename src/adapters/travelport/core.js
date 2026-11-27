const { HttpClient, TravelportError } = require('./http');
const { TokenManager } = require('./tokens');
const { resolveEnv } = require('./config');


const enc = encodeURIComponent;

/**
 * Thin, safe wrapper over the Travelport Flights API v11.
 * - Payload bodies are passed through as given: build them from the reference pages.
 * - Paths come from the consolidated endpoint list.
 * - Mutating calls set `mutating: true` so unknown outcomes are flagged, never silently retried.
 *
 * `ctx` is always resolved server-side from the tenant record:
 *   { creds:{tenantKey,username,password,clientId,clientSecret}, pcc?, accessGroup?, traceId? }
 */
class TravelportAdapter {
  constructor({ environment = 'preprod', tokenStore, fetchImpl = fetch, onCall, timeoutMs, now = () => Date.now() } = {}) {
    const env = resolveEnv(environment);
    this.environment = environment;
    this.tokens = new TokenManager({ authUrl: env.authUrl, store: tokenStore, fetchImpl, now });
    this.http = new HttpClient({ env, tokens: this.tokens, fetchImpl, onCall, timeoutMs });
    this.now = now;
  }

  #get(ctx, path, extra = {}) { return this.http.call(ctx, { method: 'GET', path, ...extra }); }
  #post(ctx, path, body, extra = {}) { return this.http.call(ctx, { method: 'POST', path, body, mutating: true, ...extra }); }
  #put(ctx, path, body, extra = {}) { return this.http.call(ctx, { method: 'PUT', path, body, mutating: true, ...extra }); }

  // ---- Search and price (read-only, safe to retry) ----
  search(ctx, body) { return this.http.call(ctx, { method: 'POST', path: 'catalog/search/catalogproductofferings', body }); }
  price(ctx, body) { return this.http.call(ctx, { method: 'POST', path: 'price/offers/buildfromcatalogproductofferings', body }); }

  // ---- Booking workbench (valid 30 min) ----
  createWorkbench(ctx, body = { '@type': 'Reservation' }) { return this.#post(ctx, 'book/session/reservationworkbench', body); }
  addOffer(ctx, wb, body) { return this.#post(ctx, `book/offer/reservationworkbench/${enc(wb)}/offers/buildfromcatalogofferings`, body); }
  /** Booking route per the docs ("Add Offer Reference Payload"): same body as Price, ids from the search/price response (strip _PC). */
  addOfferReference(ctx, wb, body) { return this.#post(ctx, `book/airoffer/reservationworkbench/${enc(wb)}/offers/buildfromcatalogproductofferings`, body); }
  addTraveller(ctx, wb, body) { return this.#post(ctx, `book/traveler/reservationworkbench/${enc(wb)}/travelers`, body); }
  addTravellers(ctx, wb, body) { return this.#post(ctx, `book/traveler/reservationworkbench/${enc(wb)}/travelers/list`, body); }
  setTravelAgency(ctx, wb, body) { return this.#post(ctx, `ticket/travelagency/reservationworkbench/${enc(wb)}/travelagency`, body); }

  /**
   * Commit creates the PNR. NEVER retry blindly: a duplicate could create a second booking.
   * On error.unknownOutcome, reconcile with retrieveReservation before doing anything else.
   */
  commitReservation(ctx, wb, body = {}) { return this.#post(ctx, `book/reservation/reservations/${enc(wb)}`, body); }

  retrieveReservation(ctx, locator) { return this.#get(ctx, `book/reservation/reservations/${enc(locator)}`); }

  // ---- Ticketing ----
  createTicketingWorkbench(ctx, locator) {
    return this.#post(ctx, 'book/session/reservationworkbench/buildfromlocator', {}, { query: { Locator: locator } });
  }
  addFormOfPayment(ctx, wb, body) { return this.#post(ctx, `payment/reservationworkbench/${enc(wb)}/formofpayment`, body); }
  addPayment(ctx, wb, body) { return this.#post(ctx, `paymentoffer/reservationworkbench/${enc(wb)}/payments`, body); }
  commitTicketing(ctx, wb, body = {}) { return this.commitReservation(ctx, wb, body); }

  // ---- Servicing ----
  /** Void window guard: tickets are voidable until midnight local agency time on the issue day. */
  static voidWindowOpen({ issuedAtIso, agencyTimeZone, now = new Date() }) {
    const day = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: agencyTimeZone }).format(d);
    return day(new Date(issuedAtIso)) === day(now);
  }

  /** GDS only. All documents must be on one booking. Not for NDC or LCC. */
  batchVoid(ctx, { locator, documents }) {
    return this.http.call(ctx, {
      method: 'POST', base: 'root', path: 'documents/void', mutating: true,
      body: { locator, documentVoid: documents },
    });
  }

  /** GDS reservation cancel (held bookings). */
  cancelReservation(ctx, locator, body = {}) { return this.#post(ctx, `receipt/reservations/${enc(locator)}/receipts`, body); }

  /** NDC cancel / void: post-commit workbench first, then this. */
  cancelOffer(ctx, wb, offerId, extra = {}) {
    return this.#post(ctx, `receipt/reservation/${enc(wb)}/receipts`, {}, { query: { OfferIdentifier: offerId }, ...extra });
  }
  /** NDC refund quote; mandatory outside the void window if refund differs from price. */
  refundQuote(ctx, wb, body) { return this.#post(ctx, `book/airoffer/reservationworkbench/${enc(wb)}/offers/canceloffer`, body); }

  // ---- Exchange / modify ----
  ndcReshop(ctx, body) { return this.http.call(ctx, { method: 'POST', path: 'change/catalogofferingsairchange', body }); }
  ndcReprice(ctx, wb, body) { return this.#post(ctx, `reprice/reservationworkbench/${enc(wb)}/offers/buildfromcatalogofferings`, body); }
  ndcModify(ctx, locator, body) { return this.#post(ctx, `modify/reservations/${enc(locator)}`, body); }
  gdsExchangeSearch(ctx, body) { return this.http.call(ctx, { method: 'POST', base: 'root', path: 'exchangesearch/catalogofferingsairchange', body }); }
}

/** NDC/GDS offer ids from Price carry a `_PC` suffix that must be stripped before Add Offer. */
function stripPcSuffix(id) { return typeof id === 'string' ? id.replace(/_PC$/, '') : id; }

module.exports = { TravelportAdapter, stripPcSuffix, TravelportError };
