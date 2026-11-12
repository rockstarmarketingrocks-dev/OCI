// Local rank tracking: location catalog, map-pack ownership, rank by location and a simulated geo-grid.
// GET  /api/local-rank/locations?q=&country=&limit=   -> { results: [{ type:'country'|'city', code, name, country, language, lat, lng, location }] }
// GET  /api/local-rank/keywords?domainId=              -> { keywords: [{ id, phrase, country, location, device, rank }] } (grid keyword picker)
// GET  /api/local-rank/map-pack?domainId=              -> { total, owned, keywords: [{ id, phrase, country, location, rank, owned, packPosition, checkedAt }] }
// GET  /api/local-rank/by-location?domainId=           -> { locations: [{ country, countryName, location, keywords, ranked, avgRank, top10, top3 }] }
// POST /api/local-rank/grid { keywordId, center:{lat,lng}, size:3|5|7, spacingKm }
//   -> { keywordId, phrase, host, center, size, spacingKm, source:'provider'|'simulated', cells:[{row,col,lat,lng,rank}], stats }
// Uses only core tables. ctx.provider is optional: without it the grid uses a deterministic simulation.
import { httpError, requireAuth, loadOwnedDomain, loadOwnedKeyword, parseJson } from '../lib/http.js';
import { latestRanks, hostMatches } from '../lib/metrics.js';
import { unit } from '../lib/providers/simulator.js';

