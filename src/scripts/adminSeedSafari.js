/**
 * SAFARI SEED SCRIPT
 * ─────────────────────────────────────────────────────────────
 * Seeds:
 *   1. Safari compound routes (Kenya + Tanzania)
 *      - Vehicle legs: land cruiser or tour van (capacity 8)
 *      - NOT from Travler — static, lodge/operator arranged
 *   2. International gateway routes with clearance buffers
 *   3. Vehicle transfer catalog
 *   4. Starter lodge catalog (agency partners add more)
 *
 * Run after 002_route_graph.sql and 004_lodge_catalog.sql:
 *   node src/scripts/adminSeedSafari.js
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const supabase      = require('../utils/supabase');
const routeLearning = require('../services/routeLearningService');

async function seedSafari() {
  console.log('🦁 Bodrless Safari Circuit Seed\n');

  // ═══════════════════════════════════════════════════════════
  // VEHICLE TRANSFERS
  // Land cruiser + tour van — capacity 8, static pricing
  // NOT from Travler — arranged by lodge or local operator
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding vehicle transfers...');

  const vehicleTransfers = [
    // ── Masai Mara ───────────────────────────────────────────
    { from: 'Mara airstrip',    to: 'Masai Mara lodge',  destination: 'masai mara', vehicle: 'landcruiser', capacity: 8, priceMin: 0,    priceMax: 0,    mins: 30,  method: 'lodge_arranged', notes: 'Included in most lodge packages. Confirm when booking lodge.' },
    { from: 'Narok gate',       to: 'Masai Mara lodge',  destination: 'masai mara', vehicle: 'landcruiser', capacity: 8, priceMin: 3000, priceMax: 8000, mins: 90,  method: 'operator',       notes: 'Arrange with local operator in Narok or through lodge.' },
    { from: 'Masai Mara lodge', to: 'Mara airstrip',     destination: 'masai mara', vehicle: 'landcruiser', capacity: 8, priceMin: 0,    priceMax: 0,    mins: 30,  method: 'lodge_arranged', notes: 'Included in most lodge packages.' },
    { from: 'Masai Mara lodge', to: 'Narok gate',        destination: 'masai mara', vehicle: 'landcruiser', capacity: 8, priceMin: 3000, priceMax: 8000, mins: 90,  method: 'operator' },

    // ── Amboseli ─────────────────────────────────────────────
    { from: 'Amboseli airstrip', to: 'Amboseli lodge',   destination: 'amboseli',   vehicle: 'landcruiser', capacity: 8, priceMin: 0,    priceMax: 0,    mins: 20,  method: 'lodge_arranged', notes: 'Included in lodge package.' },
    { from: 'Namanga road',      to: 'Amboseli lodge',   destination: 'amboseli',   vehicle: 'landcruiser', capacity: 8, priceMin: 3000, priceMax: 7000, mins: 60,  method: 'operator',       notes: 'Road transfer from Namanga junction. 4WD required.' },
    { from: 'Nairobi',           to: 'Amboseli lodge',   destination: 'amboseli',   vehicle: 'tourvan',     capacity: 8, priceMin: 8000, priceMax: 15000, mins: 240, method: 'operator',      notes: 'Full day road transfer ~4 hours. Tour van or land cruiser.' },
    { from: 'Amboseli lodge',    to: 'Nairobi',          destination: 'amboseli',   vehicle: 'tourvan',     capacity: 8, priceMin: 8000, priceMax: 15000, mins: 240, method: 'operator' },

    // ── Tsavo ────────────────────────────────────────────────
    { from: 'Voi gate',          to: 'Tsavo lodge',      destination: 'tsavo',      vehicle: 'landcruiser', capacity: 8, priceMin: 2000, priceMax: 6000, mins: 60,  method: 'operator',       notes: 'Arrange through lodge or local operator at Voi.' },
    { from: 'Mtito Andei gate',  to: 'Tsavo West lodge', destination: 'tsavo',      vehicle: 'landcruiser', capacity: 8, priceMin: 2000, priceMax: 5000, mins: 45,  method: 'operator',       notes: 'Tsavo West entrance.' },
    { from: 'Nairobi',           to: 'Tsavo lodge',      destination: 'tsavo',      vehicle: 'tourvan',     capacity: 8, priceMin: 10000, priceMax: 18000, mins: 300, method: 'operator',     notes: '~5 hours road transfer. Can combine with Mombasa itinerary.' },
    { from: 'Mombasa',           to: 'Tsavo lodge',      destination: 'tsavo',      vehicle: 'tourvan',     capacity: 8, priceMin: 6000, priceMax: 12000, mins: 180, method: 'operator',      notes: '~3 hours from Mombasa.' },

    // ── Samburu ──────────────────────────────────────────────
    { from: 'Samburu airstrip',  to: 'Samburu lodge',    destination: 'samburu',    vehicle: 'landcruiser', capacity: 8, priceMin: 0,    priceMax: 0,    mins: 20,  method: 'lodge_arranged', notes: 'Included in lodge package.' },
    { from: 'Nanyuki',           to: 'Samburu lodge',    destination: 'samburu',    vehicle: 'landcruiser', capacity: 8, priceMin: 4000, priceMax: 8000, mins: 90,  method: 'operator' },

    // ── Lake Nakuru ──────────────────────────────────────────
    { from: 'Nakuru town',       to: 'Nakuru lodge',     destination: 'lake nakuru', vehicle: 'tourvan',    capacity: 8, priceMin: 1500, priceMax: 4000, mins: 30,  method: 'operator',       notes: '~30 mins from Nakuru town to park gate.' },
    { from: 'Nairobi',           to: 'Nakuru lodge',     destination: 'lake nakuru', vehicle: 'tourvan',    capacity: 8, priceMin: 5000, priceMax: 10000, mins: 150, method: 'operator',      notes: '~2.5 hours road transfer.' },

    // ── Ol Pejeta ────────────────────────────────────────────
    { from: 'Nanyuki',           to: 'Ol Pejeta lodge',  destination: 'ol pejeta',  vehicle: 'landcruiser', capacity: 8, priceMin: 2000, priceMax: 5000, mins: 30,  method: 'operator' },
    { from: 'Nanyuki airstrip',  to: 'Ol Pejeta lodge',  destination: 'ol pejeta',  vehicle: 'landcruiser', capacity: 8, priceMin: 0,    priceMax: 0,    mins: 30,  method: 'lodge_arranged', notes: 'Confirm with lodge.' },

    // ── Tanzania Safari ──────────────────────────────────────
    { from: 'Seronera airstrip', to: 'Serengeti camp',   destination: 'serengeti',  vehicle: 'landcruiser', capacity: 8, priceMin: 0,    priceMax: 0,    mins: 30,  method: 'lodge_arranged', notes: 'Included in camp package.' },
    { from: 'Arusha',            to: 'Serengeti camp',   destination: 'serengeti',  vehicle: 'landcruiser', capacity: 8, priceMin: 15000, priceMax: 30000, mins: 480, method: 'operator',     notes: 'Full day road via Ngorongoro. 4WD essential.' },
    { from: 'Ngorongoro rim',    to: 'Ngorongoro lodge', destination: 'ngorongoro', vehicle: 'landcruiser', capacity: 8, priceMin: 0,    priceMax: 0,    mins: 15,  method: 'lodge_arranged' },
    { from: 'Arusha',            to: 'Ngorongoro lodge', destination: 'ngorongoro', vehicle: 'landcruiser', capacity: 8, priceMin: 8000, priceMax: 18000, mins: 180, method: 'operator',      notes: '~3 hours road transfer.' },
    { from: 'JRO airstrip',      to: 'Arusha',           destination: 'arusha',     vehicle: 'tourvan',     capacity: 8, priceMin: 2000, priceMax: 5000, mins: 60,  method: 'operator',       notes: '~1 hour from Kilimanjaro Airport to Arusha.' },

    // ── Victoria Falls ───────────────────────────────────────
    { from: 'VFA airport',       to: 'Victoria Falls hotel', destination: 'victoria falls', vehicle: 'tourvan', capacity: 8, priceMin: 2000, priceMax: 5000, mins: 20, method: 'operator' },
  ];

  const { error: vErr } = await supabase.from('vehicle_transfers').upsert(
    vehicleTransfers.map(v => ({
      from_place:     v.from,
      to_place:       v.to,
      destination:    v.destination,
      vehicle_type:   v.vehicle,
      capacity:       v.capacity || 8,
      price_kes_min:  v.priceMin,
      price_kes_max:  v.priceMax,
      duration_mins:  v.mins,
      booking_method: v.method,
      notes:          v.notes || null,
      confidence:     0.90,
    })),
    { onConflict: 'from_place,to_place,vehicle_type' }
  );

  if (vErr) console.error('Vehicle transfer seed error:', vErr.message);
  else console.log(`✓ ${vehicleTransfers.length} vehicle transfers seeded\n`);

  // ═══════════════════════════════════════════════════════════
  // SAFARI COMPOUND ROUTES
  // Full itinerary legs including vehicle transfers
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding Kenya safari compound routes...');

  // ── MASAI MARA ───────────────────────────────────────────────

  // Nairobi → Masai Mara (fly Wilson, mid/luxury)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'masai mara',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'mid',
    priceKesMin: 14000, priceKesMax: 40000,
    confidence: 0.95,
    notes: 'Wilson Airport → Mara airstrip (45 min flight) → land cruiser to lodge.',
    legs: [
      { from: 'Nairobi CBD',     to: 'Wilson Airport',   mode: 'transfer',    priceMin: 800,  priceMax: 1500,  durationMins: 30,  bookingMethod: 'on_arrival', notes: 'Allow 30 mins from CBD to Wilson. Taxi or Uber.' },
      { from: 'Wilson Airport',  to: 'Mara airstrip',    mode: 'flight',      priceMin: 12000, priceMax: 32000, durationMins: 45, bookingMethod: 'api', supplier: 'duffel', notes: 'Safarilink, Airkenya, Fly540. Multiple daily departures. Book ahead Jul-Oct.' },
      { from: 'Mara airstrip',   to: 'Masai Mara lodge', mode: 'landcruiser', priceMin: 0,    priceMax: 0,     durationMins: 30,  bookingMethod: 'lodge_arranged', notes: 'Land cruiser (capacity 8). Included in most lodge packages.' },
    ],
  });

  // Nairobi → Masai Mara (road via Narok, budget)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'masai mara',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'budget',
    priceKesMin: 3000, priceKesMax: 8000,
    confidence: 0.90,
    notes: 'Road via Narok ~4-5 hours. Tour van or land cruiser to lodge.',
    legs: [
      { from: 'Nairobi',       to: 'Narok',           mode: 'bus',         priceMin: 300,  priceMax: 600,   durationMins: 90,  bookingMethod: 'api', supplier: 'travelduqa' },
      { from: 'Narok',         to: 'Masai Mara gate', mode: 'landcruiser', priceMin: 2500, priceMax: 7000,  durationMins: 120, bookingMethod: 'operator', notes: 'Land cruiser or tour van (capacity 8). 4WD required. Arrange in Narok or through lodge.' },
      { from: 'Masai Mara gate', to: 'Lodge',         mode: 'landcruiser', priceMin: 0,    priceMax: 0,     durationMins: 30,  bookingMethod: 'lodge_arranged', notes: 'Lodge vehicle picks up at gate.' },
    ],
  });

  // Full day road transfer Nairobi → Masai Mara (tour van, groups)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'masai mara',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'mid',
    priceKesMin: 8000, priceKesMax: 18000,
    confidence: 0.88,
    notes: 'Direct tour van Nairobi → Masai Mara. Best for groups. Capacity 8.',
    legs: [
      { from: 'Nairobi hotel',  to: 'Masai Mara lodge', mode: 'tourvan', priceMin: 8000, priceMax: 18000, durationMins: 300, bookingMethod: 'operator', notes: 'Tour van capacity 8. Hotel pickup. ~5 hours via Narok.' },
    ],
  });

  // ── AMBOSELI ─────────────────────────────────────────────────

  // Nairobi → Amboseli (fly, mid)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'amboseli',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'mid',
    priceKesMin: 12000, priceKesMax: 30000,
    confidence: 0.88,
    notes: 'Wilson Airport → Amboseli airstrip (45 min) → land cruiser to lodge.',
    legs: [
      { from: 'Nairobi CBD',      to: 'Wilson Airport',    mode: 'transfer',    priceMin: 800,  priceMax: 1500,  durationMins: 30,  bookingMethod: 'on_arrival' },
      { from: 'Wilson Airport',   to: 'Amboseli airstrip', mode: 'flight',      priceMin: 10000, priceMax: 25000, durationMins: 45, bookingMethod: 'api', supplier: 'duffel' },
      { from: 'Amboseli airstrip', to: 'Amboseli lodge',   mode: 'landcruiser', priceMin: 0,    priceMax: 0,     durationMins: 20,  bookingMethod: 'lodge_arranged', notes: 'Land cruiser capacity 8. Included in lodge package.' },
    ],
  });

  // Nairobi → Amboseli (road, budget)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'amboseli',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'budget',
    priceKesMin: 8000, priceKesMax: 16000,
    confidence: 0.85,
    notes: 'Direct road transfer ~4 hours via Namanga. Tour van or land cruiser.',
    legs: [
      { from: 'Nairobi',      to: 'Amboseli lodge', mode: 'tourvan', priceMin: 8000, priceMax: 16000, durationMins: 240, bookingMethod: 'operator', notes: 'Tour van or land cruiser capacity 8. Hotel pickup in Nairobi.' },
    ],
  });

  // ── TSAVO ─────────────────────────────────────────────────────

  // Nairobi → Tsavo (road)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'tsavo',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'all',
    priceKesMin: 10000, priceKesMax: 20000,
    confidence: 0.85,
    notes: 'Road transfer ~5 hours via Mtito Andei. Land cruiser or tour van.',
    legs: [
      { from: 'Nairobi',         to: 'Mtito Andei gate', mode: 'tourvan',     priceMin: 7000, priceMax: 14000, durationMins: 270, bookingMethod: 'operator', notes: 'Tour van capacity 8. Can also take Mombasa bus and alight at Mtito Andei.' },
      { from: 'Mtito Andei gate', to: 'Tsavo lodge',     mode: 'landcruiser', priceMin: 2000, priceMax: 5000,  durationMins: 60,  bookingMethod: 'operator', notes: 'Land cruiser capacity 8. Arrange through lodge.' },
    ],
  });

  // Mombasa → Tsavo (road, closer from coast)
  await routeLearning.seedRoute({
    origin: 'mombasa', destination: 'tsavo',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'all',
    priceKesMin: 6000, priceKesMax: 14000,
    confidence: 0.88,
    notes: 'Road transfer ~3 hours from Mombasa. Great Mombasa + Tsavo combo.',
    legs: [
      { from: 'Mombasa',       to: 'Voi gate',    mode: 'tourvan',     priceMin: 5000, priceMax: 10000, durationMins: 150, bookingMethod: 'operator', notes: 'Tour van capacity 8. Hotel pickup in Mombasa.' },
      { from: 'Voi gate',      to: 'Tsavo lodge', mode: 'landcruiser', priceMin: 1500, priceMax: 4000,  durationMins: 45,  bookingMethod: 'operator', notes: 'Land cruiser capacity 8.' },
    ],
  });

  // ── SAMBURU ───────────────────────────────────────────────────

  // Nairobi → Samburu (fly)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'samburu',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'mid',
    priceKesMin: 12000, priceKesMax: 30000,
    confidence: 0.85,
    notes: 'Wilson Airport → Samburu airstrip → land cruiser to lodge.',
    legs: [
      { from: 'Nairobi CBD',      to: 'Wilson Airport',    mode: 'transfer',    priceMin: 800,  priceMax: 1500, durationMins: 30,  bookingMethod: 'on_arrival' },
      { from: 'Wilson Airport',   to: 'Samburu airstrip',  mode: 'flight',      priceMin: 10000, priceMax: 25000, durationMins: 60, bookingMethod: 'api', supplier: 'duffel' },
      { from: 'Samburu airstrip', to: 'Samburu lodge',     mode: 'landcruiser', priceMin: 0,    priceMax: 0,    durationMins: 20,  bookingMethod: 'lodge_arranged', notes: 'Land cruiser capacity 8. Included in lodge package.' },
    ],
  });

  // Nairobi → Samburu (road via Nanyuki)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'samburu',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'budget',
    priceKesMin: 4000, priceKesMax: 10000,
    confidence: 0.82,
    notes: 'Bus to Nanyuki then land cruiser to Samburu. ~5 hours total.',
    legs: [
      { from: 'Nairobi',  to: 'Nanyuki',       mode: 'bus',         priceMin: 300,  priceMax: 700,  durationMins: 180, bookingMethod: 'api', supplier: 'travelduqa' },
      { from: 'Nanyuki',  to: 'Samburu lodge', mode: 'landcruiser', priceMin: 4000, priceMax: 8000, durationMins: 90,  bookingMethod: 'operator', notes: 'Land cruiser capacity 8. Arrange in Nanyuki or through lodge.' },
    ],
  });

  // ── LAKE NAKURU ───────────────────────────────────────────────

  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'lake nakuru',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'all',
    priceKesMin: 5000, priceKesMax: 12000,
    confidence: 0.90,
    notes: 'SGR or bus to Nakuru then tour van to park. ~3 hours total.',
    legs: [
      { from: 'Nairobi', to: 'Nakuru',        mode: 'bus',     priceMin: 300,  priceMax: 700,  durationMins: 120, bookingMethod: 'api', supplier: 'travelduqa', notes: 'Bus via Travler or SGR train.' },
      { from: 'Nakuru',  to: 'Nakuru lodge',  mode: 'tourvan', priceMin: 1500, priceMax: 4000, durationMins: 30,  bookingMethod: 'operator', notes: 'Tour van capacity 8. ~30 mins to park gate.' },
    ],
  });

  console.log('✓ Kenya safari routes seeded\n');

  // ── TANZANIA SAFARI ───────────────────────────────────────────

  console.log('Seeding Tanzania safari compound routes...');

  // Nairobi → Serengeti (fly via Arusha or direct)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'serengeti',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'mid',
    priceKesMin: 25000, priceKesMax: 60000,
    confidence: 0.88,
    notes: 'Fly Nairobi → Kilimanjaro/Arusha → Seronera airstrip → land cruiser to camp.',
    legs: [
      { from: 'Nairobi',           to: 'Kilimanjaro',       mode: 'flight',      priceMin: 12000, priceMax: 30000, durationMins: 60,  bookingMethod: 'api', supplier: 'duffel' },
      { from: 'Kilimanjaro',       to: 'Arusha',            mode: 'tourvan',     priceMin: 2000,  priceMax: 5000,  durationMins: 60,  bookingMethod: 'operator', notes: 'Tour van capacity 8. ~1hr to Arusha.' },
      { from: 'Arusha',            to: 'Seronera airstrip', mode: 'flight',      priceMin: 8000,  priceMax: 20000, durationMins: 60,  bookingMethod: 'api', supplier: 'duffel', notes: 'Coastal Aviation, Auric Air — multiple daily departures.' },
      { from: 'Seronera airstrip', to: 'Serengeti camp',    mode: 'landcruiser', priceMin: 0,     priceMax: 0,     durationMins: 30,  bookingMethod: 'lodge_arranged', notes: 'Land cruiser capacity 8. Included in camp package.' },
    ],
  });

  // Arusha → Ngorongoro (road)
  await routeLearning.seedRoute({
    origin: 'arusha', destination: 'ngorongoro',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'all',
    priceKesMin: 8000, priceKesMax: 20000,
    confidence: 0.90,
    notes: 'Road ~3 hours Arusha → Ngorongoro rim. Land cruiser into crater.',
    legs: [
      { from: 'Arusha',        to: 'Ngorongoro rim',   mode: 'tourvan',     priceMin: 6000, priceMax: 15000, durationMins: 180, bookingMethod: 'operator', notes: 'Tour van capacity 8. Via Karatu.' },
      { from: 'Ngorongoro rim', to: 'Crater floor',    mode: 'landcruiser', priceMin: 2000, priceMax: 5000,  durationMins: 30,  bookingMethod: 'operator', notes: 'Land cruiser capacity 8. 4WD required for crater descent.' },
    ],
  });

  // Arusha → Serengeti (road, budget)
  await routeLearning.seedRoute({
    origin: 'arusha', destination: 'serengeti',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'budget',
    priceKesMin: 12000, priceKesMax: 25000,
    confidence: 0.82,
    notes: 'Full day road via Ngorongoro ~8 hours. Land cruiser essential.',
    legs: [
      { from: 'Arusha', to: 'Serengeti camp', mode: 'landcruiser', priceMin: 12000, priceMax: 25000, durationMins: 480, bookingMethod: 'operator', notes: 'Land cruiser capacity 8. Full day drive via Ngorongoro crater rim.' },
    ],
  });

  console.log('✓ Tanzania safari routes seeded\n');

  // ═══════════════════════════════════════════════════════════
  // INTERNATIONAL GATEWAY COMPOUND ROUTES
  // Washington DC, Beijing, London etc → Masai Mara
  // The engine handles the international flight via Duffel.
  // These compound routes add the Nairobi → Mara legs
  // and the clearance buffer automatically.
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding international gateway routes...');

  // Generic international → Masai Mara via Nairobi
  // (covers Washington, Beijing, London, Dubai etc)
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'masai mara',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'luxury',
    priceKesMin: 15000, priceKesMax: 45000,
    confidence: 0.92,
    notes: 'International arrival JKIA → clearance buffer → Wilson Airport → Mara airstrip → land cruiser. Allow 4 hours at JKIA before Wilson departure.',
    legs: [
      { from: 'JKIA (international arrival)', to: 'Wilson Airport', mode: 'transfer',    priceMin: 1500, priceMax: 3000,  durationMins: 240, bookingMethod: 'on_arrival', notes: '⚠️ Allow 4 hours: immigration + customs + road to Wilson (45 mins). Do NOT book Wilson flight < 4hrs after international arrival.' },
      { from: 'Wilson Airport',               to: 'Mara airstrip',  mode: 'flight',      priceMin: 12000, priceMax: 32000, durationMins: 45, bookingMethod: 'api', supplier: 'duffel', notes: 'Safarilink, Airkenya. Book ahead during Jul-Oct migration.' },
      { from: 'Mara airstrip',               to: 'Masai Mara lodge', mode: 'landcruiser', priceMin: 0,   priceMax: 0,     durationMins: 30,  bookingMethod: 'lodge_arranged', notes: 'Land cruiser capacity 8. Included in lodge package.' },
    ],
  });

  // International → Amboseli via Nairobi
  await routeLearning.seedRoute({
    origin: 'nairobi', destination: 'amboseli',
    routeType: 'compound', transportMode: 'compound',
    budgetTier: 'luxury',
    priceKesMin: 12000, priceKesMax: 30000,
    confidence: 0.88,
    notes: 'International arrival JKIA → clearance → Wilson Airport → Amboseli airstrip → land cruiser.',
    legs: [
      { from: 'JKIA (international arrival)', to: 'Wilson Airport',      mode: 'transfer',    priceMin: 1500, priceMax: 3000,  durationMins: 240, bookingMethod: 'on_arrival', notes: '⚠️ Allow 4 hours at JKIA before Wilson departure.' },
      { from: 'Wilson Airport',               to: 'Amboseli airstrip',   mode: 'flight',      priceMin: 10000, priceMax: 25000, durationMins: 45, bookingMethod: 'api', supplier: 'duffel' },
      { from: 'Amboseli airstrip',            to: 'Amboseli lodge',      mode: 'landcruiser', priceMin: 0,    priceMax: 0,     durationMins: 20,  bookingMethod: 'lodge_arranged', notes: 'Land cruiser capacity 8.' },
    ],
  });

  console.log('✓ International gateway routes seeded\n');

  // ═══════════════════════════════════════════════════════════
  // STARTER LODGE CATALOG
  // Agency partners add more via the dashboard.
  // These are well-known properties to start with.
  // ═══════════════════════════════════════════════════════════

  console.log('Seeding starter lodge catalog...');

  const lodges = [
    // ── Masai Mara ───────────────────────────────────────────
    { name: 'Governors Camp',        destination: 'masai mara', type: 'tented_camp',  stars: 5, priceUsdMin: 400,  priceUsdMax: 800,  includes: ['meals', 'game_drives', 'airstrip_transfer'], conservancy: 'Masai Mara National Reserve' },
    { name: 'Mahali Mzuri',          destination: 'masai mara', type: 'tented_camp',  stars: 5, priceUsdMin: 700,  priceUsdMax: 1200, includes: ['meals', 'game_drives', 'airstrip_transfer', 'all_inclusive'], conservancy: 'Olare Motorogi Conservancy' },
    { name: 'Angama Mara',           destination: 'masai mara', type: 'lodge',        stars: 5, priceUsdMin: 800,  priceUsdMax: 1500, includes: ['meals', 'game_drives', 'airstrip_transfer'], conservancy: 'Masai Mara National Reserve' },
    { name: 'Mara Serena Safari Lodge', destination: 'masai mara', type: 'lodge',     stars: 4, priceUsdMin: 200,  priceUsdMax: 450,  includes: ['meals', 'game_drives'], conservancy: 'Masai Mara National Reserve' },
    { name: 'Mara Intrepids Camp',   destination: 'masai mara', type: 'tented_camp',  stars: 4, priceUsdMin: 250,  priceUsdMax: 500,  includes: ['meals', 'game_drives', 'airstrip_transfer'] },
    { name: 'Basecamp Masai Mara',   destination: 'masai mara', type: 'tented_camp',  stars: 4, priceUsdMin: 180,  priceUsdMax: 380,  includes: ['meals', 'game_drives'] },

    // ── Amboseli ─────────────────────────────────────────────
    { name: 'Amboseli Serena Safari Lodge', destination: 'amboseli', type: 'lodge',   stars: 4, priceUsdMin: 180,  priceUsdMax: 380,  includes: ['meals'] },
    { name: 'Ol Tukai Lodge',        destination: 'amboseli',   type: 'lodge',        stars: 4, priceUsdMin: 150,  priceUsdMax: 350,  includes: ['meals', 'airstrip_transfer'] },
    { name: 'Tortilis Camp',         destination: 'amboseli',   type: 'tented_camp',  stars: 5, priceUsdMin: 400,  priceUsdMax: 800,  includes: ['meals', 'game_drives', 'airstrip_transfer'] },

    // ── Samburu ──────────────────────────────────────────────
    { name: 'Samburu Serena Safari Lodge', destination: 'samburu', type: 'lodge',     stars: 4, priceUsdMin: 180,  priceUsdMax: 380,  includes: ['meals', 'airstrip_transfer'] },
    { name: 'Elephant Bedroom Camp', destination: 'samburu',    type: 'tented_camp',  stars: 5, priceUsdMin: 500,  priceUsdMax: 900,  includes: ['meals', 'game_drives', 'airstrip_transfer'] },
    { name: 'Sasaab Lodge',          destination: 'samburu',    type: 'boutique',     stars: 5, priceUsdMin: 600,  priceUsdMax: 1100, includes: ['meals', 'game_drives', 'airstrip_transfer', 'all_inclusive'] },

    // ── Tsavo ────────────────────────────────────────────────
    { name: 'Voi Safari Lodge',      destination: 'tsavo',      type: 'lodge',        stars: 3, priceUsdMin: 80,   priceUsdMax: 180,  includes: ['meals'] },
    { name: 'Kilaguni Serena Safari Lodge', destination: 'tsavo', type: 'lodge',      stars: 4, priceUsdMin: 150,  priceUsdMax: 320,  includes: ['meals'] },
    { name: 'Finch Hattons',         destination: 'tsavo',      type: 'tented_camp',  stars: 5, priceUsdMin: 500,  priceUsdMax: 900,  includes: ['meals', 'game_drives', 'all_inclusive'] },

    // ── Tanzania ─────────────────────────────────────────────
    { name: 'Serengeti Serena Safari Lodge', destination: 'serengeti', type: 'lodge', stars: 4, priceUsdMin: 250,  priceUsdMax: 500,  includes: ['meals', 'airstrip_transfer'], country: 'Tanzania' },
    { name: 'Four Seasons Serengeti', destination: 'serengeti', type: 'lodge',        stars: 5, priceUsdMin: 700,  priceUsdMax: 1400, includes: ['meals', 'game_drives', 'airstrip_transfer'], country: 'Tanzania' },
    { name: 'andBeyond Ngorongoro Crater Lodge', destination: 'ngorongoro', type: 'lodge', stars: 5, priceUsdMin: 800, priceUsdMax: 1500, includes: ['meals', 'game_drives', 'airstrip_transfer'], country: 'Tanzania' },
    { name: 'Ngorongoro Serena Safari Lodge', destination: 'ngorongoro', type: 'lodge', stars: 4, priceUsdMin: 200, priceUsdMax: 450,  includes: ['meals'], country: 'Tanzania' },
  ];

  const { error: lErr } = await supabase.from('lodge_catalog').upsert(
    lodges.map(l => ({
      name:             l.name,
      destination:      l.destination,
      country:          l.country || 'Kenya',
      lodge_type:       l.type,
      stars:            l.stars,
      price_usd_min:    l.priceUsdMin,
      price_usd_max:    l.priceUsdMax,
      price_includes:   l.includes || [],
      conservancy:      l.conservancy || null,
      booking_method:   'request',
      airstrip_transfer: (l.includes || []).includes('airstrip_transfer'),
      gate_transfer:    true,
      source:           'admin_seed',
      verified:         true,
    })),
    { onConflict: 'name,destination' }
  );

  if (lErr) console.error('Lodge seed error:', lErr.message);
  else console.log(`✓ ${lodges.length} lodges seeded\n`);

  console.log('🦁 Safari seed complete!');
  console.log('\nWhat was seeded:');
  console.log(`  ✓ ${vehicleTransfers.length} vehicle transfers (land cruiser + tour van, capacity 8)`);
  console.log('  ✓ Kenya safari routes: Masai Mara, Amboseli, Tsavo, Samburu, Lake Nakuru');
  console.log('  ✓ Tanzania safari routes: Serengeti, Ngorongoro');
  console.log('  ✓ International gateway routes with JKIA clearance buffers');
  console.log(`  ✓ ${lodges.length} lodges and tented camps`);
  console.log('\nNext: Add your agency partner lodges via the admin dashboard.');
  process.exit(0);
}

seedSafari().catch(err => {
  console.error('❌ Safari seed failed:', err.message);
  process.exit(1);
});