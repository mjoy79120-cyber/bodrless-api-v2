/**
 * ADMIN SEED SCRIPT v2
 * ─────────────────────────────────────────────────────────────
 * Pre-populates the route graph with known East African routes.
 * Run once after migration 002 is applied:
 *
 *   node src/scripts/adminSeed.js
 *
 * Safe to re-run — uses upsert so nothing gets duplicated.
 *
 * BUS INVENTORY NOTE:
 * All bus routes are sourced from Travler (via TravelDuqa API).
 * We do not name specific bus operators here — Travler returns
 * live inventory including both day and night departures.
 * The seed just tells the engine this route exists and which
 * supplier to call. Travler handles operator, schedule, pricing.
 *
 * FLIGHT INVENTORY:
 * All flights sourced from Duffel + TravelDuqa in parallel.
 *
 * FERRY / STATIC ROUTES:
 * No live API — stored as static with booking_method: 'direct'.
 * Traveler books directly with the ferry operator.
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const routeLearning = require('../services/routeLearningService');

async function seed() {
  console.log('🌍 Bodrless Route Graph — Admin Seed v2\n');

  // ═══════════════════════════════════════════════════════════
  // DIRECT FLIGHT ROUTES
  // Supplier: duffel (primary) + travelduqa (parallel)
  // ═══════════════════════════════════════════════════════════

  const flightRoutes = [

    // ── Kenya Domestic ───────────────────────────────────────
    { origin: 'nairobi',   destination: 'mombasa',    confidence: 0.99, notes: 'High frequency, multiple airlines daily' },
    { origin: 'nairobi',   destination: 'zanzibar',   confidence: 0.95 },
    { origin: 'nairobi',   destination: 'kisumu',     confidence: 0.90 },
    { origin: 'nairobi',   destination: 'eldoret',    confidence: 0.88 },
    { origin: 'nairobi',   destination: 'malindi',    confidence: 0.85 },
    { origin: 'nairobi',   destination: 'lamu',       confidence: 0.85 },
    { origin: 'nairobi',   destination: 'nanyuki',    confidence: 0.70, notes: 'Limited schedule — charter mostly' },
    { origin: 'nairobi',   destination: 'masai mara', confidence: 0.92, notes: 'Wilson Airport departures' },
    { origin: 'nairobi',   destination: 'amboseli',   confidence: 0.88, notes: 'Wilson Airport departures' },
    { origin: 'nairobi',   destination: 'samburu',    confidence: 0.82, notes: 'Wilson Airport departures' },
    { origin: 'mombasa',   destination: 'nairobi',    confidence: 0.99 },
    { origin: 'mombasa',   destination: 'zanzibar',   confidence: 0.85 },
    { origin: 'zanzibar',  destination: 'nairobi',    confidence: 0.92 },
    { origin: 'zanzibar',  destination: 'mombasa',    confidence: 0.85 },

    // ── Tanzania Domestic ────────────────────────────────────
    { origin: 'dar es salaam', destination: 'zanzibar',   confidence: 0.92 },
    { origin: 'dar es salaam', destination: 'arusha',     confidence: 0.85 },
    { origin: 'dar es salaam', destination: 'kilimanjaro', confidence: 0.88 },
    { origin: 'dar es salaam', destination: 'serengeti',  confidence: 0.80 },
    { origin: 'arusha',        destination: 'zanzibar',   confidence: 0.82 },
    { origin: 'arusha',        destination: 'serengeti',  confidence: 0.85 },
    { origin: 'arusha',        destination: 'ngorongoro', confidence: 0.82 },
    { origin: 'zanzibar',      destination: 'dar es salaam', confidence: 0.92 },

    // ── East Africa Regional ─────────────────────────────────
    { origin: 'nairobi',       destination: 'dar es salaam', confidence: 0.95 },
    { origin: 'nairobi',       destination: 'kampala',       confidence: 0.95 },
    { origin: 'nairobi',       destination: 'kigali',        confidence: 0.95 },
    { origin: 'nairobi',       destination: 'addis ababa',   confidence: 0.95 },
    { origin: 'nairobi',       destination: 'entebbe',       confidence: 0.92 },
    { origin: 'nairobi',       destination: 'bujumbura',     confidence: 0.80 },
    { origin: 'nairobi',       destination: 'juba',          confidence: 0.78 },

    // ── Southern Africa ──────────────────────────────────────
    { origin: 'nairobi',       destination: 'johannesburg',  confidence: 0.95 },
    { origin: 'nairobi',       destination: 'cape town',     confidence: 0.92 },
    { origin: 'nairobi',       destination: 'lusaka',        confidence: 0.85 },
    { origin: 'nairobi',       destination: 'harare',        confidence: 0.82 },
    { origin: 'nairobi',       destination: 'maputo',        confidence: 0.78 },
    { origin: 'nairobi',       destination: 'victoria falls', confidence: 0.80 },
    { origin: 'nairobi',       destination: 'antananarivo',  confidence: 0.78 },

    // ── Indian Ocean Islands ─────────────────────────────────
    { origin: 'nairobi',       destination: 'mahe',          confidence: 0.88 },
    { origin: 'nairobi',       destination: 'port louis',    confidence: 0.85 },
    { origin: 'nairobi',       destination: 'male',          confidence: 0.80 },

    // ── Middle East & International ──────────────────────────
    { origin: 'nairobi',       destination: 'dubai',         confidence: 0.99 },
    { origin: 'nairobi',       destination: 'doha',          confidence: 0.95 },
    { origin: 'nairobi',       destination: 'abu dhabi',     confidence: 0.92 },
    { origin: 'nairobi',       destination: 'london',        confidence: 0.99 },
    { origin: 'nairobi',       destination: 'paris',         confidence: 0.95 },
    { origin: 'nairobi',       destination: 'amsterdam',     confidence: 0.95 },
    { origin: 'nairobi',       destination: 'bangkok',       confidence: 0.88 },
    { origin: 'nairobi',       destination: 'new york',      confidence: 0.85 },
    { origin: 'mombasa',       destination: 'dubai',         confidence: 0.88 },
  ];

  console.log(`Seeding ${flightRoutes.length} flight routes...`);
  let seeded = 0;
  for (const r of flightRoutes) {
    const result = await routeLearning.seedRoute({
      origin:        r.origin,
      destination:   r.destination,
      routeType:     'direct',
      transportMode: 'flight',
      budgetTier:    'all',
      supplier:      'duffel',
      bookingMethod: 'api',
      confidence:    r.confidence,
      notes:         r.notes || null,
    });
    if (result) seeded++;
  }
  console.log(`✓ ${seeded}/${flightRoutes.length} flight routes seeded\n`);

  // ═══════════════════════════════════════════════════════════
  // BUS ROUTES
  // Supplier: travelduqa (Travler inventory)
  // Travler provides live day + night departures, pricing,
  // seat availability. We just record that the route exists.
  // DO NOT hardcode operators or schedules — Travler owns that.
  // ═══════════════════════════════════════════════════════════

  const busRoutes = [

    // ── Kenya Intercity ──────────────────────────────────────
    { origin: 'nairobi',       destination: 'mombasa',       confidence: 0.99, notes: 'Day and night departures via Travler' },
    { origin: 'nairobi',       destination: 'kisumu',        confidence: 0.95, notes: 'Day and night departures via Travler' },
    { origin: 'nairobi',       destination: 'eldoret',       confidence: 0.95, notes: 'Day and night departures via Travler' },
    { origin: 'nairobi',       destination: 'nakuru',        confidence: 0.95 },
    { origin: 'nairobi',       destination: 'naivasha',      confidence: 0.92 },
    { origin: 'nairobi',       destination: 'nanyuki',       confidence: 0.90 },
    { origin: 'nairobi',       destination: 'malindi',       confidence: 0.85 },
    { origin: 'nairobi',       destination: 'thika',         confidence: 0.95 },
    { origin: 'mombasa',       destination: 'nairobi',       confidence: 0.99, notes: 'Day and night departures via Travler' },
    { origin: 'mombasa',       destination: 'malindi',       confidence: 0.90 },
    { origin: 'kisumu',        destination: 'nairobi',       confidence: 0.95 },
    { origin: 'eldoret',       destination: 'nairobi',       confidence: 0.95 },
    { origin: 'nakuru',        destination: 'nairobi',       confidence: 0.95 },

    // ── East Africa Cross-border ─────────────────────────────
    { origin: 'nairobi',       destination: 'kampala',       confidence: 0.90, notes: 'Day and night departures via Travler' },
    { origin: 'nairobi',       destination: 'arusha',        confidence: 0.90, notes: 'Shuttle services via Travler' },
    { origin: 'nairobi',       destination: 'dar es salaam', confidence: 0.85, notes: 'Night buses via Travler' },
    { origin: 'nairobi',       destination: 'kigali',        confidence: 0.82, notes: 'Via Kampala or direct via Travler' },
    { origin: 'mombasa',       destination: 'dar es salaam', confidence: 0.82 },
    { origin: 'kampala',       destination: 'nairobi',       confidence: 0.90 },
    { origin: 'arusha',        destination: 'nairobi',       confidence: 0.90 },
    { origin: 'dar es salaam', destination: 'nairobi',       confidence: 0.85 },
    { origin: 'dar es salaam', destination: 'mombasa',       confidence: 0.82 },
  ];

  console.log(`Seeding ${busRoutes.length} bus routes...`);
  seeded = 0;
  for (const r of busRoutes) {
    const result = await routeLearning.seedRoute({
      origin:        r.origin,
      destination:   r.destination,
      routeType:     'direct',
      transportMode: 'bus',
      budgetTier:    'all',
      supplier:      'travelduqa',
      bookingMethod: 'api',
      confidence:    r.confidence,
      notes:         r.notes || null,
    });
    if (result) seeded++;
  }
  console.log(`✓ ${seeded}/${busRoutes.length} bus routes seeded\n`);

  // ═══════════════════════════════════════════════════════════
  // SGR TRAIN
  // Static — not yet bookable through Bodrless
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding SGR train routes...');

  const trainRoutes = [
    { origin: 'nairobi', destination: 'mombasa', notes: '3 daily departures: 08:00, 15:00, 22:00. Economy KES 1,000. First class KES 3,000. Book at SGR portal.' },
    { origin: 'mombasa', destination: 'nairobi', notes: '3 daily departures. Book at SGR portal or station.' },
  ];

  seeded = 0;
  for (const r of trainRoutes) {
    const result = await routeLearning.seedRoute({
      origin:        r.origin,
      destination:   r.destination,
      routeType:     'direct',
      transportMode: 'train',
      budgetTier:    'all',
      priceKesMin:   1000,
      priceKesMax:   12000,
      frequency:     'daily',
      supplier:      'sgr_static',
      bookingMethod: 'direct',
      confidence:    0.99,
      notes:         r.notes,
    });
    if (result) seeded++;
  }
  console.log(`✓ ${seeded}/${trainRoutes.length} train routes seeded\n`);

  // ═══════════════════════════════════════════════════════════
  // FERRY ROUTES
  // Static — book directly with ferry operator
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding ferry routes...');

  const ferryRoutes = [
    { origin: 'dar es salaam', destination: 'zanzibar',      priceMin: 1500, priceMax: 4000, notes: 'Multiple daily departures. Azam Marine, SeaBus, Coastal Fast Ferries. Book ahead in peak season.' },
    { origin: 'zanzibar',      destination: 'dar es salaam', priceMin: 1500, priceMax: 4000, notes: 'Multiple daily departures.' },
    { origin: 'zanzibar',      destination: 'pemba',         priceMin: 2000, priceMax: 5000, notes: 'Limited schedule — check Azam Marine.' },
    { origin: 'pemba',         destination: 'zanzibar',      priceMin: 2000, priceMax: 5000, notes: 'Limited schedule.' },
    { origin: 'mombasa',       destination: 'zanzibar',      priceMin: 2500, priceMax: 6000, notes: 'Dhow or speedboat. Seasonal — confirm availability.' },
  ];

  seeded = 0;
  for (const r of ferryRoutes) {
    const result = await routeLearning.seedRoute({
      origin:        r.origin,
      destination:   r.destination,
      routeType:     'direct',
      transportMode: 'ferry',
      budgetTier:    'all',
      priceKesMin:   r.priceMin,
      priceKesMax:   r.priceMax,
      supplier:      'static',
      bookingMethod: 'direct',
      confidence:    0.90,
      notes:         r.notes,
    });
    if (result) seeded++;
  }
  console.log(`✓ ${seeded}/${ferryRoutes.length} ferry routes seeded\n`);

  // ═══════════════════════════════════════════════════════════
  // COMPOUND ROUTES
  // Multi-leg itineraries no single API returns
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding compound routes...');

  // Nairobi → Zanzibar via bus + ferry (budget)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'zanzibar',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'budget',
    priceKesMin: 4000, priceKesMax: 8000,
    confidence: 0.90,
    notes: 'Night bus Nairobi → Dar es Salaam, transfer to port, ferry to Zanzibar. ~18 hours total.',
    legs: [
      { from: 'Nairobi', to: 'Dar es Salaam', mode: 'bus', priceMin: 2000, priceMax: 4500, durationMins: 840, departs: '19:00', arrives: '07:00', bookingMethod: 'api', supplier: 'travelduqa', notes: 'Night bus via Travler. Book 2 days ahead.' },
      { from: 'Dar es Salaam', to: 'Dar port', mode: 'transfer', priceMin: 400, priceMax: 700, durationMins: 30, bookingMethod: 'on_arrival', notes: 'Taxi to ferry terminal.' },
      { from: 'Dar port', to: 'Zanzibar port', mode: 'ferry', priceMin: 1500, priceMax: 3500, durationMins: 120, departs: '07:30', bookingMethod: 'direct', notes: 'Book Azam Marine or SeaBus in advance during Jul-Aug, Dec-Jan.' },
      { from: 'Zanzibar port', to: 'Hotel', mode: 'transfer', priceMin: 400, priceMax: 800, durationMins: 20, bookingMethod: 'on_arrival' },
    ],
  });

  // Nairobi → Zanzibar via flight to Dar + ferry (mid)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'zanzibar',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'mid',
    priceKesMin: 18000, priceKesMax: 40000,
    confidence: 0.85,
    notes: 'Fly Nairobi → Dar es Salaam, then ferry to Zanzibar. ~4 hours total.',
    legs: [
      { from: 'Nairobi', to: 'Dar es Salaam', mode: 'flight', priceMin: 15000, priceMax: 35000, durationMins: 90, bookingMethod: 'api', supplier: 'duffel' },
      { from: 'Dar es Salaam airport', to: 'Dar port', mode: 'transfer', priceMin: 500, priceMax: 1000, durationMins: 45, bookingMethod: 'on_arrival' },
      { from: 'Dar port', to: 'Zanzibar port', mode: 'ferry', priceMin: 1500, priceMax: 3500, durationMins: 120, bookingMethod: 'direct' },
      { from: 'Zanzibar port', to: 'Hotel', mode: 'transfer', priceMin: 400, priceMax: 800, durationMins: 20, bookingMethod: 'on_arrival' },
    ],
  });

  // Mombasa → Zanzibar via Dar bus + ferry (budget)
  await routeLearning.seedRoute({
    origin: 'mombasa', destination: 'zanzibar',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'budget',
    priceKesMin: 3500, priceKesMax: 7000,
    confidence: 0.80,
    notes: 'Bus Mombasa → Dar es Salaam, then ferry to Zanzibar.',
    legs: [
      { from: 'Mombasa', to: 'Dar es Salaam', mode: 'bus', priceMin: 1500, priceMax: 3500, durationMins: 480, departs: '07:00', bookingMethod: 'api', supplier: 'travelduqa' },
      { from: 'Dar es Salaam', to: 'Dar port', mode: 'transfer', priceMin: 400, priceMax: 700, durationMins: 30, bookingMethod: 'on_arrival' },
      { from: 'Dar port', to: 'Zanzibar port', mode: 'ferry', priceMin: 1500, priceMax: 3500, durationMins: 120, bookingMethod: 'direct' },
    ],
  });

  // Nairobi → Masai Mara via Wilson flight (mid)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'masai mara',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'mid',
    priceKesMin: 14000, priceKesMax: 35000,
    confidence: 0.92,
    notes: 'Transfer to Wilson Airport, fly to Mara airstrip, transfer to lodge.',
    legs: [
      { from: 'Nairobi CBD', to: 'Wilson Airport', mode: 'transfer', priceMin: 800, priceMax: 1500, durationMins: 30, bookingMethod: 'on_arrival' },
      { from: 'Wilson Airport', to: 'Mara airstrip', mode: 'flight', priceMin: 12000, priceMax: 30000, durationMins: 45, bookingMethod: 'api', supplier: 'duffel', notes: 'Multiple departures daily. Book ahead Jul-Oct migration season.' },
      { from: 'Mara airstrip', to: 'Lodge/Camp', mode: 'transfer', priceMin: 0, priceMax: 0, durationMins: 30, bookingMethod: 'on_arrival', notes: 'Usually included in lodge package.' },
    ],
  });

  // Nairobi → Masai Mara via road (budget)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'masai mara',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'budget',
    priceKesMin: 2000, priceKesMax: 6000,
    confidence: 0.85,
    notes: 'Shuttle or shared 4WD via Narok. ~5-6 hours.',
    legs: [
      { from: 'Nairobi', to: 'Narok', mode: 'bus', priceMin: 300, priceMax: 600, durationMins: 90, bookingMethod: 'api', supplier: 'travelduqa' },
      { from: 'Narok', to: 'Masai Mara gate', mode: 'transfer', priceMin: 1500, priceMax: 5000, durationMins: 120, bookingMethod: 'direct', notes: '4WD required. Arrange through lodge or local operator in Narok.' },
    ],
  });

  // Nairobi → Nanyuki road (no commercial flight)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'nanyuki',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'all',
    priceKesMin: 300, priceKesMax: 800,
    confidence: 0.95,
    notes: 'Road only — ~3 hours. Bus via Travler.',
    legs: [
      { from: 'Nairobi', to: 'Nanyuki', mode: 'bus', priceMin: 300, priceMax: 800, durationMins: 180, bookingMethod: 'api', supplier: 'travelduqa', notes: 'Day departures via Travler.' },
    ],
  });

  console.log('✓ Compound routes seeded\n');

  // ═══════════════════════════════════════════════════════════
  // KNOWN ZERO-FLIGHT ROUTES
  // Pre-seed confidence = 0.05 so engine skips flight search
  // and goes straight to road/compound options immediately.
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding known zero-flight routes...');

  const noFlightRoutes = [
    { origin: 'nairobi', destination: 'naivasha',  note: 'No scheduled commercial flights — road only' },
    { origin: 'nairobi', destination: 'nakuru',    note: 'No scheduled commercial flights — road only' },
    { origin: 'nairobi', destination: 'thika',     note: 'No scheduled commercial flights — road only' },
    { origin: 'nairobi', destination: 'nanyuki',   note: 'No scheduled commercial flights — road only (charter available)' },
    { origin: 'nairobi', destination: 'narok',     note: 'No scheduled commercial flights — road only' },
  ];

  seeded = 0;
  for (const r of noFlightRoutes) {
    const result = await routeLearning.seedRoute({
      origin:        r.origin,
      destination:   r.destination,
      routeType:     'direct',
      transportMode: 'flight',
      confidence:    0.05,
      notes:         r.note,
      supplier:      'duffel',
      bookingMethod: 'api',
    });
    if (result) seeded++;
  }
  console.log(`✓ ${seeded}/${noFlightRoutes.length} zero-flight routes seeded\n`);
  console.log('🎉 Seed complete. Route graph is ready.');
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});