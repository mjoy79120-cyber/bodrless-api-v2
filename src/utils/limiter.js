// utils/limiter.js — concurrency limiter, 429-aware retry, sliding-window budget

// Run at most `concurrency` jobs at once, starting jobs at least `minIntervalMs` apart.
function createLimiter({ concurrency = 3, minIntervalMs = 0 } = {}) {
  let active = 0, nextSlot = 0;
  const queue = [];
  const pump = () => {
    if (active >= concurrency || queue.length === 0) return;
    const job = queue.shift();
    active++;
    const startAt = Math.max(Date.now(), nextSlot);
    nextSlot = startAt + minIntervalMs;
    setTimeout(async () => {
      try { job.resolve(await job.fn()); }
      catch (e) { job.reject(e); }
      finally { active--; pump(); }
    }, startAt - Date.now());
    pump();
  };
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

// Honors Retry-After / ratelimit-reset (seconds or HTTP date), capped so we never stall a request.
function retryAfterMs(err, fallback = 1000, cap = 4000) {
  const h = err?.response?.headers || {};
  const v = h['retry-after'] ?? h['ratelimit-reset'];
  let ms = fallback;
  if (v != null) {
    if (/^\d+(\.\d+)?$/.test(String(v))) ms = Number(v) * 1000;
    else { const t = Date.parse(v); if (!isNaN(t)) ms = t - Date.now(); }
  }
  return Math.min(Math.max(ms, 250), cap);
}

async function withRetry(fn, { retries = 2, isRetryable = e => e?.response?.status === 429, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const wait = retryAfterMs(err, 1000 * (attempt + 1));
      if (onRetry) onRetry({ attempt: attempt + 1, wait, err });
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// "max calls per windowMs" — tryAcquire() returns false when out of budget (fail fast, don't wait)
function createWindowBudget(max, windowMs) {
  const stamps = [];
  return {
    tryAcquire() {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length >= max) return false;
      stamps.push(now);
      return true;
    },
  };
}

module.exports = { createLimiter, withRetry, retryAfterMs, createWindowBudget };