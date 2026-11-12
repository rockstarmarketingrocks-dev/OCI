// Rank refresh engine: fetches SERPs through ctx.provider, writes rank_snapshots, runs periodic jobs,
// a built-in daily refresh of all non-paused domains, and refreshes newly added keywords right away.
import { httpError, requireAuth, loadOwnedDomain } from '../lib/http.js';
import { hostMatches } from '../lib/metrics.js';
import { tx } from '../db.js';

const TICK_MS = 60_000;
const MAX_KEYWORDS = 5000;
const MAX_BACKFILL_DAYS = 365;
const REFRESH_HOUR = Math.min(23, Math.max(0, Number(process.env.RL_REFRESH_HOUR_UTC) || 0)); // daily refresh opens at this UTC hour

// Rough SERP layout model used for the above-the-fold heuristic (pixel heights).
const LAYOUT = {
  desktop: { header: 180, row: 110, fold: 900 },
  mobile: { header: 140, row: 150, fold: 700 },
};
const TOP_BLOCKS = { ads_top: 380, ai_overview: 450, featured_snippet: 320, local_pack: 380, top_stories: 320, shopping: 260 };
const MID_BLOCKS = { people_also_ask: 260, image_pack: 220, video: 300, twitter: 280 };   // usually injected after result 2
const MOBILE_ONLY = { knowledge_panel: 500 };                                              // side panel on desktop

const state = new WeakMap();   // ctx -> scheduler state (one per app instance)
const today = (now = new Date()) => now.toISOString().slice(0, 10);
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const timersDisabled = () => process.env.NODE_ENV === 'test' || process.env.RL_DISABLE_SCHEDULER === '1';

export function estimatePixels(rank, features, device = 'desktop') {
  if (rank == null) return null;
  const L = LAYOUT[device] || LAYOUT.desktop, f = new Set(features);
  let px = L.header + (rank - 1) * L.row;
  for (const [k, v] of Object.entries(TOP_BLOCKS)) if (f.has(k)) px += v;
  if (rank > 2) for (const [k, v] of Object.entries(MID_BLOCKS)) if (f.has(k)) px += v;
  if (device === 'mobile') for (const [k, v] of Object.entries(MOBILE_ONLY)) if (f.has(k)) px += v;
  return px;
}

// Derive the stored snapshot fields from a provider SERP for one keyword/domain.
export function analyzeSerp(serp, { host, includeSubdomains = true, device = 'desktop', ignoreLocalPack = false }) {
  const results = (Array.isArray(serp?.results) ? serp.results : []).map(r => ({
    position: Number(r.position), url: r.url ?? null, host: String(r.host || '').toLowerCase(), title: r.title ?? '', type: r.type || 'organic',
  })).filter(r => Number.isFinite(r.position));
  const features = [...new Set(Array.isArray(serp?.features) ? serp.features.map(String) : [])];
  const mine = results.filter(r => hostMatches(r.host, host, includeSubdomains) && !(ignoreLocalPack && r.type === 'local_pack'));
  const best = mine.reduce((a, r) => (!a || r.position < a.position ? r : a), null);
  const owned = [...new Set(mine.filter(r => r.type !== 'organic').map(r => r.type))];
  const rank = best && best.position >= 1 && best.position <= 100 ? best.position : null;
  const pixels = estimatePixels(rank, features, device);
  return {
    rank, url: rank ? best.url : null, features, owned, results, pixels,
    aboveFold: pixels == null ? null : pixels <= (LAYOUT[device] || LAYOUT.desktop).fold ? 1 : 0,
  };
}

function loadKeywords(db, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...db.prepare(`SELECT k.*, d.host AS domain_host, d.include_subdomains, d.exact_match FROM keywords k
      JOIN domains d ON d.id = k.domain_id WHERE k.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  return out;
}

async function fillVolumes(ctx, kws) {
  const groups = new Map();
  for (const k of kws) if (k.search_volume == null) {
    const key = `${k.country}|${k.language}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(k);
  }
  const upd = ctx.db.prepare('UPDATE keywords SET search_volume = ?, cpc = COALESCE(cpc, ?) WHERE id = ? AND search_volume IS NULL');
  for (const list of groups.values()) {
    try {
      const vols = await ctx.provider.fetchVolume([...new Set(list.map(k => k.phrase))], { country: list[0].country, language: list[0].language });
      for (const k of list) {
        const v = vols?.[k.phrase];
        if (v && Number.isFinite(Number(v.volume))) upd.run(Math.round(Number(v.volume)), Number.isFinite(Number(v.cpc)) ? Number(v.cpc) : null, k.id);
      }
    } catch { /* volume is best effort; ranks still get stored */ }
  }
}

