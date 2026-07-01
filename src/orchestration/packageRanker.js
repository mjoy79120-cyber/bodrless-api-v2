/**
 * PACKAGE RANKER
 * ─────────────────────────────────────────────────────────────
 * Scores and ranks assembled trip packages so the best options
 * surface first. Considers budget fit, hotel rating, transport
 * quality and overall value.
 * ─────────────────────────────────────────────────────────────
 */

// Per-person price ranges in KES (canonical currency after conversion).
// Tuned for realistic East Africa flight + hotel package costs.
const BUDGET_RANGES = {
  low:    { min: 0,      max: 15000  },
  mid:    { min: 10000,  max: 40000  },
  high:   { min: 30000,  max: 100000 },
  luxury: { min: 80000,  max: 9999999 },
};

function rankPackages(packages, tripParams, travelerProfile = null) {
  const scored = packages.map(pkg => ({
    ...pkg,
    score: _scorePackage(pkg, tripParams, travelerProfile),
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...pkg }) => pkg);
}

function _scorePackage(pkg, tripParams, travelerProfile) {
  let score = 0;
  const budget = tripParams.budget || 'mid';
  const range = BUDGET_RANGES[budget];
  const pricePerPerson = pkg.summary.pricePerPerson;

  // ── Budget fit (0-40 points) ─────────────────────────────
  if (pricePerPerson >= range.min && pricePerPerson <= range.max) {
    score += 40;
  } else if (pricePerPerson < range.min) {
    score += 20;
  } else {
    const overage = (pricePerPerson - range.max) / range.max;
    score += Math.max(0, 30 - (overage * 30));
  }

  // ── Hotel rating (0-30 points) — skip if no hotel ───────
  // stars and review rating are BOTH 0-5 in this codebase
  // (engine.js defaults stars→4, rating→4.5), so both divide by 5.
  // Split within the 30-point budget: up to 20 from star class,
  // up to 10 from review rating. Previously stars alone could reach
  // 30 and rating was divided by 10 (wrong scale) and added on top,
  // pushing this block past its labeled 0-30 ceiling to ~45.
  if (pkg.hotel) {
    score += ((pkg.hotel.stars || 3) / 5) * 20;

    if (pkg.hotel.rating) {
      score += ((pkg.hotel.rating || 0) / 5) * 10;
    }
  }

  // ── Transport quality (0-10 points) ─────────────────────
  if (pkg.transport) {
    if (pkg.transport.stops === 0 || pkg.transport.stops === 'Non Stop') score += 10;
    else if (pkg.transport.stops === 1) score += 5;
  }

  // ── Transfers included (0-5 points) ─────────────────────
  // An empty array [] is truthy, so a package with transfers
  // explicitly disabled (e.g. "flight only", needsTransfers:false)
  // was still collecting this bonus. Require at least one leg.
  if (pkg.transfers && pkg.transfers.length > 0) score += 5;

  // ── Traveler intelligence bonus (0-20 points, additive) ──
  // Deliberately ADDITIVE on top of the 85-point base scale above,
  // never multiplicative — multiplying the tuned categories above
  // risks distorting fixes that were carefully calibrated (hotel
  // scale, non-stop bonus, transfer bonus). This block translates
  // travelerIntelligence.js's orchestrationHints/scoringWeights into
  // concrete, capped bonuses so a profile can meaningfully influence
  // ranking without ever being able to override a wildly mispriced
  // or genuinely worse package into first place. travelerProfile is
  // optional — when null/absent, this block contributes exactly 0,
  // so ranking behavior for any caller not yet passing a profile is
  // completely unchanged (existing single-destination search is the
  // only current caller; it always passes one).
  if (travelerProfile) {
    score += _travelerIntelligenceBonus(pkg, travelerProfile);
  }

  return score;
}

// Returns 0-20. Each signal below is a small, named, independently
// capped contribution — if you're debugging "why did this package
// rank where it did," each line here is a legible, single-purpose
// reason, not a black-box multiplier.
function _travelerIntelligenceBonus(pkg, profile) {
  let bonus = 0;
  const hints = profile.orchestrationHints || {};
  const weights = profile.scoringWeights || {};

  // Refund-sensitive traveler + a refundable hotel rate (max 6).
  if (hints.prioritizeRefundable && pkg.hotel?.isRefundable === true) {
    bonus += 6;
  }

  // Wants to avoid transfers, package genuinely has none (max 4).
  // Mirrors the existing "transfers included" signal's inverse —
  // this is about preference, not the unconditional +5 above.
  if (hints.avoidTransfers && (!pkg.transfers || pkg.transfers.length === 0)) {
    bonus += 4;
  }

  // Time-critical trip + an early/non-stop-feeling option. We don't
  // have a true "arrival time score" yet, so this leans on the
  // existing stops signal as the best available proxy — a direct
  // flight is the single biggest lever on actually arriving on time.
  if (hints.prioritizeArrivalTime && pkg.transport?.stops === 0) {
    bonus += 4;
  }

  // Comfort-prioritizing trip (honeymoon/family) + a strong hotel.
  // Capped at 4 and only fires for genuinely good hotels (4+ stars)
  // so it can't reward a mediocre hotel just because the trip type
  // matched — the bonus has to be earned by the package, not just
  // implied by the traveler type.
  if (hints.prioritizeComfort && (pkg.hotel?.stars || 0) >= 4) {
    bonus += 4;
  }

  // High budget sensitivity + this package is genuinely cheap
  // relative to its own budget band (bottom half of the range).
  // Small and capped at 2 — budget fit is already the single
  // largest base-scale category (40 points), this only nudges
  // among options that are already within range.
  if (weights.price >= 9 && pkg.summary?.pricePerPerson != null && pkg.summary.pricePerPerson > 0) {
    bonus += 2;
  }

  return Math.min(bonus, 20);
}

module.exports = { rankPackages };