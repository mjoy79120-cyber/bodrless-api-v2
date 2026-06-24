// test-gemini-raw.js — place in src/ (same folder as test-destinationIntel.js)
process.env.GEMINI_API_KEY = 'AIzaSyBYtn8Na9Ue22g7rOzs9Qyr36AwOjFofCs'

const axios = require('axios');

(async () => {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: 'say hello' }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    console.log('SUCCESS:', response.data);
  } catch (err) {
    console.log('STATUS:', err.response?.status);
    console.log('BODY:', JSON.stringify(err.response?.data, null, 2));
  }
})();