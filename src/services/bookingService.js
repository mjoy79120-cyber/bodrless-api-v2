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
const tracking = require('./trackingService');
const voucherService = require('./voucherService');

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
        tracking.alert({
          type:       'flight_hold_failed',
          severity:   'error',
          title:      `Flight hold failed — ${bookingRef}`,
          detail:     supplierMessage,
          context:    { bookingRef, offerId: transport.offerId, resultId: transport.resultId },
          agencyId,
          bookingRef,
          channel,
        });
        return {
          success: false,
          error: `We couldn't hold this flight with the airline (${supplierMessage}). Please search again.`,
          code: 'FLIGHT_HOLD_FAILED',
        };
      }
    }

    if (isHotelBooking) {
      let recon;
      try {
        recon = await this._reconcileHotelOccupancy({ pkg, passengerDetails, priceApproved });
      } catch (err) {
        logger.error('Hotel occupancy reconciliation failed; using original rate', { bookingRef, error: err.message });
        recon = { guests: null, rateKey: hotel.rateKey, priceChanged: false };
      }

      if (recon.priceChanged && !priceApproved) {
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

        if (recon.rateKey && recon.rateKey !== hotel.rateKey) {
          hotel.rateKey = recon.rateKey;
          if (recon.newPrice) hotel.totalRate = recon.newPrice;
        }

        stage = 'hotel_confirmed';
        logger.info('Hotel confirmed', { bookingRef, supplierRef: hotelResult?.supplierBookingReference });

      } catch (err) {
        const supplierMessage = err.response?.data?.message || err.message;
        logger.error('Hotel booking failed after flight hold', { bookingRef, error: supplierMessage });

        tracking.alert({
          type:       flightResult ? 'hotel_confirm_failed' : 'booking_failed',
          severity:   flightResult ? 'critical' : 'error',
          title:      flightResult
            ? `Hotel failed after flight hold — ${bookingRef}`
            : `Hotel booking failed — ${bookingRef}`,
          detail:     supplierMessage,
          context:    { bookingRef, rateKey: hotel.rateKey, hotelCode: hotel.hotelCode, flightHeld: !!flightResult },
          agencyId,
          bookingRef,
          channel,
        });

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
  // This is the moment a booking becomes genuinely confirmed —
  // payment received, flight ticketed. Vouchers fire here.
  //
  // Two voucher sends:
  //   1. Immediately on confirmation (booking confirmed, pre-payment
  //      details already locked in at initBooking)
  //   2. A second send with resend:true is triggered from the IntaSend
  //      webhook after this returns, so the traveler gets a clear
  //      "payment confirmed" message with their voucher attached.
  //      The webhook handles that separately so this method stays
  //      focused on the supplier/payment flow.
  //
  // Both are fire-and-forget — a voucher failure NEVER blocks or
  // rolls back a successfully paid booking.
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

    const sessionId = booking.trip_params?.sessionId || null;
    tracking.markConverted({ sessionId, bookingRef });

    // Fetch agency for voucher delivery (email copy + WhatsApp number)
    // and notifications. Fire both async so neither can block or
    // roll back a successfully paid booking.
    this._fetchAgencyAndFireVoucher(booking, false).catch(err =>
      logger.error('Voucher/notification fire failed (booking still confirmed)', { bookingRef, error: err.message })
    );

    return { success: true, bookingRef, status: 'confirmed' };
  }

  // ─────────────────────────────────────────────
  // FETCH AGENCY AND FIRE VOUCHER + NOTIFICATIONS
  // Fetches the agency row (needed for email copy recipient,
  // WhatsApp phone_number_id, and agency name on the voucher),
  // then fires both the voucher delivery and the existing
  // notifyBookingConfirmed flow in parallel. Separated from
  // confirmPayment so that function stays readable.
  // ─────────────────────────────────────────────
  async _fetchAgencyAndFireVoucher(booking, isResend) {
    let agency = null;
    try {
      const { data } = await supabase
        .from('agencies')
        .select('id,name,email,whatsapp_phone_number_id')
        .eq('id', booking.agency_id)
        .single();
      agency = data;
    } catch (err) {
      logger.warn('Could not fetch agency for voucher', { agencyId: booking.agency_id, error: err.message });
    }

    // Build the booking shape voucherService expects.
    //
    // BUG FIX: this previously never included a `flight_details` key
    // at all — voucherService._buildVoucherData reads
    // `booking.flight_details || hotel?.flight`, and neither existed
    // here, so `flight` was ALWAYS null and NO transport info (flight,
    // bus, or train — outbound or return) ever appeared on any
    // voucher sent through this path. hotel info survived only
    // because it's passed separately via the `hotel` param below,
    // which _buildVoucherData happens to fall back to.
    //
    // Fix: package_snapshot (stored in full by _persistStage — see
    // `package_snapshot: pkg || null`) is the complete original
    // package, including pkg.transport (outbound, whatever mode:
    // flight/bus/train) and pkg.returnTransport (return leg,
    // independently searched — see engine.js's per-leg
    // _searchFlights/_searchBuses/_searchTrain). Falls back to the
    // flight_details column (outbound only, no return leg) if
    // package_snapshot is somehow missing on an older row.
    const packageSnapshot  = booking.package_snapshot || {};
    const outboundTransport = packageSnapshot.transport       || booking.flight_details || null;
    const returnTransport   = packageSnapshot.returnTransport || null;

    // voucherService expects the return leg nested as `.returnLeg` on
    // the outbound object (see its _buildVoucherData/HTML/WhatsApp
    // rendering, all already mode-aware for flight/bus/train) — this
    // is the one place that shape gets assembled from the two
    // separately-searched leg objects.
    const flightDetailsForVoucher = outboundTransport
      ? { ...outboundTransport, returnLeg: returnTransport || null }
      : null;

    // Build the booking shape voucherService expects from the persisted
    // bookings row — hotel_details and flight_details are the raw supplier
    // response objects stored in _persistStage.
    const hotelDetails = booking.hotel_details || {};
    const voucherBooking = {
      supplierBookingReference: booking.hotel_supplier_reference || booking.supplier_booking_reference,
      clientReference:          booking.booking_ref,
      status:                   'CONFIRMED',
      confirmedAt:              new Date().toISOString(),
      flight_details:           flightDetailsForVoucher,
      hotelName:                hotelDetails.name            || null,
      hotelAddress:             hotelDetails.address         || null,
      hotelPhone:               hotelDetails.phone           || null,
      checkIn:                  hotelDetails.checkIn         || outboundTransport?.departureTime || null,
      checkOut:                 hotelDetails.checkOut        || null,
      nights:                   booking.nights               || null,
      roomType:                 hotelDetails.roomType        || null,
      boardType:                hotelDetails.mealPlan        || hotelDetails.boardType || null,
      guestName:                booking.guest_name           || null,
      guestEmail:               booking.guest_email          || null,
      guestPhone:               booking.guest_phone          || null,
      passengers:               booking.passengers           || 1,
      totalAmount:              hotelDetails.totalRate       || booking.total_price || 0,
      currency:                 hotelDetails.currency        || booking.currency || 'EUR',
      rateComments:             hotelDetails.rateComments    || null,
      cancellationPolicies:     hotelDetails.cancellationPolicies || [],
      promotions:               hotelDetails.promotions      || [],
      supplier_tag:             hotelDetails.supplier_tag    || null,
      booking_ref:              booking.booking_ref,
    };

    // Fire voucher and existing booking-confirmed notifications in parallel.
    // Neither can fail the other.
    await Promise.allSettled([
      voucherService.sendVoucher({
        booking: voucherBooking,
        hotel:   hotelDetails,
        agency,
        resend:  isResend,
      }),
      this._fireBookingConfirmedNotifications(booking),
    ]);
  }

  async _fireBookingConfirmedNotifications(booking) {
    const transferList = Array.isArray(booking.transfer_details)
      ? booking.transfer_details
      : (booking.transfer_details ? [booking.transfer_details] : []);

    await notificationService.notifyBookingConfirmed({
      booking: {
        bookingRef:   booking.booking_ref,
        agencyId:     booking.agency_id,
        guestName:    booking.guest_name,
        guestPhone:   booking.guest_phone,
        guestEmail:   booking.guest_email,
        origin:       booking.origin,
        destination:  booking.destination,
        checkIn:      booking.flight_details?.departureTime || null,
        checkOut:     null,
        passengers:   booking.passengers,
        totalPrice:   booking.total_price,
        currency:     booking.currency,
        specialRequests: null,
      },
      flight:    booking.flight_details    || null,
      hotel:     booking.hotel_details     || null,
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

  async _reconcileHotelOccupancy({ pkg, passengerDetails, priceApproved }) {
    const hotel = pkg.hotel || {};
    const occ = (pkg.summary && pkg.summary.occupancy) || null;

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
    const tolerance = Math.max(2, oldPrice * 0.02);
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