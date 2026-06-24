// test-destinationIntel.js — local only, don't commit
process.env.SUPABASE_URL = 'https://jsmxdceatwbezobzzpat.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_5MJpjiSu4nGiT4hcjuXCNg_AZh1lwen'
process.env.GEMINI_API_KEY = 'AIzaSyBYtn8Na9Ue22g7rOzs9Qyr36AwOjFofCs'
process.env.TRAVELDUQA_ACCESS_TOKEN = 'travelduqa_test_54499e97a61e8dc5b687540a0121df1b9101e2c1ee47202ebee09a6c0f7ad94c88f50aaa875f593f93dffdb479b18685a12606807706'
process.env.TRAVELDUQA_API_VERSION = 'v1';

const { http } = require('winston');
const destinationIntel = require('./services/destinationIntel.js');

(async () => {
  console.log('--- Testing: watamu ---');
  const watamu = await destinationIntel.resolve('watamu');
  console.log(JSON.stringify(watamu, null, 2));

  console.log('--- Testing: diani ---');
  const diani = await destinationIntel.resolve('diani');
  console.log(JSON.stringify(diani, null, 2));

  console.log('--- Testing: maasai mara (airstrip case) ---');
  const mara = await destinationIntel.resolve('maasai mara');
  console.log(JSON.stringify(mara, null, 2));
})();