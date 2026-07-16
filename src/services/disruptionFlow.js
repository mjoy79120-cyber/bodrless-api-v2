/**
 * DISRUPTION FLOW
 * ─────────────────────────────────────────────────────────────
 * Handles the full disruption response pipeline:
 *
 *   1. Detect disruption (called by cron or Duffel webhook)
 *   2. Search alternative flights on same route
 *   3. Send 2-3 options to traveler via WhatsApp with prices
 *   4. Traveler taps a choice (handled by webhooks.js tap router)
 *   5. Execute the change via Duffel order change API
 *   6. Notify hotel + transfer of new arrival time
 *   7. Log everything to trip_events
 *
 * Called by:
 *   - monitoringCron.js → handleFlightDisruption()
 *   - duffelWebhooks.js → handleWebhookEvent()
 *   - webhooks.js → handleDisruptionTap() (traveler reply)
 * ─────────────────────────────────────────────────────────────
 */

const { logger } = require('../utils/logger');
const supabase = require('../utils/supabase');
const whatsappService = require('./whatsapp');
const notificationService = require('./notifications');
const tripMonitoringService = require('./tripMonitoringService');
const duffel = require('../adapters/duffel');

// Lazy-load supplierAdapter to avoid circular dependency issues
let supplierAdapter = null;
const getSupplierAdapter = () => {
  if (!supplierAdapter) {
    try { supplierAdapter = require('../adapters'); } catch (e) {
      logger.warn('DisruptionFlow: supplierAdapter not available', { error: e.message });
    }
  }
  return supplierAdapter;
};

// Max alternatives to offer the traveler — WhatsApp buttons are
// capped at 3, so never offer more than 3 flight options + the
// "keep original" option. We use sendList (up to 10 rows) here
// since we need 4 options total (3 alternatives + keep original).
const MAX_ALTERNATIVES = 3;

class DisruptionFlow {

