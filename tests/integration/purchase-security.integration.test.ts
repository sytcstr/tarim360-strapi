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
  over: { bundleId?: string; revoked?: number } = {},
) => {
  const transactionId = `T${orig}`;
  const receipt = jws({
    transactionId,
    originalTransactionId: orig,
    productId,
    bundleId: over.bundleId ?? BUNDLE,
    // Every real Apple transaction JWS carries its own purchaseDate --
    // added here so purchasedAt (providers.ts's verifyApple) is reliably
    // populated, matching real production data, for the idempotent-
    // repair rocket-reconciliation tests that anchor on it.
    purchaseDate: Date.now(),
    // Every real Apple transaction JWS also carries its own signedDate --
    // needed so a LATER re-verify of the SAME (frozen) receipt can be
    // told apart from a genuinely newer renewal (see
    // isStaleAppleResubmission, controllers/purchase.ts).
    signedDate: Date.now(),
    expiresDate: Date.now() + days * 86_400_000,
    ...(over.revoked ? { revocationDate: over.revoked } : {}),
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

  // The client already parses `error.details.reasonCode`/`correlationId`
  // on a 403 (PurchaseVerifyOutcome._reasonCodeFromWire) -- confirms the
  // backend actually sends the specific code for each of the two checks
  // this test exercises (same stored transactionId vs. same store token),
  // never just the generic message string, and a correlationId safe to
  // show support.
  assert.equal(sameTx.body?.error?.details?.reasonCode, 'owner_mismatch', JSON.stringify(sameTx.body));
  assert.ok(sameTx.body?.error?.details?.correlationId, 'correlationId must be present');
  for (const r of [otherTx, noTx, viaPurchaseToken]) {
    assert.equal(r.body?.error?.details?.reasonCode, 'token_conflict', JSON.stringify(r.body));
    assert.ok(r.body?.error?.details?.correlationId, 'correlationId must be present');
  }
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

test('Google: three different accounts each buy the SAME product with their own separate, valid purchases -- all three succeed independently (productId alone is never a conflict key; only the store\'s own per-purchase identity is)', async () => {
  const A = await register('multi-a');
  const B = await register('multi-b');
  const C = await register('multi-c');
  const productId = 'premium_eco_yearly_1599';
  const tokenA = `tok-${uid()}`;
  const tokenB = `tok-${uid()}`;
  const tokenC = `tok-${uid()}`;
  googlePurchase(tokenA, productId, 30, `GPA.${uid()}`);
  googlePurchase(tokenB, productId, 30, `GPA.${uid()}`);
  googlePurchase(tokenC, productId, 30, `GPA.${uid()}`);

  const [rA, rB, rC] = await Promise.all([
    verify(A.jwt, { productId, platform: 'android', receipt: tokenA, transactionId: `tx-a-${uid()}` }),
    verify(B.jwt, { productId, platform: 'android', receipt: tokenB, transactionId: `tx-b-${uid()}` }),
    verify(C.jwt, { productId, platform: 'android', receipt: tokenC, transactionId: `tx-c-${uid()}` }),
  ]);

  for (const r of [rA, rB, rC]) assert.equal(r.body.verified, true, JSON.stringify(r.body));
  assert.ok(isActive(await premiumOf(A.ownerId)), 'A must have its own active entitlement');
  assert.ok(isActive(await premiumOf(B.ownerId)), 'B must have its own active entitlement');
  assert.ok(isActive(await premiumOf(C.ownerId)), 'C must have its own active entitlement');
  assert.equal((await eventsWithToken(tokenA)).length, 1);
  assert.equal((await eventsWithToken(tokenB)).length, 1);
  assert.equal((await eventsWithToken(tokenC)).length, 1);
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

  // B's own client-chosen transactionId never matched A's stored row, so
  // this is decided by the STORE identity lock (same real Apple
  // transaction/originalTransactionId), not the plain stored-row check --
  // confirms the specific `identity_conflict` code reaches the client.
  assert.equal(rb.body?.error?.details?.reasonCode, 'identity_conflict', JSON.stringify(rb.body));
  assert.ok(rb.body?.error?.details?.correlationId, 'correlationId must be present');
});

test('BUG (now fixed): idempotent verify() repairs a genuinely MISSING ProfileSetting.activePremium for an already-verified, still-valid transaction -- without re-contacting Apple and without extending the real stored expiry', async () => {
  const A = await register('idem-repair');
  const { receipt, transactionId } = appleTransactionJws('pro_premium_12ay', 30, `100${uid()}`);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));
  const original = await premiumOf(A.ownerId);
  assert.ok(isActive(original), 'the first verify() must grant the real entitlement');

  // Simulate the exact reported symptom: the purchase-event row is real
  // and already verified, but ProfileSetting's own activePremium ended up
  // missing (e.g. a crash/partial failure between the two writes on an
  // earlier attempt) -- without touching purchase-event at all.
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });
  assert.equal(await premiumOf(A.ownerId), null, 'sanity check: the simulated gap is really there');

  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r2.body.idempotent, true, JSON.stringify(r2.body));
  assert.equal(r2.body.verified, true, JSON.stringify(r2.body));

  const repaired = await premiumOf(A.ownerId);
  assert.ok(isActive(repaired), 'the idempotent repair must restore the missing entitlement');
  assert.equal(
    new Date(repaired.endsAt).getTime(),
    new Date(original.endsAt).getTime(),
    'the REAL stored expiry must be reused exactly -- never a fresh now+365 guess',
  );
  assert.equal(repaired.rocketRemaining, original.rocketRemaining, 'rocket credits are freshly (correctly) granted, not doubled');

  const history = await (async () => {
    const row = await strapiInstance.db
      .query('api::profile-setting.profile-setting')
      .findOne({ where: { profileId: A.ownerId } });
    return (row as any)?.purchaseHistory ?? [];
  })();
  assert.equal(
    history.filter((h: any) => h.transactionId === transactionId).length,
    1,
    'the repair must never duplicate the history entry for this transaction',
  );
});

