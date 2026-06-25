process.env.GEMINI_API_KEY = 'AQ.Ab8RN6Ic_mKYxCfiQU2s-iRttZEX2I2LHeuXTSnH-ulLWDLN7A'

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