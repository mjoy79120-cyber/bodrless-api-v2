/**
 * EMAIL SERVICE
 * ─────────────────────────────────────────────────────────────
 * Single entry point for all outbound email from Bodrless.
 *
 * Types handled here:
 *   sendOnboardingEmail  — welcome email sent after /register
 *   sendNudge            — price-drop / trip-is-close alert to widget visitors
 *
 * Built for Resend's FREE tier (100 emails/day, 3,000/month).
 * Nudge quota: NUDGE_EMAIL_DAILY_CAP (default 50) so booking vouchers
 * always have headroom. One nudge per address per NUDGE_EMAIL_MIN_GAP_HOURS
 * (default 72). Fails closed: if today's count can't be read, no nudge sent.
 *
 * Every nudge email carries an unsubscribe link + List-Unsubscribe headers.
 * Consent and unsubscribe state live on widget_visitors.
 *
 * REQUIRED ENV VARS:
 *   RESEND_API_KEY              — from the Resend dashboard
 *   EMAIL_FROM                  — e.g. "Bodrless <hello@yourdomain.com>"
 *                                 Must be a domain verified in Resend.
 *   DASHBOARD_URL               — e.g. "https://app.bodrless.com"
 *   API_BASE_URL                — e.g. "https://bodrless-api-v2.onrender.com"
 *
 * OPTIONAL ENV VARS:
 *   NUDGE_EMAIL_DAILY_CAP       — default 50
 *   NUDGE_EMAIL_MIN_GAP_HOURS   — default 72
 * ─────────────────────────────────────────────────────────────
 */

const { Resend } = require('resend');
const supabase   = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ── Shared config ─────────────────────────────────────────────
function intEnv(name, def) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

const resendClient  = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM          = process.env.EMAIL_FROM || 'Bodrless <onboarding@resend.dev>';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://app.bodrless.com';
const API_BASE      = process.env.API_BASE_URL  || 'https://bodrless-api-v2.onrender.com';
const DAILY_CAP     = intEnv('NUDGE_EMAIL_DAILY_CAP', 50);
const MIN_GAP_MS    = Math.max(1, intEnv('NUDGE_EMAIL_MIN_GAP_HOURS', 72)) * 3_600_000;

if (!process.env.DASHBOARD_URL) {
  logger.warn('DASHBOARD_URL not set — onboarding emails will link to a placeholder. Set this in Render env vars.');
}

const PRICE_DROP_EMAIL_KES = 2000;
const URGENT_DAYS          = 14;

// ── Shared helpers ────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// destination text originates from user chat — strip anything that could
// break a header or layout before it goes near a subject line
function cleanText(s, max = 60) {
  return String(s == null ? '' : s)
    .replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max);
}

function kes(n) { return 'KES ' + Math.round(Number(n) || 0).toLocaleString('en-US'); }

function startOfUtcDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ── Agency name cache (for nudge emails) ─────────────────────
const _agencyCache = new Map();   // agencyId -> { at, data }
async function _getAgency(agencyId) {
  if (!agencyId) return null;
  const hit = _agencyCache.get(agencyId);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.data;
  let data = null;
  try {
    const r = await supabase
      .from('agencies').select('name,website').eq('id', agencyId).maybeSingle();
    data = r.data || null;
  } catch (_) {}
  _agencyCache.set(agencyId, { at: Date.now(), data });
  return data;
}

