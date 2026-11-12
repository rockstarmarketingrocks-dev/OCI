// Provider selection via RANK_PROVIDER=simulator|dataforseo|serpapi (default simulator).
// An adapter without credentials falls back to the simulator so the app keeps working offline.
import { createSimulator } from './simulator.js';
import { createDataForSeo } from './dataforseo.js';
import { createSerpApi } from './serpapi.js';

export const PROVIDERS = ['simulator', 'dataforseo', 'serpapi'];

export function createProvider({ db, env = process.env, fetchImpl } = {}) {
  const requested = String(env.RANK_PROVIDER || 'simulator').trim().toLowerCase();
  const simulator = createSimulator({ db });
  let remote = null;
  if (requested === 'dataforseo') remote = createDataForSeo({ login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD, fetchImpl });
  else if (requested === 'serpapi') remote = createSerpApi({ apiKey: env.SERPAPI_KEY, fetchImpl, volumeFallback: simulator.fetchVolume });
  else if (requested !== 'simulator') console.warn(`[rank-provider] Unknown RANK_PROVIDER "${requested}", using simulator`);
  const active = remote?.configured ? remote : simulator;
  if (remote && !remote.configured) console.warn(`[rank-provider] ${requested} selected but credentials are missing, using simulator`);
  return {
    name: active.name,
    requested: PROVIDERS.includes(requested) ? requested : 'simulator',
    configured: Boolean(remote ? remote.configured : true),
    fetchSerp: opts => active.fetchSerp(opts),
    fetchVolume: (phrases, opts) => active.fetchVolume(phrases, opts),
  };
}