test('BUG (now fixed), negative case: idempotent verify() repair must NEVER fire -- and must never touch -- an account that already has ANY entitlement, even one from a completely different, newer transaction', async () => {
  const A = await register('idem-no-overwrite');
  const old = appleTransactionJws('pro_premium_12ay', 30, `100${uid()}`);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: old.receipt, transactionId: old.transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // A genuinely NEW, separate transaction supersedes it -- activePremium
  // now reflects THIS newer one, with its own (partially-used-looking)
  // rocket credits, deliberately different from a fresh grant so an
  // accidental overwrite/refill is unmistakable in the assertion below.
  const fresh = appleTransactionJws('pro_premium_12ay', 300, `100${uid()}`);
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: fresh.receipt, transactionId: fresh.transactionId });
  assert.equal(r2.body.verified, true, JSON.stringify(r2.body));
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: {
      activePremium: { ...(await premiumOf(A.ownerId)), rocketRemaining: 3 },
    },
  });
  const beforeRepeat = await premiumOf(A.ownerId);
  assert.equal(beforeRepeat.rocketRemaining, 3);

  // Re-sending the OLD transaction's receipt is still idempotent (it is
  // still its own verified, not-expired row) -- but must NOT touch the
  // CURRENT entitlement, which belongs to a different, newer transaction.
  const r3 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: old.receipt, transactionId: old.transactionId });
  assert.equal(r3.body.idempotent, true, JSON.stringify(r3.body));

  const after = await premiumOf(A.ownerId);
  assert.equal(
    new Date(after.endsAt).getTime(),
    new Date(beforeRepeat.endsAt).getTime(),
    'the newer transaction\'s real expiry must survive untouched',
  );
  assert.equal(
    after.rocketRemaining,
    3,
    'the newer entitlement\'s (partially-used-looking) rocket credits must never be refilled/overwritten by the OLD transaction\'s repair path',
  );
});

test('BUG (now fixed), security gap #1: a stored verified+not-yet-locally-expired row whose transaction has SINCE been refunded/revoked AT THE PROVIDER must not be resurrected -- the repair path re-asks the provider before granting anything', async () => {
  const A = await register('idem-repair-revoked');
  const orig = `100${uid()}`;
  const tx1 = appleTransactionJws('pro_premium_12ay', 30, orig);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // Simulate the exact reported symptom: the stored purchase-event row
  // still says verified/not-expired, but ProfileSetting's own
  // activePremium ended up missing.
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });
  assert.equal(await premiumOf(A.ownerId), null);

  // What re-asking "the provider" right now actually returns for this
  // exact transaction/originalTransactionId -- genuinely revoked since
  // the first verify() above (a real refund/chargeback, or Apple's own
  // revocation) -- submitted as THIS retry's own receipt, exactly as a
  // real client resubmitting its locally-cached (now stale) receipt would.
  const revokedReceipt = jws({
    transactionId: tx1.transactionId,
    originalTransactionId: orig,
    productId: 'pro_premium_12ay',
    bundleId: BUNDLE,
    expiresDate: Date.now() + 30 * 86_400_000,
    revocationDate: Date.now(),
  });
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: revokedReceipt, transactionId: tx1.transactionId });
  assert.equal(r2.body.verified, false, JSON.stringify(r2.body));
  assert.notEqual(r2.body.idempotent, true, 'a refunded transaction must never be answered as an "idempotent success"');
  assert.equal(await premiumOf(A.ownerId), null, 'a since-refunded transaction must never be resurrected by the repair path');
});

test('BUG (now fixed), security gap #2: rocket credits already consumed under the SAME subscription (real rocket-activation records) are reconciled, never refilled, when the idempotent repair runs', async () => {
  const A = await register('idem-repair-rocket');
  const { receipt, transactionId } = appleTransactionJws('pro_premium_12ay', 30); // pro plan: rocketIncludedTotal = 14
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));
  assert.equal((await premiumOf(A.ownerId)).rocketRemaining, 14);

  // 3 premium-credit rocket activations already happened under this
  // exact subscription (the real listing.ts activateRocket flow records
  // these) -- created directly here since activateRocket itself is a
  // separate, already-covered flow; only the RECONCILIATION on repair is
  // what this test exercises.
  for (let i = 0; i < 3; i += 1) {
    await strapiInstance.entityService.create('api::rocket-activation.rocket-activation', {
      data: {
        operationId: `op-${uid()}`,
        payloadFingerprint: 'fp',
        listingId: `listing-${i}`,
        ownerProfileId: A.ownerId,
        sourceType: 'premium_credit',
        days: 14,
        rocketEndsAt: new Date(Date.now() + 14 * 86_400_000),
      },
    });
  }

  // The bug: activePremium ends up missing despite the 3 already-
  // consumed credits above.
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });

  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r2.body.idempotent, true, JSON.stringify(r2.body));
  const repaired = await premiumOf(A.ownerId);
  assert.ok(isActive(repaired));
  assert.equal(
    repaired.rocketRemaining,
    11,
    'the repair must subtract the 3 already-consumed credits from the real rocket-activation records, never refill to the full 14',
  );
});

