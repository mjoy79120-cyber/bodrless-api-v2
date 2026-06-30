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
const duffelAdapter     = require('./duffel');
const hotelbedsAdapter  = require('./hotelbeds');

class SupplierAdapterLayer {

  constructor() {
    this.adapters = {
      travler:    travlerAdapter,
      iabiri:     travlerAdapter,    // alias — same adapter
      travelduqa: travelduqaAdapter,
      duffel:     duffelAdapter,
      hotelbeds:  hotelbedsAdapter,
    };
  }

  // ─────────────────────────────────────────────
  // SEARCH TRANSPORT
  // Buses → IABIRI | Flights → TravelDuqa + Duffel, IN PARALLEL
  //
  // TravelDuqa and Duffel are both genuine flight suppliers run
  // side by side, not primary/fallback — TravelDuqa's sandbox is
  // missing inventory on some routes/airlines that Duffel covers,
  // and vice versa is possible too. Both run concurrently via
  // Promise.allSettled (not sequential awaits) so the total search
  // latency is bounded by the SLOWER of the two, not their sum —
  // same reasoning as every other parallelization done this session.
  // allSettled (not Promise.all) means one supplier's hard failure
  // can never take down the other's results — exactly the same
  // "one bad supplier shouldn't break the search" contract the bus
  // branch below already had.
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
      const [travelduqaResult, duffelResult] = await Promise.allSettled([
        this.adapters.travelduqa.search({ origin, destination, date, passengers, timePreference }),
        this.adapters.duffel.search({ origin, destination, date, passengers, timePreference }),
      ]);

      if (travelduqaResult.status === 'fulfilled') {
        results.push(...travelduqaResult.value);
      } else {
        console.error('TravelDuqa adapter error:', travelduqaResult.reason?.message);
      }

      if (duffelResult.status === 'fulfilled') {
        results.push(...duffelResult.value);
        console.log(`DUFFEL: ${duffelResult.value.length} flights added alongside TravelDuqa's ${travelduqaResult.status === 'fulfilled' ? travelduqaResult.value.length : 0}`);
      } else {
        console.error('Duffel adapter error:', duffelResult.reason?.message);
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS
  // Hotels → HotelBeds
  //
  // FIX: adults, children, childAges were previously dropped here —
  // only the flat `passengers` count was forwarded, so every hotel
  // search told HotelBeds "N adults, 0 children" regardless of the
  // actual occupancy. That caused the rateKey returned at search time
  // to mismatch the pax sent at booking (E_REQUEST_CHILDRENDONTMATCH).
  // hotelCode is forwarded for the booking-side re-fetch path in
  // bookingService._reconcileHotelOccupancy — it searches one specific
  // hotel at the corrected DOB-derived child age to get a valid rateKey.
  // ─────────────────────────────────────────────
  async searchHotels({ destination, checkIn, checkOut, passengers, adults, children, childAges, nights, budget, rooms, hotelCode }) {
    try {
      const results = await this.adapters.hotelbeds.search({
        destination,
        checkIn,
        checkOut,
        passengers,
        adults,
        children,
        childAges,
        nights,
        budget,
        rooms,
        hotelCode,
      });
      console.log('HOTELBEDS HOTELS:', results.length);
      return results;
    } catch (err) {
      console.error('HotelBeds adapter error:', err.message);
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // REFETCH RATE (hotels — HotelBeds)
  // Re-prices one specific hotel at a corrected occupancy (used by
  // bookingService._reconcileHotelOccupancy when a child's real DOB
  // age differs from what was searched). Delegates straight to the
  // HotelBeds adapter's refetchRate() — a targeted single-hotel
  // availability call that returns a fresh rateKey.
  // ─────────────────────────────────────────────
  async refetchRate({ supplier, hotelCode, checkIn, checkOut, nights, adults, children, childAges, rooms }) {
    const adapter = this.adapters[supplier || 'hotelbeds'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    if (typeof adapter.refetchRate !== 'function') {
      throw new Error(`${supplier || 'hotelbeds'} adapter does not support refetchRate`);
    }
    return adapter.refetchRate({ hotelCode, checkIn, checkOut, nights, adults, children, childAges, rooms });
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
  // SELECT OFFER (flights — TravelDuqa's hold-booking model)
  // ─────────────────────────────────────────────
  async selectOffer({ supplier, resultId, offerId }) {
    const adapter = this.adapters[supplier || 'travelduqa'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    return adapter.selectOffer({ resultId, offerId });
  }

  // ─────────────────────────────────────────────
  // GET OFFER (flights — Duffel's re-verify-before-booking step)
  // Duffel has no TravelDuqa-style "hold" — instead, per Duffel's
  // own docs, you must re-fetch the offer right before booking to
  // get current pricing, since search-time prices aren't guaranteed.
  // Call this where the booking flow would otherwise call
  // selectOffer() for a TravelDuqa offer.
  // ─────────────────────────────────────────────
  async getOffer({ supplier, offerId }) {
    const adapter = this.adapters[supplier || 'duffel'];
    if (!adapter) throw new Error(`Unknown supplier: ${supplier}`);
    if (typeof adapter.getOffer !== 'function') {
      throw new Error(`${supplier} adapter does not support getOffer`);
    }
    return adapter.getOffer(offerId);
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

    if (supplier === 'duffel') {
      // Duffel passengers must be matched to the offer's own
      // passenger IDs (duffelPassengerId, captured at search time —
      // see duffel.js's _normalizeOffers -> duffelPassengerIds).
      // Without this match Duffel's API rejects the order, since it
      // has no other way to know which passenger record maps to
      // which seat/fare on the offer.
      return adapter.book({
        offerId:        params.offerId,
        offerRequestId: params.offerRequestId,
        passengers:     params.passengerDetails || params.passengers,
        totalAmount:    params.totalAmount,
        totalCurrency:  params.currency || params.totalCurrency || 'KES',
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
    if (supplier === 'duffel')     return adapter.cancel(orderId || bookingRef);
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