'use strict';

/**
 * destinationAdvisor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Answers destination knowledge questions (seasons, visas, budget, activities,
 * safety) for ANY destination using Groq, with hardcoded PROFILES as a fast
 * fallback for top East Africa / Gulf destinations.
 *
 * The traveller stays in dreaming mode until they signal they are ready to
 * search. This service never calls a supplier.
 *
 * Usage (from engine.js):
 *   const { classifyKnowledge, answerKnowledge } = require('../services/destinationAdvisor');
 *
 *   const kq = classifyKnowledge(prompt, previousParams);
 *   if (kq.type) {
 *     const answer = await answerKnowledge(kq, prompt, conversationHistory);
 *     // return answer as a clarification response, keep trip as dateless wish
 *   }
 */

const Groq = require('groq-sdk');
const { logger } = require('../utils/logger');

const MODEL = 'openai/gpt-oss-120b';

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE QUESTION PATTERNS
// ─────────────────────────────────────────────────────────────────────────────

const VISA_RE = /\bvis[ao]\b|\bpassport\b|\bentry\s+requirements?\b|\bdo\s+i\s+need\b.*\bpermit\b/i;
const BUDGET_RE = /\bhow\s+(?:much|expensive|cheap)\b|\bbudget\b|\bcost\b|\bprice\s+range\b|\baffordable\b|\bexpensive\b|\bcheap(?:er)?\b|\bvalue\b|\bworth\s+it\b/i;
const ACTIVITIES_RE = /\bwhat\s+(?:is\s+there|can\s+(?:i|we)\s+do|to\s+do|are\s+the\s+things)\b|\bactivities\b|\battractions?\b|\bsights?\b|\bthings?\s+to\s+(?:do|see)\b|\bitinerary\b|\bhighlights?\b|\bmust[\s-]see\b|\brecommend\b/i;
const SAFETY_RE = /\bsafe(?:ty|r)?\b|\bdanger(?:ous)?\b|\bcrime\b|\btravel\s+advisory\b|\bwarning\b|\bscam\b/i;
const SEASONS_RE = /\bbest\s+(?:time|month|season)\b|\bwhen\s+(?:should|to)\b|\bweather\b|\brainy?\s+season\b|\bdry\s+season\b|\bpeak\s+season\b|\boff[\s-]?season\b|\bclimat\w+\b/i;
const GENERAL_RE = /\btell\s+me\s+(?:about|more)\b|\bwhat\s+(?:is|about)\b.*\blike\b|\boverview\b|\bintroduction\b/i;

