// Held-booking test, one step at a time. From the project root:
//   node src/adapters/travelport/try-book.js open                 new workbench + add the priced offer (uses newest out/price-*.json)
//   node src/adapters/travelport/try-book.js traveller            add a TEST traveller (override: --given X --surname Y --dob 1985-06-15 --gender Male --email a@b.co --phone 700000000)
//   node src/adapters/travelport/try-book.js commit --yes         create the held booking (NOT ticketed, no payment); pauses with warnings if schedule/price changed
//   node src/adapters/travelport/try-book.js commit --yes --accept  second step: accept the warned changes and create the booking
//   node src/adapters/travelport/try-book.js retrieve [--locator ABC123]
//   node src/adapters/travelport/try-book.js cancel --yes [--locator ABC123]   cancel the held test booking
//   node src/adapters/travelport/try-book.js show                 print saved state
// Every response is saved in out/. Errors Travelport hides inside an HTTP 200 are reported as failures.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tp = require('../travelport');
const { buildAddOffer, buildAddOfferReference, buildTraveller, buildCommit } = require('./builders');
const { stripPcSuffix } = require('./core');

const OUT = path.join(__dirname, 'out');
const STATE = path.join(OUT, 'book-state.json');
fs.mkdirSync(OUT, { recursive: true });
const [cmd, ...rest] = process.argv.slice(2);
const a = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) { const k = rest[i].slice(2); a[k] = rest[i + 1] === undefined || rest[i + 1].startsWith('--') ? true : rest[++i]; }

const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {});
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
const dump = (tag, r) => {
  const f = path.join(OUT, `${tag}-${r.traceId}.json`); fs.writeFileSync(f, JSON.stringify(r.data, null, 2));
  const { authorization, ...h } = r.headers || {}; fs.writeFileSync(path.join(OUT, `${tag}-${r.traceId}.headers.json`), JSON.stringify(h, null, 2));
  return f;
};
function findAll(o, re, out = [], p = '') {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number')) out.push(`${p}${k}=${v}`);
    findAll(v, re, out, `${p}${k}.`);
  }
  return out;
}
function check(tag, r) {
  const f = dump(tag, r);
  if (r.softErrors?.length) {
    console.error(`\nFAILED at "${tag}": HTTP ${r.status} but Travelport reported errors (saved ${f}):`);
    for (const e of r.softErrors) console.error(' -', e.code, e.message);
    process.exit(1);
  }
  console.log(`OK ${tag} (HTTP ${r.status}) saved ${f}`);
}
const ctx = () => tp._ctx();