// Fetch SERPs for keywords and store one snapshot each. Never throws for provider errors.
// opts.date: 'YYYY-MM-DD' (default today); opts.skipExisting: skip keywords that already have a snapshot that day
// (otherwise the same-day snapshot is replaced); opts.emit: emit 'ranks:updated' (default true).
export async function refreshKeywords(ctx, keywordIds, { date, skipExisting = false, emit = true, concurrency = 4 } = {}) {
  const ids = [...new Set((keywordIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  const now = new Date(), day = date || today(now);
  if (!isoDate(day)) throw new Error('refreshKeywords: date must be YYYY-MM-DD');
  const checkedAt = day === today(now) ? now.toISOString() : `${day}T06:00:00.000Z`;
  const summary = { date: day, checkedAt, requested: ids.length, checked: 0, skipped: 0, failed: 0, errors: [], byDomain: {} };
  if (!ctx.provider) return { ...summary, skipped: ids.length, reason: 'No rank provider configured' };
  const { db } = ctx;
  let kws = loadKeywords(db, ids);
  summary.skipped = ids.length - kws.length;
  if (skipExisting) {
    const has = db.prepare('SELECT 1 FROM rank_snapshots WHERE keyword_id = ? AND substr(checked_at,1,10) = ? LIMIT 1');
    const before = kws.length;
    kws = kws.filter(k => !has.get(k.id, day));
    summary.skipped += before - kws.length;
  }
  await fillVolumes(ctx, kws);

  const del = db.prepare('DELETE FROM rank_snapshots WHERE keyword_id = ? AND substr(checked_at,1,10) = ?');
  const ins = db.prepare(`INSERT INTO rank_snapshots(keyword_id, checked_at, rank, url, serp_features, owned_features, results, above_the_fold, pixels_from_top)
                          VALUES (?,?,?,?,?,?,?,?,?)`);
  const dom = id => (summary.byDomain[id] ||= { checked: 0, failed: 0, keywordIds: [] });
  let next = 0;
  const worker = async () => {
    while (next < kws.length) {
      const k = kws[next++];
      try {
        const serp = await ctx.provider.fetchSerp({ phrase: k.phrase, searchEngine: k.search_engine, device: k.device, country: k.country,
          location: k.location, language: k.language, date: day, hosts: [k.domain_host] });
        const a = analyzeSerp(serp, { host: k.domain_host, includeSubdomains: !!k.include_subdomains && !k.exact_match, device: k.device, ignoreLocalPack: !!k.ignore_local_pack });
        tx(db, () => {
          del.run(k.id, day);
          ins.run(k.id, checkedAt, a.rank, a.url, JSON.stringify(a.features), JSON.stringify(a.owned), JSON.stringify(a.results), a.aboveFold, a.pixels);
        });
        summary.checked++; dom(k.domain_id).checked++; dom(k.domain_id).keywordIds.push(k.id);
      } catch (e) {
        summary.failed++; dom(k.domain_id).failed++;
        if (summary.errors.length < 20) summary.errors.push({ keywordId: k.id, error: String(e?.message || e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, kws.length)) }, worker));
  if (emit) for (const [domainId, d] of Object.entries(summary.byDomain)) {
    if (d.keywordIds.length) ctx.events.emit('ranks:updated', { domainId: Number(domainId), keywordIds: d.keywordIds, checkedAt });
  }
  return summary;
}

// Backfill history: one snapshot per day for the `days` days before today (existing days are kept).
export async function backfillKeywords(ctx, keywordIds, days, { now = new Date() } = {}) {
  const totals = { days, checked: 0, skipped: 0, failed: 0, errors: [], byDomain: {} };
  if (!ctx.provider) return { ...totals, reason: 'No rank provider configured' };
  for (let i = days; i >= 1; i--) {
    const r = await refreshKeywords(ctx, keywordIds, { date: today(new Date(now.getTime() - i * 864e5)), skipExisting: true, emit: false });
    totals.checked += r.checked; totals.skipped += r.skipped; totals.failed += r.failed;
    totals.errors.push(...r.errors.slice(0, 20 - totals.errors.length));
    for (const [id, d] of Object.entries(r.byDomain)) {
      const t = (totals.byDomain[id] ||= { checked: 0, failed: 0, keywordIds: [] });
      t.checked += d.checked; t.failed += d.failed;
      for (const k of d.keywordIds) if (!t.keywordIds.includes(k)) t.keywordIds.push(k);
    }
  }
  const checkedAt = new Date().toISOString();
  for (const [domainId, d] of Object.entries(totals.byDomain)) {
    if (d.keywordIds.length) ctx.events.emit('ranks:updated', { domainId: Number(domainId), keywordIds: d.keywordIds, checkedAt });
  }
  return totals;
}

// ---- Serial job queue (per app instance) ----
function getState(ctx) {
  if (!state.has(ctx)) state.set(ctx, { queue: [], running: null, seq: 0, chain: Promise.resolve(), jobRuns: new Map(), jobsBusy: false, timer: null, nextTickAt: null });
  return state.get(ctx);
}

function enqueue(ctx, { kind, keywordIds, domainIds, days }) {
  const st = getState(ctx);
  const job = { id: ++st.seq, kind, keywordIds, domainIds, days: days ?? null, keywordCount: keywordIds.length, queuedAt: new Date().toISOString(), state: 'queued' };
  st.queue.push(job);
  const done = st.chain.then(async () => {
    st.queue.splice(st.queue.indexOf(job), 1);
    st.running = job; job.state = 'running'; job.startedAt = new Date().toISOString();
    const runIns = ctx.db.prepare('INSERT INTO scheduler_runs(domain_id, kind, started_at, keywords) VALUES (?,?,?,?)');
    const counts = new Map(domainIds.map(id => [id, 0]));
    for (const k of loadKeywords(ctx.db, keywordIds)) counts.set(k.domain_id, (counts.get(k.domain_id) || 0) + 1);
    const runIds = new Map();
    for (const [id, n] of counts) {
      if (ctx.db.prepare('SELECT 1 FROM domains WHERE id = ?').get(id)) runIds.set(id, Number(runIns.run(id, kind, job.startedAt, n).lastInsertRowid));
    }
    let result, error = null;
    try {
      result = kind === 'backfill' ? await backfillKeywords(ctx, keywordIds, days) : await refreshKeywords(ctx, keywordIds);
      if (result.reason) error = result.reason;
    } catch (e) { error = String(e?.message || e); result = { error }; }
    const fin = ctx.db.prepare('UPDATE scheduler_runs SET finished_at = ?, checked = ?, failed = ?, error = ? WHERE id = ?');
    const finishedAt = new Date().toISOString();
    for (const [id, runId] of runIds) {
      const d = result.byDomain?.[id] || { checked: 0, failed: 0 };
      fin.run(finishedAt, d.checked, d.failed, error || (d.failed ? `${d.failed} keyword check(s) failed` : null), runId);
    }
    st.running = null;
    return { jobId: job.id, kind, ...result };
  });
  st.chain = done.catch(() => {});
  return { job, done };
}

const domainBusy = (st, domainId, kind) => [st.running, ...st.queue].some(j => j && j.kind === kind && j.domainIds.includes(domainId));

// Keyword ids of non-paused domains that have no snapshot yet today.
function dueKeywords(db, now = new Date(), domainId = null) {
  return db.prepare(`SELECT k.id, k.domain_id FROM keywords k JOIN domains d ON d.id = k.domain_id
    WHERE d.paused = 0 ${domainId ? 'AND d.id = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM rank_snapshots s WHERE s.keyword_id = k.id AND s.checked_at >= ?)`)
    .all(...(domainId ? [domainId] : []), today(now));
}

// One scheduler tick: run due registered jobs and queue the daily refresh. Exported for tests and manual triggers.
export async function runDue(ctx, now = new Date()) {
  const st = getState(ctx), ran = [], queued = [];
  for (const [name, job] of ctx.jobs) {
    const every = Math.max(1, Number(job?.everyMinutes) || 60) * 60_000, last = st.jobRuns.get(name);
    if (typeof job?.run !== 'function' || (last && now - last.at < every) || last?.running) continue;
    st.jobRuns.set(name, { at: now.getTime(), running: true });
    try { await job.run(ctx); st.jobRuns.set(name, { at: now.getTime(), ok: true }); ran.push(name); }
    catch (e) { st.jobRuns.set(name, { at: now.getTime(), ok: false, error: String(e?.message || e) }); console.error(`[scheduler] job ${name} failed:`, e); }
  }
  if (ctx.provider && now.getUTCHours() >= REFRESH_HOUR) {
    const byDomain = new Map();
    for (const r of dueKeywords(ctx.db, now)) (byDomain.get(r.domain_id) || byDomain.set(r.domain_id, []).get(r.domain_id)).push(r.id);
    for (const [domainId, ids] of byDomain) {
      if (domainBusy(st, domainId, 'daily')) continue;
      queued.push(enqueue(ctx, { kind: 'daily', keywordIds: ids, domainIds: [domainId] }).done);
    }
  }
  return { ran, refreshes: await Promise.all(queued) };
}

// ---- Input validation ----
function posInt(v, name, max = Number.MAX_SAFE_INTEGER) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isInteger(n) || n < 1 || n > max) throw httpError(400, `${name} must be an integer between 1 and ${max}`);
  return n;
}
function ownedKeywordIds(db, req, raw) {
  if (!Array.isArray(raw) || !raw.length) throw httpError(400, 'keywordIds must be a non-empty array');
  if (raw.length > MAX_KEYWORDS) throw httpError(400, `At most ${MAX_KEYWORDS} keywordIds per request`);
  const ids = [...new Set(raw.map(v => posInt(v, 'keywordIds[]')))];
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...db.prepare(`SELECT k.id, k.domain_id FROM keywords k JOIN domains d ON d.id = k.domain_id
      WHERE d.user_id = ? AND k.id IN (${chunk.map(() => '?').join(',')})`).all(req.user.id, ...chunk));
  }
  if (rows.length !== ids.length) throw httpError(404, 'Keyword not found');
  return { keywordIds: ids, domainIds: [...new Set(rows.map(r => r.domain_id))] };
}
function targetFromBody(db, req) {
  const b = req.body || {};
  if (b.keywordIds != null) return ownedKeywordIds(db, req, b.keywordIds);
  if (b.domainId == null) throw httpError(400, 'Provide domainId or keywordIds');
  const d = loadOwnedDomain(db, req, posInt(b.domainId, 'domainId'));
  const keywordIds = db.prepare('SELECT id FROM keywords WHERE domain_id = ? ORDER BY id').all(d.id).map(r => r.id);
  return { keywordIds, domainIds: [d.id] };
}
const wantsWait = b => !(b?.wait === false || b?.wait === 'false' || b?.wait === 0);

