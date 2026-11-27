'use strict';
const assert = require('assert');
const { tryEdit, pickChoice } = require('./itineraryEditGate');
const base = () => ({ _itineraryBuilt: true, origin: 'New York', finalDestination: 'New York', departureDate: '2026-12-10',
  stops: [{ city: 'Nairobi', nights: 3 }, { city: 'Maasai Mara', nights: 4 }, { city: 'Nairobi', nights: 2 }], adults: 2 });
let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; } };

t('no itinerary -> null', () => assert.strictEqual(tryEdit('make it 3 nights', { destination: 'Nairobi' }), null));
t('non-edit -> null', () => assert.strictEqual(tryEdit('is the first one refundable?', base()), null));
t('applied edit keeps other params and returns diff', () => {
  const r = tryEdit('make the mara 3 nights', base());
  assert.strictEqual(r.kind, 'applied');
  assert.strictEqual(r.tripParams.adults, 2);
  assert.strictEqual(r.tripParams.stops[1].nights, 3);
  assert.strictEqual(r.tripParams.trips, undefined);
  assert.deepStrictEqual(r.diff.kept, [0]);
});
t('ambiguous -> ask, then "second" resolves', () => {
  const a = tryEdit('drop nairobi', base());
  assert.strictEqual(a.kind, 'ask');
  const prev = { ...base(), _pendingEditChoice: a.pendingChoice };
  const r = tryEdit('the second one', prev);
  assert.strictEqual(r.kind, 'applied');
  assert.deepStrictEqual(r.tripParams.stops.map((s) => s.city), ['Nairobi', 'Maasai Mara']);
  assert.strictEqual(r.tripParams._pendingEditChoice, undefined);
});
t('unrelated reply abandons pending choice', () => {
  const a = tryEdit('drop nairobi', base());
  assert.strictEqual(tryEdit('what is the weather like', { ...base(), _pendingEditChoice: a.pendingChoice }), null);
});
t('invalid op -> error with message', () => {
  const r = tryEdit('make the mara 99 nights', base());
  assert.strictEqual(r.kind, 'error');
});
t('pickChoice', () => { const o = [{ id: 'a' }, { id: 'b' }]; assert.strictEqual(pickChoice('2', o).id, 'b'); assert.strictEqual(pickChoice('last', o).id, 'b'); assert.strictEqual(pickChoice('hmm', o), null); });
console.log(`\n${n} passed`);
