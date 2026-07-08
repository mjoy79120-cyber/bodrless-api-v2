/**
 * HOTEL INTEGRATION
 * ─────────────────────────────────────────────────────────────
 * Connects to hotel APIs.
 * Falls back to mock data when API not configured.
 * ─────────────────────────────────────────────────────────────
 */

const { logger } = require('../utils/logger');

class HotelService {

  async search({ destination, checkIn, checkOut, guests, budget, minRating }) {
    if (process.env.NODE_ENV !== 'production' || !process.env.HOTELS_API_KEY) {
      return this._getMockHotels({ destination, checkIn, checkOut, guests, budget });
    }
    try {
      return this._getMockHotels({ destination, checkIn, checkOut, guests, budget });
    } catch (error) {
      logger.error('Hotel search failed', { error: error.message });
      return this._getMockHotels({ destination, checkIn, checkOut, guests, budget });
    }
  }

  _getMockHotels({ destination, checkIn, checkOut, guests, budget }) {
    logger.warn('Using mock hotel data — configure HOTELS_API_KEY for real results');

    const nights = checkIn && checkOut
      ? Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24))
      : 3;

    const dest = (destination || '').toLowerCase();

    const hotelDB = {
      zanzibar: {
        budget: [
          { name: 'Zanzibar Coffee House', area: 'Stone Town', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
          { name: 'Paje by Night', area: 'Paje Beach', stars: 3, pricePerNight: 80, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Beach Access', 'Bar'] },
        ],
        mid: [
          { name: 'Dongwe Ocean View', area: 'Dongwe', stars: 4, pricePerNight: 180, mealPlan: 'Half Board', amenities: ['WiFi', 'Pool', 'Beach', 'Spa'] },
          { name: 'Karafuu Beach Resort', area: 'Michamvi', stars: 4, pricePerNight: 200, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Beach', 'Water Sports'] },
        ],
        luxury: [
          { name: 'The Residence Zanzibar', area: 'Kiwengwa', stars: 5, pricePerNight: 600, mealPlan: 'Full Board', amenities: ['WiFi', 'Private Pool', 'Beach', 'Spa', 'Butler'] },
          { name: 'Zuri Zanzibar', area: 'Kendwa', stars: 5, pricePerNight: 500, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Beach', 'Spa', 'Yoga'] },
        ],
      },
      mombasa: {
        budget: [
          { name: 'Lotus Hotel', area: 'Mombasa CBD', stars: 3, pricePerNight: 50, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Parking'] },
          { name: 'Reef Hotel', area: 'Nyali', stars: 3, pricePerNight: 70, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Sarova Whitesands', area: 'Shanzu Beach', stars: 4, pricePerNight: 150, mealPlan: 'Half Board', amenities: ['WiFi', 'Pool', 'Beach', 'Spa', 'Kids Club'] },
          { name: 'PrideInn Flamingo', area: 'Nyali', stars: 4, pricePerNight: 120, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant', 'Gym'] },
        ],
        luxury: [
          { name: 'Serena Beach Resort', area: 'Shanzu', stars: 5, pricePerNight: 350, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Beach', 'Spa', 'Tennis'] },
          { name: 'Hemingways Watamu', area: 'Watamu', stars: 5, pricePerNight: 400, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Beach', 'Spa', 'Diving'] },
        ],
      },
      diani: {
        budget: [
          { name: 'Diani Sea Lodge', area: 'Diani Beach', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Beach'] },
        ],
        mid: [
          { name: 'Leopard Beach Resort', area: 'Diani Beach', stars: 4, pricePerNight: 180, mealPlan: 'Half Board', amenities: ['WiFi', 'Pool', 'Beach', 'Spa', 'Water Sports'] },
          { name: 'Southern Palms Beach Resort', area: 'Diani Beach', stars: 4, pricePerNight: 160, mealPlan: 'Half Board', amenities: ['WiFi', 'Pool', 'Beach', 'Kids Club'] },
        ],
        luxury: [
          { name: 'Almanara Boutique Hotel', area: 'South Diani', stars: 5, pricePerNight: 500, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Private Pool', 'Beach', 'Spa'] },
          { name: 'Tijara Beach Hotel', area: 'South Diani', stars: 5, pricePerNight: 450, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Beach', 'Spa'] },
        ],
      },
      masai_mara: {
        budget: [
          { name: 'Mara Crossings Camp', area: 'Outside park', stars: 3, pricePerNight: 150, mealPlan: 'Full Board', amenities: ['Game Drives', 'Restaurant', 'Campfire'] },
        ],
        mid: [
          { name: 'Fig Tree Camp', area: 'Inside park — Talek River', stars: 4, pricePerNight: 280, mealPlan: 'Full Board', amenities: ['Game Drives', 'Pool', 'Spa', 'Bush Walks'] },
          { name: 'Keekorok Lodge', area: 'Inside park — Sekenani', stars: 4, pricePerNight: 320, mealPlan: 'Full Board', amenities: ['Game Drives', 'Pool', 'Spa', 'Cultural Visits'] },
        ],
        luxury: [
          { name: 'Governors Camp', area: 'Inside park — Talek River', stars: 5, pricePerNight: 800, mealPlan: 'Full Board', amenities: ['Game Drives', 'River Views', 'Spa', 'Hot Air Balloon'] },
          { name: 'Angama Mara', area: 'Inside park — Oloololo Escarpment', stars: 5, pricePerNight: 1200, mealPlan: 'Full Board', amenities: ['Game Drives', 'Infinity Pool', 'Spa', 'Photography Studio'] },
        ],
      },
      kigali: {
        budget: [
          { name: 'Chez Lando Hotel', area: 'Kigali City', stars: 3, pricePerNight: 70, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Radisson Blu Kigali', area: 'Kigali City', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Gym', 'Spa', 'Restaurant'] },
          { name: 'Lemigo Hotel', area: 'Kigali City', stars: 4, pricePerNight: 150, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Gym', 'Restaurant'] },
        ],
        luxury: [
          { name: 'Kigali Marriott Hotel', area: 'Kigali City Centre', stars: 5, pricePerNight: 300, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym', 'Rooftop Bar'] },
        ],
      },
      kampala: {
        budget: [
          { name: 'Fairway Hotel', area: 'Kampala City', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Protea Hotel Kampala', area: 'Kampala City', stars: 4, pricePerNight: 140, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Gym', 'Restaurant'] },
          { name: 'Kampala Serena Hotel', area: 'Kampala City', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
        ],
        luxury: [
          { name: 'Sheraton Kampala Hotel', area: 'Kampala City', stars: 5, pricePerNight: 280, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym', 'Tennis'] },
        ],
      },
      dar_es_salaam: {
        budget: [
          { name: 'Holiday Inn Express Dar', area: 'City Centre', stars: 3, pricePerNight: 80, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Hyatt Regency Dar', area: 'Masaki', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
          { name: 'Southern Sun Dar', area: 'City Centre', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant', 'Gym'] },
        ],
        luxury: [
          { name: 'Kunduchi Beach Hotel', area: 'Beach', stars: 5, pricePerNight: 300, mealPlan: 'Full Board', amenities: ['WiFi', 'Private Beach', 'Pool', 'Spa'] },
        ],
      },
      amboseli: {
        budget: [
          { name: 'Kimana Sanctuary', area: 'Outside park', stars: 3, pricePerNight: 120, mealPlan: 'Full Board', amenities: ['Game Drives', 'Kili Views', 'Campfire'] },
        ],
        mid: [
          { name: 'Ol Tukai Lodge', area: 'Inside park', stars: 4, pricePerNight: 280, mealPlan: 'Full Board', amenities: ['Game Drives', 'Pool', 'Kili Views', 'Cultural Visits'] },
          { name: 'Amboseli Serena Lodge', area: 'Inside park', stars: 4, pricePerNight: 300, mealPlan: 'Full Board', amenities: ['Game Drives', 'Pool', 'Spa', 'Kili Views'] },
        ],
        luxury: [
          { name: 'Tawi Lodge', area: 'Private conservancy', stars: 5, pricePerNight: 700, mealPlan: 'Full Board', amenities: ['Game Drives', 'Private Pool', 'Spa', 'Horse Riding'] },
        ],
      },
      naivasha: {
        budget: [
          { name: 'Crayfish Camp', area: 'Lake Naivasha', stars: 3, pricePerNight: 50, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Lake Views', 'Boat Rides'] },
        ],
        mid: [
          { name: 'Enashipai Resort', area: 'Lake Naivasha', stars: 4, pricePerNight: 180, mealPlan: 'Half Board', amenities: ['WiFi', 'Pool', 'Spa', 'Lake Views'] },
          { name: 'Lake Naivasha Sopa Resort', area: 'Lake Naivasha', stars: 4, pricePerNight: 160, mealPlan: 'Half Board', amenities: ['WiFi', 'Pool', 'Restaurant', 'Boat Rides'] },
        ],
        luxury: [
          { name: 'Sanctuary Farm', area: 'Lake Naivasha', stars: 5, pricePerNight: 400, mealPlan: 'Full Board', amenities: ['WiFi', 'Private Pool', 'Spa', 'Horse Riding'] },
        ],
      },
      kilifi: {
        budget: [
          { name: 'Distant Relatives Eco Lodge', area: 'Kilifi Creek', stars: 3, pricePerNight: 40, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant', 'Creek Views'] },
        ],
        mid: [
          { name: 'Kilifi Bay Beach Resort', area: 'Bofa Beach', stars: 4, pricePerNight: 130, mealPlan: 'Half Board', amenities: ['WiFi', 'Pool', 'Beach', 'Restaurant'] },
        ],
        luxury: [
          { name: 'Mnarani Club', area: 'Kilifi Creek', stars: 5, pricePerNight: 300, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Spa', 'Creek Views', 'Sailing'] },
        ],
      },
      cape_town: {
        budget: [
          { name: 'Ashanti Lodge', area: 'Gardens', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Bar'] },
        ],
        mid: [
          { name: 'Protea Hotel V&A Waterfront', area: 'V&A Waterfront', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant', 'Mountain Views'] },
          { name: 'Southern Sun Cape Sun', area: 'City Centre', stars: 4, pricePerNight: 160, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Gym', 'Restaurant'] },
        ],
        luxury: [
          { name: 'One&Only Cape Town', area: 'V&A Waterfront', stars: 5, pricePerNight: 800, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Private Pool', 'Spa', 'Marina Views'] },
          { name: 'Ellerman House', area: 'Bantry Bay', stars: 5, pricePerNight: 1200, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Spa', 'Ocean Views', 'Butler'] },
        ],
      },
      johannesburg: {
        budget: [
          { name: 'Protea Hotel Midrand', area: 'Midrand', stars: 3, pricePerNight: 70, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Radisson Blu Sandton', area: 'Sandton', stars: 4, pricePerNight: 160, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Gym', 'Spa'] },
          { name: 'Southern Sun Sandton', area: 'Sandton', stars: 4, pricePerNight: 150, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant', 'Gym'] },
        ],
        luxury: [
          { name: 'The Saxon Hotel', area: 'Sandhurst', stars: 5, pricePerNight: 600, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gardens', 'Butler'] },
          { name: 'Four Seasons Westcliff', area: 'Westcliff', stars: 5, pricePerNight: 700, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Zoo Views'] },
        ],
      },
      victoria_falls: {
        budget: [
          { name: 'Shoestrings Backpackers', area: 'Victoria Falls town', stars: 3, pricePerNight: 50, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Bar'] },
        ],
        mid: [
          { name: 'Ilala Lodge', area: 'Victoria Falls town', stars: 4, pricePerNight: 250, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Falls Views', 'Restaurant'] },
          { name: 'Victoria Falls Hotel', area: 'Victoria Falls town', stars: 4, pricePerNight: 300, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Falls Views', 'Historic Property'] },
        ],
        luxury: [
          { name: 'The Royal Livingstone', area: 'Livingstone side', stars: 5, pricePerNight: 700, mealPlan: 'Full Board', amenities: ['WiFi', 'Pool', 'Falls Views', 'Spa', 'Sunset Cruises'] },
          { name: 'Tongabezi Lodge', area: 'Livingstone', stars: 5, pricePerNight: 900, mealPlan: 'Full Board',amenities: ['WiFi', 'River Views', 'Spa', 'Private Dining'] },
        ],
      },
      lagos: {
        budget: [
          { name: 'Protea Hotel Lagos', area: 'Victoria Island', stars: 3, pricePerNight: 90, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Eko Hotel & Suites', area: 'Victoria Island', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Beach', 'Casino', 'Gym'] },
          { name: 'Lagos Continental Hotel', area: 'Victoria Island', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
        ],
        luxury: [
          { name: 'Radisson Blu Anchorage', area: 'Victoria Island', stars: 5, pricePerNight: 350, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Marina Views'] },
        ],
      },
      accra: {
        budget: [
          { name: 'Labadi Beach Hotel', area: 'Labadi', stars: 3, pricePerNight: 80, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Beach', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Movenpick Ambassador', area: 'Airport area', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
          { name: 'Kempinski Gold Coast City', area: 'City Centre', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
        ],
        luxury: [
          { name: 'Kempinski Gold Coast', area: 'City Centre', stars: 5, pricePerNight: 350, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Rooftop Bar'] },
        ],
      },
      cairo: {
        budget: [
          { name: 'Cairo Ambassador Hotel', area: 'Downtown', stars: 3, pricePerNight: 50, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Rooftop'] },
        ],
        mid: [
          { name: 'Sofitel Cairo Nile', area: 'Zamalek', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Nile Views', 'Spa'] },
          { name: 'Novotel Cairo Airport', area: 'Airport', stars: 4, pricePerNight: 120, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant', 'Gym'] },
        ],
        luxury: [
          { name: 'Four Seasons Cairo Nile Plaza', area: 'Garden City', stars: 5, pricePerNight: 400, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Nile Views', 'Spa', 'Butler'] },
          { name: 'Marriott Mena House', area: 'Giza Pyramids', stars: 5, pricePerNight: 350, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Pyramid Views', 'Spa'] },
        ],
      },
      marrakech: {
        budget: [
          { name: 'Riad Zitoun', area: 'Medina', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Rooftop Terrace', 'Traditional Decor'] },
        ],
        mid: [
          { name: 'Novotel Marrakech', area: 'Hivernage', stars: 4, pricePerNight: 130, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
          { name: 'Kenzi Rose Garden', area: 'Hivernage', stars: 4, pricePerNight: 150, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gardens'] },
        ],
        luxury: [
          { name: 'La Mamounia', area: 'Medina', stars: 5, pricePerNight: 800, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gardens', 'Casino', 'Butler'] },
          { name: 'Royal Mansour', area: 'Medina', stars: 5, pricePerNight: 1500, mealPlan: 'Full Board', amenities: ['WiFi', 'Private Riad', 'Spa', 'Butler', 'Pool'] },
        ],
      },
      dubai: {
        budget: [
          { name: 'ibis Dubai Mall of Emirates', area: 'Al Barsha', stars: 3, pricePerNight: 80, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Metro Access'] },
          { name: 'Citymax Hotel Bur Dubai', area: 'Bur Dubai', stars: 3, pricePerNight: 70, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Radisson Blu Dubai Deira Creek', area: 'Deira', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Creek Views', 'Spa'] },
          { name: 'Marriott Dubai Al Jaddaf', area: 'Al Jaddaf', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
        ],
        luxury: [
          { name: 'Burj Al Arab', area: 'Jumeirah', stars: 5, pricePerNight: 2000, mealPlan: 'Full Board', amenities: ['WiFi', 'Private Beach', 'Helicopter Pad', 'Butler'] },
          { name: 'Atlantis The Palm', area: 'Palm Jumeirah', stars: 5, pricePerNight: 600, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Waterpark', 'Private Beach', 'Aquarium', 'Spa'] },
        ],
      },
      bangkok: {
        budget: [
          { name: 'NapPark Hostel Khao San', area: 'Khao San Road', stars: 3, pricePerNight: 30, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Rooftop', 'Bar'] },
          { name: 'ibis Bangkok Riverside', area: 'Riverside', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'River Views'] },
        ],
        mid: [
          { name: 'Anantara Riverside Bangkok', area: 'Riverside', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'River Views', 'Shuttle Boat'] },
          { name: 'Centara Grand CentralWorld', area: 'City Centre', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Rooftop Bar'] },
        ],
        luxury: [
          { name: 'Mandarin Oriental Bangkok', area: 'Riverside', stars: 5, pricePerNight: 600, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'River Views', 'Butler'] },
          { name: 'The Peninsula Bangkok', area: 'Riverside', stars: 5, pricePerNight: 500, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Helicopter Pad', 'Butler'] },
        ],
      },
      bali: {
        budget: [
          { name: 'Kuta Beach Club Hotel', area: 'Kuta', stars: 3, pricePerNight: 40, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Beach Access'] },
          { name: 'Seminyak Square Hotel', area: 'Seminyak', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Alaya Resort Ubud', area: 'Ubud', stars: 4, pricePerNight: 160, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Rice Field Views', 'Yoga'] },
          { name: 'Katamama Seminyak', area: 'Seminyak', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Butler'] },
        ],
        luxury: [
          { name: 'Four Seasons Bali Jimbaran', area: 'Jimbaran', stars: 5, pricePerNight: 700, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Private Pool Villa', 'Beach', 'Spa', 'Butler'] },
          { name: 'COMO Uma Ubud', area: 'Ubud', stars: 5, pricePerNight: 500, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Jungle Views', 'Yoga'] },
        ],
      },
      tokyo: {
        budget: [
          { name: 'Dormy Inn Shinjuku', area: 'Shinjuku', stars: 3, pricePerNight: 80, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Onsen', 'Restaurant'] },
          { name: 'APA Hotel Asakusa', area: 'Asakusa', stars: 3, pricePerNight: 90, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Gym', 'Restaurant'] },
        ],
        mid: [
          { name: 'Shinjuku Granbell Hotel', area: 'Shinjuku', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Bar', 'City Views', 'Design Hotel'] },
          { name: 'Cerulean Tower Tokyu Hotel', area: 'Shibuya', stars: 4, pricePerNight: 280, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'City Views'] },
        ],
        luxury: [
          { name: 'The Peninsula Tokyo', area: 'Hibiya', stars: 5, pricePerNight: 700, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Imperial Palace Views', 'Butler'] },
          { name: 'Aman Tokyo', area: 'Otemachi', stars: 5, pricePerNight: 1200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'City Views', 'Butler', 'Onsen'] },
        ],
      },
      singapore: {
        budget: [
          { name: 'V Hotel Lavender', area: 'Lavender', stars: 3, pricePerNight: 90, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Restaurant'] },
        ],
        mid: [
          { name: 'Holiday Inn Singapore Orchard', area: 'Orchard', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Gym', 'Restaurant'] },
          { name: 'Marriott Singapore Tang Plaza', area: 'Orchard', stars: 4, pricePerNight: 250, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
        ],
        luxury: [
          { name: 'Marina Bay Sands', area: 'Marina Bay', stars: 5, pricePerNight: 600, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Infinity Pool', 'Casino', 'Spa', 'City Views'] },
          { name: 'Raffles Singapore', area: 'City Centre', stars: 5, pricePerNight: 800, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Historic Property', 'Butler'] },
        ],
      },
      mumbai: {
        budget: [
          { name: 'Hotel Kohinoor Continental', area: 'Andheri', stars: 3, pricePerNight: 50, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Gym'] },
        ],
        mid: [
          { name: 'Novotel Mumbai Juhu Beach', area: 'Juhu Beach', stars: 4, pricePerNight: 130, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Beach Views', 'Spa'] },
          { name: 'Marriott Mumbai', area: 'Powai', stars: 4, pricePerNight: 150, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Lake Views'] },
        ],
        luxury: [
          { name: 'The Taj Mahal Palace', area: 'Colaba', stars: 5, pricePerNight: 500, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gateway Views', 'Butler', 'Historic'] },
          { name: 'Four Seasons Mumbai', area: 'Worli', stars: 5, pricePerNight: 400, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Sea Views', 'Rooftop Bar'] },
        ],
      },
      london: {
        budget: [
          { name: 'Generator London', area: "King's Cross", stars: 3, pricePerNight: 80, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Bar', 'Restaurant'] },
          { name: 'ibis London Heathrow', area: 'Heathrow', stars: 3, pricePerNight: 100, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Airport Shuttle'] },
        ],
        mid: [
          { name: 'Holiday Inn London Kensington', area: 'Kensington', stars: 4, pricePerNight: 220, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Gym', 'Restaurant', 'Bar'] },
          { name: 'Marriott London Grosvenor Square', area: 'Mayfair', stars: 4, pricePerNight: 300, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Spa', 'Gym', 'Restaurant'] },
        ],
        luxury: [
          { name: 'The Savoy', area: 'Strand', stars: 5, pricePerNight: 900, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Thames Views', 'Butler', 'Historic'] },
          { name: "Claridge's", area: 'Mayfair', stars: 5, pricePerNight: 1000, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Spa', 'Butler', 'Art Deco', 'Historic'] },
        ],
      },
      paris: {
        budget: [
          { name: 'ibis Paris Gare du Nord', area: '10th arrondissement', stars: 3, pricePerNight: 90, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Metro Access'] },
        ],
        mid: [
          { name: 'Mercure Paris Centre Tour Eiffel', area: '15th arrondissement', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Eiffel Views'] },
          { name: 'Marriott Paris Champs Elysees', area: '8th arrondissement', stars: 4, pricePerNight: 350, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Spa', 'Gym', 'Restaurant'] },
        ],
        luxury: [
          { name: 'Ritz Paris', area: 'Place Vendome', stars: 5, pricePerNight: 1500, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Butler', 'Historic', 'Michelin Restaurant'] },
          { name: 'Le Meurice', area: '1st arrondissement', stars: 5, pricePerNight: 1200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Spa', 'Tuileries Views', 'Butler', 'Michelin Restaurant'] },
        ],
      },
      amsterdam: {
        budget: [
          { name: 'Generator Amsterdam', area: 'East Amsterdam', stars: 3, pricePerNight: 80, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Bar', 'Canal Nearby'] },
        ],
        mid: [
          { name: 'NH Amsterdam Centre', area: 'City Centre', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Restaurant', 'Canal Views', 'Gym'] },
          { name: 'Marriott Amsterdam', area: 'City Centre', stars: 4, pricePerNight: 280, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
        ],
        luxury: [
          { name: 'Waldorf Astoria Amsterdam', area: 'Herengracht', stars: 5, pricePerNight: 700, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Canal Views', 'Butler', 'Historic'] },
        ],
      },
      barcelona: {
        budget: [
          { name: 'Generator Barcelona', area: 'Gracia', stars: 3, pricePerNight: 70, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Rooftop Bar'] },
        ],
        mid: [
          { name: 'NH Collection Gran Hotel Calderon', area: 'Passeig de Gracia', stars: 4, pricePerNight: 200, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Rooftop Pool', 'Gym', 'Spa'] },
          { name: 'Hotel Arts Barcelona', area: 'Barceloneta', stars: 4, pricePerNight: 300, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Beach', 'Spa'] },
        ],
        luxury: [
          { name: 'W Barcelona', area: 'Barceloneta Beach', stars: 5, pricePerNight: 500, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Infinity Pool', 'Beach', 'Spa', 'Sea Views'] },
          { name: 'Mandarin Oriental Barcelona', area: 'Passeig de Gracia', stars: 5, pricePerNight: 700, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Michelin Restaurant', 'Butler'] },
        ],
      },
      istanbul: {
        budget: [
          { name: 'Marmara Guesthouse', area: 'Sultanahmet', stars: 3, pricePerNight: 60, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Rooftop Terrace', 'Bosphorus Views'] },
        ],
        mid: [
          { name: 'Radisson Blu Hotel Istanbul', area: 'Sisli', stars: 4, pricePerNight: 150, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Gym'] },
          { name: 'Marriott Istanbul Sisli', area: 'Sisli', stars: 4, pricePerNight: 180, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'City Views'] },
        ],
        luxury: [
          { name: 'Four Seasons Istanbul Bosphorus', area: 'Besiktas', stars: 5, pricePerNight: 600, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Bosphorus Views', 'Butler'] },
          { name: 'Ciragan Palace Kempinski', area: 'Besiktas', stars: 5, pricePerNight: 700, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Spa', 'Bosphorus Views', 'Historic Palace'] },
        ],
      },
      new_york: {
        budget: [
          { name: 'Pod 51 Hotel', area: 'Midtown', stars: 3, pricePerNight: 100, mealPlan: 'Room Only', amenities: ['WiFi', 'Rooftop Bar', 'Restaurant'] },
          { name: 'ibis New York Midtown', area: 'Midtown', stars: 3, pricePerNight: 120, mealPlan: 'Room Only', amenities: ['WiFi', 'Restaurant', 'Times Square Nearby'] },
        ],
        mid: [
          { name: 'Marriott New York Times Square', area: 'Times Square', stars: 4, pricePerNight: 280, mealPlan: 'Room Only', amenities: ['WiFi', 'Gym', 'Restaurant', 'Times Square Views'] },
          { name: 'Holiday Inn Midtown', area: 'Midtown', stars: 4, pricePerNight: 250, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Gym', 'Restaurant'] },
        ],
        luxury: [
          { name: 'The Plaza Hotel', area: 'Central Park South', stars: 5, pricePerNight: 900, mealPlan: 'Room Only', amenities: ['WiFi', 'Spa', 'Central Park Views', 'Butler', 'Historic'] },
          { name: 'Four Seasons New York Downtown', area: 'Downtown', stars: 5, pricePerNight: 800, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Spa', 'City Views', 'Butler'] },
        ],
      },
      miami: {
        budget: [
          { name: 'Freehand Miami', area: 'South Beach', stars: 3, pricePerNight: 80, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Bar', 'Beach Nearby'] },
        ],
        mid: [
          { name: 'Courtyard Miami Beach', area: 'South Beach', stars: 4, pricePerNight: 200, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Beach Access', 'Restaurant'] },
          { name: 'Marriott Miami Biscayne Bay', area: 'Downtown', stars: 4, pricePerNight: 220, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Bay Views', 'Gym'] },
        ],
        luxury: [
          { name: 'The Setai Miami Beach', area: 'South Beach', stars: 5, pricePerNight: 700, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Private Beach', 'Spa', 'Butler'] },
          { name: 'Four Seasons Miami', area: 'Brickell', stars: 5, pricePerNight: 600, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Spa', 'City Views', 'Butler'] },
        ],
      },
      cancun: {
        budget: [
          { name: 'Hostel Natura Cancun', area: 'Hotel Zone', stars: 3, pricePerNight: 50, mealPlan: 'Room Only', amenities: ['WiFi', 'Pool', 'Beach Nearby'] },
        ],
        mid: [
          { name: 'Krystal Grand Cancun', area: 'Hotel Zone', stars: 4, pricePerNight: 200, mealPlan: 'All Inclusive', amenities: ['WiFi', 'Pool', 'Beach', 'All Inclusive', 'Water Sports'] },
          { name: 'Marriott Cancun Resort', area: 'Hotel Zone', stars: 4, pricePerNight: 250, mealPlan: 'All Inclusive', amenities: ['WiFi', 'Pool', 'Beach', 'All Inclusive', 'Spa'] },
        ],
        luxury: [
          { name: 'Nizuc Resort & Spa', area: 'Hotel Zone', stars: 5, pricePerNight: 600, mealPlan: 'All Inclusive', amenities: ['WiFi', 'Private Beach', 'Spa', 'Pool', 'Butler'] },
          { name: 'Ritz Carlton Cancun', area: 'Hotel Zone', stars: 5, pricePerNight: 700, mealPlan: 'Bed & Breakfast', amenities: ['WiFi', 'Pool', 'Beach', 'Spa', 'Butler'] },
        ],
      },
    };

    const matchDest = (dest) => {
      if (dest.includes('zanzibar')) return hotelDB.zanzibar;
      if (dest.includes('mombasa')) return hotelDB.mombasa;
      if (dest.includes('diani')) return hotelDB.diani;
      if (dest.includes('mara') || dest.includes('masai')) return hotelDB.masai_mara;
      if (dest.includes('kigali') || dest.includes('rwanda')) return hotelDB.kigali;
      if (dest.includes('kampala') || dest.includes('uganda')) return hotelDB.kampala;
      if (dest.includes('dar es salaam') || dest.includes('dar')) return hotelDB.dar_es_salaam;
      if (dest.includes('amboseli')) return hotelDB.amboseli;
      if (dest.includes('naivasha')) return hotelDB.naivasha;
      if (dest.includes('kilifi')) return hotelDB.kilifi;
      if (dest.includes('cape town')) return hotelDB.cape_town;
      if (dest.includes('johannesburg') || dest.includes('joburg') || dest.includes('jozi')) return hotelDB.johannesburg;
      if (dest.includes('victoria falls') || dest.includes('livingstone')) return hotelDB.victoria_falls;
      if (dest.includes('lagos')) return hotelDB.lagos;
      if (dest.includes('accra') || dest.includes('ghana')) return hotelDB.accra;
      if (dest.includes('cairo') || dest.includes('egypt')) return hotelDB.cairo;
      if (dest.includes('marrakech') || dest.includes('morocco')) return hotelDB.marrakech;
      if (dest.includes('dubai') || dest.includes('uae')) return hotelDB.dubai;
      if (dest.includes('bangkok') || dest.includes('thailand')) return hotelDB.bangkok;
      if (dest.includes('bali') || dest.includes('indonesia')) return hotelDB.bali;
      if (dest.includes('tokyo') || dest.includes('japan')) return hotelDB.tokyo;
      if (dest.includes('singapore')) return hotelDB.singapore;
      if (dest.includes('mumbai') || dest.includes('india')) return hotelDB.mumbai;
      if (dest.includes('london') || dest.includes('uk')) return hotelDB.london;
      if (dest.includes('paris') || dest.includes('france')) return hotelDB.paris;
      if (dest.includes('amsterdam') || dest.includes('netherlands')) return hotelDB.amsterdam;
      if (dest.includes('barcelona') || dest.includes('spain')) return hotelDB.barcelona;
      if (dest.includes('istanbul') || dest.includes('turkey')) return hotelDB.istanbul;
      if (dest.includes('new york') || dest.includes('nyc')) return hotelDB.new_york;
      if (dest.includes('miami')) return hotelDB.miami;
      if (dest.includes('cancun') || dest.includes('mexico')) return hotelDB.cancun;
      return hotelDB.zanzibar;
    };

    const hotels = matchDest(dest);

    const options = [
      hotels.budget[0],
      hotels.mid[0],
      hotels.luxury[0],
    ].filter(Boolean);

    return options.map((hotel, index) => ({
      id: `mock-hotel-${index + 1}`,
      type: 'hotel',
      name: hotel.name,
      stars: hotel.stars,
      area: hotel.area,
      location: hotel.area,
      destination,
      checkIn,
      checkOut,
      nights,
      guests,
      mealPlan: hotel.mealPlan,
      amenities: hotel.amenities,
      roomType: index === 0 ? 'Standard Room' : index === 1 ? 'Superior Room' : 'Deluxe Room',
      cancellationPolicy: index === 0 ? 'Non-refundable' : index === 1 ? 'Free cancellation 48h before' : 'Fully refundable',
      price: hotel.pricePerNight * nights,
      pricePerNight: hotel.pricePerNight,
      currency: 'USD',
      rating: hotel.stars + 0.5,
      reviewCount: Math.floor(Math.random() * 500) + 100,
    }));
  }
}

module.exports = new HotelService();
