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
    // Send intro
    await this.sendText(phoneNumberId, to,
      `✈️ I found *${packages.length} package option(s)* for your trip! Here they are:`
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
    const transport = pkg.transport || {};
    const hotel = pkg.hotel || {};
    const transfers = pkg.transfers || {};

    const stars = hotel.stars ? '⭐'.repeat(Math.min(hotel.stars, 5)) : '';

    const hasTransfer = transfers.provider || transfers.vehicleType;

    const lines = [
      `*Option ${index} — $${pkg.summary.pricePerPerson || 0}/person*`,
      `━━━━━━━━━━━━━━━━`,
      `🗺️ *Route:* ${pkg.summary.route || 'N/A'}`,
      `👥 *Travelers:* ${pkg.summary.passengers || 1}  |  🌙 *Nights:* ${pkg.summary.nights || 1}`,
      ``,
      `✈️ *Flight*`,
      `  Airline: ${transport.airline || 'TBC'}`,
      `  From: ${transport.origin || 'TBC'} → To: ${transport.destination || 'TBC'}`,
      `  Departs: ${transport.departureTime || 'TBC'} · Arrives: ${transport.arrivalTime || 'TBC'}`,
      `  Price: $${transport.price || 0}`,
      ``,
      `🏨 *Hotel*`,
      `  ${hotel.name || 'TBC'} ${stars}`,
      `  Location: ${hotel.location || 'TBC'}`,
      `  Rating: ${hotel.rating || 'N/A'}/5`,
      `  $${hotel.pricePerNight || 0}/night × ${pkg.summary.nights || 1} nights`,
    ];

    if (hasTransfer) {
      lines.push(``);
      lines.push(`🚗 *Transfer*`);
      lines.push(`  Provider: ${transfers.provider || 'TBC'}`);
      lines.push(`  Vehicle: ${transfers.vehicleType || 'Car'}`);
      lines.push(`  Price: $${transfers.price || 0}`);
    }

    lines.push(``);
    lines.push(`💰 *Total: $${pkg.summary.totalPrice || 0}* for ${pkg.summary.passengers || 1} traveler(s)`);

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
    if (isNaN(date)) return isoString;
    return date.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  }
}

module.exports = new WhatsAppService();