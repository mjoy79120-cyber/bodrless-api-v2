/**
 * WHATSAPP BOOKING FLOW
 * ─────────────────────────────────────────────────────────────
 * Conversational passenger-detail collection + booking confirmation
 * for WhatsApp, mirroring the widget's form but one question at a time.
 *
 * State is tracked per phone number in the whatsapp_booking_sessions
 * table so the conversation survives across separate webhook calls
 * (each WhatsApp message is its own HTTP request).
 *
 * Flow:
 *   1. Customer replies with a package number ("1", "2"...) after search
 *   2. Bot asks for passenger 1 first name, then last name, then DOB
 *      (only if package includes a flight), then gender, repeats per
 *      passenger, then asks for phone + email once at the end
 *   3. Bot calls bookingService.initBooking()
 *   4. On success, bot tells the customer the total due and that
 *      payment will follow (payment step is stubbed for now)
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const bookingService = require('./bookingService');
const whatsappService = require('./whatsapp');
const { logger } = require('../utils/logger');

class WhatsAppBookingFlow {

  // ─────────────────────────────────────────────
  // Called when the person picks a package number after a search.
  // lastPackages must be passed in from whatever the orchestrator
  // most recently returned for this conversation.
  // ─────────────────────────────────────────────
  async startBooking({ phoneNumberId, from, agencyId, selectedPackage }) {
    const needsFlightDetails = !!(selectedPackage.transport && (selectedPackage.transport.transportType || 'flight') === 'flight');
    const passengerCount = selectedPackage.summary?.passengers || 1;

    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from); // clear any stale session

    await supabase.from('whatsapp_booking_sessions').insert({
      phone: from,
      agency_id: agencyId,
      package_snapshot: selectedPackage,
      passenger_count: passengerCount,
      current_step: 'p1_firstname',
      passengers_collected: [],
    });

    await whatsappService.sendText(phoneNumberId, from,
      `Great choice! Let's get this booked.\n\nFirst, what's the *first name* of traveler 1?`
    );
  }

  // ─────────────────────────────────────────────
  // Called for every incoming message while a booking session is active.
  // Returns true if it handled the message (so the caller knows not to
  // also run it through the normal search/orchestration path).
  // ─────────────────────────────────────────────
  async handleMessage({ phoneNumberId, from, text }) {
    const { data: session } = await supabase
      .from('whatsapp_booking_sessions')
      .select('*')
      .eq('phone', from)
      .maybeSingle();

    if (!session) return false; // no active booking conversation

    const pkg = session.package_snapshot;
    const needsFlightDetails = !!(pkg.transport && (pkg.transport.transportType || 'flight') === 'flight');
    const passengers = session.passengers_collected || [];
    const step = session.current_step;

    // ── Cancel keyword always available ──
    if (/^cancel$/i.test(text.trim())) {
      await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);
      await whatsappService.sendText(phoneNumberId, from, 'Booking cancelled. Let me know if you would like to search again.');
      return true;
    }

    const trimmed = text.trim();

    // ── Passenger detail collection ──
    if (step.startsWith('p')) {
      const passengerIndex = parseInt(step.match(/p(\d+)_/)?.[1] || '1', 10) - 1;
      const field = step.split('_')[1]; // firstname | lastname | dob | gender

      const current = passengers[passengerIndex] || {};

      if (field === 'firstname') {
        current.firstName = trimmed;
        passengers[passengerIndex] = current;
        await this._advance(from, passengers, `p${passengerIndex + 1}_lastname`);
        await whatsappService.sendText(phoneNumberId, from, `And the *last name* of traveler ${passengerIndex + 1}?`);
        return true;
      }

      if (field === 'lastname') {
        current.lastName = trimmed;
        passengers[passengerIndex] = current;

        if (needsFlightDetails) {
          await this._advance(from, passengers, `p${passengerIndex + 1}_dob`);
          await whatsappService.sendText(phoneNumberId, from, `Date of birth for traveler ${passengerIndex + 1}? (format: YYYY-MM-DD)`);
        } else {
          current.type = 'adult';
          passengers[passengerIndex] = current;
          await this._afterPassengerComplete(phoneNumberId, from, session, passengers, passengerIndex);
        }
        return true;
      }

      if (field === 'dob') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
          await whatsappService.sendText(phoneNumberId, from, 'Please use the format YYYY-MM-DD, e.g. 1990-05-21.');
          return true;
        }
        current.dateOfBirth = trimmed;
        passengers[passengerIndex] = current;
        await this._advance(from, passengers, `p${passengerIndex + 1}_gender`);
        await whatsappService.sendText(phoneNumberId, from, `Gender for traveler ${passengerIndex + 1}? Reply *male* or *female*.`);
        return true;
      }

      if (field === 'gender') {
        const g = trimmed.toLowerCase();
        if (g !== 'male' && g !== 'female') {
          await whatsappService.sendText(phoneNumberId, from, 'Please reply with *male* or *female*.');
          return true;
        }
        current.gender = g;
        current.type   = 'adult';
        passengers[passengerIndex] = current;
        await this._afterPassengerComplete(phoneNumberId, from, session, passengers, passengerIndex);
        return true;
      }
    }

    // ── Contact details ──
    if (step === 'contact_phone') {
      await supabase.from('whatsapp_booking_sessions')
        .update({ guest_phone: trimmed, current_step: needsFlightDetails ? 'contact_email' : 'confirm' })
        .eq('phone', from);

      if (needsFlightDetails) {
        await whatsappService.sendText(phoneNumberId, from, `Last thing — what's your *email*? (required for flight ticketing)`);
      } else {
        await this._confirmBooking(phoneNumberId, from, session, passengers, trimmed, null);
      }
      return true;
    }

    if (step === 'contact_email') {
      await supabase.from('whatsapp_booking_sessions')
        .update({ guest_email: trimmed, current_step: 'confirm' })
        .eq('phone', from);

      const { data: updated } = await supabase
        .from('whatsapp_booking_sessions')
        .select('*')
        .eq('phone', from)
        .single();

      await this._confirmBooking(phoneNumberId, from, session, passengers, updated.guest_phone, trimmed);
      return true;
    }

    return false;
  }

  async _advance(phone, passengers, nextStep) {
    await supabase.from('whatsapp_booking_sessions')
      .update({ passengers_collected: passengers, current_step: nextStep, updated_at: new Date().toISOString() })
      .eq('phone', phone);
  }

  async _afterPassengerComplete(phoneNumberId, from, session, passengers, passengerIndex) {
    const isLastPassenger = passengerIndex + 1 >= session.passenger_count;

    if (!isLastPassenger) {
      const nextIndex = passengerIndex + 1;
      await this._advance(from, passengers, `p${nextIndex + 1}_firstname`);
      await whatsappService.sendText(phoneNumberId, from, `Now, first name of traveler ${nextIndex + 1}?`);
    } else {
      await this._advance(from, passengers, 'contact_phone');
      await whatsappService.sendText(phoneNumberId, from, `Almost done! What's the best *phone number* to reach you on?`);
    }
  }

  async _confirmBooking(phoneNumberId, from, session, passengers, guestPhone, guestEmail) {
    await whatsappService.sendText(phoneNumberId, from, `Holding your flight and confirming your hotel now — one moment...`);

    const bookingRef = `BDR-${Date.now()}`;
    const guestName  = `${passengers[0].firstName} ${passengers[0].lastName}`;

    const result = await bookingService.initBooking({
      bookingRef,
      agencyId: session.agency_id,
      pkg: session.package_snapshot,
      passengerDetails: passengers,
      guestName,
      guestPhone,
      guestEmail,
      channel: 'whatsapp',
    });

    await supabase.from('whatsapp_booking_sessions').delete().eq('phone', from);

    if (!result.success) {
      await whatsappService.sendText(phoneNumberId, from,
        `We hit a snag: ${result.error}\n\nNo payment has been taken. Feel free to search again.`
      );
      return;
    }

    await whatsappService.sendText(phoneNumberId, from,
      `Your flight is held and hotel is confirmed!\n\n` +
      `*Booking ref:* ${result.bookingRef}\n` +
      `*Total due:* ${result.currency} ${result.totalPrice.toLocaleString()}\n\n` +
      `Payment via M-Pesa is coming soon — our team will reach out shortly to complete this booking. Reply *cancel* if you'd like to cancel this hold instead.`
    );

    logger.info('WhatsApp booking init complete', { bookingRef: result.bookingRef, from });
  }
}

module.exports = new WhatsAppBookingFlow();