// [code, name, language, capital lat, capital lng]
const COUNTRY_ROWS = [
  ['US', 'United States', 'en', 38.9072, -77.0369], ['GB', 'United Kingdom', 'en', 51.5074, -0.1278], ['CA', 'Canada', 'en', 45.4215, -75.6972],
  ['AU', 'Australia', 'en', -35.2809, 149.13], ['NZ', 'New Zealand', 'en', -41.2866, 174.7756], ['IE', 'Ireland', 'en', 53.3498, -6.2603],
  ['DE', 'Germany', 'de', 52.52, 13.405], ['AT', 'Austria', 'de', 48.2082, 16.3738], ['CH', 'Switzerland', 'de', 46.948, 7.4474],
  ['FR', 'France', 'fr', 48.8566, 2.3522], ['BE', 'Belgium', 'nl', 50.8503, 4.3517], ['NL', 'Netherlands', 'nl', 52.3676, 4.9041],
  ['ES', 'Spain', 'es', 40.4168, -3.7038], ['PT', 'Portugal', 'pt', 38.7223, -9.1393], ['IT', 'Italy', 'it', 41.9028, 12.4964],
  ['SE', 'Sweden', 'sv', 59.3293, 18.0686], ['NO', 'Norway', 'no', 59.9139, 10.7522], ['DK', 'Denmark', 'da', 55.6761, 12.5683],
  ['FI', 'Finland', 'fi', 60.1699, 24.9384], ['PL', 'Poland', 'pl', 52.2297, 21.0122], ['CZ', 'Czechia', 'cs', 50.0755, 14.4378],
  ['GR', 'Greece', 'el', 37.9838, 23.7275], ['TR', 'Turkey', 'tr', 39.9334, 32.8597], ['RO', 'Romania', 'ro', 44.4268, 26.1025],
  ['HU', 'Hungary', 'hu', 47.4979, 19.0402], ['MX', 'Mexico', 'es', 19.4326, -99.1332], ['BR', 'Brazil', 'pt', -15.7939, -47.8828],
  ['AR', 'Argentina', 'es', -34.6037, -58.3816], ['CL', 'Chile', 'es', -33.4489, -70.6693], ['CO', 'Colombia', 'es', 4.711, -74.0721],
  ['JP', 'Japan', 'ja', 35.6762, 139.6503], ['KR', 'South Korea', 'ko', 37.5665, 126.978], ['IN', 'India', 'en', 28.6139, 77.209],
  ['SG', 'Singapore', 'en', 1.3521, 103.8198], ['ZA', 'South Africa', 'en', -25.7479, 28.2293], ['AE', 'United Arab Emirates', 'ar', 24.4539, 54.3773],
  ['IL', 'Israel', 'he', 31.7683, 35.2137], ['PH', 'Philippines', 'en', 14.5995, 120.9842], ['ID', 'Indonesia', 'id', -6.2088, 106.8456],
  ['MY', 'Malaysia', 'en', 3.139, 101.6869],
];
// [name, country, lat, lng]
const CITY_ROWS = [
  ['New York', 'US', 40.7128, -74.006], ['Los Angeles', 'US', 34.0522, -118.2437], ['Chicago', 'US', 41.8781, -87.6298], ['Houston', 'US', 29.7604, -95.3698],
  ['Phoenix', 'US', 33.4484, -112.074], ['Philadelphia', 'US', 39.9526, -75.1652], ['San Antonio', 'US', 29.4241, -98.4936], ['San Diego', 'US', 32.7157, -117.1611],
  ['Dallas', 'US', 32.7767, -96.797], ['Austin', 'US', 30.2672, -97.7431], ['San Jose', 'US', 37.3382, -121.8863], ['San Francisco', 'US', 37.7749, -122.4194],
  ['Seattle', 'US', 47.6062, -122.3321], ['Denver', 'US', 39.7392, -104.9903], ['Washington', 'US', 38.9072, -77.0369], ['Boston', 'US', 42.3601, -71.0589],
  ['Nashville', 'US', 36.1627, -86.7816], ['Atlanta', 'US', 33.749, -84.388], ['Miami', 'US', 25.7617, -80.1918], ['Las Vegas', 'US', 36.1699, -115.1398],
  ['Portland', 'US', 45.5152, -122.6784], ['Minneapolis', 'US', 44.9778, -93.265], ['Detroit', 'US', 42.3314, -83.0458], ['Charlotte', 'US', 35.2271, -80.8431],
  ['Orlando', 'US', 28.5383, -81.3792], ['Tampa', 'US', 27.9506, -82.4572], ['New Orleans', 'US', 29.9511, -90.0715], ['Salt Lake City', 'US', 40.7608, -111.891],
  ['Kansas City', 'US', 39.0997, -94.5786], ['St. Louis', 'US', 38.627, -90.1994],
  ['London', 'GB', 51.5074, -0.1278], ['Manchester', 'GB', 53.4808, -2.2426], ['Birmingham', 'GB', 52.4862, -1.8904], ['Leeds', 'GB', 53.8008, -1.5491],
  ['Glasgow', 'GB', 55.8642, -4.2518], ['Edinburgh', 'GB', 55.9533, -3.1883], ['Liverpool', 'GB', 53.4084, -2.9916], ['Bristol', 'GB', 51.4545, -2.5879],
  ['Toronto', 'CA', 43.6532, -79.3832], ['Montreal', 'CA', 45.5017, -73.5673], ['Vancouver', 'CA', 49.2827, -123.1207], ['Calgary', 'CA', 51.0447, -114.0719],
  ['Ottawa', 'CA', 45.4215, -75.6972], ['Edmonton', 'CA', 53.5461, -113.4938],
  ['Sydney', 'AU', -33.8688, 151.2093], ['Melbourne', 'AU', -37.8136, 144.9631], ['Brisbane', 'AU', -27.4698, 153.0251], ['Perth', 'AU', -31.9505, 115.8605],
  ['Adelaide', 'AU', -34.9285, 138.6007], ['Auckland', 'NZ', -36.8485, 174.7633], ['Wellington', 'NZ', -41.2866, 174.7756], ['Christchurch', 'NZ', -43.532, 172.6306],
  ['Dublin', 'IE', 53.3498, -6.2603], ['Cork', 'IE', 51.8985, -8.4756],
  ['Berlin', 'DE', 52.52, 13.405], ['Hamburg', 'DE', 53.5511, 9.9937], ['Munich', 'DE', 48.1351, 11.582], ['Cologne', 'DE', 50.9375, 6.9603],
  ['Frankfurt', 'DE', 50.1109, 8.6821], ['Stuttgart', 'DE', 48.7758, 9.1829], ['Düsseldorf', 'DE', 51.2277, 6.7735],
  ['Vienna', 'AT', 48.2082, 16.3738], ['Graz', 'AT', 47.0707, 15.4395], ['Zurich', 'CH', 47.3769, 8.5417], ['Geneva', 'CH', 46.2044, 6.1432], ['Basel', 'CH', 47.5596, 7.5886],
  ['Paris', 'FR', 48.8566, 2.3522], ['Marseille', 'FR', 43.2965, 5.3698], ['Lyon', 'FR', 45.764, 4.8357], ['Toulouse', 'FR', 43.6047, 1.4442],
  ['Nice', 'FR', 43.7102, 7.262], ['Bordeaux', 'FR', 44.8378, -0.5792], ['Lille', 'FR', 50.6292, 3.0573],
  ['Brussels', 'BE', 50.8503, 4.3517], ['Antwerp', 'BE', 51.2194, 4.4025], ['Amsterdam', 'NL', 52.3676, 4.9041], ['Rotterdam', 'NL', 51.9244, 4.4777],
  ['The Hague', 'NL', 52.0705, 4.3007], ['Utrecht', 'NL', 52.0907, 5.1214],
  ['Madrid', 'ES', 40.4168, -3.7038], ['Barcelona', 'ES', 41.3874, 2.1686], ['Valencia', 'ES', 39.4699, -0.3763], ['Seville', 'ES', 37.3891, -5.9845],
  ['Malaga', 'ES', 36.7213, -4.4214], ['Lisbon', 'PT', 38.7223, -9.1393], ['Porto', 'PT', 41.1579, -8.6291],
  ['Rome', 'IT', 41.9028, 12.4964], ['Milan', 'IT', 45.4642, 9.19], ['Naples', 'IT', 40.8518, 14.2681], ['Turin', 'IT', 45.0703, 7.6869], ['Florence', 'IT', 43.7696, 11.2558],
  ['Stockholm', 'SE', 59.3293, 18.0686], ['Gothenburg', 'SE', 57.7089, 11.9746], ['Oslo', 'NO', 59.9139, 10.7522], ['Bergen', 'NO', 60.3913, 5.3221],
  ['Copenhagen', 'DK', 55.6761, 12.5683], ['Aarhus', 'DK', 56.1629, 10.2039], ['Helsinki', 'FI', 60.1699, 24.9384],
  ['Warsaw', 'PL', 52.2297, 21.0122], ['Krakow', 'PL', 50.0647, 19.945], ['Wroclaw', 'PL', 51.1079, 17.0385], ['Prague', 'CZ', 50.0755, 14.4378], ['Brno', 'CZ', 49.1951, 16.6068],
  ['Athens', 'GR', 37.9838, 23.7275], ['Thessaloniki', 'GR', 40.6401, 22.9444], ['Istanbul', 'TR', 41.0082, 28.9784], ['Ankara', 'TR', 39.9334, 32.8597],
  ['Bucharest', 'RO', 44.4268, 26.1025], ['Budapest', 'HU', 47.4979, 19.0402],
  ['Mexico City', 'MX', 19.4326, -99.1332], ['Guadalajara', 'MX', 20.6597, -103.3496], ['Monterrey', 'MX', 25.6866, -100.3161],
  ['São Paulo', 'BR', -23.5505, -46.6333], ['Rio de Janeiro', 'BR', -22.9068, -43.1729], ['Brasília', 'BR', -15.7939, -47.8828], ['Belo Horizonte', 'BR', -19.9167, -43.9345],
  ['Buenos Aires', 'AR', -34.6037, -58.3816], ['Córdoba', 'AR', -31.4201, -64.1888], ['Santiago', 'CL', -33.4489, -70.6693],
  ['Bogotá', 'CO', 4.711, -74.0721], ['Medellín', 'CO', 6.2442, -75.5812],
  ['Tokyo', 'JP', 35.6762, 139.6503], ['Osaka', 'JP', 34.6937, 135.5023], ['Yokohama', 'JP', 35.4437, 139.638], ['Nagoya', 'JP', 35.1815, 136.9066],
  ['Sapporo', 'JP', 43.0618, 141.3545], ['Fukuoka', 'JP', 33.5904, 130.4017], ['Seoul', 'KR', 37.5665, 126.978], ['Busan', 'KR', 35.1796, 129.0756],
  ['Mumbai', 'IN', 19.076, 72.8777], ['Delhi', 'IN', 28.7041, 77.1025], ['Bangalore', 'IN', 12.9716, 77.5946], ['Hyderabad', 'IN', 17.385, 78.4867],
  ['Chennai', 'IN', 13.0827, 80.2707], ['Kolkata', 'IN', 22.5726, 88.3639], ['Pune', 'IN', 18.5204, 73.8567],
  ['Singapore', 'SG', 1.3521, 103.8198], ['Johannesburg', 'ZA', -26.2041, 28.0473], ['Cape Town', 'ZA', -33.9249, 18.4241], ['Durban', 'ZA', -29.8587, 31.0218],
  ['Dubai', 'AE', 25.2048, 55.2708], ['Abu Dhabi', 'AE', 24.4539, 54.3773], ['Tel Aviv', 'IL', 32.0853, 34.7818], ['Jerusalem', 'IL', 31.7683, 35.2137],
  ['Manila', 'PH', 14.5995, 120.9842], ['Cebu City', 'PH', 10.3157, 123.8854], ['Jakarta', 'ID', -6.2088, 106.8456], ['Surabaya', 'ID', -7.2575, 112.7521],
  ['Kuala Lumpur', 'MY', 3.139, 101.6869], ['Penang', 'MY', 5.4141, 100.3288],
];

