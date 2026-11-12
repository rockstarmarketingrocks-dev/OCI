// fetch wrapper. Throws Error(message) with .status on non-2xx.
export async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    if (typeof body === 'string') { opts.body = body; opts.headers['content-type'] = 'text/csv'; }
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data?.error || res.statusText); e.status = res.status; throw e; }
  return data;
}
export const get = u => api('GET', u), post = (u, b) => api('POST', u, b ?? {}), put = (u, b) => api('PUT', u, b), patch = (u, b) => api('PATCH', u, b), del = u => api('DELETE', u);
