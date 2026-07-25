/**
 * HotelBeds Destination Code Lookup
 * Run this once to get the correct HotelBeds destination codes
 * for cities currently using wrong IATA codes in the adapter.
 *
 * Usage: node lookup-hotelbeds-codes.js
 */

const axios = require('axios');
const crypto = require('crypto');

const API_KEY    = process.env.HOTELBEDS_API_KEY;
const API_SECRET = process.env.HOTELBEDS_API_SECRET || process.env.HOTELBEDS_SECRET;
const BASE_URL   = process.env.HOTELBEDS_BASE_URL || 'https://api.test.hotelbeds.com';

function signature() {
  const ts   = Math.floor(Date.now() / 1000).toString();
  const hash = crypto.createHash('sha256').update(API_KEY + API_SECRET + ts).digest('hex');
  return hash;
}

function headers() {
  return {
    'Api-key':        API_KEY,
    'X-Signature':    signature(),
    'Accept':         'application/json',
    'Accept-Encoding': 'gzip',
  };
}

// Cities to look up — these are the ones most likely using wrong
// IATA codes instead of real HotelBeds destination codes
const CITIES_TO_CHECK = [
  'Nairobi',
  'Mombasa',
  'Zanzibar',
  'Dar es Salaam',
  'Kampala',
  'Kigali',
  'Addis Ababa',
  'Lusaka',
  'Harare',
  'Windhoek',
  'Johannesburg',
  'Cape Town',
  'Durban',
  'Lagos',
  'Accra',
  'Dakar',
  'Arusha',
  'Entebbe',
];

async function lookup(cityName) {
  try {
    const response = await axios.get(
      `${BASE_URL}/hotel-content-api/1.0/locations/destinations`,
      {
        headers: headers(),
        params: {
          fields:                'code,name,countryCode',
          language:              'ENG',
          from:                  1,
          to:                    5,
          useSecondaryLanguages: false,
          name:                  cityName,
        },
        timeout: 10000,
        decompress: true,
      }
    );

    const destinations = response.data?.data?.destinations || [];
    if (destinations.length === 0) {
      return { city: cityName, results: 'NO RESULTS' };
    }

    return {
      city: cityName,
      results: destinations.map(d => ({
        code:        d.code,
        name:        d.name?.content,
        country:     d.countryCode,
      })),
    };
  } catch (err) {
    return { city: cityName, error: err.response?.data || err.message };
  }
}

async function main() {
  if (!API_KEY || !API_SECRET) {
    console.error('Set HOTELBEDS_API_KEY and HOTELBEDS_API_SECRET env vars first');
    process.exit(1);
  }

  console.log('Looking up HotelBeds destination codes...\n');

  for (const city of CITIES_TO_CHECK) {
    const result = await lookup(city);
    console.log(`\n${result.city}:`);
    if (result.error)   console.log(`  ERROR: ${JSON.stringify(result.error)}`);
    if (result.results === 'NO RESULTS') console.log('  No results found');
    if (Array.isArray(result.results)) {
      result.results.forEach(r => {
        console.log(`  code=${r.code}  name="${r.name}"  country=${r.country}`);
      });
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }
}

main();