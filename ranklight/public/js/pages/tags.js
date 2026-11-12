// Tags: manage keyword tags, see per-tag ranking stats and edit dynamic tag rules.
// Data: /api/tags (?domainId=), /api/tags/:id, /api/tags/:id/rules, /api/tags/preview, /api/tags/apply.
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, table, fmtRank, fmtNum, kpi, fmtDate } from '../ui.js';

const STYLE = `
.pg-tags .layout { display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: 16px; align-items: start; }
.pg-tags form.add { display: flex; gap: 8px; margin-bottom: 12px; }
.pg-tags form.add input[name=name] { flex: 1; min-width: 0; }
.pg-tags input[type=color] { width: 40px; padding: 2px; height: 32px; }
.pg-tags ul.list { list-style: none; margin: 0; padding: 0; }
.pg-tags ul.list a { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; color: var(--text); }
.pg-tags ul.list a:hover, .pg-tags ul.list a.active { background: var(--surface-2); }
.pg-tags .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
  background: color-mix(in srgb, var(--chip) 18%, transparent); color: var(--text); border: 1px solid color-mix(in srgb, var(--chip) 55%, transparent);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-tags .chip::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--chip); flex: none; }
.pg-tags .meta { margin-left: auto; font-size: 12px; color: var(--muted); white-space: nowrap; }
.pg-tags .badge { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--primary); border: 1px solid var(--primary); border-radius: 4px; padding: 0 4px; }
.pg-tags .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 12px 0 16px; }
.pg-tags .dist { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--surface-2); margin: 4px 0 6px; }
.pg-tags .dist span { display: block; }
.pg-tags .legend { font-size: 12px; gap: 12px; margin-bottom: 16px; }
.pg-tags .legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; }
.pg-tags section { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px; }
.pg-tags .rule { display: grid; grid-template-columns: 140px 130px minmax(0, 1fr) auto; gap: 8px; margin-bottom: 8px; }
.pg-tags .rule input, .pg-tags .rule select { min-width: 0; }
.pg-tags .preview { font-size: 12px; margin-top: 8px; }
@media (max-width: 900px) { .pg-tags .layout { grid-template-columns: minmax(0, 1fr); } .pg-tags .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .pg-tags .rule { grid-template-columns: 1fr 1fr; } .pg-tags .rule input { grid-column: 1 / -1; } }
`;
const FIELDS = { phrase: 'Keyword', url: 'Ranking URL', rank: 'Rank', search_volume: 'Search volume', device: 'Device', location: 'Location' };
const NUMERIC = new Set(['rank', 'search_volume']);
const OPS = { contains: 'contains', not_contains: 'does not contain', equals: 'equals', starts_with: 'starts with', regex: 'matches regex', lt: 'less than', gt: 'greater than' };
const opsFor = f => NUMERIC.has(f) ? ['lt', 'gt', 'equals'] : ['contains', 'not_contains', 'equals', 'starts_with', 'regex'];
const DIST = [['1-3', 'var(--c2)'], ['4-10', 'var(--c1)'], ['11-20', 'var(--c3)'], ['21-50', 'var(--c4)'], ['51-100', 'var(--c5)'], ['unranked', 'var(--border)']];
const safeColor = c => /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#6b7280';
const chip = t => `<span class="chip" style="--chip:${safeColor(t.color)}" title="${esc(t.name)}">${esc(t.name)}</span>`;
const options = (map, keys, sel) => keys.map(k => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(map[k])}</option>`).join('');

export default {
  id: 'tags', title: 'Tags', group: 'Tracking', order: 30, nav: true, needsDomain: true,
  async render(el, ctx) {
    const q = `domainId=${encodeURIComponent(ctx.domainId)}`;
    const root = h(`<div class="pg-tags"><style>${STYLE}</style>
      <div class="row"><h1>Tags</h1><span class="spacer"></span><button data-act="apply-all" title="Re-evaluate every dynamic tag now">Apply all rules</button></div>
      <div class="layout">
        <div class="card"><h2>Tags</h2>
          <form class="add"><input name="name" placeholder="New tag name" aria-label="Tag name" maxlength="50" required>
            <input name="color" type="color" value="#2f5bea" aria-label="Tag color"><button class="primary">Add</button></form>
          <div data-list></div></div>
        <div class="card" data-detail></div>
      </div></div>`);
    el.append(root);
    const $ = s => root.querySelector(s);
    let tags = [];
    let selected = Number(ctx.param) || null;
    const fail = e => toast(e.message, 'error');

    async function loadList() {
      tags = await get(`/api/tags?${q}`);
      if (!tags.some(t => t.id === selected)) selected = tags[0]?.id ?? null;
      $('[data-list]').innerHTML = tags.length
        ? `<ul class="list">${tags.map(t => `<li><a href="#/tags/${t.id}" data-id="${t.id}" class="${t.id === selected ? 'active' : ''}">${chip(t)}
            ${t.dynamic ? '<span class="badge">auto</span>' : ''}<span class="meta">${fmtNum(t.keywordCount)} kw · avg ${t.avgRank ?? '–'} · top10 ${fmtNum(t.top10)}</span></a></li>`).join('')}</ul>`
        : '<div class="empty">No tags yet. Create one above, or tag keywords from the Keywords page.</div>';
    }

    async function loadDetail() {
      const box = $('[data-detail]');
      if (!selected) { box.innerHTML = '<div class="empty">Select or create a tag to see its stats and rules.</div>'; return; }
      const t = await get(`/api/tags/${selected}`);
      const s = await get(`/api/tags/${selected}/stats`);
      box.innerHTML = '';
      box.append(h(`<div><div class="row">${chip(t)}${t.dynamic ? `<span class="badge">auto</span><span class="muted" style="font-size:12px">applied ${esc(fmtDate(t.appliedAt))}</span>` : ''}</div>
        <div class="grid kpis" data-kpis></div>
        <div class="dist" role="img" aria-label="Rank distribution">${DIST.map(([k, c]) => s.count && s.distribution[k] ? `<span style="width:${(s.distribution[k] / s.count * 100).toFixed(2)}%;background:${c}" title="${esc(k)}: ${s.distribution[k]}"></span>` : '').join('')}</div>
        <div class="row legend">${DIST.map(([k, c]) => `<span><i style="background:${c}"></i>${esc(k)} ${fmtNum(s.distribution[k])}</span>`).join('')}</div>
        <form class="row" data-edit><label>Name<input name="name" value="${esc(t.name)}" maxlength="50" required></label>
          <label>Color<input name="color" type="color" value="${safeColor(t.color)}"></label>
          <span class="spacer"></span><button class="primary">Save</button><button type="button" class="danger" data-act="delete">Delete tag</button></form>
        <section><h2>Dynamic rules</h2><p class="muted" style="margin-top:0">Keywords matching these rules are tagged automatically, and untagged when they stop matching. Rules re-run when keywords are added or ranks update.</p>
          <form data-rules><div class="row" style="margin-bottom:8px"><label style="flex-direction:row;align-items:center;gap:6px">Match
            <select name="match"><option value="all">all rules</option><option value="any">any rule</option></select></label></div>
            <div data-rows></div>
            <div class="row"><button type="button" data-act="add-rule">+ Add rule</button><span class="spacer"></span>
              <button type="button" data-act="preview">Preview</button>
              ${t.dynamic ? '<button type="button" class="danger" data-act="clear-rules">Remove rules</button>' : ''}
              <button class="primary">Save &amp; apply</button></div>
            <div class="preview muted" data-preview></div></form></section>
        <section><h2>Tagged keywords</h2><div data-kws></div></section></div>`));
      const k = box.querySelector('[data-kpis]');
      k.append(kpi('Keywords', fmtNum(s.count), `${fmtNum(s.unranked)} unranked`), kpi('Average rank', s.avgRank ?? '–', `${fmtNum(s.ranked)} ranked`),
        kpi('Top 10', fmtNum(s.top10), s.count ? `${Math.round(s.top10 / s.count * 100)}% of keywords` : ''), kpi('Top 3', fmtNum(s.top3), `${fmtNum(s.searchVolume)} total volume`));
      box.querySelector('[name=match]').value = t.match || 'all';
      (t.rules?.length ? t.rules : [{ field: 'phrase', op: 'contains', value: '' }]).forEach(addRule);
      box.querySelector('[data-kws]').append(table([
        { key: 'phrase', label: 'Keyword' },
        { key: 'device', label: 'Device' },
        { key: 'location', label: 'Location', render: r => esc(r.location || 'National') },
        { key: 'rank', label: 'Rank', num: true, render: r => fmtRank(r.rank) },
        { key: 'search_volume', label: 'Volume', num: true, render: r => fmtNum(r.search_volume) },
        { key: 'url', label: 'URL', render: r => r.url ? `<span class="muted">${esc(r.url)}</span>` : '–' },
      ], t.keywords, { empty: 'No keywords carry this tag yet', onRowClick: r => ctx.navigate(`#/keyword/${r.id}`) }));
    }

    function addRule(r = { field: 'phrase', op: 'contains', value: '' }) {
      const row = h(`<div class="rule"><select name="field" aria-label="Field">${options(FIELDS, Object.keys(FIELDS), r.field)}</select>
        <select name="op" aria-label="Operator">${options(OPS, opsFor(r.field), r.op)}</select>
        <input name="value" aria-label="Value" value="${esc(r.value ?? '')}" placeholder="Value">
        <button type="button" data-act="del-rule" aria-label="Remove rule">✕</button></div>`);
      const syncType = () => { const num = NUMERIC.has(row.querySelector('[name=field]').value); row.querySelector('[name=value]').type = num ? 'number' : 'text'; };
      row.querySelector('[name=field]').addEventListener('change', e => {
        const op = row.querySelector('[name=op]'), keep = op.value;
        op.innerHTML = options(OPS, opsFor(e.target.value), opsFor(e.target.value).includes(keep) ? keep : undefined);
        syncType();
      });
      syncType();
      $('[data-rows]').append(row);
    }
    const readRules = () => {
      const form = $('form[data-rules]');
      return { match: form.querySelector('[name=match]').value, rules: [...form.querySelectorAll('.rule')].map(r => ({ field: r.querySelector('[name=field]').value, op: r.querySelector('[name=op]').value, value: r.querySelector('[name=value]').value })) };
    };

    async function refresh() { try { await loadList(); await loadDetail(); } catch (e) { fail(e); } }

    $('form.add').addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { const t = await post(`/api/tags?${q}`, { name: String(f.get('name')).trim(), color: f.get('color') }); e.target.reset(); selected = t.id; toast(`Created ${t.name}`); await refresh(); }
      catch (err) { fail(err); }
    });
    root.addEventListener('click', async e => {
      const a = e.target.closest('ul.list a[data-id]');
      if (a) { e.preventDefault(); selected = Number(a.dataset.id); history.replaceState(null, '', `#/tags/${selected}`); return refresh(); }
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'add-rule') return addRule();
      if (act === 'del-rule') return b.closest('.rule').remove();
      b.disabled = true;
      try {
        if (act === 'apply-all') { const r = await post(`/api/tags/apply?${q}`); toast(`Rules applied: ${r.added} added, ${r.removed} removed`); await refresh(); }
        if (act === 'delete') {
          const t = tags.find(x => x.id === selected);
          if (t && confirm(`Delete tag "${t.name}"? Keywords stay, only the tag is removed.`)) { await del(`/api/tags/${selected}`); selected = null; toast('Tag deleted'); await refresh(); }
        }
        if (act === 'clear-rules' && confirm('Remove the rules? The tag keeps its current keywords and becomes a manual tag.')) { await del(`/api/tags/${selected}/rules`); toast('Rules removed'); await refresh(); }
        if (act === 'preview') {
          const p = await post(`/api/tags/preview?${q}`, readRules());
          $('[data-preview]').innerHTML = `<strong>${fmtNum(p.count)}</strong> matching keyword${p.count === 1 ? '' : 's'}${p.count ? ': ' + p.keywords.slice(0, 12).map(k => esc(k.phrase)).join(', ') + (p.count > 12 ? '…' : '') : ''}`;
        }
      } catch (err) { fail(err); } finally { b.disabled = false; }
    });
    root.addEventListener('submit', async e => {
      if (e.target.matches('form[data-edit]')) {
        e.preventDefault();
        const f = new FormData(e.target);
        try { await patch(`/api/tags/${selected}`, { name: String(f.get('name')).trim(), color: f.get('color') }); toast('Tag saved'); await refresh(); } catch (err) { fail(err); }
      } else if (e.target.matches('form[data-rules]')) {
        e.preventDefault();
        try { const r = await post(`/api/tags/${selected}/rules`, readRules()); toast(`Rules saved: ${r.added} added, ${r.removed} removed`); await refresh(); } catch (err) { fail(err); }
      }
    });

    await refresh();
  },
};
