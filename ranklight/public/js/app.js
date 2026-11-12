// SPA shell. Hash routes: #/<pageId>[/<param>][?query]
// Pages are auto-discovered from /api/_meta/pages (files in public/js/pages/).
// Each page module default-exports:
//   { id: 'keywords', title: 'Keywords', group: 'Tracking', order: 10, nav: true,
//     needsDomain?: true, render(el, ctx) -> void|Promise }
// ctx = { domainId, domain, domains, param, query: URLSearchParams, user, navigate(hash), refreshDomains() }
import { get, post } from './api.js';
import { h, esc, toast } from './ui.js';

const state = { user: null, domains: [], domainId: Number(localStorage.getItem('rl_domain')) || null, pages: [] };

async function loadPages() {
  const files = await get('/api/_meta/pages');
  const mods = await Promise.all(files.map(f => import(`./pages/${f}`).then(m => m.default).catch(e => { console.error(f, e); return null; })));
  state.pages = mods.filter(Boolean).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}
async function refreshDomains() {
  try { state.domains = await get('/api/domains'); } catch { state.domains = []; }
  if (!state.domains.find(d => d.id === state.domainId)) state.domainId = state.domains[0]?.id ?? null;
  const sw = document.getElementById('domain-switcher');
  sw.innerHTML = state.domains.length ? state.domains.map(d => `<option value="${d.id}" ${d.id === state.domainId ? 'selected' : ''}>${esc(d.display_name || d.host)}</option>`).join('') : '<option>No domains</option>';
}
function renderNav(active) {
  const groups = {};
  for (const p of state.pages.filter(p => p.nav !== false)) (groups[p.group || 'General'] ||= []).push(p);
  document.getElementById('nav').innerHTML = Object.entries(groups).map(([g, ps]) => `<div class="group">${esc(g)}</div>` + ps.map(p => `<a href="#/${p.id}" class="${p.id === active ? 'active' : ''}">${esc(p.title)}</a>`).join('')).join('');
}
async function route() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const [id, ...rest] = path.split('/');
  const page = state.pages.find(p => p.id === (id || 'overview')) || state.pages.find(p => p.id === 'overview') || state.pages[0];
  renderNav(page?.id);
  const view = document.getElementById('view');
  view.innerHTML = '';
  if (!page) { view.textContent = 'No pages installed.'; return; }
  if (page.needsDomain !== false && !state.domainId && page.id !== 'domains') { view.append(h('<div class="empty">Add a domain to get started. <a href="#/domains">Add domain</a></div>')); return; }
  const ctx = { domainId: state.domainId, domain: state.domains.find(d => d.id === state.domainId), domains: state.domains, param: rest.join('/') || null,
    query: new URLSearchParams(qs || ''), user: state.user, navigate: hsh => { location.hash = hsh; }, refreshDomains: async () => { await refreshDomains(); } };
  try { await page.render(view, ctx); } catch (e) { console.error(e); view.append(h(`<div class="card down">Error: ${esc(e.message)}</div>`)); }
}
function authScreen() {
  document.getElementById('app').replaceWith(h(`<div class="auth-screen" id="app"><form class="card" style="width:340px;display:grid;gap:12px">
    <h1>Ranklight</h1><label>Email<input name="email" type="email" required></label><label>Password<input name="password" type="password" minlength="8" required></label>
    <div class="row"><button class="primary" name="mode" value="login">Log in</button><button name="mode" value="signup">Create account</button></div></form></div>`));
  document.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await post(`/api/auth/${e.submitter.value}`, { email: f.get('email'), password: f.get('password') }); location.reload(); } catch (err) { toast(err.message, 'error'); }
  });
}
async function boot() {
  try { state.user = (await get('/api/auth/me')).user; } catch {
    // Logged-out invitees must reach the team invite form (#/team/accept?token=...).
    if (/^#\/team\/accept\b/.test(location.hash)) {
      try {
        const team = (await import('./pages/team.js')).default;
        const qs = location.hash.split('?')[1] || '';
        const el = h('<div class="auth-screen" id="app"></div>');
        document.getElementById('app').replaceWith(el);
        return await team.render(el, { param: 'accept', query: new URLSearchParams(qs), user: null, domains: [], domainId: null, domain: null,
          navigate: hsh => { location.hash = hsh; }, refreshDomains: async () => {} });
      } catch (e) { console.error(e); }
    }
    return authScreen();
  }
  document.getElementById('user-email').textContent = state.user.email;
  const sidebar = document.getElementById('sidebar'), navToggle = document.getElementById('nav-toggle');
  const setNav = open => { sidebar.classList.toggle('open', open); navToggle.setAttribute('aria-expanded', String(open)); };
  navToggle.onclick = () => setNav(!sidebar.classList.contains('open'));
  window.addEventListener('hashchange', () => setNav(false));
  document.getElementById('logout').onclick = async () => { await post('/api/auth/logout'); location.reload(); };
  document.getElementById('domain-switcher').onchange = e => { state.domainId = Number(e.target.value); localStorage.setItem('rl_domain', state.domainId); route(); };
  await Promise.all([loadPages(), refreshDomains()]);
  window.addEventListener('hashchange', route);
  route();
}
boot();
