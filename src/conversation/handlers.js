'use strict';

const { norm } = require('./text');

const stripEmoji = (s) => String(s || '').replace(/[✅❌☀-➿\u{1F300}-\u{1FAFF}]/gu, '').replace(/\s+/g, ' ').trim();
const fmtMoney = (n, cur) => (Number.isFinite(Number(n)) ? `${cur || 'KES'} ${Number(n).toLocaleString('en-US')}` : null);

function orderText(booking) {
  if (!booking || !booking.ref) {
    return `I can't see a booking reference on this chat yet. A reference (it looks like BDR-… ) appears right after you tap Book Now. If you've already booked and don't see one, please contact support and mention the phone number you used.`;
  }
  const total = fmtMoney(booking.total, booking.currency);
  const head = `Your booking reference is *${booking.ref}*${total ? ` (total ${total})` : ''}.`;
  switch (booking.status) {
    case 'payment_failed':
      return `${head} The flight is held, but the M-Pesa payment didn't go through. Holds don't last forever, so it's best to retry soon: tap Book Now on your option again and double-check the phone number, or contact support with this reference.`;
    case 'held_unpaid':
      return `${head} The flight is held and waiting for payment. Complete the M-Pesa prompt on your phone, or tap Book Now again if it didn't arrive.`;
    case 'paid':
      return `${head} Your payment has been received.`;
    case 'confirmed':
      return `${head} Your booking is confirmed.`;
    default:
      return `${head} Keep it handy if you need to contact support.`;
  }
}

function paymentText(booking) {
  const base = `Payments are done with M-Pesa: choose an option and tap Book Now, and a prompt is sent to your phone.`;
  if (!booking || !booking.ref) return `${base} If the prompt doesn't arrive, check the phone number and try again.`;
  if (booking.status === 'paid' || booking.status === 'confirmed') {
    return `Your payment for *${booking.ref}* is already recorded, so there's nothing more to pay.`;
  }
  return `I can see your booking *${booking.ref}*, but I can't confirm a payment on it. To try again, tap Book Now on your option and check the phone number carefully, then approve the M-Pesa prompt. If it keeps failing, contact support and quote *${booking.ref}*.`;
}

const GENERAL = {
  visa: `Entry requirements depend on your passport and change often, so I don't want to give you a wrong answer. Please check Kenya's official immigration / eTA site before you book.`,
  weather: `I don't have reliable forecast data, so a weather service for your travel dates will serve you better than a guess from me.`,
  safety: `I can't give a safety assessment. Your government's official travel advice for Kenya is the best source.`,
  money: `I can't quote live exchange rates. Package totals here are shown in KES.`,
  connectivity: `I can't advise on SIM cards or data, sorry. Your mobile provider is the best source for roaming options.`,
  other: `That's outside what I can answer reliably.`,
};
const generalInfoText = (topic) => `${GENERAL[topic] || GENERAL.other} I can help with flights, hotels and airport transfers whenever you're ready.`;

function helpText(agencyName) {
  return `I'm ${agencyName ? `${agencyName}'s` : 'your'} travel assistant. I can price and book flights, hotels and airport transfers. Tell me where you're flying from, where to, and roughly when, for example "Nairobi to Mombasa, 20 Oct, 2 people". You can also ask me about your booking reference or payment at any time.`;
}

const greetingText = (name, hasTrip) => `Hi${name ? ` ${name}` : ''}! ${hasTrip ? "Pick one of the options above, or tell me what you'd like to change." : 'Where would you like to go, and where will you be flying from?'}`;

function quoteText(question, packages) {
  const list = (Array.isArray(packages) ? packages : []).filter(Boolean);
  if (!list.length) {
    return `Each option card shows its refund and baggage terms, and the exact terms are confirmed when you book. Which option are you asking about?`;
  }
  const t = norm(question);
  const m = t.match(/option\s*(\d)/);
  const idx = m ? Number(m[1]) - 1 : null;
  const picks = idx != null && list[idx] ? [[idx, list[idx]]] : list.slice(0, 4).map((p, i) => [i, p]);
  const line = (label, v) => (v ? `${label}: ${stripEmoji(v)}` : null);

  const rows = [];
  const wantsRefund = /\b(refund\w*|cancel\w*|change fee|terms|policy|hold)\b/.test(t);
  const wantsBags = /\b(baggage|luggage|bags?|carry|checked)\b/.test(t);
  const wantsStops = /\b(stops?|layover|duration|how long|airline)\b/.test(t);
  const wantsIncl = /\b(included|inclusive|breakfast|meals?|transfers?)\b/.test(t);

  for (const [i, p] of picks) {
    const parts = [];
    if (wantsRefund) {
      parts.push(line('Outbound', p.transport?.policySummary), line('Return', p.returnTransport?.policySummary));
    }
    if (wantsBags) {
      parts.push(line('Outbound baggage', p.transport?.baggageSummary), line('Return baggage', p.returnTransport?.baggageSummary));
    }
    if (wantsStops) {
      const tr = p.transport;
      if (tr) parts.push(`Outbound: ${tr.airline || 'flight'}${tr.stops != null ? `, ${tr.stops === 0 ? 'non-stop' : `${tr.stops} stop${tr.stops > 1 ? 's' : ''}`}` : ''}${tr.duration ? `, ${tr.duration}` : ''}`);
    }
    if (wantsIncl) {
      if (p.hotel) parts.push(`Hotel: ${p.hotel.name}${p.hotel.mealPlan || p.summary?.mealPlan ? ` (${String(p.hotel.mealPlan || p.summary.mealPlan).replace(/_/g, ' ')})` : ''}`);
      if (Array.isArray(p.transfers) && p.transfers.length) parts.push(`${p.transfers.length} airport transfer leg${p.transfers.length > 1 ? 's' : ''} included`);
      else parts.push('No airport transfers in this option');
    }
    const body = parts.filter(Boolean);
    if (body.length) rows.push(`*Option ${i + 1}*\n${body.map((b) => `- ${b}`).join('\n')}`);
  }
  if (!rows.length) {
    return `I can tell you about refund terms, baggage, stops, or what's included in each option. Which would you like to know?`;
  }
  return `${rows.join('\n\n')}\n\nThe airline confirms the final terms when you book.`;
}

module.exports = { orderText, paymentText, generalInfoText, helpText, greetingText, quoteText };
