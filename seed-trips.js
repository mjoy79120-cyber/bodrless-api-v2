/**
 * seed-trips.js
 * Run once to populate dummy active trips for dashboard testing.
 * Usage: node seed-trips.js
 * Requires SUPABASE_URL and SUPABASE_KEY env vars (same as your app).
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const IDS = {
  t1: crypto.randomUUID(),
  t2: crypto.randomUUID(),
  t3: crypto.randomUUID(),
  t4: crypto.randomUUID(),
  t5: crypto.randomUUID(),
  b1: crypto.randomUUID(),
  b2: crypto.randomUUID(),
  b3: crypto.randomUUID(),
  b4: crypto.randomUUID(),
  b5: crypto.randomUUID(),
};

const now = new Date().toISOString();

const agencies = [
  { id: 'azaki-adventures', name: 'Azaki Adventures', email: 'ops@azaki.co.ke', status: 'active', plan: 'pro' },
  { id: 'trip-soko',        name: 'Trip Soko',        email: 'ops@tripsoko.co.ke', status: 'active', plan: 'pro' },
  { id: 'tulivu-africa',    name: 'Tulivu Africa',    email: 'ops@tulivu.co.ke', status: 'active', plan: 'pro' },
];

const bookings = [
  { id: IDS.b1, booking_ref: 'BDR-DEMO-001', agency_id: 'azaki-adventures', guest_name: 'James Kariuki', guest_phone: '+254700000001', origin: 'NBO', destination: 'CPT', status: 'confirmed' },
  { id: IDS.b2, booking_ref: 'BDR-DEMO-002', agency_id: 'trip-soko',        guest_name: 'Amina Odhiambo', guest_phone: '+254700000002', origin: 'NBO', destination: 'DXB', status: 'confirmed' },
  { id: IDS.b3, booking_ref: 'BDR-DEMO-003', agency_id: 'tulivu-africa',    guest_name: 'David Mwangi',   guest_phone: '+254700000003', origin: 'NBO', destination: 'LHR', status: 'confirmed' },
  { id: IDS.b4, booking_ref: 'BDR-DEMO-004', agency_id: 'azaki-adventures', guest_name: 'Grace Njeri',    guest_phone: '+254700000004', origin: 'MBA', destination: 'JNB', status: 'confirmed' },
  { id: IDS.b5, booking_ref: 'BDR-DEMO-005', agency_id: 'trip-soko',        guest_name: 'Samuel Otieno', guest_phone: '+254700000005', origin: 'NBO', destination: 'CDG', status: 'confirmed' },
];

const trips = [
  {
    id: IDS.t1, booking_id: IDS.b1, booking_ref: 'BDR-DEMO-001', agency_id: 'azaki-adventures',
    guest_name: 'James Kariuki', guest_phone: '+254700000001',
    origin: 'NBO', destination: 'CPT',
    departure_date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    return_date:    new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10),
    flight_number: 'QR541', hotel_name: 'Cape Grace Hotel',
    stage: 'pre_departure', health: 'healthy',
    active_disruption: false, monitoring_enabled: true, check_interval_mins: 30,
    created_at: now, updated_at: now,
  },
  {
    id: IDS.t2, booking_id: IDS.b2, booking_ref: 'BDR-DEMO-002', agency_id: 'trip-soko',
    guest_name: 'Amina Odhiambo', guest_phone: '+254700000002',
    origin: 'NBO', destination: 'DXB',
    departure_date: new Date(Date.now() + 1 * 86400000).toISOString().slice(0, 10),
    return_date:    new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10),
    flight_number: 'EK722', hotel_name: 'Atlantis The Palm',
    stage: 'pre_departure', health: 'attention',
    active_disruption: true, disruption_type: 'flight_delay',
    monitoring_enabled: true, check_interval_mins: 30,
    created_at: now, updated_at: now,
  },
  {
    id: IDS.t3, booking_id: IDS.b3, booking_ref: 'BDR-DEMO-003', agency_id: 'tulivu-africa',
    guest_name: 'David Mwangi', guest_phone: '+254700000003',
    origin: 'NBO', destination: 'LHR',
    departure_date: new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10),
    return_date:    new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    flight_number: 'BA065', hotel_name: 'The Savoy London',
    stage: 'in_destination', health: 'critical',
    active_disruption: true, disruption_type: 'hotel_issue',
    monitoring_enabled: true, check_interval_mins: 30,
    created_at: now, updated_at: now,
  },
  {
    id: IDS.t4, booking_id: IDS.b4, booking_ref: 'BDR-DEMO-004', agency_id: 'azaki-adventures',
    guest_name: 'Grace Njeri', guest_phone: '+254700000004',
    origin: 'MBA', destination: 'JNB',
    departure_date: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10),
    return_date:    new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
    flight_number: 'SA201', hotel_name: 'Sandton Sun',
    stage: 'booked', health: 'healthy',
    active_disruption: false, monitoring_enabled: true, check_interval_mins: 30,
    created_at: now, updated_at: now,
  },
  {
    id: IDS.t5, booking_id: IDS.b5, booking_ref: 'BDR-DEMO-005', agency_id: 'trip-soko',
    guest_name: 'Samuel Otieno', guest_phone: '+254700000005',
    origin: 'NBO', destination: 'CDG',
    departure_date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
    return_date:    new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10),
    flight_number: 'AF560', hotel_name: 'Hotel Le Marais',
    stage: 'returning', health: 'healthy',
    active_disruption: false, monitoring_enabled: true, check_interval_mins: 30,
    created_at: now, updated_at: now,
  },
];

const events = [
  { trip_id: IDS.t1, booking_ref: 'BDR-DEMO-001', agency_id: 'azaki-adventures', event_type: 'booking_confirmed', title: 'Booking confirmed', description: 'QR541 NBO→CPT booked. Cape Grace Hotel confirmed.', severity: 'info', resolved: false, created_at: now },
  { trip_id: IDS.t1, booking_ref: 'BDR-DEMO-001', agency_id: 'azaki-adventures', event_type: 'monitoring_started', title: 'Monitoring started', description: 'Flight status polling active. Departure in 2 days.', severity: 'info', resolved: false, created_at: now },
  { trip_id: IDS.t2, booking_ref: 'BDR-DEMO-002', agency_id: 'trip-soko', event_type: 'booking_confirmed', title: 'Booking confirmed', description: 'EK722 NBO→DXB booked. Atlantis confirmed.', severity: 'info', resolved: false, created_at: now },
  { trip_id: IDS.t2, booking_ref: 'BDR-DEMO-002', agency_id: 'trip-soko', event_type: 'flight_delay', title: 'Flight delay detected', description: 'EK722 delayed by 90 minutes. New departure 23:15 EAT.', severity: 'warning', resolved: false, created_at: now },
  { trip_id: IDS.t3, booking_ref: 'BDR-DEMO-003', agency_id: 'tulivu-africa', event_type: 'booking_confirmed', title: 'Booking confirmed', description: 'BA065 NBO→LHR booked. The Savoy confirmed.', severity: 'info', resolved: false, created_at: now },
  { trip_id: IDS.t3, booking_ref: 'BDR-DEMO-003', agency_id: 'tulivu-africa', event_type: 'hotel_issue', title: 'Hotel issue reported', description: 'Guest reports room not ready on check-in. Hotel staff engaged.', severity: 'critical', resolved: false, created_at: now },
  { trip_id: IDS.t4, booking_ref: 'BDR-DEMO-004', agency_id: 'azaki-adventures', event_type: 'booking_confirmed', title: 'Booking confirmed', description: 'SA201 MBA→JNB booked. Sandton Sun confirmed.', severity: 'info', resolved: false, created_at: now },
  { trip_id: IDS.t5, booking_ref: 'BDR-DEMO-005', agency_id: 'trip-soko', event_type: 'booking_confirmed', title: 'Booking confirmed', description: 'AF560 NBO→CDG booked. Hotel Le Marais confirmed.', severity: 'info', resolved: false, created_at: now },
  { trip_id: IDS.t5, booking_ref: 'BDR-DEMO-005', agency_id: 'trip-soko', event_type: 'check_in', title: 'Guest checked in', description: 'Guest confirmed hotel check-in. All good.', severity: 'info', resolved: false, created_at: now },
];

async function seed() {
  console.log('Seeding demo data...');

  const { error: agencyError } = await supabase
    .from('agencies')
    .upsert(agencies, { onConflict: 'id' });
  if (agencyError) { console.error('Agency insert failed:', agencyError.message); process.exit(1); }
  console.log(`✓ Upserted ${agencies.length} agencies`);

  // Clean up old demo data first
  await supabase.from('trip_events').delete().in('booking_ref', ['BDR-DEMO-001','BDR-DEMO-002','BDR-DEMO-003','BDR-DEMO-004','BDR-DEMO-005']);
  await supabase.from('trips').delete().in('booking_ref', ['BDR-DEMO-001','BDR-DEMO-002','BDR-DEMO-003','BDR-DEMO-004','BDR-DEMO-005']);
  await supabase.from('bookings').delete().in('booking_ref', ['BDR-DEMO-001','BDR-DEMO-002','BDR-DEMO-003','BDR-DEMO-004','BDR-DEMO-005']);
  console.log('✓ Cleared old demo data');

  const { error: bookingError } = await supabase
    .from('bookings')
    .insert(bookings);
  if (bookingError) { console.error('Booking insert failed:', bookingError.message); process.exit(1); }
  console.log(`✓ Inserted ${bookings.length} bookings`);

  const { error: tripError } = await supabase
    .from('trips')
    .insert(trips);
  if (tripError) { console.error('Trip insert failed:', tripError.message); process.exit(1); }
  console.log(`✓ Inserted ${trips.length} trips`);

  const { error: eventError } = await supabase
    .from('trip_events')
    .insert(events);
  if (eventError) { console.error('Event insert failed:', eventError.message); process.exit(1); }
  console.log(`✓ Inserted ${events.length} events`);

  console.log('Done. Open /admin/dashboard → Active Trips to see them.');
}

seed();