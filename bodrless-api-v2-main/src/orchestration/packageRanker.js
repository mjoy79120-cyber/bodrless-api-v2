/**
 * PACKAGE RANKER
 * ─────────────────────────────────────────────────────────────
 * Scores and ranks assembled trip packages so the best options
 * surface first. Considers budget fit, hotel rating, transport
 * quality and overall value.
 * ─────────────────────────────────────────────────────────────
 */

const BUDGET_RANGES = {
  low:     { min: 0,    max: 500  },
  mid:     { min: 300,  max: 1000 },
  high:    { min: 800,  max: 2500 },
  luxury:  { min: 2000, max: 99999 },
};

/**
 * Rank packages by relevance to the traveler's preferences
 */
function rankPackages(packages, tripParams) {
  const scored = packages.map(pkg => ({
    ...pkg,
    score: _scorePackage(pkg, tripParams),
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...pkg }) => pkg); // Remove score from output
}

function _scorePackage(pkg, tripParams) {
  let score = 0;
  const budget = tripParams.budget || 'mid';
  const range = BUDGET_RANGES[budget];
  const pricePerPerson = pkg.summary.pricePerPerson;

  // ── Budget fit (0-40 points) ─────────────────────────────
  if (pricePerPerson >= range.min && pricePerPerson <= range.max) {
    score += 40; // Perfect budget fit
  } else if (pricePerPerson < range.min) {
    score += 20; // Under budget — good but maybe too basic
  } else {
    // Over budget — penalize proportionally
    const overage = (pricePerPerson - range.max) / range.max;
    score += Math.max(0, 30 - (overage * 30));
  }

  // ── Hotel rating (0-30 points) ───────────────────────────
  const hotelScore = ((pkg.hotel.stars || 3) / 5) * 30;
  score += hotelScore;

  // ── Hotel review rating (0-15 points) ───────────────────
  if (pkg.hotel.rating) {
    score += (pkg.hotel.rating / 10) * 15;
  }

  // ── Transport quality (0-10 points) ─────────────────────
  if (pkg.transport.stops === 0) score += 10; // Direct flight
  else if (pkg.transport.stops === 1) score += 5;

  // ── Transfers included (0-5 points) ─────────────────────
  if (pkg.transfers) score += 5;

  return score;
}

module.exports = { rankPackages };
