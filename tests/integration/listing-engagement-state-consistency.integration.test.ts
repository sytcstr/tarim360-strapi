/**
 * LISTING_L11_ENGAGEMENT_STATE_CONSISTENCY_REPORT.md.
 *
 * Covers what L11 confirmed about the existing engagement contract
 * (mostly re-verification, since the forensic found the core system
 * already sound) plus two genuinely new pieces of coverage:
 *  - `engagementVersion` increases monotonically across DIFFERENT kinds
 *    (like/favorite/view) for the SAME listing, not just within one
 *    kind -- this is the exact property the Flutter-side
 *    EngagementStore._toggleMembership fix (L11.11/L11.12) relies on
 *    to safely use it as a monotonic guard instead of an unconditional
 *    overwrite.
 *  - the same listing resolves to the identical engagement target
 *    whether addressed by its numeric `id` or its `documentId` --
 *    locking in the "currently benign" target-identity finding from
 *    this phase's forensic as an explicit regression test, since three
 *    independent id-resolution helpers exist across different engagement-
 *    adjacent routes.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-engagement-state-consistency-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-engagement-state-consistency-test.db');
const PORT = 14188;
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

async function createListingOwnedByStranger(overrides: Record<string, unknown> = {}) {
  const ownerJwt = await registerAndLogin(`l11-owner-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerJwt}` },
    body: JSON.stringify({
      data: {
        title: 'L11 Test Listing',
        mode: 'sell',
        mainType: 'urun',
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  return json.data;
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function putLike(jwt: string, targetId: string | number) {
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function putFavorite(jwt: string, targetId: string | number) {
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postView(jwt: string, targetId: string | number) {
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'listing', targetId }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ---------------------------------------------------------------------
// L11.11/L11.12 -- engagementVersion is a per-target, cross-kind
// monotonic counter (validates the Flutter monotonic-guard fix)
// ---------------------------------------------------------------------

test('L11.11: engagementVersion increases monotonically across like -> favorite -> view for the same listing', async () => {
  const listing = await createListingOwnedByStranger();
  const jwt = await registerAndLogin(`l11-version-${randomUUID()}@test.local`);

  const likeRes = await putLike(jwt, listing.id);
  assert.equal(likeRes.status, 200);
  const v1 = likeRes.body.serverVersion;
  assert.ok(v1 > 0);

  const favRes = await putFavorite(jwt, listing.id);
  assert.equal(favRes.status, 200);
  const v2 = favRes.body.serverVersion;
  assert.ok(v2 > v1, 'a favorite mutation must advance the SAME listing\'s version past a prior like mutation');

  const viewRes = await postView(jwt, listing.id);
  assert.equal(viewRes.status, 200);
  const v3 = viewRes.body.serverVersion;
  assert.ok(v3 > v2, 'a view mutation must advance the version past a prior favorite mutation');
});

test('L11.11 regression: a no-op duplicate toggle does not advance engagementVersion', async () => {
  const listing = await createListingOwnedByStranger();
  const jwt = await registerAndLogin(`l11-version-noop-${randomUUID()}@test.local`);

  const first = await putLike(jwt, listing.id);
  const v1 = first.body.serverVersion;

  const duplicate = await putLike(jwt, listing.id);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.changed, false);
  assert.equal(duplicate.body.serverVersion, v1, 'a no-op duplicate must not bump the version');
});

// ---------------------------------------------------------------------
// L11.2 -- target identity: numeric id and documentId resolve to the
// SAME engagement target for like/favorite/view
// ---------------------------------------------------------------------

test('L11.2: liking a listing by numeric id, then favoriting it by documentId, affects the same target', async () => {
  const listing = await createListingOwnedByStranger();
  const jwt = await registerAndLogin(`l11-identity-${randomUUID()}@test.local`);

  const likeRes = await putLike(jwt, listing.id);
  assert.equal(likeRes.status, 200);
  assert.equal(likeRes.body.count, 1);

  const favRes = await putFavorite(jwt, listing.documentId);
  assert.equal(favRes.status, 200);
  assert.equal(favRes.body.count, 1);

  // Reading back via the OTHER id shape must see both mutations on the
  // same underlying row -- a duplicate like by documentId must now be a
  // true no-op (already active), not a fresh "first like" on a
  // different resolved row.
  const duplicateLikeByDocId = await putLike(jwt, listing.documentId);
  assert.equal(duplicateLikeByDocId.status, 200);
  assert.equal(duplicateLikeByDocId.body.changed, false);
  assert.equal(duplicateLikeByDocId.body.count, 1, 'must still be 1, not a second independent like on a differently-resolved row');
});

// ---------------------------------------------------------------------
// L11.4 -- no-negative-count / duplicate add-remove regression
// (re-confirms pre-existing behavior as part of this phase's own matrix)
// ---------------------------------------------------------------------

test('L11.4 regression: removing a favorite twice never goes negative', async () => {
  const listing = await createListingOwnedByStranger();
  const jwt = await registerAndLogin(`l11-negative-${randomUUID()}@test.local`);

  await putFavorite(jwt, listing.id);
  const removeOnce = await fetch(`${BASE_URL}/engagements/favorite?targetType=listing&targetId=${listing.id}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  const removeOnceBody = await removeOnce.json();
  assert.equal(removeOnceBody.count, 0);

  const removeTwice = await fetch(`${BASE_URL}/engagements/favorite?targetType=listing&targetId=${listing.id}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  assert.equal(removeTwice.status, 200);
  const removeTwiceBody = await removeTwice.json();
  assert.equal(removeTwiceBody.count, 0, 'count must clamp at 0, never go negative');
});

test('L11.4 regression: a client cannot spoof favoriteCount/likeCount/viewCount/engagementVersion via a listing PUT', async () => {
  const ownerJwt = await registerAndLogin(`l11-spoof-owner-${randomUUID()}@test.local`);
  const createRes = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(ownerJwt),
    body: JSON.stringify({
      data: { title: 'Spoof Test', mode: 'sell', mainType: 'urun', operationId: randomUUID() },
    }),
  });
  const listing = (await createRes.json()).data;

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    method: 'PUT',
    headers: authed(ownerJwt),
    body: JSON.stringify({
      data: { favoriteCount: 9999, likeCount: 9999, viewCount: 9999, engagementVersion: 9999 },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.favoriteCount ?? 0, 0);
  assert.equal(body.data.likeCount ?? 0, 0);
  assert.equal(body.data.viewCount ?? 0, 0);
  assert.equal(body.data.engagementVersion ?? 0, 0);
});
