/**
 * LISTING_AZ_REVALIDATION_PART5_81_100.md Madde 90 (P1).
 *
 * listing-create-idempotency.integration.test.ts's own offline-sync
 * coverage builds BOTH the direct-path payload and the offline-sync
 * `listing` body from the same synthetic `listingPayload()` helper
 * (title/mainType/mode/price/location only) -- which trivially matches
 * itself and never exercises the REAL shape mismatch that caused the
 * bug: Flutter's actual offline-queue row (ListingPendingSyncQueue.
 * enqueue, lib/features/listings/stores/listings_store.dart) never
 * carried these fields under these names at all (only a display-
 * formatted `priceText`/`city`, plus several fields -- `operation`,
 * `category`, `localImagePath`/`localPhotoPaths`/`photoUrls`,
 * `createdAt`, `queuedAt`, `attrs` -- the direct POST /listings payload
 * (_buildPayload) never sends under ANY name). A genuine "online create
 * timed out, retried via the offline queue with the same operationId"
 * scenario therefore ALWAYS fingerprint-mismatched in production, even
 * though this file's own existing test suite passed.
 *
 * This suite instead builds the offline-sync `listing` body using the
 * REAL Flutter row shape (mirroring enqueue()'s exact keys, including
 * the fix's new price/priceUnit/location fields -- see
 * create_listing_page.dart's _offlineSyncContentFields), to prove cross-
 * path parity actually holds for the real payload shapes, not a
 * synthetic stand-in.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-offline-sync-fingerprint-parity-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-offline-sync-fingerprint-parity-test.db');
const PORT = 14193;
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

async function registerAndLogin(email: string): Promise<{ jwt: string; email: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return { jwt: json.jwt, email: email.trim().toLowerCase() };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

// The exact shape `create_listing_page.dart`'s `_buildPayload` sends on
// the direct POST /listings path.
function directPayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'sell',
    mainType: 'tarim',
    subType: null,
    title: 'Madde90 Parity Ilani',
    description: 'Parity test aciklamasi',
    price: 250,
    priceUnit: 'kg',
    demandAmount: null,
    maxBudget: null,
    hasatYear: 2026,
    hasatDate: null,
    qualityGrade: 'A',
    moisture: null,
    protein: null,
    certificateType: null,
    analysisNote: null,
    packaging: null,
    storage: null,
    delivery: null,
    minOrder: null,
    minOrderUnit: null,
    animalAge: null,
    animalWeight: null,
    equipCondition: null,
    equipWorkHour: null,
    equipModelYear: null,
    location: { city: 'Konya', district: 'Selcuklu', display: 'Konya / Selcuklu' },
    // _buildPayload always sends these two alongside ownerEmail/
    // ownerProfileId/ownerId -- unlike those three (excluded from the
    // fingerprint on both paths because they're always server-forced),
    // ownerName/ownerCity are NOT excluded on either side and are
    // genuinely part of what must match for cross-path parity.
    ownerName: 'Test Ciftci',
    ownerCity: 'Konya',
    createdAtClient: new Date().toISOString(),
    ...overrides,
  };
}

async function createDirect(jwt: string, operationId: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { ...directPayload(overrides), operationId } }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// The exact shape ListingPendingSyncQueue.enqueue() persists and sends
// as `listing` to POST /offline-sync/listings, AFTER the Madde 90 fix
// (price/priceUnit/location merged in via _offlineSyncContentFields).
// Content values deliberately match directPayload()'s defaults above so
// a same-operationId cross-path retry is a genuinely identical resubmit.
function offlineQueueRow(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'create',
    id: `l_${Date.now()}_${randomUUID()}`,
    title: 'Madde90 Parity Ilani',
    category: 'Tarım',
    priceText: '250 TL/kg',
    city: 'Konya',
    mainType: 'tarim',
    subType: null,
    mode: 'sell',
    localImagePath: '/data/user/0/cache/img123.jpg',
    localPhotoPaths: ['/data/user/0/cache/img123.jpg'],
    photoUrls: [],
    description: 'Parity test aciklamasi',
    attrs: { 'Hasat Yili': '2026', Kalite: 'A' },
    createdAt: new Date().toISOString(),
    ownerName: 'Test Ciftci',
    ownerCity: 'Konya',
    hasatYear: 2026,
    hasatDate: null,
    qualityGrade: 'A',
    moisture: null,
    protein: null,
    certificateType: null,
    analysisNote: null,
    packaging: null,
    storage: null,
    delivery: null,
    minOrder: null,
    minOrderUnit: null,
    animalAge: null,
    animalWeight: null,
    equipCondition: null,
    equipWorkHour: null,
    equipModelYear: null,
    queuedAt: new Date().toISOString(),
    // Madde 90 fix: real content fields _offlineSyncContentFields adds,
    // matching directPayload()'s price/priceUnit/location exactly for a
    // genuinely-unchanged resubmission.
    price: 250,
    priceUnit: 'kg',
    demandAmount: null,
    maxBudget: null,
    location: { city: 'Konya', district: 'Selcuklu', display: 'Konya / Selcuklu' },
    ...overrides,
  };
}

async function syncOffline(jwt: string, operationId: string, listingOverrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        operation: 'create',
        listing: { ...offlineQueueRow(listingOverrides), operationId },
      },
    }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function countListingsByTitle(title: string): Promise<number> {
  const rows = await strapiInstance.db.query('api::listing.listing').findMany({
    where: { title, publishedAt: { $notNull: true } },
  } as any);
  return Array.isArray(rows) ? rows.length : 0;
}

test('direct create lost-response -> offline-sync retry with the SAME operationId (real Flutter row shape) resolves to the SAME listing, no duplicate', async () => {
  const user = await registerAndLogin(`m90-direct-then-offline-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `M90 Direct-Then-Offline ${randomUUID()}`;

  const first = await createDirect(user.jwt, opId, { title });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const realId = first.body.data.documentId ?? first.body.data.id;

  const retry = await syncOffline(user.jwt, opId, { title });
  assert.equal(retry.status, 200, `expected idempotent 200, got ${retry.status}: ${JSON.stringify(retry.body)}`);
  assert.equal(retry.body.data.idempotent, true, 'must be recognized as the already-created listing');
  const retryId = retry.body.data.listing?.documentId ?? retry.body.data.listing?.id;
  assert.equal(retryId, realId);
  assert.equal(await countListingsByTitle(title), 1, 'no duplicate listing may exist');
});

test('offline-sync create lost-response -> direct retry with the SAME operationId resolves to the SAME listing, no duplicate', async () => {
  const user = await registerAndLogin(`m90-offline-then-direct-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `M90 Offline-Then-Direct ${randomUUID()}`;

  // The offline-sync endpoint is a custom controller, not a stock-CRUD
  // route -- it always returns 200 (never Strapi's auto-201), for both a
  // fresh create and an idempotent-duplicate resolution; `idempotent` is
  // the actual signal, confirmed absent/falsy on a genuine first create.
  const first = await syncOffline(user.jwt, opId, { title });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(!first.body.data.idempotent, 'the first-ever attempt must not be reported as idempotent');
  const realId = first.body.data.listing?.documentId ?? first.body.data.listing?.id;

  const retry = await createDirect(user.jwt, opId, { title });
  assert.equal(retry.status, 200, `expected idempotent 200, got ${retry.status}: ${JSON.stringify(retry.body)}`);
  const retryId = retry.body.data.documentId ?? retry.body.data.id;
  assert.equal(retryId, realId);
  assert.equal(await countListingsByTitle(title), 1, 'no duplicate listing may exist');
});

test('a createdAt/queuedAt/operation/category/priceText/attrs difference ALONE does not cause a conflict', async () => {
  const user = await registerAndLogin(`m90-volatile-fields-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `M90 Volatile Fields ${randomUUID()}`;

  const first = await createDirect(user.jwt, opId, { title });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const realId = first.body.data.documentId ?? first.body.data.id;

  // Every one of these differs from what a byte-identical resubmission
  // would produce (different wall-clock timestamps, a differently-cased
  // category label, a differently-formatted price string, a reordered
  // attrs map) -- none of it is real listing content.
  const retry = await syncOffline(user.jwt, opId, {
    title,
    createdAt: new Date(Date.now() + 60_000).toISOString(),
    queuedAt: new Date(Date.now() + 120_000).toISOString(),
    category: 'TARIM',
    priceText: '250,00 TL / kg',
    attrs: { Kalite: 'A', 'Hasat Yili': '2026' },
    localImagePath: '/data/user/0/cache/DIFFERENT.jpg',
  });
  assert.equal(retry.status, 200, `expected idempotent 200, got ${retry.status}: ${JSON.stringify(retry.body)}`);
  assert.equal(retry.body.data.idempotent, true);
  const retryId = retry.body.data.listing?.documentId ?? retry.body.data.listing?.id;
  assert.equal(retryId, realId);
  assert.equal(await countListingsByTitle(title), 1);
});

test('an owner-derived-fields difference ALONE does not cause a conflict', async () => {
  const user = await registerAndLogin(`m90-owner-fields-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `M90 Owner Fields ${randomUUID()}`;

  const first = await createDirect(user.jwt, opId, { title });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const realId = first.body.data.documentId ?? first.body.data.id;

  // ownerEmail/ownerProfileId/ownerId (the real identity fields, unlike
  // the display-only ownerName/ownerCity, which ARE genuinely compared --
  // see LISTING_AZ_REVALIDATION_PART5_81_100.md Madde 98's own separate
  // finding on that) are always force-set from the caller's own JWT
  // identity server-side on both paths regardless of what the client
  // sends -- a client-side echo mismatch on these three specifically
  // must never affect the fingerprint.
  const retry = await syncOffline(user.jwt, opId, {
    title,
    ownerEmail: 'someone-completely-different@test.local',
    ownerProfileId: 'u_someone_completely_different',
    ownerId: 'u_someone_completely_different',
  });
  assert.equal(retry.status, 200, `expected idempotent 200, got ${retry.status}: ${JSON.stringify(retry.body)}`);
  const retryId = retry.body.data.listing?.documentId ?? retry.body.data.listing?.id;
  assert.equal(retryId, realId);
  assert.equal(await countListingsByTitle(title), 1);
});

test('a genuine price change on the SAME operationId still conflicts (conflict detection not weakened)', async () => {
  const user = await registerAndLogin(`m90-price-conflict-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `M90 Price Conflict ${randomUUID()}`;

  const first = await createDirect(user.jwt, opId, { title });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const retry = await syncOffline(user.jwt, opId, { title, price: 999 });
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(await countListingsByTitle(title), 1);
});

test('a genuine title change on the SAME operationId still conflicts', async () => {
  const user = await registerAndLogin(`m90-title-conflict-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `M90 Title Conflict ${randomUUID()}`;

  const first = await createDirect(user.jwt, opId, { title });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const retry = await syncOffline(user.jwt, opId, { title: `${title} DEGISTI` });
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
});

test('a genuine mainType (category) change on the SAME operationId still conflicts', async () => {
  const user = await registerAndLogin(`m90-category-conflict-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `M90 Category Conflict ${randomUUID()}`;

  const first = await createDirect(user.jwt, opId, { title });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  // mainType itself changes (not just its redundant `category` display
  // label) -- must still conflict even though `category` is excluded
  // from the fingerprint.
  const retry = await syncOffline(user.jwt, opId, { title, mainType: 'hayvancilik' });
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
});

test('a genuinely different operationId with identical content still creates a separate listing', async () => {
  const user = await registerAndLogin(`m90-fresh-opid-${randomUUID()}@test.local`);
  const title = `M90 Fresh OpId ${randomUUID()}`;

  const first = await createDirect(user.jwt, randomUUID(), { title });
  assert.equal(first.status, 201);
  const second = await syncOffline(user.jwt, randomUUID(), { title });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.ok(!second.body.data.idempotent, 'a fresh operationId must never be reported as idempotent');

  assert.equal(await countListingsByTitle(title), 2, 'two genuinely separate submissions must be two real listings');
});
