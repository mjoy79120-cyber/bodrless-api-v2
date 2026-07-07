/**
 * SANDBOX TEST — full flight + hotel + transfer booking, real voucher
 * ─────────────────────────────────────────────────────────────
 * Bypasses M-Pesa/IntaSend entirely. bookingService.confirmPayment()
 * itself does NOT call IntaSend at all — it pays Duffel's hold order
 * directly (sandbox balance, no real money) and fires the voucher.
 * IntaSend only exists to COLLECT money from the traveler; calling
 * confirmPayment() directly simulates "payment already succeeded"
 * and exercises everything downstream of that — real flight
 * ticketing, real hotel confirmation, transfer legs, and voucher
 * generation — without needing a real STK push.
 *
 * Run from your project root:
 *   node testFullVoucherBooking.js
 *
 * Requires:
 *   - DUFFEL_ACCESS_TOKEN (duffel_test_...) in .env
 *   - HOTELBEDS credentials configured (as used by the real app)
 *   - SUPABASE_URL / SUPABASE_KEY in .env
 *   - The "bodrless" agency row in Supabase's agencies table, with
 *     a correctly-configured whatsapp_phone_number_id (the real
 *     numeric Meta Phone Number ID, not a phone number)
 *
 * This does NOT delete the resulting booking row afterward — unlike
 * earlier throwaway test scripts, this one is meant to produce a
 * real, deliverable voucher. Clean it up manually in Supabase later
 * if you want.
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const orchestrationEngine = require('./src/orchestration/engine');
const bookingService = require('./src/services/bookingService');
const supabase = require('./src/utils/supabase');

const GUEST_PHONE = '254716098296';
const GUEST_EMAIL = 'petermwasi32@gmail.com';

function line(label) {
  console.log('\n' + '═'.repeat(70));
  console.log(label);
  console.log('═'.repeat(70));
}

async function resolveAgency() {
  const AGENCY_ID = process.env.TEST_AGENCY_ID || 'azaki-adventures';

  const { data, error } = await supabase
    .from('agencies')
    .select('id, name, whatsapp_phone_number_id, email')
    .eq('id', AGENCY_ID)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not query agencies table: ${error.message}`);
  }
  if (!data) {
    throw new Error(`No agency found with id "${AGENCY_ID}". Set TEST_AGENCY_ID in .env to override.`);
  }

  console.log('Resolved agency:', {
    id: data.id,
    name: data.name,
    whatsapp_phone_number_id: data.whatsapp_phone_number_id,
    email: data.email,
  });

  if (!data.whatsapp_phone_number_id || /^\+?\d{7,15}$/.test(data.whatsapp_phone_number_id) === false) {
    console.warn('WARNING: whatsapp_phone_number_id does not look like a Meta numeric Phone Number ID — WhatsApp voucher delivery may fail. Value:', data.whatsapp_phone_number_id);
  }

  return data.id;
}

async function main() {
  const agencyId = await resolveAgency();

  // ─────────────────────────────────────────
  // STEP 1: REAL SEARCH — flight + hotel + transfer, via the actual
  // production engine (same code path as WhatsApp/widget)
  // ─────────────────────────────────────────
  line('STEP 1: SEARCH — Nairobi to Mombasa, flight + hotel');

  const prompt = 'Flight and hotel from Nairobi to Mombasa on 21st August 2026, 1 adult, 3 nights, mid budget';
  const searchResult = await orchestrationEngine.orchestrate(prompt, agencyId, {});

  const packages = searchResult.packages || [];
  console.log(`Got ${packages.length} package(s).`);

  if (packages.length === 0) {
    console.error('No packages returned at all. Response text was:', searchResult.text);
    process.exit(1);
  }

  // Prefer a package with BOTH a flight and a hotel — this prompt
  // should produce that, but don't assume; filter explicitly.
  const candidates = packages.filter(p => p.transport && p.hotel);
  console.log(`${candidates.length} of those have both a flight and a hotel.`);

  if (candidates.length === 0) {
    console.error('No package had both a flight and a hotel. Package summaries:', packages.map(p => ({
      hasTransport: !!p.transport, hasHotel: !!p.hotel, route: p.summary?.route,
    })));
    process.exit(1);
  }

  // Prefer Duffel flights first (already proven end-to-end today),
  // but fall back to whatever's available.
  candidates.sort((a, b) => {
    const aDuffel = a.transport?.supplier === 'duffel' ? 0 : 1;
    const bDuffel = b.transport?.supplier === 'duffel' ? 0 : 1;
    return aDuffel - bDuffel;
  });

  // ─────────────────────────────────────────
  // STEP 2: BOOK — try candidates in order until one succeeds.
  // Mirrors the real WhatsApp flow's behavior when a candidate
  // turns out to require instant payment (rejected cleanly, try the
  // next one) rather than assuming the first candidate always works.
  // ─────────────────────────────────────────
  line('STEP 2: BOOK — hold flight, confirm hotel, build transfers');

  const bookingRef = `TESTV-${Date.now()}`;
  const passengerDetails = [{
    firstName: 'Peter',
    lastName: 'Mwasi',
    dateOfBirth: '1990-01-01',
    gender: 'male',
    type: 'adult',
    idNumber: 'A12345678',
  }];

  let initResult = null;
  let chosenPackage = null;

  for (const candidate of candidates) {
    console.log('\nTrying candidate:', {
      supplier: candidate.transport?.supplier,
      airline: candidate.transport?.airline,
      hotel: candidate.hotel?.name,
      totalPrice: candidate.summary?.totalPrice,
      currency: candidate.summary?.currency,
    });

    const result = await bookingService.initBooking({
      bookingRef,
      agencyId,
      pkg: candidate,
      passengerDetails,
      guestName: 'Peter Mwasi',
      guestPhone: GUEST_PHONE,
      guestEmail: GUEST_EMAIL,
      channel: 'test-script',
    });

    if (result.success) {
      initResult = result;
      chosenPackage = candidate;
      console.log('SUCCESS with this candidate.');
      break;
    } else {
      console.warn('Candidate failed:', result.code, '-', result.error);
      if (result.code !== 'INSTANT_PAYMENT_NOT_SUPPORTED' && result.code !== 'FLIGHT_HOLD_FAILED') {
        // Not a "try the next flight" situation (e.g. hotel/price
        // issue) — no point trying other candidates with the same
        // hotel search, so stop here rather than looping pointlessly.
        console.error('Non-recoverable failure — stopping.');
        process.exit(1);
      }
    }
  }

  if (!initResult) {
    console.error('Every candidate failed to book. See warnings above.');
    process.exit(1);
  }

  console.log('\nBooking init result:', {
    bookingRef: initResult.bookingRef,
    stage: initResult.stage,
    flightHeld: initResult.flightHeld,
    hotelConfirmed: initResult.hotelConfirmed,
    totalPrice: initResult.totalPrice,
    currency: initResult.currency,
  });

  // ─────────────────────────────────────────
  // STEP 3: CONFIRM PAYMENT — bypassing M-Pesa entirely.
  // This is the real production function the IntaSend webhook calls
  // on a genuine COMPLETE event — we're simulating that the
  // traveler's payment already succeeded. It pays Duffel's hold
  // order for real (sandbox balance) and fires the voucher.
  // ─────────────────────────────────────────
  line('STEP 3: CONFIRM PAYMENT (simulated — no real M-Pesa involved)');

  const confirmResult = await bookingService.confirmPayment({ bookingRef });
  console.log('confirmPayment result:', confirmResult);

  if (!confirmResult.success) {
    console.error('confirmPayment failed:', confirmResult.error);
    process.exit(1);
  }

  // ─────────────────────────────────────────
  // STEP 4: VERIFY — pull the final booking row and print everything
  // relevant to confirm flight + hotel + transfer are all present.
  // ─────────────────────────────────────────
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
    booking_ref: finalBooking.booking_ref,
    status: finalBooking.status,
    booking_stage: finalBooking.booking_stage,
    payment_status: finalBooking.payment_status,
    total_price: finalBooking.total_price,
    currency: finalBooking.currency,
    supplier_order_id: finalBooking.supplier_order_id,
    supplier_booking_reference: finalBooking.supplier_booking_reference,
    hotel_supplier_reference: finalBooking.hotel_supplier_reference,
    flight_details_present: !!finalBooking.flight_details,
    hotel_details_present: !!finalBooking.hotel_details,
    transfer_details_present: !!finalBooking.transfer_details,
  });

  line('DONE — check WhatsApp (' + GUEST_PHONE + ') and email (' + GUEST_EMAIL + ') for the voucher.');
  console.log('Booking ref (not auto-deleted):', bookingRef);
}

main().catch(err => {
  console.error('\nUNEXPECTED FAILURE:', err.response?.data || err.stack || err.message);
  process.exit(1);
});