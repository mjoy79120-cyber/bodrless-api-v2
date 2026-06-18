/**
 * INTASEND WEBHOOK ROUTE
 * ─────────────────────────────────────────────────────────────
 * Receives payment state change events from IntaSend.
 *
 * IntaSend sends api_ref (which we set to our bookingRef when
 * triggering the STK push) and state (PENDING/PROCESSING/COMPLETE/FAILED).
 *
 * On COMPLETE -> bookingService.confirmPayment() — converts the
 *                TravelDuqa flight hold into a ticketed booking.
 * On FAILED   -> bookingService.failPayment() — cancels the HotelBeds
 *                booking (refundable rate, so free) and lets the
 *                flight hold expire naturally.
 * PENDING/PROCESSING are logged but otherwise ignored — the sweeper
 * job is what actually enforces the payment deadline if no terminal
 * state ever arrives.
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const router = express.Router();
const bookingService = require('../services/bookingService');
const whatsappService = require('../services/whatsapp');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

router.post('/intasend', async (req, res) => {
  // Always acknowledge quickly so IntaSend doesn't retry unnecessarily
  res.status(200).send('OK');

  try {
    const event = req.body;
    const bookingRef = event.api_ref;
    const state = event.state;

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
      await _notifyCustomerIfWhatsApp(bookingRef, 'paid');

    } else if (state === 'FAILED') {
      await bookingService.failPayment({ bookingRef });
      logger.info('Booking cancelled after payment failure webhook', { bookingRef });
      await _notifyCustomerIfWhatsApp(bookingRef, 'failed');

    } else {
      logger.info('IntaSend webhook — non-terminal state, no action taken', { bookingRef, state });
    }

  } catch (err) {
    logger.error('IntaSend webhook handler error', { error: err.message });
  }
});

// ── Notify the customer directly on WhatsApp if this booking came
// through that channel — payment confirmation arrives async, outside
// any open conversation, so we message them proactively here.
async function _notifyCustomerIfWhatsApp(bookingRef, outcome) {
  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_ref', bookingRef)
      .single();

    if (!booking || booking.channel !== 'whatsapp' || !booking.guest_phone) return;

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) return;

    const to = booking.guest_phone.replace(/^\+/, '').replace(/^0/, '254');

    if (outcome === 'paid') {
      await whatsappService.sendText(phoneNumberId, to,
        `Payment received! Your booking ${bookingRef} is fully confirmed. You will receive your e-ticket and hotel confirmation shortly.`
      );
    } else {
      await whatsappService.sendText(phoneNumberId, to,
        `We did not receive payment for booking ${bookingRef}, so the hold was released. Feel free to search again if you would still like to book.`
      );
    }
  } catch (err) {
    logger.error('Failed to notify customer of payment outcome', { bookingRef, error: err.message });
  }
}

module.exports = router;