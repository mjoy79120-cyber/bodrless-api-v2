/**
 * SEAT MAP TEST
 * ─────────────────────────────────────────────
 * Fetches a REAL seat map for a given Duffel offer_id, classifies
 * every seat (window/aisle/middle + exit row), and prints both the
 * raw response summary and the classified output — so we can
 * confirm the classification logic against real data, and see
 * whether real `disclosures` fields clarify exit-row legroom
 * specifics the docs' sample data didn't show.
 *
 * Safe — read-only, doesn't book or select anything.
 *
 * USAGE:
 *   node seatmap-test.js <offer_id>
 *
 * Get a real offer_id from your Duffel search logs — look for
 * "id": "off_..." in a TRAVELDUQA/DUFFEL RAW RESPONSE log, or run
 * a fresh flight search and grab one from there.
 * ─────────────────────────────────────────────
 */

require('dotenv').config();

const seatSelection = require('./src/services/seatSelection');

async function main() {
  const offerId = process.argv[2];

  if (!offerId) {
    console.log('Usage: node seatmap-test.js <offer_id>');
    console.log('Get a real offer_id from a Duffel search log (looks like "off_...")');
    process.exit(1);
  }

  console.log(`Fetching seat map for offer: ${offerId}\n`);

  let seatMaps;
  try {
    seatMaps = await seatSelection.getSeatMap(offerId);
  } catch (err) {
    console.error('FAILED to fetch seat map:', err.message);
    if (err.response?.data) console.error('Detail:', JSON.stringify(err.response.data, null, 2));
    return;
  }

  console.log(`Seat maps returned: ${seatMaps.length} (one per flight segment)\n`);

  if (seatMaps.length === 0) {
    console.log('⚠️  Empty result — this is a NORMAL, expected response for some');
    console.log('   airlines/flights that don\'t support seat maps at all, not an error.');
    console.log('   Try a different offer_id (different airline) if you want to see real data.');
    return;
  }

  seatMaps.forEach((seatMap, i) => {
    console.log(`=== Segment ${i + 1} (segment_id: ${seatMap.segment_id}) ===`);

    const classified = seatSelection.classifySeatMap(seatMap);
    console.log(`Total real seats found: ${classified.length}\n`);

    // Show a sample of each position type + any exit rows
    const byType = { window: [], aisle: [], middle: [] };
    const exitRowSeats = [];
    classified.forEach(s => {
      byType[s.positionType]?.push(s.designator);
      if (s.isExitRow) exitRowSeats.push(s.designator);
    });

    console.log('Window seats (sample):', byType.window.slice(0, 8).join(', ') || 'none found');
    console.log('Aisle seats (sample): ', byType.aisle.slice(0, 8).join(', ') || 'none found');
    console.log('Middle seats (sample):', byType.middle.slice(0, 8).join(', ') || 'none found');
    console.log('Exit row seats:       ', exitRowSeats.join(', ') || 'none found');

    // Show real disclosures for a few seats, if any exist — this is
    // the field that might clarify legroom specifics the docs
    // sample didn't show.
    console.log('\n--- Checking for real "disclosures" data on seats ---');
    let foundDisclosures = false;
    for (const cabin of seatMap.cabins || []) {
      for (const row of cabin.rows || []) {
        for (const section of row.sections || []) {
          for (const el of section.elements || []) {
            if (el.type === 'seat' && Array.isArray(el.disclosures) && el.disclosures.length > 0) {
              console.log(`  Seat ${el.designator}:`, JSON.stringify(el.disclosures));
              foundDisclosures = true;
            }
          }
        }
      }
    }
    if (!foundDisclosures) console.log('  No disclosures found on any seat in this segment.');

    // Test preference matching with a placeholder passenger ID —
    // real passenger IDs come from the offer itself; check the raw
    // seat map's available_services for a real one to test against.
    const anyPassengerId = classified.find(s => s.availableServices?.length > 0)?.availableServices[0]?.passenger_id;
    if (anyPassengerId) {
      console.log(`\n--- Preference matching test (passenger: ${anyPassengerId}) ---`);
      ['window', 'aisle', 'middle', 'exit_row'].forEach(pref => {
        const match = seatSelection.findSeatForPreference(classified, pref, anyPassengerId);
        console.log(`  ${pref}:`, match ? `${match.designator} (${match.currency} ${match.price})` : 'no match found');
      });
    } else {
      console.log('\n⚠️  No available_services found for any passenger — every seat may be unavailable, or this offer has no priced seats.');
    }

    console.log('\n');
  });
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
});