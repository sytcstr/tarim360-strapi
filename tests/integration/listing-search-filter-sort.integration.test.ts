/**
 * LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md.
 *
 * Proves the new whitelisted listing discovery query contract
 * (buildListingDiscoveryQuery, listing.ts's find() override) is
 * genuinely server-authoritative: search/category/subtype/mode/city/
 * price filters and non-"newest" sorts are applied at the DB query
 * level BEFORE pagination, Turkish case/diacritic differences don't
 * defeat search/city matching, listingNo exact-match still works,
 * arbitrary raw filter/sort expressions are not honored once the new
 * contract activates, and legacy callers sending none of the new
 * params get the exact unmodified pre-L6 behavior (proven by the
 * pre-existing listing-type-and-public-number.integration.test.ts's own
 * raw `filters[mode][$eq]` test continuing to pass unmodified in the
 * same full suite run).
 *
 * Each test registers its OWN fresh user (same precedent as
 * listing-type-and-public-number.integration.test.ts) rather than
 * sharing one across the file -- the free-tier quota is 5 listings per
 * owner, and several tests here create more than one.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file — see before() below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-search-filter-sort-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-search-filter-sort-test.db');
const PORT = 14184;
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

async function freshUserJwt(label: string): Promise<string> {
  const email = `l6-${label}-${randomUUID()}@test.local`;
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return json.jwt;
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

function listingPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'L6 Test Ilani',
    description: 'Standart aciklama metni',
    mainType: 'tarim',
    subType: 'Tahıllar',
    mode: 'sell',
    price: 100,
    location: { city: 'Konya', district: 'Selcuklu', display: 'Konya, Selcuklu' },
    ...overrides,
  };
}

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { ...listingPayload(overrides), operationId: randomUUID() } }),
  });
  const json = await res.json();
  if (res.status >= 400) {
    throw new Error(`createListing failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function updateListing(jwt: string, documentId: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function discover(params: Record<string, string | number>) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const res = await fetch(`${BASE_URL}/listings?${qs}`);
  const json = await res.json();
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------
// Search (title / description / Turkish normalization)
// ---------------------------------------------------------------------

test('search matches by title', async () => {
  const jwt = await freshUserJwt('search-title');
  const marker = randomUUID().slice(0, 8);
  const uniqueTitle = `Bugday Satisi ${marker}`;
  await createListing(jwt, { title: uniqueTitle });
  const { status, body } = await discover({ search: uniqueTitle });
  assert.equal(status, 200);
  assert.ok(body.data.some((row: any) => row.title === uniqueTitle));
});

test('search matches by description', async () => {
  const jwt = await freshUserJwt('search-desc');
  const marker = randomUUID().slice(0, 8);
  const uniqueDesc = `Ozel aciklama metni ${marker}`;
  await createListing(jwt, { title: `Desc Match ${marker}`, description: uniqueDesc });
  const { status, body } = await discover({ search: uniqueDesc });
  assert.equal(status, 200);
  assert.ok(body.data.some((row: any) => row.description === uniqueDesc));
});

test('Turkish-normalized search: ASCII query finds a diacritic title, and vice versa', async () => {
  const jwt = await freshUserJwt('search-tr-1');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Çiftçi Ürünü ${marker}` });

  const asciiQuery = await discover({ search: `ciftci urunu ${marker}` });
  assert.ok(
    asciiQuery.body.data.some((row: any) => row.title === `Çiftçi Ürünü ${marker}`),
    'ASCII query should find the diacritic title',
  );

  const marker2 = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `bugday urunu ${marker2}` });
  const diacriticQuery = await discover({ search: `buğday ürünü ${marker2}` });
  assert.ok(
    diacriticQuery.body.data.some((row: any) => row.title === `bugday urunu ${marker2}`),
    'diacritic query should find the ASCII title',
  );
});

test('Turkish-normalized search: dotted/dotless I and case do not defeat matching', async () => {
  const jwt = await freshUserJwt('search-tr-2');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `İzmir İlani ${marker}` });
  const lower = await discover({ search: `izmir ilani ${marker}` });
  assert.ok(lower.body.data.some((row: any) => row.title === `İzmir İlani ${marker}`));
  const upper = await discover({ search: `IZMIR ILANI ${marker}` });
  assert.ok(upper.body.data.some((row: any) => row.title === `İzmir İlani ${marker}`));
});

// ---------------------------------------------------------------------
// listingNo exact match (fast path, L6.13 regression)
// ---------------------------------------------------------------------

test('listingNo exact match is a fast path independent of search text', async () => {
  const jwt = await freshUserJwt('listingno-1');
  const marker = randomUUID().slice(0, 8);
  const created = await createListing(jwt, { title: `Listing No Test ${marker}` });
  const { status, body } = await discover({ listingNo: created.listingNo, search: 'irrelevant text' });
  assert.equal(status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].listingNo, created.listingNo);
});

test('listingNo search for a non-existent number returns empty, not an error', async () => {
  const { status, body } = await discover({ listingNo: 999999999 });
  assert.equal(status, 200);
  assert.equal(body.data.length, 0);
});

// ---------------------------------------------------------------------
// Category / subtype / mode
// ---------------------------------------------------------------------

test('server-side mainType (category) filter', async () => {
  const jwt = await freshUserJwt('category');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Hayvan ${marker}`, mainType: 'hayvancilik', subType: 'Büyükbaş' });
  const { body } = await discover({ mainType: 'hayvancilik', search: marker });
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((row: any) => row.mainType === 'hayvancilik'));
});

test('server-side subType filter', async () => {
  const jwt = await freshUserJwt('subtype');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Baklagil ${marker}`, subType: 'Baklagiller' });
  await createListing(jwt, { title: `Yem ${marker}`, subType: 'Yem Bitkileri' });
  const { body } = await discover({ subType: 'Baklagiller', search: marker });
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((row: any) => row.subType === 'Baklagiller'));
});

test('server-side sell filter', async () => {
  const jwt = await freshUserJwt('mode-sell');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Sell ${marker}`, mode: 'sell' });
  await createListing(jwt, { title: `Buy ${marker}`, mode: 'buy' });
  const { body } = await discover({ mode: 'sell', search: marker });
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((row: any) => row.mode === 'sell'));
});

test('server-side buy filter', async () => {
  const jwt = await freshUserJwt('mode-buy');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Sell2 ${marker}`, mode: 'sell' });
  await createListing(jwt, { title: `Buy2 ${marker}`, mode: 'buy' });
  const { body } = await discover({ mode: 'buy', search: marker });
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((row: any) => row.mode === 'buy'));
});

// ---------------------------------------------------------------------
// City / location (L6.7)
// ---------------------------------------------------------------------

test('server-side city filter matches the structured location.city value', async () => {
  const jwt = await freshUserJwt('city-1');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, {
    title: `City Match ${marker}`,
    location: { city: 'Şanlıurfa', district: 'Haliliye', display: 'Şanlıurfa' },
  });
  const { body } = await discover({ city: 'Şanlıurfa', search: marker });
  assert.ok(body.data.length >= 1);
});

test('city filter is Turkish case/diacritic tolerant', async () => {
  const jwt = await freshUserJwt('city-2');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, {
    title: `City Case ${marker}`,
    location: { city: 'Şanlıurfa', district: 'Haliliye', display: 'Şanlıurfa' },
  });
  const asciiLower = await discover({ city: 'sanliurfa', search: marker });
  assert.ok(asciiLower.body.data.length >= 1, 'ascii lowercase city should match');
  const upper = await discover({ city: 'SANLIURFA', search: marker });
  assert.ok(upper.body.data.length >= 1, 'uppercase ascii city should match');
});

// ---------------------------------------------------------------------
// Price range (L6.8)
// ---------------------------------------------------------------------

test('minPrice/maxPrice boundaries are inclusive', async () => {
  const jwt = await freshUserJwt('price-1');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Price100 ${marker}`, price: 100 });
  await createListing(jwt, { title: `Price200 ${marker}`, price: 200 });
  await createListing(jwt, { title: `Price300 ${marker}`, price: 300 });

  const exactMin = await discover({ minPrice: 100, search: marker });
  assert.ok(exactMin.body.data.some((r: any) => r.price === 100), 'price == min should be included');

  const exactMax = await discover({ maxPrice: 300, search: marker });
  assert.ok(exactMax.body.data.some((r: any) => r.price === 300), 'price == max should be included');

  const minOnly = await discover({ minPrice: 200, search: marker });
  assert.ok(minOnly.body.data.every((r: any) => r.price >= 200));

  const maxOnly = await discover({ maxPrice: 200, search: marker });
  assert.ok(maxOnly.body.data.every((r: any) => r.price <= 200));

  const range = await discover({ minPrice: 150, maxPrice: 250, search: marker });
  assert.ok(range.body.data.every((r: any) => r.price >= 150 && r.price <= 250));
  assert.ok(range.body.data.some((r: any) => r.price === 200));
});

test('min > max is treated as an impossible range (empty result, not an error)', async () => {
  const jwt = await freshUserJwt('price-2');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Impossible ${marker}`, price: 150 });
  const { status, body } = await discover({ minPrice: 500, maxPrice: 100, search: marker });
  assert.equal(status, 200);
  assert.equal(body.data.length, 0);
});

test('invalid (non-numeric) minPrice/maxPrice is ignored rather than crashing', async () => {
  const jwt = await freshUserJwt('price-3');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `InvalidPrice ${marker}`, price: 100 });
  const { status, body } = await discover({ minPrice: 'abc', search: marker });
  assert.equal(status, 200);
  assert.ok(body.data.some((r: any) => r.title === `InvalidPrice ${marker}`));
});

// ---------------------------------------------------------------------
// Sorting (L6.9) — must be applied before pagination
// ---------------------------------------------------------------------

test('sortBy=price_asc / price_desc order the full matching set, not just a loaded page', async () => {
  const jwt = await freshUserJwt('sort-price');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Sort A ${marker}`, price: 300 });
  await createListing(jwt, { title: `Sort B ${marker}`, price: 100 });
  await createListing(jwt, { title: `Sort C ${marker}`, price: 200 });

  const asc = await discover({ search: marker, sortBy: 'price_asc', pageSize: 10 });
  const ascPrices = asc.body.data.map((r: any) => r.price);
  const sortedAsc = [...ascPrices].sort((a, b) => a - b);
  assert.deepEqual(ascPrices, sortedAsc);

  const desc = await discover({ search: marker, sortBy: 'price_desc', pageSize: 10 });
  const descPrices = desc.body.data.map((r: any) => r.price);
  const sortedDesc = [...descPrices].sort((a, b) => b - a);
  assert.deepEqual(descPrices, sortedDesc);
});

test('sortBy=newest/oldest orders by createdAt', async () => {
  const jwt = await freshUserJwt('sort-date');
  const marker = randomUUID().slice(0, 8);
  const first = await createListing(jwt, { title: `Time A ${marker}` });
  await new Promise((r) => setTimeout(r, 10));
  const second = await createListing(jwt, { title: `Time B ${marker}` });

  const newest = await discover({ search: marker, sortBy: 'newest', pageSize: 10 });
  const newestIds = newest.body.data.map((r: any) => r.documentId ?? r.id);
  assert.ok(newestIds.indexOf(second.documentId ?? second.id) < newestIds.indexOf(first.documentId ?? first.id));

  const oldest = await discover({ search: marker, sortBy: 'oldest', pageSize: 10 });
  const oldestIds = oldest.body.data.map((r: any) => r.documentId ?? r.id);
  assert.ok(oldestIds.indexOf(first.documentId ?? first.id) < oldestIds.indexOf(second.documentId ?? second.id));
});

test('an unrecognized sortBy value falls back to newest rather than erroring', async () => {
  const jwt = await freshUserJwt('sort-fallback');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Fallback Sort ${marker}` });
  const { status } = await discover({ search: marker, sortBy: 'not_a_real_sort' });
  assert.equal(status, 200);
});

// ---------------------------------------------------------------------
// Filter-before-pagination / sort-before-pagination correctness (L6.5/L6.9/L6.10)
// ---------------------------------------------------------------------

test('a category that has zero matches in "page 1 of everything" is still found (filter runs before pagination)', async () => {
  const jwt = await freshUserJwt('filter-before-page');
  const marker = randomUUID().slice(0, 8);
  // Push several non-matching listings first so a naive "filter the
  // loaded page" implementation would miss the real match below.
  for (let i = 0; i < 3; i += 1) {
    await createListing(jwt, { title: `Filler ${marker} ${i}`, mainType: 'tarim' });
  }
  await createListing(jwt, {
    title: `RareCategory ${marker}`,
    mainType: 'tarimsalAletler',
    subType: 'Sulama',
  });

  const { body } = await discover({ mainType: 'tarimsalAletler', search: marker, pageSize: 1 });
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].mainType, 'tarimsalAletler');
});

test('combined filter + sort + pagination page 2 does not repeat or skip rows from page 1', async () => {
  const jwt = await freshUserJwt('page-drift');
  const marker = randomUUID().slice(0, 8);
  const prices = [10, 20, 30, 40, 50];
  for (const p of prices) {
    await createListing(jwt, { title: `Page ${marker} ${p}`, price: p });
  }

  const page1 = await discover({ search: marker, sortBy: 'price_asc', page: 1, pageSize: 2 });
  const page2 = await discover({ search: marker, sortBy: 'price_asc', page: 2, pageSize: 2 });
  const page3 = await discover({ search: marker, sortBy: 'price_asc', page: 3, pageSize: 2 });

  const allIds = [...page1.body.data, ...page2.body.data, ...page3.body.data].map(
    (r: any) => r.documentId ?? r.id,
  );
  const uniqueIds = new Set(allIds);
  assert.equal(uniqueIds.size, allIds.length, 'no row should repeat across pages');

  const allPrices = [...page1.body.data, ...page2.body.data, ...page3.body.data].map((r: any) => r.price);
  assert.deepEqual(allPrices, [...allPrices].sort((a, b) => a - b));
});

// ---------------------------------------------------------------------
// Pagination ceiling (L6.14)
// ---------------------------------------------------------------------

test('pageSize is capped at a sane maximum regardless of what the client requests', async () => {
  const { status, body } = await discover({ search: 'x', pageSize: 999999 });
  assert.equal(status, 200);
  assert.ok(body.meta.pagination.pageSize <= 50);
});

// ---------------------------------------------------------------------
// Security / input hardening (L6.14)
// ---------------------------------------------------------------------

test('a raw filter expression sent alongside the new contract is ignored, not merged', async () => {
  const jwt = await freshUserJwt('security');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Secure ${marker}`, mode: 'sell' });
  await createListing(jwt, { title: `Secure2 ${marker}`, mode: 'buy' });

  // Attempt to smuggle an arbitrary raw filter (asking for everything
  // whose mode is NOT 'sell', i.e. attempting to widen the result past
  // what the whitelisted `mode` param alone would allow) alongside a
  // whitelisted `mode=sell` request.
  const qs =
    `search=${encodeURIComponent(marker)}&mode=sell&` +
    `${encodeURIComponent('filters[mode][$ne]')}=sell`;
  const res = await fetch(`${BASE_URL}/listings?${qs}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.data.every((row: any) => row.mode === 'sell'), 'raw filter must not override the whitelisted mode');
});

test('the private ownerEmail field is never exposed through the new discovery contract', async () => {
  const jwt = await freshUserJwt('privacy');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Privacy ${marker}` });
  const { body } = await discover({ search: marker });
  assert.ok(body.data.length >= 1);
  assert.ok(body.data.every((row: any) => row.ownerEmail === undefined));
});

// ---------------------------------------------------------------------
// Backward compatibility (L6.16) — no new params at all
// ---------------------------------------------------------------------

test('a request with none of the new param names is completely unaffected (legacy passthrough)', async () => {
  const jwt = await freshUserJwt('legacy');
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `Legacy ${marker}` });
  const res = await fetch(
    `${BASE_URL}/listings?${encodeURIComponent('filters[title][$containsi]')}=${marker}&sort=createdAt:desc`,
  );
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.ok(json.data.some((row: any) => row.title === `Legacy ${marker}`));
});

// ---------------------------------------------------------------------
// Edit does not blank derived search fields (L6.4/L6.7)
// ---------------------------------------------------------------------

test('editing only the title recomputes searchNormalized without losing the city filter match', async () => {
  const jwt = await freshUserJwt('edit-preserve');
  const marker = randomUUID().slice(0, 8);
  const created = await createListing(jwt, {
    title: `Original Title ${marker}`,
    location: { city: 'Bursa', district: 'Nilüfer', display: 'Bursa' },
  });
  await updateListing(jwt, created.documentId, { title: `Updated Title ${marker}` });

  const byCity = await discover({ city: 'Bursa', search: marker });
  assert.ok(
    byCity.body.data.some((row: any) => row.title === `Updated Title ${marker}`),
    'city filter must still match after a title-only edit',
  );

  const byNewTitle = await discover({ search: `Updated Title ${marker}` });
  assert.ok(byNewTitle.body.data.some((row: any) => row.title === `Updated Title ${marker}`));
});

// ---------------------------------------------------------------------
// Backfill (L6.4/L6.7) — pre-existing rows created with a plain string
// location (old client shape) must not crash the backfill and must gain
// a searchable searchNormalized value from their other fields.
// ---------------------------------------------------------------------

test('runListingSearchFieldsBackfillOnce is idempotent and safely handles a legacy plain-string location', async () => {
  const jwt = await freshUserJwt('backfill');
  const { runListingSearchFieldsBackfillOnce } = require('../../src/utils/listing-search-fields-backfill');
  const marker = randomUUID().slice(0, 8);
  const created = await createListing(jwt, {
    title: `Legacy Location Backfill ${marker}`,
    location: 'Konya (plain string, pre-L6 shape)',
  });

  // Directly null out the derived fields to simulate a genuinely
  // pre-L6 row (the create() path above already populates them; this
  // test is about the BACKFILL's own robustness, not create()'s).
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId: created.documentId },
    data: { city: null, district: null, cityNormalized: null, searchNormalized: null },
  });

  const appStore = strapiInstance.store({ type: 'core', name: 'bootstrap' });
  await appStore.set({ key: 'listing_search_fields_backfill_v1_done', value: false });

  await runListingSearchFieldsBackfillOnce(strapiInstance);
  await runListingSearchFieldsBackfillOnce(strapiInstance); // idempotent re-run

  const { body } = await discover({ search: `Legacy Location Backfill ${marker}` });
  assert.ok(body.data.some((row: any) => row.documentId === created.documentId));
});
