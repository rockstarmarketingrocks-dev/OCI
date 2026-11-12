// SerpApi adapter (https://serpapi.com). Needs SERPAPI_KEY.
// SerpApi has no keyword-volume endpoint, so fetchVolume falls back to the deterministic estimator passed in.
import { fetchJson, hostFromUrl, finalizeResults } from './common.js';

const API = 'https://serpapi.com/search.json';
// SerpApi response keys -> Ranklight SERP feature ids.
const FEATURE_KEYS = {
  answer_box: 'featured_snippet', related_questions: 'people_also_ask', local_results: 'local_pack', local_map: 'local_pack',
  knowledge_graph: 'knowledge_panel', inline_images: 'image_pack', images_results: 'image_pack', inline_videos: 'video',
  video_results: 'video', short_videos: 'video', top_stories: 'top_stories', shopping_results: 'shopping', inline_shopping: 'shopping',
  immersive_products: 'shopping', twitter_results: 'twitter', related_searches: 'related_searches', ai_overview: 'ai_overview',
};

export function mapSerp(data) {
  if (data?.error) throw new Error(`SerpApi: ${data.error}`);
  const features = new Set(Object.entries(FEATURE_KEYS).filter(([k]) => data[k] != null && (!Array.isArray(data[k]) || data[k].length)).map(([, f]) => f));
  for (const ad of data.ads || []) features.add(ad.block_position === 'bottom' ? 'ads_bottom' : 'ads_top');
  const organic = (data.organic_results || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (organic.some(r => r.sitelinks)) features.add('sitelinks');
  if (organic.some(r => r.rich_snippet?.top?.detected_extensions?.rating != null)) features.add('reviews');
  return {
    results: finalizeResults(organic.map(r => ({ url: r.link, host: hostFromUrl(r.link), title: r.title }))),
    features: [...features],
    totalResults: Number(data.search_information?.total_results) || 0,
  };
}

export function createSerpApi({ apiKey = process.env.SERPAPI_KEY, fetchImpl = globalThis.fetch, volumeFallback } = {}) {
  return {
    name: 'serpapi',
    configured: Boolean(apiKey),
    async fetchSerp({ phrase, searchEngine = 'google', device = 'desktop', country = 'US', location = '', language = 'en' }) {
      const q = new URLSearchParams({ api_key: apiKey, output: 'json' });
      if (searchEngine === 'bing') { q.set('engine', 'bing'); q.set('q', phrase); q.set('cc', country); q.set('count', '50'); }
      else if (searchEngine === 'youtube') { q.set('engine', 'youtube'); q.set('search_query', phrase); q.set('gl', country.toLowerCase()); q.set('hl', language); }
      else { q.set('engine', 'google'); q.set('q', phrase); q.set('gl', country.toLowerCase()); q.set('hl', language); q.set('num', '100'); q.set('device', device); }
      if (location) q.set('location', location);
      const data = await fetchJson(fetchImpl, `${API}?${q}`);
      if (searchEngine === 'youtube' && !data.organic_results) data.organic_results = (data.video_results || []).map((v, i) => ({ position: i + 1, link: v.link, title: v.title }));
      return mapSerp(data);
    },
    async fetchVolume(phrases = [], opts = {}) {
      return volumeFallback ? volumeFallback(phrases, opts) : {};
    },
  };
}
