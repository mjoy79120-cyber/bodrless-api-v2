/**
 * BODRLESS ORCHESTRATION ENGINE (STRICT INVENTORY MODE)
 */

const { v4: uuidv4 } = require('uuid');
const fs = require("fs");
const path = require("path");
const { logger } = require('../utils/logger');

const flightService = require('../integrations/flights');
const hotelService = require('../integrations/hotels');
const transferService = require('../integrations/transfers');
const busService = require('../integrations/buses');

const { parsePrompt } = require('./promptParser');
const { rankPackages } = require('./packageRanker');

// ─────────────────────────────
// LOAD AGENCY INVENTORY
// ─────────────────────────────
function loadAgencyInventory(agencyId, type) {
  try {
    const filePath = path.join(
      __dirname,
      `../data/agencies/${agencyId}/${type}.json`
    );

    if (!fs.existsSync(filePath)) return [];

    return JSON.parse(fs.readFileSync(filePath));

  } catch (err) {
    console.error(err);
    return [];
  }
}

class OrchestrationEngine {

  async orchestrate(prompt, agencyId) {

    const sessionId = uuidv4();
    const startTime = Date.now();

    logger.info(`[${sessionId}] Orchestration started`, {
      agencyId,
      prompt
    });

    try {

      const tripParams = await parsePrompt(prompt);

      this._validateTripParams(tripParams);

      // PASS AGENCY ID DOWN
      const flightsResult = await this._searchFlights(tripParams, agencyId);
      const busesResult = await this._searchBuses(tripParams);
      const hotelsResult = await this._searchHotels(tripParams, agencyId);
      const transfers = loadAgencyInventory(agencyId, "transfers");

      const packages = await this._coordinateResults({
        flights: flightsResult,
        buses: busesResult,
        hotels: hotelsResult,
        transfers,
        tripParams
      });

      const rankedPackages = rankPackages(packages, tripParams);

      return {
        sessionId,
        packages: rankedPackages.slice(0, 4),
        tripParams,
        generatedAt: new Date().toISOString(),
        processingTimeMs: Date.now() - startTime
      };

    } catch (error) {

      logger.error(`[${sessionId}] Orchestration failed`, {
        error: error.message
      });

      throw error;
    }
  }

  // ─────────────────────────────
  // FLIGHTS (AGENCY ONLY + API fallback)
  // ─────────────────────────────
  async _searchFlights(tripParams, agencyId) {

    const flights = loadAgencyInventory(agencyId, "flights");

    const matched = flights.filter(f =>
      (f.destination || "")
        .toLowerCase()
        .includes(tripParams.destination.toLowerCase())
    );

    if (matched.length) return matched;

    try {
      return await flightService.search({
        origin: tripParams.origin,
        destination: tripParams.destination,
        departureDate: tripParams.departureDate,
        returnDate: tripParams.returnDate,
        passengers: tripParams.passengers
      });
    } catch {
      return [];
    }
  }

  // ─────────────────────────────
  // HOTELS (AGENCY ONLY + API fallback)
  // ─────────────────────────────
  async _searchHotels(tripParams, agencyId) {

    const hotels = loadAgencyInventory(agencyId, "hotels");

    const matched = hotels.filter(h =>
      (h.location || h.destination || "")
        .toLowerCase()
        .includes(tripParams.destination.toLowerCase())
    );

    if (matched.length) return matched;

    try {
      return await hotelService.search({
        destination: tripParams.destination,
        checkIn: tripParams.departureDate,
        checkOut: tripParams.returnDate,
        guests: tripParams.passengers
      });
    } catch {
      return [];
    }
  }

  // ─────────────────────────────
  // BUSES (API ONLY)
  // ─────────────────────────────
  async _searchBuses(tripParams) {
    if (!tripParams.requiresBus) return [];

    try {
      return await busService.search(tripParams);
    } catch {
      return [];
    }
  }

  // ─────────────────────────────
  // CORE PACKAGE BUILDER (STRICT MODE)
  // ─────────────────────────────
  async _coordinateResults({
    flights,
    buses,
    hotels,
    transfers,
    tripParams
  }) {

    // STRICT MODE: no inventory = no packages
    if (!flights.length || !hotels.length) {
      return [];
    }

    const transportPool =
      tripParams.requiresFlight ? flights : [...flights, ...buses];

    const packages = [];

    for (let i = 0; i < 4; i++) {

      const transport = transportPool[i % transportPool.length];
      const hotel = hotels[i % hotels.length];
      const transfer = transfers[i % transfers.length];

      packages.push(this._buildPackage({
        transport,
        hotel,
        transfer,
        tripParams
      }));
    }

    return packages;
  }

  // ─────────────────────────────
  // PACKAGE STRUCTURE
  // ─────────────────────────────
  _buildPackage({ transport, hotel, transfer, tripParams }) {

    const transportCost = (transport.price || 0) * (tripParams.passengers || 1);
    const hotelCost = (hotel.pricePerNight || 0) * (tripParams.nights || 1);
    const transferCost = transfer?.price || 0;

    const totalPrice = transportCost + hotelCost + transferCost;

    return {
      packageId: uuidv4(),

      summary: {
        route: `${tripParams.origin} → ${tripParams.destination}`,
        dates: `${tripParams.departureDate} → ${tripParams.returnDate}`,
        passengers: tripParams.passengers,
        nights: tripParams.nights,
        totalPrice: Math.round(totalPrice),
        pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1))
      },

      transport,
      hotel,
      transfers: transfer,
      status: "available"
    };
  }

  // ─────────────────────────────
  // VALIDATION
  // ─────────────────────────────
  _validateTripParams(params) {
    if (!params.destination) {
      throw new Error("Missing destination");
    }
  }
}

module.exports = new OrchestrationEngine();