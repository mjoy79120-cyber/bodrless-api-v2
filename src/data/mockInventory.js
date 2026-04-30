/**
 * MOCK INVENTORY (USED FOR TESTING WITHOUT SUPPLIERS)
 * This simulates real agencies uploading Excel / API feeds
 */

module.exports = {
  hotels: [
    {
      id: "H1",
      name: "Nairobi Grand Hotel",
      location: "Nairobi",
      stars: 5,
      rating: 4.7,
      pricePerNight: 180,
      amenities: ["WiFi", "Pool", "Breakfast"]
    },
    {
      id: "H2",
      name: "Bangkok Riverside Hotel",
      location: "Bangkok",
      stars: 4,
      rating: 4.5,
      pricePerNight: 140,
      amenities: ["WiFi", "Gym", "Spa"]
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
      price: 40
    }
  ]
};