test('BUG (now fixed), security gap #2 (owner isolation): a DIFFERENT account\'s rocket-activation records are never counted against this owner\'s reconciliation', async () => {
  const A = await register('idem-repair-owner-a');
  const B = await register('idem-repair-owner-b');
  const { receipt, transactionId } = appleTransactionJws('pro_premium_12ay', 30);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // B has genuinely consumed premium-credit rocket activations of their
  // OWN (completely unrelated to A) -- these must never be counted
  // against A's own reconciliation.
  for (let i = 0; i < 5; i += 1) {
    await strapiInstance.entityService.create('api::rocket-activation.rocket-activation', {
      data: {
        operationId: `op-b-${uid()}`,
        payloadFingerprint: 'fp',
        listingId: `listing-b-${i}`,
        ownerProfileId: B.ownerId,
        sourceType: 'premium_credit',
        days: 14,
        rocketEndsAt: new Date(Date.now() + 14 * 86_400_000),
      },
    });
  }

  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r2.body.idempotent, true, JSON.stringify(r2.body));
  const repaired = await premiumOf(A.ownerId);
  assert.equal(
    repaired.rocketRemaining,
    14,
    'B\'s own rocket consumption must never reduce A\'s reconciled credits -- A used none',
  );
});

test('BUG (now fixed), security gap #2 (period stability): reconciliation anchors on purchasedAt, not the noisier verifiedAt -- an unrelated notification bumping verifiedAt forward must never hide real in-period consumption and over-credit rockets', async () => {
  const A = await register('idem-repair-period');
  const { receipt, transactionId } = appleTransactionJws('pro_premium_12ay', 30);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // 2 real in-period rocket activations happen shortly after the purchase.
  for (let i = 0; i < 2; i += 1) {
    await strapiInstance.entityService.create('api::rocket-activation.rocket-activation', {
      data: {
        operationId: `op-period-${uid()}`,
        payloadFingerprint: 'fp',
        listingId: `listing-period-${i}`,
        ownerProfileId: A.ownerId,
        sourceType: 'premium_credit',
        days: 14,
        rocketEndsAt: new Date(Date.now() + 14 * 86_400_000),
      },
    });
  }

  // Simulate an UNRELATED notification (e.g. DID_CHANGE_RENEWAL_STATUS --
  // never a new period/charge) bumping `verifiedAt` forward in time,
  // WITHOUT moving `purchasedAt` (Apple's own purchaseDate does not change
  // for a notification that isn't a genuine renewal). If the reconciliation
  // anchored on verifiedAt, this would wrongly push the cutoff PAST the 2
  // activations above, hiding them from the count.
  await strapiInstance.db.query('api::purchase-event.purchase-event').update({
    where: { transactionId },
    data: { verifiedAt: new Date(Date.now() + 60_000).toISOString() },
  });

  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r2.body.idempotent, true, JSON.stringify(r2.body));
  const repaired = await premiumOf(A.ownerId);
  assert.equal(
    repaired.rocketRemaining,
    12,
    'the 2 real in-period activations must still be counted (14 - 2) despite verifiedAt having been bumped forward by an unrelated notification',
  );
});

test('BUG (now fixed), security gap #2 (concurrency): two concurrent idempotent-repair requests for the SAME missing entitlement never double the rocket credits or duplicate the history entry', async () => {
  const A = await register('idem-repair-concurrent');
  const { receipt, transactionId } = appleTransactionJws('pro_premium_12ay', 30);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });

  const [ra, rb] = await Promise.all([
    verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId }),
    verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt, transactionId }),
  ]);
  assert.equal(ra.body.idempotent, true, JSON.stringify(ra.body));
  assert.equal(rb.body.idempotent, true, JSON.stringify(rb.body));

  const repaired = await premiumOf(A.ownerId);
  assert.ok(isActive(repaired));
  assert.equal(repaired.rocketRemaining, 14, 'exactly one grant worth of credits, never doubled by the concurrent race');

  const row = await strapiInstance.db.query('api::profile-setting.profile-setting').findOne({ where: { profileId: A.ownerId } });
  const history = (row as any)?.purchaseHistory ?? [];
  assert.equal(
    history.filter((h: any) => h.transactionId === transactionId).length,
    1,
    'history must never duplicate from a concurrent repair race',
  );
});

test('BUG (now fixed): after a REAL webhook refund, the client resubmitting its OLD (pre-refund) cached JWS through the NORMAL (non-idempotent) verify() path must not resurrect the entitlement', async () => {
  const A = await register('stale-jws-normal-verify');
  const orig = `100${uid()}`;
  const tx1 = appleTransactionJws('pro_premium_12ay', 30, orig);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));
  assert.ok(isActive(await premiumOf(A.ownerId)));

  // A REAL webhook refund arrives, genuinely signed AFTER tx1's own
  // signedDate.
  const refund = await anote(orig, { type: 'REFUND', signedDate: Date.now() + 2000, revoked: Date.now() });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(await premiumOf(A.ownerId), null, 'sanity check: the real webhook correctly removed it');

  // The client resubmits its OWN old, frozen (pre-refund) receipt through
  // the plain verify() endpoint -- same transactionId, same (now stale)
  // baked-in signedDate. This is NOT the idempotent-repair branch (status
  // is already 'refunded', not 'verified') -- it is the ordinary flow
  // every interactive verify() call goes through.
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId });
  assert.equal(r2.body.verified, false, JSON.stringify(r2.body));
  assert.equal(await premiumOf(A.ownerId), null, 'the stale, pre-refund JWS must never resurrect the entitlement');
});

