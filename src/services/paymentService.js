/**
 * PAYMENT SERVICE — IntaSend (M-Pesa STK Push)
 * ─────────────────────────────────────────────────────────────
 * Wraps the official intasend-node SDK to trigger STK push for a
 * combined booking total, and exposes a webhook-signature-safe way
 * to look up which booking an IntaSend event belongs to.
 *
 * SAFETY NET: HotelBeds has no real "hold" — book() = immediate
 * confirmation. We only ever book refundable (NOR) rates so that if
 * payment doesn't land in time, we can cancel for free. The actual
 * enforcement of that time limit lives in the sweeper job
 * (paymentSweeper.js), not here — this file only triggers payment
 * and exposes lookup/verification helpers.
 * ─────────────────────────────────────────────────────────────
 */

const IntaSend = require('intasend-node');
const { logger } = require('../utils/logger');

const PAYMENT_WINDOW_MINUTES = 30;

class PaymentService {

  constructor() {
    // NORMAL (live) credentials — used by default, untouched by the
    // test toggle below. Never overwritten, never at risk of being
    // "forgotten" in a swapped-back state.
    this.publishableKey = process.env.INTASEND_PUBLISHABLE_KEY;
    this.secretKey       = process.env.INTASEND_SECRET_KEY;
    this.testMode        = process.env.INTASEND_TEST_MODE !== 'false'; // default true (sandbox)

    // OPT-IN TEST CREDENTIAL OVERRIDE — separate env vars entirely,
    // only used when INTASEND_USE_TEST_CREDENTIALS=true is explicitly
    // set. This exists because this account's main
    // INTASEND_PUBLISHABLE_KEY/SECRET_KEY are LIVE keys (confirmed
    // 2026-07-02) even though testMode defaults to true — meaning a
    // real STK push against a real phone would genuinely attempt to
    // charge real money, for a booking that isn't even real yet
    // (HotelBeds/TravelDuqa are still sandboxed). Flip
    // INTASEND_USE_TEST_CREDENTIALS on only for a deliberate dummy-
    // booking test, using real IntaSend SANDBOX keys (from their
    // developer sandbox signup, not the live dashboard) stored under
    // INTASEND_TEST_PUBLISHABLE_KEY/INTASEND_TEST_SECRET_KEY. The
    // live keys above are NEVER modified by this path, so there's no
    // "forgot to revert" risk to real traffic.
    const useTestCredentials = process.env.INTASEND_USE_TEST_CREDENTIALS === 'true';
    if (useTestCredentials) {
      this.publishableKey = process.env.INTASEND_TEST_PUBLISHABLE_KEY;
      this.secretKey       = process.env.INTASEND_TEST_SECRET_KEY;
      logger.warn('IntaSend: using TEST credentials (INTASEND_USE_TEST_CREDENTIALS=true) — no real M-Pesa charges will occur. Unset this env var to return to live payment collection.');
    }

    this.client = null;
    if (this.publishableKey && this.secretKey) {
      this.client = new IntaSend(this.publishableKey, this.secretKey, useTestCredentials ? true : this.testMode);
    } else {
      logger.warn(
        useTestCredentials
          ? 'INTASEND_USE_TEST_CREDENTIALS=true but INTASEND_TEST_PUBLISHABLE_KEY/INTASEND_TEST_SECRET_KEY are not set — payment triggering will fail until those are configured'
          : 'IntaSend credentials not set — payment triggering will fail until INTASEND_PUBLISHABLE_KEY / INTASEND_SECRET_KEY are configured'
      );
    }
  }

  // ─────────────────────────────────────────────
  // TRIGGER STK PUSH
  // bookingRef is passed as api_ref so the webhook can correlate
  // the IntaSend event back to our booking.
  // ─────────────────────────────────────────────
  async triggerStkPush({ bookingRef, phone, amount, email, firstName, lastName }) {
    if (!this.client) {
      throw new Error('IntaSend is not configured (missing API credentials).');
    }

    // Loud, explicit confirmation of which credential set is actually
    // firing THIS charge — check this line in Render logs before/
    // during any test to be certain real money isn't being moved.
    const usingTestCredentials = process.env.INTASEND_USE_TEST_CREDENTIALS === 'true';
    logger.info(usingTestCredentials
      ? `💳 IntaSend charge using TEST credentials — no real money will move (bookingRef: ${bookingRef})`
      : `💳 IntaSend charge using LIVE credentials — THIS WILL ATTEMPT A REAL M-PESA CHARGE (bookingRef: ${bookingRef})`
    );

    // IntaSend phone format: 2547XXXXXXXX (no leading +, no leading 0)
    const formattedPhone = this._formatPhone(phone);

    logger.info('Triggering IntaSend STK push', { bookingRef, amount, phone: formattedPhone });

    const collection = this.client.collection();

    // BUG FIX (found in production, 2026-07-02): a real IntaSend 400
    // error came back with err.message === undefined, meaning the
    // actual reason (bad phone format? live-account restriction?
    // amount limit?) was completely invisible in logs — the caller
    // just saw "Could not initiate payment: undefined". IntaSend/
    // axios errors carry the real detail on err.response.data, not
    // err.message directly (same pattern already fixed this session
    // in hotelbeds.js and voucherService.js). Wrap the call so that
    // detail is both logged in full AND baked into the thrown
    // error's own .message, so every existing caller that reads
    // err.message (bookingService.triggerPayment, etc.) automatically
    // gets the real reason without needing its own changes.
    let response;
    try {
      response = await collection.mpesaStkPush({
        first_name: firstName || 'Valued',
        last_name:  lastName  || 'Customer',
        email:      email || 'noreply@bodrless.app',
        host:       process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com',
        amount,
        phone_number: formattedPhone,
        api_ref:      bookingRef,
      });
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data;
      logger.error('IntaSend STK push request failed', {
        bookingRef, status, detail, rawMessage: err.message,
      });

      const detailText = detail
        ? (typeof detail === 'string' ? detail : JSON.stringify(detail))
        : (err.message || 'no error detail returned');
      const wrapped = new Error(`IntaSend STK push failed${status ? ` (HTTP ${status})` : ''}: ${detailText}`);
      wrapped.intasendStatus = status;
      wrapped.intasendDetail = detail;
      throw wrapped;
    }

    logger.info('IntaSend STK push triggered', { bookingRef, invoiceId: response?.invoice?.invoice_id });

    return {
      invoiceId: response?.invoice?.invoice_id || response?.id || null,
      state:     response?.invoice?.state || 'PENDING',
      raw:       response,
      paymentDeadline: new Date(Date.now() + PAYMENT_WINDOW_MINUTES * 60 * 1000).toISOString(),
    };
  }

  // ─────────────────────────────────────────────
  // CHECK PAYMENT STATUS (poll fallback if webhook is delayed/missed)
  // ─────────────────────────────────────────────
  async checkStatus(invoiceId) {
    if (!this.client) {
      throw new Error('IntaSend is not configured.');
    }
    const collection = this.client.collection();
    const response = await collection.status({ invoice_id: invoiceId });
    return response;
  }

  _formatPhone(raw) {
    if (!raw) return raw;
    let cleaned = String(raw).replace(/\s+/g, '').replace(/^\+/, '');
    if (cleaned.startsWith('0')) cleaned = '254' + cleaned.slice(1);
    if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
    return cleaned;
  }
}

module.exports = new PaymentService();