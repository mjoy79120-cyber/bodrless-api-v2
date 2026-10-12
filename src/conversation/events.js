'use strict';

const fs = require('fs');
const path = require('path');
const { norm } = require('./text');
const { formatHuman } = require('./dates');

function loadEvents(file = path.join(__dirname, 'events.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
  } catch {
    return {};
  }
}

function findEvent(events, text) {
  const t = ` ${norm(text).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
  for (const ev of Object.values(events || {})) {
    if ((ev.aliases || []).some((a) => t.includes(` ${a} `))) return ev;
  }
  return null;
}

const TOPIC = {
  dates: /\b(when|date|dates|start|starts|starting|begin|begins|commenc\w*|kick\s*off|opening|final|end|ends|how long|how soon|how far|which month)\b/i,
  venue: /\b(where|venue|venues|stadium|stadiums|host|hosts|hosted|hosting|city|cities|played)\b/i,
  tickets: /\b(ticket|tickets|seat|seats|gate|entry fee)\b/i,
  teams: /\b(team|teams|playing|qualif\w*|fixtures?|schedule|groups?|draw|squad|match(?:es)?)\b/i,
};

const hostsLine = (ev) => (Array.isArray(ev.hosts) && ev.hosts.length
  ? ` It is being co-hosted by ${ev.hosts.slice(0, -1).join(', ')}${ev.hosts.length > 1 ? ' and ' : ''}${ev.hosts[ev.hosts.length - 1]}.`
  : '');

/** Build a factual answer from the table only. Never invents a date. */
function answerEvent(ev, text) {
  const t = norm(text);
  const hasDates = ev.datesConfirmed === true && ev.startDate;

  // ticket/fixture questions first: "when are tickets on sale" is about tickets, not kickoff
  if (TOPIC.tickets.test(t)) {
    return `I handle the travel side (flights, hotels and airport transfers), so I can't confirm match tickets or sale dates for ${ev.name}. Those come from CAF's official channels. I can sort out your trip around the matches once you know which ones you want.`;
  }
  if (TOPIC.dates.test(t)) {
    if (hasDates) {
      const end = ev.endDate ? ` and runs until ${formatHuman(ev.endDate)}` : '';
      return `${ev.name} starts on ${formatHuman(ev.startDate)}${end}.${hostsLine(ev)}`;
    }
    return `The official dates for ${ev.name} haven't been confirmed on our side yet, so I don't want to give you a wrong one.${hostsLine(ev)} Tell me when you'd like to travel and I'll price flights and hotels around that, and we can adjust once CAF confirms the schedule.`;
  }
  if (TOPIC.venue.test(t)) {
    if (Array.isArray(ev.kenyaVenues) && ev.kenyaVenues.length) {
      return `In Kenya, matches are planned for ${ev.kenyaVenues.join(', ')}.${hostsLine(ev)}`;
    }
    return `I don't have a confirmed list of match venues yet.${hostsLine(ev)} Nairobi is the easiest base for flights and hotels, so if you tell me your dates I can price a stay there.`;
  }
  if (TOPIC.teams.test(t)) {
    return `I don't have confirmed fixtures, groups or teams for ${ev.name}, and I'd rather not guess. CAF's official site is the place for that. I can book your flights and hotel once you know when you want to go.`;
  }
  return `${ev.name}: I can help with the travel side (flights, hotels and transfers).${hostsLine(ev)} ${hasDates ? '' : "Official dates aren't confirmed on our side yet. "}Tell me where you'd fly from and roughly when, and I'll price it.`;
}

module.exports = { loadEvents, findEvent, answerEvent };