test('BUG (now fixed): a webhook refund racing CONCURRENTLY with an idempotent-repair attempt for the same transaction never ends with an invalid entitlement left granted, regardless of which one the lock lets run first', async () => {
  const A = await register('concurrent-webhook-repair');
  const orig = `100${uid()}`;
  const tx1 = appleTransactionJws('pro_premium_12ay', 30, orig);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // Simulate the missing-profile bug (repair-eligible: purchase-event
  // status is still 'verified', only ProfileSetting's own entitlement is
  // gone) WHILE a genuine webhook refund is about to race against the
  // repair attempt that would otherwise follow.
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });

  await Promise.all([
    verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId }),
    anote(orig, { type: 'REFUND', signedDate: Date.now() + 2000, revoked: Date.now() }),
  ]);

  // Whichever one the shared identity lock let run first, the transaction
  // IS genuinely refunded -- the final state must never show it as
  // active, no matter the interleaving.
  assert.equal(
    await premiumOf(A.ownerId),
    null,
    'a genuinely refunded transaction must never end up granted, regardless of webhook/repair race ordering',
  );
});

test('a genuinely NEWER renewal (same originalTransactionId, its own freshly-signed JWS with a later signedDate and a real extended expiry) correctly establishes the entitlement through the interactive verify() path -- the stale-JWS guard never blocks a real renewal', async () => {
  const A = await register('genuine-renewal-interactive');
  const orig = `100${uid()}`;
  const tx1 = appleTransactionJws('pro_premium_12ay', 5, orig);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // A genuine renewal: Apple issues a freshly-signed JWS for the SAME
  // originalTransactionId -- its own new transactionId (a real renewal
  // always gets one), a later signedDate, and a genuinely extended
  // expiresDate -- submitted through the ordinary interactive verify()
  // flow (e.g. the app re-verifying/restoring after the renewal).
  const renewedTxId = `T${orig}-renewed`;
  const renewedReceipt = jws({
    transactionId: renewedTxId,
    originalTransactionId: orig,
    productId: 'pro_premium_12ay',
    bundleId: BUNDLE,
    purchaseDate: Date.now(),
    signedDate: Date.now() + 5000,
    expiresDate: Date.now() + 400 * 86_400_000,
  });
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: renewedReceipt, transactionId: renewedTxId });
  assert.equal(r2.body.verified, true, JSON.stringify(r2.body));
  const renewed = await premiumOf(A.ownerId);
  assert.ok(isActive(renewed));
  assert.ok(
    new Date(renewed.endsAt).getTime() > Date.now() + 300 * 86_400_000,
    'the genuine renewal must correctly establish the extended entitlement, never mistaken for a stale resubmission',
  );
});

test('BUG (now fixed): once a REAL webhook refund is recorded for a transactionId, a LATER-signed JWS for that SAME transactionId that does not itself show revocation/expiry must still not reopen the right -- the server\'s already-known refund is permanent for that exact transactionId; only a genuinely NEW transactionId (a real renewal) may grant one', async () => {
  const A = await register('refund-then-clean-later-jws');
  const orig = `100${uid()}`;
  const tx1 = appleTransactionJws('pro_premium_12ay', 30, orig);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // A REAL webhook refund is processed FIRST.
  const refund = await anote(orig, { type: 'REFUND', signedDate: Date.now() + 2000, revoked: Date.now() });
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  assert.equal(await premiumOf(A.ownerId), null, 'sanity check: the webhook correctly removed it');

  // SAME transactionId, a NEWER signedDate than the refund notification's
  // own -- but THIS JWS itself shows NO revocationDate and a future
  // expiresDate. On its own, it looks like a perfectly fine, still-active
  // transaction (unlike the earlier "security gap #1" tests, which used a
  // later JWS that itself still showed revoked).
  const laterCleanLookingJws = jws({
    transactionId: tx1.transactionId,
    originalTransactionId: orig,
    productId: 'pro_premium_12ay',
    bundleId: BUNDLE,
    purchaseDate: Date.now(),
    signedDate: Date.now() + 10_000,
    expiresDate: Date.now() + 30 * 86_400_000,
  });
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: laterCleanLookingJws, transactionId: tx1.transactionId });
  assert.equal(r2.body.verified, false, JSON.stringify(r2.body));
  assert.equal(
    await premiumOf(A.ownerId),
    null,
    'the server\'s already-known refund for this exact transactionId must be preserved, regardless of this JWS\'s own (newer) signedDate',
  );

  // A GENUINE new renewal -- a different, brand-new transactionId -- must
  // still work completely normally.
  const renewedTxId = `T${orig}-renewed-after-refund`;
  const renewedReceipt = jws({
    transactionId: renewedTxId,
    originalTransactionId: orig,
    productId: 'pro_premium_12ay',
    bundleId: BUNDLE,
    purchaseDate: Date.now(),
    signedDate: Date.now() + 20_000,
    expiresDate: Date.now() + 400 * 86_400_000,
  });
  const r3 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: renewedReceipt, transactionId: renewedTxId });
  assert.equal(r3.body.verified, true, JSON.stringify(r3.body));
  assert.ok(isActive(await premiumOf(A.ownerId)), 'a genuinely new transactionId (a real renewal) must still correctly grant the entitlement');
});

