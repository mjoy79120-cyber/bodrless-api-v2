/**
 * travelerProfileWriter.js
 * 
 * Runs after every session ends (or booking completes).
 * Reads traveler_events + traveler_trips + search_outcomes,
 * computes a taste profile, and upserts traveler_taste_profiles.
 * 
 * Call: await writeProfile(phone, agencyId, supabase)
 */

const DECAY_HALF_LIFE_DAYS = 180; // preference halves every 6 months

// Outcome weights for scoring model signals
const OUTCOME_WEIGHTS = {
  viewed:          0.1,
  clicked:         0.3,
  asked_question:  0.4,
  asked_similar:   0.5,
  saved:           0.7,
  booking_started: 0.8,
  booked:          1.0,
  asked_cheaper:  -0.3,
  rejected:       -0.5,
};

/**
 * Decay multiplier — recent events count more than old ones.
 * Returns a value between 0 and 1.
 */
function decayFactor(eventDate) {
  const ageMs = Date.now() - new Date(eventDate).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

/**
 * Merge a new score into a scores map with decay applied.
 * Clamps to [0, 1].
 */
function addScore(map, key, delta, decay = 1) {
  if (!key) return;
  const k = key.trim().toLowerCase();
  map[k] = Math.min(1, Math.max(0, (map[k] || 0) + delta * decay));
}

/**
 * Normalise all values in a scores map so max = 1.0
 */
function normaliseScores(map) {
  const max = Math.max(...Object.values(map), 0.01);
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, +(v / max).toFixed(3)]));
}

/**
 * Main profile writer
 */
