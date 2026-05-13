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
   * Each package is sent as a separate interactive message
   */
  async sendPackages(phoneNumberId, to, packages) {
    // Send intro
    await this.sendText(phoneNumberId, to,
      `I found ${packages.length} options for your trip! Here they are:`
    );

    // Send each package
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      await this._sendPackageCard(phoneNumberId, to, pkg, i + 1);

      // Small delay between messages to preserve order
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Send closing
    await this.sendText(phoneNumberId, to,
      'Reply with the option number you prefer and we\'ll get your booking sorted! 🎉'
    );
  }

  /**
   * Format a single package as a WhatsApp message
   */
  async _sendPackageCard(phoneNumberId, to, pkg, index) {
    const transport = pkg.transport;
    const hotel = pkg.hotel;
    const transfers = pkg.transfers;

    const text = [
      `*Option ${index} — $${pkg.summary.pricePerPerson}/person*`,
      `━━━━━━━━━━━━━━━━`,
      `✈️ *Transport*`,
      `  ${transport.providerName || transport.provider} · ${transport.flightNumber || ''}`,
      `  ${this._formatTime(transport.departureTime)} → ${this._formatTime(transport.arrivalTime)}`,
      `  ${transport.stops === 0 ? 'Direct' : `${transport.stops} stop(s)`} · ${this._formatDuration(transport.duration)}`,
      `  Baggage: ${this._formatBaggage(transport.baggage)}`,
      `  Cancellation: ${transport.cancellationPolicy}`,
      ``,
      `🏨 *Hotel*`,
      `  ${hotel.name} ${'⭐'.repeat(hotel.stars)}`,
      `  Rating: ${hotel.rating}/10 (${hotel.reviewCount} reviews)`,
      `  ${hotel.roomType}`,
      `  ${hotel.nights} nights · Cancellation: ${hotel.cancellationPolicy}`,
      ``,
      transfers ? [
        `🚗 *Transfer*`,
        `  ${transfers.vehicleType} · Airport to hotel`,
        `  Included`,
        ``,
      ].join('\n') : '',
      `💰 *Total: $${pkg.summary.totalPrice}* for ${pkg.summary.passengers} traveler(s)`,
    ].filter(Boolean).join('\n');

    return this._send(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
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
          }
        }
      );
      return response.data;
    } catch (error) {
      logger.error('WhatsApp send failed', {
        error: error.response?.data || error.message
      });
      throw error;
    }
  }

  // ── Formatters ──────────────────────────────────────────────

  _formatTime(isoString) {
    if (!isoString) return 'TBC';
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  }

  _formatDuration(duration) {
    if (!duration) return '';
    // Parse ISO 8601 duration e.g. PT2H10M
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
    if (!match) return duration;
    const hours = match[1] || '0';
    const mins = match[2] || '00';
    return `${hours}h ${mins}m`;
  }

  _formatBaggage(baggage) {
    if (!baggage) return 'Check airline';
    if (baggage.quantity) return `${baggage.quantity}x ${baggage.weight?.value}${baggage.weight?.unit}`;
    return 'Included';
  }
}

module.exports = new WhatsAppService();
