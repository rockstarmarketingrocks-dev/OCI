import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

test('team: org lifecycle, invitations, roles and shared domains', async () => {
  const s = await startTestServer({ modules: ['team'] });
  try {
    const owner = await s.signup('owner@team.dev');
    const ownerToken = owner.token;

    let r = await s.api('GET', '/api/team');
    assert.equal(r.status, 200);
    assert.equal(r.data.organization, null);

    assert.equal((await s.api('POST', '/api/team/invite', { email: 'x@team.dev' })).status, 404);
    assert.equal((await s.api('POST', '/api/team/org', { name: '  ' })).status, 400);
    r = await s.api('POST', '/api/team/org', { name: 'Acme SEO' });
    assert.equal(r.status, 201);
    assert.equal(r.data.organization.name, 'Acme SEO');
    assert.equal((await s.api('POST', '/api/team/org', { name: 'Again' })).status, 409);

    // Invite validation
    assert.equal((await s.api('POST', '/api/team/invite', { email: 'bad', role: 'member' })).status, 400);
    assert.equal((await s.api('POST', '/api/team/invite', { email: 'a@team.dev', role: 'owner' })).status, 400);
    assert.equal((await s.api('POST', '/api/team/invite', { email: 'owner@team.dev', role: 'member' })).status, 409);

    r = await s.api('POST', '/api/team/invite', { email: 'Admin@Team.dev', role: 'admin' });
    assert.equal(r.status, 201);
    const adminInvite = r.data.invitation;
    assert.equal(adminInvite.email, 'admin@team.dev');
    // Re-inviting refreshes the token instead of duplicating
    r = await s.api('POST', '/api/team/invite', { email: 'admin@team.dev', role: 'admin' });
    assert.equal(r.status, 200);
    assert.notEqual(r.data.invitation.token, adminInvite.token);
    const adminToken = r.data.invitation.token;
    const memberInv = (await s.api('POST', '/api/team/invite', { email: 'm@team.dev', role: 'member' })).data.invitation;
    const doomed = (await s.api('POST', '/api/team/invite', { email: 'gone@team.dev', role: 'viewer' })).data.invitation;
    assert.equal((await s.api('DELETE', `/api/team/invitations/${doomed.id}`)).status, 200);

    r = await s.api('GET', '/api/team');
    assert.equal(r.data.canManage, true);
    assert.equal(r.data.myRole, 'owner');
    assert.deepEqual(r.data.invitations.map(i => i.email).sort(), ['admin@team.dev', 'm@team.dev']);

    // Accept (unauthenticated)
    s.setToken(null);
    assert.equal((await s.api('POST', '/api/team/accept', { token: adminInvite.token, password: 'password123' })).status, 404, 'old token invalid');
    assert.equal((await s.api('POST', '/api/team/accept', { token: adminToken, password: 'short' })).status, 400);
    r = await s.api('GET', `/api/team/invitation/${adminToken}`);
    assert.equal(r.data.organization, 'Acme SEO');
    r = await s.api('POST', '/api/team/accept', { token: adminToken, password: 'password123', name: 'Ada' });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.role, 'admin');
    const admin = r.data;
    assert.equal((await s.api('POST', '/api/team/accept', { token: adminToken, password: 'password123' })).status, 404, 'single use');
    const member = (await s.api('POST', '/api/team/accept', { token: memberInv.token, password: 'password123', name: 'Mo' })).data;

    // Session token works and login works too
    s.setToken(admin.token);
    r = await s.api('GET', '/api/auth/me');
    assert.equal(r.data.user.email, 'admin@team.dev');
    r = await s.api('GET', '/api/team');
    assert.equal(r.data.members.length, 3);
    assert.equal(r.data.members[0].role, 'owner');
    assert.equal(r.data.canManage, true);

    // Admin limits: cannot touch owner, self, or invite admins
    assert.equal((await s.api('PATCH', `/api/team/members/${owner.user.id}`, { role: 'viewer' })).status, 403);
    assert.equal((await s.api('PATCH', `/api/team/members/${admin.user.id}`, { role: 'viewer' })).status, 400);
    assert.equal((await s.api('POST', '/api/team/invite', { email: 'z@team.dev', role: 'admin' })).status, 403);
    assert.equal((await s.api('PATCH', `/api/team/members/${member.user.id}`, { role: 'superuser' })).status, 400);
    r = await s.api('PATCH', `/api/team/members/${member.user.id}`, { role: 'viewer' });
    assert.equal(r.status, 200);
    assert.equal(r.data.member.role, 'viewer');

    // Member (viewer) cannot manage and sees no invitations
    s.setToken(member.token);
    r = await s.api('GET', '/api/team');
    assert.equal(r.data.canManage, false);
    assert.deepEqual(r.data.invitations, []);
    assert.equal((await s.api('POST', '/api/team/invite', { email: 'q@team.dev' })).status, 403);
    assert.equal((await s.api('DELETE', `/api/team/members/${admin.user.id}`)).status, 403);

    // Shared domains: aggregated across org, excluding outsiders
    s.seedDomain(owner.user.id, 'owner.com', ['a', 'b']);
    s.seedDomain(member.user.id, 'member.com', ['c']);
    const outsider = await s.signup('outsider@else.dev');
    s.seedDomain(outsider.user.id, 'outsider.com');
    r = await s.api('GET', '/api/team/shared-domains');
    assert.deepEqual(r.data.map(d => d.host), ['outsider.com'], 'no org: own domains only');
    s.setToken(member.token);
    r = await s.api('GET', '/api/team/shared-domains');
    assert.deepEqual(r.data.map(d => d.host), ['member.com', 'owner.com']);
    assert.equal(r.data.find(d => d.host === 'owner.com').keyword_count, 2);
    assert.equal(r.data.find(d => d.host === 'member.com').mine, true);

    // Outsider cannot manage another org's members
    s.setToken(outsider.token);
    assert.equal((await s.api('DELETE', `/api/team/members/${member.user.id}`)).status, 404);

    // Owner removes member, who then becomes standalone
    s.setToken(ownerToken);
    assert.equal((await s.api('DELETE', `/api/team/members/${owner.user.id}`)).status, 403);
    assert.equal((await s.api('DELETE', '/api/team/members/99999')).status, 404);
    assert.equal((await s.api('DELETE', `/api/team/members/${member.user.id}`)).status, 200);
    r = await s.api('GET', '/api/team');
    assert.equal(r.data.members.length, 2);
    s.setToken(member.token);
    r = await s.api('GET', '/api/team');
    assert.equal(r.data.organization, null);
    r = await s.api('GET', '/api/team/shared-domains');
    assert.deepEqual(r.data.map(d => d.host), ['member.com']);

    // Unauthenticated access is rejected
    s.setToken(null);
    assert.equal((await s.api('GET', '/api/team')).status, 401);
  } finally { s.close(); }
});
