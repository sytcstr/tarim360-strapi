/**
 * LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md.
 *
 * Two things this suite proves against a real Strapi boot:
 *
 * 1. `mode` ('sell'/'buy') — already the single canonical field for
 *    listing direction throughout this codebase (ListingMode in Flutter,
 *    used by every card/detail/search/create screen already) -- L3 only
 *    hardens its backend schema type from a loose `string` to a real
 *    `enumeration`, so an invalid value is rejected at the API layer
 *    instead of silently accepted.
 * 2. `listingNo` — the user-facing "T360-XXXXX" number is now always
 *    server-generated (MAX(listingNo)+1 over published rows, backed by a
 *    real unique DB index), never client-supplied, immutable after
 *    create, and consistent across the idempotent-retry and
 *    offline-sync paths.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-type-public-number-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-type-public-number-test.db');
const PORT = 14183;
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

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

function listingPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'L3 Test Ilani',
    mainType: 'tarim',
    mode: 'sell',
    price: 100,
    location: 'Konya',
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
  return { status: res.status, body: json };
}

async function createListingWithOpId(jwt: string, operationId: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { ...listingPayload(overrides), operationId } }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function getListing(documentId: string) {
  // A plain GET with no status/publicationState resolves to the DRAFT
  // copy of this draftAndPublish content-type (confirmed live while
  // writing this suite: listingNo -- deliberately assigned ONLY to the
  // published row, see listing.ts's create() -- read back as null via a
  // bare GET). Real published-row content needs an explicit status.
  const res = await fetch(`${BASE_URL}/listings/${documentId}?status=published`);
  const json = await res.json();
  return { status: res.status, body: json };
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

// ---------------------------------------------------------------------
// Canonical listing type (mode)
// ---------------------------------------------------------------------

test('sell listing: create + read round trip', async () => {
  const user = await registerAndLogin(`l3-sell-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, { mode: 'sell' });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;
  const read = await getListing(documentId);
  assert.equal(read.body.data.mode, 'sell');
});

test('buy listing: create + read round trip', async () => {
  const user = await registerAndLogin(`l3-buy-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, { mode: 'buy' });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;
  const read = await getListing(documentId);
  assert.equal(read.body.data.mode, 'buy');
});

test('an invalid mode value is rejected, not silently accepted', async () => {
  const user = await registerAndLogin(`l3-invalid-mode-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      data: { ...listingPayload({ mode: 'rent' }), operationId: randomUUID() },
    }),
  });
  assert.equal(res.status, 400, 'an unrecognized mode value must be rejected by the enum, not stored');
});

test('listing type update: a title-only edit leaves mode unchanged; an explicit mode edit changes only mode', async () => {
  const user = await registerAndLogin(`l3-mode-update-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, { mode: 'sell', title: 'Baslangic' });
  const documentId = created.body.data.documentId;

  const titleOnly = await updateListing(user.jwt, documentId, { title: 'Guncellendi' });
  assert.equal(titleOnly.status, 200);
  const read1 = await getListing(documentId);
  assert.equal(read1.body.data.title, 'Guncellendi');
  assert.equal(read1.body.data.mode, 'sell', 'title-only update must not change mode');

  const modeChange = await updateListing(user.jwt, documentId, { mode: 'buy' });
  assert.equal(modeChange.status, 200);
  const read2 = await getListing(documentId);
  assert.equal(read2.body.data.mode, 'buy');
  assert.equal(read2.body.data.title, 'Guncellendi', 'mode update must not disturb title');
});

// ---------------------------------------------------------------------
// Public listing number — generation, uniqueness, immutability
// ---------------------------------------------------------------------

test('listingNo is generated on create: present, a positive integer', async () => {
  const user = await registerAndLogin(`l3-no-gen-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt);
  assert.equal(created.status, 201);
  const listingNo = created.body.data.listingNo;
  assert.equal(typeof listingNo, 'number');
  assert.ok(listingNo > 0, 'listingNo must be a positive integer');
});

test('listingNo is unique across many creates, no duplicates', async () => {
  const user = await registerAndLogin(`l3-no-unique-${randomUUID()}@test.local`);
  // Capped at 5: the free-tier listing quota (NORMAL_LISTING_FREE_COUNT)
  // rejects a 6th concurrent create with 403, unrelated to what this test
  // is actually proving.
  const results = await Promise.all(
    Array.from({ length: 5 }, () => createListing(user.jwt, { title: `Unique ${randomUUID()}` })),
  );
  for (const r of results) assert.equal(r.status, 201);
  const numbers = results.map((r) => r.body.data.listingNo);
  assert.equal(new Set(numbers).size, numbers.length, 'every concurrently-created listing must get a distinct listingNo');
});

test('a client-supplied listingNo on create is ignored -- the server always assigns its own', async () => {
  const user = await registerAndLogin(`l3-no-spoof-create-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      data: { ...listingPayload(), listingNo: 'T360-00001', operationId: randomUUID() },
    }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.notEqual(json.data.listingNo, 'T360-00001');
  assert.equal(typeof json.data.listingNo, 'number');
});

test('update cannot change listingNo, even for the listing\'s real owner', async () => {
  const user = await registerAndLogin(`l3-no-spoof-update-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt);
  const documentId = created.body.data.documentId;
  const originalNo = created.body.data.listingNo;

  const res = await updateListing(user.jwt, documentId, { listingNo: originalNo + 99999 });
  assert.equal(res.status, 200, 'the update itself should still succeed (only listingNo is stripped)');

  const read = await getListing(documentId);
  assert.equal(read.body.data.listingNo, originalNo, 'listingNo must never change via update');
});

test('a stranger cannot overwrite another listing\'s listingNo via PUT', async () => {
  const owner = await registerAndLogin(`l3-no-spoof-stranger-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`l3-no-spoof-stranger-attacker-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const documentId = created.body.data.documentId;
  const originalNo = created.body.data.listingNo;

  const res = await updateListing(stranger.jwt, documentId, { listingNo: 1 });
  assert.equal(res.status, 403);

  const read = await getListing(documentId);
  assert.equal(read.body.data.listingNo, originalNo);
});

test('idempotent retry (same operationId) resolves to the same listing with the SAME listingNo, not a freshly incremented one', async () => {
  const user = await registerAndLogin(`l3-no-idempotent-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `L3 Idempotent ${randomUUID()}`;

  const first = await createListingWithOpId(user.jwt, opId, { title });
  assert.equal(first.status, 201);
  const firstNo = first.body.data.listingNo;

  const retry = await createListingWithOpId(user.jwt, opId, { title });
  assert.equal(retry.status, 200, 'a duplicate submission must not return 201 again');
  assert.equal(retry.body.data.listingNo, firstNo, 'the retry must resolve to the exact same listingNo, not a new one');

  // A genuinely new create right after must still get the next number,
  // proving the idempotent retry never advanced the sequence twice.
  const next = await createListing(user.jwt, { title: `L3 Idempotent Next ${randomUUID()}` });
  assert.equal(next.status, 201);
  assert.equal(next.body.data.listingNo, firstNo + 1);
});

// ---------------------------------------------------------------------
// Offline-sync (engagement.ts syncOfflineListing)
// ---------------------------------------------------------------------

test('offline create preserves mode', async () => {
  const user = await registerAndLogin(`l3-offline-mode-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'create',
      listing: { id: `l_${Date.now()}`, ...listingPayload({ mode: 'buy' }) },
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.listing.mode, 'buy');
});

test('offline create ignores a client-supplied listingNo and assigns its own unique one', async () => {
  const user = await registerAndLogin(`l3-offline-no-spoof-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'create',
      listing: {
        id: `l_${Date.now()}`,
        listingNo: 'T360-99999',
        ...listingPayload({ title: `Offline No Spoof ${randomUUID()}` }),
      },
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.notEqual(json.data.listing.listingNo, 'T360-99999');
  assert.equal(typeof json.data.listing.listingNo, 'number');
  assert.ok(json.data.listing.listingNo > 0);
});

test('offline update cannot change an existing listing\'s listingNo', async () => {
  const user = await registerAndLogin(`l3-offline-no-update-spoof-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt);
  const listingId = created.body.data.id;
  const originalNo = created.body.data.listingNo;

  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: { id: listingId, listingNo: originalNo + 12345 },
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.listing.listingNo, originalNo);
});

// ---------------------------------------------------------------------
// Search + filter foundation
// ---------------------------------------------------------------------

test('a listing can be found by exact listingNo via the standard REST filter contract', async () => {
  const user = await registerAndLogin(`l3-search-no-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, { title: `Findable ${randomUUID()}` });
  const listingNo = created.body.data.listingNo;

  const res = await fetch(`${BASE_URL}/listings?${encodeURIComponent('filters[listingNo][$eq]')}=${listingNo}`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(Array.isArray(json.data) ? json.data.length : 0, 1);
  assert.equal(json.data[0].listingNo, listingNo);
});

test('server-side sell/buy filtering returns only the matching mode', async () => {
  const user = await registerAndLogin(`l3-filter-mode-${randomUUID()}@test.local`);
  const tag = randomUUID();
  await createListing(user.jwt, { title: `Filter Sell ${tag}`, mode: 'sell' });
  await createListing(user.jwt, { title: `Filter Buy ${tag}`, mode: 'buy' });

  const sellRes = await fetch(
    `${BASE_URL}/listings?${encodeURIComponent('filters[mode][$eq]')}=sell&${encodeURIComponent('filters[title][$containsi]')}=${tag}`,
  );
  const sellJson = await sellRes.json();
  assert.ok(Array.isArray(sellJson.data) && sellJson.data.length >= 1);
  assert.ok(sellJson.data.every((row: any) => row.mode === 'sell'));

  const buyRes = await fetch(
    `${BASE_URL}/listings?${encodeURIComponent('filters[mode][$eq]')}=buy&${encodeURIComponent('filters[title][$containsi]')}=${tag}`,
  );
  const buyJson = await buyRes.json();
  assert.ok(Array.isArray(buyJson.data) && buyJson.data.length >= 1);
  assert.ok(buyJson.data.every((row: any) => row.mode === 'buy'));
});

// ---------------------------------------------------------------------
// Backfill (L3.6) — existing pre-L3 rows must get a real, unique,
// deterministic listingNo, not crash, not be deleted/recreated.
// ---------------------------------------------------------------------

test('runListingNoBackfillOnce assigns unique sequential numbers to pre-existing rows with no listingNo, exactly once', async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runListingNoBackfillOnce } = require('../../src/utils/listing-number-backfill');
  const user = await registerAndLogin(`l3-backfill-${randomUUID()}@test.local`);

  // The real bootstrap hook already ran this once (against an empty
  // table) when Strapi booted in before() above, which flipped the
  // app-store "done" flag. Reset it here to actually exercise the
  // backfill logic against the rows this test is about to create --
  // otherwise it would just skip immediately as "already done".
  const appStore = strapiInstance.store({ type: 'core', name: 'bootstrap' });
  await appStore.set({ key: 'listing_no_backfill_v1_done', value: false });

  // Simulate 3 pre-L3 listings created with no listingNo at all (bypassing
  // the controller, which now always assigns one -- this is exactly the
  // production-data shape the backfill exists to fix).
  const titles = [`Backfill A ${randomUUID()}`, `Backfill B ${randomUUID()}`, `Backfill C ${randomUUID()}`];
  const created: any[] = [];
  for (const title of titles) {
    const row = await strapiInstance.entityService.create('api::listing.listing', {
      data: {
        title,
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        ownerProfileId: user.ownerId,
        ownerId: user.ownerId,
        ownerEmail: user.email,
        status: 'active',
        publishedAt: new Date().toISOString(),
      },
    });
    created.push(row);
    // Small delay so createdAt ordering (the backfill's sort key) is
    // deterministic even on a fast local disk.
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (const row of created) {
    assert.equal(row.listingNo, null, 'sanity check: these rows start with no listingNo, like real pre-L3 data');
  }

  await runListingNoBackfillOnce(strapiInstance);

  const refreshed = await Promise.all(
    created.map((row) =>
      strapiInstance.db.query('api::listing.listing').findOne({ where: { documentId: row.documentId } } as any),
    ),
  );
  const numbers = refreshed.map((r: any) => r.listingNo);
  assert.ok(numbers.every((n: number) => Number.isInteger(n) && n > 0), 'every backfilled row must get a real positive integer');
  assert.equal(new Set(numbers).size, numbers.length, 'backfilled numbers must be unique');
  // Chronological order (oldest first) must be preserved in the assigned sequence.
  assert.ok(numbers[0] < numbers[1] && numbers[1] < numbers[2]);

  // Idempotency: running it again must be a no-op (the app-store flag
  // short-circuits it), so re-running must not reassign/shuffle numbers.
  await runListingNoBackfillOnce(strapiInstance);
  const refreshedAgain = await Promise.all(
    created.map((row) =>
      strapiInstance.db.query('api::listing.listing').findOne({ where: { documentId: row.documentId } } as any),
    ),
  );
  assert.deepEqual(
    refreshedAgain.map((r: any) => r.listingNo),
    numbers,
    'a second run must not reassign any already-backfilled listingNo',
  );
});

test('a pre-existing listing with no listingNo still reads normally (no crash) before backfill runs', async () => {
  const user = await registerAndLogin(`l3-legacy-read-${randomUUID()}@test.local`);
  const row = await strapiInstance.entityService.create('api::listing.listing', {
    data: {
      title: 'Legacy Listing No listingNo',
      mainType: 'tarim',
      mode: 'sell',
      price: 50,
      ownerProfileId: user.ownerId,
      ownerId: user.ownerId,
      ownerEmail: user.email,
      status: 'active',
      publishedAt: new Date().toISOString(),
    },
  });
  const read = await getListing(row.documentId);
  assert.equal(read.status, 200);
});
