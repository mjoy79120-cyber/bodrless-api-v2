/**
 * BODRLESS NOTIFICATION SERVICE
 * ─────────────────────────────────────────────────────────────
 * Coordinates communication between suppliers when a booking
 * is confirmed or when something changes (delays, cancellations).
 *
 * Flow:
 * Flight confirmed  → notify hotel of arrival time, notify BOTH
 *                      transfer legs (departure-city pickup AND
 *                      arrival-city pickup/dropoff)
 * Flight delayed    → notify hotel + the arrival-city transfer
 *                      (the departure-city transfer already
 *                      happened before the flight even took off,
 *                      so it has nothing to update)
 *
 * SCOPE: this only notifies suppliers Bodrless has a DIRECT
 * relationship with — your own Supabase-listed hotels and transfer
 * providers (see migration 003_supplier_contact_info.sql for the
 * whatsapp_number/contact_email columns this reads from).
 * HotelBeds-sourced hotels are NOT covered here — HotelBeds' own
 * booking flow already notifies the property at booking time, and
 * reaching them for a LATER delay/change requires their Content API
 * (a separate, not-yet-built integration — follow-up task). A hotel
 * object with supplier === 'hotelbeds' is intentionally skipped here,
 * not silently mishandled.
 *
 * WHATSAPP RECIPIENTS — three distinct numbers, not to be confused:
 *   - Traveler:        booking.guestPhone
 *   - Agency ops team: agencies.ops_whatsapp_number (resolved via
 *                       _resolveAgencyContacts below) — DISTINCT from
 *                       agencies.whatsapp_phone_number_id, which is
 *                       the number CUSTOMERS message IN on, not where
 *                       booking alerts should be sent.
 *   - Hotel/transfer:  hotels.whatsapp_number / transfers.whatsapp_number
 * The FROM number for all of these is always
 * agencies.whatsapp_phone_number_id, since that's the agency's actual
 * WhatsApp Business sending number — see _resolveAgencyContacts.
 * ─────────────────────────────────────────────────────────────
 */

const { logger } = require('../utils/logger');
const supabase = require('../utils/supabase');
const realWhatsappService = require('./whatsapp');

// ─────────────────────────────────────────────────────────────
// EMAIL SERVICE — TEST STUB
// No real email provider (SendGrid/SES/etc.) is connected yet —
// that's a separate account/integration decision. Logs clearly,
// never silently pretends to have sent anything. Swap this for a
// real provider once one is chosen; nothing else in this file needs
// to change, since callers only see {status, to}.
// ─────────────────────────────────────────────────────────────
const emailService = {
  sendEmail: async (to, subject, message) => {
    logger.info(`[TEST EMAIL — no real provider connected] Would send to ${to}`, { subject });
    console.log(`\n--- EMAIL (TEST STUB) TO: ${to} ---\nSubject: ${subject}\n${message}\n-----------------------------\n`);
    return Promise.resolve({ status: 'sent_test_stub', to });
  }
};

class NotificationService {

  // ─────────────────────────────────────────────
  // RESOLVE AGENCY CONTACTS
  // One lookup, two distinct purposes:
  //   - phoneNumberId: the FROM number for every WhatsApp send below
  //     (agencies.whatsapp_phone_number_id — the same column
  //     webhooks.js already uses to send customer-facing messages)
  //   - opsWhatsappNumber: the TO number for agency booking alerts
  //     (agencies.ops_whatsapp_number — separate column, see
  //     migration 003) — an agency's customer-facing line and
  //     internal ops alert line are often not the same number.
  // ─────────────────────────────────────────────
  async _resolveAgencyContacts(agencyId) {
    if (!agencyId) return { phoneNumberId: null, opsWhatsappNumber: null };
    try {
      const { data, error } = await supabase
        .from('agencies')
        .select('whatsapp_phone_number_id, ops_whatsapp_number')
        .eq('id', agencyId)
        .single();
      if (error || !data) {
        logger.warn('Could not resolve agency contacts for notification', { agencyId });
        return { phoneNumberId: null, opsWhatsappNumber: null };
      }
      return { phoneNumberId: data.whatsapp_phone_number_id, opsWhatsappNumber: data.ops_whatsapp_number };
    } catch (err) {
      logger.error('Agency contact lookup failed', { error: err.message, agencyId });
      return { phoneNumberId: null, opsWhatsappNumber: null };
    }
  }

