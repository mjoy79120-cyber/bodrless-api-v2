/**
 * PENDING ITINERARY SERVICE
 * ─────────────────────────────────────────────────────────────
 * Cross-channel trip state management.
 * Phone number is the universal key: widget ↔ WhatsApp.
 *
 * Uses the SAME leg_flow shape as conversationMemory so
 * WhatsApp and widget share state seamlessly.
 *
 * State hierarchy:
 *   1. Widget localStorage       → instant restore, no network
 *   2. pending_itineraries table → Supabase, session-keyed
 *   3. whatsapp_contacts.leg_flow→ Supabase, phone-keyed (canonical)
 *
 * When phone is collected at booking, steps 2+3 are linked
 * and WhatsApp can continue the exact same leg flow.
 */

const { v4: uuidv4 } = require('uuid');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');

// Lazy-load conversationMemory to avoid circular deps
function getConversationMemory() {
  return require('./conversationMemoryService');
}

// ─────────────────────────────────────────────────────────────
// PRICE CHECK INTERVALS (hours) based on trip proximity
// ─────────────────────────────────────────────────────────────
function _priceCheckInterval(departureDateStr) {
  if (!departureDateStr) return 48;
  const daysUntil = Math.ceil((new Date(departureDateStr) - new Date()) / 86400000);
  if (daysUntil <= 7)  return 2;
  if (daysUntil <= 30) return 12;
  return 48;
}

