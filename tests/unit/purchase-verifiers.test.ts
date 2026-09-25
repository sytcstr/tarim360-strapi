/**
 * Unit tests for the store-native verifiers used by the purchase webhooks:
 *  - verifyAppleJws: Apple's certificate-chain + ES256 verification
 *  - verifyPubSubOidc: Google Pub/Sub push OIDC token verification
 * Test-only certificate chains live in tests/fixtures/apple-test-chain (generated
 * with openssl; NOT Apple's and NOT secret).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAppleJws } from '../../src/api/purchase/lib/apple-jws.ts';
import { GOOGLE_CERTS_URL, resetGoogleJwksCache, verifyPubSubOidc } from '../../src/api/purchase/lib/google-oidc.ts';

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

const TRUST = [fp('root.pem')];

test('Apple JWS: a correctly signed payload from a trusted chain verifies and decodes', () => {
  const out = verifyAppleJws(signJws({ notificationType: 'DID_RENEW', n: 1 }), { trustedRootSha256: TRUST });
  assert.equal(out.notificationType, 'DID_RENEW');
});

test('Apple JWS: a chain that does not end in a trusted (pinned) root is rejected', () => {
  const evil = signJws({ x: 1 }, { keyFile: 'evil-leaf.key', x5c: [der('evil-leaf.pem'), der('evil-root.pem'), der('evil-root.pem')] });
  assert.throws(() => verifyAppleJws(evil, { trustedRootSha256: TRUST }));
});

test('Apple JWS: the real Apple root pin is NOT satisfied by the test chain', () => {
  const APPLE_G3 = '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179';
  assert.throws(() => verifyAppleJws(signJws({ x: 1 }), { trustedRootSha256: [APPLE_G3] }));
});

test('Apple JWS: a payload tampered after signing is rejected', () => {
  const [h, , s] = signJws({ notificationType: 'DID_RENEW' }).split('.');
  const forged = `${h}.${b64u(JSON.stringify({ notificationType: 'SUBSCRIBED', expiresDate: 9999999999999 }))}.${s}`;
  assert.throws(() => verifyAppleJws(forged, { trustedRootSha256: TRUST }));
});

test('Apple JWS: a signature made with a different key (attacker signs, presents the real chain) is rejected', () => {
  assert.throws(() => verifyAppleJws(signJws({ x: 1 }, { keyFile: 'evil-leaf.key' }), { trustedRootSha256: TRUST }));
});

test('Apple JWS: an intermediate that did not sign the leaf is rejected', () => {
  const bad = signJws({ x: 1 }, { x5c: [der('evil-leaf.pem'), der('intermediate.pem'), der('root.pem')], keyFile: 'evil-leaf.key' });
  assert.throws(() => verifyAppleJws(bad, { trustedRootSha256: TRUST }));
});

test('Apple JWS: alg other than ES256, or a missing x5c chain, is rejected', () => {
  assert.throws(() => verifyAppleJws(signJws({ x: 1 }, { alg: 'none' }), { trustedRootSha256: TRUST }));
  assert.throws(() => verifyAppleJws(signJws({ x: 1 }, { alg: 'HS256' }), { trustedRootSha256: TRUST }));
  assert.throws(() => verifyAppleJws(signJws({ x: 1 }, { x5c: [der('leaf.pem')] }), { trustedRootSha256: TRUST }));
  assert.throws(() => verifyAppleJws('not.a.jws.at.all', { trustedRootSha256: TRUST }));
  assert.throws(() => verifyAppleJws('', { trustedRootSha256: TRUST }));
});

test('Apple JWS: certificates outside their validity window are rejected', () => {
  assert.throws(() =>
    verifyAppleJws(signJws({ x: 1 }), { trustedRootSha256: TRUST, effectiveDate: new Date('2300-01-01') }),
  );
});

// ---------------------------------------------------------------------------
// Google Pub/Sub OIDC
// ---------------------------------------------------------------------------
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';
const jwk = { ...(rsa.publicKey.export({ format: 'jwk' }) as object), kid: KID, alg: 'RS256', use: 'sig' };
const AUD = 'https://example.test/api/purchases/webhooks/google-play';
const SA = 'pubsub-push@tarim360.iam.gserviceaccount.com';

const mintToken = (claims: Record<string, unknown>, opts: { kid?: string; key?: crypto.KeyObject; alg?: string } = {}) => {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true, iat: now, exp: now + 3600, ...claims };
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(body));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), opts.key ?? rsa.privateKey);
  return `${h}.${p}.${b64u(sig)}`;
};

const realFetch = globalThis.fetch;
let certFetches = 0;
test.before(() => {
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url) === GOOGLE_CERTS_URL) {
      certFetches++;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, init);
  }) as typeof fetch;
});
test.after(() => {
  globalThis.fetch = realFetch;
});

const check = (token: string, over: Partial<{ audience: string; serviceAccountEmail: string }> = {}) =>
  verifyPubSubOidc(`Bearer ${token}`, { audience: AUD, serviceAccountEmail: SA, ...over });

test('Google OIDC: a valid token for the configured audience and service account is accepted', async () => {
  resetGoogleJwksCache();
  assert.deepEqual(await check(mintToken({})), { ok: true });
});

test('Google OIDC: wrong audience, wrong service account, unverified email, wrong issuer, expired -> rejected', async () => {
  assert.equal((await check(mintToken({ aud: 'https://evil.test' }))).ok, false);
  assert.equal((await check(mintToken({ email: 'attacker@evil.iam.gserviceaccount.com' }))).ok, false);
  assert.equal((await check(mintToken({ email_verified: false }))).ok, false);
  assert.equal((await check(mintToken({ iss: 'https://evil.example' }))).ok, false);
  assert.equal((await check(mintToken({ exp: Math.floor(Date.now() / 1000) - 3600 }))).ok, false);
});

test('Google OIDC: forged signature, unknown kid, alg none, garbage, missing header are rejected', async () => {
  assert.equal((await check(mintToken({}, { key: otherRsa.privateKey }))).ok, false);
  assert.equal((await check(mintToken({}, { kid: 'unknown-kid' }))).ok, false);
  assert.equal((await check(mintToken({}, { alg: 'none' }))).ok, false);
  assert.equal((await check('not-a-jwt')).ok, false);
  assert.equal((await verifyPubSubOidc('', { audience: AUD, serviceAccountEmail: SA })).ok, false);
  assert.equal((await verifyPubSubOidc('Basic abc', { audience: AUD, serviceAccountEmail: SA })).ok, false);
});

test('Google OIDC: an unconfigured audience / service account fails CLOSED (never accepts)', async () => {
  const t = mintToken({});
  assert.equal((await check(t, { audience: '' })).ok, false);
  assert.equal((await check(t, { serviceAccountEmail: '' })).ok, false);
});

test('Google OIDC: Google keys are cached (one fetch serves many verifications)', async () => {
  resetGoogleJwksCache();
  const before = certFetches;
  await check(mintToken({}));
  await check(mintToken({}));
  await check(mintToken({}));
  assert.equal(certFetches - before, 1);
});