// ═════════════════════════════════════════════════════════════
// ONBOARDING EMAIL
// Fired once right after a successful /register. Never throws —
// returns { success, error? } so a failed email never breaks signup.
// ═════════════════════════════════════════════════════════════
async function sendOnboardingEmail({ agencyName, agencyEmail, widgetCode, whatsappWebhook, plan }) {
  if (!resendClient) {
    logger.warn('RESEND_API_KEY not set — skipping onboarding email', { agencyEmail });
    return { success: false, error: 'Email service not configured' };
  }
  try {
    const { data, error } = await resendClient.emails.send({
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
    logger.error('Onboarding email threw', { agencyEmail, error: err.message });
    return { success: false, error: err.message };
  }
}

function _onboardingTemplate({ agencyName, widgetCode, whatsappWebhook, plan }) {
  const MIDNIGHT  = '#1a2744';
  const GOLD      = '#c9a14f';
  const EMERALD   = '#1f7a5c';
  const CHAMPAGNE = '#f7f3ea';
  const GRAPHITE  = '#3f3d38';
  const BORDER    = '#e6ddc9';

  const escapedWidgetCode = (widgetCode || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to Bodrless</title>
</head>
<body style="margin:0; padding:0; background-color:${CHAMPAGNE}; font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:560px; margin:0 auto; padding:40px 24px;">
    <div style="text-align:center; margin-bottom:32px;">
      <span style="font-size:22px; color:${MIDNIGHT}; letter-spacing:0.02em;">bodrless</span>
    </div>
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
      </div>` : ''}
      <div style="border-top:1px solid ${BORDER}; padding-top:24px; margin-top:4px;">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:${GOLD}; margin-bottom:6px;">
          Step 1 — Website widget
        </div>
        <p style="font-size:13px; color:${GRAPHITE}; opacity:0.8; margin:0 0 12px; line-height:1.6;">
          Paste this snippet just before the closing &lt;/body&gt; tag on your website.
        </p>
        <div style="background:${CHAMPAGNE}; border:1px solid ${BORDER}; border-radius:10px; padding:14px 16px; font-family:'SF Mono',Consolas,monospace; font-size:11px; color:${MIDNIGHT}; word-break:break-all; line-height:1.6;">
          ${escapedWidgetCode || 'Available in your dashboard'}
        </div>
      </div>
      <div style="border-top:1px solid ${BORDER}; padding-top:24px; margin-top:24px;">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:${GOLD}; margin-bottom:6px;">
          Step 2 — WhatsApp
        </div>
        <p style="font-size:13px; color:${GRAPHITE}; opacity:0.8; margin:0 0 12px; line-height:1.6;">
          Add this URL as your webhook in WhatsApp Business API.
        </p>
        <div style="background:${CHAMPAGNE}; border:1px solid ${BORDER}; border-radius:10px; padding:14px 16px; font-family:'SF Mono',Consolas,monospace; font-size:11px; color:${MIDNIGHT}; word-break:break-all; line-height:1.6;">
          ${whatsappWebhook || 'Available in your dashboard'}
        </div>
      </div>
      <div style="text-align:center; margin-top:32px;">
        <a href="${DASHBOARD_URL}"
           style="display:inline-block; background:${EMERALD}; color:#ffffff; text-decoration:none; font-size:14px; font-family:Georgia,serif; padding:12px 32px; border-radius:999px;">
          Go to your dashboard
        </a>
      </div>
    </div>
    <p style="text-align:center; font-size:11px; color:${GRAPHITE}; opacity:0.5; margin-top:28px; line-height:1.6;">
      You're receiving this because you signed up for Bodrless.<br/>
      Questions? Just reply to this email.
    </p>
  </div>
</body>
</html>`.trim();
}

// ═════════════════════════════════════════════════════════════
// NUDGE EMAILS (price-drop / trip-is-close)
// Only two events trigger an email; everything else stays in-widget.
// ═════════════════════════════════════════════════════════════

// Returns a composed message object, or null if the wish isn't
// worth an email (no price drop >= 2000 KES and not within 14 days).
function composeMessage(wish) {
  if (!wish || !wish.cache_valid || !wish.best_price_kes) return null;
  const dest   = cleanText(wish.destination);
  if (!dest) return null;
  const when   = cleanText(wish.departure_month || '', 40) || null;
  const price  = Number(wish.best_price_kes);
  const change = Number(wish.price_change) || 0;

  let daysOut = null;
  if (wish.departure_date) {
    daysOut = Math.round((new Date(wish.departure_date) - Date.now()) / 86_400_000);
  }
  const urgent  = daysOut !== null && daysOut > 0 && daysOut <= URGENT_DAYS;
  const dropped = change <= -PRICE_DROP_EMAIL_KES;
  if (!urgent && !dropped) return null;

  const lines = [];
  if (dropped) {
    lines.push(
      `The best package for ${dest}${when ? ' in ' + when : ''} is now from ${kes(price)}, ` +
      `down from ${kes(price - change)}.`
    );
    if (urgent) lines.push(`Your trip is ${daysOut} day${daysOut === 1 ? '' : 's'} away — a good moment to lock it in.`);
  } else {
    lines.push(`Your ${dest} trip is ${daysOut} day${daysOut === 1 ? '' : 's'} away. Packages are still available from ${kes(price)}.`);
  }

  return {
    kind:     dropped ? 'price_drop' : 'urgent',
    subject:  dropped
      ? `Prices dropped for ${dest}`
      : `${daysOut} day${daysOut === 1 ? '' : 's'} until your ${dest} trip`,
    headline: dropped
      ? `Prices dropped for ${dest}`
      : `Your ${dest} trip is almost here`,
    lines,
  };
}

// Returns true if the visitor is eligible for a nudge email right now.
function canEmail(visitor) {
  if (!visitor || !visitor.email || !visitor.email_opt_in || visitor.email_unsubscribed_at) return false;
  if (!visitor.unsubscribe_token) return false;
  if (visitor.last_emailed_at &&
      Date.now() - new Date(visitor.last_emailed_at).getTime() < MIN_GAP_MS) return false;
  return true;
}

// Returns today's sent nudge count, or null if it can't be read (fails closed).
async function sentToday() {
  try {
    const { count, error } = await supabase
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('kind', 'nudge')
      .eq('status', 'sent')
      .gte('sent_at', startOfUtcDay());
    if (error) return null;
    return count || 0;
  } catch (_) { return null; }
}

function _renderNudge({ msg, visitor, agency, unsubUrl }) {
  const agencyName = cleanText((agency && agency.name) || 'Your travel agency', 60);
  const first      = visitor.name ? cleanText(visitor.name, 30) : '';
  const hi         = first ? `Hi ${first},` : 'Hi,';
  const site       = agency && /^https:\/\//.test(agency.website || '') ? agency.website : null;

  const paras = msg.lines
    .map(l => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px;color:#2a2a2a">${escapeHtml(l)}</p>`)
    .join('');
  const cta = site
    ? `<p style="margin:20px 0 4px"><a href="${escapeHtml(site)}" ` +
      `style="background:#1b2240;color:#ffffff;text-decoration:none;padding:12px 22px;` +
      `border-radius:22px;font-size:14px;font-weight:600;display:inline-block">` +
      `Continue your trip</a></p>`
    : '';

  const html =
`<!DOCTYPE html><html><body style="margin:0;background:#f6f4ef;font-family:Arial,Helvetica,sans-serif;color:#1b2240">
<div style="max-width:520px;margin:0 auto;padding:24px 16px">
  <div style="background:#ffffff;border:1px solid #e7e2d9;border-radius:14px;padding:26px">
    <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8b857c;margin-bottom:14px">${escapeHtml(agencyName)}</div>
    <h1 style="font-size:20px;line-height:1.3;margin:0 0 14px;color:#1b2240">${escapeHtml(msg.headline)}</h1>
    <p style="font-size:15px;margin:0 0 14px;color:#2a2a2a">${escapeHtml(hi)}</p>
    ${paras}
    ${cta}
  </div>
  <p style="font-size:11px;line-height:1.6;color:#8b857c;text-align:center;margin:16px 8px 0">
    You are getting this because you asked for trip alerts on ${escapeHtml(agencyName)}.<br/>
    <a href="${escapeHtml(unsubUrl)}" style="color:#8b857c">Unsubscribe</a> &middot; Powered by Bodrless
  </p>
</div></body></html>`;

  const text =
    `${hi}\n\n${msg.lines.join('\n\n')}\n\n` +
    `${site ? 'Continue your trip: ' + site + '\n\n' : ''}` +
    `You asked for trip alerts on ${agencyName}. Unsubscribe: ${unsubUrl}`;

  return { html, text };
}

// Main nudge send. Returns { sent, reason?, id? }. Never throws.
async function sendNudge({ visitor, wish }) {
  try {
    if (!resendClient || !FROM)   return { sent: false, reason: 'email_not_configured' };
    if (!canEmail(visitor))       return { sent: false, reason: 'not_eligible' };
    const msg = composeMessage(wish);
    if (!msg)                     return { sent: false, reason: 'not_worthy' };

    const used = await sentToday();
    if (used === null || used >= DAILY_CAP) return { sent: false, reason: 'daily_cap' };

    const agency   = await _getAgency(wish.agency_id);
    const unsubUrl = `${API_BASE}/api/widget/unsubscribe?token=${encodeURIComponent(visitor.unsubscribe_token)}`;
    const { html, text } = _renderNudge({ msg, visitor, agency, unsubUrl });

    const { data, error } = await resendClient.emails.send({
      from:    FROM,
      to:      [visitor.email],
      subject: msg.subject,
      html,
      text,
      headers: {
        'List-Unsubscribe':      `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });

    if (error) {
      const message = error.message || String(error);
      logger.error('EmailService: nudge send failed', { error: message, wishId: wish.id });
      await supabase.from('email_log').insert({
        kind: 'nudge', to_email: visitor.email, visitor_id: visitor.visitor_id,
        wish_id: wish.id, status: 'failed', error: message.slice(0, 300),
      }).then(() => {}, () => {});
      return { sent: false, reason: 'send_failed', error: message };
    }

    await supabase.from('email_log').insert({
      kind: 'nudge', to_email: visitor.email, visitor_id: visitor.visitor_id,
      wish_id: wish.id, resend_id: (data && data.id) || null, status: 'sent',
    }).then(() => {}, () => {});
    await supabase.from('widget_visitors')
      .update({ last_emailed_at: new Date().toISOString() })
      .eq('visitor_id', visitor.visitor_id)
      .then(() => {}, () => {});

    logger.info('EmailService: nudge sent', { wishId: wish.id, kind: msg.kind });
    return { sent: true, id: data && data.id };
  } catch (err) {
    logger.error('EmailService: sendNudge threw', { error: err.message });
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

// ── Exports ───────────────────────────────────────────────────
// Named exports only — no class instance. All callers use:
//   const emailService = require('../services/emailService');
//   emailService.sendOnboardingEmail(...)   ← agency registration
//   emailService.sendNudge(...)             ← nudge scheduler
//   emailService.canEmail(visitor)          ← nudge scheduler guard
//   emailService.composeMessage(wish)       ← nudge scheduler guard
//   emailService.sentToday()               ← nudge scheduler
module.exports = {
  sendOnboardingEmail,
  composeMessage,
  canEmail,
  sentToday,
  sendNudge,
  escapeHtml,
};