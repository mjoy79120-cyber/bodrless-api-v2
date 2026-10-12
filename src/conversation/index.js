'use strict';

const { randomUUID } = require('crypto');
const { clean, words } = require('./text');
const { classify, STRONG, LABELS } = require('./intents');
const P = require('./pending');
const H = require('./handlers');
const { loadEvents, findEvent, answerEvent } = require('./events');
const { extractName } = require('./names');
const { guardParsePrompt, sanitizeOrigin } = require('./originGuard');

const REF_RX = /\b(?:BDR|BDL)-\d{6,}\b/gi;
const INTERNAL_KEYS = new Set(['agencyId', '_channel', '_sendWhatsApp', '_phone', '_tripStore', '_conv']);
const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

const hasEngineState = (p) => !!p && Object.keys(p).some((k) => !INTERNAL_KEYS.has(k) && p[k] !== undefined);

const MISS_TEXT = [
  (q) => `Sorry, I didn't catch that. ${q}`,
  (q) => `I'm still not sure I understood. ${q}`,
  (q) => `I'm having trouble with that one. ${q} Or start a new trip, for example "Nairobi to Mombasa, 20 Oct".`,
];
const MAX_MISSES = 3;

/**
 * Build the conversation layer. It exposes the same signature as engine.orchestrate,
 * so the server change is one line:
 *
 *   const conversation = createConversation({ engine, resolvePlace, llmClassify, findLatestBooking, logger });
 *   const result = await conversation.orchestrate(prompt, agencyId, context);
 */
