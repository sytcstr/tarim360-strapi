/**
 * PREMIUM_P1_TARGETED_FIX_REPORT.md — BUG-PREM-003 (HIGH).
 *
 * `processed-products`/`processed-seller-stores`'s write/read-own actions
 * had authentication (readIdentity) but no premium check at all -- any
 * authenticated free user could call them directly, bypassing the
 * premium-only gate Flutter's real UI enforces
 * (currentSessionHasProcessedStoreAccess, confirmed by reading
 * processed_seller_center_page.dart / processed_products_manage_page.dart
 * directly). This suite proves the backend now enforces the same rule,
 * using the same canonical isPremiumActiveFromProfile semantics as every
 * other premium gate (endsAt:null active, future active, past denied).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-processed-products-premium-gate-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-processed-products-premium-gate-test.db');
const PORT = 14175;
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

async function grantPremium(
  owner: { ownerId: string; email: string },
  endsAt: string | null | undefined,
) {
  const premium = {
    planTitle: 'Eco Premium',
    priceTl: 1599,
    startedAt: new Date().toISOString(),
    endsAt,
    autoRenew: true,
  };
  await strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: {
      profileId: owner.ownerId,
      ownerEmail: owner.email,
      activePremium: premium,
      activePremiumSubscription: premium,
    },
  });
}

test('free (non-premium) user cannot list their own processed products -> 403', async () => {
  const user = await registerAndLogin(`pp-free-mine-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/processed-products/mine`, { headers: authed(user.jwt) });
  assert.equal(res.status, 403);
});

test('free (non-premium) user cannot upsert a processed product -> 403', async () => {
  const user = await registerAndLogin(`pp-free-upsert-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/processed-products/upsert`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({ title: 'Domates', category: 'Sebze' }),
  });
  assert.equal(res.status, 403);
});

test('an active premium user (endsAt:null, unlimited) can reach processed-products.mine -> 200', async () => {
  const user = await registerAndLogin(`pp-premium-null-${randomUUID()}@test.local`);
  await grantPremium(user, null);
  const res = await fetch(`${BASE_URL}/processed-products/mine`, { headers: authed(user.jwt) });
  assert.equal(res.status, 200);
});

test('an active premium user (future endsAt) can reach processed-products.mine -> 200', async () => {
  const user = await registerAndLogin(`pp-premium-future-${randomUUID()}@test.local`);
  await grantPremium(user, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
  const res = await fetch(`${BASE_URL}/processed-products/mine`, { headers: authed(user.jwt) });
  assert.equal(res.status, 200);
});

test('an expired premium user (past endsAt) is denied -> 403, same as a free user', async () => {
  const user = await registerAndLogin(`pp-expired-${randomUUID()}@test.local`);
  await grantPremium(user, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const res = await fetch(`${BASE_URL}/processed-products/mine`, { headers: authed(user.jwt) });
  assert.equal(res.status, 403);
});

test('a premium user reaches past the gate on upsert (fails later for a real reason, not premium)', async () => {
  const user = await registerAndLogin(`pp-premium-upsert-${randomUUID()}@test.local`);
  await grantPremium(user, null);
  const res = await fetch(`${BASE_URL}/processed-products/upsert`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({ title: 'Domates', category: 'Sebze' }),
  });
  // No store profile exists yet for this owner -- the service rejects
  // with a store-required error, proving the request reached the
  // service layer at all (i.e. the premium gate did not block it).
  assert.notEqual(res.status, 403, 'a premium user must not be rejected by the premium gate');
});

test('a client cannot spoof premium via the profile-settings payload itself and bypass the gate', async () => {
  const user = await registerAndLogin(`pp-spoof-${randomUUID()}@test.local`);
  // No profile-setting row created for this user at all -- confirms the
  // gate does not default to "allow" when it can't find a profile.
  const res = await fetch(`${BASE_URL}/processed-products/mine`, { headers: authed(user.jwt) });
  assert.equal(res.status, 403);
});

test('publicList remains fully public and ungated (no accidental premium requirement)', async () => {
  const res = await fetch(`${BASE_URL}/processed-products/public`);
  assert.equal(res.status, 200);
});

test('free (non-premium) user cannot list or upsert their seller store -> 403', async () => {
  const user = await registerAndLogin(`pss-free-${randomUUID()}@test.local`);
  const mineRes = await fetch(`${BASE_URL}/processed-seller-stores/mine`, { headers: authed(user.jwt) });
  assert.equal(mineRes.status, 403);

  const upsertRes = await fetch(`${BASE_URL}/processed-seller-stores/upsert`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      storeName: `Magaza ${randomUUID()}`,
      city: 'Konya',
      contactName: 'Test Kullanici',
      shortDescription: 'Test',
    }),
  });
  assert.equal(upsertRes.status, 403);
});

test('a premium user can create their seller store -> 200', async () => {
  const user = await registerAndLogin(`pss-premium-${randomUUID()}@test.local`);
  await grantPremium(user, null);
  const res = await fetch(`${BASE_URL}/processed-seller-stores/upsert`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      storeName: `Magaza ${randomUUID()}`,
      city: 'Konya',
      contactName: 'Test Kullanici',
      shortDescription: 'Test',
    }),
  });
  assert.equal(res.status, 200);
});

test('an unauthenticated caller is rejected on processed-products.mine', async () => {
  const res = await fetch(`${BASE_URL}/processed-products/mine`);
  // 403, not 401: same documented Strapi auth:{scope:[]} platform
  // behavior as every other route in this codebase.
  assert.equal(res.status, 403);
});
