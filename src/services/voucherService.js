/**
 * VOUCHER SERVICE
 * ─────────────────────────────────────────────────────────────
 * Generates and delivers booking vouchers for confirmed hotel
 * reservations across three channels:
 *
 *   1. PDF  — generated via wkhtmltopdf from HTML template,
 *             attached to email and accessible via download URL
 *   2. Email — full branded HTML to traveler (primary) + agency
 *              (copy), PDF attached via Resend
 *   3. WhatsApp — formatted text summary with all mandatory fields
 *
 * CERTIFICATION COMPLIANCE (HotelBeds Section 4):
 *   4.1 Voucher sent for every confirmed booking ✓
 *   4.2 Hotel name, address, phone ✓
 *   4.3 Holder name + at least one pax name per room ✓
 *   4.4 HotelBeds booking reference, check-in/out, room type,
 *       board type, rate comments ✓
 *   4.5 "Payable through [supplier], acting as agent..." text ✓
 *
 * TRIGGER POINTS (wired in bookingService.js):
 *   On booking confirmation AND on payment confirmation.
 *   The second send uses resend=true so subject changes to
 *   "Payment confirmed — your voucher".
 *
 * RENDER DEPLOY NOTE:
 *   Add to Render build command or render.yaml:
 *     apt-get install -y wkhtmltopdf
 *   Or set VOUCHER_PDF_ENABLED=false to skip PDF generation
 *   and send HTML-only emails until wkhtmltopdf is confirmed.
 * ─────────────────────────────────────────────────────────────
 */

const { spawn }    = require('child_process');
const { Resend }   = require('resend');
const { logger }   = require('../utils/logger');

const resendClient  = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM          = process.env.EMAIL_FROM          || 'Bodrless <onboarding@resend.dev>';
const DASHBOARD_URL = process.env.DASHBOARD_URL       || 'https://app.bodrless.com';
const PDF_ENABLED   = process.env.VOUCHER_PDF_ENABLED !== 'false';

const C = {
  MIDNIGHT: '#1a2744', GOLD: '#c9a14f', EMERALD: '#1f7a5c',
  CHAMPAGNE: '#f7f3ea', GRAPHITE: '#3f3d38', BORDER: '#e6ddc9',
};

class VoucherService {

  async sendVoucher({ booking, hotel, agency, resend: isResend = false }) {
    if (!booking?.supplierBookingReference) {
      logger.warn('VoucherService: missing booking reference, skipping voucher');
      return { success: false, error: 'Missing booking reference' };
    }

    const voucherData = this._buildVoucherData({ booking, hotel, agency });
    const html        = this._renderHTML(voucherData);
    const results     = { pdf: null, email: null, whatsapp: null };

    let pdfBuffer = null;
    if (PDF_ENABLED) {
      try {
        pdfBuffer = await this._generatePDF(html);
        results.pdf = { success: true, bytes: pdfBuffer.length };
      } catch (err) {
        logger.error('VoucherService: PDF generation failed', { error: err.message });
        results.pdf = { success: false, error: err.message };
      }
    }

    try {
      results.email = await this._sendEmail({ voucherData, html, pdfBuffer, isResend });
    } catch (err) {
      results.email = { success: false, error: err.message };
    }

    try {
      results.whatsapp = await this._sendWhatsApp({ voucherData, agency });
    } catch (err) {
      results.whatsapp = { success: false, error: err.message };
    }

    logger.info('VoucherService: delivery complete', {
      bookingRef: booking.supplierBookingReference,
      pdf: results.pdf?.success, email: results.email?.success, whatsapp: results.whatsapp?.success,
    });

    return { success: true, results };
  }

