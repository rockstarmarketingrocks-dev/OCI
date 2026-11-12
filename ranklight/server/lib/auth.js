// Core auth: scrypt password hashing + opaque session tokens in a cookie or Bearer header.
import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}
export function createSession(db, userId, days = 30) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + days * 864e5).toISOString();
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expires);
  return token;
}
function readCookie(req, name) {
  const c = req.headers.cookie || '';
  for (const part of c.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return decodeURIComponent(v.join('=')); }
  return null;
}
// Middleware: sets req.user if a valid session cookie or "Authorization: Bearer <token>" is present.
// Other modules (e.g. API keys) may also set req.user in their own middleware registered via ctx.authResolvers.
export function sessionMiddleware(db, resolvers) {
  return (req, _res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : readCookie(req, 'rl_session');
    if (token) {
      const row = db.prepare(`SELECT u.id, u.email, u.name, u.role, u.organization_id FROM sessions s JOIN users u ON u.id = s.user_id
                              WHERE s.token = ? AND s.expires_at > ?`).get(token, new Date().toISOString());
      if (row) { req.user = { ...row }; req.sessionToken = token; }
    }
    if (!req.user) for (const r of resolvers) { const u = r(req); if (u) { req.user = u; break; } }
    next();
  };
}
