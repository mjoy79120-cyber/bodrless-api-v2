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
      }
    } else if (state === 'FAILED') {
      await bookingService.failPayment({ bookingRef });
      logger.info('Booking cancelled after payment failure webhook', { bookingRef });
    } else {
      logger.info('IntaSend webhook — non-terminal state, no action taken', { bookingRef, state });
    }

  } catch (err) {
    logger.error('IntaSend webhook handler error', { error: err.message });
  }
});

module.exports = router;