  // ─────────────────────────────────────────────
  // SEND VIA PROVIDER'S PREFERRED CHANNEL
  // Shared by every notify* method below — looks at the provider's
  // notification_preference ('whatsapp' | 'email' | 'both', set on
  // the hotels/transfers row, default 'whatsapp') and sends through
  // whichever channel(s) it has contact info for. Falls back to
  // whichever channel IS available if the preferred one has no
  // contact info on file, rather than silently sending nothing.
  // ─────────────────────────────────────────────
  async _sendViaPreferredChannel({ provider, agencyPhoneNumberId, message, subject }) {
    const preference = provider.notification_preference || 'whatsapp';
    const hasWhatsapp = !!provider.whatsapp_number;
    const hasEmail = !!provider.contact_email;
    const attempts = [];

    const sendWhatsapp = async () => {
      if (!hasWhatsapp || !agencyPhoneNumberId) return { channel: 'whatsapp', status: 'skipped_no_contact' };
      try {
        await realWhatsappService.sendText(agencyPhoneNumberId, provider.whatsapp_number, message);
        return { channel: 'whatsapp', status: 'sent' };
      } catch (error) {
        logger.error('Supplier WhatsApp notification failed', { error: error.message, provider: provider.name });
        return { channel: 'whatsapp', status: 'failed', error: error.message };
      }
    };

    const sendEmail = async () => {
      if (!hasEmail) return { channel: 'email', status: 'skipped_no_contact' };
      try {
        await emailService.sendEmail(provider.contact_email, subject, message);
        return { channel: 'email', status: 'sent' };
      } catch (error) {
        logger.error('Supplier email notification failed', { error: error.message, provider: provider.name });
        return { channel: 'email', status: 'failed', error: error.message };
      }
    };

    if (preference === 'both') {
      attempts.push(await sendWhatsapp(), await sendEmail());
    } else if (preference === 'email') {
      attempts.push(hasEmail ? await sendEmail() : await sendWhatsapp());
    } else {
      attempts.push(hasWhatsapp ? await sendWhatsapp() : await sendEmail());
    }

    return attempts;
  }