const steps = {
  async open() {
    const files = fs.readdirSync(OUT).filter((f) => f.startsWith('price-') && f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((x, y) => y.t - x.t);
    if (!files.length) { console.error('No price file in out/. Run try-price.js first.'); process.exit(1); }
    const price = JSON.parse(fs.readFileSync(path.join(OUT, files[0].f), 'utf8')).OfferListResponse;
    const offer = price?.OfferID?.[0];
    if (!offer) { console.error('Price file has no OfferID. Run try-price.js again.'); process.exit(1); }
    console.log('Using price file:', files[0].f, '|', offer.id, offer.Price?.TotalPrice, offer.Price?.CurrencyCode?.value);
    console.log('Ticket time limit (PaymentTimeLimit):', offer.TermsAndConditionsFull?.[0]?.PaymentTimeLimit || 'n/a');

    let wb = a.reuse ? load().wb : null;
    if (wb) console.log('Reusing workbench:', wb);
    else {
      const wbRes = await tp.core.createWorkbench(ctx());
      check('workbench', wbRes);
      wb = wbRes.data?.ReservationResponse?.Reservation?.Identifier?.value;
      if (!wb) { console.error('Could not find the workbench id in the response. Open the saved file and send me the first 40 lines.'); process.exit(1); }
      console.log('workbench id:', wb);
      save({ ...load(), wb, step: 'workbench' });
    }

    // Booking route "Add Offer Reference Payload" (airoffer/.../buildfromcatalogproductofferings).
    // Travelport's docs are unclear about which id set the cache knows, so we try the likely ones in order and stop at the first that works:
    //   search   = ids from the search response (same ids the Price call accepted)
    //   pricepc  = ids from the price response, catalog id kept WITH its _PC suffix
    //   price    = ids from the price response, _PC stripped
    // Force one with --ids search|pricepc|price.   --route offer  uses the other endpoint (offer/.../buildfromcatalogofferings).
    if (a.route === 'offer') {
      const ids = { offersId: stripPcSuffix(price.Identifier.value), offerId: offer.id, productIds: (offer.Product || []).map((p) => p.id) };
      const body = buildAddOffer(ids);
      if (a.dry) { console.log(JSON.stringify(body, null, 2)); return; }
      check('add-offer', await tp.core.addOffer(ctx(), wb, body));
    } else {
      const cands = {};
      const sf = fs.readdirSync(OUT).filter((f) => f.startsWith('search-') && f.endsWith('.json'))
        .map((f) => ({ f, t: fs.statSync(path.join(OUT, f)).mtimeMs })).sort((x, y) => y.t - x.t)[0];
      if (sf) {
        const so = require('./normalize').normalizeTravelportSearch(JSON.parse(fs.readFileSync(path.join(OUT, sf.f), 'utf8'))).find((x) => x.contentSource === 'GDS' && x.catalogCached);
        if (so) cands.search = { catalogOfferingsId: so.catalogOfferingsId, offerId: so.catalogOfferingId, productIds: so.productIds, note: `from ${sf.f}` };
      }
      const pids = (offer.Product || []).map((p) => p.id);
      cands.pricepc = { catalogOfferingsId: price.Identifier.value, offerId: offer.id, productIds: pids, note: 'price ids, _PC kept' };
      cands.price = { catalogOfferingsId: stripPcSuffix(price.Identifier.value), offerId: offer.id, productIds: pids, note: 'price ids, _PC stripped' };
      const order = a.ids ? [a.ids] : ['search', 'pricepc', 'price'];
      let worked = null;
      for (const name of order) {
        const c = cands[name]; if (!c) { console.log(`(skipping "${name}": not available)`); continue; }
        const body = buildAddOfferReference(c);
        if (a.dry) { console.log(name, JSON.stringify(body)); continue; }
        console.log(`\nTrying ids "${name}" (${c.note}): ${c.catalogOfferingsId} ${c.offerId} ${c.productIds.join(',')}`);
        const r = await tp.core.addOfferReference(ctx(), wb, body);
        if (r.softErrors?.some((e) => String(e.code) === '4101')) { dump('add-offer-' + name, r); console.log('  -> 4101 not found, trying the next'); continue; }
        check('add-offer', r); worked = name; break;
      }
      if (a.dry) return;
      if (!worked) { console.error('\nNone of the id sets were accepted. Send me the last add-offer file in out/.'); process.exit(1); }
      console.log('Accepted id set:', worked);
    }
    save({ ...load(), step: 'offer-added' });
    console.log('\nNext: node src\\adapters\\travelport\\try-book.js traveller');
  },
  async traveller() {
    const s = load(); if (!s.wb) { console.error('No workbench yet. Run: open'); process.exit(1); }
    const body = buildTraveller({
      given: a.given || 'TEST', surname: a.surname || 'TRAVELER', birthDate: a.dob || '1985-06-15', gender: a.gender || 'Male',
      email: a.email || 'test@bodrless.com', phone: a.phone || '212456121', countryCode: a.cc || '1', cityCode: a.city || 'NYC',
    }, 1);
    if (a.dry) { console.log(JSON.stringify(body, null, 2)); return; }
    check('traveller', await tp.core.addTraveller(ctx(), s.wb, body));
    save({ ...s, step: 'traveller-added' });
    console.log('\nNext: node src\\adapters\\travelport\\try-book.js commit --yes');
  },
  async commit() {
    const s = load(); if (!s.wb) { console.error('No workbench yet.'); process.exit(1); }
    if (!a.yes) { console.error('Commit creates a real (held) booking in pre-production. Add --yes to confirm.'); process.exit(1); }
    let r;
    try { r = await tp.core.commitReservation(ctx(), s.wb, buildCommit({ twoStep: !a.accept })); }
    catch (e) {
      console.error('FAILED:', e.message);
      if (e.body) console.error(JSON.stringify(e.body, null, 2).slice(0, 3000));
      if (e.unknownOutcome) console.error('\nOUTCOME UNKNOWN: do NOT run commit again. Run "retrieve" or check with Travelport first.');
      process.exit(1);
    }
    check('commit', r);
    const resp = Object.values(r.data || {})[0] || {};
    if (resp.Result?.status) console.log('Commit status:', resp.Result.status);
    for (const w of resp.Result?.Warning || []) console.log(' warning:', w.Message || JSON.stringify(w));
    const hints = findAll(r.data, /locator|^value$/i).filter((x) => /locator/i.test(x));
    console.log('Locator candidates:', hints.length ? hints.join(' | ') : '(none found by name: open the saved file)');
    const loc = a.locator || hints[0]?.split('=').pop();
    if (loc) { save({ ...s, locator: loc, step: 'committed' }); console.log('Saved locator:', loc); }
    console.log('\nNext: node src\\adapters\\travelport\\try-book.js retrieve');
  },
  async retrieve() {
    const s = load(); const loc = a.locator || s.locator;
    if (!loc) { console.error('No locator. Pass --locator ABC123.'); process.exit(1); }
    check('retrieve', await tp.core.retrieveReservation(ctx(), loc));
  },
  async cancel() {
    const s = load(); const loc = a.locator || s.locator;
    if (!loc) { console.error('No locator. Pass --locator ABC123.'); process.exit(1); }
    if (!a.yes) { console.error(`This cancels held booking ${loc}. Add --yes to confirm.`); process.exit(1); }
    check('cancel', await tp.core.cancelReservation(ctx(), loc, {}));
    save({ ...s, step: 'cancelled' });
  },
  async show() { console.log(JSON.stringify(load(), null, 2)); },
};

if (!steps[cmd]) { console.error('Commands: ' + Object.keys(steps).join(', ')); process.exit(1); }
steps[cmd]().catch((e) => {
  console.error('\nFAILED:', e.message, e.status ? `(HTTP ${e.status})` : '');
  if (e.body) console.error(typeof e.body === 'string' ? e.body.slice(0, 1500) : JSON.stringify(e.body, null, 2).slice(0, 3000));
  if (e.unknownOutcome) console.error('OUTCOME UNKNOWN: check the booking before retrying.');
  process.exitCode = 1;
});
