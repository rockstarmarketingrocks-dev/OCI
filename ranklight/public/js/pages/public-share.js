// Sharing: create read-only public dashboard links for the selected domain, copy their URL, see view counts, revoke.
// Data: /api/public-share (CRUD, ?domainId=). Public view: /api/public-share/view/<token>.
import { get, post, del } from '../api.js';
import { h, esc, toast, table, fmtDate, fmtNum, modal } from '../ui.js';

const STYLE = `
.pg-sharing .intro { margin: -8px 0 16px; }
.pg-sharing .status { font-size: 12px; border-radius: 4px; padding: 1px 6px; border: 1px solid var(--border); }
.pg-sharing .status.expired { color: var(--down); border-color: var(--down); }
.pg-sharing .status.active { color: var(--up); border-color: var(--up); }
.pg-sharing .acts { display: flex; gap: 6px; justify-content: flex-end; }
.pg-sharing .name { font-weight: 600; }
.pg-sharing-form { display: grid; gap: 12px; min-width: min(420px, 80vw); }
.pg-sharing-form input, .pg-sharing-form select { width: 100%; }
.pg-sharing-url { display: flex; gap: 8px; } .pg-sharing-url input { flex: 1; min-width: 0; font-family: monospace; }
@media (max-width: 600px) { .pg-sharing .acts { flex-wrap: wrap; justify-content: flex-start; } }
`;
const fullUrl = l => new URL(l.path, location.origin).href;

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); }
  catch { window.prompt('Copy this link', text); }
}

export default {
  id: 'sharing', title: 'Sharing', group: 'Reporting', order: 88, nav: true, needsDomain: true,
  async render(el, ctx) {
    const { domainId, domain } = ctx;
    const root = h(`<div class="pg-sharing"><style>${STYLE}</style>
      <div class="row"><h1>Shared links</h1><span class="spacer"></span><button class="primary" data-add>Create link</button></div>
      <p class="muted intro">Give clients or colleagues a read-only rankings dashboard for <b>${esc(domain?.display_name || domain?.host || '')}</b>, no login required.</p>
      <div data-list></div></div>`);
    el.append(root);
    const list = root.querySelector('[data-list]');
    let links = [];

    const columns = [
      { key: 'name', label: 'Name', render: l => `<span class="name">${esc(l.name || 'Untitled link')}</span>${l.hasPassword ? ' <span class="tag" title="Password protected">password</span>' : ''}` },
      { key: 'createdAt', label: 'Created', render: l => esc(fmtDate(l.createdAt)) },
      { key: 'expiresAt', label: 'Expires', render: l => l.expired ? '<span class="status expired">Expired</span>' : l.expiresAt ? esc(fmtDate(l.expiresAt)) : '<span class="status active">Never</span>' },
      { key: 'views', label: 'Views', num: true, render: l => fmtNum(l.views) },
      { key: 'id', label: '', render: l => `<div class="acts" data-id="${l.id}">${l.expired ? '' : '<button data-copy>Copy URL</button><a class="btn" data-open target="_blank" rel="noopener">Open</a>'}<button class="danger" data-revoke>Revoke</button></div>` },
    ];

    async function load() {
      try { links = await get(`/api/public-share?domainId=${domainId}`); } catch (e) { toast(e.message, 'error'); links = []; }
      list.replaceChildren(table(columns, links, { empty: 'No shared links yet. Create one to share a read-only dashboard.' }));
      for (const a of list.querySelectorAll('[data-open]')) a.href = fullUrl(links.find(l => l.id === Number(a.closest('[data-id]').dataset.id)));
    }

    function openCreate() {
      const body = h(`<form class="pg-sharing-form">
        <label>Name<input name="name" maxlength="120" placeholder="e.g. Monthly client report"></label>
        <label>Expires<select name="expiresInDays"><option value="">Never</option><option value="7">In 7 days</option>
          <option value="30" selected>In 30 days</option><option value="90">In 90 days</option><option value="365">In 1 year</option></select></label>
        <label>Password (optional)<input name="password" type="password" minlength="4" maxlength="200" autocomplete="new-password" placeholder="Leave empty for no password"></label>
        <p class="muted">With a password, viewers are asked for it before the dashboard is shown.</p>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Cancel</button><button class="primary">Create link</button></div>
      </form>`);
      const m = modal('Create share link', body);
      body.querySelector('[data-cancel]').onclick = () => m.close();
      body.querySelector('input').focus();
      body.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(body), btn = body.querySelector('button.primary');
        const payload = { domainId, name: String(fd.get('name')).trim(), expiresInDays: fd.get('expiresInDays') ? Number(fd.get('expiresInDays')) : null };
        if (fd.get('password')) payload.password = String(fd.get('password'));
        btn.disabled = true;
        try {
          const link = await post('/api/public-share', payload);
          m.close(); await load(); showCreated(link);
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    }

    function showCreated(link) {
      const body = h(`<div class="pg-sharing-form"><p>Your link is ready. Anyone with it can view this domain's rankings${link.hasPassword ? ' after entering the password' : ''}.</p>
        <div class="pg-sharing-url"><input readonly value="${esc(fullUrl(link))}" aria-label="Share URL"><button class="primary" data-copy>Copy</button></div></div>`);
      modal('Link created', body);
      const input = body.querySelector('input'); input.select();
      body.querySelector('[data-copy]').onclick = () => copy(input.value);
    }

    root.querySelector('[data-add]').onclick = openCreate;
    list.addEventListener('click', async e => {
      const box = e.target.closest('[data-id]'); if (!box) return;
      const link = links.find(l => l.id === Number(box.dataset.id)); if (!link) return;
      if (e.target.closest('[data-copy]')) copy(fullUrl(link));
      else if (e.target.closest('[data-revoke]') && confirm(`Revoke "${link.name || 'Untitled link'}"? Anyone using it will lose access.`)) {
        try { await del(`/api/public-share/${link.id}`); toast('Link revoked'); await load(); } catch (err) { toast(err.message, 'error'); }
      }
    });
    await load();
  },
};
