/**
 * LISTING_L19_MARKETPLACE_PRODUCT_GAP_FOUNDATIONS_REPORT.md.
 *
 * Part A (Seller's Other Listings) + the batch-hydration slice of Part C
 * (Recently Viewed) both extend the SAME whitelisted discovery contract
 * (listing-query.ts's buildListingDiscoveryQuery) rather than opening new
 * endpoints: `ownerProfileId` + `excludeListingNo` for A, `listingNos`
 * (comma-separated or repeated array param) for C's bounded batch
 * rehydration. This proves both new params are genuinely public-only,
 * exclude what they should, and never leak the one private field
 * (`ownerEmail`) -- since this path still runs through `super.find(ctx)`
 * (the standard entityService pipeline), Strapi's own private-field
 * stripping should already apply here (unlike the popular/similar paths,
 * which use raw db.query and must strip by hand).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-seller-other-batch-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-seller-other-batch-test.db');
const PORT = 14192;
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
        title: 'L19 Seller Other Test Ilani',
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        location: { city: 'Konya', display: 'Konya' },
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

/** Same precedent as listing-lifecycle.integration.test.ts's forceStatus:
 * the only way any real row ends up pending/rejected in this codebase. */
async function forceStatus(documentId: string, status: 'pending' | 'active' | 'rejected') {
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId },
    data: { status },
  });
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
// Part A: Seller's Other Listings (ownerProfileId + excludeListingNo)
// ---------------------------------------------------------------------

