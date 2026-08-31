/**
 * recommendationScorer.js
 * 
 * Takes a traveler taste profile + a list of packages
 * and returns them sorted by recommendation score.
 * 
 * Usage:
 *   const { rankedPackages, scores } = await scorePackages(packages, phone, supabase)
 *   // Then serve rankedPackages instead of raw supplier results
 */

// Scoring weights — tune these as you get more data
const WEIGHTS = {
  destination_affinity: 0.30,
  budget_fit:           0.25,
  style_fit:            0.20,
  date_fit:             0.10,
  package_quality:      0.10,
  popularity_boost:     0.05,
};

/**
 * Budget fit score (0–1)
 * How well does the package price fit the traveler's inferred budget?
 */
function scoreBudgetFit(priceKes, profile) {
  if (!profile.budget_min_kes || !profile.budget_max_kes) return 0.5; // unknown → neutral
  if (!priceKes) return 0.5;

  const mid = (profile.budget_min_kes + profile.budget_max_kes) / 2;
  const range = profile.budget_max_kes - profile.budget_min_kes;

  if (priceKes >= profile.budget_min_kes && priceKes <= profile.budget_max_kes) {
    // Within range — closer to midpoint = better fit
    return 1.0 - (Math.abs(priceKes - mid) / (range / 2)) * 0.2;
  }

  if (priceKes < profile.budget_min_kes) {
    // Cheaper than budget — slight penalty (traveler may perceive as low quality)
    const overshoot = (profile.budget_min_kes - priceKes) / profile.budget_min_kes;
    return Math.max(0.4, 1 - overshoot);
  }

  // More expensive than budget
  const overshoot = (priceKes - profile.budget_max_kes) / profile.budget_max_kes;
  if (profile.budget_sensitivity === 'high') return Math.max(0, 0.6 - overshoot * 2);
  if (profile.budget_sensitivity === 'low')  return Math.max(0.2, 0.9 - overshoot);
  return Math.max(0, 0.7 - overshoot * 1.2);
}

/**
 * Style fit score (0–1)
 * How well do package attributes match traveler's style scores?
 */
function scoreStyleFit(pkg, profile) {
  const styleScores = profile.travel_style_scores || {};
  const accScores   = profile.accommodation_scores || {};

  let score = 0.5; // baseline — no style info

  // Package style tags e.g. ['beach', 'luxury', 'couples']
  const tags = pkg.style_tags || pkg.trip_tags || [];
  if (tags.length === 0) return score;

  let matched = 0, total = 0;
  for (const tag of tags) {
    const t = tag.toLowerCase();
    const styleVal = styleScores[t] || 0;
    const accVal   = accScores[t]   || 0;
    const val = Math.max(styleVal, accVal);
    if (val > 0) {
      score += val * 0.3;
      matched++;
    }
    total++;
  }

  return Math.min(1, score);
}

/**
 * Destination affinity score (0–1)
 */
function scoreDestination(destination, profile) {
  if (!destination) return 0.5;
  const scores = profile.destination_scores || {};
  const key = destination.trim().toLowerCase();
  return scores[key] ?? 0.3; // unknown destination → below neutral
}

/**
 * Package quality score (0–1)
 * Based on stars, review count, supplier reliability
 */
function scorePackageQuality(pkg) {
  let score = 0.5;
  if (pkg.hotel_stars) score = Math.min(1, pkg.hotel_stars / 5);
  if (pkg.rating)      score = Math.min(1, (score + pkg.rating / 5) / 2);
  return score;
}

/**
 * Date fit score (0–1)
 * Does the package date match the traveler's stated intent window?
 */
function scoreDateFit(pkg, profile) {
  if (!profile.last_intent_window || !pkg.departure_date) return 0.5;

  const window = profile.last_intent_window.toLowerCase();
  const depDate = new Date(pkg.departure_date);
  const month = depDate.toLocaleString('en', { month: 'long' }).toLowerCase();

  if (window.includes(month)) return 1.0;
  if (window.includes(String(depDate.getFullYear()))) return 0.7;
  return 0.4;
}

/**
 * Main scorer — returns packages sorted by score, highest first
 */
async function scorePackages(packages, phone, supabase, sessionId = null) {
  if (!packages || packages.length === 0) return { rankedPackages: [], scores: [] };

  // Load taste profile
  let profile = {};
  if (phone) {
    const { data } = await supabase
      .from('traveler_taste_profiles')
      .select('*')
      .eq('traveler_phone', phone)
      .single();
    if (data) profile = data;
  }

  const scored = packages.map((pkg, idx) => {
    const destination        = pkg.destination || pkg.hotel_destination || '';
    const priceKes           = pkg.price_kes || pkg.total_price_kes || null;

    const destinationAffinity = scoreDestination(destination, profile);
    const budgetFit           = scoreBudgetFit(priceKes, profile);
    const styleFit            = scoreStyleFit(pkg, profile);
    const dateFit             = scoreDateFit(pkg, profile);
    const packageQuality      = scorePackageQuality(pkg);
    const popularityBoost     = 0; // placeholder for collaborative filtering

    const score =
      destinationAffinity * WEIGHTS.destination_affinity +
      budgetFit           * WEIGHTS.budget_fit +
      styleFit            * WEIGHTS.style_fit +
      dateFit             * WEIGHTS.date_fit +
      packageQuality      * WEIGHTS.package_quality +
      popularityBoost     * WEIGHTS.popularity_boost;

    const breakdown = {
      destination_affinity: +destinationAffinity.toFixed(3),
      budget_fit:           +budgetFit.toFixed(3),
      style_fit:            +styleFit.toFixed(3),
      date_fit:             +dateFit.toFixed(3),
      package_quality:      +packageQuality.toFixed(3),
      popularity_boost:     +popularityBoost.toFixed(3),
    };

    return { pkg, score: +score.toFixed(4), breakdown, originalIndex: idx };
  });

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Log scores to DB (fire-and-forget)
  if (supabase && sessionId) {
    const rows = scored.map((s, position) => ({
      session_id:       sessionId,
      traveler_phone:   phone || null,
      package_id:       s.pkg.id || s.pkg.package_id || `pkg_${s.originalIndex}`,
      position:         position + 1,
      score:            s.score,
      score_breakdown:  s.breakdown,
      package_snapshot: {
        destination: s.pkg.destination,
        price_kes:   s.pkg.price_kes,
        hotel_name:  s.pkg.hotel_name,
        stars:       s.pkg.hotel_stars,
        supplier:    s.pkg.supplier,
      },
    }));

    supabase.from('recommendation_scores').insert(rows).then(({ error }) => {
      if (error) console.error('[Scorer] Failed to log scores:', error.message);
    });
  }

  return {
    rankedPackages: scored.map(s => s.pkg),
    scores:         scored.map(s => ({ score: s.score, breakdown: s.breakdown })),
    profileUsed:    !!profile.traveler_phone,
  };
}

module.exports = { scorePackages };