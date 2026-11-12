// Account settings (profile, password, sessions, account deletion) and the offline demo-data generator.
// Emits 'domain:created' { domainId, userId } and 'ranks:updated' { domainId, keywordIds, checkedAt } after loading demo data.
// Deliberately does NOT emit 'keywords:added' so rank/volume refresh jobs do not overwrite the generated history.
import { httpError, requireAuth } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { tx } from '../db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PREFIX_RE = /^[a-f0-9]{8,64}$/;
export const DEMO_HOST = 'demo-outdoors.com';

const body = req => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw httpError(400, 'JSON body required');
  return req.body;
};
const prefixOf = token => token.slice(0, 12);
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, createdAt: u.created_at });

function checkPassword(db, userId, pw) {
  if (typeof pw !== 'string' || !pw) throw httpError(400, 'Password is required');
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
  if (!verifyPassword(pw, password_hash)) throw httpError(403, 'Password is incorrect');
}

// ---------------- Demo data generator ----------------

// Small seeded PRNG (mulberry32) so a given seed always yields the same demo dataset.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());

const TAGS = [
  { name: 'Tents & Shelter', color: '#2f5bea' }, { name: 'Sleep Systems', color: '#9b51e0' },
  { name: 'Packs', color: '#12a150' }, { name: 'Guides', color: '#c27c0e' },
];
// [phrase, tag index, monthly volume, cpc, base rank (null = mostly unranked), page path, SERP features]
const PHRASES = [
  ['best backpacking tent', 0, 33100, 1.85, 7, '/tents/backpacking', ['people_also_ask', 'image_pack', 'video', 'shopping']],
  ['ultralight tent 2 person', 0, 8100, 1.42, 4, '/tents/ultralight-2p', ['shopping', 'people_also_ask', 'image_pack']],
  ['4 season tent', 0, 6600, 1.21, 15, '/tents/four-season', ['people_also_ask', 'video']],
  ['camping tarp shelter', 0, 2900, 0.88, 22, '/tents/tarps', ['image_pack', 'shopping']],
  ['how to pitch a tent in the rain', 0, 1300, 0.12, 3, '/guides/pitch-tent-rain', ['featured_snippet', 'video', 'people_also_ask']],
  ['down sleeping bag', 1, 12100, 1.66, 9, '/sleep/down-bags', ['shopping', 'people_also_ask', 'image_pack']],
  ['sleeping bag temperature rating', 1, 4400, 0.35, 2, '/guides/temperature-ratings', ['featured_snippet', 'people_also_ask', 'faq']],
  ['inflatable sleeping pad', 1, 9900, 1.12, 12, '/sleep/pads', ['shopping', 'reviews', 'image_pack']],
  ['quilt vs sleeping bag', 1, 2400, 0.28, 5, '/guides/quilt-vs-bag', ['featured_snippet', 'people_also_ask', 'video']],
  ['camping pillow', 1, 14800, 0.74, 31, '/sleep/pillows', ['shopping', 'image_pack', 'ads_top']],
  ['hiking backpack 50l', 2, 5400, 1.38, 11, '/packs/50l', ['shopping', 'image_pack', 'reviews']],
  ['best daypack for hiking', 2, 18100, 1.27, 18, '/packs/daypacks', ['people_also_ask', 'shopping', 'video', 'ads_top']],
  ['womens backpacking pack', 2, 3600, 1.49, 26, '/packs/womens', ['shopping', 'image_pack']],
  ['how to pack a backpack', 2, 6600, 0.09, 6, '/guides/pack-a-backpack', ['featured_snippet', 'video', 'people_also_ask', 'image_pack']],
  ['frameless backpack', 2, 1600, 0.97, 44, '/packs/frameless', ['shopping', 'related_searches']],
  ['thru hiking gear list', 3, 4400, 0.41, 8, '/guides/thru-hike-gear-list', ['people_also_ask', 'video', 'ai_overview']],
  ['leave no trace principles', 3, 22200, 0.05, 63, '/guides/leave-no-trace', ['knowledge_panel', 'people_also_ask', 'top_stories']],
  ['camping checklist', 3, 27100, 0.33, 14, '/guides/camping-checklist', ['featured_snippet', 'people_also_ask', 'image_pack', 'ai_overview']],
  ['outdoor gear store near me', 3, 40500, 2.1, null, '/stores', ['local_pack', 'ads_top', 'reviews']],
  ['demo outdoors', 3, 880, 0.4, 1, '/', ['sitelinks', 'knowledge_panel', 'reviews']],
];
const COMPETITORS = [
  { host: 'trailpeak-gear.com', display_name: 'Trailpeak Gear' },
  { host: 'summitsupply.co', display_name: 'Summit Supply Co' },
];
const FILLER_HOSTS = ['wildtrail-journal.com', 'campcraft-reviews.com', 'peakbound.net', 'thehikinglog.org', 'basecamp-outfitters.com',
  'alpinehowto.com', 'kitbench-tests.com', 'riverbend-sports.com', 'forums.trailtalk.org', 'packlight-guides.com', 'northridge-supply.com',
  'camping-wiki.org', 'gearswap-market.com', 'backcountry-notes.net', 'outsidemag-daily.com', 'video.streamhub.tv'];