test('L19.3/L19.4: same seller, multiple active listings all come back for ownerProfileId', async () => {
  const { jwt } = await registerAndLogin(`l19-seller-a-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const a = await createListing(jwt, { title: `L19 Seller A ${marker}` });
  const b = await createListing(jwt, { title: `L19 Seller B ${marker}` });

  const { status, body } = await discover({ ownerProfileId: a.ownerProfileId });
  assert.equal(status, 200);
  const titles = body.data.map((r: any) => r.title);
  assert.ok(titles.includes(a.title));
  assert.ok(titles.includes(b.title));
});

test('L19.5: excludeListingNo removes the currently-viewed listing from its own seller\'s other-listings result', async () => {
  const { jwt } = await registerAndLogin(`l19-seller-exclude-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const current = await createListing(jwt, { title: `L19 Current ${marker}` });
  const other = await createListing(jwt, { title: `L19 Other ${marker}` });

  const { status, body } = await discover({
    ownerProfileId: current.ownerProfileId,
    excludeListingNo: current.listingNo,
  });
  assert.equal(status, 200);
  const titles = body.data.map((r: any) => r.title);
  assert.ok(!titles.includes(current.title), 'current listing must be excluded');
  assert.ok(titles.includes(other.title), 'the seller\'s other listing must still be present');
});

test('L19.4: a pending listing never appears in another user\'s seller-other-listings view', async () => {
  const { jwt } = await registerAndLogin(`l19-seller-pending-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const active = await createListing(jwt, { title: `L19 Active ${marker}` });
  const pending = await createListing(jwt, { title: `L19 Pending ${marker}` });
  await forceStatus(pending.documentId, 'pending');

  const { body } = await discover({ ownerProfileId: active.ownerProfileId });
  const titles = body.data.map((r: any) => r.title);
  assert.ok(titles.includes(active.title));
  assert.ok(!titles.includes(pending.title));
});

test('L19.4: a rejected listing never appears in another user\'s seller-other-listings view', async () => {
  const { jwt } = await registerAndLogin(`l19-seller-rejected-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const active = await createListing(jwt, { title: `L19 Active2 ${marker}` });
  const rejected = await createListing(jwt, { title: `L19 Rejected ${marker}` });
  await forceStatus(rejected.documentId, 'rejected');

  const { body } = await discover({ ownerProfileId: active.ownerProfileId });
  const titles = body.data.map((r: any) => r.title);
  assert.ok(titles.includes(active.title));
  assert.ok(!titles.includes(rejected.title));
});

test('L19.3: a different seller\'s listings never leak into this seller\'s other-listings result', async () => {
  const sellerA = await registerAndLogin(`l19-seller-x-${randomUUID()}@test.local`);
  const sellerB = await registerAndLogin(`l19-seller-y-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const aListing = await createListing(sellerA.jwt, { title: `L19 SellerX ${marker}` });
  const bListing = await createListing(sellerB.jwt, { title: `L19 SellerY ${marker}` });

  const { body } = await discover({ ownerProfileId: aListing.ownerProfileId });
  const titles = body.data.map((r: any) => r.title);
  assert.ok(titles.includes(aListing.title));
  assert.ok(!titles.includes(bListing.title));
});

test('L19.6: seller-other-listings is paginated, not returned as one unbounded page', async () => {
  const { jwt } = await registerAndLogin(`l19-seller-paginated-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const created: any[] = [];
  for (let i = 0; i < 3; i += 1) {
    created.push(await createListing(jwt, { title: `L19 Page ${marker} ${i}` }));
  }
  const { status, body } = await discover({
    ownerProfileId: created[0].ownerProfileId,
    pageSize: 2,
    page: 1,
  });
  assert.equal(status, 200);
  assert.equal(body.data.length, 2);
  assert.ok(body.meta.pagination.total >= 3);
});

test('L19.7: seller-other-listings ordering is stable across repeated identical requests', async () => {
  const { jwt } = await registerAndLogin(`l19-seller-stable-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  await createListing(jwt, { title: `L19 Stable A ${marker}` });
  await createListing(jwt, { title: `L19 Stable B ${marker}` });
  const owner = (await createListing(jwt, { title: `L19 Stable C ${marker}` })).ownerProfileId;

  const first = await discover({ ownerProfileId: owner, sortBy: 'newest' });
  const second = await discover({ ownerProfileId: owner, sortBy: 'newest' });
  assert.deepEqual(
    first.body.data.map((r: any) => r.listingNo),
    second.body.data.map((r: any) => r.listingNo),
  );
});

test('L19.45: seller-other-listings never leaks the private ownerEmail field', async () => {
  const { jwt } = await registerAndLogin(`l19-seller-privacy-${randomUUID()}@test.local`);
  const listing = await createListing(jwt, { title: `L19 Privacy ${randomUUID().slice(0, 8)}` });
  const { body } = await discover({ ownerProfileId: listing.ownerProfileId });
  assert.ok(body.data.length > 0);
  for (const row of body.data) {
    assert.equal(row.ownerEmail, undefined);
  }
});

// ---------------------------------------------------------------------
// Part C (batch slice): Recently Viewed hydration via listingNos
// ---------------------------------------------------------------------

test('L19.21/L19.37: listingNos batch-hydrates several listings in one request, in no more than one round trip', async () => {
  const { jwt } = await registerAndLogin(`l19-batch-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const a = await createListing(jwt, { title: `L19 Batch A ${marker}` });
  const b = await createListing(jwt, { title: `L19 Batch B ${marker}` });
  const c = await createListing(jwt, { title: `L19 Batch C ${marker}` });

  const { status, body } = await discover({
    listingNos: `${a.listingNo},${b.listingNo},${c.listingNo}`,
    pageSize: 50,
  });
  assert.equal(status, 200);
  const titles = body.data.map((r: any) => r.title);
  assert.ok(titles.includes(a.title));
  assert.ok(titles.includes(b.title));
  assert.ok(titles.includes(c.title));
  assert.equal(body.data.length, 3);
});

test('L19.26: listingNos gracefully prunes a deleted/nonexistent id instead of erroring', async () => {
  const { jwt } = await registerAndLogin(`l19-batch-prune-${randomUUID()}@test.local`);
  const real = await createListing(jwt, { title: `L19 Batch Prune ${randomUUID().slice(0, 8)}` });
  const fakeListingNo = 999999999;

  const { status, body } = await discover({
    listingNos: `${real.listingNo},${fakeListingNo}`,
  });
  assert.equal(status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].listingNo, real.listingNo);
});

test('L19.26: listingNos silently excludes a pending listing from the batch (no crash, just pruned)', async () => {
  const { jwt } = await registerAndLogin(`l19-batch-pending-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const active = await createListing(jwt, { title: `L19 Batch Active ${marker}` });
  const pending = await createListing(jwt, { title: `L19 Batch Pending ${marker}` });
  await forceStatus(pending.documentId, 'pending');

  const { body } = await discover({
    listingNos: `${active.listingNo},${pending.listingNo}`,
  });
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].listingNo, active.listingNo);
});
