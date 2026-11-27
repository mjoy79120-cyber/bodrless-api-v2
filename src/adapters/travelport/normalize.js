/**
 * Travelport search response -> Bodrless flight format (same field names as duffel.js _normalizeOffers).
 * Built from a real pre-production response (JFK-LAX, GDS + NDC). One result per brand option (fare).
 *
 * NOTES
 *  - Times are airport-LOCAL (Travelport gives date + time, no zone), so departureTime is "YYYY-MM-DDTHH:mm:ss" with no offset.
 *  - Currency is the PCC's currency (GBP on the test PCC), not KES: convert downstream like other suppliers.
 *  - Price is Travelport's "BestCombinablePrice"; it can change at Price/Commit (Travelport warns about combinability).
 *  - Round trips: only the outbound leg is read for now (search is journey/leg based; Next Leg Search not wired).
 */
const dur = (iso) => iso || null;

function normalizeTravelportSearch(response, traceId) {
  const root = response?.CatalogProductOfferingsResponse;
  const offerings = root?.CatalogProductOfferings?.CatalogProductOffering;
  if (!Array.isArray(offerings)) return [];

  // Price needs the cached-search Identifier (only present when the search set offersPerPage); transactionId is the fallback.
  const cachedId = root.CatalogProductOfferings?.Identifier?.value || null;
  const catalogId = cachedId || root.transactionId;
  const refs = {};
  for (const r of root.ReferenceList || []) {
    const [, list] = Object.entries(r).find(([k]) => k !== '@type') || [];
    refs[r['@type']] = Object.fromEntries((list || []).map((x) => [x.id, x]));
  }
  const flights = refs.ReferenceListFlight || {};
  const products = refs.ReferenceListProduct || {};
  const brands = refs.ReferenceListBrand || {};
  const terms = refs.ReferenceListTermsAndConditions || {};

  const out = [];
  for (const off of offerings) {
    for (const opt of off.ProductBrandOptions || []) {
      for (const bo of opt.ProductBrandOffering || []) {
        const productRefs = (bo.Product || []).map((p) => p.productRef);
        const product = products[productRefs[0]];
        if (!product) continue;
        const segs = (product.FlightSegment || []).map((s) => flights[s.Flight?.FlightRef]).filter(Boolean);
        if (!segs.length) continue;
        const first = segs[0];
        const last = segs[segs.length - 1];
        const brand = brands[bo.Brand?.BrandRef] || {};
        const attr = (c) => (brand.BrandAttribute || []).find((a) => a.classification === c)?.inclusion || null;
        const fp = product.PassengerFlight?.[0]?.FlightProduct?.[0] || {};
        const price = bo.BestCombinablePrice || {};
        const tc = terms[bo.TermsAndConditions?.termsAndConditionsRef];

        // Included checked bags: from terms; "includedInOfferPrice: Yes" means free.
        let checkedBags = 0;
        for (const b of tc?.BaggageAllowance || []) {
          if (!/Checked/i.test(b.baggageType || '')) continue; // carry-on is read from brand attributes
          if (b.ProductRef && !b.ProductRef.includes(productRefs[0])) continue;
          for (const item of b.BaggageItem || []) if (item.includedInOfferPrice === 'Yes') checkedBags = Math.max(checkedBags, item.quantity || 0);
        }
        const refundAttr = attr('Refund');
        const source = bo.ContentSource || 'GDS';

        out.push({
          supplier: 'travelport',
          type: 'flight',
          transportType: 'flight',
          // Everything the Price step needs, in one id: catalogId|offeringId|productRefs|brandRef
          offerId: [catalogId, off.id, productRefs.join(','), bo.Brand?.BrandRef || ''].join('|'),
          catalogOfferingsId: catalogId,
          catalogCached: !!cachedId,
          catalogOfferingId: off.id,
          productIds: productRefs,
          offerIdentifier: bo.Identifier?.value || null, // NDC only
          contentSource: source,
          searchTraceId: traceId || null,
          expiresAt: null,
          origin: first.Departure?.location,
          destination: last.Arrival?.location,
          originIata: first.Departure?.location,
          destIata: last.Arrival?.location,
          originAirport: null,
          destAirport: null,
          departureTime: `${first.Departure?.date}T${first.Departure?.time}`,
          arrivalTime: `${last.Arrival?.date}T${last.Arrival?.time}`,
          duration: dur(product.totalDuration || first.duration),
          stops: Math.max(0, segs.length - 1),
          airline: first.carrier, // Travelport returns the code only; map to a name downstream
          airlineCode: first.carrier,
          airlineLogo: null,
          flightNumber: `${first.carrier}${first.number}`,
          // Every leg, so two offers that share a first flight (e.g. QR1336 then different 2nd legs) can be told apart.
          flightNumbers: segs.map((s) => `${s.carrier}${s.number}`),
          via: segs.slice(0, -1).map((s) => s.Arrival?.location), // connection airports
          carriers: [...new Set(segs.map((s) => s.carrier))],
          segments: segs.map((s) => ({
            carrier: s.carrier, flightNumber: `${s.carrier}${s.number}`, equipment: s.equipment || null,
            from: s.Departure?.location, to: s.Arrival?.location,
            departing: `${s.Departure?.date}T${s.Departure?.time}`, arriving: `${s.Arrival?.date}T${s.Arrival?.time}`,
            terminalFrom: s.Departure?.terminal || null, terminalTo: s.Arrival?.terminal || null, duration: s.duration || null,
          })),
          isReturn: false,
          returnLeg: null,
          cabinClass: (fp.cabin || 'Economy').toLowerCase().replace(' ', '_'),
          fareBasis: fp.fareBasisCode || null,
          bookingClass: fp.classOfService || null,
          brandName: brand.name || null,
          checkedBags,
          carryOn: attr('CarryOn') === 'Included' ? 1 : 0,
          price: Number(price.TotalPrice || 0),
          basePrice: Number(price.Base || 0),
          taxes: Number(price.TotalTaxes || 0),
          currency: price.CurrencyCode?.value || null,
          canBook: true,
          canHold: source === 'GDS', // NDC hold support varies by carrier: confirm per carrier before enabling
          isRefundable: refundAttr == null ? null : refundAttr !== 'Not Offered',
          refundPenalty: null,
          refundPenaltyCurrency: null,
          requiresInstantPayment: null,
          paymentRequiredBy: null,
          priceGuaranteeExpiresAt: null,
          passengerIds: [],
          slices: [],
          supplierBookingReference: null,
        });
      }
    }
  }
  return out;
}

module.exports = { normalizeTravelportSearch };
