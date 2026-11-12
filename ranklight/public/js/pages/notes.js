// Notes: a timeline of dated annotations (site changes, algorithm updates, campaigns) for the selected domain,
// optionally linked to one keyword. Data: /api/notes (CRUD, ?domainId=&from=&to=&keywordId=), /api/notes/keywords.
// Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD&keywordId=N prefill the filters.
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, modal } from '../ui.js';

const STYLE = `
.pg-notes .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
.pg-notes .filters label { flex: 0 1 160px; min-width: 0; }
.pg-notes .filters label.kw { flex: 1 1 200px; }
.pg-notes .month { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 20px 0 8px; }
.pg-notes .month:first-child { margin-top: 0; }
.pg-notes ol.timeline { list-style: none; margin: 0; padding: 0 0 0 18px; border-left: 2px solid var(--border); }
.pg-notes ol.timeline li { position: relative; margin: 0 0 12px; }
.pg-notes ol.timeline li::before { content: ''; position: absolute; left: -25px; top: 18px; width: 10px; height: 10px; border-radius: 50%;
  background: var(--primary); border: 2px solid var(--surface); }
.pg-notes ol.timeline li.kw-note::before { background: var(--c4); }
.pg-notes .note { display: flex; gap: 12px; align-items: flex-start; }
.pg-notes .note .body { flex: 1; min-width: 0; }
.pg-notes .note .text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; }
.pg-notes .note .meta { font-size: 12px; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pg-notes .note .date { font-weight: 600; color: var(--text); }
.pg-notes .note .actions { display: flex; gap: 6px; flex: none; }
.pg-notes-form { display: grid; gap: 12px; }
.pg-notes-form textarea { min-height: 110px; resize: vertical; }
.pg-notes-form .count { font-size: 12px; text-align: right; }
@media (max-width: 600px) { .pg-notes .note { flex-direction: column; } .pg-notes .filters label { flex: 1 1 100%; } }
`;
const MAX = 2000;
const today = () => new Date().toISOString().slice(0, 10);
const fmtDay = d => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const fmtMonth = d => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'long' });
const kwLabel = k => k.phrase + (k.device === 'mobile' ? ' (mobile)' : '') + (k.location ? ` - ${k.location}` : '');
const kwOptions = (keywords, selected, none) =>
  `<option value="">${esc(none)}</option>` + keywords.map(k => `<option value="${k.id}" ${k.id === selected ? 'selected' : ''}>${esc(kwLabel(k))}</option>`).join('');

