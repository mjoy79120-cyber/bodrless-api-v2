/**
 * INSIGHTS ENGINE
 * ─────────────────────────────────────────────────────────────
 * Pattern detection over data Bodrless already collects — never
 * touches live search/ranking/pricing behavior. Pure read, pure
 * analysis. Results are written to the `insights` table on an
 * hourly schedule (see server.js) and read by the admin dashboard.
 *
 * This is Tier 1 of a deliberate "smarter over time" roadmap:
 *   Tier 1 (this file) — surface patterns to a human, zero risk
 *   Tier 2 (later)      — suggest specific changes, human approves
 *   Tier 3/4 (later)    — bounded/full automatic adjustment
 * Held at Tier 1 intentionally until there's enough real booking
 * volume for patterns to be trustworthy rather than noise — see
 * the per-detector MIN_SAMPLE thresholds below, which exist
 * specifically to suppress insights drawn from too little data.
 *
 * Each detector is independent, wrapped, and can never throw past
 * its own boundary — one broken detector must never prevent the
 * other five from running or block the scheduled refresh.
 * ─────────────────────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

// Minimum sample sizes before a pattern is considered meaningful
// rather than noise. These are deliberately conservative given
// current volume — raise them as real traffic grows, never lower
// them just to produce more insights to show.
const MIN_SAMPLE = {
  deadEndSearches:     3,   // a destination needs 3+ searches to call it a pattern, not bad luck
  parserStruggle:      5,   // 5+ rule-fallback/clarification hits before flagging
  conversionSegment:   8,   // 8+ searches in a segment before comparing its conversion rate
  repeatNoBooking:     3,   // 3+ searches, same traveler, before flagging as friction
  supplierDrift:       10,  // 10+ calls in both the recent and prior window
};

const LOOKBACK_DAYS = 30;        // how far back each detector scans
const RECENT_WINDOW_DAYS = 7;    // "recent" period for drift comparisons
const TOXIC_WORDS_IGNORE = [];   // reserved — not used yet, kept explicit rather than implied

class InsightsEngine {

  // ─────────────────────────────────────────────
  // REFRESH ALL
  // Runs every detector, replaces that detector's existing rows
  // with fresh results. Called hourly from server.js. Each
  // detector is independently wrapped — one failing doesn't stop
  // the others.
  // ─────────────────────────────────────────────
  async refreshAll() {
    const detectors = [
      { type: 'dead_end_destination', fn: () => this.detectDeadEndDestinations() },
      { type: 'parser_struggle',      fn: () => this.detectParserStruggle() },
      { type: 'conversion_gap',       fn: () => this.detectConversionGaps() },
      { type: 'channel_friction',     fn: () => this.detectChannelFriction() },
      { type: 'repeat_no_booking',    fn: () => this.detectRepeatNoBooking() },
      { type: 'supplier_drift',       fn: () => this.detectSupplierDrift() },
    ];

    const results = { succeeded: [], failed: [] };

    for (const { type, fn } of detectors) {
      try {
        const insights = await fn();
        await this._replaceInsightsOfType(type, insights);
        results.succeeded.push({ type, count: insights.length });
      } catch (err) {
        logger.error(`Insights detector failed: ${type}`, { error: err.message });
        results.failed.push({ type, error: err.message });
      }
    }

    logger.info('Insights refresh complete', results);
    return results;
  }

  async _replaceInsightsOfType(type, insights) {
    // Clear existing rows of this type, then insert fresh ones —
    // current-state snapshot, not an accumulating log.
    await supabase.from('insights').delete().eq('type', type);

    if (insights.length === 0) return;

    const rows = insights.map(i => ({
      id:          uuidv4(),
      type,
      severity:    i.severity || 'info',
      agency_id:   i.agencyId || null,
      title:       i.title,
      detail:      i.detail || null,
      data:        i.data || null,
      computed_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from('insights').insert(rows);
    if (error) throw error;
  }

  _sinceDate(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString();
  }

  // ─────────────────────────────────────────────
  // 1. DEAD-END DESTINATIONS
  // Destinations searched repeatedly with zero packages returned
  // every time — signals missing inventory, not a fluke search.
  // ─────────────────────────────────────────────
  async detectDeadEndDestinations() {
    const { data: searches } = await supabase
      .from('trip_searches')
      .select('agency_id, destination, packages_returned, created_at')
      .gte('created_at', this._sinceDate(LOOKBACK_DAYS))
      .not('destination', 'is', null);

    if (!searches || searches.length === 0) return [];

    // Group by agency + normalized destination
    const groups = {};
    for (const s of searches) {
      const dest = (s.destination || '').trim().toLowerCase();
      if (!dest) continue;
      const key = `${s.agency_id}::${dest}`;
      if (!groups[key]) groups[key] = { agencyId: s.agency_id, destination: dest, total: 0, zeroResult: 0 };
      groups[key].total++;
      if (Number(s.packages_returned || 0) === 0) groups[key].zeroResult++;
    }

    const insights = [];
    for (const g of Object.values(groups)) {
      if (g.total < MIN_SAMPLE.deadEndSearches) continue;
      // 100% zero-result, every single time — a genuine dead end,
      // not just a low-conversion destination.
      if (g.zeroResult === g.total) {
        const label = g.destination.charAt(0).toUpperCase() + g.destination.slice(1);
        insights.push({
          severity: g.total >= 6 ? 'high' : 'notable',
          agencyId: g.agencyId,
          title:    `"${label}" searched ${g.total}x with zero results every time`,
          detail:   `Travelers keep asking for ${label} but no package has ever come back. Likely missing hotel/flight inventory for this destination, or it needs adding to the destination resolver.`,
          data:     { destination: g.destination, totalSearches: g.total, zeroResultSearches: g.zeroResult },
        });
      }
    }

    return insights.sort((a, b) => (b.data.totalSearches - a.data.totalSearches)).slice(0, 15);
  }

  // ─────────────────────────────────────────────
  // 2. PARSER STRUGGLE ZONES
  // Conversation turns that fell back to the rule-based parser or
  // needed clarification, grouped to find what's actually hard to
  // parse — not just "the parser fails sometimes" but "X% of
  // multi-passenger prompts trip the fallback."
  // ─────────────────────────────────────────────
  async detectParserStruggle() {
    const { data: turns } = await supabase
      .from('conversations')
      .select('agency_id, used_llm, needs_clarification, degraded, llm_error, created_at')
      .gte('created_at', this._sinceDate(LOOKBACK_DAYS));

    if (!turns || turns.length === 0) return [];

    const byAgency = {};
    for (const t of turns) {
      const key = t.agency_id || 'platform';
      if (!byAgency[key]) byAgency[key] = { agencyId: t.agency_id, total: 0, fallback: 0, clarification: 0, degraded: 0 };
      byAgency[key].total++;
      if (t.used_llm === false) byAgency[key].fallback++;
      if (t.needs_clarification) byAgency[key].clarification++;
      if (t.degraded) byAgency[key].degraded++;
    }

    const insights = [];
    for (const g of Object.values(byAgency)) {
      if (g.total < MIN_SAMPLE.parserStruggle) continue;

      const fallbackRate = g.fallback / g.total;
      if (g.fallback >= MIN_SAMPLE.parserStruggle && fallbackRate >= 0.15) {
        insights.push({
          severity: fallbackRate >= 0.4 ? 'high' : 'notable',
          agencyId: g.agencyId,
          title:    `LLM parser fell back to rules on ${Math.round(fallbackRate * 100)}% of searches`,
          detail:   `${g.fallback} of ${g.total} searches used the weaker rule-based parser instead of Groq — usually means Groq is timing out, erroring, or rate-limited for this traffic. Check the GROQ_API_KEY and Render logs for "LLM (Groq) parsing failed" around these timestamps.`,
          data:     { totalTurns: g.total, fallbackCount: g.fallback, fallbackRate: Number((fallbackRate * 100).toFixed(1)) },
        });
      }

      const degradedRate = g.degraded / g.total;
      if (g.degraded >= 3) {
        insights.push({
          severity: degradedRate >= 0.1 ? 'high' : 'notable',
          agencyId: g.agencyId,
          title:    `${g.degraded} search(es) hit the engine's master error fallback`,
          detail:   `These are genuine crashes recovered gracefully (see the alerts tab for "engine_crash" entries) — the traveler got a generic "tell me where you're going" message instead of real results. Worth checking those alerts for the actual stack traces.`,
          data:     { totalTurns: g.total, degradedCount: g.degraded },
        });
      }
    }

    return insights;
  }

  // ─────────────────────────────────────────────
  // 3. CONVERSION GAPS BY TRAVELER SEGMENT
  // Compares conversion rate across traveler-profile segments
  // (using tripType/budget/children as the segment proxy, since
  // travelerIntelligence profiles aren't persisted yet — see note
  // below) to find which kinds of trips convert well vs poorly.
  // ─────────────────────────────────────────────
  async detectConversionGaps() {
    const { data: searches } = await supabase
      .from('trip_searches')
      .select('agency_id, budget, converted, created_at')
      .gte('created_at', this._sinceDate(LOOKBACK_DAYS))
      .not('budget', 'is', null);

    if (!searches || searches.length === 0) return [];

    // NOTE: trip_searches only stores `budget`, not the full
    // travelerIntelligence profile (tripPurpose, familyFriendly,
    // etc.) — that profile is computed in-memory per search and
    // never persisted. This detector works with what's actually
    // stored today (budget tier) rather than data that doesn't
    // exist yet. A future improvement: persist travelerProfile.
    // tripPurpose alongside each conversations row so this can
    // compare "honeymoon vs business vs family" directly instead
    // of using budget tier as a rough proxy.
    const byBudget = {};
    for (const s of searches) {
      const tier = s.budget;
      if (!byBudget[tier]) byBudget[tier] = { total: 0, converted: 0 };
      byBudget[tier].total++;
      if (s.converted) byBudget[tier].converted++;
    }

    const tiers = Object.entries(byBudget)
      .filter(([, v]) => v.total >= MIN_SAMPLE.conversionSegment)
      .map(([tier, v]) => ({ tier, total: v.total, converted: v.converted, rate: v.converted / v.total }));

    if (tiers.length < 2) return [];

    const overallRate = tiers.reduce((s, t) => s + t.converted, 0) / tiers.reduce((s, t) => s + t.total, 0);
    const insights = [];

    for (const t of tiers) {
      const deltaPct = (t.rate - overallRate) * 100;
      // Only flag genuinely notable gaps — half the overall rate or
      // double it, not minor statistical noise.
      if (Math.abs(deltaPct) >= 15) {
        const direction = deltaPct > 0 ? 'higher' : 'lower';
        insights.push({
          severity: Math.abs(deltaPct) >= 25 ? 'high' : 'notable',
          agencyId: null, // platform-wide pattern
          title:    `"${t.tier}" budget searches convert ${Math.abs(Math.round(deltaPct))}pp ${direction} than average`,
          detail:   `${t.tier} budget: ${t.converted}/${t.total} searches converted (${Math.round(t.rate * 100)}%) vs ${Math.round(overallRate * 100)}% overall. Worth checking whether this segment's packages match what they actually want.`,
          data:     { budgetTier: t.tier, searches: t.total, converted: t.converted, conversionRate: Number((t.rate * 100).toFixed(1)), overallRate: Number((overallRate * 100).toFixed(1)) },
        });
      }
    }

    return insights;
  }

  // ─────────────────────────────────────────────
  // 4. CHANNEL FRICTION
  // Compares search-to-booking conversion between WhatsApp and
  // widget — if one channel converts notably worse, that's a UX
  // or flow problem specific to that channel worth investigating.
  // ─────────────────────────────────────────────
  async detectChannelFriction() {
    const { data: searches } = await supabase
      .from('trip_searches')
      .select('agency_id, channel, converted, created_at')
      .gte('created_at', this._sinceDate(LOOKBACK_DAYS));

    if (!searches || searches.length === 0) return [];

    // FIX: must group by agency_id first, not just by channel pooled
    // across every agency — a healthy agency's widget numbers would
    // otherwise dilute and hide a different agency's genuine WhatsApp
    // problem. Each agency's channels are compared only against that
    // SAME agency's other channel, never against a different agency.
    const byAgency = {};
    for (const s of searches) {
      const key = s.agency_id || 'unknown';
      if (!byAgency[key]) byAgency[key] = {};
      const ch = s.channel || 'unknown';
      if (!byAgency[key][ch]) byAgency[key][ch] = { total: 0, converted: 0 };
      byAgency[key][ch].total++;
      if (s.converted) byAgency[key][ch].converted++;
    }

    const insights = [];
    for (const [agencyId, channels] of Object.entries(byAgency)) {
      const wa = channels.whatsapp;
      const wg = channels.widget;
      if (!wa || !wg || wa.total < MIN_SAMPLE.conversionSegment || wg.total < MIN_SAMPLE.conversionSegment) continue;

      const waRate = wa.converted / wa.total;
      const wgRate = wg.converted / wg.total;
      const deltaPct = Math.abs(waRate - wgRate) * 100;

      if (deltaPct < 15) continue;

      const worse = waRate < wgRate ? 'WhatsApp' : 'Widget';
      const better = worse === 'WhatsApp' ? 'Widget' : 'WhatsApp';

      insights.push({
        severity: deltaPct >= 25 ? 'high' : 'notable',
        agencyId: agencyId === 'unknown' ? null : agencyId,
        title:    `${worse} converts ${Math.round(deltaPct)}pp worse than ${better}`,
        detail:   `WhatsApp: ${wa.converted}/${wa.total} (${Math.round(waRate * 100)}%) · Widget: ${wg.converted}/${wg.total} (${Math.round(wgRate * 100)}%). Worth checking whether ${worse}'s booking flow (passenger detail collection, payment prompt) has more drop-off points than ${better}'s.`,
        data:     { whatsapp: { total: wa.total, converted: wa.converted, rate: Number((waRate*100).toFixed(1)) }, widget: { total: wg.total, converted: wg.converted, rate: Number((wgRate*100).toFixed(1)) } },
      });
    }

    return insights;
  }

  // ─────────────────────────────────────────────
  // 5. REPEAT SEARCH, NO BOOKING
  // Same phone number searching multiple times without ever
  // booking — signals real interest plus real friction (price,
  // missing dates, indecision), worth a human follow-up, not a
  // lost cause.
  // ─────────────────────────────────────────────
  async detectRepeatNoBooking() {
    const { data: convs } = await supabase
      .from('conversations')
      .select('agency_id, phone, converted, booking_ref, created_at')
      .gte('created_at', this._sinceDate(LOOKBACK_DAYS))
      .not('phone', 'is', null);

    if (!convs || convs.length === 0) return [];

    const byPhone = {};
    for (const c of convs) {
      if (!byPhone[c.phone]) byPhone[c.phone] = { agencyId: c.agency_id, turns: 0, everConverted: false, lastSeen: c.created_at };
      byPhone[c.phone].turns++;
      if (c.converted || c.booking_ref) byPhone[c.phone].everConverted = true;
      if (c.created_at > byPhone[c.phone].lastSeen) byPhone[c.phone].lastSeen = c.created_at;
    }

    const candidates = Object.entries(byPhone)
      .filter(([, v]) => v.turns >= MIN_SAMPLE.repeatNoBooking && !v.everConverted)
      .map(([phone, v]) => ({ phone, ...v }))
      .sort((a, b) => b.turns - a.turns)
      .slice(0, 10);

    if (candidates.length === 0) return [];

    // Group into a single summary insight per agency rather than
    // one row per phone — a list of phone numbers isn't actionable
    // on its own, the PATTERN (how many such travelers exist) is.
    const byAgency = {};
    for (const c of candidates) {
      const key = c.agencyId || 'platform';
      if (!byAgency[key]) byAgency[key] = { agencyId: c.agencyId, travelers: [] };
      byAgency[key].travelers.push({ phone: c.phone, searches: c.turns, lastSeen: c.lastSeen });
    }

    return Object.values(byAgency).map(g => ({
      severity: g.travelers.length >= 5 ? 'high' : 'notable',
      agencyId: g.agencyId,
      title:    `${g.travelers.length} traveler(s) searched ${MIN_SAMPLE.repeatNoBooking}+ times without ever booking`,
      detail:   `These travelers showed real, repeated interest but never converted — worth a manual follow-up (price concern? dates didn't work? hit a bug?) rather than assuming they weren't serious.`,
      data:     { travelers: g.travelers },
    }));
  }

  // ─────────────────────────────────────────────
  // 6. SUPPLIER DRIFT
  // Compares the rate of zero-result/degraded searches in the
  // last RECENT_WINDOW_DAYS against the period before it — catches
  // a supplier quietly getting worse (timeouts climbing, results
  // thinning out) before it becomes a full outage someone notices.
  // ─────────────────────────────────────────────
  async detectSupplierDrift() {
    const recentSince = this._sinceDate(RECENT_WINDOW_DAYS);
    const priorSince  = this._sinceDate(RECENT_WINDOW_DAYS * 2);

    const { data: searches } = await supabase
      .from('trip_searches')
      .select('packages_returned, created_at')
      .gte('created_at', priorSince);

    if (!searches || searches.length === 0) return [];

    const recent = searches.filter(s => s.created_at >= recentSince);
    const prior  = searches.filter(s => s.created_at < recentSince);

    if (recent.length < MIN_SAMPLE.supplierDrift || prior.length < MIN_SAMPLE.supplierDrift) return [];

    const recentZeroRate = recent.filter(s => Number(s.packages_returned || 0) === 0).length / recent.length;
    const priorZeroRate  = prior.filter(s => Number(s.packages_returned || 0) === 0).length / prior.length;

    const deltaPct = (recentZeroRate - priorZeroRate) * 100;

    // Only flag a genuine worsening trend, not normal fluctuation.
    if (deltaPct < 10) return [];

    return [{
      severity: deltaPct >= 20 ? 'high' : 'notable',
      agencyId: null,
      title:    `Zero-result rate climbed ${Math.round(deltaPct)}pp in the last ${RECENT_WINDOW_DAYS} days`,
      detail:   `Last ${RECENT_WINDOW_DAYS} days: ${Math.round(recentZeroRate * 100)}% of searches returned nothing, vs ${Math.round(priorZeroRate * 100)}% in the ${RECENT_WINDOW_DAYS} days before that. Check the alerts tab for rising "zero_results" or "supplier_timeout" entries to narrow down which supplier is degrading.`,
      data:     { recentZeroRate: Number((recentZeroRate*100).toFixed(1)), priorZeroRate: Number((priorZeroRate*100).toFixed(1)), recentSearches: recent.length, priorSearches: prior.length },
    }];
  }
}

module.exports = new InsightsEngine();