// Signals the traveller is ready to book
const READY_RE = /\b(?:ok(?:ay)?|right|great|perfect|sounds?\s+good|let(?:'?s|\s+us)\s+(?:book|search|go|check|find|look)|ready|book\s+(?:it|now|me)|find\s+(?:me\s+)?(?:flights?|hotels?|packages?))\b/i;

/**
 * Classify whether a prompt is a destination knowledge question.
 * Returns { type, destination } or { type: null } for normal flow.
 *
 * type: 'seasons' | 'visa' | 'budget' | 'activities' | 'safety' | 'general' | 'ready' | null
 */
function classifyKnowledge(prompt, previousParams = null) {
  const none = { type: null, destination: null };
  if (!prompt) return none;

  const t = prompt.toLowerCase().trim();
  const dest = previousParams?.destination || null;

  // If they're in dreaming mode and signal readiness, hand back to normal flow
  if (previousParams?._stage === 'dreaming' && READY_RE.test(t)) {
    return { type: 'ready', destination: dest };
  }

  // Only intercept knowledge questions when a destination is known
  // (either in state or mentioned in the prompt — engine.js parses it first)
  if (!dest) return none;

  // Don't intercept if a dated trip is already in progress
  if (previousParams?.departureDate && previousParams?._stage !== 'dreaming') return none;

  if (VISA_RE.test(t))       return { type: 'visa',       destination: dest };
  if (BUDGET_RE.test(t))     return { type: 'budget',     destination: dest };
  if (ACTIVITIES_RE.test(t)) return { type: 'activities', destination: dest };
  if (SAFETY_RE.test(t))     return { type: 'safety',     destination: dest };
  if (SEASONS_RE.test(t))    return { type: 'seasons',    destination: dest };
  if (GENERAL_RE.test(t))    return { type: 'general',    destination: dest };

  return none;
}

// ─────────────────────────────────────────────────────────────────────────────
// HARDCODED PROFILES (fast path, no LLM call)
// Add your top destinations here. Groq handles everything else.
// ─────────────────────────────────────────────────────────────────────────────

const PROFILES = {
  zanzibar: {
    seasons: `Zanzibar is a great choice — here's how the year breaks down:\n\n• *June–October*: cool, dry and sunny — the best overall weather. July–August are busiest and priciest.\n• *November*: short rains, usually brief showers, with good value before the festive rush.\n• *December–February*: hot, dry beach weather. Prices peak around Christmas and New Year.\n• *March–May*: long rains — heavy showers and humidity, but the lowest rates. Some lodges close.\n\nMy pick: June to October for the best mix of weather and value.`,
    visa: `Kenyan and East African passport holders get visa on arrival or e-visa for Tanzania (which covers Zanzibar). Most Western passports also qualify for e-visa. I'd recommend applying online at \`immigration.go.tz\` before you travel — it's about $50 USD and takes 1–3 days.`,
    budget: `Zanzibar suits a wide range of budgets:\n\n• *Budget*: $60–100/day — guesthouses, local food, shared transport.\n• *Mid-range*: $150–300/day — boutique hotels, half-board, private transfers.\n• *Luxury*: $400–1000+/day — private beach resorts, all-inclusive.\n\nFlights from Nairobi are typically KES 8,000–20,000 return depending on timing. I can price the full package once you pick a month.`,
    activities: `Zanzibar has a lot to offer beyond the beach:\n\n• *Stone Town* — UNESCO old town, spice tours, Freddie Mercury's birthplace.\n• *Snorkelling & diving* — Mnemba Atoll is world-class. Best visibility June–October.\n• *Dolphin tours* — Kizimkazi on the south coast.\n• *Spice farm tours* — half-day, great for families.\n• *Kitesurfing* — Paje beach, best winds June–September.\n• *Jozani Forest* — red colobus monkeys, only found here.\n\nWhat kind of trip are you after — beach, adventure, culture, or a mix?`,
    safety: `Zanzibar is generally safe for tourists. Stone Town has the usual petty theft risk in crowded areas — keep valuables close. Beach areas are relaxed. Avoid walking on beaches alone at night. The 2024 FCO and US State Dept advisories both rate it as exercise normal caution. Health: malaria prophylaxis recommended, and check your yellow fever cert if you're transiting certain countries.`,
  },
  'maasai mara': {
    seasons: `The Mara is all about timing:\n\n• *June–October*: dry season. The Great Migration arrives around July — river crossings peak August–September. Rates are highest from July.\n• *November–December*: short rains, green scenery, lower rates, price jump at Christmas.\n• *January–February*: dry again, good game viewing, quieter than migration months.\n• *March–May*: long rains — lowest rates, muddy roads, some camps close.\n\nMy pick: August–September for the migration, or January–February for value and quieter parks.`,
    visa: `Kenya e-visa is required for most nationalities — apply at \`evisa.go.ke\`. Cost is $51 USD, usually processed in 1–3 days. East African passport holders enter freely. The Mara is in Kenya, so Tanzania visa rules don't apply unless you're combining with Serengeti.`,
    budget: `Maasai Mara costs vary widely by camp tier:\n\n• *Budget*: $200–350/person/night — basic tented camps, shared facilities.\n• *Mid-range*: $400–700/person/night — comfortable camps, game drives included.\n• *Luxury*: $800–2000+/person/night — private conservancies, exclusive camps.\n\nMost camps are all-inclusive (accommodation + meals + game drives). Migration season (July–September) commands a 30–50% premium. I can price specific options once you pick dates.`,
    activities: `Beyond game drives, the Mara offers:\n\n• *Hot air balloon safaris* — sunrise over the plains, spectacular. Book ahead.\n• *Bush walks* with Maasai guides.\n• *Cultural visits* to Maasai villages.\n• *Night game drives* in private conservancies (not in the main reserve).\n• *Photography workshops* — several camps offer specialist guides.\n\nAre you after the migration specifically, or a general safari experience?`,
    safety: `The Mara is a well-established safari destination with good safety infrastructure. Stick to reputable camps and licensed guides. Don't walk outside camp at night unescorted. Nairobi airport transfers are fine via reputable operators — avoid random taxis. Health: malaria prophylaxis essential, yellow fever certificate required if arriving from endemic countries.`,
  },
};

function getProfile(destination) {
  if (!destination) return null;
  const d = destination.toLowerCase().trim();
  for (const [key, profile] of Object.entries(PROFILES)) {
    if (d === key || d.includes(key) || key.includes(d)) return profile;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROQ FALLBACK
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_PROMPTS = {
  seasons: (dest) => `You are a knowledgeable East Africa travel advisor. Give a concise season breakdown for ${dest}. Format: 4 bullet points, each covering a date range, weather note, and price/crowd note. End with one "My pick:" recommendation line. Plain text, no markdown headers, use • for bullets. Max 150 words.`,
  visa: (dest) => `You are a travel advisor. Give brief, practical visa information for ${dest} for travellers from Kenya and other African countries, plus general guidance for Western passport holders. Include approximate cost and processing time if applicable. Plain text, max 100 words. Add a note to verify with the official embassy website.`,
  budget: (dest) => `You are a travel advisor. Give a practical budget breakdown for ${dest} covering budget, mid-range, and luxury tiers (accommodation + rough daily spend). Include a note on typical flight costs from Nairobi if relevant. Plain text, use • for bullets, max 120 words.`,
  activities: (dest) => `You are a travel advisor. List the top 5–7 things to do in ${dest}, one line each with a • bullet. After the list, ask one follow-up question: what kind of trip are they after (beach/adventure/culture/family/etc). Plain text, max 150 words.`,
  safety: (dest) => `You are a travel advisor. Give a brief, honest safety overview for ${dest} — general safety level, what to watch out for, any health considerations (malaria, vaccines). Reference current FCO/US State Dept advisory level if known. Plain text, max 100 words. Do not be alarmist.`,
  general: (dest) => `You are a travel advisor. Give a brief, engaging overview of ${dest} as a travel destination — what makes it special, who it suits, best time to go in one sentence, and one thing most travellers don't know. Plain text, max 120 words. End with a question asking what kind of experience they're looking for.`,
};

async function callGroq(type, destination) {
  const groq = new Groq();
  const systemPrompt = TYPE_PROMPTS[type]?.(destination) || TYPE_PROMPTS.general(destination);

  const response = await groq.chat.completions.create({
    model: MODEL,
    max_tokens: 400,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Tell me about ${destination}.` },
    ],
  });

  return response.choices?.[0]?.message?.content?.trim() || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answer a destination knowledge question.
 * Returns a plain text string to send to the traveller.
 */
async function answerKnowledge(kq, prompt, conversationHistory = []) {
  const { type, destination } = kq;
  if (!destination || type === 'ready' || type === null) return null;

  // Fast path: hardcoded profile
  const profile = getProfile(destination);
  if (profile?.[type]) {
    logger.info('destinationAdvisor: served from profile', { type, destination });
    return profile[type];
  }

  // Groq fallback
  try {
    logger.info('destinationAdvisor: calling Groq', { type, destination });
    const answer = await callGroq(type, destination);
    if (answer) return answer;
  } catch (err) {
    logger.warn('destinationAdvisor: Groq call failed', { error: err.message, type, destination });
  }

  // Last resort
  return `I want to give you accurate information about ${destination} — let me check and get back to you. In the meantime, is there anything else about the trip you'd like to think through?`;
}

module.exports = { classifyKnowledge, answerKnowledge };
