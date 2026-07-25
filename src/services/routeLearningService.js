/**
 * ROUTE LEARNING SERVICE
 * ─────────────────────────────────────────────────────────────
 * The Waze layer for Bodrless.
 *
 * Every search writes an outcome. Outcomes build confidence scores.
 * Confidence scores tell the engine which APIs to call and which
 * to skip. Compound routes fill the gaps APIs can't cover.
 *
 * Integration points in orchestrationEngine.js:
 *
 *   // 1. BEFORE search — get hints
 *   const hints = await routeLearning.lookupRoutes(origin, destination, budget);
 *   if (hints.skipFlight) { ... skip duffel ... }
 *   if (hints.compoundRoutes.length) { ... show compound options ... }
 *   if (hints.optimalRadius) { ... pass to hotelbeds ... }
 *
 *   // 2. AFTER each supplier search — log outcome
 *   await routeLearning.logOutcome({ origin, destination, mode, supplier, resultsCount, agencyId, phone });
 *
 *   // 3. AFTER traveler selects — log selection
 *   await routeLearning.logSelection({ origin, destination, mode, supplier, selectedOption });
 * ─────────────────────────────────────────────────────────────
 */

const supabase      = require('../utils/supabase');
const { logger }    = require('../utils/logger');

// Confidence below this → skip supplier call for this route
const SKIP_THRESHOLD = 0.15;

// Zero-result streak above this → trigger radius autotune for hotels
const AUTOTUNE_TRIGGER = 3;

// Radius steps for hotel autotune (km)
const RADIUS_STEPS = [20, 30, 50, 80, 120];

class RouteLearningService {

  // ═════════════════════════════════════════════════════════════
  // BEFORE SEARCH
  // ═════════════════════════════════════════════════════════════

  /**
   * Main entry point before any search.
   * Returns hints the engine uses to decide which APIs to call.
   *
   * Always returns a safe object — never throws, never blocks engine.
   */
  async lookupRoutes(origin, destination, budget = null) {
    try {
      const [routes, confidence, compoundRoutes] = await Promise.all([
        this._getDirectRoutes(origin, destination),
        this._getConfidence(origin, destination),
        this._getCompoundRoutes(origin, destination, budget),
      ]);

      const hints = {
        // What we know exists
        hasKnownFlightRoute: this._hasRoute(routes, 'flight'),
        hasKnownBusRoute:    this._hasRoute(routes, 'bus'),
        hasKnownTrainRoute:  this._hasRoute(routes, 'train'),
        hasKnownFerryRoute:  this._hasRoute(routes, 'ferry'),

        // Skip flags — confidence too low, don't waste the API call
        skipFlight: this._shouldSkip(confidence, 'flight'),
        skipBus:    this._shouldSkip(confidence, 'bus'),
        skipTrain:  this._shouldSkip(confidence, 'train'),

        // Hotel radius — auto-tuned from past searches
        optimalRadius: this._getOptimalRadius(confidence),

        // Compound routes — multi-leg itineraries APIs can't return
        compoundRoutes,

        // Raw for engine decisions
        routes,
        confidence,
      };

      if (hints.skipFlight || hints.compoundRoutes.length > 0 || hints.optimalRadius) {
        logger.info('RouteLearning: hints generated', {
          origin, destination,
          skipFlight:    hints.skipFlight,
          compoundCount: hints.compoundRoutes.length,
          optimalRadius: hints.optimalRadius,
        });
      }

      return hints;

    } catch (err) {
      logger.error('RouteLearning: lookupRoutes threw', { origin, destination, error: err.message });
      // Never block the engine
      return {
        hasKnownFlightRoute: false, hasKnownBusRoute: false,
        hasKnownTrainRoute: false,  hasKnownFerryRoute: false,
        skipFlight: false, skipBus: false, skipTrain: false,
        optimalRadius: null, compoundRoutes: [], routes: [], confidence: [],
      };
    }
  }

  // ═════════════════════════════════════════════════════════════
  // AFTER SEARCH — log what happened
  // ═════════════════════════════════════════════════════════════

