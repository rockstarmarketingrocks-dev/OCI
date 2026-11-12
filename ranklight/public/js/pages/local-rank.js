// Local rankings: rank by location, map-pack ownership and an on-demand geo-grid scan.
import { get, post } from '../api.js';
import { h, esc, fmtNum, fmtRank, fmtDate, table, kpi, toast } from '../ui.js';

const STYLE = `
.pg-local .kpis { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); margin-bottom: 16px; }
.pg-local section { margin-bottom: 20px; }
.pg-local .grid-form { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); align-items: end; margin-bottom: 12px; }
.pg-local .grid-form label { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
.pg-local .grid-form input, .pg-local .grid-form select { font: inherit; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--surface); color: var(--text); min-width: 0; }
.pg-local .grid-out { display: grid; gap: 16px; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); align-items: start; }
@media (max-width: 760px) { .pg-local .grid-out { grid-template-columns: 1fr; } }
.pg-local svg.geo { width: 100%; height: auto; display: block; }
.pg-local svg.geo rect { stroke: var(--surface); stroke-width: 2; }
.pg-local svg.geo text { font: 600 13px var(--font); pointer-events: none; }
.pg-local .r-top3 { --band: var(--up); } .pg-local .r-top10 { --band: color-mix(in srgb, var(--up) 55%, var(--warn)); }
.pg-local .r-top20 { --band: var(--warn); } .pg-local .r-low { --band: var(--down); } .pg-local .r-none { --band: var(--surface-2); }
.pg-local svg.geo rect[class^="r-"] { fill: var(--band); }
.pg-local .t-on { fill: #fff; } .pg-local .t-off { fill: var(--muted); }
.pg-local svg.geo .center { fill: none; stroke: var(--text); stroke-width: 2; stroke-dasharray: 4 3; }
.pg-local .legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; margin-top: 8px; }
.pg-local .legend i { background: var(--band); border: 1px solid var(--border); display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -2px; margin-right: 4px; }
.pg-local .pill { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); }
.pg-local .pill.own { color: var(--up); }
`;
const BANDS = [['r-top3', '1–3', r => r <= 3], ['r-top10', '4–10', r => r <= 10], ['r-top20', '11–20', r => r <= 20], ['r-low', '21–100', () => true]];
const band = r => r == null ? 'r-none' : BANDS.find(b => b[2](r))[0];
const locLabel = (country, location) => location ? `${location}, ${country}` : `${country} (national)`;

function gridSvg(data) {
  const n = data.size, C = 56, W = n * C;
  const cells = data.cells.map(c => {
    const x = c.col * C, y = c.row * C, cls = band(c.rank);
    const tip = `${c.lat}, ${c.lng}: ${c.rank == null ? 'not in top 100' : 'rank ' + c.rank}${c.packPosition ? ` · map pack #${c.packPosition}` : ''}`;
    return `<g><title>${esc(tip)}</title><rect x="${x}" y="${y}" width="${C}" height="${C}" rx="8" class="${cls}"/>
      <text x="${x + C / 2}" y="${y + C / 2 + 5}" text-anchor="middle" class="${c.rank == null ? 't-off' : 't-on'}">${esc(c.rank == null ? '–' : c.rank)}</text></g>`;
  }).join('');
  const mid = (n - 1) / 2 * C;
  return `<svg class="geo" viewBox="-2 -2 ${W + 4} ${W + 4}" role="img" aria-label="${esc(`Geo grid for ${data.phrase}, ${n} by ${n}`)}">${cells}
    <rect class="center" x="${mid + 3}" y="${mid + 3}" width="${C - 6}" height="${C - 6}" rx="6"/></svg>`;
}

