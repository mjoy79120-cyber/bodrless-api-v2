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
 *
 * SCROLL ORDER FIX:
 *   Packages are sent in REVERSE order (4→3→2→1) so Option 1
 *   is the last message sent and therefore sits at the bottom
 *   of the screen — right where the user's thumb already is.
 *   Display numbers are preserved correctly (i+1).
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

  // ─────────────────────────────────────────────
  // SEND IMAGE
  // ─────────────────────────────────────────────
  async sendImage(phoneNumberId, to, imageUrl, caption = null) {
    if (!imageUrl) return null;
    try {
      return await this._send(phoneNumberId, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'image',
        image: {
          link: imageUrl,
          ...(caption ? { caption: caption.slice(0, 1024) } : {}),
        },
      });
    } catch (err) {
      logger.warn('WhatsApp sendImage failed — continuing without it', { error: err.message, imageUrl });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // SEND REPLY BUTTONS
  // Up to 3 quick-reply buttons. Title hard-limited to 20 chars
  // by WhatsApp — enforced here so long titles don't get rejected.
  // ─────────────────────────────────────────────
  async sendButtons(phoneNumberId, to, bodyText, buttons) {
    if (!Array.isArray(buttons) || buttons.length === 0) return null;
    try {
      return await this._send(phoneNumberId, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: String(bodyText || '').slice(0, 1024) },
          action: {
            buttons: buttons.slice(0, 3).map(b => ({
              type: 'reply',
              reply: { id: b.id, title: String(b.title || '').slice(0, 20) },
            })),
          },
        },
      });
    } catch (err) {
      logger.warn('WhatsApp sendButtons failed — continuing without it', { error: err.message, bodyText });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // SEND LIST MESSAGE
  // Up to 10 tappable options in a scrollable menu.
  // Title max 24 chars, description max 72 chars.
  // ─────────────────────────────────────────────
  async sendList(phoneNumberId, to, bodyText, buttonLabel, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    try {
      return await this._send(phoneNumberId, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: String(bodyText || '').slice(0, 1024) },
          action: {
            button: String(buttonLabel || 'Select').slice(0, 20),
            sections: [{
              rows: options.slice(0, 10).map(o => ({
                id:          o.id,
                title:       String(o.title || '').slice(0, 24),
                ...(o.description ? { description: String(o.description).slice(0, 72) } : {}),
              })),
            }],
          },
        },
      });
    } catch (err) {
      logger.warn('WhatsApp sendList failed — continuing without it', { error: err.message, bodyText });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // SEND PACKAGES
  // ─────────────────────────────────────────────
  // Packages are sent in REVERSE ORDER (highest index first) so
  // that Option 1 is the LAST message delivered and therefore
  // appears at the BOTTOM of the screen — right where the
  // traveler's thumb is resting. They scroll UP to compare 2/3/4.
  //
  // Display numbers (i+1) are preserved correctly regardless of
  // send order — the loop uses the original index.
  //
  // The intro "I found N options" header is still sent FIRST so
  // it appears above all cards as context, then the cards stack
  // below it in reverse, then the "reply with option number"
  // footer arrives last — just before Option 1 — so the reading
  // order from bottom is: Option 1 → footer → Option 2 → ...
  //
  // Wait — footer must arrive AFTER Option 1 (after the last
  // card) so it sits at the very bottom for easy tapping.
  // Send order: header → cards reversed (4,3,2,1) → footer.
  // ─────────────────────────────────────────────
  async sendPackages(phoneNumberId, to, packages, { legHeader = null } = {}) {
    if (!packages || packages.length === 0) return;

    const isItinerary = packages.length === 1 && packages[0]?.isMultiDestination;

    // ── Header ──────────────────────────────────────────────
    // If this is being called from within a leg flow, show a
    // leg-specific header instead of the generic one.
    if (legHeader) {
      await this.sendText(phoneNumberId, to, legHeader);
    } else {
      await this.sendText(phoneNumberId, to,
        isItinerary
          ? `🗺️ I've put together your multi-stop itinerary:`
          : `🧭 I found *${packages.length} option${packages.length > 1 ? 's' : ''}* for your trip! Here they are:`
      );
    }

    // ── Cards in reverse order ───────────────────────────────
    // Send highest-numbered option first so Option 1 lands last
    // (most recent) at the bottom of the traveler's screen.
    for (let i = packages.length - 1; i >= 0; i--) {
      const pkg = packages[i];
      if (pkg.isMultiDestination) {
        await this._sendItineraryCard(phoneNumberId, to, pkg);
      } else {
        await this._sendPackageCard(phoneNumberId, to, pkg, i + 1);
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // ─────────────────────────────────────────────
  // SEND LEG PACKAGES
  // Wrapper used by the leg flow in webhooks.js.
  // Builds the leg-specific header and progress line, then
  // delegates to sendPackages for the reversed card delivery.
  // ─────────────────────────────────────────────
  async sendLegPackages(phoneNumberId, to, { leg, legIndex, totalLegs, runningTotalKES }) {
    const legNum     = legIndex + 1;
    const currency   = 'KES';
    const hasRunning = runningTotalKES > 0;

    // Progress indicator: "Leg 2 of 4"
    const progressLine = `*Leg ${legNum} of ${totalLegs}*`;

    // Running total so far (not shown for first leg — nothing selected yet)
    const runningLine = hasRunning
      ? `💰 Running total so far: *${currency} ${runningTotalKES.toLocaleString()}*\n`
      : '';

    const header = [
      progressLine,
      '━━━━━━━━━━━━━━━━',
      runningLine + leg.text,
      '',
      `Reply *1*${leg.packages.length > 1 ? `–*${leg.packages.length}*` : ''} to choose an option for this leg.`,
    ].filter(Boolean).join('\n');

    await this.sendPackages(phoneNumberId, to, leg.packages, { legHeader: header });
  }

  // ─────────────────────────────────────────────
  // TRANSPORT MODE META
  // ─────────────────────────────────────────────
  _transportMeta(transportType) {
    const type = (transportType || 'flight').toLowerCase();
    if (type === 'bus')   return { type, icon: '🚌', label: 'Bus',   operatorWord: 'Operator' };
    if (type === 'train') return { type, icon: '🚆', label: 'Train', operatorWord: 'Service' };
    return { type: 'flight', icon: '✈️', label: 'Flight', operatorWord: 'Airline' };
  }

  // ─────────────────────────────────────────────
  // FORMAT A TRANSPORT PRICE LINE
  // ─────────────────────────────────────────────
  _formatPriceLine(transport) {
    const currency = transport.currency || 'KES';
    if (transport.priceOnRequest) {
      return `  Price: Contact operator to confirm`;
    }
    return `  Price: ${currency} ${(transport.price || 0).toLocaleString()}`;
  }

  /**
   * Format a single package as a WhatsApp message.
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
      const meta = this._transportMeta(transport.transportType);
      lines.push('');
      lines.push(`*${meta.icon} Outbound ${meta.label}*`);

      if (meta.type === 'train') {
        lines.push(`  Service: ${transport.serviceName || transport.provider || 'SGR'}${transport.trainClass ? ' · ' + transport.trainClass.replace('_', ' ') : ''}`);
        lines.push(`  From: ${transport.origin || 'TBC'} → ${transport.destination || 'TBC'}`);
        if (transport.departureTime) lines.push(`  Departs: ${this._formatScheduleTime(transport.departureTime)}`);
        if (transport.stopsNote) lines.push(`  Stops: ${transport.stopsNote}`);
        lines.push(`  ${transport.policySummary || (transport.canBook ? 'Bookable via SGR' : 'Not yet bookable through Bodrless — purchase directly via SGR')}`);
      } else {
        lines.push(`  ${meta.operatorWord}: ${transport.airline || transport.provider || 'TBC'}${transport.busType ? ' · ' + transport.busType : ''}`);
        lines.push(`  From: ${transport.origin || 'TBC'} → ${transport.destination || 'TBC'}`);
        lines.push(`  Departs: ${this._formatTime(transport.departureTime)} · Arrives: ${this._formatTime(transport.arrivalTime)}`);
        if (transport.stops) lines.push(`  Stops: ${transport.stops}`);
        if (transport.cabinClass) lines.push(`  Class: ${transport.cabinClass}`);
        if (meta.type === 'flight' && transport.baggageSummary) lines.push(`  Baggage: ${transport.baggageSummary}`);
        if (transport.policySummary || transport.cancellationPolicy) {
          const icon = transport.isRefundable === true ? '✅' : transport.isRefundable === false ? '❌' : 'ℹ️';
          lines.push(`  ${icon} *${transport.policySummary || (meta.type === 'bus' ? transport.cancellationPolicy : null) || 'Confirmed at booking'}*`);
        }
      }

      if (transport.routeNote) lines.push(`  ℹ️ ${transport.routeNote}`);

      lines.push(this._formatPriceLine(transport));
    }

    // ── Return transport ────────────────────────────
    if (returnTransport) {
      const meta = this._transportMeta(returnTransport.transportType);
      lines.push('');
      lines.push(`*${meta.icon} Return ${meta.label}*`);

      if (meta.type === 'train') {
        lines.push(`  Service: ${returnTransport.serviceName || returnTransport.provider || 'SGR'}${returnTransport.trainClass ? ' · ' + returnTransport.trainClass.replace('_', ' ') : ''}`);
        lines.push(`  From: ${returnTransport.origin || 'TBC'} → ${returnTransport.destination || 'TBC'}`);
        if (returnTransport.departureTime) lines.push(`  Departs: ${this._formatScheduleTime(returnTransport.departureTime)}`);
        if (returnTransport.stopsNote) lines.push(`  Stops: ${returnTransport.stopsNote}`);
        lines.push(`  ${returnTransport.policySummary || (returnTransport.canBook ? 'Bookable via SGR' : 'Not yet bookable through Bodrless — purchase directly via SGR')}`);
      } else {
        lines.push(`  ${meta.operatorWord}: ${returnTransport.airline || returnTransport.provider || 'TBC'}${returnTransport.busType ? ' · ' + returnTransport.busType : ''}`);
        lines.push(`  From: ${returnTransport.origin || 'TBC'} → ${returnTransport.destination || 'TBC'}`);
        lines.push(`  Departs: ${this._formatTime(returnTransport.departureTime)} · Arrives: ${this._formatTime(returnTransport.arrivalTime)}`);
        if (returnTransport.stops) lines.push(`  Stops: ${returnTransport.stops}`);
        if (meta.type === 'flight' && returnTransport.baggageSummary) lines.push(`  Baggage: ${returnTransport.baggageSummary}`);
        if (returnTransport.policySummary || returnTransport.cancellationPolicy) {
          const rtIcon = returnTransport.isRefundable === true ? '✅' : returnTransport.isRefundable === false ? '❌' : 'ℹ️';
          lines.push(`  ${rtIcon} *${returnTransport.policySummary || (meta.type === 'bus' ? returnTransport.cancellationPolicy : null) || 'Confirmed at booking'}*`);
        }
      }

      if (returnTransport.routeNote) lines.push(`  ℹ️ ${returnTransport.routeNote}`);

      lines.push(this._formatPriceLine(returnTransport));
    }

    // ── Hotel ───────────────────────────────────────
    if (hotel) {
      const stars = hotel.stars ? '⭐'.repeat(Math.min(Number(hotel.stars) || 0, 5)) : '';
      const hCurrency = hotel.currency || 'KES';
      lines.push('');
      lines.push('*🏨 Hotel*');
      lines.push(`  ${hotel.name || 'TBC'} ${stars}`.trim());
      if (hotel.location) lines.push(`  Location: ${hotel.location}`);
      if (hotel.rating)   lines.push(`  Rating: ${hotel.rating}/5`);
      if (hotel.mealPlan) lines.push(`  🍽️ *Board: ${hotel.mealPlan}*`);
      const hIcon = hotel.isRefundable === false ? '❌' : '✅';
      lines.push(`  ${hIcon} *${hotel.policySummary || (hotel.isRefundable === false ? 'Non-refundable rate' : 'Refundable — confirmed at booking')}*`);
      lines.push(`  ${hCurrency} ${(hotel.pricePerNight || 0).toLocaleString()}/night × ${summary.nights || 1} nights`);
    }

    // ── Transfers ───────────────────────────────────
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

    // ── Connection advisory ─────────────────────────
    if (pkg.connectionAdvisory) {
      lines.push('');
      lines.push(`⚠️ ${pkg.connectionAdvisory}`);
    }

    // ── Hub transfer note ───────────────────────────
    if (pkg.hubTransferNote) {
      lines.push('');
      lines.push(`ℹ️ ${pkg.hubTransferNote}`);
    }

    // ── Total ───────────────────────────────────────
    lines.push('');
    lines.push(`*Total: ${totalCurrency} ${(summary.totalPrice || 0).toLocaleString()}* for ${summary.passengers || 1} traveler(s)`);
    if (summary.pricePerPerson) {
      lines.push(`_(${totalCurrency} ${summary.pricePerPerson.toLocaleString()} per person)_`);
    }
    if (summary.priceCaveat) {
      lines.push(`⚠️ _${summary.priceCaveat}_`);
    }

    const result = await this._send(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: lines.join('\n') },
    });

    // Tap-to-reveal photo button
    if (hotel?.images?.length > 0) {
      await this.sendButtons(phoneNumberId, to,
        `Want to see a photo of ${hotel.name || 'this hotel'}?`,
        [{ id: `photo_${index - 1}`, title: '📷 View Photo' }]
      );
    }

    return result;
  }

  /**
   * Format a multi-destination itinerary as a WhatsApp message.
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

      const t = leg.transportIn;
      if (t) {
        const meta = this._transportMeta(t.transportType);
        lines.push(`  ${meta.icon} ${t.origin || 'TBC'} → ${t.destination || 'TBC'}`);
        if (meta.type === 'train') {
          lines.push(`    Service: ${t.serviceName || t.provider || 'SGR'}${t.trainClass ? ' · ' + t.trainClass.replace('_', ' ') : ''} · ${this._formatScheduleTime(t.departureTime)}`);
        } else {
          lines.push(`    ${meta.operatorWord}: ${t.airline || t.provider || 'TBC'} · ${this._formatTime(t.departureTime)}–${this._formatTime(t.arrivalTime)}`);
        }
        if (leg.connectsVia && !isBuffer) {
          lines.push(`    _Connects via ${this._titleCase(leg.connectsVia)}_`);
        }
        lines.push(`    ${t.priceOnRequest ? 'Price: Contact operator to confirm' : `Price: ${t.currency || 'KES'} ${(t.price || 0).toLocaleString()}`}`);
      } else if (!isBuffer) {
        lines.push(`  ⚠️ Transport for this leg still to be confirmed`);
      }

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

      if (leg.transfers) {
        const tr = leg.transfers;
        const trCurrency = tr.currency || 'KES';
        lines.push(`  🚗 ${tr.provider || 'Transfer'}: ${trCurrency} ${(tr.price || 0).toLocaleString()}`);
      }
    });

    if (pkg.returnTransport) {
      const rt = pkg.returnTransport;
      const meta = this._transportMeta(rt.transportType);
      lines.push('');
      lines.push(`*Return*`);
      lines.push(`  ${meta.icon} ${rt.origin || 'TBC'} → ${rt.destination || 'TBC'}`);
      if (meta.type === 'train') {
        lines.push(`    ${this._formatScheduleTime(rt.departureTime)} · ${rt.serviceName || rt.provider || 'SGR'}${rt.trainClass ? ' · ' + rt.trainClass.replace('_', ' ') : ''}`);
      } else {
        lines.push(`    ${this._formatTime(rt.departureTime)}–${this._formatTime(rt.arrivalTime)}`);
      }
      lines.push(`    ${rt.priceOnRequest ? 'Price: Contact operator to confirm' : `${rt.currency || 'KES'} ${(rt.price || 0).toLocaleString()}`}`);
    }

    lines.push('');
    lines.push(`*Total: ${totalCurrency} ${(summary.totalPrice || 0).toLocaleString()}* for ${summary.passengers || 1} traveler(s)`);
    if (summary.pricePerPerson) {
      lines.push(`_(${totalCurrency} ${summary.pricePerPerson.toLocaleString()} per person)_`);
    }
    if (summary.priceCaveat) {
      lines.push(`⚠️ _${summary.priceCaveat}_`);
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

  _formatScheduleTime(value) {
    if (!value) return 'TBC';
    if (/^\d{1,2}:\d{2}$/.test(value)) return value;
    return this._formatTime(value);
  }

  _titleCase(str) {
    if (!str) return '';
    return str.replace(/\b\w/g, c => c.toUpperCase());
  }
}

module.exports = new WhatsAppService();