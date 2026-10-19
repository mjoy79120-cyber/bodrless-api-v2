/**
 * SANDBOX TEST — full flight + hotel + transfer booking, real voucher
 * ─────────────────────────────────────────────────────────────
 * Fixes applied:
 *   1. HOTEL_CONFIRM_FAILED triggers a fresh search before the next
 *      hotel attempt — Duffel invalidates the whole offer_request once
 *      any offer from it is booked/cancelled, so stale offer IDs from
 *      the same search will always get offer_request_already_booked (422)
 *   2. Fresh search retries capped at 3 to avoid infinite loops
 *   3. No budget filter — keeps full hotel inventory in sandbox
 *   4. WhatsApp delivery skipped (no WA_PHONE_NUMBER_ID needed)
 *   5. 8-second tail wait so fire-and-forget voucher delivery resolves
 *      before Node exits
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const orchestrationEngine = require('./src/orchestration/engine');
const bookingService = require('./src/services/bookingService');
const supabase = require('./src/utils/supabase');

// ── TEST CONFIGURATION ────────────────────────────────────────
const GUEST_PHONE = '254716098296';
const GUEST_EMAIL = 'petermwasi32@gmail.com';
const AGENCY_ID   = process.env.TEST_AGENCY_ID || 'bodrless';
const SEARCH_PROMPT = 'Flight and hotel from Nairobi to Mombasa on 21st August 2026, 1 adult, 3 nights';
const MAX_FRESH_SEARCHES = 3;

function line(label) {
  console.log('\n' + '═'.repeat(70));
  console.log(label);
  console.log('═'.repeat(70));
}

async function resolveAgency() {
  const { data, error } = await supabase
    .from('agencies')
    .select('id, name, email, whatsapp_phone_number_id')
    .eq('id', AGENCY_ID)
    .maybeSingle();

  if (error) throw new Error(`Could not query agencies table: ${error.message}`);
  if (!data)  throw new Error(`No agency found with id "${AGENCY_ID}"`);

  console.log('Resolved agency:', {
    id:    data.id,
    name:  data.name,
    email: data.email,
  });

  if (!data.whatsapp_phone_number_id) {
    console.warn('WARNING: whatsapp_phone_number_id is null — WhatsApp voucher will be skipped.');
  }

  return data.id;
}

// Re-runs the search and returns a fresh candidate list.
// Called after HOTEL_CONFIRM_FAILED because Duffel invalidates the
// entire offer_request once any offer from it is booked or cancelled —
// any subsequent hold attempt against the same offer IDs gets 422
// offer_request_already_booked.
async function freshCandidates(agencyId, attempt) {
  console.log(`\n🔄 Fresh search #${attempt} — getting new Duffel offer IDs...`);
  const searchResult = await orchestrationEngine.orchestrate(SEARCH_PROMPT, agencyId, {});
  const packages = searchResult.packages || [];
  console.log(`   Got ${packages.length} package(s) from fresh search.`);

  if (packages.length === 0) return [];

  const withBoth = packages.filter(p => p.transport && p.hotel);
  return [
    ...withBoth.filter(p => p.transport?.supplier === 'duffel'),
    ...withBoth.filter(p => p.transport?.supplier !== 'duffel'),
    ...packages.filter(p => p.transport && !p.hotel),
  ];
}

async function main() {
  const agencyId = await resolveAgency();

  // ── STEP 1: SEARCH ────────────────────────────────────────────
  line('STEP 1: SEARCH — Nairobi to Mombasa, flight + hotel');

  const searchResult = await orchestrationEngine.orchestrate(SEARCH_PROMPT, agencyId, {});
  const packages = searchResult.packages || [];
  console.log(`\nGot ${packages.length} package(s). Response: "${searchResult.text?.slice(0, 120)}"`);

  if (packages.length === 0) {
    console.error('No packages returned. Exiting.');
    process.exit(1);
  }

  const withBoth   = packages.filter(p => p.transport && p.hotel);
  const withFlight = packages.filter(p => p.transport && !p.hotel);
  const withHotel  = packages.filter(p => !p.transport && p.hotel);

  console.log(`  ${withBoth.length} with flight+hotel, ${withFlight.length} flight-only, ${withHotel.length} hotel-only`);

  let candidates = [
    ...withBoth.filter(p => p.transport?.supplier === 'duffel'),
    ...withBoth.filter(p => p.transport?.supplier !== 'duffel'),
    ...withFlight,
  ];

  if (candidates.length === 0) {
    console.error('No bookable candidates found.');
    process.exit(1);
  }

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

  // Codes where we try the next candidate
  const RETRY_NEXT = new Set([
    'INSTANT_PAYMENT_NOT_SUPPORTED',
    'FLIGHT_HOLD_FAILED',
    'RATE_RECHECK_FAILED',
    'NON_REFUNDABLE_RATE',
  ]);

  let initResult    = null;
  let freshSearchCount = 0;
  let candidateIndex   = 0;

  while (!initResult) {
    if (candidateIndex >= candidates.length) {
      // Exhausted this candidate list — do a fresh search
      if (freshSearchCount >= MAX_FRESH_SEARCHES) {
        console.error(`\nExhausted ${MAX_FRESH_SEARCHES} fresh searches. All candidates failed.`);
        process.exit(1);
      }
      freshSearchCount++;
      candidates = await freshCandidates(agencyId, freshSearchCount);
      candidateIndex = 0;

      if (candidates.length === 0) {
        console.error('\nFresh search returned no candidates.');
        process.exit(1);
      }
    }

    const candidate = candidates[candidateIndex];
    candidateIndex++;

    console.log(`\nTrying candidate ${candidateIndex} (fresh search #${freshSearchCount}):`, {
      flightSupplier: candidate.transport?.supplier || 'none',
      airline:        candidate.transport?.airline  || 'none',
      offerId:        candidate.transport?.offerId  || 'none',
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
      initResult = result;
      console.log('✅ SUCCESS with this candidate.');
      break;
    }

    console.warn(`❌ Failed (${result.code}): ${result.error}`);

    if (result.code === 'HOTEL_CONFIRM_FAILED') {
      // KEY FIX: Duffel invalidates the entire offer_request after a
      // hold+cancel cycle. We must do a fresh search — not just move to
      // the next candidate — because all remaining candidates share the
      // same (now-invalidated) offer_request_id.
      console.log('HOTEL_CONFIRM_FAILED — forcing fresh search to get new offer IDs before retrying.');
      freshSearchCount++;
      if (freshSearchCount > MAX_FRESH_SEARCHES) {
        console.error(`Exceeded max fresh searches (${MAX_FRESH_SEARCHES}). Giving up.`);
        process.exit(1);
      }
      candidates = await freshCandidates(agencyId, freshSearchCount);
      candidateIndex = 0;
      continue;
    }

    if (!RETRY_NEXT.has(result.code)) {
      console.error('Non-recoverable error — stopping.');
      process.exit(1);
    }

    console.log('Recoverable — trying next candidate...');
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

  // ── STEP 5: VOUCHER WAIT ──────────────────────────────────────
  line('STEP 5: WAITING FOR EMAIL VOUCHER DELIVERY');

  console.log(`📧 Email voucher firing to: ${GUEST_EMAIL}`);
  console.log('Waiting 8 seconds for async voucher delivery to complete...');

  // confirmPayment fires _fetchAgencyAndFireVoucher as fire-and-forget.
  // Without this wait the Node process exits before the Promise resolves.
  await new Promise(resolve => setTimeout(resolve, 8000));

  line(`DONE — booking ref: ${bookingRef}`);
  console.log(`Check ${GUEST_EMAIL} for your voucher.`);
  console.log('Booking row NOT auto-deleted — clean up in Supabase manually if needed.');
}

main().catch(err => {
  console.error('\nUNEXPECTED FAILURE:', err.response?.data || err.stack || err.message);
  process.exit(1);
});