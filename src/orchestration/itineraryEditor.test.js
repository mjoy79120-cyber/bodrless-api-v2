'use strict';
const assert = require('assert');
const E = require('./itineraryEditor');

let passed = 0;
const t = (name, fn) => { try { fn(); passed++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n    ', e.message); process.exitCode = 1; } };

const base = () => E.createDraft({
  origin: 'New York', finalDestination: 'New York', departureDate: '2026-12-10',
  stops: [{ city: 'Nairobi', nights: 3 }, { city: 'Maasai Mara', nights: 4 }, { city: 'Nairobi', nights: 2 }],
});
const stays = (res) => res.plan.segments.filter((s) => s.type === 'stay').map((s) => `${s.city} ${s.checkIn}>${s.checkOut}`);

t('baseline dates chain (overnight arrival)', () => {
  const p = E.buildPlan(base());
  assert.ok(p.ok);
  assert.deepStrictEqual(p.segments.filter((s) => s.type === 'stay').map((s) => s.checkIn + '>' + s.checkOut),
    ['2026-12-11>2026-12-14', '2026-12-14>2026-12-18', '2026-12-18>2026-12-20']);
  assert.strictEqual(p.returnDate, '2026-12-20');
});

t('setNights on the Mara shifts later stops and the flight home', () => {
  const d = base();
  const r = E.parseEdit('make the mara 3 nights', d);
  assert.strictEqual(r.op.type, 'setNights');
  const res = E.applyOp(d, r.op);
  assert.ok(res.ok, res.error);
  assert.deepStrictEqual(stays(res), ['Nairobi 2026-12-11>2026-12-14', 'Maasai Mara 2026-12-14>2026-12-17', 'Nairobi 2026-12-17>2026-12-19']);
  assert.strictEqual(res.plan.returnDate, '2026-12-19');
  assert.ok(/1 day earlier/.test(res.message), res.message);
  assert.ok(/19 Dec/.test(res.message), res.message);
});

t('diff keeps the first leg (picks survive) and re-searches the rest', () => {
  const d = base();
  const before = E.buildPlan(d);
  const res = E.applyOp(d, { type: 'setNights', target: d.stops[1].id, nights: 3 });
  const diff = E.diffPlans(before.trips, res.plan.trips);
  assert.deepStrictEqual(diff.kept, [0]);
  assert.deepStrictEqual(diff.changed, [1, 2, 3]);
  assert.strictEqual(diff.firstChanged, 1);
  assert.strictEqual(diff.carry[0], 0);
  assert.strictEqual(diff.moved[1], 1); // new Mara leg <- old Mara leg (one-tap "keep your earlier pick")
});

t('extending the last stop only changes the last two legs', () => {
  const d = base();
  const before = E.buildPlan(d);
  const res = E.applyOp(d, { type: 'addNights', target: d.stops[2].id, delta: 1 });
  const diff = E.diffPlans(before.trips, res.plan.trips);
  assert.deepStrictEqual(diff.kept, [0, 1]);
  assert.deepStrictEqual(diff.changed, [2, 3]);
  assert.strictEqual(res.plan.returnDate, '2026-12-21');
});

t('ambiguous city asks which stay, with dates, and options carry ready-made ops', () => {
  const d = base();
  const r = E.parseEdit('drop nairobi', d);
  assert.ok(r.needsChoice);
  assert.strictEqual(r.needsChoice.options.length, 2);
  assert.ok(/first Nairobi stay \(.*11 Dec/.test(r.needsChoice.question), r.needsChoice.question);
  const res = E.applyOp(d, r.needsChoice.options[1].op);
  assert.ok(res.ok);
  assert.strictEqual(res.draft.stops.length, 2);
  assert.strictEqual(res.draft.stops[1].city, 'Maasai Mara');
});

t('ordinal resolves without asking', () => {
  const d = base();
  const r = E.parseEdit('skip the second nairobi', d);
  assert.strictEqual(r.op.type, 'removeStop');
  assert.strictEqual(r.op.target, d.stops[2].id);
});

t('add a stop at the end, with nights', () => {
  const d = base();
  const r = E.parseEdit('add mombasa for 2 nights at the end', d);
  const res = E.applyOp(d, r.op);
  assert.ok(res.ok, res.error);
  assert.strictEqual(res.draft.stops.length, 4);
  assert.strictEqual(res.draft.stops[3].city, 'Mombasa');
  assert.strictEqual(res.plan.returnDate, '2026-12-22');
  assert.strictEqual(res.draft.finalDestination, 'New York');
});

t('add a stop after a named stop', () => {
  const d = base();
  const r = E.parseEdit('add zanzibar for 3 nights after the mara', d);
  const res = E.applyOp(d, r.op);
  assert.ok(res.ok, res.error);
  assert.deepStrictEqual(res.draft.stops.map((s) => s.city), ['Nairobi', 'Maasai Mara', 'Zanzibar', 'Nairobi']);
});

t('"add a hotel" is not a stop', () => {
  assert.strictEqual(E.parseEdit('add a hotel', base()), null);
  assert.strictEqual(E.parseEdit('add breakfast', base()), null);
});

t('one more night in the mara', () => {
  const d = base();
  const r = E.parseEdit('one more night in the mara', d);
  const res = E.applyOp(d, r.op);
  assert.strictEqual(res.draft.stops[1].nights, 5);
});

t('3 nights in the mara instead', () => {
  const d = base();
  const res = E.applyOp(d, E.parseEdit('3 nights in the mara instead', d).op);
  assert.strictEqual(res.draft.stops[1].nights, 3);
});

t('start date change moves everything', () => {
  const d = base();
  const r = E.parseEdit('leave on 12 december', d);
  assert.strictEqual(r.op.date, '2026-12-12');
  const res = E.applyOp(d, r.op);
  assert.strictEqual(res.plan.returnDate, '2026-12-22');
});

t('cannot remove the only stop; nights bounded', () => {
  const d = E.createDraft({ origin: 'Nairobi', departureDate: '2026-12-10', stops: [{ city: 'Zanzibar', nights: 4 }] });
  assert.strictEqual(E.applyOp(d, { type: 'removeStop', target: d.stops[0].id }).ok, false);
  assert.strictEqual(E.applyOp(d, { type: 'setNights', target: d.stops[0].id, nights: 0 }).ok, false);
  assert.strictEqual(E.applyOp(d, { type: 'setNights', target: d.stops[0].id, nights: 99 }).ok, false);
});

t('not an edit -> null (falls through to the engine / LLM)', () => {
  const d = base();
  assert.strictEqual(E.parseEdit('is the first one refundable?', d), null);
  assert.strictEqual(E.parseEdit('drop the price a bit', d), null);
  assert.strictEqual(E.parseEdit('thanks!', d), null);
});

t('input draft is never mutated', () => {
  const d = base(); const snap = JSON.stringify(d);
  E.applyOp(d, { type: 'setNights', target: d.stops[0].id, nights: 5 });
  assert.strictEqual(JSON.stringify(d), snap);
});

console.log(`\n${passed} passed`);
