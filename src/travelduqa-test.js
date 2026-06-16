process.env.TRAVELDUQA_ACCESS_TOKEN = 'travelduqa_test_54499e97a61e8dc5b687540a0121df1b9101e2c1ee47202ebee09a6c0f7ad94c88f50aaa875f593f93dffdb479b18685a12606807706';
process.env.TRAVELDUQA_API_VERSION = 'v1';

const adapter = require('./adapters/travelduqa');

async function test() {
  // Step 1 — Search
  console.log('\n🔍 Step 1: Searching flights...');
  const results = await adapter.search({
    origin:      'nairobi',
    destination: 'mombasa',
    date:        '2026-08-15',
    passengers:  1,
  });

  if (!results.length) return console.log('❌ No flights found');
  const flight = results[0];
  console.log(`✅ Found flight: ${flight.airline} ${flight.flightNumber} — KES ${flight.price}`);

  // Step 2 — Select offer
  console.log('\n🎯 Step 2: Selecting offer...');
  const selected = await adapter.selectOffer({
    resultId: flight.resultId,
    offerId:  flight.offerId,
  });
  console.log('✅ Offer selected:', selected?.airline, selected?.conditions);

  // Step 3 — Hold booking (safe for testing — no instant charge)
  console.log('\n📋 Step 3: Creating hold booking...');
  const booking = await adapter.book({
    resultId:    flight.resultId,
    offerId:     flight.offerId,
    totalAmount: flight.price,
    currency:    'KES',
    paymentType: 'hold',  // hold = safe test, won't deduct wallet yet
    sendEticket: false,
    passengers: [{
      firstName:   'Test',
      lastName:    'Bodrless',
      dateOfBirth: '1990-01-01',
      title:       'Mr',
      gender:      'male',
      type:        'adult',
      phone:       '0712345678',
      phoneCode:   '+254',
      email:       'test@bodrless.com',
    }],
  });

  console.log('✅ Booking created:', JSON.stringify(booking, null, 2));
}

test().catch(console.error);