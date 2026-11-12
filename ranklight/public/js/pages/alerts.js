// Alerts: rule editor (rank drops/gains, top-N entry/exit, URL changes, lost SERP features) and the notification feed.
// Data: /api/alerts/rules (CRUD), /api/alerts/notifications?unread=1, POST /api/alerts/notifications/read {ids|all}.
// Tag scoping uses /api/tags?domainId= when the tags module is installed (optional).
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, modal, fmtDate } from '../ui.js';

const STYLE = `
.pg-alerts .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 16px; align-items: start; }
.pg-alerts .head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.pg-alerts .head h2 { margin: 0; }
.pg-alerts .rules, .pg-alerts .feed { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.pg-alerts .rule { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius); }
.pg-alerts .rule.off { opacity: .6; }
.pg-alerts .rule .body, .pg-alerts .note .body { flex: 1; min-width: 0; }
.pg-alerts .rule .name { font-weight: 600; overflow-wrap: anywhere; }
.pg-alerts .meta { font-size: 12px; color: var(--muted); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 4px; }
.pg-alerts .actions { display: flex; gap: 6px; flex: none; }
.pg-alerts .note { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-radius: var(--radius); border: 1px solid var(--border); }
.pg-alerts .note.unread { background: var(--surface-2); border-left: 3px solid var(--primary); }
.pg-alerts .note .msg { overflow-wrap: anywhere; }
.pg-alerts .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; background: var(--muted); }
.pg-alerts .dot.rank_drop, .pg-alerts .dot.leaves_top, .pg-alerts .dot.feature_lost { background: var(--down); }
.pg-alerts .dot.rank_gain, .pg-alerts .dot.enters_top { background: var(--up); }
.pg-alerts .dot.url_change { background: var(--warn); }
.pg-alerts .badge { background: var(--primary); color: var(--primary-ink); border-radius: 999px; padding: 0 8px; font-size: 12px; }
.pg-alerts-form { display: grid; gap: 12px; }
.pg-alerts [hidden], .pg-alerts-form [hidden] { display: none; }
.pg-alerts-form .channels { display: flex; gap: 14px; flex-wrap: wrap; }
.pg-alerts-form .channels label, .pg-alerts-form label.check { flex-direction: row; align-items: center; gap: 6px; color: var(--text); font-size: 14px; }
@media (max-width: 900px) { .pg-alerts .layout { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .pg-alerts .rule, .pg-alerts .note { flex-direction: column; } }
`;
const TYPES = {
  rank_drop: { label: 'Rank drops', th: 'Minimum positions lost' },
  rank_gain: { label: 'Rank gains', th: 'Minimum positions gained' },
  enters_top: { label: 'Enters top N', th: 'Top N' },
  leaves_top: { label: 'Leaves top N', th: 'Top N' },
  url_change: { label: 'Ranking URL changes' },
  feature_lost: { label: 'Owned SERP feature lost' },
};
const CHANNELS = { inapp: 'In-app', email: 'Email', webhook: 'Webhook' };
const describe = r => {
  const t = TYPES[r.type]?.label || r.type;
  if (r.type === 'rank_drop' || r.type === 'rank_gain') return `${t} of ${r.threshold}+`;
  if (r.type === 'enters_top' || r.type === 'leaves_top') return t.replace('N', r.threshold);
  return t;
};
const ago = s => {
  const m = Math.round((Date.now() - new Date(s)) / 6e4);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : fmtDate(s);
};

