// Notes: dated annotations on a domain's timeline, optionally linked to one keyword (table from 120-notes.sql).
//   GET    /api/notes?domainId=&from=&to=&keywordId=   -> [note]   (newest date first; from/to inclusive YYYY-MM-DD)
//   POST   /api/notes?domainId=  {date, text, keywordId?}  -> 201 note   (domainId may also be given in the body)
//   GET    /api/notes/keywords?domainId=               -> [{id, phrase, device, location}]  (for the keyword picker)
//   GET    /api/notes/:id                              -> note
//   PATCH  /api/notes/:id        {date?, text?, keywordId? (null unlinks)} -> note
//   DELETE /api/notes/:id                              -> {ok: true}
// note = {id, domainId, keywordId, keyword (phrase|null), date, text, createdBy, createdByName, createdAt, updatedAt}
// Emits 'notes:changed' {domainId, noteId, action: 'created'|'updated'|'deleted'}.
// Export helper notesFor(db, domainId, {from?, to?, keywordId?}) for reports/charts.
import { httpError, requireAuth, loadOwnedDomain } from '../lib/http.js';

const MAX_TEXT = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SELECT = `SELECT n.id, n.domain_id AS domainId, n.keyword_id AS keywordId, k.phrase AS keyword, n.date, n.text,
  n.created_by AS createdBy, COALESCE(NULLIF(u.name, ''), u.email) AS createdByName, n.created_at AS createdAt, n.updated_at AS updatedAt
  FROM notes n LEFT JOIN keywords k ON k.id = n.keyword_id LEFT JOIN users u ON u.id = n.created_by`;

const toNote = r => (r ? { ...r } : null);

export function parseDate(v, name = 'date', { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw httpError(400, `${name} is required (YYYY-MM-DD)`);
    return null;
  }
  const s = String(v).slice(0, 10);
  const d = new Date(`${s}T00:00:00Z`);
  if (!DATE_RE.test(s) || Number.isNaN(+d) || d.toISOString().slice(0, 10) !== s) throw httpError(400, `${name} must be a valid date (YYYY-MM-DD)`);
  return s;
}
function parseText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw httpError(400, 'text is required');
  if (s.length > MAX_TEXT) throw httpError(400, `text must be at most ${MAX_TEXT} characters`);
  return s;
}
function parseId(v, name) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isSafeInteger(n) || n < 1) throw httpError(400, `${name} must be a positive integer`);
  return n;
}
// Returns null (no link) or a keyword id that belongs to domainId.
function parseKeyword(db, domainId, v) {
  if (v === undefined || v === null || v === '') return null;
  const id = parseId(v, 'keywordId');
  if (!db.prepare('SELECT 1 FROM keywords WHERE id = ? AND domain_id = ?').get(id, domainId)) throw httpError(400, 'keywordId does not belong to this domain');
  return id;
}

// Notes of a domain, newest first. Caller is responsible for ownership checks.
export function notesFor(db, domainId, { from = null, to = null, keywordId = null } = {}) {
  const where = ['n.domain_id = ?'], args = [Number(domainId)];
  if (from) { where.push('n.date >= ?'); args.push(from); }
  if (to) { where.push('n.date <= ?'); args.push(to); }
  if (keywordId) { where.push('n.keyword_id = ?'); args.push(Number(keywordId)); }
  return db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY n.date DESC, n.id DESC`).all(...args).map(toNote);
}

export default {
  name: 'notes',
  router({ db, express, events }) {
    const r = express.Router();
    r.use(requireAuth);

    const ownedDomain = req => {
      const v = req.query.domainId ?? req.body?.domainId;
      return loadOwnedDomain(db, req, parseId(v ?? '', 'domainId'));
    };
    const ownedNote = req => {
      const id = parseId(req.params.id, 'id');
      const n = db.prepare(`${SELECT} JOIN domains d ON d.id = n.domain_id WHERE n.id = ? AND d.user_id = ?`).get(id, req.user.id);
      if (!n) throw httpError(404, 'Note not found');
      return toNote(n);
    };
    const one = id => toNote(db.prepare(`${SELECT} WHERE n.id = ?`).get(id));
    const emit = (domainId, noteId, action) => events.emit('notes:changed', { domainId, noteId, action });

    r.get('/', (req, res) => {
      const d = ownedDomain(req);
      const from = parseDate(req.query.from, 'from', { required: false });
      const to = parseDate(req.query.to, 'to', { required: false });
      if (from && to && from > to) throw httpError(400, 'from must not be after to');
      const keywordId = req.query.keywordId ? parseKeyword(db, d.id, req.query.keywordId) : null;
      res.json(notesFor(db, d.id, { from, to, keywordId }));
    });

    r.get('/keywords', (req, res) => {
      const d = ownedDomain(req);
      res.json(db.prepare('SELECT id, phrase, device, location FROM keywords WHERE domain_id = ? ORDER BY phrase COLLATE NOCASE, id').all(d.id).map(k => ({ ...k })));
    });

    r.post('/', (req, res) => {
      const d = ownedDomain(req);
      const b = req.body || {};
      const date = parseDate(b.date), text = parseText(b.text), keywordId = parseKeyword(db, d.id, b.keywordId);
      const { lastInsertRowid } = db.prepare('INSERT INTO notes(domain_id, keyword_id, date, text, created_by) VALUES (?,?,?,?,?)')
        .run(d.id, keywordId, date, text, req.user.id);
      const id = Number(lastInsertRowid);
      emit(d.id, id, 'created');
      res.status(201).json(one(id));
    });

    r.get('/:id', (req, res) => res.json(ownedNote(req)));

    r.patch('/:id', (req, res) => {
      const n = ownedNote(req);
      const b = req.body || {};
      const next = {
        date: 'date' in b ? parseDate(b.date) : n.date,
        text: 'text' in b ? parseText(b.text) : n.text,
        keywordId: 'keywordId' in b ? parseKeyword(db, n.domainId, b.keywordId) : n.keywordId,
      };
      if (!['date', 'text', 'keywordId'].some(k => k in b)) throw httpError(400, 'Nothing to update (date, text or keywordId)');
      db.prepare("UPDATE notes SET date = ?, text = ?, keyword_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(next.date, next.text, next.keywordId, n.id);
      emit(n.domainId, n.id, 'updated');
      res.json(one(n.id));
    });

    r.delete('/:id', (req, res) => {
      const n = ownedNote(req);
      db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
      emit(n.domainId, n.id, 'deleted');
      res.json({ ok: true });
    });

    return r;
  },
};
