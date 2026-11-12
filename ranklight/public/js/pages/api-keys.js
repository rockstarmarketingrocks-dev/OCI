// API: manage personal API keys and browse the public API reference with curl examples.
// Data: /api/api-keys (list/create/PATCH/revoke/DELETE), /api/api-keys/docs, /api/_meta/modules.
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, modal, table, fmtDate } from '../ui.js';

const STYLE = `
.pg-api section { margin-bottom: 24px; }
.pg-api .create { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 12px; }
.pg-api .create label { flex: 1 1 240px; min-width: 0; }
.pg-api code, .pg-api-key code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.pg-api .status-revoked { color: var(--down); }
.pg-api .actions { display: flex; gap: 6px; }
.pg-api .module { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 16px 0 8px; }
.pg-api .ep { margin-bottom: 10px; }
.pg-api .ep.off { opacity: .6; }
.pg-api .ep-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pg-api .ep-head code { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.pg-api .method { font: 600 11px/1 ui-monospace, monospace; padding: 4px 6px; border-radius: 4px; color: #fff; background: var(--c1); }
.pg-api .method.POST { background: var(--c2); } .pg-api .method.PATCH, .pg-api .method.PUT { background: var(--c3); } .pg-api .method.DELETE { background: var(--c5); }
.pg-api .params { margin: 8px 0 0; padding-left: 18px; font-size: 13px; }
.pg-api pre, .pg-api-key pre { position: relative; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin: 8px 0 0;
  overflow-x: auto; white-space: pre; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.pg-api .copy { float: right; font-size: 12px; padding: 2px 8px; }
.pg-api-key { display: grid; gap: 12px; }
.pg-api-key .warn { color: var(--warn); }
.pg-api-key pre { white-space: pre-wrap; word-break: break-all; }
`;

const shellQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
function curl(ep, origin, domainId) {
  const path = ep.path.replace(/:(\w+)/g, (_, n) => (n === 'id' && ep.module === 'domains' && domainId ? domainId : `{${n}}`));
  const qs = (ep.params || []).filter(p => p.in === 'query' && p.required).map(p => `${p.name}=${p.name === 'domainId' && domainId ? domainId : `{${p.name}}`}`);
  const url = origin + path + (qs.length ? `?${qs.join('&')}` : '');
  const lines = [`curl${ep.method === 'GET' ? '' : ` -X ${ep.method}`} ${shellQuote(url)}`, `  -H 'x-api-key: rl_YOUR_KEY'`];
  if (ep.body) {
    const body = domainId && 'domainId' in ep.body ? { ...ep.body, domainId } : ep.body;
    lines.push(`  -H 'content-type: application/json'`, `  -d ${shellQuote(JSON.stringify(body))}`);
  }
  return lines.join(' \\\n');
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy failed; select the text and copy it manually', 'error'); }
}

