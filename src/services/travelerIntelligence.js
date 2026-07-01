const { logger } = require('../utils/logger');

class TravelerIntelligence {
  analyze(parsedTrip = {}, originalPrompt = '') {
    const text = (originalPrompt || '').toLowerCase();

    const profile = {
      travelerType: this.detectTravelerType(parsedTrip, text),
      tripPurpose: this.detectTripPurpose(parsedTrip, text),

      budgetSensitivity: this.detectBudgetSensitivity(parsedTrip, text),
      conveniencePriority: this.detectConveniencePriority(text),
      luxuryPreference: this.detectLuxuryPreference(parsedTrip, text),

      familyFriendly: this.detectFamilyFriendly(text),

      preferredTransport: this.detectTransportPreference(parsedTrip, text),

      maxStops: this.detectMaxStops(text),

      hotelPreferences: this.detectHotelPreferences(parsedTrip, text),

      beachAffinity: this.detectBeachAffinity(parsedTrip, text),
      safariAffinity: this.detectSafariAffinity(parsedTrip, text),
      adventureAffinity: this.detectAdventureAffinity(text),

      confidence: 1.0
    };

    profile.refundSensitivity = this.detectRefundSensitivity(text);
    profile.timeCritical = this.detectTimeCritical(text);
    profile.transferTolerance = this.detectTransferTolerance(profile, text);
    profile.riskTolerance = this.detectRiskTolerance(profile, text);

    profile.scoringWeights = this.buildScoringWeights(profile);

    profile.orchestrationHints = {
      prioritizeRefundable: profile.refundSensitivity >= 8,
      avoidTransfers: profile.transferTolerance === 0,
      prioritizeArrivalTime: profile.timeCritical,
      prioritizeComfort: profile.tripPurpose === 'honeymoon' || profile.familyFriendly,
      prioritizeLowestPrice: profile.budgetSensitivity === 'high'
    };

    logger.info('Traveler Intelligence Profile Generated', { profile });

    return profile;
  }

  detectTravelerType(parsedTrip, text) {
    const travelers = parsedTrip.passengers || parsedTrip.travelers || 1;

    if (text.match(/wife|husband|girlfriend|boyfriend|partner|honeymoon|mke|mume|mchumba|mpenzi/)) {
      return 'couple';
    }
    if (text.match(/family|kids|children|familia|watoto|mtoto/) || parsedTrip.preferences?.includes('family')) {
      return 'family';
    }
    if (travelers >= 5) {
      return 'group';
    }
    return travelers === 1 ? 'solo' : 'group';
  }

  detectTripPurpose(parsedTrip, text) {
    if (parsedTrip.preferences?.includes('business') || text.match(/business|conference|meeting|mkutano|kazi/)) {
      return 'business';
    }
    if (parsedTrip.preferences?.includes('honeymoon') || text.includes('honeymoon')) {
      return 'honeymoon';
    }
    if (parsedTrip.preferences?.includes('safari') || text.match(/safari|hiking|trekking|porini/)) {
      return 'adventure';
    }
    return 'vacation';
  }

  detectBudgetSensitivity(parsedTrip, text) {
    if (parsedTrip.budget) {
      if (parsedTrip.budget === 'low') return 'high';
      if (parsedTrip.budget === 'luxury' || parsedTrip.budget === 'high') return 'low';
      return 'medium';
    }
    const highBudgetWords = ['cheap', 'budget', 'affordable', 'low cost', 'economical', 'save money', 'rahisi', 'bei nafuu'];
    const luxuryWords = ['luxury', 'premium', '5 star', 'five star', 'exclusive', 'vip', 'kifahari'];

    if (highBudgetWords.some(word => text.includes(word))) return 'high';
    if (luxuryWords.some(word => text.includes(word))) return 'low';
    return 'medium';
  }

  detectConveniencePriority(text) {
    const convenienceWords = ['direct', 'non stop', 'no layovers', 'fastest', 'quickest', 'bila kusimama', 'haraka'];
    return convenienceWords.some(word => text.includes(word)) ? 10 : 5;
  }

  detectLuxuryPreference(parsedTrip, text) {
    if (parsedTrip.budget === 'luxury') return 10;
    const luxuryWords = ['luxury', 'premium', '5 star', 'exclusive', 'vip', 'honeymoon', 'kifahari'];
    return luxuryWords.some(word => text.includes(word)) ? 10 : 5;
  }

