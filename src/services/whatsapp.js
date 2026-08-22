/**
 * WHATSAPP SERVICE
 * ─────────────────────────────────────────────────────────────
 * Sends messages back to travelers via WhatsApp Business API.
 * Formats trip packages as interactive WhatsApp messages.
 *
 * Handles two distinct package shapes:
 *   - Single-destination packages (pkg.transport/hotel/transfers
 *     as flat fields) -> _sendPackageCard
 *   - Multi-destination itineraries (pkg.isMultiDestination,
 *     pkg.legs[], pkg.returnTransport) -> _sendItineraryCard
 *
 * BSUID SUPPORT:
 *   When a WhatsApp user has enabled the username feature,
 *   their phone number is not included in webhooks. Instead,
 *   a BSUID (e.g. "KE.4521012381488781") is provided. Meta's
 *   send API requires BSUID-addressed messages to use the
 *   `recipient` field instead of the `to` field. This is
 *   detected automatically in _send() by checking for the
 *   country-code prefix pattern (e.g. "KE.", "US.", "US.ENT.").
 *
 * SCROLL ORDER FIX:
 *   Packages are sent in REVERSE order (4→3→2→1) so Option 1
 *   is the last message sent and therefore sits at the bottom
 *   of the screen — right where the user's thumb already is.
 *   Display numbers are preserved correctly (i+1).
 *
 * VISA INTEL:
 *   Visa notes are pulled from visaIntel.js and appended to
 *   package cards when the origin→destination corridor is known.
 *   Falls back to a generic advisory for unknown corridors.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');
const { getVisaNote } = require('./visaIntel');

// v21.0 required for BSUID send support (v18.0 does not support it)
const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

// ─────────────────────────────────────────────
// SAFE HELPERS — used throughout to avoid
// crashes when engine sends partial/null data
// ─────────────────────────────────────────────

/**
 * Safe number formatter. Returns 'TBC' if value is missing/NaN.
 * @param {*} value
 * @param {string} [currency='KES']
 */
function _fmtPrice(value, currency = 'KES') {
  const n = Number(value);
  if (value == null || isNaN(n)) return 'TBC';
  return `${currency} ${n.toLocaleString()}`;
}

/**
 * Safe integer — returns fallback if value is missing/NaN.
 * @param {*} value
 * @param {*} fallback
 */
function _safeInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

/**
 * Safe string — trims and returns fallback if falsy.
 * @param {*} value
 * @param {string} [fallback='TBC']
 */
function _safeStr(value, fallback = 'TBC') {
  if (value == null) return fallback;
  const s = String(value).trim();
  return s.length > 0 ? s : fallback;
}

/**
 * Clamp a string to maxLen chars (WhatsApp field limits).
 * @param {string} str
 * @param {number} maxLen
 */
