// Payload builders. Shapes follow the v11.37.3 reference pages (field names, @type discriminators).
// The search body mirrors the documented curl sample. Price/Add Offer/Traveller/Commit identifier
// nesting is built from the field lists and MUST be validated against pre-production on first run:
// any 400 will name the offending field, then fix it here in one place.

const PTC = { adult: 'ADT', child: 'CHD', infant: 'INF' };

/**
 * @param {{trips:{from:string,to:string,date:string}[], adults?:number, children?:number, infants?:number,
 *   cabin?:string, carriers?:string[], sources?:('GDS'|'NDC')[], maxOffers?:number}} q
 */
function buildSearch(q) {
  if (!q.trips?.length) throw new Error('At least one trip leg is required');
  const pax = [];
  for (const [n, ptc] of [[q.adults ?? 1, PTC.adult], [q.children ?? 0, PTC.child], [q.infants ?? 0, PTC.infant]]) {
    for (let i = 0; i < n; i++) pax.push({ '@type': 'PassengerCriteria', number: 1, passengerTypeCode: ptc });
  }
  const mods = { '@type': 'SearchModifiersAir' };
  if (q.carriers?.length) mods.CarrierPreference = [{ '@type': 'CarrierPreference', preferenceType: 'Preferred', carriers: q.carriers }];
  if (q.cabin) mods.CabinPreference = [{ '@type': 'CabinPreference', preferenceType: 'Preferred', cabins: [q.cabin] }];
  return {
    '@type': 'CatalogProductOfferingsQueryRequest',
    CatalogProductOfferingsRequest: {
      '@type': 'CatalogProductOfferingsRequestAir',
      contentSourceList: q.sources ?? ['GDS'],
      PassengerCriteria: pax,
      SearchCriteriaFlight: q.trips.map((t, i) => ({
        '@type': 'SearchCriteriaFlight',
        departureDate: t.date,
        From: { value: t.from },
        To: { value: t.to },
        ...(q.trips.length > 1 ? { legSequence: i } : {}),
      })),
      SearchModifiersAir: mods,
      // offersPerPage turns on Travelport's result caching; without it the response has no catalog Identifier and Price cannot reference it.
      offersPerPage: q.maxOffers ?? 25,
    },
  };
}

/** Price the chosen offer. Ids come from the search response (see normalize.js: catalogOfferingsId, catalogOfferingId, productIds). */
function buildPrice({ catalogOfferingsId, offerId, productIds, currency, ticketingPcc }) {
  return {
    '@type': 'OfferQueryBuildFromCatalogProductOfferings',
    BuildFromCatalogProductOfferingsRequest: {
      '@type': 'BuildFromCatalogProductOfferingsRequestAir',
      CatalogProductOfferingsIdentifier: { Identifier: { value: catalogOfferingsId } },
      CatalogProductOfferingSelection: [{
        // Real shape (docs example + live check): identifiers are nested Identifier.value. `CatalogProductOfferingRef`/`productRef` are "not used".
        CatalogProductOfferingIdentifier: { Identifier: { value: offerId } },
        ProductIdentifier: productIds.map((p) => ({ Identifier: { value: p } })),
      }],
      ...(currency || ticketingPcc ? {
        PricingModifiersAir: {
          '@type': 'PricingModifiersAir',
          ...(currency ? { currencyCode: currency } : {}),
          ...(ticketingPcc ? { TicketingPCC: ticketingPcc } : {}), // GDS only
        },
      } : {}),
    },
  };
}

/** Add the priced offer to the workbench. Strip the `_PC` suffix off ids first (see stripPcSuffix). */
function buildAddOffer({ offersId, offerId, productIds = [] }) {
  return {
    '@type': 'OfferQueryBuildFromCatalogOfferings',
    BuildFromCatalogOfferingsRequest: {
      '@type': 'BuildFromCatalogOfferingsRequestAir',
      CatalogOfferingsIdentifier: { Identifier: { value: offersId } },
      CatalogOfferingIdentifier: { Identifier: { value: offerId } },
      ...(productIds.length ? { ProductIdentifier: productIds.map((p) => ({ Identifier: { value: p } })) } : {}),
      PricingModifiersAirChange: { '@type': 'PricingModifiersAirChange' },
    },
  };
}

/** One traveller. Send id travelerRefId_1, _2, ... in order. Shape follows the docs' booking examples (typed PersonName / TelephoneDetail). */
function buildTraveller(t, index = 1) {
  if (!t.surname) throw new Error('Traveller surname is required');
  const phone = t.phone ? String(t.phone).replace(/[^\d]/g, '') : null;
  return {
    '@type': 'Traveler',
    id: `travelerRefId_${index}`,
    passengerTypeCode: t.passengerTypeCode || 'ADT',
    ...(t.birthDate ? { birthDate: t.birthDate } : {}),
    ...(t.gender ? { gender: t.gender } : {}),
    PersonName: { '@type': 'PersonNameDetail', ...(t.given ? { Given: t.given } : {}), Surname: t.surname, ...(t.title ? { Prefix: t.title } : {}) },
    ...(phone ? {
      Telephone: [{
        '@type': 'TelephoneDetail',
        ...(t.countryCode ? { countryAccessCode: String(t.countryCode) } : {}),
        phoneNumber: phone,
        id: `telephone_${index}`,
        cityCode: t.cityCode || 'NBO', // city where the phone is located (3-letter code)
        role: t.phoneRole || 'Home',
      }],
    } : {}),
    ...(t.email ? { Email: [{ value: t.email }] } : {}),
  };
}

/** Commit. Body wrapper and flags follow the docs' "first workbench commit request" example.
 *  With enableTwoStepCommitInd, a price or schedule change since Add Offer makes Travelport return a warning WITHOUT booking,
 *  so we never create a booking the user did not see. (GDS only; not supported for NDC.) ReceivedFrom is GDS-only too. */
function buildCommit({ receivedFrom, payLater = false, twoStep = true } = {}) {
  return {
    ReservationQueryCommitReservation: {
      ...(twoStep ? { enableTwoStepCommitInd: true, errorWhenScheduleChangesInd: true, errorWhenOfferPriceChangesInd: true } : {}),
      ...(receivedFrom ? { ReceivedFrom: receivedFrom } : {}),
      ...(payLater ? { payLaterInd: true } : {}),
    },
  };
}

/** Add Offer (reference payload) uses the same body as Price. */
function buildAddOfferReference(args) { return buildPrice(args); }

module.exports = { buildAddOfferReference, buildSearch, buildPrice, buildAddOffer, buildTraveller, buildCommit };
