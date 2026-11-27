// OAuth2 password-grant token manager.
// Tokens last 24h: cache per credential set, refresh early, single-flight so
// concurrent callers never stampede the auth host.
class MemoryTokenStore {
  #m = new Map();
  async get(k) { return this.#m.get(k) ?? null; }
  async set(k, v) { this.#m.set(k, v); }
  async del(k) { this.#m.delete(k); }
}
// For production, implement the same get/set/del over Redis (value is JSON {token, expiresAt}).

const EARLY_REFRESH_MS = 5 * 60 * 1000;

class TokenManager {
  constructor({ authUrl, store = new MemoryTokenStore(), fetchImpl = fetch, now = () => Date.now() }) {
    this.authUrl = authUrl;
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    this.inflight = new Map();
  }

  // creds: { tenantKey, username, password, clientId, clientSecret, accessGroup }
  async getToken(creds, { force = false } = {}) {
    const key = `tp:token:${creds.tenantKey}`;
    if (!force) {
      const cached = await this.store.get(key);
      if (cached && cached.expiresAt - EARLY_REFRESH_MS > this.now()) return cached.token;
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = this.#fetchToken(creds, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async invalidate(creds) { await this.store.del(`tp:token:${creds.tenantKey}`); }

  async #fetchToken(creds, key) {
    // Travelport's documented token request is a JSON body (not form-encoded).
    const res = await this.fetch(this.authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        username: creds.username,
        password: creds.password,
        grant_type: 'password',
      }),
    });
    if (!res.ok) {
      // Never include the request body (it contains credentials) in errors.
      let reason = '';
      try { const j = await res.json(); reason = [j.error, j.error_description].filter(Boolean).join(': '); } catch { /* no body */ }
      throw new TravelportAuthError(`Token request failed with HTTP ${res.status}${reason ? ' - ' + reason : ''}`, res.status);
    }
    const j = await res.json();
    const ttlMs = (Number(j.expires_in) || 86400) * 1000;
    const rec = { token: j.access_token, expiresAt: this.now() + ttlMs };
    await this.store.set(key, rec);
    return rec.token;
  }
}

class TravelportAuthError extends Error {
  constructor(msg, status) { super(msg); this.name = 'TravelportAuthError'; this.status = status; }
}

module.exports = { MemoryTokenStore, TokenManager, TravelportAuthError };
