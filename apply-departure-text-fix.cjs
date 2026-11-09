'use strict';
/**
 * apply-departure-text-fix.cjs
 *
 * Patches engine.js so the departure leg text tells the traveler:
 * "These connect through Nairobi — your transfer to Wilson or JKIA is included."
 * when the flight origin is a bush/safari destination that has no direct
 * international service (Masai Mara, Amboseli, etc.).
 *
 * Usage:
 *   node apply-departure-text-fix.cjs src/orchestration/engine.js
 */

const fs   = require('fs');
const path = require('path');

const [,, enginePath] = process.argv;
if (!enginePath) {
  console.error('Usage: node apply-departure-text-fix.cjs <path/to/engine.js>');
  process.exit(1);
}

const abs = path.resolve(enginePath);
if (!fs.existsSync(abs)) {
  console.error('File not found:', abs);
  process.exit(1);
}

// ── single edit: replace the 'departure' case in _buildLegResponseText ──
const EDITS = [
  {
    label: "_buildLegResponseText — departure case with Nairobi connection note",
    old: `      case 'departure':
        return \`**Return flight — \${origin} → \${dest}** (\${depFmt})\\n\` +
               \`\${count} flight option\${count !== 1 ? 's' : ''} back home. Transfer from your hotel to the airport is included.\`;`,
    new: `      case 'departure': {
        const _remoteOrigins = [
          'nairobi','mombasa','kampala','dar es salaam','kigali','addis ababa',
          'london','dubai','new york','washington','houston','johannesburg',
          'cape town','lagos','accra','cairo','casablanca',
        ];
        const _isRemote = !_remoteOrigins.includes((leg.origin || '').toLowerCase());
        const _connNote = _isRemote
          ? \` These connect through Nairobi — your transfer to Wilson or JKIA is included.\`
          : '';
        return \`**Return flight — \${origin} → \${dest}** (\${depFmt})\\n\` +
               \`\${count} flight option\${count !== 1 ? 's' : ''} back home.\${_connNote} Transfer from your hotel to the airport is included.\`;
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
    if (src.includes(edit.new.slice(0, 60))) {
      console.log(`⏭  SKIP (already applied): ${edit.label}`);
    } else {
      console.error(`✗  ANCHOR NOT FOUND: ${edit.label}`);
      console.error('\n   Looking for:\n' + edit.old.slice(0, 120));
      console.error('\n   Aborting — no changes written.');
      process.exit(1);
    }
    continue;
  }

  if (count > 1) {
    console.error(`✗  AMBIGUOUS ANCHOR (${count} matches): ${edit.label}`);
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

const bak = abs + '.bak2';
if (!fs.existsSync(bak)) {
  fs.copyFileSync(abs, bak);
  console.log(`\nBackup written → ${bak}`);
} else {
  console.log(`\nBackup already exists → ${bak} (not overwritten)`);
}

if (hasCRLF) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(abs, src, 'utf8');

console.log(`\n✅  engine.js patched — departure text updated.`);
console.log('\nWhat changed:');
console.log('  • Masai Mara → London departure card says:');
console.log('    "These connect through Nairobi — your transfer to Wilson or JKIA is included."');
console.log('  • Nairobi → London and other hub-to-hub routes show no connection note');
