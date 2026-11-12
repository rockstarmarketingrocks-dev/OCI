// Shared UI helpers for page modules. Keep pages dependency-free (no frameworks).
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
export function toast(msg, type = '') { const el = h(`<div class="toast ${type}">${esc(msg)}</div>`); document.getElementById('toasts').append(el); setTimeout(() => el.remove(), 4000); }
export function fmtNum(n) { return n == null ? '–' : Number(n).toLocaleString(); }
export function fmtRank(r) { return r == null ? '–' : String(r); }
// Rank change: positive = improved (moved up). Returns HTML.
export function fmtChange(c) { if (c == null || c === 0) return '<span class="muted">–</span>'; return c > 0 ? `<span class="up">▲ ${c}</span>` : `<span class="down">▼ ${-c}</span>`; }
export function fmtDate(s) { return s ? new Date(s).toLocaleDateString() : '–'; }

// Sortable table. columns: [{key, label, num?, render?(row)}]. Returns element.
export function table(columns, rows, { onRowClick, empty = 'No data yet' } = {}) {
  const wrap = h('<div class="table-wrap"><table class="data"><thead></thead><tbody></tbody></table></div>');
  let sortKey = null, dir = 1;
  const draw = () => {
    const sorted = sortKey ? [...rows].sort((a, b) => { const x = a[sortKey], y = b[sortKey]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * dir; }) : rows;
    wrap.querySelector('thead').innerHTML = '<tr>' + columns.map(c => `<th data-k="${esc(c.key)}" class="${c.num ? 'num' : ''}">${esc(c.label)}${sortKey === c.key ? (dir > 0 ? ' ↑' : ' ↓') : ''}</th>`).join('') + '</tr>';
    const tb = wrap.querySelector('tbody');
    tb.innerHTML = sorted.length ? sorted.map((r, i) => `<tr data-i="${rows.indexOf(r)}">` + columns.map(c => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key])}</td>`).join('') + '</tr>').join('') : `<tr><td colspan="${columns.length}" class="empty">${esc(empty)}</td></tr>`;
  };
  wrap.addEventListener('click', e => {
    const th = e.target.closest('th'); if (th) { const k = th.dataset.k; dir = sortKey === k ? -dir : 1; sortKey = k; draw(); return; }
    const tr = e.target.closest('tr[data-i]'); if (tr && onRowClick && !e.target.closest('a,button,input')) onRowClick(rows[tr.dataset.i]);
  });
  draw(); return wrap;
}

export function modal(title, bodyEl, { onClose } = {}) {
  const bd = h(`<div class="modal-backdrop"><div class="modal"><div class="row"><h2>${esc(title)}</h2><span class="spacer"></span><button data-x>✕</button></div></div></div>`);
  bd.querySelector('.modal').append(bodyEl);
  const close = () => { bd.remove(); onClose?.(); };
  bd.addEventListener('click', e => { if (e.target === bd || e.target.closest('[data-x]')) close(); });
  document.body.append(bd); return { close, el: bd };
}

// Minimal SVG line chart (no deps). series: [{name, color?, points:[{x: Date|string, y: number|null}]}]
// opts.invert = true for rank charts (1 at top).
export function lineChart(series, { height = 220, invert = false, yLabel = '' } = {}) {
  const W = 800, H = height, P = { l: 40, r: 12, t: 12, b: 24 };
  const all = series.flatMap(s => s.points.filter(p => p.y != null));
  if (!all.length) return h('<div class="empty">No data yet</div>');
  const xs = all.map(p => +new Date(p.x)), ys = all.map(p => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x0 === x1) { x0 -= 864e5; x1 += 864e5; }
  let y0 = Math.min(...ys), y1 = Math.max(...ys); if (y0 === y1) { y0 -= 1; y1 += 1; }
  const sx = x => P.l + (x - x0) / (x1 - x0) * (W - P.l - P.r);
  const sy = y => invert ? P.t + (y - y0) / (y1 - y0) * (H - P.t - P.b) : H - P.b - (y - y0) / (y1 - y0) * (H - P.t - P.b);
  const colors = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];
  const ticks = [0, .25, .5, .75, 1].map(f => y0 + f * (y1 - y0));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(yLabel)}">`;
  svg += ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--border)"/><text x="${P.l - 6}" y="${sy(t) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${Math.round(t * 10) / 10}</text>`).join('');
  series.forEach((s, i) => {
    let d = '', pen = false;
    for (const p of s.points) { if (p.y == null) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${sx(+new Date(p.x)).toFixed(1)},${sy(p.y).toFixed(1)}`; pen = true; }
    svg += `<path d="${d}" fill="none" stroke="${s.color || colors[i % colors.length]}" stroke-width="2"><title>${esc(s.name)}</title></path>`;
  });
  svg += `<text x="${P.l}" y="${H - 6}" font-size="11" fill="var(--muted)">${new Date(x0).toLocaleDateString()}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--muted)">${new Date(x1).toLocaleDateString()}</text></svg>`;
  const el = h(`<div>${svg}</div>`);
  if (series.length > 1) el.append(h(`<div class="row">${series.map((s, i) => `<span class="tag" style="border-left:3px solid ${s.color || colors[i % colors.length]}">${esc(s.name)}</span>`).join('')}</div>`));
  return el;
}

export function kpi(label, value, sub = '') { return h(`<div class="card kpi"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="muted">${sub}</div></div>`); }
