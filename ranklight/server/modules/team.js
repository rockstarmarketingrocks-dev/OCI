// Organizations and team: create an organization, invite members by email, accept invitations,
// manage member roles, and list the domains of all organization members (read-only aggregation).
// Roles (users.role): owner | admin | member | viewer. Only the owner and admins may manage the team.
import crypto from 'node:crypto';
import { httpError, requireAuth } from '../lib/http.js';
import { hashPassword, createSession } from '../lib/auth.js';

const INVITE_ROLES = ['admin', 'member', 'viewer'];
const INVITE_TTL_DAYS = 14;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default {
  name: 'team',
  router({ db, express }) {
    const r = express.Router();

    const orgOf = user => user.organization_id ? db.prepare('SELECT * FROM organizations WHERE id = ?').get(user.organization_id) : null;
    const isManager = (user, org) => !!org && (org.owner_id === user.id || user.role === 'admin');
    const requireOrg = req => { const org = orgOf(req.user); if (!org) throw httpError(404, 'You are not part of an organization'); return org; };
    const requireManager = req => {
      const org = requireOrg(req);
      if (!isManager(req.user, org)) throw httpError(403, 'Only the organization owner or an admin can manage the team');
      return org;
    };
    // Loads a member of the caller's org that the caller may modify.
    function loadManagedMember(req, org) {
      const id = Number(req.params.id);
      const m = Number.isInteger(id) && db.prepare('SELECT id, email, name, role FROM users WHERE id = ? AND organization_id = ?').get(id, org.id);
      if (!m) throw httpError(404, 'Member not found');
      if (m.id === org.owner_id) throw httpError(403, 'The organization owner cannot be changed');
      if (m.id === req.user.id) throw httpError(400, 'You cannot change your own membership');
      if (m.role === 'admin' && org.owner_id !== req.user.id) throw httpError(403, 'Only the owner can manage admins');
      return m;
    }
    const members = org => db.prepare(`SELECT id, email, name, CASE WHEN id = ? THEN 'owner' ELSE role END AS role, created_at
      FROM users WHERE organization_id = ? ORDER BY (id = ?) DESC, email`).all(org.owner_id, org.id, org.owner_id);
    const pendingInvites = org => db.prepare(`SELECT id, email, role, token, created_at FROM invitations
      WHERE organization_id = ? AND accepted_at IS NULL ORDER BY created_at DESC, id DESC`).all(org.id);
    const expired = inv => Date.parse(inv.created_at.replace(' ', 'T') + (inv.created_at.endsWith('Z') ? '' : 'Z')) < Date.now() - INVITE_TTL_DAYS * 864e5;

    r.get('/', requireAuth, (req, res) => {
      const org = orgOf(req.user);
      if (!org) return res.json({ organization: null, members: [], invitations: [], canManage: false, myRole: req.user.role });
      const canManage = isManager(req.user, org);
      res.json({
        organization: { id: org.id, name: org.name, owner_id: org.owner_id, created_at: org.created_at },
        members: members(org),
        invitations: canManage ? pendingInvites(org).map(i => ({ ...i, expired: expired(i) })) : [],
        canManage,
        myRole: org.owner_id === req.user.id ? 'owner' : req.user.role,
      });
    });

    r.post('/org', requireAuth, (req, res) => {
      const name = String(req.body?.name ?? '').trim();
      if (!name || name.length > 100) throw httpError(400, 'Organization name is required (max 100 characters)');
      if (orgOf(req.user)) throw httpError(409, 'You already belong to an organization');
      const id = Number(db.prepare('INSERT INTO organizations(name, owner_id) VALUES (?,?)').run(name, req.user.id).lastInsertRowid);
      db.prepare("UPDATE users SET organization_id = ?, role = 'owner' WHERE id = ?").run(id, req.user.id);
      res.status(201).json({ organization: db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) });
    });

    r.patch('/org', requireAuth, (req, res) => {
      const org = requireManager(req);
      const name = String(req.body?.name ?? '').trim();
      if (!name || name.length > 100) throw httpError(400, 'Organization name is required (max 100 characters)');
      db.prepare('UPDATE organizations SET name = ? WHERE id = ?').run(name, org.id);
      res.json({ organization: { ...org, name } });
    });

    r.post('/invite', requireAuth, (req, res) => {
      const org = requireManager(req);
      const email = String(req.body?.email ?? '').trim().toLowerCase();
      const role = String(req.body?.role ?? 'member');
      if (!EMAIL_RE.test(email) || email.length > 254) throw httpError(400, 'A valid email address is required');
      if (!INVITE_ROLES.includes(role)) throw httpError(400, `Role must be one of: ${INVITE_ROLES.join(', ')}`);
      if (role === 'admin' && org.owner_id !== req.user.id) throw httpError(403, 'Only the owner can invite admins');
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, 'A user with this email already has an account');
      const token = crypto.randomBytes(24).toString('hex');
      const existing = db.prepare('SELECT id FROM invitations WHERE organization_id = ? AND email = ? AND accepted_at IS NULL').get(org.id, email);
      let id;
      if (existing) {
        id = existing.id;
        db.prepare("UPDATE invitations SET role = ?, token = ?, created_at = datetime('now') WHERE id = ?").run(role, token, id);
      } else {
        id = Number(db.prepare('INSERT INTO invitations(organization_id, email, role, token) VALUES (?,?,?,?)').run(org.id, email, role, token).lastInsertRowid);
      }
      const inv = db.prepare('SELECT id, email, role, token, created_at FROM invitations WHERE id = ?').get(id);
      res.status(existing ? 200 : 201).json({ invitation: { ...inv, accept_path: `/#/team/accept?token=${token}` } });
    });

    r.delete('/invitations/:id', requireAuth, (req, res) => {
      const org = requireManager(req);
      const { changes } = db.prepare('DELETE FROM invitations WHERE id = ? AND organization_id = ? AND accepted_at IS NULL').run(Number(req.params.id), org.id);
      if (!changes) throw httpError(404, 'Invitation not found');
      res.json({ ok: true });
    });

    // Public: look up an invitation by token so the accept form can show the org and email.
    r.get('/invitation/:token', (req, res) => {
      const inv = db.prepare(`SELECT i.email, i.role, i.created_at, i.accepted_at, o.name AS organization FROM invitations i
        JOIN organizations o ON o.id = i.organization_id WHERE i.token = ?`).get(String(req.params.token));
      if (!inv || inv.accepted_at || expired(inv)) throw httpError(404, 'Invitation not found or no longer valid');
      res.json({ email: inv.email, role: inv.role, organization: inv.organization });
    });

    // Public: accept an invitation, creating the account inside the organization.
    r.post('/accept', (req, res) => {
      const { token, password, name = '' } = req.body || {};
      if (!token || typeof token !== 'string') throw httpError(400, 'Invitation token is required');
      if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'A password of 8+ characters is required');
      const displayName = String(name).trim().slice(0, 100);
      const inv = db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);
      if (!inv || inv.accepted_at || expired(inv)) throw httpError(404, 'Invitation not found or no longer valid');
      if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(inv.organization_id)) throw httpError(404, 'Organization no longer exists');
      if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(inv.email)) throw httpError(409, 'An account with this email already exists');
      db.exec('BEGIN');
      let userId;
      try {
        userId = Number(db.prepare('INSERT INTO users(email, name, password_hash, role, organization_id) VALUES (?,?,?,?,?)')
          .run(inv.email, displayName, hashPassword(password), inv.role, inv.organization_id).lastInsertRowid);
        db.prepare("UPDATE invitations SET accepted_at = datetime('now') WHERE id = ?").run(inv.id);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      const sessionToken = createSession(db, userId);
      res.setHeader('Set-Cookie', `rl_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax`);
      res.status(201).json({ token: sessionToken, user: { id: userId, email: inv.email, name: displayName, role: inv.role, organization_id: inv.organization_id } });
    });

    r.patch('/members/:id', requireAuth, (req, res) => {
      const org = requireManager(req);
      const m = loadManagedMember(req, org);
      const role = String(req.body?.role ?? '');
      if (!INVITE_ROLES.includes(role)) throw httpError(400, `Role must be one of: ${INVITE_ROLES.join(', ')}`);
      if (role === 'admin' && org.owner_id !== req.user.id) throw httpError(403, 'Only the owner can grant the admin role');
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, m.id);
      res.json({ member: { ...m, role } });
    });

    // Removes a member from the organization. Their account and own domains remain; they become a standalone owner.
    r.delete('/members/:id', requireAuth, (req, res) => {
      const org = requireManager(req);
      const m = loadManagedMember(req, org);
      db.prepare("UPDATE users SET organization_id = NULL, role = 'owner' WHERE id = ?").run(m.id);
      res.json({ ok: true });
    });

    // Read-only list of every domain owned by any member of the caller's organization (own domains if no org).
    r.get('/shared-domains', requireAuth, (req, res) => {
      const org = orgOf(req.user);
      const where = org ? 'u.organization_id = ?' : 'u.id = ?';
      const rows = db.prepare(`SELECT d.id, d.host, d.display_name, d.group_name, d.paused, d.created_at,
          u.id AS owner_id, u.email AS owner_email, u.name AS owner_name,
          (SELECT COUNT(*) FROM keywords k WHERE k.domain_id = d.id) AS keyword_count
        FROM domains d JOIN users u ON u.id = d.user_id WHERE ${where} ORDER BY d.host, d.id`).all(org ? org.id : req.user.id);
      res.json(rows.map(d => ({ ...d, mine: d.owner_id === req.user.id })));
    });

    return r;
  },
};
