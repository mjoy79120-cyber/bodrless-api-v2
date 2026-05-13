// src/data/mockInventory.js

const hotels = [
  {
    id: 'htl_1',
    name: 'Bangkok Grand Palace Hotel',
    location: 'Bangkok',
    stars: 5,
    rating: 4.7,
    reviewCount: 3200,
    roomType: 'Deluxe Room',
    amenities: ['WiFi', 'Pool', 'Breakfast', 'Spa'],
    pricePerNight: 180,
    cancellationPolicy: 'Free cancellation',
  },
  {
    id: 'htl_2',
    name: 'Siam Riverside Hotel',
    location: 'Bangkok',
    stars: 4,
    rating: 4.4,
    reviewCount: 2100,
    roomType: 'Superior Room',
    amenities: ['WiFi', 'Breakfast'],
    pricePerNight: 120,
    cancellationPolicy: 'Free cancellation',
  },
  {
    id: 'htl_3',
    name: 'Bangkok Budget Inn',
    location: 'Bangkok',
    stars: 3,
    rating: 4.0,
    reviewCount: 900,
    roomType: 'Standard Room',
    amenities: ['WiFi'],
    pricePerNight: 70,
    cancellationPolicy: 'Non-refundable',
  }
];

const transfers = [
  {
    id: 'tr_1',
    provider: 'City Transfers Co',
    vehicleType: 'Private Car',
    pickupLocation: 'Bangkok Airport',
    dropoffLocation: 'Hotel',
    price: 30,
  },
  {
    id: 'tr_2',
    provider: 'Luxury Ride',
    vehicleType: 'SUV',
    pickupLocation: 'Bangkok Airport',
    dropoffLocation: 'Hotel',
    price: 50,
  }
];

module.exports = {
  hotels,
  transfers,
};
