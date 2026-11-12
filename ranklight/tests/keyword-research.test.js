import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';
import { classifyIntent, serpDifficulty, expandSeed } from '../server/modules/keyword-research.js';

let t, user, domainId, kwIds, otherDomainId;
const added = [];
const results = hosts => JSON.stringify(hosts.map((host, i) => ({ position: i + 1, host, url: `https://${host}/page`, title: host })));
const snap = (keywordId, rank, hosts, at = '2026-11-01T06:00:00Z') =>
  t.ctx.db.prepare('INSERT INTO rank_snapshots(keyword_id, checked_at, rank, results) VALUES (?,?,?,?)').run(keywordId, at, rank, results(hosts));
const fillers = n => Array.from({ length: n }, (_, i) => `filler${i}.net`);

before(async () => {
  t = await startTestServer({ modules: ['keyword-research'] });
  t.ctx.events.on('keywords:added', e => added.push(e));
  user = (await t.signup()).user;
  ({ domainId, keywordIds: kwIds } = t.seedDomain(user.id, 'example.com', ['seo tool', 'rank tracker', 'serp checker']));
  t.ctx.db.prepare('INSERT INTO competitors(domain_id, host) VALUES (?,?)').run(domainId, 'rival.com');
  // seo tool: rival at 3, we are unranked -> gap. rank tracker: we are 2 -> no gap. serp checker: rival at 40 -> no gap.
  snap(kwIds[0], null, ['wikipedia.org', 'reddit.com', 'rival.com', ...fillers(10)]);
  snap(kwIds[1], 2, ['rival.com', 'example.com', ...fillers(10)]);
  snap(kwIds[2], 50, [...fillers(39), 'rival.com']);
  // Another domain of the same user tracks a phrase example.com does not track; rival ranks 5 there.
  const other = t.seedDomain(user.id, 'side.io', ['keyword ideas']);
  otherDomainId = other.domainId;
  snap(other.keywordIds[0], 1, ['side.io', ...fillers(3), 'www.rival.com', ...fillers(5)]);
});
after(() => t.close());

test('helpers: intent, difficulty and expansion', () => {
  assert.equal(classifyIntent('buy running shoes'), 'transactional');
  assert.equal(classifyIntent('best running shoes'), 'commercial');
  assert.equal(classifyIntent('nike login'), 'navigational');
  assert.equal(classifyIntent('how to tie running shoes'), 'informational');
  const hard = serpDifficulty(['wikipedia.org', 'amazon.com', 'youtube.com', 'reddit.com']);
  const easy = serpDifficulty(['tinyblog123.net', 'mysite99.org', 'another-small.co']);
  assert.ok(hard > easy && hard <= 100 && easy >= 0, `${hard} > ${easy}`);
  assert.equal(serpDifficulty([]), null);
  const ideas = expandSeed('crm', [{ phrase: 'hubspot', source: 'related' }]).map(i => i.phrase);
  assert.equal(ideas[0], 'crm');
  assert.ok(ideas.includes('crm vs hubspot') && ideas.includes('what is crm') && ideas.includes('crm near me'));
  assert.equal(new Set(ideas).size, ideas.length);
});

test('requires auth', async () => {
  const token = (await t.api('POST', '/api/auth/login', { email: user.email, password: 'password123' })).data.token;
  t.setToken(null);
  assert.equal((await t.api('GET', '/api/keyword-research/ideas?seed=seo')).status, 401);
  assert.equal((await t.api('GET', `/api/keyword-research/gap?domainId=${domainId}`)).status, 401);
  t.setToken(token);
});

test('ideas validates input', async () => {
  assert.equal((await t.api('GET', '/api/keyword-research/ideas')).status, 400);
  assert.equal((await t.api('GET', '/api/keyword-research/ideas?seed=x')).status, 400);
  assert.equal((await t.api('GET', '/api/keyword-research/ideas?seed=seo&country=USA')).status, 400);
  assert.equal((await t.api('GET', '/api/keyword-research/ideas?seed=seo&limit=0')).status, 400);
  assert.equal((await t.api('GET', '/api/keyword-research/ideas?seed=seo&language=!!')).status, 400);
});

test('ideas without a provider uses modifiers, questions and stored SERPs', async () => {
  t.ctx.provider = null;
  const r = await t.api('GET', '/api/keyword-research/ideas?seed=SEO%20%20Tool&country=us');
  assert.equal(r.status, 200);
  assert.equal(r.data.providerAvailable, false);
  assert.equal(r.data.country, 'US');
  const by = Object.fromEntries(r.data.ideas.map(i => [i.phrase, i]));
  assert.equal(r.data.ideas[0].phrase, 'seo tool');
  for (const p of ['best seo tool', 'seo tool near me', 'cheap seo tool', 'seo tool for beginners', 'seo tool alternatives', 'how to seo tool', 'what is seo tool', 'seo tool vs competitors'])
    assert.ok(by[p], `missing ${p}`);
  assert.equal(by['best seo tool'].intent, 'commercial');
  assert.equal(by['buy seo tool'].intent, 'transactional');
  assert.equal(by['what is seo tool'].intent, 'informational');
  assert.ok(r.data.ideas.every(i => i.volume === null && i.cpc === null && Number.isInteger(i.difficulty) && i.difficulty >= 0 && i.difficulty <= 100));
  // Seed difficulty comes from the stored SERP (wikipedia + reddit on top).
  assert.equal(by['seo tool'].difficulty, serpDifficulty(['wikipedia.org', 'reddit.com', 'rival.com', ...fillers(10)]));
  const lim = await t.api('GET', '/api/keyword-research/ideas?seed=seo%20tool&limit=5');
  assert.equal(lim.data.ideas.length, 5);
});

