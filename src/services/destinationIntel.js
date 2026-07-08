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
// STATIC CORRIDOR OVERRIDES
// ─────────────────────────────────────────────
const STATIC_DESTINATION_OVERRIDES = {
  kilifi: {
    destination: 'kilifi',
    destinationType: 'town',
    isAirstripDestination: false,
    airstripCodes: [],
    accessByMode: {
      air: {
        hubName: 'malindi', hubCode: 'MYD',
        directService: false, transferRequired: true, transferDistanceKm: 60,
      },
      train: {
        hubName: 'mombasa', hubCode: null,
        directService: false, transferRequired: true, transferDistanceKm: 60,
      },
      bus: {
        hubName: null, hubCode: null,
        directService: true, transferRequired: false, transferDistanceKm: null,
        searchAs: 'malindi',
      },
    },
  },
  watamu: {
    destination: 'watamu',
    destinationType: 'town',
    isAirstripDestination: false,
    airstripCodes: [],
    accessByMode: {
      air: {
        hubName: 'malindi', hubCode: 'MYD',
        directService: false, transferRequired: true, transferDistanceKm: 25,
      },
      train: {
        hubName: 'mombasa', hubCode: null,
        directService: false, transferRequired: true, transferDistanceKm: 100,
      },
      bus: {
        hubName: null, hubCode: null,
        directService: true, transferRequired: false, transferDistanceKm: null,
        searchAs: 'malindi',
      },
    },
  },
  diani: {
    destination: 'diani',
    destinationType: 'town',
    isAirstripDestination: false,
    airstripCodes: [],
    accessByMode: {
      air: {
        hubName: 'diani', hubCode: 'UKA',
        directService: true, transferRequired: false, transferDistanceKm: null,
      },
      train: {
        hubName: 'mombasa', hubCode: null,
        directService: false, transferRequired: true, transferDistanceKm: 35,
      },
      bus: {
        hubName: 'mombasa', hubCode: null,
        directService: false, transferRequired: true, transferDistanceKm: 35,
      },
    },
  },
};

STATIC_DESTINATION_OVERRIDES['diani beach'] = STATIC_DESTINATION_OVERRIDES['diani'];
STATIC_DESTINATION_OVERRIDES['ukunda']      = STATIC_DESTINATION_OVERRIDES['diani'];

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
      return JSON.parse(content);
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

      // 3. Fallback: If it's a valid 3-letter code, trust it for concurrent/Duffel routing
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