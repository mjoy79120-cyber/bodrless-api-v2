/**
 * HOTEL NUDGE SCHEDULER
 * Runs every 2 hours via setInterval in server.js
 * Checks hotel_wishes against live inventory and rates,
 * fires email nudges when conditions are met.
 *
 * Add to server.js:
 *   const hotelNudgeScheduler = require('./services/hotelNudgeScheduler');
 *   hotelNudgeScheduler.start();
 */

const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

// Min hours between nudges to same guest
const MIN_NUDGE_INTERVAL_HOURS = 24;
// Max nudges per wish before giving up
const MAX_NUDGES = 4;
// Inventory threshold — nudge when rooms drop to this or below
const LOW_INVENTORY_THRESHOLD = 3;

// ── Send email via existing Resend setup ──────────────────────
async function _sendEmail(to, subject, html) {
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.RESEND_FROM || 'noreply@bodrless.com',
      to,
      subject,
      html,
    });
    return true;
  } catch (err) {
    logger.warn('[HOTEL NUDGE] Email send failed', { to, error: err.message });
    return false;
  }
}

function _emailHtml(propertyName, message, ctaText, ctaUrl) {
  return `
<!DOCTYPE html>
<html>
<body style="font-family:Arial,sans-serif;background:#f8f6f2;padding:32px 16px;margin:0;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
    <div style="background:#1C2B4A;padding:24px 28px;">
      <div style="color:#C9A84C;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">${propertyName}</div>
      <div style="color:white;font-size:18px;font-weight:700;line-height:1.3;">A quick note about your stay</div>
    </div>
    <div style="padding:28px;">
      <p style="font-size:15px;color:#1a1a1a;line-height:1.7;margin:0 0 24px;">${message}</p>
      <a href="${ctaUrl}" style="display:inline-block;background:#1C2B4A;color:white;padding:13px 28px;border-radius:25px;text-decoration:none;font-size:13px;font-weight:700;">${ctaText}</a>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #f0ede6;font-size:11px;color:#aaa;text-align:center;">
      Powered by Bodrless · <a href="#" style="color:#aaa;">Unsubscribe</a>
    </div>
  </div>
</body>
</html>`;
}

async function _markNudgeSent(wishId, nudgeType, message, sentTo, groupId) {
  await supabase.from('hotel_nudge_log').insert({
    wish_id:    wishId,
    group_id:   groupId,
    nudge_type: nudgeType,
    message,
    sent_to:    sentTo,
    sent_via:   'email',
  });
  await supabase.from('hotel_wishes').update({
    last_nudge_at: new Date().toISOString(),
    nudge_count:   supabase.rpc('increment', { row_id: wishId }), // will fail silently, handled below
    pending_nudge: null,
  }).eq('id', wishId);
  // Increment nudge count safely
  await supabase.rpc('increment_hotel_wish_nudge', { wish_id: wishId }).catch(() => {});
}

// ── Check inventory for a wish ────────────────────────────────
async function _checkInventory(wish) {
  if (!wish.property_id || !wish.check_in || !wish.check_out) return null;

  // Get all room types for this property
  const { data: roomTypes } = await supabase
    .from('room_types')
    .select('id, name, total_rooms')
    .eq('property_id', wish.property_id)
    .eq('is_active', true);

  if (!roomTypes?.length) return null;

  // Check bookings for these dates
  const { data: bookings } = await supabase
    .from('hotel_reservations')
    .select('room_type_id, nights')
    .eq('property_id', wish.property_id)
    .lte('check_in', wish.check_in)
    .gte('check_out', wish.check_out)
    .not('status', 'eq', 'cancelled');

  const bookedByType = {};
  (bookings || []).forEach(b => {
    bookedByType[b.room_type_id] = (bookedByType[b.room_type_id] || 0) + 1;
  });

  // Find lowest availability
  let lowestAvail = Infinity;
  let lowestRoom  = null;

  for (const rt of roomTypes) {
    const total   = rt.total_rooms || 1;
    const booked  = bookedByType[rt.id] || 0;
    const avail   = total - booked;
    if (avail < lowestAvail) {
      lowestAvail = avail;
      lowestRoom  = rt;
    }
  }

  if (lowestAvail <= LOW_INVENTORY_THRESHOLD && lowestAvail > 0) {
    return {
      type: 'low_inventory',
      rooms: lowestAvail,
      roomName: lowestRoom?.name || 'rooms',
    };
  }

  return null;
}

