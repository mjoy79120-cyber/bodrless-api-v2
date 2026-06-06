/**
 * TRAVLER BUS INTEGRATION
 * ─────────────────────────────────────────────────────────────
 * East Africa bus routes — search, seat selection, booking
 * Ready to wire up once Travler sends API docs
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

class TravlerService {

  constructor() {
    this.baseUrl = process.env.TRAVLER_API_URL || 'https://api.travler.africa';
    this.apiKey = process.env.TRAVLER_API_KEY;
    this.timeout = 10000;
  }

  async searchRoutes({ origin, destination, date, passengers = 1 }) {
    try {
      logger.info('Travler: searching routes', { origin, destination, date });

      const response = await axios.get(`${this.baseUrl}/routes/search`, {
        params: { origin, destination, date, passengers },
        headers: this._headers(),
        timeout: this.timeout,
      });

      return this._normalizeRoutes(response.data);

    } catch (err) {
      logger.error('Travler: route search failed', { error: err.message });
      return [];
    }
  }

  async getSeatAvailability({ tripId, date }) {
    try {
      logger.info('Travler: getting seats', { tripId });

      const response = await axios.get(`${this.baseUrl}/trips/${tripId}/seats`, {
        params: { date },
        headers: this._headers(),
        timeout: this.timeout,
      });

      return this._normalizeSeats(response.data);

    } catch (err) {
      logger.error('Travler: seat fetch failed', { error: err.message });
      return [];
    }
  }

  async bookSeats({ tripId, seatNumbers, passengerDetails, agencyId }) {
    try {
      logger.info('Travler: booking seats', { tripId, seatNumbers });

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
      logger.error('Travler: booking failed', { error: err.message });
      throw err;
    }
  }

  async getBookingStatus(bookingRef) {
    try {
      const response = await axios.get(`${this.baseUrl}/bookings/${bookingRef}`, {
        headers: this._headers(),
        timeout: this.timeout,
      });
      return response.data;
    } catch (err) {
      logger.error('Travler: status check failed', { error: err.message });
      throw err;
    }
  }

  async cancelBooking(bookingRef) {
    try {
      const response = await axios.delete(`${this.baseUrl}/bookings/${bookingRef}`, {
        headers: this._headers(),
        timeout: this.timeout,
      });
      return response.data;
    } catch (err) {
      logger.error('Travler: cancellation failed', { error: err.message });
      throw err;
    }
  }

  _normalizeRoutes(data) {
    const routes = data?.routes || data?.data || data || [];
    return routes.map(route => ({
      tripId: route.id || route.trip_id,
      operator: route.operator || route.company || route.bus_company,
      origin: route.origin || route.from,
      destination: route.destination || route.to,
      departureTime: route.departure_time || route.departs_at,
      arrivalTime: route.arrival_time || route.arrives_at,
      duration: route.duration,
      price: Number(route.price || route.fare || route.amount || 0),
      currency: route.currency || 'KES',
      availableSeats: route.available_seats || route.seats_available,
      totalSeats: route.total_seats || route.capacity,
      busType: route.bus_type || route.vehicle_type || 'Standard',
      amenities: route.amenities || [],
      transportType: 'bus',
      provider: route.operator || route.company,
    }));
  }

  _normalizeSeats(data) {
    const seats = data?.seats || data?.data || data || [];
    return seats.map(seat => ({
      seatNumber: seat.seat_number || seat.number,
      status: seat.status || (seat.available ? 'available' : 'booked'),
      type: seat.type || seat.seat_type || 'standard',
      price: Number(seat.price || seat.fare || 0),
      deck: seat.deck || 'lower',
      position: seat.position || null,
    }));
  }

  _normalizeBooking(data) {
    return {
      bookingRef: data.booking_ref || data.reference || data.id,
      status: data.status || 'confirmed',
      tripId: data.trip_id,
      seats: data.seats || data.seat_numbers,
      totalAmount: data.total_amount || data.amount,
      currency: data.currency || 'KES',
      passengerDetails: data.passengers,
      ticket: data.ticket || data.ticket_url || null,
      confirmedAt: data.confirmed_at || new Date().toISOString(),
    };
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };
  }
}

module.exports = new TravlerService();