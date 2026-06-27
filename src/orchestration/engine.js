const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");
const { logger } = require("../utils/logger");
const { parsePrompt } = require("./promptParser");
const { rankPackages } = require("./packageRanker");
const { toKES, sumToKES, CANONICAL_CURRENCY } = require("../utils/currency");
const destinationIntel = require("../services/destinationIntel");

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
      // ─────────────────────────────
      // RESUME A PENDING CLARIFICATION
      // If the last response was a clarification question ("Where
      // will you be departing from for Kampala?"), previousParams
      // carries an _awaitingClarification marker (see
      // _buildClarificationResponse below) describing exactly what
      // was missing. THIS message is the traveler's answer to that
      // specific question — treat it as filling in that one field,
      // not as a brand-new prompt to parse from scratch. Without
      // this, a one-word reply like "Zanzibar" would go through
      // normal fresh parsing, which has no idea a question is even
      // pending and will likely fail or misparse it as an unrelated
      // destination search.
      // ─────────────────────────────
      if (previousParams?._awaitingClarification) {
        return await this._resumeClarification(prompt, agencyId, previousParams, conversationHistory, sessionId, context.channel);
      }

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

      // Multi-destination classification, single-destination search,
      // clarification-question handling — all shared with
      // _resumeClarification's re-entry path. See _continueOrchestration.
      return await this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, intent, context.channel);

    } catch (error) {
      logger.error("Engine failure", { error: error.message });
      throw error;
    }
  }

  // ─────────────────────────────
  // SINGLE-DESTINATION SEARCH (extracted, reusable)
  // Used by orchestrate()'s normal single-destination path AND by
  // each INDEPENDENT leg split out of a multi-destination prompt
  // (see _classifyMultiDestinationLegs) — same search/build/rank
  // logic either way, just scoped to whatever tripParams it's given.
  // Does NOT touch conversationHistory/_logSearch — callers handle
  // that themselves since the two call sites log differently.
  // ─────────────────────────────
  async _runSingleDestinationSearch(tripParams, sessionId, prompt, intent = null) {
    this._validateTripParams(tripParams);

    const resolvedIntent = intent || this._detectIntent(prompt, null);

    const [
      outboundResult, outboundBuses,
      returnResult, returnBuses,
      hotels
    ] = await Promise.all([
      this._searchFlightsWithHubFallback(tripParams, 'outbound'),
      this._searchBuses(tripParams, 'outbound'),
      tripParams.returnDate ? this._searchFlightsWithHubFallback(tripParams, 'return') : Promise.resolve({ results: [], connectsVia: null, connectingLegBookable: true }),
      tripParams.returnDate ? this._searchBuses(tripParams, 'return') : Promise.resolve([]),
      this._searchHotels(tripParams),
    ]);

    const outboundTransport = [...outboundResult.results, ...outboundBuses];
    const returnTransport   = [...returnResult.results,   ...returnBuses];

    console.log("FINAL OUTBOUND TRANSPORT:", outboundTransport.length, outboundResult.connectsVia ? `(via ${outboundResult.connectsVia})` : '');
    console.log("FINAL RETURN TRANSPORT:",   returnTransport.length, returnResult.connectsVia ? `(via ${returnResult.connectsVia})` : '');
    console.log("FINAL HOTELS:",             hotels.length);

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

    const rankedPackages = rankPackages(packages, tripParams).slice(0, 4);

    const responseText = rankedPackages.length > 0
      ? `I found ${rankedPackages.length} travel option(s) for ${tripParams.destination}.`
      : `Sorry, I couldn't find any matching travel packages for ${tripParams.destination}.`;

    return { text: responseText, packages: rankedPackages };
  }

  // ─────────────────────────────
  // CLASSIFY MULTI-DESTINATION LEGS
  // Walks legs in order, comparing each leg's stated origin (if any)
  // against the PREVIOUS leg's destination (or the top-level origin,
  // for leg 1) to decide whether the itinerary stays one continuous
  // trip, splits into independent trips, or needs a clarifying
  // question before any searching happens.
  //
  // Returns either:
  //   { needsClarification: { destination } }   -- stop, ask, no search
  //   { groups: [ { type: 'continuous', legs }, { type: 'independent', leg }, ... ] }
  //
  // Matching a leg's stated origin against the previous destination
  // uses simple normalized string comparison (lowercase, trimmed) —
  // both values come from the same place-name vocabulary the parser
  // already extracts from, so this doesn't need fuzzy matching on
  // top of what promptParser.js already does.
  // ─────────────────────────────
  _classifyMultiDestinationLegs(tripParams) {
    const legs = tripParams.legs || [];
    const groups = [];
    let currentContinuousRun = [];
    let previousDestination = tripParams.origin || null;

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const isFirstLeg = i === 0;

      if (isFirstLeg) {
        // Leg 1's origin is the top-level tripParams.origin — already
        // validated/clarified upstream (needsOriginClarification on
        // tripParams itself), nothing new to classify here.
        currentContinuousRun.push(leg);
        previousDestination = leg.destination;
        continue;
      }

      const statedOrigin = leg.origin ? this._normalize(leg.origin) : null;
      const prevDest = previousDestination ? this._normalize(previousDestination) : null;

      if (!statedOrigin) {
        // No origin restated for this leg at all -> ambiguous,
        // stop and ask rather than assuming continuation.
        return { needsClarification: { destination: leg.destination } };
      }

      if (statedOrigin === prevDest) {
        // Explicitly confirmed continuous — same as not stating one,
        // except the traveler removed the ambiguity themselves.
        currentContinuousRun.push(leg);
        previousDestination = leg.destination;
        continue;
      }

      // Stated origin differs from the previous stop -> this leg (and
      // everything after it, until the next break) is NOT part of the
      // same itinerary as what came before. Close out the current
      // continuous run, then start this leg as the seed of a new one.
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

    // A "continuous" group of exactly one leg (e.g. leg 1 alone, when
    // leg 2 broke off as independent) still needs an origin to search
    // with — leg 1's origin is tripParams.origin; for any later
    // single-leg group it's the leg's own stated origin (guaranteed
    // present, since we only ever get here via the "differs" branch
    // above, which requires a stated origin).
    for (const group of groups) {
      if (group.type === 'independent' && !group.leg.origin) {
        group.leg = { ...group.leg, origin: tripParams.origin };
      }
    }

    return { groups };
  }

  // ─────────────────────────────
  // MULTI-DESTINATION ORCHESTRATION
  // ─────────────────────────────
  //
  // Builds one combined itinerary across N destination legs.
  //
  // Routing rule per transition (legA -> legB):
  //   - If either leg is an airstrip destination (Maasai Mara,
  //     Amboseli, Ol Pejeta, etc.) -> route via origin, with a
  //     default 1-night buffer stay in the origin city (booked,
  //     priced, shown to the traveler — not a silent gap).
  //   - Otherwise -> attempt a direct transport search first; if
  //     nothing is found, fall back to routing via origin (no
  //     buffer night in this case — this is a missing-route
  //     fallback, not a known same-day-risk pattern).
  //   - Either fallback is clearly labeled on the resulting leg
  //     (connectsVia / bufferNight) so nothing is sprung on the
  //     traveler at the airport.
  //
  // Each real stay (including inserted buffer legs) reuses the
  // existing single-destination _searchHotels/_searchTransfers
  // logic unchanged, just scoped to that leg's own date window.
  // ─────────────────────────────
  async _orchestrateMultiDestination(tripParams, sessionId) {
    const origin = tripParams.origin || 'nairobi';

    // 1. Resolve every leg's destination intel up front, so routing
    //    decisions for every transition can be made before any
    //    supplier search runs.
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

    // 2. Build the real stop sequence, inserting buffer legs in the
    //    origin city wherever an airstrip transition requires one.
    //    This also computes each stop's date window.
    const stops = this._buildStopSequence(origin, resolvedLegs, tripParams.departureDate);

    console.log("MULTI-DEST: stop sequence", stops.map(s => ({
      destination: s.destination,
      checkIn: s.checkIn,
      checkOut: s.checkOut,
      isBufferLeg: s.isBufferLeg || false,
    })));

    // 3. For each stop, resolve the transport that ARRIVES at it —
    //    transitions[i] is "how we get TO stops[i]", so transitions
    //    has the same length as stops (transitions[0] is origin ->
    //    stops[0]). This lets legResults[i] line up directly with
    //    transitions[i] below, instead of being off by one and
    //    missing the very first origin -> stops[0] transition.
    const transitions = [];
    let previousStop = { destination: origin, checkOut: stops[0]?.checkIn || tripParams.departureDate, isAirstripDestination: false };

    for (let i = 0; i < stops.length; i++) {
      const toStop = stops[i];
      const transition = await this._resolveTransition(previousStop, toStop, tripParams);
      transitions.push(transition);
      previousStop = toStop;
    }

    // Final leg home — transport arriving back at origin after the last stop.
    const lastStop = stops[stops.length - 1];
    const returnTransition = await this._resolveTransition(lastStop, { destination: origin, checkIn: lastStop.checkOut, isAirstripDestination: false }, tripParams);

    // 4. For each real stay, search the hotel using existing
    //    single-leg logic. Transfer legs are built afterward
    //    (step 5b), once we know the actual transport that
    //    arrives at each stop — transfer labels depend on mode
    //    (airport vs bus/train station), so they can't be built
    //    independently of the resolved transition.
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
          transfers: null, // filled in below, once transport-in is known
        };
      })
    );

    // 5. Attach the transition that arrives at each stop (and the
    //    final return transition) to the matching leg result.
    for (let i = 0; i < legResults.length; i++) {
      legResults[i].transportIn = this._formatTransportDisplay(
        transitions[i]?.transport,
        transitions[i]?.from,
        transitions[i]?.to
      );
      legResults[i].connectsVia = transitions[i]?.connectsVia || null;
      legResults[i].bufferNight = transitions[i]?.bufferNight || false;
    }

    // 5b. Now that each leg's actual arriving transport is known,
    //     build mode-aware transfer legs (origin -> hub, hub ->
    //     hotel) per stop. Buffer legs skip this — there's no
    //     "hotel transfer" purpose for an overnight connection
    //     stop, just the transport itself.
    await Promise.all(
      legResults.map(async (leg, i) => {
        if (leg.isBufferLeg) return;
        const legTripParams = {
          ...tripParams,
          origin: transitions[i]?.from || tripParams.origin,
          destination: leg.destination,
        };
        leg.transfers = await this._buildTransferLegs(legTripParams, transitions[i]?.transport);
      })
    );

    const finalReturnTransport = this._formatTransportDisplay(
      returnTransition?.transport,
      returnTransition?.from,
      returnTransition?.to
    );

    // 6. Sum everything into one combined KES total.
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

  // ─────────────────────────────
  // BUILD STOP SEQUENCE (with buffer-leg insertion)
  // ─────────────────────────────
  _buildStopSequence(origin, resolvedLegs, departureDate) {
    const stops = [];
    let cursorDate = departureDate || this._defaultStartDate();

    for (let i = 0; i < resolvedLegs.length; i++) {
      const current = resolvedLegs[i];
      const previous = i === 0 ? null : resolvedLegs[i - 1];

      // Insert a buffer leg in the origin city if either side of
      // this transition is an airstrip destination.
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

  // ─────────────────────────────
  // RESOLVE ONE TRANSITION (transport between two stops)
  // ─────────────────────────────
  async _resolveTransition(fromStop, toStop, tripParams) {
    const fromIsAirstrip = fromStop.isAirstripDestination;
    const toIsAirstrip   = toStop.isAirstripDestination;
    const origin = tripParams.origin || 'nairobi';

    // Airstrip-involved transitions always route via origin with a
    // labeled connection (buffer night already inserted as its own
    // stop upstream in _buildStopSequence — here we just label it).
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

    // Otherwise, try direct first.
    const direct = await this._searchCheapestDirect(fromStop.destination, toStop.destination, fromStop.checkOut, tripParams);
    if (direct) {
      return { from: fromStop.destination, to: toStop.destination, transport: direct, connectsVia: null, bufferNight: false };
    }

    // No direct route found — fall back via origin, labeled.
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

  // ─────────────────────────────
  // SEARCH + PICK CHEAPEST TRANSPORT FOR ONE TRANSITION
  // Reuses the existing supplierAdapter path used by
  // _searchFlights, just scoped to a single origin/destination
  // pair and date rather than a full leg search.
  // ─────────────────────────────
  async _searchCheapestDirect(fromCity, toCity, date, tripParams) {
    if (!supplierAdapter || !date) return null;

    try {
      const results = await supplierAdapter.searchTransport({
        origin:         fromCity,
        destination:    toCity,
        date,
        passengers:     tripParams.passengers || 1,
        transportMode:  'flight',
        timePreference: tripParams.timePreference,
      });

      return this._pickCheapest(results, r => r.price);
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

  // ─────────────────────────────
  // BUILD CLARIFICATION RESPONSE
  // Shared by all three "ask before searching" call sites in
  // orchestrate(). Tags the returned tripParams with
  // _awaitingClarification — a marker describing exactly what was
  // asked — so that when this gets saved as previousParams (see
  // webhooks.js's _saveConversationState) and the traveler's next
  // message comes in, orchestrate() can recognize it as an ANSWER
  // to a pending question rather than parsing it as a fresh prompt.
  // See _resumeClarification, which reads this marker.
  // ─────────────────────────────
  _buildClarificationResponse({ sessionId, prompt, question, tripParams, intent, conversationHistory, awaitingClarification }) {
    const taggedParams = { ...tripParams, _awaitingClarification: awaitingClarification };
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

  // ─────────────────────────────
  // RESUME A PENDING CLARIFICATION
  // previousParams carries _awaitingClarification (set by
  // _buildClarificationResponse on the PREVIOUS turn). This message
  // is the traveler's answer — fill in the specific missing field
  // based on awaitingClarification.type, then re-run orchestration
  // with the now-complete params. Does NOT call parsePrompt() on
  // this message at all — a one-word answer like "Zanzibar" has no
  // business going through full trip-prompt extraction, and doing
  // so risks Groq misreading it as an unrelated fresh search.
  //
  // The reply is taken at face value as a place name (lightly
  // cleaned), same "don't overthink it" posture as
  // webhooks.js's _extractName for the welcome-message flow — if
  // the traveler answers with something that clearly isn't a place
  // (empty, or matches no reasonable pattern), we fall back to
  // asking again rather than guessing.
  // ─────────────────────────────
  async _resumeClarification(prompt, agencyId, previousParams, conversationHistory, sessionId, channel) {
    const marker = previousParams._awaitingClarification;
    const answer = String(prompt || '').trim().toLowerCase();

    // A one-word/short-phrase clarification answer has no follow-up
    // signal worth detecting (it's not "show me cheaper options", it's
    // "Zanzibar") — use a neutral default intent rather than running
    // _detectIntent on text that was never meant to carry trip-search
    // semantics like budget/transport-mode preferences.
    const neutralIntent = { isFollowUp: false, adjustments: {}, productScope: { needsTransport: true, needsHotel: true, needsTransfers: true } };

    if (!answer) {
      // Empty/unusable reply — ask again rather than guess.
      const question = `Sorry, I didn't catch that — where will you be departing from?`;
      return this._buildClarificationResponse({
        sessionId, prompt, question, tripParams: previousParams,
        intent: neutralIntent,
        conversationHistory, awaitingClarification: marker,
      });
    }

    // Strip the same conversational filler _extractName guards
    // against, in case the traveler answers in full sentences
    // ("I'll be coming from Mombasa") rather than a bare place name.
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
      // Find the leg this question was about and fill in its origin.
      const targetIdx = tripParams.legs.findIndex(l => this._normalize(l.destination) === this._normalize(marker.destination));
      if (targetIdx !== -1) {
        tripParams.legs = tripParams.legs.map((leg, i) => i === targetIdx ? { ...leg, origin: resolvedOrigin } : leg);
      }
      if (!tripParams.origin) tripParams.origin = resolvedOrigin;
      tripParams.needsOriginClarification = false;
    }

    console.log("RESUMED CLARIFICATION — completed params:", tripParams);

    // Re-run orchestration with the now-complete params, exactly as
    // if this had been a fresh, fully-specified prompt — reuses every
    // existing code path (multi-dest classification, single-dest
    // search) rather than duplicating logic here.
    return this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, neutralIntent, channel);
  }

  // ─────────────────────────────
  // CONTINUE ORCHESTRATION WITH RESOLVED PARAMS
  // This is the single shared implementation of "given complete
  // tripParams, classify/search/return a result" — used by BOTH
  // orchestrate()'s normal flow (intent computed fresh there) AND
  // _resumeClarification's re-entry path once a pending question has
  // been answered. Kept as one method so the multi-destination/
  // single-destination branches are never maintained in two places.
  // intent and channel are passed in rather than recomputed/hardcoded
  // here, since the two callers have different sources for each
  // (orchestrate() already has a real intent from the original
  // message; _resumeClarification has no meaningful intent to detect
  // from a one-word clarification answer, so it passes a neutral
  // default — see _resumeClarification).
  // ─────────────────────────────
  async _continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, intent, channel) {
    tripParams.agencyId = agencyId;

    if (tripParams.isMultiDestination) {
      this._validateMultiDestinationParams(tripParams);

      if (tripParams.needsOriginClarification) {
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
      // Tracks the end date of whichever leg (continuous itinerary OR
      // independent trip) most recently ran, so the NEXT independent
      // leg with no date of its own can calculate "starts right after
      // the previous trip ends" instead of defaulting to some
      // unrelated date. Seeded from the overall tripParams.departureDate
      // (or today+14 if even that's missing) for the very first leg.
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
          // FIX: returnDate was never computed for independent legs —
          // only departureDate and nights were set. _runSingleDestinationSearch
          // (and orchestrate()/_continueOrchestration generally) only
          // searches a return leg when tripParams.returnDate is truthy,
          // so every independent leg silently came back outbound-only,
          // even when the traveler explicitly stated a nights count
          // (e.g. "Nairobi to Mombasa 3 nights ... Nairobi to Dar es
          // Salaam 4 nights" — both legs are round trips, but neither
          // got a return search).
          //
          // DATE CALCULATION: if this leg stated its own date, use it
          // verbatim — that's an explicit traveler instruction, never
          // overridden. If it didn't, calculate a sensible default
          // (right after the previous leg's trip ends) rather than
          // asking — but the assumption is always stated back to the
          // traveler in the result text, since silently picking dates
          // this consequential (wrong dates = wrong flights booked)
          // without saying so would be worse than asking.
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

    if (tripParams.needsOriginClarification) {
      const question = `Where will you be departing from for ${tripParams.destination ? this._titleCase(tripParams.destination) : 'your trip'}?`;
      return this._buildClarificationResponse({
        sessionId, prompt, question, tripParams, intent, conversationHistory,
        awaitingClarification: { type: 'single_origin' },
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
      channel: channel || 'widget',
    }).catch(err => logger.error('Failed to log search', { error: err.message }));

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
  // KNOWN REGIONAL HUBS
  // Used only as a fallback when a direct origin->destination
  // search returns nothing — e.g. "Meru to Diani" has no direct
  // flight/bus, but Nairobi->Diani does. This is a small, stable
  // list of real East African transport hubs, not something we
  // ask an LLM to guess at — hub geography doesn't change day to
  // day, so a maintained list is more reliable than a fresh
  // model call each time, and avoids the same hallucination risk we
  // guard against elsewhere (destinationIntel's IATA validation).
  // ─────────────────────────────
  static REGIONAL_HUBS = ['nairobi', 'mombasa', 'kampala', 'dar es salaam', 'addis ababa', 'kigali'];

  // ─────────────────────────────
  // SEARCH FLIGHTS WITH HUB-CONNECTING FALLBACK
  // Tries the direct origin->destination search first (unchanged
  // _searchFlights, untouched). Only if that returns nothing does
  // it attempt connecting via a known regional hub — trying each
  // hub in turn until one has real bookable legs on BOTH sides
  // (origin->hub AND hub->destination).
  //
  // If only the hub->destination leg is bookable (e.g. Meru->
  // Nairobi has no real flight/bus supplier — that's a matatu
  // route with nothing to book), this still returns the bookable
  // leg, but flags connectingLegBookable: false so callers (and
  // ultimately the traveler, via whatsapp.js/widget.js) are told
  // honestly that they need to arrange that first leg themselves
  // — never silently treated as if Bodrless arranged it.
  // ─────────────────────────────
  async _searchFlightsWithHubFallback(tripParams, leg = 'outbound') {
    const direct = await this._searchFlights(tripParams, leg);
    if (direct.length > 0) {
      return { results: direct, connectsVia: null, connectingLegBookable: true };
    }

    // FIX: the || '' fallback previously sat INSIDE one ternary branch
    // only (`tripParams.origin || ''`), so on a 'return' leg the other
    // branch (`tripParams.destination`) had no fallback at all — if it
    // was null (e.g. a single-word prompt like "Nairobi" with no real
    // destination resolved), this crashed with "Cannot read properties
    // of null (reading 'toLowerCase')" before ever reaching a normal
    // "no results" response. The fallback now wraps the whole ternary.
    const origin = ((leg === 'return' ? tripParams.destination : tripParams.origin) || '').toLowerCase();
    const destination = ((leg === 'return' ? tripParams.origin : tripParams.destination) || '').toLowerCase();

    for (const hub of OrchestrationEngine.REGIONAL_HUBS) {
      if (hub === origin || hub === destination) continue;

      const hubToDestParams = leg === 'return'
        ? { ...tripParams, destination: hub, origin: tripParams.destination }
        : { ...tripParams, origin: hub };

      const legFromHub = await this._searchFlights(hubToDestParams, leg);
      if (legFromHub.length === 0) continue; // this hub doesn't even reach the destination — try the next one

      const originToHubParams = leg === 'return'
        ? { ...tripParams, origin: tripParams.destination, destination: hub }
        : { ...tripParams, destination: hub };

      const legToHub = await this._searchFlights(originToHubParams, leg);

      console.log(`HUB FALLBACK (${leg}): trying ${origin} -> ${hub} -> ${destination} | toHub: ${legToHub.length}, fromHub: ${legFromHub.length}`);

      // The bookable leg is always hub->destination (that's the
      // real flight/bus we can sell). origin->hub is only included
      // if it's ALSO genuinely bookable — otherwise it's flagged
      // as the traveler's own responsibility (e.g. matatu).
      return {
        results: legFromHub,
        connectsVia: hub,
        connectingLegBookable: legToHub.length > 0,
      };
    }

    // No direct route AND no hub got us there either.
    return { results: [], connectsVia: null, connectingLegBookable: true };
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
        provider:            bus.provider,
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
    // FIX: previously gated on tripParams.departureDate being
    // truthy — if a traveler said "4 nights" with no explicit
    // date, departureDate stayed null and the entire HotelBeds
    // branch was silently skipped (no log, no error, just zero
    // hotels). Mirrors the [FLIGHT FALLBACK] pattern already
    // used in _searchFlights: default to tomorrow if no date
    // was given, rather than giving up on hotel search entirely.
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
      finalHotels = await this._filterHotelsByBudget(finalHotels, tripParams.budget);
    }

    console.log("MATCHED HOTELS:", finalHotels.length);

    return finalHotels;
  }

  async _filterHotelsByBudget(hotels, budget) {
    // Per-night price ranges in KES
    const ranges = {
      low:    { min: 0,     max: 8000   },
      mid:    { min: 5000,  max: 20000  },
      high:   { min: 15000, max: 50000  },
      luxury: { min: 40000, max: 9999999 },
    };
    const range = ranges[budget];
    if (!range) return hotels;

    // Convert each hotel's price to KES before comparing, since
    // Supabase hotels are already KES but HotelBeds returns EUR
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

  // ─────────────────────────────
  // TRANSFER LEGS — mode-aware, directional
  // Builds two transfer legs based on the ACTUAL transport mode
  // selected for this package:
  //   - departure: origin city -> transport hub (airport name
  //     from the flight result if available; generic "Bus
  //     Station"/"Train Station" label for bus/train, since we
  //     don't have verified real terminal names for those yet)
  //   - arrival: transport hub -> hotel at the destination
  //
  // Pricing still comes from the transfers table (agency-specific
  // rows first, falling back to shared/default rows with
  // agency_id IS NULL — see _getTransferRate below) — only the
  // pickup/dropoff LABELS are derived from the transport mode.
  // ─────────────────────────────
  async _buildTransferLegs(tripParams, transport) {
    if (!transport) return [];

    const mode = (transport.transportType || 'flight').toLowerCase();
    const originCity = tripParams.origin || 'Nairobi';
    const destCity    = tripParams.destination || transport.destination || 'your destination';

    let originHub, destHub;

    if (mode === 'bus') {
      originHub = `${this._titleCase(originCity)} Bus Station`;
      destHub   = `${this._titleCase(destCity)} Bus Station`;
    } else if (mode === 'train') {
      originHub = `${this._titleCase(originCity)} Train Station`;
      destHub   = `${this._titleCase(destCity)} Train Station`;
    } else {
      // flight — use the real airport name from the search result when available
      originHub = transport.originAirport || `${this._titleCase(originCity)} Airport`;
      destHub   = transport.destAirport   || `${this._titleCase(destCity)} Airport`;
    }

    const rate = await this._getTransferRate(tripParams);

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
        provider:    rate?.provider || 'Bodrless Standard Transfer',
        description: `${destHub} → Hotel`,
        pickup:      destHub,
        dropoff:     'Hotel',
        price:       rate?.price ?? 1500,
        currency:    rate?.currency || 'KES',
      },
    ];
  }

  _titleCase(str) {
    if (!str) return '';
    return String(str).replace(/\b\w/g, c => c.toUpperCase());
  }

  // ─────────────────────────────
  // TRANSFER RATE LOOKUP
  // Agency-specific rows first; falls back to shared/default
  // rows (agency_id IS NULL) when the agency has none of its
  // own — see earlier fix, same reasoning applies here.
  // ─────────────────────────────
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
        // NEW — surfaces the existing cancellationPolicy in the
        // same policySummary slot whatsapp.js/widget.js read from.
        // Buses have no baggage data anywhere upstream (IABIRI
        // doesn't return any), so baggageSummary stays null here
        // rather than guessing.
        policySummary:  t.cancellationPolicy || 'Cancellation policy not specified',
        baggageSummary: null,
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
      // NEW — derived purely from fields TravelDuqa already gives
      // us (checkedBags/carryOn/canBook/canHold). See
      // _formatBaggageSummary/_formatFlightPolicySummary below.
      baggageSummary: this._formatBaggageSummary(t.checkedBags, t.carryOn),
      policySummary:  this._formatFlightPolicySummary(t.canBook, t.canHold),
    };
  }

  // ─────────────────────────────
  // BAGGAGE SUMMARY (flights)
  // checkedBags/carryOn are quantities from TravelDuqa's baggage
  // array (see adapters/travelduqa.js _normalizeOffers) — both
  // default to 0 there, not null, so 0 is a real "none included"
  // answer, not a missing-data signal.
  // ─────────────────────────────
  _formatBaggageSummary(checkedBags, carryOn) {
    const checked = Number(checkedBags) || 0;
    const carry   = Number(carryOn)     || 0;

    if (checked === 0 && carry === 0) return 'No checked or carry-on baggage included';

    const parts = [];
    if (checked > 0) parts.push(`${checked} checked bag${checked > 1 ? 's' : ''}`);
    if (carry   > 0) parts.push(`${carry} carry-on${carry > 1 ? 's' : ''}`);
    return parts.join(', ');
  }

  // ─────────────────────────────
  // POLICY SUMMARY (flights)
  // TravelDuqa doesn't return real cancellation/change-fee terms
  // in this adapter — only canBook/canHold. We surface those facts
  // honestly plus a disclaimer, rather than inventing refund terms
  // we don't actually have.
  // ─────────────────────────────
  _formatFlightPolicySummary(canBook, canHold) {
    const bookingNote = canHold
      ? 'Hold available'
      : canBook
        ? 'Instant booking only'
        : 'Booking availability unconfirmed';
    return `${bookingNote} · Subject to airline fare rules`;
  }

  // ─────────────────────────────
  // BUILD PACKAGES
  // All cross-supplier prices are converted to KES (canonical
  // currency) before being summed, since TravelDuqa/Supabase
  // return KES but HotelBeds returns EUR. Each line item also
  // keeps its original price + currency for transparent display
  // ("flight: KES 5,900 | hotel: €450 → KES 67,950").
  // ─────────────────────────────
  async _buildPackages({ outboundTransport, returnTransport, hotels, tripParams, intent, connectionInfo }) {
    const scope = intent?.productScope || { needsTransport: true, needsHotel: true, needsTransfers: true };

    const hasOutbound  = outboundTransport.length > 0;
    const hasReturn    = returnTransport.length   > 0;
    const hasHotels    = hotels.length            > 0;

    if (!hasOutbound && !hasHotels) {
      console.log("NO INVENTORY FOUND");
      return [];
    }

    // === TRANSPORT ONLY ===
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

    // === FULL PACKAGE LOGIC ===
    const packages = [];
    const maxItems = Math.max(
      scope.needsTransport  ? outboundTransport.length : 0,
      scope.needsHotel      ? hotels.length            : 0,
      1
    );

    const startIndex = tripParams.showAlternatives ? 1 : 0;

    for (let i = 0; i < maxItems; i++) {
      const ob       = hasOutbound  && scope.needsTransport  ? outboundTransport[(i + startIndex) % outboundTransport.length] : null;
      const ret      = hasReturn    && scope.needsTransport  ? returnTransport[(i  + startIndex) % returnTransport.length]    : null;
      const hotel    = hasHotels    && scope.needsHotel      ? hotels[(i    + startIndex) % hotels.length]                    : null;

      if (!ob && !hotel) continue;

      const nights = tripParams.nights || 1;

      // Transfer legs depend on which transport mode was actually
      // selected for THIS package (ob), so they're built per-package
      // rather than pre-fetched once for the whole search.
      const transferLegs = scope.needsTransfers
        ? await this._buildTransferLegs(tripParams, ob)
        : [];
      const transferTotal = transferLegs.reduce((sum, leg) => sum + (leg.price || 0), 0);
      const transferCurrency = transferLegs[0]?.currency || 'KES';

      const totalPrice = await sumToKES([
        { amount: ob?.price,                              currency: ob?.currency       || 'KES' },
        { amount: ret?.price,                             currency: ret?.currency      || 'KES' },
        { amount: (hotel?.pricePerNight || 0) * nights,    currency: hotel?.currency    || 'KES' },
        { amount: transferTotal,                           currency: transferCurrency },
      ]);

      packages.push({
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
        },
        transport:       this._formatTransportDisplay(ob,  tripParams.origin,      tripParams.destination),
        returnTransport: this._formatTransportDisplay(ret, tripParams.destination, tripParams.origin),
        hotel,
        transfers: transferLegs,
        // Connection advisory — only present when the outbound/return
        // leg required connecting via a regional hub AND that
        // connecting leg (origin -> hub) has no real supplier
        // behind it (e.g. Meru -> Nairobi is matatu-only). Never
        // silently implies Bodrless arranged a leg it didn't.
        connectionAdvisory: this._buildConnectionAdvisory(tripParams, connectionInfo),
        status: "available",
      });
    }

    return packages;
  }

  // ─────────────────────────────
  // BUILD CONNECTION ADVISORY TEXT
  // ─────────────────────────────
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