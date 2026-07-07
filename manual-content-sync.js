/**
 * ONE-TIME MANUAL HOTELBEDS CONTENT SYNC
 * ─────────────────────────────────────────────
 * Runs hotelbedsContent.syncAll() exactly once, from your own
 * machine, under your control — NOT via the live server's
 * ENABLE_HOTELBEDS_CONTENT_SYNC toggle, which reruns on every single
 * server restart/redeploy. Given real HotelBeds quota concerns
 * (evaluation-tier accounts are limited to 50 requests/day, possibly
 * shared across ALL API products, not just content), this lets you
 * run the sync deliberately, once, and see exactly how many requests
 * it used — rather than having it silently fire on every future
 * redeploy during active development.
 *
 * SAFE to run — this only reads hotel content and writes to your
 * own Supabase table, never touches bookings or payments.
 *
 * WARNING: this WILL make real requests against your HotelBeds
 * quota. If you're on the 50/day evaluation tier, consider limiting
 * HOTELBEDS_CONTENT_COUNTRIES to just ONE country first (e.g. just
 * KE) to see how many requests one country actually costs, before
 * running all three.
 * ─────────────────────────────────────────────
 */

require('dotenv').config();

// Optional override — set to a single country to test quota cost
// first, e.g.: process.env.HOTELBEDS_CONTENT_COUNTRIES = 'KE';
// Comment this out to use whatever's already in your .env/Render env.
process.env.HOTELBEDS_CONTENT_COUNTRIES = 'TZ,ZA,UG,MU';

const hotelbedsContent = require('./src/services/hotelbedsContent');

async function main() {
  console.log('Countries configured:', process.env.HOTELBEDS_CONTENT_COUNTRIES || 'KE,TZ,ZA (default)');
  console.log('Starting one-time content sync — this will make real HotelBeds API requests...\n');

  const startedAt = Date.now();
  const summary = await hotelbedsContent.syncAll();
  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n--- SYNC COMPLETE ---');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nDuration: ${durationSec}s`);
  console.log(`Total hotels synced: ${summary.synced}`);
  console.log(`Countries failed: ${summary.failed}`);

  if (summary.synced > 0) {
    console.log('\n✅ Check your Supabase hotelbeds_hotel_content table — it should now have real rows with image URLs.');
  } else {
    console.log('\n⚠️  Zero hotels synced — check the error details above, or your HOTELBEDS_API_KEY/SECRET.');
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});