// DataForSEO adapter (https://docs.dataforseo.com). Needs DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.
import { fetchJson, countryName, hostFromUrl, finalizeResults } from './common.js';

const API = 'https://api.dataforseo.com/v3';
const ENGINES = { google: 'google', bing: 'bing', youtube: 'youtube' };
// DataForSEO item types -> Ranklight SERP feature ids.
const FEATURE_MAP = {
  featured_snippet: 'featured_snippet', people_also_ask: 'people_also_ask', local_pack: 'local_pack', map: 'local_pack',
  knowledge_graph: 'knowledge_panel', images: 'image_pack', video: 'video', short_videos: 'video', top_stories: 'top_stories',
  shopping: 'shopping', popular_products: 'shopping', google_reviews: 'reviews', third_party_reviews: 'reviews', faq: 'faq',
  twitter: 'twitter', related_searches: 'related_searches', ai_overview: 'ai_overview', youtube_video: 'video',
};

const locationName = (country, location) => (location ? `${location},${countryName(country)}` : countryName(country));

function unwrap(data) {
  const task = data?.tasks?.[0];
  if (!task || (task.status_code && task.status_code >= 40000)) throw new Error(`DataForSEO: ${task?.status_message || data?.status_message || 'empty response'}`);
  return task.result || [];
}

export function mapSerp(data) {
  const res = unwrap(data)[0] || {};
  const items = res.items || [];
  const features = new Set();
  for (const t of res.item_types || items.map(i => i.type)) if (FEATURE_MAP[t]) features.add(FEATURE_MAP[t]);
  const paid = items.filter(i => i.type === 'paid');
  if (paid.length) {
    const firstOrganic = items.find(i => i.type === 'organic')?.rank_absolute ?? Infinity;
    if (paid.some(p => p.rank_absolute < firstOrganic)) features.add('ads_top');
    if (paid.some(p => p.rank_absolute > firstOrganic)) features.add('ads_bottom');
  }
  if (items.some(i => i.type === 'organic' && i.links?.length)) features.add('sitelinks');
  const organic = items.filter(i => i.type === 'organic' || i.type === 'youtube_video')
    .sort((a, b) => (a.rank_group ?? a.rank_absolute) - (b.rank_group ?? b.rank_absolute))
    .map(i => ({ url: i.url, host: hostFromUrl(i.url) || String(i.domain || '').replace(/^www\./, ''), title: i.title }));
  return { results: finalizeResults(organic), features: [...features], totalResults: Number(res.se_results_count) || 0 };
}

export function mapVolume(data, phrases) {
  const byKey = new Map(unwrap(data).map(r => [String(r.keyword).toLowerCase(), r]));
  const out = {};
  for (const ph of phrases) {
    const r = byKey.get(String(ph).toLowerCase());
    if (!r) continue;
    const months = [...(r.monthly_searches || [])].sort((a, b) => a.year - b.year || a.month - b.month).slice(-12).map(m => m.search_volume ?? 0);
    out[ph] = {
      volume: r.search_volume ?? 0, cpc: r.cpc ?? 0,
      competition: r.competition_index != null ? r.competition_index / 100 : typeof r.competition === 'number' ? r.competition : 0,
      trend: [...Array(Math.max(0, 12 - months.length)).fill(0), ...months],
    };
  }
  return out;
}

export function createDataForSeo({ login = process.env.DATAFORSEO_LOGIN, password = process.env.DATAFORSEO_PASSWORD, fetchImpl = globalThis.fetch } = {}) {
  const headers = { authorization: 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64'), 'content-type': 'application/json' };
  const post = (path, body) => fetchJson(fetchImpl, API + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return {
    name: 'dataforseo',
    configured: Boolean(login && password),
    async fetchSerp({ phrase, searchEngine = 'google', device = 'desktop', country = 'US', location = '', language = 'en' }) {
      const engine = ENGINES[searchEngine] || 'google';
      const data = await post(`/serp/${engine}/organic/live/advanced`, [{
        keyword: phrase, location_name: locationName(country, location), language_code: language, device, depth: 100,
      }]);
      return mapSerp(data);
    },
    async fetchVolume(phrases = [], { country = 'US', language = 'en' } = {}) {
      const list = phrases.filter(p => String(p ?? '').trim());
      const out = {};
      for (let i = 0; i < list.length; i += 1000) {
        const chunk = list.slice(i, i + 1000);
        Object.assign(out, mapVolume(await post('/keywords_data/google_ads/search_volume/live', [{ keywords: chunk, location_name: countryName(country), language_code: language }]), chunk));
      }
      return out;
    },
  };
}
