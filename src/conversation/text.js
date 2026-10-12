'use strict';

// Small text helpers shared by every module in this folder.

const CTRL = /[\u0000-\u001f\u007f]/g;

/** Trim, strip control chars, collapse whitespace, cap length. Never throws. */
function clean(s, max = 1000) {
  return String(s ?? '').normalize('NFKC').replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Lower-cased, apostrophe-normalised version of clean(). */
function norm(s, max = 1000) {
  return clean(s, max).toLowerCase().replace(/[’‘`]/g, "'");
}

/** Latin word tokens (letters, digits, apostrophes). Emoji/other scripts drop out. */
function words(s) {
  return norm(s).replace(/[^a-z0-9' ]/g, ' ').split(' ').filter(Boolean);
}

/** Levenshtein distance (small strings only). */
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const titleCase = (s) => String(s || '').replace(/\b\w/g, (c) => c.toUpperCase());

module.exports = { clean, norm, words, lev, titleCase };