const TOP_N = 20;  // results JSON keeps the top 20 plus any deeper positions of the domain and its competitors

// One rank walk per (keyword, host): mean-reverting random walk with an optional drift, clamped to 1..100, null beyond.
function walk(rand, base, days, drift) {
  const out = []; let r = base ?? 70 + rand() * 40;
  for (let i = 0; i < days; i++) {
    const target = (base ?? 95) - drift * i;
    r += (target - r) * 0.12 + (rand() - 0.5) * Math.max(1.2, r * 0.12);
    if (rand() < 0.02) r += (rand() - 0.4) * 12;  // occasional algorithm-update jolt
    r = Math.max(1, r);
    out.push(r > 100 ? null : Math.round(r));
  }
  return out;
}

// Creates (or with replace=true recreates) the demo domain for userId. Returns { domainId, keywordIds, snapshots, checkedAt }.
export function generateDemoData(db, userId, { days = 90, seed = 42, now = new Date(), replace = false } = {}) {
  const rand = rng(seed);
  const existing = db.prepare('SELECT id FROM domains WHERE user_id = ? AND host = ?').get(userId, DEMO_HOST);
  if (existing && !replace) throw httpError(409, 'Demo data is already loaded', { domainId: existing.id });
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0));
  const dates = Array.from({ length: days }, (_, i) => new Date(end.getTime() - (days - 1 - i) * 864e5).toISOString());

  return tx(db, () => {
    if (existing) db.prepare('DELETE FROM domains WHERE id = ?').run(existing.id);
    const domainId = Number(db.prepare(`INSERT INTO domains(user_id, host, display_name, group_name, created_at) VALUES (?,?,?,?,?)`)
      .run(userId, DEMO_HOST, 'Demo Outdoors', 'Demo', dates[0].slice(0, 19).replace('T', ' ')).lastInsertRowid);
    const addComp = db.prepare('INSERT INTO competitors(domain_id, host, display_name) VALUES (?,?,?)');
    for (const c of COMPETITORS) addComp.run(domainId, c.host, c.display_name);
    const addTag = db.prepare('INSERT INTO tags(domain_id, name, color) VALUES (?,?,?)');
    const tagIds = TAGS.map(t => Number(addTag.run(domainId, t.name, t.color).lastInsertRowid));

    const addKw = db.prepare(`INSERT INTO keywords(domain_id, phrase, device, search_volume, cpc, starred, preferred_url, created_at) VALUES (?,?,?,?,?,?,?,?)`);
    const addKwTag = db.prepare('INSERT INTO keyword_tags(keyword_id, tag_id) VALUES (?,?)');
    const addSnap = db.prepare(`INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url, serp_features, owned_features, results, above_the_fold, pixels_from_top)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const keywordIds = []; let snapshots = 0;

    for (const [phrase, tagIdx, volume, cpc, baseRank, page, features] of PHRASES) {
      for (const device of ['desktop', 'mobile']) {
        const mobile = device === 'mobile';
        const vol = Math.round(volume * (mobile ? 0.62 : 0.38) / 10) * 10;
        const kwId = Number(addKw.run(domainId, phrase, device, vol, cpc, baseRank && baseRank <= 5 ? 1 : 0,
          `https://${DEMO_HOST}${page}`, dates[0].slice(0, 19).replace('T', ' ')).lastInsertRowid);
        keywordIds.push(kwId);
        addKwTag.run(kwId, tagIds[tagIdx]);

        const base = baseRank == null ? null : baseRank + (mobile ? Math.round((rand() - 0.5) * 4) : 0);
        const drift = baseRank == null ? 0 : (rand() - 0.35) * (base > 10 ? 0.15 : 0.03);  // most keywords trend up slowly
        const own = walk(rand, base, days, drift);
        const comps = COMPETITORS.map(() => walk(rand, Math.round(2 + rand() * 30), days, (rand() - 0.5) * 0.06));
        const fillers = [...FILLER_HOSTS].sort(() => rand() - 0.5);
        const altPage = `https://${DEMO_HOST}/blog/${slug(phrase)}`;

        dates.forEach((checkedAt, d) => {
          // Slot the tracked domain and competitors first, resolving collisions by pushing down.
          const taken = new Map();
          const place = (pos, entry) => { if (pos == null) return null; while (taken.has(pos)) pos++; if (pos > 100) return null; taken.set(pos, entry); return pos; };
          const url = rand() < 0.06 ? altPage : `https://${DEMO_HOST}${page}`;
          const rank = place(own[d], { host: DEMO_HOST, url, title: `${titleCase(phrase)} | Demo Outdoors` });
          COMPETITORS.forEach((c, i) => place(comps[i][d], { host: c.host, url: `https://${c.host}/${slug(phrase)}`, title: `${titleCase(phrase)} - ${c.display_name}` }));
          const results = [];
          for (let pos = 1, f = 0; pos <= TOP_N; pos++) {
            const hit = taken.get(pos);
            if (hit) { results.push({ position: pos, url: hit.url, host: hit.host, title: hit.title, type: 'organic' }); continue; }
            const host = fillers[f++ % fillers.length];
            results.push({ position: pos, url: `https://${host}/${slug(phrase)}${f > fillers.length ? '-' + pos : ''}`, host, title: `${titleCase(phrase)}: ${host.split('.')[0].replace(/-/g, ' ')}`, type: 'organic' });
          }
          for (const [pos, hit] of [...taken].filter(([p]) => p > TOP_N).sort((a, b) => a[0] - b[0]))
            results.push({ position: pos, url: hit.url, host: hit.host, title: hit.title, type: 'organic' });

          const serp = features.filter(() => rand() > 0.08);
          const owned = [];
          if (rank != null && rank <= 3 && serp.includes('featured_snippet') && rand() < 0.7) owned.push('featured_snippet');
          if (rank === 1 && serp.includes('sitelinks')) owned.push('sitelinks');
          if (rank != null && rank <= 10 && serp.includes('image_pack') && rand() < 0.3) owned.push('image_pack');
          const pixels = rank == null ? null : Math.round(rank * (mobile ? 140 : 105) + serp.length * (mobile ? 90 : 60) + rand() * 40);
          addSnap.run(kwId, checkedAt, rank, rank == null ? null : url, JSON.stringify(serp), JSON.stringify(owned), JSON.stringify(results),
            pixels == null ? null : pixels <= (mobile ? 640 : 760) ? 1 : 0, pixels);
          snapshots++;
        });
      }
    }
    return { domainId, keywordIds, snapshots, checkedAt: dates.at(-1) };
  });
}

