// Keywords grid: filter bar, server-side sorted/paginated table, bulk actions, add-keywords modal.
import { get, post } from '../api.js';
import { h, esc, toast, fmtNum, fmtRank, fmtChange, modal } from '../ui.js';

const FEATURES = {
  featured_snippet: ['FS', 'Featured snippet'], people_also_ask: ['PAA', 'People also ask'], local_pack: ['LP', 'Local pack'],
  knowledge_panel: ['KP', 'Knowledge panel'], image_pack: ['IMG', 'Image pack'], video: ['VID', 'Video'], top_stories: ['NEWS', 'Top stories'],
  shopping: ['SHOP', 'Shopping'], sitelinks: ['SL', 'Sitelinks'], reviews: ['REV', 'Reviews'], faq: ['FAQ', 'FAQ'], twitter: ['X', 'Social posts'],
  ads_top: ['AD↑', 'Ads (top)'], ads_bottom: ['AD↓', 'Ads (bottom)'], related_searches: ['REL', 'Related searches'], ai_overview: ['AI', 'AI overview'],
};
const COLS = [
  { key: 'phrase', label: 'Keyword' }, { key: 'rank', label: 'Rank', num: true }, { key: 'change', label: '1d', num: true },
  { key: 'change_7d', label: '7d', num: true }, { key: 'change_30d', label: '30d', num: true },
  { key: 'search_volume', label: 'Search vol.', num: true }, { key: 'url', label: 'URL' }, { key: null, label: 'SERP features' }, { key: null, label: 'Tags' },
];
const STYLE = `
.pg-keywords .filters { margin-bottom: 12px; align-items: flex-end; }
.pg-keywords .filters input[type=search] { min-width: 200px; }
.pg-keywords .filters .rng input { width: 64px; }
.pg-keywords .bulkbar { margin-bottom: 12px; padding: 8px 12px; background: var(--surface-2); border-radius: var(--radius); }
.pg-keywords tbody tr { cursor: pointer; }
.pg-keywords tbody tr:hover td { background: var(--surface-2); }
.pg-keywords th.sorted { color: var(--text); }
.pg-keywords td.chk, .pg-keywords th.chk { width: 32px; cursor: default; }
.pg-keywords .star { border: 0; background: none; padding: 0 4px 0 0; color: var(--muted); font-size: 15px; }
.pg-keywords .star.on { color: var(--warn); }
.pg-keywords .meta { font-size: 11px; color: var(--muted); }
.pg-keywords .url { max-width: 260px; overflow: hidden; text-overflow: ellipsis; display: inline-block; vertical-align: bottom; }
.pg-keywords .feat { display: inline-block; font-size: 10px; padding: 0 4px; margin-right: 2px; border-radius: 4px; border: 1px solid var(--border); color: var(--muted); }
.pg-keywords .feat.own { border-color: var(--primary); color: var(--primary); font-weight: 600; }
.pg-keywords .tag { margin-right: 4px; border-left: 3px solid var(--tc, var(--border)); }
.pg-keywords .pager { margin-top: 12px; }
.pg-keywords-modal form { display: grid; gap: 12px; }
.pg-keywords-modal textarea { min-height: 160px; width: 100%; }
.pg-keywords-modal .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 600px) { .pg-keywords .filters > * { flex: 1 1 140px; } .pg-keywords-modal .two { grid-template-columns: minmax(0, 1fr); } }
`;
const safeColor = c => (/^#[0-9a-f]{3,8}$/i.test(c) ? c : 'var(--border)');

export default {
  id: 'keywords', title: 'Keywords', group: 'Tracking', order: 20, nav: true, needsDomain: true,
  async render(el, ctx) {
    const st = { q: ctx.query.get('q') || '', tag: ctx.query.get('tag') || '', device: '', starred: false, rankMin: '', rankMax: '',
      sort: 'rank', order: 'asc', page: 1, pageSize: 50, selected: new Set(), rows: [], total: 0, tags: [] };
    const root = h(`<div class="pg-keywords"><style>${STYLE}</style>
      <div class="row"><h1>Keywords</h1><span class="spacer"></span><button class="primary" data-add>+ Add keywords</button></div>
      <form class="row filters">
        <label>Search<input type="search" name="q" placeholder="Filter keywords"></label>
        <label>Tag<select name="tag"></select></label>
        <label>Device<select name="device"><option value="">All devices</option><option value="desktop">Desktop</option><option value="mobile">Mobile</option></select></label>
        <label class="rng">Rank from<input type="number" name="rankMin" min="1" max="101"></label>
        <label class="rng">to<input type="number" name="rankMax" min="1" max="101"></label>
        <label><span>Starred</span><input type="checkbox" name="starred"></label>
      </form>
      <div class="row bulkbar" hidden></div>
      <div class="table-wrap"><table class="data"><thead></thead><tbody></tbody></table></div>
      <div class="row pager"></div></div>`);
    el.append(root);
    const $ = s => root.querySelector(s);
    const f = $('.filters');
    f.addEventListener('submit', e => e.preventDefault());
    f.q.value = st.q;

    const loadTags = async () => {
      st.tags = await get(`/api/keywords/tags?domainId=${ctx.domainId}`);
      f.tag.innerHTML = '<option value="">All tags</option>' + st.tags.map(t => `<option value="${esc(t.name)}">${esc(t.name)} (${t.count})</option>`).join('');
      f.tag.value = st.tag;
    };

    const load = async () => {
      const p = new URLSearchParams({ domainId: ctx.domainId, sort: st.sort, order: st.order, page: st.page, pageSize: st.pageSize });
      for (const k of ['q', 'tag', 'device', 'rankMin', 'rankMax']) if (st[k]) p.set(k, st[k]);
      if (st.starred) p.set('starred', '1');
      try {
        const r = await get(`/api/keywords?${p}`);
        st.rows = r.rows; st.total = r.total;
      } catch (e) { toast(e.message, 'error'); st.rows = []; st.total = 0; }
      st.selected = new Set([...st.selected].filter(id => st.rows.some(r => r.id === id)));
      draw();
    };

    const featCell = r => r.serp_features.map(id => {
      const [abbr, name] = FEATURES[id] || [id.slice(0, 4).toUpperCase(), id];
      const own = r.owned_features.includes(id);
      return `<span class="feat${own ? ' own' : ''}" title="${esc(name)}${own ? ' (owned)' : ''}">${esc(abbr)}</span>`;
    }).join('') || '<span class="muted">–</span>';

    const rowHtml = r => `<tr data-id="${r.id}">
      <td class="chk"><input type="checkbox" data-sel="${r.id}" ${st.selected.has(r.id) ? 'checked' : ''} aria-label="Select keyword"></td>
      <td><button class="star${r.starred ? ' on' : ''}" data-star="${r.id}" title="${r.starred ? 'Unstar' : 'Star'}">${r.starred ? '★' : '☆'}</button>${esc(r.phrase)}
        <div class="meta">${esc(r.device)} · ${esc(r.country)}${r.location ? ' · ' + esc(r.location) : ''} · ${esc(r.search_engine)}</div></td>
      <td class="num">${r.checked_at ? (r.rank == null ? '<span class="muted">100+</span>' : fmtRank(r.rank)) : '<span class="muted" title="Not checked yet">…</span>'}</td>
      <td class="num">${fmtChange(r.change)}</td><td class="num">${fmtChange(r.change_7d)}</td><td class="num">${fmtChange(r.change_30d)}</td>
      <td class="num">${fmtNum(r.search_volume)}</td>
      <td>${r.url ? `<a class="url" href="${esc(/^https?:/i.test(r.url) ? r.url : '#')}" target="_blank" rel="noopener noreferrer" title="${esc(r.url)}">${esc(r.url.replace(/^https?:\/\/(www\.)?/i, ''))}</a>` : '<span class="muted">–</span>'}</td>
      <td>${featCell(r)}</td>
      <td>${r.tags.map(t => `<span class="tag" style="--tc:${safeColor(t.color)}">${esc(t.name)}</span>`).join('')}</td></tr>`;

    const draw = () => {
      const all = st.rows.length && st.rows.every(r => st.selected.has(r.id));
      $('thead').innerHTML = `<tr><th class="chk"><input type="checkbox" data-all ${all ? 'checked' : ''} aria-label="Select all"></th>` + COLS.map(c =>
        `<th class="${c.num ? 'num' : ''}${c.key === st.sort ? ' sorted' : ''}" ${c.key ? `data-k="${c.key}"` : 'style="cursor:default"'}>${esc(c.label)}${c.key === st.sort ? (st.order === 'asc' ? ' ↑' : ' ↓') : ''}</th>`).join('') + '</tr>';
      $('tbody').innerHTML = st.rows.length ? st.rows.map(rowHtml).join('')
        : `<tr><td colspan="${COLS.length + 1}" class="empty">${st.total === 0 && !hasFilters() ? 'No keywords yet. Click “Add keywords” to start tracking.' : 'No keywords match these filters.'}</td></tr>`;
      const pages = Math.max(1, Math.ceil(st.total / st.pageSize));
      $('.pager').innerHTML = `<span class="muted">${fmtNum(st.total)} keywords</span><span class="spacer"></span>
        <button data-pg="-1" ${st.page <= 1 ? 'disabled' : ''}>‹ Prev</button><span>Page ${st.page} / ${pages}</span>
        <button data-pg="1" ${st.page >= pages ? 'disabled' : ''}>Next ›</button>
        <select data-ps>${[25, 50, 100, 250].map(n => `<option ${n === st.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
      drawBulk();
    };
    const hasFilters = () => st.q || st.tag || st.device || st.starred || st.rankMin || st.rankMax;

    const drawBulk = () => {
      const bar = $('.bulkbar'), n = st.selected.size;
      bar.hidden = !n;
      if (!n) return;
      const others = ctx.domains.filter(d => d.id !== ctx.domainId);
      bar.innerHTML = `<strong>${n} selected</strong>
        <button data-act="star">★ Star</button><button data-act="unstar">☆ Unstar</button>
        <button data-act="addTag">Add tag</button><button data-act="removeTag">Remove tag</button>
        ${others.length ? `<select data-move><option value="">Move to…</option>${others.map(d => `<option value="${d.id}">${esc(d.display_name || d.host)}</option>`).join('')}</select>` : ''}
        <span class="spacer"></span><button class="danger" data-act="delete">Delete</button><button data-act="clear">Clear</button>`;
    };

    const bulk = async (action, extra = {}) => {
      try {
        const r = await post('/api/keywords/bulk', { ids: [...st.selected], action, ...extra });
        toast(`${r.affected} keyword${r.affected === 1 ? '' : 's'} updated${r.skipped ? `, ${r.skipped} skipped` : ''}`);
        if (action === 'delete' || action === 'move') st.selected.clear();
        if (action.endsWith('Tag')) await loadTags();
        await load();
      } catch (e) { toast(e.message, 'error'); }
    };

    root.addEventListener('click', async e => {
      const t = e.target;
      if (t.closest('[data-add]')) return openAdd();
      const th = t.closest('th[data-k]');
      if (th) { const k = th.dataset.k; st.order = st.sort === k && st.order === 'asc' ? 'desc' : 'asc'; st.sort = k; st.page = 1; return load(); }
      const pg = t.closest('[data-pg]');
      if (pg) { st.page += Number(pg.dataset.pg); return load(); }
      const star = t.closest('[data-star]');
      if (star) {
        const row = st.rows.find(r => r.id === Number(star.dataset.star));
        try { await post('/api/keywords/bulk', { ids: [row.id], action: row.starred ? 'unstar' : 'star' }); row.starred = !row.starred; draw(); }
        catch (err) { toast(err.message, 'error'); }
        return;
      }
      const act = t.closest('[data-act]')?.dataset.act;
      if (act === 'clear') { st.selected.clear(); return draw(); }
      if (act === 'delete') { if (confirm(`Delete ${st.selected.size} keyword(s) and their ranking history?`)) bulk('delete'); return; }
      if (act === 'addTag' || act === 'removeTag') {
        const tag = prompt(act === 'addTag' ? 'Tag to add' : 'Tag to remove', st.tag || '');
        if (tag && tag.trim()) bulk(act, { tag: tag.trim() });
        return;
      }
      if (act) return bulk(act);
      if (t.closest('input,select,button,a,label,td.chk')) return;
      const tr = t.closest('tbody tr[data-id]');
      if (tr) ctx.navigate(`#/keyword/${tr.dataset.id}`);
    });

    root.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.sel) { const id = Number(t.dataset.sel); t.checked ? st.selected.add(id) : st.selected.delete(id); return draw(); }
      if (t.hasAttribute('data-all')) { st.rows.forEach(r => (t.checked ? st.selected.add(r.id) : st.selected.delete(r.id))); return draw(); }
      if (t.hasAttribute('data-ps')) { st.pageSize = Number(t.value); st.page = 1; return load(); }
      if (t.hasAttribute('data-move') && t.value) {
        const d = ctx.domains.find(x => x.id === Number(t.value));
        if (confirm(`Move ${st.selected.size} keyword(s) to ${d.display_name || d.host}?`)) bulk('move', { domainId: d.id }); else t.value = '';
        return;
      }
      if (t.closest('.filters') && t.name !== 'q') applyFilters();
    });
    let timer;
    f.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(applyFilters, 250); });
    function applyFilters() {
      Object.assign(st, { q: f.q.value.trim(), tag: f.tag.value, device: f.device.value, starred: f.starred.checked,
        rankMin: f.rankMin.value, rankMax: f.rankMax.value, page: 1 });
      load();
    }

    function openAdd() {
      const d = ctx.domain || {};
      const body = h(`<div class="pg-keywords-modal"><form>
        <label>Keywords (one per line)<textarea name="text" required placeholder="best running shoes&#10;trail running shoes"></textarea></label>
        <div class="row"><label class="row" style="flex-direction:row"><input type="checkbox" name="desktop" checked> Desktop</label>
          <label class="row" style="flex-direction:row"><input type="checkbox" name="mobile"> Mobile</label></div>
        <div class="two">
          <label>Search engine<select name="searchEngine"><option value="google">Google</option><option value="bing">Bing</option><option value="youtube">YouTube</option></select></label>
          <label>Country<input name="country" maxlength="2" value="${esc(d.default_country || 'US')}"></label>
          <label>Location (optional)<input name="location" value="${esc(d.default_location || '')}" placeholder="City or ZIP"></label>
          <label>Language<input name="language" maxlength="10" value="${esc(d.default_language || 'en')}"></label>
        </div>
        <label>Tags (comma separated)<input name="tags" list="pg-kw-taglist" placeholder="brand, blog"></label>
        <datalist id="pg-kw-taglist">${st.tags.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>
        <div class="row"><span class="muted" data-count>0 keywords</span><span class="spacer"></span><button type="submit" class="primary">Add keywords</button></div>
      </form></div>`);
      const form = body.querySelector('form');
      const count = () => {
        const n = new Set(form.text.value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)).size;
        const devs = (form.desktop.checked ? 1 : 0) + (form.mobile.checked ? 1 : 0);
        body.querySelector('[data-count]').textContent = `${n * devs} keyword${n * devs === 1 ? '' : 's'} will be created`;
      };
      form.addEventListener('input', count);
      const m = modal('Add keywords', body);
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const devices = ['desktop', 'mobile'].filter(x => form[x].checked);
        if (!devices.length) return toast('Select at least one device', 'error');
        const btn = form.querySelector('[type=submit]');
        btn.disabled = true;
        try {
          const r = await post('/api/keywords', { domainId: ctx.domainId, text: form.text.value, devices, searchEngine: form.searchEngine.value,
            country: form.country.value.trim(), location: form.location.value.trim(), language: form.language.value.trim(),
            tags: form.tags.value.split(',').map(s => s.trim()).filter(Boolean) });
          toast(`Added ${r.created} keyword${r.created === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already tracked)` : ''}`);
          m.close();
          await loadTags(); await load();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
      form.text.focus();
    }

    await Promise.all([loadTags().catch(e => toast(e.message, 'error')), load()]);
  },
};
