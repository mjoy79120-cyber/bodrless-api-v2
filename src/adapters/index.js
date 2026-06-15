/**
 * SUPPLIER ADAPTER LAYER
 * ─────────────────────────────────────────────
 * Normalizes all supplier responses into
 * a single Bodrless format.
 *
 * Current suppliers:
 * - IABIRI/99Synergy (buses) via travler.js
 *
 * Future suppliers (just add adapter):
 * - Amadeus (flights)
 * - Ratehawk (hotels)
 * - Transferz (transfers)
 * - SGR (trains)
 * - TravelDuqa
 * ─────────────────────────────────────────────
 */

const travlerAdapter = require('./travler');

class SupplierAdapterLayer {

  constructor() {
    this.adapters = {
      travler: travlerAdapter,
      iabiri:  travlerAdapter, // same adapter, aliased
      // amadeus: amadeusAdapter,
      // ratehawk: ratehawkAdapter,
      // transferz: transferzAdapter,
    };
  }

  // ─────────────────────────────────────────────
  // SEARCH ALL RELEVANT SUPPLIERS
  // ─────────────────────────────────────────────
  async searchTransport({ origin, destination, date, passengers, transportMode, timePreference }) {
    const results = [];

    if (!transportMode || transportMode === 'bus') {
      try {
        const busResults = await this.adapters.travler.search({
          origin,
          destination,
          date,
          passengers,
          timePreference,
        });
        results.push(...busResults);
      } catch (err) {
        console.error('IABIRI adapter error:', err.message);
      }
    }

    // Future: search Amadeus for flights
    // if (!transportMode || transportMode === 'flight') {
    //   const flightResults = await this.adapters.amadeus.search({...});
    //   results.push(...flightResults);
    // }

    return results;
  }

  // ─────────────────────────────────────────────
  // GET SEAT AVAILABILITY
  // IABIRI needs busId + city IDs, not just tripId
  // ─────────────────────────────────────────────
  async getSeatAvailability({ supplier, busId, tripId, sourceCityId, destCityId, date, delayedFlag, delayedDate }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getSeatAvailability({ busId: busId || tripId, sourceCityId, destCityId, date, delayedFlag, delayedDate });
  }

  // ─────────────────────────────────────────────
  // GET BOARDING & DROPPING POINTS
  // ─────────────────────────────────────────────
  async getBoardingDroppingPoints({ supplier, sourceCityId, destCityId, tripId, date }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getBoardingDroppingPoints({ sourceCityId, destCityId, tripId, date });
  }

  // ─────────────────────────────────────────────
  // BOOK
  // ─────────────────────────────────────────────
  async book({ supplier, tripId, routeId, token, pickupId, returnId,
               sourceCityName, destCityName, bookingDate,
               seats, passengerDetails, agencyId }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.book({ tripId, routeId, token, pickupId, returnId,
                          sourceCityName, destCityName, bookingDate,
                          seats, passengerDetails, agencyId });
  }

  // ─────────────────────────────────────────────
  // INIT PAYMENT
  // ─────────────────────────────────────────────
  async initPayment({ supplier, bookingRef, phoneNumber, isWalletApply }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.initPayment({ bookingRef, phoneNumber, isWalletApply });
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel({ supplier, bookingRef }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.cancel(bookingRef);
  }

  // ─────────────────────────────────────────────
  // GET BOOKING STATUS
  // ─────────────────────────────────────────────
  async getStatus({ supplier, bookingRef }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getStatus(bookingRef);
  }

  // ─────────────────────────────────────────────
  // BOOKING HISTORY
  // ─────────────────────────────────────────────
  async getBookingHistory({ supplier, page, perPage, startDate, endDate, status }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getBookingHistory({ page, perPage, startDate, endDate, status });
  }
}

module.exports = new SupplierAdapterLayer();