const { v4: uuidv4 } = require("uuid");
const { logger } = require("../utils/logger");

const supabase = require("../utils/supabase");

const flightService = require("../integrations/flights");
const hotelService = require("../integrations/hotels");
const transferService = require("../integrations/transfers");
const busService = require("../integrations/buses");

const { parsePrompt } = require("./promptParser");
const { rankPackages } = require("./packageRanker");

// ─────────────────────────────
// HELPERS
// ─────────────────────────────
function normalize(text = "") {
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(",", "");
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
      tripParams.agencyId = agencyId;

      this._validateTripParams(tripParams);

      // ─────────────────────────────
      // SUPABASE DATA LOADING
      // ─────────────────────────────
      const [flightsRes, hotelsRes, transfersRes] = await Promise.all([

        supabase.from("flights").select("*").eq("agency_id", agencyId),

        supabase.from("hotels").select("*").eq("agency_id", agencyId),

        supabase.from("transfers").select("*").eq("agency_id", agencyId)
      ]);

      const flights = flightsRes.data || [];
      const hotels = hotelsRes.data || [];
      const transfers = transfersRes.data || [];

      // ─────────────────────────────
      // STRICT MATCHING (NO FALLBACK DATA)
      // ─────────────────────────────
      const matchedFlights = flights.filter(f =>
        normalize(f.destination).includes(normalize(tripParams.destination))
      );

      const matchedHotels = hotels.filter(h =>
        normalize(h.location || h.destination).includes(normalize(tripParams.destination))
      );

      const matchedTransfers = transfers;

      // 🚨 STRICT MODE: if no inventory → return empty
      if (!matchedFlights.length || !matchedHotels.length) {
        return {
          sessionId,
          packages: [],
          tripParams,
          generatedAt: new Date().toISOString(),
          message: "No agency inventory found for this route"
        };
      }

      const packages = this._buildPackages({
        flights: matchedFlights,
        hotels: matchedHotels,
        transfers: matchedTransfers,
        tripParams
      });

      return {
        sessionId,
        packages: rankPackages(packages, tripParams).slice(0, 4),
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
  // PACKAGE BUILDER
  // ─────────────────────────────
  _buildPackages({ flights, hotels, transfers, tripParams }) {

    const packages = [];

    for (let i = 0; i < 4; i++) {

      const flight = flights[i % flights.length];
      const hotel = hotels[i % hotels.length];
      const transfer = transfers[i % transfers.length];

      const transportCost = (flight.price || 0) * (tripParams.passengers || 1);
      const hotelCost = (hotel.price_per_night || hotel.pricePerNight || 0) * (tripParams.nights || 1);
      const transferCost = transfer?.price || 0;

      const totalPrice = transportCost + hotelCost + transferCost;

      packages.push({
        packageId: uuidv4(),

        summary: {
          route: `${tripParams.origin} → ${tripParams.destination}`,
          dates: `${tripParams.departureDate} → ${tripParams.returnDate}`,
          passengers: tripParams.passengers,
          nights: tripParams.nights,
          totalPrice: Math.round(totalPrice),
          pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1))
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
  // VALIDATION
  // ─────────────────────────────
  _validateTripParams(params) {
    if (!params.destination) {
      throw new Error("Missing destination");
    }
  }
}

module.exports = new OrchestrationEngine();