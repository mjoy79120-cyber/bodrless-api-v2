/**
 * DESTINATION INTELLIGENCE LAYER
 * ─────────────────────────────────────────────
 * Resolves a free-text destination (e.g. "Watamu", "Diani",
 * "Maasai Mara") into structured per-mode access data:
 * nearest hub for air/train/bus, whether a transfer is
 * required, and whether that mode is actually bookable
 * in Bodrless today.
 *
 * Flow: Supabase cache (exact + alias + fuzzy) → Gemini
 * resolution (direct REST call, same pattern as
 * promptParser.js — NOT the @google/generative-ai SDK,
 * which hit a separate/zero quota bucket despite using
 * the same API key) → validation (TravelDuqa network,
 * then static IATA list, unless it's an airstrip
 * destination) → cache write.
 *
 * Bad Gemini answers that fail validation are NEVER cached
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

class DestinationIntel {

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
  // GROQ RESOLUTION (llama-3.1-8b-instant) — direct REST call,
  // strict JSON via response_format, per-mode shape. Switched
  // from Gemini due to persistent billing/quota issues that
  // blocked production use entirely despite a linked billing
  // account — same prompt and schema, only the transport layer
  // changed (endpoint, auth, response shape).
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
  // Airstrip destinations skip IATA validation entirely.
  // Standard air hubs: TravelDuqa network first, then
  // static IATA list as a softer fallback.
  // ─────────────────────────────────────────────
  async _validate(geminiResult) {
    const result = { ...geminiResult, validationStatus: 'validated', validationSource: null };

    if (geminiResult.isAirstripDestination) {
      result.requiresCharter = true;
      result.validationSource = 'manual'; // airstrips trusted as their own category, not IATA-checked
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
        result.accessByMode.air.bookable = false; // real airport, just not bookable via Bodrless yet
        result.validationSource = 'iata_list';
        return result;
      }

      // Gemini gave a hub code that's neither in TravelDuqa nor a real IATA list — don't trust it
      result.validationStatus = 'needs_clarification';
      return result;
    }

    // No air hub claimed at all (pure train/bus destination) — nothing to validate against IATA
    return result;
  }

  // ─────────────────────────────────────────────
  // CACHE WRITE — only validated/needs_clarification rows,
  // never silently overwrite a previously validated row
  // with a worse result.
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