// Billing: current plan, usage meters and simulated plan switching. Data: /api/billing, POST /api/billing/plan.
import { get, post } from '../api.js';
import { h, esc, toast, fmtNum, fmtDate } from '../ui.js';

const STYLE = `
.pg-billing section { margin-bottom: 24px; }
.pg-billing .meters { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.pg-billing .meter .label { color: var(--muted); font-size: 12px; }
.pg-billing .meter .value { font-size: 22px; font-weight: 600; margin: 4px 0 8px; }
.pg-billing .meter .of, .pg-billing .plan .per { color: var(--muted); font-size: 13px; font-weight: 400; }
.pg-billing .bar { height: 8px; border-radius: 999px; background: var(--surface-2); overflow: hidden; border: 1px solid var(--border); }
.pg-billing .bar > span { display: block; height: 100%; background: var(--primary); }
.pg-billing .bar.warn > span { background: var(--warn); }
.pg-billing .bar.full > span { background: var(--down); }
.pg-billing .plans { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
.pg-billing .plan { display: flex; flex-direction: column; gap: 8px; }
.pg-billing .plan.current { border-color: var(--primary); box-shadow: 0 0 0 1px var(--primary); }
.pg-billing .plan h3 { margin: 0; }
.pg-billing .plan .price { font-size: 24px; font-weight: 600; }
.pg-billing .plan ul { margin: 0; padding-left: 18px; font-size: 14px; flex: 1; }
.pg-billing .plan button { width: 100%; }
.pg-billing .note { font-size: 13px; }
`;

function meter(label, used, limit, percent, sub) {
  const w = Math.min(100, percent), cls = percent >= 100 ? 'full' : percent >= 80 ? 'warn' : '';
  return `<div class="card meter"><div class="label">${esc(label)}</div>
    <div class="value">${fmtNum(used)}${limit != null ? ` <span class="of">/ ${fmtNum(limit)}</span>` : ''}</div>
    ${limit != null ? `<div class="bar ${cls}" role="progressbar" aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w}"><span style="width:${w}%"></span></div>` : ''}
    <div class="muted note">${esc(sub)}</div></div>`;
}

const refreshText = p => (p.refreshHours >= 24 ? 'Daily refresh' : `Refresh every ${p.refreshHours} hours`);

export default {
  id: 'billing', title: 'Billing', group: 'Settings', order: 98, nav: true, needsDomain: false,
  async render(el) {
    const root = h(`<div class="pg-billing"><style>${STYLE}</style><h1>Plan &amp; usage</h1>
      <p class="muted">Plans are simulated in this self-hosted install: switching changes your limits immediately and no payment is taken.</p>
      <div data-body><div class="empty">Loading…</div></div></div>`);
    el.append(root);
    const body = root.querySelector('[data-body]');

    function draw(b) {
      const u = b.usage, cur = b.plan;
      body.innerHTML = `
        <section><h2>Usage</h2><div class="meters">
          ${meter('Tracked keywords', u.keywords, u.keywordLimit, u.keywordPercent, `${u.keywordPercent}% of plan used`)}
          ${meter('Domains', u.domains, u.domainLimit, u.domainPercent, `${u.domainPercent}% of plan used`)}
          ${meter('Rank checks this month', u.snapshotsThisMonth, null, 0, `Plan capacity about ${fmtNum(u.snapshotCapacity)} checks per month`)}
        </div>
        <p class="muted note">Current plan: <strong>${esc(cur.name)}</strong> (${esc(b.status)})${b.renewsAt ? `, renews ${esc(fmtDate(b.renewsAt))}` : ''}.</p></section>
        <section><h2>Plans</h2><div class="plans">${b.plans.map(p => {
          const isCur = p.id === cur.id, tooSmall = !isCur && (u.keywords > p.keywords || u.domains > p.domains);
          const label = isCur ? 'Current plan' : p.keywords > cur.keywords ? 'Upgrade' : 'Downgrade';
          return `<div class="card plan ${isCur ? 'current' : ''}">
            <h3>${esc(p.name)}</h3>
            <div class="price">$${fmtNum(p.priceMonthly)}<span class="per"> / month</span></div>
            <ul><li>${fmtNum(p.keywords)} keywords</li><li>${fmtNum(p.domains)} domains</li><li>${esc(refreshText(p))}</li>
              <li>${p.onDemand ? 'On-demand refresh' : 'Scheduled refresh only'}</li></ul>
            <button data-plan="${esc(p.id)}" data-name="${esc(p.name)}" class="${isCur ? '' : 'primary'}" ${isCur || tooSmall ? 'disabled' : ''}
              ${tooSmall ? 'title="Your current usage exceeds this plan"' : ''}>${label}</button>
          </div>`;
        }).join('')}</div></section>`;
    }

    body.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-plan]'); if (!btn || btn.disabled) return;
      const name = btn.dataset.name;
      if (!confirm(`Switch to the ${name} plan?`)) return;
      btn.disabled = true;
      try { draw(await post('/api/billing/plan', { plan: btn.dataset.plan })); toast(`Switched to ${name}`); }
      catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });

    try { draw(await get('/api/billing')); }
    catch (err) { body.replaceChildren(h(`<div class="card down">Could not load billing: ${esc(err.message)}</div>`)); }
  },
};
