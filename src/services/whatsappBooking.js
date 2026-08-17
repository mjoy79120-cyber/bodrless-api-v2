/**
 * WHATSAPP BOOKING FLOW
 * ─────────────────────────────────────────────────────────────
 * Passenger detail collection — one compact block per traveler,
 * contact details asked once at the end.
 *
 * REDESIGNED (2026-08-17):
 * Previous version used a free-text block where Gender and Type
 * were either typed (typo-prone) or collected via a separate
 * WhatsApp list tap per passenger (extra round trips while the
 * flight hold clock ticks). New version puts everything into one
 * short block per passenger, with very lenient field parsers so
 * "m", "male", "M" all resolve correctly.
 *
 * BLOCK FORMAT (per passenger, blank line between blocks):
 *   Name: John Doe
 *   DOB: 21 May 1990          ← any format accepted
 *   Gender: Male              ← m / f / male / female
 *   Type: Adult               ← adult / child / a / c / kid
 *   Seat: Window              ← optional; window/aisle/exit row/any/skip
 *
 * CONTACT DETAILS (once, after all passenger blocks):
 *   Phone: 0712345678
 *   Email: john@example.com
 *
 * CHILD AGE CROSS-CHECK:
 * Child status is confirmed against DOB + travel date from the
 * package snapshot. If the DOB puts the traveler at 18+ on the
 * travel date, we reject "Type: Child" — they can't get a child
 * fare. If DOB says under 18 but Type says Adult, we flag it and
 * ask the user to confirm (parent may be enrolling an older teen
 * as adult intentionally). Infants (under 2) are flagged
 * separately since some suppliers handle them differently.
 *
 * MID-BOOKING PIVOT (carried over from previous version):
 * Detects "actually, can I get a different flight" style messages
 * before step handlers run, cancels session, re-shows cached
 * package list.
 *
 * WELCOME-BACK RESUME (carried over):
 * 20-minute gap triggers a short "welcome back" note before
 * continuing normal step handling.
 *
 * MIGRATION REQUIRED (same as before):
 *   alter table whatsapp_booking_sessions
 *     add column if not exists last_activity_at timestamptz;
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const bookingService = require('./bookingService');
const whatsappService = require('./whatsapp');
const packageCache = require('./packageCache');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// PROMPT TEMPLATE
// ─────────────────────────────────────────────
const FORMAT_TEMPLATE =
`⚠️ *Important:* Please make sure the name on your booking matches the name on your passport or ID exactly.

Send your traveler details like this:

Name: John Doe
DOB: 21 May 1990
Gender: Male
Type: Adult
Seat: Window

*Seat is optional* — leave it out, or write: window / aisle / exit row / any
*Type* is Adult or Child

If booking for more than one traveler, add each person as a separate block with a blank line between them.

Reply *cancel* at any time to stop.`;

const CONTACT_TEMPLATE =
`Almost there! Last step — reply with the best phone number and email to reach you on:

Phone: 0712345678
Email: john@example.com`;

// ─────────────────────────────────────────────
// MID-BOOKING PIVOT DETECTION
// ─────────────────────────────────────────────
const WANTS_SOMETHING_DIFFERENT = /\b(actually|change (my|the)?\s*(flight|hotel|option|mind)|different (flight|hotel|option)|start over|restart|pick (a )?different|go back|never ?mind|not this one|wait,? (actually|i)|can i (get|have) a different)\b/i;

const PASSENGER_DETAIL_LINE_LOCAL = /^(name|dob|date of birth|gender|type|seat)\s*:/im;

const RESUME_GAP_MS = 20 * 60 * 1000; // 20 minutes

// ─────────────────────────────────────────────
// FIELD PARSERS — all very lenient
// ─────────────────────────────────────────────

/**
 * Parse gender from a loose string.
 * Accepts: male/female, m/f, M/F, man/woman, boy/girl
 * Returns: 'male' | 'female' | null
 */
function _parseGender(raw) {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (/^(male|man|boy|m)$/.test(t)) return 'male';
  if (/^(female|woman|girl|f)$/.test(t)) return 'female';
  if (t.startsWith('m') && !t.startsWith('mi') && t.length <= 4) return 'male';
  if (t.startsWith('f') && t.length <= 6) return 'female';
  return null;
}

/**
 * Parse traveler type from a loose string.
 * Accepts: adult/child/kid/minor, a/c
 * Returns: 'adult' | 'child' | null
 */
