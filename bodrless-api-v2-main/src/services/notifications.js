/**
 * BODRLESS NOTIFICATION SERVICE
 * ─────────────────────────────────────────────────────────────
 * Coordinates communication between suppliers when a booking
 * is confirmed or when something changes (delays, cancellations)
 *
 * Flow:
 *   Flight confirmed → notify hotel of arrival time
 *   Hotel confirmed → notify transfer of pickup location
 *   Flight delayed  → notify hotel + transfer automatically
 * ─────────────────────────────────────────────────────────────
 */

const { logger } = require('../utils/logger');

class NotificationService {

  /**
   * Notify all partners when a booking is confirmed
   */
  async notifyBookingConfirmed({ booking, flight, hotel, transfer }) {
    const notifications = [];

    // 1. Notify hotel of guest arrival details
    if (hotel && flight) {
      const hotelNotification = await this.notifyHotel({
        hotel,
        message: 'BOOKING CONFIRMED',
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
      });
      notifications.push(hotelNotification);
    }

    // 2. Notify transfer of pickup details
    if (transfer && flight) {
      const transferNotification = await this.notifyTransfer({
        transfer,
        message: 'TRANSFER CONFIRMED',
        guestName: booking.guestName,
        guestCount: booking.passengers,
        pickupLocation: `${flight.destination} Airport`,
        pickupTime: flight.arrivalTime,
        dropoffLocation: hotel ? hotel.name : booking.destination,
        flightNumber: flight.flightNumber,
        bookingRef: booking.bookingRef,
        guestPhone: booking.guestPhone,
      });
      notifications.push(transferNotification);
    }

    // 3. Send confirmation to traveler
    const travelerNotification = await this.notifyTraveler({
      booking,
      flight,
      hotel,
      transfer,
    });
    notifications.push(travelerNotification);

    // 4. Notify agency
    const agencyNotification = await this.notifyAgency({
      booking,
      flight,
      hotel,
      transfer,
    });
    notifications.push(agencyNotification);

    logger.info('All booking notifications sent', {
      bookingRef: booking.bookingRef,
      notificationCount: notifications.length,
    });

    return notifications;
  }

  /**
   * Notify all partners of a flight delay
   * This is the most critical coordination function
   */
  async notifyFlightDelay({ booking, flight, hotel, transfer, delayMinutes, newArrivalTime }) {
    logger.warn('Flight delay detected — notifying all partners', {
      bookingRef: booking.bookingRef,
      originalArrival: flight.arrivalTime,
      newArrival: newArrivalTime,
      delayMinutes,
    });

    const notifications = [];

    // 1. Notify hotel of updated arrival time
    if (hotel) {
      const hotelAlert = await this.notifyHotel({
        hotel,
        message: '⚠️ FLIGHT DELAY UPDATE',
        guestName: booking.guestName,
        guestCount: booking.passengers,
        arrivalFlight: flight.flightNumber,
        originalArrivalTime: flight.arrivalTime,
        updatedArrivalTime: newArrivalTime,
        delayMinutes,
        bookingRef: booking.bookingRef,
        note: `Guest arriving ${delayMinutes} minutes late. Please hold room and adjust check-in accordingly.`,
      });
      notifications.push(hotelAlert);
    }

    // 2. Notify transfer of updated pickup time
    if (transfer) {
      const transferAlert = await this.notifyTransfer({
        transfer,
        message: '⚠️ PICKUP TIME UPDATED',
        guestName: booking.guestName,
        originalPickupTime: flight.arrivalTime,
        updatedPickupTime: newArrivalTime,
        delayMinutes,
        flightNumber: flight.flightNumber,
        bookingRef: booking.bookingRef,
        note: `Flight delayed by ${delayMinutes} minutes. Please update pickup time to ${newArrivalTime}.`,
      });
      notifications.push(transferAlert);
    }

    // 3. Notify traveler
    await this.notifyTravelerDelay({
      booking,
      flight,
      newArrivalTime,
      delayMinutes,
      hotel,
      transfer,
    });

    return notifications;
  }

