/**
 * PAYMENT SERVICE — IntaSend (M-Pesa STK Push)
 * ─────────────────────────────────────────────────────────────
 * Calls IntaSend's REST API directly via axios, matching every
 * other supplier adapter in this codebase (HotelBeds, Duffel,
 * TravelDuqa, IABIRI, HotelBeds Transfers).
 *
 * BUG FIX / REWRITE (2026-07-02): previously wrapped the
 * `intasend-node` SDK. A real production 400 error came back with
 * err.message === undefined AND err.response.data empty — the SDK
 * itself was swallowing the real error detail before it ever
 * reached our code (confirmed: "IntaSend Request HTTP Error Code:
 * 400" was the SDK's own internal console.log, not ours). Calling
 * the documented REST endpoint directly gives full visibility into
 * whatever IntaSend actually returns, the same way every other
 * supplier in this codebase already works.
 *
 * Endpoints/auth confirmed from IntaSend's public docs
 * (developers.intasend.com), 2026-07-02:
 *   Sandbox base URL: https://sandbox.intasend.com/api
 *   Live base URL:    https://payment.intasend.com/api
 *   Auth: Authorization: Bearer <SECRET_KEY> (secret key, not
 *         publishable — publishable key isn't used server-side here)
 *   STK push endpoint: POST /v1/payment/mpesa-stk-push/
 *
 * NOT YET VERIFIED AGAINST A REAL CALL — same "test before trusting"
 * rule as every other adapter built this session. Run a real STK
 * push (sandbox first) and confirm the response shape matches what
 * this file expects before relying on it in production.
 *
 * SAFETY NET: HotelBeds has no real "hold" — book() = immediate
 * confirmation. We only ever book refundable (NOR) rates so that if
 * payment doesn't land in time, we can cancel for free. The actual
 * enforcement of that time limit lives in the sweeper job
 * (paymentSweeper.js), not here — this file only triggers payment
 * and exposes lookup/verification helpers.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

const PAYMENT_WINDOW_MINUTES = 30;

class PaymentService {

  constructor() {
    // NORMAL (live) credentials — used by default, untouched by the
    // test toggle below. Never overwritten, never at risk of being
    // "forgotten" in a swapped-back state.
    this.secretKey = process.env.INTASEND_SECRET_KEY;
    this.sandbox   = process.env.INTASEND_TEST_MODE !== 'false'; // default true (sandbox)

    // OPT-IN TEST CREDENTIAL OVERRIDE — separate env var entirely,
    // only used when INTASEND_USE_TEST_CREDENTIALS=true is explicitly
    // set. This exists because this account's main
    // INTASEND_SECRET_KEY is a LIVE key (confirmed 2026-07-02) even
    // though INTASEND_TEST_MODE defaults to true — meaning a real
    // STK push against a real phone would genuinely attempt to
    // charge real money. Flip INTASEND_USE_TEST_CREDENTIALS on only
    // for a deliberate dummy-booking test, using a real IntaSend
    // SANDBOX secret key (from their developer sandbox signup, not
    // the live dashboard) stored under INTASEND_TEST_SECRET_KEY. The
    // live key above is NEVER modified by this path, so there's no
    // "forgot to revert" risk to real traffic.
    this.useTestCredentials = process.env.INTASEND_USE_TEST_CREDENTIALS === 'true';
    if (this.useTestCredentials) {
      this.secretKey = process.env.INTASEND_TEST_SECRET_KEY;
      this.sandbox   = true;
      logger.warn('IntaSend: using TEST credentials (INTASEND_USE_TEST_CREDENTIALS=true) — no real M-Pesa charges will occur. Unset this env var to return to live payment collection.');
    }

    this.baseUrl = this.sandbox
      ? 'https://sandbox.intasend.com/api'
      : 'https://payment.intasend.com/api';

    if (!this.secretKey) {
      logger.warn(
        this.useTestCredentials
          ? 'INTASEND_USE_TEST_CREDENTIALS=true but INTASEND_TEST_SECRET_KEY is not set — payment triggering will fail until it is configured'
          : 'IntaSend credentials not set — payment triggering will fail until INTASEND_SECRET_KEY is configured'
      );
    }
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Authorization': `Bearer ${this.secretKey}`,
    };
  }

  // ─────────────────────────────────────────────
  // TRIGGER STK PUSH
  // bookingRef is passed as api_ref so the webhook can correlate
  // the IntaSend event back to our booking.
  // ─────────────────────────────────────────────
  async triggerStkPush({ bookingRef, phone, amount, email, firstName, lastName }) {
    if (!this.secretKey) {
      throw new Error('IntaSend is not configured (missing INTASEND_SECRET_KEY).');
    }

    // Loud, explicit confirmation of which credential set is actually
    // firing THIS charge — check this line in Render logs before/
    // during any test to be certain real money isn't being moved.
    logger.info(this.useTestCredentials
      ? `💳 IntaSend charge using TEST credentials — no real money will move (bookingRef: ${bookingRef})`
      : `💳 IntaSend charge using LIVE credentials — THIS WILL ATTEMPT A REAL M-PESA CHARGE (bookingRef: ${bookingRef})`
    );

    // IntaSend phone format: 2547XXXXXXXX (no leading +, no leading 0)
    const formattedPhone = this._formatPhone(phone);

    const payload = {
      first_name: firstName || 'Valued',
      last_name:  lastName  || 'Customer',
      email:      email || 'noreply@bodrless.app',
      host:       process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com',
      amount,
      phone_number: formattedPhone,
      api_ref:      bookingRef,
    };

    logger.info('Triggering IntaSend STK push', { bookingRef, amount, phone: formattedPhone, sandbox: this.sandbox });

    let response;
    try {
      response = await axios.post(
        `${this.baseUrl}/v1/payment/mpesa-stk-push/`,
        payload,
        { headers: this._headers(), timeout: 20000 }
      );
    } catch (err) {
      // Full visibility this time — raw axios error, no SDK layer
      // between us and the real response body.
      const status = err.response?.status;
      const detail = err.response?.data;
      logger.error('IntaSend STK push request failed', {
        bookingRef, status, detail, rawMessage: err.message,
      });

      const detailText = detail
        ? (typeof detail === 'string' ? detail : JSON.stringify(detail))
        : (err.message || 'no error detail returned — request may have failed before reaching IntaSend (network/timeout)');
      const wrapped = new Error(`IntaSend STK push failed${status ? ` (HTTP ${status})` : ''}: ${detailText}`);
      wrapped.intasendStatus = status;
      wrapped.intasendDetail = detail;
      throw wrapped;
    }

    const data = response.data || {};
    logger.info('IntaSend STK push triggered', { bookingRef, invoiceId: data?.invoice?.invoice_id, raw: data });

    return {
      invoiceId: data?.invoice?.invoice_id || data?.id || null,
      state:     data?.invoice?.state || 'PENDING',
      raw:       data,
      paymentDeadline: new Date(Date.now() + PAYMENT_WINDOW_MINUTES * 60 * 1000).toISOString(),
    };
  }

  // ─────────────────────────────────────────────
  // CHECK PAYMENT STATUS (poll fallback if webhook is delayed/missed)
  // Endpoint per IntaSend docs: GET /v1/payment/status/{invoice_id}/
  // NOT independently verified against a real call — same caveat as
  // triggerStkPush above. Confirm the exact path/response shape with
  // a real test before relying on this for production polling.
  // ─────────────────────────────────────────────
  async checkStatus(invoiceId) {
    if (!this.secretKey) {
      throw new Error('IntaSend is not configured (missing INTASEND_SECRET_KEY).');
    }
    try {
      const response = await axios.get(
        `${this.baseUrl}/v1/payment/status/${invoiceId}/`,
        { headers: this._headers(), timeout: 15000 }
      );
      return response.data;
    } catch (err) {
      logger.error('IntaSend checkStatus failed', {
        invoiceId, status: err.response?.status, detail: err.response?.data, rawMessage: err.message,
      });
      throw err;
    }
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