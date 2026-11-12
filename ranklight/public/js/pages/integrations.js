// Integrations: webhooks, Slack incoming webhooks and tokenized CSV feeds (Looker Studio / Google Sheets IMPORTDATA).
// Data: /api/integrations (CRUD), /:id/test, /:id/rotate-token, public /api/integrations/feed/:token.csv.
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, modal } from '../ui.js';

const STYLE = `
.pg-integrations .types { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 24px; }
.pg-integrations .type-card { display: grid; gap: 8px; align-content: start; }
.pg-integrations .type-card p { margin: 0; font-size: 13px; }
.pg-integrations .list { display: grid; gap: 12px; }
.pg-integrations .item { display: grid; gap: 8px; }
.pg-integrations .item.off { opacity: .65; }
.pg-integrations .item h3 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
.pg-integrations .meta { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.pg-integrations .status-ok { color: var(--up); } .pg-integrations .status-err { color: var(--down); }
.pg-integrations code, .pg-int-form code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--surface-2);
  border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px; overflow-wrap: anywhere; word-break: break-all; }
.pg-integrations .feed { display: grid; gap: 6px; }
.pg-integrations .feed .row code { flex: 1 1 240px; min-width: 0; }
.pg-int-form { display: grid; gap: 12px; }
.pg-int-form label { display: grid; gap: 4px; }
.pg-int-form fieldset { border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; display: grid; gap: 4px; }
.pg-int-form fieldset label { display: flex; gap: 6px; align-items: center; }
.pg-int-form .hint { font-size: 12px; color: var(--muted); }
`;

const TYPES = {
  webhook: { label: 'Webhook', desc: 'POST JSON to any URL when ranks update or an alert fires. Optional HMAC signature.' },
  slack: { label: 'Slack', desc: 'Post rank summaries and alerts to a Slack channel via an incoming webhook URL.' },
  looker_csv: { label: 'CSV feed (BI tools)', desc: 'A private CSV URL of your latest ranks for Looker Studio, Google Sheets or Excel.' },
};
const EVENTS = { 'ranks:updated': 'Rank updates', 'alert:triggered': 'Alerts (rules with the webhook channel)' };

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy failed; select the text and copy it manually', 'error'); }
}
const statusHtml = i => {
  if (!i.lastStatus) return '<span class="muted">Never used</span>';
  const cls = /error/.test(i.lastStatus) ? 'status-err' : 'status-ok';
  return `<span class="${cls}">${esc(i.lastStatus)}</span>${i.lastSentAt ? ` <span class="muted">· ${esc(new Date(i.lastSentAt).toLocaleString())}</span>` : ''}`;
};

