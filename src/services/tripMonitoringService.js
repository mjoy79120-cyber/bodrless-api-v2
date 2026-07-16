/**
 * TRIP MONITORING SERVICE
 * ─────────────────────────────────────────────────────────────
 * Core engine for the trip monitoring system.
 *
 * Responsibilities:
 *   - Create a monitored trip record when a booking is confirmed
 *   - Log every event to trip_events (immutable audit trail)
 *   - Update trip health and stage
 *   - Determine which trips need checking and how urgently
 *   - Coordinate with flightStatusService, disruptionFlow,
 *     and notificationService when something changes
 *
 * Called by:
 *   - bookingService.js → createTripFromBooking() after confirmation
 *   - monitoringCron.js → checkDueTripts() on schedule
 *   - duffelWebhooks.js → handleWebhookEvent() on real-time signal
 *   - disruptionFlow.js → after executing a change
 * ─────────────────────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// ── POLLING INTERVALS BY DEPARTURE PROXIMITY ─────────────────
// The closer to departure, the more frequently we check.
// These are in minutes.
const INTERVALS = {
  MORE_THAN_7_DAYS:  120,   // 2 hours  — nothing urgent yet
  ONE_TO_7_DAYS:      60,   // 1 hour   — approaching, keep an eye out
  WITHIN_24_HOURS:    30,   // 30 mins  — delays happen here
  WITHIN_6_HOURS:     15,   // 15 mins  — imminent departure window
  IN_PROGRESS:        15,   // 15 mins  — trip is live
};

class TripMonitoringService {

  // ─────────────────────────────────────────────────────────────
  // CREATE TRIP FROM BOOKING
  // Called immediately after bookingService.js confirms a booking.
  // Extracts flight/hotel context from the booking record so the
  // monitoring engine has everything it needs without re-fetching.
  // ─────────────────────────────────────────────────────────────
  async createTripFromBooking(booking) {
    if (!booking?.id) {
      logger.warn('TripMonitoring: createTripFromBooking called with no booking id');
      return null;
    }

    try {
      // Extract flight details — bookings.flight_details is the
      // formatted transport object from engine.js _formatTransportDisplay
      const flight       = booking.flight_details   || {};
      const hotel        = booking.hotel_details    || {};
      const tripParams   = booking.trip_params      || {};

      // departure_date and return_date live inside trip_params JSONB —
      // the bookings table does not have these as top-level columns.
      const departureDate = tripParams.departureDate || null;
      const returnDate    = tripParams.returnDate    || null;

      // Determine supplier and order ID for status polling
      // Duffel bookings have orderId on the flight details;
      // TravelDuqa bookings have orderId on booking level
      const supplier = flight.supplier || tripParams.supplier || 'travelduqa';
      const supplierOrderId = flight.orderId
        || booking.supplier_order_id
        || booking.supplier_booking_reference
        || null;

      // Compute initial check interval based on departure date
      const interval = this._computeInterval(departureDate);

      const tripData = {
        id:                 uuidv4(),
        booking_id:         booking.id,
        booking_ref:        booking.booking_ref,
        agency_id:          booking.agency_id,

        guest_name:         booking.guest_name,
        guest_phone:        booking.guest_phone,
        guest_email:        booking.guest_email,
        origin:             booking.origin        || tripParams.origin        || null,
        destination:        booking.destination   || tripParams.destination   || null,
        departure_date:     departureDate,
        return_date:        returnDate,

        // Flight monitoring fields
        flight_number:        flight.flightNumber  || null,
        flight_number_return: flight.returnLeg?.flightNumber || null,
        supplier,
        supplier_order_id:    supplierOrderId,

        // Hotel fields
        hotel_name:     hotel.name     || null,
        hotel_supplier: hotel.supplier || null,

        // Initial monitoring state
        health:               'healthy',
        stage:                'booked',
        monitoring_enabled:   true,
        check_interval_mins:  interval,
        last_checked_at:      null,
        active_disruption:    false,
      };

      const { data: trip, error } = await supabase
        .from('trips')
        .insert(tripData)
        .select()
        .single();

      if (error) {
        logger.error('TripMonitoring: failed to create trip record', {
          bookingRef: booking.booking_ref, error: error.message,
        });
        return null;
      }

      // Log the first event — booking confirmed
      await this.logEvent(trip.id, {
        event_type:  'booking_confirmed',
        severity:    'info',
        title:       'Booking confirmed',
        description: `Trip to ${trip.destination} created. Monitoring started.`,
        metadata:    {
          bookingRef: booking.booking_ref,
          supplier,
          supplierOrderId,
          departureDate,
          flightNumber: trip.flight_number,
        },
      });

      logger.info('TripMonitoring: trip created', {
        tripId: trip.id,
        bookingRef: booking.booking_ref,
        destination: trip.destination,
        departureDate,
        interval,
        supplier,
      });

      return trip;

    } catch (err) {
      logger.error('TripMonitoring: createTripFromBooking threw', { error: err.message, bookingRef: booking?.booking_ref });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // LOG EVENT
  // Immutable append — never updates an existing event.
  // Every state change, notification, check result, and resolution
  // gets its own row. This is the audit trail agencies can see.
  // ─────────────────────────────────────────────────────────────
  async logEvent(tripId, { event_type, severity = 'info', title, description = null, metadata = null, resolved = false }) {
    if (!tripId) return null;

    try {
      // Need booking_ref and agency_id for the row — look them up
      // from the trip rather than requiring callers to pass them
      const { data: trip } = await supabase
        .from('trips')
        .select('booking_ref, agency_id')
        .eq('id', tripId)
        .single();

      if (!trip) {
        logger.warn('TripMonitoring: logEvent — trip not found', { tripId });
        return null;
      }

      const { data: event, error } = await supabase
        .from('trip_events')
        .insert({
          id:           uuidv4(),
          trip_id:      tripId,
          booking_ref:  trip.booking_ref,
          agency_id:    trip.agency_id,
          event_type,
          severity,
          title,
          description,
          metadata,
          resolved,
          created_at:   new Date().toISOString(),
        })
        .select()
        .single();

      if (error) {
        logger.error('TripMonitoring: logEvent insert failed', { tripId, event_type, error: error.message });
        return null;
      }

      return event;

    } catch (err) {
      logger.error('TripMonitoring: logEvent threw', { tripId, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE TRIP HEALTH
  // Called when a disruption is detected or resolved.
  // Also updates the active_disruption flag and disruption context
  // so the dashboard can show the right status at a glance.
  // ─────────────────────────────────────────────────────────────
  async updateHealth(tripId, health, { disruption_type = null, disruption_detail = null, active_disruption = null } = {}) {
    if (!tripId) return null;

    try {
      const updates = { health };

      if (active_disruption !== null) updates.active_disruption = active_disruption;
      if (disruption_type   !== null) updates.disruption_type   = disruption_type;
      if (disruption_detail !== null) updates.disruption_detail = disruption_detail;

      const { error } = await supabase
        .from('trips')
        .update(updates)
        .eq('id', tripId);

      if (error) {
        logger.error('TripMonitoring: updateHealth failed', { tripId, health, error: error.message });
        return false;
      }

      logger.info('TripMonitoring: health updated', { tripId, health, disruption_type });
      return true;

    } catch (err) {
      logger.error('TripMonitoring: updateHealth threw', { tripId, error: err.message });
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // UPDATE STAGE
  // Advances the trip through its lifecycle stages.
  // Also recalculates the polling interval since urgency changes
  // as the trip progresses.
  // ─────────────────────────────────────────────────────────────
  async updateStage(tripId, stage, departureDate = null) {
    if (!tripId) return null;

    try {
      const interval = this._computeInterval(departureDate, stage);

      const { error } = await supabase
        .from('trips')
        .update({ stage, check_interval_mins: interval })
        .eq('id', tripId);

      if (error) {
        logger.error('TripMonitoring: updateStage failed', { tripId, stage, error: error.message });
        return false;
      }

      logger.info('TripMonitoring: stage advanced', { tripId, stage, interval });
      return true;

    } catch (err) {
      logger.error('TripMonitoring: updateStage threw', { tripId, error: err.message });
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MARK LAST CHECKED
  // Called after every monitoring check so the cron knows when
  // to next check this trip. Also recalculates interval since
  // the trip is now that much closer to departure.
  // ─────────────────────────────────────────────────────────────
  async markChecked(tripId, departureDate = null) {
    if (!tripId) return;

    try {
      const interval = this._computeInterval(departureDate);

      await supabase
        .from('trips')
        .update({
          last_checked_at:     new Date().toISOString(),
          check_interval_mins: interval,
        })
        .eq('id', tripId);

    } catch (err) {
      logger.error('TripMonitoring: markChecked threw', { tripId, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET TRIPS DUE FOR CHECKING
  // The cron calls this to get the list of trips that need a check
  // right now. "Due" = last_checked_at is null OR it was more than
  // check_interval_mins ago. Excludes completed trips.
  // ─────────────────────────────────────────────────────────────
  async getTripsDueForCheck() {
    try {
      // Supabase doesn't support computed "due" filters directly —
      // fetch all active trips and filter in JS. At current scale
      // (tens to low hundreds of active trips) this is fine.
      // At thousands of active trips, push this to a DB function.
      const { data: trips, error } = await supabase
        .from('trips')
        .select('*')
        .eq('monitoring_enabled', true)
        .not('stage', 'in', '("completed")')
        .order('last_checked_at', { ascending: true, nullsFirst: true });

      if (error) {
        logger.error('TripMonitoring: getTripsDueForCheck failed', { error: error.message });
        return [];
      }

      const now = Date.now();

      return (trips || []).filter(trip => {
        if (!trip.last_checked_at) return true; // never checked — check now

        const lastChecked = new Date(trip.last_checked_at).getTime();
        const intervalMs  = (trip.check_interval_mins || 120) * 60 * 1000;

        return (now - lastChecked) >= intervalMs;
      });

    } catch (err) {
      logger.error('TripMonitoring: getTripsDueForCheck threw', { error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET TRIP BY SUPPLIER ORDER ID
  // Used by the Duffel webhook handler to look up which trip an
  // incoming webhook event belongs to.
  // ─────────────────────────────────────────────────────────────
  async getTripBySupplierOrder(supplier, supplierOrderId) {
    if (!supplierOrderId) return null;

    try {
      const { data: trip, error } = await supabase
        .from('trips')
        .select('*')
        .eq('supplier', supplier)
        .eq('supplier_order_id', supplierOrderId)
        .eq('monitoring_enabled', true)
        .single();

      if (error) {
        // .single() throws if no row found — that's fine, just means
        // this order isn't being monitored (e.g. old booking pre-monitoring)
        return null;
      }

      return trip;

    } catch (err) {
      logger.error('TripMonitoring: getTripBySupplierOrder threw', { supplier, supplierOrderId, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // STORE ALTERNATIVES OFFERED
  // Saves the alternative flights that were sent to the traveler
  // so disruptionFlow.js can match their tap reply to the right
  // option without a separate lookup table.
  // ─────────────────────────────────────────────────────────────
  async storeAlternativesOffered(tripId, alternatives) {
    if (!tripId || !Array.isArray(alternatives)) return;

    try {
      await supabase
        .from('trips')
        .update({
          alternatives_offered: alternatives,
          alternatives_sent_at: new Date().toISOString(),
        })
        .eq('id', tripId);

    } catch (err) {
      logger.error('TripMonitoring: storeAlternativesOffered threw', { tripId, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET TRIP BY BOOKING REF
  // Used by disruptionFlow.js and dashboard endpoints.
  // ─────────────────────────────────────────────────────────────
  async getTripByBookingRef(bookingRef) {
    if (!bookingRef) return null;

    try {
      const { data: trip, error } = await supabase
        .from('trips')
        .select('*')
        .eq('booking_ref', bookingRef)
        .single();

      if (error) return null;
      return trip;

    } catch (err) {
      logger.error('TripMonitoring: getTripByBookingRef threw', { bookingRef, error: err.message });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RESOLVE DISRUPTION
  // Called when the traveler picks an alternative or the issue
  // clears. Resets active_disruption, clears stored alternatives,
  // and returns health to healthy.
  // ─────────────────────────────────────────────────────────────
  async resolveDisruption(tripId, resolvedBy = 'auto') {
    if (!tripId) return;

    try {
      await supabase
        .from('trips')
        .update({
          active_disruption:    false,
          disruption_type:      null,
          disruption_detail:    null,
          alternatives_offered: null,
          alternatives_sent_at: null,
          health:               'healthy',
        })
        .eq('id', tripId);

      // Mark any open warning/critical events as resolved
      await supabase
        .from('trip_events')
        .update({ resolved: true, resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
        .eq('trip_id', tripId)
        .eq('resolved', false)
        .in('severity', ['warning', 'critical']);

      await this.logEvent(tripId, {
        event_type:  'issue_resolved',
        severity:    'info',
        title:       'Disruption resolved',
        description: `Resolved by: ${resolvedBy}`,
        resolved:    true,
      });

    } catch (err) {
      logger.error('TripMonitoring: resolveDisruption threw', { tripId, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // COMPLETE TRIP
  // Called when return_date has passed — stops monitoring.
  // ─────────────────────────────────────────────────────────────
  async completeTrip(tripId) {
    if (!tripId) return;

    try {
      await supabase
        .from('trips')
        .update({ stage: 'completed', monitoring_enabled: false })
        .eq('id', tripId);

      await this.logEvent(tripId, {
        event_type:  'stage_changed',
        severity:    'info',
        title:       'Trip completed',
        description: 'Return date passed — monitoring stopped.',
      });

    } catch (err) {
      logger.error('TripMonitoring: completeTrip threw', { tripId, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GET TRIP EVENTS (timeline)
  // Returns the event history for a trip, most recent first.
  // Used by the agency dashboard timeline view.
  // ─────────────────────────────────────────────────────────────
  async getTripEvents(tripId, { limit = 50 } = {}) {
    if (!tripId) return [];

    try {
      const { data: events, error } = await supabase
        .from('trip_events')
        .select('*')
        .eq('trip_id', tripId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        logger.error('TripMonitoring: getTripEvents failed', { tripId, error: error.message });
        return [];
      }

      return events || [];

    } catch (err) {
      logger.error('TripMonitoring: getTripEvents threw', { tripId, error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // COMPUTE CHECK INTERVAL
  // Returns the right polling frequency in minutes based on how
  // far away departure is and what stage the trip is in.
  // ─────────────────────────────────────────────────────────────
  _computeInterval(departureDate, stage = null) {
    if (stage === 'completed') return 0;
    if (stage === 'in_destination' || stage === 'returning') return INTERVALS.IN_PROGRESS;

    if (!departureDate) return INTERVALS.MORE_THAN_7_DAYS;

    const now     = Date.now();
    const depMs   = new Date(departureDate).getTime();
    const diffMs  = depMs - now;
    const diffHrs = diffMs / (1000 * 60 * 60);

    if (diffHrs <= 0)   return INTERVALS.IN_PROGRESS;      // already departed
    if (diffHrs <= 6)   return INTERVALS.WITHIN_6_HOURS;
    if (diffHrs <= 24)  return INTERVALS.WITHIN_24_HOURS;
    if (diffHrs <= 168) return INTERVALS.ONE_TO_7_DAYS;    // 7 days = 168 hours
    return INTERVALS.MORE_THAN_7_DAYS;
  }

  // ─────────────────────────────────────────────────────────────
  // INFER STAGE FROM DATES
  // Called by the cron to auto-advance trip stages without manual
  // intervention — e.g. once departure_date passes, the trip moves
  // from pre_departure to departed automatically.
  // ─────────────────────────────────────────────────────────────
  inferStage(trip) {
    const now         = new Date();
    const departure   = trip.departure_date ? new Date(trip.departure_date) : null;
    const returnDate  = trip.return_date    ? new Date(trip.return_date)    : null;

    if (!departure) return trip.stage || 'booked';

    const diffToDepMs  = departure.getTime() - now.getTime();
    const diffToDepHrs = diffToDepMs / (1000 * 60 * 60);

    if (returnDate && now > returnDate) return 'completed';

    if (departure && now > departure) {
      if (returnDate && now < returnDate) return 'in_destination';
      return 'departed';
    }

    if (diffToDepHrs <= 24) return 'pre_departure';

    return 'booked';
  }
}

module.exports = new TripMonitoringService();