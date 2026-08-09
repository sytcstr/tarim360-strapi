/**
 * Faz D8-V-B — Profile View engagement backend precondition.
 *
 * Covers two new pieces, both scoped strictly to targetType='profile':
 * 1. GET /profile-view-target/:ownerId (services/engagement-profile-lookup.ts,
 *    controllers/engagement-profile.ts, routes/engagement-profile.ts) — the
 *    narrow, non-owner-reachable bridge from Flutter's ownerId to the real
 *    profile-setting row id the generic engagement routes require.
 * 2. The self-view guard added to controllers/engagement-v1.ts's postView —
 *    a profile's own owner must never inflate their own view count.
 *
 * No other domain, and no other profile-setting behavior (favorite/follow/
 * rating/comments, the ownership policy itself), is touched by this phase —
 * several tests below exist specifically to prove that.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file — see before() below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ownerIdFromEmail } from '../../src/utils/identity.ts';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-profile-view-engagement-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-profile-view-engagement-test.db');
const PORT = 14155;
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

/** Creates the caller's own profile-setting row via the real, policy-gated
 * REST route (POST /profile-settings) — profileId is always forced to the
 * caller's own ownerId by global::profile-setting-ownership regardless of
 * what's sent, so this is the only realistic way to seed one. */
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
  return { jwt, ownerId: ownerIdFromEmail(email), profile };
}

// ---------------------------------------------------------------------
// Lookup: GET /profile-view-target/:ownerId
// ---------------------------------------------------------------------

test('lookup: an existing owner resolves to target/viewCount/serverVersion/contractVersion', async () => {
  const { ownerId } = await setupProfile(`lookup-target-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/profile-view-target/${ownerId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.target.type, 'profile');
  assert.equal(typeof body.target.id, 'string');
  assert.notEqual(body.target.id, '', 'must resolve to the real profile-setting row id, not echo ownerId back');
  assert.equal(body.viewCount, 0);
  assert.equal(body.serverVersion, 0);
  assert.equal(body.contractVersion, '1');
});

test('lookup: a non-existent owner returns 404 NOT_FOUND', async () => {
  const res = await fetch(`${BASE_URL}/profile-view-target/u_nobody_${randomUUID()}`);
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('lookup: response exposes only the allowlisted fields — no private profile-setting data leaks', async () => {
  const secretPhone = `secret-phone-${randomUUID()}`;
  const { ownerId } = await setupProfile(`lookup-privacy-${randomUUID()}@test.local`, {
    phone: secretPhone,
    bio: 'a very private bio',
    aboutText: 'private about text',
  });
  const res = await fetch(`${BASE_URL}/profile-view-target/${ownerId}`);
  const raw = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!raw.includes(secretPhone), 'phone must never appear in the lookup response');
  assert.ok(!raw.includes('very private bio'), 'bio must never appear in the lookup response');
  const body = JSON.parse(raw);
  assert.deepEqual(
    new Set(Object.keys(body)),
    new Set(['success', 'target', 'viewCount', 'serverVersion', 'contractVersion']),
    'response must contain exactly the documented fields, nothing else',
  );
  assert.deepEqual(new Set(Object.keys(body.target)), new Set(['type', 'id']));
});

test('lookup: reachable without any Authorization header (guest profile viewing must keep working)', async () => {
  const { ownerId } = await setupProfile(`lookup-guest-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/profile-view-target/${ownerId}`, {
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
});

test('lookup: resolves identically when called by a different logged-in user (non-owner)', async () => {
  const { ownerId } = await setupProfile(`lookup-owner-${randomUUID()}@test.local`);
  const strangerJwt = await registerAndLogin(`lookup-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/profile-view-target/${ownerId}`, {
    headers: authed(strangerJwt),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.target.type, 'profile');
});

// ---------------------------------------------------------------------
// View mutation: POST /engagements/view targetType=profile
// ---------------------------------------------------------------------

async function lookupTarget(ownerId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/profile-view-target/${ownerId}`);
  const body = await res.json();
  return body.target.id as string;
}

test('view: a stranger viewing a profile for the first time increments and returns incremented:true', async () => {
  const { ownerId } = await setupProfile(`view-target-${randomUUID()}@test.local`);
  const targetId = await lookupTarget(ownerId);
  const viewerJwt = await registerAndLogin(`view-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(viewerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.incremented, true);
  assert.equal(body.count, 1);
});

test('view: repeating within 24h does not increment again', async () => {
  const { ownerId } = await setupProfile(`view-target-${randomUUID()}@test.local`);
  const targetId = await lookupTarget(ownerId);
  const viewerJwt = await registerAndLogin(`view-stranger-${randomUUID()}@test.local`);
  await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(viewerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId }),
  });
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(viewerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId }),
  });
  const body = await res.json();
  assert.equal(body.incremented, false);
  assert.equal(body.count, 1);
});

test('view: after the 24h window elapses, a new view increments again', async () => {
  const { ownerId } = await setupProfile(`view-target-${randomUUID()}@test.local`);
  const targetId = await lookupTarget(ownerId);
  const viewerEmail = `view-stranger-${randomUUID()}@test.local`;
  const viewerJwt = await registerAndLogin(viewerEmail);
  await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(viewerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId }),
  });
  // registerView stores the RESOLVED row's own numeric id as targetId on
  // the engagement-view row, not the documentId this test (and Flutter)
  // sends as targetId -- so the staleness update below must match by
  // actorKey+targetType, not by re-deriving/guessing the numeric id.
  const viewerActorKey = `user:${viewerEmail.toLowerCase()}`;
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await strapiInstance.db.query('api::engagement-view.engagement-view').updateMany({
    where: { actorKey: viewerActorKey, targetType: 'profile' },
    data: { lastViewedAt: staleDate },
  });
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(viewerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId }),
  });
  const body = await res.json();
  assert.equal(body.incremented, true);
  assert.equal(body.count, 2);
});

test('view: the profile owner viewing their own profile returns incremented:false and never increments', async () => {
  const { ownerId, jwt: ownerJwt } = await setupProfile(`view-self-${randomUUID()}@test.local`);
  const targetId = await lookupTarget(ownerId);
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(ownerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.incremented, false);
  assert.equal(body.count, 0);
});

test('view: repeated self-views never write a dedup row, and a real stranger view afterwards still counts as the first', async () => {
  const email = `view-self-dedup-${randomUUID()}@test.local`;
  const { ownerId, jwt: ownerJwt } = await setupProfile(email);
  const targetId = await lookupTarget(ownerId);

  for (let i = 0; i < 3; i++) {
    await fetch(`${BASE_URL}/engagements/view`, {
      method: 'POST',
      headers: authed(ownerJwt),
      body: JSON.stringify({ targetType: 'profile', targetId }),
    });
  }

  const ownerActorKey = `user:${email.toLowerCase()}`;
  const ownRows = await strapiInstance.db.query('api::engagement-view.engagement-view').findMany({
    where: { actorKey: ownerActorKey, targetType: 'profile' },
  });
  assert.equal(ownRows.length, 0, 'self-views must never write an engagement-view row');

  const strangerJwt = await registerAndLogin(`view-real-visitor-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(strangerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId }),
  });
  const body = await res.json();
  assert.equal(body.incremented, true);
  assert.equal(body.count, 1, 'the owner\'s self-views must not have consumed any real count');
});

