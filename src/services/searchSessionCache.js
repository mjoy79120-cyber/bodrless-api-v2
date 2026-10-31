const crypto = require('crypto');
const TTL_MS = 15 * 60 * 1000, MAX = 200;
const store = new Map();
const sig = p => [p.origin, p.destination, p.departureDate, p.returnDate,
  p.passengers || 1, p.children || 0, p.cabinClass || 'economy',
  p.outboundTransportMode || '', p.wantsTrain ? 't' : '']
  .map(x => String(x ?? '').toLowerCase()).join('|');
const newKey = () => 'sc_' + crypto.randomBytes(8).toString('hex');
function put(key, p, data) {
  if (store.size >= MAX) store.delete(store.keys().next().value);
  store.set(key, { sig: sig(p), at: Date.now(), ...data });
}
function get(key, p) {
  const e = key && store.get(key);
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) { store.delete(key); return null; }
  if (e.sig !== sig(p)) return null;
  const soon = Date.now() + 2 * 60 * 1000;
  const live = f => !f.expiresAt || new Date(f.expiresAt).getTime() > soon;
  return { ...e, outbound: e.outbound.filter(live), ret: e.ret.filter(live) };
}
module.exports = { newKey, put, get };