function _parseType(raw) {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (/^(adult|grown|a)$/.test(t)) return 'adult';
  if (/^(child|kid|minor|infant|baby|c)$/.test(t)) return 'child';
  return null;
}

/**
 * Parse seat preference from a loose string.
 * Returns: 'window' | 'aisle' | 'exit_row' | null
 */
function _parseSeat(raw) {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (!t || /^(skip|none|no|any|n\/a|na|-)$/.test(t)) return null;
  if (/\bwindow\b|win/.test(t)) return 'window';
  if (/\baisle\b|isle/.test(t)) return 'aisle';
  if (/\bexit\b/.test(t)) return 'exit_row';
  return null;
}

/**
 * Parse a flexible date into YYYY-MM-DD.
 * Accepts natural language, DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD.
 * Day-first is assumed for ambiguous numeric dates (Kenyan market).
 * Returns null if nothing parseable.
 */
function _parseFlexibleDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return _isValidCalendarDate(text) ? text : null;
  }

  const MONTHS = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  };
  const monthNamePattern = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
  const monthMatch = text.match(monthNamePattern);
  if (monthMatch) {
    const monthNum = MONTHS[monthMatch[1].slice(0, 3).toLowerCase()];
    const numbers = text.match(/\d{1,4}/g) || [];
    const yearCandidate = numbers.find(n => n.length === 4);
    const dayCandidate  = numbers.find(n => n !== yearCandidate && Number(n) >= 1 && Number(n) <= 31);
    if (monthNum && yearCandidate && dayCandidate) {
      const dateStr = `${yearCandidate}-${monthNum}-${String(dayCandidate).padStart(2, '0')}`;
      return _isValidCalendarDate(dateStr) ? dateStr : null;
    }
    return null;
  }

  const numericMatch = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (numericMatch) {
    let [, a, b, year] = numericMatch;
    a = Number(a); b = Number(b);
    let day, month;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { day = b; month = a; }
    else { day = a; month = b; } // default day-first
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return _isValidCalendarDate(dateStr) ? dateStr : null;
  }

  return null;
}

function _isValidCalendarDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const [y, m, day] = dateStr.split('-').map(Number);
  return (
    d.getUTCFullYear() === y &&
    d.getUTCMonth() + 1 === m &&
    d.getUTCDate() === day &&
    y >= 1900 &&
    y <= new Date().getFullYear()
  );
}

/**
 * Calculate age in years at a given reference date.
 */
