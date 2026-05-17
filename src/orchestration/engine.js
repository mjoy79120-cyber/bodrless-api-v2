/**
 * BODRLESS ORCHESTRATION ENGINE
 * ─────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const { logger } = require('../utils/logger');

const flightService = require('../integrations/flights');
const hotelService = require('../integrations/hotels');
const transferService = require('../integrations/transfers');
const busService = require('../integrations/buses');

const { parsePrompt } = require('./promptParser');
const { rankPackages } = require('./packageRanker');

// ✅ USE UPLOADED INVENTORY
const uploadedInventory = require('../data/uploadedInventory.json');

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

      const [flightResults, busResults, hotelResults] =
        await Promise.allSettled([
          this._searchFlights(tripParams),
          this._searchBuses(tripParams),
          this._searchHotels(tripParams),
        ]);

      const packages = await this._coordinateResults({
        flights:
          flightResults.status === 'fulfilled'
            ? flightResults.value
            : [],

        buses:
          busResults.status === 'fulfilled'
            ? busResults.value
            : [],

        hotels:
          hotelResults.status === 'fulfilled'
            ? hotelResults.value
            : [],

        tripParams,
      });

      const rankedPackages =
        rankPackages(packages, tripParams);

      return {
        sessionId,
        packages: rankedPackages.slice(0, 4),
        tripParams,
        generatedAt: new Date().toISOString(),
        processingTimeMs:
          Date.now() - startTime,
      };

    } catch (error) {

      logger.error(
        `[${sessionId}] Orchestration failed`,
        { error: error.message }
      );

      throw error;
    }
  }

  async _searchFlights(tripParams) {

    // ✅ FILTER UPLOADED INVENTORY
    const uploadedFlights =
      uploadedInventory.filter(item =>
        item.type?.toLowerCase() === 'flight' &&
        item.destination?.toLowerCase()
          .includes(tripParams.destination.toLowerCase())
      );

    if (uploadedFlights.length) {
      return uploadedFlights.map(flight => ({
        airline: flight.name,
        flightNumber: "BDR001",
        departureTime: "08:00",
        arrivalTime: "12:00",
        price: Number(flight.price || 0)
      }));
    }

    // fallback
    if (!tripParams.requiresFlight) return [];

    try {
      return await flightService.search({
        origin: tripParams.origin,
        destination: tripParams.destination,
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
      return await busService.search(tripParams);
    } catch {
      return [];
    }
  }

  async _searchHotels(tripParams) {

    // ✅ FILTER UPLOADED INVENTORY
    const uploadedHotels =
      uploadedInventory.filter(item =>
        item.type?.toLowerCase() === 'hotel' &&
        item.location?.toLowerCase()
          .includes(tripParams.destination.toLowerCase())
      );

    if (uploadedHotels.length) {
      return uploadedHotels.map(hotel => ({
        name: hotel.name,
        stars: 4,
        rating: 4.5,
        pricePerNight: Number(hotel.price || 0)
      }));
    }

    // fallback
    try {
      return await hotelService.search({
        destination: tripParams.destination,
        checkIn: tripParams.departureDate,
        checkOut: tripParams.returnDate,
        guests: tripParams.passengers,
        budget: tripParams.budget,
      });
    } catch {
      return [];
    }
  }

  async _coordinateResults({
    flights,
    buses,
    hotels,
    tripParams
  }) {

    const uploadedTransfers =
      uploadedInventory.filter(item =>
        item.type?.toLowerCase() === 'transfer' &&
        item.location?.toLowerCase()
          .includes(tripParams.destination.toLowerCase())
      );

    const transportPool =
      tripParams.requiresFlight
        ? flights
        : [...flights, ...buses];

    const safeTransport =
      transportPool.length
        ? transportPool
        : this._mockFlights();

    const safeHotels =
      hotels.length
        ? hotels
        : this._mockHotels(tripParams.destination);

    const safeTransfers =
      uploadedTransfers.length
        ? uploadedTransfers.map(t => ({
            provider: t.name,
            vehicleType: "Transfer",
            price: Number(t.price || 0)
          }))
        : [this._mockTransfer(tripParams.destination)];

    const packages = [];

    for (let i = 0; i < 4; i++) {

      const transport =
        safeTransport[i % safeTransport.length];

      const hotel =
        safeHotels[i % safeHotels.length];

      const transfer =
        safeTransfers[i % safeTransfers.length];

      packages.push(
        this._buildPackage({
          transport,
          hotel,
          transfer,
          tripParams
        })
      );
    }

    return packages;
  }

  _buildPackage({
    transport,
    hotel,
    transfer,
    tripParams
  }) {

    const transportCost =
      (transport.price || 0) *
      (tripParams.passengers || 1);

    const hotelCost =
      (hotel.pricePerNight || 0) *
      (tripParams.nights || 1);

    const transferCost =
      transfer.price || 0;

    const totalPrice =
      transportCost +
      hotelCost +
      transferCost;

    return {

      packageId: uuidv4(),

      summary: {
        route:
          `${tripParams.origin} → ${tripParams.destination}`,

        dates:
          `${tripParams.departureDate} → ${tripParams.returnDate}`,

        passengers:
          tripParams.passengers,

        nights:
          tripParams.nights,

        totalPrice:
          Math.round(totalPrice),

        pricePerPerson:
          Math.round(
            totalPrice /
            (tripParams.passengers || 1)
          )
      },

      transport: {
        providerName:
          transport.airline ||
          transport.provider ||
          "Flight",

        flightNumber:
          transport.flightNumber || "",

        departureTime:
          transport.departureTime || "",

        arrivalTime:
          transport.arrivalTime || "",

        price:
          transport.price || 0
      },

      hotel: {
        name:
          hotel.name || "Hotel",

        stars:
          hotel.stars || 3,

        rating:
          hotel.rating || 4.0,

        pricePerNight:
          hotel.pricePerNight || 0
      },

      transfers: {
        provider:
          transfer.provider ||
          "Transfer Service",

        vehicleType:
          transfer.vehicleType || "Car",

        price:
          transfer.price || 0
      },

      status: "available"
    };
  }

  _mockFlights() {
    return [{
      airline: "Kenya Airways",
      flightNumber: "KQ 784",
      departureTime: "10:00",
      arrivalTime: "20:00",
      price: 450
    }];
  }

  _mockHotels(destination) {
    return [{
      name: `${destination} Grand Hotel`,
      stars: 5,
      pricePerNight: 180,
      rating: 4.7
    }];
  }

  _mockTransfer(destination) {
    return {
      provider: "Bodrless Transfers",
      vehicleType: "SUV",
      price: 40
    };
  }

  _validateTripParams(params) {

    if (!params.destination) {
      throw new Error("Missing destination");
    }
  }
}

module.exports = new OrchestrationEngine();