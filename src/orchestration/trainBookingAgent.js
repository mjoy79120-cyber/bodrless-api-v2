/**
 * TRAIN BOOKING AGENT
 * ─────────────────────────────────────────────────────────────
 * Automates SGR ticket booking on metickets.krc.co.ke using Playwright.
 *
 * Two-phase design:
 *   Phase 1 — warmUp()   : called the moment train results are shown.
 *                          Launches browser, navigates to passenger form,
 *                          parks the session. Returns a sessionId.
 *
 *   Phase 2 — complete() : called when user clicks "Book".
 *                          Resumes the parked session, fills passenger
 *                          details from Supabase, submits — triggering
 *                          the M-Pesa STK push to the passenger's phone.
 *
 * Sessions time out after 10 minutes (TTL_MS) and are cleaned up automatically.
 *
 * Install: npm install playwright
 * First run: npx playwright install chromium
 */

const { chromium } = require('playwright');
const supabase      = require('../utils/supabase');
const { logger }    = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const SGR_URL   = 'https://metickets.krc.co.ke/';
const TTL_MS    = 10 * 60 * 1000;   // 10 minutes — session held open this long
const MAX_SESSIONS = 20;             // cap concurrent warm sessions on Render

// Train type → site dropdown value mapping
const TRAIN_TYPE_MAP = {
  'express':       'Express',
  'inter-county':  'Inter-County',
  'intercounty':   'Inter-County',
  'intercity':     'Express',
  default:         'Express',
};

// Station name → site dropdown label mapping
const STATION_MAP = {
  'nairobi':       'Nairobi Terminus',
  'mombasa':       'Mombasa Terminus',
  'voi':           'Voi',
  'mtito andei':   'Mtito Andei',
  'mariakani':     'Mariakani',
  'kibwezi':       'Kibwezi',
  'emali':         'Emali',
  'athi river':    'Athi River',
};

// Departure time → site dropdown value
const TIME_MAP = {
  '08:00': null,          // Inter-County only — no dropdown needed, site auto-selects
  '15:00': '3.00 pm',
  '10:00 pm': '10.00 pm',
  '22:00': '10.00 pm',
  default: '3.00 pm',
};

// ─────────────────────────────────────────────────────────────
// SESSION STORE
// ─────────────────────────────────────────────────────────────
// Map<sessionId, { browser, page, context, expiresAt, params }>
const sessions = new Map();

