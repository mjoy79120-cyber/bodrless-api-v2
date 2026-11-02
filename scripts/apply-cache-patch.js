const fs = require('fs');
const ENGINE = 'src/orchestration/engine.js';
const ROUTE  = 'src/routes/trips.js';
const CACHE  = 'src/services/searchSessionCache.js';

const src = {}; const errors = [];
const load = f => (src[f] ??= fs.readFileSync(f, 'utf8'));

// exactly-one-match edit; build(matchedText) returns the replacement
function edit(file, name, re, build) {
  const s = load(file);
  const n = [...s.matchAll(new RegExp(re.source, 'g' + re.flags.replace('g', '')))].length;
  if (n !== 1) { errors.push(`${name}: expected 1 match in ${file}, found ${n}`); return; }
  src[file] = s.replace(re, m => build(m));
}

// ── 0. require ───────────────────────────────────────────────
edit(ENGINE, 'require', /const cachedSearch = require\('\.\.\/services\/cachedSearch'\);/,
  m => m + `\nconst searchCache = require('../services/searchSessionCache');`);

// ── 1. helpers (airport-local hour; no TZ maths) ─────────────
edit(ENGINE, 'helpers', /  _warmResultsIntro\(dest, count, dateLabel\) \{/, m => String.raw`  _localHour(t) {
    const s = String(t || '');
    const x = /T(\d{2}):/.exec(s) || /^(\d{1,2}):\d{2}/.exec(s);
    return x ? +x[1] : null;
  }

  _applyTimePreference(list, band) {
    if (!band) return list;
    const ok = h => band === 'morning' ? h >= 5 && h < 12
      : band === 'afternoon' ? h >= 12 && h < 17
      : band === 'evening' ? h >= 17 && h < 21
      : band === 'night' ? (h >= 21 || h < 5) : true;
    return list.filter(f => (f.transportType || 'flight') !== 'flight'
      || this._localHour(f.departureTime) == null || ok(this._localHour(f.departureTime)));
  }

` + m);

// ── 2. don't let the adapters time-filter (cache must hold the full list)
edit(ENGINE, 'flightParams time', /const flightParams = \{[\s\S]*?timePreference: tripParams\.timePreference \|\| null/,
  m => m.replace('timePreference: tripParams.timePreference || null', 'timePreference: null'));

// ── 3. prefetched results replace the supplier Promise.all ───
edit(ENGINE, 'prefetch', /const \[\s*outboundResult, outboundBuses, outboundTrains,\s*returnResult, returnBuses, returnTrains,\s*hotelResults\s*\] = await Promise\.all\(\[/,
  () => String.raw`const pre = context?.prefetched;
    const [
      outboundResult, outboundBuses, outboundTrains,
      returnResult, returnBuses, returnTrains,
      hotelResults
    ] = pre ? [
      { results: pre.outbound, connectsVia: pre.outConnects || null, connectingLegBookable: true },
      [], [],
      { results: pre.ret, connectsVia: null, connectingLegBookable: true },
      [], [], pre.hotels,
    ] : await Promise.all([`);

edit(ENGINE, 'routeLearning guard', /if \(routeLearning\) \{(\s*)const flightCount/,
  (m) => m.replace('if (routeLearning) {', 'if (routeLearning && !pre) {'));

// ── 4. cache write + time filter, after dedupe ───────────────
edit(ENGINE, 'cache write', /returnTransport\s*=\s*this\._dedupeEquivalentFlights\(returnTransport\);/,
  m => m + String.raw`

    if (!pre && context?.cache && !tripParams.bypassCache && !outboundResult.results.searchFailed) {
      const key = tripParams._cacheKey || (tripParams._cacheKey = searchCache.newKey());
      searchCache.put(key, tripParams, {
        outbound: outboundTransport, ret: returnTransport, hotels,
        outConnects: outboundResult.connectsVia, hadTransport: !skipFlight,
      });
    }
    outboundTransport = this._applyTimePreference(outboundTransport, tripParams.timePreference);`);

// ── 5. follow-ups read the cache ─────────────────────────────
edit(ENGINE, 'singleResult', /const singleResult = await this\._runSingleDestinationSearch\(tripParams, sessionId, prompt, intent, \{ phone \}\);/,
  () => String.raw`let prefetched = null;
    if (intent?.isFollowUp && tripParams._cacheKey) {
      const e = searchCache.get(tripParams._cacheKey, tripParams);
      const needT = intent.productScope?.needsTransport !== false;
      if (e && (!needT || e.hadTransport)) {
        prefetched = { outbound: e.outbound, ret: e.ret, hotels: e.hotels, outConnects: e.outConnects };
      }
    }
    const singleResult = await this._runSingleDestinationSearch(
      tripParams, sessionId, prompt, intent, { phone, prefetched, cache: true });`);

// ── 6. adjustments: airline / afternoon / upgrade / more nights
edit(ENGINE, 'extractAdjustments', /const dx = parseDateExpression\(t, \{ currentDeparture: previousParams\?\.departureDate \|\| null \}\);/,
  m => String.raw`const _al = t.match(/\b(kenya airways|kq|emirates|qatar airways|ethiopian|rwandair|turkish|klm|lufthansa|british airways|air france)\b/);
      if (_al) adj.preferredTransportProvider = _al[1];
      if (/\bany airline\b|\ball airlines\b/.test(t)) adj.preferredTransportProvider = null;
      if (/\bafternoon\b/.test(t)) adj.timePreference = 'afternoon';
      if (/\bany ?time\b/.test(t)) adj.timePreference = null;
      if (/\bupgrade\b|\bbetter hotel\b|\bnicer\b/.test(t)) adj.budget = 'high';
      if (!nightsMatch && /\bmore nights\b/.test(t)) adj.nights = (previousParams?.nights || 3) + 1;
      ` + m);

// ── 7. "X to Y <date>" is a new trip, not a date follow-up ───
edit(ENGINE, 'route check', /\/\/ 4b\. Date change/, m => String.raw`// fresh "X to Y" route => new trip (prevents stale origin/destination bleed-over)
    const _route = lower.match(/\b([a-z][a-z ]{2,20}?)\s+to\s+([a-z][a-z ]{2,25}?)(?=\s+(?:on|for|in|from|with|\d)|[,.!?]|$)/i);
    if (_route && lower.split(/\s+/).length >= 4
        && !/^(back|up|swap|switch|change|move|push|shift|set|make|put|bring|keep|do|go|try|add|due|next|close)\b/.test(_route[1].trim())
        && !/\b(flight|flights|train|bus|buses|seat|hotel|option|class|airline)\b/.test(_route[1])
        && !/^(flight|flights|train|bus|sgr|kq|the|a|an|my|\d)/.test(_route[2].trim())
        && !parseDateExpression(_route[2])) {
      return { isFollowUp: false, adjustments: _extractAdjustments(lower),
               productScope: this._buildProductScope(lower), wantsCheapest, wantsAffordableSort, wantsSuggestDates };
    }

    ` + m);

// ── 8. _adjustParams: provider + drop stale parser metadata ─
edit(ENGINE, 'adjust provider', /if \(adjustments\.timePreference !== undefined\) adjusted\.timePreference = adjustments\.timePreference;/,
  m => m + `\n    if (adjustments.preferredTransportProvider !== undefined) adjusted.preferredTransportProvider = adjustments.preferredTransportProvider;`);
edit(ENGINE, 'adjust stale meta', /const adjusted\s*=\s*\{ \.\.\.previousParams \};/,
  m => m + `\n    delete adjusted._missingFields; delete adjusted._freshScore; delete adjusted._parsedBy; delete adjusted._confidence;`);

// ── 9. follow-up fresh parse: only when a place is named; check origin too
edit(ENGINE, 'skipFreshParse', /\} else if \(!skipFreshParse\) \{/,
  () => `} else if (/\\b(?:to|from)\\s+[a-z]{3,}/i.test(prompt)) {`);
edit(ENGINE, 'dest/origin changed', /const destinationChanged = freshDest && prevDest && freshDest !== prevDest;/,
  () => String.raw`const _fo = (freshParse.origin || '').toLowerCase().trim();
          const _po = (tripParams.origin || '').toLowerCase().trim();
          const destinationChanged = !!((freshDest && prevDest && freshDest !== prevDest) || (_fo && _po && _fo !== _po));`);

// ── 10. hotel-follow-up gate skipped _adjustParams ───────────
edit(ENGINE, 'hotel gate adjust', /const freshIntent = this\._detectIntent\(prompt, cleanParams\);/,
  m => m + `\n          if (freshIntent.isFollowUp) Object.assign(cleanParams, this._adjustParams(cleanParams, freshIntent));`);

// ── 11. route: don't leak held (unapproved) packages ─────────
edit(ROUTE, 'strip helper', /const router = express\.Router\(\);/,
  m => m + `\nconst stripPrivate = tp => { if (!tp) return tp; const { _lastFlightPackages, _lastPackages, ...rest } = tp; return rest; };`);
edit(ROUTE, 'held tripParams', /tripParams:\s+result\?\.tripParams \|\| null,(?=\s*conversationHistory: result\?\.conversationHistory \|\| \[\],\s*\}\);)/,
  () => `tripParams:          stripPrivate(result?.tripParams) || null,`);

// ── 12. cache module ─────────────────────────────────────────
if (!fs.existsSync(CACHE)) src[CACHE] = String.raw`const crypto = require('crypto');
const TTL_MS = 15 * 60 * 1000, MAX = 200;
const store = new Map();
const sig = p => [p.origin, p.destination, p.departureDate, p.returnDate,
  p.passengers || 1, p.children || 0, p.cabinClass || 'economy',
  p.outboundTransportMode || '', p.wantsTrain ? 't' : '']
  .map(x => String(x ?? '').toLowerCase()).join('|');
const newKey = () => 'sc_' + crypto.randomBytes(8).toString('hex');
function put(key, p, data) {
  if (store.size >= MAX) store.delete(store.keys().next().value);
  store.set(key, { sig: sig(p), at: Date.now(), ...data });
}
function get(key, p) {
  const e = key && store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { store.delete(key); return null; }
  if (e.sig !== sig(p)) return null;
  const soon = Date.now() + 2 * 60 * 1000;
  const live = f => !f.expiresAt || new Date(f.expiresAt).getTime() > soon;
  return { ...e, outbound: e.outbound.filter(live), ret: e.ret.filter(live) };
}
module.exports = { newKey, put, get };
`;

if (errors.length) { console.error('FAILED, nothing written:\n' + errors.join('\n')); process.exit(1); }
for (const [f, s] of Object.entries(src)) fs.writeFileSync(f, s);
console.log('Patched:', Object.keys(src).join(', '));