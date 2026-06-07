const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");
const { logger } = require("../utils/logger");
const { parsePrompt } = require("./promptParser");
const { rankPackages } = require("./packageRanker");

// ─────────────────────────────────────────────────────────────
// CONVERSATIONAL MEMORY STORE
// Stores active conversations so the engine remembers previous 
// parameters (destinations, budgets, dates) between messages.
// ─────────────────────────────────────────────────────────────
const sessionMemory = new Map();

class OrchestrationEngine {

  // UPDATED: Added existingSessionId to resume ongoing conversations
  async orchestrate(prompt, agencyId, existingSessionId = null) {
    
    // 1. Retrieve or Create Session
    const sessionId = existingSessionId || uuidv4();
    let session = sessionMemory.get(sessionId) || {
      history: [],
      tripParams: { agencyId },
      isConversationActive: false
    };

    logger.info(`[${sessionId}] Started Orchestration`, {
      agencyId,
      prompt,
      isContinuing: !!existingSessionId
    });

    try {
      // 2. Parse the new prompt (e.g., extracts new budget or destination)
      const newParams = await parsePrompt(prompt);

      // 3. Contextual Merge (The Magic Sauce)
      // This merges new requests ON TOP of previous ones. 
      // If they already said "Mombasa" and now say "cheaper", it remembers Mombasa.
      const mergedParams = {
        ...session.tripParams,
        ...newParams,
        agencyId // Ensure agencyId is never overwritten
      };

      console.log("PREVIOUS PARAMS:", session.tripParams);
      console.log("NEW EXTRACTED PARAMS:", newParams);
      console.log("MERGED TRIP PARAMS:", mergedParams);

      // 4. Validate context
      this._validateTripParams(mergedParams);

      // 5. Fetch Inventory using the merged state
      const flights = await this._searchFlights(mergedParams);
      const hotels = await this._searchHotels(mergedParams);
      const transfers = await this._searchTransfers(mergedParams);

      console.log("FINAL FLIGHTS:", flights.length);
      console.log("FINAL HOTELS:", hotels.length);
      console.log("FINAL TRANSFERS:", transfers.length);

      // 6. Build & Rank Packages
      const packages = this._buildPackages({
        flights,
        hotels,
        transfers,
        tripParams: mergedParams
      });

      const rankedPackages = rankPackages(packages, mergedParams).slice(0, 4);

      // 7. Generate Conversational Response
      let replyText = "";
      if (rankedPackages.length > 0) {
        if (session.isConversationActive) {
          replyText = "I've updated the trip based on your new preferences. Here are the adjusted options:";
        } else {
          replyText = `I found some great options for your trip to ${mergedParams.destination}. Take a look at these packages:`;
        }
      } else {
        replyText = "I couldn't find packages matching those exact details. Should we try adjusting the budget or dates?";
      }

      // 8. Save State back to Memory
      session.tripParams = mergedParams;
      session.history.push({ role: "user", content: prompt });
      session.history.push({ role: "assistant", content: replyText });
      session.isConversationActive = true;
      sessionMemory.set(sessionId, session);

      return {
        sessionId,
        text: replyText, // Return conversational text to your WhatsApp/Frontend
        packages: rankedPackages,
        tripParams: mergedParams,
        generatedAt: new Date().toISOString()
      };

    } catch (error) {
      logger.error("Engine failure", { error: error.message });

      // Handle missing destination smoothly instead of crashing
      if (error.message === "Missing destination") {
        return {
          sessionId,
          text: "I'd love to help you plan! Where would you like to travel to?",
          packages: [],
          tripParams: session.tripParams,
          generatedAt: new Date().toISOString()
        };
      }

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
  _matchesDestination(item, destination) {
    if (!destination) {
      return true;
    }

    const search = this._normalize(destination);
    const combined = this._normalize(`
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

    if (combined.includes(search)) {
      return true;
    }

    const words = search.split(" ");
    return words.some(word => word.length > 2 && combined.includes(word));
  }

  // ─────────────────────────────
  // FLIGHTS
  // ─────────────────────────────
  async _searchFlights(tripParams) {
    const { data, error } = await supabase
      .from("flights")
      .select("*")
      .eq("agency_id", tripParams.agencyId);

    if (error) {
      console.error("FLIGHT ERROR:", error);
      return [];
    }

    const matchedFlights = (data || []).filter(flight =>
      this._matchesDestination(flight, tripParams.destination)
    );

    return matchedFlights.map(flight => ({
      airline: flight.airline || flight.provider || "Flight",
      flightNumber: flight.flight_number || "AUTO",
      departureTime: flight.departure_time || "08:00",
      arrivalTime: flight.arrival_time || "12:00",
      origin: flight.origin || "",
      destination: flight.destination || "",
      price: Number(flight.price || flight.amount || 0)
    }));
  }

  // ─────────────────────────────
  // HOTELS
  // ─────────────────────────────
  async _searchHotels(tripParams) {
    const { data, error } = await supabase
      .from("hotels")
      .select("*")
      .eq("agency_id", tripParams.agencyId);

    if (error) {
      console.error("HOTEL ERROR:", error);
      return [];
    }

    const matchedHotels = (data || []).filter(hotel =>
      this._matchesDestination(hotel, tripParams.destination)
    );

    return matchedHotels.map(hotel => ({
      name: hotel.name || hotel.hotel_name || "Hotel",
      stars: Number(hotel.stars || 4),
      rating: Number(hotel.rating || 4.5),
      category: hotel.category || "",
      location: hotel.location || hotel.city || "",
      pricePerNight: Number(hotel.price_per_night || hotel.price || hotel.rate || 0)
    }));
  }

  // ─────────────────────────────
  // TRANSFERS
  // ─────────────────────────────
  async _searchTransfers(tripParams) {
    const { data, error } = await supabase
      .from("transfers")
      .select("*")
      .eq("agency_id", tripParams.agencyId);

    if (error) {
      console.error("TRANSFER ERROR:", error);
      return [];
    }

    const matchedTransfers = (data || []).filter(t =>
      this._matchesDestination(t, tripParams.destination)
    );

    return matchedTransfers.map(t => ({
      provider: t.provider || t.name || "Transfer",
      vehicleType: t.vehicle_type || "Transfer",
      location: t.location || "",
      price: Number(t.price || t.amount || 0)
    }));
  }

  // ─────────────────────────────
  // BUILD PACKAGES
  // ─────────────────────────────
  _buildPackages({ flights, hotels, transfers, tripParams }) {
    if (!flights.length && !hotels.length && !transfers.length) {
      console.log("NO INVENTORY FOUND");
      return [];
    }

    const packages = [];
    const maxLength = Math.max(
      flights.length || 1,
      hotels.length || 1,
      transfers.length || 1
    );

    for (let i = 0; i < maxLength; i++) {
      const flight = flights[i % (flights.length || 1)] || {};
      const hotel = hotels[i % (hotels.length || 1)] || {};
      const transfer = transfers[i % (transfers.length || 1)] || {};

      const totalPrice =
        (flight.price || 0) +
        ((hotel.pricePerNight || 0) * (tripParams.nights || 1)) +
        (transfer.price || 0);

      packages.push({
        packageId: uuidv4(),
        summary: {
          route: `${tripParams.origin || 'Origin'} → ${tripParams.destination}`,
          passengers: tripParams.passengers || 1,
          nights: tripParams.nights || 1,
          totalPrice,
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