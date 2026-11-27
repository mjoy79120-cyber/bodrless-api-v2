'use strict';
const fs = require('fs'); const path = require('path');
const { normalizeTravelportBooking } = require('./normalize-booking');
const out = path.join(__dirname, 'out');
const files = fs.readdirSync(out).filter((f) => /^retrieve-.*\.json$/.test(f) && !/headers/.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(out, f)).mtimeMs })).sort((a, b) => b.t - a.t);
if (!files.length) { console.log('No retrieve file. Run: node src\\adapters\\travelport\\try-book.js retrieve'); process.exit(1); }
const b = normalizeTravelportBooking(JSON.parse(fs.readFileSync(path.join(out, files[0].f), 'utf8')));
console.log('File:', files[0].f);
console.log(`Locator ${b.locator} | airline ${b.airlineLocators.map((a) => a.airline + ' ' + a.locator).join(', ')} | status ${b.status}`);
console.log(`Pay by ${b.paymentTimeLimit} | ${b.price.total} ${b.price.currency} | refundable: ${b.isRefundable}`);
b.segments.forEach((s) => console.log(`  ${s.flightNumber} ${s.origin}>${s.destination} ${s.departureTime}`));
console.log('Travellers:', b.travellers.map((t) => `${t.firstName} ${t.lastName}`).join(', '));