function createConversation(opts = {}) {
  const engine = opts.engine;
  if (!engine || typeof engine.orchestrate !== 'function') throw new Error('createConversation: engine.orchestrate is required');

  const deps = {
    now: opts.now || (() => new Date()),
    ttlMs: opts.ttlMs ?? 20 * 60 * 1000,
    resolvePlace: opts.resolvePlace || null,
    llmClassify: opts.llmClassify || null,
    findLatestBooking: opts.findLatestBooking || null,
    events: opts.events || loadEvents(),
    logger: opts.logger || NOOP_LOGGER,
    agencyName: opts.agencyName || null,
  };

  const inflight = new Map(); // idempotency: messageId -> { t, promise }

  function pickPackages(ctx, params) {
    const c = ctx.lastPackages || params?._lastPackages || params?._lastFlightPackages;
    return Array.isArray(c) ? c : [];
  }

  async function findBooking(ctx, conv, params, agencyId) {
    if (ctx.bookingRef) return { ref: String(ctx.bookingRef), status: ctx.bookingStatus };
    if (conv.lastBooking?.ref) return conv.lastBooking;
    if (conv.lastBookingRef) return { ref: conv.lastBookingRef };
    if (params?._bookingRef) return { ref: params._bookingRef };
    if (deps.findLatestBooking) {
      try {
        const b = await deps.findLatestBooking({ agencyId, phone: ctx.phone || null, sessionKey: ctx.sessionKey || ctx.sessionId || null });
        if (b?.ref) return b;
      } catch (err) { deps.logger.warn('conv: findLatestBooking failed', { error: err.message }); }
    }
    const texts = [
      ...(Array.isArray(ctx.transcript) ? ctx.transcript : []),
      ...(Array.isArray(ctx.conversationHistory) ? ctx.conversationHistory.map((m) => m?.content) : []),
    ].filter((x) => typeof x === 'string');
    for (let i = texts.length - 1; i >= 0; i--) {
      const hits = texts[i].match(REF_RX);
      if (hits) return { ref: hits[hits.length - 1].toUpperCase() };
    }
    return null;
  }

  function build({ prompt, agencyId, ctx, text, params, conv, handledBy, needsClarification = false }) {
    const history = [
      ...(Array.isArray(ctx.conversationHistory) ? ctx.conversationHistory : []),
      { role: 'user', content: prompt },
      { role: 'assistant', content: text },
    ].slice(-10);
    return {
      sessionId: randomUUID(),
      text,
      packages: [],
      keepExistingPackages: true, // front end: do NOT clear the option cards for conversational replies
      isConversational: true,
      needsClarification,
      tripParams: { ...(params || {}), ...(agencyId ? { agencyId } : {}), _conv: conv },
      intent: null,
      conversationHistory: history,
      generatedAt: new Date().toISOString(),
      handledBy,
    };
  }

  async function toEngine({ text, prompt, agencyId, ctx, params, conv, now, tag }) {
    const { _conv, ...rest } = params || {};
    const passParams = hasEngineState(rest) ? rest : null;
    try {
      const res = await engine.orchestrate(text, agencyId, { ...ctx, previousParams: passParams });
      const out = res?.tripParams || passParams || null;
      const p = P.derivePending(out);
      // stamp _lastConfirmedOrigin so future "yes" answers to origin questions resolve correctly
      const confirmedOrigin = out?.origin || passParams?.origin || null;
      const newConv = { ...conv, pendingMeta: p ? { type: p.type, askedAt: now.getTime(), misses: 0 } : null };
      const outParams = { ...(out || {}), ...(agencyId ? { agencyId } : {}), _conv: newConv };
      if (confirmedOrigin) outParams._lastConfirmedOrigin = confirmedOrigin;
      return { ...res, tripParams: outParams, handledBy: 'engine', _route: tag };
    } catch (err) {
      deps.logger.error('conv: engine call failed', { tag, error: err.message });
      return build({
        prompt, agencyId, ctx, params, conv, handledBy: 'fallback',
        text: `Sorry, I hit a snag on my side. Could you send that again? If it keeps happening, tell me in one line where you're flying from, where to, and when.`,
      });
    }
  }

  async function route(prompt, agencyId, ctx, now) {
    const prev = ctx.previousParams || null;
    const msg = clean(prompt);
    const conv = { ...(prev?._conv || {}) };
    if (ctx.userName && !conv.name) conv.name = ctx.userName;

    // 1. what are we waiting for, and has it gone stale?
    let pending = P.derivePending(prev);
    let meta = conv.pendingMeta || null;
    if (pending) {
      if (!meta || meta.type !== pending.type) meta = { type: pending.type, askedAt: now.getTime(), misses: 0 };
      if (now.getTime() - meta.askedAt > deps.ttlMs) {
        deps.logger.info('conv: pending expired', { type: pending.type });
        pending = null; meta = null;
      }
    } else meta = null;
    const params = prev ? (pending ? prev : P.stripFlags(prev)) : null;
    const hasTrip = !!(params && (params.destination || params.trips));
    const packages = pickPackages(ctx, params);
    const refresh = () => (meta ? { ...meta, askedAt: now.getTime() } : null);
    const baseConv = (m) => ({ ...conv, pendingMeta: m });

    // 2. classify (rules first, optional LLM only for "unclear")
    let cls = classify(msg, { hasTrip, hasPackages: packages.length > 0, events: deps.events, now });
    if (cls.intent === 'unclear' && deps.llmClassify && words(msg).length >= 3) {
      try {
        const label = await deps.llmClassify(msg, { pending, hasTrip });
        const mapped = label === 'smalltalk' ? 'ack' : label;
        if (mapped && mapped !== 'unclear' && LABELS.has(mapped)) cls = { intent: mapped, via: 'llm', topic: mapped === 'info_general' ? 'other' : undefined };
      } catch (err) { deps.logger.warn('conv: llmClassify failed', { error: err.message }); }
    }
    deps.logger.info('conv.route', { intent: cls.intent, via: cls.via || 'rules', pending: pending?.type || null, hasTrip });

    const reply = (text, handledBy, { keepPending = true, paramsOverride, convOverride, needsClarification } = {}) => {
      let out = text;
      const q = keepPending && pending ? P.questionFor(pending, params) : null;
      const skipReask = pending?.type === 'hotel_followup' && (cls.intent === 'order_lookup' || cls.intent === 'payment_help');
      if (q && !skipReask) out = `${text}\n\nBack to your trip: ${q}`;
      return build({
        prompt, agencyId, ctx, text: out, handledBy,
        params: paramsOverride || params,
        conv: convOverride || baseConv(keepPending ? refresh() : null),
        needsClarification: needsClarification ?? !!(q && !skipReask),
      });
    };

    const delegate = (text, tag, useParams = params) => toEngine({ text, prompt, agencyId, ctx, params: useParams, conv, now, tag });

    const miss = (rejectText) => {
      const n = (meta?.misses || 0) + 1;
      if (n > MAX_MISSES) {
        return build({
          prompt, agencyId, ctx, handledBy: 'miss_reset', params: P.stripFlags(params), conv: baseConv(null),
          text: `No worries, let's start fresh. Tell me where you're flying from, where to, and roughly when. For example "Nairobi to Mombasa, 20 Oct".`,
        });
      }
      const q = P.questionFor(pending, params);
      const text = rejectText || MISS_TEXT[Math.min(n - 1, MISS_TEXT.length - 1)](q);
      return build({
        prompt, agencyId, ctx, handledBy: 'miss', params, text, needsClarification: true,
        conv: baseConv({ ...meta, askedAt: now.getTime(), misses: n }),
      });
    };

    // 3. empty / unusable
    if (!msg) return pending ? miss() : reply(H.helpText(deps.agencyName), 'help', { keepPending: false });

    // 4. strong, precise intents win over any pending question (and then re-ask it)
    switch (cls.intent) {
      case 'order_lookup':
        return reply(H.orderText(await findBooking(ctx, conv, params, agencyId)), 'order_lookup');
      case 'payment_help':
        return reply(H.paymentText(await findBooking(ctx, conv, params, agencyId)), 'payment_help');
      case 'info_event': {
        const ev = findEvent(deps.events, msg);
        return reply(ev ? answerEvent(ev, msg) : H.generalInfoText('other'), 'info_event');
      }
      case 'info_general':
        return reply(H.generalInfoText(cls.topic), 'info_general');
      case 'quote_question':
        return reply(H.quoteText(msg, packages), 'quote_question');
      case 'help':
        return reply(H.helpText(deps.agencyName), 'help');
      case 'complaint': {
        const o = params?.origin ? await sanitizeOrigin(params.origin, { resolvePlace: deps.resolvePlace }) : null;
        const originBroken = hasTrip && (!params.origin || (o && !o.origin));
        // If we're waiting for origin and user complains about not knowing their origin, fall through to the helpful fix
        if (pending && !(pending.type === 'single_origin' && originBroken)) return reply(`Sorry about that, I clearly missed something.`, 'complaint');
        if (originBroken) {
          const fixed = { ...params, origin: null, needsOriginClarification: true, _awaitingClarification: { type: 'single_origin' } };
          const p2 = { type: 'single_origin' };
          return build({
            prompt, agencyId, ctx, handledBy: 'complaint_origin', params: fixed, needsClarification: true,
            text: `Sorry about that, you're right: I don't know where you're travelling from yet. ${P.questionFor(p2, fixed)}`,
            conv: baseConv({ type: 'single_origin', askedAt: now.getTime(), misses: 0 }),
          });
        }
        return reply(hasTrip ? `Sorry about that. What should I change: the dates, the places, or something else?` : `Sorry about that. Tell me where you'd like to go and where you're flying from, and I'll start fresh.`, 'complaint');
      }
      default: break;
    }

    // 5. is this the answer to the question we asked?
    if (pending) {
      const acc = await P.accepts(pending, msg, { now, params, resolvePlace: deps.resolvePlace });
      if (acc.ok) {
        deps.logger.info('conv: pending answered', { type: pending.type });
        return delegate(acc.delegateText, `pending:${pending.type}`);
      }
      if (acc.reject) return miss(acc.text);
    }

    // 6. everything else
    switch (cls.intent) {
      case 'greeting':
        if (ctx.channel === 'whatsapp' && !prev) return delegate(msg, 'greeting_whatsapp'); // engine restores saved trips
        return reply(H.greetingText(conv.name || extractName(msg.replace(/^(hi+|hello+|hey+)\s*/i, '')), hasTrip), 'greeting');
      case 'thanks':
        return reply(`You're welcome!${pending ? '' : hasTrip ? ' Let me know if you want to change anything.' : ''}`, 'thanks');
      case 'bye':
        return reply(`Safe travels! Come back any time.`, 'bye', { keepPending: false });
      case 'ack':
        return pending ? reply('Sure.', 'ack') : reply(hasTrip ? `Great. Pick an option above, or tell me what to change.` : `What would you like to do next? Tell me where you're flying from, where to, and roughly when.`, 'ack');
      case 'trip_request':
        return delegate(msg, 'trip_request', P.stripFlags(params)); // new/changed trip: pending question is dropped
      case 'trip_vague':
        return pending ? miss() : delegate(msg, 'trip_vague', params);
      default: // unclear
        if (pending) return miss();
        return reply(hasTrip ? `I didn't quite get that. You can ask about your options, or tell me what to change (dates, nights, budget).` : H.helpText(deps.agencyName), 'unclear', { keepPending: false });
    }
  }

  async function orchestrate(prompt, agencyId, context = {}) {
    const ctx = context || {};
    if (ctx.skipParsing) return engine.orchestrate(prompt, agencyId, ctx); // internal flows bypass the layer
    const now = deps.now();
    const run = async () => {
      try {
        return await route(prompt, agencyId, ctx, now);
      } catch (err) {
        deps.logger.error('conv: route failed', { error: err.message, stack: err.stack });
        return build({
          prompt: String(prompt ?? ''), agencyId, ctx, handledBy: 'fallback',
          params: ctx.previousParams ? { ...ctx.previousParams } : null, conv: { ...(ctx.previousParams?._conv || {}) },
          text: `Sorry, I hit a snag on my side. Could you send that again?`,
        });
      }
    };

    const key = ctx.messageId ? `${ctx.sessionKey || ctx.phone || agencyId}:${ctx.messageId}` : null;
    if (!key) return run();
    const hit = inflight.get(key);
    if (hit && now.getTime() - hit.t < 60000) return hit.promise;
    const promise = run();
    inflight.set(key, { t: now.getTime(), promise });
    if (inflight.size > 500) {
      for (const [k, v] of inflight) if (now.getTime() - v.t > 60000) inflight.delete(k);
    }
    return promise;
  }

  return { orchestrate, converse: orchestrate };
}

/**
 * Call from your booking/hold route right after a reference is created or its payment status changes.
 * Clears any stale yes/no prompt and stores the reference so "what's my order reference?" always works.
 *   status: 'held_unpaid' | 'payment_failed' | 'paid' | 'confirmed'
 */
function recordBooking(params, { ref, status, total, currency } = {}, now = new Date()) {
  const base = P.stripFlags(params || {});
  const conv = {
    ...(base._conv || {}),
    lastBookingRef: ref,
    lastBooking: { ref, status, total, currency, at: now.toISOString() },
    pendingMeta: null,
  };
  return { ...base, _conv: conv };
}

module.exports = { createConversation, recordBooking, extractName, guardParsePrompt, sanitizeOrigin };
