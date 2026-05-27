const { v4: uuidv4 } = require('uuid');
const supabase = require("../utils/supabase");

const { logger } = require('../utils/logger');

const { parsePrompt } = require('./promptParser');
const { rankPackages } = require('./packageRanker');

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

      tripParams.agencyId =
        agencyId;

      this._validateTripParams(
        tripParams
      );

      const flights =
        await this._searchFlights(
          tripParams
        );

      const hotels =
        await this._searchHotels(
          tripParams
        );

      const transfers =
        await this._searchTransfers(
          tripParams
        );

      const packages =
        this._buildPackages({

          flights,
          hotels,
          transfers,
          tripParams
        });

      return {

        sessionId,

        packages:
          rankPackages(
            packages,
            tripParams
          ).slice(0, 4),

        tripParams,

        generatedAt:
          new Date().toISOString()
      };

    } catch (error) {

      logger.error(
        "Engine failure",
        {
          error: error.message
        }
      );

      throw error;
    }
  }

  // ─────────────────────────────
  // FLEXIBLE MATCHING
  // ─────────────────────────────
  _matchesDestination(
    item,
    destination
  ) {

    if (!destination) {
      return true;
    }

    const search =
      destination.toLowerCase();

    const combined = `
      ${item.destination || ""}
      ${item.location || ""}
      ${item.name || ""}
      ${item.notes || ""}
      ${item.origin || ""}
      ${item.airline || ""}
      ${item.provider || ""}
    `.toLowerCase();

    return combined.includes(search);
  }

  // ─────────────────────────────
  // FLIGHTS (SUPABASE)
  // ─────────────────────────────
  async _searchFlights(
    tripParams
  ) {

    const { data, error } =
      await supabase
        .from("flights")
        .select("*")
        .eq(
          "agency_id",
          tripParams.agencyId
        );

    if (error) {

      console.error(error);

      return [];
    }

    const matchedFlights =
      data.filter(flight =>

        this._matchesDestination(
          flight,
          tripParams.destination
        )
      );

    return matchedFlights.map(
      flight => ({

        airline:
          flight.airline ||

          "Flight",

        flightNumber:
          flight.flight_number ||

          "AUTO",

        departureTime:
          "08:00",

        arrivalTime:
          "12:00",

        origin:
          flight.origin || "",

        destination:
          flight.destination || "",

        price:
          Number(
            flight.price || 0
          )
      })
    );
  }

  // ─────────────────────────────
  // HOTELS (SUPABASE)
  // ─────────────────────────────
  async _searchHotels(
    tripParams
  ) {

    const { data, error } =
      await supabase
        .from("hotels")
        .select("*")
        .eq(
          "agency_id",
          tripParams.agencyId
        );

    if (error) {

      console.error(error);

      return [];
    }

    const matchedHotels =
      data.filter(hotel =>

        this._matchesDestination(
          hotel,
          tripParams.destination
        )
      );

    return matchedHotels.map(
      hotel => ({

        name:
          hotel.name ||

          "Hotel",

        stars:
          hotel.stars || 4,

        rating:
          hotel.rating || 4.5,

        category:
          hotel.category || "",

        location:
          hotel.location || "",

        pricePerNight:
          Number(
            hotel.price_per_night || 0
          )
      })
    );
  }

  // ─────────────────────────────
  // TRANSFERS (SUPABASE)
  // ─────────────────────────────
  async _searchTransfers(
    tripParams
  ) {

    const { data, error } =
      await supabase
        .from("transfers")
        .select("*")
        .eq(
          "agency_id",
          tripParams.agencyId
        );

    if (error) {

      console.error(error);

      return [];
    }

    const matchedTransfers =
      data.filter(t =>

        this._matchesDestination(
          t,
          tripParams.destination
        )
      );

    return matchedTransfers.map(
      t => ({

        provider:
          t.provider ||

          "Transfer",

        vehicleType:
          t.vehicle_type ||

          "Transfer",

        location:
          t.location || "",

        price:
          Number(
            t.price || 0
          )
      })
    );
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
      flights;

    const safeHotels =
      hotels;

    const safeTransfers =
      transfers;

    // NO INVENTORY FOUND
    if (

      !safeFlights.length &&

      !safeHotels.length &&

      !safeTransfers.length

    ) {

      return [];
    }

    const packages = [];

    const maxLength = Math.max(
      safeFlights.length || 1,
      safeHotels.length || 1,
      safeTransfers.length || 1
    );

    for (
      let i = 0;
      i < maxLength;
      i++
    ) {

      const flight =
        safeFlights[
          i % safeFlights.length
        ] || {};

      const hotel =
        safeHotels[
          i % safeHotels.length
        ] || {};

      const transfer =
        safeTransfers[
          i % safeTransfers.length
        ] || {};

      const totalPrice =

        (flight.price || 0) +

        (
          (hotel.pricePerNight || 0) *

          (tripParams.nights || 1)
        ) +

        (transfer.price || 0);

      packages.push({

        packageId:
          uuidv4(),

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

              (
                tripParams.passengers || 1
              )
            )
        },

        transport:
          flight,

        hotel,

        transfers:
          transfer,

        status:
          "available"
      });
    }

    return packages;
  }

  // ─────────────────────────────
  // VALIDATION
  // ─────────────────────────────
  _validateTripParams(
    params
  ) {

    if (!params.destination) {

      throw new Error(
        "Missing destination"
      );
    }
  }
}

module.exports =
  new OrchestrationEngine();