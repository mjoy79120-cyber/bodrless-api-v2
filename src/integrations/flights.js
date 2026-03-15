/**
 * FLIGHT INTEGRATION
 * ─────────────────────────────────────────────────────────────
 * Connects to flight APIs. Primary: Amadeus.
 * Add more providers here as you negotiate deals.
 *
 * Each provider returns results normalized to the same format
 * so the orchestration engine doesn't care which API it's using.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const { logger } = require('../utils/logger');

class FlightService {

  constructor() {
    this.amadeusToken = null;
    this.amadeusTokenExpiry = null;
  }

  /**
   * Search for flights across all connected providers
   */
  async search({ origin, destination, departureDate, returnDate, passengers, cabinClass }) {
    // Always use mock data in development
    if (process.env.NODE_ENV !== 'production' || !process.env.AMADEUS_API_KEY) {
      return this._getMockFlights({ origin, destination, departureDate, passengers });
    }
    try {
      const results = await this._searchAmadeus({
        origin, destination, departureDate, returnDate, passengers, cabinClass
      });
      return results;
    } catch (error) {
      logger.error('Flight search failed', { error: error.message });
      return this._getMockFlights({ origin, destination, departureDate, passengers });
    }
  }

  /**
   * Search Amadeus — primary flight provider
   */
  async _searchAmadeus({ origin, destination, departureDate, returnDate, passengers, cabinClass }) {
    const token = await this._getAmadeusToken();

    const params = {
      originLocationCode: origin,
      destinationLocationCode: destination,
      departureDate,
      adults: passengers,
      travelClass: cabinClass,
      max: 10,
    };

    if (returnDate) params.returnDate = returnDate;

    const response = await axios.get(
      'https://test.api.amadeus.com/v2/shopping/flight-offers',
      {
        headers: { Authorization: `Bearer ${token}` },
        params,
      }
    );

    return this._normalizeAmadeusResults(response.data.data || []);
  }

  /**
   * Normalize Amadeus results to Bodrless standard format
   */
  _normalizeAmadeusResults(offers) {
    return offers.map(offer => {
      const itinerary = offer.itineraries[0];
      const segment = itinerary.segments[0];
      const lastSegment = itinerary.segments[itinerary.segments.length - 1];

      return {
        id: offer.id,
        type: 'flight',
        provider: segment.carrierCode,
        providerName: segment.carrierCode, // TODO: Map to full airline name
        flightNumber: `${segment.carrierCode}${segment.number}`,
        origin: segment.departure.iataCode,
        destination: lastSegment.arrival.iataCode,
        departureTime: segment.departure.at,
        arrivalTime: lastSegment.arrival.at,
        duration: itinerary.duration,
        stops: itinerary.segments.length - 1,
        arrival: {
          airport: lastSegment.arrival.iataCode,
          terminal: lastSegment.arrival.terminal,
          time: lastSegment.arrival.at,
        },
        baggage: offer.travelerPricings?.[0]?.fareDetailsBySegment?.[0]?.includedCheckedBags || null,
        cancellationPolicy: 'See fare rules', // TODO: Parse from offer
        price: parseFloat(offer.price.total),
        currency: offer.price.currency,
      };
    });
  }

  /**
   * Get/refresh Amadeus OAuth token
   */
  async _getAmadeusToken() {
    if (this.amadeusToken && this.amadeusTokenExpiry > Date.now()) {
      return this.amadeusToken;
    }

    const response = await axios.post(
      'https://test.api.amadeus.com/v1/security/oauth2/token',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.AMADEUS_API_KEY,
        client_secret: process.env.AMADEUS_API_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    this.amadeusToken = response.data.access_token;
    this.amadeusTokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;

    return this.amadeusToken;
  }

  /**
   * Mock flights for development/testing when API not configured
   */
  _getMockFlights({ origin, destination, departureDate, passengers }) {
    logger.warn('Using mock flight data — configure AMADEUS_API_KEY for real results');

    return [
      {
        id: 'mock-flight-1',
        type: 'flight',
        provider: 'KQ',
        providerName: 'Kenya Airways',
        flightNumber: 'KQ100',
        origin,
        destination,
        departureTime: `${departureDate}T08:00:00`,
        arrivalTime: `${departureDate}T10:10:00`,
        duration: 'PT2H10M',
        stops: 0,
        arrival: { airport: destination, terminal: '1', time: `${departureDate}T10:10:00` },
        baggage: { quantity: 1, weight: { value: 23, unit: 'KG' } },
        cancellationPolicy: 'Non-refundable',
        price: 280 * passengers,
        currency: 'USD',
      },
      {
        id: 'mock-flight-2',
        type: 'flight',
        provider: 'P0',
        providerName: 'Precision Air',
        flightNumber: 'P0201',
        origin,
        destination,
        departureTime: `${departureDate}T14:30:00`,
        arrivalTime: `${departureDate}T16:25:00`,
        duration: 'PT1H55M',
        stops: 0,
        arrival: { airport: destination, terminal: '1', time: `${departureDate}T16:25:00` },
        baggage: { quantity: 1, weight: { value: 20, unit: 'KG' } },
        cancellationPolicy: 'Free cancellation 24h before',
        price: 320 * passengers,
        currency: 'USD',
      },
    ];
  }
}

module.exports = new FlightService();