export const LOCATIONS = Object.freeze({
  countries: Object.freeze(COUNTRY_ROWS.map(([code, name, language, lat, lng]) => Object.freeze({ code, name, language, lat, lng }))),
  cities: Object.freeze(CITY_ROWS.map(([name, country, lat, lng]) => Object.freeze({ name, country, lat, lng }))),
});
const COUNTRY_BY_CODE = new Map(LOCATIONS.countries.map(c => [c.code, c]));
const norm = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Resolve a keyword's (country, location) to catalog coordinates: city match first, then the country capital.
export function resolveLocation(country, location = '') {
  const cc = String(country || '').toUpperCase(), loc = norm(String(location).split(',')[0]);
  const city = loc && LOCATIONS.cities.find(c => norm(c.name) === loc && (!cc || c.country === cc));
  if (city) return { lat: city.lat, lng: city.lng, name: city.name, country: city.country };
  const c = COUNTRY_BY_CODE.get(cc);
  return c ? { lat: c.lat, lng: c.lng, name: c.name, country: c.code } : null;
}

function searchLocations(q, country, limit) {
  const nq = norm(q);
  const score = name => { const n = norm(name); return !nq ? 1 : n.startsWith(nq) ? 2 : n.includes(nq) ? 1 : 0; };
  const out = [];
  for (const c of LOCATIONS.countries) {
    if (country && c.code !== country) continue;
    const s = Math.max(score(c.name), nq && norm(c.code) === nq ? 3 : 0);
    if (s) out.push({ s, r: { type: 'country', code: c.code, name: c.name, country: c.code, language: c.language, lat: c.lat, lng: c.lng, location: '' } });
  }
  for (const c of LOCATIONS.cities) {
    if (country && c.country !== country) continue;
    const s = score(c.name);
    if (s) out.push({ s, r: { type: 'city', code: c.country, name: c.name, country: c.country, language: COUNTRY_BY_CODE.get(c.country)?.language || 'en', lat: c.lat, lng: c.lng, location: c.name } });
  }
  return out.sort((a, b) => b.s - a.s || (a.r.type === b.r.type ? a.r.name.localeCompare(b.r.name) : a.r.type === 'country' ? -1 : 1))
    .slice(0, limit).map(x => x.r);
}

