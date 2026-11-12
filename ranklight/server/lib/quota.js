// Plan quota enforcement shared by every module that creates keywords or domains.
// The billing module sets ctx.quota in setup(); when billing is not loaded, nothing is enforced.
import { httpError } from './http.js';

// Call inside the insert transaction, after the rows are written: if the user is now over the
// plan limit the thrown 402 rolls the transaction back.
export function enforceKeywordQuota(ctx, userId) {
  const q = ctx?.quota?.checkKeywordQuota?.(ctx.db, userId, 0);
  if (q && q.used > q.limit)
    throw httpError(402, `Keyword limit reached: the ${q.plan} plan allows ${q.limit} keywords. Upgrade your plan or remove keywords.`, { limit: q.limit, plan: q.plan });
}

// Call before inserting a domain.
export function enforceDomainQuota(ctx, userId, adding = 1) {
  const q = ctx?.quota?.checkDomainQuota?.(ctx.db, userId, adding);
  if (q && !q.ok)
    throw httpError(402, `Domain limit reached: the ${q.plan} plan allows ${q.limit} domains. Upgrade your plan or remove a domain.`, { limit: q.limit, plan: q.plan });
}
