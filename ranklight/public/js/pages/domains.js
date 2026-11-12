// Domains page: list tracked domains grouped by group_name, add/edit/delete, pause/resume.
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, modal, fmtNum, fmtDate } from '../ui.js';

const STYLE = `
.pg-domains .head { margin-bottom: 16px; }
.pg-domains .head h1 { margin: 0; }
.pg-domains .group { margin-bottom: 24px; }
.pg-domains .group h2 { display: flex; gap: 8px; align-items: baseline; }
.pg-domains .cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.pg-domains .dom { display: flex; flex-direction: column; gap: 10px; }
.pg-domains .dom.paused { opacity: .7; }
.pg-domains .dom .name { font-weight: 600; font-size: 15px; overflow-wrap: anywhere; }
.pg-domains .dom .host { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.pg-domains .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.pg-domains .stats div { min-width: 0; }
.pg-domains .stats div { background: var(--surface-2); border-radius: 6px; padding: 6px 8px; }
.pg-domains .stats b { display: block; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pg-domains .stats span { font-size: 11px; color: var(--muted); }
.pg-domains .actions { display: flex; gap: 6px; flex-wrap: wrap; }
.pg-domains .actions button { padding: 4px 10px; font-size: 13px; }
.pg-domains .badge-paused { background: var(--warn); color: var(--primary-ink); }
.pg-domains-form { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
.pg-domains-form .full { grid-column: 1 / -1; }
.pg-domains-form .check { flex-direction: row; align-items: center; gap: 8px; color: var(--text); font-size: 14px; }
@media (max-width: 560px) { .pg-domains-form { grid-template-columns: minmax(0, 1fr); } }
`;

function domainForm(d, groups, onSaved) {
  const form = h(`<form class="pg-domains-form">
    <label class="full">Domain<input name="host" required placeholder="example.com" value="${esc(d?.host)}"></label>
    <label class="full">Display name<input name="display_name" placeholder="Defaults to the domain" value="${esc(d?.display_name)}"></label>
    <label>Group<input name="group_name" list="pg-domains-groups" value="${esc(d?.group_name ?? 'Default')}">
      <datalist id="pg-domains-groups">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist></label>
    <label>Default country<input name="default_country" maxlength="2" required value="${esc(d?.default_country ?? 'US')}"></label>
    <label>Default language<input name="default_language" required value="${esc(d?.default_language ?? 'en')}"></label>
    <label>Default location<input name="default_location" placeholder="National" value="${esc(d?.default_location)}"></label>
    <label class="check full"><input type="checkbox" name="include_subdomains" ${d?.include_subdomains === false ? '' : 'checked'}> Count rankings from subdomains</label>
    <div class="row full"><span class="spacer"></span><button type="button" data-x>Cancel</button><button class="primary">${d ? 'Save changes' : 'Add domain'}</button></div>
  </form>`);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    const body = Object.fromEntries(['host', 'display_name', 'group_name', 'default_country', 'default_language', 'default_location'].map(k => [k, String(f.get(k) || '').trim()]));
    body.include_subdomains = f.get('include_subdomains') === 'on';
    const btn = form.querySelector('button.primary'); btn.disabled = true;
    try { await onSaved(d ? await patch(`/api/domains/${d.id}`, body) : await post('/api/domains', body)); }
    catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });
  return form;
}