test('BUG (now fixed): resubmitting a JWS whose OWN signedDate is EQUAL (not older) to the last known transaction signedDate -- a still-valid, never-refunded transaction -- must NOT be blocked as "stale", neither for ordinary idempotent verify() nor for repairing a missing Premium entitlement', async () => {
  const A = await register('equal-signeddate-not-stale');
  const orig = `100${uid()}`;
  const sharedSignedDate = Date.now();
  const tx1Id = `T${orig}`;
  const receipt1 = jws({
    transactionId: tx1Id,
    originalTransactionId: orig,
    productId: 'pro_premium_12ay',
    bundleId: BUNDLE,
    purchaseDate: Date.now(),
    signedDate: sharedSignedDate,
    expiresDate: Date.now() + 30 * 86_400_000,
  });
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: receipt1, transactionId: tx1Id });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // A webhook touches the SAME row (e.g. Apple's own routine DID_RENEW
  // confirmation) whose INNER transaction signedDate happens to be
  // exactly `sharedSignedDate` -- the SAME value receipt1 itself carries
  // (its own outer envelope is signed later, which is independent and
  // only affects the separate outer out-of-order check). This is exactly
  // what `appleLastTransactionSignedDate` ends up storing.
  const touch = await anote(orig, {
    type: 'DID_RENEW',
    signedDate: sharedSignedDate + 500,
    txSignedDate: sharedSignedDate,
    expires: Date.now() + 30 * 86_400_000,
  });
  assert.equal(touch.status, 200, JSON.stringify(touch.body));
  assert.ok(isActive(await premiumOf(A.ownerId)));

  // The client resubmits receipt1 again (e.g. a retry) -- its OWN
  // signedDate (sharedSignedDate) now EQUALS the stored
  // appleLastTransactionSignedDate. Not refunded, nothing wrong with it
  // -- must verify normally, never rejected as "stale".
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: receipt1, transactionId: tx1Id });
  assert.notEqual(r2.body.verified, false, JSON.stringify(r2.body));

  // Now the repair scenario: a missing entitlement must still be
  // repairable even when the repair's own re-verify happens to produce a
  // signedDate EQUAL to what is already known (the SAME transaction,
  // genuinely still valid, no refund anywhere).
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: A.ownerId },
    data: { activePremium: null, activePremiumSubscription: null },
  });
  const r3 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: receipt1, transactionId: tx1Id });
  assert.equal(r3.body.idempotent, true, JSON.stringify(r3.body));
  assert.ok(
    isActive(await premiumOf(A.ownerId)),
    'an equal (not older) signedDate must never block the repair of a genuinely still-valid, never-refunded entitlement',
  );
});

test('BUG (now fixed if present), security gap #1 (explicit newer-signedDate case): a transaction already known to be refunded does not regain entitlement just because a resubmitted JWS happens to carry a NEWER signedDate -- validity is decided by the transaction\'s own revocation/expiry data, never by signedDate recency alone', async () => {
  const A = await register('newer-signeddate-still-revoked');
  const orig = `100${uid()}`;
  const tx1 = appleTransactionJws('pro_premium_12ay', 30, orig);
  const r1 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: tx1.receipt, transactionId: tx1.transactionId });
  assert.equal(r1.body.verified, true, JSON.stringify(r1.body));

  // A later, genuinely Apple-signed JWS for the SAME transactionId --
  // its signedDate IS newer than tx1's own -- but it still reports this
  // exact transaction as revoked (a real, valid signature cannot be
  // forged with an arbitrary revocationDate; this models what Apple
  // itself would sign if asked again after a real refund).
  const laterButRevoked = jws({
    transactionId: tx1.transactionId,
    originalTransactionId: orig,
    productId: 'pro_premium_12ay',
    bundleId: BUNDLE,
    purchaseDate: Date.now(),
    signedDate: Date.now() + 10_000,
    expiresDate: Date.now() + 30 * 86_400_000,
    revocationDate: Date.now(),
  });
  const r2 = await verify(A.jwt, { productId: 'pro_premium_12ay', platform: 'ios', receipt: laterButRevoked, transactionId: tx1.transactionId });
  assert.equal(r2.body.verified, false, JSON.stringify(r2.body));
  assert.equal(
    await premiumOf(A.ownerId),
    null,
    'a newer signedDate must never, by itself, grant/restore entitlement for a transaction whose own data shows it revoked',
  );
});

// NOTE: like every other Apple test in this file, this uses a LOCAL,
// test-only certificate chain to sign a StoreKit2-shaped transaction JWS
// (see `appleTransactionJws`/`jws` above and this file's own top-of-file
// note) -- it exercises the real, unmodified `verifyAppleJws` chain
// verifier exactly as production does, but it is NOT a real Apple
// signature, a real App Store Connect sandbox purchase, or a real iPhone
// test. It must never be reported or treated as evidence from a real
// device/sandbox run.
test('Apple: three different accounts each buy the SAME product with their own separate, valid (test-chain-signed) transactions -- all three succeed independently (productId alone is never a conflict key; only the real Apple transaction/originalTransactionId is)', async () => {
  const A = await register('apple-multi-a');
  const B = await register('apple-multi-b');
  const C = await register('apple-multi-c');
  const productId = 'pro_premium_12ay';
  const txA = appleTransactionJws(productId, 30);
  const txB = appleTransactionJws(productId, 30);
  const txC = appleTransactionJws(productId, 30);

  const [rA, rB, rC] = await Promise.all([
    verify(A.jwt, { productId, platform: 'ios', receipt: txA.receipt, transactionId: txA.transactionId }),
    verify(B.jwt, { productId, platform: 'ios', receipt: txB.receipt, transactionId: txB.transactionId }),
    verify(C.jwt, { productId, platform: 'ios', receipt: txC.receipt, transactionId: txC.transactionId }),
  ]);

  for (const r of [rA, rB, rC]) assert.equal(r.body.verified, true, JSON.stringify(r.body));
  assert.ok(isActive(await premiumOf(A.ownerId)), 'A must have its own active entitlement');
  assert.ok(isActive(await premiumOf(B.ownerId)), 'B must have its own active entitlement');
  assert.ok(isActive(await premiumOf(C.ownerId)), 'C must have its own active entitlement');
  const rows = await strapiInstance.db
    .query('api::purchase-event.purchase-event')
    .findMany({ where: { originalTransactionId: { $in: [txA.orig, txB.orig, txC.orig] } } });
  assert.equal(rows.length, 3, "each account's own transaction must create its own purchase-event row");
});

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

