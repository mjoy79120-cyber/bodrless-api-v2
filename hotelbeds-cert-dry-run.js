/**
 * HOTELBEDS CERTIFICATION DRY RUN — HOTEL ONLY
 * ─────────────────────────────────────────────
 * Searches HotelBeds directly (via the adapter layer, bypassing
 * engine.js entirely — no flight/bus search, no promptParser/Groq
 * call, no destinationIntel) -> real hotel booking (sandbox, safe)
 * -> voucher -> cancel. Isolates exactly what HotelBeds certification
 * actually tests, with none of the flight-search noise.
 *
 * Matches HotelBeds' own certification test case:
 *   - Booking 6+ months out
 *   - 2 adults + 2 children (real ages, since HotelBeds needs them
 *     to price correctly)
 *   - Refundable rate
 *   - Shows the voucher
 *   - Cancels in the same run
 *
 * DELIBERATELY SKIPS INTASEND — bookingService.confirmPayment()
 * doesn't verify a real payment happened, it trusts the caller and
 * fires the voucher directly. No real M-Pesa charge, no sandbox
 * IntaSend keys needed.
 *
 * THIS WILL, FOR REAL:
 *   - Create a real row in your Supabase `bookings` table
 *   - Make a real (sandboxed, safe) HotelBeds booking
 *   - Send a real email via Resend to whatever email you set below
 *   - Send a real WhatsApp message via your agency's number to
 *     whatever phone you set below
 *   - Cancel the HotelBeds booking at the end (also safe/sandboxed)
 *
 * Use YOUR OWN email/phone below so the voucher lands somewhere you
 * can actually check it.
 * ─────────────────────────────────────────────
 */

require('dotenv').config();

const supplierAdapter = require('./src/adapters');
const bookingService   = require('./src/services/bookingService');

// ─── EDIT THESE BEFORE RUNNING ───────────────────────────────────
const AGENCY_ID    = 'azaki-adventures';       // real agency ID from your system
const GUEST_EMAIL  = 'petermwasi32@gmail.com';  // real email — voucher will be sent here
const GUEST_PHONE  = '254700000000';            // <-- put YOUR real WhatsApp number here (254 format)
const DESTINATION  = 'mombasa';                 // any HotelBeds-resolvable destination
// ──────────────────────────────────────────────────────────────────

function line() { console.log('─'.repeat(70)); }

function monthsFromNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// Age computed as of TODAY (not the future travel date) — matches
// bookingService._calculateAge's own assumption, so the reconciliation
// step sees a match and doesn't trigger an unnecessary PRICE_CHANGED
// re-price for this test run.
function dobForAge(age) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - age);
  return d.toISOString().split('T')[0];
}

