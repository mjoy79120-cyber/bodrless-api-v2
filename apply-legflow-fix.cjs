// Widget: keep multi-leg trips in the leg-by-leg flow; locked legs no longer offer "Book Now".
// Usage (repo root):  node apply-legflow-fix.cjs src/routes/widget.js
const fs = require('fs');
const file = process.argv[2];
if (!file) { console.error('Usage: node apply-legflow-fix.cjs <widget.js>'); process.exit(1); }
const edits = [
  { name: 'W5 classified detection no longer depends on one flag', marker: 'r && r.role',
    find: /if\(data\.isClassifiedTrip\s*&&\s*Array\.isArray\(data\.tripResults\)\)\{/,
    replace: "if((data.isClassifiedTrip || (Array.isArray(data.tripResults) && data.tripResults.length > 1 && data.tripResults.every(function(r){ return r && r.role; }))) && Array.isArray(data.tripResults)){" },
  { name: 'W6 locked legs hide Book Now', marker: "card.querySelector('.book')",
    find: "if (isLocked && sel && pkg.packageId !== sel.packageId) card.style.opacity = '0.45';",
    replace: "if (isLocked && sel && pkg.packageId !== sel.packageId) card.style.opacity = '0.45';\n        if (isLocked) { var _bk = card.querySelector('.book'); if (_bk) _bk.style.display = 'none'; }" },
];
let src = fs.readFileSync(file, 'utf8'), failed = false;
for (const e of edits) {
  if (src.includes(e.marker)) { console.log('skip (already applied): ' + e.name); continue; }
  const n = typeof e.find === 'string' ? src.split(e.find).length - 1 : (src.match(new RegExp(e.find.source, 'g')) || []).length;
  if (n !== 1) { console.log('FAIL (found ' + n + ', need 1): ' + e.name); failed = true; continue; }
  src = typeof e.find === 'string' ? src.split(e.find).join(e.replace) : src.replace(e.find, () => e.replace);
  console.log('ok: ' + e.name);
}
if (failed) { console.error('Nothing written. Send me the FAIL lines.'); process.exit(1); }
fs.copyFileSync(file, file + '.bak3'); fs.writeFileSync(file, src); console.log('Done. Backup: ' + file + '.bak3');