// ── Check rate drops ──────────────────────────────────────────
async function _checkRateDrop(wish) {
  if (!wish.room_type_id || !wish.last_price_seen || !wish.check_in) return null;

  const { data: rates } = await supabase
    .from('rate_plans')
    .select('price_per_night, currency')
    .eq('room_type_id', wish.room_type_id)
    .eq('is_active', true)
    .order('price_per_night', { ascending: true })
    .limit(1);

  if (!rates?.length) return null;

  const currentRate = rates[0].price_per_night;
  const lastSeen    = wish.last_price_seen;
  const drop        = lastSeen - currentRate;
  const dropPct     = (drop / lastSeen) * 100;

  // Only nudge if drop is > 5%
  if (drop > 0 && dropPct > 5) {
    return {
      type:        'price_drop',
      oldPrice:    lastSeen,
      newPrice:    currentRate,
      saving:      Math.round(drop),
      currency:    rates[0].currency || wish.currency || 'KES',
      dropPct:     Math.round(dropPct),
    };
  }

  return null;
}

// ── Check approaching dates ───────────────────────────────────
async function _checkApproaching(wish) {
  if (!wish.check_in) return null;
  const daysUntil = Math.ceil((new Date(wish.check_in) - new Date()) / (1000 * 60 * 60 * 24));
  if (daysUntil > 0 && daysUntil <= 7) {
    return { type: 'approaching', daysUntil };
  }
  return null;
}

// ── Check active promos for this property ────────────────────
async function _checkPromos(wish) {
  if (!wish.property_id) return null;
  const today = new Date().toISOString().split('T')[0];

  const { data: promos } = await supabase
    .from('hotel_promos')
    .select('*')
    .eq('property_id', wish.property_id)
    .eq('is_active', true)
    .lte('valid_from', today)
    .gte('valid_until', today)
    .limit(1);

  if (promos?.length) return { type: 'promo', promo: promos[0] };
  return null;
}

// ── Build nudge message ───────────────────────────────────────
function _buildMessage(wish, trigger, propertyName) {
  const name    = wish.guest_name ? wish.guest_name + ', ' : '';
  const dates   = wish.check_in && wish.check_out
    ? `${wish.check_in} → ${wish.check_out}`
    : 'your saved dates';
  const nights  = wish.nights || '';
  const cur     = wish.currency || 'KES';

  switch (trigger.type) {
    case 'low_inventory':
      return {
        subject: `Only ${trigger.rooms} room${trigger.rooms !== 1 ? 's' : ''} left at ${propertyName}`,
        body: `${name}just a heads-up — there ${trigger.rooms === 1 ? 'is only 1 room' : `are only ${trigger.rooms} rooms`} left at ${propertyName} for ${dates}. Availability is filling up fast.`,
        cta: 'Reserve Your Room',
      };

    case 'price_drop':
      return {
        subject: `Price dropped at ${propertyName} — save ${cur} ${trigger.saving.toLocaleString()}/night`,
        body: `${name}good news — the rate at ${propertyName} for ${dates} just dropped from ${cur} ${Math.round(trigger.oldPrice).toLocaleString()} to ${cur} ${Math.round(trigger.newPrice).toLocaleString()} per night. That's ${trigger.dropPct}% off what you saw last time.`,
        cta: 'Lock In This Rate',
      };

    case 'approaching':
      return {
        subject: `Your ${propertyName} stay is ${trigger.daysUntil} day${trigger.daysUntil !== 1 ? 's' : ''} away`,
        body: `${name}your saved stay at ${propertyName} for ${dates}${nights ? ` (${nights} nights)` : ''} is coming up soon. Rooms are still available — want to confirm your booking?`,
        cta: 'Complete Your Booking',
      };

    case 'promo': {
      const p = trigger.promo;
      return {
        subject: `${p.title} — ${propertyName}`,
        body: `${name}${p.message}${p.discount_pct ? ` Save ${p.discount_pct}% on your stay.` : ''}${p.promo_code ? ` Use code: ${p.promo_code}.` : ''}`,
        cta: 'View Offer',
      };
    }

    default:
      return null;
  }
}

