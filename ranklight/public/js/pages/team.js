// Team: create an organization, invite teammates, manage roles and view domains shared across the org.
// Data: /api/team, /api/team/org, /api/team/invite, /api/team/invitations/:id, /api/team/members/:id,
//       /api/team/shared-domains, /api/team/invitation/:token, /api/team/accept. Route #/team/accept?token=... accepts an invite.
import { get, post, patch, del } from '../api.js';
import { h, esc, toast, table, fmtDate, fmtNum } from '../ui.js';

const STYLE = `
.pg-team { display: grid; gap: 16px; }
.pg-team .grid-2 { align-items: start; }
.pg-team form.inline { display: flex; gap: 8px; flex-wrap: wrap; }
.pg-team form.inline input { flex: 1 1 200px; min-width: 0; }
.pg-team .role { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: capitalize;
  background: color-mix(in srgb, var(--rc) 15%, transparent); color: var(--rc); border: 1px solid color-mix(in srgb, var(--rc) 40%, transparent); }
.pg-team .link { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; color: var(--muted); }
.pg-team .accept { max-width: 420px; margin: 32px auto; display: grid; gap: 12px; }
.pg-team .accept label { display: grid; gap: 4px; }
@media (max-width: 900px) { .pg-team .grid-2 { grid-template-columns: 1fr; } }
`;
const ROLE_COLORS = { owner: 'var(--c4)', admin: 'var(--c1)', member: 'var(--c2)', viewer: 'var(--muted)' };
const roleBadge = r => `<span class="role" style="--rc:${ROLE_COLORS[r] || 'var(--muted)'}">${esc(r)}</span>`;
const ROLES = ['admin', 'member', 'viewer'];
const inviteUrl = token => `${location.origin}/#/team/accept?token=${encodeURIComponent(token)}`;
const fail = e => toast(e.message, 'error');

async function renderAccept(root, ctx) {
  const token = ctx.query.get('token') || '';
  let inv;
  try { inv = await get(`/api/team/invitation/${encodeURIComponent(token)}`); }
  catch (e) { root.append(h(`<div class="card empty">${esc(e.message)}</div>`)); return; }
  const form = h(`<form class="card accept"><h1>Join ${esc(inv.organization)}</h1>
    <p class="muted">You were invited as ${roleBadge(inv.role)} with <strong>${esc(inv.email)}</strong>.</p>
    <label>Your name<input name="name" maxlength="100" autocomplete="name"></label>
    <label>Choose a password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>
    <button class="primary">Create account and join</button></form>`);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(form);
    try { await post('/api/team/accept', { token, name: f.get('name'), password: f.get('password') }); location.hash = '#/'; location.reload(); }
    catch (err) { fail(err); }
  });
  root.append(form);
}

