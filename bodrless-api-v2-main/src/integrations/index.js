/**
 * HOTEL INTEGRATION
 */
const axios = require('axios');
const { logger } = require('../utils/logger');

class HotelService {
  async search({ destination, checkIn, checkOut, guests, budget, minRating }) {
    return this._getMockHotels({ destination, checkIn, checkOut, guests, minRating });
  }

  _getMockHotels({ destination, checkIn, checkOut, guests, minRating }) {
    logger.warn('Using mock hotel data — configure hotel API keys for real results');
    const nights = checkIn && checkOut
      ? Math.round((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24))
      : 3;

    return [
      {
        id: 'mock-hotel-1',
        name: `${destination} Beach Resort`,
        stars: 3,
        rating: 7.8,
        reviewCount: 342,
        location: { address: `${destination} Beach Road`, lat: -6.165, lng: 39.202 },
        roomType: 'Standard Double Room',
        amenities: ['WiFi', 'Pool', 'Breakfast included'],
        pricePerNight: 80,
        checkIn, checkOut, nights,
        cancellationPolicy: 'Free cancellation 48h before',
        id: 'mock-hotel-1',
      },
      {
        id: 'mock-hotel-2',
        name: `Baraza Resort & Spa`,
        stars: 4,
        rating: 9.1,
        reviewCount: 1204,
        location: { address: `${destination} South Coast`, lat: -6.298, lng: 39.534 },
        roomType: 'Deluxe Suite',
        amenities: ['WiFi', 'Spa', 'Pool', 'Breakfast & Dinner', 'Airport Transfer'],
        pricePerNight: 180,
        checkIn, checkOut, nights,
        cancellationPolicy: 'Free cancellation 72h before',
        id: 'mock-hotel-2',
      },
      {
        id: 'mock-hotel-3',
        name: `The Residence ${destination}`,
        stars: 5,
        rating: 9.6,
        reviewCount: 876,
        location: { address: `${destination} North Coast`, lat: -5.987, lng: 39.312 },
        roomType: 'Ocean View Villa',
        amenities: ['WiFi', 'Private Pool', 'Butler Service', 'All Inclusive', 'VIP Transfer'],
        pricePerNight: 420,
        checkIn, checkOut, nights,
        cancellationPolicy: 'Non-refundable',
        id: 'mock-hotel-3',
      },
    ].filter(h => h.stars >= (minRating || 3));
  }
}

// ─────────────────────────────────────────────────────────────

/**
 * BUS INTEGRATION
 * Connect to BuuPass, Easy Coach, etc.
 */
class BusService {
  async search({ origin, destination, departureDate, passengers }) {
    try {
      // TODO: Connect to BuuPass API
      return this._getMockBuses({ origin, destination, departureDate, passengers });
    } catch (error) {
      logger.error('Bus search failed', { error: error.message });
      return [];
    }
  }

  _getMockBuses({ origin, destination, departureDate, passengers }) {
    logger.warn('Using mock bus data — configure BUUPASS_API_KEY for real results');
    return [
      {
        id: 'mock-bus-1',
        type: 'bus',
        provider: 'BUUPASS',
        providerName: 'Modern Coast',
        origin, destination,
        departureTime: `${departureDate}T21:00:00`,
        arrivalTime: `${departureDate}T06:00:00`,
        duration: 'PT9H',
        stops: 2,
        arrival: { station: `${destination} Bus Terminal`, time: `${departureDate}T06:00:00` },
        baggage: { included: true, weight: '20KG' },
        cancellationPolicy: 'Non-refundable',
        price: 25 * passengers,
        currency: 'USD',
        amenities: ['AC', 'Reclining seats', 'USB charging'],
      },
    ];
  }
}

// ─────────────────────────────────────────────────────────────

/**
 * TRANSFER INTEGRATION
 * Airport/station to hotel transfers
 */
class TransferService {
  async search({ pickupLocation, dropoffLocation, passengers }) {
    try {
      // TODO: Connect to transfer API
      return this._getMockTransfer({ pickupLocation, dropoffLocation, passengers });
    } catch (error) {
      logger.error('Transfer search failed', { error: error.message });
      return null;
    }
  }

  _getMockTransfer({ pickupLocation, dropoffLocation, passengers }) {
    return {
      id: 'mock-transfer-1',
      provider: 'LocalTransfers',
      vehicleType: passengers <= 2 ? 'Sedan' : passengers <= 6 ? 'Minivan' : 'Bus',
      pickupLocation,
      dropoffLocation,
      duration: '45 minutes',
      price: passengers <= 2 ? 25 : 40,
      currency: 'USD',
      notes: 'Driver meets you at arrivals with name board',
    };
  }
}

// ─────────────────────────────────────────────────────────────

const { logger: _logger } = require('../utils/logger');

module.exports = {
  hotelService: new HotelService(),
  busService: new BusService(),
  transferService: new TransferService(),
};
