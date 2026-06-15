const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");
const { logger } = require("../utils/logger");
const { parsePrompt } = require("./promptParser");
const { rankPackages } = require("./packageRanker");

// Supplier adapter layer — all external suppliers go through here
let supplierAdapter = null;
try {
  supplierAdapter = require("../adapters");
} catch (e) {
  logger.warn("Supplier adapter not loaded — bus/live inventory unavailable");
}

class OrchestrationEngine {

  // ─────────────────────────────
  // MAIN ORCHESTRATE
  // ─────────────────────────────
  async orchestrate(prompt, agencyId, context = {}) {
    const sessionId = uuidv4();
    const { conversationHistory = [], previousParams = null } = context;

    logger.info(`[${sessionId}] Started`, { agencyId, prompt });

    try {
      const intent = this._detectIntent(prompt, previousParams);

      let tripParams;

      if (intent.isFollowUp && previousParams) {
        tripParams = this._adjustParams(previousParams, intent);
        tripParams.agencyId = agencyId;
        console.log("FOLLOW-UP DETECTED — adjusted params:", tripParams);
      } else {
        tripParams = await parsePrompt(prompt);
        tripParams.agencyId = agencyId;
        console.log("FRESH SEARCH — parsed params:", tripParams);
      }

      console.log("INTENT:", intent);
      console.log("PARSED TRIP PARAMS:", tripParams);

      this._validateTripParams(tripParams);

      // Search all sources in parallel
      const [flights, buses, hotels, transfers] = await Promise.all([
        this._searchFlights(tripParams),
        this._searchBuses(tripParams),
        this._searchHotels(tripParams),
        this._searchTransfers(tripParams),
      ]);

      // Merge flights and buses into transport options
      const allTransport = [...flights, ...buses];

      console.log("FINAL FLIGHTS:", flights);
      console.log("FINAL BUSES:", buses);
      console.log("FINAL HOTELS:", hotels);
      console.log("FINAL TRANSFERS:", transfers);

      const packages = this._buildPackages({
        transport: allTransport,
        hotels,
        transfers,
        tripParams
      });

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

      const rankedPackages = rankPackages(packages, tripParams).slice(0, 4);

      const responseText = rankedPackages.length > 0
        ? `I found ${rankedPackages.length} travel option(s) for ${tripParams.destination}.`
        : `Sorry, I couldn't find any matching travel packages for ${tripParams.destination}.`;

      // ── Log search to trip_searches ──────────────────
      this._logSearch({
        sessionId,
        agencyId,
        prompt,
        tripParams,
        packagesReturned: rankedPackages.length,
        channel: context.channel || 'widget',
      }).catch(err => logger.error('Failed to log search', { error: err.message }));

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
  // LOG SEARCH TO SUPABASE
  // Fires async — never blocks the response
  // ─────────────────────────────
  async _logSearch({ sessionId, agencyId, prompt, tripParams, packagesReturned, channel }) {
    try {
      await supabase.from('trip_searches').insert({
        id:                uuidv4(),
        agency_id:         agencyId,
        session_id:        sessionId,
        prompt:            prompt,
        destination:       tripParams.destination || null,
        origin:            tripParams.origin      || null,
        passengers:        tripParams.passengers  || 1,
        budget:            tripParams.budget       || null,
        nights:            tripParams.nights       || null,
        packages_returned: packagesReturned,
        channel:           channel,
        converted:         false,
        created_at:        new Date().toISOString(),
      });
    } catch (err) {
      logger.error('trip_searches insert failed', { error: err.message });
    }
  }

  // ─────────────────────────────
  // SAVE BOOKING TO SUPABASE
  // Call this from your booking handler/route
  // after supplier confirms the reservation
  // ─────────────────────────────
  async saveBooking({
    agencyId,
    guestName,
    guestPhone,
    guestEmail,
    tripParams,
    selectedPackage,
    supplierBookingReference,
    supplierName,
    channel = 'widget',
    passengers = [],
  }) {
    const bookingRef = `BDL-${Date.now()}`;

    try {
      // 1. Insert master booking record
      const { data: booking, error: bookingError } = await supabase
        .from('bookings')
        .insert({
          id:                           uuidv4(),
          booking_ref:                  bookingRef,
          agency_id:                    agencyId,
          guest_name:                   guestName,
          guest_phone:                  guestPhone,
          guest_email:                  guestEmail,
          destination:                  tripParams.destination,
          origin:                       tripParams.origin,
          nights:                       tripParams.nights       || null,
          passengers:                   tripParams.passengers   || 1,
          total_price:                  selectedPackage.summary?.totalPrice || 0,
          currency:                     selectedPackage.transport?.currency || 'KES',
          status:                       'confirmed',
          booking_status:               'confirmed',
          payment_status:               'pending',
          supplier_status:              'confirmed',
          supplier_booking_reference:   supplierBookingReference,
          channel:                      channel,
          flight_details:               selectedPackage.transport  || null,
          hotel_details:                selectedPackage.hotel      || null,
          transfer_details:             selectedPackage.transfers  || null,
          trip_params:                  tripParams,
          created_at:                   new Date().toISOString(),
        })
        .select()
        .single();

      if (bookingError) {
        logger.error('Booking insert failed', { error: bookingError.message });
        throw bookingError;
      }

      // 2. Insert passenger manifest records (one per passenger)
      if (passengers.length > 0) {
        const manifestRows = passengers.map(p => ({
          id:                    uuidv4(),
          booking_id:            booking.id,
          booking_ref:           bookingRef,
          agency_id:             agencyId,
          first_name:            p.firstName    || p.first_name,
          last_name:             p.lastName     || p.last_name,
          date_of_birth:         p.dateOfBirth  || p.date_of_birth  || null,
          nationality:           p.nationality  || null,
          passport_number:       p.passportNumber || p.passport_number || null,
          passport_expiry:       p.passportExpiry || p.passport_expiry || null,
          national_id_number:    p.nationalId   || p.national_id_number || null,
          gender:                p.gender       || null,
          passenger_type:        p.type         || 'adult',
          phone:                 p.phone        || guestPhone,
          email:                 p.email        || guestEmail,
          seat_number:           p.seatNumber   || p.seat_number || null,
          special_requests:      p.specialRequests || null,
          supplier:              supplierName   || 'iabiri',
          created_at:            new Date().toISOString(),
        }));

        const { error: manifestError } = await supabase
          .from('passenger_manifest')
          .insert(manifestRows);

        if (manifestError) {
          logger.error('Passenger manifest insert failed', { error: manifestError.message });
          // Don't throw — booking is confirmed, manifest is secondary
        }
      }

      // 3. Mark search as converted if session is available
      if (tripParams.sessionId) {
        await supabase
          .from('trip_searches')
          .update({ converted: true })
          .eq('session_id', tripParams.sessionId);
      }

      logger.info('Booking saved', { bookingRef, agencyId });

      return { bookingRef, bookingId: booking.id };

    } catch (err) {
      logger.error('saveBooking failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────
  // DETECT INTENT
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
      lower.match(/mid budget|moderate/i) ||
      lower.match(/bus|train|flight|fly|drive/i)
    ));

    const adjustments = {};

    // Budget
    if (lower.match(/cheaper|less expensive|lower budget|affordable|bei nafuu|budget option/)) {
      adjustments.budget = 'low';
    } else if (lower.match(/luxury|high end|premium|most expensive|bei ya juu/)) {
      adjustments.budget = 'luxury';
    } else if (lower.match(/mid budget|moderate|reasonable/)) {
      adjustments.budget = 'mid';
    } else if (lower.match(/high budget|expensive/)) {
      adjustments.budget = 'high';
    }

    // Nights
    const nightsMatch = lower.match(/(\d+)\s*nights?/);
    if (nightsMatch) adjustments.nights = parseInt(nightsMatch[1]);
    const daysMatch = lower.match(/(\d+)\s*days?/);
    if (daysMatch && !nightsMatch) adjustments.nights = parseInt(daysMatch[1]) - 1;

    // Passengers
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

    // Transport mode switch
    if (lower.match(/\bbus\b|by bus|take bus/)) adjustments.transportMode = 'bus';
    if (lower.match(/\bflight\b|\bfly\b|by plane/)) adjustments.transportMode = 'flight';
    if (lower.match(/\btrain\b|by train|sgr/)) adjustments.transportMode = 'train';

    // Alternatives
    if (lower.match(/other options|show me more|alternatives|different options|more options/)) {
      adjustments.showAlternatives = true;
    }

    return { isFollowUp, adjustments };
  }

  // ─────────────────────────────
  // ADJUST PARAMS
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
    if (adjustments.transportMode !== undefined) adjusted.transportMode = adjustments.transportMode;
    if (adjustments.showAlternatives) adjusted.showAlternatives = true;

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
      ${item.route || ""}
      ${item.notes || ""}
    `);

    if (combined.includes(search)) return true;
    const words = search.split(" ");
    return words.some(word => word.length > 2 && combined.includes(word));
  }

  // ─────────────────────────────
  // FLIGHT DESTINATION MATCHING
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
  // FLIGHTS — from Supabase
  // ─────────────────────────────
  async _searchFlights(tripParams) {
    if (tripParams.transportMode === 'bus' || tripParams.transportMode === 'train') {
      return [];
    }

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
      supplier: 'supabase',
      transportType: flight.transport_type || 'flight',
      airline: flight.airline || flight.provider || "Flight",
      flightNumber: flight.flight_number || "AUTO",
      departureTime: flight.departure_time || "08:00",
      arrivalTime: flight.arrival_time || "12:00",
      origin: flight.origin || "",
      destination: flight.destination || "",
      price: Number(flight.price || flight.amount || 0),
      seats: flight.seats || null,
    }));
  }

  // ─────────────────────────────
  // BUSES — from IABIRI via adapter
  // ─────────────────────────────
  async _searchBuses(tripParams) {
    if (tripParams.transportMode === 'flight' || tripParams.transportMode === 'train') {
      return [];
    }

    const busRoutes = [
      ['nairobi', 'mombasa'],
      ['nairobi', 'kampala'],
      ['nairobi', 'dar es salaam'],
      ['nairobi', 'kigali'],
      ['mombasa', 'dar es salaam'],
      ['nairobi', 'arusha'],
      ['nairobi', 'kisumu'],
      ['nairobi', 'nakuru'],
      ['nairobi', 'eldoret'],
      ['nairobi', 'thika'],
      ['mombasa', 'nairobi'],
      ['kisumu', 'nairobi'],
      ['nakuru', 'nairobi'],
    ];

    const origin = (tripParams.origin || '').toLowerCase();
    const destination = (tripParams.destination || '').toLowerCase();

    const isBusRoute = busRoutes.some(([a, b]) =>
      (origin.includes(a) && destination.includes(b)) ||
      (origin.includes(b) && destination.includes(a))
    );

    if (!isBusRoute && tripParams.transportMode !== 'bus') {
      return [];
    }

    if (!supplierAdapter) {
      logger.warn('Supplier adapter not available — skipping bus search');
      return [];
    }

    try {
      const buses = await supplierAdapter.searchTransport({
        origin: tripParams.origin,
        destination: tripParams.destination,
        date: tripParams.departureDate,
        passengers: tripParams.passengers,
        transportMode: 'bus',
        timePreference: tripParams.timePreference,
      });

      console.log("IABIRI BUSES:", buses);

      return buses.map(bus => ({
        supplier:          bus.supplier || 'iabiri',
        transportType:     'bus',
        tripId:            bus.tripId,
        busId:             bus.busId,
        routeId:           bus.routeId,
        token:             bus.token,
        sourceCityId:      bus.sourceCityId,
        destCityId:        bus.destCityId,
        airline:           bus.provider,
        provider:          bus.provider,
        busType:           bus.busType,
        flightNumber:      null,
        departureTime:     bus.departureTime,
        arrivalTime:       bus.arrivalTime,
        duration:          bus.duration,
        origin:            bus.origin,
        destination:       bus.destination,
        price:             bus.price,
        currency:          bus.currency || 'KES',
        availableSeats:    bus.availableSeats,
        totalSeats:        bus.totalSeats,
        amenities:         bus.amenities || [],
        cancellationPolicy: bus.cancellationPolicy || 'Non-refundable',
        isDelayed:         bus.isDelayed || false,
      }));

    } catch (err) {
      logger.error('Bus search failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────
  // HOTELS — from Supabase
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

    if (tripParams.budget) {
      matchedHotels = this._filterHotelsByBudget(matchedHotels, tripParams.budget);
    }

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
      low:    { min: 0,   max: 100 },
      mid:    { min: 100, max: 300 },
      high:   { min: 300, max: 600 },
      luxury: { min: 600, max: Infinity },
    };

    const range = ranges[budget];
    if (!range) return hotels;

    const filtered = hotels.filter(h => {
      const price = Number(h.price_per_night || h.price || 0);
      return price >= range.min && price <= range.max;
    });

    return filtered.length > 0 ? filtered : hotels;
  }

  // ─────────────────────────────
  // TRANSFERS — from Supabase
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
  _buildPackages({ transport, hotels, transfers, tripParams }) {
    if (!transport.length && !hotels.length && !transfers.length) {
      console.log("NO INVENTORY FOUND");
      return [];
    }

    const packages = [];

    const maxLength = Math.max(
      transport.length || 1,
      hotels.length || 1,
      transfers.length || 1
    );

    const startIndex = tripParams.showAlternatives ? 1 : 0;

    for (let i = 0; i < maxLength; i++) {
      const transportIndex = (i + startIndex) % (transport.length || 1);
      const hotelIndex     = (i + startIndex) % (hotels.length    || 1);
      const transferIndex  = i % (transfers.length || 1);

      const t        = transport[transportIndex] || {};
      const hotel    = hotels[hotelIndex]        || {};
      const transfer = transfers[transferIndex]  || {};

      const totalPrice =
        (t.price || 0) +
        ((hotel.pricePerNight || 0) * (tripParams.nights || 1)) +
        (transfer.price || 0);

      const transportDisplay = {
        transportType:  t.transportType || 'flight',
        airline:        t.airline || t.provider || "Transport",
        flightNumber:   t.flightNumber || null,
        departureTime:  t.departureTime || "08:00",
        arrivalTime:    t.arrivalTime   || "12:00",
        origin:         t.origin        || tripParams.origin,
        destination:    t.destination   || tripParams.destination,
        price:          t.price         || 0,
        supplier:       t.supplier      || 'supabase',

        ...(t.transportType === 'bus' && {
          provider:           t.provider,
          busType:            t.busType,
          busId:              t.busId,
          tripId:             t.tripId,
          routeId:            t.routeId,
          token:              t.token,
          sourceCityId:       t.sourceCityId,
          destCityId:         t.destCityId,
          availableSeats:     t.availableSeats,
          totalSeats:         t.totalSeats,
          amenities:          t.amenities || [],
          cancellationPolicy: t.cancellationPolicy,
          currency:           t.currency || 'KES',
          isDelayed:          t.isDelayed || false,
        }),

        ...(t.transportType === 'flight' && {
          seats: t.seats || null,
        }),
      };

      packages.push({
        packageId: uuidv4(),
        summary: {
          route:         `${tripParams.origin} to ${tripParams.destination}`,
          passengers:    tripParams.passengers,
          nights:        tripParams.nights,
          totalPrice,
          pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
          mealPlan:       tripParams.mealPlan || hotel.mealPlan || null,
          seatPreference: tripParams.seatPreference || null,
          transportType:  t.transportType || 'flight',
        },
        transport:  transportDisplay,
        hotel,
        transfers:  transfer,
        status:     "available"
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