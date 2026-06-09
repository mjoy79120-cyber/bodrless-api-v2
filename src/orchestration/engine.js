const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");
const { logger } = require("../utils/logger");
const { parsePrompt } = require("./promptParser");
const { rankPackages } = require("./packageRanker");

class OrchestrationEngine {

  // ─────────────────────────────
  // MAIN ORCHESTRATE
  // ─────────────────────────────
  async orchestrate(prompt, agencyId, context = {}) {
    const sessionId = uuidv4();
    const { conversationHistory = [], previousParams = null } = context;

    logger.info(`[${sessionId}] Started`, { agencyId, prompt });

    try {
      // Detect if this is a follow-up or a fresh search
      const intent = this._detectIntent(prompt, previousParams);

      let tripParams;

      if (intent.isFollowUp && previousParams) {
        // Adjust previous params based on what changed
        tripParams = this._adjustParams(previousParams, intent);
        tripParams.agencyId = agencyId;
        console.log("FOLLOW-UP DETECTED — adjusted params:", tripParams);
      } else {
        // Fresh search
        tripParams = await parsePrompt(prompt);
        tripParams.agencyId = agencyId;
        console.log("FRESH SEARCH — parsed params:", tripParams);
      }

      console.log("INTENT:", intent);
      console.log("PARSED TRIP PARAMS:", tripParams);

      this._validateTripParams(tripParams);

      const flights = await this._searchFlights(tripParams);
      const hotels = await this._searchHotels(tripParams);
      const transfers = await this._searchTransfers(tripParams);

      console.log("FINAL FLIGHTS:", flights);
      console.log("FINAL HOTELS:", hotels);
      console.log("FINAL TRANSFERS:", transfers);

      const packages = this._buildPackages({ flights, hotels, transfers, tripParams });

      // Update conversation history — keep last 10 exchanges
      const updatedHistory = [
        ...conversationHistory,
        { role: 'user', content: prompt },
        {
          role: 'assistant',
          content: `Found ${packages.length} packages`,
          params: tripParams,
          packageCount: packages.length
        }
      ].slice(-10);

      const rankedPackages =
  rankPackages(packages, tripParams).slice(0, 4);

const responseText =
  rankedPackages.length > 0
    ? `I found ${rankedPackages.length} travel option(s) for ${tripParams.destination}.`
    : `Sorry, I couldn't find any matching travel packages for ${tripParams.destination}.`;

return {
  sessionId,
  text: responseText,
  packages: rankedPackages,
  tripParams,
  intent,
  conversationHistory: updatedHistory,
  generatedAt: new Date().toISOString()
};

    } catch (error) {
      logger.error("Engine failure", { error: error.message });
      throw error;
    }
  }

