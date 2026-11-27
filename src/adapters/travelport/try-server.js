// Tiny local test server (search only, no main app needed). From the project root:
//   node src/adapters/travelport/try-server.js
// Then open in a browser:
//   http://localhost:3999/search?from=JFK&to=LAX&date=2026-12-20
// Optional: &carrier=AA  &ndc=true  &limit=20
require('dotenv').config();
const http = require('http');
const tp = require('../travelport');
const PORT = Number(process.env.TP_TEST_PORT) || 3999;

http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj, null, 2)); };
  if (u.pathname === '/') return send(200, { try: `http://localhost:${PORT}/search?from=JFK&to=LAX&date=2026-12-20` });
  if (u.pathname !== '/search') return send(404, { error: 'Use /search?from=JFK&to=LAX&date=YYYY-MM-DD' });
  const q = Object.fromEntries(u.searchParams);
  if (!/^[A-Za-z]{3}$/.test(q.from || '') || !/^[A-Za-z]{3}$/.test(q.to || '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.date || '')) {
    return send(400, { error: 'Need from=XXX&to=YYY (3-letter airport codes) and date=YYYY-MM-DD' });
  }
  try {
    const t0 = Date.now();
    const flights = await tp.search({
      origin: q.from.toUpperCase(), destination: q.to.toUpperCase(), date: q.date,
      carriers: q.carrier ? [q.carrier.toUpperCase()] : undefined,
      passengers: Number(q.pax) || 1, returnDate: q.return || null,
    });
    const limit = Number(q.limit) || 20;
    send(200, {
      count: flights.length, shown: Math.min(limit, flights.length), ms: Date.now() - t0,
      flights: flights.slice(0, limit).map((f) => ({
        supplier: f.supplier, source: f.contentSource, flights: (f.flightNumbers || [f.flightNumber]).join(' + '), route: [f.originIata, ...(f.via || []), f.destIata].join('>'),
        departs: f.departureTime, arrives: f.arrivalTime, stops: f.stops, cabin: f.cabinClass, brand: f.brandName,
        price: f.price, currency: f.currency, refundable: f.isRefundable === null ? 'unknown' : f.isRefundable, canHold: f.canHold,
      })),
    });
  } catch (e) { send(500, { error: e.message }); }
}).listen(PORT, () => console.log(`Travelport test server: http://localhost:${PORT}/search?from=JFK&to=LAX&date=2026-12-20`));