async function writeProfile(phone, agencyId, supabase) {
  // ── 1. Pull all events for this traveler ─────────────────────────────────
  const { data: events, error: evErr } = await supabase
    .from('traveler_events')
    .select('*')
    .eq('traveler_phone', phone)
    .order('created_at', { ascending: false })
    .limit(500);

  if (evErr) {
    console.error('[ProfileWriter] Failed to load events:', evErr.message);
    return null;
  }

  // ── 2. Pull completed trips (existing table) ──────────────────────────────
  const { data: trips } = await supabase
    .from('traveler_trips')
    .select('*')
    .eq('phone', phone)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(50);

  // ── 3. Pull feedback signals ──────────────────────────────────────────────
  const { data: feedback } = await supabase
    .from('recommendation_feedback')
    .select('*')
    .eq('traveler_phone', phone)
    .order('created_at', { ascending: false })
    .limit(200);

  // ── 4. Compute destination affinity scores ────────────────────────────────
  const destinationScores = {};

  // From events: destination_mentioned, package_viewed, package_rejected
  for (const ev of events || []) {
    const decay = decayFactor(ev.created_at);
    const dest = ev.payload?.destination;

    if (ev.event_type === 'destination_mentioned' && dest) {
      addScore(destinationScores, dest, 0.15, decay);
    }
    if (ev.event_type === 'package_viewed' && dest) {
      addScore(destinationScores, dest, 0.10, decay);
    }
    if (ev.event_type === 'booking_completed' && dest) {
      addScore(destinationScores, dest, 0.60, decay);
    }
    if (ev.event_type === 'package_rejected' && dest) {
      addScore(destinationScores, dest, -0.05, decay);
    }
  }

  // From historical trips: strongest signal
  for (const trip of trips || []) {
    const decay = decayFactor(trip.created_at);
    if (trip.destination) addScore(destinationScores, trip.destination, 0.50, decay);
    if (trip.had_beach)   addScore(destinationScores, trip.destination, 0.10, decay);
    if (trip.had_safari)  addScore(destinationScores, trip.destination, 0.10, decay);
  }

  // From feedback
  for (const fb of feedback || []) {
    const decay = decayFactor(fb.created_at);
    const w = OUTCOME_WEIGHTS[fb.outcome] || 0;
    if (fb.destination && w !== 0) {
      addScore(destinationScores, fb.destination, w * 0.2, decay);
    }
  }

  // ── 5. Budget range inference ─────────────────────────────────────────────
  const budgetStatements = events
    ?.filter(e => e.event_type === 'budget_stated' && e.payload?.amount_kes)
    .map(e => ({ amount: +e.payload.amount_kes, date: e.created_at })) || [];

  const cheaperRequests = events?.filter(e => e.event_type === 'asked_for_cheaper') || [];
  const rejectedOnPrice = feedback?.filter(f => f.outcome === 'asked_cheaper' || f.outcome === 'rejected') || [];

  // Stated budgets — take recent weighted average
  let budgetMin = null, budgetMax = null, budgetSensitivity = 'medium';
  if (budgetStatements.length > 0) {
    const recent = budgetStatements.slice(0, 5);
    const avg = recent.reduce((s, b) => s + b.amount, 0) / recent.length;
    budgetMax = Math.round(avg * 1.1);
    budgetMin = Math.round(avg * 0.6);
  }

  // Also infer from completed trips
  const completedPrices = (trips || [])
    .filter(t => t.total_price_kes > 0)
    .map(t => t.total_price_kes);
  if (completedPrices.length > 0) {
    const tripMax = Math.max(...completedPrices);
    const tripMin = Math.min(...completedPrices);
    budgetMax = budgetMax ? Math.round((budgetMax + tripMax) / 2) : tripMax;
    budgetMin = budgetMin ? Math.round((budgetMin + tripMin) / 2) : tripMin;
  }

  // Budget sensitivity
  const cheaperRate = events?.length > 0
    ? cheaperRequests.length / Math.max(events.length, 1)
    : 0;
  if (cheaperRate > 0.15 || cheaperRequests.length > 3) budgetSensitivity = 'high';
  else if (cheaperRate < 0.03 && completedPrices.length > 0) budgetSensitivity = 'low';

  // ── 6. Travel style scores ────────────────────────────────────────────────
  const styleScores = {};

  for (const trip of trips || []) {
    const decay = decayFactor(trip.created_at);
    if (trip.had_beach)  addScore(styleScores, 'beach', 0.40, decay);
    if (trip.had_safari) addScore(styleScores, 'safari', 0.40, decay);
    if (trip.trip_purpose === 'honeymoon') addScore(styleScores, 'couples', 0.50, decay);
    if (trip.trip_purpose === 'family')    addScore(styleScores, 'family', 0.50, decay);
    if (trip.trip_purpose === 'business')  addScore(styleScores, 'business', 0.50, decay);
  }

  // From events that carry style hints
  for (const ev of events || []) {
    const decay = decayFactor(ev.created_at);
    const tags = ev.payload?.style_tags || [];
    for (const tag of tags) {
      addScore(styleScores, tag, 0.15, decay);
    }
  }

  // ── 7. Accommodation scores ───────────────────────────────────────────────
  const accScores = {};

  for (const trip of trips || []) {
    const decay = decayFactor(trip.created_at);
    if (trip.hotel_stars >= 4) addScore(accScores, 'luxury', 0.30, decay);
    if (trip.hotel_stars === 3) addScore(accScores, 'midrange', 0.30, decay);
    if (trip.hotel_stars <= 2) addScore(accScores, 'budget', 0.30, decay);
    if (trip.had_beach)        addScore(accScores, 'beach_resort', 0.25, decay);
  }

  // ── 8. Transport preferences ──────────────────────────────────────────────
  const directFlightEvents = events?.filter(
    e => e.event_type === 'package_viewed' && e.payload?.is_direct === true
  ) || [];
  const connectingEvents = events?.filter(
    e => e.event_type === 'package_viewed' && e.payload?.is_direct === false
  ) || [];
  const prefersDirectFlight = directFlightEvents.length > connectingEvents.length;

  const transferComplaints = events?.filter(
    e => e.event_type === 'asked_for_similar' &&
         (e.payload?.reason || '').toLowerCase().includes('transfer')
  ) || [];
  const dislikesLongTransfers = transferComplaints.length > 1;

  // ── 9. Current intent ─────────────────────────────────────────────────────
  const lastSearch = events?.find(e => e.event_type === 'search_ran');
  const lastIntentDestination = lastSearch?.payload?.destination || null;
  const lastIntentWindow = lastSearch?.payload?.travel_window || null;

  // Booking readiness
  let bookingReadiness = 'browsing';
  const recentBookingStart = events?.find(e => e.event_type === 'booking_started');
  const recentSave = events?.find(e => e.event_type === 'package_saved');
  if (recentBookingStart && decayFactor(recentBookingStart.created_at) > 0.8) {
    bookingReadiness = 'hot';
  } else if (recentSave && decayFactor(recentSave.created_at) > 0.7) {
    bookingReadiness = 'warm';
  }

  // ── 10. Preferred nights ──────────────────────────────────────────────────
  const tripNights = (trips || []).filter(t => t.nights > 0).map(t => t.nights);
  const preferredNightsMin = tripNights.length > 0
    ? Math.round(Math.min(...tripNights))
    : null;
  const preferredNightsMax = tripNights.length > 0
    ? Math.round(Math.max(...tripNights))
    : null;

  // ── 11. Counters ──────────────────────────────────────────────────────────
  const totalSessions = new Set((events || []).map(e => e.session_id)).size;
  const totalSearches = events?.filter(e => e.event_type === 'search_ran').length || 0;
  const totalBookings = events?.filter(e => e.event_type === 'booking_completed').length || 0;

  // ── 12. Build final profile ───────────────────────────────────────────────
  const profile = {
    traveler_phone:          phone,
    destination_scores:      normaliseScores(destinationScores),
    budget_min_kes:          budgetMin,
    budget_max_kes:          budgetMax,
    budget_sensitivity:      budgetSensitivity,
    preferred_nights_min:    preferredNightsMin,
    preferred_nights_max:    preferredNightsMax,
    travel_style_scores:     normaliseScores(styleScores),
    accommodation_scores:    normaliseScores(accScores),
    prefers_direct_flight:   prefersDirectFlight,
    dislikes_long_transfers: dislikesLongTransfers,
    preferred_cabin:         trips?.[0]?.cabin_class || null,
    last_intent_destination: lastIntentDestination,
    last_intent_window:      lastIntentWindow,
    booking_readiness:       bookingReadiness,
    total_sessions:          totalSessions,
    total_searches:          totalSearches,
    total_bookings:          totalBookings,
    last_session_at:         events?.[0]?.created_at || null,
    updated_at:              new Date().toISOString(),
  };

  // ── 13. Upsert ────────────────────────────────────────────────────────────
  const { error: upsertErr } = await supabase
    .from('traveler_taste_profiles')
    .upsert(profile, { onConflict: 'traveler_phone' });

  if (upsertErr) {
    console.error('[ProfileWriter] Upsert failed:', upsertErr.message);
    return null;
  }

  console.log(`[ProfileWriter] ✓ Profile written for ${phone} — ` +
    `${Object.keys(destinationScores).length} destinations, ` +
    `budget ${budgetMin}–${budgetMax} KES, ` +
    `readiness: ${bookingReadiness}`);

  return profile;
}

