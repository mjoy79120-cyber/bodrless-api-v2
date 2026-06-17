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
  if (pkg.hotel) {
    const hotelScore = ((pkg.hotel.stars || 3) / 5) * 30;
    score += hotelScore;

    if (pkg.hotel.rating) {
      score += (pkg.hotel.rating / 10) * 15;
    }
  }

  // ── Transport quality (0-10 points) ─────────────────────
  if (pkg.transport) {
    if (pkg.transport.stops === 0 || pkg.transport.stops === 'Non Stop') score += 10;
    else if (pkg.transport.stops === 1) score += 5;
  }

  // ── Transfers included (0-5 points) ─────────────────────
  if (pkg.transfers) score += 5;

  return score;
}

module.exports = { rankPackages };