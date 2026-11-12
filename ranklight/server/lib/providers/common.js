// Shared helpers for remote SERP adapters.
export const HTTP_TIMEOUT_MS = 60000;

export async function fetchJson(fetchImpl, url, init = {}) {
  const res = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`Provider HTTP ${res.status}: ${data?.status_message || data?.error || text.slice(0, 200)}`);
  return data;
}

export function hostFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export function countryName(code) {
  try { return regionNames.of(String(code || 'US').toUpperCase()) || 'United States'; } catch { return 'United States'; }
}

// Turn raw organic hits into contiguous 1..N positions (max 100), keeping provider order.
export function finalizeResults(items) {
  return items.filter(r => r.url).slice(0, 100).map((r, i) => ({
    position: i + 1, url: r.url, host: r.host || hostFromUrl(r.url), title: r.title || '', type: r.type || 'organic',
  }));
}
