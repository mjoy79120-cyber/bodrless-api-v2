// End-to-end through the wrapper only (same calls the router makes). From the project root:
//   node src/adapters/travelport/try-wrapper.js            search + hold + show + (asks before cancel)
//   node src/adapters/travelport/try-wrapper.js --cancel   also cancel the held booking at the end
require('dotenv').config();
const tp = require('../travelport');
const cancel = process.argv.includes('--cancel');
(async () => {
  const d = new Date(); d.setDate(d.getDate() + 28);
  const date = d.toISOString().slice(0, 10);
  const flights = await tp.search({ origin: 'JFK', destination: 'LAX', date, passengers: 1, timePreference: null });
  console.log(`search: ${flights.length} results`);
  const f = flights.find((x) => x.canHold && x.contentSource === 'GDS');
  if (!f) { console.error('No holdable GDS flight found.'); process.exit(1); }
  console.log(`picked ${f.flightNumber} ${f.originIata}>${f.destIata} ${f.departureTime} ${f.price} ${f.currency}`);
  let r = await tp.createHeldBooking({
    catalogOfferingsId: f.catalogOfferingsId, catalogOfferingId: f.catalogOfferingId, productIds: f.productIds,
    passengers: [{ firstName: 'Test', lastName: 'Traveler', dateOfBirth: '1985-06-15', gender: 'm', email: 'test@bodrless.com', phone: '0712345678' }],
  });
  if (r.status === 'needs_confirmation') {
    console.log('Travelport reports a change since search:', r.warnings);
    r = await tp.confirmHeldBooking({ workbenchId: r.workbenchId });
  }
  console.log(JSON.stringify({ status: r.status, orderId: r.orderId, airlineRef: r.supplierBookingReference, payBy: r.paymentRequiredBy, total: r.totalAmount, currency: r.currency, flight: r.flightNumber }, null, 1));
  if (cancel && r.orderId) { await tp.cancel(r.orderId); console.log('cancelled', r.orderId); }
  else console.log('Not cancelled. Cancel with: node src\\adapters\\travelport\\try-book.js cancel --yes --locator ' + r.orderId);
})().catch((e) => { console.error('FAILED:', e.message); if (e.body) console.error(JSON.stringify(e.body).slice(0, 1500)); if (e.unknownOutcome) console.error('OUTCOME UNKNOWN: do not retry; check with retrieve.'); process.exit(1); });
