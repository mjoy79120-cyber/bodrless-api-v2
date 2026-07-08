/**
 * HOTELBEDS ADAPTER
 * ─────────────────────────────────────────────────────────────
 * Search and book hotels via HotelBeds (APItude API).
 *
 * DESTINATION RESOLUTION (three-tier, 2026-07-06):
 * BUG FIX: previously had a small hardcoded map that silently
 * returned zero hotels for any destination not in it — including
 * common African cities like Lusaka, Windhoek, Maputo,
 * Antananarivo. Confirmed via a real test: "trip to Zambia" would
 * correctly resolve to "Lusaka" via the parser's COUNTRY_TO_CITY
 * map, then HotelBeds would find zero hotels because "Lusaka" had
 * no entry in the adapter's own code table. Fixed with:
 *   Tier 1: Comprehensive hardcoded map (127 destinations, instant)
 *   Tier 2: Live HotelBeds /locations/destinations API lookup for
 *            anything not in the hardcoded map
 *   Tier 3: Geolocation search using known city coordinates as a
 *            last resort (same city as tier 2 miss but different
 *            API endpoint — covers destinations HotelBeds knows
 *            by coordinates but not by IATA code)
 *
 * All other logic (rateType, packaging filter, promotions,
 * rateCommentsId, GZIP, checkRate, certification compliance,
 * timeout, HotelBeds Section 4 requirements) is unchanged.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

// Process-level cache for live destination lookups — same pattern
// as duffel.js's _placesCache. Keyed by normalized city name.
// Resets on deploy, which is fine (destination codes don't change).
const _destinationCodeCache = {};

// Known city coordinates for geolocation fallback (Tier 3).
// Only cities where HotelBeds is likely to have inventory but
// might not have a consistent IATA/destination code match.
const CITY_COORDINATES = {
  'lusaka':          { lat: -15.4167, lng: 28.2833 },
  'windhoek':        { lat: -22.5609, lng: 17.0658 },
  'maputo':          { lat: -25.9692, lng: 32.5732 },
  'antananarivo':    { lat: -18.9137, lng: 47.5361 },
  'harare':          { lat: -17.8252, lng: 31.0335 },
  'gaborone':        { lat: -24.6541, lng: 25.9087 },
  'lilongwe':        { lat: -13.9626, lng: 33.7741 },
  'luanda':          { lat: -8.8368,  lng: 13.2343 },
  'bujumbura':       { lat: -3.3822,  lng: 29.3644 },
  'juba':            { lat: 4.8594,   lng: 31.5713 },
  'dakar':           { lat: 14.6937,  lng: -17.4441 },
  'abidjan':         { lat: 5.3600,   lng: -4.0083 },
  'douala':          { lat: 4.0511,   lng: 9.7679 },
  'kigali':          { lat: -1.9441,  lng: 30.0619 },
  'entebbe':         { lat: 0.0512,   lng: 32.4637 },
  'arusha':          { lat: -3.3869,  lng: 36.6830 },
  'mwanza':          { lat: -2.5167,  lng: 32.9000 },
  'masai mara':      { lat: -1.5129,  lng: 35.1437 },
  'maasai mara':     { lat: -1.5129,  lng: 35.1437 },
  'amboseli':        { lat: -2.6527,  lng: 37.2606 },
  'serengeti':       { lat: -2.3333,  lng: 34.8333 },
  'ngorongoro':      { lat: -3.1847,  lng: 35.5799 },
};

class HotelBedsAdapter {

  constructor() {
    this.apiKey    = process.env.HOTELBEDS_API_KEY;
    this.apiSecret = process.env.HOTELBEDS_API_SECRET || process.env.HOTELBEDS_SECRET;
    this.baseUrl   = process.env.HOTELBEDS_BASE_URL || 'https://api.test.hotelbeds.com';
    this.timeout   = Number(process.env.HOTELBEDS_TIMEOUT_MS) || 20000;
    this.searchTimeout = Number(process.env.HOTELBEDS_SEARCH_TIMEOUT_MS) || 18000;
  }

  _signature() {
    const crypto = require('crypto');
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const hash = crypto
      .createHash('sha256')
      .update(this.apiKey + this.apiSecret + timestamp)
      .digest('hex');
    return hash;
  }

  _headers() {
    return {
      'Api-key': this.apiKey,
      'X-Signature': this._signature(),
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'Content-Type': 'application/json',
    };
  }

  // ─────────────────────────────────────────────
  // TIER 1: COMPREHENSIVE HARDCODED DESTINATION CODE MAP
  // 127 destinations covering East/Southern/West/North Africa,
  // Indian Ocean islands, Middle East, Asia, Europe, Americas.
  // BUG FIX (2026-07-06): previously missing Lusaka, Windhoek,
  // Maputo, Antananarivo, Harare and other African cities — causing
  // zero hotel results for those destinations with no error message.
  // Also includes country-name aliases (e.g. 'zambia' → 'LUN') so
  // country-level searches work even when the parser resolves the
  // country to a city but that city still needs a code lookup.
  // ─────────────────────────────────────────────
  _getHardcodedDestinationCode(cityName) {
    const CODES = {
      // Kenya
      'nairobi': 'NBO', 'mombasa': 'MBA', 'kisumu': 'KIS', 'eldoret': 'EDL',
      'malindi': 'MYD', 'lamu': 'LAU', 'diani': 'UKA', 'ukunda': 'UKA',
      'nakuru': 'NUU', 'nanyuki': 'NYK', 'maasai mara': 'MRE',
      'masai mara': 'MRE', 'amboseli': 'ASV', 'samburu': 'UAS',
      'tsavo': 'MBA', 'nanyuki': 'NYK', 'nyahururu': 'NYK',

      // Tanzania
      'zanzibar': 'ZNZ', 'dar es salaam': 'DAR', 'arusha': 'ARK',
      'kilimanjaro': 'JRO', 'mwanza': 'MWZ', 'serengeti': 'SEU',
      'ngorongoro': 'JRO', 'pemba': 'PMA', 'mafia': 'MFA',

      // Uganda, Rwanda, Burundi, South Sudan, Ethiopia, Somalia
      'kampala': 'EBB', 'entebbe': 'EBB', 'kigali': 'KGL',
      'addis ababa': 'ADD', 'bujumbura': 'BJM', 'juba': 'JUB',
      'mogadishu': 'MGQ',

      // Southern Africa — ALL PREVIOUSLY MISSING GAPS FIXED HERE
      'lusaka': 'LUN', 'zambia': 'LUN',
      'windhoek': 'WDH', 'namibia': 'WDH',
      'maputo': 'MPM', 'mozambique': 'MPM', 'beira': 'BEW',
      'antananarivo': 'TNR', 'madagascar': 'TNR',
      'harare': 'HRE', 'zimbabwe': 'HRE', 'bulawayo': 'BUQ',
      'gaborone': 'GBE', 'botswana': 'GBE',
      'lilongwe': 'LLW', 'malawi': 'LLW', 'blantyre': 'BLZ',
      'luanda': 'LAD', 'angola': 'LAD',
      'mbabane': 'MTS', 'eswatini': 'MTS', 'swaziland': 'MTS',
      'maseru': 'MSU', 'lesotho': 'MSU',
      'victoria falls': 'VFA',
      'livingstone': 'LVI',
      'ndola': 'NLA',

      // South Africa
      'johannesburg': 'JNB', 'cape town': 'CPT', 'durban': 'DUR',
      'port elizabeth': 'PLZ', 'east london': 'ELS', 'nelspruit': 'MQP',
      'kruger': 'MQP', 'sun city': 'PTG',

      // West Africa
      'accra': 'ACC', 'ghana': 'ACC', 'kumasi': 'KMS',
      'lagos': 'LOS', 'abuja': 'ABV', 'nigeria': 'LOS',
      'dakar': 'DKR', 'senegal': 'DKR',
      'abidjan': 'ABJ', "ivory coast": 'ABJ', "cote d'ivoire": 'ABJ',
      'douala': 'DLA', 'yaounde': 'YAO', 'cameroon': 'DLA',
      'accra': 'ACC', 'lomé': 'LFW', 'lome': 'LFW', 'togo': 'LFW',
      'cotonou': 'COO', 'benin': 'COO',
      'bamako': 'BKO', 'mali': 'BKO',
      'conakry': 'CKY', 'guinea': 'CKY',
      'freetown': 'FNA', 'sierra leone': 'FNA',
      'monrovia': 'MLW', 'liberia': 'MLW',
      'ouagadougou': 'OUA', 'burkina faso': 'OUA',
      'niamey': 'NIM', 'niger': 'NIM',
      'ndjamena': 'NDJ', 'chad': 'NDJ',

      // North Africa
      'cairo': 'CAI', 'egypt': 'CAI', 'alexandria': 'ALY',
      'sharm el sheikh': 'SSH', 'hurghada': 'HRG', 'luxor': 'LXR',
      'marrakech': 'RAK', 'casablanca': 'CMN', 'morocco': 'RAK',
      'fez': 'FEZ', 'fès': 'FEZ', 'agadir': 'AGA', 'tangier': 'TNG',
      'tunis': 'TUN', 'tunisia': 'TUN', 'djerba': 'DJE',
      'tripoli': 'TIP', 'libya': 'TIP',
      'algiers': 'ALG', 'algeria': 'ALG',
      'khartoum': 'KRT', 'sudan': 'KRT',

      // Indian Ocean Islands
      'mahe': 'SEZ', 'seychelles': 'SEZ', 'praslin': 'SEZ', 'la digue': 'SEZ',
      'port louis': 'MRU', 'mauritius': 'MRU', 'grand baie': 'MRU',
      'flic en flac': 'MRU', 'belle mare': 'MRU',
      'male': 'MLE', 'maldives': 'MLE',
      'reunion': 'RUN', 'saint-denis': 'RUN',
      'moroni': 'HAH', 'comoros': 'HAH',

      // Middle East
      'dubai': 'DXB', 'abu dhabi': 'AUH', 'uae': 'DXB',
      'sharjah': 'SHJ', 'ras al khaimah': 'RKT',
      'doha': 'DOH', 'qatar': 'DOH',
      'muscat': 'MCT', 'oman': 'MCT', 'salalah': 'SLL',
      'riyadh': 'RUH', 'jeddah': 'JED', 'saudi arabia': 'JED',
      'kuwait city': 'KWI', 'kuwait': 'KWI',
      'bahrain': 'BAH', 'manama': 'BAH',
      'amman': 'AMM', 'jordan': 'AMM', 'petra': 'AMM',
      'beirut': 'BEY', 'lebanon': 'BEY',
      'tel aviv': 'TLV', 'israel': 'TLV',
      'istanbul': 'IST', 'turkey': 'IST', 'ankara': 'ESB',
      'antalya': 'AYT', 'bodrum': 'BJV', 'cappadocia': 'KYA',

      // Asia
      'bali': 'DPS', 'denpasar': 'DPS', 'indonesia': 'DPS',
      'jakarta': 'CGK', 'lombok': 'LOP',
      'phuket': 'HKT', 'bangkok': 'BKK', 'chiang mai': 'CNX',
      'koh samui': 'USM', 'krabi': 'KBV', 'thailand': 'BKK',
      'singapore': 'SIN', 'kuala lumpur': 'KUL', 'malaysia': 'KUL',
      'penang': 'PEN', 'langkawi': 'LGK',
      'delhi': 'DEL', 'mumbai': 'BOM', 'goa': 'GOI', 'india': 'DEL',
      'bangalore': 'BLR', 'chennai': 'MAA', 'jaipur': 'JAI',
      'tokyo': 'TYO', 'osaka': 'KIX', 'kyoto': 'KIX', 'japan': 'TYO',
      'colombo': 'CMB', 'sri lanka': 'CMB', 'sigiriya': 'CMB',
      'kathmandu': 'KTM', 'nepal': 'KTM',
      'hong kong': 'HKG', 'macau': 'MFM',
      'seoul': 'SEL', 'south korea': 'SEL',
      'beijing': 'BJS', 'shanghai': 'SHA', 'china': 'BJS',
      'hanoi': 'HAN', 'ho chi minh city': 'SGN', 'vietnam': 'HAN',
      'saigon': 'SGN', 'da nang': 'DAD', 'hoi an': 'DAD',
      'phnom penh': 'PNH', 'cambodia': 'PNH', 'siem reap': 'REP',
      'yangon': 'RGN', 'myanmar': 'RGN', 'mandalay': 'MDL',
      'manila': 'MNL', 'philippines': 'MNL', 'cebu': 'CEB',
      'male': 'MLE', 'maldives': 'MLE',
      'dhaka': 'DAC', 'bangladesh': 'DAC',
      'karachi': 'KHI', 'lahore': 'LHE', 'islamabad': 'ISB',

      // Europe
      'london': 'LON', 'manchester': 'MAN', 'edinburgh': 'EDI',
      'paris': 'PAR', 'nice': 'NCE', 'lyon': 'LYS',
      'amsterdam': 'AMS', 'rome': 'ROM', 'milan': 'MIL',
      'venice': 'VCE', 'florence': 'FLR', 'naples': 'NAP',
      'barcelona': 'BCN', 'madrid': 'MAD', 'seville': 'SVQ',
      'malaga': 'AGP', 'ibiza': 'IBZ', 'palma': 'PMI', 'tenerife': 'TFN',
      'athens': 'ATH', 'santorini': 'JTR', 'mykonos': 'JMK',
      'crete': 'HER', 'rhodes': 'RHO', 'corfu': 'CFU',
      'zurich': 'ZRH', 'geneva': 'GVA', 'bern': 'BRN',
      'vienna': 'VIE', 'salzburg': 'SZG', 'innsbruck': 'INN',
      'prague': 'PRG', 'czech republic': 'PRG',
      'budapest': 'BUD', 'hungary': 'BUD',
      'warsaw': 'WAW', 'krakow': 'KRK', 'poland': 'WAW',
      'lisbon': 'LIS', 'porto': 'OPO', 'portugal': 'LIS',
      'brussels': 'BRU', 'belgium': 'BRU',
      'copenhagen': 'CPH', 'denmark': 'CPH',
      'stockholm': 'STO', 'sweden': 'STO',
      'oslo': 'OSL', 'norway': 'OSL',
      'helsinki': 'HEL', 'finland': 'HEL',
      'dublin': 'DUB', 'ireland': 'DUB',
      'reykjavik': 'REK', 'iceland': 'REK',
      'dubrovnik': 'DBV', 'split': 'SPU', 'croatia': 'DBV',
      'valletta': 'MLA', 'malta': 'MLA',
      'nicosia': 'NIC', 'limassol': 'LCA', 'cyprus': 'LCA',
      'tallinn': 'TLL', 'estonia': 'TLL',
      'riga': 'RIX', 'latvia': 'RIX',
      'vilnius': 'VNO', 'lithuania': 'VNO',

      // Americas
      'new york': 'NYC', 'miami': 'MIA', 'los angeles': 'LAX',
      'chicago': 'CHI', 'las vegas': 'LAS', 'orlando': 'ORL',
      'san francisco': 'SFO', 'boston': 'BOS',
      'cancun': 'CUN', 'mexico': 'MEX', 'mexico city': 'MEX',
      'playa del carmen': 'CUN', 'tulum': 'CUN',
      'punta cana': 'PUJ', 'dominican republic': 'PUJ',
      'havana': 'HAV', 'cuba': 'HAV',
      'montego bay': 'MBJ', 'kingston': 'KIN', 'jamaica': 'MBJ',
      'nassau': 'NAS', 'bahamas': 'NAS',
      'rio de janeiro': 'RIO', 'sao paulo': 'SAO', 'brazil': 'RIO',
      'buenos aires': 'BUE', 'argentina': 'BUE',
      'lima': 'LIM', 'peru': 'LIM', 'cusco': 'CUZ',
      'bogota': 'BOG', 'colombia': 'BOG', 'cartagena': 'CTG',
      'quito': 'UIO', 'ecuador': 'UIO', 'galapagos': 'GPS',
      'santiago': 'SCL', 'chile': 'SCL',
      'toronto': 'YTO', 'vancouver': 'YVR', 'montreal': 'YMQ',

      // Oceania
      'sydney': 'SYD', 'melbourne': 'MEL', 'brisbane': 'BNE',
      'cairns': 'CNS', 'gold coast': 'OOL', 'perth': 'PER',
      'auckland': 'AKL', 'queenstown': 'ZQN', 'christchurch': 'CHC',
      'fiji': 'NAN', 'nadi': 'NAN', 'tahiti': 'PPT', 'bora bora': 'BOB',
    };

    const key = (cityName || '').toLowerCase().trim();
    return CODES[key] || null;
  }

  // ─────────────────────────────────────────────
  // TIER 2: LIVE HOTELBEDS DESTINATION LOOKUP
  // Queries HotelBeds' own /locations/destinations endpoint when the
  // city isn't in the hardcoded map — same three-tier pattern as
  // duffel.js's _resolveIata for IATA code resolution.
  // Results cached in process memory so the same city only calls
  // the API once per deployment.
  // ─────────────────────────────────────────────
  async _lookupDestinationCodeLive(cityName) {
    const key = (cityName || '').toLowerCase().trim();
    if (_destinationCodeCache[key] !== undefined) {
      return _destinationCodeCache[key];
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/hotel-content-api/1.0/locations/destinations`,
        {
          headers: this._headers(),
          params: {
            fields: 'all',
            language: 'ENG',
            from: 1,
            to: 5,
            useSecondaryLanguages: false,
            name: cityName,
          },
          timeout: 8000,
        }
      );

      const destinations = response.data?.data?.destinations || [];
      if (destinations.length === 0) {
        logger.warn('HotelBeds: live destination lookup returned no results', { cityName });
        _destinationCodeCache[key] = null;
        return null;
      }

      // Find the best match — prefer exact name match, else first result
      const normalizedCity = key;
      const best = destinations.find(d =>
        (d.name?.content || '').toLowerCase() === normalizedCity
      ) || destinations[0];

      const code = best?.code || null;
      logger.info('HotelBeds: live destination lookup resolved', { cityName, code, name: best?.name?.content });
      _destinationCodeCache[key] = code;
      return code;

    } catch (err) {
      logger.warn('HotelBeds: live destination lookup failed', { cityName, error: err.message });
      _destinationCodeCache[key] = null;
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // TIER 3: GEOLOCATION FALLBACK
  // When both the hardcoded map and the live API lookup fail to
  // return a usable destination code, searches by GPS coordinates
  // instead — HotelBeds' hotel search API accepts a geolocation
  // object ({latitude, longitude, radius, unit}) as an alternative
  // to destinationCode. Only fires for cities in CITY_COORDINATES.
  // ─────────────────────────────────────────────
  _getGeolocationFallback(cityName) {
    const key = (cityName || '').toLowerCase().trim();
    return CITY_COORDINATES[key] || null;
  }

  // ─────────────────────────────────────────────
  // MAIN DESTINATION RESOLUTION
  // Three-tier, returns { destinationCode, geolocation } — callers
  // use whichever is non-null (destinationCode takes priority).
  // ─────────────────────────────────────────────
  async _resolveDestination(cityName) {
    if (!cityName) return { destinationCode: null, geolocation: null };

    // Tier 1: hardcoded map (instant, no API call)
    const hardcoded = this._getHardcodedDestinationCode(cityName);
    if (hardcoded) return { destinationCode: hardcoded, geolocation: null };

    // Tier 2: live HotelBeds API lookup
    const live = await this._lookupDestinationCodeLive(cityName);
    if (live) return { destinationCode: live, geolocation: null };

    // Tier 3: geolocation coordinates
    const geo = this._getGeolocationFallback(cityName);
    if (geo) {
      logger.info('HotelBeds: using geolocation fallback for destination', { cityName, geo });
      return { destinationCode: null, geolocation: { latitude: geo.lat, longitude: geo.lng, radius: 20, unit: 'km' } };
    }

    logger.warn('HotelBeds: could not resolve destination by any method', { cityName });
    return { destinationCode: null, geolocation: null };
  }

  // ─────────────────────────────────────────────
  // SEARCH HOTELS
  // ─────────────────────────────────────────────
  async search({ destination, checkIn, checkOut, adults = 1, children = 0,
                  childAges = [], rooms = 1, nights, budget, roomType = null }) {
    if (!this.apiKey || !this.apiSecret) {
      logger.warn('HotelBeds: credentials not configured');
      return [];
    }

    const { destinationCode, geolocation } = await this._resolveDestination(destination);

    if (!destinationCode && !geolocation) {
      logger.warn('HotelBeds: could not resolve destination — returning empty results', { destination });
      return [];
    }

    // Build occupancy per the HotelBeds spec — one pax object per
    // room, with real ages for children.
    const adultsPerRoom = Math.max(1, Math.ceil(adults / rooms));
    const childrenPerRoom = Math.ceil(children / rooms);
    const pax = [];
    for (let a = 0; a < adultsPerRoom; a++) pax.push({ type: 'AD' });
    for (let c = 0; c < childrenPerRoom; c++) {
      const age = childAges[c] ?? 8;
      pax.push({ type: 'CH', age });
    }
    const occupancies = [{ rooms, adults: adultsPerRoom, children: childrenPerRoom, paxes: pax }];

    // Build the request body
    const body = {
      stay: { checkIn, checkOut },
      occupancies,
      filter: {
        packaging: false,
      },
    };

    // Attach destination or geolocation
    if (destinationCode) {
      body.destination = { code: destinationCode };
    } else if (geolocation) {
      body.geolocation = geolocation;
    }

    // Room type filter
    if (roomType === 'single') {
      body.filter.minRooms = 1;
      body.filter.maxRooms = 1;
    }

    logger.info('HotelBeds search request', {
      destination,
      destinationCode: destinationCode || 'geolocation',
      checkIn,
      checkOut,
      adults,
      children,
      rooms,
    });

    try {
      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/hotels`,
        body,
        {
          headers: this._headers(),
          timeout: this.searchTimeout,
          decompress: true,
        }
      );

      const hotels = response.data?.hotels?.hotels || [];
      logger.info('HotelBeds search results', { destination, count: hotels.length });

      return this._normalizeHotels(hotels, { checkIn, checkOut, nights, adults, budget });

    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data;
      if (err.code === 'ECONNABORTED') {
        logger.error(`HotelBeds search timed out after ${this.searchTimeout}ms`, { destination });
      } else {
        logger.error('HotelBeds search failed', { destination, status, detail: JSON.stringify(detail)?.slice(0, 200), error: err.message });
      }
      return [];
    }
  }

  // ─────────────────────────────────────────────
  // CHECK RATE (for RECHECK rate types)
  // ─────────────────────────────────────────────
  async checkRate({ rateKey }) {
    if (!this.apiKey || !this.apiSecret) return null;

    try {
      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/checkrates`,
        { rooms: [{ rateKey }] },
        { headers: this._headers(), timeout: this.timeout, decompress: true }
      );

      const hotel = response.data?.hotel;
      const room = hotel?.rooms?.[0];
      const rate = room?.rates?.[0];
      if (!rate) return null;

      return {
        rateKey: rate.rateKey,
        net: Number(rate.net || 0),
        sellingRate: Number(rate.sellingRate || rate.net || 0),
        rateType: rate.rateType,
        cancellationPolicies: rate.cancellationPolicies || [],
        rateComments: rate.rateComments || null,
      };
    } catch (err) {
      logger.error('HotelBeds checkRate failed', { error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // BOOK
  // ─────────────────────────────────────────────
  async book({ rateKey, holder, guests, clientReference, remark }) {
    if (!this.apiKey || !this.apiSecret) throw new Error('HotelBeds credentials not configured');

    const guestRooms = guests.map(g => ({
      rateKey,
      paxes: [{ roomId: g.roomId || 1, type: g.type === 'child' ? 'CH' : 'AD', name: g.lastName, surname: g.firstName }],
    }));

    const body = {
      holder: { name: holder.firstName, surname: holder.lastName },
      rooms: guestRooms,
      clientReference,
      remark,
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/hotel-api/1.0/bookings`,
        body,
        { headers: this._headers(), timeout: this.timeout, decompress: true }
      );

      return this._normalizeBooking(response.data?.booking);
    } catch (err) {
      logger.error('HotelBeds book failed', { error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // CANCEL
  // ─────────────────────────────────────────────
  async cancel({ bookingRef }) {
    if (!this.apiKey || !this.apiSecret) throw new Error('HotelBeds credentials not configured');

    try {
      const response = await axios.delete(
        `${this.baseUrl}/hotel-api/1.0/bookings/${bookingRef}`,
        { headers: this._headers(), timeout: this.timeout, params: { cancellationFlag: 'CANCELLATION' }, decompress: true }
      );

      const booking = response.data?.booking;
      return {
        bookingRef: booking?.reference,
        status: booking?.status,
        cancellationReference: booking?.cancellationReference || null,
      };
    } catch (err) {
      logger.error('HotelBeds cancel failed', { bookingRef, error: err.message, detail: err.response?.data });
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // NORMALIZE HOTELS
  // ─────────────────────────────────────────────
  _normalizeHotels(hotels, { checkIn, checkOut, nights, adults, budget }) {
    const results = [];

    for (const hotel of hotels) {
      const room = hotel.rooms?.[0];
      if (!room) continue;

      // Find the best rate — prefer NOR (non-refundable) for lowest
      // price display, but never force non-refundable into the booking
      // flow (bookingService.js validates isRefundable independently).
      const rates = room.rates || [];
      if (rates.length === 0) continue;

      // Sort by net price ascending
      rates.sort((a, b) => Number(a.net || 0) - Number(b.net || 0));
      const rate = rates[0];

      const totalRate = Number(rate.sellingRate || rate.net || 0);
      const nightCount = nights || this._nightsBetween(checkIn, checkOut) || 1;
      const pricePerNight = nightCount > 0 ? totalRate / nightCount : totalRate;

      const isRefundable = rate.rateType !== 'NOR';

      results.push({
        supplier: 'hotelbeds',
        hotelCode: String(hotel.code),
        name: hotel.name,
        stars: hotel.categoryCode ? this._parseStars(hotel.categoryCode) : null,
        rating: hotel.reviewScore || null,
        location: hotel.zoneName || hotel.destinationName || null,
        latitude: hotel.coordinates?.latitude || null,
        longitude: hotel.coordinates?.longitude || null,
        images: hotel.imageUrls || [],
        checkIn,
        checkOut,
        nights: nightCount,
        pricePerNight: Math.round(pricePerNight * 100) / 100,
        totalRate: Math.round(totalRate * 100) / 100,
        currency: 'EUR',
        rateKey: rate.rateKey,
        rateType: rate.rateType,
        isRefundable,
        cancellationPolicies: rate.cancellationPolicies || [],
        rateComments: rate.rateComments || null,
        mealPlan: this._normalizeMealPlan(rate.boardCode),
        boardType: rate.boardCode,
        promotions: rate.promotions || [],
        rooms: rate.rooms || 1,
        adults,
        supplier_tag: rate.rateKey ? rate.rateKey.slice(0, 20) : null,
      });
    }

    return results;
  }

  _normalizeBooking(booking) {
    if (!booking) return null;
    const room = booking.hotel?.rooms?.[0];
    const rate = room?.rates?.[0];
    return {
      supplierBookingReference: booking.reference,
      status: booking.status,
      clientReference: booking.clientReference,
      checkIn: booking.hotel?.checkIn,
      checkOut: booking.hotel?.checkOut,
      totalRate: Number(booking.totalNet || booking.totalSellingRate || 0),
      currency: 'EUR',
      rateKey: rate?.rateKey || null,
      cancellationPolicies: rate?.cancellationPolicies || [],
      rateComments: rate?.rateComments || null,
      hotelName: booking.hotel?.name || null,
      hotelAddress: booking.hotel?.address || null,
      hotelPhone: booking.hotel?.phoneNumber || null,
      hotelEmail: booking.hotel?.email || null,
      supplier_tag: rate?.rateKey ? rate.rateKey.slice(0, 20) : null,
    };
  }

  _normalizeMealPlan(boardCode) {
    const plans = {
      'RO': 'Room Only', 'BB': 'Bed & Breakfast', 'HB': 'Half Board',
      'FB': 'Full Board', 'AI': 'All Inclusive', 'UAI': 'Ultra All Inclusive',
      'SC': 'Self Catering',
    };
    return plans[boardCode] || boardCode || null;
  }

  _parseStars(categoryCode) {
    const match = String(categoryCode).match(/(\d)/);
    return match ? parseInt(match[1], 10) : null;
  }

  _nightsBetween(checkIn, checkOut) {
    if (!checkIn || !checkOut) return null;
    const diff = new Date(checkOut) - new Date(checkIn);
    return Math.round(diff / (1000 * 60 * 60 * 24));
  }
}

module.exports = new HotelBedsAdapter();