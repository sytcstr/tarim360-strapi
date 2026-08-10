/**
 * SEMANTIC_CONTRACT_S1 — premium activation semantics, unified.
 *
 * Root cause: premium-sync.ts's isPremiumActiveFromProfile is the
 * canonical backend rule (missing endsAt = active/unlimited, matching
 * Flutter's own PurchaseSubscription.isCurrentlyActive after the earlier
 * `fix(premium): align premium parsing with backend contract` commit).
 * Three other backend gates independently reimplemented "is premium
 * active" with the OPPOSITE rule for a missing endsAt (denied instead of
 * active): ai.ts's hasActiveAiAccess, require-logistics-premium.ts's
 * hasActivePremium, and listing.ts's hasActivePremiumExpiry. A fourth was
 * found via a repo-wide grep for other endsAt/Date.now premium
 * implementations: promo.ts's buildSubscriptionPayload, which decides
 * whether to extend or replace a member's premium on promo-code
 * redemption. All four now delegate to isPremiumActiveFromProfile. See
 * SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-premium-gates-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-premium-gates-test.db');
const PORT = 14161;
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

const ownerIdFromEmail = (email: string): string =>
  `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

async function registerAndLogin(email: string): Promise<{ jwt: string; ownerId: string; userId: number }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return { jwt: json.jwt, ownerId: ownerIdFromEmail(email), userId: json.user.id };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

/**
 * Creates the profile-setting row all three gates look a member up by,
 * covering every lookup strategy the three files actually use (ai.ts:
 * profileId only; listing.ts: profileId OR ownerEmail; require-logistics-
 * premium.ts: ownerEmail OR profileId===String(userId)) so one fixture
 * genuinely exercises all of them.
 */
async function setProfilePremium(
  email: string,
  ownerId: string,
  premium: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) {
  return strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: {
      profileId: ownerId,
      ownerEmail: email,
      activePremium: premium,
      activePremiumSubscription: premium,
      ...extra,
    },
  });
}

const future = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------
// AI Assistant gate (ai.ts's hasActiveAiAccess / ensureAiAccess)
// ---------------------------------------------------------------------

test('AI gate: endsAt in the future grants access', async () => {
  const email = `ai-future-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, {
    planTitle: 'Premium Pro',
    hasAiAssistant: true,
    endsAt: future(),
  });
  const res = await fetch(`${BASE_URL}/ai/usage-summary`, { headers: authed(jwt) });
  assert.equal(res.status, 200);
});

test('AI gate: endsAt missing entirely grants access (unlimited)', async () => {
  const email = `ai-unlimited-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, {
    planTitle: 'Premium Pro',
    hasAiAssistant: true,
  });
  const res = await fetch(`${BASE_URL}/ai/usage-summary`, { headers: authed(jwt) });
  assert.equal(res.status, 200, 'a missing endsAt must be treated as active/unlimited, matching premium-sync.ts');
});

test('AI gate: endsAt in the past denies access (403)', async () => {
  const email = `ai-past-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, {
    planTitle: 'Premium Pro',
    hasAiAssistant: true,
    endsAt: past(),
  });
  const res = await fetch(`${BASE_URL}/ai/usage-summary`, { headers: authed(jwt) });
  assert.equal(res.status, 403);
});

test('AI gate: no premium payload at all denies access (403)', async () => {
  const email = `ai-none-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, null);
  const res = await fetch(`${BASE_URL}/ai/usage-summary`, { headers: authed(jwt) });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------
// Logistics premium module gate (require-logistics-premium.ts, enforced
// on POST /logistics-loads)
// ---------------------------------------------------------------------

async function attemptCreateLoad(jwt: string) {
  return fetch(`${BASE_URL}/logistics-loads`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Gate Test Yuku',
        loadType: 'Tarimsal Urun',
        fromCity: 'Konya',
        toCity: 'Ankara',
        weight: 12,
        vehicleType: 'Kamyon',
        loadingDate: new Date().toISOString(),
        latitude: 39.9,
        longitude: 32.8,
        fromLatitude: 37.87,
        fromLongitude: 32.48,
        toLatitude: 39.9,
        toLongitude: 32.8,
      },
    }),
  });
}

