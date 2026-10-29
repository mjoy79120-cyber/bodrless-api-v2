#!/usr/bin/env node
/**
 * Warm, human wording for the engine + WhatsApp webhook.
 * Usage:  node upgrade-server-copy.js path/to/webhook.js path/to/engine.js
 * Makes .bak copies first. If any edit point is not found it aborts and writes nothing.
 */
const fs = require('fs');
const [webhookPath, enginePath] = process.argv.slice(2);
if (!webhookPath || !enginePath) { console.error('Usage: node upgrade-server-copy.js <webhook.js> <engine.js>'); process.exit(1); }

const ENGINE_METHODS = String.raw`_warmResultsIntro(dest, count, dateLabel) {
    const s = count > 1 ? "s" : "";
    const pool = [
      "Leave it with me. I found " + count + " option" + s + " for " + dest + dateLabel + "." + (count > 1 ? " The first one is my pick." : ""),
      "Let's get you to " + dest + "! Here " + (count > 1 ? "are " : "is ") + count + " option" + s + dateLabel + ".",
      dest + ", lovely choice. I've lined up " + count + " option" + s + dateLabel + ".",
      "Good news, I've found " + count + " option" + s + " for " + dest + dateLabel + ".",
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  _warmTripIntro() {
    const pool = [
      "Here's your complete trip, leg by leg. I've taken care of the planning.",
      "Leave it with me. Your whole trip is below, broken down leg by leg.",
      "Let's build this together. Here's your trip, one leg at a time.",
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  `;

const WEBHOOK_ACK = String.raw`const ACKNOWLEDGMENT_MESSAGES = [
  "Let me take care of this for you 🔍 One moment...",
  "Leave it with me, pulling together some great options...",
  "Let's find you something good. Give me a moment...",
  "On it! Lining up the best options for you...",
  "Say less, searching now. One moment...",
  "Perfect, let me see what I can find for you...",
];

const NAMED_ACKNOWLEDGMENTS = [
  (n) => n + ", leave it with me. Finding you something good...",
  (n) => "Let me take care of this for you, " + n + ". One moment...",
  (n) => "On it, " + n + "! Lining up your options now...",
];

function _pickAcknowledgment(name) {
  const pool = ACKNOWLEDGMENT_MESSAGES.slice();
  const first = name ? String(name).trim().split(/\s+/)[0] : '';
  if (first) NAMED_ACKNOWLEDGMENTS.forEach(f => pool.push(f(first)));
  return pool[Math.floor(Math.random() * pool.length)];
}`;

const loose = (s) => new RegExp(s.trim().split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g');

const jobs = [
  { file: webhookPath, patches: [
    { name: 'webhook: warmer acknowledgment pool (+ uses traveler name)',
      re: /const ACKNOWLEDGMENT_MESSAGES = \[[\s\S]*?\];\s*function _pickAcknowledgment\(\) \{[\s\S]*?\n\}/, expect: 1, rep: () => WEBHOOK_ACK },
    { name: 'webhook: pass traveler name at the 3 call sites',
      re: /await whatsappService\.sendText\(phoneNumberId, recipient, _pickAcknowledgment\(\)\);/g, expect: 3,
      rep: () => 'await whatsappService.sendText(phoneNumberId, recipient, _pickAcknowledgment(contact?.name));' },
    { name: 'webhook: "Got it, thanks!" fallback',
      re: loose('"Got it, thanks!"'), expect: 1, rep: () => '"Thanks! Tell me where you\'d like to go next ✈️"' },
    { name: 'webhook: "Got it — cleared" reply',
      re: loose('"Got it — cleared. Just send me a destination whenever you\'re ready! ✈️"'), expect: 1,
      rep: () => '"All cleared! Send me a destination whenever you\'re ready ✈️"' },
    { name: 'webhook: leg selection confirmation',
      re: loose('✅ Got it — *Option ${optionNum}* selected for'), expect: 1,
      rep: () => '✅ Lovely choice — *Option ${optionNum}* selected for' },
  ]},
  { file: enginePath, patches: [
    { name: 'engine: warm results intro (replaces "Here are N options…")',
      re: /responseText = `Here are \$\{rankedPackages\.length\} option[^\n]*;/, expect: 1,
      rep: () => "responseText = this._warmResultsIntro(dest, rankedPackages.length, dateLabel) + (unavailableNotes ? ' ' + unavailableNotes : '') + dateNote;" },
    { name: 'engine: add _warmResultsIntro / _warmTripIntro methods',
      re: /_dedupeEquivalentFlights\(transportList\) \{/, expect: 1, rep: (m) => ENGINE_METHODS + m },
    { name: 'engine: warm intro for multi-leg trips',
      re: /\[`Here's your complete trip broken down by leg:`, \.\.\.noteParts\]/, expect: 1,
      rep: () => '[this._warmTripIntro(), ...noteParts]' },
    { name: 'engine: "just the flight" reply',
      re: /text: `Got it — just the flight to \$\{dest\}\.[^`]*`,/, expect: 1,
      rep: () => "text: `No problem, just the flight to ${dest}. Pick the option you like above and I'll get it booked for you.`," },
  ]},
];

const outputs = []; let failed = false;
for (const job of jobs) {
  let src = fs.readFileSync(job.file, 'utf8'), out = src;
  for (const p of job.patches) {
    const hits = (out.match(new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g')) || []).length;
    if (hits !== p.expect) { console.error('✗ ' + p.name + ': expected ' + p.expect + ' match(es), found ' + hits); failed = true; continue; }
    out = out.replace(p.re, (m) => p.rep(m)); console.log('✓ ' + p.name);
  }
  outputs.push({ file: job.file, src, out });
}
if (failed) { console.error('\nNothing written. Send me the lines that failed and I will adjust the anchors.'); process.exit(1); }
for (const o of outputs) { fs.writeFileSync(o.file + '.bak', o.src); fs.writeFileSync(o.file, o.out); }
console.log('\nDone. Backups saved as .bak next to each file.');