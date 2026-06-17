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
 *   2. triggerPayment() — STUBBED. Will trigger M-Pesa STK push for the
 *                         combined total once Daraja credentials exist.
 *   3. confirmPayment() — called by the M-Pesa callback/webhook (or, for
 *                         now, manually) once payment succeeds. Converts
 *                         the TravelDuqa hold into a ticketed booking.
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

let supplierAdapter = null;
try {
  supplierAdapter = require('../adapters');
} catch (e) {
  logger.warn('Supplier adapter not loaded in bookingService', { error: e.message });
}

class BookingService {

  // ─────────────────────────────────────────────
  // VALIDATE PACKAGE BEFORE TOUCHING ANY SUPPLIER
  // ─────────────────────────────────────────────
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

  // ─────────────────────────────────────────────
  // STEP 1 — INIT BOOKING
  // Flight hold first, then hotel confirm. Rolls back the flight hold
  // (lets it expire — TravelDuqa holds have no cancellation cost) if the
  // hotel step fails, and tells the caller plainly what happened.
  // ─────────────────────────────────────────────
  async initBooking({ bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel }) {
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

    // ── Step 1: Hold the flight ──
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

    // ── Step 2: Confirm the hotel (refundable rate only) ──
    if (isHotelBooking) {
      try {
        const leadGuest = { firstName: passengerDetails[0].firstName, lastName: passengerDetails[0].lastName };
        const guestsForHotel = passengerDetails.map(p => ({
          firstName: p.firstName,
          lastName:  p.lastName,
          type:      p.type === 'child' ? 'child' : 'adult',
          roomId:    1,
        }));

        hotelResult = await supplierAdapter.book({
          supplier:        'hotelbeds',
          rateKey:         hotel.rateKey,
          holder:          leadGuest,
          guests:          guestsForHotel,
          clientReference: bookingRef,
          remark:          `Booked via Bodrless for ${agencyId}`,
        });

        stage = isFlightBooking ? 'hotel_confirmed' : 'hotel_confirmed';
        logger.info('Hotel confirmed', { bookingRef, supplierRef: hotelResult?.supplierBookingReference });

      } catch (err) {
        const supplierMessage = err.response?.data?.message || err.message;
        logger.error('Hotel booking failed after flight hold', { bookingRef, error: supplierMessage });

        // Flight hold has no cancellation cost — we simply let it expire
        // naturally rather than calling an explicit cancel, since TravelDuqa
        // holds auto-release after their expiry window with no penalty.
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
      stage = 'hotel_confirmed'; // Supabase-only package, nothing to hold — proceed straight to payment step
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

  // ─────────────────────────────────────────────
  // STEP 2 — TRIGGER PAYMENT (STUBBED)
  // Wire this up to M-Pesa Daraja STK push once credentials are ready.
  // For now, returns a stub response so the flow can be tested end-to-end
  // by manually calling confirmPayment() to simulate a successful charge.
  // ─────────────────────────────────────────────
  async triggerPayment({ bookingRef, phone, amount, currency }) {
    logger.info('STUB: would trigger M-Pesa STK push here', { bookingRef, phone, amount, currency });

    await supabase
      .from('bookings')
      .update({ booking_stage: 'awaiting_payment' })
      .eq('booking_ref', bookingRef);

    return {
      success: true,
      stubbed: true,
      message: 'Payment step is not yet live — M-Pesa integration pending. Call confirmPayment() manually to simulate success in testing.',
    };
  }

  // ─────────────────────────────────────────────
  // STEP 3 — CONFIRM PAYMENT
  // Call this once the M-Pesa callback confirms payment received.
  // Converts the TravelDuqa hold into a ticketed booking.
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
    return { success: true, bookingRef, status: 'confirmed' };
  }

  // ─────────────────────────────────────────────
  // PAYMENT FAILED / TIMED OUT
  // Cancels the hotel (refundable, so free) and lets the flight hold expire.
  // ─────────────────────────────────────────────
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
  // PERSIST CURRENT STAGE TO SUPABASE
  // ─────────────────────────────────────────────
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