  // ─────────────────────────────
  // DETECT INTENT
  // Is this a follow-up or adjustment?
  // ─────────────────────────────
  _detectIntent(prompt, previousParams) {
    const lower = prompt.toLowerCase();

    const isFollowUp = !!(previousParams && (
      lower.match(/cheaper|less expensive|lower|affordable|budget|bei nafuu/i) ||
      lower.match(/expensive|luxury|premium|upgrade|better|high end|bei ya juu/i) ||
      lower.match(/other options|different|alternatives|show me more|more options/i) ||
      lower.match(/instead|change|adjust|update|switch|replace/i) ||
      lower.match(/more nights|fewer nights|longer|shorter|\d+\s*nights?/i) ||
      lower.match(/window seat|aisle seat|front seat|back seat/i) ||
      lower.match(/breakfast|all inclusive|full board|half board|room only/i) ||
      lower.match(/morning|afternoon|evening|night|earlier|later/i) ||
      lower.match(/more people|fewer people|just me|solo|alone|by myself/i) ||
      lower.match(/without transfer|no transfer|with transfer/i) ||
      lower.match(/different hotel|another hotel|change hotel/i) ||
      lower.match(/different flight|another airline|change flight/i) ||
      lower.match(/mid budget|moderate/i)
    ));

    // Detect what is being adjusted
    const adjustments = {};

    // Budget adjustments
    if (lower.match(/cheaper|less expensive|lower budget|affordable|bei nafuu|budget option/)) {
      adjustments.budget = 'low';
    } else if (lower.match(/luxury|high end|premium|most expensive|bei ya juu/)) {
      adjustments.budget = 'luxury';
    } else if (lower.match(/mid budget|moderate|reasonable/)) {
      adjustments.budget = 'mid';
    } else if (lower.match(/high budget|expensive/)) {
      adjustments.budget = 'high';
    }

    // Nights adjustments
    const nightsMatch = lower.match(/(\d+)\s*nights?/);
    if (nightsMatch) adjustments.nights = parseInt(nightsMatch[1]);

    // Days to nights
    const daysMatch = lower.match(/(\d+)\s*days?/);
    if (daysMatch && !nightsMatch) adjustments.nights = parseInt(daysMatch[1]) - 1;

    // Passengers adjustments
    const passMatch = lower.match(/(\d+)\s*(people|persons|passengers|of us|travelers?)/);
    if (passMatch) adjustments.passengers = parseInt(passMatch[1]);
    if (lower.match(/just me|solo|alone|by myself/)) adjustments.passengers = 1;
    if (lower.match(/we are two|two of us|sisi wawili/)) adjustments.passengers = 2;

    // Seat preference
    if (lower.match(/window\s*seat|seat.*window/)) adjustments.seatPreference = 'window';
    if (lower.match(/aisle\s*seat|seat.*aisle/)) adjustments.seatPreference = 'aisle';
    if (lower.match(/front\s*seat|seat.*front/)) adjustments.seatPreference = 'front';
    if (lower.match(/back\s*seat|seat.*back/)) adjustments.seatPreference = 'back';
    if (lower.match(/extra\s*legroom|more\s*space/)) adjustments.seatPreference = 'extra_legroom';

    // Meal plan
    if (lower.match(/all\s*inclusive/)) adjustments.mealPlan = 'all_inclusive';
    if (lower.match(/full\s*board/)) adjustments.mealPlan = 'full_board';
    if (lower.match(/half\s*board/)) adjustments.mealPlan = 'half_board';
    if (lower.match(/breakfast\s*only|bed.*breakfast|b&b/)) adjustments.mealPlan = 'bed_and_breakfast';
    if (lower.match(/room\s*only|no\s*meals/)) adjustments.mealPlan = 'room_only';

    // Time preference
    if (lower.match(/morning|asubuhi/)) adjustments.timePreference = 'morning';
    if (lower.match(/afternoon|mchana/)) adjustments.timePreference = 'afternoon';
    if (lower.match(/evening|jioni/)) adjustments.timePreference = 'evening';
    if (lower.match(/night|usiku/)) adjustments.timePreference = 'night';

    // Show alternatives
    if (lower.match(/other options|show me more|alternatives|different options|more options/)) {
      adjustments.showAlternatives = true;
    }

    return { isFollowUp, adjustments };
  }

  // ─────────────────────────────
  // ADJUST PARAMS
  // Apply adjustments to previous params
  // ─────────────────────────────
  _adjustParams(previousParams, intent) {
    const adjusted = { ...previousParams };
    const { adjustments } = intent;

    if (adjustments.budget !== undefined) adjusted.budget = adjustments.budget;
    if (adjustments.nights !== undefined) adjusted.nights = adjustments.nights;
    if (adjustments.passengers !== undefined) adjusted.passengers = adjustments.passengers;
    if (adjustments.seatPreference !== undefined) adjusted.seatPreference = adjustments.seatPreference;
    if (adjustments.mealPlan !== undefined) adjusted.mealPlan = adjustments.mealPlan;
    if (adjustments.timePreference !== undefined) adjusted.timePreference = adjustments.timePreference;
    if (adjustments.showAlternatives) adjusted.showAlternatives = true;

    // Recalculate return date if nights changed
    if (adjustments.nights && adjusted.departureDate) {
      const date = new Date(adjusted.departureDate);
      date.setDate(date.getDate() + adjustments.nights);
      adjusted.returnDate = date.toISOString().split('T')[0];
    }

    return adjusted;
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
    if (!destination) return true;

    const search = this._normalize(destination);
    const combined = this._normalize(`
      ${item.destination || ""}
      ${item.location || ""}
      ${item.city || ""}
      ${item.country || ""}
      ${item.name || ""}
      ${item.hotel_name || ""}
      ${item.provider || ""}
      ${item.notes || ""}
    `);

    if (combined.includes(search)) return true;

    const words = search.split(" ");
    return words.some(word => word.length > 2 && combined.includes(word));
  }