export default {
  id: 'notes', title: 'Notes', group: 'Reporting', order: 85, nav: true, needsDomain: true,
  async render(el, ctx) {
    const { domainId } = ctx;
    const f = { from: ctx.query.get('from') || '', to: ctx.query.get('to') || '', keywordId: Number(ctx.query.get('keywordId')) || null };
    const keywords = await get(`/api/notes/keywords?domainId=${domainId}`).catch(() => []);

    const root = h(`<div class="pg-notes"><style>${STYLE}</style>
      <div class="row"><h1>Notes</h1><span class="spacer"></span><button class="primary" data-add>Add note</button></div>
      <p class="muted">Annotate ranking changes with what happened: releases, migrations, content updates, algorithm updates.</p>
      <form class="card filters">
        <label>From<input type="date" name="from" value="${esc(f.from)}"></label>
        <label>To<input type="date" name="to" value="${esc(f.to)}"></label>
        <label class="kw">Keyword<select name="keywordId">${kwOptions(keywords, f.keywordId, 'All notes')}</select></label>
        <button type="button" data-clear>Clear</button>
      </form>
      <div data-list></div></div>`);
    el.append(root);
    const list = root.querySelector('[data-list]');
    const form = root.querySelector('form.filters');
    let notes = [];

    async function load() {
      const qs = new URLSearchParams({ domainId });
      for (const k of ['from', 'to', 'keywordId']) if (f[k]) qs.set(k, f[k]);
      try { notes = await get(`/api/notes?${qs}`); } catch (e) { toast(e.message, 'error'); notes = []; }
      draw();
    }

    function draw() {
      if (!notes.length) {
        const filtered = f.from || f.to || f.keywordId;
        list.replaceChildren(h(`<div class="card empty">${filtered ? 'No notes match these filters.' : 'No notes yet. Add one to mark an event on your timeline.'}</div>`));
        return;
      }
      const months = new Map();
      for (const n of notes) { const m = n.date.slice(0, 7); (months.get(m) || months.set(m, []).get(m)).push(n); }
      list.innerHTML = [...months].map(([m, ns]) => `<div class="month">${esc(fmtMonth(`${m}-01`))}</div><ol class="timeline">` + ns.map(n => `
        <li class="${n.keywordId ? 'kw-note' : ''}"><div class="card note" data-id="${n.id}">
          <div class="body">
            <div class="meta"><span class="date">${esc(fmtDay(n.date))}</span>${n.keyword ? `<span class="tag">${esc(n.keyword)}</span>` : '<span class="tag">Whole domain</span>'}</div>
            <div class="text">${esc(n.text)}</div>
            <div class="meta">${n.createdByName ? `<span>by ${esc(n.createdByName)}</span>` : ''}${n.updatedAt ? '<span>edited</span>' : ''}</div>
          </div>
          <div class="actions"><button data-edit>Edit</button><button class="danger" data-del>Delete</button></div>
        </div></li>`).join('') + '</ol>').join('');
    }

    function openForm(note = null) {
      const body = h(`<form class="pg-notes-form">
        <label>Date<input type="date" name="date" required max="9999-12-31" value="${esc(note?.date || today())}"></label>
        <label>Keyword (optional)<select name="keywordId">${kwOptions(keywords, note?.keywordId ?? f.keywordId, 'Whole domain')}</select></label>
        <label>Note<textarea name="text" required maxlength="${MAX}" placeholder="e.g. Launched new category pages">${esc(note?.text || '')}</textarea></label>
        <div class="count muted"></div>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Cancel</button><button class="primary">${note ? 'Save' : 'Add note'}</button></div>
      </form>`);
      const m = modal(note ? 'Edit note' : 'Add note', body);
      const ta = body.querySelector('textarea'), count = body.querySelector('.count');
      const upd = () => { count.textContent = `${ta.value.length} / ${MAX}`; };
      ta.addEventListener('input', upd); upd(); ta.focus();
      body.querySelector('[data-cancel]').onclick = () => m.close();
      body.addEventListener('submit', async e => {
        e.preventDefault();
        const fd = new FormData(body);
        const payload = { date: fd.get('date'), text: String(fd.get('text')).trim(), keywordId: fd.get('keywordId') ? Number(fd.get('keywordId')) : null };
        const btn = body.querySelector('button.primary'); btn.disabled = true;
        try {
          if (note) await patch(`/api/notes/${note.id}`, payload);
          else await post(`/api/notes?domainId=${domainId}`, payload);
          m.close(); toast(note ? 'Note updated' : 'Note added'); await load();
        } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
      });
    }

    root.querySelector('[data-add]').onclick = () => openForm();
    form.addEventListener('change', () => {
      const fd = new FormData(form);
      f.from = fd.get('from') || ''; f.to = fd.get('to') || ''; f.keywordId = Number(fd.get('keywordId')) || null;
      if (f.from && f.to && f.from > f.to) { toast('"From" must be before "To"', 'error'); return; }
      load();
    });
    form.addEventListener('submit', e => e.preventDefault());
    root.querySelector('[data-clear]').onclick = () => { form.reset(); for (const i of form.elements) if (i.name) i.value = ''; Object.assign(f, { from: '', to: '', keywordId: null }); load(); };
    list.addEventListener('click', async e => {
      const card = e.target.closest('[data-id]'); if (!card) return;
      const note = notes.find(n => n.id === Number(card.dataset.id)); if (!note) return;
      if (e.target.closest('[data-edit]')) openForm(note);
      else if (e.target.closest('[data-del]') && confirm(`Delete the note from ${fmtDay(note.date)}?`)) {
        try { await del(`/api/notes/${note.id}`); toast('Note deleted'); await load(); } catch (err) { toast(err.message, 'error'); }
      }
    });
    await load();
  },
};