// NOTE: `appleTransactionJws(productId, days, ...)` with a NEGATIVE
// `days` signs a transaction whose own `expiresDate` is already in the
// past -- a real, not-revoked, genuinely EXPIRED Apple subscription.
test('BUG (now fixed): the backend derives isSubscription from its OWN catalog, never from the client -- a real, EXPIRED Apple subscription transaction, with the client falsely claiming isSubscription:false, is still rejected (the one-time branch\'s `verified: !revoked` would otherwise have silently granted it forever, since a one-time check never looks at expiresDate at all)', async () => {
  const A = await register('sub-type-trust');
  const { receipt } = appleTransactionJws('pro_premium_12ay', -1);
  const r = await verify(A.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt,
    transactionId: `t-${uid()}`,
    isSubscription: false, // client lies -- must be ignored
  });
  assert.notEqual(r.body.verified, true, JSON.stringify(r.body));
  assert.equal(
    await premiumOf(A.ownerId),
    null,
    'an expired subscription must never be granted just because the client mislabeled it as a one-time purchase',
  );
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
const anote = (orig: string, o: { type?: string; subtype?: string; signedDate?: number; txSignedDate?: number; expires?: number; revoked?: number; env?: string; bundle?: string; product?: string; signer?: typeof EVIL } = {}) => {
  const tx = {
    transactionId: `T${orig}-${uid()}`, originalTransactionId: orig, productId: o.product ?? 'pro_premium_12ay', bundleId: o.bundle ?? BUNDLE,
    expiresDate: o.expires ?? Date.now() + 30 * 86_400_000, environment: o.env ?? 'Production',
    // Apple's own JWSTransactionDecodedPayload carries its OWN signedDate,
    // separate from the outer notification envelope's signedDate below.
    // Defaults to the same value as the envelope so every pre-existing
    // test (which never varies them independently) is unaffected; a test
    // exercising envelope-vs-transaction staleness passes `txSignedDate`
    // explicitly.
    signedDate: o.txSignedDate ?? o.signedDate ?? Date.now(),
    ...(o.revoked ? { revocationDate: o.revoked } : {}),
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

test('BUG (now fixed): a webhook for an OLD, already-superseded original transaction (e.g. a late/duplicate notification arriving after the SAME owner already re-subscribed with a genuinely NEW, separate transaction) reporting expired/refunded must NOT null out the CURRENT, still-valid Premium entitlement that the new transaction produced', async () => {
  const { A, orig: orig1 } = await boundAppleUser('premium-unrelated-1', 30);
  assert.ok(isActive(await premiumOf(A.ownerId)), 'first subscription active');

  // The SAME owner has a genuinely NEW, separate transaction (orig2) --
  // e.g. they re-subscribed after orig1 actually lapsed, or simply made a
  // second, unrelated purchase. activePremium now reflects orig2.
  const tx2 = appleTransactionJws('pro_premium_12ay', 300);
  const r2 = await verify(A.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: tx2.receipt,
    transactionId: tx2.transactionId,
  });
  assert.equal(r2.body.verified, true, JSON.stringify(r2.body));
  const afterSecond = await premiumOf(A.ownerId);
  assert.ok(isActive(afterSecond), 'activePremium now reflects the SECOND transaction');
  assert.ok(
    Math.abs(new Date(afterSecond.endsAt).getTime() - (Date.now() + 300 * 86_400_000)) < 120_000,
    'endsAt matches the NEW transaction, not the old one',
  );

  // A LATE/duplicate webhook for the FIRST, OLD, already-superseded
  // original transaction now arrives, reporting it expired.
  const late = await anote(orig1, { type: 'EXPIRED' });
  assert.equal(late.status, 200);

  // The CURRENT entitlement, produced by the SECOND, unrelated
  // transaction, must still be intact -- a stale notification about a
  // DIFFERENT transaction must never revoke it.
  const afterLateWebhook = await premiumOf(A.ownerId);
  assert.ok(
    isActive(afterLateWebhook),
    'a late webhook for an OLD, superseded transaction must never null the CURRENT valid entitlement from a different transaction',
  );
});

test('Review follow-up (same-subscription renewal ordering): under the SAME originalTransactionId, a notification about an OLDER renewal period that is merely DELIVERED late (but was genuinely SIGNED by Apple before a later renewal) must not null a NEWER, already-renewed valid entitlement', async () => {
  const { A, orig } = await boundAppleUser('premium-chain', 5);
  const t0 = Date.now();
  const renewedExpiry = t0 + 400 * 86_400_000;

  // A genuine renewal (SAME originalTransactionId -- that is how Apple
  // subscriptions always renew) extends the entitlement far into the future.
  const renew = await anote(orig, { type: 'DID_RENEW', signedDate: t0 + 1000, expires: renewedExpiry });
  assert.equal(renew.status, 200, JSON.stringify(renew.body));
  const afterRenewal = await premiumOf(A.ownerId);
  assert.ok(isActive(afterRenewal), 'renewal active');
  assert.equal(new Date(afterRenewal.endsAt).getTime(), renewedExpiry);

  // A notification about the FIRST, now-superseded period is delivered
  // late (arrives at our server only now, after the renewal above was
  // already processed) -- but Apple actually SIGNED it back when that
  // period really ended, i.e. BEFORE the renewal notification's own
  // signedDate. This is the realistic shape of "delayed delivery": Apple's
  // signedTransactionInfo always reflects the transaction's state as of
  // signing time, so a late notification about an older period carries an
  // OLDER signedDate than a renewal that was both signed and processed
  // after it -- it does not resurrect old data with a fresher timestamp.
  const lateForOldPeriod = await anote(orig, { type: 'EXPIRED', signedDate: t0 + 200, expires: t0 - 1000 });
  assert.equal(lateForOldPeriod.status, 200, JSON.stringify(lateForOldPeriod.body));
  assert.equal(
    lateForOldPeriod.body.skipped,
    true,
    'the existing appleLastSignedDate ordering guard must already catch this as an out-of-order notification',
  );

  const afterLateNotification = await premiumOf(A.ownerId);
  assert.ok(
    isActive(afterLateNotification),
    'a late notification about an OLDER renewal period under the SAME originalTransactionId must not null the NEWER, already-renewed entitlement',
  );
  assert.equal(
    new Date(afterLateNotification.endsAt).getTime(),
    renewedExpiry,
    'the newer renewal\'s expiry must survive untouched',
  );
});

test('BUG (now fixed): a notification whose OUTER envelope carries a NEWER signedDate than the current renewal, but whose INNER transaction snapshot still describes the OLDER, already-superseded period, must not null the current entitlement -- notification-signing order is not assumed to equal transaction-period order', async () => {
  const { A, orig } = await boundAppleUser('premium-chain-2', 5);
  const t0 = Date.now();
  const renewedExpiry = t0 + 400 * 86_400_000;

  const renew = await anote(orig, { type: 'DID_RENEW', signedDate: t0 + 1000, expires: renewedExpiry });
  assert.equal(renew.status, 200, JSON.stringify(renew.body));
  const afterRenewal = await premiumOf(A.ownerId);
  assert.ok(isActive(afterRenewal), 'renewal active');
  assert.equal(new Date(afterRenewal.endsAt).getTime(), renewedExpiry);

  // The OUTER envelope's own signedDate is NEWER than the renewal above
  // (t0 + 5000 > t0 + 1000) -- the existing envelope-level ordering guard
  // alone does NOT catch this (this is exactly the case the review asked
  // to check: do not assume notification-signing order tracks which
  // period the transaction content describes). But the INNER transaction
  // snapshot it carries is for the FIRST, now-superseded period -- its own
  // signedDate (t0 + 300) is OLDER than the one already recorded from the
  // renewal's own transaction (t0 + 1000), e.g. because the envelope was
  // resent/retried with a fresh outer timestamp while reusing an older,
  // already-superseded transaction snapshot.
  const outerNewerInnerStale = await anote(orig, {
    type: 'EXPIRED',
    signedDate: t0 + 5000,
    txSignedDate: t0 + 300,
    expires: t0 - 1000,
  });
  assert.equal(outerNewerInnerStale.status, 200, JSON.stringify(outerNewerInnerStale.body));
  assert.equal(
    outerNewerInnerStale.body.skipped,
    true,
    'the inner transaction-signedDate guard must catch this even though the outer envelope signedDate alone would not',
  );

  const afterNotification = await premiumOf(A.ownerId);
  assert.ok(
    isActive(afterNotification),
    'a notification with a newer OUTER signedDate but a stale INNER transaction snapshot must not null the current entitlement',
  );
  assert.equal(
    new Date(afterNotification.endsAt).getTime(),
    renewedExpiry,
    'the newer renewal\'s expiry must survive untouched',
  );
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

// ======================================================================================
// E2. Review follow-up -- real production symptom: a genuinely expired,
// weeks-old transaction (sandbox 1-day test subscription, processed by our
// backend ~19 days after it actually expired -- the shape of StoreKit
// redelivering a never-finished transaction on relaunch, not a fresh
// interactive buy()) must be correctly rejected, must record ITS OWN real
// purchase date rather than today, and must never block a genuinely new
// purchase attempt. These are the EXACT field values from the real account
// data reported for this review (transactionId/originalTransactionId/dates);
// no real Apple/iPhone device was used -- this is the same test-chain-signed
// JWS fixture every other test in this file uses, carrying those exact values.
// ======================================================================================
test('Real production symptom: a weeks-late reprocessed, genuinely expired transaction is correctly rejected, records its REAL purchase date (not today), and does not block a subsequent genuine purchase', async () => {
  const A = await register('stale-sandbox');

  // The exact values from the real account's reported data.
  const realTransactionId = '2000001245102609';
  const realOriginalTransactionId = '2000001174918064';
  const realPurchaseMs = 1790864337000; // 1 Oct 2026 17:18:57 TR
  const realExpiresMs = 1790950737000; // 2 Oct 2026 17:18:57 TR -- a 1-day sandbox test window
  const receipt = jws({
    transactionId: realTransactionId,
    originalTransactionId: realOriginalTransactionId,
    productId: 'pro_premium_12ay',
    bundleId: BUNDLE,
    environment: 'Sandbox',
    purchaseDate: realPurchaseMs,
    expiresDate: realExpiresMs,
  });

  const r = await verify(A.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt,
    transactionId: realTransactionId,
  });
  // The real symptom: Apple's own data says this already expired weeks ago
  // (`realExpiresMs` is always in the past by the time this test runs) --
  // it must be rejected as expired, never silently granted.
  assert.equal(r.body.verified, false, JSON.stringify(r.body));
  assert.equal(r.body.status, 'expired', JSON.stringify(r.body));
  assert.equal(await premiumOf(A.ownerId), null, 'an already-expired transaction must never grant Premium');

  // The concrete code bug: the purchase-event row's OWN record of this
  // transaction must carry the REAL, Apple-verified purchase date -- never
  // "whenever our backend happened to process this", which for a
  // redelivered/late-reprocessed transaction can be weeks after the truth.
  const row = await strapiInstance.db
    .query('api::purchase-event.purchase-event')
    .findOne({ where: { transactionId: realTransactionId } });
  assert.ok(row, 'a purchase-event row must exist for this transaction');
  assert.equal(
    new Date(row.purchasedAt).getTime(),
    realPurchaseMs,
    `purchasedAt must be the real Apple purchase date, not today (got ${row.purchasedAt})`,
  );
  assert.notEqual(
    new Date(row.purchasedAt).getTime(),
    new Date(row.verifiedAt).getTime(),
    'purchasedAt (the real purchase time) and verifiedAt (when WE processed it) must be recorded as the two DIFFERENT things they are',
  );

  // The old, already-dead transaction must never block (nor get confused
  // with) a genuinely NEW purchase for the same product/account.
  const fresh = appleTransactionJws('pro_premium_12ay', 30);
  const r2 = await verify(A.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: fresh.receipt,
    transactionId: fresh.transactionId,
  });
  assert.equal(r2.body.verified, true, JSON.stringify(r2.body));
  assert.ok(isActive(await premiumOf(A.ownerId)), 'a genuinely new purchase must succeed normally afterwards');
});

// ======================================================================================
// F. Review follow-up: an UNVERIFIED client claim must never win a permanent ownership
// lock over a transaction identity it never actually proved it owns.
// ======================================================================================

test('BUG (now fixed): account A submits an invalid/unsigned receipt but CLAIMS account B\'s real (not-yet-seen) transactionId in the request body; this creates a rejected purchase-event row under A -- account B then presenting the REAL, validly Apple-signed data for that exact transaction must NOT be blocked by A\'s unverified claim', async () => {
  const A = await register('claimer');
  const B = await register('victim');
  const real = appleTransactionJws('pro_premium_12ay', 30, `100${uid()}`);

  // A never actually owns this transaction and never passes Apple's signature
  // check -- but the request body's `transactionId` is just a free-text lookup
  // hint the controller accepts from any caller, and A sets it to B's real,
  // not-yet-verified transaction id.
  const aClaim = await verify(A.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: `garbage-not-a-real-jws-${uid()}`,
    transactionId: real.transactionId,
  });
  assert.notEqual(aClaim.body.verified, true, JSON.stringify(aClaim.body));
  assert.equal(await premiumOf(A.ownerId), null, 'A must never gain an entitlement from a fake receipt');

  // B now presents the REAL, validly-signed transaction for that exact id.
  const bReal = await verify(B.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: real.receipt,
    transactionId: real.transactionId,
  });
  assert.equal(bReal.body.verified, true, JSON.stringify(bReal.body));
  assert.ok(isActive(await premiumOf(B.ownerId)), "B's genuinely verified purchase must be granted");
});

