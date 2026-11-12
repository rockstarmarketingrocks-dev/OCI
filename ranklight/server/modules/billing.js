// Billing: simulated plans, subscriptions and usage quotas. No real payment processing.
// Routes: GET /api/billing, POST /api/billing/plan {plan}, GET /api/billing/quota?adding=N
// Exports PLANS, DEFAULT_PLAN, getSubscription, usageFor, checkKeywordQuota, checkDomainQuota for other modules.
import { httpError, requireAuth } from '../lib/http.js';

export const PLANS = Object.freeze({
  starter:    Object.freeze({ id: 'starter',    name: 'Starter',    keywords: 1000,   domains: 5,    refreshHours: 24, onDemand: false, priceMonthly: 49 }),
  pro:        Object.freeze({ id: 'pro',        name: 'Pro',        keywords: 5000,   domains: 25,   refreshHours: 24, onDemand: true,  priceMonthly: 149 }),
  agency:     Object.freeze({ id: 'agency',     name: 'Agency',     keywords: 20000,  domains: 100,  refreshHours: 12, onDemand: true,  priceMonthly: 449 }),
  enterprise: Object.freeze({ id: 'enterprise', name: 'Enterprise', keywords: 100000, domains: 1000, refreshHours: 6,  onDemand: true,  priceMonthly: 1499 }),
});
export const DEFAULT_PLAN = 'starter';
const PERIOD_DAYS = 30;

const addDays = (date, days) => new Date(date.getTime() + days * 864e5).toISOString();
const pct = (used, limit) => (limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0);
const monthStart = (now = new Date()) => `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;

// Current subscription for a user; users without a row are reported on the default plan (trial).
export function getSubscription(db, userId) {
  const row = db.prepare('SELECT plan, status, renews_at FROM subscriptions WHERE user_id = ?').get(userId);
  const planId = PLANS[row?.plan] ? row.plan : DEFAULT_PLAN;
  return { plan: PLANS[planId], status: row?.status ?? 'trial', renewsAt: row?.renews_at ?? null };
}

export function usageFor(db, userId, now = new Date()) {
  const { domains } = db.prepare('SELECT COUNT(*) AS domains FROM domains WHERE user_id = ?').get(userId);
  const { keywords } = db.prepare('SELECT COUNT(*) AS keywords FROM keywords k JOIN domains d ON d.id = k.domain_id WHERE d.user_id = ?').get(userId);
  const { snapshots } = db.prepare(`SELECT COUNT(*) AS snapshots FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id
    JOIN domains d ON d.id = k.domain_id WHERE d.user_id = ? AND s.checked_at >= ?`).get(userId, monthStart(now));
  return { keywords: Number(keywords), domains: Number(domains), snapshotsThisMonth: Number(snapshots) };
}

// Can `adding` more keywords be tracked for this user? -> { ok, remaining, limit, used, plan }
export function checkKeywordQuota(db, userId, adding = 1) {
  const n = Math.max(0, Math.floor(Number(adding) || 0));
  const { plan } = getSubscription(db, userId);
  const { keywords: used } = usageFor(db, userId);
  const remaining = Math.max(0, plan.keywords - used);
  return { ok: n <= remaining, remaining, limit: plan.keywords, used, adding: n, plan: plan.id };
}

export function checkDomainQuota(db, userId, adding = 1) {
  const n = Math.max(0, Math.floor(Number(adding) || 0));
  const { plan } = getSubscription(db, userId);
  const { domains: used } = usageFor(db, userId);
  const remaining = Math.max(0, plan.domains - used);
  return { ok: n <= remaining, remaining, limit: plan.domains, used, adding: n, plan: plan.id };
}

function summary(db, userId) {
  const sub = getSubscription(db, userId);
  const u = usageFor(db, userId);
  const checksPerMonth = Math.round((24 / sub.plan.refreshHours) * PERIOD_DAYS);
  return {
    plan: sub.plan, status: sub.status, renewsAt: sub.renewsAt,
    usage: {
      keywords: u.keywords, keywordLimit: sub.plan.keywords, keywordPercent: pct(u.keywords, sub.plan.keywords),
      domains: u.domains, domainLimit: sub.plan.domains, domainPercent: pct(u.domains, sub.plan.domains),
      snapshotsThisMonth: u.snapshotsThisMonth,
      snapshotCapacity: sub.plan.keywords * checksPerMonth,
      percent: pct(u.keywords, sub.plan.keywords),
    },
    plans: Object.values(PLANS),
  };
}

export default {
  name: 'billing',
  router(ctx) {
    const { db, express, events } = ctx;
    const r = express.Router();
    r.use(requireAuth);

    r.get('/', (req, res) => res.json(summary(db, req.user.id)));

    r.get('/quota', (req, res) => {
      const raw = req.query.adding ?? '1';
      const adding = Number(raw);
      if (!/^\d+$/.test(String(raw)) || !Number.isSafeInteger(adding)) throw httpError(400, 'adding must be a non-negative integer');
      res.json(checkKeywordQuota(db, req.user.id, adding));
    });

    r.post('/plan', (req, res) => {
      const planId = String(req.body?.plan ?? '').trim().toLowerCase();
      const plan = PLANS[planId];
      if (!plan) throw httpError(400, `plan must be one of: ${Object.keys(PLANS).join(', ')}`);
      const userId = req.user.id;
      const prev = getSubscription(db, userId);
      const u = usageFor(db, userId);
      if (u.keywords > plan.keywords || u.domains > plan.domains) {
        throw httpError(409, `Current usage (${u.keywords} keywords, ${u.domains} domains) exceeds the ${plan.name} plan limits (${plan.keywords} keywords, ${plan.domains} domains)`,
          { keywords: u.keywords, domains: u.domains, limits: { keywords: plan.keywords, domains: plan.domains } });
      }
      const renewsAt = addDays(new Date(), PERIOD_DAYS);
      db.prepare(`INSERT INTO subscriptions(user_id, plan, status, renews_at, updated_at) VALUES (?,?, 'active', ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, status = 'active', renews_at = excluded.renews_at, updated_at = excluded.updated_at`)
        .run(userId, plan.id, renewsAt);
      if (prev.plan.id !== plan.id || prev.status !== 'active') events.emit('billing:plan-changed', { userId, plan: plan.id, previous: prev.plan.id });
      res.json(summary(db, userId));
    });

    return r;
  },
};
