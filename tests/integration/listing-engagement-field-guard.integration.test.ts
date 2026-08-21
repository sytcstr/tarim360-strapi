/**
 * SEMANTIC_CONTRACT_S2 (audit finding 2.5) — listing.ts had NO update
 * override at all (stock factories.createCoreController), unlike
 * processed-product/logistics-vehicle/hub-content, which all strip their
 * engagement-only fields from create/update. Any authenticated listing
 * owner could PATCH their own listing's likeCount/favoriteCount/
 * viewCount/offerCount/commentCount/shareCount/engagementVersion (and
 * isPremium/isPremiumOwner) to an arbitrary value via a normal
 * PUT /listings/:id. This suite proves the new stripClientProtectedFields
 * guard closes that gap on both create and update, while leaving every
 * normal, user-editable field working exactly as before.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-field-guard-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-field-guard-test.db');
const PORT = 14162;
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
        title: 'Field Guard Test Ilani',
        mainType: 'bitkisel',
        mode: 'sell',
        location: 'Konya',
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  return res.json();
}

const fetchRowByDocumentId = async (documentId: string) =>
  strapiInstance.db.query('api::listing.listing').findOne({ where: { documentId } } as any);

test('create: spoofed engagement/premium fields are ignored, server defaults apply', async () => {
  const jwt = await registerAndLogin(`listing-create-spoof-${randomUUID()}@test.local`);
  const body = await createListing(jwt, {
    likeCount: 999,
    favoriteCount: 999,
    viewCount: 999,
    offerCount: 999,
    commentCount: 999,
    shareCount: 999,
    engagementVersion: 999,
    isPremium: true,
    isPremiumOwner: true,
  });
  assert.equal(body.data.likeCount, 0);
  assert.equal(body.data.favoriteCount, 0);
  assert.equal(body.data.viewCount, 0);
  assert.equal(body.data.offerCount, 0);
  assert.equal(body.data.commentCount, 0);
  assert.equal(body.data.shareCount, 0);
  assert.equal(body.data.engagementVersion, 0);
  // No profile-setting premium record exists for this fresh user, so the
  // server-computed value is false regardless of what was spoofed.
  assert.equal(body.data.isPremium, false);
  assert.equal(body.data.isPremiumOwner, false);
});

test('update: spoofed engagement/premium fields are stripped, real values untouched', async () => {
  const jwt = await registerAndLogin(`listing-update-spoof-${randomUUID()}@test.local`);
  const created = await createListing(jwt);

  const res = await fetch(`${BASE_URL}/listings/${created.data.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        likeCount: 99999,
        favoriteCount: 99999,
        viewCount: 99999,
        offerCount: 99999,
        commentCount: 99999,
        shareCount: 99999,
        engagementVersion: 99999,
        isPremium: true,
        isPremiumOwner: true,
      },
    }),
  });
  assert.equal(res.status, 200, 'the real owner must still be able to update their own listing');

  const row = await fetchRowByDocumentId(created.data.documentId);
  assert.equal(row.likeCount, 0, 'spoofed likeCount must not overwrite the real, server-computed value');
  assert.equal(row.favoriteCount, 0);
  assert.equal(row.viewCount, 0);
  assert.equal(row.offerCount, 0);
  assert.equal(row.commentCount, 0);
  assert.equal(row.shareCount, 0);
  assert.notEqual(row.engagementVersion, 99999);
  assert.equal(row.isPremium, false, 'a non-premium owner must not be able to grant themselves a premium badge');
  assert.equal(row.isPremiumOwner, false);
});

test('update: normal, user-editable fields still work exactly as before', async () => {
  const jwt = await registerAndLogin(`listing-update-normal-${randomUUID()}@test.local`);
  const created = await createListing(jwt);

  const res = await fetch(`${BASE_URL}/listings/${created.data.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Guncellenmis Baslik',
        price: 1500,
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.title, 'Guncellenmis Baslik');
  assert.equal(body.data.price, 1500);
});
