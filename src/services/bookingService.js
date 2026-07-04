/**
 * BOOKING SERVICE
 * ─────────────────────────────────────────────────────────────
 * Shared booking logic used by both the widget (/api/trips/book-init,
 * /api/trips/pay) and the WhatsApp conversational booking flow.
 *
 * SEQUENCE (flight-first, single combined payment):
 *   1. initBooking()   — hold flight (TravelDuqa or Duffel), then confirm
 *                         hotel (HotelBeds, refundable rate only) and
 *                         transfer if present. No payment yet.
 *   2. triggerPayment() — real IntaSend M-Pesa STK push for the combined
 *                         total. Sets a payment_deadline used by the
 *                         sweeper job to auto-cancel if payment stalls.
 *   3. confirmPayment() — called by the IntaSend webhook (or the sweeper,
 *                         via status poll) once payment succeeds. Converts
 *                         the flight hold into a ticketed booking (either
 *                         supplier), and fires supplier/agency/traveler
 *                         notifications.
 *   4. failPayment()    — called if payment fails/times out. Cancels the
 *                         HotelBeds booking (refundable rate => free) and
 *                         lets the flight hold expire naturally.
 *
 * Hotels are restricted to refundable (NOR) rates in this flow specifically
 * because HotelBeds has no true "hold" concept — booking == immediate
 * confirmation. Using only refundable rates means we can always cancel for
 * free if the flight side fails or payment doesn't come through.
 *
 * FLIGHT SUPPLIERS (2026-07-03): both TravelDuqa and Duffel are now real
 * bookable paths — see the isFlightBooking branch below. Both use the same
 * hold-now/pay-after-traveler-pays posture; Duffel's hold-order payment is
 * a genuinely separate API call (payHoldOrder), made from confirmPayment()
 * once M-Pesa succeeds, mirroring TravelDuqa's completeHoldBooking().
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');
const paymentService = require('./paymentService');
const notificationService = require('./notifications');
const tracking = require('./trackingService');
const voucherService = require('./voucherService');
const seatSelection = require('./seatSelection');

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
    const isFlightBooking = transport.supplier === 'travelduqa' || transport.supplier === 'duffel';
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
    if (transport.supplier === 'duffel' && transport.requiresInstantPayment === true) {
      return {
        valid: false,
        error: 'This fare requires payment at the time of booking and is not currently supported. Please choose a different flight.',
        code: 'INSTANT_PAYMENT_NOT_SUPPORTED',
      };
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
    let seatSelectionResult = null;
    let stage = 'pending';

    if (isFlightBooking && transport.supplier === 'travelduqa') {
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
    } else if (isFlightBooking && transport.supplier === 'duffel') {
      try {
        const passengersForBooking = passengerDetails.map((p, idx) => ({
          ...p,
          duffelPassengerId: transport.passengerIds?.[idx] || null,
          phone: idx === 0 ? guestPhone : undefined,
          email: idx === 0 ? guestEmail : undefined,
        }));

        if (passengersForBooking.some(p => !p.duffelPassengerId)) {
          throw new Error('Missing Duffel passenger ID for one or more travelers — the offer may have expired. Please search again.');
        }

        try {
          seatSelectionResult = await seatSelection.resolveSeatSelections({
            offerId: transport.offerId,
            passengers: passengersForBooking,
          });
        } catch (err) {
          logger.warn('Seat selection resolution failed — proceeding without it', { bookingRef, error: err.message });
          seatSelectionResult = { resolved: [], unresolved: passengersForBooking.map(p => ({ passengerId: p.duffelPassengerId, reason: 'seat selection unavailable' })) };
        }

        flightResult = await supplierAdapter.book({
          supplier:     'duffel',
          offerId:      transport.offerId,
          passengers:   passengersForBooking,
          totalAmount:  transport.price,
          totalCurrency: transport.currency || 'KES',
          type:         'hold',
          services:     seatSelectionResult?.resolved?.length > 0 ? seatSelectionResult.resolved : null,
        });

        stage = 'flight_held';
        logger.info('Duffel flight held', { bookingRef, orderId: flightResult?.orderId });

      } catch (err) {
        // BUG FIX (found via a real WhatsApp sandbox booking,
        // 2026-07-04): duffel.js throws this structured error when
        // Duffel's own invalid_order_create_type response reveals the
        // offer genuinely requires instant payment — something the
        // earlier validatePackage() check couldn't catch because
        // requiresInstantPayment came back null/unconfirmed at search
        // time rather than an explicit true. Surface the SAME clean,
        // honest message/code the pre-check produces, rather than
        // letting this fall through to the generic FLIGHT_HOLD_FAILED
        // path below with a raw supplier error the traveler can't act on.
        if (err.code === 'REQUIRES_INSTANT_PAYMENT') {
          logger.warn('Duffel offer required instant payment (discovered at booking time, not pre-validated)', { bookingRef, offerId: transport.offerId });
          return {
            success: false,
            error: 'This fare requires payment at the time of booking and is not currently supported. Please choose a different flight.',
            code: 'INSTANT_PAYMENT_NOT_SUPPORTED',
          };
        }

        const supplierMessage = err.response?.data?.errors?.[0]?.message || err.message;

        const looksLikeServicesRejection = /service/i.test(supplierMessage || '') && seatSelectionResult?.resolved?.length > 0;
        if (looksLikeServicesRejection) {
          logger.warn('Duffel hold order rejected with services included — retrying without seat selection', { bookingRef, error: supplierMessage });
          try {
            const passengersForBooking = passengerDetails.map((p, idx) => ({
              ...p,
              duffelPassengerId: transport.passengerIds?.[idx] || null,
              phone: idx === 0 ? guestPhone : undefined,
              email: idx === 0 ? guestEmail : undefined,
            }));
            flightResult = await supplierAdapter.book({
              supplier:      'duffel',
              offerId:       transport.offerId,
              passengers:    passengersForBooking,
              totalAmount:   transport.price,
              totalCurrency: transport.currency || 'KES',
              type:          'hold',
              services:      null,
            });
            stage = 'flight_held';
            seatSelectionResult = {
              resolved: [],
              unresolved: (seatSelectionResult?.resolved || []).map(s => ({ passengerId: s.passengerId, reason: 'seat selection is not supported for held bookings on this fare' })),
            };
            logger.info('Duffel flight held on retry without seat selection', { bookingRef, orderId: flightResult?.orderId });
          } catch (retryErr) {
            const retryMessage = retryErr.response?.data?.errors?.[0]?.message || retryErr.message;
            logger.error('Duffel flight hold failed even without seat selection', { bookingRef, error: retryMessage });
            tracking.alert({
              type: 'flight_hold_failed', severity: 'error',
              title: `Duffel flight hold failed — ${bookingRef}`,
              detail: retryMessage, context: { bookingRef, offerId: transport.offerId },
              agencyId, bookingRef, channel,
            });
            return {
              success: false,
              error: `We couldn't hold this flight with the airline (${retryMessage}). Please search again.`,
              code: 'FLIGHT_HOLD_FAILED',
            };
          }
        } else {
          logger.error('Duffel flight hold failed', { bookingRef, error: supplierMessage });
          tracking.alert({
            type:       'flight_hold_failed',
            severity:   'error',
            title:      `Duffel flight hold failed — ${bookingRef}`,
            detail:     supplierMessage,
            context:    { bookingRef, offerId: transport.offerId },
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

          effectiveRateKey = checkRateResult.rateKey;
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
          // IMPROVEMENT (2026-07-03): previously just left the
          // flight hold to expire naturally rather than actively
          // releasing it — safe to do now that duffel.js's cancel()
          // actually completes both real steps (create + confirm a
          // cancellation), not just the first half. Releases the
          // held seat/inventory immediately instead of tying it up
          // until natural expiry. Never blocks the response to the
          // traveler either way — this is a best-effort cleanup, and
          // a failure here is logged but doesn't change what the
          // traveler is told (the hold expiring naturally is still
          // the honest fallback if active cancellation itself fails).
          let flightCancelSucceeded = null;
          try {
            await supplierAdapter.cancel({ supplier: transport.supplier, orderId: flightResult.orderId, bookingRef: flightResult.supplierBookingReference });
            flightCancelSucceeded = true;
            logger.info('Flight hold actively cancelled after hotel confirmation failure', { bookingRef, supplier: transport.supplier });
          } catch (cancelErr) {
            flightCancelSucceeded = false;
            logger.warn('Could not actively cancel flight hold after hotel failure — it will still expire naturally', { bookingRef, supplier: transport.supplier, error: cancelErr.message });
          }

          await this._persistStage(bookingRef, agencyId, pkg, passengerDetails, guestName, guestPhone, guestEmail, channel, 'failed', flightResult, null);
          return {
            success: false,
            error: `Your flight was held, but we couldn't confirm the hotel (${supplierMessage}). ${flightCancelSucceeded ? 'The flight hold has been released' : 'The flight hold will expire automatically'} — no charge has been made. Please try a different hotel.`,
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
      seatSelection: seatSelectionResult,
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

  async confirmPayment({ bookingRef }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (error || !booking) {
      return { success: false, error: 'Booking not found.' };
    }

    const transportSupplier = booking.package_snapshot?.transport?.supplier || null;

    if (booking.supplier_order_id && transportSupplier === 'duffel' && supplierAdapter) {
      try {
        await this._completeDuffelPayment(booking);
      } catch (err) {
        logger.error('Failed to pay for Duffel hold order after M-Pesa payment', { bookingRef, error: err.message });
        tracking.alert({
          type:     'duffel_payment_failed',
          severity: 'critical',
          title:    `Duffel hold-order payment failed after traveler paid — ${bookingRef}`,
          detail:   `Traveler's M-Pesa payment succeeded, but paying Duffel for the held order failed: ${err.message}. Manual follow-up required — the flight hold may expire before this is resolved.`,
          context:  { bookingRef, orderId: booking.supplier_order_id, error: err.message },
          agencyId: booking.agency_id,
          bookingRef,
        });
        return { success: false, error: 'Payment received, but we could not finalize the flight with the airline. Our team has been notified — please contact support.' };
      }
    } else if (booking.supplier_order_id && transportSupplier === 'travelduqa' && supplierAdapter) {
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

    this._fetchAgencyAndFireVoucher(booking, false).catch(err =>
      logger.error('Voucher/notification fire failed (booking still confirmed)', { bookingRef, error: err.message })
    );

    return { success: true, bookingRef, status: 'confirmed' };
  }

  async _completeDuffelPayment(booking) {
    const currentOrder = await supplierAdapter.getOrder({
      supplier: 'duffel',
      orderId:  booking.supplier_order_id,
    });

    if (!currentOrder) {
      throw new Error('Could not retrieve the current order state from Duffel before paying.');
    }

    await supplierAdapter.payHoldOrder({
      supplier: 'duffel',
      orderId:  booking.supplier_order_id,
      amount:   currentOrder.totalAmount,
      currency: currentOrder.currency,
    });

    logger.info('Duffel hold order paid', { bookingRef: booking.booking_ref, orderId: booking.supplier_order_id, amount: currentOrder.totalAmount });
  }

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

    const packageSnapshot  = booking.package_snapshot || {};
    const outboundTransport = packageSnapshot.transport       || booking.flight_details || null;
    const returnTransport   = packageSnapshot.returnTransport || null;

    const flightDetailsForVoucher = outboundTransport
      ? { ...outboundTransport, returnLeg: returnTransport || null }
      : null;

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
      passengerList: (Array.isArray(booking.passenger_details) ? booking.passenger_details : []).map(p => {
        const dob = p.dateOfBirth || p.date_of_birth || p.dob || null;
        const age = this._calculateAge(dob);
        const isChild = (p.type === 'child') || (age != null && age < 18);
        return {
          name: `${p.firstName || p.first_name || ''} ${p.lastName || p.last_name || ''}`.trim() || null,
          type: isChild ? 'child' : 'adult',
          age:  isChild ? age : null,
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
  // REQUEST A FLIGHT CHANGE (change flight — step 1 of 2)
  // Only for confirmed, PAID Duffel bookings — this changes an
  // existing paid order, not a tentative hold. Fetches the order's
  // CURRENT real slice ID fresh via getOrder() rather than trusting
  // anything stored, since that's the authoritative source and this
  // isn't something we call often enough to justify caching it.
  // Returns real change offers with real cost/penalty — nothing is
  // booked or charged by this step alone.
  // ─────────────────────────────────────────────
  async requestFlightChange({ bookingRef, newDepartureDate }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (error || !booking) {
      return { success: false, error: 'Booking not found. Please check your booking reference and try again.' };
    }

    if (booking.status !== 'confirmed' || booking.payment_status !== 'paid') {
      return { success: false, error: 'This booking is not yet confirmed and paid, so it cannot be changed. Only confirmed bookings support flight changes.' };
    }

    const transport = booking.package_snapshot?.transport || {};
    if (transport.supplier !== 'duffel' || !booking.supplier_order_id) {
      return { success: false, error: 'This booking\'s flight is not eligible for changes through this service yet. Please contact support for help changing this specific booking.' };
    }

    if (!supplierAdapter) {
      return { success: false, error: 'Booking system is temporarily unavailable. Please try again shortly.' };
    }

    let currentOrder;
    try {
      currentOrder = await supplierAdapter.getOrder({ supplier: 'duffel', orderId: booking.supplier_order_id });
    } catch (err) {
      logger.error('requestFlightChange: could not fetch current order', { bookingRef, error: err.message });
      return { success: false, error: 'We could not retrieve your current flight details from the airline. Please try again shortly or contact support.' };
    }

    if (!currentOrder?.sliceId) {
      return { success: false, error: 'We could not find the flight slice to change on this booking. Please contact support.' };
    }

    try {
      const changeRequest = await supplierAdapter.requestOrderChange({
        supplier: 'duffel',
        orderId: booking.supplier_order_id,
        removeSliceId: currentOrder.sliceId,
        addOrigin: currentOrder.originIata || transport.originIata,
        addDestination: currentOrder.destIata || transport.destIata,
        addDepartureDate: newDepartureDate,
        cabinClass: transport.cabinClass || 'economy',
      });

      if (!changeRequest?.offers?.length) {
        return {
          success: true,
          hasOffers: false,
          message: `No flights are available for ${newDepartureDate} on this route. Try a different date.`,
        };
      }

      return {
        success: true,
        hasOffers: true,
        changeRequestId: changeRequest.changeRequestId,
        offers: changeRequest.offers, // cheapest first, see duffel.js
      };
    } catch (err) {
      const supplierMessage = err.response?.data?.errors?.[0]?.message || err.message;
      logger.error('requestFlightChange failed', { bookingRef, error: supplierMessage });
      return { success: false, error: `We couldn't check change options with the airline (${supplierMessage}). Please try again.` };
    }
  }

  // ─────────────────────────────────────────────
  // CONFIRM A FLIGHT CHANGE (step 2 of 2)
  // Actually applies the change with the airline and charges/refunds
  // the difference via Bodrless's funded Duffel balance — the
  // traveler-facing side (collecting any extra amount from the
  // traveler themselves, e.g. via M-Pesa) is NOT handled here; see
  // the caller for how that's presented/collected before this is
  // invoked. Updates the booking record with the new flight details
  // on success.
  //
  // BUG FIX (found via real sandbox test, 2026-07-04): confirmOrderChange's
  // own response field `newTotalAmount` does NOT reliably match the
  // order's real, authoritative total. A live sandbox run showed
  // confirmOrderChange reporting newTotalAmount: 317.85 for a change
  // with a $25 penalty, while immediately re-fetching the order via
  // getOrder() showed the REAL total was 342.85 — exactly
  // changeTotalAmount (125) higher than the pre-change total
  // (217.85), i.e. correctly including the penalty. confirmOrderChange's
  // own newTotalAmount appears to omit the penalty and cannot be
  // trusted as the source of truth for what Duffel actually charged
  // and now holds as the order's total.
  //
  // Fix: after confirmOrderChange succeeds, re-fetch the order via
  // getOrder() — the same "always trust a fresh fetch, never a
  // stale/self-reported total" pattern already used correctly for
  // payHoldOrder (see _completeDuffelPayment) — and persist THAT
  // total, not confirmedChange's own fields. If the re-fetch itself
  // fails, the change has already been applied and charged with the
  // airline (this must never be undone or reported as a failure to
  // the traveler at this point) — log loudly and alert for manual
  // reconciliation of the stored total instead.
  // ─────────────────────────────────────────────
  async confirmFlightChange({ bookingRef, offerId, changeTotalAmount, changeTotalCurrency }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (error || !booking) {
      return { success: false, error: 'Booking not found.' };
    }

    if (!supplierAdapter) {
      return { success: false, error: 'Booking system is temporarily unavailable. Please try again shortly.' };
    }

    let pendingChange;
    try {
      pendingChange = await supplierAdapter.createOrderChange({ supplier: 'duffel', selectedOrderChangeOfferId: offerId });
    } catch (err) {
      logger.error('confirmFlightChange: createOrderChange failed', { bookingRef, offerId, error: err.message });
      return { success: false, error: `We couldn't start this change with the airline (${err.message}). Please try again.` };
    }

    if (!pendingChange?.changeId) {
      return { success: false, error: 'The airline did not return a usable change confirmation. Please try again or contact support.' };
    }

    let confirmedChange;
    try {
      confirmedChange = await supplierAdapter.confirmOrderChange({
        supplier: 'duffel',
        changeId: pendingChange.changeId,
        changeTotalAmount,
        changeTotalCurrency,
      });
    } catch (err) {
      logger.error('confirmFlightChange: confirmOrderChange failed', { bookingRef, changeId: pendingChange.changeId, error: err.message });
      tracking.alert({
        type:     'flight_change_confirm_failed',
        severity: 'critical',
        title:    `Flight change confirm failed after pending change created — ${bookingRef}`,
        detail:   `A pending change (${pendingChange.changeId}) was created but confirming it failed: ${err.message}. Manual follow-up may be required if this change has an expiry.`,
        context:  { bookingRef, changeId: pendingChange.changeId, error: err.message },
        agencyId: booking.agency_id,
        bookingRef,
      });
      return { success: false, error: `We couldn't finalize this change with the airline (${err.message}). Our team has been notified — please contact support.` };
    }

    // Re-fetch the order for its authoritative total — see the
    // BUG FIX note above. The change itself is already applied and
    // charged/refunded with the airline at this point regardless of
    // what happens next; a failure here is a reporting problem, not
    // a booking failure, and must never be surfaced to the traveler
    // as the change having failed.
    let authoritativeTotalAmount = confirmedChange.newTotalAmount;
    let authoritativeCurrency = confirmedChange.newTotalCurrency;

    try {
      const freshOrder = await supplierAdapter.getOrder({ supplier: 'duffel', orderId: booking.supplier_order_id });
      if (freshOrder?.totalAmount != null) {
        if (freshOrder.totalAmount !== confirmedChange.newTotalAmount) {
          logger.warn('confirmFlightChange: confirmOrderChange.newTotalAmount did not match freshly re-fetched order total — using the re-fetched value as authoritative', {
            bookingRef,
            changeId: pendingChange.changeId,
            confirmOrderChangeNewTotalAmount: confirmedChange.newTotalAmount,
            freshOrderTotalAmount: freshOrder.totalAmount,
          });
        }
        authoritativeTotalAmount = freshOrder.totalAmount;
        authoritativeCurrency = freshOrder.currency || authoritativeCurrency;
      }
    } catch (err) {
      // The change is already confirmed and charged with the airline —
      // this only means we couldn't verify/refresh the total to store.
      // Fall back to confirmedChange's own (possibly-short) figures,
      // but flag it loudly so someone reconciles the real total
      // manually rather than it silently being wrong forever.
      logger.error('confirmFlightChange: could not re-fetch order after a successfully confirmed change — stored total may not reflect the real charge', {
        bookingRef, changeId: pendingChange.changeId, error: err.message,
      });
      tracking.alert({
        type:     'flight_change_total_unverified',
        severity: 'warning',
        title:    `Flight change confirmed but total could not be verified — ${bookingRef}`,
        detail:   `The change with the airline succeeded (changeId: ${pendingChange.changeId}), but re-fetching the order to confirm its real total failed: ${err.message}. The booking record was updated using confirmOrderChange's own reported total, which sandbox testing has shown can be understated by the penalty amount. Please verify the real order total in Duffel's dashboard and correct the booking record if needed.`,
        context:  { bookingRef, changeId: pendingChange.changeId, orderId: booking.supplier_order_id, storedTotalAmount: authoritativeTotalAmount, error: err.message },
        agencyId: booking.agency_id,
        bookingRef,
      });
    }

    // Update the booking record with the new flight details.
    try {
      await supabase
        .from('bookings')
        .update({
          total_price: authoritativeTotalAmount || booking.total_price,
          currency: authoritativeCurrency || booking.currency,
        })
        .eq('booking_ref', bookingRef);
    } catch (err) {
      logger.error('confirmFlightChange: booking record update failed (change itself succeeded)', { bookingRef, error: err.message });
    }

    logger.info('Flight change confirmed', { bookingRef, changeId: confirmedChange.changeId, changeTotalAmount: confirmedChange.changeTotalAmount, authoritativeTotalAmount });

    return {
      success: true,
      changeTotalAmount: confirmedChange.changeTotalAmount,
      changeTotalCurrency: confirmedChange.changeTotalCurrency,
      newTotalAmount: authoritativeTotalAmount,
      newTotalCurrency: authoritativeCurrency,
    };
  }

  // ─────────────────────────────────────────────
  // REQUEST A HOTEL CHANGE (change hotel dates — step 1 of 2)
  // Built as cancel-old + book-new rather than trusting an
  // unverified "true in-place modify" contract — HotelBeds' own
  // modification docs confirm a bookingChangeCode search flag and a
  // sourceMarket field on the booking confirmation step, but don't
  // clearly show whether this actually patches an existing booking
  // or is really just special-context pricing that still requires
  // the same cancel+rebook underneath. Cancel+rebook is PROVEN safe
  // here since both halves already work correctly (see
  // cancelConfirmedBooking and the hotel booking branch of
  // initBooking) — this only searches for new availability, nothing
  // is cancelled or booked yet.
  // ─────────────────────────────────────────────
  async requestHotelChange({ bookingRef, newCheckIn, newCheckOut }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (error || !booking) {
      return { success: false, error: 'Booking not found. Please check your booking reference and try again.' };
    }

    if (booking.status !== 'confirmed' || booking.payment_status !== 'paid') {
      return { success: false, error: 'This booking is not yet confirmed and paid, so it cannot be changed.' };
    }

    if (!booking.hotel_supplier_reference || !booking.hotel_details?.hotelCode) {
      return { success: false, error: 'This booking does not have a hotel that can be changed through this service.' };
    }

    if (!supplierAdapter) {
      return { success: false, error: 'Booking system is temporarily unavailable. Please try again shortly.' };
    }

    const passengers = Array.isArray(booking.passenger_details) ? booking.passenger_details : [];
    const adults = passengers.filter(p => p.type !== 'child').length || 1;
    const children = passengers.filter(p => p.type === 'child');
    const childAges = children.map(p => this._calculateAge(p.dateOfBirth || p.date_of_birth || p.dob)).filter(a => a != null);

    try {
      const results = await supplierAdapter.searchHotels({
        hotelCode: booking.hotel_details.hotelCode,
        checkIn: newCheckIn,
        checkOut: newCheckOut,
        adults,
        children: children.length,
        childAges,
        rooms: 1,
        bookingChangeCode: 'CANCELLATION_POLICY_CHANGE',
      });

      if (!results || results.length === 0) {
        return {
          success: true,
          hasOffers: false,
          message: `No availability found at ${booking.hotel_details.name || 'this hotel'} for ${newCheckIn} to ${newCheckOut}. Try different dates.`,
        };
      }

      const newRate = results[0]; // cheapest/first real result
      return {
        success: true,
        hasOffers: true,
        hotelName: newRate.name,
        newRateKey: newRate.rateKey,
        newTotalPrice: newRate.totalRate,
        newCurrency: newRate.currency,
        currentTotalPrice: booking.total_price,
        currentCurrency: booking.currency,
        newCheckIn,
        newCheckOut,
      };
    } catch (err) {
      logger.error('requestHotelChange search failed', { bookingRef, error: err.message });
      return { success: false, error: `We couldn't check new dates with the hotel (${err.message}). Please try again.` };
    }
  }

  // ─────────────────────────────────────────────
  // CONFIRM A HOTEL CHANGE (step 2 of 2)
  // Cancels the current hotel booking, then books the new dates
  // under the SAME bookingRef (traveler keeps their existing
  // reference and voucher — no need to reissue a whole new booking
  // identity for what is, from their perspective, one continuous
  // stay being adjusted).
  //
  // CRITICAL FAILURE CASE: if the cancel succeeds but the new
  // booking fails, the traveler is left with NO hotel at all — this
  // is flagged as a critical alert for immediate manual follow-up,
  // not something to paper over. Rare (both steps individually are
  // reliable), but must never be silently swallowed.
  // ─────────────────────────────────────────────
  async confirmHotelChange({ bookingRef, newRateKey, newCheckIn, newCheckOut }) {
    const { data: booking, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (error || !booking) {
      return { success: false, error: 'Booking not found.' };
    }

    if (!supplierAdapter) {
      return { success: false, error: 'Booking system is temporarily unavailable. Please try again shortly.' };
    }

    try {
      await supplierAdapter.cancel({ supplier: 'hotelbeds', bookingRef: booking.hotel_supplier_reference });
      logger.info('Old hotel booking cancelled for change', { bookingRef, oldRef: booking.hotel_supplier_reference });
    } catch (err) {
      logger.error('confirmHotelChange: could not cancel current hotel booking', { bookingRef, error: err.message });
      return {
        success: false,
        error: `We couldn't cancel your current hotel booking (${err.message}), so we did not proceed — your existing stay is unaffected. Please try again or contact support.`,
      };
    }

    const passengers = Array.isArray(booking.passenger_details) ? booking.passenger_details : [];
    let newHotelResult;
    try {
      const leadGuest = { firstName: passengers[0]?.firstName, lastName: passengers[0]?.lastName };
      const guestsForHotel = passengers.map(p => ({
        firstName: p.firstName,
        lastName: p.lastName,
        type: p.type === 'child' ? 'child' : 'adult',
        roomId: 1,
      }));

      newHotelResult = await supplierAdapter.book({
        supplier: 'hotelbeds',
        rateKey: newRateKey,
        holder: leadGuest,
        guests: guestsForHotel,
        clientReference: bookingRef,
        remark: `Booking change via Bodrless for ${booking.agency_id}`,
      });
    } catch (err) {
      logger.error('confirmHotelChange: new hotel booking failed AFTER old was cancelled', { bookingRef, error: err.message });
      tracking.alert({
        type:     'hotel_change_left_unbooked',
        severity: 'critical',
        title:    `URGENT: traveler has NO hotel after a change attempt — ${bookingRef}`,
        detail:   `The original hotel booking was successfully cancelled, but booking the new dates failed: ${err.message}. The traveler currently has NO hotel booked. Immediate manual intervention required.`,
        context:  { bookingRef, newRateKey, newCheckIn, newCheckOut, error: err.message },
        agencyId: booking.agency_id,
        bookingRef,
      });
      return {
        success: false,
        error: `Your previous booking was cancelled, but we could not confirm the new dates (${err.message}). Our team has been notified urgently and will contact you to resolve this.`,
      };
    }

    try {
      await supabase
        .from('bookings')
        .update({
          hotel_supplier_reference: newHotelResult.supplierBookingReference || null,
          hotel_rate_key: newRateKey,
          total_price: newHotelResult.totalRate || booking.total_price,
          currency: newHotelResult.currency || booking.currency,
          hotel_details: { ...(booking.hotel_details || {}), ...newHotelResult, checkIn: newCheckIn, checkOut: newCheckOut, rateKey: newRateKey },
        })
        .eq('booking_ref', bookingRef);
    } catch (err) {
      logger.error('confirmHotelChange: booking record update failed (new hotel booking itself succeeded)', { bookingRef, error: err.message });
    }

    logger.info('Hotel change confirmed', { bookingRef, newSupplierRef: newHotelResult.supplierBookingReference });

    return {
      success: true,
      newCheckIn,
      newCheckOut,
      newTotalPrice: newHotelResult.totalRate || booking.total_price,
      newCurrency: newHotelResult.currency || booking.currency,
    };
  }

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

    let supplierCancelSucceeded = null;
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
      success: true,
      bookingRef,
      status: 'cancelled',
      supplierCancelSucceeded,
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