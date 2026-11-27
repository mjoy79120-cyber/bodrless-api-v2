const { randomUUID } = require('node:crypto');


class TravelportError extends Error {
  constructor(msg, { status, body, traceId, endpoint, unknownOutcome = false } = {}) {
    super(msg);
    this.name = 'TravelportError';
    this.status = status;
    this.body = body;
    this.traceId = traceId;
    this.endpoint = endpoint;
    // true when we cannot know whether Travelport applied the call (timeout / network drop).
    // Callers MUST reconcile (retrieve) before retrying a mutating call.
    this.unknownOutcome = unknownOutcome;
  }
}

const SENSITIVE = /(password|secret|cvv|cvc|cardnumber|number|passport|authorization|token)/i;
function redact(v, depth = 0) {
  if (v == null || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = SENSITIVE.test(k) ? '[redacted]' : redact(x, depth + 1);
    return o;
  }
  return v;
}

class HttpClient {
  constructor({ env, tokens, fetchImpl = fetch, onCall = () => {}, timeoutMs = 30000 }) {
    this.env = env;
    this.tokens = tokens;
    this.fetch = fetchImpl;
    this.onCall = onCall; // hook: persist to supplier_calls (already redacted)
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param ctx   { creds, pcc?, accessGroup?, traceId?, sessionId? }  resolved SERVER-SIDE from the tenant, never from request input
   * @param opts  { method, path, base: 'air'|'root', body, query, headers, mutating }
   */
  async call(ctx, opts) {
    const traceId = ctx.traceId ?? randomUUID();
    const base = opts.base === 'root' ? this.env.rootBase : this.env.airBase;
    const url = new URL(opts.path.replace(/^\//, ''), base);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v != null) url.searchParams.set(k, String(v));

    let token = await this.tokens.getToken(ctx.creds);
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        TraceId: traceId,
        ...(ctx.accessGroup ? { XAUTH_TRAVELPORT_ACCESSGROUP: ctx.accessGroup } : {}),
        ...(ctx.pcc ? { 'TVP-PCC-Core': ctx.pcc } : {}),
        ...(ctx.sessionId ? { travelportPlusSessionIdentifier: ctx.sessionId } : {}),
        ...(opts.headers ?? {}),
      };
      try {
        res = await this.fetch(url, {
          method: opts.method ?? 'GET',
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        this.#log(ctx, opts, url, traceId, 0, Date.now() - started, opts.body);
        // Network error or timeout: outcome unknown for mutating calls.
        throw new TravelportError(`Network error calling ${opts.path}: ${e.name}`, {
          traceId, endpoint: opts.path, unknownOutcome: !!opts.mutating,
        });
      }
      this.#log(ctx, opts, url, traceId, res.status, Date.now() - started, opts.body);
      if (res.status === 401 && attempt === 0) {
        // Token rejected before the call was processed: safe to refresh once and retry, even for mutations.
        token = await this.tokens.getToken(ctx.creds, { force: true });
        continue;
      }
      break;
    }

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      throw new TravelportError(`Travelport ${res.status} on ${opts.method ?? 'GET'} ${opts.path}`, {
        status: res.status, body: json, traceId, endpoint: opts.path,
        // 5xx on a mutating call may or may not have been applied.
        unknownOutcome: !!opts.mutating && res.status >= 500,
      });
    }
    // Travelport can answer HTTP 200 with the failure inside the body: <Response>.Result.Error[]. Surface it so callers never treat it as success.
    const soft = json && typeof json === 'object' ? Object.values(json)[0]?.Result?.Error : null;
    const softErrors = Array.isArray(soft) ? soft.map((e) => ({ code: e.SourceCode || e.StatusCode, message: e.Message, category: e.category })) : [];
    return { data: json, traceId, status: res.status, softErrors, headers: Object.fromEntries(res.headers) };
  }

  #log(ctx, opts, url, traceId, status, ms, body) {
    try {
      this.onCall({
        tenantKey: ctx.creds.tenantKey, traceId, method: opts.method ?? 'GET',
        endpoint: url.pathname, status, latencyMs: ms, request: redact(body),
      });
    } catch { /* logging must never break a call */ }
  }
}

module.exports = { TravelportError, redact, HttpClient };
