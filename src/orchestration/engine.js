const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");

const { logger } = require("../utils/logger");

const { parsePrompt } = require("./promptParser");
const { rankPackages } = require("./packageRanker");

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

      console.log(
        "PARSED TRIP PARAMS:",
        tripParams
      );

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

      console.log(
        "FINAL FLIGHTS:",
        flights
      );

      console.log(
        "FINAL HOTELS:",
        hotels
      );

      console.log(
        "FINAL TRANSFERS:",
        transfers
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
  // NORMALIZE TEXT
  // ─────────────────────────────
  _normalize(text) {

    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim();
  }

  // ─────────────────────────────
  // DESTINATION MATCHING
  // ─────────────────────────────
  _matchesDestination(
    item,
    destination
  ) {

    if (!destination) {
      return true;
    }

    const search =
      this._normalize(destination);

    const combined =
      this._normalize(`

        ${item.destination || ""}
        ${item.location || ""}
        ${item.city || ""}
        ${item.country || ""}
        ${item.name || ""}
        ${item.hotel_name || ""}
        ${item.origin || ""}
        ${item.airline || ""}
        ${item.provider || ""}
        ${item.notes || ""}
      `);

    console.log("SEARCH:", search);
    console.log("COMBINED:", combined);

    if (
      combined.includes(search)
    ) {
      return true;
    }

    const words =
      search.split(" ");

    return words.some(word =>
      word.length > 2 &&
      combined.includes(word)
    );
  }

  // ─────────────────────────────
  // FLIGHTS
  // ─────────────────────────────
  async _searchFlights(tripParams) {

    const { data, error } =
      await supabase
        .from("flights")
        .select("*")
        .eq(
          "agency_id",
          tripParams.agencyId
        );

    if (error) {

      console.error(
        "FLIGHT ERROR:",
        error
      );

      return [];
    }

    console.log(
      "SUPABASE FLIGHTS:",
      data
    );

    const matchedFlights =
      (data || []).filter(flight =>

        this._matchesDestination(
          flight,
          tripParams.destination
        )
      );

    console.log(
      "MATCHED FLIGHTS:",
      matchedFlights
    );

    return matchedFlights.map(
      flight => ({

        airline:

          flight.airline ||

          flight.provider ||

          "Flight",

        flightNumber:

          flight.flight_number ||

          "AUTO",

        departureTime:

          flight.departure_time ||

          "08:00",

        arrivalTime:

          flight.arrival_time ||

          "12:00",

        origin:

          flight.origin ||

          "",

        destination:

          flight.destination ||

          "",

        price:

          Number(

            flight.price ||

            flight.amount ||

            0
          )
      })
    );
  }

  // ─────────────────────────────
  // HOTELS
  // ─────────────────────────────
  async _searchHotels(tripParams) {

    const { data, error } =
      await supabase
        .from("hotels")
        .select("*")
        .eq(
          "agency_id",
          tripParams.agencyId
        );

    if (error) {

      console.error(
        "HOTEL ERROR:",
        error
      );

      return [];
    }

    console.log(
      "SUPABASE HOTELS:",
      data
    );

    const matchedHotels =
      (data || []).filter(hotel =>

        this._matchesDestination(
          hotel,
          tripParams.destination
        )
      );

    console.log(
      "MATCHED HOTELS:",
      matchedHotels
    );

    return matchedHotels.map(
      hotel => ({

        name:

          hotel.name ||

          hotel.hotel_name ||

          "Hotel",

        stars:

          Number(
            hotel.stars || 4
          ),

        rating:

          Number(
            hotel.rating || 4.5
          ),

        category:

          hotel.category || "",

        location:

          hotel.location ||

          hotel.city ||

          "",

        pricePerNight:

          Number(

            hotel.price_per_night ||

            hotel.price ||

            hotel.rate ||

            0
          )
      })
    );
  }

  // ─────────────────────────────
  // TRANSFERS
  // ─────────────────────────────
  async _searchTransfers(tripParams) {

    const { data, error } =
      await supabase
        .from("transfers")
        .select("*")
        .eq(
          "agency_id",
          tripParams.agencyId
        );

    if (error) {

      console.error(
        "TRANSFER ERROR:",
        error
      );

      return [];
    }

    console.log(
      "SUPABASE TRANSFERS:",
      data
    );

    const matchedTransfers =
      (data || []).filter(t =>

        this._matchesDestination(
          t,
          tripParams.destination
        )
      );

    console.log(
      "MATCHED TRANSFERS:",
      matchedTransfers
    );

    return matchedTransfers.map(
      t => ({

        provider:

          t.provider ||

          t.name ||

          "Transfer",

        vehicleType:

          t.vehicle_type ||

          "Transfer",

        location:

          t.location ||

          "",

        price:

          Number(

            t.price ||

            t.amount ||

            0
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

    if (

      !flights.length &&
      !hotels.length &&
      !transfers.length

    ) {

      console.log(
        "NO INVENTORY FOUND"
      );

      return [];
    }

    const packages = [];

    const maxLength = Math.max(

      flights.length || 1,

      hotels.length || 1,

      transfers.length || 1
    );

    for (
      let i = 0;
      i < maxLength;
      i++
    ) {

      const flight =

        flights[
          i % (flights.length || 1)
        ] || {};

      const hotel =

        hotels[
          i % (hotels.length || 1)
        ] || {};

      const transfer =

        transfers[
          i % (transfers.length || 1)
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