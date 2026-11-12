// Shared ranking math used by several modules. Pure functions + small DB queries.

// Estimated organic CTR by position (1..20). Positions > 20 or null => 0.
export const CTR_CURVE = [0, 0.284, 0.157, 0.110, 0.080, 0.072, 0.051, 0.040, 0.032, 0.028, 0.025,
  0.012, 0.011, 0.010, 0.009, 0.008, 0.007, 0.006, 0.005, 0.005, 0.004];
export function ctrFor(rank) { return rank && rank >= 1 && rank <= 20 ? CTR_CURVE[rank] : 0; }

// Share of voice contribution of one keyword: estimated clicks = volume * CTR.
export function estimatedClicks(rank, volume) { return (volume || 0) * ctrFor(rank); }

// Rank change where positive = improvement. Unranked (null) treated as 101.
export function rankChange(prev, curr) {
  if (prev == null && curr == null) return 0;
  return (prev ?? 101) - (curr ?? 101);
}

// Latest snapshot per keyword for a domain, optionally as of an ISO date (inclusive, end of day).
// Returns rows: keyword columns + rank, url, serp_features, owned_features, checked_at (snapshot fields may be null).
export function latestRanks(db, domainId, asOf = null) {
  const cutoff = asOf ? (asOf.length === 10 ? asOf + 'T23:59:59Z' : asOf) : '9999';
  return db.prepare(`
    SELECT k.*, s.rank, s.url, s.serp_features, s.owned_features, s.checked_at, s.results
    FROM keywords k
    LEFT JOIN rank_snapshots s ON s.id = (
      SELECT id FROM rank_snapshots WHERE keyword_id = k.id AND checked_at <= ? ORDER BY checked_at DESC LIMIT 1)
    WHERE k.domain_id = ?`).all(cutoff, domainId);
}

// Distinct UTC dates (YYYY-MM-DD) that have snapshots for a domain, ascending.
export function snapshotDates(db, domainId, sinceIso = '0000') {
  return db.prepare(`SELECT DISTINCT substr(s.checked_at,1,10) AS d FROM rank_snapshots s JOIN keywords k ON k.id = s.keyword_id
                     WHERE k.domain_id = ? AND s.checked_at >= ? ORDER BY d`).all(domainId, sinceIso).map(r => r.d);
}

// Does a result URL/host belong to `host`? Honors subdomains.
export function hostMatches(resultHost, host, includeSubdomains = true) {
  const a = String(resultHost || '').toLowerCase().replace(/^www\./, ''), b = String(host || '').toLowerCase().replace(/^www\./, '');
  return a === b || (includeSubdomains && a.endsWith('.' + b));
}
export function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
