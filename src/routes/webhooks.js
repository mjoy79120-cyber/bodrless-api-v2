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

  // ─────────────────────────────────────────────
  // SEND IMAGE
  // WhatsApp Business API's 'image' message type accepts either a
  // direct public URL ({link: ...}) or a pre-uploaded media ID —
  // using `link` since HotelBeds' hotel.images URLs are already
  // public HTTPS URLs, no separate upload-to-Meta step needed.
  // NOT YET VERIFIED against a real WhatsApp send — same "test
  // before trusting" rule as every other new integration this
  // session. Caption is optional; WhatsApp limits it to 1024 chars.
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
      // Image delivery failing (bad URL, WhatsApp couldn't fetch it,
      // unsupported format) must NEVER block the actual package
      // text from sending — this is a nice-to-have, not core
      // functionality. Log and continue silently.
      logger.warn('WhatsApp sendImage failed — continuing without it', { error: err.message, imageUrl });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // SEND REPLY BUTTONS
  // WhatsApp Business API's 'interactive' message type, 'button'
  // subtype — up to 3 quick-reply buttons, each with an id (returned
  // verbatim in the traveler's next message as
  // message.interactive.button_reply.id — see webhooks.js) and a
  // title (WhatsApp hard-limits this to 20 characters, enforced here
  // so a longer title doesn't silently get rejected by the API).
  // NOT YET VERIFIED against a real WhatsApp send — same "test
  // before trusting" rule as every other new integration this
  // session.
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
      // Same posture as sendImage — an optional interactive prompt
      // failing must never block the core package/text flow.
      logger.warn('WhatsApp sendButtons failed — continuing without it', { error: err.message, bodyText });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // SEND LIST MESSAGE
  // WhatsApp Business API's 'interactive' message type, 'list'
  // subtype — up to 10 options in a single tappable scrollable menu
  // (vs sendButtons' hard 3-option limit). Used for combined
  // Gender+Traveler-type selection during booking (see
  // whatsappBooking.js) so a passenger only needs ONE tap instead of
  // two separate button rounds. Title max 24 chars, description max
  // 72 chars per WhatsApp's real limits — enforced here.
  // NOT YET VERIFIED against a real WhatsApp send — same "test
  // before trusting" rule as every other new integration this
  // session.
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

    // NOTE: intro line intentionally uses a neutral icon (🧭), not a
    // flight-specific one — a single search can now legitimately
    // return a MIX of modes (e.g. a flight package, a bus package,
    // and an SGR train package all for the same "Nairobi to Kilifi"
    // search — see engine.js's corridor routing). A hardcoded ✈️
    // here would misrepresent the list before the traveler even
    // opens it.
    await this.sendText(phoneNumberId, to,
      isItinerary
        ? `🗺️ I've put together your multi-stop itinerary:`
        : `🧭 I found *${packages.length} option(s)* for your trip! Here they are:`
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

  // ─────────────────────────────────────────────
  // TRANSPORT MODE META — icon + label, one place for both
  // _sendPackageCard and _sendItineraryCard so flight/bus/train
  // never drift out of sync again. A transport object with no
  // recognized transportType (or none at all) falls back to the
  // flight treatment, matching the pre-existing default elsewhere
  // in this codebase (engine.js's _formatTransportDisplay does the
  // same: `t.transportType || 'flight'`).
  // ─────────────────────────────────────────────
  _transportMeta(transportType) {
    const type = (transportType || 'flight').toLowerCase();
    if (type === 'bus')   return { type, icon: '🚌', label: 'Bus',   operatorWord: 'Operator' };
    if (type === 'train') return { type, icon: '🚆', label: 'Train', operatorWord: 'Service' };
    return { type: 'flight', icon: '✈️', label: 'Flight', operatorWord: 'Airline' };
  }

  // ─────────────────────────────────────────────
  // FORMAT A TRANSPORT PRICE LINE
  // priceOnRequest entries (static bus operator catalog — Buscar/
  // Dreamline/Mash shown when live IABIRI has nothing for a route —
  // see engine.js's _searchStaticBusOperators) have price: null on
  // purpose, since no real fare is known. `(price || 0)` would
  // silently show "KES 0", implying the trip is free. Show an
  // honest "contact operator" line instead.
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

      // routeNote — e.g. "Buscar runs Nairobi <-> Malindi and stops
      // at Kilifi along the way" — critical operational context for
      // through-route bus entries, previously not shown at all.
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

    // ── Hotel (only if present) ─────────────────────
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

    // ── Connection advisory (e.g. "Meru -> Nairobi" not bookable) ──
    if (pkg.connectionAdvisory) {
      lines.push('');
      lines.push(`⚠️ ${pkg.connectionAdvisory}`);
    }

    // ── Hub transfer note (e.g. flight lands at Malindi for a
    // Kilifi/Watamu trip — the transfer IS included, this just
    // explains why an airport/station other than the destination
    // itself shows up in the itinerary) ──
    if (pkg.hubTransferNote) {
      lines.push('');
      lines.push(`ℹ️ ${pkg.hubTransferNote}`);
    }

    // ── Total (always canonical currency — KES) ──────
    lines.push('');
    lines.push(`*Total: ${totalCurrency} ${(summary.totalPrice || 0).toLocaleString()}* for ${summary.passengers || 1} traveler(s)`);
    if (summary.pricePerPerson) {
      lines.push(`_(${totalCurrency} ${summary.pricePerPerson.toLocaleString()} per person)_`);
    }
    // priceCaveat — set by engine.js whenever a leg's fare is
    // priceOnRequest (static bus catalog) and was therefore excluded
    // from totalPrice above, so the traveler never mistakes this
    // total for a complete, final price.
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

    // TAP-TO-REVEAL PHOTO — button ID encodes the package's index
    // (0-based) so the webhook handler can look it up directly from
    // the SAME recentPackagesByPhone cache already used for "reply
    // with the option number to book" — no separate correlation
    // table needed. Never sent automatically; this is a deliberate
    // opt-in tap, since auto-sending an image per option can be
    // heavy on a limited data bundle (a real, common constraint in
    // this market) — see webhooks.js for the reply handler.
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

    // ── Combined total ─────────────────────────────────
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

  // ─────────────────────────────────────────────
  // FORMAT A BARE "HH:MM" SCHEDULE TIME (SGR static entries store
  // departureTime as a plain "08:00" string, not an ISO timestamp —
  // _formatTime above expects ISO and would print "Invalid Date" or
  // echo the raw string oddly via `new Date(isoString)`. Kept
  // separate rather than overloading _formatTime, since the two
  // input shapes (ISO datetime vs. bare HH:MM) genuinely differ.
  // ─────────────────────────────────────────────
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