/**
 * logEvent — call this throughout your engine/webhook handler
 * 
 * Usage examples:
 *   await logEvent(supabase, phone, agencyId, sessionId, 'destination_mentioned', { destination: 'Zanzibar' })
 *   await logEvent(supabase, phone, agencyId, sessionId, 'package_rejected', { package_id, destination, price_kes: 95000 })
 *   await logEvent(supabase, phone, agencyId, sessionId, 'asked_for_cheaper', { current_price_kes: 120000, destination })
 *   await logEvent(supabase, phone, agencyId, sessionId, 'booking_completed', { destination, price_kes, hotel_name })
 */
async function logEvent(supabase, phone, agencyId, sessionId, eventType, payload = {}, channel = 'whatsapp') {
  if (!phone || !eventType) return;

  const { error } = await supabase
    .from('traveler_events')
    .insert({
      traveler_phone: phone,
      agency_id:      agencyId,
      session_id:     sessionId,
      event_type:     eventType,
      payload,
      channel,
    });

  if (error) {
    console.error(`[logEvent] Failed to log ${eventType}:`, error.message);
  }
}

/**
 * logFeedback — call when traveler reacts to a shown package
 */
async function logFeedback(supabase, { sessionId, phone, agencyId, packageId, outcome, priceKes, destination, metadata = {} }) {
  const WEIGHTS = {
    viewed: 0.1, clicked: 0.3, asked_question: 0.4, asked_similar: 0.5,
    saved: 0.7, booking_started: 0.8, booked: 1.0,
    asked_cheaper: -0.3, rejected: -0.5,
  };

  const { error } = await supabase
    .from('recommendation_feedback')
    .insert({
      session_id:           sessionId,
      traveler_phone:       phone,
      agency_id:            agencyId,
      package_id:           packageId,
      outcome,
      outcome_weight:       WEIGHTS[outcome] ?? 0,
      price_kes_at_outcome: priceKes,
      destination,
      metadata,
    });

  if (error) {
    console.error(`[logFeedback] Failed to log feedback ${outcome}:`, error.message);
  }
}

module.exports = { writeProfile, logEvent, logFeedback };