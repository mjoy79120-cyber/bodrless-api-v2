/**
 * EMAIL SERVICE
 * ─────────────────────────────────────────────────────────────
 * Thin wrapper around Resend. This is the FIRST transactional email
 * in the system — nothing else sends mail yet (forgot-password relies
 * on Supabase Auth's own built-in email).
 *
 * Deliberately structured as ONE entry point per email type
 * (sendOnboardingEmail, more to follow later — e.g. sendBookingConfirmed,
 * sendPasswordChanged) rather than a generic "sendEmail(html)" function
 * called from route handlers. Keeping templates here means the agency
 * routes file doesn't need to know what an onboarding email looks like,
 * and swapping Resend for another provider later only touches this file.
 *
 * REQUIRED ENV VARS:
 *   RESEND_API_KEY        — from the Resend dashboard
 *   EMAIL_FROM             — e.g. "Bodrless <onboarding@yourdomain.com>"
 *                             must be a domain verified in Resend, or
 *                             sends will fail/land in spam. Resend's
 *                             onboarding@resend.dev works for testing
 *                             only — verify your own domain before
 *                             agencies see these emails.
 *   DASHBOARD_URL           — e.g. "https://app.bodrless.com" — used to
 *                             build the "go to your dashboard" link.
 *                             Falls back to a placeholder if unset, with
 *                             a loud log warning so it's not silently wrong.
 * ─────────────────────────────────────────────────────────────
 */

const { Resend } = require('resend');
const { logger } = require('../utils/logger');

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM = process.env.EMAIL_FROM || 'Bodrless <onboarding@resend.dev>';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://app.bodrless.com';

if (!process.env.DASHBOARD_URL) {
  logger.warn('DASHBOARD_URL not set — onboarding emails will link to a placeholder URL. Set this in Render env vars.');
}

class EmailService {

  // ─────────────────────────────────────────────
  // SEND ONBOARDING EMAIL
  // Fired once, right after a successful /register. Never throws —
  // returns { success, error? } so the caller can log a failure
  // without ever letting it affect the signup response itself. A
  // failed welcome email must NEVER make signup look like it failed.
  // ─────────────────────────────────────────────
  async sendOnboardingEmail({ agencyName, agencyEmail, widgetCode, whatsappWebhook, plan }) {
    if (!resend) {
      logger.warn('RESEND_API_KEY not set — skipping onboarding email', { agencyEmail });
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const { data, error } = await resend.emails.send({
        from:    FROM,
        to:      [agencyEmail],
        subject: `Welcome to Bodrless, ${agencyName}`,
        html:    _onboardingTemplate({ agencyName, widgetCode, whatsappWebhook, plan }),
      });

      if (error) {
        logger.error('Onboarding email failed', { agencyEmail, error: error.message || error });
        return { success: false, error: error.message || String(error) };
      }

      logger.info('Onboarding email sent', { agencyEmail, emailId: data?.id });
      return { success: true, emailId: data?.id };

    } catch (err) {
      // Network failure, Resend outage, etc. — same non-blocking
      // contract as the explicit error branch above.
      logger.error('Onboarding email threw', { agencyEmail, error: err.message });
      return { success: false, error: err.message };
    }
  }
}

