'use strict';
/**
 * apply-safari-ground-fix.cjs
 *
 * Patches engine.js so that safari/bush destinations (Masai Mara, Amboseli, etc.)
 * use a ground transfer (land cruiser / safari van) instead of triggering a
 * flight search that ends up with NBO→NBO or hub fallbacks through Mombasa.
 *
 * Usage:
 *   node apply-safari-ground-fix.cjs src/orchestration/engine.js
 *
 * What it does:
 *   1. Adds SAFARI_GROUND detection to _resolveInternalTransportModes
 *   2. Skips flight search and returns a safari vehicle option when isGroundOnly
 *   3. Updates _buildLegResponseText 'internal' case to mention safari vehicle
 */

const fs   = require('fs');
const path = require('path');

const [,, enginePath] = process.argv;
if (!enginePath) {
  console.error('Usage: node apply-safari-ground-fix.cjs <path/to/engine.js>');
  process.exit(1);
}

const abs = path.resolve(enginePath);
if (!fs.existsSync(abs)) {
  console.error('File not found:', abs);
  process.exit(1);
}

const EDITS = [

  // ── 1. Add SAFARI_GROUND detection at top of _resolveInternalTransportModes ──
  {
    label: '_resolveInternalTransportModes — add safari ground check',
    old: `  _resolveInternalTransportModes(origin, destination) {
    const o = this._normalizeCity(origin);
    const d = this._normalizeCity(destination);

    const KNOWN_RAIL = [`,
    new: `  _resolveInternalTransportModes(origin, destination) {
    const o = this._normalizeCity(origin);
    const d = this._normalizeCity(destination);

    // Safari / bush destinations — road transfer only, no flight search needed
    const SAFARI_GROUND = [
      'masai mara', 'maasai mara', 'amboseli', 'tsavo', 'samburu',
      'ngorongoro', 'serengeti', 'tarangire', 'lake nakuru', 'ol pejeta',
      'laikipia', 'meru', 'selous', 'ruaha', 'bwindi', 'queen elizabeth',
      'mikumi', 'nyerere', 'murchison',
    ];
    if (SAFARI_GROUND.some(s => d.includes(s) || o.includes(s))) return ['ground'];

    const KNOWN_RAIL = [`,
  },

  // ── 2. Skip flight search when isGroundOnly; inject static safari vehicle ──
  {
    label: 'leg loop — skip flights for ground-only safari routes',
    old: `        const [flightResult, buses, trains] = await Promise.all([
          this._searchFlightsWithHubFallback(legParams, 'outbound', destAccess),
          transportModes.includes('bus')   ? this._searchBusesWithStaticFallback(legParams, 'outbound', destAccess) : Promise.resolve([]),
          transportModes.includes('train') ? this._searchTrain(legParams, 'outbound', destAccess)                   : Promise.resolve([]),
        ]);

        outboundFlights = this._dedupeEquivalentFlights(flightResult.results);
        outboundBuses   = buses;
        outboundTrains  = trains;`,
    new: `        const isGroundOnly = transportModes.includes('ground');

        const [flightResult, buses, trains] = await Promise.all([
          isGroundOnly
            ? Promise.resolve({ results: [], connectsVia: null, connectingLegBookable: true })
            : this._searchFlightsWithHubFallback(legParams, 'outbound', destAccess),
          transportModes.includes('bus')   ? this._searchBusesWithStaticFallback(legParams, 'outbound', destAccess) : Promise.resolve([]),
          transportModes.includes('train') ? this._searchTrain(legParams, 'outbound', destAccess)                   : Promise.resolve([]),
        ]);

        outboundFlights = this._dedupeEquivalentFlights(flightResult.results);
        outboundBuses   = isGroundOnly
          ? [{
              transportType: 'bus',
              provider:      'Safari Vehicle',
              description:   \`Land Cruiser / Safari Van — \${leg.origin} to \${leg.destination}\`,
              origin:        leg.origin,
              destination:   leg.destination,
              departureTime: null,
              arrivalTime:   null,
              price:         18000,
              currency:      'KES',
              priceKES:      18000,
              _groundTransfer: true,
              _safariVehicle:  true,
            }]
          : buses;
        outboundTrains  = trains;`,
  },

  // ── 3. Update 'internal' leg text to mention safari vehicle when relevant ──
  {
    label: '_buildLegResponseText — internal case mention safari vehicle',
    old: `      case 'internal':
        return \`**\${origin} → \${dest}** (\${depFmt})\\n\` +
               \`\${count} option\${count !== 1 ? 's' : ''} for getting to \${dest} — includes transport, hotel, and transfers.\`;`,
    new: `      case 'internal': {
        const _safariDests = ['masai mara','maasai mara','amboseli','tsavo','samburu','serengeti','ngorongoro','tarangire','ol pejeta','laikipia'];
        const _isSafari = _safariDests.some(s => (leg.destination||'').toLowerCase().includes(s));
        const _transportNote = _isSafari ? 'safari vehicle (land cruiser / van)' : 'transport';
        return \`**\${origin} → \${dest}** (\${depFmt})\\n\` +
               \`\${count} option\${count !== 1 ? 's' : ''} for getting to \${dest} — includes \${_transportNote}, lodge, and transfers.\`;
      }`,
  },

];

let src = fs.readFileSync(abs, 'utf8');
const hasCRLF = src.includes('\r\n');
if (hasCRLF) src = src.replace(/\r\n/g, '\n');

let changed = false;

for (const edit of EDITS) {
  const count = src.split(edit.old).length - 1;

  if (count === 0) {
    if (src.includes(edit.new.slice(0, 50))) {
      console.log(`⏭  SKIP (already applied): ${edit.label}`);
    } else {
      console.error(`✗  ANCHOR NOT FOUND: ${edit.label}`);
      console.error('   Aborting — no changes written.');
      process.exit(1);
    }
    continue;
  }

  if (count > 1) {
    console.error(`✗  AMBIGUOUS ANCHOR (${count} matches): ${edit.label}`);
    console.error('   Aborting — no changes written.');
    process.exit(1);
  }

  src = src.split(edit.old).join(edit.new);
  console.log(`✓  PATCHED: ${edit.label}`);
  changed = true;
}

if (!changed) {
  console.log('\nAll edits already applied — nothing to write.');
  process.exit(0);
}

const bak = abs + '.bak';
if (!fs.existsSync(bak)) {
  fs.copyFileSync(abs, bak);
  console.log(`\nBackup written → ${bak}`);
} else {
  console.log(`\nBackup already exists → ${bak} (not overwritten)`);
}

if (hasCRLF) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(abs, src, 'utf8');

console.log(`\n✅  engine.js patched — deploy when ready.`);
console.log('\nWhat changed:');
console.log('  • Safari destinations skip flight search entirely (no more NBO→NBO)');
console.log('  • Nairobi→Masai Mara shows Land Cruiser / Safari Van option');
console.log('  • Internal leg text says "safari vehicle, lodge, and transfers"');
console.log('\nNote: Nairobi overnight on departure leg is a separate script.');
