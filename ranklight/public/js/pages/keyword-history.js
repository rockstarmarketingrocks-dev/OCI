// Keyword detail page: #/keyword/<keywordId>?days=90&date=YYYY-MM-DD
// Rank history chart (inverted), SERP snapshot viewer with domain/competitor flags, ranking URL history.
import { get } from '../api.js';
import { h, esc, fmtRank, fmtDate, table, lineChart, kpi } from '../ui.js';

const FEATURE_NAMES = {
  featured_snippet: 'Featured snippet', people_also_ask: 'People also ask', local_pack: 'Local pack', knowledge_panel: 'Knowledge panel',
  image_pack: 'Image pack', video: 'Video', top_stories: 'Top stories', shopping: 'Shopping', sitelinks: 'Sitelinks', reviews: 'Reviews',
  faq: 'FAQ', twitter: 'Social posts', ads_top: 'Ads (top)', ads_bottom: 'Ads (bottom)', related_searches: 'Related searches', ai_overview: 'AI overview',
};
const RANGES = [[30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year'], [730, '2 years']];
const STYLE = `
.pg-keyword .back { display: inline-block; margin-bottom: 8px; }
.pg-keyword h1 { margin-bottom: 6px; word-break: break-word; }
.pg-keyword .meta { margin-bottom: 16px; }
.pg-keyword .kpis { grid-template-columns: repeat(4, minmax(0,1fr)); margin-bottom: 16px; }
.pg-keyword .card { margin-bottom: 16px; min-width: 0; }
.pg-keyword .card > .row:first-child { margin-bottom: 12px; }
.pg-keyword .card h2 { margin: 0; }
.pg-keyword .feat { display: inline-block; font-size: 11px; padding: 1px 6px; margin: 0 4px 4px 0; border-radius: 4px; border: 1px solid var(--border); color: var(--muted); }
.pg-keyword .feat.own { border-color: var(--primary); color: var(--primary); font-weight: 600; }
.pg-keyword .res { display: flex; flex-direction: column; max-width: 520px; white-space: normal; }
.pg-keyword .res a, .pg-keyword .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.pg-keyword .flag { font-size: 11px; padding: 1px 6px; border-radius: 999px; font-weight: 600; }
.pg-keyword .flag.you { background: var(--primary); color: var(--primary-ink); }
.pg-keyword .flag.comp { border: 1px solid var(--warn); color: var(--warn); }
.pg-keyword .flag.type { border: 1px solid var(--border); color: var(--muted); font-weight: 400; }
.pg-keyword .urls { list-style: none; margin: 0; padding: 0; }
.pg-keyword .urls li { display: grid; grid-template-columns: 180px minmax(0,1fr) auto; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
.pg-keyword .urls li:last-child { border-bottom: 0; }
.pg-keyword .urls .url { display: block; }
@media (max-width: 700px) {
  .pg-keyword .kpis { grid-template-columns: repeat(2, minmax(0,1fr)); }
  .pg-keyword .urls li { grid-template-columns: 1fr; gap: 2px; }
}
`;
const safeHref = u => (/^https?:\/\//i.test(u || '') ? esc(u) : '#');
const link = u => (u ? `<a class="url" href="${safeHref(u)}" target="_blank" rel="noopener noreferrer" title="${esc(u)}">${esc(u)}</a>` : '<span class="muted">Not ranking</span>');
const features = (all = [], owned = []) => all.length
  ? all.map(f => `<span class="feat ${owned.includes(f) ? 'own' : ''}" title="${esc(FEATURE_NAMES[f] || f)}${owned.includes(f) ? ' (owned)' : ''}">${esc(FEATURE_NAMES[f] || f)}</span>`).join('')
  : '<span class="muted">No SERP features</span>';

export default {
  id: 'keyword', title: 'Keyword', group: 'Tracking', order: 21, nav: false, needsDomain: false,
  async render(el, ctx) {
    const id = Number(ctx.param);
    const root = h(`<div class="pg-keyword"><style>${STYLE}</style><a class="back" href="#/keywords">&larr; Back to keywords</a></div>`);
    el.append(root);
    if (!Number.isInteger(id) || id < 1) { root.append(h('<div class="card empty">No keyword selected.</div>')); return; }

    let days = Number(ctx.query.get('days')) || 90;
    if (!RANGES.some(([d]) => d === days)) days = 90;
    const [hist, urls] = await Promise.all([get(`/api/keyword-history/${id}?days=${days}`), get(`/api/keyword-history/${id}/url-history`)]);
    const k = hist.keyword;
    const where = [k.location, k.country].filter(Boolean).join(', ');

    root.append(h(`<div><h1>${esc(k.phrase)}</h1>
      <div class="row meta"><span class="tag">${esc(k.domainName)}</span><span class="tag">${esc(k.searchEngine)}</span>
        <span class="tag">${esc(k.device)}</span><span class="tag">${esc(where || 'National')}</span><span class="tag">${esc(k.language)}</span>
        ${k.searchVolume != null ? `<span class="muted">${esc(Number(k.searchVolume).toLocaleString())} searches/mo</span>` : ''}</div></div>`));

    const kpis = h('<div class="grid kpis"></div>');
    kpis.append(
      kpi('Current rank', esc(fmtRank(hist.currentRank)), hist.lastChecked ? `Checked ${esc(fmtDate(hist.lastChecked))}` : 'Not checked yet'),
      kpi('Best rank', esc(fmtRank(hist.bestRank)), `Last ${esc(days)} days`),
      kpi('Worst rank', esc(fmtRank(hist.worstRank)), `Last ${esc(days)} days`),
      kpi('First seen', esc(hist.firstSeen ? fmtDate(hist.firstSeen) : '–'), 'First day in top 100'));
    root.append(kpis);

    // Rank history
    const chartCard = h(`<div class="card"><div class="row"><h2>Rank history</h2><span class="spacer"></span>
      <select aria-label="Period">${RANGES.map(([d, l]) => `<option value="${d}" ${d === days ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div></div>`);
    chartCard.querySelector('select').onchange = e => {
      const q = new URLSearchParams(ctx.query); q.set('days', e.target.value);
      ctx.navigate(`#/keyword/${id}?${q}`);
    };
    chartCard.append(hist.history.some(p => p.rank != null)
      ? lineChart([{ name: k.phrase, points: hist.history.map(p => ({ x: p.checkedAt, y: p.rank })) }], { invert: true, yLabel: 'Rank' })
      : h(`<div class="empty">${hist.history.length ? 'Not ranking in the top 100 during this period.' : 'No rank checks in this period yet.'}</div>`));
    root.append(chartCard);

    // SERP snapshot
    const serpCard = h(`<div class="card"><div class="row"><h2>SERP snapshot</h2><span class="spacer"></span>
      <label>Date<input type="date" name="date"></label></div><div data-body></div></div>`);
    root.append(serpCard);
    const dateInput = serpCard.querySelector('input'), body = serpCard.querySelector('[data-body]');
    const loadSerp = async date => {
      body.innerHTML = '<div class="empty">Loading…</div>';
      let s;
      try { s = await get(`/api/keyword-history/${id}/serp${date ? `?date=${encodeURIComponent(date)}` : ''}`); }
      catch (e) { body.innerHTML = `<div class="empty">${esc(e.status === 404 ? 'No SERP snapshots recorded yet.' : e.message)}</div>`; return; }
      dateInput.value = s.date;
      if (s.availableDates.length) { dateInput.min = s.availableDates[0]; dateInput.max = s.availableDates.at(-1); }
      body.innerHTML = '';
      const note = s.requestedDate && s.requestedDate !== s.date ? ` <span class="muted">(nearest to ${esc(fmtDate(s.requestedDate + 'T12:00:00Z'))})</span>` : '';
      body.append(h(`<div><p>Checked ${esc(new Date(s.checkedAt).toLocaleString())}${note} &middot; your rank <strong>${esc(fmtRank(s.rank))}</strong></p>
        <div>${features(s.serp_features, s.owned_features)}</div></div>`));
      body.append(table([
        { key: 'position', label: '#', num: true },
        { key: 'title', label: 'Result', render: r => `<div class="res"><span>${esc(r.title || r.host)}</span>${link(r.url)}</div>` },
        { key: 'host', label: 'Host' },
        { key: 'flag', label: '', render: r => [
          r.isDomain ? '<span class="flag you">You</span>' : '',
          r.competitor ? `<span class="flag comp">${esc(r.competitor.name)}</span>` : '',
          r.type !== 'organic' ? `<span class="flag type">${esc(FEATURE_NAMES[r.type] || r.type)}</span>` : ''].join(' ') },
      ], s.results.map(r => ({ ...r, flag: r.isDomain ? 0 : r.competitor ? 1 : 2 })), { empty: 'This snapshot has no stored results.' }));
    };
    dateInput.onchange = () => dateInput.value && loadSerp(dateInput.value);
    loadSerp(/^\d{4}-\d{2}-\d{2}$/.test(ctx.query.get('date') || '') ? ctx.query.get('date') : null);

    // URL history
    const urlCard = h(`<div class="card"><div class="row"><h2>Ranking URL history</h2><span class="spacer"></span>
      <span class="muted">${esc(urls.distinctUrls)} distinct URL${urls.distinctUrls === 1 ? '' : 's'} &middot; ${esc(urls.changes.length)} change${urls.changes.length === 1 ? '' : 's'}</span></div></div>`);
    if (k.preferredUrl) urlCard.append(h(`<p class="muted">Preferred URL: ${link(k.preferredUrl)}</p>`));
    urlCard.append(urls.periods.length
      ? h(`<ul class="urls">${[...urls.periods].reverse().map(p => `<li>
          <span class="muted">${esc(fmtDate(p.from + 'T12:00:00Z'))}${p.to !== p.from ? ` – ${esc(fmtDate(p.to + 'T12:00:00Z'))}` : ''}</span>
          <span>${link(p.url)}</span>
          <span class="row">${p.isPreferred === false && p.url ? '<span class="flag comp">Not preferred</span>' : ''}
            <span class="muted">best ${esc(fmtRank(p.bestRank))} &middot; ${esc(p.checks)} check${p.checks === 1 ? '' : 's'}</span></span></li>`).join('')}</ul>`)
      : h('<div class="empty">No rank checks yet.</div>'));
    root.append(urlCard);
  },
};