  /**
   * Log a search outcome. Call after every supplier search.
   * Never throws — logging must not break searches.
   */
  async logOutcome({
    origin, destination, mode, supplier,
    resultsCount = 0, radiusUsed = null,
    resolvedAs = null, agencyId = null,
    phone = null, error = null, durationMs = null,
  }) {
    try {
      const success = resultsCount > 0;
      const normOrigin = this._normalize(origin);
      const normDest   = this._normalize(destination);

      // Write raw outcome
      await supabase.from('search_outcomes').insert({
        origin:         normOrigin,
        destination:    normDest,
        transport_mode: mode,
        supplier,
        results_count:  resultsCount,
        radius_used:    radiusUsed,
        resolved_as:    resolvedAs,
        agency_id:      agencyId,
        phone:          phone ? this._hashPhone(phone) : null,
        error,
        duration_ms:    durationMs,
        searched_at:    new Date().toISOString(),
      });

      // Update aggregate confidence
      await supabase.rpc('update_route_confidence', {
        p_origin:      normOrigin,
        p_destination: normDest,
        p_mode:        mode,
        p_supplier:    supplier,
        p_success:     success,
        p_radius:      radiusUsed,
      });

      // Check hotel autotune
      if (mode === 'hotel' && !success) {
        await this._checkAutotune(destination, supplier, radiusUsed);
      }

      // Update routes table stats
      await this._updateRouteStats(normOrigin, normDest, mode, success);

    } catch (err) {
      logger.error('RouteLearning: logOutcome threw', { origin, destination, error: err.message });
    }
  }

  /**
   * Log that a traveler selected a specific option.
   * Tracks which results get picked — surfaces best options first.
   */
  async logSelection({ origin, destination, mode, supplier, selectedOption }) {
    try {
      await supabase
        .from('route_confidence')
        .update({
          times_shown:    supabase.raw('times_shown + 1'),
          times_selected: supabase.raw('times_selected + 1'),
          selection_rate: supabase.raw('(times_selected + 1)::numeric / NULLIF(times_shown + 1, 0)'),
          last_updated_at: new Date().toISOString(),
        })
        .eq('origin',         this._normalize(origin))
        .eq('destination',    this._normalize(destination))
        .eq('transport_mode', mode)
        .eq('supplier',       supplier);
    } catch (err) {
      logger.error('RouteLearning: logSelection threw', { origin, destination, error: err.message });
    }
  }

  // ═════════════════════════════════════════════════════════════
  // COMPOUND ROUTE FORMATTER
  // ═════════════════════════════════════════════════════════════

  /**
   * Format a compound route for WhatsApp display.
   */
  formatCompoundRoute(route) {
    const legs  = route.route_legs || [];
    const lines = [];

    const modeEmoji = {
      flight: '✈️', bus: '🚌', train: '🚆',
      ferry: '⛵', transfer: '🚕', matatu: '🚐',
    };

    lines.push(`*${route.origin} → ${route.destination}*`);
    if (route.notes) lines.push(`_${route.notes}_`);
    lines.push('');

    for (const leg of legs) {
      const emoji    = modeEmoji[leg.transport_mode] || '🚗';
      const provider = leg.providers?.[0] || '';
      const price    = leg.price_kes_min
        ? `KES ${leg.price_kes_min.toLocaleString()}–${(leg.price_kes_max || leg.price_kes_min).toLocaleString()}`
        : 'Price on arrival';
      const mins     = leg.duration_mins;
      const duration = mins
        ? `${Math.floor(mins / 60)}h${mins % 60 > 0 ? ` ${mins % 60}m` : ''}`
        : '';

      lines.push(`${emoji} *${leg.from_place} → ${leg.to_place}*`);
      if (provider) lines.push(`   ${provider}${duration ? ` · ${duration}` : ''}`);
      if (leg.departs) lines.push(`   Departs: ${leg.departs}`);
      lines.push(`   ${price}`);
      if (leg.notes) lines.push(`   _${leg.notes}_`);
      lines.push('');
    }

    const minTotal = route.totalPriceMin || 0;
    const maxTotal = route.totalPriceMax || 0;
    lines.push(`💰 *Transport: KES ${minTotal.toLocaleString()}–${maxTotal.toLocaleString()}*`);
    lines.push(`_(hotels not included above — search will add accommodation)_`);

    return lines.join('\n');
  }

