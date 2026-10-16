// utils/dateResolver.js — deterministic date parsing, always anchored to "today"
const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const m2n = s => MONTHS[s.slice(0, 3)];
const WORD_NUM = { a: 1, one: 1, two: 2, three: 3 };

const utcDay = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// next month/day on or after `notBefore` (default: today)
function nextOccurrence(month, day, now = new Date(), notBefore = null) {
  const floor = notBefore ? new Date(notBefore + 'T00:00:00Z') : utcDay(now);
  let d = new Date(Date.UTC(floor.getUTCFullYear(), month - 1, day));
  if (d < floor) d = new Date(Date.UTC(floor.getUTCFullYear() + 1, month - 1, day));
  return iso(d);
}

// push any past date forward by whole years until it is today or later
function rollForward(isoStr, now = new Date()) {
  if (!isoStr) return isoStr;
  const floor = utcDay(now);
  const d = new Date(isoStr + 'T00:00:00Z');
  if (isNaN(d)) return isoStr;
  while (d < floor) d.setUTCFullYear(d.getUTCFullYear() + 1);
  return iso(d);
}

function parseDateExpression(text, { now = new Date(), currentDeparture = null } = {}) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  const today = iso(utcDay(now));
  const out = (departureDate, returnDate = null, approx = false) => ({ departureDate, returnDate, approx });

  const isoM = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoM) return out(isoM[1]);

  const fz = t.match(new RegExp(`\\b(early|mid|late|end of)\\s+${MON}\\b`));
  if (fz) {
    const day = fz[1] === 'early' ? 5 : fz[1] === 'mid' ? 15 : 25;
    return out(nextOccurrence(m2n(fz[2]), day, now), null, true);
  }

  const re = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\b|\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g');
  const hits = []; let m;
  while ((m = re.exec(t))) {
    const day = parseInt(m[1] || m[4], 10);
    if (day >= 1 && day <= 31) hits.push({ month: m2n(m[2] || m[3]), day, end: re.lastIndex });
  }
  if (hits.length) {
    const dep = nextOccurrence(hits[0].month, hits[0].day, now);
    let ret = null;
    if (hits.length >= 2) {
      ret = nextOccurrence(hits[1].month, hits[1].day, now, dep);
    } else {
      const tail = t.slice(hits[0].end).match(/^\s*(?:to|until|till|-|–)\s*(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:nights?|days?|people|pax|adults?))/);
      if (tail) {
        const dd = new Date(dep + 'T00:00:00Z');
        let rd = new Date(Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth(), +tail[1]));
        if (rd <= dd) rd = new Date(Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 1, +tail[1]));
        ret = iso(rd);
      }
    }
    return out(dep, ret);
  }

  if (/\btomorrow\b/.test(t)) return out(addDays(today, 1));
  if (/\bnext week\b/.test(t)) return out(addDays(today, 7));
  if (/\b(?:next|this) weekend\b/.test(t)) {
    const add = ((6 - utcDay(now).getUTCDay()) + 7) % 7 || 7;
    return out(addDays(today, add));
  }
  const inN = t.match(/\bin\s+(\d+|a|one|two|three)\s+(day|week|month)s?\b/);
  if (inN) {
    const n = WORD_NUM[inN[1]] || +inN[1];
    return out(addDays(today, n * (inN[2] === 'week' ? 7 : inN[2] === 'month' ? 30 : 1)));
  }
  const later = t.match(/\b(\d+|a|one|two|three)\s+(day|week)s?\s+(?:later|after)\b/);
  if (later && currentDeparture) {
    const n = WORD_NUM[later[1]] || +later[1];
    return out(addDays(currentDeparture, n * (later[2] === 'week' ? 7 : 1)));
  }

  const bare = t.match(new RegExp(`^(?:in |around |during |sometime in |maybe |for )?${MON}[\\s.!]*$`));
  if (bare) {
    const n = m2n(bare[1]);
    const dep = n === now.getUTCMonth() + 1 ? addDays(today, 7) : nextOccurrence(n, 1, now);
    return out(dep, null, true);
  }
  return null;
}

module.exports = { parseDateExpression, rollForward, nextOccurrence, addDays, diffDays };