test('a GENUINELY Apple-signed transaction for the WRONG bundle (a different app) must not let the SENDER claim ownership of an arbitrary transactionId it asserts -- B\'s later REAL data for that id must still go through', async () => {
  const A = await register('wrong-bundle-claimer');
  const B = await register('wrong-bundle-victim');
  const victimTx = `100${uid()}`;
  // A's own receipt is a REAL, validly-signed Apple JWS -- just for a
  // different app's bundle id. The signature itself is genuine; the
  // claimed identity (whatever transactionId A's request asserts) is not.
  const wrongBundle = appleTransactionJws('pro_premium_12ay', 30, `other-${uid()}`, {
    bundleId: 'com.someone.else',
  });
  const real = appleTransactionJws('pro_premium_12ay', 30, victimTx);

  const aClaim = await verify(A.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: wrongBundle.receipt,
    transactionId: real.transactionId,
  });
  assert.notEqual(aClaim.body.verified, true, JSON.stringify(aClaim.body));
  assert.equal(await premiumOf(A.ownerId), null);

  const bReal = await verify(B.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: real.receipt,
    transactionId: real.transactionId,
  });
  assert.equal(bReal.body.verified, true, JSON.stringify(bReal.body));
  assert.ok(isActive(await premiumOf(B.ownerId)), "B's genuinely verified purchase must be granted");
});

test('a GENUINELY verified purchase keeps its ownership protection even after it legitimately expires/is refunded -- a later claim by a different account on the SAME transaction identity is still blocked', async () => {
  const A = await register('expired-owner');
  const B = await register('later-claimer');
  const real = appleTransactionJws('pro_premium_12ay', 30, `100${uid()}`, { revoked: Date.now() });

  // A's purchase is genuinely Apple-signed but already revoked/refunded at the
  // store -- verified: false, status: 'refunded' (never 'verified'), yet this
  // is a REAL transaction that really was A's.
  const aReal = await verify(A.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: real.receipt,
    transactionId: real.transactionId,
  });
  assert.notEqual(aReal.body.verified, true, JSON.stringify(aReal.body));

  // B later tries to claim the exact same transaction identity. Even though
  // A's own record was never `verified` (it was refunded), this is a REAL
  // transaction A's receipt genuinely decoded to -- B must still be refused.
  const bClaim = await verify(B.jwt, {
    productId: 'pro_premium_12ay',
    platform: 'ios',
    receipt: real.receipt,
    transactionId: real.transactionId,
  });
  assert.equal(bClaim.status, 403, JSON.stringify(bClaim.body));
  assert.equal(await premiumOf(B.ownerId), null);
});
