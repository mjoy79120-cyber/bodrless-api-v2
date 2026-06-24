/**
 * DESTINATION INTELLIGENCE LAYER
 * ─────────────────────────────────────────────
 * Resolves a free-text destination (e.g. "Watamu", "Diani",
 * "Maasai Mara") into structured per-mode access data.
 * ─────────────────────────────────────────────
 */

const axios = require('axios');
const supabase = require('../utils/supabase');
const travelDuqa = require('../adapters/travelduqa');
const { logger } = require('../utils/logger');
const STATIC_IATA_CODES = require('../data/staticIataList');

class DestinationIntel {

  // ─────────────────────────────────────────────
  // NEW UTILITY: Get strictly the Validated IATA Code
  // Use this in your flight search engine!
  // ─────────────────────────────────────────────
  async getValidAirHub(destinationName) {
    if (!destinationName) return null;
    const intel = await this.resolve(destinationName);
    
    // Only return the code if Gemini found it AND TravelDuqa validated it as bookable
    if (intel?.accessByMode?.air?.bookable && intel?.accessByMode?.air?.hubCode) {
      return intel.accessByMode.air.hubCode;
    }
    return null;
  }

  // ─────────────────────────────────────────────
  // PUBLIC: resolve a destination name
  // ─────────────────────────────────────────────
  async resolve(destinationName) {
    if (!destinationName) return null;
    const normalized = destinationName.toLowerCase().trim();

    const cached = await this._lookupCache(normalized);
    if (cached) return cached;

    logger.info('DestinationIntel: cache miss, resolving via Gemini', { destination: normalized });

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

    // fuzzy via pg_trgm similarity — catches typos without a fresh Gemini call
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
  // GEMINI RESOLUTION
  // ─────────────────────────────────────────────
  async _resolveViaGemini(destinationName) {
    const prompt = `You are a travel logistics expert for East Africa. For the destination "${destinationName}", return ONLY a JSON object, no markdown fences, no preamble, in exactly this shape:

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
- If the destination IS itself a major airport city (e.g. Nairobi, Mombasa), set directService true for air and transferRequired false.
- If the destination is reached via a nearby airport/station with a road transfer (e.g. Watamu via Malindi, Diani via Mombasa), set hubName/hubCode to that hub and transferRequired true.
- If a mode has no reasonable route (e.g. no rail line serves the area), set hubName null and directService false.
- For safari/wilderness destinations served by small aircraft (e.g. Maasai Mara), set isAirstripDestination true, list real named airstrips in airstripCodes, and leave air.hubCode null (airstrips are not standard IATA-validated codes).
- Real, geographically accurate East African transport facts only. Do not invent airport codes.`;

    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 800,
          },
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const content = response.data.candidates[0].content.parts[0].text;
      const cleaned = content.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned);
    } catch (err) {
      logger.error('DestinationIntel: Gemini resolution failed', { error: err.message, destination: destinationName });
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
      const inTravelDuqa = await travelDuqa.isAirportSupported(airHub.hubCode);
      if (inTravelDuqa) {
        result.accessByMode.air.bookable = true;
        result.accessByMode.air.supplier = 'travelduqa';
        result.validationSource = 'travelduqa';
        return result;
      }

      const inStaticList = STATIC_IATA_CODES.has(airHub.hubCode.toUpperCase());
      if (inStaticList) {
        result.accessByMode.air.bookable = false; 
        result.validationSource = 'iata_list';
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