/**
 * Purchase security (full-app reconciliation P0/P1, measured in production):
 *  - PURCHASE_VERIFY_SOFT was effectively ON in production: a fake receipt granted paid Premium.
 *  - One genuine purchase could be replayed onto other accounts.
 *  - A cheap subscription could be presented as a more expensive plan.
 *  - The webhooks trusted a static header secret no store can send, decoded Apple's JWS without
 *    verifying it, and derived entitlement dates from stale stored data.
 *
 * Google's network is intercepted (globalThis.fetch). Apple purchase/webhook
 * verification (UAT #14 fix) is local JWS chain-verification with no network
 * call at all, so "faking Apple" here means signing test transactions with
 * the same test-only certificate chain the verifier trusts (below) --
 * everything else is the real app.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// ---- environment (read lazily by the purchase code) --------------------------------------
const FIX = path.join(__dirname, '..', 'fixtures', 'apple-test-chain');
const pem = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const der = (f: string) => new crypto.X509Certificate(pem(f)).raw.toString('base64');
const rootFp = new crypto.X509Certificate(pem('root.pem')).fingerprint256.replace(/[^0-9A-F]/gi, '').toUpperCase();
const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

const saKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const oidcKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const OIDC_KID = 'int-kid';
const PKG = 'com.tarim360.test';
const AUD = 'https://example.test/api/purchases/webhooks/google-play';
const PUSH_SA = 'pubsub-push@tarim360.iam.gserviceaccount.com';
const BUNDLE = 'com.tarim360.app';

process.env.GOOGLE_PLAY_PACKAGE_NAME = PKG;
process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL = 'play-verify@tarim360.iam.gserviceaccount.com';
process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = (saKey.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).replace(/\n/g, '\\n');
process.env.GOOGLE_PUBSUB_AUDIENCE = AUD;
process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL = PUSH_SA;
// APPLE_SHARED_SECRET is no longer read by verify() (UAT #14 fix: JWS-based,
// not the legacy shared-secret /verifyReceipt call) -- left unset deliberately
// so a stray future read of it in prod code would fail loudly, not silently.
process.env.APPLE_BUNDLE_ID = BUNDLE;
process.env.APPLE_TRUSTED_ROOT_SHA256 = rootFp;
delete process.env.PURCHASE_WEBHOOK_SECRET;
// Simulate the production misconfiguration: the soft-verify flag is ON for the whole run.
// It must be ignored everywhere except an explicit development/test NODE_ENV.
process.env.PURCHASE_VERIFY_SOFT = 'true';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-purchase-security-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-purchase-security-test.db');
const PORT = 14266;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

let strapiInstance: any;
const realFetch = globalThis.fetch;

// ---- fake Google / real (test-chain-signed) Apple ---------------------------------------
type GoogleSub = { subscriptionState: string; latestOrderId: string; lineItems: { productId: string; expiryTime: string }[]; linkedPurchaseToken?: string };
const googleSubs = new Map<string, GoogleSub>();
const googleProducts = new Map<string, { purchaseState: number; orderId: string }>();
let googleFailing = false;

// Apple verification (UAT #14 fix) is local JWS chain-verification, not a
// network call -- so "faking Apple" here means signing a transaction with the
// SAME test-only chain used by the webhook tests below, not intercepting fetch.
const jws = (payload: object, opts: { key?: string; x5c?: string[] } = {}) => {
  const h = b64u(JSON.stringify({ alg: 'ES256', x5c: opts.x5c ?? [der('leaf.pem'), der('intermediate.pem'), der('root.pem')] }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${b64u(crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: pem(opts.key ?? 'leaf.key'), dsaEncoding: 'ieee-p1363' }))}`;
};
const EVIL = { key: 'evil-leaf.key', x5c: [der('evil-leaf.pem'), der('evil-root.pem'), der('evil-root.pem')] };

const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

before(async () => {
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'fake-access-token' });
    if (u.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
      return json({ keys: [{ ...(oidcKey.publicKey.export({ format: 'jwk' }) as object), kid: OIDC_KID, alg: 'RS256' }] });
    }
    const subMatch = u.match(/purchases\/subscriptionsv2\/tokens\/([^/?]+)$/);
    if (subMatch) {
      if (googleFailing) return json({ error: 'boom' }, 500);
      const rec = googleSubs.get(decodeURIComponent(subMatch[1]));
      return rec ? json(rec) : json({ error: { message: 'invalid token' } }, 400);
    }
    const prodMatch = u.match(/purchases\/products\/([^/]+)\/tokens\/([^/?]+)$/);
    if (prodMatch) {
      const rec = googleProducts.get(decodeURIComponent(prodMatch[2]));
      return rec ? json(rec) : json({ error: { message: 'invalid token' } }, 400);
    }
    return realFetch(url, init);
  }) as typeof fetch;

  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = String(PORT);
  const compiled = await compileStrapi();
  strapiInstance = await createStrapi(compiled).load();
  await strapiInstance.server.listen(PORT);
  // Strapi defaults NODE_ENV to development inside the process. The whole file runs as PRODUCTION
  // (with the soft-verify flag ON, the misconfiguration seen in production); the dev-workflow test
  // flips to development locally.
  process.env.NODE_ENV = 'production';
});

after(async () => {
  globalThis.fetch = realFetch;
  await strapiInstance?.server?.close?.();
  await strapiInstance?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

beforeEach(() => {
  googleSubs.clear();
  googleProducts.clear();
  googleFailing = false;
});

// ---- helpers ---------------------------------------------------------------------------
const uid = () => crypto.randomUUID().slice(0, 8);
async function register(tag: string) {
  const email = `${tag}-${uid()}@test.local`;
  const res = await realFetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const body = await res.json();
  return { jwt: body.jwt as string, email, ownerId: `u_${email.toLowerCase().replace(/[^a-z0-9]/g, '_')}` };
}
const post = async (url: string, jwt: string | null, body: unknown, headers: Record<string, string> = {}) => {
  const res = await realFetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const verify = (jwt: string, over: Record<string, unknown>) =>
  post('/purchases/verify', jwt, { categoryTitle: 'Premium', planTitle: 'Plan', priceTl: 1, isSubscription: true, ...over });

const premiumOf = async (ownerId: string) => {
  const row = await strapiInstance.db.query('api::profile-setting.profile-setting').findOne({ where: { profileId: ownerId } });
  return (row?.activePremium ?? null) as any;
};
const eventsWithToken = (token: string) => strapiInstance.db.query('api::purchase-event.purchase-event').findMany({ where: { purchaseToken: token } });
const isActive = (p: any) => !!p && new Date(p.endsAt).getTime() > Date.now();

const googlePurchase = (token: string, productId: string, days: number, order = `GPA.${uid()}`) =>
  googleSubs.set(token, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: order, lineItems: [{ productId, expiryTime: isoIn(days) }] });

/** Builds a real, test-chain-signed StoreKit2 transaction JWS -- exactly the
 * shape `verifyApple` now decodes (UAT #14 fix), replacing the old fake
 * legacy-receipt-JSON fixture. Returns the JWS to send as `receipt`, plus the
 * `originalTransactionId`/`transactionId` the caller needs for assertions. */