test('logistics premium gate: missing endsAt with the Logistics module grants access', async () => {
  const email = `log-unlimited-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, { planTitle: 'Premium Lojistik' }, {
    activeModules: ['logistics'],
  });
  const res = await attemptCreateLoad(jwt);
  assert.equal(res.status, 200, 'a missing endsAt must be treated as active/unlimited, matching premium-sync.ts');
});

test('logistics premium gate: endsAt in the future grants access', async () => {
  const email = `log-future-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, { planTitle: 'Premium Lojistik', endsAt: future() }, {
    activeModules: ['logistics'],
  });
  const res = await attemptCreateLoad(jwt);
  assert.equal(res.status, 200);
});

test('logistics premium gate: endsAt in the past denies access (403)', async () => {
  const email = `log-past-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, { planTitle: 'Premium Lojistik', endsAt: past() }, {
    activeModules: ['logistics'],
  });
  const res = await attemptCreateLoad(jwt);
  assert.equal(res.status, 403);
});

test('logistics premium gate: no premium at all denies access (403)', async () => {
  const email = `log-none-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, null, { activeModules: ['logistics'] });
  const res = await attemptCreateLoad(jwt);
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------
// Listing premium stamp (listing.ts's hasActivePremiumExpiry, applied at
// creation time to isPremium/isPremiumOwner)
// ---------------------------------------------------------------------

async function createListingAs(jwt: string) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Gate Test Ilani',
        mainType: 'bitkisel',
        mode: 'sell',
        location: 'Konya',
      },
    }),
  });
  return res.json();
}

test('listing premium stamp: missing endsAt stamps isPremium:true (unlimited)', async () => {
  const email = `list-unlimited-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, { planTitle: 'Premium' });
  const body = await createListingAs(jwt);
  assert.equal(body.data.isPremium, true, 'a missing endsAt must be treated as active/unlimited, matching premium-sync.ts');
  assert.equal(body.data.isPremiumOwner, true);
});

test('listing premium stamp: endsAt in the future stamps isPremium:true', async () => {
  const email = `list-future-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, { planTitle: 'Premium', endsAt: future() });
  const body = await createListingAs(jwt);
  assert.equal(body.data.isPremium, true);
});

test('listing premium stamp: endsAt in the past stamps isPremium:false', async () => {
  const email = `list-past-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, { planTitle: 'Premium', endsAt: past() });
  const body = await createListingAs(jwt);
  assert.equal(body.data.isPremium, false);
});

test('listing premium stamp: no premium at all stamps isPremium:false', async () => {
  const email = `list-none-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, null);
  const body = await createListingAs(jwt);
  assert.equal(body.data.isPremium, false);
});

// ---------------------------------------------------------------------
// Promo-code redemption (promo.ts's buildSubscriptionPayload) --
// extending an unlimited (missing-endsAt) premium must not crash and
// must not silently downgrade the member to a fixed-date plan.
// ---------------------------------------------------------------------

async function createPromoCode(overrides: Record<string, unknown> = {}) {
  const code = `TEST${randomUUID().slice(0, 8).toUpperCase()}`;
  return strapiInstance.entityService.create('api::promo-code.promo-code', {
    data: {
      code,
      codeNormalized: code,
      title: 'Test Promo',
      premiumProductId: 'premium_easy_yearly_999',
      isActive: true,
      usageLimit: 100,
      perUserLimit: 100,
      allowWhenPremiumActive: true,
      ...overrides,
    },
  });
}

test('promo redemption: extending an unlimited (missing endsAt) premium does not crash and stays unlimited', async () => {
  const email = `promo-unlimited-${randomUUID()}@test.local`;
  const { jwt, ownerId } = await registerAndLogin(email);
  await setProfilePremium(email, ownerId, {
    planTitle: 'Premium',
    priceTl: 999,
    // deliberately no endsAt
  });
  const promo = await createPromoCode();
  const res = await fetch(`${BASE_URL}/promos/redeem`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ code: promo.code }),
  });
  assert.equal(res.status, 200, 'must not crash (TypeError on null currentEndsAt.getTime()) when extending an unlimited grant');
  const row = await strapiInstance.db
    .query('api::profile-setting.profile-setting')
    .findOne({ where: { profileId: ownerId } } as any);
  const nextPremium = (row as any)?.activePremium;
  assert.equal(
    nextPremium?.endsAt ?? null,
    null,
    'an unlimited grant must stay unlimited, not be narrowed to a fixed date',
  );
});
