'use strict';

const { clean } = require('./text');
const { resolvePlaceLocal } = require('./places');

const STOP = new Set([
  'am', 'i', 'im', "i'm", 'yes', 'no', 'hi', 'hello', 'hey', 'ok', 'okay', 'sure', 'name', 'my', 'is', 'the', 'a',
  'an', 'call', 'me', 'it', 'its', "it's", 'this', 'mimi', 'jina', 'langu', 'ni', 'naitwa', 'what', 'who', 'why',
  'how', 'when', 'where', 'please', 'thanks', 'thank', 'you', 'your', 'not', 'none', 'nothing', 'skip', 'guest',
  'anonymous', 'test', 'asdf', 'thinking', 'coming', 'going', 'want', 'wanna', 'need', 'looking', 'planning',
  'trying', 'hoping', 'of', 'to', 'for', 'with', 'and', 'but', 'flight', 'flights', 'trip', 'hotel', 'hotels',
  'book', 'plan', 'travel', 'afcon', 'help', 'from', 'in', 'on', 'at',
]);

const GREET = /^(?:hi+|hello+|hey+|habari|good\s+(?:morning|afternoon|evening))\b[ ,!.]*/i;
const EXPLICIT = /^(?:my\s+name\s+is|my\s+name's|name\s+is|name's|they\s+call\s+me|people\s+call\s+me|you\s+can\s+call\s+me|just\s+call\s+me|call\s+me|jina\s+langu\s+ni|naitwa)\s+/i;
const SOFT = /^(?:i\s+am|i'm|im|am|it\s+is|it's|its|this\s+is|me|mimi\s+ni|ni)\s+/i;

const cap = (w) => w.toLowerCase().replace(/(^|[-'])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());

/**
 * "Am kelvin" -> "Kelvin", "my name is Wanjiru Kamau" -> "Wanjiru Kamau",
 * "Am thinking of coming to kenya" -> null, "Am" -> null.
 * Returns null whenever it is not confident, so the caller can simply ask again.
 */
function extractName(text) {
  let t = clean(text, 100).replace(/[^\p{L}\p{M}'\- ]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  t = t.replace(GREET, '').trim();
  let explicit = false;
  for (let i = 0; i < 4; i++) {
    let next = t;
    if (EXPLICIT.test(next)) { next = next.replace(EXPLICIT, ''); explicit = true; }
    else if (SOFT.test(next)) next = next.replace(SOFT, '');
    next = next.trim();
    if (next === t) break;
    t = next;
  }
  t = t.split(/\s+(?:and|from|here|pls|please|thanks|thank|but|so)\b/i)[0].trim();
  const parts = t.split(' ').filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  if (!explicit && parts.length > 2) return null;
  if (parts.some((p) => p.length < 2 || p.length > 20 || STOP.has(p.toLowerCase()))) return null;
  if (resolvePlaceLocal(t)) return null;
  return parts.map(cap).join(' ');
}

module.exports = { extractName };
