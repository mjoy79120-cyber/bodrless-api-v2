/**
 * INTASEND WEBHOOK ROUTE
 * ─────────────────────────────────────────────────────────────
 * Receives payment state change events from IntaSend.
 *
 * On COMPLETE -> bookingService.confirmPayment() fires the first
 *                voucher (booking confirmed), then this handler fires
 *                a second voucher with resend:true so the traveler
 *                gets a clear "payment confirmed" message with their
 *                voucher attached. The two sends have different subject
 *                lines and WhatsApp openers so they don't read as
 *                duplicate messages.
 *
 * On FAILED   -> bookingService.failPayment() — cancels HotelBeds
 *                booking (refundable rate, so free) and lets the
 *                flight hold expire naturally.
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();
const bookingService  = require('../services/bookingService');
const voucherService  = require('../services/voucherService');
const supabase        = require('../utils/supabase');
const { logger }      = require('../utils/logger');

router.post('/intasend', async (req, res) => {
  res.status(200).send('OK');

  try {
    const event      = req.body;
    const bookingRef = event.api_ref;
    const state      = event.state;

    if (!bookingRef) {
      logger.warn('IntaSend webhook missing api_ref', { event });
      return;
    }

    logger.info('IntaSend webhook received', { bookingRef, state, invoiceId: event.invoice_id });

    if (state === 'COMPLETE') {
      const result = await bookingService.confirmPayment({ bookingRef });
      if (!result.success) {
        logger.error('Failed to finalize booking after payment confirmation', { bookingRef, error: result.error });
        return;
      }

      // Fire a second voucher delivery on payment confirmation — different
      // subject/opener ("Payment confirmed") from the first one that fired
      // inside confirmPayment ("Booking confirmed"). Traveler gets both:
      // one when the booking was secured, one when money landed.
      // Fire-and-forget — payment is already confirmed regardless.
      _firePaymentConfirmedVoucher(bookingRef).catch(err =>
        logger.error('Payment-confirmed voucher failed (payment itself still confirmed)', { bookingRef, error: err.message })
      );

    } else if (state === 'FAILED') {
      await bookingService.failPayment({ bookingRef });
      logger.info('Booking cancelled after payment failure webhook', { bookingRef });
      await _notifyPaymentFailed(bookingRef);

    } else {
      logger.info('IntaSend webhook — non-terminal state, no action taken', { bookingRef, state });
    }

  } catch (err) {
    logger.error('IntaSend webhook handler error', { error: err.message });
  }
});

// ─────────────────────────────────────────────
// FIRE PAYMENT-CONFIRMED VOUCHER
// Fetches the full booking + agency, then sends voucherService with
// resend:true so the email subject reads "Payment confirmed — your
// voucher" and the WhatsApp message opens with "✅ Payment received"
// rather than the duplicate "✅ Booking Confirmed" the first send used.
// ─────────────────────────────────────────────
async function _firePaymentConfirmedVoucher(bookingRef) {
  const { data: booking } = await supabase
    .from('bookings')
    .select('*')
    .eq('booking_ref', bookingRef)
    .single();

  if (!booking) return;

  let agency = null;
  try {
    const { data } = await supabase
      .from('agencies')
      .select('id,name,email,whatsapp_phone_number_id')
      .eq('id', booking.agency_id)
      .single();
    agency = data;
  } catch {}

  const hotelDetails = booking.hotel_details || {};
  const voucherBooking = {
    supplierBookingReference: booking.hotel_supplier_reference || booking.supplier_booking_reference,
    clientReference:          booking.booking_ref,
    status:                   'CONFIRMED',
    confirmedAt:              new Date().toISOString(),
    hotelName:                hotelDetails.name            || null,
    hotelAddress:             hotelDetails.address         || null,
    hotelPhone:               hotelDetails.phone           || null,
    checkIn:                  hotelDetails.checkIn         || booking.flight_details?.departureTime || null,
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

  await voucherService.sendVoucher({
    booking: voucherBooking,
    hotel:   hotelDetails,
    agency,
    resend:  true, // "Payment confirmed" subject + opener
  });
}

// ─────────────────────────────────────────────
// NOTIFY PAYMENT FAILED
// Simple WhatsApp message only — no voucher since there's nothing
// to confirm. Keeps the original behavior for the failed path.
// ─────────────────────────────────────────────
async function _notifyPaymentFailed(bookingRef) {
  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('channel,guest_phone,agency_id')
      .eq('booking_ref', bookingRef)
      .single();

    if (!booking || booking.channel !== 'whatsapp' || !booking.guest_phone) return;

    // Resolve the agency's WhatsApp phone_number_id — the right way
    // to route the message, rather than relying on a global env var.
    const { data: agency } = await supabase
      .from('agencies')
      .select('whatsapp_phone_number_id')
      .eq('id', booking.agency_id)
      .single();

    const phoneNumberId = agency?.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) return;

    const whatsappService = require('../services/whatsapp');
    await whatsappService.sendText(
      phoneNumberId,
      booking.guest_phone,
      `We didn't receive payment for booking ${bookingRef}, so the hold was released. Feel free to search again if you'd still like to book — your options will still be available.`
    );
  } catch (err) {
    logger.error('Failed to notify customer of payment failure', { bookingRef, error: err.message });
  }
}

module.exports = router;