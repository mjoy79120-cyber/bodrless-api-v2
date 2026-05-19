const { v4: uuidv4 } = require('uuid');
const { logger } = require('../utils/logger');

const flightService = require('../integrations/flights');
const hotelService = require('../integrations/hotels');
const busService = require('../integrations/buses');

const { parsePrompt } = require('./promptParser');
const { rankPackages } = require('./packageRanker');

const uploadedInventory =
  require('../data/uploadedInventory.json');

class OrchestrationEngine {

  async orchestrate(prompt, agencyId) {

    const sessionId = uuidv4();

    logger.info(`[${sessionId}] Started`, {
      agencyId,
      prompt
    });

    try {

      const tripParams =
        await parsePrompt(prompt);

      this._validateTripParams(tripParams);

      const flights =
        await this._searchFlights(tripParams);

      const hotels =
        await this._searchHotels(tripParams);

      const transfers =
        await this._searchTransfers(tripParams);

      const packages =
        this._buildPackages({
          flights,
          hotels,
          transfers,
          tripParams
        });

      return {
        sessionId,
        packages: rankPackages(
          packages,
          tripParams
        ).slice(0, 4),

        tripParams,
        generatedAt:
          new Date().toISOString()
      };

    } catch (error) {

      logger.error("Engine failure", {
        error: error.message
      });

      throw error;
    }
  }

  // ─────────────────────────────
  // FLEXIBLE MATCHING
  // ─────────────────────────────
  _matchesDestination(item, destination) {

    if (!destination) return true;

    const search =
      destination.toLowerCase();

    const combined = `
      ${item.destination || ""}
      ${item.location || ""}
      ${item.name || ""}
      ${item.notes || ""}
    `.toLowerCase();

    return combined.includes(search);
  }

  // ─────────────────────────────
  // FLIGHTS
  // ─────────────────────────────
  async _searchFlights(tripParams) {

    const uploadedFlights =
      uploadedInventory.filter(item =>

        (
          item.type === 'flight' ||
          item.type === 'bus'
        ) &&

        this._matchesDestination(
          item,
          tripParams.destination
        )
      );

    if (uploadedFlights.length) {

      return uploadedFlights.map(flight => ({

        airline:
          flight.name ||

          flight.provider ||

          "Flight",

        flightNumber: "BDR001",

        departureTime: "08:00",

        arrivalTime: "12:00",

        price:
          Number(flight.price || 0)
      }));
    }

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

  // ─────────────────────────────
  // HOTELS
  // ─────────────────────────────
  async _searchHotels(tripParams) {

    const uploadedHotels =
      uploadedInventory.filter(item =>

        item.type === 'hotel' &&

        this._matchesDestination(
          item,
          tripParams.destination
        )
      );

    if (uploadedHotels.length) {

      return uploadedHotels.map(hotel => ({

        name:
          hotel.name ||

          "Hotel",

        stars: 4,

        rating: 4.5,

        pricePerNight:
          Number(hotel.price || 0)
      }));
    }

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

  // ─────────────────────────────
  // TRANSFERS
  // ─────────────────────────────
  async _searchTransfers(tripParams) {

    const uploadedTransfers =
      uploadedInventory.filter(item =>

        item.type === 'transfer' &&

        this._matchesDestination(
          item,
          tripParams.destination
        )
      );

    return uploadedTransfers.map(t => ({

      provider:
        t.name ||

        "Transfer",

      vehicleType: "Transfer",

      price:
        Number(t.price || 0)
    }));
  }

  // ─────────────────────────────
  // BUILD PACKAGES
  // ─────────────────────────────
  _buildPackages({
    flights,
    hotels,
    transfers,
    tripParams
  }) {

    const safeFlights =
      flights.length
        ? flights
        : [this._mockFlight()];

    const safeHotels =
      hotels.length
        ? hotels
        : [this._mockHotel(
            tripParams.destination
          )];

    const safeTransfers =
      transfers.length
        ? transfers
        : [this._mockTransfer()];

    const packages = [];

    for (let i = 0; i < 4; i++) {

      const flight =
        safeFlights[
          i % safeFlights.length
        ];

      const hotel =
        safeHotels[
          i % safeHotels.length
        ];

      const transfer =
        safeTransfers[
          i % safeTransfers.length
        ];

      const totalPrice =
        (flight.price || 0) +
        ((hotel.pricePerNight || 0) *
          (tripParams.nights || 1)) +
        (transfer.price || 0);

      packages.push({

        packageId: uuidv4(),

        summary: {

          route:
            `${tripParams.origin} → ${tripParams.destination}`,

          passengers:
            tripParams.passengers,

          nights:
            tripParams.nights,

          totalPrice,

          pricePerPerson:
            Math.round(
              totalPrice /
              (tripParams.passengers || 1)
            )
        },

        transport: flight,

        hotel,

        transfers: transfer,

        status: "available"
      });
    }

    return packages;
  }

  // ─────────────────────────────
  // MOCKS
  // ─────────────────────────────
  _mockFlight() {

    return {

      airline: "Kenya Airways",

      flightNumber: "KQ100",

      departureTime: "08:00",

      arrivalTime: "12:00",

      price: 400
    };
  }

  _mockHotel(destination) {

    return {

      name:
        `${destination} Hotel`,

      stars: 4,

      rating: 4.5,

      pricePerNight: 120
    };
  }

  _mockTransfer() {

    return {

      provider:
        "Bodrless Transfers",

      vehicleType: "SUV",

      price: 40
    };
  }

  _validateTripParams(params) {

    if (!params.destination) {

      throw new Error(
        "Missing destination"
      );
    }
  }
}

module.exports =
  new OrchestrationEngine();