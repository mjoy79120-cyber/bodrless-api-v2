/**
 * DATA QUERY SERVICE — "Talk to my data"
 * ─────────────────────────────────────────────────────────────
 * Lets an agency ask natural-language questions about their own
 * bookings, earnings, and customers, and get a real answer grounded
 * in their actual Supabase data — not a hallucinated guess.
 *
 * Approach: fetch the agency's relevant data first (bookings, searches,
 * computed stats), then hand that real data + the question to Gemini
 * with an explicit instruction to answer ONLY from the provided data
 * and say so plainly if the data can't answer the question. This
 * keeps every number in the response traceable to a real row, never
 * invented by the model.
 * ─────────────────────────────────────────────────────────────
 */

const axios = require('axios');
const supabase = require('../utils/supabase');
const { logger } = require('../utils/logger');

const MAX_BOOKINGS_FOR_CONTEXT = 200; // keep the Gemini prompt bounded

class DataQueryService {

  async answerQuestion({ agencyId, question }) {
    try {
      const context = await this._buildAgencyContext(agencyId);
      const answer = await this._askGemini(question, context);

      return { success: true, answer, dataAsOf: new Date().toISOString() };

    } catch (err) {
      logger.error('Data query failed', { agencyId, question, error: err.message });
      return {
        success: false,
        error: 'Could not process that question right now. Please try again or rephrase it.',
      };
    }
  }

  // ─────────────────────────────────────────────
  // BUILD CONTEXT — pull the agency's real data
  // ─────────────────────────────────────────────
  async _buildAgencyContext(agencyId) {
    const { data: agency } = await supabase
      .from('agencies')
      .select('name, markup_percentage, plan, created_at')
      .eq('id', agencyId)
      .single();

    const { data: bookings } = await supabase
      .from('bookings')
      .select('booking_ref, guest_name, guest_phone, destination, origin, nights, passengers, total_price, currency, status, booking_stage, channel, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(MAX_BOOKINGS_FOR_CONTEXT);

    const { data: searches } = await supabase
      .from('trip_searches')
      .select('destination, origin, passengers, budget, nights, packages_returned, converted, channel, created_at')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(MAX_BOOKINGS_FOR_CONTEXT);

    const markupRate = (agency?.markup_percentage || 0) / 100;
    const totalEarnings = (bookings || []).reduce((sum, b) => sum + (Number(b.total_price || 0) * markupRate), 0);
    const totalRevenuePassedThrough = (bookings || []).reduce((sum, b) => sum + Number(b.total_price || 0), 0);

    const uniqueCustomers = new Set((bookings || []).map(b => b.guest_phone || b.guest_name)).size;

    const destinationCounts = {};
    (bookings || []).forEach(b => {
      if (b.destination) destinationCounts[b.destination] = (destinationCounts[b.destination] || 0) + 1;
    });
    const topDestinations = Object.entries(destinationCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([dest, count]) => ({ destination: dest, bookingCount: count }));

    return {
      agencyName: agency?.name || 'Your agency',
      markupPercentage: agency?.markup_percentage || 0,
      plan: agency?.plan,
      agencySince: agency?.created_at,
      summary: {
        totalBookings: (bookings || []).length,
        totalEarnings: Math.round(totalEarnings),
        totalRevenuePassedThrough: Math.round(totalRevenuePassedThrough),
        uniqueCustomers,
        totalSearches: (searches || []).length,
        conversionRate: searches?.length > 0
          ? Math.round(((bookings?.length || 0) / searches.length) * 100)
          : 0,
        topDestinations,
      },
      // Raw rows so Gemini can answer specific/granular questions
      // (e.g. "who booked Mombasa last week") not just aggregate ones.
      recentBookings: (bookings || []).map(b => ({
        ref: b.booking_ref,
        guest: b.guest_name,
        route: `${b.origin || '?'} to ${b.destination || '?'}`,
        nights: b.nights,
        passengers: b.passengers,
        totalPrice: b.total_price,
        currency: b.currency,
        status: b.status,
        stage: b.booking_stage,
        channel: b.channel,
        date: b.created_at,
      })),
      recentSearches: (searches || []).map(s => ({
        route: `${s.origin || '?'} to ${s.destination || '?'}`,
        passengers: s.passengers,
        budget: s.budget,
        nights: s.nights,
        resultsFound: s.packages_returned,
        converted: s.converted,
        channel: s.channel,
        date: s.created_at,
      })),
    };
  }

  // ─────────────────────────────────────────────
  // ASK GEMINI — grounded strictly in the provided context
  // ─────────────────────────────────────────────
  async _askGemini(question, context) {
    const prompt = `You are a data assistant for a travel agency using the Bodrless platform. Answer the agency's question using ONLY the data provided below. Do not invent, estimate, or guess any number that isn't directly present or computable from this data.

If the data doesn't contain enough information to answer the question, say so plainly — do not make up an answer.

Be concise, conversational, and specific. Use real numbers from the data. Format currency as "KES X,XXX". If listing multiple items (bookings, destinations, etc.), use a short bulleted list.

AGENCY: ${context.agencyName} (${context.plan} plan, markup: ${context.markupPercentage}%)

SUMMARY STATS:
${JSON.stringify(context.summary, null, 2)}

RECENT BOOKINGS (most recent ${context.recentBookings.length}):
${JSON.stringify(context.recentBookings, null, 2)}

RECENT SEARCHES (most recent ${context.recentSearches.length}):
${JSON.stringify(context.recentSearches, null, 2)}

QUESTION: "${question}"

Answer the question now, grounded strictly in the data above:`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 600 },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );

    return response.data.candidates[0].content.parts[0].text.trim();
  }
}

module.exports = new DataQueryService();