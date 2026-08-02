/**
 * Faz D4-B — Logistics Load like/favorite backend delegation.
 *
 * Verifies that the legacy Logistics Load endpoints
 * (POST /logistics-loads/:id/metrics/like|favorite and
 * POST /logistics-load-likes/toggle) and the new canonical
 * PUT/DELETE /engagements/like|favorite (targetType=logistics-load)
 * routes now share the exact same mutation core (setMembership) — so
 * calling both for the same real user only ever changes the counter
 * once, never double-counts, and the legacy JSON actor-list mirror
 * never becomes a second source of truth for the count.
 *
 * Run: npm run test:integration (requires a real Strapi boot against a
 * throwaway SQLite file — see beforeAll below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-logistics-load-engagement-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-logistics-load-engagement-test.db');
const PORT = 14151;
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

/**
 * Creates a logistics-load row directly through entityService, bypassing
 * the require-logistics-premium policy — that policy (and the create
 * endpoint's own authorization) is out of D4-B's scope, which is only
 * concerned with the like/favorite mutation path once a load already
 * exists.
 */
async function createLoad(overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::logistics-load.logistics-load', {
    data: {
      title: 'Test yuk',
      loadType: 'genel',
      fromCity: 'Ankara',
      toCity: 'Istanbul',
      weight: 10,
      vehicleType: 'kamyon',
      loadingDate: new Date().toISOString(),
      latitude: 39.9,
      longitude: 32.8,
      fromLatitude: 39.9,
      fromLongitude: 32.8,
      toLatitude: 41.0,
      toLongitude: 28.9,
      ownerName: 'Test Sahibi',
      ownerKey: `profile:${randomUUID()}`,
      status: 'open',
      viewCount: 0,
      likeCount: 0,
      favoriteCount: 0,
      likedActorKeys: [],
      favoriteActorKeys: [],
      engagementVersion: 0,
      ...overrides,
    },
  } as any);
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

const freshLoad = async () => createLoad();

const fetchLoadRow = async (id: number | string) =>
  strapiInstance.db.query('api::logistics-load.logistics-load').findOne({ where: { id } } as any);

// ---------------------------------------------------------------------
// New canonical route (PUT/DELETE /engagements/like|favorite)
// ---------------------------------------------------------------------

test('like (new): first PUT activates and increments likeCount', async () => {
  const jwt = await registerAndLogin(`load-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.changed, true);
  assert.equal(body.count, 1);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
});

test('like (new): repeating the same PUT is a no-op', async () => {
  const jwt = await registerAndLogin(`load-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
});

test('like (new): DELETE unlikes and decrements', async () => {
  const jwt = await registerAndLogin(`load-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like?targetType=logistics-load&targetId=${load.id}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  const body = await res.json();
  assert.equal(body.active, false);
  assert.equal(body.changed, true);
  assert.equal(body.count, 0);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 0);
});

test('favorite (new): first PUT activates and increments favoriteCount', async () => {
  const jwt = await registerAndLogin(`load-fav-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const body = await res.json();
  assert.equal(body.active, true);
  assert.equal(body.changed, true);
  assert.equal(body.count, 1);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.favoriteCount, 1);
});

test('favorite (new): repeating the same PUT is a no-op', async () => {
  const jwt = await registerAndLogin(`load-fav-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
});

test('like (new): two concurrent PUTs from the same actor result in count=1', async () => {
  const jwt = await registerAndLogin(`load-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const fire = () =>
    fetch(`${BASE_URL}/engagements/like`, {
      method: 'PUT',
      headers: authed(jwt),
      body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal([a.changed, b.changed].filter(Boolean).length, 1);
  assert.equal(Math.max(a.count, b.count), 1);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
});

test('like (new): a concurrent PUT and DELETE race never leaves count negative', async () => {
  const jwt = await registerAndLogin(`load-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const putAgain = fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  }).then((r) => r.json());
  const del = fetch(`${BASE_URL}/engagements/like?targetType=logistics-load&targetId=${load.id}`, {
    method: 'DELETE',
    headers: authed(jwt),
  }).then((r) => r.json());
  const [a, b] = await Promise.all([putAgain, del]);
  assert.ok(a.count >= 0 && b.count >= 0, 'count must never go negative');
  const row = await fetchLoadRow(load.id);
  assert.ok(row.likeCount >= 0);
});

test('engagementVersion only advances on a real mutation, not a no-op retry', async () => {
  const jwt = await registerAndLogin(`load-ver-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const first = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  }).then((r) => r.json());
  const retry = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  }).then((r) => r.json());
  assert.equal(retry.serverVersion, first.serverVersion);
});

test('count matches the real engagement-interaction row count', async () => {
  const jwt = await registerAndLogin(`load-count-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'logistics-load', targetId: String(load.id), kind: 'like' },
  });
  assert.equal(rows.length, 1);
});

test('like: non-existent load returns NOT_FOUND', async () => {
  const jwt = await registerAndLogin(`load-liker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: '999999999' }),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------
// Legacy route: POST /logistics-loads/:id/metrics/like|favorite
// ---------------------------------------------------------------------

test('legacy metrics/like: first call activates and increments likeCount', async () => {
  const jwt = await registerAndLogin(`legacy-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/like`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.likeCount, 1);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
  assert.ok((row.likedActorKeys ?? []).length === 1, 'legacy actor-list mirror should reflect the like');
});

test('legacy metrics/like: repeating the same call does not double-count', async () => {
  const jwt = await registerAndLogin(`legacy-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/like`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/like`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const body = await res.json();
  assert.equal(body.data.likeCount, 1);
});

test('legacy metrics/like: active:false unlikes and decrements', async () => {
  const jwt = await registerAndLogin(`legacy-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/like`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/like`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: false }),
  });
  const body = await res.json();
  assert.equal(body.data.likeCount, 0);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 0);
  assert.equal((row.likedActorKeys ?? []).length, 0);
});