// ---------------- Module ----------------

export default {
  name: 'account',
  router({ db, express, events }) {
    const r = express.Router();
    r.use(requireAuth);
    const me = req => db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    r.get('/', (req, res) => {
      const stats = db.prepare(`SELECT COUNT(DISTINCT d.id) AS domains, COUNT(k.id) AS keywords FROM domains d
        LEFT JOIN keywords k ON k.domain_id = d.id WHERE d.user_id = ?`).get(req.user.id);
      const demo = db.prepare('SELECT id FROM domains WHERE user_id = ? AND host = ?').get(req.user.id, DEMO_HOST);
      res.json({ user: publicUser(me(req)), stats: { ...stats }, demoDomainId: demo?.id ?? null });
    });

    r.patch('/profile', (req, res) => {
      const b = body(req), sets = {};
      if (b.name !== undefined) {
        if (typeof b.name !== 'string' || b.name.trim().length > 100) throw httpError(400, 'name must be a string of at most 100 characters');
        sets.name = b.name.trim();
      }
      if (b.email !== undefined) {
        const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
        if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, 'A valid email address is required');
        if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) throw httpError(409, 'Email already registered');
        sets.email = email;
      }
      const cols = Object.keys(sets);
      if (!cols.length) throw httpError(400, 'Nothing to update: send name and/or email');
      db.prepare(`UPDATE users SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(c => sets[c]), req.user.id);
      res.json({ user: publicUser(me(req)) });
    });

    // Changing the password signs out every other session.
    r.post('/password', (req, res) => {
      const { current, next } = body(req);
      checkPassword(db, req.user.id, current);
      if (typeof next !== 'string' || next.length < 8) throw httpError(400, 'New password must be at least 8 characters');
      if (next.length > 200) throw httpError(400, 'New password must be at most 200 characters');
      if (next === current) throw httpError(400, 'New password must differ from the current one');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
      const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken ?? '');
      res.json({ ok: true, revokedSessions: Number(changes) });
    });

    r.get('/sessions', (req, res) => {
      const rows = db.prepare('SELECT token, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC')
        .all(req.user.id, new Date().toISOString());
      res.json(rows.map(s => ({ prefix: prefixOf(s.token), createdAt: s.created_at, expiresAt: s.expires_at, current: s.token === req.sessionToken })));
    });

    // Revoke every session except the current one.
    r.delete('/sessions', (req, res) => {
      const { changes } = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken ?? '');
      res.json({ ok: true, revoked: Number(changes) });
    });

    r.delete('/sessions/:prefix', (req, res) => {
      const prefix = String(req.params.prefix).toLowerCase();
      if (!PREFIX_RE.test(prefix)) throw httpError(400, 'Session prefix must be 8+ hex characters');
      const matches = db.prepare('SELECT token FROM sessions WHERE user_id = ? AND substr(token, 1, ?) = ?').all(req.user.id, prefix.length, prefix);
      if (!matches.length) throw httpError(404, 'Session not found');
      if (matches.length > 1) throw httpError(409, 'Prefix matches several sessions; use a longer prefix');
      if (matches[0].token === req.sessionToken) throw httpError(400, 'Cannot revoke the current session; log out instead');
      db.prepare('DELETE FROM sessions WHERE token = ?').run(matches[0].token);
      res.json({ ok: true });
    });

    r.delete('/', (req, res) => {
      checkPassword(db, req.user.id, (req.body && typeof req.body === 'object' ? req.body : {}).password);
      try { db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id); }
      catch (e) { throw httpError(409, `Account could not be deleted: ${e.message}`); }
      res.setHeader('Set-Cookie', 'rl_session=; Path=/; Max-Age=0');
      res.json({ ok: true });
    });

    r.post('/demo', (req, res) => {
      const replace = req.body?.replace === true;
      const out = generateDemoData(db, req.user.id, { replace, seed: (req.user.id * 7919) % 100000 + 1 });
      const emit = (name, payload) => { try { events.emit(name, payload); } catch (e) { console.warn(`[account] ${name} listener failed: ${e.message}`); } };
      emit('domain:created', { domainId: out.domainId, userId: req.user.id });
      emit('ranks:updated', { domainId: out.domainId, keywordIds: out.keywordIds, checkedAt: out.checkedAt });
      res.status(201).json({ domainId: out.domainId, host: DEMO_HOST, keywords: out.keywordIds.length, competitors: COMPETITORS.length, tags: TAGS.length, snapshots: out.snapshots });
    });

    return r;
  },
};
