// Reports: generate a printable/CSV rank report now (opens in a new tab) and manage scheduled email reports.
// Data: /api/reports/generate (GET, standalone document), /api/reports/schedules (CRUD), /api/reports/schedules/:id/send,
// /api/reports/transport ({mode}).
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, modal, table, fmtDate } from '../ui.js';

const STYLE = `
.pg-reports { display: grid; gap: 16px; }
.pg-reports .gen { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); align-items: end; }
.pg-reports .sections, .pg-reports-form .sections { display: flex; gap: 12px; flex-wrap: wrap; }
.pg-reports .sections label, .pg-reports-form .sections label, .pg-reports-form .check { flex-direction: row; align-items: center; gap: 6px; color: var(--text); font-size: 13px; }
.pg-reports .notice { font-size: 13px; padding: 8px 12px; border-radius: 6px; background: var(--surface-2); color: var(--muted); }
.pg-reports .actions { display: flex; gap: 6px; justify-content: flex-end; }
.pg-reports .actions button { padding: 3px 8px; font-size: 12px; }
.pg-reports .err { color: var(--down); font-size: 12px; white-space: normal; }
.pg-reports .rcpt { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.pg-reports-form { display: grid; gap: 12px; }
.pg-reports-form .two { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
.pg-reports-form textarea { min-height: 70px; resize: vertical; }
@media (max-width: 600px) { .pg-reports-form .two { grid-template-columns: 1fr; } }
`;
const SECTIONS = [['kpis', 'KPIs'], ['chart', 'Average rank chart'], ['movers', 'Top movers'], ['keywords', 'Keyword table']];
const FORMATS = [['html', 'HTML'], ['pdf-html', 'Printable (PDF)'], ['csv', 'CSV']];
const FREQS = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
const PERIODS = [7, 30, 90, 180, 365];
const DEFAULT_DAYS = { daily: 7, weekly: 30, monthly: 90 };
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`).join('');
const label = (list, v) => list.find(x => x[0] === v)?.[1] || v;
const domainOpts = (domains, sel) => opts(domains.map(d => [d.id, d.display_name || d.host]), sel);
const checks = (sel, name = 'sections') => SECTIONS.map(([v, l]) => `<label><input type="checkbox" name="${name}" value="${v}" ${sel.includes(v) ? 'checked' : ''}>${esc(l)}</label>`).join('');

export default {
  id: 'reports', title: 'Reports', group: 'Reporting', order: 80, nav: true, needsDomain: true,
  async render(el, ctx) {
    const root = h(`<div class="pg-reports"><style>${STYLE}</style>
      <div class="row"><h1>Reports</h1></div>
      <form class="card" data-gen><h2>Generate now</h2>
        <div class="gen">
          <label>Domain<select name="domainId">${domainOpts(ctx.domains, ctx.domainId)}</select></label>
          <label>Period<select name="days">${opts(PERIODS.map(d => [d, `Last ${d} days`]), 30)}</select></label>
          <label>Format<select name="format">${opts(FORMATS, 'html')}</select></label>
          <button class="primary">Generate report</button>
        </div>
        <div class="sections" style="margin-top:12px">${checks(SECTIONS.map(s => s[0]))}</div>
      </form>
      <div class="card"><div class="row"><h2 style="margin:0">Scheduled reports</h2><span class="spacer"></span><button class="primary" data-new>New schedule</button></div>
        <p class="notice" data-transport hidden></p><div data-list style="margin-top:12px"></div></div></div>`);
    el.append(root);
    const list = root.querySelector('[data-list]');

    root.querySelector('[data-gen]').addEventListener('submit', e => {
      e.preventDefault();
      const f = new FormData(e.target), sections = f.getAll('sections');
      if (!sections.length) return toast('Pick at least one section', 'error');
      const qs = new URLSearchParams({ domainId: f.get('domainId'), days: f.get('days'), format: f.get('format'), sections: sections.join(',') });
      window.open(`/api/reports/generate?${qs}`, '_blank', 'noopener');
    });

    get('/api/reports/transport').then(({ mode }) => {
      if (mode !== 'outbox') return;
      const n = root.querySelector('[data-transport]');
      n.hidden = false;
      n.textContent = 'Email is not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM). Scheduled reports are saved to data/outbox on the server instead.';
    }).catch(() => {});

    function edit(s = null) {
      const v = s || { domainId: ctx.domainId, name: '', frequency: 'weekly', format: 'html', recipients: [], sections: SECTIONS.map(x => x[0]), days: 30, enabled: true };
      const form = h(`<form class="pg-reports-form">
        <label>Name<input name="name" maxlength="120" required value="${esc(v.name)}" placeholder="Weekly client report"></label>
        <div class="two">
          <label>Domain<select name="domainId" ${s ? 'disabled' : ''}>${domainOpts(ctx.domains, v.domainId)}</select></label>
          <label>Frequency<select name="frequency">${opts(FREQS, v.frequency)}</select></label>
          <label>Format<select name="format">${opts(FORMATS, v.format)}</select></label>
          <label>Period (days)<input name="days" type="number" min="1" max="365" required value="${esc(v.days)}"></label>
        </div>
        <label>Recipients (comma or newline separated)<textarea name="recipients" required placeholder="client@example.com">${esc(v.recipients.join('\n'))}</textarea></label>
        <div><div class="muted" style="font-size:12px;margin-bottom:4px">Sections</div><div class="sections">${checks(v.sections)}</div></div>
        <label class="check"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}>Enabled</label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Cancel</button><button class="primary">${s ? 'Save' : 'Create schedule'}</button></div></form>`);
      const days = form.querySelector('[name=days]');
      form.querySelector('[name=frequency]').addEventListener('change', e => { if (!s) days.value = DEFAULT_DAYS[e.target.value]; });
      const m = modal(s ? 'Edit schedule' : 'New report schedule', form);
      form.querySelector('[data-cancel]').onclick = () => m.close();
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(form);
        const body = { name: f.get('name'), frequency: f.get('frequency'), format: f.get('format'), days: Number(f.get('days')),
          recipients: f.get('recipients'), sections: f.getAll('sections'), enabled: f.get('enabled') === 'on' };
        if (!body.sections.length) return toast('Pick at least one section', 'error');
        try {
          if (s) await patch(`/api/reports/schedules/${s.id}`, body);
          else await post('/api/reports/schedules', { ...body, domainId: Number(f.get('domainId')) });
          m.close(); toast(s ? 'Schedule saved' : 'Schedule created'); load();
        } catch (err) { toast(err.message, 'error'); }
      });
    }
    root.querySelector('[data-new]').onclick = () => edit();

    async function load() {
      let rows;
      try { rows = await get('/api/reports/schedules'); } catch (e) { list.replaceChildren(h(`<div class="empty down">${esc(e.message)}</div>`)); return; }
      const byId = new Map(rows.map(r => [r.id, r]));
      list.replaceChildren(table([
        { key: 'name', label: 'Name', render: r => `<strong>${esc(r.name)}</strong>${r.lastError ? `<div class="err">${esc(r.lastError)}</div>` : ''}` },
        { key: 'domainName', label: 'Domain' },
        { key: 'frequency', label: 'Frequency', render: r => `${esc(label(FREQS, r.frequency))} <span class="muted">· ${esc(r.days)}d</span>` },
        { key: 'format', label: 'Format', render: r => esc(label(FORMATS, r.format)) },
        { key: 'recipients', label: 'Recipients', render: r => `<div class="rcpt" title="${esc(r.recipients.join(', '))}">${esc(r.recipients.join(', '))}</div>` },
        { key: 'lastSentAt', label: 'Last sent', render: r => esc(r.lastSentAt ? fmtDate(r.lastSentAt) : 'Never') },
        { key: 'nextDueAt', label: 'Next', render: r => (!r.enabled ? '<span class="tag">Paused</span>' : esc(r.nextDueAt ? fmtDate(r.nextDueAt) : 'Soon')) },
        { key: 'id', label: '', render: r => `<div class="actions"><button data-act="send" data-id="${r.id}">Send now</button><button data-act="toggle" data-id="${r.id}">${r.enabled ? 'Pause' : 'Resume'}</button><button data-act="edit" data-id="${r.id}">Edit</button><button class="danger" data-act="del" data-id="${r.id}">Delete</button></div>` },
      ], rows, { empty: 'No scheduled reports yet. Create one to email reports automatically.' }));
      list.querySelector('.table-wrap').addEventListener('click', async e => {
        const b = e.target.closest('button[data-act]'); if (!b) return;
        const s = byId.get(Number(b.dataset.id));
        try {
          if (b.dataset.act === 'edit') return edit(s);
          if (b.dataset.act === 'del') { if (!confirm(`Delete schedule "${s.name}"?`)) return; await del(`/api/reports/schedules/${s.id}`); toast('Schedule deleted'); }
          if (b.dataset.act === 'toggle') await patch(`/api/reports/schedules/${s.id}`, { enabled: !s.enabled });
          if (b.dataset.act === 'send') {
            b.disabled = true;
            const r = await post(`/api/reports/schedules/${s.id}/send`);
            toast(r.transport === 'outbox' ? `Saved to outbox: ${r.file}` : `Report sent to ${s.recipients.length} recipient(s)`);
          }
          load();
        } catch (err) { toast(err.message, 'error'); load(); }
      });
    }
    load();
  },
};