  /**
   * Notify hotel — via email, WhatsApp or API depending on hotel setup
   */
  async notifyHotel({ hotel, message, ...details }) {
    try {
      // Format the notification message
      const notification = this._formatHotelNotification({ message, ...details });

      // In production: send via hotel's preferred channel
      // Option 1: Email (most common)
      // Option 2: WhatsApp Business API
      // Option 3: Hotel PMS API (Opera, Protel, Nightsbridge)
      // Option 4: SMS

      // For now — log it (replace with real sending below)
      logger.info('Hotel notification sent', {
        hotelName: hotel.name,
        message,
        bookingRef: details.bookingRef,
        notification,
      });

      // TODO: Replace with real hotel notification
      // await this._sendEmail(hotel.email, 'Bodrless Booking Update', notification);
      // await this._sendWhatsApp(hotel.whatsappNumber, notification);

      return {
        recipient: 'hotel',
        hotelName: hotel.name,
        message,
        status: 'sent',
        sentAt: new Date().toISOString(),
      };

    } catch (error) {
      logger.error('Hotel notification failed', { error: error.message, hotel: hotel.name });
      return { recipient: 'hotel', status: 'failed', error: error.message };
    }
  }

  /**
   * Notify transfer provider
   */
  async notifyTransfer({ transfer, message, ...details }) {
    try {
      const notification = this._formatTransferNotification({ message, ...details });

      logger.info('Transfer notification sent', {
        provider: transfer.provider,
        message,
        bookingRef: details.bookingRef,
        notification,
      });

      // TODO: Replace with real transfer notification
      // await this._sendWhatsApp(transfer.whatsappNumber, notification);
      // await this._sendSMS(transfer.phone, notification);

      return {
        recipient: 'transfer',
        provider: transfer.provider,
        message,
        status: 'sent',
        sentAt: new Date().toISOString(),
      };

    } catch (error) {
      logger.error('Transfer notification failed', { error: error.message });
      return { recipient: 'transfer', status: 'failed', error: error.message };
    }
  }

  /**
   * Notify traveler of confirmed booking
   */
  async notifyTraveler({ booking, flight, hotel, transfer }) {
    try {
      const message = this._formatTravelerConfirmation({ booking, flight, hotel, transfer });

      logger.info('Traveler confirmation sent', {
        guestName: booking.guestName,
        bookingRef: booking.bookingRef,
      });

      // TODO: Send via WhatsApp to traveler's number
      // await whatsappService.sendText(booking.phoneNumberId, booking.guestPhone, message);

      return {
        recipient: 'traveler',
        guestName: booking.guestName,
        status: 'sent',
        sentAt: new Date().toISOString(),
      };

    } catch (error) {
      logger.error('Traveler notification failed', { error: error.message });
      return { recipient: 'traveler', status: 'failed', error: error.message };
    }
  }

  /**
   * Notify traveler of flight delay
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

      logger.info('Traveler delay notification sent', {
        bookingRef: booking.bookingRef,
        delayMinutes,
      });

      // TODO: Send via WhatsApp
      // await whatsappService.sendText(booking.phoneNumberId, booking.guestPhone, message);

      return { recipient: 'traveler', type: 'delay', status: 'sent' };

    } catch (error) {
      logger.error('Traveler delay notification failed', { error: error.message });
      return { recipient: 'traveler', status: 'failed' };
    }
  }

  /**
   * Notify agency of completed booking
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
*Hotel:* ${hotel ? hotel.name + ' — ' + hotel.nights + ' nights' : 'N/A'}
*Transfer:* ${transfer ? transfer.provider : 'N/A'}

*Total Value:* $${booking.totalPrice}
*Your Commission:* $${Math.round(booking.totalPrice * 0.05)}

View full details in your Bodrless dashboard.
      `.trim();

      logger.info('Agency notification sent', {
        agencyId: booking.agencyId,
        bookingRef: booking.bookingRef,
      });

      // TODO: Send via WhatsApp to agency number
      // await whatsappService.sendText(booking.phoneNumberId, agencyWhatsappNumber, message);

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
Check-in: ${checkIn || arrivalTime}
Check-out: ${checkOut || 'As booked'}
Arrival Flight: ${arrivalFlight}
${updatedArrivalTime ? `Updated Arrival: ${updatedArrivalTime} (${delayMinutes}min delay)` : `Arrival Time: ${arrivalTime}`}
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
Flight: ${flightNumber}
Pickup: ${pickupLocation}
${updatedPickupTime ? `Updated Pickup Time: ${updatedPickupTime} (${delayMinutes}min delay)` : `Pickup Time: ${pickupTime}`}
Drop-off: ${dropoffLocation}
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
${hotel ? hotel.name + ' · ' + hotel.nights + ' nights · ' + hotel.mealPlan : 'See itinerary'}

🚗 *Transfer*
${transfer ? transfer.provider + ' · Pickup at arrival · Drop to ' + (hotel ? hotel.name : 'hotel') : 'See itinerary'}

💰 *Total Paid:* $${booking.totalPrice}

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