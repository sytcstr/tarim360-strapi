/**
 * LISTING_L12_POPULAR_TRENDING_RANKING_REPORT.md.
 *
 * Forensic found NO server-side "Popular" ranking existed anywhere
 * before this phase -- every Home/Popular-page screen fetched ~60 most-
 * recent listings and re-sorted that small client-side window in Dart,
 * presenting the result as if it were a true global ranking. This suite
 * proves the new `GET /listings?sortBy=popular` mode (listing-popular-
 * query.ts) is genuinely server-authoritative over the WHOLE eligible
 * catalog: a deterministic fixture (mandate's own A-G scenario set),
 * stable pagination across two pages with no duplicates/gaps, inactive/
 * pending/rejected exclusion, active-Rocket-floats-to-top, expired-
 * Rocket-gets-NO-promotion-advantage (the single most important
 * correctness property this phase exists to guarantee), and that the
 * existing protected-counter/spoof defenses are untouched.
 *
 * Every test scopes its own query with a unique `subType` tag (real
 * `entityService.create` calls bypass the HTTP create() controller, so
 * `searchNormalized`/`cityNormalized` are never auto-computed the way a
 * real client request would get them -- `subType` is a plain `$eq`
 * filter needing no such derived field) -- all tests share one Strapi
 * instance/DB with no reset between them, so without per-test scoping,
 * an earlier test's fixture listings would pollute a later test's
 * result set and pagination totals (confirmed while writing this suite:
 * that exact cross-test pollution was the initial failure cause, not a
 * bug in the query itself).
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file -- see before() below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-popular-ranking-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-popular-ranking-test.db');
const PORT = 14189;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

let strapiInstance: any;

before(async () => {
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = String(PORT);
  const compiled = await compileStrapi();
  strapiInstance = await createStrapi(compiled).load();
  await strapiInstance.server.listen(PORT);
});

after(async () => {
  await strapiInstance?.server?.close?.();
  await strapiInstance?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

async function registerAndLogin(email: string): Promise<{ jwt: string; ownerId: string; email: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  const ownerId = `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt, ownerId, email: email.trim().toLowerCase() };
}

const uniqueTag = () => `l12tag${randomUUID().replace(/-/g, '')}`;

async function createListing(
  owner: { ownerId: string; email: string },
  tag: string,
  overrides: Record<string, unknown> = {},
) {
  return strapiInstance.entityService.create('api::listing.listing', {
    data: {
      title: 'L12 Ranking Test Ilani',
      mainType: 'tarim',
      subType: tag,
      mode: 'sell',
      price: 100,
      ownerProfileId: owner.ownerId,
      ownerId: owner.ownerId,
      ownerEmail: owner.email,
      status: 'active',
      isDoping: false,
      isPremium: false,
      isPremiumOwner: false,
      viewCount: 0,
      favoriteCount: 0,
      likeCount: 0,
      offerCount: 0,
      publishedAt: new Date().toISOString(),
      ...overrides,
    },
  });
}

async function fetchPopular(tag: string, params: string) {
  const res = await fetch(`${BASE_URL}/listings?sortBy=popular&subType=${tag}${params}`);
  const body = await res.json();
  return { status: res.status, body };
}

const titlesInOrder = (body: any): string[] =>
  (body.data as any[]).map((row) => row.title);

// ---------------------------------------------------------------------
// L12.20/L12.21 -- deterministic ranking fixture (mandate's own A-G set)
// ---------------------------------------------------------------------

test('L12: deterministic popular order across the mandate\'s A-G fixture', async () => {
  const tag = uniqueTag();
  const owner = await registerAndLogin(`l12-fixture-owner-${randomUUID()}@test.local`);
  const future = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 3600_000).toISOString();

  // D: active Rocket -- must outrank every non-rocketed listing
  // regardless of its own (deliberately low) engagement numbers.
  await createListing(owner, tag, {
    title: 'Listing D (active rocket)',
    isDoping: true,
    rocketEndsAt: future,
    offerCount: 1,
  });
  // E: expired Rocket -- must NOT get any promotion advantage. Given
  // zero engagement (deliberately, so it ranks unambiguously below B/C
  // on the same offers/favorites tie-break weights this query uses)
  // this proves an expired rocket is treated exactly like an ordinary
  // never-rocketed listing, not specially promoted.
  await createListing(owner, tag, {
    title: 'Listing E (expired rocket)',
    isDoping: true,
    rocketEndsAt: past,
  });
  // B: highest offerCount among the non-rocketed listings (offers is
  // the heaviest tie-break weight).
  await createListing(owner, tag, {
    title: 'Listing B (high offers)',
    offerCount: 10,
    favoriteCount: 1,
  });
  // C: highest favoriteCount among the rest (no offers, so it ranks
  // below B but above anything with neither offers nor favorites).
  await createListing(owner, tag, {
    title: 'Listing C (high favorites)',
    favoriteCount: 8,
    likeCount: 1,
  });
  // A: only views -- lowest-weighted signal, ranks last among the
  // engaged listings.
  await createListing(owner, tag, {
    title: 'Listing A (only views)',
    viewCount: 50,
  });
  // F: zero engagement, never rocketed -- ranks at the very bottom
  // (tied with E, but included to prove it's not excluded).
  await createListing(owner, tag, { title: 'Listing F (inactive engagement)' });

  const { status, body } = await fetchPopular(tag, '&pageSize=10');
  assert.equal(status, 200);
  const titles = titlesInOrder(body);

  const expectedOrder = [
    'Listing D (active rocket)',
    'Listing B (high offers)',
    'Listing C (high favorites)',
    'Listing A (only views)',
  ];
  assert.deepEqual(
    titles.slice(0, 4),
    expectedOrder,
    `unexpected order: ${JSON.stringify(titles)}`,
  );
  // E and F are tied (zero engagement, tier 2) -- both must still be
  // present, order between the two is not asserted.
  assert.deepEqual(
    new Set(titles.slice(4)),
    new Set(['Listing E (expired rocket)', 'Listing F (inactive engagement)']),
  );
});

test('L12: a same-score tie (G) is broken deterministically, not randomly, across repeated requests', async () => {
  const tag = uniqueTag();
  const owner = await registerAndLogin(`l12-tie-owner-${randomUUID()}@test.local`);
  await createListing(owner, tag, { title: 'Tie G1', favoriteCount: 3 });
  await createListing(owner, tag, { title: 'Tie G2', favoriteCount: 3 });

  const first = await fetchPopular(tag, '&pageSize=10');
  const second = await fetchPopular(tag, '&pageSize=10');
  assert.deepEqual(
    titlesInOrder(first.body),
    titlesInOrder(second.body),
    'tie order must be stable across identical requests',
  );
});

// ---------------------------------------------------------------------
// L12.5 -- pagination: no duplicates, no gaps, across tier boundary
// ---------------------------------------------------------------------

test('L12.5: page 1 and page 2 together cover every listing exactly once, even when Rocket listings straddle the page boundary', async () => {
  const tag = uniqueTag();
  const owner = await registerAndLogin(`l12-pagination-owner-${randomUUID()}@test.local`);
  const future = new Date(Date.now() + 3600_000).toISOString();

  const titles: string[] = [];
  for (let i = 0; i < 3; i++) {
    const title = `Rocket-${i}`;
    await createListing(owner, tag, { title, isDoping: true, rocketEndsAt: future, viewCount: 10 - i });
    titles.push(title);
  }
  for (let i = 0; i < 3; i++) {
    const title = `Standard-${i}`;
    await createListing(owner, tag, { title, viewCount: 10 - i });
    titles.push(title);
  }

  const pageSize = 2;
  const page1 = await fetchPopular(tag, `&pageSize=${pageSize}&page=1`);
  const page2 = await fetchPopular(tag, `&pageSize=${pageSize}&page=2`);
  const page3 = await fetchPopular(tag, `&pageSize=${pageSize}&page=3`);

  const all = [...titlesInOrder(page1.body), ...titlesInOrder(page2.body), ...titlesInOrder(page3.body)];
  const unique = new Set(all);
  assert.equal(all.length, unique.size, `duplicates found across pages: ${JSON.stringify(all)}`);
  for (const t of titles) {
    assert.ok(unique.has(t), `listing ${t} missing from paginated results`);
  }
  assert.equal(page1.body.meta.pagination.total, 6);
  assert.equal(page1.body.meta.pagination.pageCount, 3);
});

// ---------------------------------------------------------------------
// L12.11 -- eligibility: inactive/pending/rejected excluded
// ---------------------------------------------------------------------

test('L12.11: pending and rejected listings never appear in popular results', async () => {
  const tag = uniqueTag();
  const owner = await registerAndLogin(`l12-eligibility-owner-${randomUUID()}@test.local`);
  await createListing(owner, tag, { title: 'Active Eligible', viewCount: 5 });
  const pending = await createListing(owner, tag, { title: 'Pending Ineligible', viewCount: 999 });
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId: pending.documentId },
    data: { status: 'pending' },
  });
  const rejected = await createListing(owner, tag, { title: 'Rejected Ineligible', viewCount: 999 });
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId: rejected.documentId },
    data: { status: 'rejected' },
  });

  const { body } = await fetchPopular(tag, '&pageSize=10');
  const titles = titlesInOrder(body);
  assert.ok(titles.includes('Active Eligible'));
  assert.ok(!titles.includes('Pending Ineligible'), 'a pending listing must never leak into popular results');
  assert.ok(!titles.includes('Rejected Ineligible'), 'a rejected listing must never leak into popular results');
});

// ---------------------------------------------------------------------
// L12.13 -- filters combine correctly with popular sort
// ---------------------------------------------------------------------

test('L12.13: mainType filter still applies when sortBy=popular', async () => {
  const tag = uniqueTag();
  const owner = await registerAndLogin(`l12-filter-owner-${randomUUID()}@test.local`);
  await createListing(owner, tag, { title: 'Tarim Match', mainType: 'tarim', viewCount: 5 });
  await createListing(owner, tag, { title: 'Hayvancilik NoMatch', mainType: 'hayvancilik', viewCount: 999 });

  const { body } = await fetchPopular(tag, '&pageSize=10&mainType=tarim');
  const titles = titlesInOrder(body);
  assert.ok(titles.includes('Tarim Match'));
  assert.ok(!titles.includes('Hayvancilik NoMatch'), 'mainType filter must not be bypassed by sortBy=popular');
});

// ---------------------------------------------------------------------
// L12.4/L12.10 -- protected counters remain un-spoofable regardless of
// the new popular sort mode existing
// ---------------------------------------------------------------------

test('L12.10 regression: a client still cannot spoof favoriteCount/viewCount to manipulate popular ranking', async () => {
  const tag = uniqueTag();
  const owner = await registerAndLogin(`l12-spoof-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner, tag);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${owner.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ data: { favoriteCount: 999999, viewCount: 999999 } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.favoriteCount, 0, 'favoriteCount must remain server-authoritative regardless of the new popular sort');
  assert.equal(body.data.viewCount, 0, 'viewCount must remain server-authoritative regardless of the new popular sort');
});