export default {
  id: 'team', title: 'Team', group: 'Settings', order: 96, nav: true, needsDomain: false,
  async render(el, ctx) {
    const root = h(`<div class="pg-team"><style>${STYLE}</style></div>`);
    el.append(root);
    if (ctx.param === 'accept') return renderAccept(root, ctx);

    const body = h('<div class="pg-team-body" style="display:grid;gap:16px"></div>');
    root.append(body);

    async function load() {
      const [team, shared] = await Promise.all([get('/api/team'), get('/api/team/shared-domains')]);
      body.innerHTML = '';
      if (!team.organization) return renderNoOrg();
      const { organization: org, canManage } = team;
      body.append(h(`<div class="row"><h1>${esc(org.name)}</h1>${roleBadge(team.myRole)}<span class="spacer"></span>
        <span class="muted">${team.members.length} member${team.members.length === 1 ? '' : 's'} · since ${esc(fmtDate(org.created_at))}</span></div>`));

      const memberCols = [
        { key: 'name', label: 'Name', render: m => esc(m.name || '–') + (m.id === ctx.user.id ? ' <span class="muted">(you)</span>' : '') },
        { key: 'email', label: 'Email' },
        { key: 'role', label: 'Role', render: m => {
          const editable = canManage && m.role !== 'owner' && m.id !== ctx.user.id && (team.myRole === 'owner' || m.role !== 'admin');
          if (!editable) return roleBadge(m.role);
          const opts = ROLES.filter(r => r !== 'admin' || team.myRole === 'owner' || m.role === 'admin');
          return `<select data-role="${m.id}" aria-label="Role for ${esc(m.email)}">${opts.map(r => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
        } },
        { key: 'created_at', label: 'Joined', render: m => esc(fmtDate(m.created_at)) },
      ];
      if (canManage) memberCols.push({ key: 'actions', label: '', render: m =>
        m.role === 'owner' || m.id === ctx.user.id || (m.role === 'admin' && team.myRole !== 'owner') ? '' : `<button class="btn-link" data-remove="${m.id}" data-email="${esc(m.email)}">Remove</button>` });
      const membersCard = h('<div class="card"><h2>Members</h2></div>');
      membersCard.append(table(memberCols, team.members));
      membersCard.addEventListener('change', async e => {
        const s = e.target.closest('select[data-role]'); if (!s) return;
        try { await patch(`/api/team/members/${s.dataset.role}`, { role: s.value }); toast('Role updated'); } catch (err) { fail(err); load().catch(fail); }
      });
      membersCard.addEventListener('click', async e => {
        const b = e.target.closest('[data-remove]'); if (!b) return;
        if (!confirm(`Remove ${b.dataset.email} from ${org.name}? Their own account and domains are kept.`)) return;
        try { await del(`/api/team/members/${b.dataset.remove}`); toast('Member removed'); load().catch(fail); } catch (err) { fail(err); }
      });

      const top = h('<div class="grid grid-2"></div>');
      body.append(top);
      top.append(membersCard);
      if (canManage) top.append(inviteCard(team));
      else top.append(h('<div class="card"><h2>Invitations</h2><p class="muted">Only the organization owner or an admin can invite teammates and change roles.</p></div>'));

      const sharedCard = h('<div class="card"><h2>Shared domains</h2><p class="muted">Domains tracked by everyone in the organization (read-only overview).</p></div>');
      sharedCard.append(table([
        { key: 'host', label: 'Domain', render: d => `<strong>${esc(d.display_name || d.host)}</strong>${d.display_name && d.display_name !== d.host ? ` <span class="muted">${esc(d.host)}</span>` : ''}` },
        { key: 'owner_email', label: 'Owner', render: d => d.mine ? '<span class="muted">You</span>' : esc(d.owner_name || d.owner_email) },
        { key: 'group_name', label: 'Group' },
        { key: 'keyword_count', label: 'Keywords', num: true, render: d => fmtNum(d.keyword_count) },
        { key: 'paused', label: 'Status', render: d => d.paused ? '<span class="muted">Paused</span>' : '<span class="up">Active</span>' },
      ], shared, { empty: 'No domains in this organization yet' }));
      body.append(sharedCard);
    }

    function inviteCard(team) {
      const card = h(`<div class="card"><h2>Invite a teammate</h2>
        <form class="inline"><input name="email" type="email" placeholder="name@company.com" aria-label="Email" required maxlength="254">
          <select name="role" aria-label="Role">${ROLES.filter(r => r !== 'admin' || team.myRole === 'owner').map(r => `<option value="${r}" ${r === 'member' ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <button class="primary">Invite</button></form>
        <div data-new></div><h3>Pending invitations</h3><div data-pending></div></div>`);
      const pending = team.invitations;
      card.querySelector('[data-pending]').append(table([
        { key: 'email', label: 'Email', render: i => esc(i.email) + (i.expired ? ' <span class="down">expired</span>' : '') },
        { key: 'role', label: 'Role', render: i => roleBadge(i.role) },
        { key: 'created_at', label: 'Sent', render: i => esc(fmtDate(i.created_at)) },
        { key: 'actions', label: '', render: i => `<button class="btn-link" data-copy="${esc(i.token)}">Copy link</button> · <button class="btn-link" data-revoke="${i.id}">Revoke</button>` },
      ], pending, { empty: 'No pending invitations' }));
      card.querySelector('form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try {
          const { invitation } = await post('/api/team/invite', { email: f.get('email'), role: f.get('role') });
          toast(`Invitation created for ${invitation.email}`);
          await load();
          const box = body.querySelector('[data-new]');
          box?.append(h(`<div class="card" style="margin:12px 0"><div>Share this link with <strong>${esc(invitation.email)}</strong>:</div><div class="link">${esc(inviteUrl(invitation.token))}</div></div>`));
        } catch (err) { fail(err); }
      });
      card.addEventListener('click', async e => {
        const c = e.target.closest('[data-copy]');
        if (c) { try { await navigator.clipboard.writeText(inviteUrl(c.dataset.copy)); toast('Invite link copied'); } catch { toast(inviteUrl(c.dataset.copy)); } return; }
        const r = e.target.closest('[data-revoke]');
        if (r) { try { await del(`/api/team/invitations/${r.dataset.revoke}`); toast('Invitation revoked'); load().catch(fail); } catch (err) { fail(err); } }
      });
      return card;
    }

    function renderNoOrg() {
      const card = h(`<div class="card" style="max-width:560px"><h1>Team</h1>
        <p class="muted">Create an organization to invite teammates, assign roles and see every member's tracked domains in one place.</p>
        <form class="inline"><input name="name" placeholder="Organization name" aria-label="Organization name" maxlength="100" required>
          <button class="primary">Create organization</button></form></div>`);
      card.querySelector('form').addEventListener('submit', async e => {
        e.preventDefault();
        try { await post('/api/team/org', { name: new FormData(e.target).get('name') }); toast('Organization created'); await load(); } catch (err) { fail(err); }
      });
      body.append(card);
    }

    await load();
  },
};
