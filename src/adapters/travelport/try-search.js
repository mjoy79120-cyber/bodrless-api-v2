// From the project root:
//   node src/adapters/travelport/try-search.js                       (JFK -> LAX, 2026-12-19, AA, GDS+NDC)
//   node src/adapters/travelport/try-search.js NBO LHR 2026-12-19    (any route, all carriers)
//   node src/adapters/travelport/try-search.js NBO LHR 2026-12-19 KQ (one carrier)
// Saves the raw response to out/ and prints a short summary of what the normalizer made of it.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tp = require('../travelport');
let normalize = null;
try { normalize = require('./normalize').normalizeTravelportSearch; } catch { /* normalizer not installed yet */ }

(async () => {
  const [origin = 'JFK', destination = 'LAX', date = '2026-12-19', carrier] = process.argv.slice(2);
  const r = await tp.searchRaw({ origin, destination, date, carriers: carrier ? [carrier] : (process.argv.length > 2 ? undefined : ['AA']), ndc: true });
  const dir = path.join(__dirname, 'out'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `search-${r.traceId}.json`);
  fs.writeFileSync(file, JSON.stringify(r.data, null, 2));
  console.log('OK', r.status, `${origin}>${destination} ${date}`, 'saved', file);
  if (normalize) {
    const flights = normalize(r.data, r.traceId);
    const cached = flights.some((f) => f.catalogCached);
    console.log(`${flights.length} results (${flights.filter((f) => f.contentSource === 'GDS').length} GDS, ${flights.filter((f) => f.contentSource === 'NDC').length} NDC), price-ready: ${cached ? 'yes' : 'NO (no cached search id)'}`);
    for (const f of flights.slice(0, 8)) console.log(' ', f.contentSource, f.flightNumber, f.originIata + '>' + f.destIata, f.departureTime.slice(0, 16), f.stops + ' stop', f.price, f.currency, f.brandName || '');
  }
})().catch((e) => { console.error('FAILED:', e.message); if (e.body) console.error(JSON.stringify(e.body, null, 2).slice(0, 3000)); process.exitCode = 1; });
