/**
 * Integration tests for the Engagement API contract — like/favorite,
 * view, and share, including the concurrency/idempotency scenarios
 * from ENGAGEMENT_API_CONTRACT.md and the Faz B Aşama 11 test list.
 *
 * ============================================================
 * NOT EXECUTED IN THIS SESSION. Written, not run.
 * ============================================================
 * Faz B's explicit working rules for this implementation pass forbid
 * connecting to a database or running migrations in this session. This
 * file requires booting a real Strapi instance against a throwaway
 * SQLite file (which runs pending migrations and content-type schema
 * sync — exactly the actions that were off-limits here). It is written
 * to the same standard as the rest of this phase's code (real,
 * reviewed, type-checked — `npx tsc --noEmit` passes on this file) but
 * its assertions have NOT been observed to pass. Whoever runs this next
 * must treat a first run as the actual verification step, not a
 * formality — in particular §3.3/§Aşama 3's known migration-ordering
 * risk (the composite unique index may not exist after only one boot)
 * should be checked here first via the PRAGMA index_list query
 * documented in the migration files.
 *
 * To run (after removing this file's exclusion, if any, from CI):
 *   npm run test:integration
 * (script provided in package.json; requires DATABASE_FILENAME pointed
 * at a throwaway file — see beforeAll below — never point this at a
 * real dev or production database file.)
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

// Must be a path relative to the Strapi project root — config/database.ts
// joins DATABASE_FILENAME onto the project root itself, so an absolute
// path here would be joined twice and fail with EINVAL (confirmed while
// running this suite for real during Faz B-V).
const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-engagement-integration-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-engagement-integration-test.db');
const PORT = 14150;
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

/** Creates a real user + JWT via the users-permissions plugin so tests
 * hit genuine auth, not a mocked identity. */
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
 * Creates a listing owned by a FRESH, separate account — never the caller
 * under test. The engagement-v1 controller correctly forbids liking/
 * favoriting your own listing (isOwnListingTarget); an earlier version of
 * this helper created the listing under the same JWT that then tried to
 * like it, which made every like/favorite test fail with a genuine (and
 * correct) self-like 403 — a test bug, not an engagement-system bug. This
 * was caught by actually running the suite (Faz B-V), exactly the kind of
 * thing a written-but-unexecuted test file cannot surface.
 */
