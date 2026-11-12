// Discovery: import a Google Search Console "Queries" CSV and turn untracked queries into keywords.
// Data: /api/gsc-import/csv, /api/gsc-import/opportunities, /api/gsc-import/track, /api/gsc-import/oauth/status.
import { get, post, api, del } from '../api.js';
import { h, esc, toast, fmtNum, fmtDate, kpi } from '../ui.js';

const STYLE = `
.pg-discovery .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 16px; }
.pg-discovery .upload { display: grid; gap: 10px; margin-bottom: 16px; }
.pg-discovery .drop { border: 2px dashed var(--border); border-radius: var(--radius); padding: 18px; text-align: center; color: var(--muted); cursor: pointer; }
.pg-discovery .drop.over { border-color: var(--primary); color: var(--text); background: var(--surface-2); }
.pg-discovery textarea { width: 100%; min-height: 90px; font: 12px/1.4 ui-monospace, monospace; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px; }
.pg-discovery .toolbar { margin-bottom: 10px; }
.pg-discovery .toolbar input[type=search] { min-width: 0; flex: 1 1 200px; }
.pg-discovery .flag { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; white-space: nowrap;
  color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.pg-discovery td.q { white-space: normal; min-width: 180px; }
.pg-discovery td.pg { max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.pg-discovery .note { font-size: 12px; }
@media (max-width: 800px) { .pg-discovery .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

export default {
  id: 'discovery', title: 'Discovery', group: 'Discovery', order: 70, nav: true, needsDomain: true,
  async render(el, ctx) {
    const dq = `domainId=${encodeURIComponent(ctx.domainId)}`;
    const root = h(`<div class="pg-discovery"><style>${STYLE}</style>
      <div class="row"><h1>Discovery</h1><span class="spacer"></span><span class="muted note" data-oauth></span></div>
      <div class="grid kpis" data-kpis></div>
      <div class="card upload"><h2>Import Search Console queries</h2>
        <p class="muted note">In Search Console open Performance, export, and upload the <b>Queries</b> CSV (columns: Top queries, Clicks, Impressions, CTR, Position).</p>
        <label class="drop" data-drop tabindex="0">Drop a CSV here or click to choose a file<input type="file" accept=".csv,text/csv,text/plain" hidden></label>
        <details><summary>Or paste CSV text</summary><textarea placeholder="Top queries,Clicks,Impressions,CTR,Position" aria-label="CSV text"></textarea>
          <div class="row"><button class="primary" data-act="paste">Import pasted CSV</button></div></details>
      </div>
      <div class="card"><div class="row toolbar">
          <h2 style="margin:0">Opportunities</h2><span class="spacer"></span>
          <input type="search" placeholder="Filter queries" aria-label="Filter queries">
          <label class="row"><input type="checkbox" data-striking> Striking distance only</label>
          <select aria-label="Device" data-device><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select>
          <button class="primary" data-act="track" disabled>Track selected</button>
          <button class="danger" data-act="clear" title="Delete imported Search Console data for this domain">Clear import</button>
        </div><div data-table></div></div>
    </div>`);
    el.append(root);
    const $ = s => root.querySelector(s);
    const fail = e => toast(e.message, 'error');
    let data = { opportunities: [] }, selected = new Set(), timer;

    get('/api/gsc-import/oauth/status').then(s => { $('[data-oauth]').textContent = s.configured ? 'Search Console API client configured' : 'CSV import mode'; }).catch(() => {});

    const syncTrackBtn = () => { const b = $('[data-act=track]'); b.disabled = !selected.size; b.textContent = selected.size ? `Track selected (${selected.size})` : 'Track selected'; };

    function drawKpis() {
      const rows = data.opportunities;
      const k = $('[data-kpis]'); k.innerHTML = '';
      k.append(kpi('Imported queries', fmtNum(data.imported ?? 0), data.lastImportedAt ? `Last import ${esc(fmtDate(data.lastImportedAt))}` : 'No import yet'),
        kpi('Untracked opportunities', fmtNum(data.total ?? 0)),
        kpi('Striking distance', fmtNum(data.strikingDistance ?? 0), 'Average position 8–20'),
        kpi('Impressions (shown)', fmtNum(rows.reduce((a, r) => a + r.impressions, 0))));
    }

    function drawTable() {
      const rows = data.opportunities;
      const allOn = rows.length && rows.every(r => selected.has(r.query));
      const wrap = h(`<div class="table-wrap"><table class="data"><thead><tr>
        <th><input type="checkbox" data-all aria-label="Select all" ${allOn ? 'checked' : ''}></th><th>Query</th><th class="num">Impressions</th>
        <th class="num">Clicks</th><th class="num">CTR</th><th class="num">Position</th><th>Flags</th><th>Top page</th></tr></thead><tbody>${
        rows.length ? rows.map((r, i) => `<tr><td><input type="checkbox" data-i="${i}" aria-label="Select ${esc(r.query)}" ${selected.has(r.query) ? 'checked' : ''}></td>
          <td class="q">${esc(r.query)}</td><td class="num">${fmtNum(r.impressions)}</td><td class="num">${fmtNum(r.clicks)}</td>
          <td class="num">${(r.ctr * 100).toFixed(2)}%</td><td class="num">${r.position == null ? '–' : esc(r.position)}</td>
          <td>${r.flags.map(f => `<span class="flag">${esc(f)}</span>`).join(' ')}</td>
          <td class="pg" title="${esc(r.page || '')}">${r.page ? esc(r.page) : '<span class="muted">–</span>'}</td></tr>`).join('')
        : `<tr><td colspan="8" class="empty">${data.imported ? 'Every imported query is already tracked.' : 'Import a Search Console CSV to discover keywords.'}</td></tr>`}</tbody></table></div>`);
      wrap.addEventListener('change', e => {
        if (e.target.matches('[data-all]')) { rows.forEach(r => (e.target.checked ? selected.add(r.query) : selected.delete(r.query))); drawTable(); }
        else if (e.target.dataset.i != null) { const q = rows[e.target.dataset.i].query; e.target.checked ? selected.add(q) : selected.delete(q); }
        syncTrackBtn();
      });
      $('[data-table]').replaceChildren(wrap);
    }

    async function load() {
      const q = encodeURIComponent($('input[type=search]').value.trim());
      data = await get(`/api/gsc-import/opportunities?${dq}&q=${q}${$('[data-striking]').checked ? '&strikingOnly=1' : ''}`);
      const visible = new Set(data.opportunities.map(r => r.query));
      selected = new Set([...selected].filter(q => visible.has(q)));
      drawKpis(); drawTable(); syncTrackBtn();
    }

    async function importCsv(text) {
      if (!text.trim()) return toast('CSV is empty', 'error');
      try {
        const r = await api('POST', `/api/gsc-import/csv?${dq}`, text);
        toast(`Imported ${fmtNum(r.imported)} queries${r.skipped ? `, skipped ${fmtNum(r.skipped)} invalid rows` : ''}`);
        await load();
      } catch (e) { fail(e); }
    }
    const readFile = f => f && f.text().then(importCsv).catch(fail);

    const drop = $('[data-drop]'), file = drop.querySelector('input');
    file.addEventListener('change', () => { readFile(file.files[0]); file.value = ''; });
    drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
    $('[data-act=paste]').addEventListener('click', () => importCsv($('textarea').value));
    $('input[type=search]').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(fail), 250); });
    $('[data-striking]').addEventListener('change', () => load().catch(fail));
    $('[data-act=track]').addEventListener('click', async () => {
      try {
        const r = await post('/api/gsc-import/track', { domainId: ctx.domainId, queries: [...selected], device: $('[data-device]').value });
        toast(`Now tracking ${fmtNum(r.added)} keyword${r.added === 1 ? '' : 's'}${r.skipped ? ` (${fmtNum(r.skipped)} already tracked)` : ''}`);
        selected.clear(); await load();
      } catch (e) { fail(e); }
    });
    $('[data-act=clear]').addEventListener('click', async () => {
      if (!confirm('Delete all imported Search Console data for this domain?')) return;
      try { await del(`/api/gsc-import?${dq}`); selected.clear(); await load(); } catch (e) { fail(e); }
    });

    await load();
  },
};