const appleTransactionJws = (
  productId: string,
  days: number,
  orig = `100${uid()}`,
  over: { bundleId?: string; revoked?: number; environment?: string; transactionId?: string } = {},
) => {
  const transactionId = over.transactionId ?? `T${orig}`;
  // A real Apple StoreKit2 JWSTransaction ALWAYS carries `environment`
  // (it is a mandatory field) -- defaulting to 'Production' here when
  // the caller doesn't care keeps every pre-existing test an accurate
  // simulation of a genuine transaction. Pass `environment: ''`
  // explicitly to simulate the (never-genuinely-happens) missing-field
  // case for the environment-rejection tests specifically.
  const envValue = over.environment === undefined ? 'Production' : over.environment;
  const receipt = jws({
    transactionId,
    originalTransactionId: orig,
    productId,
    bundleId: over.bundleId ?? BUNDLE,
    expiresDate: Date.now() + days * 86_400_000,
    ...(over.revoked ? { revocationDate: over.revoked } : {}),
    ...(envValue ? { environment: envValue } : {}),
  });
  return { receipt, orig, transactionId };
};

// ======================================================================================
// A. Free premium: fake receipts, soft verify
// ======================================================================================
test('fake receipts never grant an entitlement (Google and Apple), whatever the claimed product', async () => {
  const u = await register('fake');
  for (const [platform, productId] of [['android', 'premium_pro_yearly_3599'], ['ios', 'pro_premium_12ay'], ['android', 'doping_7_189']] as const) {
    const r = await verify(u.jwt, { productId, platform, receipt: `fake-${uid()}`, transactionId: `tx-${uid()}`, isSubscription: !productId.startsWith('doping') });
    assert.notEqual(r.body.verified, true, `${platform} ${productId}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(await premiumOf(u.ownerId), null, 'no entitlement from fake receipts');
});

test('PURCHASE_VERIFY_SOFT is ignored outside development/test: a fake receipt gets NO entitlement even with the flag set', async () => {
  const u = await register('soft');
  const prevEnv = process.env.NODE_ENV;
  const prevSoft = process.env.PURCHASE_VERIFY_SOFT;
  try {
    process.env.PURCHASE_VERIFY_SOFT = 'true';
    for (const env of ['production', '', 'staging']) {
      if (env === '') delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      const r = await verify(u.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: `fake-${uid()}`, transactionId: `tx-${uid()}` });
      assert.notEqual(r.body.verified, true, `NODE_ENV=${env || '(unset)'}: ${JSON.stringify(r.body)}`);
      assert.notEqual(r.body.message, 'Soft verify aktif.');
    }
    assert.equal(await premiumOf(u.ownerId), null);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevSoft === undefined) delete process.env.PURCHASE_VERIFY_SOFT;
    else process.env.PURCHASE_VERIFY_SOFT = prevSoft;
  }
});

test('soft verify still works for local development (NODE_ENV=development) so the dev workflow is not broken', async () => {
  const u = await register('softdev');
  const prevEnv = process.env.NODE_ENV;
  const prevSoft = process.env.PURCHASE_VERIFY_SOFT;
  try {
    process.env.NODE_ENV = 'development';
    process.env.PURCHASE_VERIFY_SOFT = 'true';
    const r = await verify(u.jwt, { productId: 'premium_easy_yearly_999', platform: 'android', receipt: `dev-${uid()}`, transactionId: `tx-${uid()}` });
    assert.equal(r.body.verified, true);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
    if (prevSoft === undefined) delete process.env.PURCHASE_VERIFY_SOFT;
    else process.env.PURCHASE_VERIFY_SOFT = prevSoft;
  }
});

test('a client can never self-grant paid entitlement through profile-settings', async () => {
  const u = await register('selfgrant');
  const forged = { planTitle: 'Forged', endsAt: null, premiumProfileEnabled: true };
  const c = await post('/profile-settings', u.jwt, { data: { profileId: u.ownerId, activePremium: forged, activePremiumSubscription: forged, purchaseHistory: [{ transactionId: 'x' }] } });
  assert.ok(c.status === 200 || c.status === 201, JSON.stringify(c.body));
  assert.equal(await premiumOf(u.ownerId), null);
});

// ======================================================================================
// B. Valid purchase, idempotency, cross-account reuse, product substitution
// ======================================================================================
test('Google: valid purchase -> entitlement for A; same request again is idempotent (one event, no duplicate)', async () => {
  const A = await register('ga');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_easy_yearly_999', 30, 'GPA.1111');
  const body = { productId: 'premium_easy_yearly_999', platform: 'android', receipt: token, transactionId: 'GPA.1111' };
  const r1 = await verify(A.jwt, body);
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));
  const p = await premiumOf(A.ownerId);
  assert.ok(isActive(p));
  assert.ok(Math.abs(new Date(p.endsAt).getTime() - (Date.now() + 30 * 86_400_000)) < 120_000, 'expiry comes from Google, not a default');
  const r2 = await verify(A.jwt, body);
  assert.equal(r2.body.verified, true);
  assert.equal(r2.body.idempotent, true);
  assert.equal((await eventsWithToken(token)).length, 1);
});

test('Google: the SAME purchase token on account B is refused and B gets nothing -- even with a different client-chosen transaction id', async () => {
  const A = await register('ga2');
  const B = await register('gb2');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_pro_yearly_3599', 30, 'GPA.2222');
  assert.equal((await verify(A.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: token, transactionId: 'GPA.2222' })).body.verified, true);

  const sameTx = await verify(B.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: token, transactionId: 'GPA.2222' });
  const otherTx = await verify(B.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: token, transactionId: `attacker-chosen-${uid()}` });
  const noTx = await verify(B.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: token });
  const viaPurchaseToken = await verify(B.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: 'x', purchaseToken: token, transactionId: `y-${uid()}` });
  for (const r of [sameTx, otherTx, noTx, viaPurchaseToken]) assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(await premiumOf(B.ownerId), null, 'B must not receive an entitlement');
  const events = await eventsWithToken(token);
  assert.equal(events.length, 1);
  assert.equal(events[0].ownerProfileId, A.ownerId, "A's binding is not overwritten");
  assert.ok(isActive(await premiumOf(A.ownerId)), "A's entitlement is intact");
});

test('"Paketler ve Fiyatlar" follow-up: each 403 branch carries its own distinct reasonCode + correlationId, and never names the other account', async () => {
  const A = await register('rc-a');
  const B = await register('rc-b');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_pro_yearly_3599', 30, 'GPA.RC1');
  const first = await verify(A.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: token, transactionId: 'GPA.RC1' });
  assert.equal(first.body.verified, true, JSON.stringify(first.body));

  // Branch 1 (existing-event owner mismatch): same transactionId, B's JWT.
  const sameTx = await verify(B.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: token, transactionId: 'GPA.RC1' });
  assert.equal(sameTx.status, 403, JSON.stringify(sameTx.body));
  assert.equal(sameTx.body.error?.details?.reasonCode, 'owner_mismatch');
  assert.ok(sameTx.body.error?.details?.correlationId, 'a correlationId must be present');
  const sameTxDump = JSON.stringify(sameTx.body);
  assert.ok(!sameTxDump.includes(A.email), "B's rejection must never reveal A's email");
  assert.ok(!sameTxDump.includes(A.ownerId), "B's rejection must never reveal A's ownerId");

  // Branch 2: a brand-new client-chosen transactionId, but the SAME
  // underlying purchaseToken -- the provider is now verified FIRST
  // (this audit's own idempotency/lookup-scope fix), so Google's own
  // REAL order id for this token resolves to the SAME row A already
  // owns, and the EARLIER, more specific owner_mismatch check catches
  // it directly (a real improvement: this no longer depends on reaching
  // the later purchaseToken pre-check to be caught at all).
  const viaToken = await verify(B.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: 'x', purchaseToken: token, transactionId: `y-${uid()}` });
  assert.equal(viaToken.status, 403, JSON.stringify(viaToken.body));
  assert.equal(viaToken.body.error?.details?.reasonCode, 'owner_mismatch');
  assert.ok(viaToken.body.error?.details?.correlationId);
  const viaTokenDump = JSON.stringify(viaToken.body);
  assert.ok(!viaTokenDump.includes(A.email));
  assert.ok(!viaTokenDump.includes(A.ownerId));

  // Every request gets its OWN correlationId, even for the same conflict.
  assert.notEqual(sameTx.body.error.details.correlationId, viaToken.body.error.details.correlationId);
});

test('"Paketler ve Fiyatlar" follow-up: the identity-lock conflict branch (concurrent race) carries reasonCode=identity_conflict', async () => {
  const A = await register('rc-race-a');
  const B = await register('rc-race-b');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_eco_yearly_1599', 30, 'GPA.RC2');
  const mk = (jwt: string) => verify(jwt, { productId: 'premium_eco_yearly_1599', platform: 'android', receipt: token, transactionId: `c-${uid()}` });
  const [ra, rb] = await Promise.all([mk(A.jwt), mk(B.jwt)]);
  const winnerRes = ra.status === 200 ? ra : rb;
  const loserRes = ra.status === 200 ? rb : ra;
  assert.equal(winnerRes.status, 200, JSON.stringify(winnerRes.body));
  assert.equal(loserRes.status, 403, JSON.stringify(loserRes.body));
  // Depending on exact scheduling, the loser can be caught by the early
  // existing-row lookup, the purchaseToken pre-check, or the later
  // identity-lock check -- all three are genuine, correct conflict
  // detections of the same race; which one fires first is not
  // deterministic and is not the thing under test.
  assert.ok(
    ['owner_mismatch', 'token_conflict', 'identity_conflict'].includes(
      loserRes.body.error?.details?.reasonCode,
    ),
    JSON.stringify(loserRes.body),
  );
  assert.ok(loserRes.body.error?.details?.correlationId);
});

test('"Paketler ve Fiyatlar" follow-up: a successful verify (first-time and idempotent replay) also returns its own correlationId', async () => {
  const u = await register('corr-ok');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_easy_yearly_999', 30, 'GPA.CORR1');
  const body = { productId: 'premium_easy_yearly_999', platform: 'android', receipt: token, transactionId: 'GPA.CORR1' };
  const r1 = await verify(u.jwt, body);
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));
  assert.ok(r1.body.correlationId);
  const r2 = await verify(u.jwt, body);
  assert.equal(r2.body.idempotent, true, JSON.stringify(r2.body));
  assert.ok(r2.body.correlationId);
  assert.notEqual(
    r1.body.correlationId,
    r2.body.correlationId,
    'each request gets its own id even when the underlying transaction is the same',
  );
});

test('Google: concurrent verify of one purchase by two accounts binds exactly one of them', async () => {
  const A = await register('race-a');
  const B = await register('race-b');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_eco_yearly_1599', 30, 'GPA.3333');
  const mk = (jwt: string) => verify(jwt, { productId: 'premium_eco_yearly_1599', platform: 'android', receipt: token, transactionId: `c-${uid()}` });
  const [ra, rb] = await Promise.all([mk(A.jwt), mk(B.jwt)]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 403]);
  const events = await eventsWithToken(token);
  assert.equal(events.length, 1);
  const winner = ra.status === 200 ? A : B;
  const loser = ra.status === 200 ? B : A;
  assert.ok(isActive(await premiumOf(winner.ownerId)));
  assert.equal(await premiumOf(loser.ownerId), null);
});

test('Google: a cheap subscription cannot be presented as a more expensive plan (no product substitution)', async () => {
  const A = await register('sub');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_easy_yearly_999', 30);
  const r = await verify(A.jwt, { productId: 'premium_pro_yearly_3599', platform: 'android', receipt: token, transactionId: `t-${uid()}` });
  assert.notEqual(r.body.verified, true, JSON.stringify(r.body));
  assert.equal(await premiumOf(A.ownerId), null, 'no Pro entitlement from an Easy purchase');
});

test('Apple: valid (real signed StoreKit2 transaction) receipt -> entitlement for A; another account presenting the same receipt is refused', async () => {
  const A = await register('aa');
  const B = await register('ab');
  const { receipt, orig, transactionId } = appleTransactionJws('pro_premium_12ay', 30, '9000001');
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));
  assert.ok(isActive(await premiumOf(A.ownerId)));
  assert.equal((await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId })).body.idempotent, true);

  const rb = await verify(B.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId: `chosen-${uid()}` });
  assert.equal(rb.status, 403, JSON.stringify(rb.body));
  assert.equal(await premiumOf(B.ownerId), null);
  const owners = await strapiInstance.db.query('api::purchase-event.purchase-event').findMany({ where: { originalTransactionId: orig } });
  assert.deepEqual(owners.map((e: any) => e.ownerProfileId), [A.ownerId]);
});

test(
  '"Paketler ve Fiyatlar" follow-up (SECOND PASS): an Apple transaction with a MISSING or UNRECOGNIZED `environment` value is rejected outright -- no entitlement, no "verified" purchase-event row, never defaulted to production',
  async () => {
    const A = await register('env-missing-a');
    const missing = appleTransactionJws('pro_premium_12ay', 30, undefined, { environment: '' });
    const rMissing = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: missing.receipt, transactionId: missing.transactionId });
    assert.notEqual(rMissing.body.verified, true, JSON.stringify(rMissing.body));
    assert.equal(await premiumOf(A.ownerId), null);
    const rowMissing = await strapiInstance.db.query('api::purchase-event.purchase-event').findOne({ where: { transactionId: missing.transactionId } });
    assert.notEqual(rowMissing?.status, 'verified', 'no successful purchase-event for an unverifiable environment');

    const B = await register('env-bogus-b');
    const bogus = appleTransactionJws('pro_premium_12ay', 30, undefined, { environment: 'Xcode' });
    const rBogus = await verify(B.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: bogus.receipt, transactionId: bogus.transactionId });
    assert.notEqual(rBogus.body.verified, true, JSON.stringify(rBogus.body));
    assert.equal(await premiumOf(B.ownerId), null);
    const rowBogus = await strapiInstance.db.query('api::purchase-event.purchase-event').findOne({ where: { transactionId: bogus.transactionId } });
    assert.notEqual(rowBogus?.status, 'verified');
  },
);

test(
  '"Paketler ve Fiyatlar" follow-up (SECOND PASS -- corrects the first pass): a verified Apple SANDBOX transaction is rejected outright (no separate sandbox entitlement store exists) -- a REAL, active production Premium is left completely untouched',
  async () => {
    const A = await register('env-guard-a');

    const prod = appleTransactionJws('pro_premium_12ay', 300, `900guard${uid()}`, { environment: 'Production' });
    const rProd = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: prod.receipt, transactionId: prod.transactionId });
    assert.equal(rProd.body.verified, true, JSON.stringify(rProd.body));
    const premiumAfterProd = await premiumOf(A.ownerId);
    assert.ok(isActive(premiumAfterProd));
    const realEndsAt = premiumAfterProd.endsAt;

    const sandbox = appleTransactionJws('easy_premium_12ay', 1, `900guardsbx${uid()}`, { environment: 'Sandbox' });
    const rSandbox = await verify(A.jwt, { productId: 'easy_premium_12ay', platform: 'ios', receipt: sandbox.receipt, transactionId: sandbox.transactionId });
    assert.equal(rSandbox.status, 403, JSON.stringify(rSandbox.body));
    assert.equal(rSandbox.body.error?.details?.reasonCode, 'sandbox_unsupported');

    const premiumAfterSandbox = await premiumOf(A.ownerId);
    assert.ok(isActive(premiumAfterSandbox));
    assert.equal(premiumAfterSandbox.endsAt, realEndsAt, 'the rejected sandbox transaction must not have changed the real expiry at all');
    assert.equal(premiumAfterSandbox.planTitle, premiumAfterProd.planTitle, 'must still be the real PRO plan');
  },
);

test(
  '"Paketler ve Fiyatlar" follow-up (SECOND PASS): a verified Apple SANDBOX transaction is rejected for a production account with NO existing Premium at all -- it must never be silently granted just because nothing real exists yet',
  async () => {
    const tester = await register('env-guard-fresh');
    const sandbox = appleTransactionJws('pro_premium_12ay', 30, `900fresh${uid()}`, { environment: 'Sandbox' });
    const r = await verify(tester.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: sandbox.receipt, transactionId: sandbox.transactionId });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error?.details?.reasonCode, 'sandbox_unsupported');
    assert.equal(await premiumOf(tester.ownerId), null, 'a tester with no prior real Premium must NOT see one unlock from a sandbox purchase -- there is no sandbox entitlement store to safely credit it to');
  },
);

test(
  '"Paketler ve Fiyatlar" follow-up (SECOND PASS): a verified Apple SANDBOX transaction is rejected for a production account whose Premium has EXPIRED -- it must never silently revive/extend it',
  async () => {
    const tester = await register('env-guard-expired');
    const expired = appleTransactionJws('pro_premium_12ay', -5, `900expired${uid()}`, { environment: 'Production' });
    const rExpired = await verify(tester.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: expired.receipt, transactionId: expired.transactionId });
    // An already-expired transaction never grants anything either -- confirm the baseline before the real test.
    assert.equal(await premiumOf(tester.ownerId), null, 'sanity: an expired production transaction grants nothing by itself');

    const sandbox = appleTransactionJws('pro_premium_12ay', 60, `900expiredsbx${uid()}`, { environment: 'Sandbox' });
    const rSandbox = await verify(tester.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: sandbox.receipt, transactionId: sandbox.transactionId });
    assert.equal(rSandbox.status, 403, JSON.stringify(rSandbox.body));
    assert.equal(rSandbox.body.error?.details?.reasonCode, 'sandbox_unsupported');
    assert.equal(await premiumOf(tester.ownerId), null, 'a sandbox purchase must not revive/extend an expired real Premium');
    void rExpired;
  },
);

test(
  '"Paketler ve Fiyatlar" follow-up (SECOND PASS): a sandbox Apple transaction sharing a real production purchase\'s originalTransactionId is rejected before any lookup/conflict logic even runs -- the production purchase and its own ownership are completely unaffected',
  async () => {
    const A = await register('env-prod'); // real production buyer
    const B = await register('env-sbx-1'); // sandbox tester, unrelated account

    const sharedOrig = `900shared${uid()}`;
    const prod = appleTransactionJws('pro_premium_12ay', 30, sharedOrig, { environment: 'Production' });
    const rProd = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: prod.receipt, transactionId: prod.transactionId });
    assert.equal(rProd.body.verified, true, JSON.stringify(rProd.body));
    assert.ok(isActive(await premiumOf(A.ownerId)));
    const storedProd = await strapiInstance.db.query('api::purchase-event.purchase-event').findOne({ where: { transactionId: prod.transactionId } });
    assert.equal(storedProd?.storeEnvironment, 'production');

    const sandboxB = appleTransactionJws('pro_premium_12ay', 30, sharedOrig, {
      environment: 'Sandbox',
      transactionId: `TsandboxB${uid()}`,
    });
    const rSandboxB = await verify(B.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: sandboxB.receipt, transactionId: sandboxB.transactionId });
    // Rejected for being sandbox -- NOT for conflicting with A's row (it
    // never even reaches the conflict check), and B gets nothing.
    assert.equal(rSandboxB.status, 403, JSON.stringify(rSandboxB.body));
    assert.equal(rSandboxB.body.error?.details?.reasonCode, 'sandbox_unsupported');
    assert.equal(await premiumOf(B.ownerId), null);

    // A's real production entitlement, and the single purchase-event row
    // it owns, are completely untouched by B's rejected sandbox attempt.
    assert.ok(isActive(await premiumOf(A.ownerId)));
    const owners = await strapiInstance.db.query('api::purchase-event.purchase-event').findMany({ where: { originalTransactionId: sharedOrig } });
    assert.deepEqual(owners.map((e: any) => e.ownerProfileId), [A.ownerId]);
  },
);

test(
  '"Paketler ve Fiyatlar" follow-up (webhook path, defense-in-depth): a SANDBOX-tagged Apple Server Notification also cannot cancel/expire a real, active PRODUCTION Premium -- the guard is driven by the STORED row\'s own environment, never the notification\'s own (spoofable) claim',
  async () => {
    const A = await register('env-guard-webhook');

    // A's REAL production purchase -- active for a long time.
    const prod = appleTransactionJws('pro_premium_12ay', 300, `900wh${uid()}`, { environment: 'Production' });
    const rProd = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: prod.receipt, transactionId: prod.transactionId });
    assert.equal(rProd.body.verified, true, JSON.stringify(rProd.body));
    const realEndsAt = (await premiumOf(A.ownerId)).endsAt;

    // `verify()` itself now rejects sandbox transactions outright, so a
    // sandbox-tagged row can only exist as LEGACY data (persisted before
    // this fix) or from some other, not-yet-discovered write path --
    // simulated here with a direct DB insert, exactly what this guard
    // defends against either way.
    const sandboxOrig = `900whsbx${uid()}`;
    const sandboxTx = `Twhsbx${uid()}`;
    await strapiInstance.entityService.create('api::purchase-event.purchase-event', {
      data: {
        transactionId: sandboxTx,
        originalTransactionId: sandboxOrig,
        ownerEmail: A.email,
        ownerProfileId: A.ownerId,
        provider: 'app_store',
        productId: 'easy_premium_12ay',
        categoryTitle: 'Premium',
        planTitle: 'Kolay Premium',
        priceTl: 999,
        isSubscription: true,
        status: 'verified',
        verifiedAt: new Date().toISOString(),
        storeEnvironment: 'sandbox',
      },
    });
    assert.equal((await premiumOf(A.ownerId)).endsAt, realEndsAt, 'sanity: still untouched going into the webhook step');

    // Apple now sends a signed Server Notification for THAT sandbox row,
    // claiming a refund/revocation -- and, to prove the guard isn't
    // fooled by the notification's OWN claimed environment, the
    // notification itself falsely claims "Production".
    const revoke = await anote(sandboxOrig, { type: 'REFUND', env: 'Production', signedDate: Date.now() + 10, revoked: Date.now() });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));

    // A's REAL, active production Premium must be completely untouched --
    // the notification only ever had authority over the sandbox-tagged
    // row it named (looked up by its own stored environment), never over
    // the real one, regardless of what the notification itself claims.
    const after = await premiumOf(A.ownerId);
    assert.ok(isActive(after), 'a sandbox-tagged webhook notification must never cancel a real, active production Premium');
    assert.equal(after.endsAt, realEndsAt, 'real expiry must be exactly unchanged');
  },
);

test(
  '"Paketler ve Fiyatlar" follow-up: a legacy purchase-event row with no stored environment still conflicts against a REAL production transaction sharing its originalTransactionId (fail-safe, never silently exempted)',
  async () => {
    const A = await register('env-legacy-a');
    const B = await register('env-legacy-b');
    const orig = `900legacy${uid()}`;
    const { receipt, transactionId } = appleTransactionJws('pro_premium_12ay', 30, orig, { environment: 'Production' });
    const rA = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
    assert.equal(rA.body.verified, true, JSON.stringify(rA.body));
    // Simulate a row persisted before environment-tagging existed at all.
    await strapiInstance.db.query('api::purchase-event.purchase-event').update({
      where: { transactionId },
      data: { storeEnvironment: null },
    });

    // B presents a DISTINCT, genuinely PRODUCTION transaction that
    // happens to share the same originalTransactionId as A's now-
    // untagged legacy row -- sandbox is no longer reachable here at all
    // (it is rejected earlier, unconditionally), so this is the
    // meaningful way left to exercise the untagged-row fail-safe.
    const prodB = appleTransactionJws('pro_premium_12ay', 30, orig, {
      environment: 'Production',
      transactionId: `TlegacyB${uid()}`,
    });
    const rB = await verify(B.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: prodB.receipt, transactionId: prodB.transactionId });
    assert.equal(rB.status, 403, JSON.stringify(rB.body));
    assert.equal(rB.body.error?.details?.reasonCode, 'identity_conflict');
    assert.equal(await premiumOf(B.ownerId), null);
  },
);

test('Apple: a transaction for another app (wrong bundle id) is rejected', async () => {
  const A = await register('bundle');
  const { receipt } = appleTransactionJws('easy_premium_12ay', 30, undefined, { bundleId: 'com.someone.else' });
  const r = await verify(A.jwt, { productId: 'easy_premium_12ay', platform: 'ios', receipt, transactionId: `t-${uid()}` });
  assert.notEqual(r.body.verified, true);
  assert.equal(await premiumOf(A.ownerId), null);
});

test('Apple: a revoked/refunded transaction never grants an entitlement through verify()', async () => {
  const A = await register('applerefundverify');
  const { receipt } = appleTransactionJws('easy_premium_12ay', 30, undefined, { revoked: Date.now() - 1000 });
  const r = await verify(A.jwt, { productId: 'easy_premium_12ay', platform: 'ios', receipt, transactionId: `t-${uid()}`, isSubscription: false });
  assert.notEqual(r.body.verified, true, JSON.stringify(r.body));
  assert.equal(await premiumOf(A.ownerId), null);
});

// ======================================================================================
// C. Google Play RTDN webhook (Pub/Sub push, OIDC-authenticated, store re-query)
// ======================================================================================
const oidc = (over: Record<string, unknown> = {}, key: crypto.KeyObject = oidcKey.privateKey) => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://accounts.google.com', aud: AUD, email: PUSH_SA, email_verified: true, iat: now, exp: now + 3600, ...over };
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: OIDC_KID, typ: 'JWT' }));
  const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), key))}`;
};
const gpush = (notification: Record<string, unknown>, token: string | null = oidc()) =>
  post(
    '/purchases/webhooks/google-play',
    null,
    { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: PKG, eventTimeMillis: String(Date.now()), ...notification })).toString('base64'), messageId: uid() }, subscription: 'projects/x/subscriptions/y' },
    token ? { authorization: `Bearer ${token}` } : {},
  );
