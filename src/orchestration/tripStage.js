'use strict';

/**
 * tripStage.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Where is this traveller in their journey, and what should the bot do about it?
 *
 *   mode 'advise'  → they are dreaming, undecided, or asking WHEN to go.
 *                    Answer the question, keep the trip as a dateless wish.
 *                    Do NOT call a supplier. NEVER invent a date.
 *   mode null      → normal flow (existing slot-filling + search in engine.js).
 *
 * Deterministic on purpose: no LLM, no I/O. Fast, free and unit-testable
 * (see stage-cases.cjs). The season notes in PROFILES are general guidance;
 * overwrite them with your own operator knowledge, and add destinations over time.
 */

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// ─────────────────────────────────────────────
// WHAT COUNTS AS "THE TRAVELLER GAVE US A WINDOW"
// ─────────────────────────────────────────────
// "may" is also a verb ("I may go"), so it only counts as a month with context.
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b(?:in|on|by|during|around|early|mid|late|of)\s+(may)\b|\b(may)\s+\d{1,2}\b/i;

const WINDOW_RE = new RegExp(String.raw`\b(?:christmas|xmas|easter|new\s+year|school\s+holidays?|half[\s-]?term|summer|winter|spring|autumn|long\s+weekend|this\s+weekend|next\s+week(?:end)?|next\s+month|this\s+month|tomorrow|today|tonight|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|in\s+(?:\d+|a|an|one|two|three|four|five|six)\s+(?:days?|weeks?|months?)|\d{1,2}(?:st|nd|rd|th)|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)\b`, 'i');

// ─────────────────────────────────────────────
// SIGNALS
// ─────────────────────────────────────────────
const NEG = String.raw`(?:\bnot|n't|\b(?:aint|havent|hasnt|isnt|dont))`;
const WHEN_WORD = String.raw`(?:on\s+|about\s+)?(?:when|the\s+dates?|dates?|timing|what\s+(?:month|time|dates?))\b`;

