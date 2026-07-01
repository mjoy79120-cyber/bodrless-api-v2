/**
 * HOTELBEDS CONTENT API — batch sync + lookup
 * ─────────────────────────────────────────────
 * Populates hotelbeds_hotel_content (Supabase) from HotelBeds'
 * Content API, and provides fast local lookups for enriching
 * search results / vouchers / notifications with hotel address,
 * phone, email, category, and facilities — data the live
 * Availability/Booking API response does not carry (confirmed
 * against the Content API OpenAPI spec: ApiHotel already has
 * address/phones/email/facilities/images/categoryCode, so the
 * /hotels LIST endpoint alone covers everything needed — no need
 * to also call /hotels/{code}/details per hotel).
 *
 * TWO SEPARATE CONCERNS, KEPT SEPARATE ON PURPOSE:
 *   1. syncAll() — batch job, runs on a schedule (see server.js
 *      wiring note at the bottom of this file), pulls broadly by
 *      COUNTRY CODE and upserts into Supabase. Slow, infrequent,
 *      never on the live request path.
 *   2. getHotelContent()/getHotelContentBatch() — fast Supabase
 *      reads, safe to call inline during a live search/booking.
 *
 * Rate comments (resolveRateComment) are intentionally NOT part of
 * the batch sync — they're keyed by a specific rateCommentsId +
 * date returned at BOOKING time, not something meaningful to
 * pre-sync per hotel. That's a small, on-demand live call made once
 * per booking confirmation (see integration note at the bottom of
 * this file), not a batch concern.
 *
 * AUTH: HotelBeds' standard Content API signature scheme —
 * X-Signature = SHA256(apiKey + secret + currentUnixTimestampSeconds).
 * Same credentials as the Booking/Availability API
 * (HOTELBEDS_API_KEY / HOTELBEDS_SECRET) — HotelBeds does not issue
 * separate keys per API product. ASSUMPTION: this matches the env
 * var names already used in hotelbeds.js (the booking-side adapter);
 * if that adapter uses different names, update HOTELBEDS_API_KEY /
 * HOTELBEDS_SECRET below to match.
 * ─────────────────────────────────────────────
 */

const axios  = require('axios');
const crypto = require('crypto');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

let tracking = null;
try {
  tracking = require('./trackingService');
} catch (e) {
  // trackingService is optional here — sync still works without alerting.
}

class HotelbedsContentService {

  constructor() {
    // Content API has its own base path (/hotel-content-api/1.0),
    // distinct from the Booking API's /hotel-api/1.0 — same host,
    // same credentials, different product path. Defaults to
    // HotelBeds' TEST environment per the OpenAPI spec's servers
    // block; override HOTELBEDS_CONTENT_BASE_URL for production
    // (typically api.hotelbeds.com instead of api.test.hotelbeds.com).
    this.baseUrl = process.env.HOTELBEDS_CONTENT_BASE_URL
      || 'https://api.test.hotelbeds.com/hotel-content-api/1.0';

    this.apiKey = process.env.HOTELBEDS_API_KEY;
    this.secret = process.env.HOTELBEDS_SECRET;

    // Countries to sync, broadly — per product decision: pull all
    // hotels in these countries regardless of past search history,
    // rather than scoping to only-searched destinations. Starts
    // with Bodrless's three confirmed primary markets; extend this
    // list (or override entirely via env) as new markets open up.
    // ISO-ish HotelBeds country codes — confirm exact codes via
    // /locations/countries if any of these don't return hotels.
    this.countryCodes = (process.env.HOTELBEDS_CONTENT_COUNTRIES || 'KE,TZ,ZA')
      .split(',')
      .map(c => c.trim().toUpperCase())
      .filter(Boolean);

    this.pageSize = Number(process.env.HOTELBEDS_CONTENT_PAGE_SIZE) || 200;
    this.timeout  = Number(process.env.HOTELBEDS_CONTENT_TIMEOUT_MS) || 20000;

    // HotelBeds' documented image CDN convention — the Content API
    // returns only a relative `path` per image (see ApiImage schema:
    // "we do not return the full path... one of the following paths
    // must be added by the client"). `bigger` gives a reasonably
    // large image suitable for hotel cards; override via env if a
    // different size/base is preferred.
    this.imageBaseUrl = process.env.HOTELBEDS_IMAGE_BASE_URL
      || 'https://photos.hotelbeds.com/giata/bigger/';

    // Gentle pacing between pages/countries to stay well under
    // HotelBeds' rate limits during a broad multi-country pull —
    // this is a background job, not latency-sensitive, so there's
    // no cost to being conservative here.
    this.pageDelayMs = Number(process.env.HOTELBEDS_CONTENT_PAGE_DELAY_MS) || 350;
  }

