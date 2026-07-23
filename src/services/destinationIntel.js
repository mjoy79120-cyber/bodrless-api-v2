/**
 * DESTINATION INTELLIGENCE LAYER
 * ─────────────────────────────────────────────
 * Resolves a free-text destination (e.g. "Watamu", "Diani",
 * "Maasai Mara") into structured per-mode access data:
 * nearest hub for air/train/bus, whether a transfer is
 * required, and whether that mode is actually bookable
 * in Bodrless today.
 *
 * Flow: STATIC OVERRIDES (hand-verified, exact) → Supabase
 * cache (exact + alias + fuzzy) → Groq resolution (direct
 * REST call, same pattern as promptParser.js) → validation
 * (TravelDuqa network, then static IATA list, unless it's an
 * airstrip destination) → cache write.
 *
 * Bad Groq answers that fail validation are NEVER cached
 * as trustworthy — they're returned as needs_clarification
 * so callers can ask the user rather than silently booking
 * the wrong route.
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const supabase = require('../utils/supabase');
const travelDuqa = require('../adapters/travelduqa');
const { logger } = require('../utils/logger');
const STATIC_IATA_CODES = require('../data/staticIataList');

// ─────────────────────────────────────────────
// HELPER — build a simple city override entry
// ─────────────────────────────────────────────
function _cityOverride(name, iata, { transferFrom = null, transferKm = null } = {}) {
  const isDirect = !transferFrom;
  return {
    destination: name,
    destinationType: 'city',
    isAirstripDestination: false,
    airstripCodes: [],
    accessByMode: {
      air: {
        hubName: transferFrom || name,
        hubCode: iata,
        directService: isDirect,
        transferRequired: !isDirect,
        transferDistanceKm: transferKm || null,
      },
      train: { hubName: null, hubCode: null, directService: false, transferRequired: false, transferDistanceKm: null },
      bus:   { hubName: null, hubCode: null, directService: false, transferRequired: false, transferDistanceKm: null },
    },
  };
}

// ─────────────────────────────────────────────
// STATIC CORRIDOR OVERRIDES
// Hand-verified, never go to Groq for these.
// ─────────────────────────────────────────────
const STATIC_DESTINATION_OVERRIDES = {
  // ── Kenya coast ──────────────────────────
  kilifi: {
    destination: 'kilifi',
    destinationType: 'town',
    isAirstripDestination: false,
    airstripCodes: [],
    accessByMode: {
      air: { hubName: 'malindi', hubCode: 'MYD', directService: false, transferRequired: true, transferDistanceKm: 60 },
      train: { hubName: 'mombasa', hubCode: null, directService: false, transferRequired: true, transferDistanceKm: 60 },
      bus: { hubName: null, hubCode: null, directService: true, transferRequired: false, transferDistanceKm: null, searchAs: 'malindi' },
    },
  },
  watamu: {
    destination: 'watamu',
    destinationType: 'town',
    isAirstripDestination: false,
    airstripCodes: [],
    accessByMode: {
      air: { hubName: 'malindi', hubCode: 'MYD', directService: false, transferRequired: true, transferDistanceKm: 25 },
      train: { hubName: 'mombasa', hubCode: null, directService: false, transferRequired: true, transferDistanceKm: 100 },
      bus: { hubName: null, hubCode: null, directService: true, transferRequired: false, transferDistanceKm: null, searchAs: 'malindi' },
    },
  },
  diani: {
    destination: 'diani',
    destinationType: 'town',
    isAirstripDestination: false,
    airstripCodes: [],
    accessByMode: {
      air:   { hubName: 'diani', hubCode: 'UKA', directService: true,  transferRequired: false, transferDistanceKm: null },
      train: { hubName: 'mombasa', hubCode: null, directService: false, transferRequired: true,  transferDistanceKm: 35 },
      bus:   { hubName: 'mombasa', hubCode: null, directService: false, transferRequired: true,  transferDistanceKm: 35 },
    },
  },
};

// ── Aliases for existing entries ──────────────
STATIC_DESTINATION_OVERRIDES['diani beach'] = STATIC_DESTINATION_OVERRIDES['diani'];
STATIC_DESTINATION_OVERRIDES['ukunda']      = STATIC_DESTINATION_OVERRIDES['diani'];

// ── Indian Ocean islands ──────────────────────
STATIC_DESTINATION_OVERRIDES['port louis']   = _cityOverride('port louis',   'MRU');
STATIC_DESTINATION_OVERRIDES['mauritius']    = _cityOverride('mauritius',    'MRU');
STATIC_DESTINATION_OVERRIDES['grand baie']   = _cityOverride('grand baie',   'MRU', { transferFrom: 'port louis',  transferKm: 40 });
STATIC_DESTINATION_OVERRIDES['flic en flac'] = _cityOverride('flic en flac', 'MRU', { transferFrom: 'port louis',  transferKm: 30 });
STATIC_DESTINATION_OVERRIDES['belle mare']   = _cityOverride('belle mare',   'MRU', { transferFrom: 'port louis',  transferKm: 45 });
STATIC_DESTINATION_OVERRIDES['mahe']         = _cityOverride('mahe',         'SEZ');
STATIC_DESTINATION_OVERRIDES['seychelles']   = _cityOverride('seychelles',   'SEZ');
STATIC_DESTINATION_OVERRIDES['praslin']      = _cityOverride('praslin',      'SEZ', { transferFrom: 'mahe',        transferKm: 45 });
STATIC_DESTINATION_OVERRIDES['male']         = _cityOverride('male',         'MLE');
STATIC_DESTINATION_OVERRIDES['maldives']     = _cityOverride('maldives',     'MLE');
STATIC_DESTINATION_OVERRIDES['nosy be']      = _cityOverride('nosy be',      'NOS');
STATIC_DESTINATION_OVERRIDES['la reunion']   = _cityOverride('la reunion',   'RUN');
STATIC_DESTINATION_OVERRIDES['reunion']      = _cityOverride('reunion',      'RUN');
STATIC_DESTINATION_OVERRIDES['comoros']      = _cityOverride('comoros',      'HAH');
STATIC_DESTINATION_OVERRIDES['pemba']        = _cityOverride('pemba',        'PMA');

// ── East Africa — major cities ────────────────
STATIC_DESTINATION_OVERRIDES['zanzibar']      = _cityOverride('zanzibar',      'ZNZ');
STATIC_DESTINATION_OVERRIDES['stone town']    = _cityOverride('stone town',    'ZNZ');
STATIC_DESTINATION_OVERRIDES['dar es salaam'] = _cityOverride('dar es salaam', 'DAR');
STATIC_DESTINATION_OVERRIDES['addis ababa']   = _cityOverride('addis ababa',   'ADD');
STATIC_DESTINATION_OVERRIDES['kigali']        = _cityOverride('kigali',        'KGL');
STATIC_DESTINATION_OVERRIDES['rwanda']        = _cityOverride('rwanda',        'KGL');
STATIC_DESTINATION_OVERRIDES['entebbe']       = _cityOverride('entebbe',       'EBB');
STATIC_DESTINATION_OVERRIDES['kampala']       = _cityOverride('kampala',       'EBB', { transferFrom: 'entebbe',       transferKm: 45 });
STATIC_DESTINATION_OVERRIDES['maputo']        = _cityOverride('maputo',        'MPM');
STATIC_DESTINATION_OVERRIDES['antananarivo']  = _cityOverride('antananarivo',  'TNR');
STATIC_DESTINATION_OVERRIDES['madagascar']    = _cityOverride('madagascar',    'TNR');
STATIC_DESTINATION_OVERRIDES['lusaka']        = _cityOverride('lusaka',        'LUN');
STATIC_DESTINATION_OVERRIDES['harare']        = _cityOverride('harare',        'HRE');
STATIC_DESTINATION_OVERRIDES['windhoek']      = _cityOverride('windhoek',      'WDH');
STATIC_DESTINATION_OVERRIDES['luanda']        = _cityOverride('luanda',        'LAD');

// ── East Africa — safari / non-airport towns ──
STATIC_DESTINATION_OVERRIDES['malindi']       = _cityOverride('malindi',       'MYD');
STATIC_DESTINATION_OVERRIDES['lamu']          = _cityOverride('lamu',          'LAU');
STATIC_DESTINATION_OVERRIDES['nanyuki']       = _cityOverride('nanyuki',       'NYK');
STATIC_DESTINATION_OVERRIDES['naivasha']      = _cityOverride('naivasha',      'NBO', { transferFrom: 'nairobi',       transferKm: 90 });
STATIC_DESTINATION_OVERRIDES['lake nakuru']   = _cityOverride('lake nakuru',   'NBO', { transferFrom: 'nairobi',       transferKm: 160 });
STATIC_DESTINATION_OVERRIDES['amboseli']      = _cityOverride('amboseli',      'NBO', { transferFrom: 'nairobi',       transferKm: 240 });
STATIC_DESTINATION_OVERRIDES['tsavo']         = _cityOverride('tsavo',         'MBA', { transferFrom: 'mombasa',       transferKm: 130 });
STATIC_DESTINATION_OVERRIDES['samburu']       = _cityOverride('samburu',       'NBO', { transferFrom: 'nairobi',       transferKm: 330 });
STATIC_DESTINATION_OVERRIDES['maasai mara']   = _cityOverride('maasai mara',   'NBO', { transferFrom: 'nairobi',       transferKm: 270 });
STATIC_DESTINATION_OVERRIDES['masai mara']    = STATIC_DESTINATION_OVERRIDES['maasai mara'];
STATIC_DESTINATION_OVERRIDES['arusha']        = _cityOverride('arusha',        'JRO', { transferFrom: 'kilimanjaro',   transferKm: 46 });
STATIC_DESTINATION_OVERRIDES['kilimanjaro']   = _cityOverride('kilimanjaro',   'JRO');
STATIC_DESTINATION_OVERRIDES['serengeti']     = _cityOverride('serengeti',     'JRO', { transferFrom: 'kilimanjaro',   transferKm: 330 });
STATIC_DESTINATION_OVERRIDES['ngorongoro']    = _cityOverride('ngorongoro',    'JRO', { transferFrom: 'kilimanjaro',   transferKm: 180 });
STATIC_DESTINATION_OVERRIDES['bwindi']        = _cityOverride('bwindi',        'EBB', { transferFrom: 'entebbe',       transferKm: 500 });
STATIC_DESTINATION_OVERRIDES['lake victoria'] = _cityOverride('lake victoria', 'EBB', { transferFrom: 'entebbe',       transferKm: 35 });

// ── Southern Africa ───────────────────────────
STATIC_DESTINATION_OVERRIDES['johannesburg']  = _cityOverride('johannesburg',  'JNB');
STATIC_DESTINATION_OVERRIDES['cape town']     = _cityOverride('cape town',     'CPT');
STATIC_DESTINATION_OVERRIDES['durban']        = _cityOverride('durban',        'DUR');
STATIC_DESTINATION_OVERRIDES['port elizabeth']= _cityOverride('port elizabeth','PLZ');
STATIC_DESTINATION_OVERRIDES['gqeberha']      = _cityOverride('gqeberha',      'PLZ');
STATIC_DESTINATION_OVERRIDES['stellenbosch']  = _cityOverride('stellenbosch',  'CPT', { transferFrom: 'cape town',     transferKm: 50 });
STATIC_DESTINATION_OVERRIDES['franschhoek']   = _cityOverride('franschhoek',   'CPT', { transferFrom: 'cape town',     transferKm: 75 });
STATIC_DESTINATION_OVERRIDES['hermanus']      = _cityOverride('hermanus',      'CPT', { transferFrom: 'cape town',     transferKm: 120 });
STATIC_DESTINATION_OVERRIDES['knysna']        = _cityOverride('knysna',        'GRJ', { transferFrom: 'george',        transferKm: 70 });
STATIC_DESTINATION_OVERRIDES['garden route']  = _cityOverride('garden route',  'GRJ', { transferFrom: 'george',        transferKm: 10 });
STATIC_DESTINATION_OVERRIDES['sun city']      = _cityOverride('sun city',      'JNB', { transferFrom: 'johannesburg',  transferKm: 185 });
STATIC_DESTINATION_OVERRIDES['kruger']        = _cityOverride('kruger',        'MQP', { transferFrom: 'kruger mpumalanga', transferKm: 60 });
STATIC_DESTINATION_OVERRIDES['kruger park']   = _cityOverride('kruger park',   'MQP', { transferFrom: 'kruger mpumalanga', transferKm: 60 });

// ── North & West Africa ───────────────────────
STATIC_DESTINATION_OVERRIDES['cairo']         = _cityOverride('cairo',         'CAI');
STATIC_DESTINATION_OVERRIDES['marrakech']     = _cityOverride('marrakech',     'RAK');
STATIC_DESTINATION_OVERRIDES['casablanca']    = _cityOverride('casablanca',    'CMN');
STATIC_DESTINATION_OVERRIDES['accra']         = _cityOverride('accra',         'ACC');
STATIC_DESTINATION_OVERRIDES['lagos']         = _cityOverride('lagos',         'LOS');
STATIC_DESTINATION_OVERRIDES['abuja']         = _cityOverride('abuja',         'ABV');
STATIC_DESTINATION_OVERRIDES['dakar']         = _cityOverride('dakar',         'DSS');

// ── Middle East ───────────────────────────────
STATIC_DESTINATION_OVERRIDES['dubai']         = _cityOverride('dubai',         'DXB');
STATIC_DESTINATION_OVERRIDES['abu dhabi']     = _cityOverride('abu dhabi',     'AUH');
STATIC_DESTINATION_OVERRIDES['doha']          = _cityOverride('doha',          'DOH');
STATIC_DESTINATION_OVERRIDES['muscat']        = _cityOverride('muscat',        'MCT');
STATIC_DESTINATION_OVERRIDES['istanbul']      = _cityOverride('istanbul',      'IST');
STATIC_DESTINATION_OVERRIDES['sharjah']       = _cityOverride('sharjah',       'SHJ');
STATIC_DESTINATION_OVERRIDES['riyadh']        = _cityOverride('riyadh',        'RUH');
STATIC_DESTINATION_OVERRIDES['jeddah']        = _cityOverride('jeddah',        'JED');
STATIC_DESTINATION_OVERRIDES['amman']         = _cityOverride('amman',         'AMM');
STATIC_DESTINATION_OVERRIDES['beirut']        = _cityOverride('beirut',        'BEY');
STATIC_DESTINATION_OVERRIDES['tel aviv']      = _cityOverride('tel aviv',      'TLV');
STATIC_DESTINATION_OVERRIDES['jerusalem']     = _cityOverride('jerusalem',     'TLV', { transferFrom: 'tel aviv',      transferKm: 60 });
STATIC_DESTINATION_OVERRIDES['petra']         = _cityOverride('petra',         'AMM', { transferFrom: 'amman',         transferKm: 230 });
STATIC_DESTINATION_OVERRIDES['aqaba']         = _cityOverride('aqaba',         'AQJ');

// ── Europe ────────────────────────────────────
STATIC_DESTINATION_OVERRIDES['london']        = _cityOverride('london',        'LHR');
STATIC_DESTINATION_OVERRIDES['paris']         = _cityOverride('paris',         'CDG');
STATIC_DESTINATION_OVERRIDES['amsterdam']     = _cityOverride('amsterdam',     'AMS');
STATIC_DESTINATION_OVERRIDES['rome']          = _cityOverride('rome',          'FCO');
STATIC_DESTINATION_OVERRIDES['madrid']        = _cityOverride('madrid',        'MAD');
STATIC_DESTINATION_OVERRIDES['barcelona']     = _cityOverride('barcelona',     'BCN');
STATIC_DESTINATION_OVERRIDES['athens']        = _cityOverride('athens',        'ATH');
STATIC_DESTINATION_OVERRIDES['venice']        = _cityOverride('venice',        'VCE');
STATIC_DESTINATION_OVERRIDES['florence']      = _cityOverride('florence',      'FCO', { transferFrom: 'rome',          transferKm: 280 });
STATIC_DESTINATION_OVERRIDES['tuscany']       = _cityOverride('tuscany',       'FCO', { transferFrom: 'rome',          transferKm: 280 });
STATIC_DESTINATION_OVERRIDES['amalfi coast']  = _cityOverride('amalfi coast',  'NAP', { transferFrom: 'naples',        transferKm: 60 });
STATIC_DESTINATION_OVERRIDES['positano']      = _cityOverride('positano',      'NAP', { transferFrom: 'naples',        transferKm: 55 });
STATIC_DESTINATION_OVERRIDES['santorini']     = _cityOverride('santorini',     'JTR');
STATIC_DESTINATION_OVERRIDES['mykonos']       = _cityOverride('mykonos',       'JMK');
STATIC_DESTINATION_OVERRIDES['crete']         = _cityOverride('crete',         'HER');
STATIC_DESTINATION_OVERRIDES['ibiza']         = _cityOverride('ibiza',         'IBZ');
STATIC_DESTINATION_OVERRIDES['mallorca']      = _cityOverride('mallorca',      'PMI');
STATIC_DESTINATION_OVERRIDES['lisbon']        = _cityOverride('lisbon',        'LIS');
STATIC_DESTINATION_OVERRIDES['porto']         = _cityOverride('porto',         'OPO');
STATIC_DESTINATION_OVERRIDES['brussels']      = _cityOverride('brussels',      'BRU');
STATIC_DESTINATION_OVERRIDES['zurich']        = _cityOverride('zurich',        'ZRH');
STATIC_DESTINATION_OVERRIDES['geneva']        = _cityOverride('geneva',        'GVA');
STATIC_DESTINATION_OVERRIDES['vienna']        = _cityOverride('vienna',        'VIE');
STATIC_DESTINATION_OVERRIDES['prague']        = _cityOverride('prague',        'PRG');
STATIC_DESTINATION_OVERRIDES['budapest']      = _cityOverride('budapest',      'BUD');
STATIC_DESTINATION_OVERRIDES['copenhagen']    = _cityOverride('copenhagen',    'CPH');
STATIC_DESTINATION_OVERRIDES['stockholm']     = _cityOverride('stockholm',     'ARN');
STATIC_DESTINATION_OVERRIDES['oslo']          = _cityOverride('oslo',          'OSL');
STATIC_DESTINATION_OVERRIDES['helsinki']      = _cityOverride('helsinki',      'HEL');
STATIC_DESTINATION_OVERRIDES['edinburgh']     = _cityOverride('edinburgh',     'EDI');
STATIC_DESTINATION_OVERRIDES['manchester']    = _cityOverride('manchester',    'MAN');
STATIC_DESTINATION_OVERRIDES['dubrovnik']     = _cityOverride('dubrovnik',     'DBV');
STATIC_DESTINATION_OVERRIDES['split']         = _cityOverride('split',         'SPU');
STATIC_DESTINATION_OVERRIDES['zagreb']        = _cityOverride('zagreb',        'ZAG');
STATIC_DESTINATION_OVERRIDES['reykjavik']     = _cityOverride('reykjavik',     'KEF');

// ── Asia ──────────────────────────────────────
STATIC_DESTINATION_OVERRIDES['bali']          = _cityOverride('bali',          'DPS');
STATIC_DESTINATION_OVERRIDES['ubud']          = _cityOverride('ubud',          'DPS', { transferFrom: 'bali',          transferKm: 75 });
STATIC_DESTINATION_OVERRIDES['seminyak']      = _cityOverride('seminyak',      'DPS', { transferFrom: 'bali',          transferKm: 10 });
STATIC_DESTINATION_OVERRIDES['lombok']        = _cityOverride('lombok',        'LOP');
STATIC_DESTINATION_OVERRIDES['phuket']        = _cityOverride('phuket',        'HKT');
STATIC_DESTINATION_OVERRIDES['koh samui']     = _cityOverride('koh samui',     'USM');
STATIC_DESTINATION_OVERRIDES['krabi']         = _cityOverride('krabi',         'KBV');
STATIC_DESTINATION_OVERRIDES['chiang mai']    = _cityOverride('chiang mai',    'CNX');
STATIC_DESTINATION_OVERRIDES['bangkok']       = _cityOverride('bangkok',       'BKK');
STATIC_DESTINATION_OVERRIDES['singapore']     = _cityOverride('singapore',     'SIN');
STATIC_DESTINATION_OVERRIDES['kuala lumpur']  = _cityOverride('kuala lumpur',  'KUL');
STATIC_DESTINATION_OVERRIDES['delhi']         = _cityOverride('delhi',         'DEL');
STATIC_DESTINATION_OVERRIDES['mumbai']        = _cityOverride('mumbai',        'BOM');
STATIC_DESTINATION_OVERRIDES['goa']           = _cityOverride('goa',           'GOI');
STATIC_DESTINATION_OVERRIDES['kathmandu']     = _cityOverride('kathmandu',     'KTM');
STATIC_DESTINATION_OVERRIDES['colombo']       = _cityOverride('colombo',       'CMB');
STATIC_DESTINATION_OVERRIDES['sri lanka']     = _cityOverride('sri lanka',     'CMB');
STATIC_DESTINATION_OVERRIDES['dhaka']         = _cityOverride('dhaka',         'DAC');
STATIC_DESTINATION_OVERRIDES['karachi']       = _cityOverride('karachi',       'KHI');
STATIC_DESTINATION_OVERRIDES['lahore']        = _cityOverride('lahore',        'LHE');
STATIC_DESTINATION_OVERRIDES['islamabad']     = _cityOverride('islamabad',     'ISB');
STATIC_DESTINATION_OVERRIDES['tokyo']         = _cityOverride('tokyo',         'TYO');
STATIC_DESTINATION_OVERRIDES['osaka']         = _cityOverride('osaka',         'KIX');
STATIC_DESTINATION_OVERRIDES['beijing']       = _cityOverride('beijing',       'PEK');
STATIC_DESTINATION_OVERRIDES['shanghai']      = _cityOverride('shanghai',      'PVG');
STATIC_DESTINATION_OVERRIDES['hong kong']     = _cityOverride('hong kong',     'HKG');
STATIC_DESTINATION_OVERRIDES['seoul']         = _cityOverride('seoul',         'ICN');
STATIC_DESTINATION_OVERRIDES['manila']        = _cityOverride('manila',        'MNL');
STATIC_DESTINATION_OVERRIDES['ho chi minh']   = _cityOverride('ho chi minh',   'SGN');
STATIC_DESTINATION_OVERRIDES['saigon']        = STATIC_DESTINATION_OVERRIDES['ho chi minh'];
STATIC_DESTINATION_OVERRIDES['hanoi']         = _cityOverride('hanoi',         'HAN');
STATIC_DESTINATION_OVERRIDES['hoi an']        = _cityOverride('hoi an',        'DAD', { transferFrom: 'da nang',       transferKm: 30 });
STATIC_DESTINATION_OVERRIDES['ha long bay']   = _cityOverride('ha long bay',   'HAN', { transferFrom: 'hanoi',         transferKm: 170 });
STATIC_DESTINATION_OVERRIDES['phnom penh']    = _cityOverride('phnom penh',    'PNH');
STATIC_DESTINATION_OVERRIDES['siem reap']     = _cityOverride('siem reap',     'REP');
STATIC_DESTINATION_OVERRIDES['yangon']        = _cityOverride('yangon',        'RGN');

// ── Americas ──────────────────────────────────
STATIC_DESTINATION_OVERRIDES['new york']      = _cityOverride('new york',      'JFK');
STATIC_DESTINATION_OVERRIDES['miami']         = _cityOverride('miami',         'MIA');
STATIC_DESTINATION_OVERRIDES['los angeles']   = _cityOverride('los angeles',   'LAX');
STATIC_DESTINATION_OVERRIDES['san francisco'] = _cityOverride('san francisco', 'SFO');
STATIC_DESTINATION_OVERRIDES['las vegas']     = _cityOverride('las vegas',     'LAS');
STATIC_DESTINATION_OVERRIDES['cancun']        = _cityOverride('cancun',        'CUN');
STATIC_DESTINATION_OVERRIDES['toronto']       = _cityOverride('toronto',       'YYZ');
STATIC_DESTINATION_OVERRIDES['vancouver']     = _cityOverride('vancouver',     'YVR');
STATIC_DESTINATION_OVERRIDES['montreal']      = _cityOverride('montreal',      'YUL');
STATIC_DESTINATION_OVERRIDES['sao paulo']     = _cityOverride('sao paulo',     'GRU');
STATIC_DESTINATION_OVERRIDES['rio de janeiro']= _cityOverride('rio de janeiro','GIG');
STATIC_DESTINATION_OVERRIDES['buenos aires']  = _cityOverride('buenos aires',  'EZE');
STATIC_DESTINATION_OVERRIDES['bogota']        = _cityOverride('bogota',        'BOG');
STATIC_DESTINATION_OVERRIDES['lima']          = _cityOverride('lima',          'LIM');
STATIC_DESTINATION_OVERRIDES['cusco']         = _cityOverride('cusco',         'CUZ');
STATIC_DESTINATION_OVERRIDES['machu picchu']  = _cityOverride('machu picchu',  'CUZ', { transferFrom: 'cusco',         transferKm: 80 });
STATIC_DESTINATION_OVERRIDES['mexico city']   = _cityOverride('mexico city',   'MEX');
STATIC_DESTINATION_OVERRIDES['havana']        = _cityOverride('havana',        'HAV');
STATIC_DESTINATION_OVERRIDES['punta cana']    = _cityOverride('punta cana',    'PUJ');
STATIC_DESTINATION_OVERRIDES['montego bay']   = _cityOverride('montego bay',   'MBJ');
STATIC_DESTINATION_OVERRIDES['nassau']        = _cityOverride('nassau',        'NAS');

// ── Australia / Pacific ───────────────────────
STATIC_DESTINATION_OVERRIDES['sydney']        = _cityOverride('sydney',        'SYD');
STATIC_DESTINATION_OVERRIDES['melbourne']     = _cityOverride('melbourne',     'MEL');
STATIC_DESTINATION_OVERRIDES['brisbane']      = _cityOverride('brisbane',      'BNE');
STATIC_DESTINATION_OVERRIDES['perth']         = _cityOverride('perth',         'PER');
STATIC_DESTINATION_OVERRIDES['auckland']      = _cityOverride('auckland',      'AKL');
STATIC_DESTINATION_OVERRIDES['queenstown']    = _cityOverride('queenstown',    'ZQN');
STATIC_DESTINATION_OVERRIDES['fiji']          = _cityOverride('fiji',          'NAN');
STATIC_DESTINATION_OVERRIDES['nadi']          = _cityOverride('nadi',          'NAN');


class DestinationIntel {

  // ─────────────────────────────────────────────
  // PUBLIC: resolve a destination name
  // ─────────────────────────────────────────────
  async resolve(destinationName) {
    if (!destinationName) return null;
    const normalized = destinationName.toLowerCase().trim();

    const staticOverride = STATIC_DESTINATION_OVERRIDES[normalized];
    if (staticOverride) {
      return {
        ...staticOverride,
        requiresCharter: false,
        validationStatus: 'validated',
        validationSource: 'static_override',
      };
    }

    const cached = await this._lookupCache(normalized);
    if (cached) return cached;

    logger.info('DestinationIntel: cache miss, resolving via Groq', { destination: normalized });

    const geminiResult = await this._resolveViaGemini(normalized);
    if (!geminiResult) {
      return { destination: normalized, validationStatus: 'needs_clarification', accessByMode: {} };
    }

    const validated = await this._validate(geminiResult);
    await this._cacheResult(normalized, validated);

    return validated;
  }

  // ─────────────────────────────────────────────
  // CACHE LOOKUP — exact, alias, then fuzzy (trigram)
  // ─────────────────────────────────────────────
  async _lookupCache(normalized) {
    const { data: exact } = await supabase
      .from('destination_intel')
      .select('*')
      .eq('destination_name', normalized)
      .eq('validation_status', 'validated')
      .maybeSingle();

    if (exact) return this._toResultShape(exact);

    const { data: aliasMatch } = await supabase
      .from('destination_intel')
      .select('*')
      .contains('aliases', [normalized])
      .eq('validation_status', 'validated')
      .maybeSingle();

    if (aliasMatch) return this._toResultShape(aliasMatch);

    const { data: fuzzyMatches } = await supabase.rpc('match_destination_fuzzy', {
      input_name: normalized,
      min_similarity: 0.6,
    });

    if (fuzzyMatches?.length) {
      logger.info('DestinationIntel: fuzzy cache match', { input: normalized, matched: fuzzyMatches[0].destination_name });
      return this._toResultShape(fuzzyMatches[0]);
    }

    return null;
  }

  // ─────────────────────────────────────────────
  // GROQ RESOLUTION (llama-3.1-8b-instant)
  // ─────────────────────────────────────────────
  async _resolveViaGemini(destinationName) {
    const prompt = `You are a travel logistics expert for East Africa and global routes. For the destination "${destinationName}", return ONLY a JSON object, no markdown fences, no preamble, in exactly this shape:

{
  "destination": "string, normalized lowercase",
  "destinationType": "city|town|landmark|park|island|region|airstrip_destination",
  "isAirstripDestination": boolean,
  "airstripCodes": ["array of named airstrips if applicable, else empty array"],
  "accessByMode": {
    "air": { "hubName": "string or null", "hubCode": "IATA code string or null", "directService": boolean, "transferRequired": boolean, "transferDistanceKm": number or null },
    "train": { "hubName": "string or null", "hubCode": null, "directService": boolean, "transferRequired": boolean, "transferDistanceKm": number or null },
    "bus": { "hubName": "string or null", "hubCode": null, "directService": boolean, "transferRequired": boolean, "transferDistanceKm": number or null }
  }
}

Rules:
- If the destination IS itself a major airport city (e.g. Nairobi, Mombasa, Mumbai, Mahe), set directService true for air and transferRequired false.
- If the destination does not have a major airport and is reached via a nearby hub with a road transfer (e.g. Watamu via Malindi), set hubName/hubCode to that airport hub and transferRequired true.
- If a mode has no reasonable route, set hubName null and directService false.
- For safari/wilderness destinations served by small aircraft (e.g. Maasai Mara), set isAirstripDestination true, list real named airstrips in airstripCodes, and leave air.hubCode null.
- Real, geographically accurate transport facts only. Do not invent airport codes.`;

    try {
      const response = await axios.post(
        `https://api.groq.com/openai/v1/chat/completions`,
        {
          model: 'llama-3.1-8b-instant',
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_completion_tokens: 800,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          },
          timeout: 10000,
        }
      );

      const content = response.data.choices[0].message.content;
      const parsed = JSON.parse(content);

      // ── SANITY CHECK: hubCode must be a valid 3-letter IATA code ──
      // Groq occasionally hallucinates codes like "mrUganda". Reject
      // anything that doesn't look like a real IATA before it poisons
      // the flight search.
      const airHub = parsed?.accessByMode?.air;
      if (airHub?.hubCode) {
        const clean = String(airHub.hubCode).toUpperCase().trim();
        if (!/^[A-Z]{3}$/.test(clean)) {
          logger.warn('DestinationIntel: Groq returned invalid hubCode — clearing it', {
            destination: destinationName, hubCode: airHub.hubCode,
          });
          airHub.hubCode = null;
        } else {
          airHub.hubCode = clean;
        }
      }

      return parsed;
    } catch (err) {
      logger.error('DestinationIntel: Groq resolution failed', { error: err.message, destination: destinationName });
      return null;
    }
  }

  // ─────────────────────────────────────────────
  // VALIDATION CASCADE
  // ─────────────────────────────────────────────
  async _validate(geminiResult) {
    const result = { ...geminiResult, validationStatus: 'validated', validationSource: null };

    if (geminiResult.isAirstripDestination) {
      result.requiresCharter = true;
      result.validationSource = 'manual';
      return result;
    }

    const airHub = geminiResult.accessByMode?.air;
    if (airHub?.hubCode) {
      const cleanCode = airHub.hubCode.toUpperCase().trim();

      // 1. Check TravelDuqa support
      const inTravelDuqa = await travelDuqa.isAirportSupported(cleanCode);
      if (inTravelDuqa) {
        result.accessByMode.air.bookable = true;
        result.accessByMode.air.supplier = 'travelduqa';
        result.validationSource = 'travelduqa';
        return result;
      }

      // 2. Check Static List
      const inStaticList = STATIC_IATA_CODES.has(cleanCode);
      if (inStaticList) {
        result.accessByMode.air.bookable = false;
        result.validationSource = 'iata_list';
        return result;
      }

      // 3. Fallback: If it's a valid 3-letter code, trust it for Duffel routing
      if (/^[A-Z]{3}$/.test(cleanCode)) {
        result.accessByMode.air.bookable = true;
        result.accessByMode.air.supplier = 'duffel';
        result.validationSource = 'global_fallback_match';
        return result;
      }

      result.validationStatus = 'needs_clarification';
      return result;
    }

    return result;
  }

  // ─────────────────────────────────────────────
  // CACHE WRITE
  // ─────────────────────────────────────────────
  async _cacheResult(normalized, result) {
    const { error } = await supabase
      .from('destination_intel')
      .upsert({
        destination_name: normalized,
        destination_type: result.destinationType,
        access_by_mode: result.accessByMode,
        is_airstrip_destination: result.isAirstripDestination || false,
        airstrip_codes: result.airstripCodes || [],
        requires_charter: result.requiresCharter || false,
        resolved_by: 'gemini',
        validation_status: result.validationStatus,
        validation_source: result.validationSource,
        raw_gemini_response: result,
        last_validated_at: new Date().toISOString(),
      }, { onConflict: 'destination_name' });

    if (error) {
      logger.error('DestinationIntel: cache write failed', { error: error.message, destination: normalized });
    }
  }

  _toResultShape(row) {
    return {
      destination: row.destination_name,
      destinationType: row.destination_type,
      accessByMode: row.access_by_mode,
      isAirstripDestination: row.is_airstrip_destination,
      airstripCodes: row.airstrip_codes,
      requiresCharter: row.requires_charter,
      validationStatus: row.validation_status,
      validationSource: row.validation_source,
    };
  }
}

module.exports = new DestinationIntel();