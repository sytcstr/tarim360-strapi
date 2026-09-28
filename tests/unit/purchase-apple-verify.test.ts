/**
 * UAT #14 (real-device 1.0.85 report): unit coverage for the FIXED `verifyApple`
 * (exercised through the exported `verifyWithProvider`, provider 'app_store').
 *
 * Root cause this locks in: the old `verifyApple` called Apple's legacy
 * `/verifyReceipt` REST endpoint, expecting a base64 App Store receipt blob
 * (StoreKit1's format). The Flutter app's `in_app_purchase_storekit` plugin
 * defaults to StoreKit2, whose `serverVerificationData` is a signed JWS
 * transaction string -- a different format the legacy endpoint cannot parse.
 * Every real iOS purchase therefore failed verification. The fix verifies the
 * JWS locally (same cryptographic chain-verification already proven correct
 * by the App Store Server Notifications webhook), with NO network call to
 * Apple at all.
 *
 * Uses the same test-only certificate chain / signing helper as
 * purchase-verifiers.test.ts (tests/fixtures/apple-test-chain; generated with
 * openssl, NOT Apple's and NOT secret).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FIX = path.join(__dirname, '..', 'fixtures', 'apple-test-chain');
const pem = (f: string) => fs.readFileSync(path.join(FIX, f), 'utf8');
const der = (f: string) => new crypto.X509Certificate(pem(f)).raw.toString('base64');
const fp = (f: string) => new crypto.X509Certificate(pem(f)).fingerprint256.replace(/[^0-9A-F]/gi, '').toUpperCase();
const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

const signJws = (payload: object, opts: { x5c?: string[]; keyFile?: string; alg?: string } = {}) => {
  const header = { alg: opts.alg ?? 'ES256', x5c: opts.x5c ?? [der('leaf.pem'), der('intermediate.pem'), der('root.pem')] };
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), { key: pem(opts.keyFile ?? 'leaf.key'), dsaEncoding: 'ieee-p1363' });
  return `${h}.${p}.${b64u(sig)}`;
};

const BUNDLE = 'com.tarim360.app';
process.env.APPLE_BUNDLE_ID = BUNDLE;
process.env.APPLE_TRUSTED_ROOT_SHA256 = fp('root.pem');
delete process.env.PURCHASE_VERIFY_SOFT; // soft-verify must stay OFF: this exercises the real verifier.

// Imported AFTER env is set: config.ts reads process.env lazily per-call, but
// importing after keeps this file's intent explicit either way.
import { verifyWithProvider } from '../../src/api/purchase/lib/providers.ts';

const tx = (over: Record<string, unknown> = {}) => ({
  transactionId: `T${crypto.randomUUID()}`,
  originalTransactionId: `O${crypto.randomUUID()}`,
  productId: 'pro_premium_12ay',
  bundleId: BUNDLE,
  expiresDate: Date.now() + 30 * 86_400_000,
  ...over,
});

const verifyApple = (receipt: string, over: Partial<{ productId: string; isSubscription: boolean }> = {}) =>
  verifyWithProvider({
    provider: 'app_store',
    productId: over.productId ?? 'pro_premium_12ay',
    receipt,
    purchaseToken: '',
    isSubscription: over.isSubscription ?? true,
    fallbackTransactionId: `fallback-${crypto.randomUUID()}`,
  });

test('Apple verify: a real signed StoreKit2 transaction (subscription, active) verifies', async () => {
  const t = tx();
  const out = await verifyApple(signJws(t));
  assert.equal(out.verified, true, JSON.stringify(out));
  assert.equal(out.status, 'verified');
  assert.equal(out.transactionId, t.transactionId);
  assert.equal(out.originalTransactionId, t.originalTransactionId);
});

test('Apple verify: a real signed StoreKit2 transaction (one-time product) verifies', async () => {
  const t = tx({ productId: 'easy_premium_12ay' });
  const out = await verifyApple(signJws(t), { productId: 'easy_premium_12ay', isSubscription: false });
  assert.equal(out.verified, true, JSON.stringify(out));
  assert.equal(out.status, 'verified');
});

test('Apple verify: an expired subscription is reported as expired, not verified', async () => {
  const t = tx({ expiresDate: Date.now() - 1000 });
  const out = await verifyApple(signJws(t));
  assert.equal(out.verified, false);
  assert.equal(out.status, 'expired');
});

test('Apple verify: a revoked/refunded transaction is reported as refunded (subscription and one-time)', async () => {
  const sub = tx({ revocationDate: Date.now() - 500 });
  const outSub = await verifyApple(signJws(sub));
  assert.equal(outSub.verified, false);
  assert.equal(outSub.status, 'refunded');

  const oneTime = tx({ productId: 'easy_premium_12ay', revocationDate: Date.now() - 500 });
  const outOneTime = await verifyApple(signJws(oneTime), { productId: 'easy_premium_12ay', isSubscription: false });
  assert.equal(outOneTime.verified, false);
  assert.equal(outOneTime.status, 'refunded');
});

test('Apple verify: a transaction for another app (wrong bundle id) is rejected', async () => {
  const t = tx({ bundleId: 'com.someone.else' });
  const out = await verifyApple(signJws(t));
  assert.equal(out.verified, false);
  assert.equal(out.status, 'rejected');
});

test('Apple verify: a transaction claiming a different product than requested is rejected (no product substitution)', async () => {
  const t = tx({ productId: 'easy_premium_12ay' }); // cheap plan
  const out = await verifyApple(signJws(t), { productId: 'pro_premium_12ay' }); // claims expensive plan
  assert.equal(out.verified, false);
  assert.equal(out.status, 'rejected');
});

test('Apple verify: a chain signed by an untrusted root is rejected (never network-verified against a fake Apple)', async () => {
  const evil = signJws(tx(), { keyFile: 'evil-leaf.key', x5c: [der('evil-leaf.pem'), der('evil-root.pem'), der('evil-root.pem')] });
  const out = await verifyApple(evil);
  assert.equal(out.verified, false);
  assert.equal(out.status, 'rejected');
});

test('Apple verify: a tampered payload (signature no longer matches) is rejected', async () => {
  const [h, , s] = signJws(tx()).split('.');
  const tampered = `${h}.${b64u(JSON.stringify(tx({ expiresDate: Date.now() + 999 * 86_400_000 })))}.${s}`;
  const out = await verifyApple(tampered);
  assert.equal(out.verified, false);
  assert.equal(out.status, 'rejected');
});

test('Apple verify: garbage / legacy-shaped (non-JWS) receipt is rejected, never crashes', async () => {
  const legacyLooking = Buffer.from(JSON.stringify({ status: 0, receipt: { bundle_id: BUNDLE } })).toString('base64');
  const out = await verifyApple(legacyLooking);
  assert.equal(out.verified, false);
  assert.equal(out.status, 'rejected');

  const empty = await verifyApple('');
  assert.equal(empty.verified, false);
  assert.equal(empty.status, 'rejected');
});
