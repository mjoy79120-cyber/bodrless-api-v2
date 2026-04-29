const logger = require('../utils/logger'); // adjust if your logger export differs

const _getMockBuses = ({ origin, destination, departureDate, passengers = 1 }) => {
  logger.warn('Using mock bus data');

  const dep = departureDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const orig = (origin || '').toLowerCase();
  const dest = (destination || '').toLowerCase();

  const busRoutes = [
    { from: 'nairobi', to: 'mombasa', operators: ['Modern Coast', 'Mash East Africa', 'Tahmeed Express'], duration: '8-9 hours', prices: [1200, 1500, 2000], departure: ['07:00', '20:00', '21:00'], notes: 'Overnight buses popular. Book in advance during holidays.' },
    { from: 'nairobi', to: 'kisumu', operators: ['Easy Coach', 'Mash East Africa', 'Modern Coast'], duration: '6-7 hours', prices: [1000, 1200, 1500], departure: ['07:00', '08:00', '21:00'], notes: 'Via Nakuru or Kericho.' },
    { from: 'nairobi', to: 'kampala', operators: ['Modern Coast', 'Buscar', 'Mash East Africa'], duration: '10-12 hours', prices: [2000, 2500, 3000], departure: ['07:00', '19:00', '20:00'], notes: 'Cross-border route. Carry passport.' },
    { from: 'nairobi', to: 'dar es salaam', operators: ['Modern Coast', 'Dar Express'], duration: '14-16 hours', prices: [3000, 3500, 4000], departure: ['06:00', '19:00'], notes: 'Long overnight route. Book early.' },
    { from: 'nairobi', to: 'arusha', operators: ['Riverside Shuttle', 'Impala Shuttle', 'Kilimanjaro Express'], duration: '5-6 hours', prices: [2000, 2500, 3000], departure: ['07:00', '08:00', '14:00'], notes: 'Shuttle services available. Comfortable.' },
    { from: 'mombasa', to: 'dar es salaam', operators: ['Dar Express', 'Modern Coast'], duration: '10-12 hours', prices: [2500, 3000], departure: ['06:00', '20:00'], notes: 'Cross-border route. Carry passport.' },

    { from: 'kampala', to: 'kigali', operators: ['Jaguar Executive Coaches', 'Trinity Express', 'Volcano Express'], duration: '8-9 hours', prices: [25, 35, 45], departure: ['07:00', '08:00', '20:00'], notes: 'USD prices. Scenic route via Kabale.' },
    { from: 'dar es salaam', to: 'kampala', operators: ['Modern Coast', 'Dar Express'], duration: '20-24 hours', prices: [35, 45], departure: ['06:00', '17:00'], notes: 'Long route. Overnight journey.' },
    { from: 'arusha', to: 'nairobi', operators: ['Riverside Shuttle', 'Impala Shuttle', 'Bobby Shuttle'], duration: '5-6 hours', prices: [2000, 2500, 3000], departure: ['06:00', '07:00', '12:00'], notes: 'Popular tourist shuttle.' },
    { from: 'nairobi', to: 'kigali', operators: ['Modern Coast', 'Buscar'], duration: '16-18 hours', prices: [3500, 4000], departure: ['07:00', '19:00'], notes: 'Via Uganda. Long overnight journey.' },

    { from: 'johannesburg', to: 'cape town', operators: ['Intercape', 'Greyhound', 'FlixBus'], duration: '24 hours', prices: [15, 25, 35], departure: ['08:00', '16:00', '18:00'], notes: 'USD prices. Very long route. Flight recommended.' },
    { from: 'johannesburg', to: 'livingstone', operators: ['Intercape'], duration: '20-22 hours', prices: [35, 45], departure: ['08:00'], notes: 'To Livingstone for Victoria Falls.' },
    { from: 'livingstone', to: 'johannesburg', operators: ['Intercape'], duration: '20-22 hours', prices: [35, 45], departure: ['12:00'], notes: 'Return from Victoria Falls.' },

    { from: 'accra', to: 'lagos', operators: ['STC', 'ABC Transport'], duration: '8-10 hours', prices: [20, 30], departure: ['06:00', '08:00'], notes: 'Cross-border route. Carry passport.' },
    { from: 'lagos', to: 'accra', operators: ['ABC Transport', 'STC'], duration: '8-10 hours', prices: [20, 30], departure: ['06:00', '07:00'], notes: 'Via Togo and Benin borders.' },

    { from: 'london', to: 'paris', operators: ['FlixBus', 'Eurolines', 'National Express'], duration: '8-9 hours', prices: [15, 25, 35], departure: ['07:00', '10:00', '22:00'], notes: 'Via Eurotunnel. Train (Eurostar) is faster.' },
    { from: 'barcelona', to: 'amsterdam', operators: ['FlixBus', 'Eurolines'], duration: '18-20 hours', prices: [30, 50], departure: ['08:00', '20:00'], notes: 'Long bus journey. Flight recommended.' },
    { from: 'amsterdam', to: 'paris', operators: ['FlixBus', 'Eurolines'], duration: '5-6 hours', prices: [10, 20], departure: ['07:00', '10:00', '15:00'], notes: 'Regular service. Train (Thalys) is faster.' },

    { from: 'bangkok', to: 'chiang mai', operators: ['Nakhon Chai Air', 'Sombat Tour', 'Green Bus'], duration: '8-9 hours', prices: [8, 12, 18], departure: ['07:00', '19:00', '20:00'], notes: 'USD prices. Night bus popular.' },
    { from: 'bali', to: 'lombok', operators: ['Perama Tour', 'Kura Kura Bus'], duration: '4-5 hours', prices: [10, 15], departure: ['08:00', '13:00'], notes: 'Includes ferry crossing.' },
    { from: 'singapore', to: 'kuala lumpur', operators: ['Aeroline', 'FirstCoach', 'Nice'], duration: '4-5 hours', prices: [15, 25, 35], departure: ['08:00', '10:00', '14:00'], notes: 'Popular route. Very comfortable coaches.' },
  ];

  const findRoute = (orig, dest) => {
    return busRoutes.find(route =>
      (orig.includes(route.from) || route.from.includes(orig.split(' ')[0])) &&
      (dest.includes(route.to) || route.to.includes(dest.split(' ')[0]))
    ) || busRoutes.find(route =>
      dest.includes(route.to) || route.to.includes(dest.split(' ')[0])
    );
  };

  const route = findRoute(orig, dest);

  if (!route) {
    return [{
      id: 'mock-bus-1',
      type: 'bus',
      operator: 'Regional Coach Service',
      origin,
      destination,
      departureDate: dep,
      departureTime: '07:00',
      arrivalTime: '15:00',
      duration: '8 hours',
      stops: 2,
      passengers,
      amenities: ['Air Conditioning', 'Reclining Seats'],
      cancellationPolicy: 'Non-refundable',
      price: 25 * passengers,
      currency: 'USD',
      notes: 'Bus service available. Check local operators for schedules.',
      available: true,
    }];
  }

  return route.operators.slice(0, 3).map((operator, index) => ({
    id: `mock-bus-${index + 1}`,
    type: 'bus',
    operator,
    origin,
    destination,
    departureDate: dep,
    departureTime: route.departure[index] || route.departure[0],
    arrivalTime: '-- arrives next day --',
    duration: route.duration,
    stops: index === 0 ? 0 : index,
    passengers,
    amenities: index === 2
      ? ['Air Conditioning', 'Reclining Seats', 'WiFi', 'USB Charging', 'Meals']
      : ['Air Conditioning', 'Reclining Seats'],
    cancellationPolicy: index === 2 ? 'Free cancellation 24h before' : 'Non-refundable',
    price: (typeof route.prices[index] === 'number' ? route.prices[index] : route.prices[0]) * passengers,
    currency: 'USD',
    notes: route.notes,
    available: true,
  }));
};

module.exports = { _getMockBuses };
