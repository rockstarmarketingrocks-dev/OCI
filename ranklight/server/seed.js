// Seed CLI: creates demo@ranklight.local / demo12345 (or resets its password) and (re)generates the demo domain.
// Usage: npm run seed   (honors DB_PATH)
import { openDb } from './db.js';
import { hashPassword } from './lib/auth.js';
import { generateDemoData, DEMO_HOST } from './modules/account.js';

const EMAIL = 'demo@ranklight.local', PASSWORD = 'demo12345';
const db = openDb();
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
const userId = existing
  ? (db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(PASSWORD), existing.id), existing.id)
  : Number(db.prepare('INSERT INTO users(email, name, password_hash) VALUES (?,?,?)').run(EMAIL, 'Demo User', hashPassword(PASSWORD)).lastInsertRowid);
const out = generateDemoData(db, userId, { replace: true });
console.log(`Seeded ${DEMO_HOST}: ${out.keywordIds.length} keywords, ${out.snapshots} snapshots.`);
console.log(`Log in with ${EMAIL} / ${PASSWORD}`);
db.close();
