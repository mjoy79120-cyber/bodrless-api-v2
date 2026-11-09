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

// Each edit targets just the specific addPackage() call — no multiline matching needed.
const EDITS = [
  {
    label: 'shown.forEach — map render (p, i)',
    // The three p,i call sites each sit on their own line; we match them by surrounding context
    old: `var card = addPackage(p, i, null, null);\n      _decorateCard(card, p, i, badges[i]);`,
    new: `var card = addPackage(p, i, 0, ${ON_SELECT});\n      _decorateCard(card, p, i, badges[i]);`,
  },
  {
    label: 'd.packages_cached render (p, i)',
    old: `var card = addPackage(p, i, null, null);\n        messages.appendChild(card);`,
    new: `var card = addPackage(p, i, 0, ${ON_SELECT});\n        messages.appendChild(card);`,
  },
  {
    label: 'msg.packages history render (p, i)',
    old: `messages.appendChild(addPackage(p, i, null, null));`,
    new: `messages.appendChild(addPackage(p, i, 0, ${ON_SELECT}));`,
  },
  {
    label: 'replayTranscript packages (p, idx)',
    old: `addPackage(p, idx, null, null);`,
    new: `messages.appendChild(addPackage(p, idx, 0, ${ON_SELECT}));`,
  },
];

let raw = fs.readFileSync(abs, 'utf8');
// Normalise line endings for matching; remember whether to restore them
const hasCRLF = raw.includes('\r\n');
let src = hasCRLF ? raw.replace(/\r\n/g, '\n') : raw;

let changed = false;

for (const edit of EDITS) {
  const count = (src.split(edit.old).length - 1);

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
    console.error(`✗  ANCHOR MATCHES ${count} TIMES (ambiguous): ${edit.label}`);
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

// Backup then write
const bak = abs + '.bak';
if (!fs.existsSync(bak)) {
  fs.copyFileSync(abs, bak);
  console.log(`\nBackup written → ${bak}`);
} else {
  console.log(`\nBackup already exists → ${bak} (not overwritten)`);
}

if (hasCRLF) src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(abs, src, 'utf8');
console.log(`\n✅  widget.js patched — deploy when ready.`);
