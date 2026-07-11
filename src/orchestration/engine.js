const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");
const { logger } = require("../utils/logger");
const { parsePrompt, resolveCountryToCity } = require("./promptParser");
const { rankPackages } = require("./packageRanker");
const { toKES, sumToKES, CANONICAL_CURRENCY } = require("../utils/currency");
const destinationIntel = require("../services/destinationIntel");
const tracking = require("../services/trackingService");
const travelerIntelligence = require("../services/travelerIntelligence");

let hotelbedsTransfers = null;
try {
  hotelbedsTransfers = require("../adapters/hotelbedsTransfers");
} catch (e) {
  logger.warn("HotelBeds Transfers adapter not loaded — falling back to static transfer rates only", { error: e.message });
}

let supplierAdapter = null;
try {
  supplierAdapter = require("../adapters");
} catch (e) {
  console.log("ADAPTER LOAD ERROR:", e.message);
  console.log("ADAPTER LOAD STACK:", e.stack);
  logger.warn("Supplier adapter not loaded — bus/live inventory unavailable", { error: e.message });
}

class OrchestrationEngine {

  static SUPPLIER_TIMEOUT_MS = Number(process.env.SUPPLIER_TIMEOUT_MS) || 10000;

  _withTimeout(promise, fallback, label) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        logger.warn('Supplier call timed out — using fallback', {
          label, ms: OrchestrationEngine.SUPPLIER_TIMEOUT_MS,
        });
        resolve(fallback);
      }, OrchestrationEngine.SUPPLIER_TIMEOUT_MS);
    });

    const tracked = Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    );

    return Promise.race([tracked, timeout]);
  }

  // ─────────────────────────────
  // MAIN ORCHESTRATE
  // ─────────────────────────────
  async orchestrate(prompt, agencyId, context = {}) {
    const sessionId = uuidv4();
    const { conversationHistory = [], previousParams = null } = context;

    logger.info(`[${sessionId}] Started`, { agencyId, prompt });

    try {
      const { data: agencyRow } = await supabase
        .from('agencies')
        .select('mode, api_key')
        .eq('id', agencyId)
        .single();

      if (agencyRow?.mode === 'hotel_direct') {
        const hotelDirectEngine = require('./hotelDirectEngine');
        return hotelDirectEngine.orchestrate(prompt, agencyRow.api_key, context);
      }
    } catch (routingErr) {
      logger.warn('Hotel direct routing check failed — continuing as agency engine', {
        agencyId, error: routingErr.message,
      });
    }

    try {
      if (previousParams?._awaitingClarification) {
        return await this._resumeClarification(prompt, agencyId, previousParams, conversationHistory, sessionId, context.channel, context.phone);
      }

      const intent = this._detectIntent(prompt, previousParams);

      let tripParams;

      if (intent.isFollowUp && previousParams) {
        tripParams = this._adjustParams(previousParams, intent);
        tripParams.agencyId = agencyId;
        if (tripParams.destination) tripParams.destination = resolveCountryToCity(tripParams.destination);
        if (tripParams.origin)      tripParams.origin      = resolveCountryToCity(tripParams.origin);
        console.log("FOLLOW-UP DETECTED — adjusted params:", tripParams);
      } else {
        tripParams = await parsePrompt(prompt);
        tripParams.agencyId = agencyId;
        console.log("FRESH SEARCH — parsed params:", tripParams);
      }

      console.log("INTENT:", intent);
      console.log("PARSED TRIP PARAMS:", tripParams);

      return await this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, intent, context.channel, context.phone);

    } catch (error) {
      logger.error("Engine failure — returning graceful fallback instead of throwing", {
        sessionId, error: error.message, stack: error.stack,
      });

      tracking.alert({
        type:     'engine_crash',
        severity: 'error',
        title:    'Engine error — traveler got no results',
        detail:   error.message,
        context:  { prompt: typeof prompt === 'string' ? prompt.slice(0, 500) : null, agencyId, stack: error.stack },
        agencyId,
        sessionId,
      });
      return {
        sessionId,
        text: "I had trouble putting that together. Could you tell me in a short line where you'd like to go and which city you're travelling from? For example: \"Nairobi to Zanzibar, 3 nights\".",
        packages: [],
        needsClarification: true,
        tripParams: null,
        intent: null,
        conversationHistory,
        generatedAt: new Date().toISOString(),
        degraded: true,
      };
    }
  }

  // ─────────────────────────────
  // SINGLE-DESTINATION SEARCH
  // ─────────────────────────────
  async _runSingleDestinationSearch(tripParams, sessionId, prompt, intent = null) {
    this._validateTripParams(tripParams);

// ── DATE FALLBACK ─────────────────────────────────────────
// When the user didn't give dates (e.g. "Dar es Salaam to
// Cape Town 5 nights") the parser returns departureDate: null
// and returnDate: null. The individual flight/hotel fallbacks
// already handle the missing outbound date with tomorrow, but
// returnDate stays null so the return search never fires at all.
// Fix both here, once, before any search runs.
if (!tripParams.departureDate) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  tripParams.departureDate = d.toISOString().split('T')[0];
  console.log(`[DATE FALLBACK] No departureDate — using ${tripParams.departureDate}`);
}
if (!tripParams.returnDate && tripParams.nights) {
  const dep = new Date(tripParams.departureDate);
  dep.setDate(dep.getDate() + tripParams.nights);
  tripParams.returnDate = dep.toISOString().split('T')[0];
  console.log(`[DATE FALLBACK] No returnDate — using ${tripParams.returnDate} (${tripParams.nights} nights)`);
}
// ── END DATE FALLBACK ─────────────────────────────────────

