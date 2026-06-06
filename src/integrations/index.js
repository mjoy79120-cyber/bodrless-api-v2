/**
 * INTEGRATIONS INDEX
 * ─────────────────────────────────────────────────────────────
 * - Hotels: Supabase (real data)
 * - Transfers: Supabase (real data)
 * - Buses: Travler (real-time East Africa routes)
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');
const supabase = require('../utils/supabase');

// ─────────────────────────────────────────────
// HOTEL SERVICE — Supabase
// ─────────────────────────────────────────────
class HotelService {
  async search({ destination, agencyId, checkIn, checkOut, guests, minRating }) {
    try {
      const { data, error } = await supabase
        .from('hotels')
        .select('*')
        .eq('agency_id', agencyId);

      if (error) throw error;

      const nights = checkIn && checkOut
        ? Math.round((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24))
        : 3;

      return (data || [])
        .filter(h => {
          const loc = (h.location || '').toLowerCase();
          const dest = (destination || '').toLowerCase();
          return loc.includes(dest) || dest.includes(loc);
        })
        .filter(h => !minRating || h.stars >= minRating)
        .map(h => ({
          id: h.id,
          name: h.name,
          stars: h.stars || 4,
          rating: h.rating || 4.5,
          location: h.location,
          pricePerNight: h.price_per_night,
          nights,
          checkIn,
          checkOut,
          reviews: h.reviews || [],
          reviewScore: h.review_score || null,
        }));

    } catch (err) {
      logger.error('Hotel search failed', { error: err.message });
      return [];
    }
  }
}

// ─────────────────────────────────────────────
// TRAVLER BUS SERVICE — Real-time
// East Africa routes, seats, bus types
// ─────────────────────────────────────────────
class TravlerBusService {

  constructor() {
    this.baseUrl = process.env.TRAVLER_API_URL || 'https://api.travler.africa';
    this.apiKey = process.env.TRAVLER_API_KEY;
    this.timeout = 10000;
  }

  async search({ origin, destination, departureDate, passengers = 1, timePreference = null }) {
    try {
      logger.info('Travler: searching buses', { origin, destination, departureDate, timePreference });

      // TODO: Update endpoint when Travler sends docs
      const response = await axios.get(`${this.baseUrl}/routes/search`, {
        params: {
          origin,
          destination,
          date: departureDate,
          passengers,
        },
        headers: this._headers(),
        timeout: this.timeout,
      });

      const routes = this._normalizeRoutes(response.data);
      return this._filterByTimePreference(routes, timePreference);

    } catch (err) {
      logger.error('Travler: bus search failed', { error: err.message });
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

  // Filter by time preference — morning, afternoon, evening, night
  _filterByTimePreference(routes, timePreference) {
    if (!timePreference) return routes;

    const preference = timePreference.toLowerCase();

    return routes.filter(route => {
      if (!route.departureTime) return true;

      const hour = new Date(route.departureTime).getHours();

      if (preference.includes('morning')) return hour >= 5 && hour < 12;
      if (preference.includes('afternoon')) return hour >= 12 && hour < 17;
      if (preference.includes('evening')) return hour >= 17 && hour < 21;
      if (preference.includes('night')) return hour >= 21 || hour < 5;

      return true;
    });
  }

  _normalizeRoutes(data) {
    const routes = data?.routes || data?.data || data || [];
    return routes.map(route => ({
      tripId: route.id || route.trip_id,
      operator: route.operator || route.company || route.bus_company,
      busType: route.bus_type || route.vehicle_type || route.coach_type || 'Standard',
      origin: route.origin || route.from,
      destination: route.destination || route.to,
      departureTime: route.departure_time || route.departs_at,
      arrivalTime: route.arrival_time || route.arrives_at,
      duration: route.duration,
      price: Number(route.price || route.fare || route.amount || 0),
      currency: route.currency || 'KES',
      availableSeats: route.available_seats || route.seats_available,
      totalSeats: route.total_seats || route.capacity,
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

// ─────────────────────────────────────────────
// TRANSFER SERVICE — Supabase
// ─────────────────────────────────────────────
class TransferService {
  async search({ destination, agencyId, passengers }) {
    try {
      const { data, error } = await supabase
        .from('transfers')
        .select('*')
        .eq('agency_id', agencyId);

      if (error) throw error;

      return (data || [])
        .filter(t => {
          const loc = (t.location || '').toLowerCase();
          const dest = (destination || '').toLowerCase();
          return loc.includes(dest) || dest.includes(loc);
        })
        .map(t => ({
          id: t.id,
          provider: t.provider,
          vehicleType: t.vehicle_type,
          location: t.location,
          price: t.price,
          currency: 'USD',
        }));

    } catch (err) {
      logger.error('Transfer search failed', { error: err.message });
      return [];
    }
  }
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = {
  hotelService: new HotelService(),
  busService: new TravlerBusService(),
  transferService: new TransferService(),
};