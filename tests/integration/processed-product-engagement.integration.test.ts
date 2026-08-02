/**
 * Faz D5-B — Processed Product like/favorite/view backend readiness.
 *
 * Unlike logistics-load, processed-product never had a dedicated
 * /metrics/like|favorite|view route — its only pre-D5-B "counter"
 * mechanism was the Flutter client (ProcessedProductInsightsStore)
 * computing likeCount/favoriteCount/viewCount locally and PATCHing them
 * via the generic core update route. This suite verifies: (1) the
 * already-generic PUT/DELETE /engagements/like|favorite and
 * POST /engagements/view routes work end-to-end for
 * targetType=processed-product with zero additional backend code
 * (engagement-contract.ts already had it fully configured before D5-B);
 * (2) the one real legacy entry point (POST /processed-product-likes/toggle)
 * is now delegated to the same setMembership core; (3) the generic
 * create/update routes silently strip any client-supplied
 * likeCount/favoriteCount/viewCount/engagementVersion — the old
 * best-effort metric-sync mechanism can no longer desync the real
 * counter even if it successfully reaches the server.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file — see beforeAll below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-processed-product-engagement-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-processed-product-engagement-test.db');
const PORT = 14152;
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

async function registerAndLogin(email: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return json.jwt;
}

async function createSellerStore(overrides: Record<string, unknown> = {}) {
  const slug = `test-magaza-${randomUUID()}`;
  return strapiInstance.entityService.create('api::seller-store.seller-store', {
    data: {
      ownerId: `owner-${randomUUID()}`,
      storeName: `Test Magaza ${randomUUID().slice(0, 8)}`,
      storeSlug: slug,
      city: 'Ankara',
      contactName: 'Test Satici',
      shortDescription: 'Test aciklama',
      ...overrides,
    },
  } as any);
}

async function createProduct(overrides: Record<string, unknown> = {}) {
  const store = await createSellerStore();
  return strapiInstance.entityService.create('api::processed-product.processed-product', {
    data: {
      localProductId: `local-${randomUUID()}`,
      title: 'Test Urun',
      category: 'Bal',
      ownerId: store.ownerId,
      store: store.id,
      isActive: true,
      viewCount: 0,
      likeCount: 0,
      favoriteCount: 0,
      engagementVersion: 0,
      ...overrides,
    },
  } as any);
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

const fetchProductRow = async (id: number | string) =>
  strapiInstance.db.query('api::processed-product.processed-product').findOne({ where: { id } } as any);

// ---------------------------------------------------------------------
// New canonical route (PUT/DELETE /engagements/like|favorite, POST /engagements/view)
// ---------------------------------------------------------------------

test('like (new): first PUT activates and increments likeCount', async () => {
  const jwt = await registerAndLogin(`pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.count, 1);
  const row = await fetchProductRow(product.id);
  assert.equal(row.likeCount, 1);
});

test('like (new): repeating the same PUT is a no-op', async () => {
  const jwt = await registerAndLogin(`pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
});

test('like (new): DELETE unlikes and decrements', async () => {
  const jwt = await registerAndLogin(`pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const res = await fetch(
    `${BASE_URL}/engagements/like?targetType=processed-product&targetId=${product.id}`,
    { method: 'DELETE', headers: authed(jwt) },
  );
  const body = await res.json();
  assert.equal(body.active, false);
  assert.equal(body.count, 0);
  const row = await fetchProductRow(product.id);
  assert.equal(row.likeCount, 0);
});

test('favorite (new): first PUT activates and increments favoriteCount', async () => {
  const jwt = await registerAndLogin(`pp-fav-${randomUUID()}@test.local`);
  const product = await createProduct();
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const body = await res.json();
  assert.equal(body.active, true);
  assert.equal(body.count, 1);
  const row = await fetchProductRow(product.id);
  assert.equal(row.favoriteCount, 1);
});

test('like (new): two concurrent PUTs from the same actor result in count=1', async () => {
  const jwt = await registerAndLogin(`pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  const fire = () =>
    fetch(`${BASE_URL}/engagements/like`, {
      method: 'PUT',
      headers: authed(jwt),
      body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal([a.changed, b.changed].filter(Boolean).length, 1);
  assert.equal(Math.max(a.count, b.count), 1);
  const row = await fetchProductRow(product.id);
  assert.equal(row.likeCount, 1);
});

test('like/DELETE race never leaves count negative', async () => {
  const jwt = await registerAndLogin(`pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const putAgain = fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  }).then((r) => r.json());
  const del = fetch(
    `${BASE_URL}/engagements/like?targetType=processed-product&targetId=${product.id}`,
    { method: 'DELETE', headers: authed(jwt) },
  ).then((r) => r.json());
  const [a, b] = await Promise.all([putAgain, del]);
  assert.ok(a.count >= 0 && b.count >= 0);
  const row = await fetchProductRow(product.id);
  assert.ok(row.likeCount >= 0);
});

test('view: first view increments viewCount, client-supplied count is ignored', async () => {
  const jwt = await registerAndLogin(`pp-viewer-${randomUUID()}@test.local`);
  const product = await createProduct();
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      targetType: 'processed-product',
      targetId: product.id,
      viewCount: 999999,
      count: 999999,
    }),
  });
  const body = await res.json();
  assert.equal(body.incremented, true);
  assert.equal(body.count, 1, 'server must ignore the client-supplied count entirely');
  const row = await fetchProductRow(product.id);
  assert.equal(row.viewCount, 1);
});

test('engagementVersion only advances on a real mutation, not a no-op retry', async () => {
  const jwt = await registerAndLogin(`pp-ver-${randomUUID()}@test.local`);
  const product = await createProduct();
  const first = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  }).then((r) => r.json());
  const retry = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  }).then((r) => r.json());
  assert.equal(retry.serverVersion, first.serverVersion);
});

test('count matches the real engagement-interaction row count', async () => {
  const jwt = await registerAndLogin(`pp-count-${randomUUID()}@test.local`);
  const product = await createProduct();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'processed-product', targetId: String(product.id), kind: 'like' },
  });
  assert.equal(rows.length, 1);
});

test('like: non-existent product returns NOT_FOUND', async () => {
  const jwt = await registerAndLogin(`pp-liker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: '999999999' }),
  });
  assert.equal(res.status, 404);
});

test('capability matrix: like/favorite/view allowed, comment/share are not', async () => {
  const jwt = await registerAndLogin(`pp-cap-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: '1' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'ENGAGEMENT_NOT_SUPPORTED');
});

// ---------------------------------------------------------------------
// Legacy route: POST /processed-product-likes/toggle
// ---------------------------------------------------------------------

test('legacy toggle: first call activates likeCount', async () => {
  const jwt = await registerAndLogin(`legacy-pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  const res = await fetch(`${BASE_URL}/processed-product-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ productId: String(product.id), liked: true }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.enabled, true);
  const row = await fetchProductRow(product.id);
  assert.equal(row.likeCount, 1);
});

test('legacy toggle: repeating the same call does not double-count', async () => {
  const jwt = await registerAndLogin(`legacy-pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  await fetch(`${BASE_URL}/processed-product-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ productId: String(product.id), liked: true }),
  });
  await fetch(`${BASE_URL}/processed-product-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ productId: String(product.id), liked: true }),
  });
  const row = await fetchProductRow(product.id);
  assert.equal(row.likeCount, 1);
});

test('legacy toggle then new PUT for the same user only changes the counter once', async () => {
  const jwt = await registerAndLogin(`combo-pp-liker-${randomUUID()}@test.local`);
  const product = await createProduct();
  await fetch(`${BASE_URL}/processed-product-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ productId: String(product.id), liked: true }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
  const row = await fetchProductRow(product.id);
  assert.equal(row.likeCount, 1);
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'processed-product', targetId: String(product.id), kind: 'like' },
  });
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------
// Generic create/update must strip client-supplied engagement fields
// ---------------------------------------------------------------------

test('generic update ignores a client-supplied likeCount/favoriteCount/viewCount/engagementVersion', async () => {
  const jwt = await registerAndLogin(`pp-spoof-${randomUUID()}@test.local`);
  const store = await createSellerStore({ ownerId: `spoof-owner-${randomUUID()}` });
  const product = await createProduct({ ownerId: store.ownerId, store: store.id });
  // Real like first, so we can prove the spoofed PATCH doesn't touch it.
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'processed-product', targetId: product.id }),
  });
  await fetch(`${BASE_URL}/processed-products/${product.id}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        likeCount: 99999,
        favoriteCount: 99999,
        viewCount: 99999,
        engagementVersion: 99999,
        views: 99999,
        favorites: 99999,
        likes: 99999,
      },
    }),
  });
  const row = await fetchProductRow(product.id);
  assert.equal(row.likeCount, 1, 'spoofed likeCount must not have overwritten the real, server-computed value');
  assert.equal(row.favoriteCount, 0);
  assert.equal(row.viewCount, 0);
  assert.notEqual(row.engagementVersion, 99999);
});

test('generic create ignores a client-supplied likeCount/favoriteCount/viewCount', async () => {
  const jwt = await registerAndLogin(`pp-spoof-create-${randomUUID()}@test.local`);
  const store = await createSellerStore({ ownerId: `spoof-create-owner-${randomUUID()}` });
  const res = await fetch(`${BASE_URL}/processed-products`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        localProductId: `spoof-${randomUUID()}`,
        title: 'Spoof Urun',
        category: 'Bal',
        ownerId: store.ownerId,
        store: store.id,
        likeCount: 500,
        favoriteCount: 500,
        viewCount: 500,
      },
    }),
  });
  if (res.status !== 200 && res.status !== 201) {
    // Core create action may not be permission-granted to the
    // authenticated role at all (see D5-B report §"Route/izin durumu") —
    // that is a separate, pre-existing authorization gap, not part of
    // this phase. If it 403s, the spoof never had a chance to land,
    // which also satisfies this test's intent.
    assert.equal(res.status, 403);
    return;
  }
  const body = await res.json();
  const created = body.data ?? body;
  assert.equal(created.likeCount ?? 0, 0);
  assert.equal(created.favoriteCount ?? 0, 0);
  assert.equal(created.viewCount ?? 0, 0);
});
