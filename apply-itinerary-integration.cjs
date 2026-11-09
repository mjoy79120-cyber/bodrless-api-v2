// Wires the multi-stop itinerary builder, arrival/departure advice and flight alternatives into your engine + parser.
// Usage (repo root):  node apply-itinerary-integration.cjs src/orchestration/engine.js src/orchestration/promptParser.js
// Copy itineraryBuilder.js, arrivalBuffer.js and alternativesPlanner.js into the SAME folder first.
const fs = require('fs'), path = require('path');
const u = (s) => s.replace(/§/g, '`').replace(/¤\{/g, '${'); // § = backtick, ¤{ = ${  (keeps this file readable)
const [enginePath, parserPath] = process.argv.slice(2);
if (!enginePath || !parserPath) { console.error('Usage: node apply-itinerary-integration.cjs <engine.js> <promptParser.js>'); process.exit(1); }
const dir = path.dirname(enginePath);
for (const m of ['itineraryBuilder.js', 'arrivalBuffer.js', 'alternativesPlanner.js']) {
  if (!fs.existsSync(path.join(dir, m))) { console.error('Missing ' + m + ' next to engine.js. Copy it there first.'); process.exit(1); }
}
if (path.dirname(parserPath) !== dir) console.warn('Warning: promptParser.js is not in the same folder as engine.js; its require("./itineraryBuilder") will break.');

const E5 = u(String.raw`
    // [itinerary-builder] multi-stop prompts: build every date deterministically from stops
    if (Array.isArray(tripParams.stops) && tripParams.stops.length && intent?.productScope?.needsTransport !== false) {
      const { buildItinerary } = require('./itineraryBuilder');
      const _ask = (question, type) => this._buildClarificationResponse({
        sessionId, prompt, question, tripParams, intent, conversationHistory,
        awaitingClarification: type ? { type } : null,
      });
      if (!tripParams.origin) return _ask('Where will you be flying from?', 'single_origin');
      if (!tripParams.departureDate) {
        return _ask(§What date do you leave ¤{this._titleCase(tripParams.origin)}? A rough date works.§, 'departure_date');
      }
      const _plan = buildItinerary({
        origin: tripParams.origin,
        finalDestination: tripParams.finalDestination || tripParams.origin,
        departureDate: tripParams.departureDate,
        stops: tripParams.stops,
        arrivalOffsetDays: tripParams.arrivalOffsetDays,
      });
      if (!_plan.ok) {
        logger.warn('Itinerary build failed', { errors: _plan.errors });
        return _ask('I want to get the stops right. Could you list each place and how many nights at each? For example: "2 nights Nairobi, 5 nights Maasai Mara, 1 night Nairobi".', null);
      }
      tripParams = {
        ...tripParams, trips: _plan.trips, destination: _plan.trips[0].destination, nights: _plan.trips[0].nights,
        returnDate: _plan.returnDate, isMultiDestination: false, legs: undefined,
        _itineraryBuilt: true, _itineraryAssumptions: _plan.assumptions,
      };
    }`);

const LEG_ADVISORY = u(String.raw`// [itinerary-builder] timing advice per leg (early arrival, late departure)
  _legAdvisory(role, leg, transport) {
    try {
      if (!transport || (transport.transportType || 'flight') !== 'flight') return '';
      const ab = require('./arrivalBuffer');
      const ea = OrchestrationEngine.EA_BUS_CITIES;
      const intl = !(ea.has(this._normalizeCity(leg.origin)) && ea.has(this._normalizeCity(leg.destination)));
      const adv = role === 'arrival' ? ab.hotelCheckInAdvisory({ arrivalISO: transport.arrivalTime, international: intl })
        : role === 'departure' ? ab.departureAdvisory({ departureISO: transport.departureTime, international: intl }) : null;
      return adv && adv.message ? '\n\n_⏰ ' + adv.message + '_' : '';
    } catch (e) { return ''; }
  }

  `);

const ALT_A = u(String.raw`const _alt0 = require('./alternativesPlanner').suggestFlightAlternatives({ provider: tripParams.preferredTransportProvider, time: tripParams.preferredTime, flights: _allOutbound });
        unavailableProviderNote = _alt0 ? _alt0.text : (§¤{tripParams.preferredTransportProvider} isn't available on this route, so here are the available options instead.§);
        if (_alt0) outboundTransport = [..._alt0.options, ...outboundTransport.filter(t => !_alt0.options.includes(t))];`);

const ALT_B = u(String.raw`// [flight-alternatives] an exact-time request that no flight satisfies: offer the closest real options
    if (tripParams.preferredTime && !unavailableProviderNote) {
      const _alt = require('./alternativesPlanner').suggestFlightAlternatives({ provider: tripParams.preferredTransportProvider, time: tripParams.preferredTime, flights: _allOutbound });
      if (_alt) {
        unavailableProviderNote = _alt.text;
        outboundTransport = [..._alt.options, ...outboundTransport.filter(t => !_alt.options.includes(t))];
      }
    }

    if (tripParams.preferredHotel) {`);

const P1 = `═══ MULTI-STOP RULES ═══
If the user names 2+ stops, or flies home to a different city than they left from:
- fill "stops" in order, one entry per visit, repeating a city if they return to it:
  [{"city":"Nairobi","nights":2},{"city":"Maasai Mara","nights":5},{"city":"Nairobi","nights":1}]
- "finalDestination" = the city they fly home to ("Houston"). null if same as origin.
- "departureDate" = the day they leave origin. NEVER compute any other date.
- nights are integers. "N days" at a stop = N nights.
- leave "trips" null and "legs" [] for these prompts.

═══ CHILD RULES ═══`;

const P3 = u(String.raw`raw._freshScore = freshScore;

  // [itinerary-builder] multi-stop prompts: stops + finalDestination drive the whole timeline
  {
    const { parseStopsWithRules } = require('./itineraryBuilder');
    const _tc = (s) => String(s || '').trim().replace(/\b\w/g, (c) => c.toUpperCase());
    if (!Array.isArray(raw.stops) || raw.stops.length < 2) {
      const rs = parseStopsWithRules(prompt);
      if (rs.stops.length >= 2) { raw.stops = rs.stops; raw.finalDestination = raw.finalDestination || rs.finalDestination; }
    }
    if (Array.isArray(raw.stops) && raw.stops.length) {
      raw.stops = raw.stops.map((s) => ({ city: resolveCountryToCity(_tc(s.city)), nights: parseInt(s.nights, 10) }));
      raw.finalDestination = raw.finalDestination ? resolveCountryToCity(_tc(raw.finalDestination)) : null;
      raw.trips = null; raw.legs = []; raw.isMultiDestination = false;
      raw.destination = raw.destination || raw.stops[0].city;
    }
    const _tm = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(prompt);
    if (_tm && !raw.preferredTime) {
      let h = parseInt(_tm[1], 10) % 12; if (/pm/i.test(_tm[3])) h += 12;
      raw.preferredTime = String(h).padStart(2, '0') + ':' + (_tm[2] || '00');
    }
  }`);

const edits = [
  // ---- engine: crash + date correctness
  { file: enginePath, name: 'E1 safe _addDaysStr (named error instead of Invalid time value)', marker: '_addDaysStr invalid input',
    find: /_addDaysStr\(dateStr, days\) \{\s*const date = new Date\(dateStr\);\s*date\.setDate\(date\.getDate\(\) \+ days\);\s*return date\.toISOString\(\)\.split\('T'\)\[0\];\s*\}/,
    replace: `_addDaysStr(dateStr, days) {
    const n = Number(days);
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
    if (!dateStr || Number.isNaN(d.getTime()) || !Number.isFinite(n)) throw new Error('_addDaysStr invalid input: date=' + dateStr + ' days=' + days);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }` },
  { file: enginePath, name: 'E2 legacy legs: accept stayNights', marker: 'nights: l.nights ?? l.stayNights',
    find: '_validateMultiDestinationParams(params) {',
    replace: '_validateMultiDestinationParams(params) {\n    params.legs = (params.legs || []).map(l => ({ ...l, nights: l.nights ?? l.stayNights }));' },
  { file: enginePath, name: 'E3 legacy stop sequence: accept stayNights', marker: 'current.nights ?? current.stayNights',
    find: 'const checkOut = this._addDaysStr(cursorDate, current.nights);',
    replace: 'const checkOut = this._addDaysStr(cursorDate, (current.nights ?? current.stayNights ?? 1));' },
  { file: enginePath, name: 'E4 open-jaw: final leg is the departure leg', marker: 'leg._returnLeg)',
    find: 'if (isLastLeg && isOrigin) {', replace: 'if (isLastLeg && (isOrigin || leg._returnLeg)) {' },
  { file: enginePath, name: 'E5 hotel check-in follows arrival day (leg params)', marker: 'hotelCheckIn:       leg.checkIn',
    find: /returnDate:\s+leg\.returnDate,/, replace: 'returnDate:         leg.returnDate,\n        hotelCheckIn:       leg.checkIn || null,' },
  { file: enginePath, name: 'E6 hotel search uses hotelCheckIn', marker: 'tripParams.hotelCheckIn || tripParams.departureDate',
    find: 'let checkIn = tripParams.departureDate;', replace: 'let checkIn = tripParams.hotelCheckIn || tripParams.departureDate;' },
  { file: enginePath, name: 'E7 hotel checkout from nights when hotelCheckIn set', marker: 'tripParams.hotelCheckIn ?',
    find: 'const checkOut = tripParams.returnDate || this._addDaysStr(checkIn, nights);',
    replace: 'const checkOut = tripParams.hotelCheckIn ? this._addDaysStr(checkIn, nights) : (tripParams.returnDate || this._addDaysStr(checkIn, nights));' },
  // ---- engine: build the itinerary
  { file: enginePath, name: 'E8 build itinerary from stops in _continueOrchestration', marker: '[itinerary-builder] multi-stop prompts',
    find: 'if (intent?.productScope) tripParams._pendingProductScope = intent.productScope;',
    replace: 'if (intent?.productScope) tripParams._pendingProductScope = intent.productScope;\n' + E5 },
  { file: enginePath, name: 'E9 show assumptions to the traveler', marker: 'assumptionNote',
    find: /const noteParts\s*=\s*\[excursionNote, safariLodgeNote\]\.filter\(Boolean\);/,
    replace: u("const assumptionNote = tripParams._itineraryAssumptions?.length ? §_📝 ¤{tripParams._itineraryAssumptions.join(' · ')}. Tell me if any of that is wrong._§ : null;\n    const noteParts    = [excursionNote, safariLodgeNote, assumptionNote].filter(Boolean);") },
  // ---- engine: arrival / departure advice
  { file: enginePath, name: 'E10 leg advisory method', marker: '_legAdvisory(role, leg, transport) {',
    find: '_buildLegResponseText(role, leg, packages, isRevisit) {', replace: LEG_ADVISORY + '_buildLegResponseText(role, leg, packages, isRevisit) {' },
  { file: enginePath, name: 'E11 attach advisory to leg text', marker: 'this._legAdvisory(role, leg, primaryTransport)',
    find: 'text: this._buildLegResponseText(role, leg, packages, isRevisit),',
    replace: 'text: this._buildLegResponseText(role, leg, packages, isRevisit) + this._legAdvisory(role, leg, primaryTransport),' },
  // ---- engine: flight alternatives
  { file: enginePath, name: 'E12 remember unfiltered flights', marker: 'const _allOutbound = outboundTransport;',
    find: 'let unavailableProviderNote = null;', replace: 'const _allOutbound = outboundTransport; // [flight-alternatives]\n    let unavailableProviderNote = null;' },
  { file: enginePath, name: 'E13 provider not available -> real alternatives', marker: 'suggestFlightAlternatives({ provider: tripParams.preferredTransportProvider, time: tripParams.preferredTime, flights: _allOutbound });\n        unavailable',
    find: u("unavailableProviderNote = §¤{tripParams.preferredTransportProvider} isn't available on this route, so here are the available options instead.§;"), replace: ALT_A },
  { file: enginePath, name: 'E14 exact-time request -> real alternatives', marker: '[flight-alternatives] an exact-time',
    find: 'if (tripParams.preferredHotel) {', replace: ALT_B },
  // ---- parser
  { file: parserPath, name: 'P1 Groq main prompt: stops instead of dates', marker: 'MULTI-STOP RULES', find: '═══ CHILD RULES ═══', replace: P1 },
  { file: parserPath, name: 'P2 Groq simple prompt: stops rule', marker: 'fill stops [{"city","nights"}]',
    find: 'For multi-city trips: trips[] with ALL legs including return home.',
    replace: 'For 2+ stops or a different home city: fill stops [{"city","nights"}] in order (repeat a city if revisited) and finalDestination; leave trips null. Never compute dates other than departureDate.' },
  { file: parserPath, name: 'P3 add stops/finalDestination to both JSON shapes', marker: '"stops": null', count: 2,
    find: '"_missingFields": []', replace: '"stops": null, "finalDestination": null, "_missingFields": []' },
  { file: parserPath, name: 'P4 Groq token limit', marker: "reasoning_effort: 'low'",
    find: /max_tokens:\s*1200,/, replace: "max_tokens:      4000,\n      reasoning_effort: 'low'," },
  { file: parserPath, name: 'P5 rules fallback + preferred time', marker: '[itinerary-builder] multi-stop prompts: stops',
    find: 'raw._freshScore = freshScore;', replace: P3 },
];

const text = {}; for (const f of new Set(edits.map((e) => e.file))) text[f] = fs.readFileSync(f, 'utf8');
let failed = false; const log = [];
for (const e of edits) {
  const src = text[e.file], want = e.count || 1;
  if (src.includes(e.marker)) { log.push('skip (already applied): ' + e.name); continue; }
  let n;
  if (typeof e.find === 'string') n = src.split(e.find).length - 1;
  else n = (src.match(new RegExp(e.find.source, 'g')) || []).length;
  if (n !== want) { log.push('FAIL (found ' + n + ' matches, need ' + want + '): ' + e.name); failed = true; continue; }
  text[e.file] = typeof e.find === 'string' ? src.split(e.find).join(e.replace) : src.replace(new RegExp(e.find.source, 'g'), () => e.replace);
  log.push('ok: ' + e.name);
}
console.log(log.join('\n'));
if (failed) { console.error('\nNothing written. Send me the FAIL lines.'); process.exit(1); }
for (const f of Object.keys(text)) { fs.copyFileSync(f, f + '.bak2'); fs.writeFileSync(f, text[f]); }
console.log('\nDone. Backups: *.bak2');
