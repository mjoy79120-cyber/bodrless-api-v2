// Regression cases for tripStage.classify. Run from the repo root:  node stage-cases.cjs
// Add every piece of friend feedback here as a new row: [label, prompt, previousParams, expected mode, expected reason?]
let tripStage;
try { tripStage = require('./src/orchestration/tripStage'); } catch (e) { tripStage = require('./tripStage'); }

const AWAIT_DATE = { destination: 'Zanzibar', _awaitingClarification: { type: 'departure_date' } };
const AWAIT_ORIGIN = { destination: 'Zanzibar', _awaitingClarification: { type: 'single_origin' } };
const DATED = { destination: 'Zanzibar', origin: 'Nairobi', departureDate: '2026-12-05' };

const CASES = [
  // The original feedback
  ['friend: considering Zanzibar next year, not sure when', "I am considering booking a trip next year to Zanzibar, ain't sure when", null, 'advise'],
  // Asking WHEN is a knowledge question
  ['best time question', 'When is the best time to visit Zanzibar?', null, 'advise', 'timing_question'],
  ['when should I go', 'when should I travel to Dubai', null, 'advise', 'timing_question'],
  ['month verdict', 'Is March a good time to visit Zanzibar?', null, 'advise', 'timing_question'],
  ['season question', 'is it peak season in december?', null, 'advise', 'timing_question'],
  // From a real tester: the answer to "when are you travelling?"
  ['tester: next year, not sure what time is best (asked for a date)', 'Next year. Not sure what time is best ..', AWAIT_DATE, 'advise'],
  ['tester: same message, no state', 'Next year. Not sure what time is best ..', null, 'advise'],
  ['what time is best', 'what time is best', null, 'advise', 'timing_question'],
  ['best time to visit', "What's the best time to visit Zanzibar?", null, 'advise', 'timing_question'],
  ['best time, bot just asked for a date', 'best time?', AWAIT_DATE, 'advise', 'timing_question'],
  // Clock-time questions must NOT become seasonal advice
  ['best time to fly on friday', "what's the best time to fly on friday", null, null],
  ['best time to fly, dated trip', 'best time to fly', DATED, null],
  ['what time is check-in', 'what time is check-in?', DATED, null],
  ['what time is the flight', 'what time is the flight', DATED, null],
  // Dreaming / undecided
  ['dreaming', "I'm thinking about going to Zanzibar", null, 'advise', 'dreaming'],
  ['sometime next year', 'I want to go to Zanzibar sometime next year', null, 'advise'],
  ['no dates yet', 'Nairobi to Zanzibar for 5 nights, no dates yet', null, 'advise', 'undecided'],
  ['year only', 'Nairobi to Zanzibar next year for 5 nights', null, 'advise', 'year_only'],
  // Answers to "when are you travelling?"
  ['awaiting date: not sure', 'not sure', AWAIT_DATE, 'advise', 'flexible_answer'],
  ['awaiting date: ain\'t sure', "ain't sure yet", AWAIT_DATE, 'advise', 'flexible_answer'],
  ['awaiting date: flexible', 'flexible', AWAIT_DATE, 'advise', 'flexible_answer'],
  ['awaiting date: next year', 'next year', AWAIT_DATE, 'advise', 'year_only'],
  ['awaiting date: a month', 'March', AWAIT_DATE, null],
  ['awaiting date: flexible but a month', 'flexible, maybe march', AWAIT_DATE, null],
  // Must NOT be intercepted
  ['awaiting origin: not sure', 'not sure', AWAIT_ORIGIN, null],
  ['exact trip', 'Nairobi to Zanzibar on 5 December for 4 nights', null, null],
  ['plain trip, no dates (existing flow asks)', 'plan me a trip to Zanzibar', null, null],
  ['hotel only', 'Hotels in Nairobi', null, null],
  ['thinking + month', 'thinking about going to Zanzibar in March', null, null],
  ['tomorrow', 'Nairobi to Mombasa tomorrow', null, null],
  ['not sure about hotel mid-trip', "I'm not sure which hotel to pick", DATED, null],
  ['not sure about hotel, no state', "not sure which hotel to pick in Zanzibar", null, null],
  ['one day trip', 'Nairobi to Mombasa one day trip on friday', null, null],
  ['spend some time', 'I want to spend some time in Zanzibar from 3rd Dec', null, null],
  ['may as a verb', 'I may add a hotel', DATED, null],
  ['cheapest flight', 'show me the cheapest flight to Dubai on 12 Dec', null, null],
  ['explicit suggest dates (existing flow)', 'suggest dates for Zanzibar', null, null],
];

let failed = 0;
for (const [label, prompt, prev, mode, reason] of CASES) {
  const got = tripStage.classify(prompt, prev);
  const ok = got.mode === mode && (!reason || got.reason === reason);
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} ${label}${ok ? '' : `\n    prompt:   ${prompt}\n    expected: ${mode}${reason ? '/' + reason : ''}\n    got:      ${got.mode}/${got.reason}`}`);
}

// Parser date guard
const VAGUE = [
  ["considering a trip next year to Zanzibar, ain't sure when", true],
  ['Nairobi to Zanzibar on 5 December', false],
  ['thinking about Zanzibar in March', false],
  ['Nairobi to Zanzibar for 5 nights', false],
];
for (const [p, expected] of VAGUE) {
  const got = tripStage.isVagueTiming(p);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✖'} isVagueTiming(${JSON.stringify(p)}) = ${got}`);
}

console.log(failed ? `\n${failed} FAILED` : '\nAll good.');
if (process.argv.includes('--show')) {
  console.log('\n--- sample: dreamer ---\n' + tripStage.buildAdvice('Zanzibar', { reason: 'undecided' }));
  console.log('\n--- sample: month verdict ---\n' + tripStage.buildAdvice('Zanzibar', { reason: 'timing_question', month: 3 }));
  console.log('\n--- sample: unknown destination ---\n' + tripStage.buildAdvice('Kigali', { reason: 'dreaming' }));
}
process.exit(failed ? 1 : 0);