function nextRunFor(db, st, domain, now = new Date()) {
  if (domain.paused || timersDisabled()) return null;
  const openAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), REFRESH_HOUR));
  if (now < openAt) return openAt.toISOString();
  if (dueKeywords(db, now, domain.id).length) return new Date(st.nextTickAt || now.getTime()).toISOString();
  return new Date(openAt.getTime() + 864e5).toISOString();
}

export default {
  name: 'scheduler',
  setup(ctx) {
    const st = getState(ctx);
    ctx.events.on('keywords:added', ({ keywordIds } = {}) => {
      if (!ctx.provider || !Array.isArray(keywordIds) || !keywordIds.length) return;
      setImmediate(() => {
        const rows = loadKeywords(ctx.db, keywordIds.map(Number)).filter(k => !ctx.db.prepare('SELECT paused FROM domains WHERE id = ?').get(k.domain_id)?.paused);
        if (!rows.length) return;
        enqueue(ctx, { kind: 'added', keywordIds: rows.map(k => k.id), domainIds: [...new Set(rows.map(k => k.domain_id))] })
          .done.catch(e => console.error('[scheduler] refresh of added keywords failed:', e));
      });
    });
    if (timersDisabled()) return;
    const tick = () => { st.nextTickAt = Date.now() + TICK_MS; runDue(ctx).catch(e => console.error('[scheduler] tick failed:', e)); };
    st.timer = setInterval(tick, TICK_MS);
    st.timer.unref?.();
    st.nextTickAt = Date.now() + TICK_MS;
    setTimeout(tick, 5000).unref?.();
  },
  router(ctx) {
    const { db, express } = ctx;
    const r = express.Router();
    r.use(requireAuth);

    // POST /api/scheduler/refresh {domainId} | {keywordIds}, optional wait:false to return 202 immediately.
    r.post('/refresh', async (req, res) => {
      const { keywordIds, domainIds } = targetFromBody(db, req);
      if (!ctx.provider) throw httpError(503, 'No rank provider is configured');
      if (!keywordIds.length) return res.json({ requested: 0, checked: 0, skipped: 0, failed: 0, errors: [] });
      const { job, done } = enqueue(ctx, { kind: 'manual', keywordIds, domainIds });
      if (!wantsWait(req.body)) { done.catch(() => {}); return res.status(202).json({ jobId: job.id, queued: keywordIds.length }); }
      const { byDomain, ...result } = await done;
      res.json(result);
    });

    // POST /api/scheduler/backfill {domainId, days} — one snapshot per past day.
    r.post('/backfill', async (req, res) => {
      const b = req.body || {};
      if (b.domainId == null) throw httpError(400, 'domainId is required');
      const d = loadOwnedDomain(db, req, posInt(b.domainId, 'domainId'));
      const days = posInt(b.days ?? 30, 'days', MAX_BACKFILL_DAYS);
      if (!ctx.provider) throw httpError(503, 'No rank provider is configured');
      const keywordIds = db.prepare('SELECT id FROM keywords WHERE domain_id = ? ORDER BY id').all(d.id).map(x => x.id);
      if (!keywordIds.length) return res.json({ days, checked: 0, skipped: 0, failed: 0, errors: [] });
      const { job, done } = enqueue(ctx, { kind: 'backfill', keywordIds, domainIds: [d.id], days });
      if (!wantsWait(b)) { done.catch(() => {}); return res.status(202).json({ jobId: job.id, queued: keywordIds.length * days }); }
      const { byDomain, ...result } = await done;
      res.json(result);
    });

    // GET /api/scheduler/status?domainId=
    r.get('/status', (req, res) => {
      const d = loadOwnedDomain(db, req, posInt(req.query.domainId, 'domainId'));
      const st = getState(ctx);
      const runs = db.prepare('SELECT * FROM scheduler_runs WHERE domain_id = ? ORDER BY started_at DESC, id DESC LIMIT 10').all(d.id);
      const kw = db.prepare(`SELECT COUNT(*) AS n, (SELECT MAX(s.checked_at) FROM rank_snapshots s JOIN keywords k2 ON k2.id = s.keyword_id
                             WHERE k2.domain_id = ?) AS last FROM keywords WHERE domain_id = ?`).get(d.id, d.id);
      const queue = [st.running, ...st.queue].filter(j => j && j.domainIds.includes(d.id))
        .map(({ id, kind, state, keywordCount, days, queuedAt, startedAt }) => ({ id, kind, state, keywordCount, days, queuedAt, startedAt: startedAt ?? null }));
      res.json({
        domainId: d.id, paused: !!d.paused, providerAvailable: !!ctx.provider, schedulerEnabled: !timersDisabled(),
        keywords: kw.n, lastCheckedAt: kw.last ?? null, dueKeywords: d.paused ? 0 : dueKeywords(db, new Date(), d.id).length,
        lastRun: runs[0] ?? null, recentRuns: runs, nextRun: nextRunFor(db, st, d), queue,
      });
    });
    return r;
  },
};
