const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");
const { logger } = require("../utils/logger");
const { parsePrompt } = require("./promptParser");
const { rankPackages } = require("./packageRanker");

// ─────────────────────────────────────────────────────────────
// CONVERSATIONAL MEMORY STORE
// ─────────────────────────────────────────────────────────────
const sessionMemory = new Map();

class OrchestrationEngine {

  async orchestrate(prompt, agencyId, existingSessionId = null) {
    
    // 1. Guard Check: Ensure an Agency ID is strictly provided by the incoming router
    if (!agencyId) {
      logger.error("Orchestration blocked: Missing agencyId context");
      throw new Error("Tenant isolation breach: agencyId is required");
    }

    // 2. Retrieve or Create Session
    const sessionId = existingSessionId || uuidv4();
    let session = sessionMemory.get(sessionId) || {
      history: [],
      tripParams: { agencyId }, // Session memory is pinned to this specific agency tenant
      isConversationActive: false
    };

    logger.info(`[${sessionId}] Started Orchestration for Tenant: ${agencyId}`, {
      agencyId,
      prompt,
      isContinuing: !!existingSessionId
    });

    try {
      // 3. Parse the incoming conversational prompt
      const newParams = await parsePrompt(prompt);

      // 4. Contextual Merge (Keeps parameters isolated within this specific agency context)
      const mergedParams = {
        ...session.tripParams,
        ...newParams,
        agencyId // Enforce that agencyId can never be overwritten by a malicious prompt payload
      };

      console.log(`[${agencyId}] PREVIOUS STATE:`, session.tripParams);
      console.log(`[${agencyId}] EXTRACTED PARAMS:`, newParams);
      console.log(`[${agencyId}] ACTIVE ROUTE CONTEXT:`, mergedParams.agencyId);

      // 5. Validate context attributes
      this._validateTripParams(mergedParams);

      // 6. Fetch Inventory from tables (Now 100% dynamic based on the active agency parameter)
      const [transports, hotels, transfers] = await Promise.all([
        this._searchTransport(mergedParams),
        this._searchHotels(mergedParams),
        this._searchTransfers(mergedParams)
      ]);

      console.log(`[${agencyId}] INVENTORY COUNTS -> Transports: ${transports.length}, Hotels: ${hotels.length}, Transfers: ${transfers.length}`);

      // 7. Combinatoric Package Assembly
      const packages = this._buildPackages({
        transports,
        hotels,
        transfers,
        tripParams: mergedParams
      });

      const rankedPackages = rankPackages(packages, mergedParams).slice(0, 4);

      // 8. Generate Conversational Response
      let replyText = "";
      if (rankedPackages.length > 0) {
        if (session.isConversationActive) {
          replyText = "I've updated the trip options based on your new preferences. Take a look at these choices:";
        } else {
          replyText = `I found some great travel options for your trip to ${mergedParams.destination}. Here are the packages I put together:`;
        }
      } else {
        replyText = "I couldn't find matching packages with those exact details right now. Should we try adjusting your dates or budget slightly?";
      }

      // 9. Save State back to Memory
      session.tripParams = mergedParams;
      session.history.push({ role: "user", content: prompt });
      session.history.push({ role: "assistant", content: replyText });
      session.isConversationActive = true;
      sessionMemory.set(sessionId, session);

      return {
        sessionId,
        text: replyText, 
        packages: rankedPackages,
        tripParams: mergedParams,
        generatedAt: new Date().toISOString()
      };

    } catch (error) {
      logger.error(`Engine failure on tenant [${agencyId}]`, { error: error.message });

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

  _normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim();
  }

  _matchesDestination(item, destination) {
    if (!destination) return true;

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
      ${item.provider || item.operator || ""}
      ${item.notes || ""}
    `);

    if (combined.includes(search)) return true;

    const words = search.split(" ");
    return words.some(word => word.length > 2 && combined.includes(word));
  }

  async _searchTransport(tripParams) {
    const transportType = this._normalize(tripParams.transportType);
    let flights = [];
    let buses = [];

    if (transportType !== "bus" && transportType !== "train") {
      try {
        const { data, error } = await supabase
          .from("flights")
          .select("*")
          .eq("agency_id", tripParams.agencyId); // Strictly filtered by dynamic tenant ID

        if (!error && data) flights = data;
      } catch (err) {
        console.error("SUPABASE FLIGHT FETCH ERROR:", err);
      }
    }

    if (transportType !== "flight") {
      try {
        const { data, error } = await supabase
          .from("buses")
          .select("*")
          .eq("agency_id", tripParams.agencyId); // Strictly filtered by dynamic tenant ID

        if (!error && data) buses = data;
      } catch (err) {
        console.error("SUPABASE BUS FETCH ERROR:", err);
      }
    }

    const matchedFlights = flights
      .filter(f => this._matchesDestination(f, tripParams.destination))
      .map(f => ({
        type: "flight",
        provider: f.airline || f.provider || "Local Airline",
        referenceNumber: f.flight_number || "AUTO",
        departureTime: f.departure_time || "08:00",
        arrivalTime: f.arrival_time || "11:00",
        origin: f.origin || "Nairobi",
        destination: f.destination || "",
        price: Number(f.price || f.amount || 0)
      }));

    const matchedBuses = buses
      .filter(b => this._matchesDestination(b, tripParams.destination))
      .map(b => ({
        type: "bus",
        provider: b.operator || b.provider || "Regional Bus",
        referenceNumber: b.bus_number || b.route_code || "BUS-REG",
        departureTime: b.departure_time || "07:00",
        arrivalTime: b.arrival_time || "15:00",
        origin: b.origin || "Nairobi",
        destination: b.destination || "",
        price: Number(b.price || b.amount || 0)
      }));

    return transportType === "bus" ? [...matchedBuses, ...matchedFlights] : [...matchedFlights, ...matchedBuses];
  }

  async _searchHotels(tripParams) {
    const { data, error } = await supabase
      .from("hotels")
      .select("*")
      .eq("agency_id", tripParams.agencyId); // Dynamic check

    if (error) {
      console.error("HOTEL ERROR:", error);
      return [];
    }

    return (data || [])
      .filter(hotel => this._matchesDestination(hotel, tripParams.destination))
      .map(hotel => ({
        name: hotel.name || hotel.hotel_name || "Accommodation",
        stars: Number(hotel.stars || 4),
        rating: Number(hotel.rating || 4.5),
        category: hotel.category || "",
        location: hotel.location || hotel.city || "",
        pricePerNight: Number(hotel.price_per_night || hotel.price || hotel.rate || 0)
      }));
  }

  async _searchTransfers(tripParams) {
    const { data, error } = await supabase
      .from("transfers")
      .select("*")
      .eq("agency_id", tripParams.agencyId); // Dynamic check

    if (error) {
      console.error("TRANSFER ERROR:", error);
      return [];
    }

    return (data || [])
      .filter(t => this._matchesDestination(t, tripParams.destination))
      .map(t => ({
        provider: t.provider || t.name || "Local Transfer",
        vehicleType: t.vehicle_type || "Standard Vehicle",
        location: t.location || "",
        price: Number(t.price || t.amount || 0)
      }));
  }

  _buildPackages({ transports, hotels, transfers, tripParams }) {
    if (!transports.length && !hotels.length && !transfers.length) {
      return [];
    }

    const packages = [];
    const maxLength = Math.max(transports.length || 1, hotels.length || 1, transfers.length || 1);

    for (let i = 0; i < maxLength; i++) {
      const transport = transports[i % (transports.length || 1)] || {};
      const hotel = hotels[i % (hotels.length || 1)] || {};
      const transfer = transfers[i % (transfers.length || 1)] || {};

      const totalPrice =
        (transport.price || 0) +
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
        transport, 
        hotel,
        transfers: transfer,
        status: "available"
      });
    }

    return packages;
  }

  _validateTripParams(params) {
    if (!params.destination) {
      throw new Error("Missing destination");
    }
  }
}

module.exports = new OrchestrationEngine();