test('ideas with a provider adds related searches and volumes', async () => {
  const seen = [];
  t.ctx.provider = {
    async fetchSerp(opts) {
      seen.push(opts);
      return { results: [{ position: 1, host: 'amazon.com', url: 'https://amazon.com/x' }], features: ['related_searches'],
        related_searches: ['Running Shoes Women', { query: 'trail shoes' }] };
    },
    async fetchVolume(phrases) { return Object.fromEntries(phrases.map(p => [p, { volume: p.length * 10, cpc: 1.5, competition: 0.4, trend: [] }])); },
  };
  const r = await t.api('GET', '/api/keyword-research/ideas?seed=running%20shoes&country=GB');
  assert.equal(r.status, 200);
  assert.equal(seen[0].country, 'GB');
  const by = Object.fromEntries(r.data.ideas.map(i => [i.phrase, i]));
  assert.equal(by['running shoes women'].source, 'related');
  assert.ok(by['running shoes vs trail shoes']);
  assert.equal(by['trail shoes'].volume, 110);
  assert.equal(by['trail shoes'].cpc, 1.5);
  const rest = r.data.ideas.slice(1).map(i => i.volume);
  assert.deepEqual(rest, [...rest].sort((a, b) => b - a));
  t.ctx.provider = { async fetchSerp() { throw new Error('down'); }, async fetchVolume() { throw new Error('down'); } };
  const f = await t.api('GET', '/api/keyword-research/ideas?seed=running%20shoes');
  assert.equal(f.status, 200);
  assert.equal(f.data.warnings.length, 2);
  assert.ok(f.data.ideas.every(i => i.volume === null));
  t.ctx.provider = null;
});

test('gap lists phrases where competitors rank top 20 and the domain does not', async () => {
  const r = await t.api('GET', `/api/keyword-research/gap?domainId=${domainId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.competitors, ['rival.com']);
  assert.equal(r.data.competitorsSource, 'configured');
  assert.deepEqual(r.data.gaps.map(g => g.phrase), ['seo tool', 'keyword ideas']);
  const [a, b] = r.data.gaps;
  assert.equal(a.tracked, true);
  assert.equal(a.bestCompetitorRank, 3);
  assert.equal(a.yourRank, null);
  assert.equal(b.tracked, false);
  assert.equal(b.bestCompetitorRank, 5);
  const narrow = await t.api('GET', `/api/keyword-research/gap?domainId=${domainId}&maxRank=4`);
  assert.deepEqual(narrow.data.gaps.map(g => g.phrase), ['seo tool']);
  assert.equal((await t.api('GET', `/api/keyword-research/gap?domainId=${domainId}&maxRank=500`)).status, 400);
  assert.equal((await t.api('GET', '/api/keyword-research/gap')).status, 404);
});

test('gap detects competitors when none are configured', async () => {
  const r = await t.api('GET', `/api/keyword-research/gap?domainId=${otherDomainId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.competitorsSource, 'detected');
  assert.ok(Array.isArray(r.data.gaps));
});

test('track inserts keywords, skips duplicates and emits keywords:added', async () => {
  const r = await t.api('POST', '/api/keyword-research/track', { domainId, phrases: ['Best SEO Tool', 'seo tool', 'best seo tool'] });
  assert.equal(r.status, 201);
  assert.equal(r.data.created, 1);
  assert.equal(r.data.skipped, 1);
  assert.deepEqual(added.at(-1), { domainId, keywordIds: r.data.keywordIds });
  const row = t.ctx.db.prepare('SELECT * FROM keywords WHERE id = ?').get(r.data.keywordIds[0]);
  assert.equal(row.phrase, 'best seo tool');
  assert.equal(row.country, 'US');
  assert.equal((await t.api('POST', '/api/keyword-research/track', { domainId, phrases: [] })).status, 400);
  assert.equal((await t.api('POST', '/api/keyword-research/track', { domainId, phrases: 'x' })).status, 400);
  assert.equal((await t.api('POST', '/api/keyword-research/track', { domainId, phrases: ['x'], device: 'tv' })).status, 400);
  assert.equal((await t.api('POST', '/api/keyword-research/track', { domainId, phrases: ['x'], country: 'usa' })).status, 400);
});

test('data is scoped to the owner', async () => {
  await t.signup();
  assert.equal((await t.api('GET', `/api/keyword-research/gap?domainId=${domainId}`)).status, 404);
  assert.equal((await t.api('POST', '/api/keyword-research/track', { domainId, phrases: ['hack'] })).status, 404);
  // Stored SERPs of other users must not influence difficulty: falls back to the estimate.
  const r = await t.api('GET', '/api/keyword-research/ideas?seed=seo%20tool');
  assert.equal(r.status, 200);
  assert.notEqual(r.data.ideas[0].difficulty, serpDifficulty(['wikipedia.org', 'reddit.com', 'rival.com', ...fillers(10)]));
});