test('view: two concurrent first-views from the same (non-owner) actor increment exactly once', async () => {
  const { ownerId } = await setupProfile(`view-target-${randomUUID()}@test.local`);
  const targetId = await lookupTarget(ownerId);
  const viewerJwt = await registerAndLogin(`view-concurrent-${randomUUID()}@test.local`);
  const fire = () =>
    fetch(`${BASE_URL}/engagements/view`, {
      method: 'POST',
      headers: authed(viewerJwt),
      body: JSON.stringify({ targetType: 'profile', targetId }),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(Math.max(a.count, b.count), 1);
  assert.equal([a.incremented, b.incremented].filter(Boolean).length, 1);
});

test('view: a client-supplied count is ignored — server always computes it', async () => {
  const { ownerId } = await setupProfile(`view-target-${randomUUID()}@test.local`);
  const targetId = await lookupTarget(ownerId);
  const viewerJwt = await registerAndLogin(`view-spoof-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(viewerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId, count: 999999, viewCount: 999999 }),
  });
  const body = await res.json();
  assert.equal(body.count, 1, 'server must ignore the client-supplied count entirely');
});

test('view: an invalid/non-existent profile target returns NOT_FOUND', async () => {
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetType: 'profile', targetId: 'not-a-real-document-id', guestActorId: randomUUID() }),
  });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('view: a guest (no JWT, guestActorId only) can register a view on someone else\'s profile', async () => {
  const { ownerId } = await setupProfile(`view-target-${randomUUID()}@test.local`);
  const targetId = await lookupTarget(ownerId);
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetType: 'profile', targetId, guestActorId: randomUUID() }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.incremented, true);
  assert.equal(body.count, 1);
});

// ---------------------------------------------------------------------
// Regression — D8-V-B must not touch any of this
// ---------------------------------------------------------------------

// NOTE: a planned regression test asserting "GET /profile-settings?filters
// still only returns the caller's own document" was REMOVED here, not
// skipped silently. Writing it surfaced a real, pre-existing, confirmed
// (via this real boot) bug in global::profile-setting-ownership: its GET
// branch mutates `ctx.query` to force `filters.profileId` to the caller's
// own ownerId, but `ctx.query` is empty at the time the policy runs (a
// debug trace showed `before: {}` even with a real querystring on the
// request), so the mutation never reaches the controller and the
// client-supplied filter is honored as-is -- any authenticated user can
// currently read ANY other user's full profile-setting document (phone,
// bio, favorites, follow lists, etc.) via this route. This is entirely
// outside D8-V-B's scope (this phase never touches that policy, and the
// new lookup endpoint added here does not depend on it), so it is not
// fixed here -- see PROFILE_VIEW_BACKEND_D8V_REPORT.md and the message
// to the user for the full writeup instead of asserting broken behavior
// as if it were an intended, tested contract.

test('regression: a non-owner still cannot PUT another user\'s profile-setting document', async () => {
  const { profile } = await setupProfile(`regress-write-target-${randomUUID()}@test.local`);
  const strangerJwt = await registerAndLogin(`regress-write-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/profile-settings/${profile.documentId}`, {
    method: 'PUT',
    headers: authed(strangerJwt),
    body: JSON.stringify({ data: { displayName: 'Hijacked' } }),
  });
  assert.equal(res.status, 403);
});

test('regression: a non-owner still cannot GET another user\'s profile-setting document by id', async () => {
  const { profile } = await setupProfile(`regress-read-target-${randomUUID()}@test.local`);
  const strangerJwt = await registerAndLogin(`regress-read-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/profile-settings/${profile.documentId}`, {
    headers: authed(strangerJwt),
  });
  assert.equal(res.status, 403);
});
