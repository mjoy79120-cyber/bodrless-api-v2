/**
 * MONITORING CRON
 * ─────────────────────────────────────────────────────────────
 * Frequency-aware scheduler that drives all trip monitoring.
 *
 * NOT a fixed-interval cron — it runs every 15 minutes but each
 * trip has its own check_interval_mins that controls how often
 * it's actually checked:
 *
 *   departure > 7 days:    check every 2 hours
 *   departure 1-7 days:    check every 1 hour
 *   departure < 24 hours:  check every 30 minutes
 *   departure < 6 hours:   check every 15 minutes
 *   trip in progress:      check every 15 minutes
 *
 * This means the cron fires frequently but most trips are skipped
 * on any given run — only trips where (now - last_checked_at) >=
 * check_interval_mins actually get processed.
 *
 * Mounted in server.js via startMonitoringCron().
 * Uses node-cron (already available) — no new dependencies.
 * ─────────────────────────────────────────────────────────────
 */

const { logger } = require('../utils/logger');
const tripMonitoringService = require('../services/tripMonitoringService');
const flightStatusService   = require('../services/flightStatusService');
const disruptionFlow        = require('../services/disruptionFlow');

// Guard against concurrent runs — if the previous run is still
// in progress when the cron fires again, skip this tick entirely.
// Prevents pile-up on slow API responses.
let isRunning = false;

class MonitoringCron {

  // ─────────────────────────────────────────────────────────────
  // START
  // Called from server.js after all routes are mounted.
  // Uses node-cron to fire every 15 minutes — the per-trip
  // interval logic inside the run controls actual check frequency.
  // ─────────────────────────────────────────────────────────────
  start() {
    let cron;
    try {
      cron = require('node-cron');
    } catch (err) {
      logger.warn('MonitoringCron: node-cron not installed — monitoring will not run', {
        fix: 'npm install node-cron',
      });
      return;
    }

    // Every 15 minutes — the inner logic determines which trips
    // actually need checking on any given tick
    cron.schedule('*/15 * * * *', () => {
      this.run().catch(err => {
        logger.error('MonitoringCron: unhandled error in run()', { error: err.message, stack: err.stack });
      });
    });

    logger.info('MonitoringCron: started — runs every 15 minutes, per-trip intervals enforced internally');
  }

  // ─────────────────────────────────────────────────────────────
  // RUN
  // The main cron tick. Gets all trips due for checking and
  // processes each one. Errors on individual trips are caught
  // and logged — one bad trip never blocks the others.
  // ─────────────────────────────────────────────────────────────
  async run() {
    if (isRunning) {
      logger.info('MonitoringCron: previous run still in progress — skipping this tick');
      return;
    }

    isRunning = true;
    const _tStart = Date.now();

    try {
      const trips = await tripMonitoringService.getTripsDueForCheck();

      if (trips.length === 0) {
        logger.info('MonitoringCron: no trips due for check this tick');
        return;
      }

      logger.info(`MonitoringCron: checking ${trips.length} trip(s)`, {
        tripIds: trips.map(t => t.id),
      });

      // Process trips sequentially to avoid hammering APIs
      // At current scale (tens of active trips), this is fine.
      // At hundreds, switch to batched parallel processing.
      for (const trip of trips) {
        await this._checkTrip(trip).catch(err => {
          logger.error('MonitoringCron: error checking trip — continuing', {
            tripId: trip.id, bookingRef: trip.booking_ref, error: err.message,
          });
        });
      }

      const elapsed = Date.now() - _tStart;
      logger.info(`MonitoringCron: run complete in ${elapsed}ms`, { tripsChecked: trips.length });

    } catch (err) {
      logger.error('MonitoringCron: run() failed', { error: err.message });
    } finally {
      isRunning = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // CHECK TRIP
  // Per-trip check — advances stage, polls flight status, detects
  // disruptions, and marks the trip as checked when done.
  // ─────────────────────────────────────────────────────────────
  async _checkTrip(trip) {
    logger.info('MonitoringCron: checking trip', {
      tripId: trip.id, bookingRef: trip.booking_ref,
      destination: trip.destination, supplier: trip.supplier,
    });

    // 1. Auto-advance stage based on current dates
    const inferredStage = tripMonitoringService.inferStage(trip);
    if (inferredStage !== trip.stage) {
      await tripMonitoringService.updateStage(trip.id, inferredStage, trip.departure_date);

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'stage_changed',
        severity:    'info',
        title:       `Trip advanced to stage: ${inferredStage}`,
      });

      // If the trip is now completed, stop here — no more checks needed
      if (inferredStage === 'completed') {
        await tripMonitoringService.completeTrip(trip.id);
        return;
      }
    }

    // 2. Flight status check
    // Only poll AeroDataBox for TravelDuqa bookings — Duffel bookings
    // use webhooks (duffelWebhooks.js) for real-time status.
    // Skip polling entirely if departure is more than 48 hours away
    // (AeroDataBox doesn't have reliable data that far in advance).
    if (trip.supplier !== 'duffel' && trip.flight_number && trip.departure_date) {
      const hoursToDepature = this._hoursUntil(trip.departure_date);

      if (hoursToDepature <= 48 && hoursToDepature > -2) {
        // Within 48 hours of departure (and not more than 2 hours past) —
        // AeroDataBox data is reliable in this window
        await this._checkFlightStatus(trip);
      } else {
        logger.info('MonitoringCron: skipping flight poll (outside 48h window)', {
          tripId: trip.id, hoursToDepature: Math.round(hoursToDepature),
        });
      }
    }

    // 3. Mark checked — updates last_checked_at and recalculates interval
    await tripMonitoringService.markChecked(trip.id, trip.departure_date);
  }