// ─────────────────────────────────────────────────────────────
// MESSAGE CLASSIFIER
// Determines intent so we know whether to restore or start fresh
// ─────────────────────────────────────────────────────────────
const GREETING_PATTERN    = /^(hi|hey|hello|hujambo|habari|sasa|niaje|good\s*(morning|afternoon|evening)|howdy|sup|what'?s\s*up|yo|greetings|salaam|jambo)[\s!?.]*$/i;
const RESUME_PATTERN      = /\b(my\s*(saved|previous|last)\s*trip|the\s*trip\s*(i|we)\s*(was|were)\s*planning|continue|pick\s*up\s*where|resume|saved\s*itinerary|my\s*itinerary)\b/i;
const NEW_TRIP_PATTERN    = /\b(to|from|nairobi|mombasa|zanzibar|kigali|dubai|london|safari|fly|flight|hotel|nights?|travel|trip\s+to)\b/i;

function classifyMessage(text) {
  const t = (text || '').trim();
  if (GREETING_PATTERN.test(t)) return 'greeting';
  if (RESUME_PATTERN.test(t))   return 'resume_request';
  if (NEW_TRIP_PATTERN.test(t)) return 'new_trip';
  return 'other';
}

// ─────────────────────────────────────────────────────────────
// SAVE / UPSERT pending_itineraries
// leg_flow uses conversationMemory shape for cross-channel compat
// ─────────────────────────────────────────────────────────────
async function save({
  itineraryId    = null,
  phone          = null,
  agencyId,
  sessionId,
  channel        = 'widget',
  tripParams,
  legResults,    // tripResults[] from engine (classified trip)
  legFlow,       // conversationMemory leg_flow shape
  status         = 'active',
  bookedLegs     = [],
  pendingLegs    = [],
  priceSnapshot  = {},
}) {
  try {
    const departureDateStr = tripParams?.departureDate || null;
    const intervalHours    = _priceCheckInterval(departureDateStr);

    // Total from leg_flow selections
    let totalSelectedPrice = 0;
    if (legFlow?.runningTotalKES) totalSelectedPrice = legFlow.runningTotalKES;

    const payload = {
      phone,
      agency_id:           agencyId,
      session_id:          sessionId || null,
      channel,
      trip_params:         tripParams    || null,
      leg_results:         legResults    || null,
      leg_flow:            legFlow       || null,
      selected_legs:       legFlow?.selections ? Object.values(legFlow.selections) : [],
      current_leg_index:   legFlow?.currentLegIndex ?? 0,
      booked_legs:         bookedLegs,
      pending_legs:        pendingLegs,
      price_snapshot:      priceSnapshot,
      price_checked_at:    new Date().toISOString(),
      price_check_interval_hours: intervalHours,
      destination:         tripParams?.destination || null,
      departure_date:      departureDateStr,
      total_selected_price: totalSelectedPrice,
      currency:            tripParams?.currency || 'KES',
      passengers:          tripParams?.passengers || 1,
      status,
      updated_at:          new Date().toISOString(),
      expires_at:          new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    };

    if (itineraryId) {
      const { error } = await supabase
        .from('pending_itineraries')
        .update(payload)
        .eq('id', itineraryId);
      if (error) throw error;
      logger.info('PendingItinerary: updated', { id: itineraryId, status });
      return itineraryId;
    } else {
      const newId = uuidv4();
      const { error } = await supabase
        .from('pending_itineraries')
        .insert({ id: newId, ...payload });
      if (error) throw error;
      logger.info('PendingItinerary: created', { id: newId, agencyId, phone, channel });
      return newId;
    }
  } catch (err) {
    logger.error('PendingItinerary.save failed', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// RESTORE
// Phone-first (cross-channel), sessionId fallback (widget only)
// ─────────────────────────────────────────────────────────────
async function restore({ phone, sessionId, agencyId }) {
  try {
    let query = supabase
      .from('pending_itineraries')
      .select('*')
      .eq('agency_id', agencyId)
      .in('status', ['active', 'partially_booked'])
      .gt('expires_at', new Date().toISOString())
      .order('updated_at', { ascending: false })
      .limit(1);

    if (phone) {
      query = query.eq('phone', phone);
    } else if (sessionId) {
      query = query.eq('session_id', sessionId);
    } else {
      return null;
    }

    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;

    logger.info('PendingItinerary: restored', {
      id: data.id, phone, sessionId,
      status: data.status,
      currentLegIndex: data.current_leg_index,
    });
    return data;
  } catch (err) {
    logger.error('PendingItinerary.restore failed', { error: err.message });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// ATTACH PHONE
// Called at booking time — links session to phone for WhatsApp
// Also writes leg_flow to whatsapp_contacts for WA continuity
// ─────────────────────────────────────────────────────────────
async function attachPhone(itineraryId, phone, agencyId) {
  if (!itineraryId || !phone) return;
  try {
    // Update pending_itineraries
    await supabase
      .from('pending_itineraries')
      .update({ phone, updated_at: new Date().toISOString() })
      .eq('id', itineraryId);

    // Get the itinerary so we can sync leg_flow to whatsapp_contacts
    const { data: itin } = await supabase
      .from('pending_itineraries')
      .select('leg_flow, trip_params')
      .eq('id', itineraryId)
      .single();

    if (itin?.leg_flow) {
      const cm = getConversationMemory();
      await cm.upsertContact(phone, agencyId, {
        leg_flow:        itin.leg_flow,
        previous_params: itin.trip_params || null,
      });
      logger.info('PendingItinerary: leg_flow synced to whatsapp_contacts', { phone, itineraryId });
    }

    logger.info('PendingItinerary: phone attached', { id: itineraryId, phone });
  } catch (err) {
    logger.error('PendingItinerary.attachPhone failed', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// MARK STATES
// ─────────────────────────────────────────────────────────────
async function markAbandoned(itineraryId) {
  if (!itineraryId) return;
  try {
    await supabase
      .from('pending_itineraries')
      .update({ status: 'abandoned', updated_at: new Date().toISOString() })
      .eq('id', itineraryId);
    logger.info('PendingItinerary: abandoned', { id: itineraryId });
  } catch (err) {
    logger.error('PendingItinerary.markAbandoned failed', { error: err.message });
  }
}

async function markPartiallyBooked(itineraryId, bookedLegs, pendingLegs) {
  if (!itineraryId) return;
  try {
    await supabase
      .from('pending_itineraries')
      .update({
        status:       'partially_booked',
        booked_legs:  bookedLegs,
        pending_legs: pendingLegs,
        updated_at:   new Date().toISOString(),
      })
      .eq('id', itineraryId);
  } catch (err) {
    logger.error('PendingItinerary.markPartiallyBooked failed', { error: err.message });
  }
}

async function markCompleted(itineraryId) {
  if (!itineraryId) return;
  try {
    await supabase
      .from('pending_itineraries')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', itineraryId);
  } catch (err) {
    logger.error('PendingItinerary.markCompleted failed', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────
// BUILD RESTORE PROMPT
// Shown when a returning traveler sends a greeting
// ─────────────────────────────────────────────────────────────
function buildRestorePrompt(itinerary) {
  try {
    const tp       = itinerary.trip_params || {};
    const legFlow  = itinerary.leg_flow || {};
    const dest     = tp.destination || 'your destination';
    const deps     = tp.departureDate
      ? new Date(tp.departureDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      : null;
    const pax      = tp.passengers || 1;
    const selCount = Object.keys(legFlow.selections || {}).length;
    const legCount = (legFlow.legs || []).length;
    const total    = legFlow.runningTotalKES || 0;
    const cur      = itinerary.currency || 'KES';

    let msg = `👋 Welcome back! You have a saved trip`;
    if (dest) msg += ` to *${dest.charAt(0).toUpperCase() + dest.slice(1)}*`;
    if (deps) msg += ` on ${deps}`;
    if (pax > 1) msg += ` for ${pax} travelers`;
    msg += `.`;

    if (selCount > 0 && legCount > 0) {
      msg += `\n\nYou've selected ${selCount} of ${legCount} leg${legCount !== 1 ? 's' : ''}`;
      if (total > 0) msg += ` — total so far: *${cur} ${Math.round(total).toLocaleString()}*`;
      msg += `.`;
    }

    if (itinerary.status === 'partially_booked') {
      const booked = Array.isArray(itinerary.booked_legs) ? itinerary.booked_legs.length : 0;
      msg += `\n\n✅ ${booked} leg${booked !== 1 ? 's' : ''} already booked. Pending legs still need confirmation.`;
    }

    msg += `\n\nWant to continue where you left off?`;
    return msg;
  } catch {
    return `👋 Welcome back! You have a saved trip — want to continue where you left off?`;
  }
}

// ─────────────────────────────────────────────────────────────
// PRICE CHECK
// Compares current selection prices against saved snapshot
// Returns array of nudges
// ─────────────────────────────────────────────────────────────
async function checkPrices(itinerary) {
  try {
    const snapshot  = itinerary.price_snapshot || {};
    const legFlow   = itinerary.leg_flow || {};
    const selections = legFlow.selections || {};
    const nudges    = [];

    for (const [idx, sel] of Object.entries(selections)) {
      const pkg      = sel?.package;
      if (!pkg?.packageId) continue;

      const oldPrice = snapshot[pkg.packageId];
      const newPrice = pkg?.summary?.totalPrice;
      if (!oldPrice || !newPrice) continue;

      const change    = newPrice - oldPrice;
      const changePct = Math.abs(change / oldPrice) * 100;
      if (changePct < 2 && Math.abs(change) < 500) continue;

      const direction = change > 0 ? 'up' : 'down';
      nudges.push({
        packageId:  pkg.packageId,
        legIndex:   Number(idx),
        legLabel:   sel.label || `Leg ${Number(idx) + 1}`,
        oldPrice,
        newPrice,
        change:     Math.abs(change),
        changePct:  Math.round(changePct),
        direction,
        currency:   itinerary.currency || 'KES',
      });

      // Log nudge
      await supabase.from('price_nudges').insert({
        id:            uuidv4(),
        itinerary_id:  itinerary.id,
        package_id:    pkg.packageId,
        leg_index:     Number(idx),
        old_price:     oldPrice,
        new_price:     newPrice,
        currency:      itinerary.currency || 'KES',
        direction,
        change_amount: Math.abs(change),
        change_pct:    Math.round(changePct),
        nudge_channel: itinerary.channel,
        created_at:    new Date().toISOString(),
      }).catch(() => {});
    }

    // Update checked timestamp
    await supabase
      .from('pending_itineraries')
      .update({ price_checked_at: new Date().toISOString() })
      .eq('id', itinerary.id)
      .catch(() => {});

    return nudges;
  } catch (err) {
    logger.error('PendingItinerary.checkPrices failed', { error: err.message });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// FORMAT PRICE NUDGE — non-blocking, inline alert
// ─────────────────────────────────────────────────────────────
function formatNudgeMessage(nudges, currency = 'KES') {
  if (!nudges || nudges.length === 0) return null;
  const lines = nudges.map(n => {
    const amt = `${n.currency || currency} ${Math.round(n.change).toLocaleString()}`;
    if (n.direction === 'down') {
      return `✈️ *${n.legLabel}* dropped by ${amt} (${n.changePct}%) — your saved price still stands, great news!`;
    }
    return `⚠️ *${n.legLabel}* went up by ${amt} (${n.changePct}%). Reply "keep it" to hold your selection or "search again" for alternatives.`;
  });
  return `💡 Quick price update on your saved trip:\n\n${lines.join('\n')}`;
}

function shouldCheckPrices(itinerary) {
  if (!itinerary?.price_checked_at) return true;
  const intervalMs  = (itinerary.price_check_interval_hours || 48) * 60 * 60 * 1000;
  const lastChecked = new Date(itinerary.price_checked_at).getTime();
  return (Date.now() - lastChecked) > intervalMs;
}

// ─────────────────────────────────────────────────────────────
// CALCULATE DEPOSIT
// Flights 100% + Hotels 30% + Transfers paid at arrival
// ─────────────────────────────────────────────────────────────
function calculateDeposit(legFlow) {
  let flightsTotal   = 0;
  let hotelsTotal    = 0;
  let transfersTotal = 0;
  const selections   = legFlow?.selections || {};

  for (const sel of Object.values(selections)) {
    const pkg    = sel?.package;
    if (!pkg) continue;
    const nights = pkg.summary?.nights || 1;

    if (pkg.transport?.price)       flightsTotal   += Number(pkg.transport.price)       || 0;
    if (pkg.returnTransport?.price) flightsTotal   += Number(pkg.returnTransport.price) || 0;
    if (pkg.hotel?.pricePerNight)   hotelsTotal    += (Number(pkg.hotel.pricePerNight) || 0) * nights;
    for (const x of (pkg.transfers || [])) transfersTotal += Number(x.price) || 0;
  }

  const hotelDeposit = Math.round(hotelsTotal * 0.30);
  const depositTotal = Math.round(flightsTotal + hotelDeposit);
  const balanceDue   = Math.round(hotelsTotal - hotelDeposit + transfersTotal);

  return {
    flightsTotal:   Math.round(flightsTotal),
    hotelsTotal:    Math.round(hotelsTotal),
    transfersTotal: Math.round(transfersTotal),
    hotelDeposit,
    depositTotal,
    balanceDue,
    currency: 'KES',
    breakdown: [
      { label: 'Flights (100%)',      amount: Math.round(flightsTotal) },
      { label: 'Hotel deposit (30%)', amount: hotelDeposit },
      { label: 'Balance due later',   amount: balanceDue, note: 'Hotel balance + transfers paid at arrival' },
    ],
  };
}

module.exports = {
  save,
  restore,
  attachPhone,
  markAbandoned,
  markPartiallyBooked,
  markCompleted,
  checkPrices,
  shouldCheckPrices,
  formatNudgeMessage,
  buildRestorePrompt,
  calculateDeposit,
  classifyMessage,
};