  // ═════════════════════════════════════════════════════════════
  // ADMIN — seed and manage routes
  // ═════════════════════════════════════════════════════════════

  /**
   * Seed a route. Used by adminSeed.js and the admin dashboard.
   * Safe to call repeatedly — upserts on conflict.
   */
  async seedRoute({
    origin, destination, routeType = 'direct',
    transportMode, budgetTier = 'all',
    providers = [], priceKesMin, priceKesMax,
    frequency, departs, durationHours,
    bookingMethod = 'api', supplier = null,
    notes, confidence = 0.85, legs = [],
  }) {
    try {
      const { data: route, error } = await supabase
        .from('routes')
        .upsert({
          origin:          this._normalize(origin),
          destination:     this._normalize(destination),
          route_type:      routeType,
          transport_mode:  transportMode,
          budget_tier:     budgetTier,
          providers,
          price_kes_min:   priceKesMin,
          price_kes_max:   priceKesMax,
          frequency,
          departs,
          duration_hours:  durationHours,
          booking_method:  bookingMethod,
          supplier,
          notes,
          confidence,
          source:          'admin_seed',
          verified:        true,
          verified_at:     new Date().toISOString(),
          updated_at:      new Date().toISOString(),
        }, { onConflict: 'origin,destination,transport_mode,budget_tier' })
        .select()
        .single();

      if (error) {
        logger.error('RouteLearning: seedRoute failed', { origin, destination, error: error.message });
        return null;
      }

      // Insert compound legs
      if (legs.length > 0 && route?.id) {
        // Delete old legs first to avoid duplicates on re-seed
        await supabase.from('route_legs').delete().eq('route_id', route.id);

        const legRows = legs.map((leg, i) => ({
          route_id:       route.id,
          leg_order:      i + 1,
          from_place:     leg.from,
          to_place:       leg.to,
          transport_mode: leg.mode,
          providers:      leg.providers || [],
          price_kes_min:  leg.priceMin,
          price_kes_max:  leg.priceMax,
          duration_mins:  leg.durationMins,
          departs:        leg.departs || null,
          arrives:        leg.arrives || null,
          booking_method: leg.bookingMethod || 'static',
          supplier:       leg.supplier || null,
          notes:          leg.notes || null,
        }));

        await supabase.from('route_legs').insert(legRows);
      }

      return route;

    } catch (err) {
      logger.error('RouteLearning: seedRoute threw', { origin, destination, error: err.message });
      return null;
    }
  }