const resolvedIntent = intent || this._detectIntent(prompt, null);

    tripParams.wantsCheapest = !!resolvedIntent.wantsCheapest;
    tripParams.wantsAffordableSort = !!resolvedIntent.wantsAffordableSort;

    const _tSearch = Date.now();

    const destinationAccess = await this._resolveDestinationAccess(tripParams.destination);

    const [
      outboundResult, outboundBuses, outboundTrains,
      returnResult, returnBuses, returnTrains,
      hotelResults
    ] = await Promise.all([
      this._searchFlightsWithHubFallback(tripParams, 'outbound', destinationAccess),
      this._searchBusesWithStaticFallback(tripParams, 'outbound', destinationAccess),
      this._searchTrain(tripParams, 'outbound', destinationAccess),
      tripParams.returnDate ? this._searchFlightsWithHubFallback(tripParams, 'return', destinationAccess) : Promise.resolve({ results: [], connectsVia: null, connectingLegBookable: true }),
      tripParams.returnDate ? this._searchBusesWithStaticFallback(tripParams, 'return', destinationAccess) : Promise.resolve([]),
      tripParams.returnDate ? this._searchTrain(tripParams, 'return', destinationAccess) : Promise.resolve([]),
      this._searchHotels(tripParams),
    ]);

    console.log(`[TIMING] single-dest supplier search (${tripParams.destination}): ${Date.now() - _tSearch}ms`);

    let outboundTransport = [...outboundResult.results, ...outboundBuses, ...outboundTrains];
    let returnTransport   = [...returnResult.results,   ...returnBuses,   ...returnTrains];
    let hotels = hotelResults;

    outboundTransport = this._dedupeEquivalentFlights(outboundTransport);
    returnTransport    = this._dedupeEquivalentFlights(returnTransport);

    console.log("FINAL OUTBOUND TRANSPORT:", outboundTransport.length, outboundResult.connectsVia ? `(via ${outboundResult.connectsVia})` : '');
    console.log("FINAL RETURN TRANSPORT:",   returnTransport.length, returnResult.connectsVia ? `(via ${returnResult.connectsVia})` : '');
    console.log("FINAL HOTELS:",             hotels.length);

    let unavailableProviderNote = null;
    let unavailableHotelNote = null;

    if (tripParams.preferredTransportProvider) {
      const obFiltered = this._filterByProvider(outboundTransport, tripParams.preferredTransportProvider);
      const retFiltered = returnTransport.length > 0 ? this._filterByProvider(returnTransport, tripParams.preferredTransportProvider) : returnTransport;

      const obHasMatch = obFiltered.length > 0;
      const retHasMatch = returnTransport.length === 0 || retFiltered.length > 0;

      if (obHasMatch && retHasMatch) {
        outboundTransport = obFiltered;
        returnTransport = retFiltered;
      } else {
        unavailableProviderNote = `${tripParams.preferredTransportProvider} isn't available on this route, so here are the available options instead.`;
      }
    }

    if (tripParams.preferredHotel) {
      const hotelsFiltered = this._filterHotelsByName(hotels, tripParams.preferredHotel);
      if (hotelsFiltered.length > 0) {
        hotels = hotelsFiltered;
      } else {
        unavailableHotelNote = `${tripParams.preferredHotel} isn't available for these dates, so here are the available hotels instead.`;
      }
    }

    const _tBuild = Date.now();
    const packages = await this._buildPackages({
      outboundTransport,
      returnTransport,
      hotels,
      tripParams,
      intent: resolvedIntent,
      connectionInfo: {
        outbound: { connectsVia: outboundResult.connectsVia, connectingLegBookable: outboundResult.connectingLegBookable },
        return:   { connectsVia: returnResult.connectsVia,   connectingLegBookable: returnResult.connectingLegBookable },
      },
    });
    console.log(`[TIMING] single-dest package build (${tripParams.destination}): ${Date.now() - _tBuild}ms`);

    let travelerProfile = null;
    try {
      travelerProfile = travelerIntelligence.analyze(tripParams, prompt);
    } catch (err) {
      logger.warn('TravelerIntelligence.analyze failed — ranking without a profile', { error: err.message });
    }

    const rankedPackages = rankPackages(packages, tripParams, travelerProfile).slice(0, 4);

    const unavailableNotes = [unavailableProviderNote, unavailableHotelNote].filter(Boolean).join(' ');

    let responseText;
    if (rankedPackages.length > 0) {
      responseText = `I found ${rankedPackages.length} travel option(s) for ${tripParams.destination}.${unavailableNotes ? ' ' + unavailableNotes : ''}`;
    } else {
      const suggestions = await this._suggestAvailableDestinations(tripParams.agencyId, tripParams.destination);
      const dest = this._titleCase(tripParams.destination);
      responseText = suggestions.length > 0
        ? `I couldn't find availability for ${dest} on those dates. I can put a trip together to one of these right now: ${suggestions.join(', ')}. Want me to try one of those, or adjust your dates?`
        : `I couldn't find availability for ${dest} on those dates. Try shifting your dates or naming a nearby city and I'll search again.`;
    }

    return { text: responseText, packages: rankedPackages };
  }

  _dedupeEquivalentFlights(transportList) {
    if (!Array.isArray(transportList) || transportList.length === 0) return transportList;

    const bestByKey = new Map();
    const passthrough = [];

    for (const item of transportList) {
      const isFlight = (item.transportType || 'flight') === 'flight';
      if (!isFlight) {
        passthrough.push(item);
        continue;
      }

      const key = this._flightDedupeKey(item);
      if (!key) {
        passthrough.push(item);
        continue;
      }

      const existing = bestByKey.get(key);
      if (!existing) {
        bestByKey.set(key, item);
        continue;
      }

      const existingPrice = Number(existing.price ?? Infinity);
      const itemPrice = Number(item.price ?? Infinity);

      if (itemPrice < existingPrice) {
        logger.info('Deduped equivalent flight across suppliers — kept cheaper', {
          key,
          keptSupplier: item.supplier, keptPrice: itemPrice,
          droppedSupplier: existing.supplier, droppedPrice: existingPrice,
        });
        bestByKey.set(key, item);
      } else {
        logger.info('Deduped equivalent flight across suppliers — kept cheaper', {
          key,
          keptSupplier: existing.supplier, keptPrice: existingPrice,
          droppedSupplier: item.supplier, droppedPrice: itemPrice,
        });
      }
    }

    return [...bestByKey.values(), ...passthrough];
  }

  _flightDedupeKey(flight) {
    if (!flight.departureTime) return null;

    const airline = String(flight.airlineCode || flight.airline || '').toLowerCase().trim();
    if (!airline) return null;

    const flightNumber = String(flight.flightNumber || '').trim();
    if (flightNumber) {
      return `${airline}|${flightNumber}|${flight.departureTime}`;
    }

    const origin = String(flight.originIata || flight.origin || '').toLowerCase().trim();
    const dest    = String(flight.destIata   || flight.destination || '').toLowerCase().trim();
    if (!origin || !dest) return null;

    return `${airline}|${origin}-${dest}|${flight.departureTime}`;
  }

  async _suggestAvailableDestinations(agencyId, exclude = null) {
    try {
      const { data, error } = await supabase
        .from('hotels')
        .select('location, city, destination, name')
        .eq('agency_id', agencyId)
        .limit(200);

      if (error || !Array.isArray(data)) return [];

      const ex = exclude ? this._normalize(exclude) : null;
      const seen = new Set();
      const places = [];

      for (const row of data) {
        const place = row.location || row.city || row.destination;
        if (!place) continue;
        const norm = this._normalize(place);
        if (!norm || norm === ex || seen.has(norm)) continue;
        seen.add(norm);
        places.push(this._titleCase(place));
        if (places.length >= 4) break;
      }
      return places;
    } catch (err) {
      logger.error('suggestAvailableDestinations failed', { error: err.message });
      return [];
    }
  }

  _filterByProvider(transportList, preferredProvider) {
    const target = this._normalize(preferredProvider);
    if (!target) return transportList;
    const targetTokens = target.split(' ').filter(Boolean);
    const aliasTargets = this._expandProviderAliases(target);

    return transportList.filter(t => {
      const providerName = this._normalize(t.airline || t.provider || '');
      const providerCode = this._normalize(t.airlineCode || '');

      if (providerName && (providerName.includes(target) || target.includes(providerName))) return true;
      if (providerCode && (providerCode === target || target.includes(providerCode))) return true;

      const providerTokens = providerName.split(' ').filter(Boolean);
      if (targetTokens.length > 0 && providerTokens.length > 0) {
        const [shorter, longer] = targetTokens.length <= providerTokens.length
          ? [targetTokens, providerTokens]
          : [providerTokens, targetTokens];
        if (shorter.every(tok => longer.includes(tok))) return true;
      }

      if (aliasTargets.some(alias => providerName.includes(alias) || providerCode === alias)) return true;

      return false;
    });
  }

  static PROVIDER_ALIASES = {
    'kq': 'kenya airways', 'ek': 'emirates', 'qr': 'qatar airways',
    'et': 'ethiopian airlines', 'ww': 'wow air', 'sa': 'south african airways',
    'rw': 'rwandair', 'pw': 'precision air', 'kl': 'klm',
    'jw': 'jw marriott', 'sw': 'swiss',
  };

  _expandProviderAliases(normalizedTarget) {
    const aliases = OrchestrationEngine.PROVIDER_ALIASES;
    const expanded = [];
    if (aliases[normalizedTarget]) expanded.push(this._normalize(aliases[normalizedTarget]));
    for (const [code, fullName] of Object.entries(aliases)) {
      if (this._normalize(fullName) === normalizedTarget) expanded.push(code);
    }
    return expanded;
  }

  _filterHotelsByName(hotelList, preferredHotel) {
    const target = this._normalize(preferredHotel);
    if (!target) return hotelList;
    const targetTokens = target.split(' ').filter(Boolean);
    const aliasTargets = this._expandProviderAliases(target);

    return hotelList.filter(h => {
      const hotelName = this._normalize(h.name || '');
      if (hotelName && (hotelName.includes(target) || target.includes(hotelName))) return true;

      const hotelTokens = hotelName.split(' ').filter(Boolean);
      if (targetTokens.length > 0 && hotelTokens.length > 0) {
        const [shorter, longer] = targetTokens.length <= hotelTokens.length
          ? [targetTokens, hotelTokens]
          : [hotelTokens, targetTokens];
        if (shorter.every(tok => longer.includes(tok))) return true;
      }

      if (aliasTargets.some(alias => hotelName.includes(alias))) return true;

      return false;
    });
  }

  _classifyMultiDestinationLegs(tripParams) {
    const legs = tripParams.legs || [];
    const groups = [];
    let currentContinuousRun = [];
    let previousDestination = tripParams.origin || null;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const isFirstLeg = i === 0;

      if (isFirstLeg) {
        currentContinuousRun.push(leg);
        previousDestination = leg.destination;
        continue;
      }

      const statedOrigin = leg.origin ? this._normalize(leg.origin) : null;
      const prevDest = previousDestination ? this._normalize(previousDestination) : null;

      if (!statedOrigin) {
        return { needsClarification: { destination: leg.destination } };
      }

      if (statedOrigin === prevDest) {
        currentContinuousRun.push(leg);
        previousDestination = leg.destination;
        continue;
      }

      if (currentContinuousRun.length > 0) {
        groups.push(
          currentContinuousRun.length === 1
            ? { type: 'independent', leg: currentContinuousRun[0] }
            : { type: 'continuous', legs: currentContinuousRun }
        );
      }
      currentContinuousRun = [{ ...leg, origin: leg.origin }];
      previousDestination = leg.destination;
    }

    if (currentContinuousRun.length > 0) {
      groups.push(
        currentContinuousRun.length === 1
          ? { type: 'independent', leg: currentContinuousRun[0] }
          : { type: 'continuous', legs: currentContinuousRun }
      );
    }

    for (const group of groups) {
      if (group.type === 'independent' && !group.leg.origin) {
        group.leg = { ...group.leg, origin: tripParams.origin };
      }
    }

    return { groups };
  }

  async _orchestrateMultiDestination(tripParams, sessionId) {
    const origin = tripParams.origin || 'nairobi';

    const resolvedLegs = await Promise.all(
      tripParams.legs.map(async (leg) => {
        const intel = await destinationIntel.resolve(leg.destination);
        return {
          ...leg,
          intel,
          isAirstripDestination: intel?.isAirstripDestination || false,
        };
      })
    );

    console.log("MULTI-DEST: resolved legs", resolvedLegs.map(l => ({
      destination: l.destination,
      isAirstripDestination: l.isAirstripDestination,
      validationStatus: l.intel?.validationStatus,
    })));

    const stops = this._buildStopSequence(origin, resolvedLegs, tripParams.departureDate);

    console.log("MULTI-DEST: stop sequence", stops.map(s => ({
      destination: s.destination,
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      isBufferLeg: s.isBufferLeg || false,
    })));

    const lastStop = stops[stops.length - 1];

    const _tTransitions = Date.now();
    const transitionPairs = stops.map((toStop, i) => {
      const fromStop = i === 0
        ? { destination: origin, checkOut: stops[0]?.checkIn || tripParams.departureDate, isAirstripDestination: false }
        : stops[i - 1];
      return { fromStop, toStop };
    });

    const [transitions, returnTransition] = await Promise.all([
      Promise.all(transitionPairs.map(({ fromStop, toStop }) =>
        this._resolveTransition(fromStop, toStop, tripParams)
      )),
      this._resolveTransition(
        lastStop,
        { destination: origin, checkIn: lastStop.checkOut, isAirstripDestination: false },
        tripParams
      ),
    ]);
    console.log(`[TIMING] multi-dest transitions (${stops.length} stops + return): ${Date.now() - _tTransitions}ms`);

    const legResults = await Promise.all(
      stops.map(async (stop) => {
        const legTripParams = {
          ...tripParams,
          destination: stop.destination,
          departureDate: stop.checkIn,
          returnDate: stop.checkOut,
          nights: stop.nights,
        };

        const hotels = await this._searchHotels(legTripParams);
        const cheapestHotel = this._pickCheapest(hotels, h => h.pricePerNight);

        return {
          destination: stop.destination,
          nights: stop.nights,
          checkIn: stop.checkIn,
          checkOut: stop.checkOut,
          isBufferLeg: stop.isBufferLeg || false,
          isAirstripDestination: stop.isAirstripDestination || false,
          hotel: cheapestHotel || null,
          transfers: null,
        };
      })
    );

    for (let i = 0; i < legResults.length; i++) {
      legResults[i].transportIn = this._formatTransportDisplay(
        transitions[i]?.transport,
        transitions[i]?.from,
        transitions[i]?.to
      );
      legResults[i].connectsVia = transitions[i]?.connectsVia || null;
      legResults[i].bufferNight = transitions[i]?.bufferNight || false;
    }

    await Promise.all(
      legResults.map(async (leg, i) => {
        if (leg.isBufferLeg) return;
        const legTripParams = {
          ...tripParams,
          origin: transitions[i]?.from || tripParams.origin,
          destination: leg.destination,
        };
        leg.transfers = await this._buildTransferLegs(legTripParams, transitions[i]?.transport, leg.hotel);
      })
    );

    const finalReturnTransport = this._formatTransportDisplay(
      returnTransition?.transport,
      returnTransition?.from,
      returnTransition?.to
    );

    const transportCosts = [...transitions, returnTransition].map(t => ({
      amount:   t?.transport?.price,
      currency: t?.transport?.currency || 'KES',
    }));

    const hotelCosts = legResults.map(leg => ({
      amount:   (leg.hotel?.pricePerNight || 0) * leg.nights,
      currency: leg.hotel?.currency || 'KES',
    }));

    const transferCosts = legResults.flatMap(leg =>
      (leg.transfers || []).map(t => ({ amount: t.price, currency: t.currency || 'KES' }))
    );

    const totalPrice = await sumToKES([...transportCosts, ...hotelCosts, ...transferCosts]);

    const totalNights = legResults.reduce((sum, leg) => sum + (leg.nights || 0), 0);
    const routeLabel = [origin, ...stops.map(s => s.destination)].join(' → ');

    return {
      packageId: uuidv4(),
      isMultiDestination: true,
      summary: {
        route:          routeLabel,
        totalNights,
        totalPrice,
        pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
        currency:       CANONICAL_CURRENCY,
        passengers:     tripParams.passengers || 1,
      },
      legs: legResults,
      returnTransport: finalReturnTransport,
      status: "available",
    };
  }

  _buildStopSequence(origin, resolvedLegs, departureDate) {
    const stops = [];
    let cursorDate = departureDate || this._defaultStartDate();

    for (let i = 0; i < resolvedLegs.length; i++) {
      const current = resolvedLegs[i];
      const previous = i === 0 ? null : resolvedLegs[i - 1];

      const needsBuffer = previous && (previous.isAirstripDestination || current.isAirstripDestination);

      if (needsBuffer) {
        const bufferCheckOut = this._addDaysStr(cursorDate, 1);
        stops.push({
          destination: origin,
          checkIn:     cursorDate,
          checkOut:    bufferCheckOut,
          nights:      1,
          isBufferLeg: true,
        });
        cursorDate = bufferCheckOut;
      }

      const checkOut = this._addDaysStr(cursorDate, current.nights);
      stops.push({
        destination: current.destination,
        checkIn:     cursorDate,
        checkOut,
        nights:      current.nights,
        isAirstripDestination: current.isAirstripDestination,
        intel: current.intel,
      });
      cursorDate = checkOut;
    }

    return stops;
  }

  async _resolveTransition(fromStop, toStop, tripParams) {
    const fromIsAirstrip = fromStop.isAirstripDestination;
    const toIsAirstrip   = toStop.isAirstripDestination;
    const origin = tripParams.origin || 'nairobi';

    if (fromIsAirstrip || toIsAirstrip) {
      const transport = await this._searchCheapestDirect(fromStop.destination, toStop.destination, fromStop.checkOut, tripParams);
      return {
        from: fromStop.destination,
        to: toStop.destination,
        transport,
        connectsVia: origin,
        bufferNight: true,
      };
    }

    const direct = await this._searchCheapestDirect(fromStop.destination, toStop.destination, fromStop.checkOut, tripParams);
    if (direct) {
      return { from: fromStop.destination, to: toStop.destination, transport: direct, connectsVia: null, bufferNight: false };
    }

    logger.info('MultiDest: no direct route, falling back via origin', {
      from: fromStop.destination, to: toStop.destination,
    });
    const viaOrigin = await this._searchCheapestDirect(fromStop.destination, toStop.destination, fromStop.checkOut, tripParams);
    return {
      from: fromStop.destination,
      to: toStop.destination,
      transport: viaOrigin,
      connectsVia: origin,
      bufferNight: false,
    };
  }

  async _searchCheapestDirect(fromCity, toCity, date, tripParams) {
    if (!supplierAdapter || !date) return null;

    try {
      const results = await this._withTimeout(
        supplierAdapter.searchTransport({
          origin:         fromCity,
          destination:    toCity,
          date,
          passengers:     tripParams.passengers || 1,
          transportMode:  'flight',
          timePreference: tripParams.timePreference,
          children:       tripParams.children || 0,
          childAges:      Array.isArray(tripParams.childAges) ? tripParams.childAges : [],
        }),
        [],
        `transition ${fromCity}->${toCity}`
      );

      return this._pickCheapest(this._dedupeEquivalentFlights(results), r => r.price);
    } catch (err) {
      logger.error('MultiDest: transition search failed', { from: fromCity, to: toCity, error: err.message });
      return null;
    }
  }

  _pickCheapest(items, priceFn) {
    if (!items || items.length === 0) return null;
    return items.reduce((cheapest, item) => {
      if (!cheapest) return item;
      return (priceFn(item) || Infinity) < (priceFn(cheapest) || Infinity) ? item : cheapest;
    }, null);
  }

  _addDaysStr(dateStr, days) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  }

  _defaultStartDate() {
    const date = new Date();
    date.setDate(date.getDate() + 14);
    return date.toISOString().split('T')[0];
  }

  _validateMultiDestinationParams(params) {
    if (!Array.isArray(params.legs) || params.legs.length < 2) {
      throw new Error("Multi-destination trip requires at least 2 legs");
    }
    for (const leg of params.legs) {
      if (!leg.destination) throw new Error("Each leg requires a destination");
    }
  }

  _buildClarificationResponse({ sessionId, prompt, question, tripParams, intent, conversationHistory, awaitingClarification }) {
    const taggedParams = {
      ...tripParams,
      _awaitingClarification: awaitingClarification,
      _pendingProductScope: intent?.productScope || null,
    };
    return {
      sessionId,
      text: question,
      packages: [],
      needsClarification: true,
      tripParams: taggedParams,
      intent,
      conversationHistory: [
        ...conversationHistory,
        { role: 'user', content: prompt },
        { role: 'assistant', content: question, params: taggedParams, packageCount: 0 },
      ].slice(-10),
      generatedAt: new Date().toISOString(),
    };
  }

  _needsChildAgeClarification(tripParams) {
    const children = tripParams.children || 0;
    if (children <= 0) return null;
    const ages = Array.isArray(tripParams.childAges) ? tripParams.childAges : [];
    if (ages.length >= children) return null;

    const missing = children - ages.length;
    const question = children === 1
      ? `How old is the child travelling? I need their age to price the hotel correctly.`
      : ages.length === 0
        ? `How old are the ${children} children travelling? I need each child's age to price the hotel correctly (e.g. "5 and 8").`
        : `I still need ${missing === 1 ? "the remaining child's age" : `${missing} more children's ages`}. How old ${missing === 1 ? 'is' : 'are'} they?`;
    return { question, missing };
  }

  async _resumeClarification(prompt, agencyId, previousParams, conversationHistory, sessionId, channel, phone = null) {
    const marker = previousParams._awaitingClarification;
    const answer = String(prompt || '').trim().toLowerCase();

    const wordCount = answer.split(/\s+/).filter(Boolean).length;
    const looksLikeFreshPrompt = wordCount > 10;

    if (looksLikeFreshPrompt) {
      logger.info('Clarification answer looks like a fresh prompt, not a short answer — re-parsing instead of treating as a fragment', {
        wordCount, preview: answer.slice(0, 120),
      });
      const freshTripParams = await parsePrompt(prompt);
      freshTripParams.agencyId = agencyId;
      const freshIntent = this._detectIntent(prompt, null);
      console.log('CLARIFICATION BYPASSED — treated as fresh prompt:', freshTripParams);
      return this._continueOrchestration(freshTripParams, agencyId, prompt, conversationHistory, sessionId, freshIntent, channel, phone);
    }

    const neutralIntent = {
      isFollowUp: false,
      adjustments: {},
      productScope: previousParams._pendingProductScope || { needsTransport: true, needsHotel: true, needsTransfers: true },
    };

    if (!answer) {
      const question = marker?.type === 'destination'
        ? `Sorry, I didn't catch that — where would you like to travel to?`
        : marker?.type === 'child_age'
          ? `Sorry, I didn't catch that — how old ${(previousParams.children || 0) === 1 ? 'is the child' : 'are the children'} travelling?`
          : `Sorry, I didn't catch that — where will you be departing from?`;
      return this._buildClarificationResponse({
        sessionId, prompt, question, tripParams: previousParams,
        intent: neutralIntent,
        conversationHistory, awaitingClarification: marker,
      });
    }

    if (marker?.type === 'destination') {
      const cleanedDest = answer
        .replace(/^(i'?d like to |i'?d love to |i'?m |i want to |i would like to )?(go to |travel to |visit |fly to |to )?/i, '')
        .trim() || answer;
      const tripParams = { ...previousParams };
      delete tripParams._awaitingClarification;
      tripParams.destination = cleanedDest;
      console.log("RESUMED CLARIFICATION (destination) — completed params:", tripParams);
      return this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, neutralIntent, channel, phone);
    }

    if (marker?.type === 'child_age') {
      const tripParams = { ...previousParams };
      delete tripParams._awaitingClarification;
      const existing = Array.isArray(tripParams.childAges) ? [...tripParams.childAges] : [];
      const children = tripParams.children || 0;
      const newAges = (answer.match(/\d{1,2}/g) || [])
        .map(n => parseInt(n, 10))
        .filter(n => Number.isFinite(n) && n >= 0 && n < 18);
      tripParams.childAges = existing.concat(newAges).slice(0, children);

      if (tripParams.childAges.length < children) {
        const gate = this._needsChildAgeClarification(tripParams);
        return this._buildClarificationResponse({
          sessionId, prompt,
          question: gate ? gate.question : `Please tell me the remaining child age(s).`,
          tripParams, intent: neutralIntent, conversationHistory,
          awaitingClarification: { type: 'child_age' },
        });
      }

      console.log("RESUMED CLARIFICATION (child_age) — completed params:", tripParams);
      return this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, neutralIntent, channel, phone);
    }

    const cleanedAnswer = answer
      .replace(/^(i'?ll be |i'?m |coming |departing |leaving )?(coming |departing |leaving )?from\s+/i, '')
      .replace(/^(it'?s|i'?m|i am)\s+/i, '')
      .trim();

    const resolvedOrigin = cleanedAnswer || answer;

    let tripParams = { ...previousParams };
    delete tripParams._awaitingClarification;

    if (marker?.type === 'single_origin' || marker?.type === 'overall_origin') {
      tripParams.origin = resolvedOrigin;
      tripParams.needsOriginClarification = false;
    } else if (marker?.type === 'leg_origin' && Array.isArray(tripParams.legs)) {
      const targetIdx = tripParams.legs.findIndex(l => this._normalize(l.destination) === this._normalize(marker.destination));
      if (targetIdx !== -1) {
        tripParams.legs = tripParams.legs.map((leg, i) => i === targetIdx ? { ...leg, origin: resolvedOrigin } : leg);
      }
      if (!tripParams.origin) tripParams.origin = resolvedOrigin;
      tripParams.needsOriginClarification = false;
    }

    console.log("RESUMED CLARIFICATION — completed params:", tripParams);

    return this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, neutralIntent, channel, phone);
  }

  async _continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, intent, channel, phone = null) {
    tripParams.agencyId = agencyId;

    // ── Multi-trip: independent separate trips ────────────────────────────────
    // parsePrompt returns { trips: [...] } when the user asks for multiple
    // completely separate trips (different origins, destinations, and dates).
    // These are NOT multi-destination legs — run each as its own search.
    if (Array.isArray(tripParams.trips) && tripParams.trips.length > 1) {
      const tripResults = [];

      for (const trip of tripParams.trips) {
        const legParams = {
          ...tripParams,
          trips:              undefined,   // prevent recursion
          isMultiDestination: false,
          legs:               undefined,
          destination:        trip.destination,
          origin:             trip.origin || tripParams.origin,
          departureDate:      trip.departureDate,
          returnDate:         trip.returnDate,
          nights:             trip.nights,
        };

        const result = await this._runSingleDestinationSearch(legParams, sessionId, prompt, intent);

        tripResults.push({
          text:     result.text,
          packages: result.packages,
          label:    `${legParams.origin} → ${trip.destination} (${trip.departureDate})`,
        });
      }

      const updatedHistory = [
        ...conversationHistory,
        { role: 'user', content: prompt },
        {
          role:         'assistant',
          content:      `Built ${tripResults.length} separate trip searches`,
          params:       tripParams,
          packageCount: tripResults.reduce((s, t) => s + t.packages.length, 0),
        },
      ].slice(-10);

      this._logSearch({
        sessionId,
        agencyId,
        prompt,
        tripParams:       { ...tripParams, destination: tripResults.map(t => t.label).join(' + ') },
        packagesReturned: tripResults.reduce((s, t) => s + t.packages.length, 0),
        channel:          channel || 'widget',
      }).catch(err => logger.error('Failed to log multi-trip search', { error: err.message }));

      tracking.logTurn({
        sessionId,
        agencyId,
        channel:            channel || 'widget',
        phone:              phone || null,
        userMessage:        prompt,
        engineResponse:     `Found options for ${tripResults.length} trips`,
        packagesCount:      tripResults.reduce((s, t) => s + t.packages.length, 0),
        needsClarification: false,
        tripParams,
        packages:           tripResults.flatMap(t => t.packages),
      });

      return {
        sessionId,
        text:                `I found options for your ${tripResults.length} trips:`,
        packages:            tripResults.flatMap(t => t.packages),
        tripResults,
        tripParams,
        intent,
        conversationHistory: updatedHistory,
        generatedAt:         new Date().toISOString(),
      };
    }
    // ── End multi-trip ────────────────────────────────────────────────────────

    if (tripParams.isMultiDestination) {
      try {
        this._validateMultiDestinationParams(tripParams);
      } catch (validationErr) {
        logger.warn('Multi-destination validation failed — attempting graceful salvage', { error: validationErr.message });
        const usableLeg = (tripParams.legs || []).find(l => l && l.destination);
        if (usableLeg) {
          tripParams = {
            ...tripParams,
            isMultiDestination: false,
            legs: undefined,
            destination: usableLeg.destination,
            nights: usableLeg.nights || tripParams.nights || 3,
            origin: usableLeg.origin || tripParams.origin || null,
          };
        } else {
          return this._buildClarificationResponse({
            sessionId, prompt,
            question: "I couldn't quite follow the trip you described. Could you list the places you'd like to visit and how many nights at each? For example: \"3 nights Maasai Mara then 4 nights Mombasa\".",
            tripParams: { ...tripParams, _awaitingClarification: undefined },
            intent, conversationHistory,
            awaitingClarification: null,
          });
        }
      }
    }

    if (tripParams.isMultiDestination) {

      if (tripParams.needsOriginClarification && intent?.productScope?.needsTransport !== false) {
        const question = `Where will you be departing from for your trip?`;
        return this._buildClarificationResponse({
          sessionId, prompt, question, tripParams, intent, conversationHistory,
          awaitingClarification: { type: 'overall_origin' },
        });
      }

      const classification = this._classifyMultiDestinationLegs(tripParams);

      if (classification.needsClarification) {
        const question = `Where will you be departing from for ${this._titleCase(classification.needsClarification.destination)}?`;
        return this._buildClarificationResponse({
          sessionId, prompt, question, tripParams, intent, conversationHistory,
          awaitingClarification: { type: 'leg_origin', destination: classification.needsClarification.destination },
        });
      }

      const tripResults = [];
      let previousLegEndDate = tripParams.departureDate || this._defaultStartDate();

      for (const group of classification.groups) {
        if (group.type === 'continuous') {
          const groupParams = { ...tripParams, legs: group.legs, isMultiDestination: true };
          const itinerary = await this._orchestrateMultiDestination(groupParams, sessionId);
          tripResults.push({
            text: `I put together a ${itinerary.summary.totalNights}-night itinerary across ${itinerary.legs.length} stops.`,
            packages: [itinerary],
            label: itinerary.summary.route,
          });
          const lastStop = itinerary.legs[itinerary.legs.length - 1];
          if (lastStop?.checkOut) previousLegEndDate = lastStop.checkOut;
        } else {
          const dateWasAssumed = !group.leg.departureDate;
          const legDepartureDate = group.leg.departureDate || previousLegEndDate;
          const legReturnDate = this._addDaysStr(legDepartureDate, group.leg.nights || 1);

          const legParams = {
            ...tripParams,
            isMultiDestination: false,
            legs: undefined,
            origin: group.leg.origin,
            destination: group.leg.destination,
            departureDate: legDepartureDate,
            returnDate: legReturnDate,
            nights: group.leg.nights,
          };
          const result = await this._runSingleDestinationSearch(legParams, sessionId, prompt);

          const assumptionNote = dateWasAssumed
            ? ` (I've scheduled this for ${legDepartureDate} to ${legReturnDate}, right after your previous trip — let me know if you meant different dates.)`
            : '';

          tripResults.push({ text: result.text + assumptionNote, packages: result.packages, label: legParams.destination });
          previousLegEndDate = legReturnDate;
        }
      }

      const updatedHistory = [
        ...conversationHistory,
        { role: 'user', content: prompt },
        {
          role: 'assistant',
          content: `Built ${tripResults.length} trip result(s): ${tripResults.map(t => t.label).join(', ')}`,
          params: tripParams,
          packageCount: tripResults.reduce((sum, t) => sum + t.packages.length, 0),
        },
      ].slice(-10);

      this._logSearch({
        sessionId,
        agencyId,
        prompt,
        tripParams: { ...tripParams, destination: tripResults.map(t => t.label).join(' + ') },
        packagesReturned: tripResults.length,
        channel: channel || 'widget',
      }).catch(err => logger.error('Failed to log search', { error: err.message }));

      return {
        sessionId,
        text: tripResults.length === 1 ? tripResults[0].text : `I found ${tripResults.length} separate trips in your message.`,
        packages: tripResults.flatMap(t => t.packages),
        tripResults,
        tripParams,
        intent,
        conversationHistory: updatedHistory,
        generatedAt: new Date().toISOString(),
      };
    }

    if (!tripParams.destination) {
      return this._buildClarificationResponse({
        sessionId, prompt,
        question: "I want to get this right — where would you like to travel to?",
        tripParams: { ...tripParams, _awaitingClarification: undefined },
        intent, conversationHistory,
        awaitingClarification: { type: 'destination' },
      });
    }

    if (tripParams.needsOriginClarification && intent?.productScope?.needsTransport !== false) {
      const question = `Where will you be departing from for ${tripParams.destination ? this._titleCase(tripParams.destination) : 'your trip'}?`;
      return this._buildClarificationResponse({
        sessionId, prompt, question, tripParams, intent, conversationHistory,
        awaitingClarification: { type: 'single_origin' },
      });
    }

    const childAgeGate = this._needsChildAgeClarification(tripParams);
    if (childAgeGate) {
      return this._buildClarificationResponse({
        sessionId, prompt, question: childAgeGate.question, tripParams, intent, conversationHistory,
        awaitingClarification: { type: 'child_age' },
      });
    }

    const singleResult = await this._runSingleDestinationSearch(tripParams, sessionId, prompt, intent);

    const updatedHistory = [
      ...conversationHistory,
      { role: 'user', content: prompt },
      {
        role: 'assistant',
        content: `Found ${singleResult.packages.length} packages`,
        params: tripParams,
        packageCount: singleResult.packages.length,
      },
    ].slice(-10);

    this._logSearch({
      sessionId,
      agencyId,
      prompt,
      tripParams,
      packagesReturned: singleResult.packages.length,
      packages:         singleResult.packages,
      channel: channel || 'widget',
    }).catch(err => logger.error('Failed to log search', { error: err.message }));

    tracking.logTurn({
      sessionId,
      agencyId,
      channel:            channel || 'widget',
      phone:              phone || null,
      userMessage:        prompt,
      engineResponse:     singleResult.text,
      packagesCount:      singleResult.packages.length,
      needsClarification: false,
      tripParams,
      packages:           singleResult.packages,
    });

    if (singleResult.packages.length === 0) {
      tracking.alert({
        type:      'zero_results',
        severity:  'warning',
        title:     `No results for "${tripParams.destination || 'unknown destination'}"`,
        detail:    `Prompt: "${prompt.slice(0, 200)}"`,
        context:   { prompt, destination: tripParams.destination, origin: tripParams.origin, tripParams },
        agencyId,
        sessionId,
        channel:   channel || 'widget',
      });
    }

    return {
      sessionId,
      text: singleResult.text,
      packages: singleResult.packages,
      tripParams,
      intent,
      conversationHistory: updatedHistory,
      generatedAt: new Date().toISOString(),
    };
  }

  async _logSearch({ sessionId, agencyId, prompt, tripParams, packagesReturned, packages = [], channel }) {
    try {
      const preferredProvider = tripParams.preferredTransportProvider
        ? tripParams.preferredTransportProvider.toLowerCase().trim()
        : null;

      let preferredMode = null;
      if (preferredProvider) {
        if (tripParams.outboundTransportMode) {
          preferredMode = tripParams.outboundTransportMode;
        } else if (tripParams.requiresFlight) {
          preferredMode = 'flight';
        } else if (tripParams.requiresBus) {
          preferredMode = 'bus';
        }
      }

      let preferredFulfilled = null;
      if (preferredProvider && packages.length > 0) {
        const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const target = normalize(preferredProvider);
        preferredFulfilled = packages.some(pkg => {
          const t = pkg.transport;
          if (!t) return false;
          return normalize(t.airline || '').includes(target) ||
                 target.includes(normalize(t.airline || '')) ||
                 normalize(t.airlineCode || '').includes(target) ||
                 normalize(t.provider || '').includes(target);
        });
      }

      await supabase.from('trip_searches').insert({
        id:                           uuidv4(),
        agency_id:                    agencyId,
        session_id:                   sessionId,
        prompt:                       prompt,
        destination:                  tripParams.destination || null,
        origin:                       tripParams.origin      || null,
        passengers:                   tripParams.passengers  || 1,
        budget:                       tripParams.budget      || null,
        nights:                       tripParams.nights      || null,
        packages_returned:            packagesReturned,
        channel:                      channel,
        converted:                    false,
        preferred_transport_provider: preferredProvider,
        preferred_transport_mode:     preferredMode,
        preferred_fulfilled:          preferredFulfilled,
        created_at:                   new Date().toISOString(),
      });
    } catch (err) {
      logger.error('trip_searches insert failed', { error: err.message });
    }
  }

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
          national_id: p.nationalId || p.national_id_number || p.national_id || null,
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

  _detectIntent(prompt, previousParams) {
    const lower = prompt.toLowerCase();

    const followUpSignals = !!(
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
    );

    const freshTripPattern = /\b[a-z\s]{2,30}?\s+to\s+[a-z\s]{2,30}\b/i;
    const freshTripMatches = lower.match(new RegExp(freshTripPattern, 'gi')) || [];
    const hasOwnDestinationStructure = freshTripMatches.length > 0;

    const isFollowUp = !!(previousParams && followUpSignals && !hasOwnDestinationStructure);

    const adjustments = {};
    const productScope = {
      needsTransport:  true,
      needsHotel:      true,
      needsTransfers:  true,
    };

    const wantsCheapest = /\b(cheapest|lowest[\s-]?price|lowest[\s-]?fare|best[\s-]?price)\b/i.test(lower);
    const wantsAffordableSort = /\bcheap\b|cheaper|less expensive|lower budget|affordable|bei nafuu|budget option/i.test(lower);

    const flightExclusive = lower.match(
      /\bonly\s+(a\s+)?flight(s)?\b|flight(s)?\s+only|just\s+(a\s+)?flight(s)?\b|\bonly\s+want\s+a\s+flight\b|\bjust\s+want\s+a\s+flight\b|search\s+flights?\s+only|\bcheapest\s+flight(s)?\b|\bcheapest\s+fare\b/i
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
      const additivePhrase = /\b(include|also|add|as well|too|alongside)\b/i.test(lower);

      if (!additivePhrase) {
        if (lower.match(/\bflight(s)?\b|\bfly\b|\bflying\b/i)) {
          adjustments.transportMode = 'flight';
        } else if (lower.match(/\bbus(es)?\b/i)) {
          adjustments.transportMode = 'bus';
        }
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

    let newDestination = null;
    const insteadMatch = lower.match(/\b(?:let'?s do|do|go to|make it|change (?:it|that) to|switch to)\s+([a-z\s]{2,30}?)\s+instead\b/i)
      || lower.match(/\binstead\s+(?:of\s+[a-z\s]{2,30}?,?\s*)?(?:let'?s do|do|go to|make it)\s+([a-z\s]{2,30}?)(?:\s*[.,]|$)/i)
      || lower.match(/\bactually,?\s+(?:let'?s do|do|go to|make it)\s+([a-z\s]{2,30}?)(?:\s+instead)?(?:\s*[.,]|$)/i);
    if (insteadMatch && insteadMatch[1]) {
      const candidate = insteadMatch[1].trim();
      if (candidate.length >= 3 && !/^(that|this|it|there|here)$/i.test(candidate)) {
        newDestination = candidate;
      }
    }
    if (newDestination) adjustments.destination = newDestination;

    return { isFollowUp, adjustments, productScope, wantsCheapest, wantsAffordableSort };
  }

  _adjustParams(previousParams, intent) {
    const adjusted = { ...previousParams };
    const { adjustments } = intent;

    if (adjustments.budget        !== undefined) adjusted.budget        = adjustments.budget;
    if (adjustments.nights        !== undefined) adjusted.nights        = adjustments.nights;
    if (adjustments.passengers    !== undefined) adjusted.passengers    = adjustments.passengers;
    if (adjustments.transportMode !== undefined) adjusted.transportMode = adjustments.transportMode;

    if (adjustments.destination !== undefined) {
      adjusted.destination = adjustments.destination;
      adjusted.destinationCode = undefined;
    }

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

  static REGIONAL_HUBS = ['nairobi', 'mombasa', 'kampala', 'dar es salaam', 'addis ababa', 'kigali'];

  async _resolveDestinationAccess(destination) {
    if (!destination) return null;
    try {
      return await destinationIntel.resolve(destination);
    } catch (err) {
      logger.warn('DestinationIntel resolution failed — falling back to direct-airport assumption', {
        destination, error: err.message,
      });
      return null;
    }
  }

  async _searchFlightsWithHubFallback(tripParams, leg = 'outbound', destinationAccess = null) {
    const direct = await this._searchFlights(tripParams, leg, destinationAccess);
    if (direct.length > 0) {
      return { results: direct, connectsVia: null, connectingLegBookable: true };
    }

    const origin = ((leg === 'return' ? tripParams.destination : tripParams.origin) || '').toLowerCase();
    const destination = ((leg === 'return' ? tripParams.origin : tripParams.destination) || '').toLowerCase();

    const candidateHubs = OrchestrationEngine.REGIONAL_HUBS.filter(
      (hub) => hub !== origin && hub !== destination
    );

    const fromHubResults = await Promise.all(
      candidateHubs.map((hub) => {
        const hubToDestParams = leg === 'return'
          ? { ...tripParams, destination: hub, origin: tripParams.destination }
          : { ...tripParams, origin: hub };
        return this._searchFlights(hubToDestParams, leg, destinationAccess)
          .then((results) => ({ hub, results }))
          .catch((err) => {
            logger.error('Hub fallback leg search failed', { hub, leg, error: err.message });
            return { hub, results: [] };
          });
      })
    );

    const winner = fromHubResults.find((r) => r.results.length > 0);
    if (winner) {
      const originToHubParams = leg === 'return'
        ? { ...tripParams, origin: tripParams.destination, destination: winner.hub }
        : { ...tripParams, destination: winner.hub };

      const legToHub = await this._searchFlights(originToHubParams, leg);

      console.log(`HUB FALLBACK (${leg}): ${origin} -> ${winner.hub} -> ${destination} | toHub: ${legToHub.length}, fromHub: ${winner.results.length}`);

      return {
        results: winner.results,
        connectsVia: winner.hub,
        connectingLegBookable: legToHub.length > 0,
      };
    }

    return { results: [], connectsVia: null, connectingLegBookable: true };
  }

  async _searchFlights(tripParams, leg = 'outbound', destinationAccess = null) {
    const mode = leg === 'return'
      ? (tripParams.returnTransportMode || tripParams.outboundTransportMode || tripParams.transportMode || 'flight')
      : (tripParams.outboundTransportMode || tripParams.transportMode || 'flight');

    if (mode === 'bus' || mode === 'train') return [];

    let searchOrigin      = leg === 'return' ? tripParams.destination : tripParams.origin;
    let searchDestination = leg === 'return' ? tripParams.origin      : tripParams.destination;

    let hubLanding = null;
    const airAccess = destinationAccess?.accessByMode?.air;
    if (airAccess?.hubName && (airAccess.transferRequired || !airAccess.directService)) {
      hubLanding = {
        name: airAccess.hubName,
        code: airAccess.hubCode || null,
        distanceKm: airAccess.transferDistanceKm || null,
        realDestination: tripParams.destination,
      };
      if (leg === 'return') searchOrigin = airAccess.hubName;
      else searchDestination = airAccess.hubName;
    } else if (airAccess && !airAccess.hubName && !airAccess.directService) {
      logger.info('DestinationIntel: no air route known for destination, skipping flight search', {
        destination: tripParams.destination, leg,
      });
      return [];
    }

    let searchDate = leg === 'return' ? tripParams.returnDate : tripParams.departureDate;
    if (!searchDate) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      searchDate = tomorrow.toISOString().split('T')[0];
      console.log(`[FLIGHT FALLBACK] No date for ${leg} — using ${searchDate}`);
    }

    const results = [];

    if (supplierAdapter && searchDate) {
      try {
        const liveFlights = await this._withTimeout(
          supplierAdapter.searchTransport({
            origin:         searchOrigin,
            destination:    searchDestination,
            date:           searchDate,
            passengers:     tripParams.passengers  || 1,
            transportMode:  'flight',
            timePreference: tripParams.timePreference,
            children:       tripParams.children || 0,
            childAges:      Array.isArray(tripParams.childAges) ? tripParams.childAges : [],
          }),
          [],
          `flight ${leg} ${searchOrigin}->${searchDestination}`
        );
        console.log(`TRAVELDUQA FLIGHTS (${leg}):`, liveFlights.length);
        results.push(...(hubLanding ? liveFlights.map(f => ({ ...f, hubLanding })) : liveFlights));
      } catch (err) {
        logger.error(`TravelDuqa flight search failed (${leg})`, { error: err.message });
      }
    }

    console.log(`ALL FLIGHTS (${leg}):`, results.length);
    return results;
  }

  _busEligibleForLeg(tripParams, leg, destinationAccess) {
    const explicitLegMode = leg === 'return'
      ? (tripParams.returnTransportMode || tripParams.outboundTransportMode || tripParams.transportMode || null)
      : (tripParams.outboundTransportMode || tripParams.transportMode || null);

    const mode = explicitLegMode || 'flight';

    const busAccess = destinationAccess?.accessByMode?.bus;
    const isDestinationIntelDirectRoute = busAccess?.directService === true;
    const canBypassOnKnownRoute = explicitLegMode === null && isDestinationIntelDirectRoute;

    return !((mode === 'flight' || mode === 'train') && !canBypassOnKnownRoute);
  }

  async _searchBuses(tripParams, leg = 'outbound', destinationAccess = null) {
    if (!this._busEligibleForLeg(tripParams, leg, destinationAccess)) return [];

    const explicitLegMode = leg === 'return'
      ? (tripParams.returnTransportMode || tripParams.outboundTransportMode || tripParams.transportMode || null)
      : (tripParams.outboundTransportMode || tripParams.transportMode || null);
    const mode = explicitLegMode || 'flight';

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

    const isKnownBusRoute = busRoutes.some(([a, b]) =>
      (o.includes(a) && d.includes(b)) || (o.includes(b) && d.includes(a))
    );

    const busAccess = destinationAccess?.accessByMode?.bus;
    const isDestinationIntelDirectRoute = busAccess?.directService === true;

    const isBusRoute = isKnownBusRoute || isDestinationIntelDirectRoute;

    if (!isBusRoute && mode !== 'bus') return [];
    if (!supplierAdapter || !searchDate) return [];

    const busSearchAs = busAccess?.searchAs || null;
    const iabiriSearchOrigin      = busSearchAs && leg === 'return' ? busSearchAs : searchOrigin;
    const iabiriSearchDestination = busSearchAs && leg !== 'return' ? busSearchAs : searchDestination;

    try {
      const buses = await this._withTimeout(
        supplierAdapter.searchTransport({
          origin:        iabiriSearchOrigin,
          destination:   iabiriSearchDestination,
          date:          searchDate,
          passengers:    tripParams.passengers,
          transportMode: 'bus',
          timePreference: tripParams.timePreference,
        }),
        [],
        `bus ${leg} ${iabiriSearchOrigin}->${iabiriSearchDestination}`
      );

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
        provider:            bus.provider,
        busType:            bus.busType,
        departureTime:      bus.departureTime,
        arrivalTime:        bus.arrivalTime,
        duration:           bus.duration,
        origin:             busSearchAs ? this._titleCase(leg === 'return' ? tripParams.destination : tripParams.origin) : bus.origin,
        destination:        busSearchAs ? this._titleCase(leg === 'return' ? tripParams.origin : tripParams.destination) : bus.destination,
        routeNote:          busSearchAs
          ? `This service runs ${this._titleCase(tripParams.origin)} \u2194 ${this._titleCase(busSearchAs)} and stops at ${this._titleCase(tripParams.destination)} along the way \u2014 request that ${leg === 'return' ? 'boarding' : 'drop-off'} point when you book.`
          : null,
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

  static STATIC_BUS_OPERATORS = [
    { provider: 'Buscar',    busType: null },
    { provider: 'Dreamline', busType: 'Marcopolo G7' },
    { provider: 'Mash',      busType: 'Mash Polo' },
  ];

  _staticBusCorridor(tripParams, destinationAccess) {
    const origin = (tripParams.origin      || '').toLowerCase().trim();
    const dest   = (tripParams.destination || '').toLowerCase().trim();

    if ((origin === 'nairobi' && dest === 'mombasa') || (origin === 'mombasa' && dest === 'nairobi')) {
      return { routeOrigin: 'nairobi', routeHub: 'mombasa', stopsAt: null };
    }

    const busAccess = destinationAccess?.accessByMode?.bus;
    if (busAccess?.searchAs === 'malindi') {
      return { routeOrigin: 'nairobi', routeHub: 'malindi', stopsAt: tripParams.destination };
    }

    return null;
  }

  async _searchStaticBusOperators(tripParams, leg = 'outbound', destinationAccess = null) {
    if (!this._busEligibleForLeg(tripParams, leg, destinationAccess)) return [];

    const corridor = this._staticBusCorridor(tripParams, destinationAccess);
    if (!corridor) return [];

    const displayOrigin      = leg === 'return' ? tripParams.destination : tripParams.origin;
    const displayDestination = leg === 'return' ? tripParams.origin      : tripParams.destination;

    return OrchestrationEngine.STATIC_BUS_OPERATORS.map(op => ({
      supplier:           'static_bus_catalog',
      transportType:      'bus',
      provider:            op.provider,
      airline:             op.provider,
      busType:             op.busType,
      origin:              this._titleCase(displayOrigin),
      destination:         this._titleCase(displayDestination),
      departureTime:       null,
      arrivalTime:         null,
      price:               null,
      priceOnRequest:      true,
      currency:            'KES',
      canBook:             false,
      availableSeats:      null,
      totalSeats:          null,
      amenities:           [],
      cancellationPolicy:  null,
      isDelayed:           false,
      routeNote:           corridor.stopsAt
        ? `${op.provider}${op.busType ? ` (${op.busType})` : ''} runs ${this._titleCase(corridor.routeOrigin)} \u2194 ${this._titleCase(corridor.routeHub)} and stops at ${this._titleCase(corridor.stopsAt)} along the way. Contact ${op.provider} directly to confirm schedule and fare \u2014 live booking here is pending the Travler/IABIRI integration for this route.`
        : `Contact ${op.provider}${op.busType ? ` (${op.busType})` : ''} directly to confirm current schedule and fare \u2014 live booking here is pending the Travler/IABIRI integration for this route.`,
    }));
  }

  async _searchBusesWithStaticFallback(tripParams, leg = 'outbound', destinationAccess = null) {
    const liveResults = await this._searchBuses(tripParams, leg, destinationAccess);
    if (liveResults.length > 0) return liveResults;

    try {
      return await this._searchStaticBusOperators(tripParams, leg, destinationAccess);
    } catch (err) {
      logger.warn('Static bus operator catalog fallback failed', { error: err.message });
      return [];
    }
  }

  static SGR_SCHEDULE = [
    { departureTime: '08:00', serviceName: 'SGR Intercounty',              stopsNote: 'Stops at multiple stations along the route' },
    { departureTime: '15:00', serviceName: 'SGR Madaraka Express (Direct)', stopsNote: 'Stops only at Voi' },
    { departureTime: '22:00', serviceName: 'SGR Madaraka Express (Direct)', stopsNote: 'Stops only at Voi' },
  ];

  static SGR_FARES = { economy: 1500, first_class: 4500, premium: 12000 };

  static SGR_STATION_COORDS = {
    nairobi: { lat: -1.354561, lng: 36.898430 },
    mombasa: { lat: -4.025278, lng: 39.578333 },
  };

  static BUS_TERMINAL_COORDS = {
    mombasa: { lat: -4.0435, lng: 39.6682 },
  };

  async _searchTrain(tripParams, leg = 'outbound', destinationAccess = null) {
    const mode = leg === 'return'
      ? (tripParams.returnTransportMode || tripParams.outboundTransportMode || tripParams.transportMode || null)
      : (tripParams.outboundTransportMode || tripParams.transportMode || null);

    if (mode === 'flight' || mode === 'bus') return [];

    let hubLanding = null;
    const trainAccess = destinationAccess?.accessByMode?.train;
    if (trainAccess?.hubName && (trainAccess.transferRequired || !trainAccess.directService)) {
      hubLanding = {
        name: trainAccess.hubName, code: null,
        distanceKm: trainAccess.transferDistanceKm || null,
        realDestination: tripParams.destination,
      };
    }

    const effectiveDestination = hubLanding ? hubLanding.name : tripParams.destination;
    const o = (tripParams.origin || '').toLowerCase().trim();
    const d = (effectiveDestination || '').toLowerCase().trim();

    const isSgrCorridor = (o === 'nairobi' && d === 'mombasa') || (o === 'mombasa' && d === 'nairobi');
    if (!isSgrCorridor) return [];

    const explicitTrainRequest = mode === 'train' || !!tripParams.trainClass;
    const isBudgetSearch = tripParams.budget === 'low';
    if (!explicitTrainRequest && !isBudgetSearch) return [];

    const classesToShow = (tripParams.trainClass && tripParams.trainClass !== 'sgr')
      ? [tripParams.trainClass]
      : ['economy'];

    const searchDate = leg === 'return' ? tripParams.returnDate : tripParams.departureDate;

    const displayOrigin      = leg === 'return' ? effectiveDestination : tripParams.origin;
    const displayDestination = leg === 'return' ? tripParams.origin    : effectiveDestination;

    const entries = [];
    for (const schedule of OrchestrationEngine.SGR_SCHEDULE) {
      for (const cls of classesToShow) {
        const fare = OrchestrationEngine.SGR_FARES[cls];
        if (!fare) continue;
        entries.push({
          supplier:      'sgr_static',
          transportType: 'train',
          origin:        this._titleCase(displayOrigin),
          destination:   this._titleCase(displayDestination),
          departureTime: schedule.departureTime,
          arrivalTime:   null,
          serviceName:   schedule.serviceName,
          stopsNote:     schedule.stopsNote,
          trainClass:    cls,
          price:         fare,
          currency:      'KES',
          canBook:       false,
          travelDate:    searchDate,
          hubLanding,
        });
      }
    }

    return entries;
  }

  async _searchHotels(tripParams) {
    const results = [];

    let checkIn = tripParams.departureDate;
    if (!checkIn) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      checkIn = tomorrow.toISOString().split('T')[0];
      console.log(`[HOTEL FALLBACK] No departureDate — using ${checkIn}`);
    }

    if (supplierAdapter) {
      try {
        const nights   = tripParams.nights || 1;
        const checkOut = tripParams.returnDate || this._addDaysStr(checkIn, nights);

        const liveHotels = await this._withTimeout(
          supplierAdapter.searchHotels({
            destination: tripParams.destination,
            checkIn,
            checkOut,
            passengers:  tripParams.passengers || 1,
            adults:      tripParams.adults != null ? tripParams.adults : (tripParams.passengers || 1),
            children:    tripParams.children || 0,
            childAges:   Array.isArray(tripParams.childAges) ? tripParams.childAges : [],
            nights,
            budget:      tripParams.budget,
            rooms: tripParams.rooms || 1,
            roomType: tripParams.roomType || null,
          }),
          [],
          `hotels ${tripParams.destination}`
        );

        console.log("HOTELBEDS HOTELS (engine):", liveHotels.length);
        results.push(...liveHotels);
      } catch (err) {
        logger.error('HotelBeds hotel search failed', { error: err.message });
      }
    }

    let finalHotels = results;
    if (tripParams.budget) {
      finalHotels = await this._filterHotelsByBudget(finalHotels, tripParams.budget);
    }

    console.log("MATCHED HOTELS:", finalHotels.length);

    return finalHotels;
  }

  async _filterHotelsByBudget(hotels, budget) {
    const ranges = {
      low:    { min: 0,     max: 8000   },
      mid:    { min: 5000,  max: 20000  },
      high:   { min: 15000, max: 50000  },
      luxury: { min: 40000, max: 9999999 },
    };
    const range = ranges[budget];
    if (!range) return hotels;

    const withKESPrice = await Promise.all(hotels.map(async h => {
      const rawPrice = Number(h.pricePerNight ?? h.price_per_night ?? h.price ?? 0);
      const kesPrice = await toKES(rawPrice, h.currency || 'KES');
      return { hotel: h, kesPrice };
    }));

    const filtered = withKESPrice
      .filter(({ kesPrice }) => kesPrice >= range.min && kesPrice <= range.max)
      .map(({ hotel }) => hotel);

    return filtered.length > 0 ? filtered : hotels;
  }

  async _buildTransferLegs(tripParams, transport, hotel = null) {
    if (!transport) return [];

    const mode = (transport.transportType || 'flight').toLowerCase();
    const originCity = tripParams.origin || 'Nairobi';
    const destCity    = tripParams.destination || transport.destination || 'your destination';
    const hubCity = transport.hubLanding?.name || destCity;

    let originHub, destHub;

    if (mode === 'bus') {
      originHub = `${this._titleCase(originCity)} Bus Station`;
      destHub   = `${this._titleCase(hubCity)} Bus Station`;
    } else if (mode === 'train') {
      originHub = `${this._titleCase(originCity)} Train Station`;
      destHub   = `${this._titleCase(hubCity)} Train Station`;
    } else {
      originHub = transport.originAirport || `${this._titleCase(originCity)} Airport`;
      destHub   = transport.destAirport   || `${this._titleCase(hubCity)} Airport`;
    }

    const rate = await this._getTransferRate(tripParams);

    let fromType = null, fromCode = null;
    if (mode === 'flight' && transport.destIata) {
      fromType = 'IATA';
      fromCode = transport.destIata;
    } else if (mode === 'train') {
      const stationCoords = OrchestrationEngine.SGR_STATION_COORDS[(hubCity || '').toLowerCase()];
      if (stationCoords) {
        fromType = 'GPS';
        fromCode = `${stationCoords.lat},${stationCoords.lng}`;
      }
    } else if (mode === 'bus') {
      const terminalCoords = OrchestrationEngine.BUS_TERMINAL_COORDS[(hubCity || '').toLowerCase()];
      if (terminalCoords) {
        fromType = 'GPS';
        fromCode = `${terminalCoords.lat},${terminalCoords.lng}`;
      }
    }

    let liveArrival = null;
    let liveArrivalPriceKES = null;
    if (hotelbedsTransfers && fromType && fromCode && hotel?.latitude != null && hotel?.longitude != null) {
      try {
        const outbound = this._toTransferDateTime(transport.arrivalTime) || this._toTransferDateTime(tripParams.departureDate);
        if (outbound) {
          const results = await hotelbedsTransfers.search({
            fromType, fromCode,
            toType:   'GPS',  toCode:   `${hotel.latitude},${hotel.longitude}`,
            outbound,
            adults:   tripParams.adults != null ? tripParams.adults : (tripParams.passengers || 1),
            children: tripParams.children || 0,
            infants:  0,
          });
          const picked = hotelbedsTransfers.pickCheapest(results);
          if (picked) {
            liveArrivalPriceKES = await toKES(picked.price, picked.currency || 'EUR');
            liveArrival = picked;
          }
        }
      } catch (err) {
        logger.warn('Live transfer pricing attempt failed — falling back to static rate', { error: err.message });
        liveArrival = null;
        liveArrivalPriceKES = null;
      }
    }

    const arrivalDescription = transport.hubLanding
      ? `${destHub} → ${this._titleCase(transport.hubLanding.realDestination)} (road transfer${transport.hubLanding.distanceKm ? `, ~${transport.hubLanding.distanceKm}km` : ''})`
      : `${destHub} → Hotel`;
    const arrivalDropoff = transport.hubLanding
      ? `${this._titleCase(transport.hubLanding.realDestination)} (Hotel)`
      : 'Hotel';

    return [
      {
        legType:     'departure',
        provider:    rate?.provider || 'Bodrless Standard Transfer',
        description: `${this._titleCase(originCity)} → ${originHub}`,
        pickup:      this._titleCase(originCity),
        dropoff:     originHub,
        price:       rate?.price ?? 1500,
        currency:    rate?.currency || 'KES',
      },
      {
        legType:     'arrival',
        provider:    liveArrival ? `HolidayTaxis${liveArrival.vehicle ? ' — ' + liveArrival.vehicle : ''}` : (rate?.provider || 'Bodrless Standard Transfer'),
        description: arrivalDescription,
        pickup:      destHub,
        dropoff:     arrivalDropoff,
        price:       liveArrival ? liveArrivalPriceKES : (rate?.price ?? 1500),
        currency:    'KES',
        live: liveArrival ? {
          supplier: liveArrival.supplier,
          rateKey: liveArrival.rateKey,
          transferType: liveArrival.transferType,
          estimatedMinutes: liveArrival.estimatedMinutes,
          luggageAllowance: liveArrival.luggageAllowance,
          cancellationPolicies: liveArrival.cancellationPolicies,
          originalPrice: liveArrival.price,
          originalCurrency: liveArrival.currency,
        } : null,
      },
    ];
  }

  _toTransferDateTime(value) {
    if (!value) return null;
    try {
      const d = new Date(value);
      if (isNaN(d.getTime())) return null;
      const pad = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
      return null;
    }
  }

  _titleCase(str) {
    if (!str) return '';
    return String(str).replace(/\b\w/g, c => c.toUpperCase());
  }

  async _getTransferRate(tripParams) {
    const { data, error } = await supabase
      .from("transfers")
      .select("*")
      .eq("agency_id", tripParams.agencyId);

    if (error) {
      console.error("TRANSFER RATE ERROR:", error);
      return null;
    }

    let rows = data || [];

    if (rows.length === 0) {
      const { data: defaultRows, error: defaultError } = await supabase
        .from("transfers")
        .select("*")
        .is("agency_id", null);

      if (defaultError) {
        console.error("DEFAULT TRANSFER RATE ERROR:", defaultError);
      } else {
        rows = defaultRows || [];
      }
    }

    const matched = rows.find(t => this._matchesDestination(t, tripParams.destination)) || rows[0];
    if (!matched) return null;

    return {
      provider: matched.provider || matched.name || null,
      price:    Number(matched.price || matched.amount || 1500),
      currency: matched.currency || 'KES',
    };
  }

  _formatTransportDisplay(t, fallbackOrigin, fallbackDest) {
    if (!t) return null;

    const base = {
      transportType: t.transportType || 'flight',
      airline:       t.airline       || t.provider || "Transport",
      flightNumber:  t.flightNumber  || null,
      departureTime: t.priceOnRequest ? (t.departureTime || null) : (t.departureTime || "08:00"),
      arrivalTime:   t.priceOnRequest ? (t.arrivalTime   || null) : (t.arrivalTime   || "12:00"),
      origin:        t.origin        || fallbackOrigin,
      destination:   t.destination   || fallbackDest,
      price:         t.priceOnRequest ? null : (t.price || 0),
      priceOnRequest: t.priceOnRequest || false,
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
        canBook:            t.canBook !== undefined ? t.canBook : true,
        policySummary:  t.priceOnRequest
          ? 'Not yet bookable through Bodrless \u2014 contact the operator directly to confirm schedule, fare, and seat availability.'
          : (t.cancellationPolicy || 'Cancellation policy not specified'),
        baggageSummary: null,
        routeNote:      t.routeNote || null,
      };
    }

    if (t.transportType === 'train') {
      return {
        ...base,
        supplier:      t.supplier    || 'sgr_static',
        provider:      t.serviceName || 'SGR',
        trainClass:    t.trainClass  || null,
        serviceName:   t.serviceName || null,
        stopsNote:     t.stopsNote   || null,
        currency:      t.currency    || 'KES',
        canBook:       t.canBook     || false,
        hubLanding:    t.hubLanding  || null,
        policySummary: t.canBook
          ? 'Bookable via SGR'
          : 'Not yet bookable through Bodrless — purchase directly via SGR (Madaraka Express) at the station or their booking portal. Price shown is the standard published fare.',
        baggageSummary: null,
      };
    }

    return {
      ...base,
      seats:        t.seats        || null,
      airlineCode:  t.airlineCode  || null,
      airlineLogo:  t.airlineLogo  || null,
      cabinClass:   t.cabinClass   || null,
      checkedBags:  t.checkedBags  || null,
      carryOn:      t.carryOn      || null,
      stops:        t.stops        ?? null,
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
      isRefundable:          t.isRefundable          ?? null,
      refundPenalty:         t.refundPenalty          ?? null,
      refundPenaltyCurrency: t.refundPenaltyCurrency  ?? null,
      requiresInstantPayment: t.requiresInstantPayment ?? null,
      paymentRequiredBy:       t.paymentRequiredBy      ?? null,
      baggageSummary: this._formatBaggageSummary(t.checkedBags, t.carryOn),
      policySummary:  this._formatFlightPolicySummary(t.canBook, t.canHold, t.isRefundable, t.refundPenalty, t.refundPenaltyCurrency),
      hubLanding:   t.hubLanding   || null,
    };
  }

  _formatBaggageSummary(checkedBags, carryOn) {
    const checked = Number(checkedBags) || 0;
    const carry   = Number(carryOn)     || 0;

    if (checked === 0 && carry === 0) return 'No checked or carry-on baggage included';

    const parts = [];
    if (checked > 0) parts.push(`${checked} checked bag${checked > 1 ? 's' : ''}`);
    if (carry   > 0) parts.push(`${carry} carry-on${carry > 1 ? 's' : ''}`);
    return parts.join(', ');
  }

  _formatFlightPolicySummary(canBook, canHold, isRefundable = null, refundPenalty = null, refundPenaltyCurrency = null) {
    const bookingNote = canHold
      ? 'Hold available'
      : canBook
        ? 'Instant booking only'
        : 'Booking availability unconfirmed';

    if (isRefundable === true) {
      const penaltyNote = (refundPenalty != null && refundPenalty > 0)
        ? ` (${refundPenaltyCurrency || ''} ${refundPenalty.toLocaleString()} penalty applies)`.replace('  ', ' ')
        : ' (no penalty)';
      return `✅ Refundable${penaltyNote} · ${bookingNote}`;
    }
    if (isRefundable === false) {
      return `❌ Non-refundable · ${bookingNote}`;
    }
    return `${bookingNote} · Refund status not confirmed by the airline — check before booking if this matters to you`;
  }

  async _buildPackages({ outboundTransport, returnTransport, hotels, tripParams, intent, connectionInfo }) {
    const scope = intent?.productScope || { needsTransport: true, needsHotel: true, needsTransfers: true };

    const hasOutbound  = outboundTransport.length > 0;
    const hasReturn    = returnTransport.length   > 0;
    const hasHotels    = hotels.length            > 0;

    if (!hasOutbound && !hasHotels) {
      console.log("NO INVENTORY FOUND");
      return [];
    }

    if (scope.needsTransport && !scope.needsHotel && !scope.needsTransfers) {
      if (hasOutbound && hasReturn) {
        return Promise.all(outboundTransport.map(async (ob, i) => {
          const ret = returnTransport[i % returnTransport.length];
          const obKES  = await toKES(ob.price,  ob.currency  || 'KES');
          const retKES = await toKES(ret.price, ret.currency || 'KES');
          const totalPrice = obKES + retKES;
          return {
            packageId: uuidv4(),
            summary: {
              route:          `${tripParams.origin || 'Nairobi'} to ${tripParams.destination}`,
              passengers:     tripParams.passengers || 1,
              nights:         0,
              totalPrice,
              pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
              currency:       CANONICAL_CURRENCY,
              transportType:  ob.transportType || 'flight',
            },
            transport:       this._formatTransportDisplay(ob,  tripParams.origin,      tripParams.destination),
            returnTransport: this._formatTransportDisplay(ret, tripParams.destination, tripParams.origin),
            hotel:     null,
            transfers: null,
            status:    "available",
          };
        }));
      }

      const transportList = hasOutbound ? outboundTransport : returnTransport;
      return Promise.all(transportList.map(async t => {
        const totalPrice = await toKES(t.price, t.currency || 'KES');
        return {
          packageId: uuidv4(),
          summary: {
            route:          `${tripParams.origin || 'Nairobi'} to ${tripParams.destination}`,
            passengers:     tripParams.passengers || 1,
            nights:         0,
            totalPrice,
            pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
            currency:       CANONICAL_CURRENCY,
            transportType:  t.transportType || 'flight',
          },
          transport:       this._formatTransportDisplay(t, tripParams.origin, tripParams.destination),
          returnTransport: null,
          hotel:     null,
          transfers: null,
          status:    "available",
        };
      }));
    }

    const packages = [];
    const maxItems = Math.max(
      scope.needsTransport  ? outboundTransport.length : 0,
      scope.needsHotel      ? hotels.length            : 0,
      1
    );

    const startIndex = tripParams.showAlternatives ? 1 : 0;

    const built = await Promise.all(
      Array.from({ length: maxItems }, (_, i) => i).map(async (i) => {
        const ob    = hasOutbound && scope.needsTransport ? outboundTransport[(i + startIndex) % outboundTransport.length] : null;
        const ret   = hasReturn   && scope.needsTransport ? returnTransport[(i + startIndex) % returnTransport.length]    : null;
        const hotel = hasHotels   && scope.needsHotel     ? hotels[(i + startIndex) % hotels.length]                      : null;

        if (!ob && !hotel) return null;

        const nights = tripParams.nights || 1;

        const transferLegs = scope.needsTransfers
          ? await this._buildTransferLegs(tripParams, ob, hotel)
          : [];
        const transferTotal = transferLegs.reduce((sum, leg) => sum + (leg.price || 0), 0);
        const transferCurrency = transferLegs[0]?.currency || 'KES';

        const obAmount  = ob?.priceOnRequest  ? 0 : ob?.price;
        const retAmount = ret?.priceOnRequest ? 0 : ret?.price;
        const hasPriceOnRequestLeg = !!(ob?.priceOnRequest || ret?.priceOnRequest);

        const totalPrice = await sumToKES([
          { amount: obAmount,                               currency: ob?.currency       || 'KES' },
          { amount: retAmount,                              currency: ret?.currency      || 'KES' },
          { amount: (hotel?.pricePerNight || 0) * nights,    currency: hotel?.currency    || 'KES' },
          { amount: transferTotal,                           currency: transferCurrency },
        ]);

        return {
          packageId: uuidv4(),
          summary: {
            route:          `${tripParams.origin || 'Anywhere'} to ${tripParams.destination}`,
            passengers:     tripParams.passengers,
            nights:         tripParams.nights || 0,
            totalPrice,
            pricePerPerson: Math.round(totalPrice / (tripParams.passengers || 1)),
            currency:       CANONICAL_CURRENCY,
            mealPlan:       tripParams.mealPlan  || hotel?.mealPlan || null,
            seatPreference: tripParams.seatPreference || null,
            transportType:  ob?.transportType    || 'none',
            priceCaveat: hasPriceOnRequestLeg
              ? "This total excludes the fare for the bus operator shown below \u2014 contact them directly to confirm price, then add it to this total."
              : null,
            occupancy: {
              adults:    tripParams.adults != null ? tripParams.adults : (tripParams.passengers || 1),
              children:  tripParams.children || 0,
              childAges: Array.isArray(tripParams.childAges) ? tripParams.childAges : [],
              checkIn:   tripParams.departureDate || null,
              checkOut:  tripParams.returnDate || null,
              nights:    tripParams.nights || 0,
            },
          },
          transport:       this._formatTransportDisplay(ob,  tripParams.origin,      tripParams.destination),
          returnTransport: this._formatTransportDisplay(ret, tripParams.destination, tripParams.origin),
          hotel,
          transfers: transferLegs,
          connectionAdvisory: this._buildConnectionAdvisory(tripParams, connectionInfo),
          hubTransferNote: ob?.hubLanding
            ? `This trip ${ob.transportType === 'train' ? 'arrives at' : 'flies into'} ${this._titleCase(ob.hubLanding.name)} — the road transfer to ${this._titleCase(ob.hubLanding.realDestination)} is included below.`
            : null,
          status: "available",
        };
      })
    );

    packages.push(...built.filter(Boolean));

    return packages;
  }

  _buildConnectionAdvisory(tripParams, connectionInfo) {
    if (!connectionInfo) return null;

    const outboundNote = (connectionInfo.outbound?.connectsVia && !connectionInfo.outbound?.connectingLegBookable)
      ? `You'll need to arrange your own way from ${this._titleCase(tripParams.origin)} to ${this._titleCase(connectionInfo.outbound.connectsVia)} first (no direct flight/bus available) — then the booked leg below covers ${this._titleCase(connectionInfo.outbound.connectsVia)} to ${this._titleCase(tripParams.destination)}.`
      : null;

    const returnNote = (connectionInfo.return?.connectsVia && !connectionInfo.return?.connectingLegBookable)
      ? `On your return, you'll need to arrange your own way from ${this._titleCase(connectionInfo.return.connectsVia)} back to ${this._titleCase(tripParams.origin)} after your booked flight lands.`
      : null;

    if (!outboundNote && !returnNote) return null;
    return [outboundNote, returnNote].filter(Boolean).join(' ');
  }

  _validateTripParams(params) {
    if (!params.destination) {
      throw new Error("Missing destination");
    }
  }
}

module.exports = new OrchestrationEngine();