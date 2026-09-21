// src/services/accessibilityService.js
// Partner: Accessible Travel Kenya
// Handles all accessible property + transfer queries triggered by accessibility intent

const supabase = require('../utils/supabase');

// Keywords that trigger accessibility mode in promptParser
const ACCESSIBILITY_KEYWORDS = [
  // Mobility
  'wheelchair', 'wheel chair', 'accessible', 'accessibility',
  'mobility', 'disabled', 'disability', 'ramp', 'roll-in',
  'grab bar', 'elevator access',
  // Visual
  'blind', 'visually impaired', 'visual impairment', 'low vision',
  // Hearing
  'deaf', 'hearing impaired', 'hearing loop',
  // Airport
  'airport assistance', 'airport help', 'special assistance',
  'meet and greet', 'wheelchair at airport',
];

/**
 * Detect accessibility intent from a parsed prompt or raw message.
 * Returns true if any accessibility keyword is found.
 */
function detectAccessibilityIntent(text = '') {
  const lower = text.toLowerCase();
  return ACCESSIBILITY_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Main query function.
 * @param {string} destination - e.g. 'nairobi', 'diani', 'mombasa'
 * @param {object} options
 * @param {string[]} [options.requiredFeatures] - e.g. ['Roll-in shower']
 * @param {string[]} [options.types] - subset of ['hotel','transfer','airport_assistance']
 * @returns {Promise<{hotels: object[], transfers: object[], airportAssistance: object[]}>}
 */
async function getAccessibleOptions(destination, options = {}) {
  const { requiredFeatures = [], types } = options;

  const dest = destination?.toLowerCase().trim();

  let query = supabase
    .from('accessible_properties')
    .select('*')
    .eq('active', true);

  if (dest) {
    query = query.eq('destination', dest);
  }

  if (types && types.length > 0) {
    query = query.in('type', types);
  }

  if (requiredFeatures.length > 0) {
    query = query.contains('accessibility_features', requiredFeatures);
  }

  const { data, error } = await query.order('price_from', { ascending: true });

  if (error) {
    console.error('[accessibilityService] Supabase error:', error.message);
    return { hotels: [], transfers: [], airportAssistance: [] };
  }

  const hotels = data.filter(p => p.type === 'hotel');
  const transfers = data.filter(p => p.type === 'transfer');
  const airportAssistance = data.filter(p => p.type === 'airport_assistance');

  return { hotels, transfers, airportAssistance };
}

/**
 * Format results as a WhatsApp message string.
 * Mirrors the style of your existing hotel/flight WhatsApp responses.
 */
function formatAccessibilityResponse(destination, { hotels, transfers, airportAssistance }) {
  const destLabel = _titleCase(destination || 'your destination');
  const lines = [];

  lines.push(`♿ *Accessible options in ${destLabel}*`);
  lines.push(`_Powered by Accessible Travel Kenya_\n`);

  // --- Hotels ---
  if (hotels.length > 0) {
    lines.push(`🏨 *Accessible Hotels*`);
    hotels.forEach((h, i) => {
      const roomInfo = h.accessible_rooms ? ` · ${h.accessible_rooms} accessible room${h.accessible_rooms > 1 ? 's' : ''}` : '';
      const price = h.price_from
        ? `From ${h.currency} ${Number(h.price_from).toLocaleString()}${h.price_unit}`
        : '';
      const features = (h.accessibility_features || []).slice(0, 3).join(', ');

      lines.push(`${i + 1}. *${h.name}*${roomInfo}`);
      if (h.location) lines.push(`   📍 ${h.location}`);
      if (features) lines.push(`   ✅ ${features}`);
      if (price) lines.push(`   💰 ${price}`);
      if (h.notes) lines.push(`   ℹ️ ${h.notes}`);
      lines.push('');
    });
  }

  // --- Transfers ---
  if (transfers.length > 0) {
    lines.push(`🚐 *Accessible Transfers*`);
    transfers.forEach((t, i) => {
      const price = t.price_from
        ? `${t.currency} ${Number(t.price_from).toLocaleString()} ${t.price_unit}`
        : '';
      const features = (t.accessibility_features || []).slice(0, 3).join(', ');

      lines.push(`${i + 1}. *${t.name}*`);
      if (features) lines.push(`   ✅ ${features}`);
      if (price) lines.push(`   💰 ${price}`);
      if (t.notes) lines.push(`   ℹ️ ${t.notes}`);
      lines.push('');
    });
  }

  // --- Airport Assistance ---
  if (airportAssistance.length > 0) {
    lines.push(`✈️ *Airport Assistance*`);
    airportAssistance.forEach((a, i) => {
      const price = a.price_from
        ? `${a.currency} ${Number(a.price_from).toLocaleString()} ${a.price_unit}`
        : '';
      const features = (a.accessibility_features || []).slice(0, 4).join(', ');

      lines.push(`${i + 1}. *${a.name}*`);
      lines.push(`   📍 ${a.location}`);
      if (features) lines.push(`   ✅ ${features}`);
      if (price) lines.push(`   💰 ${price}`);
      if (a.notes) lines.push(`   ℹ️ ${a.notes}`);
      lines.push('');
    });
  }

  if (hotels.length === 0 && transfers.length === 0 && airportAssistance.length === 0) {
    lines.push(`We don't have specific accessible listings for ${destLabel} yet.`);
    lines.push(`Reply *AGENT* and our team will find the right options for you.`);
    return lines.join('\n');
  }

  lines.push(`To book any of these or get more details, reply with the option number or type *AGENT* to speak with our team.`);

  return lines.join('\n');
}

// --- helpers ---

function _titleCase(str) {
  return str
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = {
  detectAccessibilityIntent,
  getAccessibleOptions,
  formatAccessibilityResponse,
  ACCESSIBILITY_KEYWORDS,
};