  /**
   * Approve an agency tip — moves it into the routes table.
   */
  async approveAgencyTip(tipId, reviewedBy) {
    try {
      const { data: tip } = await supabase
        .from('agency_route_tips')
        .select('*')
        .eq('id', tipId)
        .single();

      if (!tip) return false;

      await this.seedRoute({
        origin:        tip.origin,
        destination:   tip.destination,
        transportMode: tip.transport_mode,
        providers:     tip.provider ? [tip.provider] : [],
        priceKesMin:   tip.price_kes_min,
        priceKesMax:   tip.price_kes_max,
        frequency:     tip.frequency,
        departs:       tip.departs,
        durationHours: tip.duration_hours,
        notes:         tip.notes,
        confidence:    tip.confidence || 0.7,
        bookingMethod: 'direct',
      });

      await supabase
        .from('agency_route_tips')
        .update({ status: 'approved', reviewed_by: reviewedBy, reviewed_at: new Date().toISOString() })
        .eq('id', tipId);

      logger.info('RouteLearning: agency tip approved', { tipId });
      return true;

    } catch (err) {
      logger.error('RouteLearning: approveAgencyTip threw', { tipId, error: err.message });
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═════════════════════════════════════════════════════════════

  async _getDirectRoutes(origin, destination) {
    try {
      const { data } = await supabase
        .from('routes')
        .select('*')
        .eq('origin',      this._normalize(origin))
        .eq('destination', this._normalize(destination))
        .eq('route_type',  'direct')
        .gte('confidence', 0.3);
      return data || [];
    } catch { return []; }
  }

  async _getConfidence(origin, destination) {
    try {
      const { data } = await supabase
        .from('route_confidence')
        .select('*')
        .eq('origin',      this._normalize(origin))
        .eq('destination', this._normalize(destination));
      return data || [];
    } catch { return []; }
  }

  async _getCompoundRoutes(origin, destination, budget = null) {
    try {
      let query = supabase
        .from('routes')
        .select(`*, route_legs ( id, leg_order, from_place, to_place, transport_mode, providers, price_kes_min, price_kes_max, duration_mins, departs, arrives, booking_method, supplier, notes )`)
        .eq('origin',      this._normalize(origin))
        .eq('destination', this._normalize(destination))
        .eq('route_type',  'compound')
        .gte('confidence', 0.5)
        .order('confidence', { ascending: false });

      if (budget) {
        const tier = this._getBudgetTier(budget);
        query = query.in('budget_tier', [tier, 'all']);
      }

      const { data } = await query;
      if (!data) return [];

      return data.map(route => ({
        ...route,
        route_legs:    (route.route_legs || []).sort((a, b) => a.leg_order - b.leg_order),
        totalPriceMin: (route.route_legs || []).reduce((s, l) => s + (l.price_kes_min || 0), 0),
        totalPriceMax: (route.route_legs || []).reduce((s, l) => s + (l.price_kes_max || 0), 0),
      }));

    } catch (err) {
      logger.error('RouteLearning: _getCompoundRoutes threw', { origin, destination, error: err.message });
      return [];
    }
  }

  async _updateRouteStats(origin, destination, mode, success) {
    try {
      const updates = {
        search_count:     supabase.raw('search_count + 1'),
        last_searched_at: new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      };
      if (success) {
        updates.success_count     = supabase.raw('success_count + 1');
        updates.last_succeeded_at = new Date().toISOString();
      }
      await supabase
        .from('routes')
        .update(updates)
        .eq('origin',         origin)
        .eq('destination',    destination)
        .eq('transport_mode', mode);
    } catch { /* non-critical */ }
  }

  async _checkAutotune(destination, supplier, currentRadius) {
    try {
      const { data } = await supabase
        .from('route_confidence')
        .select('zero_result_streak, optimal_radius_km')
        .eq('destination',    this._normalize(destination))
        .eq('transport_mode', 'hotel')
        .eq('supplier',       supplier)
        .maybeSingle();

      if (!data) return;
      if (data.zero_result_streak < AUTOTUNE_TRIGGER) return;

      const currentStep = RADIUS_STEPS.indexOf(currentRadius || 20);
      const nextRadius  = RADIUS_STEPS[currentStep + 1];
      if (!nextRadius) return;

      await supabase
        .from('route_confidence')
        .update({ optimal_radius_km: nextRadius, last_updated_at: new Date().toISOString() })
        .eq('destination',    this._normalize(destination))
        .eq('transport_mode', 'hotel')
        .eq('supplier',       supplier);

      logger.info('RouteLearning: radius autotuned', {
        destination, from: currentRadius, to: nextRadius,
        streak: data.zero_result_streak,
      });
    } catch (err) {
      logger.error('RouteLearning: _checkAutotune threw', { destination, error: err.message });
    }
  }

  _hasRoute(routes, mode) {
    return routes.some(r => r.transport_mode === mode && r.confidence >= 0.5);
  }

  _shouldSkip(confidence, mode) {
    const entry = confidence.find(c => c.transport_mode === mode);
    if (!entry) return false;                          // no data → don't skip
    if (entry.total_searches < 5) return false;       // not enough data yet
    return entry.confidence < SKIP_THRESHOLD;
  }

  _getOptimalRadius(confidence) {
    const hotelConf = confidence.find(c => c.transport_mode === 'hotel');
    return hotelConf?.optimal_radius_km || null;
  }

  _getBudgetTier(budget) {
    if (typeof budget === 'number') {
      if (budget <= 50000)  return 'budget';
      if (budget <= 150000) return 'mid';
      return 'luxury';
    }
    if (budget === 'low')    return 'budget';
    if (budget === 'luxury') return 'luxury';
    return 'mid';
  }

  _normalize(str) {
    return (str || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  _hashPhone(phone) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(phone).digest('hex').slice(0, 16);
  }
}

module.exports = new RouteLearningService();