// Runs the REAL router (adapters/index.js searchTransport) with no server, widget or background jobs.
//   node src/adapters/travelport/try-router.js [FROM TO DATE]      default NBO CPT <date 4 weeks out>
//   node src/adapters/travelport/try-router.js NBO CPT 2026-12-15 --only-travelport
require('dotenv').config();
process.env.TRAVELPORT_ENABLED = 'true';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const only = process.argv.includes('--only-travelport');
const d = new Date(); d.setDate(d.getDate() + 28);
const [origin, destination, date] = [args[0] || 'NBO', args[1] || 'CPT', args[2] || d.toISOString().slice(0, 10)];
const layer = require('../index');
if (only) { // skip the other suppliers so the test is fast and quiet
  for (const k of ['travelduqa', 'duffel']) layer.adapters[k] = { search: async () => [] };
}
(async () => {
  const t0 = Date.now();
  console.log(`searchTransport ${origin} > ${destination} ${date}${only ? ' (Travelport only)' : ''} ...`);
  const res = await layer.searchTransport({ origin, destination, date, passengers: 1, transportMode: 'flight' });
  const by = {}; for (const f of res) by[f.supplier] = (by[f.supplier] || 0) + 1;
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s | total ${res.length} |`, JSON.stringify(by));
  const tpf = res.filter((f) => f.supplier === 'travelport').slice(0, 5);
  for (const f of tpf) console.log(`  ${(f.flightNumbers || [f.flightNumber]).join('+')} ${f.originIata}>${(f.via || []).join('>')}${f.via?.length ? '>' : ''}${f.destIata} ${f.departureTime} ${f.price} ${f.currency} hold:${f.canHold}`);
  if (!by.travelport) console.log('No Travelport results. Check TP_* settings in .env and the "Travelport search failed" line above.');
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