async function main() {
  const nights   = 3;
  const checkIn  = monthsFromNow(7); // 7 months out, safely past the "6+" requirement
  const checkOut = addDays(checkIn, nights);

  line();
  console.log('STEP 1 — SEARCH HOTELS DIRECTLY (HotelBeds sandbox, no flight search at all)');
  line();
  console.log(`Destination: ${DESTINATION}  |  ${checkIn} -> ${checkOut}  |  2 adults + 2 children (8, 10)`);

  const hotels = await supplierAdapter.searchHotels({
    destination: DESTINATION,
    checkIn,
    checkOut,
    passengers: 4,
    adults: 2,
    children: 2,
    childAges: [8, 10],
    nights,
    budget: 'mid',
    rooms: 1,
  });

  console.log(`\nHotels found: ${hotels.length}`);

  const hotel = hotels.find(h => h.isRefundable !== false);
  if (!hotel) {
    console.log('❌ No refundable hotel found. Results:');
    hotels.forEach((h, i) => console.log(`  [${i}] ${h.name} isRefundable=${h.isRefundable}`));
    return;
  }

  console.log('\n✅ Selected hotel:');
  console.log(`   ${hotel.name} (${hotel.isRefundable === false ? 'NON-refundable — should not happen' : 'refundable'})`);
  console.log(`   Rate key: ${hotel.rateKey?.slice(0, 60)}...`);
  console.log(`   Rate type: ${hotel.rateType}`);
  console.log(`   Total: ${hotel.currency} ${hotel.totalRate}`);
  console.log(`   Hotel code (ATLAS): ${hotel.hotelCode}`);

  // Minimal package shape — matches exactly what bookingService.initBooking
  // reads (pkg.transport/hotel/transfers/summary). transport: null means
  // isFlightBooking evaluates false in validatePackage(), so no flight
  // logic runs at all.
  const pkg = {
    transport: null,
    hotel,
    transfers: null,
    summary: {
      totalPrice: hotel.totalRate,
      currency:   hotel.currency,
      nights,
      passengers: 4,
      occupancy: {
        adults: 2,
        children: 2,
        childAges: [8, 10],
        checkIn, checkOut, nights,
      },
    },
  };

  line();
  console.log('STEP 2 — INIT BOOKING (real HotelBeds sandbox booking, no money moved)');
  line();

  const bookingRef = `BDL${Date.now()}`; // matches real production format, safely under HotelBeds' 20-char clientReference limit

  const passengerDetails = [
    { firstName: 'John',   lastName: 'Doe', dateOfBirth: '1990-01-15', gender: 'male',   phone: GUEST_PHONE, email: GUEST_EMAIL, type: 'adult' },
    { firstName: 'Jane',   lastName: 'Doe', dateOfBirth: '1992-03-20', gender: 'female', phone: GUEST_PHONE, email: GUEST_EMAIL, type: 'adult' },
    { firstName: 'Junior', lastName: 'Doe', dateOfBirth: dobForAge(8),  gender: 'male',   type: 'child' },
    { firstName: 'Junie',  lastName: 'Doe', dateOfBirth: dobForAge(10), gender: 'female', type: 'child' },
  ];

  const initResult = await bookingService.initBooking({
    bookingRef,
    agencyId: AGENCY_ID,
    pkg,
    passengerDetails,
    guestName:  'John Doe',
    guestPhone: GUEST_PHONE,
    guestEmail: GUEST_EMAIL,
    channel: 'test',
  });

  console.log(JSON.stringify(initResult, null, 2));

  if (!initResult.success) {
    console.log('\n❌ Booking init failed — stopping here. See error above.');
    if (initResult.code === 'PRICE_CHANGED') {
      console.log('   (Price changed once real child ages were applied — this is expected');
      console.log('    HotelBeds cert behavior, not a bug. Re-run initBooking with');
      console.log('    priceApproved:true if you want to proceed at the new price —');
      console.log('    not automated in this script.)');
    }
    return;
  }

  console.log(`\n✅ Booking initialized. Stage: ${initResult.stage}`);
  console.log(`   Hotel confirmed: ${initResult.hotelConfirmed}`);

  line();
  console.log('STEP 3 — CONFIRM (skip IntaSend entirely — fires the real voucher code path)');
  line();

  const confirmResult = await bookingService.confirmPayment({ bookingRef });
  console.log(JSON.stringify(confirmResult, null, 2));

  if (!confirmResult.success) {
    console.log('\n❌ Confirm failed — see error above.');
    return;
  }

  console.log('\n✅ Booking confirmed. Voucher should now be sending via:');
  console.log(`   - Email to: ${GUEST_EMAIL}`);
  console.log(`   - WhatsApp to: ${GUEST_PHONE}`);
  console.log('   (fire-and-forget — check your inbox/WhatsApp in the next few seconds)');

  line();
  console.log('Waiting 5 seconds before cancellation, so the voucher has time to send...');
  line();
  await new Promise(r => setTimeout(r, 5000));

  console.log('STEP 4 — CANCEL (same session, per cert requirement)');
  line();

  const cancelResult = await bookingService.failPayment({ bookingRef });
  console.log(JSON.stringify(cancelResult, null, 2));

  if (cancelResult.supplierCancelSucceeded === false) {
    console.log('\n⚠️  IMPORTANT: the internal Supabase record says "cancelled", but the');
    console.log('    REAL HotelBeds cancellation call failed. The actual hotel booking');
    console.log('    may still be CONFIRMED on HotelBeds\' side. Check their sandbox/');
    console.log('    dashboard directly, or retry the cancel before treating this as done.');
  } else if (cancelResult.supplierCancelSucceeded === true) {
    console.log('\n✅ Confirmed: the real HotelBeds cancellation succeeded too, not just the local record.');
  }

  line();
  console.log(`DONE. Booking ref used: ${bookingRef}`);
  console.log('Check Supabase `bookings` table for this ref to see the full record.');
  line();
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});