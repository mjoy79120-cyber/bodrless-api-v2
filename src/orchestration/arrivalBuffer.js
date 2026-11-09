'use strict';
// Pure timing rules. No I/O. All thresholds live in CONFIG so you can tune them without touching logic.
const CONFIG = {
  clearanceMins: { international: 75, domestic: 25 }, // landing to leaving the terminal (immigration, bags)
  transferToHotelMins: 30,
  minConnectionMins: { intl_to_domestic: 240, domestic_to_intl: 270, domestic_to_domestic: 75 },
  hotelCheckInHour: 14,
  earlyAdviceIfReadyBeforeHour: 12, // ready to check in 2h+ before standard check-in
  redEyeBeforeHour: 5,              // landing before 05:00 = effectively the previous night
  lateDepartureFromHour: 16,
  earlyDepartureBeforeHour: 6,
  airportLeadMins: { international: 180, domestic: 90 },
  hotelToAirportMins: 45,
};

function parseLocal(s) {
  const m = /(?:(\d{4})-(\d{2})-(\d{2})[T ])?(\d{1,2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const tod = parseInt(m[4], 10) * 60 + parseInt(m[5], 10);
  const abs = m[1] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
  return { tod, abs };
}
const pad = (n) => String(n).padStart(2, '0');
function fmt(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
}
const hours = (mins) => (mins / 60).toFixed(mins % 60 === 0 ? 0 : 1);

// Landing -> can the traveler check in?
function hotelCheckInAdvisory({ arrivalISO, international = true }) {
  const p = parseLocal(arrivalISO);
  if (!p) return { type: 'none' };
  if (p.tod < CONFIG.redEyeBeforeHour * 60) {
    return { type: 'previous_night', message:
      `You land at ${fmt(p.tod)}, before the room for that day is normally ready (${CONFIG.hotelCheckInHour}:00). Consider booking the night before so it is waiting for you.` };
  }
  const ready = p.tod + CONFIG.clearanceMins[international ? 'international' : 'domestic'] + CONFIG.transferToHotelMins;
  if (ready < CONFIG.earlyAdviceIfReadyBeforeHour * 60) {
    const wait = CONFIG.hotelCheckInHour * 60 - ready;
    return { type: 'early_check_in', readyAt: fmt(ready), waitMins: wait, message:
      `You land at ${fmt(p.tod)} and would reach the hotel around ${fmt(ready)}, about ${hours(wait)} hours before standard check-in. Ask for early check-in or a day room.` };
  }
  return { type: 'none' };
}

// Leaving: late flights outlive checkout, early flights need a pre-dawn transfer.
function departureAdvisory({ departureISO, international = true }) {
  const p = parseLocal(departureISO);
  if (!p) return { type: 'none' };
  if (p.tod >= CONFIG.lateDepartureFromHour * 60) {
    return { type: 'late_departure', message:
      `Your flight leaves at ${fmt(p.tod)}, well after the usual 11:00 checkout. Ask for a late checkout or a day room.` };
  }
  if (p.tod < CONFIG.earlyDepartureBeforeHour * 60) {
    const lead = CONFIG.airportLeadMins[international ? 'international' : 'domestic'] + CONFIG.hotelToAirportMins;
    return { type: 'early_departure', leaveHotelAt: fmt(p.tod - lead), message:
      `Your flight leaves at ${fmt(p.tod)}, so plan to leave the hotel around ${fmt(p.tod - lead)}.` };
  }
  return { type: 'none' };
}

// Can the traveler make the next flight? type: intl_to_domestic | domestic_to_intl | domestic_to_domestic
function checkConnection({ arrivesISO, departsISO, type }) {
  const a = parseLocal(arrivesISO), d = parseLocal(departsISO);
  const need = CONFIG.minConnectionMins[type];
  if (!a || !d || a.abs == null || d.abs == null || !need) return { ok: true, unknown: true };
  const gap = d.abs - a.abs;
  return { ok: gap >= need, gapMins: gap, requiredMins: need, message: gap >= need ? null :
    `Only ${hours(gap)} hours between flights; this connection needs about ${hours(need)}.` };
}

module.exports = { CONFIG, hotelCheckInAdvisory, departureAdvisory, checkConnection, parseLocal, fmt };