_getMockFlights({ origin, destination, departureDate, passengers }) {
    logger.warn('Using mock flight data — configure AMADEUS_API_KEY for real results');

    const dep = departureDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Airline selection based on destination region
    const getAirlines = (dest = '') => {
      const d = dest.toLowerCase();
      if (['zanzibar','mombasa','diani','nairobi','kigali','kampala','dar','kilifi','amboseli','mara','naivasha'].some(x => d.includes(x)))
        return [{ code: 'KQ', name: 'Kenya Airways' }, { code: 'ET', name: 'Ethiopian Airlines' }, { code: 'WB', name: 'RwandAir' }];
      if (['cape town','johannesburg','victoria falls','livingstone','lusaka','harare'].some(x => d.includes(x)))
        return [{ code: 'KQ', name: 'Kenya Airways' }, { code: 'SA', name: 'South African Airways' }, { code: 'ET', name: 'Ethiopian Airlines' }];
      if (['lagos','accra','dakar','abidjan','douala'].some(x => d.includes(x)))
        return [{ code: 'ET', name: 'Ethiopian Airlines' }, { code: 'KQ', name: 'Kenya Airways' }, { code: 'AT', name: 'Royal Air Maroc' }];
      if (['dubai','abu dhabi','doha','riyadh','muscat'].some(x => d.includes(x)))
        return [{ code: 'EK', name: 'Emirates' }, { code: 'QR', name: 'Qatar Airways' }, { code: 'EY', name: 'Etihad Airways' }];
      if (['bangkok','bali','singapore','tokyo','mumbai','delhi','kuala lumpur'].some(x => d.includes(x)))
        return [{ code: 'EK', name: 'Emirates' }, { code: 'QR', name: 'Qatar Airways' }, { code: 'SQ', name: 'Singapore Airlines' }];
      if (['london','paris','amsterdam','barcelona','frankfurt','rome','istanbul'].some(x => d.includes(x)))
        return [{ code: 'KQ', name: 'Kenya Airways' }, { code: 'BA', name: 'British Airways' }, { code: 'KL', name: 'KLM' }];
      if (['new york','miami','toronto','cancun','los angeles'].some(x => d.includes(x)))
        return [{ code: 'EK', name: 'Emirates' }, { code: 'QR', name: 'Qatar Airways' }, { code: 'AA', name: 'American Airlines' }];
      if (['cairo','marrakech','casablanca','tunis','algiers'].some(x => d.includes(x)))
        return [{ code: 'MS', name: 'EgyptAir' }, { code: 'ET', name: 'Ethiopian Airlines' }, { code: 'AT', name: 'Royal Air Maroc' }];
      // Default
      return [{ code: 'KQ', name: 'Kenya Airways' }, { code: 'ET', name: 'Ethiopian Airlines' }, { code: 'EK', name: 'Emirates' }];
    };

    // Price based on destination region
    const getPrice = (dest = '') => {
      const d = dest.toLowerCase();
      if (['zanzibar','mombasa','diani','kigali','kampala','dar','kilifi'].some(x => d.includes(x))) return [150, 200, 280];
      if (['cape town','johannesburg','victoria falls'].some(x => d.includes(x))) return [350, 480, 650];
      if (['lagos','accra','dakar'].some(x => d.includes(x))) return [400, 550, 750];
      if (['dubai','doha','riyadh'].some(x => d.includes(x))) return [380, 520, 700];
      if (['bangkok','bali','singapore','kuala lumpur'].some(x => d.includes(x))) return [600, 800, 1100];
      if (['tokyo','seoul','beijing','shanghai'].some(x => d.includes(x))) return [800, 1100, 1500];
      if (['london','paris','amsterdam','barcelona'].some(x => d.includes(x))) return [700, 950, 1300];
      if (['new york','miami','toronto'].some(x => d.includes(x))) return [900, 1200, 1700];
      if (['cairo','marrakech','casablanca'].some(x => d.includes(x))) return [300, 420, 600];
      return [300, 500, 800];
    };

    // Duration based on region
    const getDuration = (dest = '') => {
      const d = dest.toLowerCase();
      if (['zanzibar','mombasa','diani','kigali','kampala','dar'].some(x => d.includes(x))) return ['PT1H30M', 'PT2H', 'PT2H30M'];
      if (['cape town','johannesburg'].some(x => d.includes(x))) return ['PT4H', 'PT5H', 'PT6H'];
      if (['lagos','accra'].some(x => d.includes(x))) return ['PT5H', 'PT6H', 'PT7H'];
      if (['dubai','doha'].some(x => d.includes(x))) return ['PT4H30M', 'PT5H', 'PT5H30M'];
      if (['bangkok','bali','singapore'].some(x => d.includes(x))) return ['PT9H', 'PT10H', 'PT11H'];
      if (['tokyo','seoul'].some(x => d.includes(x))) return ['PT13H', 'PT14H', 'PT15H'];
      if (['london','paris','amsterdam'].some(x => d.includes(x))) return ['PT8H', 'PT9H', 'PT10H'];
      if (['new york','miami'].some(x => d.includes(x))) return ['PT15H', 'PT16H', 'PT17H'];
      return ['PT4H', 'PT6H', 'PT8H'];
    };

    const airlines = getAirlines(destination);
    const prices = getPrice(destination);
    const durations = getDuration(destination);

    const addHours = (date, hours) => {
      const d = new Date(date);
      d.setHours(d.getHours() + hours);
      return d.toISOString();
    };

    return [
      {
        id: 'mock-flight-1',
        type: 'flight',
        provider: airlines[0].code,
        providerName: airlines[0].name,
        flightNumber: `${airlines[0].code}100`,
        origin,
        destination,
        departureTime: `${dep}T06:00:00`,
        arrivalTime: addHours(`${dep}T06:00:00`, 2),
        duration: durations[0],
        stops: 0,
        arrival: { airport: destination, terminal: '1', time: addHours(`${dep}T06:00:00`, 2) },
        baggage: { quantity: 1, weight: { value: 23, unit: 'KG' } },
        cancellationPolicy: 'Non-refundable',
        price: prices[0] * passengers,
        currency: 'USD',
      },
      {
        id: 'mock-flight-2',
        type: 'flight',
        provider: airlines[1].code,
        providerName: airlines[1].name,
        flightNumber: `${airlines[1].code}201`,
        origin,
        destination,
        departureTime: `${dep}T10:30:00`,
        arrivalTime: addHours(`${dep}T10:30:00`, 3),
        duration: durations[1],
        stops: 1,
        arrival: { airport: destination, terminal: '2', time: addHours(`${dep}T10:30:00`, 3) },
        baggage: { quantity: 1, weight: { value: 30, unit: 'KG' } },
        cancellationPolicy: 'Free cancellation 24h before departure',
        price: prices[1] * passengers,
        currency: 'USD',
      },
      {
        id: 'mock-flight-3',
        type: 'flight',
        provider: airlines[2].code,
        providerName: airlines[2].name,
        flightNumber: `${airlines[2].code}305`,
        origin,
        destination,
        departureTime: `${dep}T20:00:00`,
        arrivalTime: addHours(`${dep}T20:00:00`, 4),
        duration: durations[2],
        stops: 1,
        arrival: { airport: destination, terminal: '1', time: addHours(`${dep}T20:00:00`, 4) },
        baggage: { quantity: 2, weight: { value: 30, unit: 'KG' } },
        cancellationPolicy: 'Fully refundable',
        price: prices[2] * passengers,
        currency: 'USD',
      },
    ];
  }
