/**
 * SANDBOX TEST — validates the confirmFlightChange fix FOR REAL
 * ─────────────────────────────────────────────────────────────
 * The previous test script (testDuffelBookAndChange.js) calls the
 * Duffel adapter directly and bypasses bookingService.js entirely —
 * it can never show whether the fix inside confirmFlightChange()
 * actually works, because that function is never invoked.
 *
 * This script instead:
 *   1. Books + pays a real Duffel hold order (same as before)
 *   2. Inserts a matching row directly into Supabase's `bookings`
 *      table, shaped exactly as a real confirmed/paid Duffel
 *      booking would be
 *   3. Calls the REAL bookingService.requestFlightChange() and
 *      bookingService.confirmFlightChange() — the actual production
 *      functions, including the re-fetch-and-reconcile fix
 *   4. Independently re-fetches the order via the adapter AND reads
 *      back the Supabase row, and compares all three numbers:
 *      confirmFlightChange's returned total, the row actually
 *      persisted, and Duffel's own authoritative order total
 *   5. Cleans up the test row at the end either way
 *
 * Run from your project root:
 *   node testConfirmFlightChangeFix.js
 *
 * Requires:
 *   - DUFFEL_ACCESS_TOKEN (duffel_test_... token) in .env
 *   - SUPABASE_URL / SUPABASE_KEY (or however utils/supabase.js
 *     picks them up) in .env
 *   - At least one row in the `agencies` table — this script picks
 *     the first one it finds to satisfy the agency_id foreign key.
 *     Set TEST_AGENCY_ID in .env to force a specific one instead.
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const duffelAdapter = require('./src/adapters/duffel');
const adapters = require('./src/adapters');
const supabase = require('./bodrless-api-v2-main/src/utils/supabase');
const bookingService = require('./src/services/bookingService');

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
  const DEPARTURE_DATE = futureDate(14);
  const CHANGE_TO_DATE = futureDate(21);
  const TEST_BOOKING_REF = `TEST-${Date.now()}`;

  // ─────────────────────────────────────────
  // STEP 0: FIND A REAL AGENCY ID (foreign key requirement)
  // ─────────────────────────────────────────
  line('STEP 0: RESOLVE AGENCY ID');

  let agencyId = process.env.TEST_AGENCY_ID || null;
  if (!agencyId) {
    const { data: agencies, error: agencyErr } = await supabase
      .from('agencies')
      .select('id')
      .limit(1);
    if (agencyErr || !agencies?.length) {
      console.error('Could not find any agency row, and TEST_AGENCY_ID is not set in .env. Cannot continue — the bookings table requires a valid agency_id.');
      console.error('Set TEST_AGENCY_ID=<a real agency id> in your .env and re-run.');
      process.exit(1);
    }
    agencyId = agencies[0].id;
  }
  console.log('Using agencyId:', agencyId);

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

  const holdEligible = offers.filter(o => o.requiresInstantPayment !== true);
  if (holdEligible.length === 0) {
    console.error('No hold-eligible offers returned — cannot continue.');
    process.exit(1);
  }
  const chosenOffer = holdEligible[0];
  console.log('Chosen offer:', {
    offerId: chosenOffer.offerId,
    price: chosenOffer.price,
    currency: chosenOffer.currency,
    airline: chosenOffer.airline,
  });

  const duffelPassengerId = chosenOffer.passengerIds?.[0];

  // ─────────────────────────────────────────
  // STEP 2: BOOK (hold order)
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
    totalAmount: flightResult.totalAmount,
    currency: flightResult.currency,
  });

  // ─────────────────────────────────────────
  // STEP 3: PAY HOLD ORDER
  // ─────────────────────────────────────────
  line('STEP 3: PAY HOLD ORDER');
  let currentOrder;
  try {
    currentOrder = await adapters.getOrder({ supplier: 'duffel', orderId: flightResult.orderId });
    await adapters.payHoldOrder({
      supplier: 'duffel',
      orderId: flightResult.orderId,
      amount: currentOrder.totalAmount,
      currency: currentOrder.currency,
    });
  } catch (err) {
    console.error('PAY HOLD ORDER FAILED:', err.response?.data || err.message);
    process.exit(1);
  }
  console.log('Paid. Pre-change order total:', currentOrder.totalAmount, currentOrder.currency);

  // ─────────────────────────────────────────
  // STEP 4: INSERT A MATCHING BOOKING ROW
  // Shaped so bookingService.requestFlightChange /
  // confirmFlightChange will recognize it as a real, eligible,
  // paid Duffel booking.
  // ─────────────────────────────────────────
  line('STEP 4: INSERT TEST BOOKING ROW INTO SUPABASE');

  const { error: insertErr } = await supabase.from('bookings').insert({
    booking_ref: TEST_BOOKING_REF,
    agency_id: agencyId,
    guest_name: 'Test Traveler',
    guest_phone: '+254700000000',
    guest_email: 'test.traveler@example.com',
    origin: currentOrder.origin || ORIGIN,
    destination: currentOrder.destination || DESTINATION,
    passengers: 1,
    passenger_details: passengersForBooking,
    total_price: currentOrder.totalAmount,
    currency: currentOrder.currency,
    status: 'confirmed',
    booking_status: 'paid',
    booking_stage: 'paid',
    payment_status: 'paid',
    supplier_status: 'confirmed',
    supplier_order_id: flightResult.orderId,
    supplier_booking_reference: flightResult.supplierBookingReference,
    channel: 'test-script',
    package_snapshot: {
      transport: {
        supplier: 'duffel',
        originIata: currentOrder.originIata,
        destIata: currentOrder.destIata,
        cabinClass: 'economy',
      },
    },
  });

  if (insertErr) {
    console.error('Could not insert test booking row:', insertErr.message);
    process.exit(1);
  }
  console.log('Test booking row inserted:', TEST_BOOKING_REF);

  // From here on, wrap in try/finally so the test row always gets
  // cleaned up even if something fails partway through.
  try {
    // ─────────────────────────────────────────
    // STEP 5: bookingService.requestFlightChange() — THE REAL FUNCTION
    // ─────────────────────────────────────────
    line(`STEP 5: bookingService.requestFlightChange → ${CHANGE_TO_DATE}`);

    const changeOffersResult = await bookingService.requestFlightChange({
      bookingRef: TEST_BOOKING_REF,
      newDepartureDate: CHANGE_TO_DATE,
    });

    console.log('requestFlightChange result summary:', {
      success: changeOffersResult.success,
      hasOffers: changeOffersResult.hasOffers,
      error: changeOffersResult.error,
      offerCount: changeOffersResult.offers?.length,
    });

    if (!changeOffersResult.success || !changeOffersResult.hasOffers) {
      console.error('requestFlightChange did not return usable offers — cannot continue to confirmFlightChange. This may be a normal "no availability" outcome for this date; try re-running.');
      return;
    }

    const chosenChangeOffer = changeOffersResult.offers[0];
    console.log('Chosen change offer:', chosenChangeOffer);

    // ─────────────────────────────────────────
    // STEP 6: bookingService.confirmFlightChange() — THE REAL FUNCTION
    // This is what we're actually testing.
    // ─────────────────────────────────────────
    line('STEP 6: bookingService.confirmFlightChange — THE ACTUAL FIX');

    const confirmResult = await bookingService.confirmFlightChange({
      bookingRef: TEST_BOOKING_REF,
      offerId: chosenChangeOffer.offerId,
      changeTotalAmount: chosenChangeOffer.changeTotalAmount,
      changeTotalCurrency: chosenChangeOffer.changeTotalCurrency,
    });

    console.log('confirmFlightChange returned:', confirmResult);

    if (!confirmResult.success) {
      console.error('confirmFlightChange reported failure:', confirmResult.error);
      return;
    }

    // ─────────────────────────────────────────
    // STEP 7: INDEPENDENT VERIFICATION
    // Compare THREE numbers:
    //   a) what confirmFlightChange returned (newTotalAmount)
    //   b) what actually got persisted to the bookings row
    //   c) Duffel's own real, authoritative order total (getOrder)
    // All three should match if the fix is working correctly.
    // ─────────────────────────────────────────
    line('STEP 7: INDEPENDENT VERIFICATION — three numbers should match');

    const { data: persistedRow, error: fetchErr } = await supabase
      .from('bookings')
      .select('total_price, currency')
      .eq('booking_ref', TEST_BOOKING_REF)
      .single();

    let realOrder;
    try {
      realOrder = await adapters.getOrder({ supplier: 'duffel', orderId: flightResult.orderId });
    } catch (err) {
      console.error('Could not independently re-fetch order for verification:', err.response?.data || err.message);
    }

    console.log({
      'a) confirmFlightChange returned newTotalAmount': confirmResult.newTotalAmount,
      'b) persisted in Supabase bookings.total_price': fetchErr ? `ERROR: ${fetchErr.message}` : persistedRow?.total_price,
      'c) Duffel real order totalAmount (independent getOrder)': realOrder?.totalAmount,
    });

    const aMatchesC = realOrder && Number(confirmResult.newTotalAmount) === Number(realOrder.totalAmount);
    const bMatchesC = realOrder && persistedRow && Number(persistedRow.total_price) === Number(realOrder.totalAmount);

    if (aMatchesC && bMatchesC) {
      line('✅ PASS — the fix is working. All three totals match the real Duffel order total.');
    } else {
      line('❌ FAIL — mismatch detected. The fix is not fully correcting the stored/returned total.');
      console.log({ aMatchesC, bMatchesC });
    }

  } finally {
    // ─────────────────────────────────────────
    // CLEANUP — always remove the test row, pass or fail
    // ─────────────────────────────────────────
    line('CLEANUP — removing test booking row');
    const { error: deleteErr } = await supabase
      .from('bookings')
      .delete()
      .eq('booking_ref', TEST_BOOKING_REF);
    if (deleteErr) {
      console.warn('Could not delete test row — remove it manually:', TEST_BOOKING_REF, deleteErr.message);
    } else {
      console.log('Test row removed:', TEST_BOOKING_REF);
    }
  }

  console.log('\nOrder ID for reference (still live in Duffel sandbox):', flightResult.orderId);
}

main().catch(err => {
  console.error('\nUNEXPECTED FAILURE:', err.response?.data || err.stack || err.message);
  process.exit(1);
});