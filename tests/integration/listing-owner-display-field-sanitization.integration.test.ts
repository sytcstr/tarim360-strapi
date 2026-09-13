/**
 * LISTING_AZ_FINAL_MASTER_SWEEP_REPORT.md İlan 1A (Madde 98).
 *
 * ownerName/ownerCity are display-only snapshots the client sends at
 * create/update time. Unlike ownerEmail/ownerProfileId/ownerId (always
 * force-derived from the JWT identity, never trusted from the client),
 * these two were previously passed through completely unchecked --
 * an authenticated caller could type an arbitrary string impersonating
 * a different real seller's name/city with no ownership bypass but a
 * genuine cosmetic-display-spoofing surface.
 *
 * sanitizeOwnerDisplayFields (listing.ts) is now applied on all three
 * write paths (POST /listings, PUT /listings/:id, POST /offline-sync/
 * listings): if the caller's OWN profile-setting row has at least one
 * real candidate name (displayName/publicUsername/brandName) and the
 * client's claim matches none of them, the claim is replaced with the
 * first real candidate. A caller with no profile-setting row yet (or
 * one with no name fields set) has nothing genuine to check against,
 * so their client value (including a legitimate email-prefix/
 * "Kullanıcı" fallback) passes through unchanged. Same policy for
 * ownerCity against the profile's own `city`.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-owner-display-field-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-owner-display-field-test.db');
const PORT = 14204;
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

async function setProfile(owner: { ownerId: string; email: string }, fields: Record<string, unknown>) {
  return strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: {
      profileId: owner.ownerId,
      ownerEmail: owner.email,
      ...fields,
    },
  });
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'sell',
    mainType: 'tarim',
    title: `M98 Ilan ${randomUUID()}`,
    description: 'Test aciklama',
    price: 100,
    location: { city: 'Konya', district: 'Selcuklu', display: 'Konya / Selcuklu' },
    ...overrides,
  };
}

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { ...basePayload(overrides), operationId: randomUUID() } }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------
// POST /listings (create)
// ---------------------------------------------------------------------

test('create: brand-new user with no profile-setting row -> client ownerName/ownerCity pass through unchanged', async () => {
  const user = await registerAndLogin(`m98-create-noprofile-${randomUUID()}@test.local`);
  const res = await createListing(user.jwt, { ownerName: 'kullanici', ownerCity: 'Türkiye' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.ownerName, 'kullanici');
  assert.equal(res.body.data.ownerCity, 'Türkiye');
});

test('create: client ownerName matching one of the caller\'s real profile names passes through', async () => {
  const user = await registerAndLogin(`m98-create-match-${randomUUID()}@test.local`);
  await setProfile(user, { displayName: 'Gercek Isim', city: 'Konya' });

  const res = await createListing(user.jwt, { ownerName: 'Gercek Isim', ownerCity: 'Konya' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.ownerName, 'Gercek Isim');
  assert.equal(res.body.data.ownerCity, 'Konya');
});

test('create: client ownerName matching publicUsername (not displayName) also passes through', async () => {
  const user = await registerAndLogin(`m98-create-publicuser-${randomUUID()}@test.local`);
  await setProfile(user, { publicUsername: 'ciftci123' });

  const res = await createListing(user.jwt, { ownerName: 'ciftci123' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.ownerName, 'ciftci123');
});

test('create: client ownerName spoofing a different name is overridden with the caller\'s own real name', async () => {
  const user = await registerAndLogin(`m98-create-spoof-${randomUUID()}@test.local`);
  await setProfile(user, { displayName: 'Gercek Ciftci', city: 'Konya' });

  const res = await createListing(user.jwt, { ownerName: 'Baska Bir Satici', ownerCity: 'Istanbul' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.ownerName, 'Gercek Ciftci', 'spoofed name must be replaced with the caller\'s real profile name');
  assert.equal(res.body.data.ownerCity, 'Konya', 'spoofed city must be replaced with the caller\'s real profile city');
});

test('create: missing ownerCity on the profile leaves the client value untouched even with a name mismatch', async () => {
  const user = await registerAndLogin(`m98-create-nocity-${randomUUID()}@test.local`);
  await setProfile(user, { displayName: 'Gercek Isim' });

  const res = await createListing(user.jwt, { ownerName: 'Sahte Isim', ownerCity: 'Antalya' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.ownerName, 'Gercek Isim');
  assert.equal(res.body.data.ownerCity, 'Antalya', 'profile has no city set -- nothing genuine to check the claim against');
});

// ---------------------------------------------------------------------
// PUT /listings/:id (update)
// ---------------------------------------------------------------------

test('update: a spoofed ownerName is overridden the same way on edit', async () => {
  const user = await registerAndLogin(`m98-update-spoof-${randomUUID()}@test.local`);
  await setProfile(user, { displayName: 'Gercek Isim Update', city: 'Bursa' });
  const created = await createListing(user.jwt, { ownerName: 'Gercek Isim Update', ownerCity: 'Bursa' });
  assert.equal(created.status, 201);

  const res = await fetch(`${BASE_URL}/listings/${created.body.data.documentId}`, {
    method: 'PUT',
    headers: authed(user.jwt),
    body: JSON.stringify({ data: { ownerName: 'Sahte Guncel Isim', ownerCity: 'Izmir' } }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.ownerName, 'Gercek Isim Update');
  assert.equal(json.data.ownerCity, 'Bursa');
});

test('update: not sending ownerName/ownerCity at all leaves the existing (already-sanitized) value unchanged', async () => {
  const user = await registerAndLogin(`m98-update-untouched-${randomUUID()}@test.local`);
  await setProfile(user, { displayName: 'Sabit Isim', city: 'Ankara' });
  const created = await createListing(user.jwt, { ownerName: 'Sabit Isim', ownerCity: 'Ankara' });
  assert.equal(created.status, 201);

  const res = await fetch(`${BASE_URL}/listings/${created.body.data.documentId}`, {
    method: 'PUT',
    headers: authed(user.jwt),
    body: JSON.stringify({ data: { title: 'Sadece Baslik Degisti' } }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.title, 'Sadece Baslik Degisti');
  assert.equal(json.data.ownerName, 'Sabit Isim');
  assert.equal(json.data.ownerCity, 'Ankara');
});

// ---------------------------------------------------------------------
// POST /offline-sync/listings
// ---------------------------------------------------------------------

test('offline-sync create: a spoofed ownerName is overridden the same way as the direct path', async () => {
  const user = await registerAndLogin(`m98-offline-create-spoof-${randomUUID()}@test.local`);
  await setProfile(user, { displayName: 'Gercek Offline Isim', city: 'Trabzon' });

  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'create',
      listing: {
        operationId: randomUUID(),
        title: `M98 Offline Ilan ${randomUUID()}`,
        mainType: 'tarim',
        mode: 'sell',
        ownerName: 'Sahte Offline Isim',
        ownerCity: 'Rize',
      },
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const json = await res.json();
  assert.equal(json.data.listing.ownerName, 'Gercek Offline Isim');
  assert.equal(json.data.listing.ownerCity, 'Trabzon');
});

test('offline-sync update: a spoofed ownerName is overridden on an existing listing', async () => {
  const user = await registerAndLogin(`m98-offline-update-spoof-${randomUUID()}@test.local`);
  await setProfile(user, { displayName: 'Gercek Isim2', city: 'Samsun' });
  const created = await createListing(user.jwt, { ownerName: 'Gercek Isim2', ownerCity: 'Samsun' });
  assert.equal(created.status, 201);

  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: { id: created.body.data.id, ownerName: 'Sahte Isim2', ownerCity: 'Mersin' },
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const row = await strapiInstance.entityService.findOne('api::listing.listing', created.body.data.id);
  assert.equal(row.ownerName, 'Gercek Isim2');
  assert.equal(row.ownerCity, 'Samsun');
});

test('offline-sync create: brand-new user with no profile passes ownerName/ownerCity through unchanged', async () => {
  const user = await registerAndLogin(`m98-offline-noprofile-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'create',
      listing: {
        operationId: randomUUID(),
        title: `M98 Offline Noprofile ${randomUUID()}`,
        mainType: 'tarim',
        mode: 'sell',
        ownerName: 'kullanici',
        ownerCity: 'Türkiye',
      },
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const json = await res.json();
  assert.equal(json.data.listing.ownerName, 'kullanici');
  assert.equal(json.data.listing.ownerCity, 'Türkiye');
});
