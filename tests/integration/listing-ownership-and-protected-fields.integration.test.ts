/**
 * LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md — BUG-LISTING-001 (CRITICAL),
 * BUG-LISTING-004 (HIGH), BUG-LISTING-005 (MEDIUM-HIGH).
 *
 * BUG-LISTING-001: `POST /offline-sync/listings` (engagement.ts's
 * syncOfflineListing) had zero ownership check on its update/upsert
 * branch and never stripped protected fields -- any authenticated
 * caller could hijack another user's listing (reassigning ownerEmail/
 * ownerProfileId/ownerId to themselves) and freely set isPremium/
 * isDoping/rocketEndsAt/every counter on it. Fixed with a
 * matchesIdentity ownership check plus stripListingProtectedFields.
 *
 * BUG-LISTING-004: isDoping/rocketEndsAt were excluded from the
 * client-protected-field list on the normal PUT /listings/:id route,
 * letting any listing owner self-grant a free rocket/boost. Fixed by
 * moving to a shared LISTING_CLIENT_PROTECTED_FIELDS constant that
 * includes both.
 *
 * BUG-LISTING-005: listing.ts's update() never re-forced ownerEmail/
 * ownerProfileId/ownerId from the caller's identity (only create() did),
 * so an owner could reassign their own listing's ownership via a
 * crafted PUT body. Fixed the same way create() already worked.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-ownership-protected-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-ownership-protected-test.db');
const PORT = 14172;
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

async function createOwnedListing(owner: { ownerId: string; email: string }, overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::listing.listing', {
    data: {
      title: 'Test Ilani',
      description: 'Test aciklama',
      mainType: 'Tahil',
      price: 100,
      ownerProfileId: owner.ownerId,
      ownerId: owner.ownerId,
      ownerEmail: owner.email,
      ownerName: 'Test Sahibi',
      status: 'active',
      viewCount: 0,
      likeCount: 0,
      favoriteCount: 0,
      offerCount: 0,
      isPremium: false,
      isPremiumOwner: false,
      isDoping: false,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------
// BUG-LISTING-001: POST /offline-sync/listings
// ---------------------------------------------------------------------

test('offline-sync: owner can sync their own listing -> 200, non-protected fields applied', async () => {
  const owner = await registerAndLogin(`ls-sync-owner-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner, { title: 'Eski Baslik' });

  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(owner.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: { id: listing.id, title: 'Yeni Baslik' },
    }),
  });
  assert.equal(res.status, 200);
  const row = await strapiInstance.entityService.findOne('api::listing.listing', listing.id);
  assert.equal(row.title, 'Yeni Baslik');
});

test('offline-sync: a different user cannot sync/update someone else\'s listing -> 403, victim listing unchanged', async () => {
  const victim = await registerAndLogin(`ls-sync-victim-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(victim, { title: 'Kurbanin Ilani', price: 500 });

  const attacker = await registerAndLogin(`ls-sync-attacker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(attacker.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: { id: listing.id, title: 'Ele Gecirildi', price: 1 },
    }),
  });
  assert.equal(res.status, 403, 'a stranger must not be able to update another user\'s listing via offline-sync');

  const row = await strapiInstance.entityService.findOne('api::listing.listing', listing.id);
  assert.equal(row.title, 'Kurbanin Ilani', 'the victim\'s listing must be untouched');
  assert.equal(Number(row.price), 500);
});

test('offline-sync: attacker cannot reassign another user\'s listing to themselves via ownerEmail/ownerProfileId spoof', async () => {
  const victim = await registerAndLogin(`ls-sync-victim2-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(victim);

  const attacker = await registerAndLogin(`ls-sync-attacker2-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(attacker.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: {
        id: listing.id,
        ownerEmail: attacker.email,
        ownerProfileId: attacker.ownerId,
        ownerId: attacker.ownerId,
      },
    }),
  });
  assert.equal(res.status, 403);

  const row = await strapiInstance.entityService.findOne('api::listing.listing', listing.id);
  assert.equal(row.ownerEmail, victim.email, 'ownership must remain with the real owner, not the attacker');
  assert.equal(row.ownerProfileId, victim.ownerId);
});

test('offline-sync: owner cannot self-grant premium/rocket via offline-sync payload', async () => {
  const owner = await registerAndLogin(`ls-sync-premium-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);

  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(owner.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: {
        id: listing.id,
        isPremium: true,
        isPremiumOwner: true,
        isDoping: true,
        rocketEndsAt: '2099-01-01T00:00:00.000Z',
      },
    }),
  });
  assert.equal(res.status, 200, 'the sync itself should still succeed (only the protected fields are stripped)');

  const row = await strapiInstance.entityService.findOne('api::listing.listing', listing.id);
  assert.equal(row.isPremium, false);
  assert.equal(row.isPremiumOwner, false);
  assert.equal(row.isDoping, false);
  assert.equal(row.rocketEndsAt, null);
});

test('offline-sync: owner cannot spoof engagement counters via offline-sync payload', async () => {
  const owner = await registerAndLogin(`ls-sync-metrics-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);

  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(owner.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: {
        id: listing.id,
        viewCount: 999999,
        likeCount: 999999,
        favoriteCount: 999999,
        offerCount: 999999,
        engagementVersion: 999999,
      },
    }),
  });
  assert.equal(res.status, 200);

  const row = await strapiInstance.entityService.findOne('api::listing.listing', listing.id);
  assert.equal(row.viewCount, 0);
  assert.equal(row.likeCount, 0);
  assert.equal(row.favoriteCount, 0);
  assert.equal(row.offerCount, 0);
});

test('offline-sync: a nonexistent listing id falls back to creating a new listing owned by the caller (upsert contract, unchanged)', async () => {
  const owner = await registerAndLogin(`ls-sync-new-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(owner.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: { id: 999999999, title: 'Cevrimdisi Yeni Ilan' },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.operation, 'create');
  assert.equal(body.data.listing.ownerEmail, owner.email);
});

test('offline-sync: unauthenticated caller is rejected', async () => {
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'create', listing: { title: 'x' } }),
  });
  assert.equal(res.status, 403, 'auth:{scope:[]} with no JWT -- same documented Strapi platform behavior as other routes');
});

// ---------------------------------------------------------------------
// BUG-LISTING-004 / BUG-LISTING-005: PUT /listings/:id
// ---------------------------------------------------------------------

test('PUT /listings/:id: owner cannot self-grant isDoping/rocketEndsAt', async () => {
  const owner = await registerAndLogin(`ls-put-rocket-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({
      data: { isDoping: true, rocketEndsAt: '2099-01-01T00:00:00.000Z' },
    }),
  });
  assert.equal(res.status, 200);

  const row = await strapiInstance.db
    .query('api::listing.listing')
    .findOne({ where: { documentId: listing.documentId } } as any);
  assert.equal(row.isDoping, false);
  assert.equal(row.rocketEndsAt, null);
});

test('PUT /listings/:id: owner cannot reassign their own listing\'s ownership via body', async () => {
  const owner = await registerAndLogin(`ls-put-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`ls-put-stranger-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({
      data: {
        title: 'Guncellendi',
        ownerEmail: stranger.email,
        ownerProfileId: stranger.ownerId,
        ownerId: stranger.ownerId,
      },
    }),
  });
  assert.equal(res.status, 200);

  const row = await strapiInstance.db
    .query('api::listing.listing')
    .findOne({ where: { documentId: listing.documentId } } as any);
  assert.equal(row.title, 'Guncellendi', 'the legitimate field change must still apply');
  assert.equal(row.ownerEmail, owner.email, 'ownership must stay with the real (calling) owner');
  assert.equal(row.ownerProfileId, owner.ownerId);
});

test('PUT /listings/:id: a stranger still cannot update someone else\'s listing at all (regression, listing-owner-write policy)', async () => {
  const owner = await registerAndLogin(`ls-put-owner2-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`ls-put-stranger2-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    method: 'PUT',
    headers: authed(stranger.jwt),
    body: JSON.stringify({ data: { title: 'Hacked' } }),
  });
  assert.equal(res.status, 403);
});