function idParam(v, name) {
  if (v === undefined || v === null || v === '') throw httpError(400, `${name} is required`);
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, `${name} must be a positive integer`);
  return n;
}
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// Position of the domain inside the local pack of a snapshot's results, or null.
function packPosition(results, domain) {
  const pack = (Array.isArray(results) ? results : []).filter(r => r && r.type === 'local_pack');
  const i = pack.findIndex(r => hostMatches(r.host || '', domain.host, !!domain.include_subdomains));
  return i < 0 ? null : Number(pack[i].pack_position ?? pack[i].packPosition) || i + 1;
}

// Grid cell coordinates: row 0 is north, col 0 is west. ~111.32 km per degree latitude.
export function gridPoints(center, size, spacingKm) {
  const half = (size - 1) / 2, dLat = spacingKm / 111.32, dLng = spacingKm / (111.32 * Math.max(0.01, Math.cos(center.lat * Math.PI / 180)));
  const pts = [];
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++)
    pts.push({ row, col, lat: round(center.lat + (half - row) * dLat, 5), lng: round(((center.lng + (col - half) * dLng + 540) % 360) - 180, 5) });
  return pts;
}

// Deterministic offline fallback: rank worsens with distance from center, plus stable per-point jitter.
function simulatedRank(kw, base, pt, center, spacingKm, size) {
  const distSteps = Math.hypot(pt.row - (size - 1) / 2, pt.col - (size - 1) / 2);
  const u = unit('grid', kw.id, kw.phrase, pt.lat.toFixed(4), pt.lng.toFixed(4));
  if (u < 0.06 + distSteps * 0.04) return null;
  const r = Math.round(base + distSteps * (1 + spacingKm * 0.6) + (u - 0.5) * 6);
  return Math.min(100, Math.max(1, r));
}