const subNote = (purchaseToken: string, notificationType: number) => ({ subscriptionNotification: { version: '1.0', notificationType, purchaseToken, subscriptionId: 'x' } });

test('Google webhook: unauthenticated, wrong audience, wrong service account, forged signature and the old static secret are all rejected', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const note = subNote('any', 2);
  assert.equal((await gpush(note, null)).status, 401);
  assert.equal((await gpush(note, oidc({ aud: 'https://evil.test' }))).status, 401);
  assert.equal((await gpush(note, oidc({ email: 'attacker@evil.iam.gserviceaccount.com' }))).status, 401);
  assert.equal((await gpush(note, oidc({}, other.privateKey))).status, 401);
  assert.equal((await post('/purchases/webhooks/google-play', null, { message: { data: 'e30=' } }, { 'x-webhook-secret': 'anything' })).status, 401);
});

test('Google webhook: renewal extends the entitlement from the STORE expiry; duplicate is idempotent; out-of-order delivery converges', async () => {
  const A = await register('grenew');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_easy_yearly_999', 5, 'GPA.5555');
  await verify(A.jwt, { productId: 'premium_easy_yearly_999', platform: 'android', receipt: token, transactionId: 'GPA.5555' });
  const before = await premiumOf(A.ownerId);

  // the store now says: renewed, expires in 400 days
  googleSubs.get(token)!.lineItems[0].expiryTime = isoIn(400);
  googleSubs.get(token)!.latestOrderId = 'GPA.5555..0';
  const r1 = await gpush(subNote(token, 2));
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const after = await premiumOf(A.ownerId);
  assert.ok(new Date(after.endsAt).getTime() > new Date(before.endsAt).getTime() + 300 * 86_400_000, 'new expiry comes from Google');
  // duplicate + a stale "earlier" notification type arriving late: state is re-derived from the store, so nothing regresses
  assert.equal((await gpush(subNote(token, 2))).status, 200);
  assert.equal((await gpush(subNote(token, 4))).status, 200);
  assert.equal((await premiumOf(A.ownerId)).endsAt, after.endsAt);
  assert.equal((await eventsWithToken(token)).length, 1, 'no duplicate purchase event');
});

