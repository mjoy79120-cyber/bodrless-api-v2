/**
 * TRAVELDUQA CONDITIONS INSPECTION
 * ─────────────────────────────────────────────
 * Runs a real TravelDuqa search and prints exactly what the
 * `conditions` field looks like on real offers, so we can see its
 * actual shape before building any refund-status interpretation on
 * top of it (rather than guessing).
 *
 * Safe — search only, books nothing.
 * ─────────────────────────────────────────────
 */

// Override the production 9s search timeout for this standalone
// test — that cap is deliberately tuned around the multi-hub
// fallback chain's total budget (see travelduqa.js's constructor
// comment), which doesn't apply here. Two consecutive 9s timeouts
// suggest TravelDuqa's sandbox may just be slow right now — this
// gives it real room to respond before we conclude anything else.
process.env.TRAVELDUQA_SEARCH_TIMEOUT_MS = '30000';

require('dotenv').config();

const supplierAdapter = require('./src/adapters');

async function main() {
  // Real Nairobi -> Mombasa route, a date comfortably in the future.
  const departureDate = new Date();
  departureDate.setDate(departureDate.getDate() + 30);
  const dateStr = departureDate.toISOString().split('T')[0];

  console.log(`Searching Nairobi -> Mombasa on ${dateStr}...\n`);

  const results = await supplierAdapter.searchTransport({
    origin: 'nairobi',
    destination: 'mombasa',
    date: dateStr,
    passengers: 1,
    transportMode: 'flight',
  });

  console.log(`\nTotal flights found: ${results.length}\n`);

  if (results.length === 0) {
    console.log('No results — try a different date, or check the TRAVELDUQA/DUFFEL logs above for the real reason.');
    return;
  }

  // Only TravelDuqa results carry the raw `conditions` field we're
  // investigating (Duffel's offers use `refundPenalty`/`isRefundable`
  // instead, already interpreted).
  const travelDuqaResults = results.filter(r => r.supplier === 'travelduqa');

  console.log(`TravelDuqa-specific results: ${travelDuqaResults.length}\n`);

  travelDuqaResults.forEach((offer, i) => {
    console.log(`--- Offer ${i + 1}: ${offer.airline} ${offer.flightNumber} — ${offer.currency} ${offer.price} ---`);
    console.log('conditions field (raw):');
    console.log(JSON.stringify(offer.conditions, null, 2));
    console.log('');
  });

  if (travelDuqaResults.length === 0) {
    console.log('No TravelDuqa-supplier results in this search — only Duffel offers came back.');
    console.log('Try a different route/date, since TravelDuqa inventory varies by search.');
  } else if (travelDuqaResults.every(o => !o.conditions)) {
    console.log('⚠️  Every TravelDuqa offer has conditions: null — meaning either:');
    console.log('   (a) TravelDuqa genuinely does not return this field on search results, or');
    console.log('   (b) it only appears after selectOffer() is called (a booking-flow step),');
    console.log('       not on the initial getOffers search response.');
    console.log('   Either way, this confirms refund status isn\'t available at search time');
    console.log('   for TravelDuqa flights — the honest "not confirmed" messaging is correct.');
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});