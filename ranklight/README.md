# Ranklight

Ranklight is a self-hosted SEO keyword rank tracker. You add domains and keywords, it checks where each domain ranks in search results once a day, and it turns that history into dashboards, reports, alerts and exports.

It runs on Node.js 22.5+ with Express 5 and the built-in `node:sqlite` database. There is no frontend build step and no external database.

**About ranking data:** out of the box, Ranklight uses a built-in **simulator** that generates deterministic, realistic-looking search results. It does not contact Google. To track real Google (or Bing/YouTube) rankings you need a key for a SERP data provider (DataForSEO or SerpApi), see [Configuration](#configuration).

## Quick start

```bash
npm install
npm run seed      # creates demo@ranklight.local / demo12345 with 90 days of demo data
npm start         # http://localhost:3000
```

Log in with `demo@ranklight.local` / `demo12345`. The demo domain `demo-outdoors.com` has 40 keywords, 2 competitors, 4 tags and 3,600 rank snapshots. Running `npm run seed` again resets the demo user and regenerates its data.

You can also create your own account on the login screen and load the same demo data from Settings > Load demo data.

Run the tests with `npm test`.

## Features by module

Each server module lives in `server/modules/<name>.js` and is mounted at `/api/<name>`. Most have a matching page in `public/js/pages/`.

| Module | What it does |
| --- | --- |
| domains | Add, edit, pause and delete tracked domains with default country, language and location. Cards show keyword count, average rank and last check. |
| keywords | Bulk add keywords per device, filter, sort and page the keyword table, 1/7/30-day rank change, SERP feature badges, star, tag, move and delete in bulk. |
| keyword-history | Per-keyword detail page: rank chart, best/worst rank, the stored top-100 SERP for any day, and ranking-URL history. |
| rank-provider | Supplies SERP and search-volume data. Simulator by default; DataForSEO and SerpApi adapters. |
| scheduler | Daily rank refresh, refresh on demand, history backfill, and the job runner other modules register with. New keywords are checked right after they are added. |
| overview | Dashboard: KPIs (average rank, top 3/10/100, share of voice, estimated clicks), average-rank chart, rank distribution, winners and losers. |
| share-of-voice | Share of voice over time for you and your competitors, overall and per tag. |
| competitors | Manage competitors, suggestions from the SERPs, head-to-head win/loss and a rank comparison table. |
| serp-features | Which SERP features appear for your keywords, which you own, and how that changed. |
| tags | Tags with stats, plus dynamic tags that are filled automatically from rules (phrase, URL, rank, volume, device, location). |
| landing-pages | Ranking URLs with clicks and share of voice, keyword cannibalization (URL switching), preferred-URL mismatches. |
| local-rank | Rankings grouped by location, map-pack ownership, and a geo-grid rank scan around a point. |
| notes | Dated annotations, optionally tied to a keyword. Shown as markers on the overview charts. |
| search-volume | Monthly search volume, CPC, competition and a 12-month trend per keyword. |
| gsc-import | Import a Google Search Console queries CSV and track untracked queries, with "striking distance" (position 8-20) flags. |
| keyword-research | Keyword ideas from a seed phrase with volume, difficulty and intent, and a competitor gap list. |
| reports | Branded HTML/CSV/printable-PDF reports, generated on demand or emailed on a daily/weekly/monthly schedule. |
| exports | Keyword CSV, rank history CSV, full domain JSON backup, and CSV keyword import with a dry-run preview. |
| alerts | Rules for rank drops/gains, entering/leaving the top N, URL changes and lost SERP features; in-app notification feed, webhook and email channels. |
| integrations | Outgoing webhooks and Slack messages on rank updates and alerts; a tokenised CSV feed for Looker Studio / Google Sheets. |
| public-share | Read-only dashboard links for clients, with optional expiry and password. |
| api-keys | Personal API keys and a built-in API reference page. |
| team | Organizations, invitations with roles (admin, member, viewer) and a shared view of members' domains. |
| billing | Simulated plans (Starter, Pro, Agency, Enterprise) with keyword and domain limits. No payment provider is involved. |
| account | Profile, password, active sessions, account deletion, and the demo data generator. |

### Plan limits

When the billing module is loaded, creating keywords (keywords page, CSV import, GSC import, keyword research) and domains is checked against the user's plan. Going over the limit returns HTTP 402 and nothing is inserted. Users without a subscription row are on the Starter plan (1,000 keywords, 5 domains).

## Configuration

All settings are environment variables. None are required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `DB_PATH` | `data/ranklight.db` | SQLite database file. Used by `npm start` and `npm run seed`. |
| `RANK_PROVIDER` | `simulator` | `simulator`, `dataforseo` or `serpapi`. If the chosen provider's credentials are missing, Ranklight logs a warning and falls back to the simulator. `GET /api/rank-provider/status` shows which one is active. |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | | DataForSEO API credentials (SERP and Google Ads search volume). |
| `SERPAPI_KEY` | | SerpApi key (Google, Bing, YouTube SERPs). SerpApi has no volume API, so search volumes stay simulated estimates with this provider. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | | Outgoing mail for scheduled reports and email alerts. `SMTP_SECURE=1` uses implicit TLS; `SMTP_STARTTLS=0` disables STARTTLS. Without `SMTP_HOST`, emails are written as files to `data/outbox`. |
| `RL_OUTBOX_DIR` | `data/outbox` | Where emails go when SMTP is not configured. |
| `RL_BRAND_NAME` | `Ranklight` | Name shown in report headers. |
| `GSC_CLIENT_ID` | | Marks Google Search Console OAuth as configured. The live OAuth sync is not implemented; CSV import works without it. |
| `RL_DISABLE_SCHEDULER` | | Set to `1` to turn off the background timers (daily refresh and periodic jobs). Manual refreshes still work. Timers are also off when `NODE_ENV=test`. |
| `RL_REFRESH_HOUR_UTC` | `0` | UTC hour from which the daily refresh starts. |

The DataForSEO and SerpApi adapters have been tested against mocked responses only.

## Architecture

- `server/app.js` builds the Express app: core auth routes (`/api/auth/signup`, `/login`, `/logout`, `/me`), the module loader, and static file serving.
- `server/db.js` holds the core schema (users, sessions, domains, keywords, rank_snapshots, tags, keyword_tags, competitors) and runs `server/migrations/*.sql` in order for module tables.
- `server/modules/*.js` are feature modules. Each exports `{ name, setup?(ctx), router(ctx) }` and is mounted at `/api/<name>`. `ctx` carries the database, a shared event bus, auth resolvers, the job registry and the rank provider.
- Modules talk through events: `keywords:added` (scheduler refreshes ranks, search-volume fills volumes, tags re-apply rules), `ranks:updated` (alerts, integrations and dynamic tags react), `alert:triggered` (integrations), `alert:email` (reports mail transport).
- `server/lib/` has shared helpers: HTTP errors and ownership checks, rank metrics (CTR curve, estimated clicks, rank change), auth, quota checks and the provider adapters.
- `public/` is a no-build single-page app. `public/js/app.js` discovers pages in `public/js/pages/` and routes on `#/<page>/<param>?<query>`.
- Every rank check stores a snapshot with the domain's rank, ranking URL, SERP features and the full top-100 results, so competitor ranks and SERP history are derived from stored data.

See `docs/ARCHITECTURE.md` for the module contract.

## API access

Every page uses the JSON API, and you can call it directly.

1. Open **Settings > API** and create a key. The full key (`rl_...`) is shown once.
2. Send it in the `x-api-key` header:

```bash
curl -H "x-api-key: rl_your_key" http://localhost:3000/api/domains
curl -H "x-api-key: rl_your_key" "http://localhost:3000/api/keywords?domainId=1&pageSize=100"
curl -H "x-api-key: rl_your_key" "http://localhost:3000/api/overview?domainId=1&days=30"
```

A session token from `POST /api/auth/login` also works as `Authorization: Bearer <token>`. Key management routes refuse requests made with an API key, so a leaked key cannot create or revoke keys. Revoke a key from the same page. The API page lists the documented endpoints with parameters and curl examples (`GET /api/api-keys/docs`).

Two routes are public by design: shared dashboards (`/api/public-share/view/<token>`) and integration CSV feeds (`/api/integrations/feed/<token>.csv`).

## Known limitations

- Rankings are simulated unless a provider key is set.
- Google Search Console has CSV import only; no OAuth sync.
- The team `viewer` role is stored but not enforced as read-only outside the team module. Domain ownership stays per user; organization members see each other's domains in a read-only list.
- Billing is simulated; no payments are taken.
- Local geo-grid scans are not saved, and the simulator does not produce map-pack entries.
