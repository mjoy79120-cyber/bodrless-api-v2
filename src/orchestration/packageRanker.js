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

function rankPackages(packages, tripParams) {
  const scored = packages.map(pkg => ({
    ...pkg,
    score: _scorePackage(pkg, tripParams),
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...pkg }) => pkg);
}

function _scorePackage(pkg, tripParams) {
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

  return score;
}

module.exports = { rankPackages };