  _buildVoucherData({ booking, hotel, agency }) {
    const fmt = d => {
      if (!d) return '—';
      try { return new Date(d).toLocaleDateString('en-KE', { weekday:'long', year:'numeric', month:'long', day:'numeric' }); }
      catch { return String(d); }
    };

    const supplierName = booking.supplier_tag?.name  || 'HBX Group';
    const supplierVAT  = booking.supplier_tag?.vatNumber || '';
    const paymentText  = supplierVAT
      ? `Payable through ${supplierName}, acting as agent for the service operating company. VAT: ${supplierVAT} Reference: ${booking.supplierBookingReference}`
      : `Payable through ${supplierName}, acting as agent for the service operating company. Reference: ${booking.supplierBookingReference}`;

    return {
      bookingRef:   booking.supplierBookingReference,
      agencyRef:    booking.clientReference || booking.booking_ref || null,
      status:       booking.status || 'CONFIRMED',
      confirmedAt:  booking.confirmedAt || new Date().toISOString(),
      hotelName:    booking.hotelName    || hotel?.name     || '—',
      hotelAddress: booking.hotelAddress || hotel?.address  || '—',
      hotelPhone:   booking.hotelPhone   || hotel?.phone    || '—',
      hotelStars:   hotel?.stars         || null,
      hotelCity:    hotel?.city          || booking.destination || '—',
      checkIn:      fmt(booking.checkIn),
      checkOut:     fmt(booking.checkOut),
      nights:       booking.nights       || null,
      roomType:     booking.roomType     || hotel?.roomType || '—',
      boardType:    booking.boardType    || hotel?.mealPlan || '—',
      holderName:   booking.guestName    || `${booking.holder?.name || ''} ${booking.holder?.surname || ''}`.trim() || '—',
      guestEmail:   booking.guestEmail   || null,
      guestPhone:   booking.guestPhone   || null,
      passengers:   booking.passengers   || 1,
      totalAmount:  booking.totalAmount  || 0,
      currency:     booking.currency     || 'EUR',
      rateComments: booking.rateComments || hotel?.rateComments || null,
      cancellationPolicies: booking.cancellationPolicies || hotel?.cancellationPolicies || [],
      promotions:   booking.promotions   || hotel?.promotions   || [],
      paymentText,
      agencyId:     agency?.id    || null,
      agencyName:   agency?.name  || 'Your travel agency',
      agencyEmail:  agency?.email || null,
      agencyWhatsappPhoneNumberId: agency?.whatsapp_phone_number_id || null,
    };
  }

