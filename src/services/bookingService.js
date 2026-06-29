/**
 * BOOKING SERVICE
 * ─────────────────────────────────────────────────────────────
 * Shared booking logic used by both the widget (/api/trips/book-init,
 * /api/trips/pay) and the WhatsApp conversational booking flow.
 *
 * SEQUENCE (flight-first, single combined payment):
 *   1. initBooking()   — hold flight (TravelDuqa), then confirm hotel
 *                         (HotelBeds, refundable rate only) and transfer
 *                         if present. No payment yet.
 *   2. triggerPayment() — real IntaSend M-Pesa STK push for the combined
 *                         total. Sets a payment_deadline used by the
 *                         sweeper job to auto-cancel if payment stalls.
 *   3. confirmPayment() — called by the IntaSend webhook (or the sweeper,
 *                         via status poll) once payment succeeds. Converts
 *                         the TravelDuqa hold into a ticketed booking, and
 *                         fires supplier/agency/traveler notifications.
 *   4. failPayment()    — called if payment fails/times out. Cancels the
 *                         HotelBeds booking (refundable rate => free) and
 *                         lets the TravelDuqa hold expire naturally.
 *
 * Hotels are restricted to refundable (NOR) rates in this flow specifically
 * because HotelBeds has no true "hold" concept — booking == immediate
 * confirmation. Using only refundable rates means we can always cancel for
 * free if the flight side fails or payment doesn't come through.
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const paymentService = require('./paymentService');
const notificationService = require('./notifications');

let supplierAdapter = null;
try {
  supplierAdapter = require('../adapters');
} catch (e) {
  logger.warn('Supplier adapter not loaded in bookingService', { error: e.message });
}

class BookingService {

  validatePackage(pkg, passengerDetails, guestPhone, guestEmail) {
    const transport = pkg.transport || {};
    const hotel      = pkg.hotel || {};
    const isFlightBooking = transport.supplier === 'travelduqa';
    const isHotelBooking  = hotel.supplier === 'hotelbeds';

    if ((isFlightBooking || isHotelBooking) && (!passengerDetails || passengerDetails.length === 0)) {
      return { valid: false, error: 'Passenger details are required to complete this booking.' };
    }
    if ((isFlightBooking || isHotelBooking) && !guestPhone) {
      return { valid: false, error: 'Phone number is required.' };
    }
    if (isFlightBooking && !guestEmail) {
      return { valid: false, error: 'Email is required for flight bookings.' };
    }
    if (isFlightBooking && transport.expiresAt && Date.now() > new Date(transport.expiresAt).getTime()) {
      return { valid: false, error: 'This flight offer has expired. Please search again for current prices.', code: 'OFFER_EXPIRED' };
    }
    if (isHotelBooking && hotel.isRefundable === false) {
      return { valid: false, error: 'This hotel rate is non-refundable and cannot be used in the combined booking flow. Please choose a refundable rate.', code: 'NON_REFUNDABLE_RATE' };
    }
    return { valid: true, isFlightBooking, isHotelBooking };
  }

  async initBooking({ bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, priceApproved = false }) {
    const transport = pkg.transport || {};
    const hotel      = pkg.hotel || {};
    const transfers  = pkg.transfers || {};
    const summary    = pkg.summary || {};

    const validation = this.validatePackage(pkg, passengerDetails, guestPhone, guestEmail);
    if (!validation.valid) {
      return { success: false, ...validation };
    }
    const { isFlightBooking, isHotelBooking } = validation;

    if (!supplierAdapter) {
      return { success: false, error: 'Booking system is temporarily unavailable. Please try again shortly.' };
    }

    let flightResult = null;
    let hotelResult  = null;
    let stage = 'pending';

    if (isFlightBooking) {
      try {
        await supplierAdapter.selectOffer({
          supplier: 'travelduqa',
          resultId: transport.resultId,
          offerId:  transport.offerId,
        });

        const passengersForBooking = passengerDetails.map((p, idx) => ({
          ...p,
          phone: idx === 0 ? guestPhone : undefined,
          email: idx === 0 ? guestEmail : undefined,
        }));

        flightResult = await supplierAdapter.book({
          supplier:          'travelduqa',
          resultId:          transport.resultId,
          offerId:           transport.offerId,
          passengerDetails:  passengersForBooking,
          totalAmount:        transport.price,
          currency:           transport.currency || 'KES',
          paymentType:        'hold',
          sendEticket:        false,
        });

        stage = 'flight_held';
        logger.info('Flight held', { bookingRef, supplierRef: flightResult?.supplierBookingReference });

      } catch (err) {
        const supplierMessage = err.response?.data?.message || err.message;
        logger.error('Flight hold failed', { bookingRef, error: supplierMessage });
        return {
          success: false,
          error: `We couldn't hold this flight with the airline (${supplierMessage}). Please search again.`,
          code: 'FLIGHT_HOLD_FAILED',
        };
      }
    }

    if (isHotelBooking) {
      // Reconcile the searched occupancy against the real DOB ages. If a
      // child's true age differs from what was searched, this silently
      // re-fetches a valid rateKey; if that reveals a price jump beyond
      // tolerance, we STOP here and surface it for approval before any
      // payment, rather than booking or charging.
      let recon;
      try {
        recon = await this._reconcileHotelOccupancy({ pkg, passengerDetails, priceApproved });
      } catch (err) {
        logger.error('Hotel occupancy reconciliation failed; using original rate', { bookingRef, error: err.message });
        recon = { guests: null, rateKey: hotel.rateKey, priceChanged: false };
      }

      if (recon.priceChanged && !priceApproved) {
        // Don't book the hotel, don't charge. If a flight was held, let it
        // expire (no charge) and persist the failed stage exactly as the
        // hotel-confirm-failed path does.
        if (flightResult) {
          await this._persistStage(bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, 'failed', flightResult, null);
        }
        return {
          success: false,
          code: 'PRICE_CHANGED',
          needsApproval: true,
          oldPrice:   recon.oldPrice,
          newPrice:   recon.newPrice,
          currency:   recon.currency,
          priceDelta: Number((recon.newPrice - recon.oldPrice).toFixed(2)),
          newRateKey: recon.rateKey,
          flightHeld: !!flightResult,
          message: `The hotel price changed from ${recon.currency} ${recon.oldPrice} to ${recon.currency} ${recon.newPrice} once the child's real age was applied. Re-initiate with priceApproved=true to continue at the new price.`,
        };
      }

      try {
        const leadGuest = { firstName: passengerDetails[0].firstName, lastName: passengerDetails[0].lastName };
        // Prefer the reconciled guests (type + age from DOB); fall back to a
        // plain mapping only if reconciliation couldn't build them.
        const guestsForHotel = recon.guests || passengerDetails.map(p => ({
          firstName: p.firstName,
          lastName:  p.lastName,
          type:      p.type === 'child' ? 'child' : 'adult',
          roomId:    1,
        }));
        const effectiveRateKey = recon.rateKey || hotel.rateKey;

        hotelResult = await supplierAdapter.book({
          supplier:        'hotelbeds',
          rateKey:         effectiveRateKey,
          holder:          leadGuest,
          guests:          guestsForHotel,
          clientReference: bookingRef,
          remark:          `Booked via Bodrless for ${agencyId}`,
        });

        // If a re-fetched rateKey was used, keep the package/hotel in sync so
        // persistence and the combined total reflect what was actually booked.
        if (recon.rateKey && recon.rateKey !== hotel.rateKey) {
          hotel.rateKey = recon.rateKey;
          if (recon.newPrice) hotel.totalRate = recon.newPrice;
        }

        stage = 'hotel_confirmed';
        logger.info('Hotel confirmed', { bookingRef, supplierRef: hotelResult?.supplierBookingReference });

      } catch (err) {
        const supplierMessage = err.response?.data?.message || err.message;
        logger.error('Hotel booking failed after flight hold', { bookingRef, error: supplierMessage });

        if (flightResult) {
          await this._persistStage(bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, 'failed', flightResult, null);
          return {
            success: false,
            error: `Your flight was held, but we couldn't confirm the hotel (${supplierMessage}). The flight hold will expire automatically — no charge has been made. Please try a different hotel.`,
            code: 'HOTEL_CONFIRM_FAILED',
            flightHeld: true,
          };
        }

        return { success: false, error: `We couldn't confirm the hotel (${supplierMessage}). Please try again.`, code: 'HOTEL_CONFIRM_FAILED' };
      }
    }

    if (!isFlightBooking && !isHotelBooking) {
      stage = 'hotel_confirmed';
    }

    const totalPrice = summary.totalPrice || 0;
    const currency    = summary.currency || 'KES';

    await this._persistStage(bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, stage, flightResult, hotelResult);

    return {
      success: true,
      bookingRef,
      stage,
      totalPrice,
      currency,
      flightHeld: !!flightResult,
      hotelConfirmed: !!hotelResult,
      message: `Flight + hotel reserved. Total due: ${currency} ${totalPrice.toLocaleString()}. Proceed to payment to confirm your booking.`,
    };
  }

  async triggerPayment({ bookingRef, phone, amount, currency, email, firstName, lastName }) {
    try {
      const result = await paymentService.triggerStkPush({
        bookingRef, phone, amount, email, firstName, lastName,
      });

      await supabase
        .from('bookings')
        .update({
          booking_stage: 'awaiting_payment',
          payment_invoice_id: result.invoiceId,
          payment_deadline: result.paymentDeadline,
        })
        .eq('booking_ref', bookingRef);

      logger.info('Payment triggered', { bookingRef, invoiceId: result.invoiceId });

      return {
        success: true,
        invoiceId: result.invoiceId,
        message: 'M-Pesa prompt sent to your phone. Please enter your PIN to complete payment.',
        paymentDeadline: result.paymentDeadline,
      };

    } catch (err) {
      logger.error('Failed to trigger payment', { bookingRef, error: err.message });
      return { success: false, error: `Could not initiate payment: ${err.message}` };
    }
  }

  // ─────────────────────────────────────────────
  // STEP 3 — CONFIRM PAYMENT
  // NOTIFICATION HOOK: this is the moment a booking becomes genuinely
  // confirmed (payment received, flight ticketed) — the right place
  // to fire notifyBookingConfirmed(), not initBooking() (flight/hotel
  // are only HELD at that point, payment hasn't landed yet). Wrapped
  // so a notification failure NEVER blocks or rolls back a
  // successful, paid booking — the booking is real regardless of
  // whether a hotel's WhatsApp number happened to be unreachable.
  // ─────────────────────────────────────────────
  async confirmPayment({ bookingRef }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (error || !booking) {
      return { success: false, error: 'Booking not found.' };
    }

    if (booking.supplier_order_id && supplierAdapter) {
      try {
        await supplierAdapter.completeHoldBooking({
          supplier: 'travelduqa',
          orderId:  booking.supplier_order_id,
          sendEticket: true,
        });
      } catch (err) {
        logger.error('Failed to complete TravelDuqa hold after payment', { bookingRef, error: err.message });
        return { success: false, error: 'Payment received, but we could not finalize the flight ticket. Our team has been notified — please contact support.' };
      }
    }

    await supabase
      .from('bookings')
      .update({ booking_stage: 'paid', status: 'confirmed', payment_status: 'paid' })
      .eq('booking_ref', bookingRef);

    logger.info('Booking fully confirmed after payment', { bookingRef });

    // Fire-and-log, not fire-and-await-inline-with-the-response — a
    // notification failure (missing contact info, WhatsApp API
    // hiccup, etc.) must never make a successfully PAID booking look
    // like it failed to the traveler calling this method.
    this._fireBookingConfirmedNotifications(booking).catch(err => {
      logger.error('Booking confirmation notifications failed (booking itself is still confirmed)', {
        bookingRef, error: err.message,
      });
    });

    return { success: true, bookingRef, status: 'confirmed' };
  }

  // ─────────────────────────────────────────────
  // FIRE BOOKING-CONFIRMED NOTIFICATIONS
  // Maps the bookings row's stored JSON columns (flight_details,
  // hotel_details, transfer_details — all persisted in _persistStage
  // below) into the shape notificationService.notifyBookingConfirmed
  // expects. Kept separate so confirmPayment's main flow stays
  // focused on the supplier/payment logic.
  // ─────────────────────────────────────────────
  async _fireBookingConfirmedNotifications(booking) {
    const transferList = Array.isArray(booking.transfer_details)
      ? booking.transfer_details
      : (booking.transfer_details ? [booking.transfer_details] : []);

    await notificationService.notifyBookingConfirmed({
      booking: {
        bookingRef: booking.booking_ref,
        agencyId: booking.agency_id,
        guestName: booking.guest_name,
        guestPhone: booking.guest_phone,
        guestEmail: booking.guest_email,
        origin: booking.origin,
        destination: booking.destination,
        checkIn: booking.flight_details?.departureTime || null,
        checkOut: null,
        passengers: booking.passengers,
        totalPrice: booking.total_price,
        currency: booking.currency,
        specialRequests: null,
      },
      flight: booking.flight_details || null,
      hotel: booking.hotel_details || null,
      transfers: transferList,
    });
  }

  async failPayment({ bookingRef }) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (booking?.hotel_supplier_reference && supplierAdapter) {
      try {
        await supplierAdapter.cancel({ supplier: 'hotelbeds', bookingRef: booking.hotel_supplier_reference });
        logger.info('Hotel cancelled after payment failure', { bookingRef });
      } catch (err) {
        logger.error('Failed to cancel hotel after payment failure', { bookingRef, error: err.message });
      }
    }

    await supabase
      .from('bookings')
      .update({ booking_stage: 'failed', status: 'cancelled', payment_status: 'failed' })
      .eq('booking_ref', bookingRef);

    return { success: true, bookingRef, status: 'cancelled' };
  }

  // ─────────────────────────────────────────────
  // CALCULATE AGE from a date of birth (years, floored). Returns null
  // for missing/unparseable dates so callers can fall back safely.
  // ─────────────────────────────────────────────
  _calculateAge(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age >= 0 && age < 120 ? age : null;
  }

  // ─────────────────────────────────────────────
  // RECONCILE HOTEL OCCUPANCY (search ages vs real DOB ages)
  // Builds the HotelBeds guest list (type + age from each passenger's DOB)
  // and, if a child's true age differs from what was searched, silently
  // re-fetches a fresh rateKey for that exact hotel at the corrected
  // occupancy. Returns:
  //   { guests, rateKey, priceChanged, oldPrice?, newPrice?, currency? }
  // priceChanged is true ONLY when a re-fetch revealed a price move beyond
  // tolerance — the caller then stops and asks the traveler to approve
  // BEFORE any payment. Every failure path falls back to the original
  // rateKey and never silently mischarges.
  // ─────────────────────────────────────────────
  async _reconcileHotelOccupancy({ pkg, passengerDetails, priceApproved }) {
    const hotel = pkg.hotel || {};
    const occ = (pkg.summary && pkg.summary.occupancy) || null;

    // Guests with type + age derived from DOB (authoritative at booking).
    const guests = (passengerDetails || []).map(p => {
      const dob = p.dateOfBirth || p.date_of_birth || p.dob || null;
      const age = this._calculateAge(dob);
      const isChild = age != null && age < 18;
      const g = {
        firstName: p.firstName || p.first_name,
        lastName:  p.lastName  || p.last_name,
        roomId:    1,
        type:      isChild ? 'child' : 'adult',
      };
      if (isChild && age != null) g.age = age;
      return g;
    });

    // Nothing to reconcile against, or no re-fetchable hotel -> use as-is.
    if (!occ || !hotel.hotelCode || !hotel.rateKey || typeof supplierAdapter?.refetchRate !== 'function') {
      return { guests, rateKey: hotel.rateKey, priceChanged: false };
    }

    const trueChildAges = guests
      .filter(g => g.type === 'child' && g.age != null)
      .map(g => g.age).sort((a, b) => a - b);
    const searchedChildAges = (Array.isArray(occ.childAges) ? occ.childAges : [])
      .slice().sort((a, b) => a - b);

    const agesMatch =
      trueChildAges.length === searchedChildAges.length &&
      trueChildAges.every((a, i) => a === searchedChildAges[i]);

    if (agesMatch) {
      return { guests, rateKey: hotel.rateKey, priceChanged: false };
    }

    // Ages drifted -> re-fetch a valid rate for this exact hotel.
    const adults = Math.max(1, guests.filter(g => g.type === 'adult').length);
    let refetch = null;
    try {
      refetch = await supplierAdapter.refetchRate({
        supplier:  'hotelbeds',
        hotelCode: hotel.hotelCode,
        checkIn:   occ.checkIn,
        checkOut:  occ.checkOut,
        nights:    occ.nights || pkg.summary?.nights || 1,
        adults,
        children:  trueChildAges.length,
        childAges: trueChildAges,
        rooms:     1,
      });
    } catch (err) {
      logger.error('Hotel rate re-fetch threw; using original rateKey', { hotelCode: hotel.hotelCode, error: err.message });
    }

    if (!refetch || !refetch.rateKey) {
      logger.warn('Hotel rate re-fetch returned nothing; using original rateKey', { hotelCode: hotel.hotelCode });
      return { guests, rateKey: hotel.rateKey, priceChanged: false };
    }

    const oldPrice = Number(hotel.totalRate || (hotel.pricePerNight || 0) * (occ.nights || pkg.summary?.nights || 1) || 0);
    const newPrice = Number(refetch.totalRate || 0);
    const tolerance = Math.max(2, oldPrice * 0.02); // 2 currency units OR 2%
    const priceChanged = oldPrice > 0 && newPrice > 0 && Math.abs(newPrice - oldPrice) > tolerance;

    if (priceChanged && !priceApproved) {
      return {
        guests,
        rateKey: refetch.rateKey,
        priceChanged: true,
        oldPrice, newPrice,
        currency: refetch.currency || hotel.currency || 'EUR',
      };
    }

    logger.info('Hotel rate re-fetched for corrected child age(s)', { hotelCode: hotel.hotelCode, oldPrice, newPrice, priceApproved });
    return { guests, rateKey: refetch.rateKey, priceChanged: false, oldPrice, newPrice, currency: refetch.currency || hotel.currency };
  }

  async _persistStage(bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, stage, flightResult, hotelResult) {
    const transport = pkg.transport || {};
    const hotel      = pkg.hotel || {};
    const transfers  = pkg.transfers || {};
    const summary    = pkg.summary || {};

    try {
      await supabase.from('bookings').upsert({
        booking_ref: bookingRef,
        agency_id: agencyId,
        guest_name: guestName,
        guest_phone: guestPhone,
        guest_email: guestEmail,
        destination: transport.destination || summary.destination || null,
        origin: transport.origin || summary.origin || null,
        nights: summary.nights || 0,
        passengers: passengerDetails?.length || summary.passengers || 1,
        passenger_details: passengerDetails || null,
        total_price: summary.totalPrice || 0,
        currency: summary.currency || 'KES',
        status: stage === 'failed' ? 'cancelled' : 'pending',
        booking_status: stage,
        booking_stage: stage,
        payment_status: 'pending',
        supplier_status: stage,
        supplier_booking_reference: flightResult?.supplierBookingReference || null,
        supplier_order_id: flightResult?.orderId || null,
        hotel_supplier_reference: hotelResult?.supplierBookingReference || null,
        hotel_rate_key: hotel.rateKey || null,
        flight_hold_expires_at: transport.expiresAt || null,
        channel: channel || 'widget',
        flight_details: transport || null,
        hotel_details: hotel || null,
        transfer_details: transfers || null,
        package_snapshot: pkg || null,
      }, { onConflict: 'booking_ref' });
    } catch (err) {
      logger.error('CRITICAL: supplier action succeeded but Supabase persist failed', {
        bookingRef, stage, error: err.message, flightResult, hotelResult,
      });
      throw err;
    }
  }
}

module.exports = new BookingService();