export default {
  id: 'local', title: 'Local Rankings', group: 'Insights', order: 60, nav: true, needsDomain: true,
  async render(el, ctx) {
    const root = h(`<div class="pg-local"><style>${STYLE}</style><h1>Local rankings</h1>
      <div class="grid kpis"></div>
      <section class="card"><h2>Geo-grid scan</h2>
        <form class="grid-form">
          <label>Keyword<select name="keywordId" required></select></label>
          <label>Center city<input name="place" list="pg-local-places" placeholder="Search a city…" autocomplete="off"></label>
          <label>Latitude<input name="lat" type="number" step="any" min="-90" max="90" required></label>
          <label>Longitude<input name="lng" type="number" step="any" min="-180" max="180" required></label>
          <label>Grid<select name="size"><option value="3">3 × 3</option><option value="5" selected>5 × 5</option><option value="7">7 × 7</option></select></label>
          <label>Spacing (km)<input name="spacingKm" type="number" step="0.1" min="0.1" max="50" value="1" required></label>
          <button class="primary" type="submit">Run scan</button>
          <datalist id="pg-local-places"></datalist>
        </form>
        <div class="grid-result muted">Pick a keyword and a center point, then run a scan.</div></section>
      <section><h2>Rankings by location</h2><div class="by-loc"><div class="empty">Loading…</div></div></section>
      <section><h2>Map pack</h2><div class="pack"><div class="empty">Loading…</div></div></section></div>`);
    el.append(root);
    const q = s => root.querySelector(s), form = q('form');
    const qs = new URLSearchParams({ domainId: ctx.domainId });

    const [byLoc, pack, kws] = await Promise.all([`by-location`, `map-pack`, `keywords`].map(p =>
      get(`/api/local-rank/${p}?${qs}`).catch(e => ({ error: e.message }))));

    if (byLoc.error) q('.by-loc').replaceChildren(h(`<div class="card down">Could not load locations: ${esc(byLoc.error)}</div>`));
    else q('.by-loc').replaceChildren(table([
      { key: 'location', label: 'Location', render: l => esc(l.location || 'National') },
      { key: 'countryName', label: 'Country', render: l => `${esc(l.countryName)} <span class="muted">${esc(l.country)}</span>` },
      { key: 'keywords', label: 'Keywords', num: true, render: l => esc(fmtNum(l.keywords)) },
      { key: 'avgRank', label: 'Avg rank', num: true, render: l => esc(l.avgRank ?? '–') },
      { key: 'top3', label: 'Top 3', num: true, render: l => esc(fmtNum(l.top3)) },
      { key: 'top10', label: 'Top 10', num: true, render: l => esc(fmtNum(l.top10)) },
    ], byLoc.locations, { empty: 'No keywords yet', onRowClick: l => l.lat != null && setCenter(l.lat, l.lng, l.location || l.countryName) }));

    if (pack.error) q('.pack').replaceChildren(h(`<div class="card down">Could not load map pack data: ${esc(pack.error)}</div>`));
    else q('.pack').replaceChildren(table([
      { key: 'phrase', label: 'Keyword', render: k => `<a href="#/keyword/${encodeURIComponent(k.id)}">${esc(k.phrase)}</a> <span class="muted">${esc(k.device)}</span>` },
      { key: 'location', label: 'Location', render: k => esc(locLabel(k.country, k.location)) },
      { key: 'owned', label: 'Map pack', render: k => k.owned ? '<span class="pill own">Owned</span>' : '<span class="pill">Not owned</span>' },
      { key: 'packPosition', label: 'Pack position', num: true, render: k => esc(k.packPosition ?? '–') },
      { key: 'rank', label: 'Organic rank', num: true, render: k => esc(fmtRank(k.rank)) },
      { key: 'checkedAt', label: 'Checked', render: k => esc(fmtDate(k.checkedAt)) },
    ], pack.keywords, { empty: 'No tracked keyword shows a map pack yet' }));

    const locs = byLoc.locations || [];
    q('.kpis').append(
      kpi('Locations tracked', esc(fmtNum(locs.length))),
      kpi('Local keywords', esc(fmtNum(locs.filter(l => l.location).reduce((s, l) => s + l.keywords, 0))), 'with a city or area set'),
      kpi('Map packs owned', esc(pack.error ? '–' : `${fmtNum(pack.owned)} / ${fmtNum(pack.total)}`), 'of keywords showing a map pack'));

    // ---- Geo grid ----
    const keywords = kws.keywords || [];
    form.keywordId.innerHTML = keywords.length ? keywords.map(k => `<option value="${esc(k.id)}">${esc(k.phrase)} · ${esc(locLabel(k.country, k.location))}</option>`).join('')
      : '<option value="">No keywords</option>';
    let places = [];
    function setCenter(lat, lng, name) { form.lat.value = lat; form.lng.value = lng; if (name) form.place.value = name; }
    const centerFor = k => { const l = locs.find(x => x.country === k?.country && x.location === k?.location); if (l?.lat != null) setCenter(l.lat, l.lng, l.location || l.countryName); };
    centerFor(keywords[0]);
    form.keywordId.addEventListener('change', () => centerFor(keywords.find(k => String(k.id) === form.keywordId.value)));

    let timer;
    form.place.addEventListener('input', () => {
      clearTimeout(timer);
      const val = form.place.value.trim(), pick = places.find(p => `${p.name}, ${p.country}` === val || p.name === val);
      if (pick) { setCenter(pick.lat, pick.lng); return; }
      timer = setTimeout(async () => {
        try { places = (await get(`/api/local-rank/locations?${new URLSearchParams({ q: val, limit: 12 })}`)).results; }
        catch { places = []; }
        q('#pg-local-places').innerHTML = places.map(p => `<option value="${esc(`${p.name}, ${p.country}`)}">${esc(p.type)}</option>`).join('');
      }, 200);
    });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = form.querySelector('button'), out = q('.grid-result');
      if (!form.keywordId.value) { toast('Add a keyword first', 'error'); return; }
      btn.disabled = true; out.replaceChildren(h('<div class="empty">Scanning…</div>'));
      try {
        const d = await post('/api/local-rank/grid', { keywordId: Number(form.keywordId.value), center: { lat: Number(form.lat.value), lng: Number(form.lng.value) },
          size: Number(form.size.value), spacingKm: Number(form.spacingKm.value) });
        const s = d.stats;
        out.className = 'grid-result';
        out.replaceChildren(h(`<div class="grid-out"><div>${gridSvg(d)}
            <div class="legend">${BANDS.map(([c, l]) => `<span><i class="${c}"></i>${esc(l)}</span>`).join('')}<span><i class="r-none"></i>Not found</span></div></div>
          <div class="grid kpis">${[['Average rank', s.avgRank ?? '–'], ['Found', `${s.found} / ${s.total}`], ['Top 3 points', s.top3], ['Top 10 points', s.top10]]
            .map(([l, v]) => `<div class="card kpi"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`).join('')}
            <div class="muted" style="grid-column:1/-1">${esc(d.phrase)} · ${esc(d.host)} · ${esc(d.size)}×${esc(d.size)} at ${esc(d.spacingKm)} km ·
              ${d.source === 'provider' ? 'live SERP checks' : 'simulated (no rank provider configured)'}</div></div></div>`));
      } catch (err) { out.replaceChildren(h(`<div class="down">Scan failed: ${esc(err.message)}</div>`)); }
      finally { btn.disabled = false; }
    });
  },
};
