/**
 * PAYMENT SWEEPER
 * ─────────────────────────────────────────────────────────────
 * Background safety net for the flight-first, single-payment booking
 * flow. Runs on an interval and finds any booking stuck in
 * 'awaiting_payment' past its payment_deadline, then:
 *
 *   1. Polls IntaSend directly for the real payment status (in case the
 *      webhook was missed or delayed) — if it actually completed, we
 *      finalize the booking instead of wrongly cancelling it.
 *   2. If payment genuinely did not complete, cancels the HotelBeds
 *      booking (always a refundable rate in this flow, so this costs
 *      nothing) and lets the TravelDuqa flight hold expire on its own.
 *
 * This exists because HotelBeds bookings are immediate confirmations
 * with no true "hold" — the sweeper is what guarantees Bodrless is
 * never left holding a confirmed, unpaid hotel booking indefinitely.
 *
 * Call startSweeper() once at server boot (e.g. from server.js).
 * ─────────────────────────────────────────────────────────────
 */

const supabase = require('../utils/supabase');
const bookingService = require('./bookingService');
const paymentService = require('./paymentService');
const whatsappService = require('./whatsapp');
const { logger } = require('../utils/logger');

const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // every 2 minutes

async function sweepOnce() {
  try {
    const { data: staleBookings, error } = await supabase
      .from('bookings')
      .select('booking_ref, payment_invoice_id, payment_deadline')
      .eq('booking_stage', 'awaiting_payment')
      .lt('payment_deadline', new Date().toISOString());

    if (error) {
      logger.error('Payment sweeper query failed', { error: error.message });
      return;
    }

    if (!staleBookings || staleBookings.length === 0) {
      return; // nothing to do, the common case
    }

    logger.info('Payment sweeper found stale bookings', { count: staleBookings.length });

    for (const booking of staleBookings) {
      await _resolveStaleBooking(booking);
    }

  } catch (err) {
    logger.error('Payment sweeper run failed', { error: err.message });
  }
}

async function _resolveStaleBooking(booking) {
  const { booking_ref: bookingRef, payment_invoice_id: invoiceId } = booking;

  // Double-check with IntaSend directly before cancelling — the webhook
  // may have been missed even though payment actually succeeded.
  if (invoiceId) {
    try {
      const status = await paymentService.checkStatus(invoiceId);
      const state = status?.invoice?.state || status?.state;

      if (state === 'COMPLETE') {
        logger.info('Sweeper found payment actually completed — finalizing instead of cancelling', { bookingRef });
        await bookingService.confirmPayment({ bookingRef });
        return;
      }
    } catch (err) {
      logger.warn('Sweeper could not verify payment status with IntaSend — proceeding to cancel', { bookingRef, error: err.message });
    }
  }

  logger.info('Sweeper cancelling stale unpaid booking', { bookingRef });
  await bookingService.failPayment({ bookingRef });
  await _notifyIfWhatsApp(bookingRef);
}

async function _notifyIfWhatsApp(bookingRef) {
  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('channel, guest_phone')
      .eq('booking_ref', bookingRef)
      .single();

    if (!booking || booking.channel !== 'whatsapp' || !booking.guest_phone) return;

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!phoneNumberId) return;

    const to = booking.guest_phone.replace(/^\+/, '').replace(/^0/, '254');
    await whatsappService.sendText(phoneNumberId, to,
      `We did not receive payment for booking ${bookingRef} in time, so the hold has been released. Feel free to search again if you would still like to book.`
    );
  } catch (err) {
    logger.error('Sweeper WhatsApp notification failed', { bookingRef, error: err.message });
  }
}

function startSweeper() {
  logger.info('Payment sweeper started', { intervalMinutes: SWEEP_INTERVAL_MS / 60000 });
  setInterval(sweepOnce, SWEEP_INTERVAL_MS);
}

module.exports = { startSweeper, sweepOnce };