export default {
  id: 'api', title: 'API', group: 'Settings', order: 94, nav: true, needsDomain: false,
  async render(el, ctx) {
    const root = h(`<div class="pg-api"><style>${STYLE}</style>
      <h1>API</h1>
      <p class="muted">Use personal API keys to read and manage your rank data from scripts, BI tools and integrations. Send the key in the <code>x-api-key</code> header. A key acts with your full account access; keys cannot be used to manage other keys.</p>
      <section><h2>API keys</h2>
        <form class="card create"><label>New key name<input name="name" required maxlength="80" placeholder="e.g. Reporting dashboard"></label><button class="primary">Create key</button></form>
        <div data-keys></div></section>
      <section><h2>API reference</h2><div data-docs><div class="empty">Loading…</div></div></section></div>`);
    el.append(root);
    const keysEl = root.querySelector('[data-keys]'), docsEl = root.querySelector('[data-docs]');
    let keys = [];

    async function loadKeys() {
      try { keys = await get('/api/api-keys'); } catch (e) { toast(e.message, 'error'); keys = []; }
      keysEl.replaceChildren(table([
        { key: 'name', label: 'Name' },
        { key: 'prefix', label: 'Key', render: k => `<code>${esc(k.prefix)}…</code>` },
        { key: 'createdAt', label: 'Created', render: k => esc(fmtDate(k.createdAt)) },
        { key: 'lastUsedAt', label: 'Last used', render: k => (k.lastUsedAt ? esc(new Date(k.lastUsedAt).toLocaleString()) : '<span class="muted">Never</span>') },
        { key: 'revoked', label: 'Status', render: k => (k.revoked ? '<span class="status-revoked">Revoked</span>' : '<span class="up">Active</span>') },
        { key: 'id', label: '', render: k => `<div class="actions" data-id="${k.id}"><button data-rename>Rename</button>${k.revoked ? '' : '<button data-revoke>Revoke</button>'}<button class="danger" data-del>Delete</button></div>` },
      ], keys, { empty: 'No API keys yet. Create one above.' }));
    }

    function showNewKey(k) {
      const body = h(`<div class="pg-api-key">
        <p class="warn">Copy this key now. For your security it is stored hashed and will not be shown again.</p>
        <pre><code>${esc(k.key)}</code></pre>
        <div class="row"><span class="spacer"></span><button data-copy>Copy key</button><button class="primary" data-done>Done</button></div></div>`);
      const m = modal(`API key "${k.name}" created`, body);
      body.querySelector('[data-copy]').onclick = () => copy(k.key);
      body.querySelector('[data-done]').onclick = () => m.close();
    }

    const form = root.querySelector('form.create');
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true;
      try {
        const k = await post('/api/api-keys', { name: form.elements.name.value.trim() });
        form.reset(); showNewKey(k); await loadKeys();
      } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    });

    keysEl.addEventListener('click', async e => {
      const box = e.target.closest('[data-id]'); if (!box || !e.target.closest('button')) return;
      const k = keys.find(x => x.id === Number(box.dataset.id)); if (!k) return;
      try {
        if (e.target.closest('[data-rename]')) {
          const name = prompt('New name for this key', k.name);
          if (name == null || !name.trim() || name.trim() === k.name) return;
          await patch(`/api/api-keys/${k.id}`, { name: name.trim() }); toast('Key renamed');
        } else if (e.target.closest('[data-revoke]')) {
          if (!confirm(`Revoke "${k.name}"? Apps using it will stop working immediately.`)) return;
          await post(`/api/api-keys/${k.id}/revoke`); toast('Key revoked');
        } else if (e.target.closest('[data-del]')) {
          if (!confirm(`Delete "${k.name}" permanently?`)) return;
          await del(`/api/api-keys/${k.id}`); toast('Key deleted');
        } else return;
        await loadKeys();
      } catch (err) { toast(err.message, 'error'); }
    });

    async function loadDocs() {
      let docs, mods;
      try { [docs, mods] = await Promise.all([get('/api/api-keys/docs'), get('/api/_meta/modules').catch(() => null)]); }
      catch (e) { docsEl.replaceChildren(h(`<div class="card down">Could not load the API reference: ${esc(e.message)}</div>`)); return; }
      const installed = ep => ep.module === 'core' || !mods || mods.includes(ep.module);
      const groups = new Map();
      for (const ep of docs) (groups.get(ep.module) || groups.set(ep.module, []).get(ep.module)).push(ep);
      const origin = location.origin;
      docsEl.innerHTML = `<div class="card"><h2>Authentication</h2>
          <p class="muted">Every request needs a key in the <code>x-api-key</code> header. Responses are JSON; errors return <code>{ "error": "message" }</code> with a 4xx/5xx status.</p>
          <pre><button class="copy" data-copy>Copy</button><code>${esc(curl(docs.find(d => d.path === '/api/auth/me') || docs[0], origin))}</code></pre></div>` +
        [...groups].map(([mod, eps]) => `<div class="module">${esc(mod)}${eps.some(installed) ? '' : ' (not installed)'}</div>` + eps.map(ep => `
          <div class="card ep ${installed(ep) ? '' : 'off'}">
            <div class="ep-head"><span class="method ${esc(ep.method)}">${esc(ep.method)}</span><code>${esc(ep.path)}</code><span class="muted">${esc(ep.summary)}</span></div>
            ${ep.params?.length ? `<ul class="params">${ep.params.map(p => `<li><code>${esc(p.name)}</code> <span class="muted">(${esc(p.in)}${p.required ? ', required' : ''})</span> ${esc(p.description)}</li>`).join('')}</ul>` : ''}
            <pre><button class="copy" data-copy>Copy</button><code>${esc(curl(ep, origin, ctx.domainId))}</code></pre>
          </div>`).join('')).join('');
    }
    docsEl.addEventListener('click', e => {
      const b = e.target.closest('[data-copy]'); if (b) copy(b.parentElement.querySelector('code').textContent);
    });

    await Promise.all([loadKeys(), loadDocs()]);
  },
};