function _clamp(str, maxLen) {
  const s = _safeStr(str, '');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * Build a ⭐ star string, safely clamped to 0–5.
 * @param {*} stars
 */
function _starStr(stars) {
  const n = Math.min(Math.max(_safeInt(stars, 0), 0), 5);
  return n > 0 ? '⭐'.repeat(n) : '';
}

/**
 * Format an ISO datetime to HH:MM (en-KE locale).
 * Accepts raw "HH:MM" strings and passes them through.
 * @param {string} value
 */
function _formatTime(value) {
  if (!value) return 'TBC';
  if (/^\d{1,2}:\d{2}$/.test(String(value))) return value;
  const date = new Date(value);
  if (isNaN(date.getTime())) return _safeStr(value, 'TBC');
  return date.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a schedule time value (SGR uses raw "HH:MM" strings).
 * @param {string} value
 */
function _formatScheduleTime(value) {
  if (!value) return 'TBC';
  if (/^\d{1,2}:\d{2}$/.test(String(value))) return value;
  return _formatTime(value);
}

/**
 * Title-case a string.
 * @param {string} str
 */
function _titleCase(str) {
  if (!str) return '';
  return String(str).replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Visa note line for a package, derived from summary.route or
 * explicit origin/destination fields. Always returns a string
 * (generic advisory if corridor not found).
 * @param {Object} summary  — pkg.summary
 * @param {Object} [transport] — outbound transport object
 */
function _visaLine(summary = {}, transport = null) {
  // Try to extract origin + destination from multiple sources
  const origin      = _safeStr(transport?.origin || summary?.origin || '', '');
  const destination = _safeStr(transport?.destination || summary?.destination || '', '');

  if (!origin || !destination) return null;

  const note = getVisaNote(origin, destination);
  if (note) return `📋 *Visa:* ${note}`;

  // Unknown corridor — surface a generic advisory rather than silence
  return `📋 *Visa:* Requirements may apply — verify before travel`;
}

class WhatsAppService {

  // ─────────────────────────────────────────────
  // SEND TEXT
  // ─────────────────────────────────────────────
  async sendText(phoneNumberId, to, text) {
    if (!text) return null;
    return this._send(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: _clamp(text, 4096) },
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
          ...(caption ? { caption: _clamp(caption, 1024) } : {}),
        },
      });
    } catch (err) {
      logger.warn('WhatsApp sendImage failed — continuing without it', { error: err.message, imageUrl });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // SEND REPLY BUTTONS
  // Up to 3 quick-reply buttons. Title hard-limited to 20 chars.
  // ─────────────────────────────────────────────
  async sendButtons(phoneNumberId, to, bodyText, buttons) {
    if (!Array.isArray(buttons) || buttons.length === 0) return null;
    if (!bodyText) return null;
    try {
      return await this._send(phoneNumberId, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: _clamp(bodyText, 1024) },
          action: {
            buttons: buttons.slice(0, 3).map(b => ({
              type: 'reply',
              reply: {
                id:    _clamp(b.id    || '', 256),
                title: _clamp(b.title || '', 20),
              },
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
  // Up to 10 tappable options. Title max 24 chars, desc max 72.
  // ─────────────────────────────────────────────
  async sendList(phoneNumberId, to, bodyText, buttonLabel, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    if (!bodyText) return null;
    try {
      return await this._send(phoneNumberId, {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: _clamp(bodyText, 1024) },
          action: {
            button: _clamp(buttonLabel || 'Select', 20),
            sections: [{
              rows: options.slice(0, 10).map(o => ({
                id:    _safeStr(o.id, ''),
                title: _clamp(o.title || '', 24),
                ...(o.description ? { description: _clamp(o.description, 72) } : {}),
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
  //
  // Send order: header → cards reversed (N…1) → footer.
  // Option 1 lands at the bottom of the screen (thumb position).
  // ─────────────────────────────────────────────
  async sendPackages(phoneNumberId, to, packages, { legHeader = null } = {}) {
    if (!packages || packages.length === 0) return;

    const isItinerary = packages.length === 1 && packages[0]?.isMultiDestination;

    // ── Header ──────────────────────────────────────────────
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
    const reversed = [...packages].reverse();
    for (let ri = 0; ri < reversed.length; ri++) {
      const pkg = reversed[ri];
      // Original display index (1-based) relative to the un-reversed list
      const displayIndex = packages.length - ri;
      try {
        if (pkg.isMultiDestination) {
          await this._sendItineraryCard(phoneNumberId, to, pkg);
        } else {
          await this._sendPackageCard(phoneNumberId, to, pkg, displayIndex);
        }
      } catch (cardErr) {
        // Don't let one broken card kill the whole batch
        logger.error('Package card render error — skipping card', {
          displayIndex,
          error: cardErr.message,
          pkg: JSON.stringify(pkg).slice(0, 200),
        });
        await this.sendText(phoneNumberId, to,
          `⚠️ Option ${displayIndex} could not be displayed — please try again or contact support.`
        );
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // ── Footer ───────────────────────────────────────────────
    if (!isItinerary && packages.length > 1) {
      await this.sendText(phoneNumberId, to,
        `Reply with *1*–*${packages.length}* to choose an option, or ask me to filter by price, airline, or hotel.`
      );
    } else if (!isItinerary) {
      await this.sendText(phoneNumberId, to,
        `Reply *1* to go ahead with this option, or tell me if you'd like changes.`
      );
    }
  }

  // ─────────────────────────────────────────────
  // SEND LEG PACKAGES
  // ─────────────────────────────────────────────
  async sendLegPackages(phoneNumberId, to, { leg, legIndex, totalLegs, runningTotalKES }) {
    const legNum     = legIndex + 1;
    const hasRunning = runningTotalKES > 0;

    const progressLine = `*Leg ${legNum} of ${totalLegs}*`;
    const runningLine  = hasRunning
      ? `💰 Running total so far: *KES ${Number(runningTotalKES).toLocaleString()}*\n`
      : '';

    const legText = _safeStr(leg?.text, '');
    const legPackages = leg?.packages || [];

    const header = [
      progressLine,
      '━━━━━━━━━━━━━━━━',
      runningLine + legText,
      '',
      legPackages.length > 1
        ? `Reply *1*–*${legPackages.length}* to choose an option for this leg.`
        : `Reply *1* to go ahead with this leg.`,
    ].filter(Boolean).join('\n');

    await this.sendPackages(phoneNumberId, to, legPackages, { legHeader: header });
  }

  // ─────────────────────────────────────────────
  // TRANSPORT MODE META
  // ─────────────────────────────────────────────
  _transportMeta(transportType) {
    const type = _safeStr(transportType, 'flight').toLowerCase();
    if (type === 'bus')   return { type, icon: '🚌', label: 'Bus',   operatorWord: 'Operator' };
    if (type === 'train') return { type, icon: '🚆', label: 'Train', operatorWord: 'Service'  };
    return { type: 'flight', icon: '✈️', label: 'Flight', operatorWord: 'Airline' };
  }

  // ─────────────────────────────────────────────
  // FORMAT PRICE LINE
  // ─────────────────────────────────────────────
  _formatPriceLine(transport) {
    if (!transport) return '  Price: TBC';
    const currency = _safeStr(transport.currency, 'KES');
    if (transport.priceOnRequest) return '  Price: Contact operator to confirm';
    return `  Price: ${_fmtPrice(transport.price, currency)}`;
  }

  // ─────────────────────────────────────────────
  // FORMAT REFUNDABILITY ICON + LINE
  // ─────────────────────────────────────────────
  _refundLine(item, fallbackText = 'Confirmed at booking') {
    const policy = _safeStr(item?.policySummary || item?.cancellationPolicy, '');
    if (!policy && item?.isRefundable == null) return null;
    const icon = item?.isRefundable === true  ? '✅'
               : item?.isRefundable === false ? '❌'
               : 'ℹ️';
    return `  ${icon} *${policy || fallbackText}*`;
  }

  // ─────────────────────────────────────────────
  // RENDER OUTBOUND / RETURN TRANSPORT BLOCK
  // Shared between single-destination and itinerary cards.
  // @param {Object} transport
  // @param {string} label — "Outbound Flight", "Return Bus" etc.
  // @returns {string[]} lines to push
  // ─────────────────────────────────────────────
  _transportBlock(transport, label) {
    if (!transport) return [];
    const meta  = this._transportMeta(transport.transportType);
    const lines = [];

    lines.push(`*${meta.icon} ${label || `${meta.label}`}*`);

    if (meta.type === 'train') {
      const service = _safeStr(
        transport.serviceName || transport.provider,
        'SGR'
      );
      const cls = transport.trainClass
        ? ' · ' + String(transport.trainClass).replace('_', ' ')
        : '';
      lines.push(`  Service: ${service}${cls}`);
      lines.push(`  From: ${_safeStr(transport.origin)} → ${_safeStr(transport.destination)}`);
      if (transport.departureTime) {
        lines.push(`  Departs: ${_formatScheduleTime(transport.departureTime)}`);
      }
      if (transport.stopsNote) lines.push(`  Stops: ${transport.stopsNote}`);
      const trainPolicy = transport.policySummary
        || (transport.canBook ? 'Bookable via SGR' : 'Not yet bookable through Bodrless — purchase directly via SGR');
      lines.push(`  ${trainPolicy}`);
    } else {
      // flight or bus
      const operator = _safeStr(
        transport.airline || transport.provider,
        'TBC'
      );
      const busType = transport.busType ? ` · ${transport.busType}` : '';
      lines.push(`  ${meta.operatorWord}: ${operator}${busType}`);
      lines.push(`  From: ${_safeStr(transport.origin)} → ${_safeStr(transport.destination)}`);

      const dep = _formatTime(transport.departureTime);
      const arr = _formatTime(transport.arrivalTime);
      lines.push(`  Departs: ${dep} · Arrives: ${arr}`);

      if (transport.stops)      lines.push(`  Stops: ${transport.stops}`);
      if (transport.cabinClass) lines.push(`  Class: ${transport.cabinClass}`);

      // Baggage only on flights
      if (meta.type === 'flight' && transport.baggageSummary) {
        lines.push(`  Baggage: ${transport.baggageSummary}`);
      }

      const refund = this._refundLine(transport);
      if (refund) lines.push(refund);
    }

    if (transport.routeNote) lines.push(`  ℹ️ ${transport.routeNote}`);
    lines.push(this._formatPriceLine(transport));
    return lines;
  }

  // ─────────────────────────────────────────────
  // SEND PACKAGE CARD (single-destination)
  // ─────────────────────────────────────────────
  async _sendPackageCard(phoneNumberId, to, pkg, index) {
    const transport       = pkg.transport       || null;
    const returnTransport = pkg.returnTransport || null;
    const hotel           = pkg.hotel           || null;
    const transfers       = pkg.transfers       || null;
    const summary         = pkg.summary         || {};

    const totalCurrency = _safeStr(summary.currency, 'KES');
    const passengers    = _safeInt(summary.passengers, 1);
    const nights        = _safeInt(summary.nights, 0);

    const lines = [
      `*Option ${index}*`,
      `━━━━━━━━━━━━━━━━`,
      `*Route:* ${_safeStr(summary.route)}`,
      `*Travelers:* ${passengers}`,
    ];

    if (nights > 0) lines.push(`*Nights:* ${nights}`);

    // ── Visa note ──────────────────────────────────
    const visa = _visaLine(summary, transport);
    if (visa) lines.push(visa);

    // ── Outbound transport ──────────────────────────
    if (transport) {
      const meta = this._transportMeta(transport.transportType);
      lines.push('');
      lines.push(...this._transportBlock(transport, `Outbound ${meta.label}`));
    }

    // ── Return transport ────────────────────────────
    if (returnTransport) {
      const meta = this._transportMeta(returnTransport.transportType);
      lines.push('');
      lines.push(...this._transportBlock(returnTransport, `Return ${meta.label}`));
    }

    // ── Hotel ───────────────────────────────────────
    if (hotel) {
      const stars     = _starStr(hotel.stars);
      const hCurrency = _safeStr(hotel.currency, 'KES');
      const hNights   = nights || _safeInt(hotel.nights, 1);

      lines.push('');
      lines.push('*🏨 Hotel*');
      lines.push(`  ${_safeStr(hotel.name)} ${stars}`.trimEnd());
      if (hotel.location) lines.push(`  Location: ${hotel.location}`);
      if (hotel.rating)   lines.push(`  Rating: ${Number(hotel.rating).toFixed(1)}/5`);
      if (hotel.mealPlan) lines.push(`  🍽️ *Board: ${hotel.mealPlan}*`);

      const hRefund = this._refundLine(hotel, hotel.isRefundable === false ? 'Non-refundable rate' : 'Refundable — confirmed at booking');
      if (hRefund) lines.push(hRefund);

      const pricePer = hotel.pricePerNight != null
        ? `${_fmtPrice(hotel.pricePerNight, hCurrency)}/night × ${hNights} nights`
        : _fmtPrice(hotel.totalPrice || hotel.price, hCurrency);
      lines.push(`  ${pricePer}`);
    }

    // ── Transfers ───────────────────────────────────
    const transferList = Array.isArray(transfers)
      ? transfers
      : (transfers ? [transfers] : []);

    if (transferList.length > 0) {
      lines.push('');
      lines.push('*🚗 Transfer*');
      transferList.forEach(t => {
        if (!t) return;
        const trCurrency = _safeStr(t.currency, 'KES');
        const legLabel   = t.legType === 'departure' ? 'Departure'
                         : t.legType === 'arrival'   ? 'Arrival'
                         : _safeStr(t.provider, 'Transfer');
        const desc       = _safeStr(t.description || t.location, 'TBC');
        lines.push(`  ${legLabel}: ${desc} — ${_fmtPrice(t.price, trCurrency)}`);
      });
    }

    // ── Advisories ──────────────────────────────────
    if (pkg.connectionAdvisory) {
      lines.push('');
      lines.push(`⚠️ ${pkg.connectionAdvisory}`);
    }
    if (pkg.hubTransferNote) {
      lines.push('');
      lines.push(`ℹ️ ${pkg.hubTransferNote}`);
    }

    // ── Total ───────────────────────────────────────
    lines.push('');
    lines.push(`*Total: ${_fmtPrice(summary.totalPrice, totalCurrency)}* for ${passengers} traveler(s)`);
    if (summary.pricePerPerson) {
      lines.push(`_(${_fmtPrice(summary.pricePerPerson, totalCurrency)} per person)_`);
    }
    if (summary.priceCaveat) {
      lines.push(`⚠️ _${summary.priceCaveat}_`);
    }

    const result = await this._send(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: _clamp(lines.join('\n'), 4096) },
    });

    // Tap-to-reveal photo button
    if (Array.isArray(hotel?.images) && hotel.images.length > 0) {
      await this.sendButtons(phoneNumberId, to,
        `Want to see a photo of ${_safeStr(hotel.name, 'this hotel')}?`,
        [{ id: `photo_${index - 1}`, title: '📷 View Photo' }]
      ).catch(err => {
        logger.warn('Photo button send failed — continuing', { error: err.message });
      });
    }

    return result;
  }

  // ─────────────────────────────────────────────
  // SEND ITINERARY CARD (multi-destination)
  // ─────────────────────────────────────────────
  async _sendItineraryCard(phoneNumberId, to, pkg) {
    const summary = pkg.summary || {};
    const legs    = Array.isArray(pkg.legs) ? pkg.legs : [];
    const totalCurrency = _safeStr(summary.currency, 'KES');
    const passengers    = _safeInt(summary.passengers, 1);

    const lines = [
      `*🗺️ ${_safeStr(summary.route, 'Your Itinerary')}*`,
      `━━━━━━━━━━━━━━━━`,
      `*Travelers:* ${passengers}`,
      `*Total nights:* ${_safeInt(summary.totalNights, 0)}`,
    ];

    // ── Visa note (origin of first non-buffer leg → last destination) ──
    const firstRealLeg = legs.find(l => !l.isBufferLeg);
    const lastLeg      = [...legs].reverse().find(l => !l.isBufferLeg);
    if (firstRealLeg && lastLeg) {
      const visa = _visaLine(summary, firstRealLeg.transportIn);
      if (visa) {
        lines.push('');
        lines.push(visa);
      }
    }

    legs.forEach((leg, i) => {
      if (!leg) return;
      const stopNumber = i + 1;
      const isBuffer   = Boolean(leg.isBufferLeg);
      const destination = _titleCase(_safeStr(leg.destination, 'TBC'));
      const legNights   = _safeInt(leg.nights, isBuffer ? 1 : 0);

      lines.push('');

      if (isBuffer) {
        lines.push(`*— Connection: overnight in ${destination} —*`);
        lines.push(`  Connecting between destinations · 1 night`);
      } else {
        lines.push(`*Stop ${stopNumber}: ${destination}* (${legNights} night${legNights === 1 ? '' : 's'})`);
      }

      // Transport in
      const t = leg.transportIn;
      if (t) {
        const meta = this._transportMeta(t.transportType);
        lines.push(`  ${meta.icon} ${_safeStr(t.origin)} → ${_safeStr(t.destination)}`);

        if (meta.type === 'train') {
          const service = _safeStr(t.serviceName || t.provider, 'SGR');
          const cls     = t.trainClass ? ` · ${String(t.trainClass).replace('_', ' ')}` : '';
          lines.push(`    Service: ${service}${cls} · ${_formatScheduleTime(t.departureTime)}`);
        } else {
          const operator = _safeStr(t.airline || t.provider);
          lines.push(`    ${meta.operatorWord}: ${operator} · ${_formatTime(t.departureTime)}–${_formatTime(t.arrivalTime)}`);
        }

        if (leg.connectsVia && !isBuffer) {
          lines.push(`    _Connects via ${_titleCase(leg.connectsVia)}_`);
        }
        lines.push(`    ${t.priceOnRequest ? 'Price: Contact operator to confirm' : `Price: ${_fmtPrice(t.price, _safeStr(t.currency, 'KES'))}`}`);
      } else if (!isBuffer) {
        lines.push(`  ⚠️ Transport for this leg still to be confirmed`);
      }

      // Hotel
      if (leg.hotel) {
        const h        = leg.hotel;
        const stars    = _starStr(h.stars);
        const hCurr    = _safeStr(h.currency, 'KES');
        const hotelLine = `  🏨 ${_safeStr(h.name)} ${stars}`.trimEnd();
        lines.push(hotelLine);
        if (h.location)      lines.push(`    ${h.location}`);
        if (h.mealPlan)      lines.push(`    🍽️ ${h.mealPlan}`);
        lines.push(`    ${_fmtPrice(h.pricePerNight, hCurr)}/night × ${legNights} night${legNights === 1 ? '' : 's'}`);
      } else if (!isBuffer) {
        lines.push(`  ⚠️ Hotel for this stop still to be confirmed`);
      }

      // Transfers
      if (leg.transfers) {
        const tr     = leg.transfers;
        const trCurr = _safeStr(tr.currency, 'KES');
        lines.push(`  🚗 ${_safeStr(tr.provider, 'Transfer')}: ${_fmtPrice(tr.price, trCurr)}`);
      }

      // Connection advisory per leg
      if (leg.connectionAdvisory) {
        lines.push(`  ⚠️ ${leg.connectionAdvisory}`);
      }
    });

    // ── Return transport ────────────────────────────
    if (pkg.returnTransport) {
      const rt   = pkg.returnTransport;
      const meta = this._transportMeta(rt.transportType);
      lines.push('');
      lines.push(`*Return*`);
      lines.push(...this._transportBlock(rt, `Return ${meta.label}`).map(l => `  ${l.trim()}`));
    }

    // ── Total ───────────────────────────────────────
    lines.push('');
    lines.push(`*Total: ${_fmtPrice(summary.totalPrice, totalCurrency)}* for ${passengers} traveler(s)`);
    if (summary.pricePerPerson) {
      lines.push(`_(${_fmtPrice(summary.pricePerPerson, totalCurrency)} per person)_`);
    }
    if (summary.priceCaveat) {
      lines.push(`⚠️ _${summary.priceCaveat}_`);
    }
    if (summary.bookingNote) {
      lines.push(`ℹ️ _${summary.bookingNote}_`);
    }

    return this._send(phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: _clamp(lines.join('\n'), 4096) },
    });
  }

  // ─────────────────────────────────────────────
  // CORE SEND
  //
  // BSUID detection: "KE.xxx", "US.xxx", "US.ENT.xxx" etc.
  // — these must use `recipient` field, not `to`.
  // ─────────────────────────────────────────────
  async _send(phoneNumberId, payload) {
    if (!phoneNumberId || !payload) {
      logger.error('_send called with missing phoneNumberId or payload');
      return null;
    }

    const isBsuid = payload.to && /^[A-Z]{2,}\./.test(String(payload.to));

    let finalPayload;
    if (isBsuid) {
      const { to, ...rest } = payload;
      finalPayload = { ...rest, recipient: to };
    } else {
      finalPayload = payload;
    }

    const recipientValue = finalPayload.to || finalPayload.recipient;

    logger.info('WhatsApp outbound send', {
      phoneNumberId,
      to: recipientValue,
      isBsuid,
      messageType: finalPayload.type,
      textPreview: finalPayload.text?.body?.slice(0, 80)
                || finalPayload.image?.link
                || finalPayload.interactive?.type
                || null,
    });

    try {
      const response = await axios.post(
        `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
        finalPayload,
        {
          headers: {
            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      logger.info('WhatsApp send succeeded', {
        to: recipientValue,
        isBsuid,
        messageId: response.data?.messages?.[0]?.id,
      });

      return response.data;
    } catch (error) {
      const errBody = error.response?.data;
      logger.error('WhatsApp send failed', {
        to: recipientValue,
        isBsuid,
        status: error.response?.status,
        errorBody: errBody,
        message: error.message,
      });
      throw error;
    }
  }
}

module.exports = new WhatsAppService();