async function createListingOwnedByStranger(overrides: Record<string, unknown> = {}) {
  const ownerJwt = await registerAndLogin(`owner-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerJwt}` },
    body: JSON.stringify({
      data: {
        title: 'Test listing',
        mode: 'sell',
        mainType: 'urun',
        ownerEmail: 'owner@example.com',
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  return json.data;
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

// ---------------------------------------------------------------------
// Like / Favorite
// ---------------------------------------------------------------------

test('like: first PUT activates and increments count (changed:true)', async () => {
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.changed, true);
  assert.equal(body.count, 1);
});

test('like: repeating the same PUT is a no-op (changed:false, same active/count)', async () => {
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const body = await res.json();
  assert.equal(body.active, true);
  assert.equal(body.changed, false);
  assert.equal(body.count, 1); // must NOT have incremented a second time
});

test('like: DELETE after PUT deactivates and decrements', async () => {
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  // DELETE requests carry targetType/targetId as query params, not body —
  // confirmed via a real boot (Faz B-V) that this Strapi/Koa setup leaves
  // ctx.request.body empty for DELETE even when a JSON body is sent.
  const res = await fetch(`${BASE_URL}/engagements/like?targetType=listing&targetId=${listing.id}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  const body = await res.json();
  assert.equal(body.active, false);
  assert.equal(body.changed, true);
  assert.equal(body.count, 0);
});

test('like: repeating DELETE when already inactive is a no-op', async () => {
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const res = await fetch(`${BASE_URL}/engagements/like?targetType=listing&targetId=${listing.id}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  const body = await res.json();
  assert.equal(body.active, false);
  assert.equal(body.changed, false);
  assert.equal(body.count, 0);
});

test('like: two concurrent PUTs from the same actor result in count=1, not 2 (unique constraint + insert-conflict handling)', async () => {
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const fire = () =>
    fetch(`${BASE_URL}/engagements/like`, {
      method: 'PUT',
      headers: authed(jwt),
      body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(a.active, true);
  assert.equal(b.active, true);
  // Exactly one of the two should report changed:true; final count must be 1.
  assert.equal([a.changed, b.changed].filter(Boolean).length, 1);
  assert.equal(Math.max(a.count, b.count), 1);
});

test('like: two concurrent DELETEs from the same already-liked actor result in count=0, not -1', async () => {
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const fire = () =>
    fetch(`${BASE_URL}/engagements/like?targetType=listing&targetId=${listing.id}`, {
      method: 'DELETE',
      headers: authed(jwt),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(Math.max(a.count, b.count), 0);
  assert.ok(a.count >= 0 && b.count >= 0, 'count must never go negative');
});

test('like: request with no JWT at all is rejected before reaching our controller', async () => {
  // A completely missing token never reaches engagement-v1's controller —
  // Strapi's OWN authorize middleware (route config `auth: {scope:[]}`)
  // rejects it first, treating the caller as the "public" role, which
  // does not have this action enabled. Confirmed via a real boot
  // (Faz B-V): Strapi's native behavior here is 403, not 401 — a missing
  // token is treated as "anonymous role lacks permission," not "who are
  // you." This is standard Strapi framework behavior, not a bug in this
  // implementation; ENGAGEMENT_API_CONTRACT.md's error-code table should
  // be read with this in mind for the true-anonymous case specifically
  // (an INVALID/expired token, by contrast, does reach readIdentity and
  // gets our own UNAUTHORIZED envelope).
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetType: 'listing', targetId: '1' }),
  });
  assert.equal(res.status, 403);
});

test('favorite: unsupported domain (hub-content) returns ENGAGEMENT_NOT_SUPPORTED, not a silent success', async () => {
  // logistics-vehicle used to be the example here; it now supports
  // favorite (post-D-final production-blocker fix, see
  // logistics-vehicle-favorite.integration.test.ts) so it is no longer a
  // valid "unsupported" example. hub-content still has favorite:false.
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: '1' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'ENGAGEMENT_NOT_SUPPORTED');
});

test('like: non-existent target returns NOT_FOUND', async () => {
  const jwt = await registerAndLogin(`liker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: '999999999' }),
  });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------
// View
// ---------------------------------------------------------------------

test('view: first view increments and returns incremented:true', async () => {
  const jwt = await registerAndLogin(`viewer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const body = await res.json();
  assert.equal(body.incremented, true);
  assert.equal(body.count, 1);
});

test('view: repeating within 24h does not increment again', async () => {
  const jwt = await registerAndLogin(`viewer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const body = await res.json();
  assert.equal(body.incremented, false);
  assert.equal(body.count, 1);
});

test('view: after the 24h window elapses, a new view increments again (requires manipulating lastViewedAt directly — see note)', async () => {
  // A real 24h wait is impractical in a test suite. This test documents
  // the INTENT and manipulates the engagement-view row's lastViewedAt
  // directly via strapi.db.query to simulate elapsed time, then re-fires
  // the same request — this exercises the real conditional-UPDATE path,
  // not a mock.
  const jwt = await registerAndLogin(`viewer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await strapiInstance.db.query('api::engagement-view.engagement-view').updateMany({
    where: { targetType: 'listing', targetId: String(listing.id) },
    data: { lastViewedAt: staleDate },
  });
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const body = await res.json();
  assert.equal(body.incremented, true);
  assert.equal(body.count, 2);
});

test('view: two concurrent first-views from the same actor increment exactly once (unique constraint + insert-conflict handling)', async () => {
  const jwt = await registerAndLogin(`viewer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const fire = () =>
    fetch(`${BASE_URL}/engagements/view`, {
      method: 'POST',
      headers: authed(jwt),
      body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(Math.max(a.count, b.count), 1);
  assert.equal([a.incremented, b.incremented].filter(Boolean).length, 1);
});

test('view: a client-supplied count/viewCount in the body is ignored — server always computes it', async () => {
  const jwt = await registerAndLogin(`viewer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id, viewCount: 999999, count: 999999 }),
  });
  const body = await res.json();
  assert.equal(body.count, 1, 'server must ignore the client-supplied count entirely');
});

test('view: an invalid guest UUID is rejected rather than silently accepted as an untracked actor', async () => {
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetType: 'listing', targetId: '1', guestActorId: 'not-a-real-uuid' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('view: non-existent target returns NOT_FOUND', async () => {
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetType: 'listing', targetId: '999999999', guestActorId: randomUUID() }),
  });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------

test('share: first operationId creates a real row and returns 201', async () => {
  const jwt = await registerAndLogin(`sharer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const operationId = randomUUID();
  const res = await fetch(`${BASE_URL}/listing-shares`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ listingId: listing.id, channel: 'whatsapp', operationId }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.meta.shareCount, 1);
});

test('share: retrying the same operationId with the same payload is idempotent (200, no new row)', async () => {
  const jwt = await registerAndLogin(`sharer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const operationId = randomUUID();
  const payload = { listingId: listing.id, channel: 'whatsapp', operationId };
  await fetch(`${BASE_URL}/listing-shares`, { method: 'POST', headers: authed(jwt), body: JSON.stringify(payload) });
  const res = await fetch(`${BASE_URL}/listing-shares`, { method: 'POST', headers: authed(jwt), body: JSON.stringify(payload) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.meta.shareCount, 1, 'must not have created a second row');
});

test('share: same operationId with a DIFFERENT payload returns 409 CONFLICT', async () => {
  const jwt = await registerAndLogin(`sharer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const operationId = randomUUID();
  await fetch(`${BASE_URL}/listing-shares`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ listingId: listing.id, channel: 'whatsapp', operationId }),
  });
  const res = await fetch(`${BASE_URL}/listing-shares`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ listingId: listing.id, channel: 'sms', operationId }), // different channel, same id
  });
  const body = await res.json();
  assert.equal(res.status, 409);
  assert.equal(body.error.code, 'CONFLICT');
});

test('share: two concurrent requests with the same operationId create exactly one row', async () => {
  const jwt = await registerAndLogin(`sharer-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const operationId = randomUUID();
  const payload = { listingId: listing.id, channel: 'whatsapp', operationId };
  const fire = () =>
    fetch(`${BASE_URL}/listing-shares`, { method: 'POST', headers: authed(jwt), body: JSON.stringify(payload) }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(Math.max(a.meta.shareCount, b.meta.shareCount), 1);
});

test('share: request with no JWT at all is rejected (auth now required, unlike the pre-Faz-B behavior)', async () => {
  // Same Strapi native-403-for-missing-token behavior as the like test
  // above — see that test's comment for the full explanation.
  const res = await fetch(`${BASE_URL}/listing-shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ listingId: '1', channel: 'whatsapp', operationId: randomUUID() }),
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------
// General invariants
// ---------------------------------------------------------------------

test('general: engagementVersion only advances on a real mutation, not on a no-op retry', async () => {
  const jwt = await registerAndLogin(`ver-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  const first = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  }).then((r) => r.json());
  const retry = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  }).then((r) => r.json());
  assert.equal(retry.serverVersion, first.serverVersion, 'no-op retry must not advance serverVersion');
});

test('general: count matches the real engagement-interaction row count, not a client-influenced number', async () => {
  const jwt = await registerAndLogin(`count-${randomUUID()}@test.local`);
  const listing = await createListingOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.id }),
  });
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'listing', targetId: String(listing.id), kind: 'like' },
  });
  assert.equal(rows.length, 1);
});
