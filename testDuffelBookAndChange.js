/**
 * SANDBOX TEST — Duffel: book (hold + pay) then change a flight
 * ─────────────────────────────────────────────────────────────
 * Run this from your project root (same level as server.js) with:
 *
 *   node testDuffelBookAndChange.js
 *
 * Requirements:
 *   - DUFFEL_ACCESS_TOKEN in your .env must be a duffel_test_... token
 *   - Run on a machine/shell where require('./adapters') resolves
 *     (i.e. inside the actual Bodrless repo)
 *
 * This deliberately does NOT touch Supabase or bookingService.js —
 * it calls straight through adapters/index.js (the real router used
 * in production) into duffel.js, to isolate and verify the Duffel
 * integration itself first: search -> hold order -> pay -> request
 * change -> confirm change. bookingService's full flow (with
 * Supabase persistence) is a separate test layered on top once this
 * passes clean.
 *
 * Every step logs its raw result so you can see exactly what Duffel
 * returned — pay close attention to the CHANGE FEE CHECK block,
 * since that's the real airline-fare-rule number (refund/extra
 * charge), not something Bodrless calculates itself.
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const duffelAdapter = require('./src/adapters/duffel'); // direct — for search only, to isolate from TravelDuqa's parallel search
const adapters = require('./src/adapters');              // the real router — used for everything past search

function line(label) {
  console.log('\n' + '═'.repeat(70));
  console.log(label);
  console.log('═'.repeat(70));
}

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

async function main() {
  const ORIGIN = 'LHR';
  const DESTINATION = 'JFK';
  const DEPARTURE_DATE = futureDate(14); // 2 weeks out
  const CHANGE_TO_DATE = futureDate(21); // change to 3 weeks out

  // ─────────────────────────────────────────
  // STEP 1: SEARCH
  // ─────────────────────────────────────────
  line('STEP 1: SEARCH — Duffel LHR → JFK');
  const offers = await duffelAdapter.search({
    origin: ORIGIN,
    destination: DESTINATION,
    date: DEPARTURE_DATE,
    passengers: 1,
  });

  console.log(`Got ${offers.length} offers.`);
  if (offers.length === 0) {
    console.error('No offers returned — cannot continue. Check DUFFEL_ACCESS_TOKEN and route.');
    process.exit(1);
  }

  // Filter out anything requiring instant payment — Bodrless's flow
  // is hold-then-pay, so those are cleanly ineligible (mirrors the
  // real check in bookingService.js's validatePackage).
  const holdEligible = offers.filter(o => o.requiresInstantPayment !== true);
  console.log(`${holdEligible.length} of those support hold (not requiresInstantPayment).`);

  if (holdEligible.length === 0) {
    console.error('Every returned offer requires instant payment — none are eligible for the hold flow. Cannot continue this test.');
    process.exit(1);
  }

  const chosenOffer = holdEligible[0];
  console.log('Chosen offer:', {
    offerId: chosenOffer.offerId,
    price: chosenOffer.price,
    currency: chosenOffer.currency,
    airline: chosenOffer.airline,
    departureTime: chosenOffer.departureTime,
    isRefundable: chosenOffer.isRefundable,
    requiresInstantPayment: chosenOffer.requiresInstantPayment,
    passengerIds: chosenOffer.passengerIds,
  });

  const duffelPassengerId = chosenOffer.passengerIds?.[0];
  if (!duffelPassengerId) {
    console.error('Chosen offer has no passengerIds — cannot book. Something is wrong with the offer normalization.');
    process.exit(1);
  }

  // ─────────────────────────────────────────
  // STEP 2: BOOK (hold order) — via the real router
  // ─────────────────────────────────────────
  line('STEP 2: BOOK — create hold order');

  const passengersForBooking = [{
    duffelPassengerId,
    firstName: 'Test',
    lastName: 'Traveler',
    dateOfBirth: '1990-01-01',
    gender: 'm',
    email: 'test.traveler@example.com',
    phone: '+254700000000',
  }];

  let flightResult;
  try {
    flightResult = await adapters.book({
      supplier: 'duffel',
      offerId: chosenOffer.offerId,
      passengers: passengersForBooking,
      totalAmount: chosenOffer.price,
      currency: chosenOffer.currency,
      type: 'hold',
      services: null,
    });
  } catch (err) {
    console.error('BOOK FAILED:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('Order created:', {
    orderId: flightResult.orderId,
    supplierBookingReference: flightResult.supplierBookingReference,
    type: flightResult.type,
    awaitingPayment: flightResult.awaitingPayment,
    totalAmount: flightResult.totalAmount,
    currency: flightResult.currency,
    sliceId: flightResult.sliceId,
  });

  if (flightResult.type !== 'hold') {
    console.warn(`WARNING: expected type 'hold' but got '${flightResult.type}' — check duffel.js's book() defaults.`);
  }
  if (flightResult.awaitingPayment !== true) {
    console.warn(`WARNING: expected awaitingPayment: true on a fresh hold order but got '${flightResult.awaitingPayment}'.`);
  }

  // ─────────────────────────────────────────
  // STEP 3: GET ORDER (fresh price before paying — Duffel's own
  // documented requirement, since search/booking price isn't
  // guaranteed to still match)
  // ─────────────────────────────────────────
  line('STEP 3: GET ORDER — fetch current price before paying');

  let currentOrder;
  try {
    currentOrder = await adapters.getOrder({ supplier: 'duffel', orderId: flightResult.orderId });
  } catch (err) {
    console.error('GET ORDER FAILED:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('Current order state:', {
    totalAmount: currentOrder.totalAmount,
    currency: currentOrder.currency,
    sliceId: currentOrder.sliceId,
    originIata: currentOrder.originIata,
    destIata: currentOrder.destIata,
  });

  // ─────────────────────────────────────────
  // STEP 4: PAY HOLD ORDER (simulating M-Pesa having succeeded)
  // ─────────────────────────────────────────
  line('STEP 4: PAY HOLD ORDER — simulating post-M-Pesa payment');

  let paymentResult;
  try {
    paymentResult = await adapters.payHoldOrder({
      supplier: 'duffel',
      orderId: flightResult.orderId,
      amount: currentOrder.totalAmount,
      currency: currentOrder.currency,
    });
  } catch (err) {
    console.error('PAY HOLD ORDER FAILED:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('Payment result:', paymentResult);
  console.log('If this did not throw, the hold order is now paid and ticketed with Duffel.');

  // ─────────────────────────────────────────
  // STEP 5: REQUEST ORDER CHANGE
  // ─────────────────────────────────────────
  line(`STEP 5: REQUEST CHANGE — move departure to ${CHANGE_TO_DATE}`);

  let changeRequest;
  try {
    changeRequest = await adapters.requestOrderChange({
      supplier: 'duffel',
      orderId: flightResult.orderId,
      removeSliceId: currentOrder.sliceId,
      addOrigin: currentOrder.originIata,
      addDestination: currentOrder.destIata,
      addDepartureDate: CHANGE_TO_DATE,
      cabinClass: 'economy',
    });
  } catch (err) {
    console.error('REQUEST ORDER CHANGE FAILED:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log(`Got ${changeRequest.offers.length} change offers.`);
  if (changeRequest.offers.length === 0) {
    console.error(`No change offers available for ${CHANGE_TO_DATE}. Try a different date and re-run — this is a normal "no availability" outcome, not necessarily a bug.`);
    process.exit(1);
  }

  const chosenChangeOffer = changeRequest.offers[0]; // cheapest first, per duffel.js sort

  line('CHANGE FEE CHECK — this is the real airline fare-rule number');
  console.log({
    offerId: chosenChangeOffer.offerId,
    changeTotalAmount: chosenChangeOffer.changeTotalAmount, // what's actually charged (negative = refund)
    changeTotalCurrency: chosenChangeOffer.changeTotalCurrency,
    penaltyAmount: chosenChangeOffer.penaltyAmount,
    penaltyCurrency: chosenChangeOffer.penaltyCurrency,
    newTotalAmount: chosenChangeOffer.newTotalAmount,
    newTotalCurrency: chosenChangeOffer.newTotalCurrency,
    refundAllowed: chosenChangeOffer.refundAllowed,
    changeAllowed: chosenChangeOffer.changeAllowed,
  });
  console.log('^ Confirm these numbers make sense (e.g. changeTotalAmount roughly = fare difference + any penalty).');

  // ─────────────────────────────────────────
  // STEP 6: CREATE PENDING CHANGE
  // ─────────────────────────────────────────
  line('STEP 6: CREATE PENDING CHANGE');

  let pendingChange;
  try {
    pendingChange = await adapters.createOrderChange({
      supplier: 'duffel',
      selectedOrderChangeOfferId: chosenChangeOffer.offerId,
    });
  } catch (err) {
    console.error('CREATE ORDER CHANGE FAILED:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('Pending change created:', pendingChange);

  // ─────────────────────────────────────────
  // STEP 7: CONFIRM CHANGE (actually applies it + charges/refunds)
  // ─────────────────────────────────────────
  line('STEP 7: CONFIRM CHANGE');

  let confirmedChange;
  try {
    confirmedChange = await adapters.confirmOrderChange({
      supplier: 'duffel',
      changeId: pendingChange.changeId,
      changeTotalAmount: chosenChangeOffer.changeTotalAmount,
      changeTotalCurrency: chosenChangeOffer.changeTotalCurrency,
    });
  } catch (err) {
    console.error('CONFIRM ORDER CHANGE FAILED:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('Change confirmed:', confirmedChange);

  // ─────────────────────────────────────────
  // STEP 8: VERIFY — fetch the order again, confirm it reflects
  // the new date/slice
  // ─────────────────────────────────────────
  line('STEP 8: VERIFY — re-fetch order after change');

  let finalOrder;
  try {
    finalOrder = await adapters.getOrder({ supplier: 'duffel', orderId: flightResult.orderId });
  } catch (err) {
    console.error('FINAL GET ORDER FAILED:', err.response?.data || err.message);
    process.exit(1);
  }

  console.log('Final order state:', {
    totalAmount: finalOrder.totalAmount,
    currency: finalOrder.currency,
    departureTime: finalOrder.departureTime,
  });

  line('DONE — full book -> pay -> change cycle completed without errors.');
  console.log('Order ID for reference:', flightResult.orderId);
}

main().catch(err => {
  console.error('\nUNEXPECTED FAILURE:', err.response?.data || err.stack || err.message);
  process.exit(1);
});