  // ─────────────────────────────────────────────────────────────
  // HANDLE FLIGHT DISRUPTION
  // Entry point called when a disruption is confirmed — whether
  // from a Duffel webhook or an AeroDataBox poll.
  //
  // trip:           the trips table row
  // disruptionInfo: normalized status from flightStatusService
  //                 OR Duffel webhook payload (both normalized
  //                 to the same shape by their respective callers)
  // ─────────────────────────────────────────────────────────────
  async handleFlightDisruption(trip, disruptionInfo) {
    if (!trip?.id) return;

    logger.warn('DisruptionFlow: handling flight disruption', {
      tripId:         trip.id,
      bookingRef:     trip.booking_ref,
      disruptionType: disruptionInfo.disruptionType,
      flightNumber:   disruptionInfo.flightNumber,
      delayMinutes:   disruptionInfo.delayMinutes,
    });

    // 1. Update trip health to attention/critical
    const health = disruptionInfo.isCancelled ? 'critical' : 'attention';
    await tripMonitoringService.updateHealth(trip.id, health, {
      active_disruption: true,
      disruption_type:   disruptionInfo.disruptionType,
      disruption_detail: disruptionInfo,
    });

    // 2. Log the disruption event
    const summary = this._formatDisruptionSummary(disruptionInfo);
    await tripMonitoringService.logEvent(trip.id, {
      event_type:  `flight_${disruptionInfo.disruptionType || 'disrupted'}`,
      severity:    disruptionInfo.isCancelled ? 'critical' : 'warning',
      title:       summary,
      description: this._formatDisruptionDetail(disruptionInfo),
      metadata:    disruptionInfo,
    });

    // 3. Get agency phone number for sending WhatsApp
    const agencyPhoneNumberId = await this._getAgencyPhoneId(trip.agency_id);

    // 4. Immediately notify the traveler about the disruption
    //    (don't wait for alternatives — they need to know NOW)
    if (trip.guest_phone && agencyPhoneNumberId) {
      await this._sendInitialDisruptionAlert(trip, disruptionInfo, agencyPhoneNumberId);
      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'traveler_notified',
        severity:    'info',
        title:       'Traveler notified of disruption',
        description: `Sent via WhatsApp to ${trip.guest_phone}`,
      });
    }

    // 5. Search for alternative flights
    const alternatives = await this._searchAlternatives(trip, disruptionInfo);

    if (alternatives.length > 0) {
      // 6. Send alternatives to traveler
      await this._sendAlternativesToTraveler(trip, alternatives, disruptionInfo, agencyPhoneNumberId);

      // 7. Store alternatives so the tap handler can look them up
      await tripMonitoringService.storeAlternativesOffered(trip.id, alternatives);

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'alternative_offered',
        severity:    'info',
        title:       `${alternatives.length} alternative flight(s) offered to traveler`,
        description: alternatives.map(a => `${a.airline} ${a.flightNumber} — ${a.departureTime} (${a.currency} ${a.price?.toLocaleString()})`).join('; '),
        metadata:    { alternatives },
      });
    } else {
      // No alternatives found — notify traveler and escalate to agency
      await this._sendNoAlternativesAlert(trip, disruptionInfo, agencyPhoneNumberId);

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'no_alternatives_found',
        severity:    'warning',
        title:       'No alternative flights found — agency notified',
        description: `Could not find alternatives on ${trip.origin} → ${trip.destination} for ${trip.departure_date}`,
      });
    }

    // 8. Notify hotel and transfer of potential delay/cancellation
    await this._notifySuppliers(trip, disruptionInfo, agencyPhoneNumberId);

    // 9. Notify agency ops
    await this._notifyAgency(trip, disruptionInfo, alternatives, agencyPhoneNumberId);
  }

  // ─────────────────────────────────────────────────────────────
  // HANDLE TRAVELER TAP (alternative selected)
  // Called by webhooks.js when the traveler taps one of the
  // "Option 1 / Option 2 / Keep original" buttons.
  //
  // tapId format: 'disruption_alt_{tripId}_{altIndex}'
  //               'disruption_keep_{tripId}'
  // ─────────────────────────────────────────────────────────────
  async handleAlternativeTap(tapId, phone) {
    if (!tapId) return null;

    // Parse tap ID
    const keepMatch = tapId.match(/^disruption_keep_(.+)$/);
    const altMatch  = tapId.match(/^disruption_alt_(.+?)_(\d+)$/);

    if (!keepMatch && !altMatch) return null;

    const tripId   = keepMatch ? keepMatch[1] : altMatch[1];
    const altIndex = altMatch  ? parseInt(altMatch[2], 10) : null;

    const trip = await supabase
      .from('trips')
      .select('*')
      .eq('id', tripId)
      .single()
      .then(r => r.data);

    if (!trip) {
      logger.warn('DisruptionFlow: tap received for unknown trip', { tapId, tripId });
      return null;
    }

    const agencyPhoneNumberId = await this._getAgencyPhoneId(trip.agency_id);

    // Traveler chose to keep original flight
    if (keepMatch) {
      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'traveler_chose_original',
        severity:    'info',
        title:       'Traveler chose to keep original flight',
        metadata:    { tapId, phone },
      });

      if (trip.guest_phone && agencyPhoneNumberId) {
        await whatsappService.sendText(agencyPhoneNumberId, trip.guest_phone,
          `Understood — we'll keep your original booking as-is. We'll continue monitoring and let you know of any further changes. Safe travels! ✈️`
        );
      }

      await tripMonitoringService.resolveDisruption(trip.id, 'traveler');
      return { action: 'kept_original', tripId };
    }

    // Traveler chose an alternative flight
    const alternatives = trip.alternatives_offered || [];
    const chosen = alternatives[altIndex];

    if (!chosen) {
      logger.warn('DisruptionFlow: tap index out of range', { tapId, altIndex, availableCount: alternatives.length });
      return null;
    }

    await tripMonitoringService.logEvent(trip.id, {
      event_type:  'traveler_chose_alternative',
      severity:    'info',
      title:       `Traveler selected alternative ${altIndex + 1}: ${chosen.airline} ${chosen.flightNumber}`,
      metadata:    { chosen, altIndex },
    });

    // Confirm with traveler — tell them we're executing the change
    if (trip.guest_phone && agencyPhoneNumberId) {
      await whatsappService.sendText(agencyPhoneNumberId, trip.guest_phone,
        `Got it! 👍 Switching you to ${chosen.airline} ${chosen.flightNumber}, departing ${this._formatTime(chosen.departureTime)}.\n\nExecuting the change now — I'll confirm once it's done.`
      );
    }

    // Execute the change via Duffel (only for Duffel bookings)
    if (trip.supplier === 'duffel' && trip.supplier_order_id) {
      return this._executeDuffelChange(trip, chosen, agencyPhoneNumberId);
    }

    // Non-Duffel: route to agency for manual execution
    await this._escalateToAgency(trip, chosen, agencyPhoneNumberId);
    return { action: 'escalated_to_agency', tripId, chosen };
  }

  // ─────────────────────────────────────────────────────────────
  // EXECUTE DUFFEL CHANGE
  // Full Duffel order change flow (already built in duffel.js):
  //   requestOrderChange → createOrderChange → confirmOrderChange
  // ─────────────────────────────────────────────────────────────
  async _executeDuffelChange(trip, chosen, agencyPhoneNumberId) {
    try {
      logger.info('DisruptionFlow: executing Duffel order change', {
        tripId: trip.id, orderId: trip.supplier_order_id, chosen: chosen.flightNumber,
      });

      // Step 1: Get current order state to get the slice ID to replace
      const currentOrder = await duffel.getOrder(trip.supplier_order_id);
      if (!currentOrder?.sliceId) {
        throw new Error('Could not retrieve current order slice ID for change request');
      }

      // Step 2: Request change — this returns offers (Duffel's options)
      const changeRequest = await duffel.requestOrderChange({
        orderId:           trip.supplier_order_id,
        removeSliceId:     currentOrder.sliceId,
        addOrigin:         chosen.originIata || trip.origin,
        addDestination:    chosen.destIata   || trip.destination,
        addDepartureDate:  chosen.departureDate || trip.departure_date,
        cabinClass:        chosen.cabinClass || 'economy',
      });

      // Find the offer that matches our chosen flight
      // (Duffel may return multiple options — pick the cheapest
      // or the one matching the flight number exactly)
      const matchingOffer = this._matchDuffelOffer(changeRequest.offers, chosen);
      if (!matchingOffer) {
        throw new Error(`No matching Duffel offer found for ${chosen.airline} ${chosen.flightNumber}`);
      }

      // Step 3: Create the pending change
      const pendingChange = await duffel.createOrderChange(matchingOffer.offerId);
      if (!pendingChange?.changeId) {
        throw new Error('createOrderChange did not return a changeId');
      }

      // Step 4: Confirm the change
      // BUG NOTE (from session summary): confirmOrderChange understates
      // the real total by the penalty amount — re-fetch via getOrder()
      // after confirming for the accurate new total.
      const confirmed = await duffel.confirmOrderChange({
        changeId:             pendingChange.changeId,
        changeTotalAmount:    matchingOffer.changeTotalAmount,
        changeTotalCurrency:  matchingOffer.changeTotalCurrency,
      });

      // Re-fetch to get accurate post-change total
      const updatedOrder = await duffel.getOrder(trip.supplier_order_id);

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'change_executed',
        severity:    'info',
        title:       `Flight changed to ${chosen.airline} ${chosen.flightNumber}`,
        description: `Change confirmed. New total: ${updatedOrder?.currency} ${updatedOrder?.totalAmount?.toLocaleString()}`,
        metadata:    { changeId: pendingChange.changeId, confirmed, updatedOrder },
      });

      // Notify traveler with confirmation
      if (trip.guest_phone && agencyPhoneNumberId) {
        await whatsappService.sendText(agencyPhoneNumberId, trip.guest_phone,
          `✅ *Flight change confirmed!*\n\n` +
          `*New flight:* ${chosen.airline} ${chosen.flightNumber}\n` +
          `*Departs:* ${this._formatTime(chosen.departureTime)}\n` +
          `*Arrives:* ${this._formatTime(chosen.arrivalTime)}\n\n` +
          `Your hotel and transfer have been notified of your updated arrival time.\n\n` +
          `New booking total: ${updatedOrder?.currency || 'KES'} ${updatedOrder?.totalAmount?.toLocaleString() || 'TBC'}\n\n` +
          `Questions? Reply to this message. ✈️`
        );
      }

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'traveler_notified',
        severity:    'info',
        title:       'Traveler notified of confirmed flight change',
      });

      // Notify hotel and transfer of new arrival time
      await this._notifySupplierOfChange(trip, chosen, agencyPhoneNumberId);

      // Resolve disruption — trip is healthy again
      await tripMonitoringService.resolveDisruption(trip.id, 'auto');

      return { action: 'change_executed', tripId: trip.id, chosen, confirmed };

    } catch (err) {
      logger.error('DisruptionFlow: Duffel change execution failed', {
        tripId: trip.id, error: err.message,
      });

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'change_failed',
        severity:    'critical',
        title:       'Automatic flight change failed — escalated to agency',
        description: err.message,
        metadata:    { error: err.message, chosen },
      });

      // Auto-escalate to agency on failure
      await this._escalateToAgency(trip, chosen, agencyPhoneNumberId, err.message);

      if (trip.guest_phone && agencyPhoneNumberId) {
        await whatsappService.sendText(agencyPhoneNumberId, trip.guest_phone,
          `We hit an issue processing your flight change automatically. Don't worry — your agency has been notified and will confirm your new booking within the hour. Apologies for the inconvenience! 🙏`
        );
      }

      return { action: 'change_failed', tripId: trip.id, error: err.message };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SEARCH ALTERNATIVES
  // Uses the existing engine search infrastructure to find
  // alternatives on the same route. Returns up to MAX_ALTERNATIVES.
  // ─────────────────────────────────────────────────────────────
  async _searchAlternatives(trip, disruptionInfo) {
    const adapter = getSupplierAdapter();
    if (!adapter) return [];

    const searchDate = trip.departure_date;
    if (!searchDate || !trip.origin || !trip.destination) {
      logger.warn('DisruptionFlow: cannot search alternatives — missing trip route info', { tripId: trip.id });
      return [];
    }

    try {
      logger.info('DisruptionFlow: searching for alternatives', {
        tripId: trip.id,
        route:  `${trip.origin} → ${trip.destination}`,
        date:   searchDate,
      });

      const results = await Promise.race([
        adapter.searchTransport({
          origin:        trip.origin,
          destination:   trip.destination,
          date:          searchDate,
          passengers:    1,
          transportMode: 'flight',
        }),
        // 15s timeout — don't hold up the cron indefinitely
        new Promise(resolve => setTimeout(() => resolve([]), 15000)),
      ]);

      if (!Array.isArray(results) || results.length === 0) return [];

      // Filter out the disrupted flight itself and sort by price
      const disruptedFlightNumber = (disruptionInfo.flightNumber || '').toUpperCase();

      return results
        .filter(f => {
          const fn = String(f.flightNumber || '').toUpperCase();
          return fn !== disruptedFlightNumber && f.price > 0;
        })
        .sort((a, b) => (a.price || 0) - (b.price || 0))
        .slice(0, MAX_ALTERNATIVES)
        .map((f, i) => ({
          index:         i,
          supplier:      f.supplier,
          offerId:       f.offerId,
          resultId:      f.resultId,
          airline:       f.airline || f.provider || 'Unknown',
          airlineCode:   f.airlineCode || null,
          flightNumber:  f.flightNumber || null,
          origin:        f.origin,
          destination:   f.destination,
          originIata:    f.originIata,
          destIata:      f.destIata,
          departureTime: f.departureTime,
          arrivalTime:   f.arrivalTime,
          departureDate: searchDate,
          price:         f.price,
          currency:      f.currency || 'KES',
          cabinClass:    f.cabinClass || 'Economy',
          stops:         f.stops || 0,
          isRefundable:  f.isRefundable ?? null,
          canHold:       f.canHold || false,
        }));

    } catch (err) {
      logger.error('DisruptionFlow: alternative search failed', { tripId: trip.id, error: err.message });
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // SEND INITIAL DISRUPTION ALERT
  // Immediate notification — sent BEFORE alternatives are ready
  // so the traveler isn't kept waiting while we search.
  // ─────────────────────────────────────────────────────────────
  async _sendInitialDisruptionAlert(trip, disruptionInfo, agencyPhoneNumberId) {
    const summary = this._formatDisruptionSummary(disruptionInfo);

    const message = disruptionInfo.isCancelled
      ? `⚠️ *Flight Update — ${trip.booking_ref}*\n\n` +
        `${summary}\n\n` +
        `We're searching for alternative flights right now and will send you options in a moment. Stand by! 🔍`
      : `⚠️ *Flight Update — ${trip.booking_ref}*\n\n` +
        `${summary}\n\n` +
        `We're checking alternative options for you. You'll hear from us shortly.`;

    await whatsappService.sendText(agencyPhoneNumberId, trip.guest_phone, message);
  }

  // ─────────────────────────────────────────────────────────────
  // SEND ALTERNATIVES TO TRAVELER
  // Sends a WhatsApp list message with up to 3 alternatives plus
  // a "keep original" option. Uses list messages (up to 10 rows)
  // not buttons (capped at 3) so we can include all options + keep.
  //
  // Tap IDs are structured so webhooks.js can route them back here:
  //   disruption_alt_{tripId}_{index}
  //   disruption_keep_{tripId}
  // ─────────────────────────────────────────────────────────────
  async _sendAlternativesToTraveler(trip, alternatives, disruptionInfo, agencyPhoneNumberId) {
    if (!trip.guest_phone || !agencyPhoneNumberId) return;

    const intro = disruptionInfo.isCancelled
      ? `Here are the next available flights on your route:`
      : `Here are some alternative options if you'd prefer to avoid the delay:`;

    const options = alternatives.map((alt, i) => ({
      id:          `disruption_alt_${trip.id}_${i}`,
      title:       `${alt.airline} ${alt.flightNumber || ''} · ${this._formatShortTime(alt.departureTime)}`.slice(0, 24),
      description: `${alt.currency} ${(alt.price || 0).toLocaleString()} · ${alt.stops === 0 ? 'Direct' : alt.stops + ' stop(s)'}`.slice(0, 72),
    }));

    // Always add "keep original" unless the flight is cancelled
    if (!disruptionInfo.isCancelled) {
      options.push({
        id:          `disruption_keep_${trip.id}`,
        title:       `Keep original flight`.slice(0, 24),
        description: `Stay on ${disruptionInfo.flightNumber} as booked`.slice(0, 72),
      });
    }

    await whatsappService.sendList(
      agencyPhoneNumberId,
      trip.guest_phone,
      `✈️ *Alternative Flights — ${trip.booking_ref}*\n\n${intro}\n\nTap an option below:`,
      'View options',
      options
    );
  }

  // ─────────────────────────────────────────────────────────────
  // SEND NO ALTERNATIVES ALERT
  // ─────────────────────────────────────────────────────────────
  async _sendNoAlternativesAlert(trip, disruptionInfo, agencyPhoneNumberId) {
    if (!trip.guest_phone || !agencyPhoneNumberId) return;

    const summary = this._formatDisruptionSummary(disruptionInfo);

    await whatsappService.sendText(agencyPhoneNumberId, trip.guest_phone,
      `⚠️ *Flight Update — ${trip.booking_ref}*\n\n` +
      `${summary}\n\n` +
      `We weren't able to find available alternatives automatically right now. Your agency has been alerted and will reach out to you directly to sort this out. We're on it! 💪`
    );
  }

  // ─────────────────────────────────────────────────────────────
  // NOTIFY SUPPLIERS OF ORIGINAL DISRUPTION
  // Tells hotel and arrival transfer that the guest's arrival
  // time may change. Done immediately on disruption detection —
  // don't wait for the traveler to pick an alternative.
  // ─────────────────────────────────────────────────────────────
  async _notifySuppliers(trip, disruptionInfo, agencyPhoneNumberId) {
    if (!trip.booking_ref) return;

    // Fetch full booking to get hotel and transfer supplier details
    try {
      const { data: booking } = await supabase
        .from('bookings')
        .select('flight_details, hotel_details, transfer_details, guest_name, passengers')
        .eq('booking_ref', trip.booking_ref)
        .single();

      if (!booking) return;

      const hotel     = booking.hotel_details    || null;
      const transfers = booking.transfer_details || null;

      const delay = disruptionInfo.delayMinutes || 0;
      const newArrivalTime = disruptionInfo.arrival?.revisedTime || null;

      // notificationService already handles the hotel/transfer
      // notification logic correctly — reuse it
      if (disruptionInfo.isDelayed && delay > 0) {
        await notificationService.notifyFlightDelay({
          booking: {
            bookingRef:  trip.booking_ref,
            agencyId:    trip.agency_id,
            guestName:   trip.guest_name,
            guestPhone:  trip.guest_phone,
            passengers:  booking.passengers || 1,
          },
          flight:         booking.flight_details,
          hotel:          hotel,
          transfers:      transfers,
          delayMinutes:   delay,
          newArrivalTime: newArrivalTime,
        });
      }

      if (hotel || transfers) {
        await tripMonitoringService.logEvent(trip.id, {
          event_type:  'hotel_notified',
          severity:    'info',
          title:       'Hotel and transfer notified of potential arrival change',
          description: `Delay: ${delay} minutes. New arrival: ${newArrivalTime || 'TBC'}`,
        });
      }

    } catch (err) {
      logger.error('DisruptionFlow: _notifySuppliers failed', { tripId: trip.id, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // NOTIFY SUPPLIERS OF CONFIRMED CHANGE
  // Called AFTER a flight change is successfully executed —
  // tells hotel and transfer the new confirmed arrival time.
  // ─────────────────────────────────────────────────────────────
  async _notifySupplierOfChange(trip, newFlight, agencyPhoneNumberId) {
    try {
      const { data: booking } = await supabase
        .from('bookings')
        .select('hotel_details, transfer_details, flight_details, guest_name, passengers')
        .eq('booking_ref', trip.booking_ref)
        .single();

      if (!booking) return;

      const hotel     = booking.hotel_details    || null;
      const transfers = booking.transfer_details || null;
      const origFlight = booking.flight_details  || {};

      const delayMinutes = this._minutesDiff(origFlight.arrivalTime, newFlight.arrivalTime);

      if ((hotel || transfers) && delayMinutes !== null) {
        await notificationService.notifyFlightDelay({
          booking: {
            bookingRef:  trip.booking_ref,
            agencyId:    trip.agency_id,
            guestName:   trip.guest_name,
            guestPhone:  trip.guest_phone,
            passengers:  booking.passengers || 1,
          },
          flight:         origFlight,
          hotel,
          transfers,
          delayMinutes,
          newArrivalTime: newFlight.arrivalTime,
        });
      }

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'hotel_notified',
        severity:    'info',
        title:       'Hotel and transfer notified of confirmed new arrival time',
        description: `New flight: ${newFlight.airline} ${newFlight.flightNumber}, arrives ${newFlight.arrivalTime}`,
      });

    } catch (err) {
      logger.error('DisruptionFlow: _notifySupplierOfChange failed', { tripId: trip.id, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // NOTIFY AGENCY
  // Keeps the ops team informed on everything — disruption,
  // alternatives offered, what the traveler chose.
  // ─────────────────────────────────────────────────────────────
  async _notifyAgency(trip, disruptionInfo, alternatives, agencyPhoneNumberId) {
    try {
      const { data: agency } = await supabase
        .from('agencies')
        .select('ops_whatsapp_number')
        .eq('id', trip.agency_id)
        .single();

      const opsNumber = agency?.ops_whatsapp_number;
      if (!opsNumber || !agencyPhoneNumberId) return;

      const altSummary = alternatives.length > 0
        ? alternatives.map((a, i) => `  ${i + 1}. ${a.airline} ${a.flightNumber} — ${this._formatShortTime(a.departureTime)} (${a.currency} ${(a.price || 0).toLocaleString()})`).join('\n')
        : '  No alternatives found automatically';

      const summary = this._formatDisruptionSummary(disruptionInfo);

      const message =
        `⚠️ *Trip Disruption — ${trip.booking_ref}*\n\n` +
        `*Guest:* ${trip.guest_name}\n` +
        `*Route:* ${trip.origin} → ${trip.destination}\n` +
        `*Date:* ${trip.departure_date}\n\n` +
        `*Disruption:* ${summary}\n\n` +
        `*Alternatives offered to traveler:*\n${altSummary}\n\n` +
        `Traveler has been notified via WhatsApp and is selecting an option. You'll get another update once they choose.`;

      await whatsappService.sendText(agencyPhoneNumberId, opsNumber, message);

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'agency_notified',
        severity:    'info',
        title:       'Agency ops team notified',
      });

    } catch (err) {
      logger.error('DisruptionFlow: _notifyAgency failed', { tripId: trip.id, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ESCALATE TO AGENCY (manual execution needed)
  // For non-Duffel bookings or when Duffel change fails.
  // ─────────────────────────────────────────────────────────────
  async _escalateToAgency(trip, chosen, agencyPhoneNumberId, errorReason = null) {
    try {
      const { data: agency } = await supabase
        .from('agencies')
        .select('ops_whatsapp_number')
        .eq('id', trip.agency_id)
        .single();

      const opsNumber = agency?.ops_whatsapp_number;
      if (!opsNumber || !agencyPhoneNumberId) return;

      const message =
        `🔴 *Manual Action Required — ${trip.booking_ref}*\n\n` +
        `*Guest:* ${trip.guest_name} (${trip.guest_phone})\n` +
        `*Route:* ${trip.origin} → ${trip.destination}\n\n` +
        `*Traveler selected:*\n` +
        `  ${chosen.airline} ${chosen.flightNumber}\n` +
        `  Departs: ${this._formatTime(chosen.departureTime)}\n` +
        `  Price: ${chosen.currency} ${(chosen.price || 0).toLocaleString()}\n\n` +
        (errorReason ? `*Auto-change failed:* ${errorReason}\n\n` : '') +
        `Please action this change manually and confirm with the traveler.`;

      await whatsappService.sendText(agencyPhoneNumberId, opsNumber, message);

      await tripMonitoringService.logEvent(trip.id, {
        event_type:  'agency_notified',
        severity:    'warning',
        title:       'Escalated to agency for manual flight change',
        description: errorReason || 'Non-Duffel booking requires manual change',
        metadata:    { chosen },
      });

    } catch (err) {
      logger.error('DisruptionFlow: _escalateToAgency failed', { tripId: trip.id, error: err.message });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MATCH DUFFEL OFFER
  // Finds the Duffel order change offer that best matches the
  // alternative the traveler chose. Matches on flight number first,
  // then falls back to cheapest offer on the right route.
  // ─────────────────────────────────────────────────────────────
  _matchDuffelOffer(duffelOffers, chosen) {
    if (!Array.isArray(duffelOffers) || duffelOffers.length === 0) return null;

    // Try exact flight number match first
    if (chosen.flightNumber) {
      const exact = duffelOffers.find(o =>
        String(o.flightNumber || '').toUpperCase() === chosen.flightNumber.toUpperCase()
      );
      if (exact) return exact;
    }

    // Fall back to cheapest offer (already sorted in _normalizeOrderChangeRequest)
    return duffelOffers[0];
  }

  // ─────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────
  async _getAgencyPhoneId(agencyId) {
    if (!agencyId) return null;
    try {
      const { data } = await supabase
        .from('agencies')
        .select('whatsapp_phone_number_id')
        .eq('id', agencyId)
        .single();
      return data?.whatsapp_phone_number_id || null;
    } catch {
      return null;
    }
  }

  _formatDisruptionSummary(disruptionInfo) {
    const fn = disruptionInfo.flightNumber || 'Your flight';

    if (disruptionInfo.isCancelled) {
      return `Flight ${fn} has been cancelled.`;
    }

    if (disruptionInfo.isDiverted) {
      return `Flight ${fn} has been diverted.`;
    }

    if (disruptionInfo.isDelayed || disruptionInfo.delayMinutes > 0) {
      const mins  = disruptionInfo.delayMinutes || 0;
      const hrs   = Math.floor(mins / 60);
      const rem   = mins % 60;
      const label = hrs > 0 ? `${hrs}h${rem > 0 ? ` ${rem}m` : ''}` : `${mins}m`;
      const newTime = disruptionInfo.departure?.revisedTime
        ? ` New departure: ${this._formatTime(disruptionInfo.departure.revisedTime)}.`
        : '';
      return `Flight ${fn} is delayed by ${label}.${newTime}`;
    }

    return `Flight ${fn} status update: ${disruptionInfo.rawStatus || 'change detected'}.`;
  }

  _formatDisruptionDetail(disruptionInfo) {
    const lines = [];
    if (disruptionInfo.departure?.scheduledTime) lines.push(`Scheduled: ${this._formatTime(disruptionInfo.departure.scheduledTime)}`);
    if (disruptionInfo.departure?.revisedTime)   lines.push(`Revised:   ${this._formatTime(disruptionInfo.departure.revisedTime)}`);
    if (disruptionInfo.departure?.gate)          lines.push(`Gate: ${disruptionInfo.departure.gate}`);
    return lines.join(' · ') || null;
  }

  _formatTime(isoString) {
    if (!isoString) return 'TBC';
    try {
      return new Date(isoString).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return isoString;
    }
  }

  _formatShortTime(isoString) {
    if (!isoString) return 'TBC';
    // For bare "HH:MM" strings (SGR static entries) — return as-is
    if (/^\d{1,2}:\d{2}$/.test(String(isoString))) return isoString;
    return this._formatTime(isoString);
  }

  _minutesDiff(isoA, isoB) {
    if (!isoA || !isoB) return null;
    try {
      const msA = new Date(isoA).getTime();
      const msB = new Date(isoB).getTime();
      if (isNaN(msA) || isNaN(msB)) return null;
      return Math.round((msB - msA) / (1000 * 60));
    } catch {
      return null;
    }
  }
}

module.exports = new DisruptionFlow();