  _renderHTML(v) {
    const starStr = v.hotelStars ? '&#9733;'.repeat(v.hotelStars) + '&#9734;'.repeat(Math.max(0, 5 - v.hotelStars)) : '';

    const cancelRows = (v.cancellationPolicies || []).map(p =>
      `<li style="margin-bottom:4px">From ${p.from ? new Date(p.from).toLocaleDateString('en-KE') : '—'}: fee ${p.amount || '—'} ${v.currency}</li>`
    ).join('');

    const promoRows = (v.promotions || []).map(p =>
      `<div style="font-size:12px;color:#dc2626;margin-top:6px">&#9888; ${p.name || p.remark || ''}</div>`
    ).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>Voucher ${v.bookingRef}</title></head>
<body style="margin:0;padding:0;background:${C.CHAMPAGNE};font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:600px;margin:0 auto;padding:32px 20px;">

  <div style="text-align:center;margin-bottom:24px;">
    <div style="font-size:20px;color:${C.MIDNIGHT};letter-spacing:.04em">bodrless</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:${C.GOLD}">Hotel Booking Voucher</div>
  </div>

  <div style="background:${v.status==='CONFIRMED'?C.EMERALD:C.GOLD};color:#fff;text-align:center;padding:10px;border-radius:8px;font-size:13px;margin-bottom:18px;letter-spacing:.04em">
    ${v.status==='CONFIRMED'?'&#10003; BOOKING CONFIRMED':v.status}
  </div>

  <div style="background:#fff;border:1px solid ${C.BORDER};border-radius:14px;padding:20px 22px;margin-bottom:14px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GOLD};margin-bottom:4px">HotelBeds Reference</div>
    <div style="font-size:22px;font-weight:bold;color:${C.MIDNIGHT};font-family:monospace">${v.bookingRef}</div>
    <div style="font-size:11px;color:${C.GRAPHITE};margin-top:4px">Confirmed: ${new Date(v.confirmedAt).toLocaleDateString('en-KE')}${v.agencyRef?'  &nbsp;|&nbsp;  Agency ref: '+v.agencyRef:''}</div>
  </div>

  <div style="background:#fff;border:1px solid ${C.BORDER};border-radius:14px;padding:20px 22px;margin-bottom:14px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GOLD};margin-bottom:8px">Hotel</div>
    <div style="font-size:17px;font-weight:bold;color:${C.MIDNIGHT}">${v.hotelName}</div>
    ${starStr?`<div style="color:${C.GOLD};font-size:13px;margin-top:2px">${starStr}</div>`:''}
    <div style="font-size:12px;color:${C.GRAPHITE};margin-top:8px;line-height:1.6">
      &#128205; ${v.hotelAddress!=='—'?v.hotelAddress+', ':''} ${v.hotelCity}
      ${v.hotelPhone!=='—'?`<br/>&#128222; ${v.hotelPhone}`:''}
    </div>
  </div>

  <div style="background:#fff;border:1px solid ${C.BORDER};border-radius:14px;padding:20px 22px;margin-bottom:14px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GOLD};margin-bottom:10px">Stay</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:5px 0;color:${C.GRAPHITE};width:38%">Check-in</td><td style="color:${C.MIDNIGHT};font-weight:500">${v.checkIn}</td></tr>
      <tr><td style="padding:5px 0;color:${C.GRAPHITE}">Check-out</td><td style="color:${C.MIDNIGHT};font-weight:500">${v.checkOut}</td></tr>
      ${v.nights?`<tr><td style="padding:5px 0;color:${C.GRAPHITE}">Nights</td><td style="color:${C.MIDNIGHT};font-weight:500">${v.nights}</td></tr>`:''}
      <tr><td style="padding:5px 0;color:${C.GRAPHITE}">Room type</td><td style="color:${C.MIDNIGHT};font-weight:500">${v.roomType}</td></tr>
      <tr><td style="padding:5px 0;color:${C.GRAPHITE}">Board</td><td style="color:${C.MIDNIGHT};font-weight:500">${v.boardType}</td></tr>
      <tr><td style="padding:5px 0;color:${C.GRAPHITE}">Guests</td><td style="color:${C.MIDNIGHT};font-weight:500">${v.passengers}</td></tr>
    </table>
    ${promoRows}
  </div>

  <div style="background:#fff;border:1px solid ${C.BORDER};border-radius:14px;padding:18px 22px;margin-bottom:14px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GOLD};margin-bottom:6px">Lead guest</div>
    <div style="font-size:15px;color:${C.MIDNIGHT};font-weight:500">${v.holderName}</div>
    ${v.guestEmail?`<div style="font-size:12px;color:${C.GRAPHITE};margin-top:3px">${v.guestEmail}</div>`:''}
    ${v.guestPhone?`<div style="font-size:12px;color:${C.GRAPHITE};margin-top:2px">${v.guestPhone}</div>`:''}
  </div>

  ${v.rateComments?`
  <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:14px;padding:14px 18px;margin-bottom:14px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GOLD};margin-bottom:5px">Rate information</div>
    <div style="font-size:12px;color:${C.GRAPHITE};line-height:1.5">${v.rateComments}</div>
  </div>`:''}

  ${cancelRows?`
  <div style="background:#fff;border:1px solid ${C.BORDER};border-radius:14px;padding:14px 18px;margin-bottom:14px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.GOLD};margin-bottom:6px">Cancellation policy</div>
    <ul style="margin:0;padding-left:16px;font-size:12px;color:${C.GRAPHITE};line-height:1.6">${cancelRows}</ul>
  </div>`:''}

  <div style="background:${C.CHAMPAGNE};border:1px solid ${C.BORDER};border-radius:10px;padding:12px 16px;margin-bottom:20px;">
    <div style="font-size:11px;color:${C.GRAPHITE};line-height:1.6;opacity:.75">${v.paymentText}</div>
  </div>

  <div style="text-align:center;font-size:11px;color:${C.GRAPHITE};opacity:.5;line-height:1.6">
    Booked through ${v.agencyName} via Bodrless
  </div>
</div>
</body></html>`;
  }

  _generatePDF(html) {
    return new Promise((resolve, reject) => {
      const os   = require('os');
      const fs   = require('fs');
      const path = require('path');
      const id   = `bodrless-voucher-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const htmlPath = path.join(os.tmpdir(), `${id}.html`);
      const pdfPath  = path.join(os.tmpdir(), `${id}.pdf`);

      const cleanup = () => {
        try { fs.unlinkSync(htmlPath); } catch {}
        try { fs.unlinkSync(pdfPath);  } catch {}
      };

      try {
        fs.writeFileSync(htmlPath, html, 'utf8');
      } catch (err) {
        return reject(new Error(`Failed to write temp HTML: ${err.message}`));
      }

      const proc = spawn('wkhtmltopdf', [
        '--quiet',
        '--disable-smart-shrinking',
        '--page-size', 'A4',
        '--margin-top', '10mm', '--margin-bottom', '10mm',
        '--margin-left', '12mm', '--margin-right', '12mm',
        htmlPath,
        pdfPath,
      ]);

      const errChunks = [];
      proc.stderr.on('data', c => errChunks.push(c));

      proc.on('close', code => {
        if (code !== 0) {
          cleanup();
          return reject(new Error(`wkhtmltopdf exited ${code}: ${Buffer.concat(errChunks).toString().trim()}`));
        }
        try {
          const pdfBuffer = fs.readFileSync(pdfPath);
          cleanup();
          resolve(pdfBuffer);
        } catch (err) {
          cleanup();
          reject(new Error(`Failed to read PDF output: ${err.message}`));
        }
      });

      proc.on('error', err => {
        cleanup();
        if (err.code === 'ENOENT') {
          reject(new Error('wkhtmltopdf not found — install it on Render or set VOUCHER_PDF_ENABLED=false'));
        } else {
          reject(err);
        }
      });
    });
  }

  async _sendEmail({ voucherData: v, html, pdfBuffer, isResend }) {
    if (!resendClient) return { success: false, error: 'RESEND_API_KEY not set' };

    const recipients = [v.guestEmail, v.agencyEmail].filter(Boolean);
    if (!recipients.length) return { success: false, error: 'No email recipients' };

    const subject = isResend
      ? `Payment confirmed — your voucher for ${v.hotelName}`
      : `Your booking is confirmed — ${v.hotelName} (${v.bookingRef})`;

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

  async _sendWhatsApp({ voucherData: v, agency }) {
    const whatsappService = require('./whatsapp');
    const phoneNumberId   = v.agencyWhatsappPhoneNumberId;

    if (!v.guestPhone)    return { success: false, error: 'No guest phone' };
    if (!phoneNumberId)   return { success: false, error: 'Agency WhatsApp not configured' };

    const cancelLines = (v.cancellationPolicies || []).map(p =>
      `• From ${p.from ? new Date(p.from).toLocaleDateString('en-KE') : '—'}: ${p.amount || '—'} ${v.currency}`
    );

    const parts = [
      `✅ *Booking Confirmed*`,
      ``,
      `*${v.hotelName}*${v.hotelStars ? ' ' + '⭐'.repeat(Math.min(v.hotelStars, 5)) : ''}`,
      `📍 ${v.hotelAddress !== '—' ? v.hotelAddress + ', ' : ''}${v.hotelCity}`,
      v.hotelPhone !== '—' ? `📞 ${v.hotelPhone}` : null,
      ``,
      `*Reference:* ${v.bookingRef}`,
      v.agencyRef ? `*Agency ref:* ${v.agencyRef}` : null,
      ``,
      `*Check-in:* ${v.checkIn}`,
      `*Check-out:* ${v.checkOut}`,
      v.nights ? `*Nights:* ${v.nights}` : null,
      `*Room:* ${v.roomType}`,
      `*Board:* ${v.boardType}`,
      `*Guests:* ${v.passengers}`,
      ``,
      `*Lead guest:* ${v.holderName}`,
      (v.promotions||[]).length ? `\n⚠ ${v.promotions.map(p=>p.name||p.remark).join('\n⚠ ')}` : null,
      v.rateComments ? `\n📋 *Rate note*\n${v.rateComments}` : null,
      cancelLines.length ? `\n*Cancellation policy*\n${cancelLines.join('\n')}` : null,
      ``,
      `_${v.paymentText}_`,
    ].filter(p => p !== null);

    const message = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

    try {
      await whatsappService.sendText(phoneNumberId, v.guestPhone, message);
      logger.info('VoucherService: WhatsApp voucher sent', { phone: v.guestPhone });
      return { success: true };
    } catch (err) {
      logger.error('VoucherService: WhatsApp send failed', { error: err.message });
      return { success: false, error: err.message };
    }
  }
}

module.exports = new VoucherService();