/**
 * WHATSAPP BOOKING FLOW
 * ─────────────────────────────────────────────────────────────
 * Single-message passenger detail collection for WhatsApp.
 *
 * Instead of a slow one-question-at-a-time conversation, the bot sends
 * one template message showing the exact format to reply with, and the
 * customer fills in all passenger details at once — one labeled block
 * per traveler, separated by a blank line. This mirrors filling out a
 * form, just typed as plain text rather than tappable fields (which
 * would require WhatsApp Flows — a separate, heavier Meta-approved
 * integration we're not using yet).
 *
 * Expected format (per passenger block):
 *   Name: John Doe
 *   ID/Passport No: A12345678
 *   Gender: Male
 *   Phone: 0712345678
 *   Email: john@example.com
 *   DOB: 1990-05-21
 *
 * Multiple passengers = multiple blocks separated by a blank line.
 * Phone/email are only required on the first passenger (used as the
 * booking's contact details). Children can write "child" or "N/A" for
 * ID/Passport No and it will be accepted without an ID.
 *
 * State is tracked per phone number in whatsapp_booking_sessions so the
 * conversation survives across separate webhook calls.
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const bookingService = require('./bookingService');
const whatsappService = require('./whatsapp');
const { logger } = require('../utils/logger');

const FORMAT_TEMPLATE =
`Please reply with *all traveler details in one message*, like this:

Name: John Doe
ID/Passport No: A12345678
Gender: Male
Phone: 0712345678
Email: john@example.com
DOB: 1990-05-21

If booking for more than one traveler, add each person as a separate block, with a blank line between them. Only the first traveler needs to include Phone and Email.

For a child traveler, you can write "child" for ID/Passport No instead of a number.

Reply *cancel* at any time to stop.`;

class WhatsAppBookingFlow {

  // ─────────────────────────────────────────────
  // Called when the person picks a package number after a search.
  // ─────────────────────────────────────────────
  async startBooking({ phoneNumberId, from, agencyId, selectedPackage }) {
    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from); // clear any stale session

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

  // ─────────────────────────────────────────────
  // Lightweight active-session check, reused by webhook.js so it
  // never has to duplicate this query independently. This is the
  // single source of truth for "is there an active booking
  // conversation for this phone number" — handleMessage() below
  // remains the only place that actually loads and acts on the
  // session's contents.
  // ─────────────────────────────────────────────
  async hasActiveSession(from) {
    const { data: session } = await supabase
      .from('whatsapp_booking_sessions')
      .select('phone')
      .eq('phone', from)
      .maybeSingle();
    return !!session;
  }

  // ─────────────────────────────────────────────
  // Called for every incoming message while a booking session is active.
  // Returns true if it handled the message.
  // ─────────────────────────────────────────────
  async handleMessage({ phoneNumberId, from, text }) {
    const { data: session } = await supabase
      .from('whatsapp_booking_sessions')
      .select('*')
      .eq('phone', from)
      .maybeSingle();

    if (!session) return false; // no active booking conversation

    if (/^cancel$/i.test(text.trim())) {
      await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);
      await whatsappService.sendText(phoneNumberId, from, 'Booking cancelled. Let me know if you would like to search again.');
      return true;
    }

    if (session.current_step === 'awaiting_details_message') {
      return this._handleDetailsMessage({ phoneNumberId, from, text, session });
    }

    return false;
  }

  // ─────────────────────────────────────────────
  // PARSE the single details message into passenger objects
  // ─────────────────────────────────────────────
  _parseDetailsMessage(text, expectedCount) {
    const blocks = text
      .split(/\n\s*\n/) // split on blank lines
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

      const name = fields['name'];
      const idNum = fields['id/passport no'] || fields['id'] || fields['passport'] || fields['id/passport'];
      const gender = fields['gender'];
      const phone = fields['phone'];
      const email = fields['email'];
      const dob = fields['dob'] || fields['date of birth'];

      if (!name) {
        return { error: `Traveler ${i + 1} is missing a Name. Please check the format and try again.` };
      }
      const nameParts = name.trim().split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || nameParts[0];

      if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
        return { error: `Traveler ${i + 1}'s DOB must be in YYYY-MM-DD format (e.g. 1990-05-21). Please check and resend.` };
      }

      const genderLower = (gender || '').toLowerCase();
      if (genderLower !== 'male' && genderLower !== 'female') {
        return { error: `Traveler ${i + 1}'s Gender must be "Male" or "Female". Please check and resend.` };
      }

      const isChild = !idNum || /^(child|n\/a|na|none)$/i.test(idNum.trim());

      if (!isChild && !idNum) {
        return { error: `Traveler ${i + 1} needs an ID/Passport No, or write "child" if this traveler is a minor.` };
      }

      passengers.push({
        firstName,
        lastName,
        dateOfBirth: dob,
        gender: genderLower,
        type: isChild ? 'child' : 'adult',
        idNumber: isChild ? null : idNum,
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

    await whatsappService.sendText(phoneNumberId, from, 'Got it! Holding your flight and confirming your hotel now — one moment...');

    const bookingRef = `BDR-${Date.now()}`;
    const guestName  = `${parsed.passengers[0].firstName} ${parsed.passengers[0].lastName}`;

    const result = await bookingService.initBooking({
      bookingRef,
      agencyId: session.agency_id,
      pkg,
      passengerDetails: parsed.passengers,
      guestName,
      guestPhone: parsed.guestPhone,
      guestEmail: parsed.guestEmail,
      channel: 'whatsapp',
    });

    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);

    if (!result.success) {
      await whatsappService.sendText(phoneNumberId, from,
        `We hit a snag: ${result.error}\n\nNo payment has been taken. Feel free to search again.`
      );
      return true;
    }

    await whatsappService.sendText(phoneNumberId, from,
      `Flight held and hotel confirmed!\n\n` +
      `*Booking ref:* ${result.bookingRef}\n` +
      `*Total due:* ${result.currency} ${result.totalPrice.toLocaleString()}\n\n` +
      `Sending an M-Pesa payment prompt to ${parsed.guestPhone} now...`
    );

    const paymentResult = await bookingService.triggerPayment({
      bookingRef: result.bookingRef,
      phone: parsed.guestPhone,
      amount: result.totalPrice,
      currency: result.currency,
      email: parsed.guestEmail,
      firstName: parsed.passengers[0].firstName,
      lastName: parsed.passengers[0].lastName,
    });

    if (!paymentResult.success) {
      await whatsappService.sendText(phoneNumberId, from,
        `Your flight and hotel are held, but we couldn't send the payment prompt (${paymentResult.error}). Please contact support with booking ref ${result.bookingRef}.`
      );
      logger.error('WhatsApp payment trigger failed after successful booking init', { bookingRef: result.bookingRef, error: paymentResult.error });
      return true;
    }

    await whatsappService.sendText(phoneNumberId, from,
      `Check your phone and enter your *M-Pesa PIN* to complete payment.\n\nThis booking will be held for 30 minutes. We'll message you once payment is confirmed.`
    );

    logger.info('WhatsApp booking init + payment trigger complete', { bookingRef: result.bookingRef, from });
    return true;
  }
}

module.exports = new WhatsAppBookingFlow();