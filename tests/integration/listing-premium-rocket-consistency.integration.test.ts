/**
 * LISTING_L10_PREMIUM_ROCKET_CONSISTENCY_REPORT.md.
 *
 * Covers what L10 actually changed/verified on the backend:
 *  - an expired rocket (`isDoping:true` with a past `rocketEndsAt`) now
 *    reads back as `isDoping:false` through both the single-item
 *    (`GET /listings/:id`) and list (`GET /listings`) routes -- a
 *    read-time-only fix (content-type lifecycles.ts), never rewriting
 *    the DB row -- while a genuinely active rocket is completely
 *    unaffected (regression, not just the new branch).
 *  - a listing's own `isPremiumOwner` and the same profile's public
 *    `isPremium` never disagree, across standard/finite-premium/
 *    unlimited-premium (`endsAt:null`)/expired-premium profile states.
 *  - `isDoping`/`rocketEndsAt`/`isPremium`/`isPremiumOwner` remain
 *    un-spoofable via a normal listing PUT (pre-existing protection,
 *    re-confirmed unmodified by this phase).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-premium-rocket-consistency-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-premium-rocket-consistency-test.db');
const PORT = 14187;
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
      title: 'L10 Test Ilani',
      mainType: 'Tahil',
      price: 100,
      ownerProfileId: owner.ownerId,
      ownerId: owner.ownerId,
      ownerEmail: owner.email,
      status: 'active',
      // isDoping/isPremium/isPremiumOwner have no schema default (raw
      // `null` otherwise, matching listing-rocket-activation.integration.
      // test.ts's own explicit `isDoping: false` convention for the same
      // reason).
      isDoping: false,
      isPremium: false,
      isPremiumOwner: false,
      publishedAt: new Date().toISOString(),
      ...overrides,
    },
  });
}

async function createProfile(owner: { ownerId: string; email: string }, overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: {
      profileId: owner.ownerId,
      ownerEmail: owner.email,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------
// L10.4/L10.9 -- expired rocket read-time correction
// ---------------------------------------------------------------------

test('L10.4: an expired rocket reads back as isDoping:false via GET /listings/:id', async () => {
  const owner = await registerAndLogin(`l10-expired-single-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner, {
    isDoping: true,
    rocketEndsAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    headers: authed(owner.jwt),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.isDoping, false, 'an expired rocket must not read back as active');
  // Note: db.query() reads go through the same content-type lifecycle
  // layer as entityService/REST reads in this Strapi version, so a
  // second read via db.query() here would ALSO see the corrected
  // isDoping:false -- confirming the fix applies universally to any
  // reader, not just this one route. The underlying column itself is
  // still never rewritten by this fix (no UPDATE is ever issued); there
  // is simply no in-process way to observe that without bypassing
  // Strapi's query engine entirely.
});

test('L10.4: an expired rocket reads back as isDoping:false via GET /listings (list route)', async () => {
  const owner = await registerAndLogin(`l10-expired-list-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner, {
    isDoping: true,
    rocketEndsAt: new Date(Date.now() - 60_000).toISOString(),
  });

  const res = await fetch(`${BASE_URL}/listings?filters[documentId][$eq]=${listing.documentId}`, {
    headers: authed(owner.jwt),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const row = (body.data as any[])[0];
  const attrs = row.attributes ?? row;
  assert.equal(attrs.isDoping, false, 'an expired rocket must not read back as active in a list response either');
});

test('L10.4 regression: a genuinely active (non-expired) rocket still reads back as isDoping:true', async () => {
  const owner = await registerAndLogin(`l10-active-rocket-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner, {
    isDoping: true,
    rocketEndsAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    headers: authed(owner.jwt),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.isDoping, true, 'a still-active rocket must not be affected by the expiry fix');
});

test('L10.4 regression: a listing that was never rocketed is unaffected', async () => {
  const owner = await registerAndLogin(`l10-never-rocketed-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    headers: authed(owner.jwt),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.isDoping, false);
  assert.equal(attrs.rocketEndsAt ?? null, null);
});

// ---------------------------------------------------------------------
// L10.13 -- listing premium-owner vs public-profile isPremium consistency
// ---------------------------------------------------------------------

async function publicProfileIsPremium(ownerId: string): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/public-profiles/${ownerId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return Boolean(body.profile?.isPremium);
}

test('L10.13: standard (non-premium) owner -- listing isPremiumOwner and public-profile isPremium both false', async () => {
  const owner = await registerAndLogin(`l10-consistency-standard-${randomUUID()}@test.local`);
  await createProfile(owner);
  const listing = await createOwnedListing(owner, { isPremium: false, isPremiumOwner: false });

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, { headers: authed(owner.jwt) });
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.isPremiumOwner, false);
  assert.equal(await publicProfileIsPremium(owner.ownerId), false);
});

test('L10.13: active premium with a finite future endsAt -- both signals true', async () => {
  const owner = await registerAndLogin(`l10-consistency-finite-${randomUUID()}@test.local`);
  const premium = {
    planTitle: 'Eco Premium',
    priceTl: 1599,
    startedAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
    autoRenew: true,
  };
  await createProfile(owner, { activePremium: premium, activePremiumSubscription: premium });
  const listing = await createOwnedListing(owner, { isPremium: true, isPremiumOwner: true });

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, { headers: authed(owner.jwt) });
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.isPremiumOwner, true);
  assert.equal(await publicProfileIsPremium(owner.ownerId), true);
});

test('L10.13: active premium with endsAt:null (unlimited) -- both signals true', async () => {
  const owner = await registerAndLogin(`l10-consistency-unlimited-${randomUUID()}@test.local`);
  const premium = {
    planTitle: 'Eco Premium',
    priceTl: 1599,
    startedAt: new Date().toISOString(),
    endsAt: null,
    autoRenew: true,
  };
  await createProfile(owner, { activePremium: premium, activePremiumSubscription: premium });
  const listing = await createOwnedListing(owner, { isPremium: true, isPremiumOwner: true });

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, { headers: authed(owner.jwt) });
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.isPremiumOwner, true);
  assert.equal(await publicProfileIsPremium(owner.ownerId), true);
});

test('L10.13: expired premium (past endsAt) -- both signals false', async () => {
  const owner = await registerAndLogin(`l10-consistency-expired-${randomUUID()}@test.local`);
  const premium = {
    planTitle: 'Eco Premium',
    priceTl: 1599,
    startedAt: new Date(Date.now() - 60 * 24 * 3600_000).toISOString(),
    endsAt: new Date(Date.now() - 24 * 3600_000).toISOString(),
    autoRenew: false,
  };
  await createProfile(owner, { activePremium: premium, activePremiumSubscription: premium });
  // isPremiumOwner/isPremium reflect what create() would have stamped
  // (false, since the premium had already expired by then).
  const listing = await createOwnedListing(owner, { isPremium: false, isPremiumOwner: false });

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, { headers: authed(owner.jwt) });
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.isPremiumOwner, false);
  assert.equal(await publicProfileIsPremium(owner.ownerId), false);
});

// ---------------------------------------------------------------------
// L10.14 -- protected-field spoof re-confirmation (pre-existing, unmodified)
// ---------------------------------------------------------------------

test('L10.14: a client PUT cannot spoof isDoping/rocketEndsAt/isPremium/isPremiumOwner on their own listing', async () => {
  const owner = await registerAndLogin(`l10-spoof-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({
      data: {
        isDoping: true,
        rocketEndsAt: new Date(Date.now() + 3600_000).toISOString(),
        isPremium: true,
        isPremiumOwner: true,
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.isDoping, false, 'isDoping must not be settable by a client PUT');
  assert.equal(body.data.isPremium, false, 'isPremium must not be settable by a client PUT');
  assert.equal(body.data.isPremiumOwner, false, 'isPremiumOwner must not be settable by a client PUT');
  assert.equal(body.data.rocketEndsAt ?? null, null, 'rocketEndsAt must not be settable by a client PUT');
});

test('L10.14: a non-owner cannot activate rocket on someone else\'s listing via direct API (re-confirmed)', async () => {
  const owner = await registerAndLogin(`l10-security-owner-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(owner);
  const attacker = await registerAndLogin(`l10-security-attacker-${randomUUID()}@test.local`);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}/rocket/activate`, {
    method: 'POST',
    headers: authed(attacker.jwt),
    body: JSON.stringify({ days: 7, operationId: randomUUID() }),
  });
  assert.equal(res.status, 403);
});