function _ageAt(dobStr, referenceDate) {
  const dob = new Date(dobStr + 'T00:00:00Z');
  const ref = new Date(referenceDate + 'T00:00:00Z');
  let age = ref.getUTCFullYear() - dob.getUTCFullYear();
  const m = ref.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && ref.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

// ─────────────────────────────────────────────
// MAIN CLASS
// ─────────────────────────────────────────────
class WhatsAppBookingFlow {

  async startBooking({ phoneNumberId, from, agencyId, selectedPackage }) {
    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);

    await supabase.from('whatsapp_booking_sessions').insert({
      phone: from,
      agency_id: agencyId,
      package_snapshot: selectedPackage,
      passenger_count: selectedPackage.summary?.passengers || 1,
      current_step: 'awaiting_details_message',
      passengers_collected: [],
      last_activity_at: new Date().toISOString(),
    });

    const passengerCount = selectedPackage.summary?.passengers || 1;
    const countNote = passengerCount > 1
      ? `\nThis booking is for *${passengerCount} travelers* — please include ${passengerCount} blocks.\n`
      : '';

    await whatsappService.sendText(phoneNumberId, from,
      `Great choice!${countNote}\n\n${FORMAT_TEMPLATE}`
    );
  }

  async hasActiveSession(from) {
    const { data: session } = await supabase
      .from('whatsapp_booking_sessions')
      .select('phone')
      .eq('phone', from)
      .maybeSingle();
    return !!session;
  }

  async clearSession(from) {
    try {
      await supabase
        .from('whatsapp_booking_sessions')
        .delete()
        .eq('phone', from);
    } catch (err) {
      logger.warn('clearSession: failed to delete session', { from, error: err.message });
    }
  }

  async handleMessage({ phoneNumberId, from, text, interactive = null }) {
    const { data: session } = await supabase
      .from('whatsapp_booking_sessions')
      .select('*')
      .eq('phone', from)
      .maybeSingle();

    if (!session) return false;

    if (text && /^cancel$/i.test(text.trim())) {
      await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);
      await whatsappService.sendText(phoneNumberId, from,
        'Booking cancelled. Let me know if you would like to search again.'
      );
      return true;
    }

    // ── WELCOME-BACK RESUME ────────────────────────────────
    const lastActivityMs = session.last_activity_at
      ? new Date(session.last_activity_at).getTime()
      : null;
    if (lastActivityMs && (Date.now() - lastActivityMs) > RESUME_GAP_MS) {
      await whatsappService.sendText(phoneNumberId, from,
        'Welcome back! Picking up your booking where we left off...'
      );
    }
    await this._touchActivity(from);

    // ── MID-BOOKING PIVOT ──────────────────────────────────
    if (
      text &&
      WANTS_SOMETHING_DIFFERENT.test(text.trim()) &&
      !this._looksLikeExpectedAnswer(text, session)
    ) {
      return this._handlePivotAway({ phoneNumberId, from });
    }

    if (session.current_step === 'awaiting_details_message') {
      if (!text) return false;
      return this._handleDetailsMessage({ phoneNumberId, from, text, session });
    }

    if (session.current_step === 'awaiting_contact_details') {
      if (!text) return false;
      return this._handleContactDetails({ phoneNumberId, from, text, session });
    }

    if (session.current_step === 'awaiting_price_approval') {
      if (!text) return false;
      return this._handlePriceApproval({ phoneNumberId, from, text, session });
    }

    return false;
  }

  // ─────────────────────────────────────────────
  // Does this message look like a genuine answer to the current step?
  // ─────────────────────────────────────────────
  _looksLikeExpectedAnswer(text, session) {
    const t = text.trim();
    if (session.current_step === 'awaiting_price_approval') {
      return /^(yes|yeah|y|ok|okay|approve|confirmed?|sure|proceed|go ahead|no|nope|n|decline|reject|don'?t)$/i.test(t);
    }
    if (session.current_step === 'awaiting_details_message') {
      return PASSENGER_DETAIL_LINE_LOCAL.test(t);
    }
    if (session.current_step === 'awaiting_contact_details') {
      return /^(phone|email)\s*:/im.test(t);
    }
    return false;
  }

  // ─────────────────────────────────────────────
  // MID-BOOKING PIVOT
  // ─────────────────────────────────────────────
  async _handlePivotAway({ phoneNumberId, from }) {
    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);

    const cached = await packageCache.get(from);
    if (cached && cached.packages?.length > 0) {
      await whatsappService.sendText(phoneNumberId, from,
        'No problem — here are your saved options again:'
      );
      await whatsappService.sendPackages(phoneNumberId, from, cached.packages);
      await whatsappService.sendText(phoneNumberId, from,
        `Reply with the option number (1-${cached.packages.length}) to book a different one, or search again for something new.`
      );
    } else {
      await whatsappService.sendText(phoneNumberId, from,
        "No problem — that booking's been cancelled. Go ahead and search again whenever you're ready."
      );
    }
    return true;
  }

  async _touchActivity(phone) {
    try {
      await supabase
        .from('whatsapp_booking_sessions')
        .update({ last_activity_at: new Date().toISOString() })
        .eq('phone', phone);
    } catch (err) {
      logger.warn('Could not update last_activity_at', { phone, error: err.message });
    }
  }

  // ─────────────────────────────────────────────
  // PARSE PASSENGER BLOCKS
  // ─────────────────────────────────────────────
  _parseDetailsMessage(text, expectedCount, travelDate) {
    const blocks = text
      .split(/\n\s*\n/)
      .map(b => b.trim())
      .filter(Boolean);

    if (blocks.length === 0) {
      return {
        error: "I couldn't read any traveler details in that message. Please use the format shown above.",
      };
    }

    const passengers = [];
    const warnings   = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const fields = {};

      block.split('\n').forEach(line => {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) {
          const key   = match[1].trim().toLowerCase();
          const value = match[2].trim();
          fields[key] = value;
        }
      });

      // ── Name ──────────────────────────────────────────────
      const name = fields['name'];
      if (!name) {
        return {
          error: `Traveler ${i + 1} is missing a Name. Please check the format and try again.`,
        };
      }
      const nameParts = name.trim().split(/\s+/);
      const firstName = nameParts[0];
      const lastName  = nameParts.slice(1).join(' ') || nameParts[0];

      // ── DOB ───────────────────────────────────────────────
      const rawDob = fields['dob'] || fields['date of birth'];
      const parsedDob = _parseFlexibleDate(rawDob);
      if (!parsedDob) {
        return {
          error: `I couldn't read Traveler ${i + 1}'s date of birth (${name}). Try something like "21 May 1990", "21/05/1990", or "1990-05-21".`,
        };
      }

      // ── Gender ────────────────────────────────────────────
      const gender = _parseGender(fields['gender'] || fields['sex']);
      if (!gender) {
        return {
          error: `I couldn't read the gender for ${name}. Please use Male or Female (or M/F).`,
        };
      }

      // ── Type ──────────────────────────────────────────────
      const type = _parseType(fields['type'] || fields['traveler type'] || fields['traveller type']);
      if (!type) {
        return {
          error: `I couldn't read the traveler type for ${name}. Please use Adult or Child.`,
        };
      }

      // ── Seat (optional) ───────────────────────────────────
      const seatPreference = _parseSeat(
        fields['seat'] || fields['seat preference'] || fields['seat pref'] || null
      );

      // ── Child age cross-check ──────────────────────────────
      // Reference date: travel date from package snapshot, or today
      const refDate = travelDate || new Date().toISOString().split('T')[0];
      const ageAtTravel = _ageAt(parsedDob, refDate);

      if (type === 'child' && ageAtTravel >= 18) {
        return {
          error: `${name}'s date of birth (${parsedDob}) shows they'll be ${ageAtTravel} years old at travel — that's an adult fare. Please correct their Type to *Adult*, or check the date of birth.`,
        };
      }

      if (type === 'adult' && ageAtTravel < 18) {
        // Warn but don't hard-block — parent may be intentionally
        // booking a 16/17 year old as adult (some suppliers allow it)
        warnings.push(
          `Note: ${name} will be ${ageAtTravel} years old at travel but is booked as an Adult. If this is correct, ignore this — otherwise update their Type to Child.`
        );
      }

      if (ageAtTravel < 2) {
        warnings.push(
          `Note: ${name} will be under 2 years old at travel (infant). Some suppliers handle infant fares separately — our team will confirm this with you.`
        );
      }

      passengers.push({
        firstName,
        lastName,
        dateOfBirth: parsedDob,
        gender,
        type,
        seatPreference,
        ageAtTravel,
      });
    }

    if (expectedCount && passengers.length !== expectedCount) {
      return {
        error: `This booking is for ${expectedCount} traveler(s), but I found ${passengers.length} block(s). Please include exactly ${expectedCount} traveler block(s), separated by a blank line.`,
      };
    }

    return { passengers, warnings };
  }

  // ─────────────────────────────────────────────
  // STEP 1: PASSENGER DETAILS BLOCK
  // ─────────────────────────────────────────────
  async _handleDetailsMessage({ phoneNumberId, from, text, session }) {
    const expectedCount = session.passenger_count || 1;
    const pkg = session.package_snapshot;

    // Travel date from package snapshot for child age cross-check
    const travelDate = pkg?.transport?.departureDate
      || pkg?.summary?.departureDate
      || null;

    const parsed = this._parseDetailsMessage(text, expectedCount, travelDate);

    if (parsed.error) {
      await whatsappService.sendText(phoneNumberId, from,
        `${parsed.error}\n\nPlease resend your details using the format shown earlier.`
      );
      return true;
    }

    // Send any age-related warnings before continuing
    if (parsed.warnings?.length > 0) {
      for (const warning of parsed.warnings) {
        await whatsappService.sendText(phoneNumberId, from, `⚠️ ${warning}`);
      }
    }

    // Save passengers, move to contact details step
    await supabase
      .from('whatsapp_booking_sessions')
      .update({
        current_step: 'awaiting_contact_details',
        passengers_collected: parsed.passengers,
      })
      .eq('phone', from);

    await whatsappService.sendText(phoneNumberId, from,
      `✅ Got details for ${parsed.passengers.length === 1 ? '1 traveler' : `${parsed.passengers.length} travelers`}.\n\n${CONTACT_TEMPLATE}`
    );
    return true;
  }

  // ─────────────────────────────────────────────
  // STEP 2: CONTACT DETAILS
  // ─────────────────────────────────────────────
  async _handleContactDetails({ phoneNumberId, from, text, session }) {
    const fields = {};
    text.split('\n').forEach(line => {
      const match = line.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        fields[match[1].trim().toLowerCase()] = match[2].trim();
      }
    });

    const guestPhone = fields['phone'] || fields['tel'] || fields['mobile'] || null;
    const guestEmail = fields['email'] || fields['e-mail'] || null;

    if (!guestPhone) {
      await whatsappService.sendText(phoneNumberId, from,
        `Please include a Phone number.\n\n${CONTACT_TEMPLATE}`
      );
      return true;
    }

    const pkg = session.package_snapshot;
    const needsEmail = !!(pkg?.transport && (pkg.transport.transportType || 'flight') === 'flight');
    if (needsEmail && !guestEmail) {
      await whatsappService.sendText(phoneNumberId, from,
        `An Email address is required for flight bookings. Please resend including an Email line.\n\n${CONTACT_TEMPLATE}`
      );
      return true;
    }

    await supabase
      .from('whatsapp_booking_sessions')
      .update({ guest_phone: guestPhone, guest_email: guestEmail || null })
      .eq('phone', from);

    await this._finalizeBooking({
      phoneNumberId,
      from,
      session: {
        ...session,
        guest_phone: guestPhone,
        guest_email: guestEmail || null,
      },
    });
    return true;
  }

  // ─────────────────────────────────────────────
  // FINALIZE BOOKING
  // ─────────────────────────────────────────────
  async _finalizeBooking({ phoneNumberId, from, session }) {
    await whatsappService.sendText(phoneNumberId, from,
      'Got it! Holding your flight and confirming your hotel now — one moment...'
    );

    const bookingRef = `BDR-${Date.now()}`;
    const passengers = session.passengers_collected || [];
    const guestName  = `${passengers[0]?.firstName || ''} ${passengers[0]?.lastName || ''}`.trim();

    const result = await bookingService.initBooking({
      bookingRef,
      agencyId:         session.agency_id,
      pkg:              session.package_snapshot,
      passengerDetails: passengers,
      guestName,
      guestPhone:       session.guest_phone,
      guestEmail:       session.guest_email,
      channel:          'whatsapp',
    });

    const parsed = {
      guestPhone: session.guest_phone,
      guestEmail: session.guest_email,
      passengers,
    };

    if (!result.success && result.code === 'PRICE_CHANGED') {
      const oldFmt = `${result.currency} ${Number(result.oldPrice).toLocaleString()}`;
      const newFmt = `${result.currency} ${Number(result.newPrice).toLocaleString()}`;
      const flightNote = result.flightHeld
        ? '\n\nYour flight hold is not yet charged — it will expire automatically if you cancel.'
        : '';

      await supabase
        .from('whatsapp_booking_sessions')
        .update({
          current_step: 'awaiting_price_approval',
          price_approval_ctx: {
            bookingRef,
            guestName,
            guestPhone:       session.guest_phone,
            guestEmail:       session.guest_email,
            passengerDetails: passengers,
            oldPrice:         result.oldPrice,
            newPrice:         result.newPrice,
            currency:         result.currency,
            flightHeld:       result.flightHeld || false,
          },
        })
        .eq('phone', from);

      await whatsappService.sendText(phoneNumberId, from,
        `The hotel price changed once the traveler's real date of birth was applied:\n\n` +
        `Old price: ~${oldFmt}~\n` +
        `New price: *${newFmt}*` +
        flightNote +
        `\n\nReply *yes* to approve the new price and continue, or *no* to cancel.`
      );
      return;
    }

    if (!result.success) {
      await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);
      await whatsappService.sendText(phoneNumberId, from,
        `We hit a snag: ${result.error}\n\nNo payment has been taken. Feel free to search again.`
      );
      return;
    }

    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);

    // Seat selection notes
    if (result.seatSelection?.unresolved?.length > 0) {
      const notes = result.seatSelection.unresolved
        .filter(u => u.reason !== 'no preference stated')
        .map(u => `• ${u.reason}`);
      if (notes.length > 0) {
        await whatsappService.sendText(phoneNumberId, from,
          `Note on seat preferences:\n${notes.join('\n')}\n\nYour booking is proceeding without those specific seats — you can still request one at check-in.`
        );
      }
    }
    if (result.seatSelection?.resolved?.length > 0) {
      const seatLines = result.seatSelection.resolved.map(s =>
        `Seat ${s.designator} (${s.positionType}${s.isExitRow ? ', exit row' : ''}) — ${s.currency} ${s.price}`
      );
      await whatsappService.sendText(phoneNumberId, from,
        `Seat${result.seatSelection.resolved.length > 1 ? 's' : ''} confirmed:\n${seatLines.join('\n')}`
      );
    }

    await this._proceedToPayment({ phoneNumberId, from, result, parsed });
  }

  // ─────────────────────────────────────────────
  // PRICE APPROVAL (after PRICE_CHANGED)
  // ─────────────────────────────────────────────
  async _handlePriceApproval({ phoneNumberId, from, text, session }) {
    const answer = text.trim().toLowerCase();
    const ctx    = session.price_approval_ctx || {};

    const isYes = /^(yes|yeah|y|ok|okay|approve|confirmed?|sure|proceed|go ahead)$/i.test(answer);
    const isNo  = /^(no|nope|n|cancel|stop|decline|reject|don'?t)$/i.test(answer);

    if (!isYes && !isNo) {
      await whatsappService.sendText(phoneNumberId, from,
        `Please reply *yes* to approve the new price of *${ctx.currency} ${Number(ctx.newPrice).toLocaleString()}*, or *no* to cancel.`
      );
      return true;
    }

    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);

    if (isNo) {
      const flightNote = ctx.flightHeld
        ? ' Your flight hold will expire automatically — no charge has been made.'
        : '';
      await whatsappService.sendText(phoneNumberId, from,
        `Booking cancelled.${flightNote} Feel free to search again if you would like different options.`
      );
      return true;
    }

    await whatsappService.sendText(phoneNumberId, from,
      'Great — processing your booking at the new price now...'
    );

    const result = await bookingService.initBooking({
      bookingRef:       ctx.bookingRef,
      agencyId:         session.agency_id,
      pkg:              session.package_snapshot,
      passengerDetails: ctx.passengerDetails,
      guestName:        ctx.guestName,
      guestPhone:       ctx.guestPhone,
      guestEmail:       ctx.guestEmail,
      channel:          'whatsapp',
      priceApproved:    true,
    });

    if (!result.success) {
      await whatsappService.sendText(phoneNumberId, from,
        `Something went wrong at the new price: ${result.error}\n\nNo payment has been taken. Please search again.`
      );
      return true;
    }

    await this._proceedToPayment({
      phoneNumberId,
      from,
      result,
      parsed: {
        guestPhone: ctx.guestPhone,
        guestEmail: ctx.guestEmail,
        passengers: ctx.passengerDetails,
      },
    });
    return true;
  }

  // ─────────────────────────────────────────────
  // PROCEED TO PAYMENT
  // ─────────────────────────────────────────────
  async _proceedToPayment({ phoneNumberId, from, result, parsed }) {
    await whatsappService.sendText(phoneNumberId, from,
      `Flight held and hotel confirmed!\n\n` +
      `*Booking ref:* ${result.bookingRef}\n` +
      `*Total due:* ${result.currency} ${result.totalPrice.toLocaleString()}\n\n` +
      `Sending an M-Pesa payment prompt to ${parsed.guestPhone} now...`
    );

    const paymentResult = await bookingService.triggerPayment({
      bookingRef: result.bookingRef,
      phone:      parsed.guestPhone,
      amount:     result.totalPrice,
      currency:   result.currency,
      email:      parsed.guestEmail,
      firstName:  parsed.passengers[0].firstName,
      lastName:   parsed.passengers[0].lastName,
    });

    if (!paymentResult.success) {
      await whatsappService.sendText(phoneNumberId, from,
        `Your flight and hotel are held, but we couldn't send the payment prompt (${paymentResult.error}). Please contact support with booking ref ${result.bookingRef}.`
      );
      logger.error('WhatsApp payment trigger failed after successful booking init', {
        bookingRef: result.bookingRef, error: paymentResult.error,
      });
      return;
    }

    await whatsappService.sendText(phoneNumberId, from,
      `Check your phone and enter your *M-Pesa PIN* to complete payment.\n\nThis booking will be held for 30 minutes. We'll message you once payment is confirmed.`
    );

    logger.info('WhatsApp booking init + payment trigger complete', {
      bookingRef: result.bookingRef, from,
    });
  }
}

module.exports = new WhatsAppBookingFlow();