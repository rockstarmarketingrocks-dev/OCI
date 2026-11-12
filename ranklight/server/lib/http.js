// Shared HTTP helpers for feature modules.
export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const httpError = (status, message, details) => new HttpError(status, message, details);

export function requireAuth(req, _res, next) {
  if (!req.user) return next(httpError(401, 'Authentication required'));
  next();
}

// Throws 404 unless the domain exists and belongs to req.user. Returns the domain row.
export function loadOwnedDomain(db, req, domainId) {
  const d = db.prepare('SELECT * FROM domains WHERE id = ? AND user_id = ?').get(Number(domainId), req.user.id);
  if (!d) throw httpError(404, 'Domain not found');
  return d;
}
// Throws 404 unless the keyword exists and its domain belongs to req.user. Returns the keyword row.
export function loadOwnedKeyword(db, req, keywordId) {
  const k = db.prepare(`SELECT k.* FROM keywords k JOIN domains d ON d.id = k.domain_id
                        WHERE k.id = ? AND d.user_id = ?`).get(Number(keywordId), req.user.id);
  if (!k) throw httpError(404, 'Keyword not found');
  return k;
}

export function parseJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

export function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error', details: err.details });
}
