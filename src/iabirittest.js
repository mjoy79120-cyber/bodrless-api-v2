require('dotenv').config({ path: '../.env' });
const axios = require('axios');

async function test() {
  const apiKey = process.env.IABIRI_API_KEY;
  console.log('🔑 API Key loaded:', apiKey ? `${apiKey.substring(0, 8)}...` : 'MISSING');

  console.log('🔍 Calling filterBuses directly...');

  try {
    const response = await axios.post(
      'http://bossapi.99synergy.com/globalApi/Trips/filterBuses',
      {
        source_city_id: '1',
        destination_city_id: '114',
        travel_date: '2025-07-15',
        avg_rating: null,
        departure_time: 'asc',
        fare: null,
        seat_type: '',
        travels: '',
        boarding_points: [],
        dropping_points: [],
        bus_with_amenities: [],
        high_rating: false,
        bus_with_live_tracking: false,
        cabs: false,
        hot_deals: false,
        on_time: false,
        bus_type: [],
        time_range: [],
        record_type: 'data',
        currencyId: '1',
        company_id: [],
        delayBus: true,
        sourcetype: 'web',
      },
      {
        headers: {
          'authorization': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 12000,
      }
    );

    console.log('✅ Status:', response.status);
    console.log('📦 Raw response:', JSON.stringify(response.data, null, 2));

  } catch (err) {
    console.log('❌ Error:', err.message);
    if (err.response) {
      console.log('Response status:', err.response.status);
      console.log('Response data:', err.response.data);
    }
  }
}

test().catch(console.error);