// ─────────────────────────────────────────────
// ONBOARDING EMAIL TEMPLATE
// Matches the dashboard's brand exactly: midnight/gold/emerald
// palette, champagne background, the same card treatment used
// throughout dashboard.tsx (rounded corners, soft border, white
// cards on a tinted page background).
//
// Email-client constraint: no CSS variables (Outlook/Gmail strip
// <style> custom properties unreliably), so the hex values are
// inlined directly. Table-based layout avoided where possible in
// favor of simple divs with inline styles, which renders acceptably
// across Gmail/Apple Mail/Outlook web for a transactional email at
// this level of complexity — flagged here in case a designer wants
// to harden this further with a dedicated email-safe framework
// (MJML / react-email) later.
// ─────────────────────────────────────────────
function _onboardingTemplate({ agencyName, widgetCode, whatsappWebhook, plan }) {
  const MIDNIGHT = '#1a2744';
  const GOLD = '#c9a14f';
  const EMERALD = '#1f7a5c';
  const CHAMPAGNE = '#f7f3ea';
  const GRAPHITE = '#3f3d38';
  const BORDER = '#e6ddc9';

  const escapedWidgetCode = (widgetCode || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to Bodrless</title>
</head>
<body style="margin:0; padding:0; background-color:${CHAMPAGNE}; font-family:Georgia, 'Times New Roman', serif;">
  <div style="max-width:560px; margin:0 auto; padding:40px 24px;">

    <!-- Wordmark -->
    <div style="text-align:center; margin-bottom:32px;">
      <span style="font-size:22px; color:${MIDNIGHT}; letter-spacing:0.02em;">bodrless</span>
    </div>

    <!-- Main card -->
    <div style="background:#ffffff; border:1px solid ${BORDER}; border-radius:16px; padding:40px 32px;">

      <h1 style="font-size:26px; color:${MIDNIGHT}; margin:0 0 8px; font-weight:normal;">
        Welcome, ${agencyName}
      </h1>
      <p style="font-size:14px; color:${GRAPHITE}; opacity:0.75; margin:0 0 28px; line-height:1.6;">
        Your account is live. Here's everything you need to start receiving bookings.
      </p>

      ${plan ? `
      <div style="display:inline-block; font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:${GOLD}; border:1px solid ${GOLD}66; border-radius:999px; padding:4px 12px; margin-bottom:28px;">
        ${plan} plan
      </div>
      ` : ''}

      <!-- Step 1: Widget -->
      <div style="border-top:1px solid ${BORDER}; padding-top:24px; margin-top:4px;">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:${GOLD}; margin-bottom:6px;">
          Step 1 — Website widget
        </div>
        <p style="font-size:13px; color:${GRAPHITE}; opacity:0.8; margin:0 0 12px; line-height:1.6;">
          Paste this snippet just before the closing &lt;/body&gt; tag on your website to start taking bookings there.
        </p>
        <div style="background:${CHAMPAGNE}; border:1px solid ${BORDER}; border-radius:10px; padding:14px 16px; font-family:'SF Mono', Consolas, monospace; font-size:11px; color:${MIDNIGHT}; word-break:break-all; line-height:1.6;">
          ${escapedWidgetCode || 'Available in your dashboard'}
        </div>
      </div>

      <!-- Step 2: WhatsApp -->
      <div style="border-top:1px solid ${BORDER}; padding-top:24px; margin-top:24px;">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:${GOLD}; margin-bottom:6px;">
          Step 2 — WhatsApp
        </div>
        <p style="font-size:13px; color:${GRAPHITE}; opacity:0.8; margin:0 0 12px; line-height:1.6;">
          Add this URL as your webhook in WhatsApp Business API to start receiving travelers there too.
        </p>
        <div style="background:${CHAMPAGNE}; border:1px solid ${BORDER}; border-radius:10px; padding:14px 16px; font-family:'SF Mono', Consolas, monospace; font-size:11px; color:${MIDNIGHT}; word-break:break-all; line-height:1.6;">
          ${whatsappWebhook || 'Available in your dashboard'}
        </div>
      </div>

      <!-- CTA -->
      <div style="text-align:center; margin-top:32px;">
        <a href="${DASHBOARD_URL}"
           style="display:inline-block; background:${EMERALD}; color:#ffffff; text-decoration:none; font-size:14px; font-family:Georgia, serif; padding:12px 32px; border-radius:999px;">
          Go to your dashboard
        </a>
      </div>

    </div>

    <!-- Footer -->
    <p style="text-align:center; font-size:11px; color:${GRAPHITE}; opacity:0.5; margin-top:28px; line-height:1.6;">
      You're receiving this because you signed up for Bodrless.<br/>
      Questions? Just reply to this email.
    </p>

  </div>
</body>
</html>
`.trim();
}

module.exports = new EmailService();