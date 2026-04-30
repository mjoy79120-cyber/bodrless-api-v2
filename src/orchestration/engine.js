/**
 * BODRLESS ORCHESTRATION ENGINE
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

// ✅ FIXED IMPORT PATH
const {
  hotels: inventoryHotels = [],
  transfers: inventoryTransfers = []
} = require('../data/mockInventory');

class OrchestrationEngine {

  async orchestrate(prompt, agencyId) {
    const sessionId = uuidv4();
    const startTime = Date.now();

    logger.info(`[${sessionId}] Orchestration started`, { agencyId, prompt });

    try {
      const tripParams = await parsePrompt(prompt);

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

      return {
        sessionId,
        packages: rankedPackages.slice(0, 4), // ALWAYS 4
        tripParams,
        generatedAt: new Date().toISOString(),
        processingTimeMs: duration,
      };

    } catch (error) {
      logger.error(`[${sessionId}] Orchestration failed`, { error: error.message });
      throw error;
    }
  }

  async _searchFlights(tripParams) {
    if (!tripParams.requiresFlight) return [];

    try {
      return await flightService.search({
        origin: tripParams.originCode || tripParams.origin,
        destination: tripParams.destinationCode || tripParams.destination,
        departureDate: tripParams.departureDate,
        returnDate: tripParams.returnDate,
        passengers: tripParams.passengers,
        cabinClass: this._mapBudgetToCabin(tripParams.budget),
      });
    } catch {
      return [];
    }
  }

  async _searchBuses(tripParams) {
    if (!tripParams.requiresBus) return [];

    try {
      return await busService.search({
        origin: tripParams.origin,
        destination: tripParams.destination,
        departureDate: tripParams.departureDate,
        passengers: tripParams.passengers,
      });
    } catch {
      return [];
    }
  }

  async _searchHotels(tripParams) {
    try {
      return await hotelService.search({
        destination: tripParams.destination,
        checkIn: tripParams.departureDate,
        checkOut: tripParams.returnDate,
        guests: tripParams.passengers,
        budget: tripParams.budget,
        minRating: this._mapBudgetToMinRating(tripParams.budget),
      });
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // 🔥 CORE COORDINATION (INVENTORY + FALLBACK)
  // ─────────────────────────────────────────────
  async _coordinateResults({ flights, buses, hotels, tripParams }) {

    const isFlightRoute = tripParams.requiresFlight;

    const transportPool =
      isFlightRoute ? flights : [...flights, ...buses];

    const safeTransport =
      transportPool.length > 0
        ? transportPool
        : this._generateMockFlights();

    // ✅ FILTER INVENTORY HOTELS FIRST
    const filteredInventoryHotels = inventoryHotels.filter(
      h =>
        (h.location || '').toLowerCase() ===
        (tripParams.destination || '').toLowerCase()
    );

    const safeHotels =
      filteredInventoryHotels.length > 0
        ? filteredInventoryHotels
        : hotels.length > 0
          ? hotels
          : this._generateMockHotels(tripParams.destination);

    // ✅ SAFE TRANSFERS FROM INVENTORY
    const safeTransfers =
      inventoryTransfers.length > 0
        ? inventoryTransfers
        : [];

    const packages = [];

    let i = 0;

    while (packages.length < 4) {
      const transport = safeTransport[i % safeTransport.length];
      const hotel = safeHotels[i % safeHotels.length];

      const transfer =
        safeTransfers[i % safeTransfers.length] ||
        this._mockTransfer(tripParams.destination);

      packages.push(
        this._buildPackage({
          transport,
          hotel,
          transfers: transfer,
          tripParams,
        })
      );

      i++;
    }

    return packages;
  }

  // ─────────────────────────────────────────────
  // MOCK DATA (FALLBACK ONLY)
  // ─────────────────────────────────────────────

  _generateMockFlights() {
    return [
      {
        id: "F1",
        type: "flight",
        provider: "Kenya Airways",
        airline: "Kenya Airways",
        flightNumber: "KQ 784",
        departureTime: "10:00",
        arrivalTime: "20:00",
        duration: "10h",
        price: 450
      }
    ];
  }

  _generateMockHotels(destination) {
    return [
      {
        id: "H1",
        name: `${destination} Grand Hotel`,
        stars: 5,
        rating: 4.7,
        reviewCount: 4000,
        location: destination,
        pricePerNight: 180,
      }
    ];
  }

  _mockTransfer(destination) {
    return {
      id: "T1",
      provider: "Bodrless Transfers",
      vehicleType: "Private SUV",
      pickupLocation: `${destination} Airport`,
      dropoffLocation: destination,
      price: 40,
    };
  }

  _buildPackage({ transport, hotel, transfers, tripParams }) {

    const transportCost = transport.price * tripParams.passengers;
    const hotelCost = hotel.pricePerNight * tripParams.nights;
    const transferCost = transfers.price;

    return {
      packageId: uuidv4(),
      summary: {
        route: `${tripParams.origin} → ${tripParams.destination}`,
        dates: `${tripParams.departureDate} — ${tripParams.returnDate}`,
        passengers: tripParams.passengers,
        nights: tripParams.nights,
        totalPrice: transportCost + hotelCost + transferCost,
      },
      transport,
      hotel,
      transfers,
      status: "available"
    };
  }

  _validateTripParams(params) {
    if (!params.destination) throw new Error("Missing destination");
  }

  _mapBudgetToCabin(budget) {
    return { low: 'ECONOMY', mid: 'ECONOMY', high: 'BUSINESS', luxury: 'FIRST' }[budget] || 'ECONOMY';
  }

  _mapBudgetToMinRating(budget) {
    return { low: 3, mid: 3, high: 4, luxury: 5 }[budget] || 3;
  }
}

module.exports = new OrchestrationEngine();
