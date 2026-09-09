/**
 * LISTING_AZ_REVALIDATION_PART5_81_100.md Madde 86 (P1), fixed in
 * src/api/engagement/controllers/engagement.ts's
 * delegateListingMembershipToggle.
 *
 * The legacy `POST /listing-favorites/toggle` and `POST
 * /listing-likes/toggle` routes are still registered and authenticated-
 * reachable, and used to delegate straight into setMembership with no
 * ownership check at all -- unlike the current PUT
 * /engagements/like|favorite route (engagement-v1.ts's handleMembership),
 * which already blocks a caller from favoriting/liking their own
 * listing. Any authenticated caller could self-favorite/self-like
 * through this still-registered route to inflate their own listing's
 * favoriteCount/likeCount (a metric used in "popular" sorting). This
 * suite proves that gap is closed on both legacy routes, and that
 * legitimate buyer favorite/like (create + remove) still works.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-legacy-favorite-like-ownership-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-legacy-favorite-like-ownership-test.db');
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

async function registerAndLogin(email: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return json.jwt;
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Madde86 Test Ilani',
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

async function legacyToggleFavorite(jwt: string, listingId: string, favorite: boolean) {
  const res = await fetch(`${BASE_URL}/listing-favorites/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { listingId, favorite } }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function legacyToggleLike(jwt: string, listingId: string, liked: boolean) {
  const res = await fetch(`${BASE_URL}/listing-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { listingId, liked } }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function listingCounts(documentId: string) {
  const row: any = await strapiInstance.db.query('api::listing.listing').findOne({
    where: { documentId, publishedAt: { $notNull: true } },
    select: ['favoriteCount', 'likeCount'],
  });
  return { favoriteCount: row?.favoriteCount ?? 0, likeCount: row?.likeCount ?? 0 };
}

test('legacy POST /listing-favorites/toggle: owner self-favorite is blocked', async () => {
  const owner = await registerAndLogin(`m86-fav-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner);

  const { status } = await legacyToggleFavorite(owner, listing.documentId, true);
  assert.equal(status, 403);

  const counts = await listingCounts(listing.documentId);
  assert.equal(counts.favoriteCount, 0, 'rejected self-favorite must not increment the counter');
});

test('legacy POST /listing-likes/toggle: owner self-like is blocked', async () => {
  const owner = await registerAndLogin(`m86-like-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner);

  const { status } = await legacyToggleLike(owner, listing.documentId, true);
  assert.equal(status, 403);

  const counts = await listingCounts(listing.documentId);
  assert.equal(counts.likeCount, 0, 'rejected self-like must not increment the counter');
});

test('legacy POST /listing-favorites/toggle: buyer favorite works and increments the counter', async () => {
  const seller = await registerAndLogin(`m86-fav-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m86-fav-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);

  const { status, body } = await legacyToggleFavorite(buyer, listing.documentId, true);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.enabled, true);

  const counts = await listingCounts(listing.documentId);
  assert.equal(counts.favoriteCount, 1);
});

test('legacy POST /listing-likes/toggle: buyer like works and increments the counter', async () => {
  const seller = await registerAndLogin(`m86-like-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m86-like-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);

  const { status, body } = await legacyToggleLike(buyer, listing.documentId, true);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.enabled, true);

  const counts = await listingCounts(listing.documentId);
  assert.equal(counts.likeCount, 1);
});

test('legacy POST /listing-favorites/toggle: a buyer can remove their own existing favorite (idempotent-unfavorite preserved)', async () => {
  const seller = await registerAndLogin(`m86-fav-remove-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m86-fav-remove-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);

  const created = await legacyToggleFavorite(buyer, listing.documentId, true);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await listingCounts(listing.documentId)).favoriteCount, 1);

  const removed = await legacyToggleFavorite(buyer, listing.documentId, false);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.data.enabled, false);
  assert.equal((await listingCounts(listing.documentId)).favoriteCount, 0);
});

test('legacy POST /listing-favorites/toggle: owner "removing" a favorite they never had does not go negative', async () => {
  const owner = await registerAndLogin(`m86-fav-negative-${randomUUID()}@test.local`);
  const listing = await createListing(owner);

  // enabled=false (removal) intentionally bypasses the new ownership
  // check -- only CREATING a self-favorite is blocked, matching
  // handleMembership's own precedent -- so this must not error, and
  // must not push the counter below zero.
  const { status } = await legacyToggleFavorite(owner, listing.documentId, false);
  assert.equal(status, 200);

  const counts = await listingCounts(listing.documentId);
  assert.equal(counts.favoriteCount, 0);
  assert.ok(counts.favoriteCount >= 0);
});

test('legacy POST /listing-likes/toggle: owner "removing" a like they never had does not go negative', async () => {
  const owner = await registerAndLogin(`m86-like-negative-${randomUUID()}@test.local`);
  const listing = await createListing(owner);

  const { status } = await legacyToggleLike(owner, listing.documentId, false);
  assert.equal(status, 200);

  const counts = await listingCounts(listing.documentId);
  assert.equal(counts.likeCount, 0);
  assert.ok(counts.likeCount >= 0);
});
