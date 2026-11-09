// Fixes the double-charged return flight on multi-leg (classified) trips.
// Single-destination search code is not touched.
// Usage (repo root):  node apply-return-fix.cjs src/orchestration/engine.js src/routes/widget.js
const fs = require('fs');
const [enginePath, widgetPath] = process.argv.slice(2);
if (!enginePath || !widgetPath) { console.error('Usage: node apply-return-fix.cjs <engine.js> <widget.js>'); process.exit(1); }

const edits = [
  { file: enginePath, name: 'E1 arrival leg no longer bundles the return flight',
    find: "const departureLeg = classifiedLegs.find(l => l._role === 'departure');",
    replace: "const departureLeg = null; // return flight is sold in the departure leg only (no double charge)" },
  { file: enginePath, name: 'E2 arrival text no longer promises a bundled return',
    find: 'Your return flight back to ${origin} is bundled in each package.',
    replace: 'Your flight home is shown as the final leg.' },
  { file: widgetPath, name: 'W1 tag new leg flows with a version',
    find: 'legFlow={active:true,startedAt', replace: 'legFlow={_v:3,active:true,startedAt' },
  { file: widgetPath, name: 'W2 discard untagged saved leg flows on restore',
    find: /legFlow\s*=\s*__r\.legFlow\s*\|\|\s*null;/,
    replace: 'legFlow = (__r.legFlow && __r.legFlow._v === 3) ? __r.legFlow : null;' },
  { file: widgetPath, name: 'W3 drop itineraryId with a discarded leg flow',
    find: /itineraryId\s*=\s*__r\.itineraryId\s*\|\|\s*null;/,
    replace: 'itineraryId = legFlow ? (__r.itineraryId || null) : null;' },
  { file: widgetPath, name: 'W4 booking guard: only the departure leg carries the return flight',
    find: 'selectedPackages.push(sels[si].package);',
    replace: "selectedPackages.push(legFlow.legs.some(function(l){ return l.role === 'departure'; }) && legFlow.legs[si].role !== 'departure' ? Object.assign({}, sels[si].package, { returnTransport: null }) : sels[si].package);" },
];

const text = {}; for (const f of new Set(edits.map(e => e.file))) text[f] = fs.readFileSync(f, 'utf8');
let failed = false; const log = [];
for (const e of edits) {
  const src = text[e.file];
  const count = typeof e.find === 'string' ? src.split(e.find).length - 1 : (src.match(new RegExp(e.find.source, 'g')) || []).length;
  const done = src.includes(e.replace);
  if (done && count === 0) { log.push('skip (already applied): ' + e.name); continue; }
  if (count !== 1) { log.push('FAIL (found ' + count + ' matches, need 1): ' + e.name); failed = true; continue; }
  text[e.file] = typeof e.find === 'string' ? src.replace(e.find, () => e.replace) : src.replace(e.find, () => e.replace);
  log.push('ok: ' + e.name);
}
console.log(log.join('\n'));
if (failed) { console.error('\nNothing written. Send me the FAIL lines.'); process.exit(1); }
for (const f of Object.keys(text)) { fs.copyFileSync(f, f + '.bak'); fs.writeFileSync(f, text[f]); }
console.log('\nDone. Backups: *.bak');
