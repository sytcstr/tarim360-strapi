/**
 * "Paketler ve Fiyatlar" / TestFlight follow-up (THIRD PASS).
 *
 * On a REAL production deployment, a verified Apple SANDBOX transaction is
 * rejected outright (`purchase-security.integration.test.ts` proves this,
 * extensively, with the flag below left unset -- the real default). That is
 * correct: this backend has no separate sandbox entitlement store, and
 * TestFlight/App Store share the exact same tables there.
 *
 * This file simulates the OTHER, explicitly opted-in half: a genuinely
 * SEPARATE deployment (its own process, its own throwaway SQLite file --
 * never the production database) that sets
 * `PURCHASE_ALLOW_SANDBOX_ENTITLEMENTS=true` so a TestFlight build pointed
 * AT THIS DEPLOYMENT can validate Premium, doping (rocket) and the
 * normal-listing quota purchases end-to-end. `allowSandboxPurchaseEntitlements()`
 * (config.ts) also requires NODE_ENV to be exactly `development`/`test` --
 * set explicitly below, exactly like this suite's own real deployment would
 * need (Strapi's own `production` NODE_ENV, what the real backend runs
 * under, would ignore this flag even if it were accidentally set there).
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file, port 14268 -- distinct from every other integration suite's
 * own file/port, see before() below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const FIX = path.join(__dirname, '..', 'fixtures', 'apple-test-chain');
const pem = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const der = (f: string) => new crypto.X509Certificate(pem(f)).raw.toString('base64');
const rootFp = new crypto.X509Certificate(pem('root.pem')).fingerprint256.replace(/[^0-9A-F]/gi, '').toUpperCase();
const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');
const BUNDLE = 'com.tarim360.app';

process.env.APPLE_BUNDLE_ID = BUNDLE;
process.env.APPLE_TRUSTED_ROOT_SHA256 = rootFp;
delete process.env.PURCHASE_WEBHOOK_SECRET;
delete process.env.PURCHASE_VERIFY_SOFT;
// The two things that, together, make this a safe "test backend": an
// explicit dev/test NODE_ENV (never what the real production deployment
// runs under) and the explicit opt-in flag itself. Neither alone is
// enough -- see allowSandboxPurchaseEntitlements()'s own doc comment.
process.env.NODE_ENV = 'test';
process.env.PURCHASE_ALLOW_SANDBOX_ENTITLEMENTS = 'true';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-purchase-sandbox-test-backend.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-purchase-sandbox-test-backend.db');
const PORT = 14268;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

let strapiInstance: any;

const jws = (payload: object) => {
  const h = b64u(JSON.stringify({ alg: 'ES256', x5c: [der('leaf.pem'), der('intermediate.pem'), der('root.pem')] }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${b64u(crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: pem('leaf.key'), dsaEncoding: 'ieee-p1363' }))}`;
};

before(async () => {
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = String(PORT);
  const compiled = await compileStrapi();
  strapiInstance = await createStrapi(compiled).load();
  await strapiInstance.server.listen(PORT);
  // Re-assert after boot -- see purchase-security.integration.test.ts's own
  // identical comment: Strapi may touch NODE_ENV internally during load.
  process.env.NODE_ENV = 'test';
});

after(async () => {
  await strapiInstance?.server?.close?.();
  await strapiInstance?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

// ---- helpers ------------------------------------------------------------
const uid = () => crypto.randomUUID().slice(0, 8);
const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

const post = async (url: string, jwt: string | null, body: unknown) => {
  const res = await fetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function register(tag: string) {
  const email = `${tag}-${uid()}@test.local`;
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const body = await res.json();
  return { jwt: body.jwt as string, email, ownerId: `u_${email.toLowerCase().replace(/[^a-z0-9]/g, '_')}` };
}

const verify = (jwt: string, over: Record<string, unknown>) =>
  post('/purchases/verify', jwt, { categoryTitle: 'Premium', planTitle: 'Plan', priceTl: 1, isSubscription: true, ...over });

const premiumOf = async (ownerId: string) => {
  const row = await strapiInstance.db.query('api::profile-setting.profile-setting').findOne({ where: { profileId: ownerId } });
  return (row?.activePremium ?? null) as any;
};
const isActive = (p: any) => !!p && new Date(p.endsAt).getTime() > Date.now();

const appleTransactionJws = (productId: string, days: number, orig = `100${uid()}`, over: { transactionId?: string } = {}) => {
  const transactionId = over.transactionId ?? `T${orig}`;
  const receipt = jws({
    transactionId,
    originalTransactionId: orig,
    productId,
    bundleId: BUNDLE,
    expiresDate: Date.now() + days * 86_400_000,
    environment: 'Sandbox',
  });
  return { receipt, orig, transactionId };
};

const appleProductionJws = (productId: string, days: number, orig = `100${uid()}`) => {
  const transactionId = `T${orig}`;
  const receipt = jws({
    transactionId,
    originalTransactionId: orig,
    productId,
    bundleId: BUNDLE,
    expiresDate: Date.now() + days * 86_400_000,
    environment: 'Production',
  });
  return { receipt, orig, transactionId };
};

function listingPayload(overrides: Record<string, unknown> = {}) {
  return { title: 'Sandbox Backend Test Ilani', mainType: 'bitkisel', mode: 'sell', price: 100, location: 'Konya', ...overrides };
}

async function createListing(jwt: string, operationId: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { ...listingPayload(overrides), operationId } }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createOwnedListing(owner: { ownerId: string; email: string }, overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::listing.listing', {
    data: {
      title: 'Sandbox Backend Rocket Test',
      mainType: 'Tahil',
      price: 100,
      ownerProfileId: owner.ownerId,
      ownerId: owner.ownerId,
      ownerEmail: owner.email,
      listingStatus: 'active',
      isDoping: false,
      publishedAt: new Date().toISOString(),
      ...overrides,
    },
  });
}

const activateRocket = (jwt: string, listingId: string, days: number, operationId: string) =>
  fetch(`${BASE_URL}/listings/${listingId}/rocket/activate`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ days, operationId }),
  });

// ---- tests ----------------------------------------------------------------

test('on this opted-in test backend, a verified SANDBOX Apple Premium purchase grants a (tagged) entitlement end-to-end', async () => {
  const tester = await register('tb-premium');
  const sandbox = appleTransactionJws('pro_premium_12ay', 30, `tb900${uid()}`);
  const r = await verify(tester.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: sandbox.receipt, transactionId: sandbox.transactionId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.verified, true, JSON.stringify(r.body));
  const premium = await premiumOf(tester.ownerId);
  assert.ok(isActive(premium), 'the test backend must actually grant the entitlement, not just verify the store transaction');
  assert.equal(premium.sourceEnvironment, 'sandbox', 'still tagged, even though it was allowed to apply');
});

test('on this opted-in test backend, a verified SANDBOX doping purchase actually activates a rocket boost', async () => {
  const owner = await register('tb-doping');
  const sandbox = appleTransactionJws('doping_7_189', 1, `tb901${uid()}`);
  const r = await verify(owner.jwt, { productId: 'doping_7_189', platform: 'ios', receipt: sandbox.receipt, transactionId: sandbox.transactionId, isSubscription: false });
  assert.equal(r.body.verified, true, JSON.stringify(r.body));

  const listing = await createOwnedListing(owner);
  const activated = await activateRocket(owner.jwt, listing.documentId, 7, crypto.randomUUID());
  assert.equal(activated.status, 200, JSON.stringify(await activated.json().catch(() => ({}))));
  const row = await strapiInstance.db.query('api::listing.listing').findOne({ where: { documentId: listing.documentId, publishedAt: { $notNull: true } } } as any);
  assert.equal(row.isDoping, true, 'the sandbox-verified doping purchase must actually be usable to activate the rocket on this test backend');
});

test('on this opted-in test backend, a verified SANDBOX normal-listing-quota purchase actually raises the real allowed listing count', async () => {
  const user = await register('tb-quota');
  for (let i = 0; i < 5; i++) {
    const res = await createListing(user.jwt, crypto.randomUUID(), { title: `TB Quota Free ${i}-${uid()}` });
    assert.equal(res.status, 201);
  }
  const sixthBeforePurchase = await createListing(user.jwt, crypto.randomUUID(), { title: `TB Quota Blocked ${uid()}` });
  assert.equal(sixthBeforePurchase.status, 403, 'still blocked before any quota-pack purchase');

  const sandbox = appleTransactionJws('normal_listing_5_399', 1, `tb902${uid()}`);
  const r = await verify(user.jwt, { productId: 'normal_listing_5_399', platform: 'ios', receipt: sandbox.receipt, transactionId: sandbox.transactionId, isSubscription: false });
  assert.equal(r.body.verified, true, JSON.stringify(r.body));

  const sixthAfterPurchase = await createListing(user.jwt, crypto.randomUUID(), { title: `TB Quota Allowed ${uid()}` });
  assert.equal(sixthAfterPurchase.status, 201, 'the sandbox-verified quota-pack purchase must actually raise the real allowed count on this test backend');
});

test('on this opted-in test backend, a genuine PRODUCTION Apple Premium purchase still verifies and grants normally (opting in to sandbox testability does not break real purchases)', async () => {
  const tester = await register('tb-prod-regress');
  const prod = appleProductionJws('pro_premium_12ay', 30, `tb903${uid()}`);
  const r = await verify(tester.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: prod.receipt, transactionId: prod.transactionId });
  assert.equal(r.body.verified, true, JSON.stringify(r.body));
  const premium = await premiumOf(tester.ownerId);
  assert.ok(isActive(premium));
  assert.equal(premium.sourceEnvironment, 'production');
});
