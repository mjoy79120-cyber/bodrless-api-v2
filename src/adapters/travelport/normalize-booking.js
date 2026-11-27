'use strict';
// Travelport retrieve response -> Bodrless booking object.
// Verified against a live GDS held booking (pre-production).

const dur = (iso) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso || '');
  return m ? (Number(m[1] || 0) * 60 + Number(m[2] || 0)) : null;
};

function normalizeTravelportBooking(response) {
  const r = response?.ReservationResponse?.Reservation;
  if (!r) return null;

  const offer = (r.Offer || [])[0] || {};
  const product = (offer.Product || [])[0] || {};
  const pf = (product.PassengerFlight || [])[0] || {};
  const fp = (pf.FlightProduct || [])[0] || {};
  const tc = (offer.TermsAndConditionsFull || []).find((t) => t.PaymentTimeLimit || t.BaggageAllowance) || {};
  const restrictions = (offer.TermsAndConditionsFull || []).flatMap((t) => (t.Restriction || []).map((x) => x.value));

  // Locators: source "1G" = Travelport/Galileo PNR, any other source = airline record locator.
  const receipts = (r.Receipt || []).map((x) => x.Confirmation).filter(Boolean);
  const tpLoc = receipts.find((c) => c.Locator?.source === '1G');
  const airlineLocs = receipts.filter((c) => c.Locator && c.Locator.source !== '1G')
    .map((c) => ({ airline: c.Locator.source, locator: c.Locator.value }));
  const statusAir = tpLoc?.OfferStatus?.StatusAir?.[0];

  const segments = (product.FlightSegment || []).map((s) => {
    const f = s.Flight || {};
    return {
      sequence: s.sequence,
      carrier: f.carrier,
      flightNumber: `${f.carrier || ''}${f.number || ''}`,
      equipment: f.equipment,
      origin: f.Departure?.location,
      destination: f.Arrival?.location,
      departureTime: f.Departure ? `${f.Departure.date}T${f.Departure.time}` : null, // local, no zone
      arrivalTime: f.Arrival ? `${f.Arrival.date}T${f.Arrival.time}` : null,
      durationMinutes: dur(f.duration),
      connectionMinutes: dur(s.connectionDuration),
    };
  });

  // Price: use the charged-currency breakdown (the one with currencySource "Charged"), not the filed amount.
  const price = offer.Price || {};
  const charged = (price.PriceBreakdown || []).find((b) => b.Amount?.currencySource === 'Charged') || {};
  const filed = charged.FiledAmount;

  const bag = (tc.BaggageAllowance || []).map((b) => ({ segments: b.SegmentSequenceList, allowance: (b.Text || []).join(',') }));

  return {
    supplier: 'travelport',
    contentSource: offer.ContentSource,
    locator: tpLoc?.Locator?.value || null,          // use this for retrieve/cancel
    airlineLocators: airlineLocs,                    // show to traveller
    status: statusAir?.code === 'HK' ? 'held' : (statusAir?.code || 'unknown'),
    statusCode: statusAir?.code,
    createdDate: tpLoc?.Locator?.creationDate,
    paymentTimeLimit: tc.PaymentTimeLimit || null,   // ticket by this time (UTC)
    offerExpiry: tc.ExpiryDate || null,
    validatingAirline: tc.ValidatingAirline?.[0]?.ValidatingAirline,
    ticketingPcc: tc.TicketingAgency?.[0]?.Code,
    segments,
    cabinClass: fp.cabin,
    bookingClass: fp.classOfService,
    fareBasis: fp.fareBasisCode,
    brandName: fp.Brand?.name,
    checkedBags: bag,
    restrictions,
    isRefundable: !restrictions.some((x) => /NONREF/i.test(x)),
    price: {
      total: price.TotalPrice,
      base: price.Base,
      taxes: price.TotalTaxes,
      fees: price.TotalFees,
      currency: price.CurrencyCode?.value,
      taxLines: (charged.Amount?.Taxes?.Tax || []).map((t) => ({ code: t.taxCode, amount: t.value })),
      filedAmount: filed ? { amount: filed.value, currency: filed.currencyCode } : null,
      fareCalculation: charged.FareCalculation,
    },
    travellers: (r.Traveler || []).map((t) => ({
      ref: t.id,
      type: t.passengerTypeCode,
      firstName: t.PersonName?.Given,
      lastName: t.PersonName?.Surname,
      dob: t.birthDate,
      gender: t.gender,
      email: t.Email?.[0]?.value,
      phone: t.Telephone?.[0] ? `+${t.Telephone[0].countryAccessCode}${t.Telephone[0].phoneNumber}` : null,
    })),
    travelportReservationId: r.Identifier?.value, // internal UUID, not the locator
  };
}

module.exports = { normalizeTravelportBooking };
