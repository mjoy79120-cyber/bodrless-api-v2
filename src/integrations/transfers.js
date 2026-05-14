const { logger } = require('../utils/logger');

class TransferService {

  _getMockTransfers({ destination, arrivalTime, hotelArea, passengers }) {
    logger.warn('Using mock transfer data');

    const dest = (destination || '').toLowerCase();

    const transferDB = {
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
      // ... keep the rest EXACTLY as you wrote it
    };

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
      return transferDB.zanzibar;
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
}

module.exports = new TransferService();
