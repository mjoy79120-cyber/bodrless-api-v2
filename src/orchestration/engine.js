/**
 * BODRLESS ORCHESTRATION ENGINE (FIXED)
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
        this._searchFlights(tripParams),
        this._searchBuses(tripParams),
        this._searchHotels(tripParams),
      ]);

      const packages = await this._coordinateResults({
        flights: flightResults.status === 'fulfilled' ? flightResults.value : [],
        buses: busResults.status === 'fulfilled' ? busResults.value : [],
        hotels: hotelResults.status === 'fulfilled' ? hotelResults.value : [],
        tripParams,
      });

      const rankedPackages = rankPackages(packages, tripParams);

      return {
        sessionId,
        packages: rankedPackages.slice(0, 4),
        tripParams,
        generatedAt: new Date().toISOString(),
        processingTimeMs: Date.now() - startTime,
      };

    } catch (error) {
      logger.error(`[${sessionId}] Orchestration failed`, { error: error.message });
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  async _searchFlights(tripParams) {
    if (!tripParams.requiresFlight) return [];

    try {
      return await flightService.search({
        origin: tripParams.originCode || tripParams.origin,
        destination: tripParams.destinationCode || tripParams.destination,
        departureDate: tripParams.departureDate,
        returnDate: tripParams.returnDate,
        passengers: tripParams.passengers,
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
      });
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────
  async _coordinateResults({ flights, buses, hotels, tripParams }) {

    const transportPool = flights.length > 0 ? flights : [...flights, ...buses];
    const safeTransport = transportPool.length > 0 ? transportPool : this._generateMockFlights();

    const filteredInventoryHotels = inventoryHotels.filter(
      h => (h.location || '').toLowerCase() === (tripParams.destination || '').toLowerCase()
    );

    const safeHotels =
      filteredInventoryHotels.length > 0
        ? filteredInventoryHotels
        : hotels.length > 0
          ? hotels
          : this._generateMockHotels(tripParams.destination);

    const safeTransfers =
      inventoryTransfers.length > 0
        ? inventoryTransfers
        : [];

    const packages = [];

    let i = 0;

    while (packages.length < 4) {

      const transport = safeTransport[i % safeTransport.length];
      const hotel = safeHotels[i % safeHotels.length];
      const transfer = safeTransfers[i % safeTransfers.length] || this._mockTransfer(tripParams.destination);

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
  // FIXED PACKAGE BUILDER (IMPORTANT)
  // ─────────────────────────────────────────────
  _buildPackage({ transport, hotel, transfers, tripParams }) {

    const transportCost = (transport?.price || 0) * (tripParams.passengers || 1);
    const hotelCost = (hotel?.pricePerNight || 0) * (tripParams.nights || 1);
    const transferCost = transfers?.price || 0;

    const totalPrice = transportCost + hotelCost + transferCost;
    const pricePerPerson = Math.round(totalPrice / (tripParams.passengers || 1));

    return {
      packageId: uuidv4(),

      hotel: {
        name: hotel?.name || "Standard Hotel",
        stars: hotel?.stars || 3,
        rating: hotel?.rating || 4.0
      },

      transport: {
        provider: transport?.provider || "Flight included",
        type: transport?.type || "flight",
        flightNumber: transport?.flightNumber || null,
        duration: transport?.duration || null
      },

      transfers: {
        provider: transfers?.provider || "Airport transfer",
        vehicleType: transfers?.vehicleType || "Standard car",
        price: transferCost,
        included: transferCost > 0
      },

      summary: {
        route: `${tripParams.origin} → ${tripParams.destination}`,
        dates: `${tripParams.departureDate} — ${tripParams.returnDate}`,
        passengers: tripParams.passengers || 1,
        nights: tripParams.nights || 1,

        pricePerPerson: pricePerPerson,
        totalPrice: Math.round(totalPrice)
      },

      status: "available"
    };
  }

  // ─────────────────────────────────────────────
  _generateMockFlights() {
    return [{
      type: "flight",
      provider: "Kenya Airways",
      price: 450,
      duration: "10h"
    }];
  }

  _generateMockHotels(destination) {
    return [{
      name: `${destination} Grand Hotel`,
      stars: 5,
      rating: 4.7,
      pricePerNight: 180
    }];
  }

  _mockTransfer(destination) {
    return {
      provider: "Airport Pickup",
      vehicleType: "SUV",
      price: 40
    };
  }

  _validateTripParams(params) {
    if (!params.destination) throw new Error("Missing destination");
  }
}

module.exports = new OrchestrationEngine();
