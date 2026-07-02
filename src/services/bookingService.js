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
        let effectiveRateKey = recon.rateKey || hotel.rateKey;

        // BUG FIX (found via close reading of the HotelBeds
        // certification "Best Practices" doc, 2026-07-02): checkRate()
        // has existed in hotelbeds.js since earlier this session but
        // was NEVER actually called anywhere — every booking skipped
        // straight to book() regardless of rateType. Per the
        // documented correct workflow ("if rateType == RECHECK then
        // send ONE CheckRates Request... Send Booking request") and
        // Best Practices ("DO NOT send a CheckRates together with a
        // booking request... only if completion code was 200, then
        // proceed"), a RECHECK-type rate MUST be re-validated via
        // CheckRates before booking — skipping it isn't just a missed
        // opportunity to fetch rateComments, it's a workflow
        // violation the certification explicitly tests for.
        //
        // Only fires for rateType === 'RECHECK' — a BOOKABLE rate
        // never calls this here (rateComments for those are captured
        // directly from the booking response instead, see
        // hotelbeds.js's book() — calling CheckRates for a BOOKABLE
        // rate "just for extra info" without needing it is itself a
        // Best Practices violation: "only send a CheckRates request
        // if you need extra info like RateComments" — we don't need
        // to, since book() already gets it).
        //
        // On failure, the booking does NOT proceed — matches "only
        // if completion code was 200, then you can proceed to the
        // confirmation" exactly.
        if (hotel.rateType === 'RECHECK') {
          logger.info('Hotel rate is RECHECK — calling CheckRates before booking', { bookingRef, rateKey: effectiveRateKey?.slice(0, 40) });
          let checkRateResult;
          try {
            checkRateResult = await supplierAdapter.checkRate?.({ supplier: 'hotelbeds', rateKey: effectiveRateKey }) ?? null;
          } catch (err) {
            logger.error('CheckRates call failed — booking cannot proceed for a RECHECK rate', { bookingRef, error: err.message });
            if (flightResult) {
              await this._persistStage(bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, 'failed', flightResult, null);
            }
            return {
              success: false,
              error: `This rate could no longer be verified with the hotel (${err.message}). Please search again for current availability.`,
              code: 'RATE_RECHECK_FAILED',
              flightHeld: !!flightResult,
            };
          }

          if (!checkRateResult || !checkRateResult.rateKey) {
            logger.error('CheckRates returned no usable rate — booking cannot proceed', { bookingRef });
            if (flightResult) {
              await this._persistStage(bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, 'failed', flightResult, null);
            }
            return {
              success: false,
              error: 'This rate is no longer available. Please search again for current availability.',
              code: 'RATE_RECHECK_FAILED',
              flightHeld: !!flightResult,
            };
          }

          // Use the (possibly updated) rateKey from CheckRates for
          // the actual booking call — per "DO NOT parse or work in
          // any way with the rateKey", it's copied through verbatim,
          // never modified/reconstructed.
          effectiveRateKey = checkRateResult.rateKey;
          // Capture rateComments here too — CheckRates is the
          // documented source for RECHECK rates specifically (the
          // book()-response capture only covers BOOKABLE rates,
          // which never go through this branch).
          hotel.rateComments = checkRateResult.rateComments || hotel.rateComments || null;
          hotel.cancellationPolicies = checkRateResult.cancellationPolicies?.length
            ? checkRateResult.cancellationPolicies
            : hotel.cancellationPolicies;
        }

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

        // BUG FIX (found via HotelBeds cert dry-run testing, 2026-07-02):
        // hotelResult (the CONFIRMED booking response) carries
        // authoritative data the search-time `hotel` object never
        // had — real checkIn/checkOut dates, and the mandatory
        // rateComments text (Cert 3.9/4.4). Neither was ever merged
        // back into `hotel` before, so a voucher built from
        // pkg.hotel showed blank dates and no rate comments even
        // though HotelBeds genuinely returned both at booking time.
        // `hotel` here is the SAME object reference as pkg.hotel (see
        // `const hotel = pkg.hotel || {}` above — no copy is made
        // when pkg.hotel is truthy), so mutating it here flows
        // through automatically to _persistStage's hotel_details and
        // package_snapshot, and from there to the voucher.
        if (hotelResult) {
          hotel.checkIn        = hotelResult.checkIn        || hotel.checkIn        || null;
          hotel.checkOut       = hotelResult.checkOut       || hotel.checkOut       || null;
          hotel.rateComments   = hotelResult.rateComments   || hotel.rateComments   || null;
          hotel.address        = hotel.address              || hotelResult.hotelAddress || null;
          hotel.phone          = hotel.phone                || hotelResult.hotelPhone   || null;
          hotel.email          = hotel.email                || hotelResult.hotelEmail   || null;
          hotel.cancellationPolicies = hotel.cancellationPolicies?.length
            ? hotel.cancellationPolicies
            : (hotelResult.cancellationPolicies || []);
          hotel.supplier_tag   = hotelResult.supplier_tag   || null;
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
      checkIn:                  hotelDetails.checkIn         || packageSnapshot.summary?.occupancy?.checkIn  || outboundTransport?.departureTime || null,
      checkOut:                 hotelDetails.checkOut        || packageSnapshot.summary?.occupancy?.checkOut || null,
      nights:                   booking.nights               || null,
      roomType:                 hotelDetails.roomType        || null,
      boardType:                hotelDetails.mealPlan        || hotelDetails.boardType || null,
      guestName:                booking.guest_name           || null,
      guestEmail:               booking.guest_email          || null,
      guestPhone:               booking.guest_phone          || null,
      passengers:               booking.passengers           || 1,
      // CERT 4.3 FIX (found via close reading of the HotelBeds
      // certification checklist, 2026-07-02): "At least one pax
      // name per room... If children are present, children's ages
      // should be informed" — MANDATORY. Previously `passengers`
      // was only ever a bare count ("4 passengers"), no individual
      // names, no ages anywhere on the voucher. booking.passenger_details
      // (persisted by _persistStage from the real data collected at
      // booking time) has everything needed — just was never passed
      // through to the voucher before. Age is computed here (not
      // trusted from whatever was typed at booking time) using the
      // same _calculateAge logic already used for HotelBeds
      // reconciliation, so the voucher always shows a REAL, current
      // age from DOB, consistent with what was actually booked.
      passengerList: (Array.isArray(booking.passenger_details) ? booking.passenger_details : []).map(p => {
        const dob = p.dateOfBirth || p.date_of_birth || p.dob || null;
        const age = this._calculateAge(dob);
        const isChild = (p.type === 'child') || (age != null && age < 18);
        return {
          name: `${p.firstName || p.first_name || ''} ${p.lastName || p.last_name || ''}`.trim() || null,
          type: isChild ? 'child' : 'adult',
          age:  isChild ? age : null, // only surfaced for children per cert 4.3 — adults don't need an age shown
        };
      }).filter(p => p.name),
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

  // ─────────────────────────────────────────────
  // CANCEL A CONFIRMED BOOKING
  // Distinct from failPayment() above — that method is for a
  // booking that was HELD but never successfully paid (cancel the
  // tentative hotel hold, no money was ever collected). This method
  // is for a booking that IS confirmed and PAID, being cancelled
  // afterward by the traveler (or ops) — a fundamentally different
  // situation: HotelBeds' own cancellation policy may impose a fee,
  // and a refund may be owed on money that was genuinely collected.
  //
  // REFUND HANDLING — INTENTIONALLY NOT AUTOMATED YET: paymentService.js
  // (IntaSend) currently has no refund method — only triggerStkPush/
  // checkStatus. This function correctly CALCULATES what's owed
  // (per HotelBeds' real cancellationPolicies on the booking) and
  // raises a tracked alert for manual processing, rather than
  // either (a) silently claiming to have refunded money that was
  // never actually sent back, or (b) blocking the cancellation
  // itself on refund automation that doesn't exist. Add a real
  // IntaSend refund call here once that capability exists.
  // ─────────────────────────────────────────────
  async cancelConfirmedBooking({ bookingRef, requestedBy = 'traveler' }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (error || !booking) {
      return { success: false, error: 'Booking not found.' };
    }

    if (booking.status === 'cancelled') {
      return { success: false, error: 'This booking is already cancelled.', alreadyCancelled: true };
    }

    if (booking.status !== 'confirmed') {
      return { success: false, error: 'This booking is not in a confirmed state and cannot be cancelled this way.' };
    }

    // Determine cancellation fee from HotelBeds' own real
    // cancellationPolicies (persisted on hotel_details — each entry
    // is { amount, from }: if cancelling on/after `from`, `amount`
    // becomes chargeable). Multiple policy tiers are possible
    // (increasing fees closer to check-in) — take the highest
    // applicable fee, i.e. the most recent tier whose `from` date
    // has already passed.
    const policies = booking.hotel_details?.cancellationPolicies || [];
    const now = new Date();
    let feeApplies = false;
    let feeAmount = 0;
    let feeCurrency = booking.currency || 'KES';
    for (const p of policies) {
      if (p.from && now >= new Date(p.from)) {
        const amt = Number(p.amount) || 0;
        if (amt >= feeAmount) {
          feeApplies = true;
          feeAmount = amt;
          feeCurrency = p.currencyId || feeCurrency;
        }
      }
    }

    // Same honest-reporting pattern as failPayment()'s fix — never
    // silently claim the real supplier-side cancellation succeeded
    // when it didn't.
    let supplierCancelSucceeded = null;
    let supplierCancelError = null;

    if (booking.hotel_supplier_reference && supplierAdapter) {
      try {
        await supplierAdapter.cancel({ supplier: 'hotelbeds', bookingRef: booking.hotel_supplier_reference });
        logger.info('Confirmed booking cancelled on HotelBeds', { bookingRef });
        supplierCancelSucceeded = true;
      } catch (err) {
        logger.error('Failed to cancel confirmed booking on HotelBeds', { bookingRef, error: err.message });
        supplierCancelSucceeded = false;
        supplierCancelError = err.message;

        tracking.alert({
          type:     'hotel_cancel_failed',
          severity: 'critical',
          title:    `Confirmed-booking cancellation failed on HotelBeds' side — ${bookingRef}`,
          detail:   `Traveler-requested cancellation recorded in Supabase, but the real HotelBeds booking (ref: ${booking.hotel_supplier_reference}) may still be CONFIRMED. Manual follow-up with HotelBeds support required.`,
          context:  { bookingRef, hotelSupplierReference: booking.hotel_supplier_reference, error: err.message, requestedBy },
          agencyId: booking.agency_id,
          bookingRef,
        });
      }
    }

    await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        booking_stage: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by: requestedBy,
      })
      .eq('booking_ref', bookingRef);

    const totalPaid = Number(booking.total_price || 0);
    const refundAmount = feeApplies ? Math.max(0, totalPaid - feeAmount) : totalPaid;

    // Flag for manual refund processing whenever money was actually
    // collected (payment_status === 'paid') — see file-header note
    // on why this isn't automated yet.
    if (booking.payment_status === 'paid' && refundAmount > 0) {
      tracking.alert({
        type:     'manual_refund_needed',
        severity: 'warning',
        title:    `Refund needed for cancelled booking ${bookingRef}`,
        detail:   `Traveler paid ${booking.currency || 'KES'} ${totalPaid.toLocaleString()}. Cancellation fee: ${feeCurrency} ${feeAmount.toLocaleString()}. Refund owed (manual processing required — no automated refund path exists yet): ${feeCurrency} ${refundAmount.toLocaleString()}.`,
        context:  { bookingRef, totalPaid, feeAmount, refundAmount, guestPhone: booking.guest_phone, requestedBy },
        agencyId: booking.agency_id,
        bookingRef,
      });
    }

    return {
      success: true,
      bookingRef,
      status: 'cancelled',
      supplierCancelSucceeded,
      supplierCancelError,
      feeApplies,
      feeAmount,
      feeCurrency,
      refundAmount,
      refundCurrency: feeCurrency,
      refundNote: refundAmount > 0
        ? 'Refund will be processed by our team — this is not yet automated, so allow some time for it to reach you.'
        : null,
    };
  }

  async failPayment({ bookingRef }) {
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    // BUG FIX (found via HotelBeds cert dry-run testing, 2026-07-02):
    // this previously always returned success:true regardless of
    // whether the real HotelBeds cancellation actually succeeded —
    // a genuine supplier-side failure (e.g. a 500 from HotelBeds)
    // was silently swallowed, leaving Supabase saying "cancelled"
    // while the real hotel booking could still be CONFIRMED on
    // HotelBeds' own system. That's exactly the kind of mismatch a
    // certification reviewer (or a real guest showing up to a
    // "cancelled" reservation) would catch.
    //
    // Fix: still transition the internal Supabase state regardless
    // (a booking must never get stuck in limbo just because the
    // supplier call failed) — but now honestly report whether the
    // supplier-side cancel actually worked, and raise a CRITICAL
    // alert when it didn't, so it's visible and actionable (manual
    // follow-up with HotelBeds support) rather than silently lost.
    let supplierCancelSucceeded = null; // null = not attempted (no hotel_supplier_reference on this booking)
    let supplierCancelError = null;

    if (booking?.hotel_supplier_reference && supplierAdapter) {
      try {
        await supplierAdapter.cancel({ supplier: 'hotelbeds', bookingRef: booking.hotel_supplier_reference });
        logger.info('Hotel cancelled after payment failure', { bookingRef });
        supplierCancelSucceeded = true;
      } catch (err) {
        logger.error('Failed to cancel hotel after payment failure', { bookingRef, error: err.message });
        supplierCancelSucceeded = false;
        supplierCancelError = err.message;

        tracking.alert({
          type:     'hotel_cancel_failed',
          severity: 'critical',
          title:    `Hotel cancellation failed on HotelBeds' side — ${bookingRef}`,
          detail:   `Supabase now shows this booking as cancelled, but the real HotelBeds booking (ref: ${booking.hotel_supplier_reference}) may still be CONFIRMED. Manual follow-up with HotelBeds support may be required.`,
          context:  { bookingRef, hotelSupplierReference: booking.hotel_supplier_reference, error: err.message },
          agencyId: booking.agency_id,
          bookingRef,
        });
      }
    }

    await supabase
      .from('bookings')
      .update({ booking_stage: 'failed', status: 'cancelled', payment_status: 'failed' })
      .eq('booking_ref', bookingRef);

    return {
      success: true, // internal state transition always completes
      bookingRef,
      status: 'cancelled',
      supplierCancelSucceeded, // the actually-honest signal — check this, not just `success`
      supplierCancelError,
    };
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
        // BUG FIX (found via HotelBeds cert dry-run testing,
        // 2026-07-02): persisting the locally-coerced `transport`/
        // `transfers` variables (which are `pkg.transport || {}`,
        // used above ONLY for safe property access like
        // transport.destination) meant a genuinely absent flight/
        // transfer (null, e.g. a hotel-only booking) got stored as
        // an empty object `{}` instead — which is TRUTHY. Downstream,
        // bookingService._fetchAgencyAndFireVoucher checks
        // `booking.flight_details` as a signal for "is there a
        // flight to show" — `{}` passed that check, producing a
        // voucher with a broken "Outbound Flight" section showing
        // "— → — undefined stop" for bookings that never had a
        // flight at all. Persist pkg.transport/pkg.transfers
        // directly instead, preserving real null when there
        // genuinely is none.
        flight_details: pkg.transport || null,
        hotel_details: hotel || null,
        transfer_details: pkg.transfers || null,
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