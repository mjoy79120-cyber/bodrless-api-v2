'use strict';
/**
 * apply-widget-fix.cjs
 * Patches widget.js so single-destination package cards show
 * "Choose this option" + "Details ▾" instead of a bare "Book Now" button.
 *
 * Usage:
 *   node apply-widget-fix.cjs src/routes/widget.js
 */

const fs   = require('fs');
const path = require('path');

const [,, widgetPath] = process.argv;
if (!widgetPath) {
  console.error('Usage: node apply-widget-fix.cjs <path/to/widget.js>');
  process.exit(1);
}

const abs = path.resolve(widgetPath);
if (!fs.existsSync(abs)) {
  console.error('File not found:', abs);
  process.exit(1);
}

const ON_SELECT = `function(selectedPkg) { selectedPkgHold = { package: selectedPkg, savedAt: Date.now() }; persistState(); showNameFormStandalone(selectedPkg, null); }`;

// Simple global replacements — no multiline matching, no whitespace issues.
const EDITS = [
  // All "addPackage(p, i, null, null)" call sites (cached, history, map render)
  {
    label: 'addPackage(p, i, null, null) → onSelect (all sites)',
    old:   `addPackage(p, i, null, null)`,
    new:   `addPackage(p, i, 0, ${ON_SELECT})`,
    minExpected: 1,
  },
  // replayTranscript uses idx not i
  {
    label: 'addPackage(p, idx, null, null) → onSelect',
    old:   `addPackage(p, idx, null, null)`,
    new:   `addPackage(p, idx, 0, ${ON_SELECT})`,
    minExpected: 1,
  },
];

let src = fs.readFileSync(abs, 'utf8');
let changed = false;

for (const edit of EDITS) {
  const count = src.split(edit.old).length - 1;

  if (count === 0) {
    if (src.includes(edit.new.slice(0, 40))) {
      console.log(`⏭  SKIP (already applied): ${edit.label}`);
    } else {
      console.error(`✗  ANCHOR NOT FOUND: ${edit.label}`);
      console.error('   Aborting — no changes written.');
      process.exit(1);
    }
    continue;
  }

  console.log(`✓  PATCHED (${count} site${count > 1 ? 's' : ''}): ${edit.label}`);
  src = src.split(edit.old).join(edit.new);
  changed = true;
}

if (!changed) {
  console.log('\nAll edits already applied — nothing to write.');
  process.exit(0);
}

// Backup then write
const bak = abs + '.bak';
if (!fs.existsSync(bak)) {
  fs.copyFileSync(abs, bak);
  console.log(`\nBackup written → ${bak}`);
} else {
  console.log(`\nBackup already exists → ${bak} (not overwritten)`);
}

fs.writeFileSync(abs, src, 'utf8');
console.log(`\n✅  widget.js patched — deploy when ready.`);
console.log('\nWhat changed:');
console.log('  • All single-destination cards now show "Choose this option" + "Details ▾"');
console.log('  • Clicking "Choose this option" opens the passenger/booking form');
