// Ticketing test on the TEST PCC only. From the project root:
//   node src/adapters/travelport/try-ticket.js prepare [--fop cash|invoice] [--locator ABC123]   post-commit workbench + FOP + payment (nothing issued yet)
//   node src/adapters/travelport/try-ticket.js issue --yes                                       commit: issues the ticket
//   node src/adapters/travelport/try-ticket.js retrieve                                          show the booking after ticketing
//   node src/adapters/travelport/try-ticket.js show
// The ticketing workbench lives 30 minutes: run prepare and issue close together.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tp = require('../travelport');

const OUT = path.join(__dirname, 'out');
const BOOK = path.join(OUT, 'book-state.json');
const STATE = path.join(OUT, 'ticket-state.json');
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
const find = (o, key) => { // first value for a key, depth-first
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === key) return v; const x = find(v, key); if (x !== undefined) return x; }
};

const steps = {
  async prepare() {
    const locator = a.locator || (fs.existsSync(BOOK) ? JSON.parse(fs.readFileSync(BOOK, 'utf8')).locator : null);
    if (!locator) { console.error('No locator. Create a held booking first, or pass --locator ABC123.'); process.exit(1); }
    const fop = a.fop || 'cash';
    if (!['cash', 'invoice'].includes(fop)) { console.error('--fop must be cash or invoice'); process.exit(1); }
    console.log(`Locator ${locator} | form of payment: ${fop}`);

    // 1. Current booking: offer id and amount to pay.
    const cur = await tp.core.retrieveReservation(ctx(), locator);
    check('t-retrieve', cur);
    const res = cur.data?.ReservationResponse?.Reservation;
    const offer = res?.Offer?.[0];
    if (!offer) { console.error('No offer on the booking (cancelled or expired?).'); process.exit(1); }
    const amount = offer.Price?.TotalPrice, currency = offer.Price?.CurrencyCode?.value;
    console.log(`Paying ${amount} ${currency} for ${offer.id}`);

    // 2. Post-commit workbench.
    const wbRes = await tp.core.createTicketingWorkbench(ctx(), locator);
    check('t-workbench', wbRes);
    const wb = wbRes.data?.ReservationResponse?.Identifier?.value;
    if (!wb) { console.error('No workbench id at ReservationResponse.Identifier.value. Send me the saved t-workbench file.'); process.exit(1); }
    console.log('ticketing workbench:', wb);
    const wbOffer = wbRes.data?.ReservationResponse?.Reservation?.Offer?.[0] || offer;
    save({ locator, wb, fop, offerId: wbOffer.id || 'offer_1', offerIdentifier: wbOffer.Identifier?.value || offer.Identifier?.value, amount, currency, step: 'workbench', at: new Date().toISOString() });

    // 3. Form of payment.
    const fopId = 'formOfPayment_1';
    const ident = { authority: 'Travelport', value: 'bodrless-test-fop-1' };
    const fopBody = fop === 'cash'
      ? { FormOfPaymentCash: { id: fopId, FormOfPaymentRef: fopId, Identifier: ident } }
      : { FormOfPaymentInvoice: { id: fopId, FormOfPaymentRef: fopId, Identifier: ident, InvoiceNumber: String(a.invoice || '100001') } };
    const fopRes = await tp.core.addFormOfPayment(ctx(), wb, fopBody);
    check('t-fop', fopRes);
    const fopIdentifier = fopRes.data?.FormofPaymentResponse?.Identifier?.value || ident.value;

    // 4. Payment linking the FOP to the flight offer.
    const payBody = {
      Payment: {
        id: 'payment_1',
        Identifier: { authority: 'Travelport', value: 'bodrless-test-payment-1' },
        Amount: { code: currency, minorUnit: 2, currencySource: 'Charged', value: amount },
        FormOfPaymentIdentifier: { id: fopId, FormOfPaymentRef: fopId, Identifier: { authority: 'Travelport', value: fopIdentifier } },
        OfferIdentifier: [{ id: wbOffer.id || 'offer_1', offerRef: wbOffer.id || 'offer_1', Identifier: { authority: 'Travelport', value: wbOffer.Identifier?.value || offer.Identifier?.value } }],
      },
    };
    const payRes = await tp.core.addPayment(ctx(), wb, payBody);
    check('t-payment', payRes);
    save({ ...load(), step: 'ready' });
    console.log('\nReady. Nothing is issued yet. To issue the ticket (within 30 minutes):\n  node src\\adapters\\travelport\\try-ticket.js issue --yes');
  },
  async issue() {
    const s = load();
    if (s.step !== 'ready') { console.error('Run prepare first (state is "' + (s.step || 'empty') + '").'); process.exit(1); }
    if (!a.yes) { console.error(`This ISSUES a ticket on ${s.locator} (${s.amount} ${s.currency}, ${s.fop}). Add --yes to confirm.`); process.exit(1); }
    let r;
    try { r = await tp.core.commitTicketing(ctx(), s.wb, {}); }
    catch (e) {
      console.error('\nissue threw:', e.message);
      if (e.traceId) console.error('traceId:', e.traceId);
      if (e.body !== undefined) {
        const bf = path.join(OUT, `t-issue-ERROR-${e.traceId || Date.now()}.json`);
        fs.writeFileSync(bf, JSON.stringify(e.body, null, 2));
        console.error('Travelport error body saved to', bf);
        console.error(JSON.stringify(e.body, null, 2).slice(0, 3000));
      } else console.error('(no response body was returned)');
      if (e.unknownOutcome) console.error('OUTCOME UNKNOWN: do NOT run issue again. Run "retrieve" to see if a ticket exists.');
      process.exit(1);
    }
    check('t-issue', r);
    save({ ...s, step: 'issued' });
    console.log('Ticket numbers found:', JSON.stringify([...new Set((JSON.stringify(r.data).match(/"(?:ticketNumber|value)":\s*"(\d{13})"/g) || []))]));
    console.log('\nNext: node src\\adapters\\travelport\\try-ticket.js retrieve');
  },
  async retrieve() {
    const s = load();
    const r = await tp.core.retrieveReservation(ctx(), a.locator || s.locator);
    check('t-after', r);
  },
  async show() { console.log(JSON.stringify(load(), null, 2)); },
};
if (!steps[cmd]) { console.log('Commands: prepare | issue --yes | retrieve | show'); process.exit(1); }
steps[cmd]().catch((e) => { console.error('\nERROR:', e.message); if (e.unknownOutcome) console.error('OUTCOME UNKNOWN: do not retry blindly.'); process.exit(1); });
