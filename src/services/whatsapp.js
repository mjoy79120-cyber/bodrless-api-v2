/**
 * WHATSAPP SERVICE
 * ─────────────────────────────────────────────────────────────
 * Sends messages back to travelers via WhatsApp Business API.
 * Formats trip packages as interactive WhatsApp messages.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';

class WhatsAppService {

  /**
   * Send a plain text message
   */
  async sendText(phoneNumberId, to, text) {
    return this._send(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    });
  }

  /**
   * Send trip packages as formatted WhatsApp messages
   * Each package is sent as a separate message
   */
  async sendPackages(phoneNumberId, to, packages) {
    await this.sendText(phoneNumberId, to,
      `✈️ I found *${packages.length} option(s)* for your trip! Here they are:`
    );

    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      await this._sendPackageCard(phoneNumberId, to, pkg, i + 1);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await this.sendText(phoneNumberId, to,
      "Reply with the option number you prefer and we'll get your booking sorted!"
    );
  }

  /**
   * Format a single package as a WhatsApp message.
   * Sections (hotel, transfer) are only shown when data exists.
   */
  async _sendPackageCard(phoneNumberId, to, pkg, index) {
    const transport       = pkg.transport       || null;
    const returnTransport = pkg.returnTransport || null;
    const hotel           = pkg.hotel           || null;
    const transfers       = pkg.transfers       || null;
    const summary         = pkg.summary         || {};

    const totalCurrency = summary.currency || 'KES';

    const lines = [
      `*Option ${index}*`,
      `━━━━━━━━━━━━━━━━`,
      `*Route:* ${summary.route || 'N/A'}`,
      `*Travelers:* ${summary.passengers || 1}`,
    ];

    if (summary.nights > 0) {
      lines.push(`*Nights:* ${summary.nights}`);
    }

    // ── Outbound transport ──────────────────────────
    if (transport) {
      const isbus = (transport.transportType || '').toLowerCase() === 'bus';
      const tCurrency = transport.currency || 'KES';
      lines.push('');
      lines.push(isbus ? '*🚌 Outbound Bus*' : '*✈️ Outbound Flight*');
      lines.push(`  ${isbus ? 'Operator' : 'Airline'}: ${transport.airline || transport.provider || 'TBC'}`);
      lines.push(`  From: ${transport.origin || 'TBC'} → ${transport.destination || 'TBC'}`);
      lines.push(`  Departs: ${this._formatTime(transport.departureTime)} · Arrives: ${this._formatTime(transport.arrivalTime)}`);
      if (transport.stops) lines.push(`  Stops: ${transport.stops}`);
      if (transport.cabinClass) lines.push(`  Class: ${transport.cabinClass}`);
      if (!isbus && transport.baggageSummary) lines.push(`  Baggage: ${transport.baggageSummary}`);
      if (transport.policySummary || transport.cancellationPolicy) {
        lines.push(`  Cancellation: ${transport.policySummary || (isbus ? transport.cancellationPolicy : null) || 'Confirmed at booking'}`);
      }
      lines.push(`  Price: ${tCurrency} ${(transport.price || 0).toLocaleString()}`);
    }

    // ── Return transport ────────────────────────────
    if (returnTransport) {
      const isbus = (returnTransport.transportType || '').toLowerCase() === 'bus';
      const rtCurrency = returnTransport.currency || 'KES';
      lines.push('');
      lines.push(isbus ? '*🚌 Return Bus*' : '*✈️ Return Flight*');
      lines.push(`  ${isbus ? 'Operator' : 'Airline'}: ${returnTransport.airline || returnTransport.provider || 'TBC'}`);
      lines.push(`  From: ${returnTransport.origin || 'TBC'} → ${returnTransport.destination || 'TBC'}`);
      lines.push(`  Departs: ${this._formatTime(returnTransport.departureTime)} · Arrives: ${this._formatTime(returnTransport.arrivalTime)}`);
      if (returnTransport.stops) lines.push(`  Stops: ${returnTransport.stops}`);
      if (!isbus && returnTransport.baggageSummary) lines.push(`  Baggage: ${returnTransport.baggageSummary}`);
      if (returnTransport.policySummary || returnTransport.cancellationPolicy) {
        lines.push(`  Cancellation: ${returnTransport.policySummary || (isbus ? returnTransport.cancellationPolicy : null) || 'Confirmed at booking'}`);
      }
      lines.push(`  Price: ${rtCurrency} ${(returnTransport.price || 0).toLocaleString()}`);
    }

    // ── Hotel (only if present) ─────────────────────
    if (hotel) {
      const stars = hotel.stars ? '⭐'.repeat(Math.min(Number(hotel.stars) || 0, 5)) : '';
      const hCurrency = hotel.currency || 'KES';
      lines.push('');
      lines.push('*🏨 Hotel*');
      lines.push(`  ${hotel.name || 'TBC'} ${stars}`.trim());
      if (hotel.location) lines.push(`  Location: ${hotel.location}`);
      if (hotel.rating)   lines.push(`  Rating: ${hotel.rating}/5`);
      if (hotel.mealPlan) lines.push(`  Meal plan: ${hotel.mealPlan}`);
      lines.push(`  Cancellation: ${hotel.policySummary || (hotel.isRefundable === false ? 'Non-refundable rate' : 'Confirmed at booking')}`);
      lines.push(`  ${hCurrency} ${(hotel.pricePerNight || 0).toLocaleString()}/night × ${summary.nights || 1} nights`);
    }

    // ── Transfers (now an array of legs — departure + arrival) ──
    const transferList = Array.isArray(transfers) ? transfers : (transfers ? [transfers] : []);
    if (transferList.length > 0) {
      lines.push('');
      lines.push('*🚗 Transfer*');
      transferList.forEach(t => {
        const trCurrency = t.currency || 'KES';
        const legLabel = t.legType === 'departure' ? 'Departure' : t.legType === 'arrival' ? 'Arrival' : (t.provider || 'TBC');
        lines.push(`  ${legLabel}: ${t.description || t.location || 'TBC'} — ${trCurrency} ${(t.price || 0).toLocaleString()}`);
      });
    }

    // ── Total (always canonical currency — KES) ──────
    lines.push('');
    lines.push(`*Total: ${totalCurrency} ${(summary.totalPrice || 0).toLocaleString()}* for ${summary.passengers || 1} traveler(s)`);
    if (summary.pricePerPerson) {
      lines.push(`_(${totalCurrency} ${summary.pricePerPerson.toLocaleString()} per person)_`);
    }

    return this._send(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: lines.join('\n') },
    });
  }

  /**
   * Core send function
   */
  async _send(phoneNumberId, payload) {
    try {
      const response = await axios.post(
        `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );
      return response.data;
    } catch (error) {
      logger.error('WhatsApp send failed', {
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  _formatTime(isoString) {
    if (!isoString) return 'TBC';
    const date = new Date(isoString);
    if (isNaN(date)) return isoString;
    return date.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  }
}

module.exports = new WhatsAppService();