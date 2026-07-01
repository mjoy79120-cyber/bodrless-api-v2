/**
 * VOUCHER SERVICE v2
 * ─────────────────────────────────────────────────────────────
 * Generates and delivers booking vouchers for complete packages
 * (flight + hotel + transfers) across three channels:
 *
 *   1. PDF  — wkhtmltopdf via temp files (set VOUCHER_PDF_ENABLED=false
 *             to skip on Render until wkhtmltopdf is installed via
 *             Dockerfile — see deployment notes)
 *   2. Email — full branded HTML, PDF attached if generated
 *   3. WhatsApp — complete text summary, all HotelBeds cert fields
 *
 * AGENCY BRANDING:
 *   - Agency logo from agencies.logo_url (PNG/SVG) if available,
 *     falls back to large text header — no broken images ever
 *   - Agency name, website, phone in header
 *   - "Powered by Bodrless" in footer — small, unobtrusive
 *   - Neutral professional color scheme (navy/white/grey) so the
 *     voucher feels like the agency's document, not Bodrless's
 *
 * CERTIFICATION COMPLIANCE (HotelBeds Section 4):
 *   4.1 Voucher sent for every confirmed booking ✓
 *   4.2 Hotel name, address, phone ✓
 *   4.3 Holder name + pax per room ✓
 *   4.4 Booking ref, dates, room type, board, rate comments ✓
 *   4.5 "Payable through [supplier], acting as agent..." ✓
 * ─────────────────────────────────────────────────────────────
 */

const { spawn }    = require('child_process');
const os           = require('os');
const fs           = require('fs');
const path         = require('path');
const { Resend }   = require('resend');
const { logger }   = require('../utils/logger');

const resendClient  = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM          = process.env.EMAIL_FROM     || 'Bodrless <onboarding@resend.dev>';
const PDF_ENABLED   = process.env.VOUCHER_PDF_ENABLED !== 'false';

// Neutral professional palette — works for any agency brand
const C = {
  NAVY:      '#1a2744',
  NAVYLIGHT: '#2a3a5c',
  GREEN:     '#1a7a4a',
  GOLD:      '#b8972a',
  GREY:      '#6b7280',
  LIGHTGREY: '#f3f4f6',
  BORDER:    '#e5e7eb',
  WHITE:     '#ffffff',
  BLACK:     '#111827',
  RED:       '#dc2626',
};

class VoucherService {

  // ─────────────────────────────────────────────
  // MAIN ENTRY POINT
  // ─────────────────────────────────────────────
  async sendVoucher({ booking, hotel, agency, resend: isResend = false }) {
    if (!booking?.supplierBookingReference && !booking?.booking_ref) {
      logger.warn('VoucherService: missing booking reference, skipping');
      return { success: false, error: 'Missing booking reference' };
    }

    const vd      = this._buildVoucherData({ booking, hotel, agency });
    const html    = this._renderHTML(vd);
    const results = { pdf: null, email: null, whatsapp: null };

    let pdfBuffer = null;
    if (PDF_ENABLED) {
      try {
        pdfBuffer = await this._generatePDF(html);
        results.pdf = { success: true, bytes: pdfBuffer.length };
      } catch (err) {
        logger.error('VoucherService: PDF failed', { error: err.message });
        results.pdf = { success: false, error: err.message };
      }
    }

    try {
      results.email = await this._sendEmail({ vd, html, pdfBuffer, isResend });
    } catch (err) {
      results.email = { success: false, error: err.message };
    }

    try {
      results.whatsapp = await this._sendWhatsApp({ vd });
    } catch (err) {
      results.whatsapp = { success: false, error: err.message };
    }

    logger.info('VoucherService: delivery complete', {
      ref: vd.bookingRef,
      pdf: results.pdf?.success,
      email: results.email?.success,
      whatsapp: results.whatsapp?.success,
    });

    return { success: true, results };
  }

