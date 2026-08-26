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
      'showcasePinnedIds', 'showcasePinnedOrder', 'ratingAverage', 'ratingCount', 'isPremium',
    ]),
  );
});

// ---------------------------------------------------------------------
// BUG-002 fix -- public isPremium boolean (PROFILE_RELEASE_AUDIT.md,
// PROFILE_BUG002_PUBLIC_PREMIUM_FIX_REPORT.md)
// ---------------------------------------------------------------------

test('isPremium: no activePremium/activePremiumSubscription payload -> false', async () => {
  const { profile } = await setupProfile(`pub-premium-none-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.profile.isPremium, false);
});

test('isPremium: activePremium with no endsAt (unlimited grant) -> true', async () => {
  const { profile } = await setupProfile(`pub-premium-unlimited-${randomUUID()}@test.local`);
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: profile.profileId },
    data: { activePremium: { planTitle: 'Yillik' }, activePremiumSubscription: { planTitle: 'Yillik' } },
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(body.profile.isPremium, true);
});

test('isPremium: activePremium.endsAt in the future -> true', async () => {
  const { profile } = await setupProfile(`pub-premium-future-${randomUUID()}@test.local`);
  const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: profile.profileId },
    data: { activePremium: { endsAt }, activePremiumSubscription: { endsAt } },
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(body.profile.isPremium, true);
});

test('isPremium: activePremium.endsAt in the past -> false', async () => {
  const { profile } = await setupProfile(`pub-premium-past-${randomUUID()}@test.local`);
  const endsAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: profile.profileId },
    data: { activePremium: { endsAt }, activePremiumSubscription: { endsAt } },
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(body.profile.isPremium, false);
});

test('isPremium: computed from a stranger (non-owner) caller identically to a guest caller', async () => {
  const { profile } = await setupProfile(`pub-premium-stranger-${randomUUID()}@test.local`);
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: profile.profileId },
    data: { activePremium: { planTitle: 'Yillik' }, activePremiumSubscription: { planTitle: 'Yillik' } },
  });
  const strangerJwt = await registerAndLogin(`pub-premium-stranger-viewer-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`, { headers: authed(strangerJwt) });
  const body = await res.json();
  assert.equal(body.profile.isPremium, true);
});

test('the raw activePremium/activePremiumSubscription payload never leaks into the response, premium or not', async () => {
  const { profile } = await setupProfile(`pub-premium-privacy-${randomUUID()}@test.local`);
  const secretPlanTitle = `secret-plan-${randomUUID()}`;
  const secretTransactionId = `secret-txn-${randomUUID()}`;
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: profile.profileId },
    data: {
      activePremium: {
        planTitle: secretPlanTitle,
        priceTl: 999,
        transactionId: secretTransactionId,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: null,
      },
      activePremiumSubscription: {
        planTitle: secretPlanTitle,
        priceTl: 999,
        transactionId: secretTransactionId,
      },
    },
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.profile.isPremium, true, 'the boolean itself must still resolve correctly');
  assert.equal(body.profile.activePremium, undefined, 'activePremium must never be a response key');
  assert.equal(body.profile.activePremiumSubscription, undefined, 'activePremiumSubscription must never be a response key');
  assert.ok(!raw.includes(secretPlanTitle), 'planTitle must never leak');
  assert.ok(!raw.includes('999'), 'price must never leak');
  assert.ok(!raw.includes(secretTransactionId), 'transactionId must never leak');
  assert.ok(!raw.includes('startsAt'), 'startsAt must never leak');
  assert.ok(!raw.includes('activePremium'), 'the field name itself must never appear in the response body');
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

// ---------------------------------------------------------------------
// LISTING_L7_SELLER_CONTACT_PRIVACY_REPORT.md L7.3/L7.4: phone/whatsapp
// opt-in visibility. The default-off case is already covered by "phone,
// email, and other private fields never leak into the response" above
// (unmodified by this phase) -- these cover the new opt-in path.
// ---------------------------------------------------------------------

test('phone appears in the response only when contactPhoneVisible is explicitly true', async () => {
  const { profile } = await setupProfile(`pub-phone-visible-${randomUUID()}@test.local`, {
    phone: '05551234567',
    contactPhoneVisible: true,
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.profile.phone, '05551234567');
});

test('whatsapp appears in the response only when contactWhatsappVisible is explicitly true', async () => {
  const { profile } = await setupProfile(`pub-whatsapp-visible-${randomUUID()}@test.local`, {
    whatsapp: '905551234567',
    contactWhatsappVisible: true,
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.profile.whatsapp, '905551234567');
});

test('contactPhoneVisible:true with no phone on file omits the key rather than an empty string', async () => {
  const { profile } = await setupProfile(`pub-phone-empty-${randomUUID()}@test.local`, {
    contactPhoneVisible: true,
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.profile.phone, undefined);
});

test('an explicit contactPhoneVisible:false still hides a real phone value (opt-out is safe, not just default)', async () => {
  const { profile } = await setupProfile(`pub-phone-explicit-off-${randomUUID()}@test.local`, {
    phone: '05559876543',
    contactPhoneVisible: false,
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const raw = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!raw.includes('05559876543'));
});

test('phone visibility and whatsapp visibility are independent toggles', async () => {
  const { profile } = await setupProfile(`pub-independent-${randomUUID()}@test.local`, {
    phone: '05551112233',
    whatsapp: '905551112233',
    contactPhoneVisible: true,
    contactWhatsappVisible: false,
  });
  const res = await fetch(`${BASE_URL}/public-profiles/${profile.profileId}`);
  const body = await res.json();
  assert.equal(body.profile.phone, '05551112233');
  assert.equal(body.profile.whatsapp, undefined);
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
