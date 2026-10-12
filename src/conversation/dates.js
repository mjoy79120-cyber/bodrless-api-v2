'use strict';

const { norm } = require('./text');

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RX = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const startOfDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

function validDay(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(base, n) {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a loose date answer. Returns { iso, precision } or null.
 * `now` is injectable for tests. Dates in the past roll to next year when no year was given.
 * Dates more than ~2 years out, or impossible dates, return null.
 */
function parseDateLoose(text, now = new Date()) {
  const t = norm(text, 200);
  if (!t) return null;
  const today = startOfDay(now);
  const y0 = today.getUTCFullYear();
  const limit = new Date(today.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 2);

  const finish = (y, m, d, precision, hadYear) => {
    if (!validDay(y, m, d)) return null;
    let dt = new Date(Date.UTC(y, m - 1, d));
    if (dt < today && !hadYear) {
      y += 1;
      if (!validDay(y, m, d)) return null;
      dt = new Date(Date.UTC(y, m - 1, d));
    }
    if (dt < today || dt > limit) return null;
    return { iso: iso(y, m, d), precision };
  };

  let m = t.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (m) return finish(+m[1], +m[2], +m[3], 'day', true);

  m = t.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RX}\\b(?:\\s*,?\\s*(20\\d{2}))?`));
  if (m) return finish(m[3] ? +m[3] : y0, MONTHS[m[2]], +m[1], 'day', !!m[3]);

  m = t.match(new RegExp(`\\b${MONTH_RX}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(20\\d{2}))?`));
  if (m) return finish(m[3] ? +m[3] : y0, MONTHS[m[1]], +m[2], 'day', !!m[3]);

  m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m) {
    const yr = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : y0;
    return finish(yr, +m[2], +m[1], 'day', !!m[3]);
  }

  m = t.match(new RegExp(`\\b(early|mid|middle of|late|end of)\\s+${MONTH_RX}\\b`));
  if (m) {
    const day = m[1] === 'early' ? 5 : m[1].startsWith('mid') ? 15 : 25;
    return finish(y0, MONTHS[m[2]], day, 'month', false);
  }

  if (/\btomorrow\b/.test(t)) return { iso: addDays(today, 1), precision: 'day' };
  if (/\bnext week\b/.test(t)) return { iso: addDays(today, 7), precision: 'day' };
  if (/\bnext month\b/.test(t)) return { iso: addDays(today, 30), precision: 'month' };
  if (/\bthis weekend\b/.test(t)) return { iso: addDays(today, ((6 - today.getUTCDay()) + 7) % 7 || 7), precision: 'day' };
  m = t.match(/\bin (\d{1,3}) (day|days|week|weeks)\b/);
  if (m) return { iso: addDays(today, +m[1] * (m[2].startsWith('week') ? 7 : 1)), precision: 'day' };

  m = t.match(new RegExp(`(?:^|\\b(?:in|during|around|sometime in|maybe|probably)\\s+)${MONTH_RX}\\s*(?:ish|time)?\\s*[.!]*$`));
  if (m) return finish(y0, MONTHS[m[1]], 1, 'month', false);

  return null;
}

const FLEXIBLE = /\b(flexible|anytime|any time|open dates?|not sure|don'?t mind|whenever|no preference|up to you|surprise me|doesn'?t matter|no specific)\b/i;
const isFlexibleDateAnswer = (t) => FLEXIBLE.test(norm(t));

function formatHuman(isoDate) {
  try {
    return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch { return isoDate; }
}

module.exports = { parseDateLoose, isFlexibleDateAnswer, formatHuman };