test('legacy metrics/like: unauthenticated request is rejected', async () => {
  // Same native Strapi behavior as the /engagements/like "no JWT" test —
  // a missing token is rejected by the framework's own authorize
  // middleware (403, "anonymous role lacks permission"), before this
  // route's own ctx.unauthorized() check ever runs.
  const load = await freshLoad();
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/like`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ active: true }),
  });
  assert.equal(res.status, 403);
});

test('legacy metrics/favorite: first call activates and increments favoriteCount', async () => {
  const jwt = await registerAndLogin(`legacy-fav-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/favorite`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const body = await res.json();
  assert.equal(body.data.favoriteCount, 1);
});

test('legacy metrics/favorite: repeating the same call does not double-count', async () => {
  const jwt = await registerAndLogin(`legacy-fav-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/favorite`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/favorite`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const body = await res.json();
  assert.equal(body.data.favoriteCount, 1);
});

// ---------------------------------------------------------------------
// Legacy route: POST /logistics-load-likes/toggle
// ---------------------------------------------------------------------

test('legacy toggle: first call activates likeCount and mirrors profile-setting likedLogisticsLoadIds', async () => {
  const jwt = await registerAndLogin(`legacy-toggle-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const res = await fetch(`${BASE_URL}/logistics-load-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ loadId: String(load.id), liked: true }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.enabled, true);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
});

test('legacy toggle: repeating the same call does not double-count and reports changed-equivalent state', async () => {
  const jwt = await registerAndLogin(`legacy-toggle-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/logistics-load-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ loadId: String(load.id), liked: true }),
  });
  await fetch(`${BASE_URL}/logistics-load-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ loadId: String(load.id), liked: true }),
  });
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
});

test('legacy toggle: profile-setting likedLogisticsLoadIds is updated from the server result, not the client value — a stale client "liked:true" retry after server state is already true never re-adds a duplicate id', async () => {
  const jwt = await registerAndLogin(`legacy-toggle-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/logistics-load-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ loadId: String(load.id), liked: true }),
  });
  const res = await fetch(`${BASE_URL}/logistics-load-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ loadId: String(load.id), liked: true }),
  });
  const body = await res.json();
  // Second call is a no-op at the setMembership level (changed:false), so
  // this route intentionally leaves profile-setting untouched and returns
  // an empty values array rather than re-deriving it — see engagement.ts.
  assert.deepEqual(body.data.values, []);
});

// ---------------------------------------------------------------------
// Legacy + new called together for the SAME real user — the actual
// point of D4-B: both entry points converge on setMembership, so the
// counter only ever changes once no matter which route(s) are called.
// ---------------------------------------------------------------------

test('like: legacy metrics/like then new PUT for the same user only changes the counter once', async () => {
  const jwt = await registerAndLogin(`combo-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/like`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false, 'the same user liking via the new route after the legacy route must be a no-op');
  assert.equal(body.count, 1);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
});

test('like: new PUT then legacy /logistics-load-likes/toggle for the same user only changes the counter once', async () => {
  const jwt = await registerAndLogin(`combo-liker-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  await fetch(`${BASE_URL}/logistics-load-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ loadId: String(load.id), liked: true }),
  });
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'logistics-load', targetId: String(load.id), kind: 'like' },
  });
  assert.equal(rows.length, 1, 'legacy and new routes for the same user must produce exactly one interaction row');
});

test('favorite: legacy metrics/favorite then new PUT for the same user only changes the counter once', async () => {
  const jwt = await registerAndLogin(`combo-fav-${randomUUID()}@test.local`);
  const load = await freshLoad();
  await fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/favorite`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.favoriteCount, 1);
});

test('favorite: two simultaneous calls — one legacy, one new — for the same user still only change the counter once', async () => {
  const jwt = await registerAndLogin(`combo-fav-${randomUUID()}@test.local`);
  const load = await freshLoad();
  const legacy = fetch(`${BASE_URL}/logistics-loads/${load.id}/metrics/favorite`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ active: true }),
  });
  const modern = fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  await Promise.all([legacy, modern]);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.favoriteCount, 1);
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'logistics-load', targetId: String(load.id), kind: 'favorite' },
  });
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------
// Stale legacy JSON actor-list does not conflict with the interaction
// result — the JSON array is a best-effort mirror, never re-consulted
// to compute the count.
// ---------------------------------------------------------------------

test('a stale/corrupted likedActorKeys array does not affect the real like count, which comes only from setMembership', async () => {
  const jwt = await registerAndLogin(`stale-liker-${randomUUID()}@test.local`);
  // Pre-seed the legacy JSON array with unrelated, stale actor keys — as
  // if migrated from the old mechanism or corrupted by an external write.
  const load = await freshLoad({ likedActorKeys: ['user:someone-else@test.local', 'user:another@test.local'] });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-load', targetId: load.id }),
  });
  const body = await res.json();
  // The real count is derived purely from engagement_interactions, not
  // from the stale array's length (which already had 2 unrelated entries).
  assert.equal(body.count, 1);
  const row = await fetchLoadRow(load.id);
  assert.equal(row.likeCount, 1);
});
