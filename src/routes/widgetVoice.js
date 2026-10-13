/**
 * WIDGET VOICE — transcribes a voice note recorded in the browser.
 * POST /api/widget/transcribe   body: raw audio (audio/webm, audio/mp4, ...)
 * Returns { text } — the widget then feeds it into its normal send() flow.
 */
const express = require('express');
const { logger } = require('../utils/logger');
const { transcribeAudio } = require('../services/audioHandler');

const router = express.Router();

// light abuse protection: 6 voice requests per minute per visitor/IP
const hits = new Map();
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();
function limiter(req, res, next) {
  const k   = String(req.headers['x-visitor-token'] || '').slice(0, 80) + '|' + req.ip;
  const now = Date.now();
  const arr = (hits.get(k) || []).filter(t => now - t < 60000);
  if (arr.length >= 6) return res.status(429).json({ error: 'too_many_requests' });
  arr.push(now);
  hits.set(k, arr);
  next();
}

// the widget sends x-api-key (agency mode) or x-hotel-key (hotel mode)
function requireKey(req, res, next) {
  const key = String(req.headers['x-api-key'] || req.headers['x-hotel-key'] || '');
  if (!/^[a-z0-9_-]{1,80}$/i.test(key)) return res.status(401).json({ error: 'missing_key' });
  next();
}

router.post('/transcribe',
  requireKey,
  limiter,
  express.raw({ type: 'audio/*', limit: '5mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length < 1000) {
        return res.status(400).json({ error: 'no_audio' });
      }
      const mime = req.headers['content-type'] || 'audio/webm';
      const text = await transcribeAudio(req.body, mime);
      logger.info('[widgetVoice] transcribed', { bytes: req.body.length, mime, chars: text ? text.length : 0 });
      res.json({ text });
    } catch (e) {
      logger.error('[widgetVoice] transcription failed', { error: e.message });
      res.status(500).json({ error: 'transcription_failed' });
    }
  });

module.exports = router;