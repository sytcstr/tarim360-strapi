/**
 * PUB-PROFILE-B — public profile read contract.
 *
 * Covers GET /public-profiles/:ownerId (services/public-profile.ts,
 * controllers/public-profile.ts, routes/public-profile.ts): the narrow,
 * allowlisted replacement for the "view someone else's profile" read path
 * that SEC-1 correctly closed (that path relied on a broken ownership
 * policy that happened to leak the target's full document -- see
 * PROFILE_SETTING_OWNERSHIP_SEC1_REPORT.md).
 *
 * Also re-confirms, in this same suite, that SEC-1's fix is untouched by
 * this phase: GET /profile-settings (filtered) must still only ever
 * return the caller's own document.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-public-profile-read-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-public-profile-read-test.db');
const PORT = 14157;
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

async function createOwnProfileSetting(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/profile-settings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { displayName: 'Test Profil', ...overrides } }),
  });
  const json = await res.json();
  return json.data;
}

async function setupProfile(email: string, overrides: Record<string, unknown> = {}) {
  const jwt = await registerAndLogin(email);
  const profile = await createOwnProfileSetting(jwt, overrides);
  return { jwt, profile };
}

test('an existing public profile resolves with the allowlisted display fields', async () => {
  const { profile } = await setupProfile(`pub-target-${randomUUID()}@test.local`, {
    displayName: 'Ayse Ciftci',
    city: 'Konya',
    bio: 'Merhaba, ben Ayse.',
    accountType: 'premium',
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.profile.ownerId, profile.profileId);
  assert.equal(body.profile.displayName, 'Ayse Ciftci');
  assert.equal(body.profile.city, 'Konya');
  assert.equal(body.profile.bio, 'Merhaba, ben Ayse.');
  assert.equal(body.profile.accountType, 'premium');
  assert.equal(body.contractVersion, '1');
});

test('a non-existent owner returns 404 NOT_FOUND', async () => {
  const res = await fetch(`${BASE_URL}/public-profiles/u_nobody_${randomUUID()}`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('response exposes exactly the allowlisted fields -- nothing else', async () => {
  const { profile } = await setupProfile(`pub-fields-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(new Set(Object.keys(body)), new Set(['success', 'profile', 'contractVersion']));
  assert.deepEqual(
    new Set(Object.keys(body.profile)),
    new Set([
      'ownerId', 'displayName', 'publicUsername', 'brandName', 'city', 'bio', 'aboutText',
      'logisticsAboutText', 'accountType', 'avatarUrl', 'coverUrl', 'coverFocusY', 'avatarZoom',
      'showcasePinnedIds', 'showcasePinnedOrder', 'ratingAverage', 'ratingCount',
    ]),
  );
});

test('phone, email, and other private fields never leak into the response', async () => {
  const secretPhone = `secret-phone-${randomUUID()}`;
  const secretEmail = `secret-${randomUUID()}@private.local`;
  const { profile } = await setupProfile(`pub-privacy-${randomUUID()}@test.local`, {
    phone: secretPhone,
    ownerEmail: secretEmail,
    whatsapp: 'secret-whatsapp-999',
    birthDate: '1990-01-01',
    favoriteListingIds: ['listing-1', 'listing-2'],
    followerIds: ['u_someone'],
    fcmTokens: ['device-token-xyz'],
    settings: { pushEnabled: true, secretFlag: 'do-not-leak' },
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const raw = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!raw.includes(secretPhone), 'phone must never leak');
  assert.ok(!raw.includes(secretEmail), 'email must never leak');
  assert.ok(!raw.includes('secret-whatsapp-999'), 'whatsapp must never leak');
  assert.ok(!raw.includes('1990-01-01'), 'birthDate must never leak');
  assert.ok(!raw.includes('listing-1'), 'favorite listing ids must never leak');
  assert.ok(!raw.includes('u_someone'), 'follower ids must never leak');
  assert.ok(!raw.includes('device-token-xyz'), 'fcm tokens must never leak');
  assert.ok(!raw.includes('do-not-leak'), 'notification/app settings must never leak');
});

test('rating average/count is computed from base + dynamic votes, never the raw vote map', async () => {
  const targetJwt = await registerAndLogin(`pub-rating-target-${randomUUID()}@test.local`);
  const target = await createOwnProfileSetting(targetJwt);
  const voterAJwt = await registerAndLogin(`pub-rating-voter-a-${randomUUID()}@test.local`);
  const voterA = await createOwnProfileSetting(voterAJwt);
  const voterBJwt = await registerAndLogin(`pub-rating-voter-b-${randomUUID()}@test.local`);
  const voterB = await createOwnProfileSetting(voterBJwt);

  // Directly seed rating votes on the target's own row (bypassing the app's
  // own broken cross-profile rating sync, irrelevant here -- this test only
  // needs a known ratingVotesByViewer map to verify the aggregation math).
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: target.profileId },
    data: {
      ratingBaseCount: 2,
      ratingBaseAverage: 4,
      ratingVotesByViewer: { [voterA.profileId]: 5, [voterB.profileId]: 3 },
    },
  });

  const res = await fetch(`${BASE_URL}/public-profiles/${target.profileId}`);
  const body = await res.json();
  // base: 2 votes averaging 4 (sum 8). dynamic: 5 + 3 = 8 across 2 votes.
  // total: (8 + 8) / 4 = 4.
  assert.equal(body.profile.ratingCount, 4);
  assert.equal(body.profile.ratingAverage, 4);
  const raw = await (await fetch(`${BASE_URL}/public-profiles/${target.profileId}`)).text();
  assert.ok(!raw.includes(voterA.profileId), 'the raw per-viewer vote map must never be exposed');
});

test('showcasePinnedIds/showcasePinnedOrder pass through for the visitor-facing listing order', async () => {
  const { profile } = await setupProfile(`pub-showcase-${randomUUID()}@test.local`, {
    showcasePinnedIds: ['listing-A', 'listing-B'],
    showcasePinnedOrder: '{"all":["listing-A","listing-B"]}',
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.deepEqual(body.profile.showcasePinnedIds, ['listing-A', 'listing-B']);
  assert.equal(body.profile.showcasePinnedOrder, '{"all":["listing-A","listing-B"]}');
});

test('accountType defaults to "standard" when unset', async () => {
  const { profile } = await setupProfile(`pub-default-account-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(body.profile.accountType, 'standard');
});

test('reachable without any Authorization header (guest profile viewing must keep working)', async () => {
  const { profile } = await setupProfile(`pub-guest-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`, {
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
});

test('resolves identically when called by a different logged-in user (non-owner)', async () => {
  const { profile } = await setupProfile(`pub-stranger-call-${randomUUID()}@test.local`);
  const strangerJwt = await registerAndLogin(`pub-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`, { headers: authed(strangerJwt) });
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------
// SEC-1 regression -- must stay closed
// ---------------------------------------------------------------------

test('regression: SEC-1 is not reopened -- GET /profile-settings (filtered) still only returns the caller\'s own document', async () => {
  const { profile: target } = await setupProfile(`pub-sec1-target-${randomUUID()}@test.local`, {
    phone: 'still-secret-phone',
  });
  const viewerJwt = await registerAndLogin(`pub-sec1-viewer-${randomUUID()}@test.local`);
  const res = await fetch(
    `${BASE_URL}/profile-settings?filters[profileId][\$eq]=${encodeURIComponent(target.profileId)}`,
    { headers: authed(viewerJwt) },
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.data, [], 'a viewer with no own document must still get an empty list, never the target\'s row');
});
