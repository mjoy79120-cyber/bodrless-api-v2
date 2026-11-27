// From the project root:  node src/adapters/travelport/try-price.js [GDS|NDC] [--dry]
// Prices the first offer of the NEWEST search file in out/ using the documented endpoint
//   POST price/offers/buildfromcatalogproductofferings   (host api.pp.travelport.net, PCC in TVP-PCC-Core)
// Price only: NO booking is created. Saves the full response to out/price-<traceId>.json.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tp = require('../travelport');
const { normalizeTravelportSearch } = require('./normalize');
const { buildPrice } = require('./builders');

const OUT = path.join(__dirname, 'out');
const source = process.argv.slice(2).find((a) => /^(GDS|NDC)$/i.test(a))?.toUpperCase() || 'GDS';
const dry = process.argv.includes('--dry');

const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => f.startsWith('search-') && f.endsWith('.json'))
  .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((a, b) => b.t - a.t) : [];
if (!files.length) { console.error('No search file in out/. Run try-search.js first.'); process.exit(1); }
console.log('Using search file:', files[0].f);
const flights = normalizeTravelportSearch(JSON.parse(fs.readFileSync(path.join(OUT, files[0].f), 'utf8')));
const offer = flights.find((f) => f.contentSource === source);
if (!offer) { console.error(`No ${source} offer in that search.`); process.exit(1); }
if (!offer.catalogCached) { console.error('This search has no cached search id, so it cannot be priced. Run try-search.js again (it now caches results) and retry.'); process.exit(1); }

console.log(`\nOffer: ${offer.flightNumber} ${offer.originIata}>${offer.destIata} ${offer.departureTime} ${offer.price} ${offer.currency} (${offer.brandName})`);
console.log('ids  :', offer.catalogOfferingsId, offer.catalogOfferingId, offer.productIds.join(','));
const body = buildPrice({ catalogOfferingsId: offer.catalogOfferingsId, offerId: offer.catalogOfferingId, productIds: offer.productIds });
if (dry) { console.log(JSON.stringify(body, null, 2)); process.exit(0); }

(async () => {
  const r = await tp.core.price(tp._ctx(), body);
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `price-${r.traceId}.json`);
  fs.writeFileSync(file, JSON.stringify(r.data, null, 2));
  if (r.softErrors?.length) {
    console.error('\nFAILED: HTTP', r.status, 'but Travelport reported errors in the body (saved', file + '):');
    for (const e of r.softErrors) console.error(' -', e.code, e.message);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK', r.status, 'saved', file);
  console.log('Top-level keys:', Object.keys(r.data || {}).join(', '));
})().catch((e) => {
  console.error('\nFAILED:', e.message, e.status ? `(HTTP ${e.status})` : '');
  if (e.body) console.error(typeof e.body === 'string' ? e.body.slice(0, 1500) : JSON.stringify(e.body, null, 2).slice(0, 3000));
  process.exitCode = 1;
});