function _cleanExpired() {
  const now = Date.now();
  for (const [id, s] of sessions.entries()) {
    if (s.expiresAt < now) {
      logger.info('TrainAgent: session expired — closing browser', { sessionId: id });
      s.browser.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

// Run cleanup every 2 minutes
setInterval(_cleanExpired, 2 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function _resolveStation(city) {
  return STATION_MAP[(city || '').toLowerCase().trim()] || city;
}

function _resolveTrainType(trainType) {
  return TRAIN_TYPE_MAP[(trainType || '').toLowerCase().trim()] || TRAIN_TYPE_MAP.default;
}

function _resolveTime(time) {
  return TIME_MAP[time] || TIME_MAP.default;
}

async function _selectDropdown(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 8000 });
  await page.selectOption(selector, { label: value });
}

async function _getPassengerFromSupabase(bookingRef, agencyId) {
  const { data, error } = await supabase
    .from('passenger_manifest')
    .select('first_name, last_name, national_id, passport_number, phone, nationality, date_of_birth')
    .eq('booking_ref', bookingRef)
    .eq('agency_id', agencyId)
    .limit(1)
    .single();

  if (error) throw new Error(`Passenger lookup failed: ${error.message}`);
  if (!data)  throw new Error(`No passenger found for booking_ref=${bookingRef}`);
  return data;
}

// ─────────────────────────────────────────────────────────────
// PHASE 1 — WARM UP
// Navigate to the passenger form and park the session.
// Call this the moment train results are returned to the user.
// ─────────────────────────────────────────────────────────────
/**
 * @param {object} params
 * @param {string} params.origin        - e.g. "Nairobi"
 * @param {string} params.destination   - e.g. "Mombasa"
 * @param {string} params.date          - "YYYY-MM-DD"
 * @param {string} params.time          - "15:00" | "22:00"
 * @param {string} [params.trainType]   - "express" | "inter-county"
 * @param {number} [params.passengers]  - number of passengers (default 1)
 * @returns {Promise<string>} sessionId
 */
async function warmUp(params) {
  _cleanExpired();

  if (sessions.size >= MAX_SESSIONS) {
    logger.warn('TrainAgent: max sessions reached — skipping warm-up', { current: sessions.size });
    return null;
  }

  const sessionId = uuidv4();
  logger.info('TrainAgent: warming up session', { sessionId, ...params });

  let browser, context, page;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // required on Render
    });

    context = await browser.newContext({
      viewport:  { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    });

    page = await context.newPage();

    // ── Navigate ────────────────────────────────────────────
    await page.goto(SGR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const fromStation = _resolveStation(params.origin);
    const toStation   = _resolveStation(params.destination);
    const trainType   = _resolveTrainType(params.trainType);
    const timeLabel   = _resolveTime(params.time);

    // ── Select train type ───────────────────────────────────
    // The site has two forms (one-way and return) — target the one-way form
    await _selectDropdown(page, 'select[name="train_type"]:first-of-type', trainType);

    // ── From ────────────────────────────────────────────────
    await _selectDropdown(page, 'select[name="from"]:first-of-type', fromStation);

    // ── To ──────────────────────────────────────────────────
    await _selectDropdown(page, 'select[name="to"]:first-of-type', toStation);

    // ── Date ────────────────────────────────────────────────
    await page.fill('input[name="departure_date"]:first-of-type', params.date);

    // ── Time ────────────────────────────────────────────────
    if (timeLabel) {
      await _selectDropdown(page, 'select[name="departure_time"]:first-of-type', timeLabel);
    }

    // ── Submit search ───────────────────────────────────────
    await Promise.all([
      page.click('button[type="submit"]:first-of-type, input[type="submit"]:first-of-type'),
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {}),
    ]);

    // ── Wait for results / passenger form ───────────────────
    // The site may show available trains — click first one if needed
    const trainResult = await page.$('.train-result, .available-train, .select-train, tr.clickable');
    if (trainResult) {
      await trainResult.click();
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
    }

    // Park here — we're now on the passenger details form
    const currentUrl = page.url();
    logger.info('TrainAgent: warm-up complete — parked at', { sessionId, url: currentUrl });

    sessions.set(sessionId, {
      browser,
      context,
      page,
      params,
      expiresAt: Date.now() + TTL_MS,
      status: 'parked',
    });

    return sessionId;

  } catch (err) {
    logger.error('TrainAgent: warm-up failed', { sessionId, error: err.message });
    if (browser) await browser.close().catch(() => {});
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// PHASE 2 — COMPLETE BOOKING
// Resume parked session, fill passenger details, submit.
// Returns booking reference from KRC confirmation page.
// ─────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} opts.sessionId    - from warmUp()
 * @param {string} opts.bookingRef   - your internal booking_ref (to look up passenger)
 * @param {string} opts.agencyId
 * @param {number} [opts.passengers] - number of passengers (default 1)
 * @returns {Promise<{ success: boolean, krcRef?: string, error?: string }>}
 */
async function complete({ sessionId, bookingRef, agencyId, passengers = 1 }) {
  const session = sessions.get(sessionId);

  // ── No warm session — do a fresh cold booking ────────────
  if (!session) {
    logger.warn('TrainAgent: no warm session found — attempting cold booking', { sessionId });
    return coldBook({ bookingRef, agencyId, passengers });
  }

  const { page, browser, params } = session;

  try {
    // Refresh TTL while completing
    session.expiresAt = Date.now() + TTL_MS;

    // ── Fetch passenger from Supabase ────────────────────────
    const passenger = await _getPassengerFromSupabase(bookingRef, agencyId);
    const idNumber  = passenger.national_id || passenger.passport_number;

    if (!idNumber) throw new Error('No national_id or passport_number found for passenger');
    if (!passenger.phone) throw new Error('No phone number found for passenger — needed for M-Pesa');

    logger.info('TrainAgent: completing booking', {
      sessionId, bookingRef,
      passenger: `${passenger.first_name} ${passenger.last_name}`,
    });

    // ── Fill passenger form ──────────────────────────────────
    // KRC form fields (based on site inspection)
    await _fillIfExists(page, 'input[name="first_name"], input[placeholder*="First"], input[id*="first"]',
      passenger.first_name);

    await _fillIfExists(page, 'input[name="last_name"], input[placeholder*="Last"], input[id*="last"]',
      passenger.last_name);

    await _fillIfExists(page, 'input[name="id_number"], input[name="national_id"], input[placeholder*="ID"], input[placeholder*="Passport"]',
      idNumber);

    await _fillIfExists(page, 'input[name="phone"], input[name="mobile"], input[placeholder*="Phone"], input[placeholder*="Mobile"]',
      _formatPhone(passenger.phone));

    await _fillIfExists(page, 'input[name="email"], input[placeholder*="Email"]',
      passenger.email || '');

    // ── Handle multiple passengers ───────────────────────────
    // If site supports adding more passengers, handle here
    // (KRC site appears to be single-passenger per booking — book multiple if needed)

    // ── Submit ───────────────────────────────────────────────
    await Promise.all([
      page.click('button[type="submit"], input[type="submit"], .book-btn, .submit-btn, button:has-text("Book"), button:has-text("Pay"), button:has-text("Continue")'),
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
    ]);

    // ── Scrape confirmation ──────────────────────────────────
    await page.waitForTimeout(2000); // brief wait for page to settle

    const krcRef = await _scrapeConfirmationRef(page);

    // ── Update passenger_manifest with KRC reference ─────────
    if (krcRef) {
      await supabase
        .from('passenger_manifest')
        .update({
          transport_reference: krcRef,
          transport_provider:  'SGR',
          metadata: { krc_booking_ref: krcRef, booked_via: 'trainBookingAgent', booked_at: new Date().toISOString() },
        })
        .eq('booking_ref', bookingRef)
        .eq('agency_id', agencyId);

      logger.info('TrainAgent: booking complete', { sessionId, bookingRef, krcRef });
    }

    // ── Clean up session ─────────────────────────────────────
    sessions.delete(sessionId);
    await browser.close().catch(() => {});

    return {
      success: true,
      krcRef,
      message: krcRef
        ? `SGR ticket booked. Reference: ${krcRef}. Check your phone for M-Pesa prompt.`
        : 'Booking submitted — check your phone for the M-Pesa prompt. You\'ll receive an SMS confirmation from KRC.',
    };

  } catch (err) {
    logger.error('TrainAgent: complete failed', { sessionId, bookingRef, error: err.message });
    sessions.delete(sessionId);
    await browser.close().catch(() => {});
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// COLD BOOKING — no warm session available
// Runs the full flow from scratch (slower, ~8-12 seconds)
// ─────────────────────────────────────────────────────────────
async function coldBook({ bookingRef, agencyId, passengers = 1, params }) {
  logger.info('TrainAgent: cold booking', { bookingRef });

  // Spin up a temporary session then complete immediately
  const sessionId = await warmUp(params);
  if (!sessionId) return { success: false, error: 'Failed to launch booking browser' };

  return complete({ sessionId, bookingRef, agencyId, passengers });
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
async function _fillIfExists(page, selector, value) {
  if (!value) return;
  try {
    const el = await page.$(selector);
    if (el) {
      await el.fill(String(value));
    }
  } catch (err) {
    logger.warn('TrainAgent: field fill failed (non-fatal)', { selector, error: err.message });
  }
}

async function _scrapeConfirmationRef(page) {
  // Try several patterns KRC might use for the booking reference
  const patterns = [
    '.booking-ref', '.booking-id', '.reference', '.confirmation-code',
    '[class*="booking"]', '[class*="reference"]', '[class*="confirm"]',
    'b', 'strong',
  ];

  for (const sel of patterns) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        const text = (await el.innerText()).trim();
        // KRC refs look like BTC followed by digits, e.g. BTC99246806
        const match = text.match(/BTC\d{6,12}/i) || text.match(/\b\d{8,12}\b/);
        if (match) return match[0];
      }
    } catch {}
  }

  // Fallback — scan full page text
  try {
    const body = await page.innerText('body');
    const match = body.match(/BTC\d{6,12}/i);
    if (match) return match[0];
  } catch {}

  return null;
}

function _formatPhone(phone) {
  if (!phone) return '';
  // Normalise to 07XXXXXXXX or 2547XXXXXXXX
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return '0' + digits.slice(3);
  if (digits.startsWith('0'))   return digits;
  return '0' + digits;
}

// ─────────────────────────────────────────────────────────────
// SESSION STATUS — useful for debugging
// ─────────────────────────────────────────────────────────────
function sessionStatus(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { found: false };
  return {
    found:     true,
    status:    s.status,
    expiresIn: Math.round((s.expiresAt - Date.now()) / 1000) + 's',
    params:    s.params,
  };
}

function activeSessions() {
  return sessions.size;
}

module.exports = { warmUp, complete, coldBook, sessionStatus, activeSessions };