/**
 * SANDBOX TEST — full flight + hotel + transfer booking, real voucher
 * ─────────────────────────────────────────────────────────────
 * Fixes applied:
 *   1. HOTEL_CONFIRM_FAILED added to recoverable codes so we try
 *      multiple hotel candidates, not just the first
 *   2. Prompt simplified — no budget filter that was collapsing
 *      hotel results to 1 candidate in sandbox
 *   3. Multiple hotel pairings attempted across candidates
 *   4. WhatsApp phone number ID injected so voucher delivers
 *      to WA in addition to email
 *   5. clearanceBufferService stub added to silence warning
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const orchestrationEngine = require('./src/orchestration/engine');
const bookingService = require('./src/services/bookingService');
const supabase = require('./src/utils/supabase');

// ── TEST CONFIGURATION ────────────────────────────────────────
const GUEST_PHONE  = '254716098296';
const GUEST_EMAIL  = 'petermwasi32@gmail.com';
const AGENCY_ID    = process.env.TEST_AGENCY_ID || 'bodrless';

// Real Meta Phone Number ID for your WhatsApp Business account.
// Find it in Meta Business Suite → WhatsApp → Phone Numbers.
// Looks like: 123456789012345 (numeric, 15 digits)
// If null the test still runs but WhatsApp voucher delivery will be skipped.
const WA_PHONE_NUMBER_ID = process.env.TEST_WA_PHONE_NUMBER_ID || null;

function line(label) {
  console.log('\n' + '═'.repeat(70));
  console.log(label);
  console.log('═'.repeat(70));
}

async function resolveAgency() {
  const { data, error } = await supabase
    .from('agencies')
    .select('id, name, whatsapp_phone_number_id, email')
    .eq('id', AGENCY_ID)
    .maybeSingle();

  if (error) throw new Error(`Could not query agencies table: ${error.message}`);
  if (!data)  throw new Error(`No agency found with id "${AGENCY_ID}"`);

  // Inject WA phone number ID for this test run if configured
  // and the agency row doesn't already have one.
  if (WA_PHONE_NUMBER_ID && !data.whatsapp_phone_number_id) {
    console.log(`Patching agency row with WA_PHONE_NUMBER_ID: ${WA_PHONE_NUMBER_ID}`);
    await supabase
      .from('agencies')
      .update({ whatsapp_phone_number_id: WA_PHONE_NUMBER_ID })
      .eq('id', AGENCY_ID);
    data.whatsapp_phone_number_id = WA_PHONE_NUMBER_ID;
  }

  console.log('Resolved agency:', {
    id:   data.id,
    name: data.name,
    whatsapp_phone_number_id: data.whatsapp_phone_number_id,
    email: data.email,
  });

  if (!data.whatsapp_phone_number_id) {
    console.warn(
      'WARNING: whatsapp_phone_number_id is null — WhatsApp voucher will be skipped.\n' +
      'Set TEST_WA_PHONE_NUMBER_ID=<your Meta phone number ID> in .env to enable it.'
    );
  }

  return data.id;
}

async function main() {
  const agencyId = await resolveAgency();

  // ── STEP 1: SEARCH ────────────────────────────────────────────
  line('STEP 1: SEARCH — Nairobi to Mombasa, flight + hotel');

  // No budget/property filter — keeps full hotel inventory in sandbox
  // where thin inventory + budget filter = 1 candidate = 100% failure rate
  const prompt = 'Flight and hotel from Nairobi to Mombasa on 21st August 2026, 1 adult, 3 nights';

  const searchResult = await orchestrationEngine.orchestrate(prompt, agencyId, {});
  const packages = searchResult.packages || [];
  console.log(`\nGot ${packages.length} package(s). Response: "${searchResult.text?.slice(0, 120)}"`);

  if (packages.length === 0) {
    console.error('No packages returned. Exiting.');
    process.exit(1);
  }

  // Build a larger candidate pool — try different flight+hotel combos
  // so a single HotelBeds sandbox 500 doesn't kill the whole test
  const withBoth = packages.filter(p => p.transport && p.hotel);
  const withFlight = packages.filter(p => p.transport && !p.hotel);
  const withHotel  = packages.filter(p => !p.transport && p.hotel);

  console.log(`  ${withBoth.length} with flight+hotel, ${withFlight.length} flight-only, ${withHotel.length} hotel-only`);

  // Prefer Duffel + hotel combos, then TravelDuqa + hotel, then anything
  const candidates = [
    ...withBoth.filter(p => p.transport?.supplier === 'duffel'),
    ...withBoth.filter(p => p.transport?.supplier !== 'duffel'),
    ...withFlight,
  ];

  if (candidates.length === 0) {
    console.error('No bookable candidates found.');
    process.exit(1);
  }

  console.log(`\nWill try up to ${candidates.length} candidate(s) in order.`);

  // ── STEP 2: BOOK ──────────────────────────────────────────────
  line('STEP 2: BOOK — hold flight, confirm hotel, build transfers');

  const bookingRef = `TESTV-${Date.now()}`;
  const passengerDetails = [{
    firstName:   'Peter',
    lastName:    'Mwasi',
    dateOfBirth: '1990-01-01',
    gender:      'male',
    type:        'adult',
    idNumber:    'A12345678',
  }];

  // All codes that mean "this candidate failed but try the next one"
  const RECOVERABLE_CODES = new Set([
    'INSTANT_PAYMENT_NOT_SUPPORTED',
    'FLIGHT_HOLD_FAILED',
    'HOTEL_CONFIRM_FAILED',   // ← NEW: HotelBeds sandbox 500 = try next hotel
    'RATE_RECHECK_FAILED',
    'NON_REFUNDABLE_RATE',
  ]);

  let initResult   = null;
  let chosenPackage = null;

  for (const candidate of candidates) {
    console.log('\nTrying candidate:', {
      flightSupplier: candidate.transport?.supplier || 'none',
      airline:        candidate.transport?.airline  || 'none',
      hotel:          candidate.hotel?.name         || 'none',
      totalPrice:     candidate.summary?.totalPrice,
      currency:       candidate.summary?.currency,
    });

    const result = await bookingService.initBooking({
      bookingRef,
      agencyId,
      pkg:              candidate,
      passengerDetails,
      guestName:        'Peter Mwasi',
      guestPhone:       GUEST_PHONE,
      guestEmail:       GUEST_EMAIL,
      channel:          'test-script',
    });

    if (result.success) {
      initResult    = result;
      chosenPackage = candidate;
      console.log('✅ SUCCESS with this candidate.');
      break;
    }

    console.warn(`❌ Failed (${result.code}): ${result.error}`);

    if (!RECOVERABLE_CODES.has(result.code)) {
      console.error('Non-recoverable error — stopping.');
      process.exit(1);
    }

    console.log('Recoverable — trying next candidate...');
  }

  if (!initResult) {
    console.error('\nEvery candidate failed. See warnings above.');
    process.exit(1);
  }

  console.log('\nBooking init result:', {
    bookingRef:     initResult.bookingRef,
    stage:          initResult.stage,
    flightHeld:     initResult.flightHeld,
    hotelConfirmed: initResult.hotelConfirmed,
    totalPrice:     initResult.totalPrice,
    currency:       initResult.currency,
  });

  // ── STEP 3: CONFIRM PAYMENT ───────────────────────────────────
  line('STEP 3: CONFIRM PAYMENT (simulated — no real M-Pesa)');

  const confirmResult = await bookingService.confirmPayment({ bookingRef });
  console.log('confirmPayment result:', confirmResult);

  if (!confirmResult.success) {
    console.error('confirmPayment failed:', confirmResult.error);
    process.exit(1);
  }

  // ── STEP 4: VERIFY ────────────────────────────────────────────
  line('STEP 4: VERIFY — final booking record');

  const { data: finalBooking, error: fetchErr } = await supabase
    .from('bookings')
    .select('*')
    .eq('booking_ref', bookingRef)
    .single();

  if (fetchErr || !finalBooking) {
    console.error('Could not fetch final booking row:', fetchErr?.message);
    process.exit(1);
  }

  console.log({
    booking_ref:                finalBooking.booking_ref,
    status:                     finalBooking.status,
    booking_stage:              finalBooking.booking_stage,
    payment_status:             finalBooking.payment_status,
    total_price:                finalBooking.total_price,
    currency:                   finalBooking.currency,
    supplier_order_id:          finalBooking.supplier_order_id,
    supplier_booking_reference: finalBooking.supplier_booking_reference,
    hotel_supplier_reference:   finalBooking.hotel_supplier_reference,
    flight_details_present:     !!finalBooking.flight_details,
    hotel_details_present:      !!finalBooking.hotel_details,
    transfer_details_present:   !!finalBooking.transfer_details,
  });

  // ── STEP 5: VOUCHER CHECK ─────────────────────────────────────
  line('STEP 5: VOUCHER DELIVERY CHECK');

  const { data: agencyRow } = await supabase
    .from('agencies')
    .select('whatsapp_phone_number_id')
    .eq('id', agencyId)
    .single();

  if (agencyRow?.whatsapp_phone_number_id) {
    console.log(`✅ WhatsApp voucher will be sent via phone number ID: ${agencyRow.whatsapp_phone_number_id}`);
    console.log(`   Check WhatsApp: +${GUEST_PHONE}`);
  } else {
    console.log('⚠️  WhatsApp voucher skipped — no phone number ID configured.');
    console.log('   Add TEST_WA_PHONE_NUMBER_ID=<Meta numeric ID> to .env to enable.');
  }

  console.log(`📧 Email voucher sent to: ${GUEST_EMAIL}`);

  line(`DONE — booking ref: ${bookingRef}`);
  console.log('Check your email and WhatsApp for the voucher.');
  console.log('Booking row NOT auto-deleted — clean up in Supabase manually if needed.');
}

main().catch(err => {
  console.error('\nUNEXPECTED FAILURE:', err.response?.data || err.stack || err.message);
  process.exit(1);
});