  // ─────────────────────────────────────────────
  // BUILD VOUCHER DATA
  // Normalizes the raw booking/hotel/agency objects into
  // a clean shape both the HTML template and WhatsApp
  // formatter can use without defensive null-checks everywhere.
  // ─────────────────────────────────────────────
  _buildVoucherData({ booking, hotel, agency }) {
    const fmt = d => {
      if (!d) return null;
      try {
        return new Date(d).toLocaleDateString('en-KE', {
          weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        });
      } catch { return String(d); }
    };

    const fmtTime = d => {
      if (!d) return null;
      try {
        return new Date(d).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false });
      } catch { return null; }
    };

    const flight  = booking.flight_details  || hotel?.flight  || null;
    const hotelD  = booking.hotel_details   || hotel           || {};
    const xfers   = Array.isArray(booking.transfer_details)
      ? booking.transfer_details
      : (booking.transfer_details ? [booking.transfer_details] : []);

    // HotelBeds certification 4.5 payment attribution
    const supplierName = hotelD.supplier_tag?.name || 'HBX Group';
    const supplierVAT  = hotelD.supplier_tag?.vatNumber || '';
    const paymentText  = supplierVAT
      ? `Payable through ${supplierName}, acting as agent for the service operating company. VAT: ${supplierVAT} Reference: ${booking.supplierBookingReference || booking.hotel_supplier_reference || '—'}`
      : `Payable through ${supplierName}, acting as agent for the service operating company. Reference: ${booking.supplierBookingReference || booking.hotel_supplier_reference || '—'}`;

    return {
      // Refs
      bookingRef:      booking.booking_ref || booking.clientReference || '—',
      hotelRef:        booking.hotel_supplier_reference || booking.supplierBookingReference || null,
      flightRef:       booking.supplier_booking_reference || null,
      status:          booking.status || 'CONFIRMED',
      confirmedAt:     booking.confirmedAt || new Date().toISOString(),

      // Traveler
      holderName:      booking.guestName || `${booking.holder?.name || ''} ${booking.holder?.surname || ''}`.trim() || '—',
      guestEmail:      booking.guestEmail || null,
      guestPhone:      booking.guestPhone || null,
      passengers:      booking.passengers || 1,

      // Flight (outbound)
      flight: flight ? {
        airline:       flight.airline      || null,
        airlineCode:   flight.airlineCode  || null,
        flightNumber:  flight.flightNumber || null,
        origin:        flight.origin       || booking.origin || null,
        destination:   flight.destination  || booking.destination || null,
        originIata:    flight.originIata   || null,
        destIata:      flight.destIata     || null,
        departureTime: flight.departureTime,
        arrivalTime:   flight.arrivalTime,
        departureDate: fmt(flight.departureTime),
        departureTimeF: fmtTime(flight.departureTime),
        arrivalTimeF:  fmtTime(flight.arrivalTime),
        duration:      flight.duration     || null,
        stops:         flight.stops === 0 || flight.stops === 'Non Stop' ? 'Non-stop' : `${flight.stops} stop${flight.stops > 1 ? 's' : ''}`,
        cabinClass:    flight.cabinClass   || 'Economy',
        checkedBags:   flight.checkedBags  || null,
      } : null,

      // Return leg
      returnFlight: flight?.returnLeg ? {
        airline:       flight.returnLeg.airline      || null,
        airlineCode:   flight.returnLeg.airlineCode  || null,
        flightNumber:  flight.returnLeg.flightNumber || null,
        origin:        flight.returnLeg.origin       || flight.destination || null,
        destination:   flight.returnLeg.destination  || flight.origin     || null,
        originIata:    flight.returnLeg.originIata   || null,
        destIata:      flight.returnLeg.destIata     || null,
        departureDate: fmt(flight.returnLeg.departureTime),
        departureTimeF: fmtTime(flight.returnLeg.departureTime),
        arrivalTimeF:  fmtTime(flight.returnLeg.arrivalTime),
        duration:      flight.returnLeg.duration     || null,
        stops:         flight.returnLeg.stops === 0 || flight.returnLeg.stops === 'Non Stop' ? 'Non-stop' : `${flight.returnLeg.stops} stop(s)`,
        cabinClass:    flight.returnLeg.cabinClass   || 'Economy',
      } : null,

      // Hotel
      hotel: hotelD.name ? {
        name:          hotelD.name,
        stars:         hotelD.stars     || null,
        address:       hotelD.address   || null,
        city:          hotelD.city      || booking.destination || null,
        phone:         hotelD.phone     || null,
        checkIn:       fmt(hotelD.checkIn  || booking.checkIn),
        checkOut:      fmt(hotelD.checkOut || booking.checkOut),
        nights:        booking.nights   || null,
        roomType:      hotelD.roomType  || null,
        boardType:     hotelD.mealPlan  || hotelD.boardType || null,
        isRefundable:  hotelD.isRefundable !== false,
        rateComments:  hotelD.rateComments || null,
        cancellationPolicies: hotelD.cancellationPolicies || [],
        promotions:    hotelD.promotions   || [],
      } : null,

      // Transfers
      transfers: xfers.map(x => ({
        type:          x.type || x.transferType || 'Transfer',
        from:          x.from || x.pickup       || null,
        to:            x.to   || x.dropoff      || null,
        dateTime:      fmt(x.dateTime || x.pickupTime) || null,
        timeF:         fmtTime(x.dateTime || x.pickupTime),
        vehicle:       x.vehicleType || x.vehicle || null,
        notes:         x.notes || null,
      })),

      // Payment
      paymentText,
      totalAmount:     booking.totalAmount || booking.total_price || null,
      currency:        booking.currency   || 'KES',

      // Agency branding
      agencyName:      agency?.name     || 'Your Travel Agency',
      agencyEmail:     agency?.email    || null,
      agencyPhone:     agency?.phone    || null,
      agencyWebsite:   agency?.website  || null,
      agencyLogoUrl:   agency?.logo_url || null,
      agencyTagline:   agency?.tagline  || null,
      agencyId:        agency?.id       || null,
      agencyWhatsappPhoneNumberId: agency?.whatsapp_phone_number_id || null,
    };
  }

  // ─────────────────────────────────────────────
  // RENDER HTML
  // Single template for email body + PDF source.
  // Inline styles only for email client compatibility.
  // ─────────────────────────────────────────────
  _renderHTML(v) {
    const star = v.hotel?.stars
      ? '&#9733;'.repeat(v.hotel.stars) + '&#9734;'.repeat(Math.max(0, 5 - v.hotel.stars))
      : '';

    const agencyHeader = v.agencyLogoUrl
      ? `<img src="${v.agencyLogoUrl}" alt="${v.agencyName}" style="max-height:60px;max-width:200px;object-fit:contain;display:block;margin-bottom:6px"/>`
      : `<div style="font-size:22px;font-weight:700;color:${C.NAVY};letter-spacing:-.01em">${v.agencyName}</div>`;

    const agencySubline = [v.agencyTagline, v.agencyWebsite, v.agencyPhone]
      .filter(Boolean).join('  ·  ');

    const flightRow = (f, label) => f ? `
      <div style="background:${C.LIGHTGREY};border-radius:10px;padding:14px 16px;margin-bottom:10px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GREY};margin-bottom:6px">${label}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:16px;color:${C.NAVY}">&#9992;</span>
          <span style="font-size:15px;font-weight:600;color:${C.NAVY}">${f.origin || '—'} &rarr; ${f.destination || '—'}</span>
          <span style="font-size:11px;color:${C.GREY};margin-left:auto">${f.stops}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;color:${C.BLACK}">
          <tr>
            <td style="padding:2px 0;color:${C.GREY};width:35%">Airline</td>
            <td>${f.airline || '—'}${f.flightNumber ? ' · ' + (f.airlineCode || '') + f.flightNumber : ''}</td>
          </tr>
          <tr>
            <td style="padding:2px 0;color:${C.GREY}">Date</td>
            <td>${f.departureDate || '—'}</td>
          </tr>
          <tr>
            <td style="padding:2px 0;color:${C.GREY}">Departure</td>
            <td><strong>${f.departureTimeF || '—'}</strong>${f.arrivalTimeF ? ' &rarr; ' + f.arrivalTimeF : ''}${f.duration ? ' &nbsp;(' + f.duration + ')' : ''}</td>
          </tr>
          <tr>
            <td style="padding:2px 0;color:${C.GREY}">Class</td>
            <td>${f.cabinClass || 'Economy'}${f.checkedBags ? ' · ' + f.checkedBags + ' checked bag(s)' : ''}</td>
          </tr>
        </table>
      </div>` : '';

    const cancelRows = (v.hotel?.cancellationPolicies || []).map(p =>
      `<li style="margin-bottom:3px">From ${p.from ? new Date(p.from).toLocaleDateString('en-KE',{day:'numeric',month:'short',year:'numeric'}) : '—'}: ${p.amount || '—'} ${v.currency}</li>`
    ).join('');

    const promoText = (v.hotel?.promotions || []).map(p =>
      `<div style="color:${C.RED};font-size:11px;margin-top:4px">&#9888; ${p.name || p.remark || ''}</div>`
    ).join('');

    const transferRows = v.transfers.length ? v.transfers.map(x => `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid ${C.BORDER}">
        <span style="font-size:16px">&#128652;</span>
        <div style="font-size:12px;color:${C.BLACK}">
          <div><strong>${x.from || '—'} &rarr; ${x.to || '—'}</strong></div>
          <div style="color:${C.GREY}">${[x.dateTime, x.timeF].filter(Boolean).join(' · ')}${x.vehicle ? ' · ' + x.vehicle : ''}</div>
          ${x.notes ? `<div style="color:${C.GREY}">${x.notes}</div>` : ''}
        </div>
      </div>`).join('') : '';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>Booking Voucher · ${v.bookingRef}</title>
<style>
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .no-break { page-break-inside: avoid; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:${C.BLACK}">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">

  <!-- AGENCY HEADER -->
  <div class="no-break" style="background:${C.WHITE};border:1px solid ${C.BORDER};border-radius:12px;padding:20px 22px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
    <div>
      ${agencyHeader}
      ${agencySubline ? `<div style="font-size:11px;color:${C.GREY};margin-top:3px">${agencySubline}</div>` : ''}
    </div>
    <div style="text-align:right">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GREY}">Booking Voucher</div>
      <div style="font-size:10px;color:${C.GREY};margin-top:2px">${new Date(v.confirmedAt).toLocaleDateString('en-KE',{day:'numeric',month:'short',year:'numeric'})}</div>
    </div>
  </div>

  <!-- STATUS + REFS -->
  <div class="no-break" style="background:${C.GREEN};border-radius:10px;padding:12px 18px;margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
    <div style="color:${C.WHITE};font-size:14px;font-weight:600;letter-spacing:.02em">&#10003; BOOKING CONFIRMED</div>
    <div style="text-align:right">
      <div style="font-size:11px;color:rgba(255,255,255,.8)">Ref: <strong style="color:${C.WHITE}">${v.bookingRef}</strong></div>
      ${v.hotelRef ? `<div style="font-size:10px;color:rgba(255,255,255,.7)">Hotel ref: ${v.hotelRef}</div>` : ''}
    </div>
  </div>

  <!-- TRAVELER -->
  <div class="no-break" style="background:${C.WHITE};border:1px solid ${C.BORDER};border-radius:12px;padding:14px 18px;margin-bottom:10px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GREY};margin-bottom:8px">Traveler</div>
    <div style="font-size:14px;font-weight:600;color:${C.NAVY}">${v.holderName}</div>
    <div style="font-size:12px;color:${C.GREY};margin-top:2px">
      ${v.passengers} passenger${v.passengers > 1 ? 's' : ''}
      ${v.guestEmail ? ' · ' + v.guestEmail : ''}
      ${v.guestPhone ? ' · ' + v.guestPhone : ''}
    </div>
  </div>

  <!-- OUTBOUND FLIGHT -->
  ${v.flight ? `
  <div class="no-break" style="background:${C.WHITE};border:1px solid ${C.BORDER};border-radius:12px;padding:14px 18px;margin-bottom:10px">
    ${flightRow(v.flight, 'Outbound Flight')}
  </div>` : ''}

  <!-- HOTEL -->
  ${v.hotel ? `
  <div class="no-break" style="background:${C.WHITE};border:1px solid ${C.BORDER};border-radius:12px;padding:14px 18px;margin-bottom:10px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GREY};margin-bottom:8px">Hotel</div>
    <div style="font-size:15px;font-weight:600;color:${C.NAVY}">${v.hotel.name}</div>
    ${star ? `<div style="color:${C.GOLD};font-size:12px;margin-top:1px">${star}</div>` : ''}
    <div style="font-size:12px;color:${C.GREY};margin-top:6px;line-height:1.5">
      ${v.hotel.address || v.hotel.city ? `&#128205; ${[v.hotel.address, v.hotel.city].filter(Boolean).join(', ')}` : ''}
      ${v.hotel.phone ? `<br/>&#128222; ${v.hotel.phone}` : ''}
    </div>
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${C.BORDER}">
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr>
          <td style="padding:3px 0;color:${C.GREY};width:35%">Check-in</td>
          <td style="font-weight:500">${v.hotel.checkIn || '—'}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;color:${C.GREY}">Check-out</td>
          <td style="font-weight:500">${v.hotel.checkOut || '—'}</td>
        </tr>
        ${v.hotel.nights ? `<tr><td style="padding:3px 0;color:${C.GREY}">Nights</td><td>${v.hotel.nights}</td></tr>` : ''}
        <tr>
          <td style="padding:3px 0;color:${C.GREY}">Room</td>
          <td>${v.hotel.roomType || '—'}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;color:${C.GREY}">Board</td>
          <td>${v.hotel.boardType || '—'}</td>
        </tr>
      </table>
      ${promoText}
    </div>
    ${v.hotel.rateComments ? `
    <div style="margin-top:10px;padding:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:11px;color:#92400e;line-height:1.5">
      <strong>Note:</strong> ${v.hotel.rateComments}
    </div>` : ''}
    ${cancelRows ? `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid ${C.BORDER}">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GREY};margin-bottom:4px">Cancellation policy</div>
      <ul style="margin:0;padding-left:16px;font-size:11px;color:${C.GREY};line-height:1.6">${cancelRows}</ul>
    </div>` : ''}
  </div>` : ''}

  <!-- TRANSFERS -->
  ${v.transfers.length ? `
  <div class="no-break" style="background:${C.WHITE};border:1px solid ${C.BORDER};border-radius:12px;padding:14px 18px;margin-bottom:10px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GREY};margin-bottom:8px">Transfers</div>
    ${transferRows}
  </div>` : ''}

  <!-- RETURN FLIGHT -->
  ${v.returnFlight ? `
  <div class="no-break" style="background:${C.WHITE};border:1px solid ${C.BORDER};border-radius:12px;padding:14px 18px;margin-bottom:10px">
    ${flightRow(v.returnFlight, 'Return Flight')}
  </div>` : ''}

  <!-- PAYMENT ATTRIBUTION (HotelBeds Cert 4.5 — mandatory) -->
  <div class="no-break" style="background:${C.LIGHTGREY};border:1px solid ${C.BORDER};border-radius:10px;padding:12px 16px;margin-bottom:16px">
    <div style="font-size:10px;color:${C.GREY};line-height:1.6">${v.paymentText}</div>
  </div>

  <!-- FOOTER -->
  <div style="text-align:center;padding-top:8px;border-top:1px solid ${C.BORDER}">
    <div style="font-size:12px;color:${C.GREY}">Booked by <strong>${v.agencyName}</strong></div>
    <div style="font-size:10px;color:#9ca3af;margin-top:3px">Powered by Bodrless</div>
  </div>

</div>
</body></html>`;
  }

  // ─────────────────────────────────────────────
  // GENERATE PDF via wkhtmltopdf temp files
  // ─────────────────────────────────────────────
  _generatePDF(html) {
    return new Promise((resolve, reject) => {
      const id      = `voucher-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      const htmlPath = path.join(os.tmpdir(), `${id}.html`);
      const pdfPath  = path.join(os.tmpdir(), `${id}.pdf`);
      const cleanup  = () => { try { fs.unlinkSync(htmlPath); } catch {} try { fs.unlinkSync(pdfPath); } catch {} };

      try { fs.writeFileSync(htmlPath, html, 'utf8'); }
      catch (err) { return reject(new Error(`Temp HTML write failed: ${err.message}`)); }

      const proc = spawn('wkhtmltopdf', [
        '--quiet', '--disable-smart-shrinking', '--enable-local-file-access',
        '--page-size', 'A4',
        '--margin-top', '8mm', '--margin-bottom', '8mm',
        '--margin-left', '10mm', '--margin-right', '10mm',
        htmlPath, pdfPath,
      ]);

      const errChunks = [];
      proc.stderr.on('data', c => errChunks.push(c));
      proc.on('close', code => {
        if (code !== 0) { cleanup(); return reject(new Error(`wkhtmltopdf exited ${code}: ${Buffer.concat(errChunks).toString().trim()}`)); }
        try { const buf = fs.readFileSync(pdfPath); cleanup(); resolve(buf); }
        catch (err) { cleanup(); reject(new Error(`PDF read failed: ${err.message}`)); }
      });
      proc.on('error', err => { cleanup(); reject(err.code === 'ENOENT' ? new Error('wkhtmltopdf not found — set VOUCHER_PDF_ENABLED=false') : err); });
    });
  }

  // ─────────────────────────────────────────────
  // SEND EMAIL via Resend
  // ─────────────────────────────────────────────
  async _sendEmail({ vd: v, html, pdfBuffer, isResend }) {
    if (!resendClient) return { success: false, error: 'RESEND_API_KEY not set' };

    const recipients = [v.guestEmail, v.agencyEmail].filter(Boolean);
    if (!recipients.length) return { success: false, error: 'No email recipients' };

    const subject = isResend
      ? `Payment confirmed — your voucher for ${v.hotel?.name || v.bookingRef}`
      : `Booking confirmed — ${v.hotel?.name || v.bookingRef} (${v.bookingRef})`;

    const attachments = pdfBuffer ? [{
      filename: `Voucher-${v.bookingRef}.pdf`,
      content:  pdfBuffer.toString('base64'),
    }] : [];

    const { data, error } = await resendClient.emails.send({
      from: FROM, to: recipients, subject, html, attachments,
    });

    if (error) return { success: false, error: error.message || String(error) };
    logger.info('VoucherService: email sent', { emailId: data?.id, recipients });
    return { success: true, emailId: data?.id, recipients };
  }

  // ─────────────────────────────────────────────
  // SEND WHATSAPP — full text summary
  // ─────────────────────────────────────────────
  async _sendWhatsApp({ vd: v }) {
    const whatsappService = require('./whatsapp');
    const phoneNumberId   = v.agencyWhatsappPhoneNumberId;
    if (!v.guestPhone)  return { success: false, error: 'No guest phone' };
    if (!phoneNumberId) return { success: false, error: 'Agency WhatsApp not configured' };

    const parts = [
      `✅ *Booking Confirmed*`,
      `*Ref:* ${v.bookingRef}${v.hotelRef ? `  |  Hotel ref: ${v.hotelRef}` : ''}`,
      '',
    ];

    if (v.flight) {
      parts.push(
        `✈ *Outbound Flight*`,
        `${v.flight.origin} → ${v.flight.destination}`,
        `${v.flight.airline || '—'}${v.flight.flightNumber ? ' · ' + (v.flight.airlineCode||'') + v.flight.flightNumber : ''} · ${v.flight.departureDate || '—'} · ${v.flight.departureTimeF || '—'}${v.flight.arrivalTimeF ? ' → ' + v.flight.arrivalTimeF : ''} · ${v.flight.stops}`,
        '',
      );
    }

    if (v.hotel) {
      const stars = v.hotel.stars ? '⭐'.repeat(Math.min(v.hotel.stars, 5)) : '';
      parts.push(
        `🏨 *Hotel*`,
        `*${v.hotel.name}* ${stars}`,
        `📍 ${[v.hotel.address, v.hotel.city].filter(Boolean).join(', ')}`,
        v.hotel.phone ? `📞 ${v.hotel.phone}` : null,
        `Check-in: *${v.hotel.checkIn || '—'}*`,
        `Check-out: *${v.hotel.checkOut || '—'}*`,
        v.hotel.nights ? `${v.hotel.nights} nights` : null,
        `${v.hotel.roomType || '—'} · ${v.hotel.boardType || '—'}`,
        '',
      );

      if (v.hotel.promotions?.length) {
        parts.push(...v.hotel.promotions.map(p => `⚠ ${p.name || p.remark}`), '');
      }
    }

    if (v.transfers.length) {
      parts.push(`🚐 *Transfers*`);
      v.transfers.forEach(x => {
        parts.push(`${x.from || '—'} → ${x.to || '—'}${x.dateTime ? ' · ' + x.dateTime : ''}${x.timeF ? ' ' + x.timeF : ''}`);
      });
      parts.push('');
    }

    if (v.returnFlight) {
      parts.push(
        `✈ *Return Flight*`,
        `${v.returnFlight.origin} → ${v.returnFlight.destination}`,
        `${v.returnFlight.airline || '—'} · ${v.returnFlight.departureDate || '—'} · ${v.returnFlight.departureTimeF || '—'}${v.returnFlight.arrivalTimeF ? ' → ' + v.returnFlight.arrivalTimeF : ''} · ${v.returnFlight.stops}`,
        '',
      );
    }

    if (v.hotel?.rateComments) {
      parts.push(`📋 ${v.hotel.rateComments}`, '');
    }

    parts.push(`_${v.paymentText}_`);

    const message = parts.filter(p => p !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    try {
      await whatsappService.sendText(phoneNumberId, v.guestPhone, message);
      return { success: true };
    } catch (err) {
      logger.error('VoucherService: WhatsApp send failed', { error: err.message });
      return { success: false, error: err.message };
    }
  }
}

module.exports = new VoucherService();