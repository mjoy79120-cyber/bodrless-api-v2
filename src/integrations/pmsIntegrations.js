// ─────────────────────────────────────────────────────────────────────────────
// BODRLESS — PMS INTEGRATION LAYER
// Drop this file alongside your hotel-direct-engine.js
// Handles: OPERA Cloud (REST), OPERA 5 On-Premise (SOAP/OWS),
//          Channel Manager fallback (SiteMinder / RateGain style),
//          and a generic REST fallback for custom PMS setups.
//
// Usage in your engine — replace your two stubbed methods with:
//   const pms = require('./pms-integrations');
//   async _searchRoomsOperaCloud(property, params) {
//     return pms.searchOperaCloud(property, params, this._mapToRoomResult.bind(this));
//   }
//   async _searchRoomsOpera5(property, params) {
//     return pms.searchOpera5(property, params, this._mapToRoomResult.bind(this));
//   }
//
// PMS type values for hotel_properties.pms_type:
//   'opera_cloud'      — OPERA Cloud REST API (Oracle Hospitality)
//   'opera_5'          — OPERA On-Premise v5.x (OWS SOAP)
//   'channel_manager'  — SiteMinder / RateGain / Apaleo REST
//   'custom_rest'      — Any hotel with a custom REST API
//   'supabase'         — Mock / manual data (default fallback)
// ─────────────────────────────────────────────────────────────────────────────

const https  = require('https');
const http   = require('http');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN CACHE
// Avoids fetching a new OAuth token on every request.
// Tokens are cached per property ID and refreshed before expiry.
// ─────────────────────────────────────────────────────────────────────────────
const _tokenCache = new Map();

async function _getOperaCloudToken(property) {
  const cached = _tokenCache.get(property.id);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }

  // Credentials stored in property.pms_credentials (JSONB column in Supabase)
  // Shape: { clientId, clientSecret, tenantId, baseUrl, enterpriseId }
  const creds = property.pms_credentials;
  if (!creds?.clientId || !creds?.clientSecret) {
    throw new Error(`[OPERA CLOUD] Missing credentials for property ${property.id}`);
  }

  const tokenUrl = `${creds.baseUrl}/oauth/v1/tokens`;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
  }).toString();

  const response = await _httpRequest(tokenUrl, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/x-www-form-urlencoded',
      'x-app-key':         creds.clientId,
      'x-hotelid':         creds.hotelId || creds.enterpriseId,
    },
    body,
  });

  if (!response.access_token) {
    throw new Error(`[OPERA CLOUD] Token exchange failed: ${JSON.stringify(response)}`);
  }

  const expiresAt = Date.now() + ((response.expires_in || 3600) * 1000);
  _tokenCache.set(property.id, { token: response.access_token, expiresAt });

  logger.info('[OPERA CLOUD] Token refreshed', { propertyId: property.id });
  return response.access_token;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERA CLOUD — REST API INTEGRATION
