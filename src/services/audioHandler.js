/**
 * WHATSAPP AUDIO HANDLER
 * ─────────────────────────────────────────────────────────────
 * Transcription via Groq Whisper (whisper-large-v3-turbo)
 * No new API key needed — uses your existing GROQ_API_KEY.
 *
 * FLOW:
 *   1. WhatsApp sends audio as .ogg (Opus codec)
 *   2. Download from WhatsApp Media API using the media ID
 *   3. Send to Groq Whisper for transcription
 *   4. Return transcript to webhooks.js to feed into orchestrationEngine
 *
 * COST: Free on Groq's current tier.
 *
 * ENV VARS NEEDED:
 *   GROQ_API_KEY            — already set on Render
 *   WHATSAPP_ACCESS_TOKEN   — already set on Render
 *
 * DEPENDENCIES:
 *   npm install form-data   ← only new package needed
 *   (axios already installed)
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const axios    = require('axios');
const FormData = require('form-data');
const { logger } = require('../utils/logger');

// ─────────────────────────────────────────────
// DOWNLOAD WHATSAPP MEDIA
// WhatsApp requires two steps:
//   1. GET /media/{id} → returns a URL
//   2. GET that URL   → returns the actual audio bytes
// ─────────────────────────────────────────────
async function _downloadWhatsAppAudio(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  // Step 1: resolve media URL
  const metaRes = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const mediaUrl = metaRes.data?.url;
  if (!mediaUrl) throw new Error(`WhatsApp media URL not returned for id ${mediaId}`);

  // Step 2: download the audio bytes
  const audioRes = await axios.get(mediaUrl, {
    headers:      { Authorization: `Bearer ${token}` },
    responseType: 'arraybuffer',
  });

  return Buffer.from(audioRes.data);
}

// ─────────────────────────────────────────────
// TRANSCRIBE WITH GROQ WHISPER
// Groq hosts whisper-large-v3-turbo — same quality as OpenAI
// Whisper, faster, and free on Groq's current tier.
// Accepts .ogg (WhatsApp's format) directly.
// ─────────────────────────────────────────────
async function _transcribeAudio(audioBuffer) {
  const form = new FormData();

  form.append('file', audioBuffer, {
    filename:    'voice.ogg',
    contentType: 'audio/ogg',
  });
  form.append('model', 'whisper-large-v3-turbo');

  // Omitting `language` lets Whisper auto-detect.
  // Good for your market — handles English, Swahili, and Sheng naturally.
  // To force Swahili: form.append('language', 'sw');

  const res = await axios.post(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      timeout: 15000,
    }
  );

  return res.data?.text?.trim() || null;
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// Called from webhooks.js when message.type === 'audio'
// Returns { handled: true, transcript } on success,
// or true (handled, no transcript) on error.
// ─────────────────────────────────────────────
async function handleAudioMessage({
  message,
  phoneNumberId,
  recipient,
  userKey,
  agencyId,
  contact,
}) {
  const mediaId = message.audio?.id;
  if (!mediaId) {
    logger.warn('Audio message has no media ID', { userKey });
    return false;
  }

  logger.info('WhatsApp audio message received — transcribing', { userKey, mediaId });

  const whatsappService = require('../services/whatsapp');

  // Acknowledge while Groq runs (usually <2s)
  await whatsappService.sendText(
    phoneNumberId,
    recipient,
    '🎙️ Got your voice note — transcribing now...'
  );

  let transcript;
  try {
    const audioBuffer = await _downloadWhatsAppAudio(mediaId);
    transcript = await _transcribeAudio(audioBuffer);
  } catch (err) {
    logger.error('Audio transcription failed', { userKey, mediaId, error: err.message });
    await whatsappService.sendText(
      phoneNumberId,
      recipient,
      "Sorry, I couldn't make out that voice note. Could you type your request instead? For example: \"Nairobi to Zanzibar, 3 nights, 2 adults\"."
    );
    return true;
  }

  if (!transcript) {
    await whatsappService.sendText(
      phoneNumberId,
      recipient,
      "I couldn't pick up anything from that voice note. Could you try again or type your request?"
    );
    return true;
  }

  logger.info('Audio transcribed', { userKey, transcript: transcript.slice(0, 120) });

  // Echo so the user can verify we heard them correctly
  await whatsappService.sendText(
    phoneNumberId,
    recipient,
    `I heard: _"${transcript}"_\n\nSearching now...`
  );

  return { handled: true, transcript };
}

module.exports = { handleAudioMessage };