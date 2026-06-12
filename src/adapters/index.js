/**
 * SUPPLIER ADAPTER LAYER
 * ─────────────────────────────────────────────
 * Normalizes all supplier responses into
 * a single Bodrless format.
 *
 * Current suppliers:
 * - Travler (buses)
 *
 * Future suppliers (just add adapter):
 * - Amadeus (flights)
 * - Ratehawk (hotels)
 * - Transferz (transfers)
 * - SGR (trains)
 * - Direct hotels
 * ─────────────────────────────────────────────
 */

const travlerAdapter = require('./travler');

class SupplierAdapterLayer {

  constructor() {
    this.adapters = {
      travler: travlerAdapter,
      // amadeus: amadeus Adapter,
      // ratehawk: ratehawkAdapter,
      // transferz: transferzAdapter,
    };
  }

  // ─────────────────────────────────────────────
  // SEARCH ALL RELEVANT SUPPLIERS
  // Returns normalized results from all suppliers
  // ─────────────────────────────────────────────
  async searchTransport({ origin, destination, date, passengers, transportMode, timePreference }) {
    const results = [];

    // Search Travler for buses
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
        console.error('Travler adapter error:', err.message);
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
  // ─────────────────────────────────────────────
  async getSeatAvailability({ supplier, tripId, date }) {
    const adapter = this.adapters[supplier];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getSeatAvailability({ tripId, date });
  }

  // ─────────────────────────────────────────────
  // BOOK
  // ─────────────────────────────────────────────
  async book({ supplier, tripId, seatNumbers, passengerDetails, agencyId }) {
    const adapter = this.adapters[supplier];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.book({ tripId, seatNumbers, passengerDetails, agencyId });
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel({ supplier, bookingRef }) {
    const adapter = this.adapters[supplier];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.cancel(bookingRef);
  }

  // ─────────────────────────────────────────────
  // GET BOOKING STATUS
  // ─────────────────────────────────────────────
  async getStatus({ supplier, bookingRef }) {
    const adapter = this.adapters[supplier];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getStatus(bookingRef);
  }
}

module.exports = new SupplierAdapterLayer();