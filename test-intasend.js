// Standalone IntaSend test — run this directly with: node test-intasend.js
// Fill in your real keys below, run it, and share the exact output (the
// resp or err object) so we can see precisely what IntaSend says back.

const IntaSend = require('intasend-node');

const intasend = new IntaSend(
  'ISPubKey_live_159a80fc-7935-4e86-a23e-f279cf75d81d',
  'ISSecretKey_live_b03bde1e-1d02-4fbf-bb32-fce94368c481',
  false
);

const collection = intasend.collection();

collection
  .mpesaStkPush({
    first_name: 'Test',
    last_name: 'User',
    email: 'test@bodrless.app',
    host: 'https://bodrless-api-v2.onrender.com',
    amount: 10,
    phone_number: '254716098296',
    api_ref: 'isolated-test-' + Date.now(),
  })
  .then((resp) => {
    console.log('SUCCESS:', JSON.stringify(resp, null, 2));
  })
  .catch((err) => {
    console.error('ERROR MESSAGE:', err.message);
    console.error('ERROR RESPONSE DATA:', JSON.stringify(err.response?.data, null, 2));
    console.error('ERROR STATUS:', err.response?.status);
    console.error('FULL ERROR:', err);
  });