// Rank data provider: installs ctx.provider (simulator, DataForSEO or SerpApi) and reports its status.
import { requireAuth } from '../lib/http.js';
import { createProvider } from '../lib/providers/index.js';

export default {
  name: 'rank-provider',
  setup(ctx) {
    ctx.provider = createProvider({ db: ctx.db });
  },
  router({ express, provider }) {
    const r = express.Router();
    r.get('/status', requireAuth, (_req, res) => {
      res.json({ provider: provider.requested, configured: provider.configured, active: provider.name });
    });
    return r;
  },
};
