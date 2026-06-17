/**
 * SUPPLIER ADAPTER LAYER
 * ─────────────────────────────────────────────
 * Normalizes all supplier responses into
 * a single Bodrless format.
 *
 * Current suppliers:
 * - IABIRI/99Synergy (buses)  via travler.js
 * - TravelDuqa (flights)      via travelduqa.js
 * - HotelBeds (hotels)        via hotelbeds.js
 *
 * Future suppliers (just add adapter):
 * - Amadeus (flights)
 * - Ratehawk (hotels)
 * - Transferz (transfers)
 * - SGR (trains)
 * ─────────────────────────────────────────────
 */

const travlerAdapter    = require('./travler');
const travelduqaAdapter = require('./travelduqa');
const hotelbedsAdapter  = require('./hotelbeds');

class SupplierAdapterLayer {

  constructor() {
    this.adapters = {
      travler:    travlerAdapter,
      iabiri:     travlerAdapter,    // alias — same adapter
      travelduqa: travelduqaAdapter,
      hotelbeds:  hotelbedsAdapter,
    };
  }

  // ─────────────────────────────────────────────
  // SEARCH TRANSPORT
  // Buses → IABIRI | Flights → TravelDuqa
  // ─────────────────────────────────────────────
  async searchTransport({ origin, destination, date, passengers, transportMode, timePreference }) {
    const results = [];

    if (!transportMode || transportMode === 'bus') {
      try {
        const busResults = await this.adapters.travler.search({
          origin, destination, date, passengers, timePreference,
        });
        results.push(...busResults);
      } catch (err) {
        console.error('IABIRI adapter error:', err.message);
      }
    }

    if (!transportMode || transportMode === 'flight') {
      try {
        const flightResults = await this.adapters.travelduqa.search({
          origin, destination, date, passengers, timePreference,
        });
        results.push(...flightResults);
      } catch (err) {
        console.error('TravelDuqa adapter error:', err.message);
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS
  // Hotels → HotelBeds
  // ─────────────────────────────────────────────
  async searchHotels({ destination, checkIn, checkOut, passengers, nights, budget, rooms }) {
    try {
      const results = await this.adapters.hotelbeds.search({
        destination, checkIn, checkOut, passengers, nights, budget, rooms,
      });
      console.log('HOTELBEDS HOTELS:', results.length);
      return results;
    } catch (err) {
      console.error('HotelBeds adapter error:', err.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // GET SEAT AVAILABILITY (buses — IABIRI)
  // ─────────────────────────────────────────────
  async getSeatAvailability({ supplier, busId, tripId, sourceCityId, destCityId, date, delayedFlag, delayedDate }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getSeatAvailability({ busId: busId || tripId, sourceCityId, destCityId, date, delayedFlag, delayedDate });
  }

  // ─────────────────────────────────────────────
  // GET BOARDING & DROPPING POINTS (buses — IABIRI)
  // ─────────────────────────────────────────────
  async getBoardingDroppingPoints({ supplier, sourceCityId, destCityId, tripId, date }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getBoardingDroppingPoints({ sourceCityId, destCityId, tripId, date });
  }

  // ─────────────────────────────────────────────
  // SELECT OFFER (flights — TravelDuqa)
  // ─────────────────────────────────────────────
  async selectOffer({ supplier, resultId, offerId }) {
    const adapter = this.adapters[supplier || 'travelduqa'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.selectOffer({ resultId, offerId });
  }

  // ─────────────────────────────────────────────
  // BOOK
  // ─────────────────────────────────────────────
  async book({ supplier, ...params }) {
    const adapter = this.adapters[supplier];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);

    if (supplier === 'travelduqa') {
      return adapter.book({
        resultId:    params.resultId,
        offerId:     params.offerId,
        passengers:  params.passengerDetails || params.passengers,
        totalAmount: params.totalAmount,
        currency:    params.currency || 'KES',
        paymentType: params.paymentType || 'balance',
        sendEticket: params.sendEticket !== false,
      });
    }

    if (supplier === 'hotelbeds') {
      return adapter.book({
        rateKey:         params.rateKey,
        holder:          params.holder,
        guests:          params.guests || params.passengerDetails,
        clientReference: params.clientReference,
        remark:          params.remark,
      });
    }

    return adapter.book({
      tripId:           params.tripId,
      routeId:          params.routeId,
      token:            params.token,
      pickupId:         params.pickupId,
      returnId:         params.returnId,
      sourceCityName:   params.sourceCityName,
      destCityName:     params.destCityName,
      bookingDate:      params.bookingDate,
      seats:            params.seats,
      passengerDetails: params.passengerDetails,
      agencyId:         params.agencyId,
    });
  }

  // ─────────────────────────────────────────────
  // CHECK RATE (hotels — HotelBeds)
  // Only needed when rateType === 'RECHECK'; safe to call
  // before any HotelBeds booking to confirm price hasn't drifted.
  // ─────────────────────────────────────────────
  async checkRate({ supplier, rateKey }) {
    const adapter = this.adapters[supplier || 'hotelbeds'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.checkRate(rateKey);
  }

  // ─────────────────────────────────────────────
  // COMPLETE HELD BOOKING (flights — TravelDuqa)
  // ─────────────────────────────────────────────
  async completeHoldBooking({ supplier, orderId, sendEticket }) {
    const adapter = this.adapters[supplier || 'travelduqa'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.completeHoldBooking({ orderId, sendEticket });
  }

  // ─────────────────────────────────────────────
  // INIT PAYMENT (buses — IABIRI MPESA)
  // ─────────────────────────────────────────────
  async initPayment({ supplier, bookingRef, phoneNumber, isWalletApply }) {
    const adapter = this.adapters[supplier || 'travler'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.initPayment({ bookingRef, phoneNumber, isWalletApply });
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel({ supplier, bookingRef, orderId }) {
    const adapter = this.adapters[supplier];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    if (supplier === 'travelduqa') return adapter.cancel(orderId || bookingRef);
    if (supplier === 'hotelbeds')  return adapter.cancel(bookingRef);
    return adapter.cancel(bookingRef);
  }

  // ─────────────────────────────────────────────
  // GET BOOKING STATUS
  // ─────────────────────────────────────────────
  async getStatus({ supplier, bookingRef, orderId }) {
    const adapter = this.adapters[supplier];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    if (supplier === 'travelduqa') return adapter.getStatus(orderId || bookingRef);
    return adapter.getStatus(bookingRef);
  }

  // ─────────────────────────────────────────────
  // BOOKING HISTORY
  // ─────────────────────────────────────────────
  async getBookingHistory({ supplier, page, perPage, startDate, endDate, status }) {
    const adapter = this.adapters[supplier || 'travelduqa'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getBookingHistory({ page, perPage, startDate, endDate, status });
  }

  // ─────────────────────────────────────────────
  // CHANGE REQUEST (flights — TravelDuqa)
  // ─────────────────────────────────────────────
  async requestChange({ supplier, orderId, changeType, changeData }) {
    const adapter = this.adapters[supplier || 'travelduqa'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.requestChange({ orderId, changeType, changeData });
  }

  // ─────────────────────────────────────────────
  // WALLET STATUS (TravelDuqa)
  // ─────────────────────────────────────────────
  async getWalletStatus({ supplier } = {}) {
    const adapter = this.adapters[supplier || 'travelduqa'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.getWalletStatus();
  }
}

module.exports = new SupplierAdapterLayer();