test('Google webhook: cancellation keeps access until the store expiry, expiration removes it', async () => {
  const A = await register('gcancel');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_eco_yearly_1599', 20, 'GPA.6666');
  await verify(A.jwt, { productId: 'premium_eco_yearly_1599', platform: 'android', receipt: token, transactionId: 'GPA.6666' });

  googleSubs.get(token)!.subscriptionState = 'SUBSCRIPTION_STATE_CANCELED';
  const cancelPush = await gpush(subNote(token, 3));
  assert.equal(cancelPush.status, 200, JSON.stringify(cancelPush.body));
  const canceled = await premiumOf(A.ownerId);
  assert.ok(isActive(canceled), 'still active until the paid period ends');
  assert.equal(canceled.autoRenew, false);

  googleSubs.get(token)!.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
  googleSubs.get(token)!.lineItems[0].expiryTime = isoIn(-1);
  assert.equal((await gpush(subNote(token, 13))).status, 200);
  assert.equal(await premiumOf(A.ownerId), null, 'expired -> entitlement removed');
});

test('Google webhook: a voided (refunded) purchase removes the entitlement', async () => {
  const A = await register('grefund');
  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_easy_yearly_999', 20, 'GPA.7777');
  await verify(A.jwt, { productId: 'premium_easy_yearly_999', platform: 'android', receipt: token, transactionId: 'GPA.7777' });
  assert.ok(isActive(await premiumOf(A.ownerId)));
  const r = await gpush({ voidedPurchaseNotification: { purchaseToken: token, orderId: 'GPA.7777', productType: 1, refundType: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await premiumOf(A.ownerId), null);
});

test('Google webhook: a forged pointer at an unknown token, a foreign package and a store outage never grant or change anything', async () => {
  const A = await register('gnone');
  const unknown = await gpush(subNote(`never-verified-${uid()}`, 2));
  assert.equal(unknown.body.skipped, true);
  const foreign = await gpush({ packageName: 'com.other.app', ...subNote('x', 2) });
  assert.equal(foreign.body.skipped, true);
  assert.equal(await premiumOf(A.ownerId), null);

  const token = `tok-${uid()}`;
  googlePurchase(token, 'premium_easy_yearly_999', 20);
  await verify(A.jwt, { productId: 'premium_easy_yearly_999', platform: 'android', receipt: token, transactionId: `t-${uid()}` });
  const kept = await premiumOf(A.ownerId);
  googleFailing = true;
  const outage = await gpush(subNote(token, 13));
  assert.equal(outage.status, 503, 'non-2xx so Pub/Sub retries');
  assert.equal((await premiumOf(A.ownerId)).endsAt, kept.endsAt, 'store outage must not change the entitlement');
});

// ======================================================================================
// D. Apple App Store Server Notifications V2 (signed payload verified against the chain)
// ======================================================================================
const anote = (orig: string, o: { type?: string; subtype?: string; signedDate?: number; expires?: number; revoked?: number; env?: string; bundle?: string; product?: string; signer?: typeof EVIL } = {}) => {
  const tx = {
    transactionId: `T${orig}-${uid()}`, originalTransactionId: orig, productId: o.product ?? 'pro_premium_12ay', bundleId: o.bundle ?? BUNDLE,
    expiresDate: o.expires ?? Date.now() + 30 * 86_400_000, environment: o.env ?? 'Production', ...(o.revoked ? { revocationDate: o.revoked } : {}),
  };
  return post('/purchases/webhooks/apple', null, {
    signedPayload: jws(
      { notificationType: o.type ?? 'DID_RENEW', subtype: o.subtype ?? '', notificationUUID: uid(), signedDate: o.signedDate ?? Date.now(), data: { bundleId: o.bundle ?? BUNDLE, environment: o.env ?? 'Production', signedTransactionInfo: jws(tx, o.signer ?? {}) } },
      o.signer ?? {},
    ),
  });
};

async function boundAppleUser(tag: string, days = 30) {
  const A = await register(tag);
  const { receipt, orig, transactionId } = appleTransactionJws('pro_premium_12ay', days);
  const r = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r.body.verified, true, JSON.stringify(r.body));
  return { A, orig };
}

test('Apple webhook: forged / unsigned / tampered / wrong-chain notifications are rejected and change nothing', async () => {
  const { A, orig } = await boundAppleUser('aforge');
  const kept = (await premiumOf(A.ownerId)).endsAt;
  assert.equal((await anote(orig, { signer: EVIL, expires: Date.now() + 999 * 86_400_000 })).status, 401, 'attacker-signed chain');
  assert.equal((await post('/purchases/webhooks/apple', null, { signedPayload: 'a.b.c' })).status, 401);
  assert.equal((await post('/purchases/webhooks/apple', null, {})).status, 401);
  assert.equal((await post('/purchases/webhooks/apple', null, { notificationType: 'DID_RENEW', originalTransactionId: orig }, { 'x-webhook-secret': 'x' })).status, 401, 'legacy unsigned body');
  const good = (await anote(orig)).status;
  assert.equal(good, 200);
  // tamper an otherwise valid payload
  const okSigned = jws({ notificationType: 'DID_RENEW', signedDate: Date.now(), data: { bundleId: BUNDLE } });
  const [h, , s] = okSigned.split('.');
  const tampered = `${h}.${b64u(JSON.stringify({ notificationType: 'SUBSCRIBED', signedDate: Date.now(), data: { bundleId: BUNDLE } }))}.${s}`;
  assert.equal((await post('/purchases/webhooks/apple', null, { signedPayload: tampered })).status, 401);
  assert.ok((await premiumOf(A.ownerId)).endsAt >= kept);
});

test('Apple webhook: renewal uses the VERIFIED expiry; duplicates and out-of-order (older signedDate) are ignored', async () => {
  const { A, orig } = await boundAppleUser('arenew', 5);
  const t0 = Date.now();
  const newExpiry = t0 + 400 * 86_400_000;
  const r1 = await anote(orig, { type: 'DID_RENEW', signedDate: t0 + 1000, expires: newExpiry });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(new Date((await premiumOf(A.ownerId)).endsAt).getTime(), newExpiry);
  const dup = await anote(orig, { type: 'DID_RENEW', signedDate: t0 + 1000, expires: newExpiry + 86_400_000 });
  assert.equal(dup.body.skipped, true, 'duplicate (same signedDate) ignored');
  const stale = await anote(orig, { type: 'EXPIRED', signedDate: t0 + 500, expires: t0 - 1000 });
  assert.equal(stale.body.skipped, true, 'older notification delivered late is ignored');
  assert.equal(new Date((await premiumOf(A.ownerId)).endsAt).getTime(), newExpiry, 'entitlement did not regress');
});

test('Apple webhook: auto-renew off keeps access until expiry; expiration and refund/revocation remove it', async () => {
  const { A, orig } = await boundAppleUser('astates', 20);
  const t = Date.now();
  await anote(orig, { type: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED', signedDate: t + 10 });
  const off = await premiumOf(A.ownerId);
  assert.ok(isActive(off));
  assert.equal(off.autoRenew, false);
  await anote(orig, { type: 'EXPIRED', signedDate: t + 20, expires: t - 5000 });
  assert.equal(await premiumOf(A.ownerId), null, 'expired -> removed');

  const second = await boundAppleUser('arefund', 20);
  await anote(second.orig, { type: 'REFUND', signedDate: Date.now() + 10, revoked: Date.now() });
  assert.equal(await premiumOf(second.A.ownerId), null, 'refund/revocation -> removed');
});

test('Apple webhook: sandbox notifications are accepted (App Review / TestFlight); a foreign bundle id, unknown transaction and TEST are skipped', async () => {
  const { A, orig } = await boundAppleUser('asandbox', 10);
  const sb = await anote(orig, { env: 'Sandbox', signedDate: Date.now() + 5, expires: Date.now() + 200 * 86_400_000 });
  assert.equal(sb.status, 200);
  assert.ok(new Date((await premiumOf(A.ownerId)).endsAt).getTime() > Date.now() + 150 * 86_400_000);
  assert.equal((await anote(orig, { bundle: 'com.other.app', signedDate: Date.now() + 9 })).body.skipped, true);
  assert.equal((await anote('never-seen-999')).body.skipped, true);
  const test = await post('/purchases/webhooks/apple', null, { signedPayload: jws({ notificationType: 'TEST', signedDate: Date.now(), data: { bundleId: BUNDLE } }) });
  assert.equal(test.body.skipped, true);
});

test('Apple webhook: the real Apple root pin is enforced (the test chain is rejected when no test root is configured)', async () => {
  const prev = process.env.APPLE_TRUSTED_ROOT_SHA256;
  try {
    delete process.env.APPLE_TRUSTED_ROOT_SHA256;
    const r = await post('/purchases/webhooks/apple', null, { signedPayload: jws({ notificationType: 'DID_RENEW', signedDate: Date.now(), data: { bundleId: BUNDLE } }) });
    assert.equal(r.status, 401);
  } finally {
    process.env.APPLE_TRUSTED_ROOT_SHA256 = prev;
  }
});
