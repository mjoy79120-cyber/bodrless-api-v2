/**
 * MOCK INVENTORY (USED FOR TESTING WITHOUT SUPPLIERS)
 * Simulates hotels, flights, buses, and transfers
 * for widget + WhatsApp orchestration testing
 */

module.exports = {
  hotels: [
    {
      id: "H1",
      name: "Nairobi Grand Hotel",
      location: "Nairobi",
      stars: 5,
      rating: 4.7,
      reviewCount: 3200,
      roomType: "Deluxe Room",
      amenities: ["WiFi", "Pool", "Breakfast"],
      pricePerNight: 180,
      cancellationPolicy: "Free cancellation"
    },

    {
      id: "H2",
      name: "Bangkok Riverside Hotel",
      location: "Bangkok",
      stars: 4,
      rating: 4.5,
      reviewCount: 2100,
      roomType: "Superior Room",
      amenities: ["WiFi", "Gym", "Spa"],
      pricePerNight: 140,
      cancellationPolicy: "Free cancellation"
    },

    {
      id: "H3",
      name: "Bangkok Grand Palace Hotel",
      location: "Bangkok",
      stars: 5,
      rating: 4.7,
      reviewCount: 3200,
      roomType: "Deluxe Room",
      amenities: ["WiFi", "Pool", "Breakfast", "Spa"],
      pricePerNight: 180,
      cancellationPolicy: "Free cancellation"
    },

    {
      id: "H4",
      name: "Siam Riverside Hotel",
      location: "Bangkok",
      stars: 4,
      rating: 4.4,
      reviewCount: 2100,
      roomType: "Superior Room",
      amenities: ["WiFi", "Breakfast"],
      pricePerNight: 120,
      cancellationPolicy: "Free cancellation"
    },

    {
      id: "H5",
      name: "Bangkok Budget Inn",
      location: "Bangkok",
      stars: 3,
      rating: 4.0,
      reviewCount: 900,
      roomType: "Standard Room",
      amenities: ["WiFi"],
      pricePerNight: 70,
      cancellationPolicy: "Non-refundable"
    }
  ],

  flights: [
    {
      id: "F1",
      type: "flight",
      provider: "Kenya Airways",
      airline: "Kenya Airways",
      flightNumber: "KQ 888",
      origin: "Nairobi",
      destination: "Bangkok",
      departureTime: "10:00",
      arrivalTime: "04:00",
      duration: "10h",
      price: 520
    }
  ],

  buses: [
    {
      id: "B1",
      type: "bus",
      provider: "EasyCoach",
      origin: "Nairobi",
      destination: "Mombasa",
      departureTime: "08:00",
      duration: "8h",
      price: 15
    }
  ],

  transfers: [
    {
      id: "T1",
      provider: "Bodrless Transfers",
      vehicleType: "SUV",
      pickupLocation: "Airport",
      dropoffLocation: "Hotel",
      price: 40
    },

    {
      id: "T2",
      provider: "City Transfers Co",
      vehicleType: "Private Car",
      pickupLocation: "Bangkok Airport",
      dropoffLocation: "Hotel",
      price: 30
    },

    {
      id: "T3",
      provider: "Luxury Ride",
      vehicleType: "SUV",
      pickupLocation: "Bangkok Airport",
      dropoffLocation: "Hotel",
      price: 50
    }
  ]
};
