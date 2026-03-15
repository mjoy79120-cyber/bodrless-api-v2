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

  /**
   * Main entry point — takes a raw traveler prompt and returns
   * complete bookable packages
   *
   * @param {string} prompt   — "Nairobi to Zanzibar, 2 people, mid-budget, April"
   * @param {string} agencyId — which agency this request belongs to
   * @returns {Array}         — array of complete trip packages
   */
  async orchestrate(prompt, agencyId) {
    const sessionId = uuidv4();
    const startTime = Date.now();

    logger.info(`[${sessionId}] Orchestration started`, { agencyId, prompt });

    try {
      // ── STEP 1: Parse the prompt into structured trip parameters ──
      const tripParams = await parsePrompt(prompt);
      logger.info(`[${sessionId}] Prompt parsed`, tripParams);

      // ── STEP 2: Validate we have enough to proceed ─────────────
      this._validateTripParams(tripParams);

      // ── STEP 3: Search all suppliers in parallel ───────────────
      // We search everything simultaneously to be fast,
      // but we coordinate/sequence the results intelligently
      const [flightResults, busResults, hotelResults] = await Promise.allSettled([
        this._searchFlights(tripParams, sessionId),
        this._searchBuses(tripParams, sessionId),
        this._searchHotels(tripParams, sessionId),
      ]);

      // ── STEP 4: Coordinate results respecting dependency chain ──
      // Flights/buses anchor the dates → hotels follow → transfers last
      const packages = await this._coordinateResults({
        flights: flightResults.status === 'fulfilled' ? flightResults.value : [],
        buses: busResults.status === 'fulfilled' ? busResults.value : [],
        hotels: hotelResults.status === 'fulfilled' ? hotelResults.value : [],
        tripParams,
        sessionId,
      });

      // ── STEP 5: Rank packages by relevance + value ─────────────
      const rankedPackages = rankPackages(packages, tripParams);

      const duration = Date.now() - startTime;
      logger.info(`[${sessionId}] Orchestration complete in ${duration}ms`, {
        packagesFound: rankedPackages.length
      });

      return {
        sessionId,
        packages: rankedPackages.slice(0, 3), // Return top 3
        tripParams,
        generatedAt: new Date().toISOString(),
        processingTimeMs: duration,
      };

    } catch (error) {
      logger.error(`[${sessionId}] Orchestration failed`, { error: error.message });
      throw error;
    }
  }

  /**
   * Search for flights — primary transport anchor
   */
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

      logger.info(`[${sessionId}] Flights found: ${results.length}`);
      return results;
    } catch (error) {
      logger.warn(`[${sessionId}] Flight search failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Search for buses/ground transport — used when flight not required
   * or as an alternative for nearby destinations
   */
  async _searchBuses(tripParams, sessionId) {
    if (!tripParams.requiresBus) return [];

    try {
      const results = await busService.search({
        origin: tripParams.origin,
        destination: tripParams.destination,
        departureDate: tripParams.departureDate,
        passengers: tripParams.passengers,
      });

      logger.info(`[${sessionId}] Bus options found: ${results.length}`);
      return results;
    } catch (error) {
      logger.warn(`[${sessionId}] Bus search failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Search for hotels — anchored to transportation arrival/departure
   */
  async _searchHotels(tripParams, sessionId) {
    try {
      const results = await hotelService.search({
        destination: tripParams.destination,
        checkIn: tripParams.departureDate,
        checkOut: tripParams.returnDate,
        guests: tripParams.passengers,
        budget: tripParams.budget,
        minRating: this._mapBudgetToMinRating(tripParams.budget),
      });

      logger.info(`[${sessionId}] Hotels found: ${results.length}`);
      return results;
    } catch (error) {
      logger.warn(`[${sessionId}] Hotel search failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Coordinate results into complete packages
   * This is where the dependency chain logic lives
   *
   * Transport anchors → Hotels follow → Transfers complete
   */
  async _coordinateResults({ flights, buses, hotels, tripParams, sessionId }) {
    const packages = [];
    const transport = [...flights, ...buses];

    if (transport.length === 0 || hotels.length === 0) {
      logger.warn(`[${sessionId}] Insufficient results to build packages`, {
        transport: transport.length,
        hotels: hotels.length
      });
      return packages;
    }

    // Build packages — each package = 1 transport option + 1 hotel + transfers
    // We take top transport options × top hotel options
    const topTransport = transport.slice(0, 3);
    const topHotels = hotels.slice(0, 3);

    for (const transport of topTransport) {
      for (const hotel of topHotels) {
        try {
          // Search transfers only after we know transport + hotel
          // Transfers depend on: arrival airport/station + hotel location
          const transfers = await this._searchTransfers({
            transportArrival: transport.arrival,
            hotelLocation: hotel.location,
            passengers: tripParams.passengers,
            sessionId,
          });

          const pkg = this._buildPackage({
            transport,
            hotel,
            transfers,
            tripParams,
          });

          packages.push(pkg);
        } catch (error) {
          logger.warn(`[${sessionId}] Package build failed`, { error: error.message });
        }
      }
    }

    return packages;
  }

  /**
   * Search for transfers — always last, depends on transport + hotel
   */
  async _searchTransfers({ transportArrival, hotelLocation, passengers, sessionId }) {
    try {
      return await transferService.search({
        pickupLocation: transportArrival,
        dropoffLocation: hotelLocation,
        passengers,
      });
    } catch (error) {
      logger.warn(`[${sessionId}] Transfer search failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Assemble a complete bookable package from components
   */
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
      transport: {
        type: transport.type, // 'flight' | 'bus' | 'train'
        provider: transport.provider,
        departureTime: transport.departureTime,
        arrivalTime: transport.arrivalTime,
        duration: transport.duration,
        stops: transport.stops || 0,
        baggage: transport.baggage,
        cancellationPolicy: transport.cancellationPolicy,
        price: transportCost,
        bookingRef: transport.id,
      },
      hotel: {
        name: hotel.name,
        stars: hotel.stars,
        rating: hotel.rating,
        reviewCount: hotel.reviewCount,
        location: hotel.location,
        roomType: hotel.roomType,
        amenities: hotel.amenities,
        checkIn: tripParams.departureDate,
        checkOut: tripParams.returnDate,
        nights: tripParams.nights,
        cancellationPolicy: hotel.cancellationPolicy,
        price: hotelCost,
        bookingRef: hotel.id,
      },
      transfers: transfers ? {
        provider: transfers.provider,
        vehicleType: transfers.vehicleType,
        pickupLocation: transfers.pickupLocation,
        dropoffLocation: transfers.dropoffLocation,
        price: transferCost,
        bookingRef: transfers.id,
      } : null,
      bookedAs: 'package', // Bodrless books as coordinated package
      status: 'available',
    };
  }

  /**
   * Validate that we have minimum required trip parameters
   */
  _validateTripParams(params) {
    const required = ['origin', 'destination', 'passengers'];
    if (!params.departureDate) {
      const date = new Date();
      date.setDate(date.getDate() + 14);
      params.departureDate = date.toISOString().split('T')[0];
    }
    const missing = required.filter(field => !params[field]);

    if (missing.length > 0) {
      throw new Error(`Missing required trip parameters: ${missing.join(', ')}`);
    }
  }

  // ── Budget mapping helpers ─────────────────────────────────

  _mapBudgetToCabin(budget) {
    const map = { low: 'ECONOMY', mid: 'ECONOMY', high: 'BUSINESS', luxury: 'FIRST' };
    return map[budget] || 'ECONOMY';
  }

  _mapBudgetToMinRating(budget) {
    const map = { low: 3, mid: 3, high: 4, luxury: 5 };
    return map[budget] || 3;
  }
}

module.exports = new OrchestrationEngine();
