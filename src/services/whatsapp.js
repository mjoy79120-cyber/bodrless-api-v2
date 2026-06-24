/**
 * WHATSAPP SERVICE
 * ─────────────────────────────────────────────────────────────
 * Sends messages back to travelers via WhatsApp Business API.
 * Formats trip packages as interactive WhatsApp messages.
 *
 * Handles two distinct package shapes:
 *   - Single-destination packages (pkg.transport/hotel/transfers
 *     as flat fields) -> _sendPackageCard (unchanged)
 *   - Multi-destination itineraries (pkg.isMultiDestination,
 *     pkg.legs[], pkg.returnTransport) -> _sendItineraryCard
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
   * Each package is sent as a separate message.
   *
   * Multi-destination itineraries (pkg.isMultiDestination) are
   * routed to _sendItineraryCard instead of _sendPackageCard,
   * since they have a fundamentally different shape (legs[]
   * instead of flat transport/hotel/transfers fields) and there
   * is normally only one combined itinerary per search, not
   * several alternatives.
   */
  async sendPackages(phoneNumberId, to, packages) {
    const isItinerary = packages.length === 1 && packages[0]?.isMultiDestination;

    await this.sendText(phoneNumberId, to,
      isItinerary
        ? `🗺️ I've put together your multi-stop itinerary:`
        : `✈️ I found *${packages.length} option(s)* for your trip! Here they are:`
    );

    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      if (pkg.isMultiDestination) {
        await this._sendItineraryCard(phoneNumberId, to, pkg);
      } else {
        await this._sendPackageCard(phoneNumberId, to, pkg, i + 1);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await this.sendText(phoneNumberId, to,
      isItinerary
        ? "Let me know if you'd like to book this, or adjust any part of it!"
        : "Reply with the option number you prefer and we'll get your booking sorted!"
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
   * Format a multi-destination itinerary as a WhatsApp message.
   *
   * Shows each stop in order — transport arriving there, the
   * stay itself, then moves to the next stop. Buffer nights
   * (inserted automatically when a leg involves an airstrip
   * destination, e.g. Maasai Mara) are clearly labeled as
   * connections, not presented as a stop the traveler asked for.
   * Ends with one combined total across the whole itinerary.
   */
  async _sendItineraryCard(phoneNumberId, to, pkg) {
    const summary = pkg.summary || {};
    const legs    = pkg.legs    || [];
    const totalCurrency = summary.currency || 'KES';

    const lines = [
      `*🗺️ ${summary.route || 'Your Itinerary'}*`,
      `━━━━━━━━━━━━━━━━`,
      `*Travelers:* ${summary.passengers || 1}`,
      `*Total nights:* ${summary.totalNights || 0}`,
    ];

    legs.forEach((leg, i) => {
      const stopNumber = i + 1;
      const isBuffer = leg.isBufferLeg;

      lines.push('');

      if (isBuffer) {
        lines.push(`*— Connection: overnight in ${this._titleCase(leg.destination)} —*`);
        lines.push(`  Connecting between destinations · 1 night`);
      } else {
        lines.push(`*Stop ${stopNumber}: ${this._titleCase(leg.destination)}* (${leg.nights} night${leg.nights === 1 ? '' : 's'})`);
      }

      // ── Transport arriving at this stop ────────────
      const t = leg.transportIn;
      if (t) {
        const isbus = (t.transportType || '').toLowerCase() === 'bus';
        const tCurrency = t.currency || 'KES';
        lines.push(`  ${isbus ? '🚌' : '✈️'} ${t.origin || 'TBC'} → ${t.destination || 'TBC'}`);
        lines.push(`    ${isbus ? 'Operator' : 'Airline'}: ${t.airline || t.provider || 'TBC'} · ${this._formatTime(t.departureTime)}–${this._formatTime(t.arrivalTime)}`);
        if (leg.connectsVia && !isBuffer) {
          lines.push(`    _Connects via ${this._titleCase(leg.connectsVia)}_`);
        }
        lines.push(`    Price: ${tCurrency} ${(t.price || 0).toLocaleString()}`);
      } else if (!isBuffer) {
        lines.push(`  ⚠️ Transport for this leg still to be confirmed`);
      }

      // ── Hotel for this stop ─────────────────────────
      if (leg.hotel) {
        const h = leg.hotel;
        const stars = h.stars ? '⭐'.repeat(Math.min(Number(h.stars) || 0, 5)) : '';
        const hCurrency = h.currency || 'KES';
        const hotelLine = `  🏨 ${h.name || 'TBC'} ${stars}`.replace(/\s+$/, '');
        lines.push(hotelLine);
        if (h.location) lines.push(`    ${h.location}`);
        lines.push(`    ${hCurrency} ${(h.pricePerNight || 0).toLocaleString()}/night × ${leg.nights} night${leg.nights === 1 ? '' : 's'}`);
      } else if (!isBuffer) {
        lines.push(`  ⚠️ Hotel for this stop still to be confirmed`);
      }

      // ── Transfer for this stop ──────────────────────
      if (leg.transfers) {
        const tr = leg.transfers;
        const trCurrency = tr.currency || 'KES';
        lines.push(`  🚗 ${tr.provider || 'Transfer'}: ${trCurrency} ${(tr.price || 0).toLocaleString()}`);
      }
    });

    // ── Final return-to-origin transport ──────────────
    if (pkg.returnTransport) {
      const rt = pkg.returnTransport;
      const isbus = (rt.transportType || '').toLowerCase() === 'bus';
      const rtCurrency = rt.currency || 'KES';
      lines.push('');
      lines.push(`*Return*`);
      lines.push(`  ${isbus ? '🚌' : '✈️'} ${rt.origin || 'TBC'} → ${rt.destination || 'TBC'}`);
      lines.push(`    ${this._formatTime(rt.departureTime)}–${this._formatTime(rt.arrivalTime)} · ${rtCurrency} ${(rt.price || 0).toLocaleString()}`);
    }

    // ── Combined total ─────────────────────────────────
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

  _titleCase(str) {
    if (!str) return '';
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }
}

module.exports = new WhatsAppService();