/**
 * BODRLESS NOTIFICATION SERVICE
 * ─────────────────────────────────────────────────────────────
 * Coordinates communication between suppliers when a booking
 * is confirmed or when something changes (delays, cancellations)
 *
 * Flow:
 * Flight confirmed → notify hotel of arrival time
 * Hotel confirmed → notify transfer of pickup location
 * Flight delayed  → notify hotel + transfer automatically
 * ─────────────────────────────────────────────────────────────
 */

const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// TEST WHATSAPP SERVICE
// Replace this block with your actual WhatsApp API client later
// ─────────────────────────────────────────────────────────────
const whatsappService = {
  sendText: async (to, message) => {
    logger.info(`[TEST WHATSAPP] Message sent to ${to}`);
    console.log(`\n--- WHATSAPP TO: ${to} ---\n${message}\n-----------------------------\n`);
    return Promise.resolve({ status: 'sent', to });
  }
};

class NotificationService {

  /**
   * Notify all partners when a booking is confirmed
   */
  async notifyBookingConfirmed({ booking, flight, hotel, transfer }) {
    // 1. Data Validation
    if (!booking || !booking.bookingRef) {
      logger.error('Validation Error: Missing booking or booking reference');
      throw new Error('Booking reference is required to send notifications');
    }

    const notifications = [];

    // 2. Process all notifications in parallel
    const notificationPromises = [
      this.notifyTraveler({ booking, flight, hotel, transfer }),
      this.notifyAgency({ booking, flight, hotel, transfer })
    ];

    if (hotel && flight) {
      notificationPromises.push(this.notifyHotel({
        hotel,
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

    if (transfer && flight) {
      notificationPromises.push(this.notifyTransfer({
        transfer,
        message: '🚗 TRANSFER CONFIRMED',
        guestName: booking.guestName,
        guestCount: booking.passengers,
        pickupLocation: `${flight.destination} Airport`,
        pickupTime: flight.arrivalTime,
        dropoffLocation: hotel ? hotel.name : booking.destination,
        flightNumber: flight.flightNumber,
        bookingRef: booking.bookingRef,
        guestPhone: booking.guestPhone,
      }));
    }

    const results = await Promise.allSettled(notificationPromises);

    // 3. Collect successful results
    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        notifications.push(result.value);
      }
    });

    logger.info('All booking notifications processed', {
      bookingRef: booking.bookingRef,
      successfulCount: notifications.length,
      attemptedCount: notificationPromises.length
    });

    return notifications;
  }

  /**
   * Notify all partners of a flight delay
   */
  async notifyFlightDelay({ booking, flight, hotel, transfer, delayMinutes, newArrivalTime }) {
    if (!booking || !booking.bookingRef) throw new Error('Booking reference is required');

    logger.warn('Flight delay detected — notifying partners via WhatsApp', {
      bookingRef: booking.bookingRef,
      delayMinutes,
    });

    const notifications = [];
    const notificationPromises = [
      this.notifyTravelerDelay({ booking, flight, newArrivalTime, delayMinutes, hotel, transfer })
    ];

    if (hotel) {
      notificationPromises.push(this.notifyHotel({
        hotel,
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

    if (transfer) {
      notificationPromises.push(this.notifyTransfer({
        transfer,
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

  /**
   * Notify hotel via WhatsApp
   */
  async notifyHotel({ hotel, message, ...details }) {
    try {
      const notification = this._formatHotelNotification({ message, ...details });
      const targetNumber = hotel.whatsappNumber || '[TEST_HOTEL_NUM]';
      
      await whatsappService.sendText(targetNumber, notification);

      return { recipient: 'hotel', hotelName: hotel.name, status: 'sent' };
    } catch (error) {
      logger.error('Hotel notification failed', { error: error.message, hotel: hotel.name });
      return { recipient: 'hotel', status: 'failed', error: error.message };
    }
  }

  /**
   * Notify transfer provider via WhatsApp
   */
  async notifyTransfer({ transfer, message, ...details }) {
    try {
      const notification = this._formatTransferNotification({ message, ...details });
      const targetNumber = transfer.whatsappNumber || '[TEST_TRANSFER_NUM]';

      await whatsappService.sendText(targetNumber, notification);

      return { recipient: 'transfer', provider: transfer.provider, status: 'sent' };
    } catch (error) {
      logger.error('Transfer notification failed', { error: error.message });
      return { recipient: 'transfer', status: 'failed', error: error.message };
    }
  }

  /**
   * Notify traveler of confirmed booking via WhatsApp
   */
  async notifyTraveler({ booking, flight, hotel, transfer }) {
    try {
      const message = this._formatTravelerConfirmation({ booking, flight, hotel, transfer });
      const targetNumber = booking.guestPhone || '[TEST_GUEST_NUM]';

      await whatsappService.sendText(targetNumber, message);

      return { recipient: 'traveler', guestName: booking.guestName, status: 'sent' };
    } catch (error) {
      logger.error('Traveler notification failed', { error: error.message });
      return { recipient: 'traveler', status: 'failed', error: error.message };
    }
  }

  /**
   * Notify traveler of flight delay via WhatsApp
   */
  async notifyTravelerDelay({ booking, flight, newArrivalTime, delayMinutes, hotel, transfer }) {
    try {
      const message = `
⚠️ *Flight Delay Update — Booking ${booking.bookingRef}*

Your flight ${flight.flightNumber} is delayed by ${delayMinutes} minutes.

*New arrival time:* ${newArrivalTime}

Don't worry — we've already notified:
✅ ${hotel ? hotel.name : 'Your hotel'} — room held for your updated arrival
✅ ${transfer ? transfer.provider : 'Your transfer'} — pickup time updated

No action needed from you. We've got it handled.

Questions? Reply to this message.
      `.trim();

      const targetNumber = booking.guestPhone || '[TEST_GUEST_NUM]';
      await whatsappService.sendText(targetNumber, message);

      return { recipient: 'traveler', type: 'delay', status: 'sent' };
    } catch (error) {
      logger.error('Traveler delay notification failed', { error: error.message });
      return { recipient: 'traveler', status: 'failed' };
    }
  }

  /**
   * Notify agency of completed booking via WhatsApp
   */
  async notifyAgency({ booking, flight, hotel, transfer }) {
    try {
      const message = `
✅ *New Booking Confirmed — ${booking.bookingRef}*

*Client:* ${booking.guestName}
*Route:* ${booking.origin} → ${booking.destination}
*Travel Date:* ${booking.checkIn}
*Passengers:* ${booking.passengers}

*Flight:* ${flight ? flight.flightNumber + ' — ' + flight.departureTime : 'N/A'}
*Hotel:* ${hotel ? hotel.name + ' — ' + (hotel.nights || 'TBD') + ' nights' : 'N/A'}
*Transfer:* ${transfer ? transfer.provider : 'N/A'}

*Total Value:* $${booking.totalPrice || '0.00'}

View full details in your dashboard.
      `.trim();

      const targetNumber = booking.agencyWhatsappNumber || '[TEST_AGENCY_NUM]';
      await whatsappService.sendText(targetNumber, message);

      return { recipient: 'agency', agencyId: booking.agencyId, status: 'sent' };
    } catch (error) {
      logger.error('Agency notification failed', { error: error.message });
      return { recipient: 'agency', status: 'failed' };
    }
  }

  // ── FORMATTERS ────────────────────────────────────────────

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

  _formatTravelerConfirmation({ booking, flight, hotel, transfer }) {
    return `
✅ *Booking Confirmed!*
━━━━━━━━━━━━━━━━━━━━
Ref: *${booking.bookingRef}*

✈️ *Flight*
${flight ? flight.flightNumber + ' · Departs ' + flight.departureTime + ' · Arrives ' + flight.arrivalTime : 'See itinerary'}

🏨 *Hotel*
${hotel ? hotel.name + ' · ' + (hotel.nights || 'TBD') + ' nights · ' + (hotel.mealPlan || 'Room only') : 'See itinerary'}

🚗 *Transfer*
${transfer ? transfer.provider + ' · Pickup at arrival · Drop to ' + (hotel ? hotel.name : 'hotel') : 'See itinerary'}

💰 *Total Paid:* $${booking.totalPrice || '0.00'}

Everything is confirmed and coordinated.
Your hotel knows when you're arriving.
Your transfer driver will be waiting.

Have a wonderful trip! 🌍
━━━━━━━━━━━━━━━━━━━━
Questions? Reply to this message.
    `.trim();
  }
}

module.exports = new NotificationService();