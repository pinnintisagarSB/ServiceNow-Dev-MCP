// Shared HTTP utility with timeout, 429 retry, and structured errors.
// Use in place of bare fetch() across all connectors.

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RETRIES        = 3;

export async function httpFetch(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl   = new AbortController();
    const timer  = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });

      // Respect 429 Retry-After
      if (res.status === 429 && attempt < retries) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '5', 10);
        await sleep(Math.min(retryAfter, 60) * 1000);
        continue;
      }
      // 5xx → exponential backoff retry
      if (res.status >= 500 && attempt < retries) {
        await sleep(Math.min(2 ** attempt, 30) * 1000);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError' || attempt >= retries) throw new Error(`HTTP ${url} failed: ${e.message}`);
      await sleep(Math.min(2 ** attempt, 30) * 1000);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr ?? new Error(`HTTP ${url} exhausted retries`);
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
