/**
 * WHATSAPP BOOKING FLOW
 * ─────────────────────────────────────────────────────────────
 * Passenger detail collection for WhatsApp — a short free-text
 * block for open-ended fields, plus ONE TAP per passenger for
 * Gender + Traveler type (combined into a single WhatsApp list
 * message, not two separate button rounds), rather than everything
 * crammed into one long typed block.
 *
 * REDESIGNED (2026-07-03) from an earlier all-in-one-block version:
 * Gender and Adult/Child used to be typed fields in the block
 * (real failure modes we hit in testing: exact "Male"/"Female"
 * spelling required, DOB format strictness, easy to get wrong with
 * no clear per-field error). Moving these two to a tap removes that
 * whole class of typo, and shortens the block itself.
 *
 * FREE-TEXT BLOCK now covers only (per passenger, blank line between
 * blocks):
 *   Name: John Doe
 *   ID/Passport No: A12345678   (optional — leave blank if none yet)
 *   DOB: 1990-05-21
 *   Seat preference: window     (optional, Duffel flights only)
 *
 * Phone/Email are asked once, for the first traveler only (contact
 * details for the whole booking).
 *
 * After the block is accepted, Gender + Traveler type are collected
 * ONE PASSENGER AT A TIME via a WhatsApp list message (see
 * _askGenderType/_handleGenderTypeReply) — a single tap picks one of:
 * Male Adult / Female Adult / Male Child / Female Child. A typed
 * fallback ("male adult", "female child", etc.) is also accepted in
 * case the traveler types instead of tapping.
 *
 * State (including the in-progress passenger list before Gender/Type
 * is fully collected) lives in whatsapp_booking_sessions so the
 * conversation survives across separate webhook calls.
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const bookingService = require('./bookingService');
const whatsappService = require('./whatsapp');
const { logger } = require('../utils/logger');

const FORMAT_TEMPLATE =
`Please reply with *traveler details in one message*, like this:

Name: John Doe
ID/Passport No: A12345678
DOB: 21 May 1990
Seat preference: window

If booking for more than one traveler, add each person as a separate block, with a blank line between them. Only the first traveler needs to include Phone and Email — add those to their block too:

Phone: 0712345678
Email: john@example.com

ID/Passport No can be left blank if not available yet. "Seat preference" is optional — leave it out, or write window / aisle / exit row (only available on some flights, may cost extra).

I'll ask for each traveler's gender and whether they're an adult or child with a quick tap right after this.

Reply *cancel* at any time to stop.`;

const GENDER_TYPE_OPTIONS = [
  { id: 'gt_male_adult',   title: 'Male, Adult' },
  { id: 'gt_female_adult', title: 'Female, Adult' },
  { id: 'gt_male_child',   title: 'Male, Child' },
  { id: 'gt_female_child', title: 'Female, Child' },
];

class WhatsAppBookingFlow {

  // ─────────────────────────────────────────────
  // PARSE A FLEXIBLE DATE INTO YYYY-MM-DD
  // No WhatsApp date-picker exists outside the heavier WhatsApp
  // Flows integration (not in scope) — the real fix for DOB being
  // error-prone is a far more forgiving parser, not more taps.
  // Accepts, in order tried:
  //   - YYYY-MM-DD (already-correct format, always tried first)
  //   - DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (day-first, the
  //     Kenyan/Commonwealth convention — assumed default for any
  //     ambiguous numeric date, since that's this platform's
  //     primary market)
  //   - MM/DD/YYYY only recognized when the first number is >12
  //     (the only case that unambiguously CAN'T be day-first)
  //   - Natural language with a month name: "21 May 1990",
  //     "May 21 1990", "21st May 1990", "21 May, 1990"
  // Returns null if nothing matches — caller keeps the existing
  // clear per-traveler error message in that case, so an
  // unparseable date is never silently guessed at.
  // ─────────────────────────────────────────────
  _parseFlexibleDate(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    // Already correct.
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return this._isValidCalendarDate(text) ? text : null;
    }

    // Natural language with a month name, e.g. "21 May 1990",
    // "May 21, 1990", "21st May 1990".
    const MONTHS = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const monthNamePattern = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    const monthMatch = text.match(monthNamePattern);
    if (monthMatch) {
      const monthNum = MONTHS[monthMatch[1].slice(0, 3).toLowerCase()];
      const numbers = text.match(/\d{1,4}/g) || [];
      // One of the numbers is the day (1-31), another is the year
      // (4 digits, or 2 digits assumed 1900s/2000s based on
      // plausibility for a real traveler's birth date).
      const yearCandidate = numbers.find(n => n.length === 4);
      const dayCandidate  = numbers.find(n => n !== yearCandidate && Number(n) >= 1 && Number(n) <= 31);
      if (monthNum && yearCandidate && dayCandidate) {
        const dateStr = `${yearCandidate}-${monthNum}-${String(dayCandidate).padStart(2, '0')}`;
        return this._isValidCalendarDate(dateStr) ? dateStr : null;
      }
      return null;
    }

    // Numeric with separators: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY —
    // or MM/DD/YYYY only when the first number can't possibly be a
    // day (i.e. > 12, and second number <= 12).
    const numericMatch = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (numericMatch) {
      let [, a, b, year] = numericMatch;
      a = Number(a); b = Number(b);
      let day, month;
      if (a > 12 && b <= 12) {
        // Unambiguous: a can't be a month, must be MM/DD/YYYY... wait,
        // a > 12 means a is the day in a DD/MM layout already — this
        // branch actually confirms DD/MM/YYYY (a=day, b=month).
        day = a; month = b;
      } else if (b > 12 && a <= 12) {
        // The reverse case genuinely is MM/DD/YYYY (US-style) — only
        // reachable if a <= 12 and b > 12.
        day = b; month = a;
      } else {
        // Both <= 12, genuinely ambiguous — default to day-first
        // (Kenyan/Commonwealth convention, this platform's market).
        day = a; month = b;
      }
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return this._isValidCalendarDate(dateStr) ? dateStr : null;
    }

    return null;
  }

  // Rejects real nonsense (Feb 30th, month 13, etc.) that would
  // otherwise silently pass the regex-level checks above.
  _isValidCalendarDate(dateStr) {
    const d = new Date(dateStr + 'T00:00:00Z');
    if (isNaN(d.getTime())) return false;
    const [y, m, day] = dateStr.split('-').map(Number);
    return d.getUTCFullYear() === y && d.getUTCMonth() + 1 === m && d.getUTCDate() === day
      && y >= 1900 && y <= new Date().getFullYear();
  }

  async startBooking({ phoneNumberId, from, agencyId, selectedPackage }) {
    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);

    await supabase.from('whatsapp_booking_sessions').insert({
      phone: from,
      agency_id: agencyId,
      package_snapshot: selectedPackage,
      passenger_count: selectedPackage.summary?.passengers || 1,
      current_step: 'awaiting_details_message',
      passengers_collected: [],
    });

    const passengerCount = selectedPackage.summary?.passengers || 1;
    const countNote = passengerCount > 1
      ? `\nThis booking is for *${passengerCount} travelers* — please include ${passengerCount} blocks.\n`
      : '';

    await whatsappService.sendText(phoneNumberId, from, `Great choice! ${countNote}\n${FORMAT_TEMPLATE}`);
  }

  async hasActiveSession(from) {
    const { data: session } = await supabase
      .from('whatsapp_booking_sessions')
      .select('phone')
      .eq('phone', from)
      .maybeSingle();
    return !!session;
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
      await whatsappService.sendText(phoneNumberId, from, 'Booking cancelled. Let me know if you would like to search again.');
      return true;
    }

    if (session.current_step === 'awaiting_details_message') {
      if (!text) return false;
      return this._handleDetailsMessage({ phoneNumberId, from, text, session });
    }

    if (session.current_step === 'awaiting_gender_type') {
      return this._handleGenderTypeReply({ phoneNumberId, from, text, interactive, session });
    }

    if (session.current_step === 'awaiting_price_approval') {
      if (!text) return false;
      return this._handlePriceApproval({ phoneNumberId, from, text, session });
    }

    return false;
  }

  _parseDetailsMessage(text, expectedCount) {
    const blocks = text
      .split(/\n\s*\n/)
      .map(b => b.trim())
      .filter(Boolean);

    if (blocks.length === 0) {
      return { error: "I couldn't read any traveler details in that message. Please use the format shown above." };
    }

    const passengers = [];
    let guestPhone = null;
    let guestEmail = null;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const fields = {};

      block.split('\n').forEach(line => {
        const match = line.match(/^([^:]+):\s*(.+)$/);
        if (match) {
          const key = match[1].trim().toLowerCase();
          const value = match[2].trim();
          fields[key] = value;
        }
      });

      const name  = fields['name'];
      const idNum = fields['id/passport no'] || fields['id'] || fields['passport'] || fields['id/passport'] || null;
      const phone = fields['phone'];
      const email = fields['email'];
      const dob   = fields['dob'] || fields['date of birth'];
      const seatPreference = fields['seat preference'] || fields['seat'] || null;

      if (!name) {
        return { error: `Traveler ${i + 1} is missing a Name. Please check the format and try again.` };
      }
      const nameParts = name.trim().split(/\s+/);
      const firstName = nameParts[0];
      const lastName  = nameParts.slice(1).join(' ') || nameParts[0];

      const parsedDob = this._parseFlexibleDate(dob);
      if (!parsedDob) {
        return { error: `I couldn't read Traveler ${i + 1}'s date of birth. Try something like "21 May 1990", "21/05/1990", or "1990-05-21".` };
      }

      passengers.push({
        firstName,
        lastName,
        dateOfBirth: parsedDob,
        idNumber: idNum,
        seatPreference,
        gender: null,
        type: null,
      });

      if (i === 0) {
        guestPhone = phone || null;
        guestEmail = email || null;
      }
    }

    if (expectedCount && passengers.length !== expectedCount) {
      return {
        error: `This booking is for ${expectedCount} traveler(s), but I found ${passengers.length} block(s) in your message. Please include exactly ${expectedCount} traveler block(s), separated by a blank line.`,
      };
    }

    if (!guestPhone) {
      return { error: 'Please include a Phone number for the first traveler.' };
    }

    return { passengers, guestPhone, guestEmail };
  }

  async _handleDetailsMessage({ phoneNumberId, from, text, session }) {
    const expectedCount = session.passenger_count || 1;
    const parsed = this._parseDetailsMessage(text, expectedCount);

    if (parsed.error) {
      await whatsappService.sendText(phoneNumberId, from, `${parsed.error}\n\nPlease resend your details in the format shown earlier.`);
      return true;
    }

    const pkg = session.package_snapshot;
    const needsFlightDetails = !!(pkg.transport && (pkg.transport.transportType || 'flight') === 'flight');

    if (needsFlightDetails && !parsed.guestEmail) {
      await whatsappService.sendText(phoneNumberId, from, 'An Email is required for the first traveler on flight bookings. Please resend your details including an Email line.');
      return true;
    }

    await supabase
      .from('whatsapp_booking_sessions')
      .update({
        current_step: 'awaiting_gender_type',
        passengers_collected: parsed.passengers,
        guest_phone: parsed.guestPhone,
        guest_email: parsed.guestEmail,
        current_passenger_index: 0,
      })
      .eq('phone', from);

    await this._askGenderType({ phoneNumberId, from, passengers: parsed.passengers, index: 0 });
    return true;
  }

  async _askGenderType({ phoneNumberId, from, passengers, index }) {
    const passenger = passengers[index];
    const name = `${passenger.firstName} ${passenger.lastName}`.trim();

    const sent = await whatsappService.sendList(
      phoneNumberId, from,
      `One more thing for *${name}* — select gender and traveler type:`,
      'Select',
      GENDER_TYPE_OPTIONS
    );

    if (!sent) {
      await whatsappService.sendText(phoneNumberId, from,
        `One more thing for *${name}* — reply with their gender and traveler type, e.g. "male adult" or "female child".`
      );
    }
  }

  async _handleGenderTypeReply({ phoneNumberId, from, text, interactive, session }) {
    const listReplyId = interactive?.list_reply?.id || null;
    let gender = null, type = null;

    if (listReplyId) {
      const match = listReplyId.match(/^gt_(male|female)_(adult|child)$/);
      if (match) {
        gender = match[1];
        type = match[2];
      }
    } else if (text) {
      const t = text.toLowerCase();
      if (/\bmale\b|\bm\b/.test(t) && !/\bfemale\b/.test(t)) gender = 'male';
      else if (/\bfemale\b|\bf\b/.test(t)) gender = 'female';
      if (/\bchild\b|\bkid\b|\bminor\b/.test(t)) type = 'child';
      else if (/\badult\b/.test(t)) type = 'adult';
    }

    if (!gender || !type) {
      const passengers = session.passengers_collected || [];
      const idx = session.current_passenger_index || 0;
      const name = passengers[idx] ? `${passengers[idx].firstName} ${passengers[idx].lastName}`.trim() : 'this traveler';
      await whatsappService.sendText(phoneNumberId, from,
        `Sorry, I didn't catch that — please tap one of the options above, or reply with something like "male adult" for *${name}*.`
      );
      return true;
    }

    const passengers = session.passengers_collected || [];
    const idx = session.current_passenger_index || 0;

    if (!passengers[idx]) {
      logger.error('WhatsApp booking: passenger index out of range in gender/type flow', { from, idx, passengerCount: passengers.length });
      await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);
      await whatsappService.sendText(phoneNumberId, from, 'Something went wrong tracking your travelers — please search again to restart the booking.');
      return true;
    }

    passengers[idx] = { ...passengers[idx], gender, type };
    const nextIndex = idx + 1;

    if (nextIndex < passengers.length) {
      await supabase
        .from('whatsapp_booking_sessions')
        .update({ passengers_collected: passengers, current_passenger_index: nextIndex })
        .eq('phone', from);

      await this._askGenderType({ phoneNumberId, from, passengers, index: nextIndex });
      return true;
    }

    await supabase
      .from('whatsapp_booking_sessions')
      .update({ passengers_collected: passengers, current_passenger_index: nextIndex })
      .eq('phone', from);

    await this._finalizeBooking({ phoneNumberId, from, session: { ...session, passengers_collected: passengers } });
    return true;
  }

  async _finalizeBooking({ phoneNumberId, from, session }) {
    await whatsappService.sendText(phoneNumberId, from, 'Got it! Holding your flight and confirming your hotel now — one moment...');

    const bookingRef = `BDR-${Date.now()}`;
    const passengers = session.passengers_collected || [];
    const guestName  = `${passengers[0]?.firstName || ''} ${passengers[0]?.lastName || ''}`.trim();

    const result = await bookingService.initBooking({
      bookingRef,
      agencyId:         session.agency_id,
      pkg:               session.package_snapshot,
      passengerDetails: passengers,
      guestName,
      guestPhone:       session.guest_phone,
      guestEmail:       session.guest_email,
      channel:          'whatsapp',
    });

    const parsed = { guestPhone: session.guest_phone, guestEmail: session.guest_email, passengers };

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
        `The hotel price changed once the child's real date of birth was applied:\n\n` +
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
      const seatLines = result.seatSelection.resolved.map(s => `Seat ${s.designator} (${s.positionType}${s.isExitRow ? ', exit row' : ''}) — ${s.currency} ${s.price}`);
      await whatsappService.sendText(phoneNumberId, from, `Seat${result.seatSelection.resolved.length > 1 ? 's' : ''} confirmed:\n${seatLines.join('\n')}`);
    }

    await this._proceedToPayment({ phoneNumberId, from, result, parsed });
  }

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

    await whatsappService.sendText(phoneNumberId, from, 'Great — processing your booking at the new price now...');

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
      parsed: { guestPhone: ctx.guestPhone, guestEmail: ctx.guestEmail, passengers: ctx.passengerDetails },
    });
    return true;
  }

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

    logger.info('WhatsApp booking init + payment trigger complete', { bookingRef: result.bookingRef, from });
  }
}

module.exports = new WhatsAppBookingFlow();