  // ─────────────────────────────
  // FLIGHT DESTINATION MATCHING
  // Only match on destination field
  // ─────────────────────────────
  _matchesFlightDestination(flight, destination) {
    if (!destination) return true;

    const search = this._normalize(destination);
    const flightDest = this._normalize(flight.destination || "");

    if (flightDest.includes(search)) return true;

    const words = search.split(" ");
    return words.some(word => word.length > 2 && flightDest.includes(word));
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

    console.log("SUPABASE FLIGHTS:", data);

    const matchedFlights = (data || []).filter(flight =>
      this._matchesFlightDestination(flight, tripParams.destination)
    );

    console.log("MATCHED FLIGHTS:", matchedFlights);

    return matchedFlights.map(flight => ({
      airline: flight.airline || flight.provider || "Flight",
      flightNumber: flight.flight_number || "AUTO",
      departureTime: flight.departure_time || "08:00",
      arrivalTime: flight.arrival_time || "12:00",
      origin: flight.origin || "",
      destination: flight.destination || "",
      price: Number(flight.price || flight.amount || 0),
      seats: flight.seats || null,
      transportType: flight.transport_type || 'flight',
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

    console.log("SUPABASE HOTELS:", data);

    let matchedHotels = (data || []).filter(hotel =>
      this._matchesDestination(hotel, tripParams.destination)
    );

    // Filter by budget if specified
    if (tripParams.budget) {
      matchedHotels = this._filterHotelsByBudget(matchedHotels, tripParams.budget);
    }

    // Filter by meal plan if specified
    if (tripParams.mealPlan) {
      const withMealPlan = matchedHotels.filter(h =>
        (h.meal_plan || '').toLowerCase().includes(tripParams.mealPlan.replace('_', ' '))
      );
      if (withMealPlan.length > 0) matchedHotels = withMealPlan;
    }

    console.log("MATCHED HOTELS:", matchedHotels);

    return matchedHotels.map(hotel => ({
      name: hotel.name || hotel.hotel_name || "Hotel",
      stars: Number(hotel.stars || 4),
      rating: Number(hotel.rating || 4.5),
      category: hotel.category || "",
      location: hotel.location || hotel.city || "",
      pricePerNight: Number(hotel.price_per_night || hotel.price || hotel.rate || 0),
      mealPlan: hotel.meal_plan || null,
      reviews: hotel.reviews || [],
    }));
  }

  // ─────────────────────────────
  // FILTER HOTELS BY BUDGET
  // ─────────────────────────────
  _filterHotelsByBudget(hotels, budget) {
    const ranges = {
      low: { min: 0, max: 100 },
      mid: { min: 100, max: 300 },
      high: { min: 300, max: 600 },
      luxury: { min: 600, max: Infinity },
    };

    const range = ranges[budget];
    if (!range) return hotels;

    const filtered = hotels.filter(h => {
      const price = Number(h.price_per_night || h.price || 0);
      return price >= range.min && price <= range.max;
    });

    // If no hotels match budget filter, return all (don't leave empty)
    return filtered.length > 0 ? filtered : hotels;
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

    console.log("SUPABASE TRANSFERS:", data);

    const matchedTransfers = (data || []).filter(t =>
      this._matchesDestination(t, tripParams.destination)
    );

    console.log("MATCHED TRANSFERS:", matchedTransfers);

    return matchedTransfers.map(t => ({
      provider: t.provider || t.name || "Transfer",
      vehicleType: t.vehicle_type || "Transfer",
      location: t.location || "",
      price: Number(t.price || t.amount || 0),
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

    // If showAlternatives, start from a different index to show different combos
    const startIndex = tripParams.showAlternatives ? 1 : 0;

    for (let i = 0; i < maxLength; i++) {
      const flightIndex = (i + startIndex) % (flights.length || 1);
      const hotelIndex = (i + startIndex) % (hotels.length || 1);
      const transferIndex = i % (transfers.length || 1);

      const flight = flights[flightIndex] || {};
      const hotel = hotels[hotelIndex] || {};
      const transfer = transfers[transferIndex] || {};

      const totalPrice =
        (flight.price || 0) +
        ((hotel.pricePerNight || 0) * (tripParams.nights || 1)) +
        (transfer.price || 0);

      packages.push({
        packageId: uuidv4(),
        summary: {
          route: `${tripParams.origin} to ${tripParams.destination}`,
          passengers: tripParams.passengers,
          nights: tripParams.nights,
          totalPrice,
          pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
          mealPlan: tripParams.mealPlan || hotel.mealPlan || null,
          seatPreference: tripParams.seatPreference || null,
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