export default {
  id: 'integrations', title: 'Integrations', group: 'Settings', order: 95, nav: true, needsDomain: false,
  async render(el, ctx) {
    const root = h(`<div class="pg-integrations"><style>${STYLE}</style>
      <h1>Integrations</h1>
      <p class="muted">Send rank updates and alerts to other tools, or pull your rankings into dashboards.</p>
      <div class="types">${Object.entries(TYPES).map(([k, t]) => `<div class="card type-card"><strong>${esc(t.label)}</strong><p class="muted">${esc(t.desc)}</p>
        <div><button class="primary" data-add="${k}">Add ${esc(t.label)}</button></div></div>`).join('')}</div>
      <h2>Your integrations</h2><div class="list" data-list><div class="empty">Loading…</div></div></div>`);
    el.append(root);
    const listEl = root.querySelector('[data-list]');
    const domainName = id => { const d = ctx.domains.find(x => x.id === id); return d ? d.display_name || d.host : `#${id}`; };
    let items = [];

    function itemHtml(i) {
      const scope = i.config.domainId ? `Domain: ${esc(domainName(i.config.domainId))}` : 'All domains';
      let detail = '';
      if (i.type === 'looker_csv') {
        const url = location.origin + i.feedUrl;
        detail = `<div class="feed">
          <div class="row"><code>${esc(url)}</code><button data-copy="${esc(url)}">Copy URL</button></div>
          <div class="row"><code>${esc(`=IMPORTDATA("${url}")`)}</code><button data-copy="${esc(`=IMPORTDATA("${url}")`)}">Copy Sheets formula</button></div>
          <div class="meta">Add <code>?days=30</code> for daily history. Anyone with this URL can read the data; rotate the token if it leaks.</div></div>`;
      } else {
        detail = `<div class="meta">${esc(i.config.url)}</div><div class="meta">Events: ${i.config.events.map(e => esc(EVENTS[e] || e)).join(', ')}${i.config.secret ? ' · Signed' : ''}</div>`;
      }
      return `<div class="card item ${i.enabled ? '' : 'off'}" data-id="${i.id}">
        <div class="row"><h3>${esc(i.name)}</h3><span class="tag">${esc(TYPES[i.type]?.label || i.type)}</span><span class="tag">${scope}</span>
          ${i.enabled ? '' : '<span class="tag">Paused</span>'}</div>
        ${detail}
        <div class="meta">Last activity: ${statusHtml(i)}</div>
        <div class="row"><button data-act="test">${i.type === 'looker_csv' ? 'Check feed' : 'Send test'}</button><button data-act="edit">Edit</button>
          <button data-act="toggle">${i.enabled ? 'Pause' : 'Resume'}</button>${i.type === 'looker_csv' ? '<button data-act="rotate">Rotate token</button>' : ''}
          <span class="spacer"></span><button class="danger" data-act="delete">Delete</button></div></div>`;
    }

    async function load() {
      try { items = await get('/api/integrations'); } catch (e) { listEl.replaceChildren(h(`<div class="card down">Could not load integrations: ${esc(e.message)}</div>`)); return; }
      listEl.innerHTML = items.length ? items.map(itemHtml).join('') : '<div class="empty card">No integrations yet. Add one above.</div>';
    }

    function openForm(type, cur) {
      const c = cur?.config || {};
      const net = type !== 'looker_csv';
      const form = h(`<form class="pg-int-form">
        <label>Name<input name="name" required maxlength="120" value="${esc(cur?.name || TYPES[type].label)}"></label>
        ${net ? `<label>${type === 'slack' ? 'Slack incoming webhook URL' : 'Endpoint URL'}<input name="url" type="url" required maxlength="2000" value="${esc(c.url || '')}"
            placeholder="${type === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://example.com/hooks/ranklight'}"></label>
          <fieldset><legend>Send on</legend>${Object.entries(EVENTS).map(([k, l]) => `<label><input type="checkbox" name="events" value="${k}" ${!c.events || c.events.includes(k) ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</fieldset>` : ''}
        <label>Domain<select name="domainId"><option value="">All domains</option>${ctx.domains.map(d => `<option value="${d.id}" ${c.domainId === d.id ? 'selected' : ''}>${esc(d.display_name || d.host)}</option>`).join('')}</select></label>
        ${type === 'webhook' ? `<label>Signing secret (optional)<input name="secret" maxlength="200" autocomplete="off" value="${esc(c.secret || '')}">
          <span class="hint">Requests carry <code>X-Ranklight-Signature: sha256=&lt;HMAC of body&gt;</code>.</span></label>` : ''}
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Cancel</button><button class="primary">${cur ? 'Save' : 'Create'}</button></div></form>`);
      const m = modal(cur ? `Edit ${cur.name}` : `Add ${TYPES[type].label}`, form);
      form.querySelector('[data-cancel]').onclick = () => m.close();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(form);
        const config = { domainId: f.get('domainId') ? Number(f.get('domainId')) : null };
        if (net) { config.url = String(f.get('url')).trim(); config.events = f.getAll('events'); }
        if (type === 'webhook') config.secret = String(f.get('secret') || '').trim() || null;
        if (net && !config.events.length) return toast('Choose at least one event', 'error');
        const btn = form.querySelector('button.primary'); btn.disabled = true;
        try {
          const body = { name: String(f.get('name')).trim(), config };
          if (cur) await patch(`/api/integrations/${cur.id}`, body); else await post('/api/integrations', { type, ...body });
          toast(cur ? 'Integration saved' : 'Integration created'); m.close(); await load();
        } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
      });
    }

    root.addEventListener('click', async e => {
      const add = e.target.closest('[data-add]'); if (add) return openForm(add.dataset.add);
      const cp = e.target.closest('[data-copy]'); if (cp) return copy(cp.dataset.copy);
      const btn = e.target.closest('[data-act]'); if (!btn) return;
      const i = items.find(x => x.id === Number(btn.closest('[data-id]').dataset.id)); if (!i) return;
      const act = btn.dataset.act;
      if (act === 'edit') return openForm(i.type, i);
      btn.disabled = true;
      try {
        if (act === 'test') {
          const r = await post(`/api/integrations/${i.id}/test`);
          toast(i.type === 'looker_csv' ? `Feed ready: ${r.rows} rows` : r.ok ? `Test sent (${r.lastStatus})` : `Test failed: ${r.lastStatus}`, r.ok ? '' : 'error');
        } else if (act === 'toggle') {
          await patch(`/api/integrations/${i.id}`, { enabled: !i.enabled });
        } else if (act === 'rotate') {
          if (!confirm('Rotate the feed token? The current URL will stop working immediately.')) return;
          await post(`/api/integrations/${i.id}/rotate-token`); toast('New feed URL generated');
        } else if (act === 'delete') {
          if (!confirm(`Delete "${i.name}"?`)) return;
          await del(`/api/integrations/${i.id}`); toast('Integration deleted');
        }
        await load();
      } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    });

    await load();
  },
};
