const { v4: uuidv4 } = require("uuid");
const supabase = require("../utils/supabase");
const { logger } = require("../utils/logger");
const { parsePrompt, resolveCountryToCity } = require("./promptParser");
const { rankPackages } = require("./packageRanker");
const { toKES, sumToKES, CANONICAL_CURRENCY } = require("../utils/currency");
const destinationIntel = require("../services/destinationIntel");
const tracking = require("../services/trackingService");
const travelerIntelligence = require("../services/travelerIntelligence");

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
  // LATENCY BUDGET
  // Every external supplier call is wrapped in _withTimeout so a
  // single slow/hung supplier can't blow the overall response-time
  // budget. On timeout the call resolves to a safe fallback (the
  // same shape a "no results" response returns — usually [] or null)
  // rather than rejecting, so a missing supplier DEGRADES results
  // instead of failing the whole search. Because outbound/return/
  // hotel searches all run in parallel, this per-call ceiling keeps
  // the total comfortably under the 30s target even in the worst
  // case.
  //
  // This is a BACKSTOP, not the primary timeout. Each adapter sets
  // its own (shorter) HTTP timeout — e.g. TravelDuqa's search is 9s
  // (TRAVELDUQA_SEARCH_TIMEOUT_MS) — and should fail fast on its own,
  // logging a precise reason. This 10s wrapper sits just ABOVE that
  // so it only fires if an adapter's own timeout somehow doesn't
  // (hung socket, an adapter with no timeout configured, etc.).
  // Keep this >= the largest adapter search timeout, or you'll cut
  // off adapters mid-request and lose results they were about to
  // return. Tune via SUPPLIER_TIMEOUT_MS on Render.
  //
  // NOTE: JS can't truly cancel the underlying request; on timeout
  // we simply stop waiting for it. The clearTimeout prevents the
  // timer leaking once the real call settles.
  // ─────────────────────────────
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

    // If the real promise settles first, clear the timer and pass its
    // value/error straight through (so existing try/catch at each call
    // site still sees real rejections exactly as before). If the timer
    // wins, the call site sees `fallback` and carries on.
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
        return await this._resumeClarification(prompt, agencyId, previousParams, conversationHistory, sessionId, context.channel, context.phone);
      }

      const intent = this._detectIntent(prompt, previousParams);

      let tripParams;

      if (intent.isFollowUp && previousParams) {
        tripParams = this._adjustParams(previousParams, intent);
        tripParams.agencyId = agencyId;
        // Normalize country names in cached params — previousParams can
        // carry a raw country name (e.g. "rwanda") from a prior failed
        // search, and _adjustParams copies it through unchanged. Apply
        // the same country→city resolution the parser applies to fresh
        // prompts so a follow-up doesn't re-use a broken cached value.
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

      // Multi-destination classification, single-destination search,
      // clarification-question handling — all shared with
      // _resumeClarification's re-entry path. See _continueOrchestration.
      return await this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, intent, context.channel, context.phone);

    } catch (error) {
      // NEVER dead-end the traveler. Whatever went wrong — a parser
      // crash, an unexpected supplier response shape, a malformed
      // params object — we log it in full for engineers but hand the
      // traveler an actionable next step instead of throwing (which
      // the caller would surface as a generic failure / nothing at
      // all). This is the master safety net behind every other
      // graceful-degradation path below.
      logger.error("Engine failure — returning graceful fallback instead of throwing", {
        sessionId, error: error.message, stack: error.stack,
      });

      // Alert immediately — an engine crash means someone got no results
      // at all and we have no idea why unless we log it.
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
        // Drop any pending-clarification marker so the next message is
        // parsed fresh rather than mis-applied to a half-built state.
        tripParams: null,
        intent: null,
        conversationHistory,
        generatedAt: new Date().toISOString(),
        degraded: true,
      };
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

    // [TIMING] Wall-clock around the parallel supplier-search phase. These
    // logs show up in Render and tell you exactly where the seconds go on
    // real traffic — search phase vs package-build phase. Remove or lower
    // to logger.debug once latency is comfortably within budget.
    const _tSearch = Date.now();

    const [
      outboundResult, outboundBuses,
      returnResult, returnBuses,
      hotelResults
    ] = await Promise.all([
      this._searchFlightsWithHubFallback(tripParams, 'outbound'),
      this._searchBuses(tripParams, 'outbound'),
      tripParams.returnDate ? this._searchFlightsWithHubFallback(tripParams, 'return') : Promise.resolve({ results: [], connectsVia: null, connectingLegBookable: true }),
      tripParams.returnDate ? this._searchBuses(tripParams, 'return') : Promise.resolve([]),
      this._searchHotels(tripParams),
    ]);

    console.log(`[TIMING] single-dest supplier search (${tripParams.destination}): ${Date.now() - _tSearch}ms`);

    let outboundTransport = [...outboundResult.results, ...outboundBuses];
    let returnTransport   = [...returnResult.results,   ...returnBuses];
    let hotels = hotelResults;

    console.log("FINAL OUTBOUND TRANSPORT:", outboundTransport.length, outboundResult.connectsVia ? `(via ${outboundResult.connectsVia})` : '');
    console.log("FINAL RETURN TRANSPORT:",   returnTransport.length, returnResult.connectsVia ? `(via ${returnResult.connectsVia})` : '');
    console.log("FINAL HOTELS:",             hotels.length);

    // ─────────────────────────────
    // PREFERRED TRANSPORT PROVIDER / HOTEL FILTERING
    // If the traveler named a specific airline, bus company, train
    // operator, or hotel, narrow results to that provider FIRST,
    // before building packages — "build around that" per how this
    // was requested, not just a ranking nudge. If narrowing empties
    // the list (genuinely not available on this route/destination),
    // fall back to the full unfiltered list rather than returning
    // nothing, but flag this honestly in the response text so the
    // traveler isn't left thinking their preference was honored when
    // it wasn't. See _filterByProvider/_filterHotelsByName below.
    // ─────────────────────────────
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

    // ─────────────────────────────────────────────
    // TRAVELER INTELLIGENCE
    // Derives a per-prompt traveler profile (budget sensitivity,
    // refund sensitivity, time-criticality, transfer tolerance, etc.)
    // purely from the prompt text + already-parsed tripParams — no
    // LLM call, no cross-request learning, fully deterministic. The
    // resulting profile feeds packageRanker as an ADDITIVE bonus on
    // top of the existing fixed-budget scoring (budget fit/hotel/
    // transport/transfers) — it can nudge ranking toward what this
    // traveler seems to actually want, but can never override or
    // distort the core scoring categories already tuned earlier.
    // Wrapped defensively: a bug here must never break a real search,
    // it should just silently fall back to profile-less ranking
    // (which is exactly today's current behavior).
    // ─────────────────────────────────────────────
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
      // Never leave the traveler at a flat dead end. Suggest places the
      // agency can ACTUALLY fulfil right now (pulled from their own
      // inventory — real, bookable, honest — not invented), plus the
      // option to adjust dates. If we can't even fetch suggestions, fall
      // back to a plain but still actionable nudge.
      const suggestions = await this._suggestAvailableDestinations(tripParams.agencyId, tripParams.destination);
      const dest = this._titleCase(tripParams.destination);
      responseText = suggestions.length > 0
        ? `I couldn't find availability for ${dest} on those dates. I can put a trip together to one of these right now: ${suggestions.join(', ')}. Want me to try one of those, or adjust your dates?`
        : `I couldn't find availability for ${dest} on those dates. Try shifting your dates or naming a nearby city and I'll search again.`;
    }

    return { text: responseText, packages: rankedPackages };
  }

  // ─────────────────────────────
  // SUGGEST AVAILABLE DESTINATIONS
  // Last-resort honesty helper: when a search returns zero options, we
  // still want to hand the traveler something actionable. This pulls a
  // handful of destinations the agency genuinely has inventory for (from
  // their own hotels table), so the suggestion is real and bookable —
  // never a fabricated "we have flights to X" claim. Runs ONLY on the
  // zero-result path, so it adds no latency to normal searches, and is
  // fully wrapped so it can never itself throw or dead-end the response.
  // NOTE: uses the hotels table as the proxy for "destinations this
  // agency serves"; extend to the flights table too if you curate
  // transport-only destinations separately.
  // ─────────────────────────────
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

  // ─────────────────────────────
  // FILTER TRANSPORT BY PREFERRED PROVIDER
  // Built defensively for REAL supplier data, not just the airline
  // field's exact display name — TravelDuqa/IABIRI responses vary in
  // ways synthetic testing can't fully anticipate:
  //   - Airline CODE vs name: a traveler might type "EK" or "Emirates"
  //     — both should match. t.airlineCode (IATA code, set by
  //     adapters/travelduqa.js's _normalizeOffers) is checked
  //     alongside t.airline/t.provider.
  //   - Word order / extra words in provider names: "Buscar Dreamline"
  //     should still match "Buscar Dreamline Express", and in
  //     principle a differently-ordered real-world listing too —
  //     tokenized matching (every word in the shorter name appears
  //     somewhere in the longer one) is more forgiving than a single
  //     substring check.
  // This is a best-effort match, not a guarantee — once live inventory
  // is plugged in, watch for cases where a real provider name doesn't
  // match and the alias needs adding explicitly (see _PROVIDER_ALIASES).
  // ─────────────────────────────
  _filterByProvider(transportList, preferredProvider) {
    const target = this._normalize(preferredProvider);
    if (!target) return transportList;
    const targetTokens = target.split(' ').filter(Boolean);
    const aliasTargets = this._expandProviderAliases(target);

    return transportList.filter(t => {
      const providerName = this._normalize(t.airline || t.provider || '');
      const providerCode = this._normalize(t.airlineCode || '');

      // Direct substring match either direction (handles the common
      // case cheaply: "emirates" in "emirates airlines").
      if (providerName && (providerName.includes(target) || target.includes(providerName))) return true;

      // Code match: traveler typed the IATA/provider code directly.
      if (providerCode && (providerCode === target || target.includes(providerCode))) return true;

      // Tokenized match: every word in the shorter name appears
      // somewhere in the longer one, regardless of order — catches
      // "Buscar Dreamline" vs "Buscar Dreamline Express Coach".
      const providerTokens = providerName.split(' ').filter(Boolean);
      if (targetTokens.length > 0 && providerTokens.length > 0) {
        const [shorter, longer] = targetTokens.length <= providerTokens.length
          ? [targetTokens, providerTokens]
          : [providerTokens, targetTokens];
        if (shorter.every(tok => longer.includes(tok))) return true;
      }

      // Known alias match (e.g. "KQ" <-> "Kenya Airways").
      if (aliasTargets.some(alias => providerName.includes(alias) || providerCode === alias)) return true;

      return false;
    });
  }

  // ─────────────────────────────
  // KNOWN PROVIDER ALIASES
  // Small, explicit, maintained list for common East African /
  // international carriers a traveler is likely to abbreviate. NOT
  // meant to be exhaustive — extend this as real misses turn up
  // against live inventory, the same way REGIONAL_HUBS and CITY_CODES
  // are maintained lists rather than something inferred on the fly.
  // ─────────────────────────────
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

  // ─────────────────────────────
  // FILTER HOTELS BY PREFERRED NAME
  // Same tokenized-matching posture as _filterByProvider, for the
  // same reason — real hotel listings (HotelBeds especially) vary in
  // word order and add location suffixes ("JW Marriott Hotel
  // Nairobi" vs a traveler typing "JW Marriott").
  // ─────────────────────────────
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
    // Each transition's endpoints come ENTIRELY from the precomputed
    // `stops` array (the transport RESULT of one leg never feeds into
    // the next — only stop metadata like destination/checkOut/airstrip
    // flag does), so every transition plus the final return leg can be
    // resolved CONCURRENTLY instead of one-at-a-time. For a 3-stop
    // itinerary that's 4 sequential supplier searches collapsed into a
    // single parallel wave. transitions[i] still lines up with stops[i]
    // exactly as before (Promise.all preserves order).
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
      // Final leg home — transport arriving back at origin after the last stop.
      this._resolveTransition(
        lastStop,
        { destination: origin, checkIn: lastStop.checkOut, isAirstripDestination: false },
        tripParams
      ),
    ]);
    console.log(`[TIMING] multi-dest transitions (${stops.length} stops + return): ${Date.now() - _tTransitions}ms`);

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
  // CHILD-AGE CLARIFICATION CHECK
  // Returns { question, missing } when a child was declared without an
  // age (childAges shorter than the children count), else null. HotelBeds
  // requires an age for every child to price a room and to keep the
  // searched rate valid through to booking, so we ask rather than guess.
  // ─────────────────────────────
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
  async _resumeClarification(prompt, agencyId, previousParams, conversationHistory, sessionId, channel, phone = null) {
    const marker = previousParams._awaitingClarification;
    const answer = String(prompt || '').trim().toLowerCase();

    // A one-word/short-phrase clarification answer has no follow-up
    // signal worth detecting (it's not "show me cheaper options", it's
    // "Zanzibar") — use a neutral default intent rather than running
    // _detectIntent on text that was never meant to carry trip-search
    // semantics like budget/transport-mode preferences.
    const neutralIntent = { isFollowUp: false, adjustments: {}, productScope: { needsTransport: true, needsHotel: true, needsTransfers: true } };

    if (!answer) {
      // Empty/unusable reply — ask again rather than guess. Word the
      // reprompt to match what we actually asked for.
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

    // ── DESTINATION answer ───────────────────────────────────
    // Answer to "where would you like to travel to?" — take it at
    // face value as a place name (lightly cleaned of "to/go to/visit"
    // lead-ins), the same don't-re-parse posture used for origins.
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

    // ── CHILD AGE answer ─────────────────────────────────────
    // Answer to "how old is the child?" — pull the number(s) out of
    // the reply ("7", "she's 7", "5 and 8") and append to childAges.
    // If ages are still missing afterwards, _continueOrchestration's
    // child-age gate will simply ask again for the remainder.
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
        // Still missing at least one age — ask for the rest.
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
    return this._continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, neutralIntent, channel, phone);
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
  async _continueOrchestration(tripParams, agencyId, prompt, conversationHistory, sessionId, intent, channel, phone = null) {
    tripParams.agencyId = agencyId;

    if (tripParams.isMultiDestination) {
      // Don't let malformed multi-destination params (fewer than 2
      // legs, a leg missing a destination) throw and dead-end the
      // traveler. If validation fails, salvage: if at least one leg
      // has a real destination, fall through to a normal single-
      // destination search on the first usable leg; otherwise ask
      // the traveler to restate their trip.
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
          // fall through to the single-destination path below.
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

    // If we couldn't pin down WHERE the traveler wants to go (a long,
    // rambling, or ambiguous prompt the parser couldn't resolve a
    // destination from), ask for it rather than letting
    // _validateTripParams throw "Missing destination" and dead-end.
    if (!tripParams.destination) {
      return this._buildClarificationResponse({
        sessionId, prompt,
        question: "I want to get this right — where would you like to travel to?",
        tripParams: { ...tripParams, _awaitingClarification: undefined },
        intent, conversationHistory,
        awaitingClarification: { type: 'destination' },
      });
    }

    if (tripParams.needsOriginClarification) {
      const question = `Where will you be departing from for ${tripParams.destination ? this._titleCase(tripParams.destination) : 'your trip'}?`;
      return this._buildClarificationResponse({
        sessionId, prompt, question, tripParams, intent, conversationHistory,
        awaitingClarification: { type: 'single_origin' },
      });
    }

    // Child-age gate: HotelBeds needs every child's age at search time to
    // return a rate that will still be valid at booking (a child with no
    // age can't be priced, and an age guessed here would later clash with
    // the real DOB). So if a child was mentioned without an age, ask for
    // the missing one(s) before searching rather than guessing.
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

    // Log full conversation turn for visibility + debugging
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

    // Alert when a search returns nothing — could be a supplier issue,
    // a destination we can't serve, or a bad parse.
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

  // ─────────────────────────────
  // LOG SEARCH TO SUPABASE
  // ─────────────────────────────
  async _logSearch({ sessionId, agencyId, prompt, tripParams, packagesReturned, packages = [], channel }) {
    try {
      // ── Preferred provider tracking ───────────────────
      // preferredTransportProvider is parsed live and used for
      // matching during the search, but never persisted until now.
      // We write it here — alongside mode and a fulfillment flag —
      // so the admin dashboard can show "top requested providers"
      // split by mode (flights/buses/trains), with requested vs
      // actually-fulfilled counts side by side. That split surfaces
      // real supplier gaps: a provider requested 20x but fulfilled
      // only 3x is a clear inventory problem worth acting on.
      const preferredProvider = tripParams.preferredTransportProvider
        ? tripParams.preferredTransportProvider.toLowerCase().trim()
        : null;

      // Derive transport mode from the parsed trip. outboundTransportMode
      // is the explicit mode if the traveler said "bus" or "flight";
      // otherwise we infer from IATA codes (has IATA codes = flight-likely).
      // Stored as 'flight'/'bus'/'train'/null — matches the migration CHECK
      // constraint exactly so Supabase doesn't reject the row.
      let preferredMode = null;
      if (preferredProvider) {
        if (tripParams.outboundTransportMode) {
          preferredMode = tripParams.outboundTransportMode; // 'flight'/'bus'/'train'
        } else if (tripParams.requiresFlight) {
          preferredMode = 'flight';
        } else if (tripParams.requiresBus) {
          preferredMode = 'bus';
        }
      }

      // Fulfillment: did the named provider actually appear in the
      // packages we returned? Checks airline name + airlineCode on
      // transport (Duffel/TravelDuqa shape) — case-insensitive,
      // partial-match tolerant so "Emirates" matches "Emirates
      // Airlines" without needing an exact string. null when no
      // provider was requested (not false — false would mean "was
      // requested but not fulfilled", null means "n/a").
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

  // ─────────────────────────────
  // DETECT INTENT
  // ─────────────────────────────
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

    // FIX: a prompt like "Nairobi to Mombasa 3 nights then Nairobi to
    // Kampala 4 nights" matched the \d+\s*nights?\ follow-up regex
    // above purely because it contains "3 nights"/"4 nights" — but
    // it's a complete, self-contained NEW trip request with its own
    // origin/destination, not a tweak to a previous search. Treating
    // it as a follow-up meant _adjustParams only updated nights/budget
    // on the OLD destination from previousParams, silently keeping a
    // stale destination from an earlier conversation (e.g. a prior
    // Dar es Salaam search) instead of the traveler's actual new
    // Kampala request.
    //
    // A prompt containing its own "X to Y" / "from X to Y" structure
    // — once or, for multi-destination, more than once — is a strong,
    // self-sufficient fresh-trip signal that should override an
    // incidental follow-up-style word match. This is intentionally
    // conservative (requires the actual "to"/"from...to" shape, not
    // just any place name) so a genuine follow-up like "actually make
    // it 5 nights" doesn't get misclassified just because some other
    // part of a multi-turn conversation mentioned "to" once.
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

    // Fire every candidate hub's "hub -> destination" search CONCURRENTLY
    // instead of walking them one at a time. The old sequential loop could
    // do up to 6 hubs x 2 calls = 12 supplier round-trips back-to-back —
    // the single biggest latency source in the engine. We then pick the
    // first hub IN PRIORITY ORDER (REGIONAL_HUBS order, preserved by
    // Promise.all keeping array order) that actually reached the
    // destination, and only THEN do that one hub's "origin -> hub" search
    // to set connectingLegBookable. Net: ~2 parallel waves instead of up
    // to ~12 sequential calls, with identical results and identical
    // hub-priority semantics to before.
    const candidateHubs = OrchestrationEngine.REGIONAL_HUBS.filter(
      (hub) => hub !== origin && hub !== destination
    );

    const fromHubResults = await Promise.all(
      candidateHubs.map((hub) => {
        const hubToDestParams = leg === 'return'
          ? { ...tripParams, destination: hub, origin: tripParams.destination }
          : { ...tripParams, origin: hub };
        return this._searchFlights(hubToDestParams, leg)
          .then((results) => ({ hub, results }))
          .catch((err) => {
            logger.error('Hub fallback leg search failed', { hub, leg, error: err.message });
            return { hub, results: [] };
          });
      })
    );

    // First hub (in priority order) with real bookable legs to the destination.
    const winner = fromHubResults.find((r) => r.results.length > 0);
    if (winner) {
      const originToHubParams = leg === 'return'
        ? { ...tripParams, origin: tripParams.destination, destination: winner.hub }
        : { ...tripParams, destination: winner.hub };

      const legToHub = await this._searchFlights(originToHubParams, leg);

      console.log(`HUB FALLBACK (${leg}): ${origin} -> ${winner.hub} -> ${destination} | toHub: ${legToHub.length}, fromHub: ${winner.results.length}`);

      // The bookable leg is always hub->destination (that's the real
      // flight/bus we can sell). origin->hub is only included if it's
      // ALSO genuinely bookable — otherwise it's flagged as the
      // traveler's own responsibility (e.g. matatu).
      return {
        results: winner.results,
        connectsVia: winner.hub,
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

    // NOTE: Supabase static flight inventory removed — all agencies
    // now use live supplier inventory (TravelDuqa + Duffel in parallel).
    // The old static `flights` table lookup has been removed since it
    // always returned 0 results for live agencies and added unnecessary
    // latency before the real supplier search ran.

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
      const buses = await this._withTimeout(
        supplierAdapter.searchTransport({
          origin:        searchOrigin,
          destination:   searchDestination,
          date:          searchDate,
          passengers:    tripParams.passengers,
          transportMode: 'bus',
          timePreference: tripParams.timePreference,
        }),
        [],
        `bus ${leg} ${searchOrigin}->${searchDestination}`
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

    // NOTE: Supabase static hotel inventory removed — all agencies
    // now use live HotelBeds inventory. The old static `hotels` table
    // lookup has been removed since live agencies have no rows there
    // and it added an unnecessary Supabase query before HotelBeds ran.

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
            // ROOM COUNT: use explicitly stated room count from the prompt
            // (e.g. "two single rooms" → rooms=2), otherwise default to 1.
            // When roomType is 'single', each room holds 1 adult — so
            // "two single rooms" means 2 rooms × 1 adult each, not 1 room
            // with 2 adults. HotelBeds' occupancy will correctly produce
            // separate room+pax entries for multi-room bookings.
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
      // FIX: ?? not || — a real 0 (non-stop) was being turned into
      // null by `t.stops || null` (since 0 is falsy), so the ranker's
      // `stops === 0` direct-flight bonus never fired and non-stop
      // flights silently lost their +10. ?? only falls back on
      // null/undefined, preserving a genuine 0.
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

    // Build every package CONCURRENTLY rather than one at a time. Each
    // iteration independently does a transfer-rate lookup (Supabase) and
    // currency conversion (sumToKES) — running them sequentially meant N
    // packages = N round-trips back-to-back. Order doesn't matter here
    // since rankPackages re-sorts by score downstream. Skipped slots
    // (no transport AND no hotel) return null and are filtered out, exactly
    // mirroring the old `continue`.
    // NOTE: _buildTransferLegs re-queries the same agency transfer rate on
    // every package even though that rate is constant across packages in a
    // single search — a future win is to fetch it once and pass it in, but
    // that touches the shared _buildTransferLegs signature (also called by
    // multi-dest), so it's left for a deliberate follow-up rather than this
    // latency pass.
    const built = await Promise.all(
      Array.from({ length: maxItems }, (_, i) => i).map(async (i) => {
        const ob    = hasOutbound && scope.needsTransport ? outboundTransport[(i + startIndex) % outboundTransport.length] : null;
        const ret   = hasReturn   && scope.needsTransport ? returnTransport[(i + startIndex) % returnTransport.length]    : null;
        const hotel = hasHotels   && scope.needsHotel     ? hotels[(i + startIndex) % hotels.length]                      : null;

        if (!ob && !hotel) return null;

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
            // Occupancy actually searched — carried so bookingService can
            // detect a DOB/age drift at booking time and re-fetch a valid
            // rateKey (see the HotelBeds search/booking age-match rules).
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
          // Connection advisory — only present when the outbound/return
          // leg required connecting via a regional hub AND that
          // connecting leg (origin -> hub) has no real supplier
          // behind it (e.g. Meru -> Nairobi is matatu-only). Never
          // silently implies Bodrless arranged a leg it didn't.
          connectionAdvisory: this._buildConnectionAdvisory(tripParams, connectionInfo),
          status: "available",
        };
      })
    );

    packages.push(...built.filter(Boolean));

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