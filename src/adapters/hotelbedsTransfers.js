/**
 * HOTELBEDS TRANSFERS ADAPTER
 * ─────────────────────────────────────────────
 * Wraps HBX Group's Transfer API (operated via HolidayTaxis, part of
 * HBX Group — same group as the HotelBeds hotel Booking/Content APIs
 * Bodrless already integrates with). Same account, same auth scheme
 * — this is NOT a separate supplier relationship to negotiate.
 *
 * WHY THIS MATTERS: it directly solves two separate problems raised
 * this session:
 *   1. "Westlands to JKIA — it needs to calculate the ride price" —
 *      solved via GPS-type pickup/dropoff codes, which return a REAL
 *      priced quote for that exact pair, not a flat city-level rate.
 *   2. "Travelers going to South Africa etc — how will transfers work
 *      worldwide?" — solved automatically: this is the same global
 *      HolidayTaxis network already covering HotelBeds' worldwide
 *      hotel inventory, no per-country integration needed.
 *
 * SCOPE OF THIS FILE: availability search AND booking confirmation,
 * both now implemented against confirmed endpoint specs (2026-07-02).
 * NOT yet implemented: modification of an existing booking (the docs
 * mention it's possible but didn't detail the request shape) — only
 * cancel() and getBookingDetail() are built, matching what was
 * actually documented.
 *
 * Base URL: https://api.test.hotelbeds.com (sandbox)
 *           https://api.hotelbeds.com (production)
 * Auth:     Api-key header + X-Signature (SHA256 of apiKey + secret +
 *           timestamp) — identical scheme to hotelbeds.js and
 *           hotelbedsContent.js. ASSUMPTION: same HOTELBEDS_API_KEY/
 *           HOTELBEDS_SECRET credentials work here too, since HBX
 *           Group's product APIs share one signature scheme across
 *           Content/Booking/Transfer — confirm with a real test call
 *           before relying on this in production.
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

class HotelbedsTransfersAdapter {

  constructor() {
    // Dedicated Transfers API credentials — confirmed as a separate
    // key+secret pair from the hotel Booking/Content API credentials
    // (same HBX Group account, but issued separately for this
    // product). Do NOT fall back to HOTELBEDS_API_KEY/HOTELBEDS_SECRET
    // — that assumption was never verified and this session confirmed
    // it's a distinct credential pair.
    this.apiKey  = process.env.HOTELBEDS_TRANSFERS_API_KEY;
    this.secret  = process.env.HOTELBEDS_TRANSFERS_SECRET;
    this.sandbox = process.env.HOTELBEDS_SANDBOX  !== 'false';
    this.baseUrl = this.sandbox
      ? 'https://api.test.hotelbeds.com'
      : 'https://api.hotelbeds.com';
    this.supplier = 'hotelbeds_transfers';
    this.timeout  = Number(process.env.HOTELBEDS_TRANSFERS_TIMEOUT_MS) || 20000;

    if (!this.apiKey || !this.secret) {
      logger.warn('HotelbedsTransfersAdapter: HOTELBEDS_TRANSFERS_API_KEY/HOTELBEDS_TRANSFERS_SECRET not set — every call will fail until these are configured');
    }
  }

  _headers() {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHash('sha256')
      .update(this.apiKey + this.secret + timestamp)
      .digest('hex');

    return {
      'Content-Type':    'application/json',
      'Accept':          'application/json',
      'Accept-Encoding': 'gzip',
      'Api-key':         this.apiKey,
      'X-Signature':     signature,
    };
  }

  // ─────────────────────────────────────────────
  // SEARCH AVAILABILITY
  // Path-segment URL (not query string) — per the documented shape:
  //   /availability/{language}/from/{fromType}/{fromCode}
  //                 /to/{toType}/{toCode}/{outbound}[/{inbound}]
  //                 /{adults}/{children}/{infants}
  // The {inbound} segment is OMITTED entirely for one-way (confirmed
  // by the doc's own one-way vs round-trip example URLs — one-way has
  // ONE datetime segment before the pax counts, round-trip has two).
  //
  // fromType/toType: 'IATA' (airport), 'GPS' (lat,lng — min 3 decimal
  // places), 'ATLAS' (HotelBeds' own hotel codes — same codes as
  // hotel.hotelCode from hotelbeds.js hotel search results), 'PORT',
  // 'STATION'.
  //
  // GPS code format is INFERRED as "lat,lng" from the type's
  // description in the docs (no explicit GPS example was shown) —
  // verify this against a real test call before relying on it.
  // ─────────────────────────────────────────────
  async search({
    fromType, fromCode,
    toType,   toCode,
    outbound, inbound = null,
    adults = 1, children = 0, infants = 0,
    language = 'en',
  }) {
    if (!fromType || !fromCode || !toType || !toCode || !outbound) {
      logger.warn('HotelBeds Transfers: missing required search params', { fromType, fromCode, toType, toCode, outbound });
      return [];
    }

    try {
      const segments = [
        'transfer-api', '1.0', 'availability', language,
        'from', fromType, encodeURIComponent(String(fromCode)),
        'to',   toType,   encodeURIComponent(String(toCode)),
        outbound,
      ];
      if (inbound) segments.push(inbound);
      segments.push(adults, children, infants);

      const url = `${this.baseUrl}/${segments.join('/')}`;

      logger.info('HotelBeds Transfers: searching', { fromType, fromCode, toType, toCode, outbound, inbound });

      const response = await axios.get(url, {
        headers: this._headers(),
        timeout: this.timeout,
      });

      const services = response.data?.services || [];
      logger.info('HotelBeds Transfers: results', { count: services.length });

      return this._normalizeServices(services);

    } catch (err) {
      logger.error('HotelBeds Transfers search failed', {
        error: err.message,
        status: err.response?.status,
        data: err.response?.data,
      });
      // Same contract as every other adapter in this codebase: a
      // supplier failure returns empty, never throws — callers
      // (engine.js's _buildTransferLegs) fall back to the static
      // transfers table rather than breaking the whole package.
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // BOOK / CONFIRM
  // Confirmed against the real /bookings endpoint spec (2026-07-02).
  //
  // GPS-TYPE ADDRESS REQUIREMENT: per the docs, `pickupInformation`/
  // `dropoffInformation` (name/address/town/country/zip) are
  // MANDATORY when overriding a GPS-type service's location — even
  // though GPS search only needed lat/lng. Bodrless's primary use
  // case (airport -> hotel via GPS) means we must supply the HOTEL's
  // address fields here at booking time, not just its coordinates.
  // Pass `dropoffAddress` (built from the HotelBeds hotel record's
  // own address/city/country fields) when the original search used
  // GPS for the "to" side; omit entirely for IATA/ATLAS/PORT/STATION
  // legs, where the location is already unambiguous.
  //
  // MULTIPLE RATEKEYS: pass an array of { rateKey, transferDetail }
  // in `transfers` to confirm several services under one booking
  // reference (e.g. arrival + departure as a round trip) — mirrors
  // the docs' "Confirming multiple ratekeys" example exactly.
  // ─────────────────────────────────────────────
  async book({
    holder,               // { firstName, lastName, email, phone } — phone MUST be E.164 (e.g. "+254712345678")
    transfers,             // array of { rateKey, direction, flightNumber, dropoffAddress?, pickupAddress? }
    clientReference = null,
    welcomeMessage = null,
    remark = null,
    language = 'en',
  }) {
    if (!holder?.firstName || !holder?.lastName || !holder?.email || !holder?.phone) {
      throw new Error('HotelbedsTransfersAdapter.book(): holder.firstName/lastName/email/phone are all required');
    }
    if (!Array.isArray(transfers) || transfers.length === 0) {
      throw new Error('HotelbedsTransfersAdapter.book(): at least one transfer (rateKey) is required');
    }

    try {
      const payload = {
        language,
        holder: {
          name:    holder.firstName,
          surname: holder.lastName,
          email:   holder.email,
          phone:   holder.phone,
        },
        transfers: transfers.map(t => {
          const entry = {
            rateKey: t.rateKey,
            transferDetails: [{
              type:        t.rideType || 'FLIGHT',
              direction:   t.direction || 'ARRIVAL',
              code:        t.flightNumber || t.rideCode || '',
              ...(t.companyName ? { companyName: t.companyName } : {}),
            }],
          };
          // GPS-type override — required for GPS pickup/dropoff, per
          // the docs' mandatory-field note. See file header comment.
          if (t.pickupAddress) entry.pickupInformation = t.pickupAddress;
          if (t.dropoffAddress) entry.dropoffInformation = t.dropoffAddress;
          if (t.extras) entry.extras = t.extras;
          return entry;
        }),
        ...(clientReference ? { clientReference } : {}),
        ...(welcomeMessage ? { welcomeMessage } : {}),
        ...(remark ? { remark } : {}),
      };

      logger.info('HotelBeds Transfers: creating booking', { transferCount: transfers.length, clientReference });

      const response = await axios.post(
        `${this.baseUrl}/transfer-api/1.0/bookings`,
        payload,
        { headers: this._headers(), timeout: this.timeout }
      );

      return this._normalizeBooking(response.data?.bookings?.[0]);

    } catch (err) {
      logger.error('HotelBeds Transfers book failed', {
        error: err.message,
        status: err.response?.status,
        data: err.response?.data,
      });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BUILD DROPOFF/PICKUP ADDRESS FOR A GPS-TYPE LOCATION
  // Small helper — turns a HotelBeds hotel record (already carrying
  // name/address/city from hotelbeds.js's _normalizeHotels) into the
  // shape book() requires when the original availability search used
  // a GPS code. Field length limits from the docs are enforced here
  // (name/town/country <=50 chars, address <=100, zip <=10) so a
  // long hotel name/address can't silently cause a 400 at booking
  // time.
  // ─────────────────────────────────────────────
  buildAddressFromHotel(hotel, countryName = 'Kenya') {
    if (!hotel) return null;
    const clip = (str, max) => (str || '').toString().slice(0, max) || 'N/A';
    return {
      name:    clip(hotel.name, 50),
      address: clip(hotel.address, 100),
      town:    clip(hotel.city, 50),
      country: clip(countryName, 50),
      zip:     clip(hotel.zip || '00100', 10),
    };
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // Uses the exact DELETE link the docs show in both the booking
  // response (`links: [{ rel: "bookingCancel", ... }]`) and the
  // per-transfer response (`rel: "transferCancel"`). Accepts either
  // the full booking reference (cancels everything) — pass the
  // per-transfer link href instead if only one service of a
  // multi-service booking should be cancelled.
  // ─────────────────────────────────────────────
  async cancel(bookingReference, language = 'en') {
    try {
      const response = await axios.delete(
        `${this.baseUrl}/transfer-api/1.0/booking/${language}/reference/${bookingReference}`,
        { headers: this._headers(), timeout: this.timeout }
      );
      return response.data;
    } catch (err) {
      logger.error('HotelBeds Transfers cancel failed', {
        error: err.message, status: err.response?.status, data: err.response?.data,
      });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // GET BOOKING DETAIL
  // Same reference-based URL pattern as cancel() (GET instead of
  // DELETE) — per the docs' "BookingDetail" post-booking operation
  // and the `rel: "bookingDetail"` link shown in the booking response.
  // ─────────────────────────────────────────────
  async getBookingDetail(bookingReference, language = 'en') {
    try {
      const response = await axios.get(
        `${this.baseUrl}/transfer-api/1.0/booking/${language}/reference/${bookingReference}`,
        { headers: this._headers(), timeout: this.timeout }
      );
      return this._normalizeBooking(response.data?.bookings?.[0]);
    } catch (err) {
      logger.error('HotelBeds Transfers getBookingDetail failed', {
        error: err.message, status: err.response?.status, data: err.response?.data,
      });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE BOOKING RESPONSE
  // ─────────────────────────────────────────────
  _normalizeBooking(booking) {
    if (!booking) return null;
    const transfer = booking.transfers?.[0] || {};

    return {
      supplier:                 this.supplier,
      supplierBookingReference: booking.reference,
      status:                   booking.status, // CONFIRMED | CANCELLED | MODIFIED
      creationDate:             booking.creationDate,
      holder:                   booking.holder,
      totalAmount:              Number(booking.totalAmount || 0),
      currency:                 booking.currency || 'EUR',
      pendingAmount:            Number(booking.pendingAmount || 0),
      paymentDataRequired:      booking.paymentDataRequired || false,
      canCancel:                booking.transfers?.[0] ? true : (booking.modificationsPolicies?.cancellation ?? null),
      supplierName:             booking.supplier?.name || null,
      cancellationPolicies:     (transfer.cancellationPolicies || []).map(c => ({
        amount: c.amount, from: c.from, currency: c.currencyId,
      })),
      pickupInstructions:       transfer.pickupInformation?.pickup?.description || null,
      emergencyNumber:          transfer.sourceMarketEmergencyNumber || null,
      vehicle:                  transfer.vehicle?.name || null,
      transfers: (booking.transfers || []).map(t => ({
        id: t.id, direction: t.direction, status: t.status,
        transferType: t.transferType, vehicle: t.vehicle?.name || null,
        price: Number(t.price?.totalAmount || 0), currency: t.price?.currencyId || 'EUR',
      })),
      raw: booking,
    };
  }

  // ─────────────────────────────────────────────
  // NORMALIZE — maps HBX Group's Transfer API shape into a form
  // close to Bodrless's existing transfer-leg fields (provider,
  // price, currency) plus richer fields (vehicle, category, rateKey,
  // cancellation policy, estimated journey time, luggage allowance)
  // that the flat static-rate system never had.
  // ─────────────────────────────────────────────
  _normalizeServices(services) {
    if (!Array.isArray(services)) return [];

    return services.map(s => {
      const detailInfo = s.content?.transferDetailInfo || [];
      const findDetail = id => detailInfo.find(d => d.id === id)?.value || null;

      return {
        supplier:      this.supplier,
        serviceId:     s.serviceId,
        direction:     s.direction,      // ARRIVAL | DEPARTURE
        transferType:  s.transferType,   // SHARED | PRIVATE
        vehicle:       s.vehicle?.name || s.content?.vehicle?.name || null,
        vehicleCode:   s.vehicle?.code || null,
        category:      s.category?.name || null,
        minPax:        s.minPaxCapacity ?? null,
        maxPax:        s.maxPaxCapacity ?? null,
        price:         Number(s.price?.totalAmount || 0),
        currency:      s.price?.currencyId || 'EUR',
        rateKey:       s.rateKey || null,
        cancellationPolicies: (s.cancellationPolicies || []).map(c => ({
          amount: c.amount, from: c.from, currency: c.currencyId,
        })),
        pickupDescription: s.pickupInformation?.pickup?.description || null,
        estimatedMinutes:  findDetail('TRFTIME'),
        luggageAllowance:  findDetail('LUGGAGE'),
        images: (s.content?.images || []).map(i => i.url),
      };
    });
  }

  // ─────────────────────────────────────────────
  // PICK CHEAPEST — convenience for callers that just want one
  // priced option per leg rather than presenting every vehicle/
  // category combination.
  // ─────────────────────────────────────────────
  pickCheapest(normalizedServices) {
    if (!normalizedServices || normalizedServices.length === 0) return null;
    return normalizedServices.reduce((cheapest, s) =>
      (s.price || Infinity) < (cheapest.price || Infinity) ? s : cheapest
    );
  }
}

module.exports = new HotelbedsTransfersAdapter();