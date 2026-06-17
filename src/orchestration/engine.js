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
  console.log("ADAPTER LOAD ERROR:", e.message);
  console.log("ADAPTER LOAD STACK:", e.stack);
  logger.warn("Supplier adapter not loaded — bus/live inventory unavailable", { error: e.message });
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

      const [
        outboundFlights, outboundBuses,
        returnFlights, returnBuses,
        hotels, transfers
      ] = await Promise.all([
        this._searchFlights(tripParams, 'outbound'),
        this._searchBuses(tripParams, 'outbound'),
        tripParams.returnDate ? this._searchFlights(tripParams, 'return') : Promise.resolve([]),
        tripParams.returnDate ? this._searchBuses(tripParams, 'return') : Promise.resolve([]),
        this._searchHotels(tripParams),
        this._searchTransfers(tripParams),
      ]);

      const outboundTransport = [...outboundFlights, ...outboundBuses];
      const returnTransport   = [...returnFlights,   ...returnBuses];

      console.log("FINAL OUTBOUND TRANSPORT:", outboundTransport.length);
      console.log("FINAL RETURN TRANSPORT:",   returnTransport.length);
      console.log("FINAL HOTELS:",             hotels.length);
      console.log("FINAL TRANSFERS:",          transfers.length);

      const packages = this._buildPackages({
        outboundTransport,
        returnTransport,
        hotels,
        transfers,
        tripParams,
        intent,
      });

      const updatedHistory = [
        ...conversationHistory,
        { role: 'user', content: prompt },
        {
          role: 'assistant',
          content: `Found ${packages.length} packages`,
          params: tripParams,
          packageCount: packages.length,
        },
      ].slice(-10);

      const rankedPackages = rankPackages(packages, tripParams).slice(0, 4);

      const responseText = rankedPackages.length > 0
        ? `I found ${rankedPackages.length} travel option(s) for ${tripParams.destination}.`
        : `Sorry, I couldn't find any matching travel packages for ${tripParams.destination}.`;

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
        generatedAt: new Date().toISOString(),
      };

    } catch (error) {
      logger.error("Engine failure", { error: error.message });
      throw error;
    }
  }

  // ─────────────────────────────
  // LOG SEARCH TO SUPABASE
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
        budget:            tripParams.budget      || null,
        nights:            tripParams.nights      || null,
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
      const { data: booking, error: bookingError } = await supabase
        .from('bookings')
        .insert({
          id:                         uuidv4(),
          booking_ref:                bookingRef,
          agency_id:                  agencyId,
          guest_name:                 guestName,
          guest_phone:                guestPhone,
          guest_email:                guestEmail,
          destination:                tripParams.destination,
          origin:                     tripParams.origin,
          nights:                     tripParams.nights     || null,
          passengers:                 tripParams.passengers || 1,
          total_price:                selectedPackage.summary?.totalPrice || 0,
          currency:                   selectedPackage.transport?.currency || 'KES',
          status:                     'confirmed',
          booking_status:             'confirmed',
          payment_status:             'pending',
          supplier_status:            'confirmed',
          supplier_booking_reference: supplierBookingReference,
          channel:                    channel,
          flight_details:             selectedPackage.transport  || null,
          hotel_details:              selectedPackage.hotel      || null,
          transfer_details:           selectedPackage.transfers  || null,
          trip_params:                tripParams,
          created_at:                 new Date().toISOString(),
        })
        .select()
        .single();

      if (bookingError) {
        logger.error('Booking insert failed', { error: bookingError.message });
        throw bookingError;
      }

      if (passengers.length > 0) {
        const manifestRows = passengers.map(p => ({
          id:                 uuidv4(),
          booking_id:         booking.id,
          booking_ref:        bookingRef,
          agency_id:          agencyId,
          first_name:         p.firstName       || p.first_name,
          last_name:          p.lastName        || p.last_name,
          date_of_birth:      p.dateOfBirth     || p.date_of_birth   || null,
          nationality:        p.nationality     || null,
          passport_number:    p.passportNumber  || p.passport_number || null,
          passport_expiry:    p.passportExpiry  || p.passport_expiry || null,
          national_id_number: p.nationalId      || p.national_id_number || null,
          gender:             p.gender          || null,
          passenger_type:     p.type            || 'adult',
          phone:              p.phone           || guestPhone,
          email:              p.email           || guestEmail,
          seat_number:        p.seatNumber      || p.seat_number || null,
          special_requests:   p.specialRequests || null,
          supplier:           supplierName      || 'travelduqa',
          created_at:         new Date().toISOString(),
        }));

        const { error: manifestError } = await supabase
          .from('passenger_manifest')
          .insert(manifestRows);

        if (manifestError) {
          logger.error('Passenger manifest insert failed', { error: manifestError.message });
        }
      }

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
    const productScope = {
      needsTransport:  true,
      needsHotel:      true,
      needsTransfers:  true,
    };

    // Only narrow scope to a single product when the prompt signals EXCLUSIVITY
    // (e.g. "only flights", "just a flight", "flight only") — a bare mention of
    // "flight" in a general trip request ("flight to Mombasa") should still
    // return the full package (flight + hotel + transfer), since that's the
    // default expectation when someone names a route without qualifying it.
    const flightExclusive = lower.match(
      /\bonly\s+(a\s+)?flight(s)?\b|flight(s)?\s+only|just\s+(a\s+)?flight(s)?\b|\bonly\s+want\s+a\s+flight\b|\bjust\s+want\s+a\s+flight\b|search\s+flights?\s+only/i
    );
    const busExclusive = lower.match(
      /\bonly\s+(a\s+)?bus(es)?\b|bus(es)?\s+only|just\s+(a\s+)?bus(es)?\b/i
    );
    const hotelExclusive = lower.match(
      /\bonly\s+(a\s+)?hotel\b|hotel\s+only|just\s+(a\s+)?hotel\b|stay\s+only|accommodation\s+only/i
    );

    if (flightExclusive) {
      productScope.needsHotel      = false;
      productScope.needsTransfers  = false;
      adjustments.transportMode    = 'flight';
    } else if (busExclusive) {
      productScope.needsHotel      = false;
      productScope.needsTransfers  = false;
      adjustments.transportMode    = 'bus';
    } else if (hotelExclusive) {
      productScope.needsTransport  = false;
      productScope.needsTransfers  = false;
    } else {
      // No exclusivity language — still capture transport mode preference
      // (e.g. "fly to Mombasa" vs "bus to Mombasa") without narrowing scope
      if (lower.match(/\bflight(s)?\b|\bfly\b|\bflying\b/i)) {
        adjustments.transportMode = 'flight';
      } else if (lower.match(/\bbus(es)?\b/i)) {
        adjustments.transportMode = 'bus';
      }
    }

    if (lower.match(/cheaper|less expensive|lower budget|affordable|bei nafuu|budget option/)) {
      adjustments.budget = 'low';
    } else if (lower.match(/luxury|high end|premium|most expensive|bei ya juu/)) {
      adjustments.budget = 'luxury';
    } else if (lower.match(/mid budget|moderate|reasonable/)) {
      adjustments.budget = 'mid';
    }

    const nightsMatch = lower.match(/(\d+)\s*nights?/);
    if (nightsMatch) adjustments.nights = parseInt(nightsMatch[1]);

    const passMatch = lower.match(/(\d+)\s*(people|persons|passengers|of us|travelers?)/);
    if (passMatch) adjustments.passengers = parseInt(passMatch[1]);

    return { isFollowUp, adjustments, productScope };
  }

  _adjustParams(previousParams, intent) {
    const adjusted = { ...previousParams };
    const { adjustments } = intent;

    if (adjustments.budget        !== undefined) adjusted.budget        = adjustments.budget;
    if (adjustments.nights        !== undefined) adjusted.nights        = adjustments.nights;
    if (adjustments.passengers    !== undefined) adjusted.passengers    = adjustments.passengers;
    if (adjustments.transportMode !== undefined) adjusted.transportMode = adjustments.transportMode;

    return adjusted;
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
      ${item.location    || ""}
      ${item.city        || ""}
      ${item.country     || ""}
      ${item.name        || ""}
      ${item.hotel_name  || ""}
      ${item.provider    || ""}
      ${item.route       || ""}
      ${item.notes       || ""}
    `);
    if (combined.includes(search)) return true;
    const words = search.split(" ");
    return words.some(word => word.length > 2 && combined.includes(word));
  }

  _matchesFlightDestination(flight, destination) {
    if (!destination) return true;
    const search   = this._normalize(destination);
    const flightDest = this._normalize(flight.destination || "");
    if (flightDest.includes(search)) return true;
    const words = search.split(" ");
    return words.some(word => word.length > 2 && flightDest.includes(word));
  }

  // ─────────────────────────────
  // FLIGHTS
  // ─────────────────────────────
  async _searchFlights(tripParams, leg = 'outbound') {
    const mode = leg === 'return'
      ? (tripParams.returnTransportMode || tripParams.outboundTransportMode || tripParams.transportMode || 'flight')
      : (tripParams.outboundTransportMode || tripParams.transportMode || 'flight');

    if (mode === 'bus' || mode === 'train') return [];

    const searchOrigin      = leg === 'return' ? tripParams.destination : tripParams.origin;
    const searchDestination = leg === 'return' ? tripParams.origin      : tripParams.destination;

    let searchDate = leg === 'return' ? tripParams.returnDate : tripParams.departureDate;
    if (!searchDate) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      searchDate = tomorrow.toISOString().split('T')[0];
      console.log(`[FLIGHT FALLBACK] No date for ${leg} — using ${searchDate}`);
    }

    const results = [];

    const { data, error } = await supabase
      .from("flights")
      .select("*")
      .eq("agency_id", tripParams.agencyId);

    if (!error) {
      const matchedFlights = (data || []).filter(flight =>
        this._matchesFlightDestination(flight, searchDestination)
      );
      console.log(`SUPABASE FLIGHTS (${leg}):`, matchedFlights.length);
      results.push(...matchedFlights.map(flight => ({
        supplier:      'supabase',
        transportType: flight.transport_type || 'flight',
        airline:       flight.airline        || flight.provider || "Flight",
        flightNumber:  flight.flight_number  || "AUTO",
        departureTime: flight.departure_time || "08:00",
        arrivalTime:   flight.arrival_time   || "12:00",
        origin:        flight.origin         || "",
        destination:   flight.destination    || "",
        price:         Number(flight.price   || flight.amount || 0),
        seats:         flight.seats          || null,
      })));
    }

    if (supplierAdapter && searchDate) {
      try {
        const liveFlights = await supplierAdapter.searchTransport({
          origin:         searchOrigin,
          destination:    searchDestination,
          date:           searchDate,
          passengers:     tripParams.passengers  || 1,
          transportMode:  'flight',
          timePreference: tripParams.timePreference,
        });
        console.log(`TRAVELDUQA FLIGHTS (${leg}):`, liveFlights.length);
        results.push(...liveFlights);
      } catch (err) {
        logger.error(`TravelDuqa flight search failed (${leg})`, { error: err.message });
      }
    }

    console.log(`ALL FLIGHTS (${leg}):`, results.length);
    return results;
  }

  // ─────────────────────────────
  // BUSES
  // ─────────────────────────────
  async _searchBuses(tripParams, leg = 'outbound') {
    const mode = leg === 'return'
      ? (tripParams.returnTransportMode || tripParams.outboundTransportMode || tripParams.transportMode || 'flight')
      : (tripParams.outboundTransportMode || tripParams.transportMode || 'flight');

    if (mode === 'flight' || mode === 'train') return [];

    const busRoutes = [
      ['nairobi', 'mombasa'], ['nairobi', 'kampala'], ['nairobi', 'dar es salaam'],
      ['nairobi', 'kigali'], ['mombasa', 'dar es salaam'], ['nairobi', 'arusha'],
      ['nairobi', 'kisumu'], ['nairobi', 'nakuru'], ['nairobi', 'eldoret'],
      ['mombasa', 'nairobi'], ['kisumu', 'nairobi'], ['nakuru', 'nairobi'],
    ];

    const searchOrigin      = leg === 'return' ? tripParams.destination : tripParams.origin;
    const searchDestination = leg === 'return' ? tripParams.origin      : tripParams.destination;
    const searchDate        = leg === 'return' ? tripParams.returnDate  : tripParams.departureDate;

    const o = (searchOrigin      || '').toLowerCase();
    const d = (searchDestination || '').toLowerCase();

    const isBusRoute = busRoutes.some(([a, b]) =>
      (o.includes(a) && d.includes(b)) || (o.includes(b) && d.includes(a))
    );

    if (!isBusRoute && mode !== 'bus') return [];
    if (!supplierAdapter || !searchDate) return [];

    try {
      const buses = await supplierAdapter.searchTransport({
        origin:        searchOrigin,
        destination:   searchDestination,
        date:          searchDate,
        passengers:    tripParams.passengers,
        transportMode: 'bus',
        timePreference: tripParams.timePreference,
      });

      console.log(`IABIRI BUSES (${leg}):`, buses.length);

      return buses.map(bus => ({
        supplier:           bus.supplier           || 'iabiri',
        transportType:      'bus',
        tripId:             bus.tripId,
        busId:              bus.busId,
        routeId:            bus.routeId,
        token:              bus.token,
        sourceCityId:       bus.sourceCityId,
        destCityId:         bus.destCityId,
        airline:            bus.provider,
        provider:           bus.provider,
        busType:            bus.busType,
        departureTime:      bus.departureTime,
        arrivalTime:        bus.arrivalTime,
        duration:           bus.duration,
        origin:             bus.origin,
        destination:        bus.destination,
        price:              bus.price,
        currency:           bus.currency           || 'KES',
        availableSeats:     bus.availableSeats,
        totalSeats:         bus.totalSeats,
        amenities:          bus.amenities          || [],
        cancellationPolicy: bus.cancellationPolicy || 'Non-refundable',
        isDelayed:          bus.isDelayed          || false,
      }));
    } catch (err) {
      logger.error(`bus search failed (${leg})`, { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────
  // HOTELS — Supabase static inventory + HotelBeds live
  // ─────────────────────────────
  async _searchHotels(tripParams) {
    const results = [];

    // ── Supabase static inventory ────────────────
    const { data, error } = await supabase
      .from("hotels")
      .select("*")
      .eq("agency_id", tripParams.agencyId);

    if (error) {
      console.error("HOTEL ERROR:", error);
    } else {
      let matchedHotels = (data || []).filter(hotel =>
        this._matchesDestination(hotel, tripParams.destination)
      );

      if (tripParams.mealPlan) {
        const withMealPlan = matchedHotels.filter(h =>
          (h.meal_plan || '').toLowerCase().includes(tripParams.mealPlan.replace('_', ' '))
        );
        if (withMealPlan.length > 0) matchedHotels = withMealPlan;
      }

      console.log("SUPABASE HOTELS:", matchedHotels.length);

      results.push(...matchedHotels.map(hotel => ({
        name:          hotel.name          || hotel.hotel_name || "Hotel",
        stars:         Number(hotel.stars  || 4),
        rating:        Number(hotel.rating || 4.5),
        category:      hotel.category      || "",
        location:      hotel.location      || hotel.city || "",
        pricePerNight: Number(hotel.price_per_night || hotel.price || hotel.rate || 0),
        mealPlan:      hotel.meal_plan     || null,
        reviews:       hotel.reviews       || [],
        currency:      hotel.currency      || 'KES',
        supplier:      'supabase',
      })));
    }

    // ── HotelBeds live inventory ──────────────────
    if (supplierAdapter && tripParams.departureDate) {
      try {
        const checkIn  = tripParams.departureDate;
        const checkOut = tripParams.returnDate || null;
        const nights   = tripParams.nights || 1;

        const liveHotels = await supplierAdapter.searchHotels({
          destination: tripParams.destination,
          checkIn,
          checkOut,
          passengers:  tripParams.passengers || 1,
          nights,
          budget:      tripParams.budget,
          rooms:       1,
        });

        console.log("HOTELBEDS HOTELS (engine):", liveHotels.length);
        results.push(...liveHotels);
      } catch (err) {
        logger.error('HotelBeds hotel search failed', { error: err.message });
      }
    }

    let finalHotels = results;
    if (tripParams.budget) {
      finalHotels = this._filterHotelsByBudget(finalHotels, tripParams.budget);
    }

    console.log("MATCHED HOTELS:", finalHotels.length);

    return finalHotels;
  }

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
      const price = Number(h.pricePerNight ?? h.price_per_night ?? h.price ?? 0);
      return price >= range.min && price <= range.max;
    });

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

    const matchedTransfers = (data || []).filter(t =>
      this._matchesDestination(t, tripParams.destination)
    );

    console.log("MATCHED TRANSFERS:", matchedTransfers.length);

    return matchedTransfers.map(t => ({
      provider:    t.provider     || t.name || "Transfer",
      vehicleType: t.vehicle_type || "Transfer",
      location:    t.location     || "",
      price:       Number(t.price || t.amount || 0),
    }));
  }

  // ─────────────────────────────
  // FORMAT TRANSPORT DISPLAY
  // FIX: was referencing undefined `bus` variable — now correctly uses `t`
  // ─────────────────────────────
  _formatTransportDisplay(t, fallbackOrigin, fallbackDest) {
    if (!t) return null;

    const base = {
      transportType: t.transportType || 'flight',
      airline:       t.airline       || t.provider || "Transport",
      flightNumber:  t.flightNumber  || null,
      departureTime: t.departureTime || "08:00",
      arrivalTime:   t.arrivalTime   || "12:00",
      origin:        t.origin        || fallbackOrigin,
      destination:   t.destination   || fallbackDest,
      price:         t.price         || 0,
      supplier:      t.supplier      || 'supabase',
    };

    if (t.transportType === 'bus') {
      return {
        ...base,
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
        amenities:          t.amenities          || [],
        cancellationPolicy: t.cancellationPolicy,
        currency:           t.currency           || 'KES',
        isDelayed:          t.isDelayed          || false,
      };
    }

    // flight (default)
    return {
      ...base,
      seats:        t.seats        || null,
      airlineCode:  t.airlineCode  || null,
      airlineLogo:  t.airlineLogo  || null,
      cabinClass:   t.cabinClass   || null,
      checkedBags:  t.checkedBags  || null,
      carryOn:      t.carryOn      || null,
      stops:        t.stops        || null,
      duration:     t.duration     || null,
      currency:     t.currency     || 'KES',
      offerId:      t.offerId      || null,
      resultId:     t.resultId     || null,
      expiresAt:    t.expiresAt    || null,
      canBook:      t.canBook      || false,
      canHold:      t.canHold      || false,
      isReturn:     t.isReturn     || false,
      returnLeg:    t.returnLeg    || null,
      passengerIds: t.passengerIds || [],
      originIata:   t.originIata   || null,
      destIata:     t.destIata     || null,
    };
  }

  // ─────────────────────────────
  // BUILD PACKAGES
  // ─────────────────────────────
  _buildPackages({ outboundTransport, returnTransport, hotels, transfers, tripParams, intent }) {
    const scope = intent?.productScope || { needsTransport: true, needsHotel: true, needsTransfers: true };

    const hasOutbound  = outboundTransport.length > 0;
    const hasReturn    = returnTransport.length   > 0;
    const hasHotels    = hotels.length            > 0;
    const hasTransfers = transfers.length         > 0;

    if (!hasOutbound && !hasHotels && !hasTransfers) {
      console.log("NO INVENTORY FOUND");
      return [];
    }

    // === TRANSPORT ONLY ===
    if (scope.needsTransport && !scope.needsHotel && !scope.needsTransfers) {
      // Pair outbound + return into a single package per outbound offer
      if (hasOutbound && hasReturn) {
        return outboundTransport.map((ob, i) => {
          const ret = returnTransport[i % returnTransport.length];
          const totalPrice = (ob.price || 0) + (ret.price || 0);
          return {
            packageId: uuidv4(),
            summary: {
              route:          `${tripParams.origin || 'Nairobi'} to ${tripParams.destination}`,
              passengers:     tripParams.passengers || 1,
              nights:         0,
              totalPrice,
              pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
              transportType:  ob.transportType || 'flight',
            },
            transport:       this._formatTransportDisplay(ob,  tripParams.origin,      tripParams.destination),
            returnTransport: this._formatTransportDisplay(ret, tripParams.destination, tripParams.origin),
            hotel:     null,
            transfers: null,
            status:    "available",
          };
        });
      }

      // One-way or return-only
      const transportList = hasOutbound ? outboundTransport : returnTransport;
      return transportList.map(t => ({
        packageId: uuidv4(),
        summary: {
          route:          `${tripParams.origin || 'Nairobi'} to ${tripParams.destination}`,
          passengers:     tripParams.passengers || 1,
          nights:         0,
          totalPrice:     t.price || 0,
          pricePerPerson: Math.round((t.price || 0) / (tripParams.passengers || 1)),
          transportType:  t.transportType || 'flight',
        },
        transport:       this._formatTransportDisplay(t, tripParams.origin, tripParams.destination),
        returnTransport: null,
        hotel:     null,
        transfers: null,
        status:    "available",
      }));
    }

    // === FULL PACKAGE LOGIC ===
    const packages = [];
    const maxItems = Math.max(
      scope.needsTransport  ? outboundTransport.length : 0,
      scope.needsHotel      ? hotels.length            : 0,
      scope.needsTransfers  ? transfers.length         : 0,
      1
    );

    const startIndex = tripParams.showAlternatives ? 1 : 0;

    for (let i = 0; i < maxItems; i++) {
      const ob       = hasOutbound  && scope.needsTransport  ? outboundTransport[(i + startIndex) % outboundTransport.length] : null;
      const ret      = hasReturn    && scope.needsTransport  ? returnTransport[(i  + startIndex) % returnTransport.length]    : null;
      const hotel    = hasHotels    && scope.needsHotel      ? hotels[(i    + startIndex) % hotels.length]                    : null;
      const transfer = hasTransfers && scope.needsTransfers  ? transfers[i % transfers.length]                                : null;

      if (!ob && !hotel && !transfer) continue;

      const totalPrice =
        (ob?.price       || 0) +
        (ret?.price      || 0) +
        ((hotel?.pricePerNight || 0) * (tripParams.nights || 1)) +
        (transfer?.price || 0);

      packages.push({
        packageId: uuidv4(),
        summary: {
          route:          `${tripParams.origin || 'Anywhere'} to ${tripParams.destination}`,
          passengers:     tripParams.passengers,
          nights:         tripParams.nights || 0,
          totalPrice,
          pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
          mealPlan:       tripParams.mealPlan  || hotel?.mealPlan || null,
          seatPreference: tripParams.seatPreference || null,
          transportType:  ob?.transportType    || 'none',
        },
        transport:       this._formatTransportDisplay(ob,  tripParams.origin,      tripParams.destination),
        returnTransport: this._formatTransportDisplay(ret, tripParams.destination, tripParams.origin),
        hotel,
        transfers: transfer,
        status: "available",
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