// ── Main run function ─────────────────────────────────────────
async function run() {
  logger.info('[HOTEL NUDGE] Scheduler run started');

  try {
    // Load active wishes with email, not yet booked, under max nudges
    const { data: wishes, error } = await supabase
      .from('hotel_wishes')
      .select('*, hotel_properties(name, slug), hotel_groups(name, slug)')
      .eq('status', 'active')
      .not('guest_email', 'is', null)
      .lt('nudge_count', MAX_NUDGES)
      .or(`last_nudge_at.is.null,last_nudge_at.lt.${new Date(Date.now() - MIN_NUDGE_INTERVAL_HOURS * 3600000).toISOString()}`);

    if (error) throw error;
    if (!wishes?.length) {
      logger.info('[HOTEL NUDGE] No eligible wishes');
      return;
    }

    logger.info(`[HOTEL NUDGE] Checking ${wishes.length} wishes`);
    let sent = 0;

    for (const wish of wishes) {
      try {
        const propertyName = wish.hotel_properties?.name || 'your hotel';
        const groupSlug    = wish.hotel_groups?.slug || wish.group_id;

        // Check triggers in priority order
        const trigger =
          await _checkInventory(wish) ||
          await _checkRateDrop(wish) ||
          await _checkPromos(wish) ||
          await _checkApproaching(wish);

        if (!trigger) continue;

        const msg = _buildMessage(wish, trigger, propertyName);
        if (!msg) continue;

        // Build CTA URL — points back to hotel widget
        const apiBase = process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com';
        const ctaUrl  = `${apiBase}/hotel/${groupSlug}`;

        const html = _emailHtml(propertyName, msg.body, msg.cta, ctaUrl);
        const ok   = await _sendEmail(wish.guest_email, msg.subject, html);

        if (ok) {
          await supabase.from('hotel_nudge_log').insert({
            wish_id:    wish.id,
            group_id:   wish.group_id,
            nudge_type: trigger.type,
            message:    msg.body,
            sent_to:    wish.guest_email,
            sent_via:   'email',
          });

          // Update wish
          await supabase.from('hotel_wishes').update({
            last_nudge_at: new Date().toISOString(),
            nudge_count:   (wish.nudge_count || 0) + 1,
            pending_nudge: msg.body,
          }).eq('id', wish.id);

          sent++;
          logger.info('[HOTEL NUDGE] Sent', {
            wishId: wish.id,
            type:   trigger.type,
            to:     wish.guest_email,
            property: propertyName,
          });
        }

        // Small delay between sends
        await new Promise(r => setTimeout(r, 200));

      } catch (err) {
        logger.warn('[HOTEL NUDGE] Wish check failed', { wishId: wish.id, error: err.message });
      }
    }

    logger.info(`[HOTEL NUDGE] Run complete — ${sent} nudges sent`);

  } catch (err) {
    logger.error('[HOTEL NUDGE] Scheduler error', { error: err.message });
  }
}

function start() {
  // Run immediately on start, then every 2 hours
  run().catch(err => logger.error('[HOTEL NUDGE] Initial run failed', { error: err.message }));
  setInterval(() => {
    run().catch(err => logger.error('[HOTEL NUDGE] Scheduled run failed', { error: err.message }));
  }, 2 * 60 * 60 * 1000);
  logger.info('[HOTEL NUDGE] Scheduler started — runs every 2 hours');
}

module.exports = { start, run };