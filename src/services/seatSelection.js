/**
 * SEAT SELECTION (Duffel)
 * ─────────────────────────────────────────────
 * Lets a traveler get a specific seat by stating a plain preference
 * ("window seat", "aisle", "exit row") instead of picking from a
 * visual seat map — deliberately built this way per a real product
 * decision: seat selection must be an OPTIONAL, low-clutter step on
 * both WhatsApp and the widget, not a graphical grid.
 *
 * Classification is derived purely from the REAL structural position
 * data in Duffel's seat map response (which section/row a seat sits
 * in), not guessed or hardcoded per aircraft type:
 *   - The first seat in a row's first section, and the last seat in
 *     a row's last section, are always WINDOW seats.
 *   - Any other seat at the edge of a section (next to an aisle) is
 *     an AISLE seat.
 *   - Everything else in a section is a MIDDLE seat.
 *   - EXIT ROW = a real seat row sitting immediately before or after
 *     a row containing an `exit_row`-type element (the physical door
 *     position in the cabin).
 *
 * Endpoint/auth confirmed from Duffel's public docs, 2026-07-03:
 *   GET https://api.duffel.com/air/seat_maps?offer_id=...
 *   Headers: Authorization: Bearer <token>, Duffel-Version: v2,
 *            Accept: application/json, Accept-Encoding: gzip
 *
 * NOT YET VERIFIED against a real seat map response — same "test
 * before trusting" rule as every other adapter built this session.
 * Run getSeatMap() against a real offer_id and inspect the
 * classified output before wiring this into the live booking flow.
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

const DUFFEL_BASE_URL = 'https://api.duffel.com';

class SeatSelectionService {

  constructor() {
    this.token = process.env.DUFFEL_ACCESS_TOKEN;
  }

  _headers() {
    return {
      'Content-Type':      'application/json',
      'Accept':             'application/json',
      'Accept-Encoding':    'gzip',
      'Duffel-Version':     'v2',
      'Authorization':      `Bearer ${this.token}`,
    };
  }

  // ─────────────────────────────────────────────
  // FETCH RAW SEAT MAP
  // Returns one entry per segment (a multi-stop journey has one seat
  // map per flight leg). Not all airlines/flights support seat maps
  // — an empty array is a normal, expected response, not an error.
  // ─────────────────────────────────────────────
  async getSeatMap(offerId) {
    if (!this.token) {
      throw new Error('Duffel is not configured (missing DUFFEL_ACCESS_TOKEN).');
    }
    try {
      const response = await axios.get(`${DUFFEL_BASE_URL}/air/seat_maps`, {
        params: { offer_id: offerId },
        headers: this._headers(),
        timeout: 15000,
      });
      return response.data?.data || [];
    } catch (err) {
      logger.error('Duffel getSeatMap failed', {
        offerId, status: err.response?.status, detail: err.response?.data, error: err.message,
      });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CLASSIFY ONE SEAT MAP (one segment)
  // Walks every cabin -> row -> section -> element, tagging each
  // real seat with positionType (window/aisle/middle) and isExitRow.
  // Non-seat elements (lavatory, galley, exit_row markers, empty
  // sections) are used only to inform classification, never returned
  // as seats themselves.
  // ─────────────────────────────────────────────
  classifySeatMap(seatMap) {
    const results = [];

    for (const cabin of seatMap.cabins || []) {
      const rows = cabin.rows || [];

      // First pass: which row INDEXES contain an exit_row marker,
      // so we can mark the real seat rows immediately adjacent to
      // them (before AND after) as extra-legroom exit rows.
      const exitMarkerRowIndices = [];
      rows.forEach((row, idx) => {
        const hasExitMarker = (row.sections || []).some(sec =>
          (sec.elements || []).some(el => el.type === 'exit_row')
        );
        if (hasExitMarker) exitMarkerRowIndices.push(idx);
      });

      const exitAdjacentRowIndices = new Set();
      for (const idx of exitMarkerRowIndices) {
        if (idx - 1 >= 0) exitAdjacentRowIndices.add(idx - 1);
        if (idx + 1 < rows.length) exitAdjacentRowIndices.add(idx + 1);
      }

      // Second pass: classify every real seat.
      rows.forEach((row, rowIdx) => {
        const isExitRow = exitAdjacentRowIndices.has(rowIdx);

        // Only sections that actually contain seat-type elements —
        // lavatory/galley/exit_row/empty sections are structural,
        // not seats, and must not shift window/aisle math.
        const seatSections = (row.sections || []).filter(sec =>
          (sec.elements || []).some(el => el.type === 'seat')
        );

        seatSections.forEach((section, sectionIdx) => {
          const seatElements = (section.elements || []).filter(el => el.type === 'seat');
          const isFirstSection = sectionIdx === 0;
          const isLastSection  = sectionIdx === seatSections.length - 1;

          seatElements.forEach((seat, seatIdx) => {
            const isFirstInSection = seatIdx === 0;
            const isLastInSection  = seatIdx === seatElements.length - 1;

            let positionType;
            if (seatElements.length === 1) {
              // Single-seat section — genuine edge case (rare
              // aircraft configs). Treat as window if it's the
              // outermost section, otherwise aisle.
              positionType = (isFirstSection || isLastSection) ? 'window' : 'aisle';
            } else if (isFirstSection && isFirstInSection) {
              positionType = 'window';
            } else if (isLastSection && isLastInSection) {
              positionType = 'window';
            } else if (isFirstInSection || isLastInSection) {
              positionType = 'aisle';
            } else {
              positionType = 'middle';
            }

            results.push({
              designator:  seat.designator,
              positionType,
              isExitRow,
              availableServices: seat.available_services || [],
              disclosures: seat.disclosures || [],
            });
          });
        });
      });
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // NORMALIZE A PLAIN-TEXT PREFERENCE
  // ─────────────────────────────────────────────
  normalizePreference(text) {
    const t = String(text || '').toLowerCase();
    if (/\bexit\s*row\b/.test(t)) return 'exit_row';
    if (/\bwindow\b/.test(t))     return 'window';
    if (/\baisle\b/.test(t))      return 'aisle';
    if (/\bmiddle\b/.test(t))     return 'middle';
    return null;
  }

  // ─────────────────────────────────────────────
  // FIND A SEAT MATCHING A PREFERENCE, FOR ONE PASSENGER
  // Returns the first available matching seat, with its real price
  // (Duffel seats are usually a paid extra, not free) — or null if
  // nothing matches. "Available for this passenger" means the seat
  // has a available_services entry with this passenger's ID; an
  // empty available_services array means the seat isn't sellable to
  // this passenger (already taken, blocked, etc.) and is skipped.
  //
  // isChildPassenger MUST be passed accurately — confirmed via a
  // real live test that some seats (exit rows and others) carry a
  // real disclosure: "Passenger must be an adult". This is a
  // genuine airline safety restriction, not a preference — a child
  // is never matched to a seat with this disclosure, regardless of
  // what preference was requested. If every candidate for the
  // requested preference is adult-only, this returns null (falls
  // through to no match) rather than silently placing the child in
  // a restricted seat.
  // ─────────────────────────────────────────────
  findSeatForPreference(classifiedSeats, preferenceType, passengerId, isChildPassenger = false) {
    const candidates = classifiedSeats.filter(s =>
      preferenceType === 'exit_row' ? s.isExitRow : s.positionType === preferenceType
    );

    for (const seat of candidates) {
      if (isChildPassenger && this._isAdultOnlySeat(seat)) continue;

      const service = (seat.availableServices || []).find(svc => svc.passenger_id === passengerId);
      if (service) {
        return {
          designator:   seat.designator,
          positionType: seat.positionType,
          isExitRow:    seat.isExitRow,
          price:        Number(service.total_amount),
          currency:     service.total_currency,
          serviceId:    service.id,
        };
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────
  // Checks a seat's real disclosures for an adult-only restriction.
  // Matches case-insensitively on "adult" since the exact disclosure
  // wording isn't guaranteed to be identical across airlines —
  // confirmed real wording from a live test: "Passenger must be an
  // adult", but treating this narrowly (exact string match only)
  // risks silently missing a differently-worded equivalent
  // restriction from another airline.
  // ─────────────────────────────────────────────
  _isAdultOnlySeat(seat) {
    return (seat.disclosures || []).some(d => /\badult\b/i.test(String(d)));
  }

  // ─────────────────────────────────────────────
  // RESOLVE SEAT SELECTIONS FOR A BOOKING
  // Top-level orchestrator: given a real offer_id and a list of
  // passengers (each with a Duffel passenger_id, a type, and an
  // optional raw seatPreference string), fetches the real seat map
  // once and resolves every passenger's preference against it.
  //
  // Only ever attempted for Duffel-sourced flights — this whole
  // service is Duffel-specific (see file header). Caller is
  // responsible for checking transport.supplier === 'duffel' first.
  //
  // Returns { resolved: [...], unresolved: [...] } — resolved
  // entries carry the real serviceId needed to include this seat in
  // the SAME order-creation call (Duffel does not support selecting
  // a seat after an order already exists — see file header).
  // unresolved entries carry an honest reason (no preference stated,
  // no seat map available for this flight, preference couldn't be
  // matched, or a child was correctly refused an adult-only seat)
  // so the caller can tell the traveler plainly rather than silently
  // booking without the requested seat.
  //
  // A seat map lookup failure (network error, or this flight
  // genuinely has none — both are normal, non-fatal cases per
  // Duffel's own docs) never blocks the booking — every passenger
  // just becomes "unresolved" with a clear reason, and the caller
  // proceeds with the booking seatless.
  // ─────────────────────────────────────────────
  async resolveSeatSelections({ offerId, passengers }) {
    const resolved = [];
    const unresolved = [];

    const withPreference = (passengers || []).filter(p => p.seatPreference && this.normalizePreference(p.seatPreference));
    if (withPreference.length === 0) {
      return { resolved, unresolved: (passengers || []).map(p => ({ passengerId: p.duffelPassengerId, reason: 'no preference stated' })) };
    }

    let seatMaps;
    try {
      seatMaps = await this.getSeatMap(offerId);
    } catch (err) {
      logger.warn('resolveSeatSelections: seat map fetch failed — proceeding without seat selection', { offerId, error: err.message });
      return { resolved, unresolved: passengers.map(p => ({ passengerId: p.duffelPassengerId, reason: 'seat map unavailable' })) };
    }

    if (!seatMaps || seatMaps.length === 0) {
      return { resolved, unresolved: passengers.map(p => ({ passengerId: p.duffelPassengerId, reason: 'this flight does not support seat selection' })) };
    }

    // Classify once per segment, reused for every passenger.
    const classifiedBySegment = seatMaps.map(sm => ({
      segmentId: sm.segment_id,
      seats: this.classifySeatMap(sm),
    }));

    for (const passenger of passengers) {
      const normalizedPref = this.normalizePreference(passenger.seatPreference);
      if (!normalizedPref) {
        unresolved.push({ passengerId: passenger.duffelPassengerId, reason: 'no preference stated' });
        continue;
      }
      if (!passenger.duffelPassengerId) {
        unresolved.push({ passengerId: null, reason: 'no Duffel passenger ID available yet — offer not yet selected' });
        continue;
      }

      const isChild = passenger.type === 'child';

      // Attempt every segment (a multi-stop flight needs a seat per
      // leg) — for now, resolves the FIRST segment only, since most
      // of Bodrless's real routes are direct. Extending to every
      // segment is a straightforward loop once multi-segment
      // bookings are actually in scope.
      const segment = classifiedBySegment[0];
      const match = segment
        ? this.findSeatForPreference(segment.seats, normalizedPref, passenger.duffelPassengerId, isChild)
        : null;

      if (match) {
        resolved.push({
          passengerId: passenger.duffelPassengerId,
          segmentId: segment.segmentId,
          ...match,
        });
      } else {
        unresolved.push({
          passengerId: passenger.duffelPassengerId,
          reason: isChild && normalizedPref === 'exit_row'
            ? 'exit row seats are not permitted for children'
            : `no available ${normalizedPref.replace('_', ' ')} seat found`,
        });
      }
    }

    return { resolved, unresolved };
  }

}

module.exports = new SeatSelectionService();