  detectFamilyFriendly(text) {
    return !!text.match(/family|kids|children|familia|watoto|mtoto/);
  }

  detectTransportPreference(parsedTrip, text) {
    if (parsedTrip.outboundTransportMode) {
      return parsedTrip.outboundTransportMode === 'flight' ? 'air' : parsedTrip.outboundTransportMode;
    }
    if (text.match(/flight|fly|ndege/)) return 'air';
    if (text.match(/bus|coach|basi|matatu/)) return 'bus';
    if (text.match(/train|sgr|treni/)) return 'train';
    return 'any';
  }

  detectMaxStops(text) {
    if (text.match(/direct|non stop|no layovers|bila kusimama/)) return 0;
    return null;
  }

  detectHotelPreferences(parsedTrip, text) {
    const preferences = [];
    if (text.match(/beach|pwani|bahari/) || parsedTrip.preferences?.includes('beach')) preferences.push('beachfront');
    if (text.match(/pool|kuogelea/)) preferences.push('pool');
    if (parsedTrip.mealPlan === 'all_inclusive' || text.match(/all inclusive|chakula chote/)) preferences.push('all_inclusive');
    if (text.includes('spa')) preferences.push('spa');
    return preferences;
  }

  detectBeachAffinity(parsedTrip, text) {
    const hasBeachTarget = text.match(/beach|zanzibar|diani|watamu|kilifi|lamu|pwani|bahari/);
    const hasBeachPref = parsedTrip.preferences?.includes('beach');
    return (hasBeachTarget || hasBeachPref) ? 10 : 5;
  }

  detectSafariAffinity(parsedTrip, text) {
    const hasSafariTarget = text.match(/safari|maasai mara|mara|serengeti|amboseli|tsavo|porini/);
    const hasSafariPref = parsedTrip.preferences?.includes('safari');
    return (hasSafariTarget || hasSafariPref) ? 10 : 5;
  }

  detectAdventureAffinity(text) {
    return text.match(/hiking|trekking|climbing|kupanda|milima/) ? 10 : 5;
  }

  detectRefundSensitivity(text) {
    const flexibleWords = [
      'refundable', 'flexible', 'may change', 'might change', 'tentative',
      'not sure', 'change dates', 'cancel', 'cancellation',
      'kubadilisha', 'kughairi', 'kurudisha pesa'
    ];
    return flexibleWords.some(word => text.includes(word)) ? 10 : 5;
  }

  detectTransferTolerance(profile, text) {
    if (text.match(/direct|non stop|no layovers|bila kusimama/)) {
      return 0;
    }
    if (profile.budgetSensitivity === 'high') {
      return 3;
    }
    if (profile.tripPurpose === 'business') {
      return 1;
    }
    return 2;
  }

  detectRiskTolerance(profile, text) {
    if (text.match(/elderly|senior|old parents|grandmother|grandfather|wazee|babu|nyanya/)) {
      return 'low';
    }
    if (profile.familyFriendly || profile.tripPurpose === 'business') {
      return 'low';
    }
    return 'medium';
  }

  detectTimeCritical(text) {
    const keywords = [
      'must arrive', 'need to be', 'conference', 'meeting', 'event starts',
      'before', 'deadline', 'wedding', 'appointment', 'lazima', 'haraka', 'harusi', 'mkutano'
    ];
    return keywords.some(word => text.includes(word));
  }

  buildScoringWeights(profile) {
    const weights = {
      price: 5,
      convenience: 5,
      hotelQuality: 5,
      transferComfort: 5,
      refundFlexibility: 5
    };

    if (profile.budgetSensitivity === 'high') {
      weights.price = 10;
      weights.convenience = 4;
      weights.hotelQuality = 3;
    }
    if (profile.tripPurpose === 'business') {
      weights.price = 3;
      weights.convenience = 10;
      weights.hotelQuality = 8;
      weights.refundFlexibility = 9;
    }
    if (profile.tripPurpose === 'honeymoon') {
      weights.price = 3;
      weights.hotelQuality = 10;
      weights.transferComfort = 9;
    }
    if (profile.familyFriendly) {
      weights.transferComfort = 9;
      weights.convenience = 8;
    }
    if (profile.refundSensitivity >= 8) {
      weights.refundFlexibility = 10;
    }
    if (profile.timeCritical) {
      weights.convenience = 10;
    }

    return weights;
  }
}

module.exports = new TravelerIntelligence();