// Import / export: download keyword, history and backup files; import keywords from CSV with a server-validated preview.
// Data: GET /api/exports/keywords.csv|history.csv|domain.json?domainId=, POST /api/exports/import?domainId=[&dryRun=1]
import { api } from '../api.js';
import { h, esc, toast, table } from '../ui.js';

const STYLE = `
.pg-import-export .grid2 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin-bottom: 16px; }
.pg-import-export .dl { display: flex; flex-direction: column; gap: 8px; }
.pg-import-export .dl p { margin: 0; color: var(--muted); font-size: 13px; flex: 1; }
.pg-import-export .dl .row { gap: 8px; flex-wrap: wrap; }
.pg-import-export a.btn { display: inline-block; padding: 6px 12px; border-radius: var(--radius); background: var(--primary); color: var(--primary-ink); text-decoration: none; font-weight: 600; }
.pg-import-export textarea { width: 100%; min-height: 160px; font-family: ui-monospace, monospace; font-size: 13px; box-sizing: border-box;
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px; }
.pg-import-export .hint { color: var(--muted); font-size: 13px; margin: 4px 0 12px; }
.pg-import-export .hint code { background: var(--surface-2); padding: 0 4px; border-radius: 4px; }
.pg-import-export .actions { gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.pg-import-export .summary { gap: 16px; flex-wrap: wrap; margin-bottom: 8px; font-weight: 600; }
.pg-import-export .st { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 4px; border: 1px solid currentColor; }
.pg-import-export .st.add { color: var(--up); } .pg-import-export .st.skip { color: var(--muted); } .pg-import-export .st.error { color: var(--down); }
@media (max-width: 900px) { .pg-import-export .grid2 { grid-template-columns: 1fr; } }
`;

export default {
  id: 'import-export', title: 'Import / Export', group: 'Settings', order: 92, nav: true, needsDomain: true,
  async render(el, ctx) {
    const q = `domainId=${encodeURIComponent(ctx.domainId)}`;
    const name = ctx.domain?.display_name || ctx.domain?.host || '';
    const root = h(`<div class="pg-import-export"><style>${STYLE}</style>
      <div class="row"><h1>Import / Export</h1><span class="spacer"></span><span class="muted">${esc(name)}</span></div>
      <div class="grid2">
        <div class="card dl"><h2>Keywords</h2><p>Every tracked keyword with tags, current rank, change since the previous day, ranking URL, volume and SERP features.</p>
          <div class="row"><a class="btn" href="/api/exports/keywords.csv?${q}" download>Download CSV</a></div></div>
        <div class="card dl"><h2>Rank history</h2><p>One row per keyword per day: date, keyword, device, rank and URL.</p>
          <div class="row"><select data-days aria-label="History period">
            ${[[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year'], [3650, 'All time']].map(([v, l]) => `<option value="${v}" ${v === 30 ? 'selected' : ''}>${l}</option>`).join('')}
          </select><a class="btn" data-history href="/api/exports/history.csv?${q}&days=30" download>Download CSV</a></div></div>
        <div class="card dl"><h2>Full backup</h2><p>Domain settings, keywords, tags, competitors and all rank snapshots as JSON.</p>
          <div class="row"><a class="btn" href="/api/exports/domain.json?${q}" download>Download JSON</a></div></div>
      </div>
      <div class="card"><h2>Import keywords</h2>
        <p class="hint">CSV columns: <code>keyword</code>, optional <code>device</code> (desktop/mobile), <code>country</code> (2 letters),
          <code>location</code>, <code>tags</code> (separated by <code>;</code>). The header row is optional; without it columns are read in that order.
          Blank fields use the domain defaults. Existing keywords are skipped.</p>
        <div class="row actions"><input type="file" accept=".csv,text/csv,text/plain" data-file aria-label="CSV file"></div>
        <textarea data-text placeholder="keyword,device,country,location,tags&#10;best running shoes,mobile,US,,shoes;priority" aria-label="CSV text"></textarea>
        <div class="row actions"><button data-preview>Preview</button><button class="primary" data-import disabled>Import</button><button data-clear>Clear</button></div>
        <div data-result></div>
      </div></div>`);
    el.append(root);
    const $ = s => root.querySelector(s);
    const text = $('[data-text]'), result = $('[data-result]'), importBtn = $('[data-import]');

    $('[data-days]').onchange = e => { $('[data-history]').href = `/api/exports/history.csv?${q}&days=${encodeURIComponent(e.target.value)}`; };
    const reset = () => { importBtn.disabled = true; result.innerHTML = ''; };
    text.oninput = reset;
    $('[data-file]').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 5e6) { toast('File is larger than 5 MB', 'error'); return; }
      text.value = await f.text(); reset(); preview();
    };
    $('[data-clear]').onclick = () => { text.value = ''; $('[data-file]').value = ''; reset(); };
    $('[data-preview]').onclick = () => preview();
    importBtn.onclick = async () => {
      importBtn.disabled = true;
      try {
        const r = await api('POST', `/api/exports/import?${q}`, { csv: text.value });
        toast(`Imported ${r.added} keyword${r.added === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} skipped` : ''}${r.errors.length ? `, ${r.errors.length} with errors` : ''}`);
        result.innerHTML = '';
        result.append(h(`<div class="row summary"><span class="up">${r.added} added</span><span class="muted">${r.skipped} skipped</span><span class="down">${r.errors.length} errors</span></div>`));
        if (r.errors.length) result.append(table([{ key: 'line', label: 'Line', num: true }, { key: 'error', label: 'Error' }], r.errors));
      } catch (e) { toast(e.message, 'error'); importBtn.disabled = false; }
    };

    async function preview() {
      if (!text.value.trim()) { toast('Paste CSV or choose a file first', 'error'); return; }
      try {
        const r = await api('POST', `/api/exports/import?${q}&dryRun=1`, { csv: text.value });
        result.innerHTML = '';
        result.append(h(`<div class="row summary"><span class="up">${r.added} to add</span><span class="muted">${r.skipped} to skip</span><span class="down">${r.errors.length} errors</span></div>`));
        result.append(table([
          { key: 'line', label: 'Line', num: true },
          { key: 'status', label: 'Status', render: x => `<span class="st ${esc(x.status)}">${esc(x.status)}</span>` },
          { key: 'keyword', label: 'Keyword' }, { key: 'device', label: 'Device' }, { key: 'country', label: 'Country' },
          { key: 'location', label: 'Location' },
          { key: 'tags', label: 'Tags / error', render: x => x.error ? `<span class="down">${esc(x.error)}</span>` : esc(x.tags.join(', ')) },
        ], r.rows, { empty: 'No rows' }));
        importBtn.disabled = !r.added;
      } catch (e) { reset(); toast(e.message, 'error'); }
    }
  },
};
