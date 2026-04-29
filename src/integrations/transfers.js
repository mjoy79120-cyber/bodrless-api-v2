/**
 * TRANSFERS MOCK DATA
 * Replace _getMockTransfers method in src/integrations/transfers.js
 */
 
_getMockTransfers({ destination, arrivalTime, hotelArea, passengers }) {
    logger.warn('Using mock transfer data');
 
    const dest = (destination || '').toLowerCase();
 
    const transferDB = {
      // EAST AFRICA
      zanzibar: [
        { type: 'Shared Taxi', duration: '45 minutes', cost: 10, notes: 'Shared with other travelers. Cheaper option.' },
        { type: 'Private Taxi', duration: '40 minutes', cost: 25, notes: 'Private car. Comfortable and direct.' },
        { type: 'Hotel Shuttle', duration: '50 minutes', cost: 0, notes: 'Free shuttle for most beach resorts. Confirm with hotel.' },
      ],
      mombasa: [
        { type: 'Taxi', duration: '30 minutes', cost: 15, notes: 'From Moi International Airport to hotel.' },
        { type: 'Uber', duration: '30 minutes', cost: 10, notes: 'Uber available in Mombasa. Book from app.' },
        { type: 'Hotel Shuttle', duration: '35 minutes', cost: 0, notes: 'Most hotels offer free airport pickup. Confirm in advance.' },
      ],
      diani: [
        { type: 'Taxi from Ukunda', duration: '15 minutes', cost: 10, notes: 'Ukunda airstrip is 10 minutes from most Diani hotels.' },
        { type: 'Taxi from Mombasa Airport', duration: '90 minutes', cost: 40, notes: 'Via Likoni Ferry. Ferry is free.' },
        { type: 'Hotel Shuttle', duration: '20 minutes', cost: 0, notes: 'Most Diani hotels offer free pickup from Ukunda airstrip.' },
      ],
      masai_mara: [
        { type: 'Lodge Vehicle', duration: '30 minutes', cost: 0, notes: 'Lodge sends vehicle to airstrip. Included in stay.' },
        { type: 'Shared Transfer', duration: '45 minutes', cost: 30, notes: 'Shared with other lodge guests from airstrip.' },
      ],
      kigali: [
        { type: 'Private Taxi', duration: '30 minutes', cost: 20, notes: 'From Kigali International Airport.' },
        { type: 'Hotel Shuttle', duration: '35 minutes', cost: 0, notes: 'Most hotels offer airport pickup.' },
        { type: 'Tap&Go Bus', duration: '45 minutes', cost: 2, notes: 'Public bus available. Cheapest option.' },
      ],
      kampala: [
        { type: 'Private Taxi', duration: '45 minutes', cost: 40, notes: 'From Entebbe Airport to Kampala. Negotiate price.' },
        { type: 'Special Hire', duration: '45 minutes', cost: 35, notes: 'Pre-booked taxi. More reliable.' },
        { type: 'Uber', duration: '50 minutes', cost: 30, notes: 'Uber available from Entebbe Airport.' },
      ],
      dar_es_salaam: [
        { type: 'Taxi', duration: '30 minutes', cost: 25, notes: 'From Julius Nyerere International Airport.' },
        { type: 'Dala Dala', duration: '45 minutes', cost: 1, notes: 'Public minibus. Very cheap. Can be crowded.' },
        { type: 'Hotel Shuttle', duration: '35 minutes', cost: 0, notes: 'Available for most hotels. Confirm in advance.' },
      ],
 
      // SOUTHERN AFRICA
      cape_town: [
        { type: 'MyCiTi Bus', duration: '45 minutes', cost: 5, notes: 'Public bus from airport to City Bowl.' },
        { type: 'Uber', duration: '30 minutes', cost: 25, notes: 'Uber widely available. Reliable.' },
        { type: 'Private Transfer', duration: '30 minutes', cost: 40, notes: 'Pre-booked private car. Most comfortable.' },
      ],
      johannesburg: [
        { type: 'Gautrain', duration: '40 minutes', cost: 8, notes: 'Train from OR Tambo to Sandton. Clean and fast.' },
        { type: 'Uber', duration: '40 minutes', cost: 25, notes: 'Uber widely available.' },
        { type: 'Private Transfer', duration: '35 minutes', cost: 50, notes: 'Pre-booked private car.' },
      ],
      victoria_falls: [
        { type: 'Hotel Transfer', duration: '15 minutes', cost: 20, notes: 'Most lodges provide airport transfers.' },
        { type: 'Taxi', duration: '15 minutes', cost: 15, notes: 'Short ride from airport to falls area.' },
      ],
 
      // MIDDLE EAST
      dubai: [
        { type: 'Dubai Metro', duration: '45 minutes', cost: 3, notes: 'Red line from airport to City Centre.' },
        { type: 'Uber', duration: '40 minutes', cost: 20, notes: 'Uber widely available.' },
        { type: 'Private Transfer', duration: '35 minutes', cost: 35, notes: 'Pre-booked luxury car.' },
        { type: 'Taxi', duration: '40 minutes', cost: 25, notes: 'Official Dubai taxis from airport.' },
      ],
 
      // ASIA
      bangkok: [
        { type: 'Airport Rail Link', duration: '30 minutes', cost: 5, notes: 'Train to Phaya Thai then BTS Skytrain.' },
        { type: 'Taxi', duration: '45 minutes', cost: 15, notes: 'Metered taxi from airport.' },
        { type: 'Private Transfer', duration: '40 minutes', cost: 30, notes: 'Pre-booked private car.' },
        { type: 'Grab', duration: '45 minutes', cost: 12, notes: 'Southeast Asian ride-hailing app.' },
      ],
      bali: [
        { type: 'Taxi', duration: '30 minutes', cost: 10, notes: 'From Ngurah Rai Airport. Bluebird Taxi recommended.' },
        { type: 'Grab', duration: '30 minutes', cost: 8, notes: 'Grab available but must book outside airport.' },
        { type: 'Hotel Transfer', duration: '35 minutes', cost: 20, notes: 'Pre-booked hotel car. More comfortable.' },
      ],
      tokyo: [
        { type: 'Narita Express', duration: '60 minutes', cost: 30, notes: 'Train from Narita to Tokyo Station.' },
        { type: 'Airport Limousine Bus', duration: '90 minutes', cost: 20, notes: 'Bus to major hotels. Comfortable.' },
        { type: 'Taxi', duration: '90 minutes', cost: 150, notes: 'Very expensive. Avoid unless necessary.' },
      ],
      singapore: [
        { type: 'MRT', duration: '30 minutes', cost: 2, notes: 'East-West line from Changi to City Hall.' },
        { type: 'Grab', duration: '25 minutes', cost: 15, notes: 'Grab widely available.' },
        { type: 'Taxi', duration: '25 minutes', cost: 20, notes: 'Taxis from official stands at airport.' },
      ],
 
      // EUROPE
      london: [
        { type: 'Heathrow Express', duration: '15 minutes', cost: 35, notes: 'Fastest train to Paddington Station.' },
        { type: 'Elizabeth Line', duration: '40 minutes', cost: 12, notes: 'Cheaper train option to central London.' },
        { type: 'Uber', duration: '45 minutes', cost: 60, notes: 'Traffic can make this slow and expensive.' },
        { type: 'National Express Coach', duration: '60 minutes', cost: 10, notes: 'Cheapest but slowest option.' },
      ],
      paris: [
        { type: 'RER B Train', duration: '45 minutes', cost: 12, notes: 'From CDG to Paris city centre.' },
        { type: 'Taxi', duration: '45 minutes', cost: 55, notes: 'Fixed fare from CDG to Paris.' },
        { type: 'Uber', duration: '45 minutes', cost: 45, notes: 'Uber available from CDG.' },
      ],
      amsterdam: [
        { type: 'Sprinter Train', duration: '15 minutes', cost: 5, notes: 'Direct train from Schiphol to Amsterdam Centraal.' },
        { type: 'Taxi', duration: '25 minutes', cost: 40, notes: 'Taxis from official stands.' },
        { type: 'Uber', duration: '25 minutes', cost: 35, notes: 'Uber available.' },
      ],
      barcelona: [
        { type: 'Aerobus', duration: '35 minutes', cost: 6, notes: 'Direct bus to Plaça Catalunya.' },
        { type: 'Metro', duration: '45 minutes', cost: 5, notes: 'L9 Sud line to city centre.' },
        { type: 'Taxi', duration: '30 minutes', cost: 35, notes: 'Fixed price from airport.' },
      ],
      istanbul: [
        { type: 'Havaist Bus', duration: '45 minutes', cost: 5, notes: 'Bus from Istanbul Airport to city centre.' },
        { type: 'Taxi', duration: '40 minutes', cost: 25, notes: 'Taxis from official stands.' },
        { type: 'Uber', duration: '40 minutes', cost: 20, notes: 'Uber available in Istanbul.' },
      ],
 
      // AMERICAS
      new_york: [
        { type: 'AirTrain + Subway', duration: '60 minutes', cost: 10, notes: 'Cheapest option. AirTrain to Jamaica then E train.' },
        { type: 'Uber', duration: '45 minutes', cost: 60, notes: 'Surge pricing common. Can be expensive.' },
        { type: 'Private Transfer', duration: '45 minutes', cost: 80, notes: 'Pre-booked black car. Most comfortable.' },
      ],
      miami: [
        { type: 'Miami Metrorail', duration: '40 minutes', cost: 5, notes: 'Train to downtown Miami.' },
        { type: 'Uber', duration: '30 minutes', cost: 25, notes: 'Uber widely available.' },
        { type: 'Taxi', duration: '30 minutes', cost: 35, notes: 'Taxis from official stands.' },
      ],
      cancun: [
        { type: 'ADO Bus', duration: '30 minutes', cost: 8, notes: 'Bus to Hotel Zone or downtown.' },
        { type: 'Shared Shuttle', duration: '25 minutes', cost: 12, notes: 'Shared van to Hotel Zone.' },
        { type: 'Private Transfer', duration: '20 minutes', cost: 25, notes: 'Pre-booked private car.' },
      ],
    };
 
    // Match destination
    const matchDest = (dest) => {
      if (dest.includes('zanzibar')) return transferDB.zanzibar;
      if (dest.includes('mombasa')) return transferDB.mombasa;
      if (dest.includes('diani')) return transferDB.diani;
      if (dest.includes('mara') || dest.includes('masai')) return transferDB.masai_mara;
      if (dest.includes('kigali') || dest.includes('rwanda')) return transferDB.kigali;
      if (dest.includes('kampala') || dest.includes('uganda')) return transferDB.kampala;
      if (dest.includes('dar')) return transferDB.dar_es_salaam;
      if (dest.includes('cape town')) return transferDB.cape_town;
      if (dest.includes('johannesburg') || dest.includes('joburg')) return transferDB.johannesburg;
      if (dest.includes('victoria falls') || dest.includes('livingstone')) return transferDB.victoria_falls;
      if (dest.includes('dubai')) return transferDB.dubai;
      if (dest.includes('bangkok') || dest.includes('thailand')) return transferDB.bangkok;
      if (dest.includes('bali') || dest.includes('indonesia')) return transferDB.bali;
      if (dest.includes('tokyo') || dest.includes('japan')) return transferDB.tokyo;
      if (dest.includes('singapore')) return transferDB.singapore;
      if (dest.includes('london') || dest.includes('uk')) return transferDB.london;
      if (dest.includes('paris') || dest.includes('france')) return transferDB.paris;
      if (dest.includes('amsterdam') || dest.includes('netherlands')) return transferDB.amsterdam;
      if (dest.includes('barcelona') || dest.includes('spain')) return transferDB.barcelona;
      if (dest.includes('istanbul') || dest.includes('turkey')) return transferDB.istanbul;
      if (dest.includes('new york') || dest.includes('nyc')) return transferDB.new_york;
      if (dest.includes('miami')) return transferDB.miami;
      if (dest.includes('cancun') || dest.includes('mexico')) return transferDB.cancun;
      return transferDB.zanzibar; // Default
    };
 
    const transfers = matchDest(dest);
 
    return transfers.slice(0, 3).map((transfer, index) => ({
      id: `mock-transfer-${index + 1}`,
      type: 'transfer',
      transferType: transfer.type,
      origin: `${destination} Airport`,
      destination: hotelArea || destination,
      duration: transfer.duration,
      passengers,
      cost: transfer.cost * passengers,
      costPerPerson: transfer.cost,
      currency: 'USD',
      notes: transfer.notes,
      bookingRequired: index === 2,
    }));
  }