// "not sure when", "ain't sure when", "don't know when", "haven't decided on dates", "no dates yet"
const UNDECIDED_WHEN = [
  new RegExp(`${NEG}\\s+(?:really\\s+|too\\s+|entirely\\s+|quite\\s+)?(?:sure|certain|decided|clear)\\s+(?:yet\\s+)?${WHEN_WORD}`),
  new RegExp(`${NEG}\\s+(?:yet\\s+)?(?:know|decided|picked|chosen|settled|set|fixed|confirmed)\\s+(?:yet\\s+)?${WHEN_WORD}`),
  /\b(?:dunno|no\s+idea|unsure|undecided)\s+(?:on\s+|about\s+)?(?:when|the\s+dates?|dates?|timing)\b/,
  /\bno\s+(?:fixed\s+|set\s+|specific\s+|exact\s+|firm\s+)?dates?\b/,
  /\bdates?\s+(?:are|is)\s*(?:n't|not|nt)\s+(?:fixed|set|decided|confirmed|sorted)\b/,
  /\b(?:sometime|someday|eventually|at\s+some\s+point)\b/,
];

// "thinking about going", "considering booking a trip", "I'd love to visit"
const DREAMING = [
  /\b(?:thinking|considering|dreaming|wondering|toying)\s+(?:about|of|on|with)?\s*(?:going|travell?ing|visiting|booking|taking|planning|flying|a\s+(?:trip|holiday|vacation|getaway))\b/,
  /\b(?:might|may)\s+(?:go|travel|visit|fly)\b/,
  /\b(?:would|i'd|id)\s+love\s+to\s+(?:go|visit|travel|see)\b/,
];

// Seasonal questions: "which month is cheapest", "when should I go", "is it peak season".
const TIMING_STRONG = [
  /\bbest\s+(?:month|months|season|period)\b/,
  /\b(?:cheapest|cheaper|lowest|quietest|busiest)\s+(?:time|month|months|season|period)\b/,
  /\b(?:which|what)\s+month\b|\bwhat\s+time\s+of\s+(?:the\s+)?year\b|\btime\s+of\s+year\b/,
  /\bwhen\s+(?:should\s+i|should\s+we|to\s+(?:go|visit|travel|fly)|is\s+(?:the\s+)?best|are\s+the\s+best|is\s+(?:it\s+)?(?:good|cheapest|cheaper))\b/,
  /\b(?:high|low|peak|off|shoulder|rainy|dry|wet|rain|migration)[\s-]+season\b/,
];

// Ambiguous: "best time" can mean the season OR the clock time of a flight.
// Only trusted when no dated trip is in progress (or we just asked "when are you travelling?").
const TIMING_LOOSE = [
  /\bbest\s+(?:time|times)\b/,
  /\bgood\s+time\s+to\s+(?:go|visit|travel|fly|book)\b/,
  /\b(?:what|which)\s+time\s+(?:is|would\s+be|will\s+be)\s+(?:the\s+)?(?:best|better|good|ideal|cheapest)\b/,
];

// Only trusted when the bot has JUST asked "when are you travelling?"
const FLEXIBLE_ANSWER = /^\W*(?:i\s+)?(?:am\s+|i'?m\s+)?(?:still\s+)?(?:not\s+(?:really\s+)?sure|ain'?t\s+sure|unsure|no\s+idea|dunno|don'?t\s+know|undecided|not\s+decided|haven'?t\s+decided|flexible|anytime|any\s*time|whenever|open|open\s+to\s+(?:anything|suggestions)|no\s+preference|doesn'?t\s+matter|up\s+to\s+you|surprise\s+me|whatever(?:\s+works)?|no\s+specific)/;

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function norm(s) {
  return String(s || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
}

function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

function titleCase(s) {
  return String(s || '').replace(/\b\w/g, c => c.toUpperCase());
}

function monthMentioned(text) {
  const m = MONTH_RE.exec(norm(text));
  if (!m) return null;
  const name = (m[1] || m[2] || m[3]).toLowerCase().slice(0, 3);
  return MONTH_NUM[name] || null;
}

function hasWindow(text) {
  const t = norm(text);
  return monthMentioned(t) != null || WINDOW_RE.test(t);
}

function isYearOnly(t) {
  const next = new Date().getFullYear() + 1;
  return new RegExp(String.raw`\bnext\s+year\b|\b${next}\b`).test(t);
}

function soundsUndecided(t) {
  return UNDECIDED_WHEN.some(p => p.test(t)) || DREAMING.some(p => p.test(t)) || isYearOnly(t);
}

/** True when the message is vague about timing and gave no real window. Used by the parser's date guard. */
function isVagueTiming(prompt) {
  const t = norm(prompt);
  if (!t || hasWindow(t)) return false;
  return soundsUndecided(t);
}

// ─────────────────────────────────────────────
// CLASSIFIER
// ─────────────────────────────────────────────
function classify(prompt, previousParams = null) {
  const none = { mode: null, reason: null, month: null, dateCertainty: null };
  const t = norm(prompt);
  if (!t) return none;

  const awaiting = previousParams?._awaitingClarification?.type || null;
  const month = monthMentioned(t);
  const windowGiven = month != null || WINDOW_RE.test(t);

  // 1. They are asking WHEN. That is a knowledge question, not a search.
  //    "best time to fly on friday" is about a clock time, so a day/date window rules it out
  //    (a month is fine: "is March a good time to visit?").
  const datedTripInProgress = !!previousParams?.departureDate && awaiting !== 'departure_date';
  const asksTiming =
    TIMING_STRONG.some(p => p.test(t)) || (!datedTripInProgress && TIMING_LOOSE.some(p => p.test(t)));
  if (asksTiming && (month != null || !windowGiven)) {
    return { mode: 'advise', reason: 'timing_question', month, dateCertainty: windowGiven ? 'vague' : 'none' };
  }

  // 2. They named a window ("March", "next Friday"): the normal flow can handle it.
  // But only exit early if they are NOT also dreaming or undecided � "next year, not sure when" must reach check 4.
  if (windowGiven && !DREAMING.some(p => p.test(t)) && !UNDECIDED_WHEN.some(p => p.test(t)) && !isYearOnly(t)) return none;

  // 3. We just asked "when?" and they said "not sure / flexible / whenever".
  if (awaiting === 'departure_date' && wordCount(t) <= 8 && FLEXIBLE_ANSWER.test(t)) {
    return { mode: 'advise', reason: 'flexible_answer', month: null, dateCertainty: 'none' };
  }

  // 4. Undecided / dreaming / "next year", unless a dated trip is already in progress.
  if (!datedTripInProgress) {
    if (UNDECIDED_WHEN.some(p => p.test(t))) return { mode: 'advise', reason: 'undecided', month: null, dateCertainty: 'none' };
    if (DREAMING.some(p => p.test(t)))       return { mode: 'advise', reason: 'dreaming', month: null, dateCertainty: 'none' };
    if (isYearOnly(t))                       return { mode: 'advise', reason: 'year_only', month: null, dateCertainty: 'vague' };
  }

  return none;
}

// ─────────────────────────────────────────────
// SEASON NOTES (edit freely)
// ─────────────────────────────────────────────
// windows[].months are in calendar order (they may wrap the year: [12, 1, 2]).
const PROFILES = [
  {
    key: 'zanzibar',
    aliases: ['zanzibar', 'stone town', 'nungwi', 'kendwa', 'paje', 'jambiani', 'kiwengwa', 'matemwe'],
    windows: [
      { months: [6, 7, 8, 9, 10], note: 'cool, dry and sunny, the best overall weather. July and August are the busiest and priciest' },
      { months: [11], note: 'short rains, usually brief showers, with good value before the festive rush' },
      { months: [12, 1, 2], note: 'hot, dry beach weather. Prices peak around Christmas and New Year' },
      { months: [3, 4, 5], note: 'long rains, so heavy showers and humidity, but the lowest rates. Some lodges close' },
    ],
    pick: 'June to October for the best mix of weather and value',
  },
  {
    key: 'maasai mara',
    aliases: ['maasai mara', 'masai mara', 'mara', 'the mara'],
    windows: [
      { months: [6, 7, 8, 9, 10], note: 'dry season. The Great Migration usually arrives around July, with river crossings at their best from August to September. Rates are highest from July' },
      { months: [11, 12], note: 'short rains bring green scenery and lower rates, with a price jump over Christmas' },
      { months: [1, 2], note: 'dry again with good game viewing, and quieter than the migration months' },
      { months: [3, 4, 5], note: 'long rains, with the lowest rates but muddy roads. Some camps close' },
    ],
    pick: 'August to September for the migration, or January to February for good value and quieter parks',
  },
  {
    key: 'mombasa',
    aliases: ['mombasa', 'diani', 'diani beach', 'malindi', 'watamu', 'kilifi', 'nyali'],
    windows: [
      { months: [12, 1, 2, 3], note: 'hot, dry and sunny with calm seas. Peak season, especially around Christmas and New Year' },
      { months: [4, 5, 6], note: 'long rains, with the lowest rates but heavy showers. Some places close' },
      { months: [7, 8, 9, 10], note: 'cooler, dry and breezy, with good value and fewer crowds' },
      { months: [11], note: 'short rains, usually brief showers' },
    ],
    pick: 'July to October for good weather and value, or January to March if you want it hot',
  },
  {
    key: 'dubai',
    aliases: ['dubai', 'abu dhabi'],
    windows: [
      { months: [11, 12, 1, 2, 3], note: 'pleasant, sunny weather, the best time for outdoor plans. December and January are peak season with the highest prices' },
      { months: [4, 5], note: 'getting hot, with lower rates' },
      { months: [6, 7, 8, 9, 10], note: 'very hot and humid, with the lowest rates. Fine if you plan around air-conditioning' },
    ],
    pick: 'November to March for the weather, or June to September if price matters most',
  },
];

function lookup(destination) {
  const d = norm(destination);
  if (!d) return null;
  return PROFILES.find(p => p.aliases.some(a => d === a || d.startsWith(a + ' ') || d.endsWith(' ' + a))) || null;
}

function rangeLabel(months) {
  const first = MONTH_NAMES[months[0] - 1];
  const last = MONTH_NAMES[months[months.length - 1] - 1];
  return months.length === 1 ? first : `${first}–${last}`;
}

// ─────────────────────────────────────────────
// ADVICE BUILDER
// ─────────────────────────────────────────────
function buildAdvice(destination, { reason = null, month = null } = {}) {
  const label = titleCase(destination);
  const profile = lookup(destination);

  // Warm acknowledgement first (no flat "Got it" openers), then the answer.
  const ack =
    reason === 'flexible_answer'
      ? `Flexible is great, it means you can pick the sweet spot. `
      : reason === 'timing_question'
        ? ''
        : `${label} is a great choice, and not having a date yet is fine. `;

  if (!profile) {
    return `${ack}I don't want to guess at the best months for ${label} without checking. ` +
      `Tell me what matters most, weather, price or avoiding crowds, and roughly when you're free, and I'll look at fares around then.`;
  }

  const parts = [];
  let verdictMonth = null;

  if (month && reason === 'timing_question') {
    const w = profile.windows.find(x => x.months.includes(month));
    if (w) {
      verdictMonth = MONTH_NAMES[month - 1];
      parts.push(`${verdictMonth} falls in the ${rangeLabel(w.months)} stretch: ${w.note}.`);
      parts.push(`Here's the full picture for ${label}:`);
    }
  }
  if (parts.length === 0) {
    const lead = reason === 'flexible_answer' || reason === 'timing_question'
      ? `Here's how ${label} looks through the year:`
      : `Timing makes a real difference in ${label}, so here's how the year looks:`;
    parts.push(`${ack}${lead}`.trim());
  }

  const lines = profile.windows.map(w => `• *${rangeLabel(w.months)}*: ${w.note}.`);
  const closing = verdictMonth
    ? `If ${verdictMonth} works for you, tell me where you're flying from and I'll price flights and hotels.`
    : `Do you have a month in mind, or dates you need to work around? Tell me roughly when (and where you're flying from) and I'll price flights and hotels.`;

  return [
    parts.join(' '),
    lines.join('\n'),
    `My pick: ${profile.pick}.`,
    closing,
  ].join('\n\n');
}

module.exports = {
  classify,
  isVagueTiming,
  hasWindow,
  monthMentioned,
  buildAdvice,
};

