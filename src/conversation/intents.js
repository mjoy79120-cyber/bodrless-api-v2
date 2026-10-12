'use strict';

const { norm, words, lev } = require('./text');
const { findPlaceMention } = require('./places');
const { parseDateLoose } = require('./dates');
const { findEvent } = require('./events');

/**
 * Deterministic intent classifier. Order matters: precise, high-stakes intents first.
 * Returns { intent, topic? } where intent is one of:
 *   order_lookup | payment_help | complaint | info_event | info_general | quote_question |
 *   help | greeting | thanks | bye | ack | trip_request | trip_vague | unclear
 *
 * trip_request  = contains at least one concrete trip fact (place, date, budget, numbers of people/nights)
 * trip_vague    = trip-flavoured words but no concrete fact ("am thinking of coming")
 */

const QUESTION_START = /^(?:when|where|what|whats|what's|which|who|whom|how|is|are|does|do|did|will|can|could|should|would|has|have|any|tell me|i want to know|i'd like to know)\b/;
const isQuestion = (t) => t.includes('?') || QUESTION_START.test(t);

const RX = {
  greeting: /^(?:hi+|hello+|hey+|hola|good\s+(?:morning|afternoon|evening)|habari|mambo|niaje|sasa|vipi|jambo)\b/,
  thanks: /^(?:thanks?|thank\s*you|thx|asante|shukran|cheers|much appreciated)\b/,
  bye: /^(?:bye+|goodbye|see\s+you|later|kwaheri|ciao|good\s*night)\b/,
  ack: /^(?:ok(?:ay)?|okey|k|alright|cool|great|nice|good|fine|sawa|poa|noted|got\s+it|i\s+see|hmm+|oh|yes|yeah|yep|no|nope|nah)[!. ]*$/,
  help: /^(?:help|help me|i need help|what can you do|how does this work|how do you work|who are you|what are you|are you (?:a )?(?:bot|human|real|ai)|what is this)\b/,
  complaint: [
    /\byou\s+(?:don'?t|dont|do not|didn'?t|didnt|did not|never)\s+(?:know|understand|get|listen|ask|even)\b/,
    /\b(?:that'?s|thats|that is|this is)\s+(?:wrong|not (?:what|right|correct))\b/,
    /\b(?:i|we)\s+(?:didn'?t|didnt|did not)\s+(?:say|ask|mean)\b/,
    /\bnot\s+what\s+i\s+(?:said|asked|meant|wanted)\b/,
    /\byou\s+keep\s+(?:asking|repeating|saying)\b/,
    /\b(?:stop|quit)\s+(?:asking|repeating)\b/,
    /\bare you (?:even )?(?:listening|stupid|dumb)\b/,
    /\bwhy\s+(?:are|do)\s+you\s+(?:keep|ask)/,
  ],
  payNoun: /\b(mpesa|m-pesa|m pesa|stk|payment|payments|pay|paid|paying|pin)\b/,
  payTrouble: /\b(fail|failed|failing|didn'?t|did not|not|no|stuck|error|retry|again|declin\w*|reject\w*|cancel\w*|problem|issue|prompt|push|receive\w*|got|timeout|timed out|deducted|charged|double)\b/,
  payHow: /\b(how (?:do|can|to|should) i pay|payment (?:options|methods|method)|pay with|accept (?:card|visa|mpesa))\b/,
  orderDid: /\b(?:did|has|was|is)\s+(?:my|the)\s+(?:booking|payment|order|flight|reservation)\b.*\b(?:go|went|confirm\w*|succe\w*|work\w*|through|paid|done)\b/,
  orderWhere: /\bwhere(?:'s|s| is)\s+(?:my|the)\s+(?:order|booking|ticket|reservation|confirmation)\b/,
  orderStatus: /\b(?:my|the)\s+(?:order|booking|reservation)\s+(?:status|details|number|id|code)\b/,
  orderConfirmCode: /\bconfirmation\b.*\b(?:number|code|ref\w*)\b/,
  quoteTopic: /\b(refund\w*|cancel\w*|change fee|baggage|luggage|bags?|carry[- ]?on|checked|included|inclusive|breakfast|meals?|transfers?|stops?|layover|duration|how long|which airline|what airline|terms|policy|non[- ]?refundable|hold|option\s*\d)\b/,
  tripFlavour: /\b(plan|book|booking|trip|travel\w*|fly|flying|flight|flights|hotel|hotels|stay|vacation|holiday|honeymoon|safari|getaway|visit\w*|going|go|coming|come|tour|package|accommodation|transfer|itinerary|quote|price|prices|cost|cheap\w*|nights?|days?|pax|people|adults?|children|kids?|couple|family|budget|expensive|luxury)\b/,
  tripStruct: /\b(book|flight|flights|fly|flying|hotel|hotels|stay|accommodation|plan (?:a |my )?trip|package|quote|itinerary|transfer)\b/,
  budget: /\b(?:kes|ksh|shillings?|bob|usd|dollars?)\b|\b\d+\s?k\b|\b\d{4,}\b/,
  paxNights: /\b\d+\s*(?:people|persons|pax|adults?|travell?ers?|of us|nights?|days?|kids?|children|guests?|passengers?)\b|\b(?:couple|family|solo|alone|my (?:wife|husband|partner))\b/,
  infoGeneral: [
    { topic: 'visa', rx: /\b(visa|eta|e-?visa|entry requirements?|passport (?:rules|requirements?)|yellow fever|vaccinat\w*|covid)\b/ },
    { topic: 'weather', rx: /\b(weather|climate|temperature|rain(?:y|s)?|season|hot|cold)\b/ },
    { topic: 'safety', rx: /\b(safe|safety|security|crime|dangerous)\b/ },
    { topic: 'money', rx: /\b(currency|exchange rate|forex|dollar rate|atm|tipping)\b/ },
    { topic: 'connectivity', rx: /\b(sim card|data bundle|wifi|wi-fi|internet|roaming)\b/ },
  ],
};

// "ref", "refs", "reference(s)" and typos like "refenrence"/"refrence". NOT refund/refundable/refer.
function refWordPresent(toks) {
  return toks.some((w) => w === 'ref' || w === 'refs' || w === 'ref#' || (w.length >= 7 && w.length <= 11 && lev(w, 'reference') <= 2));
}

function classify(rawText, ctx = {}) {
  const t = norm(rawText);
  const toks = words(rawText);
  if (!t || (!toks.length && !/\d/.test(t))) return { intent: 'unclear', reason: 'empty' };

  // order lookup (typos allowed: "refenrence")
  const orderWord = toks.some((w) => ['order', 'booking', 'reservation', 'ticket', 'payment', 'confirmation', 'trip'].includes(w));
  const posesive = toks.includes('my') || toks.includes('the') || toks.includes('what') || toks.includes('whats') || toks.includes("what's");
  if ((refWordPresent(toks) && (orderWord || posesive)) || RX.orderWhere.test(t) || RX.orderStatus.test(t) || RX.orderDid.test(t) || RX.orderConfirmCode.test(t)) {
    return { intent: 'order_lookup' };
  }

  // payment trouble / how to pay
  if ((RX.payNoun.test(t) && RX.payTrouble.test(t) && !RX.tripStruct.test(t)) || RX.payHow.test(t) || /\b(retry|resend)\b.*\b(payment|prompt|stk|mpesa|m-pesa)\b/.test(t)) {
    return { intent: 'payment_help' };
  }

  // complaints/corrections (only when no place is named; "I said Mombasa" is a trip correction)
  if (RX.complaint.some((r) => r.test(t)) && !findPlaceMention(t)) return { intent: 'complaint' };

  // event questions (AFCON etc.) that are not trip requests
  if (ctx.events && findEvent(ctx.events, t) && isQuestion(t) && !RX.tripStruct.test(t)) {
    return { intent: 'info_event' };
  }

  // general travel-info questions we cannot answer authoritatively
  if (isQuestion(t) || toks.length <= 4) {
    for (const g of RX.infoGeneral) {
      if (g.rx.test(t) && !RX.tripStruct.test(t)) return { intent: 'info_general', topic: g.topic };
    }
  }

  // questions about the quote on screen
  if ((ctx.hasPackages || ctx.hasTrip) && isQuestion(t) && RX.quoteTopic.test(t) && !/\b(book me|i want|i need|find me|plan)\b/.test(t)) {
    return { intent: 'quote_question' };
  }

  // small talk
  if (RX.help.test(t)) return { intent: 'help' };
  if (toks.length <= 3 && RX.greeting.test(t) && !findPlaceMention(t)) return { intent: 'greeting' };
  if (toks.length <= 5 && RX.thanks.test(t)) return { intent: 'thanks' };
  if (toks.length <= 3 && RX.bye.test(t)) return { intent: 'bye' };
  if (RX.ack.test(t)) return { intent: 'ack' };

  // trip facts
  const hasFact = !!(findPlaceMention(t) || parseDateLoose(t, ctx.now || new Date()) || RX.budget.test(t) || RX.paxNights.test(t));
  if (hasFact) return { intent: 'trip_request' };
  // structural booking words (book/flight/hotel/etc.) are concrete enough to be a request, not vague
  if (RX.tripStruct.test(t) && isQuestion(t)) return { intent: 'trip_request' };
  if (RX.tripFlavour.test(t)) return { intent: 'trip_vague' };
  return { intent: 'unclear' };
}

const STRONG = new Set(['order_lookup', 'payment_help', 'complaint', 'info_event', 'info_general', 'quote_question', 'help']);
const LABELS = new Set(['trip_request', 'info_event', 'info_general', 'order_lookup', 'payment_help', 'complaint', 'greeting', 'thanks', 'bye', 'ack', 'help', 'trip_vague', 'unclear', 'quote_question']);

module.exports = { classify, STRONG, LABELS, isQuestion };
