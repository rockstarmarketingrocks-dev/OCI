# Ranklight architecture and module contract

Ranklight is a self-hosted SEO keyword rank tracker. Node 22+, Express 5, built-in `node:sqlite`, no frontend framework or build step.

## Layout
- `server/app.js` core: auth routes (`/api/auth/*`), module loader, static files. Do not edit unless you are the integrator.
- `server/db.js` core schema (users, sessions, domains, keywords, rank_snapshots, tags, keyword_tags, competitors). Do not edit.
- `server/lib/http.js` HttpError, requireAuth, loadOwnedDomain, loadOwnedKeyword, parseJson.
- `server/lib/metrics.js` CTR curve, estimatedClicks, rankChange, latestRanks, snapshotDates, hostMatches, hostOf.
- `server/modules/<name>.js` one file per feature module, auto-mounted at `/api/<name>`.
- `server/migrations/<NNN>-<name>.sql` extra tables for a module. Use the number assigned to you. Use `CREATE TABLE IF NOT EXISTS`.
- `public/js/pages/<name>.js` one SPA page per file, auto-discovered.
- `public/js/ui.js`, `public/js/api.js` shared frontend helpers (esc, h, toast, table, modal, lineChart, kpi, fmtChange...).
- `tests/<name>.test.js` node:test tests per module. Use `startTestServer({ modules: ['<name>'] })` from `tests/helpers.js`.

## Module contract (server)
```js
export default {
  name: 'my-module',                // URL prefix /api/my-module, equals file basename
  setup(ctx) {},                    // optional; runs before any router is built
  router(ctx) { const r = ctx.express.Router(); /* routes */ return r; },
};
```
ctx = { db, express, events, authResolvers, jobs, provider }
- `db`: node:sqlite DatabaseSync. Synchronous: `db.prepare(sql).get/all/run(...)`. `run()` returns `{ changes, lastInsertRowid }` (lastInsertRowid may be BigInt-like, wrap in Number()). Rows are null-prototype objects (spread them before JSON if needed; res.json handles them).
- Express 5: async handlers may throw; errors go to the JSON error handler. Throw `httpError(status, msg)`.
- Always protect routes with `requireAuth` and scope data to `req.user.id` via `loadOwnedDomain` / `loadOwnedKeyword`.
- `events` (EventEmitter) conventions:
  - `ranks:updated` payload `{ domainId, keywordIds, checkedAt }` emitted after new rank_snapshots are written.
  - `keywords:added` payload `{ domainId, keywordIds }`.
  - `domain:created` payload `{ domainId, userId }`.
- `jobs`: `ctx.jobs.set('name', { everyMinutes, run: async (ctx) => {} })` registers a periodic job; the scheduler module runs them.
- `provider`: set by the rank-provider module in setup(). Interface:
  `await ctx.provider.fetchSerp({ phrase, searchEngine, device, country, location, language, date })`
  returns `{ results: [{position, url, host, title, type}], features: ['featured_snippet', ...], totalResults }`
  where `results` are the top 100 organic results and `type` is 'organic' or a feature id.
  `await ctx.provider.fetchVolume(phrases[], {country, language})` returns `{ [phrase]: { volume, cpc, competition, trend: number[12] } }`.
  Modules that need the provider must handle `ctx.provider == null` (tests that do not load rank-provider).

## SERP feature ids
featured_snippet, people_also_ask, local_pack, knowledge_panel, image_pack, video, top_stories, shopping, sitelinks, reviews, faq, twitter, ads_top, ads_bottom, related_searches, ai_overview

## Data semantics
- `rank_snapshots.rank` is the best organic position of the tracked domain (1..100) or NULL if not found.
- Rank change: positive = improvement. Use `rankChange(prev, curr)`.
- Dates are ISO UTC strings. Day buckets use `substr(checked_at,1,10)`.
- `results` JSON on a snapshot holds the full top-100 list so competitor ranks and SERP history can be derived.

## Frontend page contract
```js
export default { id: 'keywords', title: 'Keywords', group: 'Tracking', order: 20, nav: true, needsDomain: true,
  async render(el, ctx) {} };
```
ctx = { domainId, domain, domains, param, query, user, navigate, refreshDomains }. Route `#/<id>/<param>?<query>`.
Use CSS variables from `public/css/base.css` and the helpers in `ui.js`. Always escape user data with `esc()`. A page may add a `<style>` element scoped with a class prefix `.pg-<id>`.
Nav groups and order: Overview(0-9) / Tracking(10-39) / Insights(40-69) / Discovery(70-79) / Reporting(80-89) / Settings(90-99).