export default {
  name: 'local-rank',
  router(ctx) {
    const { db, express } = ctx;
    const r = express.Router();
    r.use(requireAuth);

    r.get('/locations', (req, res) => {
      const country = String(req.query.country ?? '').trim().toUpperCase();
      if (country && !/^[A-Z]{2}$/.test(country)) throw httpError(400, 'country must be a 2-letter code');
      const q = String(req.query.q ?? '').slice(0, 80);
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw httpError(400, 'limit must be an integer between 1 and 200');
      res.json({ results: searchLocations(q, country, limit) });
    });

    r.get('/keywords', (req, res) => {
      const domain = loadOwnedDomain(db, req, idParam(req.query.domainId, 'domainId'));
      const keywords = latestRanks(db, domain.id).map(k => ({ id: k.id, phrase: k.phrase, country: k.country, location: k.location, device: k.device, rank: k.rank }))
        .sort((a, b) => a.phrase.localeCompare(b.phrase));
      res.json({ keywords });
    });

    r.get('/map-pack', (req, res) => {
      const domain = loadOwnedDomain(db, req, idParam(req.query.domainId, 'domainId'));
      const keywords = latestRanks(db, domain.id)
        .filter(k => k.checked_at && parseJson(k.serp_features, []).includes?.('local_pack'))
        .map(k => {
          const owned = parseJson(k.owned_features, []), results = parseJson(k.results, []);
          const pos = packPosition(results, domain);
          return { id: k.id, phrase: k.phrase, country: k.country, location: k.location, device: k.device, rank: k.rank,
            owned: (Array.isArray(owned) && owned.includes('local_pack')) || pos != null, packPosition: pos, checkedAt: k.checked_at };
        })
        .sort((a, b) => Number(b.owned) - Number(a.owned) || (a.packPosition ?? 99) - (b.packPosition ?? 99) || a.phrase.localeCompare(b.phrase));
      res.json({ domainId: domain.id, total: keywords.length, owned: keywords.filter(k => k.owned).length, keywords });
    });

    r.get('/by-location', (req, res) => {
      const domain = loadOwnedDomain(db, req, idParam(req.query.domainId, 'domainId'));
      const groups = new Map();
      for (const k of latestRanks(db, domain.id)) {
        const key = `${k.country}\u0001${k.location}`;
        if (!groups.has(key)) groups.set(key, { country: k.country, location: k.location, keywords: 0, ranked: 0, sum: 0, top10: 0, top3: 0 });
        const g = groups.get(key);
        g.keywords++;
        if (k.rank != null) { g.ranked++; g.sum += k.rank; if (k.rank <= 10) g.top10++; if (k.rank <= 3) g.top3++; }
      }
      const locations = [...groups.values()].map(({ sum, ...g }) => {
        const geo = resolveLocation(g.country, g.location);
        return { ...g, countryName: COUNTRY_BY_CODE.get(String(g.country).toUpperCase())?.name || g.country,
          avgRank: g.ranked ? round(sum / g.ranked) : null, lat: geo?.lat ?? null, lng: geo?.lng ?? null };
      }).sort((a, b) => b.keywords - a.keywords || a.country.localeCompare(b.country) || a.location.localeCompare(b.location));
      res.json({ domainId: domain.id, locations });
    });

    r.post('/grid', async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const kw = loadOwnedKeyword(db, req, idParam(body.keywordId, 'keywordId'));
      const domain = db.prepare('SELECT * FROM domains WHERE id = ?').get(kw.domain_id);
      const lat = Number(body.center?.lat), lng = Number(body.center?.lng);
      if (body.center == null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        throw httpError(400, 'center must be {lat: -90..90, lng: -180..180}');
      const size = body.size === undefined ? 5 : Number(body.size);
      if (![3, 5, 7].includes(size)) throw httpError(400, 'size must be 3, 5 or 7');
      const spacingKm = body.spacingKm === undefined ? 1 : Number(body.spacingKm);
      if (!Number.isFinite(spacingKm) || spacingKm < 0.1 || spacingKm > 50) throw httpError(400, 'spacingKm must be between 0.1 and 50');

      const center = { lat, lng }, points = gridPoints(center, size, spacingKm);
      const provider = ctx.provider;
      let source = 'simulated', cells;
      if (provider?.fetchSerp) {
        source = 'provider';
        const date = new Date().toISOString().slice(0, 10);
        cells = await Promise.all(points.map(async pt => {
          const serp = await provider.fetchSerp({ phrase: kw.phrase, searchEngine: kw.search_engine, device: kw.device, country: kw.country,
            location: `${pt.lat},${pt.lng}`, language: kw.language, date, hosts: [domain.host] });
          const hit = (serp?.results || []).find(x => x && x.type !== 'local_pack' && hostMatches(x.host, domain.host, !!domain.include_subdomains));
          return { ...pt, rank: hit ? hit.position : null, packPosition: packPosition(serp?.results, domain) };
        }));
      } else {
        const last = db.prepare('SELECT rank FROM rank_snapshots WHERE keyword_id = ? AND rank IS NOT NULL ORDER BY checked_at DESC LIMIT 1').get(kw.id);
        const base = last?.rank ?? 5 + Math.floor(unit('gridbase', kw.id, kw.phrase) * 15);
        cells = points.map(pt => ({ ...pt, rank: simulatedRank(kw, base, pt, center, spacingKm, size), packPosition: null }));
      }
      const ranked = cells.filter(c => c.rank != null);
      const stats = { total: cells.length, found: ranked.length, top3: ranked.filter(c => c.rank <= 3).length, top10: ranked.filter(c => c.rank <= 10).length,
        avgRank: ranked.length ? round(ranked.reduce((s, c) => s + c.rank, 0) / ranked.length) : null };
      res.json({ keywordId: kw.id, phrase: kw.phrase, host: domain.host, center, size, spacingKm, source, cells, stats });
    });

    return r;
  },
};