// Oracle Hospitality OPERA Cloud Services REST API
// Docs: https://docs.oracle.com/en/industries/hospitality/opera-cloud/
//
// Required pms_credentials shape (store in hotel_properties.pms_credentials):
// {
//   baseUrl:      "https://[tenant].hospitality.us-ashburn-1.ocs.oraclecloud.com",
//   clientId:     "your-client-id",
//   clientSecret: "your-client-secret",
//   hotelId:      "SAROVA_NRB",        ← OPERA Cloud hotel code
//   enterpriseId: "SAROVA",            ← Enterprise / chain code
// }
// ─────────────────────────────────────────────────────────────────────────────
async function searchOperaCloud(property, params, mapFn) {
  const { checkIn, checkOut, nights = 1, adults = 1, children = 0, mealPlan = null } = params;

  try {
    const token = await _getOperaCloudToken(property);
    const creds = property.pms_credentials;

    const queryParams = new URLSearchParams({
      hotelId:       creds.hotelId,
      arrivalDate:   checkIn,
      departureDate: checkOut,
      adults:        String(adults),
      children:      String(children),
      ...(mealPlan ? { ratePlanCategory: _mapMealPlanToOpera(mealPlan) } : {}),
    });

    const availUrl = `${creds.baseUrl}/par/v1/hotels/${creds.hotelId}/availability?${queryParams}`;

    const availResponse = await _httpRequest(availUrl, {
      method: 'GET',
      headers: {
        'Authorization':       `Bearer ${token}`,
        'x-app-key':           creds.clientId,
        'x-hotelid':           creds.hotelId,
        'Content-Type':        'application/json',
        'Accept':              'application/json',
      },
    });

    const roomTypes = availResponse?.availResponseSegments?.[0]?.roomStayList || [];
    if (!roomTypes.length) {
      logger.info('[OPERA CLOUD] No availability returned', { propertyId: property.id, checkIn });
      return [];
    }

    // Map Oracle response → Bodrless room result shape
    const results = [];
    for (const stay of roomTypes) {
      const roomInfo  = stay.roomTypes?.[0];
      const rateInfo  = stay.roomRates?.[0];
      if (!roomInfo || !rateInfo) continue;

      const pricePerNight = _parseOperaCloudRate(rateInfo);
      const currency      = rateInfo.rates?.[0]?.base?.currencyCode || property.currency || 'KES';
      const totalPrice    = pricePerNight * nights;

      results.push({
        source: 'opera_cloud',
        roomType: {
          id:          roomInfo.roomTypeCode,
          name:        roomInfo.roomTypeDescription?.value || roomInfo.roomTypeCode,
          bed_type:    roomInfo.bedTypeCodes?.[0] || null,
          view:        roomInfo.roomFeatures?.find(f => f.feature === 'VIEW')?.description || null,
          amenities:   (roomInfo.roomFeatures || []).map(f => f.description).filter(Boolean),
          images:      (roomInfo.roomTypeImages || []).map(i => i.url).filter(Boolean),
          max_adults:  roomInfo.maxOccupancy || adults,
        },
        ratePlan: {
          id:              rateInfo.ratePlanCode,
          meal_plan:       _mapOperaMealPlan(rateInfo.mealPlan),
          price_per_night: pricePerNight,
          currency,
          is_refundable:   rateInfo.cancelPenalties?.[0]?.nonRefundable !== true,
          season_name:     rateInfo.ratePlanDescription?.value || null,
          base_occupancy:  adults,
        },
        property,
        checkIn, checkOut, nights, adults, children,
        childAges:    [],
        totalPrice,
        pricePerNight,
        currency,
        mealPlan:     _mapOperaMealPlan(rateInfo.mealPlan),
        cancellationPolicy: _parseOperaCancellationPolicy(rateInfo),
        allRates:     _extractAllOperaCloudRates(stay, adults, nights, currency),
        mealPlanMatched: !mealPlan || _mapOperaMealPlan(rateInfo.mealPlan) === mealPlan,
      });
    }

    logger.info('[OPERA CLOUD] Availability fetched', {
      propertyId: property.id, checkIn, rooms: results.length,
    });
    return results;

  } catch (err) {
    logger.error('[OPERA CLOUD] Search failed — falling back to Supabase', {
      propertyId: property.id, error: err.message,
    });
    // Return empty — engine falls back to Supabase mock
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERA 5 ON-PREMISE — OWS SOAP INTEGRATION
// Oracle OPERA Web Services — SOAP/XML over HTTP
// Typically exposed on port 8090 or 443 behind hotel firewall.
//
// Required pms_credentials shape:
// {
//   owsUrl:       "http://192.168.1.10:8090/OWS_WS_51/Services/Availability.asmx",
//   hotelCode:    "SAROVA_NRB",
//   username:     "bodrless_api",
//   password:     "your-password",
//   chainCode:    "SAR",              ← Optional, some properties require it
//   soapVersion:  "1.1",             ← "1.1" or "1.2"
// }
// ─────────────────────────────────────────────────────────────────────────────
async function searchOpera5(property, params, mapFn) {
  const { checkIn, checkOut, nights = 1, adults = 1, children = 0, mealPlan = null } = params;

  try {
    const creds = property.pms_credentials;
    if (!creds?.owsUrl || !creds?.hotelCode) {
      throw new Error(`[OPERA 5] Missing OWS credentials for property ${property.id}`);
    }

    const soapEnvelope = _buildOWSAvailabilityRequest({
      hotelCode:  creds.hotelCode,
      chainCode:  creds.chainCode || '',
      username:   creds.username,
      password:   creds.password,
      checkIn,
      checkOut,
      adults,
      children,
      mealPlan,
    });

    const soapAction = creds.soapVersion === '1.2'
      ? ''
      : 'http://webservices.micros.com/ows/5.1/Availability.wsdl/FetchAvailability';

    const rawXml = await _soapRequest(creds.owsUrl, soapEnvelope, soapAction);
    const rooms  = _parseOWSAvailabilityResponse(rawXml, property, params);

    logger.info('[OPERA 5] OWS availability fetched', {
      propertyId: property.id, checkIn, rooms: rooms.length,
    });
    return rooms;

  } catch (err) {
    logger.error('[OPERA 5] OWS search failed — falling back to Supabase', {
      propertyId: property.id, error: err.message,
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL MANAGER — REST FALLBACK
// For hotels using SiteMinder, RateGain, Apaleo, or similar.
// Each channel manager has a slightly different API — this handles
// the common pattern (bearer token + availability endpoint).
//
// Required pms_credentials shape:
// {
//   provider:    "siteminder" | "rategain" | "apaleo" | "custom",
//   baseUrl:     "https://api.siteminder.com/v1",
//   apiKey:      "your-api-key",
//   propertyCode:"SAROVA_NRB",
// }
// ─────────────────────────────────────────────────────────────────────────────
async function searchChannelManager(property, params) {
  const { checkIn, checkOut, nights = 1, adults = 1, children = 0, mealPlan = null } = params;

  try {
    const creds    = property.pms_credentials;
    const provider = creds?.provider || 'custom';

    // Build provider-specific request
    const { url, headers, queryString } = _buildChannelManagerRequest(
      provider, creds, { checkIn, checkOut, adults, children }
    );

    const response = await _httpRequest(`${url}?${queryString}`, { method: 'GET', headers });
    const rooms    = _parseChannelManagerResponse(provider, response, property, params);

    logger.info('[CHANNEL MANAGER] Availability fetched', {
      propertyId: property.id, provider, checkIn, rooms: rooms.length,
    });
    return rooms;

  } catch (err) {
    logger.error('[CHANNEL MANAGER] Search failed — falling back to Supabase', {
      propertyId: property.id, error: err.message,
    });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATED _searchRooms SWITCH
// Replace the method in your HotelDirectEngine class with this.
// Covers all PMS types — just set hotel_properties.pms_type accordingly.
// ─────────────────────────────────────────────────────────────────────────────
async function searchRooms(property, params, supabaseFallback) {
  switch (property.pms_type) {
    case 'opera_cloud':
      return searchOperaCloud(property, params);
    case 'opera_5':
      return searchOpera5(property, params);
    case 'channel_manager':
      return searchChannelManager(property, params);
    case 'custom_rest':
      return searchCustomRest(property, params);
    case 'supabase':
    default:
      return supabaseFallback(property, params);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM REST FALLBACK
// For any hotel with a bespoke API. They provide:
// - baseUrl, apiKey, and an availability endpoint path
// The response is expected to loosely follow a rooms array shape.
// ─────────────────────────────────────────────────────────────────────────────
async function searchCustomRest(property, params) {
  const { checkIn, checkOut, adults = 1, children = 0 } = params;

  try {
    const creds = property.pms_credentials;
    const url   = `${creds.baseUrl}${creds.availabilityPath || '/availability'}`;

    const response = await _httpRequest(url, {
      method:  'GET',
      headers: {
        'Authorization': `Bearer ${creds.apiKey}`,
        'Content-Type':  'application/json',
      },
      queryParams: { checkIn, checkOut, adults, children },
    });

    // Attempt to map a generic rooms array response
    const rooms = Array.isArray(response?.rooms || response?.data)
      ? (response.rooms || response.data)
      : [];

    return rooms.map(room => _mapGenericRestRoom(room, property, params));
  } catch (err) {
    logger.error('[CUSTOM REST] Search failed', { propertyId: property.id, error: err.message });
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESERVATION CREATION
// Handles creating a booking across PMS types.
// Called after guest confirms — replaces manual handoff for integrated hotels.
// ─────────────────────────────────────────────────────────────────────────────
async function createReservation(property, bookingData) {
  switch (property.pms_type) {
    case 'opera_cloud':
      return _createOperaCloudReservation(property, bookingData);
    case 'opera_5':
      return _createOpera5Reservation(property, bookingData);
    default:
      // For non-integrated hotels: return a pending status
      // that triggers manual notification to the hotel
      logger.info('[RESERVATION] Non-integrated property — manual handoff', {
        propertyId: property.id, pmsType: property.pms_type,
      });
      return {
        status:        'pending_manual',
        reservationId: null,
        message:       'Booking received — confirmation pending from hotel.',
      };
  }
}

async function _createOperaCloudReservation(property, bookingData) {
  try {
    const token = await _getOperaCloudToken(property);
    const creds = property.pms_credentials;

    const payload = {
      hotelId:      creds.hotelId,
      arrivalDate:  bookingData.checkIn,
      departureDate: bookingData.checkOut,
      roomTypeCode: bookingData.roomTypeId,
      ratePlanCode: bookingData.ratePlanId,
      adults:       bookingData.adults,
      children:     bookingData.children || 0,
      guestProfile: {
        firstName: bookingData.guestFirstName,
        lastName:  bookingData.guestLastName,
        email:     bookingData.guestEmail,
        phone:     bookingData.guestPhone,
      },
      paymentMethod: {
        type:            bookingData.paymentType || 'CC',
        confirmationNo:  bookingData.paymentConfirmationToken,
      },
      comments: bookingData.specialRequests || '',
    };

    const response = await _httpRequest(
      `${creds.baseUrl}/rsv/v1/hotels/${creds.hotelId}/reservations`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-app-key':     creds.clientId,
          'x-hotelid':     creds.hotelId,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify(payload),
      }
    );

    logger.info('[OPERA CLOUD] Reservation created', {
      propertyId:    property.id,
      reservationId: response?.reservationId,
    });

    return {
      status:        'confirmed',
      reservationId: response?.reservationId || response?.confirmationNumber,
      message:       'Booking confirmed in OPERA Cloud.',
      raw:           response,
    };
  } catch (err) {
    logger.error('[OPERA CLOUD] Reservation creation failed', {
      propertyId: property.id, error: err.message,
    });
    return { status: 'failed', message: err.message };
  }
}

async function _createOpera5Reservation(property, bookingData) {
  try {
    const creds = property.pms_credentials;
    const soap  = _buildOWSReservationRequest(creds, bookingData);
    const soapAction = 'http://webservices.micros.com/ows/5.1/Reservation.wsdl/CreateBooking';

    // Use reservation endpoint — different from availability
    const reservationUrl = creds.reservationUrl || creds.owsUrl.replace('Availability', 'Reservation');
    const rawXml = await _soapRequest(reservationUrl, soap, soapAction);
    const result = _parseOWSReservationResponse(rawXml);

    logger.info('[OPERA 5] Reservation created', {
      propertyId: property.id, reservationId: result.reservationId,
    });

    return {
      status:        result.success ? 'confirmed' : 'failed',
      reservationId: result.reservationId,
      message:       result.success ? 'Booking confirmed in OPERA 5.' : result.errorMessage,
    };
  } catch (err) {
    logger.error('[OPERA 5] Reservation creation failed', {
      propertyId: property.id, error: err.message,
    });
    return { status: 'failed', message: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OWS SOAP HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _buildOWSAvailabilityRequest({ hotelCode, chainCode, username, password, checkIn, checkOut, adults, children, mealPlan }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:ows="http://webservices.micros.com/ows/5.1/Core.wsdl"
               xmlns:avail="http://webservices.micros.com/ows/5.1/Availability.wsdl">
  <soap:Header>
    <ows:OGHeader transactionID="${Date.now()}" timeStamp="${new Date().toISOString()}">
      <ows:Authentication>
        <ows:UserCredentials>
          <ows:UserName>${username}</ows:UserName>
          <ows:UserPassword>${password}</ows:UserPassword>
          <ows:Domain>OPERA</ows:Domain>
        </ows:UserCredentials>
      </ows:Authentication>
    </ows:OGHeader>
  </soap:Header>
  <soap:Body>
    <avail:FetchAvailabilityRequest>
      <avail:AvailRequestSegments>
        <avail:AvailRequestSegment>
          <avail:HotelSearchCriteria>
            <avail:Criterion>
              <avail:HotelRef hotelCode="${hotelCode}" chainCode="${chainCode}"/>
              <avail:StayDateRange start="${checkIn}" end="${checkOut}"/>
              <avail:GuestCounts>
                <avail:GuestCount ageQualifyingCode="10" count="${adults}"/>
                ${children > 0 ? `<avail:GuestCount ageQualifyingCode="8" count="${children}"/>` : ''}
              </avail:GuestCounts>
              ${mealPlan ? `<avail:RatePlanCandidates><avail:RatePlanCandidate mealPlanIndicator="${_mapMealPlanToOWS(mealPlan)}"/></avail:RatePlanCandidates>` : ''}
            </avail:Criterion>
          </avail:HotelSearchCriteria>
        </avail:AvailRequestSegment>
      </avail:AvailRequestSegments>
    </avail:FetchAvailabilityRequest>
  </soap:Body>
</soap:Envelope>`;
}

function _buildOWSReservationRequest(creds, bookingData) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
               xmlns:ows="http://webservices.micros.com/ows/5.1/Core.wsdl"
               xmlns:rsv="http://webservices.micros.com/ows/5.1/Reservation.wsdl">
  <soap:Header>
    <ows:OGHeader transactionID="${Date.now()}" timeStamp="${new Date().toISOString()}">
      <ows:Authentication>
        <ows:UserCredentials>
          <ows:UserName>${creds.username}</ows:UserName>
          <ows:UserPassword>${creds.password}</ows:UserPassword>
          <ows:Domain>OPERA</ows:Domain>
        </ows:UserCredentials>
      </ows:Authentication>
    </ows:OGHeader>
  </soap:Header>
  <soap:Body>
    <rsv:CreateBookingRequest>
      <rsv:HotelReservation>
        <rsv:RoomStays>
          <rsv:RoomStay>
            <rsv:RoomTypes>
              <rsv:RoomType roomTypeCode="${bookingData.roomTypeId}"/>
            </rsv:RoomTypes>
            <rsv:RatePlans>
              <rsv:RatePlan ratePlanCode="${bookingData.ratePlanId}"/>
            </rsv:RatePlans>
            <rsv:GuestCounts>
              <rsv:GuestCount ageQualifyingCode="10" count="${bookingData.adults}"/>
            </rsv:GuestCounts>
            <rsv:TimeSpan start="${bookingData.checkIn}" end="${bookingData.checkOut}"/>
            <rsv:BasicPropertyInfo hotelCode="${creds.hotelCode}"/>
          </rsv:RoomStay>
        </rsv:RoomStays>
        <rsv:ResGuests>
          <rsv:ResGuest>
            <rsv:Profiles>
              <rsv:Profile>
                <rsv:Customer>
                  <rsv:PersonName>
                    <rsv:GivenName>${bookingData.guestFirstName}</rsv:GivenName>
                    <rsv:Surname>${bookingData.guestLastName}</rsv:Surname>
                  </rsv:PersonName>
                  <rsv:Email>${bookingData.guestEmail}</rsv:Email>
                  <rsv:Telephone phoneNumber="${bookingData.guestPhone}"/>
                </rsv:Customer>
              </rsv:Profile>
            </rsv:Profiles>
          </rsv:ResGuest>
        </rsv:ResGuests>
      </rsv:HotelReservation>
    </rsv:CreateBookingRequest>
  </soap:Body>
</soap:Envelope>`;
}

function _parseOWSAvailabilityResponse(xmlString, property, params) {
  const { checkIn, checkOut, nights = 1, adults = 1, children = 0 } = params;
  const results = [];

  // Extract RoomStay blocks — basic regex XML parsing
  // For production, replace with a proper XML parser like 'xml2js' or 'fast-xml-parser'
  const roomStayRegex = /<RoomStay[^>]*>([\s\S]*?)<\/RoomStay>/g;
  let match;

  while ((match = roomStayRegex.exec(xmlString)) !== null) {
    const block = match[1];

    const roomTypeCode = _extractXmlAttr(block, 'RoomType', 'roomTypeCode');
    const roomTypeName = _extractXmlAttr(block, 'RoomType', 'roomTypeDescription') || roomTypeCode;
    const ratePlanCode = _extractXmlAttr(block, 'RatePlan', 'ratePlanCode');
    const amountRaw    = _extractXmlAttr(block, 'AmountAfterTax', 'amount')
                      || _extractXmlAttr(block, 'Base', 'amountAfterTax');
    const currencyCode = _extractXmlAttr(block, 'Base', 'currencyCode')
                      || property.currency || 'KES';
    const mealPlanCode = _extractXmlAttr(block, 'RatePlan', 'mealPlanIndicator');
    const isRefundable = !block.includes('NonRefundable="true"');

    if (!roomTypeCode || !ratePlanCode || !amountRaw) continue;

    const pricePerNight = parseFloat(amountRaw) || 0;
    const totalPrice    = pricePerNight * nights;

    results.push({
      source: 'opera_5',
      roomType: {
        id:          roomTypeCode,
        name:        roomTypeName,
        bed_type:    null,
        view:        null,
        amenities:   [],
        images:      [],
        max_adults:  adults,
      },
      ratePlan: {
        id:              ratePlanCode,
        meal_plan:       _mapOWSMealPlan(mealPlanCode),
        price_per_night: pricePerNight,
        currency:        currencyCode,
        is_refundable:   isRefundable,
        season_name:     null,
        base_occupancy:  adults,
      },
      property, checkIn, checkOut, nights, adults, children,
      childAges: [], totalPrice, pricePerNight,
      currency:  currencyCode,
      mealPlan:  _mapOWSMealPlan(mealPlanCode),
      cancellationPolicy: { free_cancellation_days: isRefundable ? 1 : 0, penalty_percentage: isRefundable ? 0 : 100 },
      allRates:  [],
      mealPlanMatched: true,
    });
  }

  return results;
}

function _parseOWSReservationResponse(xmlString) {
  const success       = xmlString.includes('<Result resultStatusFlag="SUCCESS"');
  const resIdMatch    = xmlString.match(/reservationID="([^"]+)"/);
  const errorMatch    = xmlString.match(/<Text[^>]*>([^<]+)<\/Text>/);

  return {
    success,
    reservationId: resIdMatch?.[1] || null,
    errorMessage:  success ? null : (errorMatch?.[1] || 'Unknown OWS error'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL MANAGER HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _buildChannelManagerRequest(provider, creds, params) {
  const { checkIn, checkOut, adults, children } = params;

  const providerMap = {
    siteminder: {
      url:     `${creds.baseUrl}/properties/${creds.propertyCode}/availability`,
      headers: { 'Authorization': `Bearer ${creds.apiKey}`, 'Accept': 'application/json' },
      query:   new URLSearchParams({ arrival: checkIn, departure: checkOut, adults, children }).toString(),
    },
    rategain: {
      url:     `${creds.baseUrl}/availability`,
      headers: { 'x-api-key': creds.apiKey, 'Accept': 'application/json' },
      query:   new URLSearchParams({ hotel_code: creds.propertyCode, check_in: checkIn, check_out: checkOut, pax: adults }).toString(),
    },
    apaleo: {
      url:     `${creds.baseUrl}/booking/v1/rate-plans`,
      headers: { 'Authorization': `Bearer ${creds.apiKey}`, 'Accept': 'application/json' },
      query:   new URLSearchParams({ propertyId: creds.propertyCode, arrival: checkIn, departure: checkOut }).toString(),
    },
  };

  return providerMap[provider] || providerMap.siteminder;
}

function _parseChannelManagerResponse(provider, response, property, params) {
  const { checkIn, checkOut, nights = 1, adults = 1 } = params;
  const rooms = response?.rooms || response?.data || response?.roomTypes || [];

  return rooms.map(room => ({
    source: `channel_manager_${provider}`,
    roomType: {
      id:         room.roomTypeCode || room.id,
      name:       room.roomTypeName || room.name || room.description,
      bed_type:   room.bedType || null,
      view:       null,
      amenities:  room.amenities || [],
      images:     room.images || [],
      max_adults: room.maxOccupancy || adults,
    },
    ratePlan: {
      id:              room.ratePlanCode || room.rateCode,
      meal_plan:       room.mealPlan || 'room_only',
      price_per_night: parseFloat(room.rate || room.price || 0),
      currency:        room.currency || property.currency || 'KES',
      is_refundable:   room.cancellable !== false,
      season_name:     null,
      base_occupancy:  adults,
    },
    property, checkIn, checkOut, nights, adults,
    children: params.children || 0, childAges: [],
    totalPrice:    parseFloat(room.rate || room.price || 0) * nights,
    pricePerNight: parseFloat(room.rate || room.price || 0),
    currency:      room.currency || property.currency || 'KES',
    mealPlan:      room.mealPlan || 'room_only',
    cancellationPolicy: null,
    allRates: [], mealPlanMatched: true,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC REST ROOM MAPPER
// ─────────────────────────────────────────────────────────────────────────────
function _mapGenericRestRoom(room, property, params) {
  const { checkIn, checkOut, nights = 1, adults = 1 } = params;
  const pricePerNight = parseFloat(room.rate || room.price || room.pricePerNight || 0);

  return {
    source: 'custom_rest',
    roomType: {
      id:         room.roomTypeCode || room.id || room.code,
      name:       room.name || room.roomType || room.description || 'Room',
      bed_type:   room.bedType || null,
      view:       room.view || null,
      amenities:  room.amenities || [],
      images:     room.images || [],
      max_adults: room.maxOccupancy || adults,
    },
    ratePlan: {
      id:              room.ratePlanCode || room.rateCode || 'DEFAULT',
      meal_plan:       room.mealPlan || 'room_only',
      price_per_night: pricePerNight,
      currency:        room.currency || property.currency || 'KES',
      is_refundable:   room.refundable !== false,
      season_name:     null,
      base_occupancy:  adults,
    },
    property, checkIn, checkOut, nights, adults,
    children: params.children || 0, childAges: [],
    totalPrice: pricePerNight * nights, pricePerNight,
    currency:   room.currency || property.currency || 'KES',
    mealPlan:   room.mealPlan || 'room_only',
    cancellationPolicy: null,
    allRates: [], mealPlanMatched: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP / SOAP UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function _httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl  = new URL(url);
    const isHttps    = parsedUrl.protocol === 'https:';
    const lib        = isHttps ? https : http;
    const bodyData   = options.body || null;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (isHttps ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    if (bodyData) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyData);
    }

    const req = lib.request(reqOptions, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data); // Return raw string for SOAP responses
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function _soapRequest(url, soapEnvelope, soapAction = '') {
  const parsedUrl = new URL(url);
  const isHttps   = parsedUrl.protocol === 'https:';
  const lib       = isHttps ? https : http;
  const body      = Buffer.from(soapEnvelope, 'utf-8');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (isHttps ? 443 : 80),
      path:     parsedUrl.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'text/xml; charset=utf-8',
        'Content-Length': body.length,
        'SOAPAction':     soapAction,
      },
    };

    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('SOAP request timeout')); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MEAL PLAN MAPPING
// Bodrless internal → OPERA Cloud / OWS codes and back
// ─────────────────────────────────────────────────────────────────────────────
function _mapMealPlanToOpera(mealPlan) {
  const map = {
    room_only:         '0',
    bed_and_breakfast: '1',
    half_board:        '3',
    full_board:        '4',
    all_inclusive:     '14',
  };
  return map[mealPlan] || '0';
}

function _mapOperaMealPlan(operaCode) {
  const map = {
    '0':  'room_only',
    '1':  'bed_and_breakfast',
    '3':  'half_board',
    '4':  'full_board',
    '14': 'all_inclusive',
    'RO': 'room_only',
    'BB': 'bed_and_breakfast',
    'HB': 'half_board',
    'FB': 'full_board',
    'AI': 'all_inclusive',
  };
  return map[operaCode] || 'room_only';
}

function _mapMealPlanToOWS(mealPlan) {
  return _mapMealPlanToOpera(mealPlan); // Same codes
}

function _mapOWSMealPlan(owsCode) {
  return _mapOperaMealPlan(owsCode);
}

// ─────────────────────────────────────────────────────────────────────────────
// OPERA CLOUD RESPONSE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _parseOperaCloudRate(rateInfo) {
  const amount = rateInfo.rates?.[0]?.base?.amount
              || rateInfo.totalRate?.amount
              || rateInfo.averageRate?.amount
              || 0;
  return parseFloat(amount) || 0;
}

function _parseOperaCancellationPolicy(rateInfo) {
  const penalties = rateInfo.cancelPenalties || [];
  if (!penalties.length) return null;
  const penalty = penalties[0];

  return {
    free_cancellation_days: penalty.deadline?.numberOfDays || 0,
    penalty_percentage:     penalty.nonRefundable ? 100 : (penalty.percent || 0),
    policy_name:            penalty.policyCode || null,
  };
}

function _extractAllOperaCloudRates(stay, adults, nights, defaultCurrency) {
  const rates = stay.roomRates || [];
  return rates.map(r => ({
    ratePlanId:    r.ratePlanCode,
    mealPlan:      _mapOperaMealPlan(r.mealPlan),
    pricePerNight: _parseOperaCloudRate(r),
    currency:      r.rates?.[0]?.base?.currencyCode || defaultCurrency,
    isRefundable:  r.cancelPenalties?.[0]?.nonRefundable !== true,
    seasonName:    r.ratePlanDescription?.value || null,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// XML ATTRIBUTE EXTRACTOR (lightweight — no full XML parser dependency)
// For production volume consider: npm install fast-xml-parser
// ─────────────────────────────────────────────────────────────────────────────
function _extractXmlAttr(xml, tagName, attrName) {
  const tagRegex  = new RegExp(`<${tagName}[^>]*>|<${tagName}[^/]*/>`);
  const tagMatch  = xml.match(tagRegex);
  if (!tagMatch) return null;
  const attrRegex = new RegExp(`${attrName}="([^"]+)"`);
  const attrMatch = tagMatch[0].match(attrRegex);
  return attrMatch?.[1] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  searchRooms,
  searchOperaCloud,
  searchOpera5,
  searchChannelManager,
  searchCustomRest,
  createReservation,
  };