export default {
  id: 'alerts', title: 'Alerts', group: 'Reporting', order: 82, nav: true, needsDomain: false,
  async render(el, ctx) {
    const domainName = id => { const d = ctx.domains.find(x => x.id === id); return d ? d.display_name || d.host : 'Deleted domain'; };
    const tagCache = new Map();
    const tagsFor = async domainId => {
      if (!domainId) return [];
      if (!tagCache.has(domainId)) tagCache.set(domainId, await get(`/api/tags?domainId=${domainId}`).catch(() => []));
      return tagCache.get(domainId);
    };
    const f = { unread: ctx.query.get('unread') === '1', thisDomain: false };
    let rules = [], feed = { items: [], unreadCount: 0 };

    const root = h(`<div class="pg-alerts"><style>${STYLE}</style>
      <div class="row"><h1>Alerts</h1></div>
      <p class="muted">Get notified when rankings move. Rules run every time new rankings are collected.</p>
      <div class="layout">
        <section class="card"><div class="head"><h2>Rules</h2><span class="spacer"></span><button class="primary" data-add>New rule</button></div><ul class="rules" data-rules></ul></section>
        <section class="card"><div class="head"><h2>Notifications</h2><span class="badge" data-count hidden></span><span class="spacer"></span>
          <label class="row" style="flex-direction:row"><input type="checkbox" data-unread ${f.unread ? 'checked' : ''}> Unread only</label>
          ${ctx.domainId ? '<label class="row" style="flex-direction:row"><input type="checkbox" data-scope> This domain</label>' : ''}
          <button data-readall>Mark all read</button></div><ul class="feed" data-feed></ul></section>
      </div></div>`);
    el.append(root);
    const rulesEl = root.querySelector('[data-rules]'), feedEl = root.querySelector('[data-feed]'), countEl = root.querySelector('[data-count]');

    async function loadRules() {
      try { rules = await get('/api/alerts/rules'); } catch (e) { toast(e.message, 'error'); rules = []; }
      const tagNames = new Map();
      for (const r of rules) if (r.tagId) for (const t of await tagsFor(r.domainId)) tagNames.set(t.id, t.name);
      rulesEl.innerHTML = rules.length ? rules.map(r => `<li class="rule ${r.enabled ? '' : 'off'}" data-id="${r.id}">
        <div class="body"><div class="name">${esc(r.name)}</div>
          <div class="meta"><span>${esc(describe(r))}</span><span class="tag">${esc(r.domainId ? domainName(r.domainId) : 'All domains')}</span>
          ${r.tagId ? `<span class="tag">Tag: ${esc(tagNames.get(r.tagId) || '#' + r.tagId)}</span>` : ''}
          ${r.channels.map(c => `<span class="tag">${esc(CHANNELS[c] || c)}</span>`).join('')}${r.enabled ? '' : '<span>Paused</span>'}</div></div>
        <div class="actions"><button data-toggle>${r.enabled ? 'Pause' : 'Enable'}</button><button data-edit>Edit</button><button class="danger" data-del>Delete</button></div></li>`).join('')
        : '<li class="empty">No rules yet. Create one to start receiving alerts.</li>';
    }

    async function loadFeed() {
      const qs = new URLSearchParams({ limit: '200' });
      if (f.unread) qs.set('unread', '1');
      if (f.thisDomain && ctx.domainId) qs.set('domainId', ctx.domainId);
      try { feed = await get(`/api/alerts/notifications?${qs}`); } catch (e) { toast(e.message, 'error'); }
      countEl.hidden = !feed.unreadCount; countEl.textContent = `${feed.unreadCount} unread`;
      feedEl.innerHTML = feed.items.length ? feed.items.map(n => `<li class="note ${n.read ? '' : 'unread'}" data-id="${n.id}">
        <span class="dot ${esc(n.type)}"></span>
        <div class="body"><div class="msg">${esc(n.message)}</div>
          <div class="meta"><span>${esc(ago(n.createdAt))}</span>${n.domainId ? `<span class="tag">${esc(domainName(n.domainId))}</span>` : ''}
          ${n.keywordId ? `<a href="#/keyword-history/${n.keywordId}">History</a>` : ''}</div></div>
        ${n.read ? '' : '<div class="actions"><button data-read>Mark read</button></div>'}</li>`).join('')
        : `<li class="empty">${f.unread ? 'You are all caught up.' : 'No notifications yet.'}</li>`;
    }

    async function openForm(rule = null) {
      const r = rule || { name: '', type: 'rank_drop', threshold: 3, domainId: ctx.domainId ?? null, tagId: null, channels: ['inapp'], enabled: true };
      const body = h(`<form class="pg-alerts-form">
        <label>Name<input name="name" required maxlength="120" value="${esc(r.name)}" placeholder="e.g. Money keywords dropping"></label>
        <label>Trigger<select name="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === r.type ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <label data-th><span></span><input name="threshold" type="number" min="1" max="100" value="${esc(r.threshold ?? '')}"></label>
        <label>Domain<select name="domainId"><option value="">All domains</option>${ctx.domains.map(d => `<option value="${d.id}" ${d.id === r.domainId ? 'selected' : ''}>${esc(d.display_name || d.host)}</option>`).join('')}</select></label>
        <label data-tag>Only keywords tagged<select name="tagId"></select></label>
        <div><div class="muted" style="font-size:12px;margin-bottom:4px">Channels</div><div class="channels">${Object.entries(CHANNELS).map(([k, v]) =>
          `<label><input type="checkbox" name="channels" value="${k}" ${r.channels.includes(k) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></div>
        <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> Enabled</label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Cancel</button><button class="primary">${rule ? 'Save' : 'Create rule'}</button></div>
      </form>`);
      const m = modal(rule ? 'Edit alert rule' : 'New alert rule', body);
      const typeSel = body.elements.type, domSel = body.elements.domainId, tagSel = body.elements.tagId, th = body.querySelector('[data-th]');
      const syncType = () => {
        const meta = TYPES[typeSel.value];
        th.hidden = !meta.th; th.querySelector('span').textContent = meta.th || '';
        if (meta.th && !body.elements.threshold.value) body.elements.threshold.value = typeSel.value.endsWith('_top') ? 10 : 3;
      };
      const syncTags = async (selected = null) => {
        const tags = await tagsFor(Number(domSel.value) || null);
        body.querySelector('[data-tag]').hidden = !tags.length;
        tagSel.innerHTML = '<option value="">All keywords</option>' + tags.map(t => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
      };
      typeSel.onchange = () => { body.elements.threshold.value = ''; syncType(); };
      domSel.onchange = () => syncTags();
      syncType(); await syncTags(r.tagId);
      body.querySelector('[data-cancel]').onclick = () => m.close();
      body.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(body);
        const payload = {
          name: String(fd.get('name')).trim(), type: fd.get('type'), domainId: Number(fd.get('domainId')) || null, tagId: Number(fd.get('tagId')) || null,
          channels: fd.getAll('channels'), enabled: fd.has('enabled'),
        };
        if (TYPES[payload.type].th) payload.threshold = Number(fd.get('threshold')) || null;
        if (!payload.channels.length) return toast('Pick at least one channel', 'error');
        const btn = body.querySelector('button.primary'); btn.disabled = true;
        try {
          if (rule) await patch(`/api/alerts/rules/${rule.id}`, payload); else await post('/api/alerts/rules', payload);
          m.close(); toast(rule ? 'Rule saved' : 'Rule created'); await loadRules();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    }

    root.querySelector('[data-add]').onclick = () => openForm();
    rulesEl.addEventListener('click', async e => {
      const li = e.target.closest('[data-id]'); if (!li) return;
      const rule = rules.find(r => r.id === Number(li.dataset.id)); if (!rule) return;
      try {
        if (e.target.closest('[data-edit]')) return openForm(rule);
        if (e.target.closest('[data-toggle]')) { await patch(`/api/alerts/rules/${rule.id}`, { enabled: !rule.enabled }); await loadRules(); }
        else if (e.target.closest('[data-del]') && confirm(`Delete the rule "${rule.name}"?`)) { await del(`/api/alerts/rules/${rule.id}`); toast('Rule deleted'); await loadRules(); }
      } catch (err) { toast(err.message, 'error'); }
    });
    feedEl.addEventListener('click', async e => {
      const li = e.target.closest('[data-id]');
      if (!li || !e.target.closest('[data-read]')) return;
      try { await post('/api/alerts/notifications/read', { ids: [Number(li.dataset.id)] }); await loadFeed(); } catch (err) { toast(err.message, 'error'); }
    });
    root.querySelector('[data-readall]').onclick = async () => {
      try { const r = await post('/api/alerts/notifications/read', { all: true }); toast(`${r.updated} marked as read`); await loadFeed(); } catch (err) { toast(err.message, 'error'); }
    };
    root.querySelector('[data-unread]').onchange = e => { f.unread = e.target.checked; loadFeed(); };
    root.querySelector('[data-scope]')?.addEventListener('change', e => { f.thisDomain = e.target.checked; loadFeed(); });
    await Promise.all([loadRules(), loadFeed()]);
  },
};