function domainCard(d) {
  return `<div class="card dom ${d.paused ? 'paused' : ''}" data-id="${d.id}">
    <div class="row"><div style="min-width:0"><div class="name">${esc(d.display_name || d.host)}</div>
      <div class="host">${esc(d.host)} · ${esc(d.default_country)}${d.default_location ? ' · ' + esc(d.default_location) : ''} · ${esc(d.default_language)}</div></div>
      <span class="spacer"></span>${d.paused ? '<span class="tag badge-paused">Paused</span>' : ''}</div>
    <div class="stats">
      <div><b>${fmtNum(d.keyword_count)}</b><span>Keywords</span></div>
      <div><b>${d.avg_rank == null ? '–' : esc(d.avg_rank)}</b><span>Avg. rank</span></div>
      <div title="${d.last_checked_at ? esc(fmtDate(d.last_checked_at)) : ''}"><b>${d.last_checked_at ? esc(new Date(d.last_checked_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })) : '–'}</b><span>Last check</span></div>
    </div>
    <div class="actions"><button data-act="open" class="primary">Open</button><button data-act="edit">Edit</button>
      <button data-act="${d.paused ? 'resume' : 'pause'}">${d.paused ? 'Resume' : 'Pause'}</button><button data-act="delete" class="danger">Delete</button></div>
  </div>`;
}

export default {
  id: 'domains', title: 'Domains', group: 'Tracking', order: 10, nav: true, needsDomain: false,
  async render(el, ctx) {
    el.append(h(`<style>${STYLE}</style>`));
    const root = h('<div class="pg-domains"></div>');
    el.append(root);
    let domains = [];

    const reload = async () => {
      domains = await get('/api/domains');
      const groups = {};
      for (const d of domains) (groups[d.group_name || 'Default'] ||= []).push(d);
      root.innerHTML = `<div class="row head"><h1>Domains</h1><span class="muted">${domains.length} tracked</span><span class="spacer"></span><button class="primary" data-act="add">Add domain</button></div>`
        + (domains.length ? Object.entries(groups).map(([g, ds]) => `<section class="group"><h2>${esc(g)} <span class="muted">${ds.length}</span></h2>
            <div class="cards">${ds.map(domainCard).join('')}</div></section>`).join('')
          : '<div class="card empty">No domains yet. Add your first domain to start tracking rankings.</div>');
    };

    const openForm = d => {
      const groups = [...new Set(domains.map(x => x.group_name))];
      let m;
      const form = domainForm(d, groups, async saved => {
        m.close();
        toast(d ? 'Domain updated' : `Added ${saved.host}`);
        await ctx.refreshDomains();
        await reload();
      });
      m = modal(d ? `Edit ${d.display_name || d.host}` : 'Add domain', form);
      form.querySelector('input[name=host]').focus();
    };

    const confirmDelete = d => {
      const body = h(`<div style="display:grid;gap:12px"><p>Delete <b>${esc(d.display_name || d.host)}</b> and its ${fmtNum(d.keyword_count)} keywords and ranking history? This cannot be undone.</p>
        <div class="row"><span class="spacer"></span><button data-x>Cancel</button><button class="primary" data-confirm>Delete domain</button></div></div>`);
      body.querySelector('[data-confirm]').style.cssText = 'background:var(--down);border-color:var(--down)';
      const m = modal('Delete domain', body);
      body.querySelector('[data-confirm]').onclick = async () => {
        try { await del(`/api/domains/${d.id}`); m.close(); toast('Domain deleted'); await ctx.refreshDomains(); await reload(); }
        catch (err) { toast(err.message, 'error'); }
      };
    };

    root.addEventListener('click', async e => {
      const btn = e.target.closest('button[data-act]'); if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'add') return openForm(null);
      const d = domains.find(x => x.id === Number(btn.closest('[data-id]').dataset.id)); if (!d) return;
      if (act === 'edit') return openForm(d);
      if (act === 'delete') return confirmDelete(d);
      if (act === 'open') { localStorage.setItem('rl_domain', d.id); const sw = document.getElementById('domain-switcher'); if (sw) { sw.value = d.id; sw.dispatchEvent(new Event('change')); } return ctx.navigate('#/overview'); }
      try { await post(`/api/domains/${d.id}/${act}`); toast(act === 'pause' ? 'Tracking paused' : 'Tracking resumed'); await reload(); }
      catch (err) { toast(err.message, 'error'); }
    });

    await reload();
    if (ctx.query.get('add') === '1' || !domains.length) openForm(null);
  },
};
