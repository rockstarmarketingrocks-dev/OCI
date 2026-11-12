// Settings: profile, password, active sessions, demo data and account deletion.
// Data: /api/account, /api/account/profile, /api/account/password, /api/account/sessions, /api/account/demo.
import { get, post, patch, api } from '../api.js';
import { h, esc, toast, table, modal } from '../ui.js';

const STYLE = `
.pg-account { display: grid; gap: 16px; max-width: 880px; }
.pg-account form { display: grid; gap: 12px; }
.pg-account .fields { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.pg-account .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.pg-account .stats { display: flex; gap: 16px; flex-wrap: wrap; }
.pg-account code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.pg-account .danger-zone { border-color: var(--down); }
.pg-account .danger-zone h2 { color: var(--down); }
.pg-account .current { color: var(--up); font-weight: 600; }
.pg-account-del { display: grid; gap: 12px; }
`;
const when = s => (s ? esc(new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString()) : '–');

export default {
  id: 'account', title: 'Settings', group: 'Settings', order: 99, nav: true, needsDomain: false,
  async render(el, ctx) {
    const { user, stats, demoDomainId } = await get('/api/account');
    const root = h(`<div class="pg-account"><style>${STYLE}</style>
      <h1>Settings</h1>
      <section class="card"><h2>Profile</h2>
        <form data-profile><div class="fields">
          <label>Name<input name="name" maxlength="100" value="${esc(user.name)}" autocomplete="name"></label>
          <label>Email<input name="email" type="email" required value="${esc(user.email)}" autocomplete="email"></label></div>
          <div class="row"><span class="muted">Member since ${when(user.createdAt)} · ${esc(stats.domains)} domains · ${esc(stats.keywords)} keywords</span>
          <span class="spacer"></span><button class="primary">Save profile</button></div></form></section>
      <section class="card"><h2>Password</h2>
        <form data-password><div class="fields">
          <label>Current password<input name="current" type="password" required autocomplete="current-password"></label>
          <label>New password<input name="next" type="password" required minlength="8" autocomplete="new-password"></label>
          <label>Confirm new password<input name="confirm" type="password" required minlength="8" autocomplete="new-password"></label></div>
          <div class="row"><span class="muted">Changing your password signs out all other sessions.</span><span class="spacer"></span><button class="primary">Change password</button></div></form></section>
      <section class="card"><div class="row"><h2>Active sessions</h2><span class="spacer"></span><button data-revoke-all>Sign out other sessions</button></div>
        <div data-sessions></div></section>
      <section class="card"><h2>Demo data</h2>
        <p class="muted">Load a sample domain (<code>demo-outdoors.com</code>) with 2 competitors, 40 keywords across desktop and mobile, 4 tags and 90 days of ranking history. No network access is needed.</p>
        <div class="actions" data-demo></div></section>
      <section class="card danger-zone"><h2>Danger zone</h2>
        <div class="row"><span class="muted">Permanently delete your account, domains, keywords and all ranking history. This cannot be undone.</span>
        <span class="spacer"></span><button class="danger" data-delete>Delete account</button></div></section></div>`);
    el.append(root);

    const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; } };

    const profile = root.querySelector('[data-profile]');
    profile.addEventListener('submit', e => {
      e.preventDefault();
      busy(e.submitter || profile.querySelector('button'), async () => {
        const r = await patch('/api/account/profile', { name: profile.elements.name.value, email: profile.elements.email.value });
        document.getElementById('user-email')?.replaceChildren(r.user.email);
        toast('Profile saved');
      });
    });

    const pw = root.querySelector('[data-password]');
    pw.addEventListener('submit', e => {
      e.preventDefault();
      const f = pw.elements;
      if (f.next.value !== f.confirm.value) return toast('New passwords do not match', 'error');
      busy(e.submitter || pw.querySelector('button'), async () => {
        const r = await post('/api/account/password', { current: f.current.value, next: f.next.value });
        pw.reset();
        toast(`Password changed${r.revokedSessions ? `; signed out ${r.revokedSessions} other session(s)` : ''}`);
        await loadSessions();
      });
    });

    const sessEl = root.querySelector('[data-sessions]');
    async function loadSessions() {
      let rows = [];
      try { rows = await get('/api/account/sessions'); } catch (e) { toast(e.message, 'error'); }
      sessEl.replaceChildren(table([
        { key: 'prefix', label: 'Session', render: s => `<code>${esc(s.prefix)}…</code>` },
        { key: 'createdAt', label: 'Signed in', render: s => when(s.createdAt) },
        { key: 'expiresAt', label: 'Expires', render: s => when(s.expiresAt) },
        { key: 'current', label: '', render: s => (s.current ? '<span class="current">This device</span>' : `<button data-revoke="${esc(s.prefix)}">Revoke</button>`) },
      ], rows, { empty: 'No active sessions' }));
    }
    sessEl.addEventListener('click', e => {
      const b = e.target.closest('[data-revoke]'); if (!b) return;
      busy(b, async () => { await api('DELETE', `/api/account/sessions/${encodeURIComponent(b.dataset.revoke)}`); toast('Session revoked'); await loadSessions(); });
    });
    root.querySelector('[data-revoke-all]').addEventListener('click', e => busy(e.currentTarget, async () => {
      const r = await api('DELETE', '/api/account/sessions'); toast(`Signed out ${r.revoked} other session(s)`); await loadSessions();
    }));

    const demoEl = root.querySelector('[data-demo]');
    const openDomain = id => { try { localStorage.setItem('rl_domain', id); } catch {} location.hash = '#/overview'; location.reload(); };
    demoEl.innerHTML = demoDomainId
      ? `<button data-open>Open demo domain</button><button data-load data-replace>Regenerate demo data</button>`
      : `<button class="primary" data-load>Load demo data</button>`;
    demoEl.querySelector('[data-open]')?.addEventListener('click', () => openDomain(demoDomainId));
    demoEl.querySelector('[data-load]').addEventListener('click', e => {
      const replace = e.currentTarget.hasAttribute('data-replace');
      if (replace && !confirm('Regenerate demo data? The current demo domain and any changes to it will be replaced.')) return;
      busy(e.currentTarget, async () => {
        const r = await post('/api/account/demo', { replace });
        toast(`Loaded ${r.keywords} demo keywords`);
        await ctx.refreshDomains();
        openDomain(r.domainId);
      });
    });

    root.querySelector('[data-delete]').addEventListener('click', () => {
      const body = h(`<form class="pg-account-del"><p>This permanently deletes <strong>${esc(user.email)}</strong> and all of its data.</p>
        <label>Confirm with your password<input name="password" type="password" required autocomplete="current-password"></label>
        <div class="row"><span class="spacer"></span><button type="button" data-cancel>Cancel</button><button class="danger">Delete my account</button></div></form>`);
      const m = modal('Delete account', body);
      body.querySelector('[data-cancel]').onclick = () => m.close();
      body.addEventListener('submit', e => {
        e.preventDefault();
        busy(e.submitter, async () => { await api('DELETE', '/api/account', { password: body.elements.password.value }); location.hash = ''; location.reload(); });
      });
    });

    await loadSessions();
  },
};
