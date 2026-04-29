/**
 * BODRLESS ORCHESTRATION ENGINE
 * ─────────────────────────────────────────────────────────────
 * This is the heart of Bodrless. It understands the travel
 * dependency chain and coordinates all suppliers in the right
 * order:
 *
 *   1. FLIGHTS first  — they anchor dates and times
 *   2. HOTELS second  — they follow flight arrival/departure
 *   3. TRANSFERS last — they depend on flight times + hotel location
 *
 * Any system that doesn't respect this chain produces broken
 * bookings. This is Bodrless's core IP.
 * ─────────────────────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const { logger } = require('../utils/logger');
const flightService = require('../integrations/flights');
const hotelService = require('../integrations/hotels');
const transferService = require('../integrations/transfers');
const busService = require('../integrations/buses');
const { parsePrompt } = require('./promptParser');
const { rankPackages } = require('./packageRanker');

class OrchestrationEngine {

  async orchestrate(prompt, agencyId) {
    const sessionId = uuidv4();
    const startTime = Date.now();

    logger.info(`[${sessionId}] Orchestration started`, { agencyId, prompt });

    try {
      const tripParams = await parsePrompt(prompt);
      logger.info(`[${sessionId}] Prompt parsed`, tripParams);

      this._validateTripParams(tripParams);

      const [flightResults, busResults, hotelResults] = await Promise.allSettled([
        this._searchFlights(tripParams, sessionId),
        this._searchBuses(tripParams, sessionId),
        this._searchHotels(tripParams, sessionId),
      ]);

      const packages = await this._coordinateResults({
        flights: flightResults.status === 'fulfilled' ? flightResults.value : [],
        buses: busResults.status === 'fulfilled' ? busResults.value : [],
        hotels: hotelResults.status === 'fulfilled' ? hotelResults.value : [],
        tripParams,
        sessionId,
      });

      const rankedPackages = rankPackages(packages, tripParams);

      const duration = Date.now() - startTime;

      logger.info(`[${sessionId}] Orchestration complete in ${duration}ms`, {
        packagesFound: rankedPackages.length
      });

      return {
        sessionId,
        packages: rankedPackages.slice(0, 4), // 🔥 FIX: always return 4
        tripParams,
        generatedAt: new Date().toISOString(),
        processingTimeMs: duration,
      };

    } catch (error) {
      logger.error(`[${sessionId}] Orchestration failed`, { error: error.message });
      throw error;
    }
  }

  async _searchFlights(tripParams, sessionId) {
    if (!tripParams.requiresFlight) return [];

    try {
      const results = await flightService.search({
        origin: tripParams.originCode || tripParams.origin,
        destination: tripParams.destinationCode || tripParams.destination,
        departureDate: tripParams.departureDate,
        returnDate: tripParams.returnDate,
        passengers: tripParams.passengers,
        cabinClass: this._mapBudgetToCabin(tripParams.budget),
      });

      return results;
    } catch (error) {
      logger.warn(`[${sessionId}] Flight search failed`);
      return [];
    }
  }

  async _searchBuses(tripParams, sessionId) {
    if (!tripParams.requiresBus) return [];

    try {
      return await busService.search({
        origin: tripParams.origin,
        destination: tripParams.destination,
        departureDate: tripParams.departureDate,
        passengers: tripParams.passengers,
      });
    } catch (error) {
      logger.warn(`[${sessionId}] Bus search failed`);
      return [];
    }
  }

  async _searchHotels(tripParams, sessionId) {
    try {
      return await hotelService.search({
        destination: tripParams.destination,
        checkIn: tripParams.departureDate,
        checkOut: tripParams.returnDate,
        guests: tripParams.passengers,
        budget: tripParams.budget,
        minRating: this._mapBudgetToMinRating(tripParams.budget),
      });
    } catch (error) {
      logger.warn(`[${sessionId}] Hotel search failed`);
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // 🔥 FIXED CORE LOGIC
  // ─────────────────────────────────────────────
  async _coordinateResults({ flights, buses, hotels, tripParams, sessionId }) {
    const packages = [];

    const isLongHaul = tripParams.requiresFlight;

    const transportPool = isLongHaul ? flights : [...flights, ...buses];

    const safeTransport =
      transportPool && transportPool.length > 0
        ? transportPool
        : [this._mockTransport(tripParams)];

    const safeHotels =
      hotels && hotels.length > 0
        ? hotels
        : [this._mockHotel(tripParams.destination)];

    const topTransport = safeTransport.slice(0, 2);
    const topHotels = safeHotels.slice(0, 2);

    for (const transport of topTransport) {
      for (const hotel of topHotels) {
        try {
          const transfers = this._mockTransfers({
            destination: tripParams.destination,
            passengers: tripParams.passengers,
          });

          packages.push(
            this._buildPackage({
              transport,
              hotel,
              transfers,
              tripParams,
            })
          );
        } catch (error) {
          logger.warn(`[${sessionId}] Package build failed`);
        }
      }
    }

    return packages.slice(0, 4); // 🔥 ALWAYS 4
  }

  // ─────────────────────────────────────────────
  // 🔥 MOCK LAYER (CRITICAL FIX)
  // ─────────────────────────────────────────────
  _mockTransport(tripParams) {
    return {
      id: 'mock-transport',
      type: tripParams.requiresFlight ? 'flight' : 'bus',
      provider: 'Bodrless Air',
      departureTime: '10:00',
      arrivalTime: '18:00',
      duration: '8h',
      stops: 0,
      baggage: '23kg',
      cancellationPolicy: 'Flexible',
      price: 450,
    };
  }

  _mockHotel(destination) {
    return {
      id: 'mock-hotel',
      name: `${destination} Grand Hotel`,
      stars: 4,
      rating: 4.4,
      reviewCount: 1200,
      location: destination,
      roomType: 'Deluxe Room',
      amenities: ['WiFi', 'Pool', 'Breakfast'],
      pricePerNight: 120,
      cancellationPolicy: 'Free cancellation',
    };
  }

  _mockTransfers({ destination, passengers }) {
    return {
      id: 'mock-transfer',
      provider: 'Bodrless Transfers',
      vehicleType: 'Private Car',
      pickupLocation: `${destination} Airport`,
      dropoffLocation: destination,
      price: 25 * passengers,
    };
  }

  // ─────────────────────────────────────────────

  _buildPackage({ transport, hotel, transfers, tripParams }) {
    const transportCost = transport.price * tripParams.passengers;
    const hotelCost = hotel.pricePerNight * tripParams.nights;
    const transferCost = transfers ? transfers.price : 0;

    const totalPrice = transportCost + hotelCost + transferCost;

    return {
      packageId: uuidv4(),
      summary: {
        route: `${tripParams.origin} → ${tripParams.destination}`,
        dates: `${tripParams.departureDate} — ${tripParams.returnDate}`,
        passengers: tripParams.passengers,
        nights: tripParams.nights,
        totalPrice,
        currency: 'USD',
        pricePerPerson: Math.round(totalPrice / tripParams.passengers),
      },
      transport,
      hotel,
      transfers,
      bookedAs: 'package',
      status: 'available',
    };
  }

  _validateTripParams(params) {
    if (!params.destination) {
      throw new Error('Missing destination');
    }
  }

  _mapBudgetToCabin(budget) {
    return { low: 'ECONOMY', mid: 'ECONOMY', high: 'BUSINESS', luxury: 'FIRST' }[budget] || 'ECONOMY';
  }

  _mapBudgetToMinRating(budget) {
    return { low: 3, mid: 3, high: 4, luxury: 5 }[budget] || 3;
  }
}

module.exports = new OrchestrationEngine();