  // ─────────────────────────────────────────────
  // AUTH HEADERS
  // ─────────────────────────────────────────────
  _headers() {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash('sha256')
      .update(`${this.apiKey}${this.secret}${timestamp}`)
      .digest('hex');

    return {
      'Api-key':         this.apiKey,
      'X-Signature':      signature,
      'Accept':           'application/json',
      'Accept-Encoding':  'gzip',
      'Content-Type':     'application/json',
    };
  }

  // ─────────────────────────────────────────────
  // SYNC ALL CONFIGURED COUNTRIES
  // Sequential (not parallel) across countries — deliberate, to stay
  // well under Content API rate limits during a broad pull. One
  // country failing (network blip, bad country code) never aborts
  // the rest — logged and alerted, then moves on.
  // ─────────────────────────────────────────────
  async syncAll() {
    if (!this.apiKey || !this.secret) {
      logger.error('HotelbedsContent: missing HOTELBEDS_API_KEY/HOTELBEDS_SECRET — sync skipped');
      return { synced: 0, failed: this.countryCodes.length, countries: [] };
    }

    const startedAt = Date.now();
    const summary = { synced: 0, failed: 0, countries: [] };

    logger.info('HotelbedsContent: sync starting', { countries: this.countryCodes });

    for (const countryCode of this.countryCodes) {
      try {
        const count = await this.syncCountry(countryCode);
        summary.synced += count;
        summary.countries.push({ countryCode, hotels: count, status: 'ok' });
      } catch (err) {
        summary.failed += 1;
        summary.countries.push({ countryCode, hotels: 0, status: 'failed', error: err.message });
        logger.error('HotelbedsContent: country sync failed', { countryCode, error: err.message });
        if (tracking) {
          tracking.alert({
            type:     'hotelbeds_content_sync_failed',
            severity: 'warning',
            title:    `HotelBeds content sync failed for ${countryCode}`,
            detail:   err.message,
            context:  { countryCode },
          });
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    logger.info('HotelbedsContent: sync complete', { ...summary, durationMs });

    if (tracking && summary.failed > 0) {
      tracking.alert({
        type:     'hotelbeds_content_sync_partial',
        severity: 'warning',
        title:    `HotelBeds content sync finished with ${summary.failed} failed countr${summary.failed === 1 ? 'y' : 'ies'}`,
        detail:   JSON.stringify(summary.countries.filter(c => c.status === 'failed')),
        context:  summary,
      });
    }

    return summary;
  }

  // ─────────────────────────────────────────────
  // SYNC ONE COUNTRY (paginated)
  // Uses the /hotels LIST endpoint, filtered by countryCode. Pages
  // via from/to until the response's `to` reaches `total`. Each
  // page is normalized and upserted immediately (not batched across
  // the whole country) so a failure partway through a large country
  // still leaves earlier pages committed rather than losing
  // everything.
  // ─────────────────────────────────────────────
  async syncCountry(countryCode) {
    let from = 1;
    let total = Infinity;
    let synced = 0;

    while (from <= total) {
      const to = from + this.pageSize - 1;

      const response = await this._getWithRetry('/hotels', {
        countryCode,
        from,
        to,
      });

      const data = response.data || {};
      total = Number(data.total) || 0;
      const hotels = Array.isArray(data.hotels) ? data.hotels : [];

      if (hotels.length === 0) break;

      const rows = hotels.map(h => this._normalizeHotel(h, countryCode));
      await this._upsertRows(rows);
      synced += rows.length;

      logger.info('HotelbedsContent: page synced', {
        countryCode, from, to: Math.min(to, total), total, pageCount: rows.length,
      });

      from = to + 1;

      if (from <= total) {
        await this._sleep(this.pageDelayMs);
      }
    }

    return synced;
  }

  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────
  // GET WITH RETRY
  // Content API is rate-limited (429) and occasionally 5xx during
  // large pulls — retry with backoff rather than aborting the whole
  // country sync over a transient blip. Not retried: 400/401/403,
  // those are real request/auth problems that won't fix themselves.
  // ─────────────────────────────────────────────
  async _getWithRetry(path, params, attempt = 1) {
    const maxAttempts = 4;
    try {
      return await axios.get(`${this.baseUrl}${path}`, {
        params,
        headers: this._headers(),
        timeout: this.timeout,
      });
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || !status;

      if (retryable && attempt < maxAttempts) {
        const backoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
        logger.warn('HotelbedsContent: request failed, retrying', {
          path, params, status, attempt, backoffMs,
        });
        await this._sleep(backoffMs);
        return this._getWithRetry(path, params, attempt + 1);
      }

      logger.error('HotelbedsContent: request failed, giving up', {
        path, params, status, error: err.message, body: err.response?.data,
      });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE ONE HOTEL (Content API shape -> our table row)
  // ─────────────────────────────────────────────
  _normalizeHotel(h, fallbackCountryCode) {
    const phones = Array.isArray(h.phones) ? h.phones : [];
    const bestPhone =
      phones.find(p => (p.phoneType || '').toUpperCase() === 'PHONEBOOKING') ||
      phones.find(p => (p.phoneType || '').toUpperCase() === 'PHONEHOTEL') ||
      phones[0] || null;

    const facilities = Array.isArray(h.facilities)
      ? h.facilities.map(f => ({
          code: f.facilityCode,
          name: f.description?.content || null,
        })).filter(f => f.name)
      : [];

    const images = Array.isArray(h.images)
      ? h.images.slice(0, 8).map(img => ({
          url:  img.path ? `${this.imageBaseUrl}${img.path}` : null,
          type: img.imageTypeCode || null,
        })).filter(img => img.url)
      : [];

    return {
      hotel_code:       h.code,
      name:             h.name?.content || null,
      category_code:    h.categoryCode || null,
      country_code:     h.countryCode || fallbackCountryCode,
      destination_code: h.destinationCode || null,
      city:             h.city?.content || null,
      address:          h.address?.content || null,
      phone:            bestPhone?.phoneNumber || null,
      email:            h.email || null,
      latitude:         h.coordinates?.latitude ?? null,
      longitude:        h.coordinates?.longitude ?? null,
      facilities,
      board_codes:      Array.isArray(h.boardCodes) ? h.boardCodes : [],
      images,
      raw:              h,
      last_synced_at:   new Date().toISOString(),
    };
  }

  // ─────────────────────────────────────────────
  // UPSERT (chunked — Supabase/Postgres has practical payload limits
  // on a single insert; 500 rows per call is comfortably safe)
  // ─────────────────────────────────────────────
  async _upsertRows(rows) {
    const chunkSize = 500;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const { error } = await supabase
        .from('hotelbeds_hotel_content')
        .upsert(chunk, { onConflict: 'hotel_code' });

      if (error) {
        logger.error('HotelbedsContent: upsert failed', { error: error.message, chunkSize: chunk.length });
        throw new Error(`Supabase upsert failed: ${error.message}`);
      }
    }
  }

  // ─────────────────────────────────────────────
  // LOOKUP — SINGLE HOTEL (live request path, fast)
  // ─────────────────────────────────────────────
  async getHotelContent(hotelCode) {
    if (!hotelCode) return null;
    try {
      const { data, error } = await supabase
        .from('hotelbeds_hotel_content')
        .select('*')
        .eq('hotel_code', hotelCode)
        .single();

      if (error) {
        // Not found is expected for hotels outside the synced
        // countries or not yet synced — not worth logging as an error.
        if (error.code !== 'PGRST116') {
          logger.warn('HotelbedsContent: lookup failed', { hotelCode, error: error.message });
        }
        return null;
      }
      return data;
    } catch (err) {
      logger.warn('HotelbedsContent: lookup threw', { hotelCode, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // LOOKUP — BATCH (enrich a full search-result page in one query
  // instead of N round-trips)
  // ─────────────────────────────────────────────
  async getHotelContentBatch(hotelCodes) {
    const codes = (hotelCodes || []).filter(c => c != null);
    if (codes.length === 0) return {};

    try {
      const { data, error } = await supabase
        .from('hotelbeds_hotel_content')
        .select('*')
        .in('hotel_code', codes);

      if (error) {
        logger.warn('HotelbedsContent: batch lookup failed', { error: error.message, count: codes.length });
        return {};
      }

      const byCode = {};
      for (const row of data || []) {
        byCode[row.hotel_code] = row;
      }
      return byCode;
    } catch (err) {
      logger.warn('HotelbedsContent: batch lookup threw', { error: err.message });
      return {};
    }
  }

  // ─────────────────────────────────────────────
  // RATE COMMENT RESOLUTION (live, on-demand — NOT part of the
  // batch sync; see file header for why)
  // Resolves a rateCommentsId + date (both captured at booking time
  // per this session's HotelBeds certification work) to the
  // human-readable comment text required on the voucher.
  // ─────────────────────────────────────────────
  async resolveRateComment({ code, date }) {
    if (!code || !date) return null;
    try {
      const response = await this._getWithRetry('/types/ratecommentdetails', { code, date });
      const comments = response.data?.rateComments || [];
      return comments.map(c => c.description).filter(Boolean).join(' ') || null;
    } catch (err) {
      logger.warn('HotelbedsContent: rate comment resolution failed', { code, date, error: err.message });
      return null;
    }
  }
}

module.exports = new HotelbedsContentService();