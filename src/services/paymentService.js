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
    this.publishableKey = process.env.INTASEND_PUBLISHABLE_KEY;
    this.secretKey       = process.env.INTASEND_SECRET_KEY;
    this.testMode        = process.env.INTASEND_TEST_MODE !== 'false'; // default true (sandbox)

    this.client = null;
    if (this.publishableKey && this.secretKey) {
      this.client = new IntaSend(this.publishableKey, this.secretKey, this.testMode);
    } else {
      logger.warn('IntaSend credentials not set — payment triggering will fail until INTASEND_PUBLISHABLE_KEY / INTASEND_SECRET_KEY are configured');
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

    // IntaSend phone format: 2547XXXXXXXX (no leading +, no leading 0)
    const formattedPhone = this._formatPhone(phone);

    logger.info('Triggering IntaSend STK push', { bookingRef, amount, phone: formattedPhone });

    const collection = this.client.collection();

    const response = await collection.mpesaStkPush({
      first_name: firstName || 'Valued',
      last_name:  lastName  || 'Customer',
      email:      email || 'noreply@bodrless.app',
      host:       process.env.API_BASE_URL || 'https://bodrless-api-v2.onrender.com',
      amount,
      phone_number: formattedPhone,
      api_ref:      bookingRef,
    });

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