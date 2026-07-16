/**
 * FLIGHT STATUS SERVICE
 * ─────────────────────────────────────────────────────────────
 * Polls AeroDataBox for real-time flight status.
 * Used as the fallback for TravelDuqa bookings where Duffel
 * webhooks are not available.
 *
 * AeroDataBox API:
 *   Host:    aerodatabox.p.rapidapi.com
 *   Auth:    X-RapidAPI-Key header (AERODATABOX_API_KEY env var)
 *   Docs:    https://doc.aerodatabox.com
 *   Pricing: Free tier = 150 calls/month. $10/mo for 2,000 calls.
 *            At 30-min polling for one active trip = ~48 calls/day.
 *            Budget: one active trip ≈ 1,440 calls/month. Plan for
 *            the paid tier from day one. Use AERODATABOX_API_KEY
 *            as the env var — set it in Render, leave it null in
 *            dev and the service degrades gracefully (no polling,
 *            relies on Duffel webhooks only).
 *
 * What we get:
 *   - status: 'Scheduled' | 'EnRoute' | 'Landed' | 'Cancelled' | 'Diverted'
 *   - departure.scheduledTime / departure.revisedTime (delay = difference)
 *   - arrival.scheduledTime  / arrival.revisedTime
 *   - departure.gate / arrival.gate
 *   - departure.terminal / arrival.terminal
 *
 * Called by: monitoringCron.js → checkFlight()
 * NOT called for Duffel bookings — those use webhooks instead.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

// Minimum delay minutes before we treat this as a real disruption
// worth notifying the traveler about. Avoids spam for 5-minute
// schedule tweaks that airlines routinely make weeks in advance.
const DELAY_THRESHOLD_MINUTES = 20;

class FlightStatusService {

  constructor() {
    this.apiKey  = process.env.AERODATABOX_API_KEY || null;
    this.host    = 'aerodatabox.p.rapidapi.com';
    this.baseUrl = 'https://aerodatabox.p.rapidapi.com';
    this.timeout = 10000;
  }

  // ─────────────────────────────────────────────────────────────
  // CHECK FLIGHT STATUS
  // Primary method called by the cron for each active trip.
  // Returns a normalized status object — callers don't need to
  // know AeroDataBox's response shape.
  //
  // flightNumber: IATA format, e.g. "KQ101" or "ET307"
  // date:         YYYY-MM-DD of the departure
  //
  // Returns null if:
  //   - No API key configured (degrade gracefully)
  //   - Flight not found (too far in advance, or wrong number)
  //   - API error (log and continue — don't crash the cron)
  // ─────────────────────────────────────────────────────────────
  async checkFlight(flightNumber, date) {
    if (!this.apiKey) {
      logger.warn('FlightStatus: AERODATABOX_API_KEY not set — skipping poll (Duffel webhooks still active)');
      return null;
    }

    if (!flightNumber || !date) {
      logger.warn('FlightStatus: checkFlight called with missing flightNumber or date', { flightNumber, date });
      return null;
    }

    // AeroDataBox wants departure date as local date range:
    // /flights/number/{flightNumber}/{date}
    // The endpoint returns all departures of this flight on this date
    // (usually just one, occasionally codeshares)
    const cleanFlightNumber = String(flightNumber).replace(/\s+/g, '').toUpperCase();

    try {
      logger.info('FlightStatus: polling AeroDataBox', { flightNumber: cleanFlightNumber, date });

      const response = await axios.get(
        `${this.baseUrl}/flights/number/${cleanFlightNumber}/${date}`,
        {
          headers: {
            'X-RapidAPI-Key':  this.apiKey,
            'X-RapidAPI-Host': this.host,
          },
          params: {
            withAircraftImage:    false,
            withLocation:         false,
          },
          timeout: this.timeout,
        }
      );

      // AeroDataBox returns an array — pick first result
      const flights = response.data;
      if (!Array.isArray(flights) || flights.length === 0) {
        logger.info('FlightStatus: no data returned for flight', { flightNumber: cleanFlightNumber, date });
        return null;
      }

      const flight = flights[0];
      return this._normalize(flight, cleanFlightNumber);

    } catch (err) {
      // 404 = flight not in their database yet (too far in advance
      // or genuinely wrong number) — not an error worth alarming on
      if (err.response?.status === 404) {
        logger.info('FlightStatus: flight not found in AeroDataBox (may be too far in advance)', {
          flightNumber: cleanFlightNumber, date,
        });
        return null;
      }

      // 429 = rate limit — log prominently but don't crash
      if (err.response?.status === 429) {
        logger.warn('FlightStatus: AeroDataBox rate limit hit — skipping this check cycle', {
          flightNumber: cleanFlightNumber,
        });
        return null;
      }

      logger.error('FlightStatus: AeroDataBox poll failed', {
        flightNumber: cleanFlightNumber, date,
        status: err.response?.status,
        error:  err.message,
      });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // NORMALIZE AERODATABOX RESPONSE
  // Converts AeroDataBox's response shape to Bodrless's internal
  // flight status format. Callers only see this normalized shape —
  // if AeroDataBox is ever swapped for another provider, only this
  // method needs to change.
  //
  // Key computed fields:
  //   delayMinutes:  positive = delayed, negative = early
  //   isDisrupted:   true if delayed beyond threshold OR cancelled
  //   disruptionType: 'delay' | 'cancellation' | 'diversion' | null
  // ─────────────────────────────────────────────────────────────
  _normalize(flight, flightNumber) {
    const dep = flight.departure || {};
    const arr = flight.arrival   || {};

    const scheduledDep  = dep.scheduledTime?.local  || dep.scheduledTime?.utc  || null;
    const revisedDep    = dep.revisedTime?.local     || dep.revisedTime?.utc    || null;
    const scheduledArr  = arr.scheduledTime?.local   || arr.scheduledTime?.utc  || null;
    const revisedArr    = arr.revisedTime?.local     || arr.revisedTime?.utc    || null;

    // Delay calculation: how many minutes is the DEPARTURE delayed?
    let delayMinutes = 0;
    if (scheduledDep && revisedDep) {
      const schedMs   = new Date(scheduledDep).getTime();
      const revisedMs = new Date(revisedDep).getTime();
      if (!isNaN(schedMs) && !isNaN(revisedMs)) {
        delayMinutes = Math.round((revisedMs - schedMs) / (1000 * 60));
      }
    }

    const status    = (flight.status || '').toLowerCase();
    const isCancelled = status.includes('cancel');
    const isDiverted  = status.includes('divert');
    const isDelayed   = !isCancelled && !isDiverted && Math.abs(delayMinutes) >= DELAY_THRESHOLD_MINUTES;

    let disruptionType = null;
    if (isCancelled)                         disruptionType = 'cancellation';
    else if (isDiverted)                     disruptionType = 'diversion';
    else if (delayMinutes >= DELAY_THRESHOLD_MINUTES) disruptionType = 'delay';

    const isDisrupted = isCancelled || isDiverted || isDelayed;

    return {
      flightNumber,
      status:           flight.status || 'Unknown',
      airline:          flight.airline?.name  || null,
      airlineCode:      flight.airline?.iata  || null,
      aircraft:         flight.aircraft?.model || null,

      departure: {
        airport:         dep.airport?.name    || null,
        iata:            dep.airport?.iata    || null,
        terminal:        dep.terminal         || null,
        gate:            dep.gate             || null,
        scheduledTime:   scheduledDep,
        revisedTime:     revisedDep,
        actualTime:      dep.actualTime?.local || dep.actualTime?.utc || null,
      },
      arrival: {
        airport:         arr.airport?.name    || null,
        iata:            arr.airport?.iata    || null,
        terminal:        arr.terminal         || null,
        gate:            arr.gate             || null,
        scheduledTime:   scheduledArr,
        revisedTime:     revisedArr,
        actualTime:      arr.actualTime?.local || arr.actualTime?.utc || null,
      },

      delayMinutes,
      isDisrupted,
      disruptionType,
      isCancelled,
      isDiverted,
      isDelayed,

      rawStatus: flight.status || null,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // HAS STATUS CHANGED
  // Compares a fresh status result against the last known status
  // stored in trip.disruption_detail. Returns true only when
  // something material changed — prevents re-notifying the
  // traveler about the same delay they already know about.
  //
  // "Material" = disruption appeared, worsened, or cleared.
  // A 5-minute change in an already-known delay is NOT material.
  // ─────────────────────────────────────────────────────────────
  hasStatusChanged(freshStatus, lastKnownDetail) {
    if (!lastKnownDetail) {
      // No previous state — any disruption is a new event
      return freshStatus.isDisrupted;
    }

    const prev = lastKnownDetail;

    // Disruption appeared
    if (freshStatus.isDisrupted && !prev.isDisrupted) return true;

    // Disruption cleared
    if (!freshStatus.isDisrupted && prev.isDisrupted) return true;

    // Disruption type changed (e.g. delay → cancellation)
    if (freshStatus.disruptionType !== prev.disruptionType) return true;

    // Delay got significantly worse (>15 min change from last known)
    if (freshStatus.disruptionType === 'delay' && prev.disruptionType === 'delay') {
      const delayDiff = Math.abs(freshStatus.delayMinutes - (prev.delayMinutes || 0));
      if (delayDiff >= 15) return true;
    }

    // Gate changed
    if (freshStatus.departure?.gate && freshStatus.departure.gate !== prev.departure?.gate) return true;

    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // FORMAT DISRUPTION SUMMARY
  // Human-readable one-liner for event logs and WhatsApp messages.
  // ─────────────────────────────────────────────────────────────
  formatDisruptionSummary(status) {
    if (!status?.isDisrupted) return null;

    const fn = status.flightNumber;
    const dep = status.departure;

    if (status.isCancelled) {
      return `Flight ${fn} has been cancelled.`;
    }

    if (status.isDiverted) {
      return `Flight ${fn} has been diverted.`;
    }

    if (status.isDelayed) {
      const mins  = status.delayMinutes;
      const hrs   = Math.floor(Math.abs(mins) / 60);
      const rem   = Math.abs(mins) % 60;
      const label = hrs > 0
        ? `${hrs}h${rem > 0 ? ` ${rem}m` : ''}`
        : `${mins}m`;

      const newTime = dep?.revisedTime
        ? ` New departure: ${this._formatLocalTime(dep.revisedTime)}.`
        : '';

      const gateNote = dep?.gate ? ` Gate: ${dep.gate}.` : '';

      return `Flight ${fn} is delayed by ${label}.${newTime}${gateNote}`;
    }

    return `Flight ${fn} status: ${status.rawStatus}.`;
  }

  _formatLocalTime(isoString) {
    if (!isoString) return 'TBC';
    try {
      return new Date(isoString).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoString;
    }
  }
}

module.exports = new FlightStatusService();