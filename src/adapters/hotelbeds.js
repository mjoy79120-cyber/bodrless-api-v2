/**
 * HOTELBEDS ADAPTER
 * ─────────────────────────────────────────────
 * Normalizes HotelBeds API responses into
 * Bodrless standard hotel format
 *
 * Base URL:  https://api.test.hotelbeds.com (sandbox)
 *            https://api.hotelbeds.com (production)
 * Auth:      Api-key header + X-Signature (SHA256 of apiKey + secret + timestamp)
 * Docs:      https://developer.hotelbeds.com
 *
 * CERTIFICATION STATUS: compliant with HotelBeds certification checklist
 *
 * CONTENT ENRICHMENT: address/phone/email are not always reliably
 * populated on the live Availability/Booking API's hotel object (this
 * was confirmed missing on the booking response specifically — see
 * book() below). hotelbedsContent.js maintains a locally-synced cache
 * of this data from HotelBeds' Content API (batch job, see that
 * file), so both search() and book() fall back to it when the live
 * response is missing these fields — fast local Supabase reads, no
 * added latency on the live request path.
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const crypto = require('crypto');
const { logger } = require('../utils/logger');
const hotelbedsContent = require('../services/hotelbedsContent');

class HotelBedsAdapter {

  constructor() {
    this.apiKey  = process.env.HOTELBEDS_API_KEY  || '9ec6d226c814617a769830d6debfa22a';
    this.secret  = process.env.HOTELBEDS_SECRET   || 'VuyrB8sJ0N';
    this.sandbox = process.env.HOTELBEDS_SANDBOX  !== 'false'; // default: sandbox ON
    this.baseUrl = this.sandbox
      ? 'https://api.test.hotelbeds.com'
      : 'https://api.hotelbeds.com';
    this.supplier = 'hotelbeds';
  }

  // ─────────────────────────────────────────────
  // BUILD OCCUPANCY
  // Produces a HotelBeds occupancy node from a real adult/child split.
  // Per HotelBeds rules, the `children` count MUST equal the number of
  // CH entries in `paxes`, and every child needs an `age` — otherwise
  // E_REQUEST_CHILDRENDONTMATCH / E_REQUEST_AGESDONTMATCH (400). To make
  // that impossible to violate, the child count is derived from the
  // number of valid ages we actually have, not a separate counter.
  // ─────────────────────────────────────────────
  _buildOccupancy({ rooms = 1, adults = 1, children = 0, childAges = [] }) {
    const ages = (Array.isArray(childAges) ? childAges : [])
      .map(a => parseInt(a, 10))
      .filter(a => Number.isFinite(a) && a >= 0 && a < 18);

    const childCount = Math.min(Math.max(0, children || 0), ages.length);
    const occ = {
      rooms,
      adults: Math.max(1, adults || 1),
      children: childCount,
    };
    if (childCount > 0) {
      occ.paxes = ages.slice(0, childCount).map(age => ({ type: 'CH', age }));
    }
    return occ;
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS
  // ─────────────────────────────────────────────
  async search({
    destination,
    checkIn,
    checkOut,
    passengers = 1,
    adults = null,
    children = 0,
    childAges = [],
    nights = 1,
    budget = 'mid',
    rooms = 1,
    roomType = null,   // 'single'|'double'|'twin'|'triple'|'family'|'suite'|null
    hotelCode = null,
  }) {
    try {
      logger.info('HotelBeds: searching hotels', { destination, checkIn, checkOut, passengers, children, rooms, roomType, hotelCode });

      const checkInDate  = this._formatDate(checkIn);
      const checkOutDate = checkOut
        ? this._formatDate(checkOut)
        : this._addDays(checkInDate, nights);

      // For single-room-type requests (e.g. "two single rooms"),
      // divide adults across rooms so each room gets 1 adult, not
      // all adults crammed into one room configuration.
      const adultsPerRoom = roomType === 'single'
        ? 1
        : adults != null ? adults : passengers;

      const occupancy = this._buildOccupancy({
        rooms,
        adults: adultsPerRoom,
        children,
        childAges,
      });

      const payload = {
        stay: {
          checkIn:  checkInDate,
          checkOut: checkOutDate,
        },
        occupancies: [occupancy],
      };

      if (hotelCode) {
        payload.hotels = { hotel: [Number(hotelCode) || hotelCode] };
      } else {
        const destCode = await this._resolveDestination(destination);
        if (!destCode) {
          logger.warn('HotelBeds: could not resolve destination code', { destination });
          return [];
        }
        payload.destination = { code: destCode };
      }

      payload.filter = {
        maxHotels:   hotelCode ? 1 : 10,
        minRate:     this._budgetMinRate(budget),
        maxRate:     this._budgetMaxRate(budget),
        paymentType: 'AT_WEB',
        // CERTIFICATION 3.5: exclude opaque/packaged rates from
        // standalone hotel search — they must only appear when
        // bundled with flights/transfers per HotelBeds rules.
        packaging: false,
      };

      console.log('HOTELBEDS REQUEST:', JSON.stringify({ destination, hotelCode, checkInDate, checkOutDate, occupancy, budget }, null, 2));

      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/hotels`,
        payload,
        { headers: this._headers(), timeout: 30000 }
      );

      console.log('HOTELBEDS RAW RESPONSE:', JSON.stringify(response.data?.hotels?.hotels?.slice(0, 2), null, 2));

      const hotels = response.data?.hotels?.hotels || [];
      logger.info('HotelBeds: results', { count: hotels.length });

      // CONTENT ENRICHMENT: batch-fetch cached address/phone/email
      // for every hotel in this page of results in ONE Supabase
      // query, rather than one lookup per hotel. Never blocks or
      // fails the search — a lookup miss/error just means those
      // hotels fall back to whatever the live response already had
      // (possibly nothing, same as before this change).
      const contentByCode = await this._enrichWithContent(hotels);

      return this._normalizeHotels(hotels, nights, contentByCode);

    } catch (err) {
      console.log('HOTELBEDS ERROR DETAIL:', JSON.stringify({
        message: err.message,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));
      logger.error('HotelBeds search failed', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // ENRICH WITH CONTENT (batch)
  // Wrapped defensively — hotelbedsContent.getHotelContentBatch
  // already catches its own Supabase errors and returns {}, but this
  // extra layer guarantees a search can NEVER fail because of a
  // content-lookup problem, even a future change to that method.
  // ─────────────────────────────────────────────
  async _enrichWithContent(hotels) {
    try {
      const codes = hotels.map(h => h.code).filter(Boolean);
      if (codes.length === 0) return {};
      return await hotelbedsContent.getHotelContentBatch(codes);
    } catch (err) {
      logger.warn('HotelBeds: content enrichment lookup failed — continuing without it', { error: err.message });
      return {};
    }
  }

  // ─────────────────────────────────────────────
  // REFETCH RATE
  // Re-prices one hotel at a corrected occupancy (used when child DOB
  // differs from searched age). Returns cheapest refundable rate or null.
  // ─────────────────────────────────────────────
  async refetchRate({ hotelCode, checkIn, checkOut, nights = 1, adults = 1, children = 0, childAges = [], rooms = 1 }) {
    if (!hotelCode) return null;
    const results = await this.search({
      hotelCode, checkIn, checkOut, nights, adults, children, childAges, rooms,
      budget: 'mid',
    });
    if (!results || results.length === 0) return null;
    const hotel = results[0];
    return {
      rateKey:       hotel.rateKey,
      rateType:      hotel.rateType,
      pricePerNight: hotel.pricePerNight,
      totalRate:     hotel.totalRate,
      currency:      hotel.currency,
    };
  }

  // ─────────────────────────────────────────────
  // CHECK RATE
  // CERTIFICATION 2.5: Only call this when rateType === 'RECHECK'.
  // Never call for BOOKABLE rates — that's a certification violation.
  // The booking flow reads hotel.rateType and only calls this when needed.
  // ─────────────────────────────────────────────
  async checkRate(rateKey) {
    try {
      logger.info('HotelBeds: checking rate', { rateKey: rateKey?.slice(0, 30) + '...' });

      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/checkrates`,
        { rooms: [{ rateKey }] },
        { headers: this._headers(), timeout: 20000 }
      );

      const hotel = response.data?.hotel;
      if (!hotel) return null;

      const room = hotel.rooms?.[0];
      const rate = room?.rates?.[0];

      return {
        rateKey:              rate?.rateKey || rateKey,
        rateType:             rate?.rateType || 'BOOKABLE',
        net:                  Number(rate?.net || 0),
        currency:             response.data?.currency || 'EUR',
        rateClass:            rate?.rateClass,
        cancellationPolicies: rate?.cancellationPolicies || [],
        // CERTIFICATION 3.9: rateComments available directly from
        // checkRate response (no separate ContentAPI call needed for
        // RECHECK rates — this is the more reliable path).
        rateComments:         rate?.rateComments || null,
        rateCommentsId:       rate?.rateCommentsId || null,
        promotions:           (rate?.promotions || []).map(p => ({
          code: p.code, name: p.name, remark: p.remark || p.name,
        })),
      };

    } catch (err) {
      console.log('HOTELBEDS CHECKRATE ERROR:', JSON.stringify({
        message: err.message,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));
      logger.error('HotelBeds checkRate failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOK
  // CERTIFICATION 3.11: timeout minimum 60s (was 30s — certification
  // violation). HotelBeds booking confirmation can take up to 60s in
  // real conditions; a 30s timeout causes false failures on slow hotels.
  // ─────────────────────────────────────────────
  async book({ rateKey, holder, guests, clientReference, remark }) {
    try {
      logger.info('HotelBeds: creating booking', { guestCount: guests?.length });

      const paxes = (guests || []).map(g => ({
        roomId:  g.roomId || 1,
        type:    g.type === 'child' ? 'CH' : 'AD',
        name:    g.firstName,
        surname: g.lastName,
        ...(g.type === 'child' && g.age ? { age: g.age } : {}),
      }));

      const payload = {
        holder: {
          name:    holder.firstName,
          surname: holder.lastName,
        },
        rooms: [{ rateKey, paxes }],
        clientReference: clientReference || `BDR-${Date.now()}`,
        remark: remark || '',
        tolerance: 2.0,
      };

      console.log('HOTELBEDS BOOK REQUEST:', JSON.stringify(payload, null, 2));

      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/bookings`,
        payload,
        { headers: this._headers(), timeout: 65000 } // CERTIFICATION 3.11: ≥60s
      );

      console.log('HOTELBEDS BOOK RESPONSE:', JSON.stringify(response.data, null, 2));

      const booking = response.data?.booking;
      if (!booking) throw new Error('HotelBeds booking response missing booking object');

      // CONTENT ENRICHMENT: the live booking response's hotel.address/
      // hotel.phones are frequently absent in practice (this is the
      // gap the Content API integration exists to close — see file
      // header). Fall back to the synced content cache by hotel code
      // whenever the live response is missing either field. Never
      // blocks or fails the booking — a lookup miss just leaves these
      // fields null, exactly as before this change.
      let hotelAddress = booking.hotel?.address?.content || null;
      let hotelPhone    = booking.hotel?.phones?.[0]?.phoneNumber || null;
      let hotelEmail    = booking.hotel?.email || null;

      if ((!hotelAddress || !hotelPhone || !hotelEmail) && booking.hotel?.code) {
        try {
          const content = await hotelbedsContent.getHotelContent(booking.hotel.code);
          if (content) {
            hotelAddress = hotelAddress || content.address || null;
            hotelPhone    = hotelPhone    || content.phone    || null;
            hotelEmail    = hotelEmail    || content.email    || null;
          }
        } catch (err) {
          logger.warn('HotelBeds: book() content enrichment failed — continuing without it', { error: err.message });
        }
      }

      // BUG FIX (found via HotelBeds cert dry-run testing, 2026-07-02):
      // the confirmed booking response carries the REAL rateComments
      // text (Cert 3.9/4.4 — e.g. "Car park YES..., Check-in hour
      // 13:00..., Minimum check-in age 18.") right on
      // booking.hotel.rooms[0].rates[0].rateComments, but this was
      // never captured here at all — meaning it silently never
      // reached any voucher for a BOOKABLE-rate booking (RECHECK
      // rates got it via checkRate() instead, so this only affected
      // the BOOKABLE path). This is a MANDATORY voucher field per
      // certification, not optional — capture it now.
      const rateComments = booking.hotel?.rooms?.[0]?.rates?.[0]?.rateComments || null;

      return {
        supplier:                 this.supplier,
        supplierBookingReference: booking.reference,
        status:                   booking.status,
        hotelName:                booking.hotel?.name,
        hotelAddress,
        hotelPhone,
        hotelEmail,
        checkIn:                  booking.hotel?.checkIn,
        checkOut:                 booking.hotel?.checkOut,
        roomType:                 booking.hotel?.rooms?.[0]?.name || null,
        boardType:                booking.hotel?.rooms?.[0]?.rates?.[0]?.boardName || null,
        rateComments,
        cancellationPolicies:     booking.hotel?.rooms?.[0]?.rates?.[0]?.cancellationPolicies || [],
        totalAmount:              Number(booking.totalNet || 0),
        currency:                 booking.currency || 'EUR',
        holder:                   booking.holder,
        rooms:                    booking.hotel?.rooms || [],
        // CERTIFICATION 4.5: supplier info for voucher payment attribution
        supplier_tag:             booking.supplier || null,
        confirmedAt:              new Date().toISOString(),
      };

    } catch (err) {
      console.log('HOTELBEDS BOOK ERROR:', JSON.stringify({
        message: err.message,
        status:  err.response?.status,
        data:    err.response?.data,
      }, null, 2));
      logger.error('HotelBeds book failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL BOOKING
  // ─────────────────────────────────────────────
  async cancel(bookingReference) {
    try {
      const response = await axios.delete(
        `${this.baseUrl}/hotel-api/1.0/bookings/${bookingReference}`,
        { headers: this._headers(), timeout: 20000 }
      );
      return response.data;
    } catch (err) {
      logger.error('HotelBeds cancel failed', { error: err.message });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // RESOLVE DESTINATION CODE
  // ─────────────────────────────────────────────
  async _resolveDestination(cityName) {
    if (!cityName) return null;

    const map = {
      // ── Kenya ────────────────────────────────────────────────
      'mombasa': 'MBA', 'diani': 'MBA', 'ukunda': 'MBA', 'diani beach': 'MBA',
      'nairobi': 'NAI', 'malindi': 'MYD', 'watamu': 'MYD',
      'kilifi': 'MYD', 'lamu': 'UAM', 'masai mara': 'MAS', 'maasai mara': 'MAS',
      'nakuru': 'LEK', 'naivasha': 'LAV', 'amboseli': 'ASV',
      'tsavo': 'TNP', 'taita hills': 'TAI', 'kisumu': 'KSI',
      'eldoret': 'UAS', 'kitale': 'UAS', 'samburu': 'UAS',
      'mt kenya': 'MKN', 'nanyuki': 'MKN',
      // ── Tanzania ─────────────────────────────────────────────
      'zanzibar': 'ZNZ', 'stone town': 'ZNZ',
      'dar es salaam': 'DAR',
      'arusha': 'ARU', 'kilimanjaro': 'JRO', 'moshi': 'JRO',
      'serengeti': 'ARU', 'ngorongoro': 'ARU',
      // ── East Africa ──────────────────────────────────────────
      'kigali': 'KGL', 'rwanda': 'KGL',
      'kampala': 'KMP', 'entebbe': 'KMP', 'uganda': 'KMP',
      'addis ababa': 'ADD', 'ethiopia': 'ADD',
      'juba': 'JUB', 'bujumbura': 'BJM',
      'mogadishu': 'MGQ', 'djibouti': 'JIB',
      // ── Southern Africa ──────────────────────────────────────
      'johannesburg': 'JNB', 'cape town': 'CPT',
      'durban': 'DUR', 'pretoria': 'PRY',
      'victoria falls': 'VFA', 'livingstone': 'LVI',
      'lusaka': 'LUN', 'harare': 'HRE',
      'maputo': 'MPM', 'windhoek': 'WDH',
      // ── Indian Ocean Islands ─────────────────────────────────
      // CRITICAL FIX: city/island names alongside country names —
      // the promptParser resolves country→city, so HotelBeds must
      // recognise the resolved CITY name, not just the country name.
      'seychelles': 'SEZ',
      'mahe': 'SEZ',          // Seychelles main island (promptParser: seychelles → mahe)
      'victoria seychelles': 'SEZ',
      'praslin': 'SEZ',       // Second Seychelles island — same destination code
      'mauritius': 'MRU',
      'port louis': 'MRU',    // Mauritius capital (promptParser: mauritius → port louis)
      'grand baie': 'MRU',    // Common Mauritius resort area
      'flic en flac': 'MRU',
      'maldives': 'MLE',
      'male': 'MLE',          // Maldives capital (promptParser: maldives → male)
      'hulhumale': 'MLE',
      'madagascar': 'TNR',
      'antananarivo': 'TNR',  // Madagascar capital
      // ── Middle East ──────────────────────────────────────────
      'dubai': 'DXB', 'abu dhabi': 'AUH',
      'doha': 'DOH', 'muscat': 'MCT',
      'riyadh': 'RUH', 'jeddah': 'JED',
      'kuwait': 'KWI', 'kuwait city': 'KWI',
      'beirut': 'BEY', 'amman': 'AMM',
      // ── North Africa ─────────────────────────────────────────
      'cairo': 'CAI', 'egypt': 'CAI',
      'marrakech': 'RAK', 'casablanca': 'CMN', 'morocco': 'CMN',
      'sharm el sheikh': 'SSH', 'hurghada': 'HRG',
      'tunis': 'TUN', 'algiers': 'ALG',
      // ── Europe ───────────────────────────────────────────────
      'london': 'LON', 'paris': 'PAR', 'amsterdam': 'AMS',
      'rome': 'ROM', 'milan': 'MIL', 'venice': 'VCE',
      'barcelona': 'BCN', 'madrid': 'MAD',
      'athens': 'ATH', 'santorini': 'JTR', 'mykonos': 'JMK',
      'istanbul': 'IST', 'frankfurt': 'FRA',
      'zurich': 'ZRH', 'vienna': 'VIE', 'brussels': 'BRU',
      'lisbon': 'LIS', 'porto': 'OPO',
      'prague': 'PRG', 'budapest': 'BUD', 'warsaw': 'WAW',
      // ── Asia ─────────────────────────────────────────────────
      'bali': 'DPS', 'denpasar': 'DPS',
      'bangkok': 'BKK', 'phuket': 'HKT', 'chiang mai': 'CNX',
      'singapore': 'SIN',
      'kuala lumpur': 'KUL',
      'tokyo': 'TYO', 'osaka': 'OSA',
      'delhi': 'DEL', 'mumbai': 'BOM', 'goa': 'GOI',
      'beijing': 'BJS', 'shanghai': 'SHA', 'hong kong': 'HKG',
      'seoul': 'SEL',
      // ── Americas ─────────────────────────────────────────────
      'new york': 'NYC', 'los angeles': 'LAX', 'miami': 'MIA',
      'cancun': 'CUN', 'punta cana': 'PUJ',
      'toronto': 'YTO', 'vancouver': 'YVR',
      'sao paulo': 'SAO', 'rio de janeiro': 'RIO',
      // ── Australasia ──────────────────────────────────────────
      'sydney': 'SYD', 'melbourne': 'MEL',
      'auckland': 'AKL',
    };

    const key = cityName.toLowerCase().trim();
    if (map[key]) return map[key];

    const keyNoSpace = key.replace(/\s+/g, '');
    for (const [k, v] of Object.entries(map)) {
      if (k.replace(/\s+/g, '') === keyNoSpace) return v;
    }

    const fuzzyMatch = this._fuzzyMatch(key, Object.keys(map));
    if (fuzzyMatch) {
      logger.info('HotelBeds: fuzzy-matched destination name', { input: cityName, matched: fuzzyMatch });
      return map[fuzzyMatch];
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/hotel-content-api/1.0/locations/destinations`,
        {
          headers: this._headers(),
          params: { fields: 'all', language: 'ENG', from: 1, to: 5 },
          timeout: 10000,
        }
      );
      const destinations = response.data?.destinations || [];
      const match = destinations.find(d =>
        (d.name?.content || '').toLowerCase().includes(key)
      );
      return match?.code || null;
    } catch {
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE HOTELS
  // CERTIFICATION ADDITIONS:
  //   rateType     — 'BOOKABLE' or 'RECHECK', determines checkRate() call
  //   isPackaging  — opaque/packaged rates (filter these out of standalone search)
  //   promotions   — "Non-refundable — no amendments" etc., must show to traveler
  //   rateCommentsId — ID for rate remarks text, fetch from ContentAPI at checkout
  //
  // contentByCode — from hotelbedsContent's synced cache (see search()
  // above), keyed by hotel code. Used ONLY to fill in address/phone/
  // email/coordinates when the live response's own fields are empty —
  // never overrides a real value the live response already has.
  // ─────────────────────────────────────────────
  _normalizeHotels(hotels, nights, contentByCode = {}) {
    return hotels.map(hotel => {
      const cheapestRoom  = this._cheapestRoom(hotel.rooms || []);
      const bestRate      = this._bestRate(cheapestRoom?.rates);
      const totalRate     = Number(bestRate?.net || hotel.minRate || 0);
      const pricePerNight = nights > 0 ? Math.round(totalRate / nights) : totalRate;

      const content = contentByCode[hotel.code] || null;

      // CERTIFICATION 2.5: rateType tells the booking flow whether to
      // call checkRate() — RECHECK = must call, BOOKABLE = skip it.
      // Previously this field was never read, meaning RECHECK rates
      // could be sent straight to booking and fail.
      const rateType = bestRate?.rateType || 'BOOKABLE';

      // CERTIFICATION 3.5: packaging=true = opaque rate, must only be
      // used when bundled with flights/transfers. Filter handled below.
      const isPackaging = bestRate?.packaging === true;

      // CERTIFICATION 2.7: promotions like "Non-refundable rate. No
      // amendments permitted" must be surfaced to the traveler before
      // they confirm. Stored on the hotel object so the booking flow
      // can pass them through to the traveler-facing message.
      const promotions = (bestRate?.promotions || []).map(p => ({
        code:   p.code,
        name:   p.name,
        remark: p.remark || p.name,
      }));

      // CERTIFICATION 3.9: rateCommentsId links to human-readable
      // remarks ("Hotel insurance payable at property", etc.) via
      // ContentAPI /ratecomments. Fetched on-demand at checkout —
      // too slow to inline per search result.
      const rateCommentsId = bestRate?.rateCommentsId || null;

      return {
        supplier:             this.supplier,
        hotelCode:            hotel.code,
        name:                 hotel.name,
        stars:                Number(hotel.categoryCode?.replace(/[^0-9]/g, '') || hotel.categoryName?.charAt(0) || 3),
        rating:               Number(hotel.reviews?.[0]?.rate || 4.0),
        category:             hotel.categoryName || '',
        location:             hotel.zoneName     || hotel.destinationName || '',
        city:                 hotel.destinationName || '',
        address:              hotel.address?.content || content?.address || '',
        // NEW — phone/email weren't part of the normalized hotel shape
        // at all before; the live availability response never carried
        // them, only the Content API cache does.
        phone:                content?.phone || null,
        email:                content?.email || null,
        latitude:             hotel.latitude  || hotel.coordinates?.latitude  || content?.latitude  || null,
        longitude:            hotel.longitude || hotel.coordinates?.longitude || content?.longitude || null,
        pricePerNight,
        totalRate,
        currency:             bestRate?.currency || hotel.currency || 'EUR',
        mealPlan:             this._boardName(bestRate?.boardCode),
        mealPlanCode:         bestRate?.boardCode || null,
        roomType:             cheapestRoom?.name || null,
        rateKey:              bestRate?.rateKey  || null,
        rateType,
        isRefundable:         bestRate?.rateClass !== 'NRF',
        isPackaging,
        promotions,
        rateCommentsId,
        cancellationPolicies: bestRate?.cancellationPolicies || [],
        // BUG FIX (found via a real "why does it just say 'confirmed
        // at booking' instead of the real policy" question,
        // 2026-07-02): cancellationPolicies (the real amount/date
        // data) was already captured above, but nothing ever turned
        // it into readable text at SEARCH time — only the voucher
        // (post-booking) formatted it. Package options shown before
        // booking always fell through to a generic "confirmed at
        // booking" placeholder despite the real policy already being
        // known. Built here now from the same real data.
        policySummary:        this._buildHotelPolicySummary(bestRate?.cancellationPolicies, bestRate?.rateClass),
        // BUG FIX (found via a real "images still not showing"
        // report, 2026-07-02): two separate bugs here. (1) HotelBeds'
        // Availability response doesn't actually carry image data in
        // this account (confirmed empty across every real response
        // seen this session) — hotelbedsContent.js's Content API sync
        // already has real images with correctly-built full CDN URLs,
        // but this was never wired to use them. (2) even if the raw
        // response DID have hotel.images, `.map(img => img.path)`
        // only produces a bare relative path (e.g. "12345_h.jpg"), not
        // a usable URL — hotelbedsContent.js's own imageBaseUrl
        // handling was the correct pattern, just never applied here.
        // Content API data (content?.images, already full URLs) is
        // now preferred; the raw response is only used as a fallback,
        // with the same CDN base URL hotelbedsContent.js defaults to.
        images:               this._resolveHotelImages(hotel.images, content?.images),
        reviews:              hotel.reviews || [],
        amenities:            (hotel.facilities || []).map(f => f.facilityName).filter(Boolean).slice(0, 10),
      };
    })
    // CERTIFICATION 3.5: packaging=true rates removed from standalone
    // results. We already set packaging:false in the filter payload,
    // but filter here defensively in case any slip through.
    .filter(h => !h.isPackaging);
  }

  _cheapestRoom(rooms) {
    if (!rooms.length) return null;
    return rooms.reduce((cheapest, room) => {
      const roomRate  = Number(this._bestRate(room.rates)?.net || Infinity);
      const cheapRate = Number(this._bestRate(cheapest.rates)?.net || Infinity);
      return roomRate < cheapRate ? room : cheapest;
    });
  }

  _bestRate(rates) {
    if (!rates || !rates.length) return null;
    const refundable = rates.filter(r => r.rateClass !== 'NRF');
    const pool = refundable.length > 0 ? refundable : rates;
    return pool.reduce((cheapest, r) =>
      Number(r.net) < Number(cheapest.net) ? r : cheapest
    );
  }

  _boardName(code) {
    const map = { RO: 'Room Only', BB: 'Bed & Breakfast', HB: 'Half Board', FB: 'Full Board', AI: 'All Inclusive' };
    return map[code] || code || null;
  }

  // ─────────────────────────────────────────────
  // BUILD HOTEL POLICY SUMMARY (search-time, real data)
  // Turns the real cancellationPolicies array (already captured from
  // HotelBeds' own response) into a specific, readable line at
  // SEARCH time — the same real data the voucher already formats
  // post-booking, just surfaced earlier so the traveler can see it
  // before committing, not just after.
  //
  // rateClass 'NRF' = non-refundable rate, no cancellation window at
  // all — straightforward. Otherwise, cancellationPolicies[0] is the
  // EARLIEST tier (the "from" date closest to now) — the one that
  // matters most for "when does this stop being free to cancel".
  // ─────────────────────────────────────────────
  _buildHotelPolicySummary(cancellationPolicies, rateClass) {
    if (rateClass === 'NRF') {
      return 'Non-refundable — full amount charged if cancelled';
    }

    const policies = Array.isArray(cancellationPolicies) ? cancellationPolicies : [];
    if (policies.length === 0) {
      return 'Refundable — free cancellation';
    }

    const first = policies[0];
    const amount = Number(first.amount || 0);
    const dateStr = first.from
      ? new Date(first.from).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
      : null;

    if (dateStr && amount > 0) {
      return `Free cancellation until ${dateStr} — after that, a fee of ${first.currencyId || 'EUR'} ${amount.toLocaleString()} applies`;
    }
    if (amount > 0) {
      return `Cancellation fee of ${first.currencyId || 'EUR'} ${amount.toLocaleString()} may apply`;
    }
    return 'Refundable — free cancellation';
  }

  // ─────────────────────────────────────────────
  // RESOLVE HOTEL IMAGES
  // Content API sync data (contentImages) is preferred — it already
  // has full, correct CDN URLs built by hotelbedsContent.js's own
  // imageBaseUrl handling. The raw Availability response's own
  // `images` field is only used as a last-resort fallback (and is
  // confirmed usually absent entirely in this account's real
  // responses) — its entries only ever carry a relative `path`, so a
  // full URL is built here using the same default CDN base URL
  // hotelbedsContent.js defaults to, rather than returning an
  // unusable bare filename.
  // ─────────────────────────────────────────────
  _resolveHotelImages(rawImages, contentImages) {
    if (Array.isArray(contentImages) && contentImages.length > 0) {
      return contentImages.slice(0, 3).map(img => img.url).filter(Boolean);
    }
    if (Array.isArray(rawImages) && rawImages.length > 0) {
      const base = process.env.HOTELBEDS_IMAGE_BASE_URL || 'https://photos.hotelbeds.com/giata/bigger/';
      return rawImages.slice(0, 3).map(img => img.path ? `${base}${img.path}` : null).filter(Boolean);
    }
    return [];
  }

  _budgetMinRate(budget) {
    const map = { low: 0, mid: 0, high: 0, luxury: 0 };
    return map[budget] || 0;
  }

  _budgetMaxRate(budget) {
    const map = { low: 99999, mid: 99999, high: 99999, luxury: 99999 };
    return map[budget] || 99999;
  }

  _headers() {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash('sha256')
      .update(this.apiKey + this.secret + timestamp)
      .digest('hex');

    return {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Accept-Encoding': 'gzip', // CERTIFICATION 1: GZIP compression
      'Api-key':      this.apiKey,
      'X-Signature':  signature,
    };
  }

  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }

  _fuzzyMatch(input, candidates) {
    const inputLen = (input || '').length;
    if (inputLen < 3) return null;
    let best = null, bestDistance = Infinity;
    for (const candidate of candidates) {
      if (Math.abs(candidate.length - inputLen) > 2) continue;
      const distance = this._levenshtein(input, candidate);
      const maxAllowed = candidate.length <= 5 ? 1 : candidate.length <= 9 ? 2 : 3;
      const similarity = 1 - distance / Math.max(inputLen, candidate.length);
      if (distance <= maxAllowed && similarity >= 0.75 && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  _formatDate(date) {
    if (!date) return new Date().toISOString().split('T')[0];
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    return new Date(date).toISOString().split('T')[0];
  }

  _addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  }
}

module.exports = new HotelBedsAdapter();