/**
 * LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 34 (P0).
 *
 * `listing.ts`'s `find()` whitelist path (buildListingDiscoveryQuery)
 * already forced `status:active`, but ONLY when the request used one of
 * the whitelisted param names (search/mainType/mode/etc). If a caller
 * sent NONE of those -- including RAW Strapi filter syntax like
 * `?filters[status][$eq]=pending`, which uses a DIFFERENT top-level
 * `filters` key the whitelist never inspected -- `ctx.query` was passed
 * through to `super.find(ctx)` completely untouched, with zero status
 * restriction. `api::listing.listing.find` is granted to Strapi's
 * PUBLIC role, so no authentication was even required: any anonymous
 * caller could enumerate every pending/rejected listing's full content
 * this way. This suite proves that's closed -- public/anonymous raw
 * filters can never see non-active listings, in any shape -- while the
 * one legitimate raw-filter caller (an authenticated owner viewing
 * their OWN listings via `filters[ownerProfileId][$eq]=<their own id>`,
 * Flutter's `fetchListingsForOwner` / "İlanlarım") keeps working, and
 * normal active search/filter/pagination via the whitelisted params is
 * unaffected.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-public-discovery-raw-filter-bypass-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-public-discovery-raw-filter-bypass-test.db');
const PORT = 14197;
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

async function registerAndLogin(email: string): Promise<{ jwt: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return { jwt: json.jwt };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: `Madde34 Test Ilani ${randomUUID()}`,
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        location: { city: 'Konya' },
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  if (res.status >= 400) {
    throw new Error(`createListing failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
}

const setListingStatus = (documentId: string, status: string) =>
  strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId },
    data: { status },
  });

async function rawFind(jwt: string | null, query: string) {
  const res = await fetch(`${BASE_URL}/listings${query}`, {
    method: 'GET',
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const titlesIn = (body: any): string[] =>
  Array.isArray(body?.data) ? body.data.map((row: any) => row.title) : [];

// ---------------------------------------------------------------------
// The actual exploit shape: an anonymous caller, raw filter syntax.
// ---------------------------------------------------------------------

test('anonymous raw filters[status][$eq]=pending cannot see a pending listing', async () => {
  const seller = await registerAndLogin(`m34-anon-pending-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt);
  await setListingStatus(listing.documentId, 'pending');

  const { status, body } = await rawFind(null, '?filters[status][$eq]=pending');
  assert.equal(status, 200);
  assert.ok(!titlesIn(body).includes(listing.title), 'the pending listing must never appear');
});

test('anonymous raw filters[status][$ne]=active cannot see a rejected listing', async () => {
  const seller = await registerAndLogin(`m34-anon-rejected-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt);
  await setListingStatus(listing.documentId, 'rejected');

  const { status, body } = await rawFind(null, '?filters[status][$ne]=active');
  assert.equal(status, 200);
  assert.ok(!titlesIn(body).includes(listing.title), 'the rejected listing must never appear');
});

test('a bare GET /listings with no query params at all never returns a pending listing', async () => {
  const seller = await registerAndLogin(`m34-anon-bare-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt);
  await setListingStatus(listing.documentId, 'pending');

  const { status, body } = await rawFind(null, '');
  assert.equal(status, 200);
  assert.ok(!titlesIn(body).includes(listing.title));
});

test('an authenticated but UNRELATED user cannot use a raw ownerProfileId filter to see a stranger\'s pending listing', async () => {
  const seller = await registerAndLogin(`m34-stranger-seller-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`m34-stranger-viewer-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt);
  await setListingStatus(listing.documentId, 'pending');

  const { status, body } = await rawFind(
    stranger.jwt,
    `?filters[ownerProfileId][$eq]=${encodeURIComponent(listing.ownerProfileId)}`,
  );
  assert.equal(status, 200);
  assert.ok(
    !titlesIn(body).includes(listing.title),
    'a stranger claiming the seller\'s own ownerProfileId filter must not see their pending listing',
  );
});

// ---------------------------------------------------------------------
// The one legitimate raw-filter caller must keep working.
// ---------------------------------------------------------------------

test('the real owner CAN see their own pending listing via the raw ownerProfileId filter (İlanlarım/fetchListingsForOwner)', async () => {
  const seller = await registerAndLogin(`m34-owner-pending-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt);
  await setListingStatus(listing.documentId, 'pending');

  const { status, body } = await rawFind(
    seller.jwt,
    `?filters[ownerProfileId][$eq]=${encodeURIComponent(listing.ownerProfileId)}`,
  );
  assert.equal(status, 200);
  assert.ok(titlesIn(body).includes(listing.title), 'the real owner must still see their own pending listing');
});

test('the real owner CAN see their own active listing via the legacy ownerId raw filter', async () => {
  const seller = await registerAndLogin(`m34-owner-ownerid-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt);

  const { status, body } = await rawFind(
    seller.jwt,
    `?filters[ownerId][$eq]=${encodeURIComponent(listing.ownerId)}`,
  );
  assert.equal(status, 200);
  assert.ok(titlesIn(body).includes(listing.title));
});

test('even the real owner\'s own-listings query is rebuilt server-side, not trusted verbatim -- a smuggled $or cannot ride along', async () => {
  const seller = await registerAndLogin(`m34-owner-smuggle-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`m34-owner-smuggle-stranger-${randomUUID()}@test.local`);
  const ownListing = await createListing(seller.jwt);
  const strangerListing = await createListing(stranger.jwt);
  await setListingStatus(strangerListing.documentId, 'pending');

  // A verified ownerProfileId match for `seller` combined with a
  // smuggled $or trying to also pull in the stranger's pending listing.
  const query =
    `?filters[ownerProfileId][$eq]=${encodeURIComponent(ownListing.ownerProfileId)}` +
    `&filters[$or][0][status][$eq]=pending`;
  const { status, body } = await rawFind(seller.jwt, query);
  assert.equal(status, 200);
  const titles = titlesIn(body);
  assert.ok(titles.includes(ownListing.title), 'the real owner still sees their own listing');
  assert.ok(!titles.includes(strangerListing.title), 'the smuggled $or must not leak the stranger\'s pending listing');
});

// ---------------------------------------------------------------------
// Regression: normal active discovery via the whitelisted params still
// works exactly as before.
// ---------------------------------------------------------------------

test('regression: whitelisted discovery params (search) still find an active listing publicly', async () => {
  const seller = await registerAndLogin(`m34-regress-search-${randomUUID()}@test.local`);
  const uniqueTitle = `Madde34RegressionSearch${randomUUID().replace(/-/g, '')}`;
  const listing = await createListing(seller.jwt, { title: uniqueTitle });

  const { status, body } = await rawFind(null, `?search=${encodeURIComponent(uniqueTitle)}`);
  assert.equal(status, 200);
  assert.ok(titlesIn(body).includes(listing.title));
});

test('regression: whitelisted discovery params never return a pending listing even by exact search match', async () => {
  const seller = await registerAndLogin(`m34-regress-search-pending-${randomUUID()}@test.local`);
  const uniqueTitle = `Madde34RegressionPending${randomUUID().replace(/-/g, '')}`;
  const listing = await createListing(seller.jwt, { title: uniqueTitle });
  await setListingStatus(listing.documentId, 'pending');

  const { status, body } = await rawFind(null, `?search=${encodeURIComponent(uniqueTitle)}`);
  assert.equal(status, 200);
  assert.ok(!titlesIn(body).includes(listing.title));
});