  async notifyBookingConfirmed({ booking, flight, hotel, transfers }) {
    if (!booking || !booking.bookingRef) {
      logger.error('Validation Error: Missing booking or booking reference');
      throw new Error('Booking reference is required to send notifications');
    }

    const { phoneNumberId: agencyPhoneNumberId, opsWhatsappNumber } = await this._resolveAgencyContacts(booking.agencyId);
    const notifications = [];

    const notificationPromises = [
      this.notifyTraveler({ booking, flight, hotel, transfers, agencyPhoneNumberId }),
      this.notifyAgency({ booking, flight, hotel, transfers, agencyPhoneNumberId, opsWhatsappNumber }),
    ];

    const isDirectRelationshipHotel = hotel && hotel.supplier !== 'hotelbeds' && (hotel.whatsapp_number || hotel.contact_email);
    if (isDirectRelationshipHotel && flight) {
      notificationPromises.push(this.notifyHotel({
        hotel,
        agencyPhoneNumberId,
        message: '🔔 BOOKING CONFIRMED',
        guestName: booking.guestName,
        guestCount: booking.passengers,
        arrivalDate: flight.arrivalTime,
        arrivalFlight: flight.flightNumber,
        arrivalTime: flight.arrivalTime,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        roomType: hotel.roomType,
        mealPlan: hotel.mealPlan,
        bookingRef: booking.bookingRef,
        specialRequests: booking.specialRequests || 'None',
      }));
    }

    const transferList = Array.isArray(transfers) ? transfers : (transfers ? [transfers] : []);
    if (transferList.length > 0 && flight) {
      for (const transfer of transferList) {
        if (!(transfer.whatsapp_number || transfer.contact_email)) continue;
        notificationPromises.push(this.notifyTransfer({
          transfer,
          agencyPhoneNumberId,
          message: transfer.legType === 'departure' ? '🚗 DEPARTURE TRANSFER CONFIRMED' : '🚗 ARRIVAL TRANSFER CONFIRMED',
          guestName: booking.guestName,
          guestCount: booking.passengers,
          pickupLocation: transfer.pickup || (transfer.legType === 'arrival' ? `${flight.destination} Airport` : booking.origin),
          dropoffLocation: transfer.dropoff || (hotel ? hotel.name : booking.destination),
          pickupTime: transfer.legType === 'arrival' ? flight.arrivalTime : (transfer.pickupTime || 'See itinerary'),
          flightNumber: flight.flightNumber,
          bookingRef: booking.bookingRef,
          guestPhone: booking.guestPhone,
        }));
      }
    }

    const results = await Promise.allSettled(notificationPromises);
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) notifications.push(result.value);
    });

    logger.info('All booking notifications processed', {
      bookingRef: booking.bookingRef,
      successfulCount: notifications.length,
      attemptedCount: notificationPromises.length,
    });

    return notifications;
  }

  async notifyFlightDelay({ booking, flight, hotel, transfers, delayMinutes, newArrivalTime }) {
    if (!booking || !booking.bookingRef) throw new Error('Booking reference is required');

    logger.warn('Flight delay detected — notifying partners', { bookingRef: booking.bookingRef, delayMinutes });

    const { phoneNumberId: agencyPhoneNumberId } = await this._resolveAgencyContacts(booking.agencyId);
    const notifications = [];
    const notificationPromises = [
      this.notifyTravelerDelay({ booking, flight, newArrivalTime, delayMinutes, hotel, transfers, agencyPhoneNumberId }),
    ];

    const isDirectRelationshipHotel = hotel && hotel.supplier !== 'hotelbeds' && (hotel.whatsapp_number || hotel.contact_email);
    if (isDirectRelationshipHotel) {
      notificationPromises.push(this.notifyHotel({
        hotel,
        agencyPhoneNumberId,
        message: '⚠️ FLIGHT DELAY UPDATE',
        guestName: booking.guestName,
        guestCount: booking.passengers,
        arrivalFlight: flight.flightNumber,
        originalArrivalTime: flight.arrivalTime,
        updatedArrivalTime: newArrivalTime,
        delayMinutes,
        bookingRef: booking.bookingRef,
        note: `Guest arriving ${delayMinutes} minutes late. Please hold room and adjust check-in.`,
      }));
    }

    const transferList = Array.isArray(transfers) ? transfers : (transfers ? [transfers] : []);
    for (const transfer of transferList) {
      if (!(transfer.whatsapp_number || transfer.contact_email)) continue;
      if (transfer.legType !== 'arrival') continue;
      notificationPromises.push(this.notifyTransfer({
        transfer,
        agencyPhoneNumberId,
        message: '⚠️ PICKUP TIME UPDATED',
        guestName: booking.guestName,
        originalPickupTime: flight.arrivalTime,
        updatedPickupTime: newArrivalTime,
        delayMinutes,
        flightNumber: flight.flightNumber,
        bookingRef: booking.bookingRef,
        note: `Flight delayed by ${delayMinutes} minutes. Please update pickup time to ${newArrivalTime}.`,
      }));
    }

    const results = await Promise.allSettled(notificationPromises);
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) notifications.push(result.value);
    });

    return notifications;
  }

  async notifyHotel({ hotel, agencyPhoneNumberId, message, ...details }) {
    try {
      const text = this._formatHotelNotification({ message, ...details });
      const attempts = await this._sendViaPreferredChannel({
        provider: hotel, agencyPhoneNumberId, message: text, subject: `${message} — Booking ${details.bookingRef}`,
      });
      return { recipient: 'hotel', hotelName: hotel.name, attempts };
    } catch (error) {
      logger.error('Hotel notification failed', { error: error.message, hotel: hotel.name });
      return { recipient: 'hotel', status: 'failed', error: error.message };
    }
  }

  async notifyTransfer({ transfer, agencyPhoneNumberId, message, ...details }) {
    try {
      const text = this._formatTransferNotification({ message, ...details });
      const attempts = await this._sendViaPreferredChannel({
        provider: transfer, agencyPhoneNumberId, message: text, subject: `${message} — Booking ${details.bookingRef}`,
      });
      return { recipient: 'transfer', provider: transfer.provider, legType: transfer.legType, attempts };
    } catch (error) {
      logger.error('Transfer notification failed', { error: error.message });
      return { recipient: 'transfer', status: 'failed', error: error.message };
    }
  }

  async notifyTraveler({ booking, flight, hotel, transfers, agencyPhoneNumberId }) {
    try {
      const message = this._formatTravelerConfirmation({ booking, flight, hotel, transfers });
      if (!booking.guestPhone || !agencyPhoneNumberId) {
        logger.warn('Cannot notify traveler — missing guestPhone or agency phoneNumberId', { bookingRef: booking.bookingRef });
        return { recipient: 'traveler', status: 'skipped_no_contact' };
      }
      await realWhatsappService.sendText(agencyPhoneNumberId, booking.guestPhone, message);
      return { recipient: 'traveler', guestName: booking.guestName, status: 'sent' };
    } catch (error) {
      logger.error('Traveler notification failed', { error: error.message });
      return { recipient: 'traveler', status: 'failed', error: error.message };
    }
  }

  async notifyTravelerDelay({ booking, flight, newArrivalTime, delayMinutes, hotel, transfers, agencyPhoneNumberId }) {
    try {
      const transferList = Array.isArray(transfers) ? transfers : (transfers ? [transfers] : []);
      const arrivalTransfer = transferList.find(t => t.legType === 'arrival');

      const message = `
⚠️ *Flight Delay Update — Booking ${booking.bookingRef}*

Your flight ${flight.flightNumber} is delayed by ${delayMinutes} minutes.

*New arrival time:* ${newArrivalTime}

Don't worry — we've already notified:
✅ ${hotel ? hotel.name : 'Your hotel'} — room held for your updated arrival
✅ ${arrivalTransfer ? (arrivalTransfer.provider || 'Your transfer') : 'Your transfer'} — pickup time updated

No action needed from you. We've got it handled.

Questions? Reply to this message.
      `.trim();

      if (!booking.guestPhone || !agencyPhoneNumberId) {
        return { recipient: 'traveler', type: 'delay', status: 'skipped_no_contact' };
      }
      await realWhatsappService.sendText(agencyPhoneNumberId, booking.guestPhone, message);
      return { recipient: 'traveler', type: 'delay', status: 'sent' };
    } catch (error) {
      logger.error('Traveler delay notification failed', { error: error.message });
      return { recipient: 'traveler', status: 'failed', error: error.message };
    }
  }

  async notifyAgency({ booking, flight, hotel, transfers, agencyPhoneNumberId, opsWhatsappNumber }) {
    try {
      const transferList = Array.isArray(transfers) ? transfers : (transfers ? [transfers] : []);
      const transferSummary = transferList.length > 0
        ? transferList.map(t => `${t.legType || 'transfer'}: ${t.provider || 'TBC'}`).join(', ')
        : 'N/A';

      const message = `
✅ *New Booking Confirmed — ${booking.bookingRef}*

*Client:* ${booking.guestName}
*Route:* ${booking.origin} → ${booking.destination}
*Travel Date:* ${booking.checkIn}
*Passengers:* ${booking.passengers}

*Flight:* ${flight ? flight.flightNumber + ' — ' + flight.departureTime : 'N/A'}
*Hotel:* ${hotel ? hotel.name + ' — ' + (hotel.nights || 'TBD') + ' nights' : 'N/A'}
*Transfers:* ${transferSummary}

*Total Value:* ${booking.currency || 'KES'} ${booking.totalPrice || '0.00'}

View full details in your dashboard.
      `.trim();

      if (!opsWhatsappNumber || !agencyPhoneNumberId) {
        logger.warn('Cannot notify agency — missing ops_whatsapp_number or phoneNumberId', { bookingRef: booking.bookingRef, agencyId: booking.agencyId });
        return { recipient: 'agency', status: 'skipped_no_contact' };
      }
      await realWhatsappService.sendText(agencyPhoneNumberId, opsWhatsappNumber, message);
      return { recipient: 'agency', agencyId: booking.agencyId, status: 'sent' };
    } catch (error) {
      logger.error('Agency notification failed', { error: error.message });
      return { recipient: 'agency', status: 'failed', error: error.message };
    }
  }

  _formatHotelNotification({ message, guestName, guestCount, arrivalFlight, arrivalTime, updatedArrivalTime, checkIn, checkOut, roomType, mealPlan, bookingRef, note, delayMinutes }) {
    return `
${message}
━━━━━━━━━━━━━━━━━━━━
Booking Ref: ${bookingRef}
Guest: ${guestName} (${guestCount} pax)
Room: ${roomType || 'As booked'}
Meal Plan: ${mealPlan || 'As booked'}
Check-in: ${checkIn || arrivalTime || 'TBD'}
Check-out: ${checkOut || 'As booked'}
Arrival Flight: ${arrivalFlight || 'TBD'}
${updatedArrivalTime ? `Updated Arrival: ${updatedArrivalTime} (${delayMinutes}min delay)` : `Arrival Time: ${arrivalTime || 'TBD'}`}
${note ? `Note: ${note}` : ''}
━━━━━━━━━━━━━━━━━━━━
Powered by Bodrless
    `.trim();
  }

  _formatTransferNotification({ message, guestName, guestCount, pickupLocation, pickupTime, updatedPickupTime, dropoffLocation, flightNumber, bookingRef, guestPhone, note, delayMinutes }) {
    return `
${message}
━━━━━━━━━━━━━━━━━━━━
Booking Ref: ${bookingRef}
Guest: ${guestName} (${guestCount} pax)
Flight: ${flightNumber || 'TBD'}
Pickup: ${pickupLocation || 'TBD'}
${updatedPickupTime ? `Updated Pickup Time: ${updatedPickupTime} (${delayMinutes}min delay)` : `Pickup Time: ${pickupTime || 'TBD'}`}
Drop-off: ${dropoffLocation || 'TBD'}
Guest Phone: ${guestPhone || 'See booking'}
${note ? `Note: ${note}` : ''}
━━━━━━━━━━━━━━━━━━━━
Powered by Bodrless
    `.trim();
  }

  _formatTravelerConfirmation({ booking, flight, hotel, transfers }) {
    const transferList = Array.isArray(transfers) ? transfers : (transfers ? [transfers] : []);
    const transferLines = transferList.length > 0
      ? transferList.map(t => `${t.legType === 'departure' ? 'Departure pickup' : 'Arrival pickup'}: ${t.provider || 'TBC'} · ${t.pickup || 'TBC'} → ${t.dropoff || 'TBC'}`).join('\n')
      : 'See itinerary';

    return `
✅ *Booking Confirmed!*
━━━━━━━━━━━━━━━━━━━━
Ref: *${booking.bookingRef}*

✈️ *Flight*
${flight ? flight.flightNumber + ' · Departs ' + flight.departureTime + ' · Arrives ' + flight.arrivalTime : 'See itinerary'}

🏨 *Hotel*
${hotel ? hotel.name + ' · ' + (hotel.nights || 'TBD') + ' nights · ' + (hotel.mealPlan || 'Room only') : 'See itinerary'}

🚗 *Transfers*
${transferLines}

💰 *Total Paid:* ${booking.currency || 'KES'} ${booking.totalPrice || '0.00'}

Everything is confirmed and coordinated.
Your hotel knows when you're arriving.
Your transfer drivers will be waiting.

Have a wonderful trip! 🌍
━━━━━━━━━━━━━━━━━━━━
Questions? Reply to this message.
    `.trim();
  }
}

module.exports = new NotificationService();