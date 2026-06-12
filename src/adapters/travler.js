/**
 * TRAVLER ADAPTER
 * ─────────────────────────────────────────────
 * Normalizes Travler API responses into
 * Bodrless standard format
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

class TravlerAdapter {

  constructor() {
    this.baseUrl = process.env.TRAVLER_API_URL || 'https://api.travler.africa';
    this.apiKey = process.env.TRAVLER_API_KEY;
    this.timeout = 10000;
    this.supplier = 'travler';
  }

  // ─────────────────────────────────────────────
  // SEARCH ROUTES
  // ─────────────────────────────────────────────
  async search({ origin, destination, date, passengers = 1, timePreference = null }) {
    try {
      logger.info('Travler: searching routes', { origin, destination, date });

      // TODO: Update endpoint when Travler sends docs
      const response = await axios.get(`${this.baseUrl}/routes/search`, {
        params: { origin, destination, date, passengers },
        headers: this._headers(),
        timeout: this.timeout,
      });

      const routes = this._normalizeRoutes(response.data);
      return this._filterByTime(routes, timePreference);

    } catch (err) {
      logger.error('Travler search failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // GET SEAT AVAILABILITY
  // ─────────────────────────────────────────────
  async getSeatAvailability({ tripId, date }) {
    try {
      const response = await axios.get(`${this.baseUrl}/trips/${tripId}/seats`, {
        params: { date },
        headers: this._headers(),
        timeout: this.timeout,
      });

      return this._normalizeSeats(response.data);
    } catch (err) {
      logger.error('Travler seat fetch failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // BOOK SEATS
  // ─────────────────────────────────────────────
  async book({ tripId, seatNumbers, passengerDetails, agencyId }) {
    try {
      const response = await axios.post(`${this.baseUrl}/bookings`, {
        trip_id: tripId,
        seats: seatNumbers,
        passengers: passengerDetails,
        agent_id: agencyId,
      }, {
        headers: this._headers(),
        timeout: this.timeout,
      });

      return this._normalizeBooking(response.data);
    } catch (err) {
      logger.error('Travler booking failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET STATUS
  // ─────────────────────────────────────────────
  async getStatus(bookingRef) {
    try {
      const response = await axios.get(`${this.baseUrl}/bookings/${bookingRef}`, {
        headers: this._headers(),
        timeout: this.timeout,
      });
      return response.data;
    } catch (err) {
      logger.error('Travler status check failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel(bookingRef) {
    try {
      const response = await axios.delete(`${this.baseUrl}/bookings/${bookingRef}`, {
        headers: this._headers(),
        timeout: this.timeout,
      });
      return response.data;
    } catch (err) {
      logger.error('Travler cancellation failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZERS
  // Map Travler response → Bodrless standard format
  // Update field names when docs arrive
  // ─────────────────────────────────────────────
  _normalizeRoutes(data) {
    const routes = data?.routes || data?.data || data || [];
    return routes.map(route => ({
      // Bodrless standard fields
      supplier: this.supplier,
      type: 'bus',
      transportType: 'bus',

      // Route info
      tripId: route.id || route.trip_id,
      route: `${route.origin || route.from}-${route.destination || route.to}`,
      origin: route.origin || route.from,
      destination: route.destination || route.to,

      // Times
      departureTime: route.departure_time || route.departs_at,
      arrivalTime: route.arrival_time || route.arrives_at,
      duration: route.duration || null,

      // Provider
      provider: route.operator || route.company || route.bus_company,
      busType: route.bus_type || route.vehicle_type || route.coach_type || 'Standard',

      // Pricing
      price: Number(route.price || route.fare || route.amount || 0),
      currency: route.currency || 'KES',

      // Availability
      availableSeats: route.available_seats || route.seats_available || null,
      totalSeats: route.total_seats || route.capacity || null,

      // Extras
      amenities: route.amenities || [],
      cancellationPolicy: route.cancellation_policy || 'Non-refundable',

      // Supplier reference — needed for booking
      supplierBookingReference: null, // Set after booking
    }));
  }

  _normalizeSeats(data) {
    const seats = data?.seats || data?.data || data || [];
    return seats.map(seat => ({
      supplier: this.supplier,
      seatNumber: seat.seat_number || seat.number,
      status: seat.status || (seat.available ? 'available' : 'booked'),
      type: seat.type || seat.seat_type || 'standard',
      position: seat.position || null, // window, aisle, middle
      deck: seat.deck || 'lower',
      price: Number(seat.price || seat.fare || 0),
    }));
  }

  _normalizeBooking(data) {
    return {
      supplier: this.supplier,
      supplierBookingReference: data.booking_ref || data.reference || data.id,
      bodrlessRef: null, // Set by booking handler
      status: data.status || 'confirmed',
      tripId: data.trip_id,
      seats: data.seats || data.seat_numbers || [],
      totalAmount: data.total_amount || data.amount,
      currency: data.currency || 'KES',
      passengerDetails: data.passengers || [],
      ticket: data.ticket || data.ticket_url || null,
      confirmedAt: data.confirmed_at || new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────
  // FILTER BY TIME PREFERENCE
  // morning, afternoon, evening, night
  // ─────────────────────────────────────────────
  _filterByTime(routes, timePreference) {
    if (!timePreference) return routes;

    return routes.filter(route => {
      if (!route.departureTime) return true;
      const hour = new Date(route.departureTime).getHours();

      if (timePreference === 'morning') return hour >= 5 && hour < 12;
      if (timePreference === 'afternoon') return hour >= 12 && hour < 17;
      if (timePreference === 'evening') return hour >= 17 && hour < 21;
      if (timePreference === 'night') return hour >= 21 || hour < 5;
      return true;
    });
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };
  }
}

module.exports = new TravlerAdapter();