  // ─────────────────────────────────────────────────────────────
  // CHECK FLIGHT STATUS (AeroDataBox poll)
  // Only called for TravelDuqa bookings within 48h of departure.
  // Duffel bookings are handled by webhooks in real-time.
  // ─────────────────────────────────────────────────────────────
  async _checkFlightStatus(trip) {
    const status = await flightStatusService.checkFlight(
      trip.flight_number,
      trip.departure_date
    );

    if (!status) return; // null = not in AeroDataBox yet, or API error

    // Has anything material changed since last check?
    const lastKnown = trip.disruption_detail || null;
    const changed   = flightStatusService.hasStatusChanged(status, lastKnown);

    if (!changed) {
      logger.info('MonitoringCron: flight status unchanged', {
        tripId: trip.id, flightNumber: trip.flight_number, status: status.rawStatus,
      });
      return;
    }

    if (status.isDisrupted) {
      // New disruption or worsening — handle it
      logger.warn('MonitoringCron: flight disruption detected', {
        tripId:         trip.id,
        flightNumber:   trip.flight_number,
        disruptionType: status.disruptionType,
        delayMinutes:   status.delayMinutes,
      });

      await disruptionFlow.handleFlightDisruption(trip, status);

    } else if (!status.isDisrupted && trip.active_disruption) {
      // Disruption has cleared (e.g. delay cancelled, flight back on schedule)
      logger.info('MonitoringCron: disruption cleared', { tripId: trip.id });

      await tripMonitoringService.resolveDisruption(trip.id, 'auto');

      // Notify traveler that things are back to normal
      const agencyPhoneNumberId = await this._getAgencyPhoneId(trip.agency_id);
      if (trip.guest_phone && agencyPhoneNumberId) {
        const whatsappService = require('../services/whatsapp');
        await whatsappService.sendText(agencyPhoneNumberId, trip.guest_phone,
          `✅ Good news! Flight ${trip.flight_number} is back on schedule. Your original departure time stands. ✈️`
        );
      }

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'issue_resolved',
        severity:    'info',
        title:       `Flight ${trip.flight_number} back on schedule`,
        description: 'Disruption cleared — flight returned to scheduled departure time.',
        metadata:    status,
        resolved:    true,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────
  _hoursUntil(dateStr) {
    if (!dateStr) return Infinity;
    const depMs = new Date(dateStr).getTime();
    const nowMs = Date.now();
    return (depMs - nowMs) / (1000 * 60 * 60);
  }

  async _getAgencyPhoneId(agencyId) {
    if (!agencyId) return null;
    try {
      const supabase = require('../utils/supabase');
      const { data }  = await supabase
        .from('agencies')
        .select('whatsapp_phone_number_id')
        .eq('id', agencyId)
        .single();
      return data?.whatsapp_phone_number_id || null;
    } catch {
      return null;
    }
  }
}

module.exports = new MonitoringCron();