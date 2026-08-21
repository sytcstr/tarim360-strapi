/**
 * SEC-1 — global::profile-setting-ownership's GET (filtered-list) branch.
 *
 * Discovered while writing D8-V-B's regression coverage: this branch tried
 * to force `filters.profileId` to the caller's own ownerId by assigning
 * `ctx.query = {...}`, but in Strapi's policy execution context `ctx.query`
 * is not the same delegated property as `ctx.request.query` (confirmed via
 * real debug instrumentation during a real boot, not inferred from reading
 * the code) -- Strapi's core `find` controller reads filters from
 * `ctx.request.query`, which the old code never touched, so the branch was
 * a complete no-op: any authenticated caller could read ANY other user's
 * full profile-setting document (phone, bio, favorites, follow lists,
 * incoming comments, etc.) by filtering on `profileId`, or on any other
 * field entirely, since the client's filters object was never constrained
 * at all.
 *
 * Scope of this fix and this file: ONLY the GET-list branch of
 * profile-setting-ownership. Nothing else in the app was touched -- the
 * `id`-based branch (GET/PUT/PATCH/DELETE by :id) already worked correctly
 * (uses a direct entity lookup + comparison, not a ctx.query mutation) and
 * is not modified here; its own coverage lives in
 * profile-view-engagement.integration.test.ts.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-profile-setting-ownership-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-profile-setting-ownership-test.db');
const PORT = 14156;
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

test('GET list filtered by profileId=<target>: a viewer with no profile-setting of their own gets an empty list, never the target\'s row', async () => {
  const targetJwt = await registerAndLogin(`sec1-target-${randomUUID()}@test.local`);
  const target = await createOwnProfileSetting(targetJwt, { phone: 'SECRET-1' });
  const viewerJwt = await registerAndLogin(`sec1-viewer-${randomUUID()}@test.local`);

  const res = await fetch(
    `${BASE_URL}/profile-settings?filters[profileId][\$eq]=${encodeURIComponent(target.profileId)}`,
    { headers: authed(viewerJwt) },
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body.data, [], 'a viewer with no own document must get an empty list, not the target\'s row');
});

test('GET list filtered by profileId=<target>: a viewer WITH their own document gets back only their own document', async () => {
  const targetJwt = await registerAndLogin(`sec1-target-${randomUUID()}@test.local`);
  const target = await createOwnProfileSetting(targetJwt, { phone: 'SECRET-2' });
  const viewerJwt = await registerAndLogin(`sec1-viewer-${randomUUID()}@test.local`);
  const viewerOwn = await createOwnProfileSetting(viewerJwt, { displayName: 'Viewer Own' });

  const res = await fetch(
    `${BASE_URL}/profile-settings?filters[profileId][\$eq]=${encodeURIComponent(target.profileId)}`,
    { headers: authed(viewerJwt) },
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].profileId, viewerOwn.profileId, 'must be the viewer\'s own row, never the target\'s');
  assert.notEqual(body.data[0].profileId, target.profileId);
});

test('GET list filtered by an unrelated field (displayName) matching only the target: still resolves to the caller\'s own scope, not the target', async () => {
  const targetJwt = await registerAndLogin(`sec1-target-${randomUUID()}@test.local`);
  await createOwnProfileSetting(targetJwt, { displayName: 'Very Unique Target Name', phone: 'SECRET-3' });
  const viewerJwt = await registerAndLogin(`sec1-viewer-${randomUUID()}@test.local`);

  const res = await fetch(
    `${BASE_URL}/profile-settings?filters[displayName][\$eq]=${encodeURIComponent('Very Unique Target Name')}`,
    { headers: authed(viewerJwt) },
  );
  const raw = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!raw.includes('SECRET-3'), 'the target\'s private data must not leak through a filter on an unrelated field');
  const body = JSON.parse(raw);
  assert.deepEqual(body.data, [], 'the viewer has no own document, so the forced self-scope must return empty');
});

test('GET list filtered by an unrelated field matching the VIEWER\'s own document: legitimate self-access still works', async () => {
  const viewerJwt = await registerAndLogin(`sec1-self-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(viewerJwt, { displayName: 'My Own Unique Name' });

  const res = await fetch(
    `${BASE_URL}/profile-settings?filters[displayName][\$eq]=${encodeURIComponent('My Own Unique Name')}`,
    { headers: authed(viewerJwt) },
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].profileId, own.profileId);
});

test('GET list: pagination/populate query params still pass through unaffected by the forced filter', async () => {
  const viewerJwt = await registerAndLogin(`sec1-pagination-${randomUUID()}@test.local`);
  await createOwnProfileSetting(viewerJwt);

  const res = await fetch(
    `${BASE_URL}/profile-settings?pagination[pageSize]=5&filters[profileId][\$eq]=irrelevant-because-forced`,
    { headers: authed(viewerJwt) },
  );
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.meta.pagination.pageSize, 5, 'pagination params must still be honored alongside the forced filter');
  assert.equal(body.data.length, 1, 'the forced filter must still resolve to the caller\'s own single document');
});

test('GET list with no filters at all still scopes to the caller\'s own document only', async () => {
  const targetJwt = await registerAndLogin(`sec1-target-${randomUUID()}@test.local`);
  await createOwnProfileSetting(targetJwt);
  const viewerJwt = await registerAndLogin(`sec1-viewer-${randomUUID()}@test.local`);
  const viewerOwn = await createOwnProfileSetting(viewerJwt);

  const res = await fetch(`${BASE_URL}/profile-settings`, { headers: authed(viewerJwt) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].profileId, viewerOwn.profileId);
});

test('regression: an unauthenticated GET list is still rejected', async () => {
  // 403, not 401: Strapi's own RBAC layer rejects this before our policy
  // ever runs (profile-setting.find is granted to the authenticated role
  // only, never public) -- confirmed by the real response below, unrelated
  // to and unaffected by the SEC-1 fix.
  const res = await fetch(`${BASE_URL}/profile-settings`, {
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------
// ENGAGEMENT_E2_TARGETED_FIX_REPORT.md BUG-ENG-007: viewCount/
// engagementVersion must never be settable through the generic create/
// update actions -- the canonical POST /engagements/view flow is the
// only real source of truth. Self-serving metric inflation, not a
// cross-user issue (the ownership policy already scopes writes to the
// caller's own row).
// ---------------------------------------------------------------------

test('BUG-ENG-007: a normal profile-setting update cannot spoof its own viewCount', async () => {
  const jwt = await registerAndLogin(`sec-viewcount-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(jwt);
  assert.equal(own.viewCount ?? 0, 0);

  const res = await fetch(`${BASE_URL}/profile-settings/${own.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { viewCount: 999999 } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.data.viewCount, 999999, 'a client-supplied viewCount must never be written');
  assert.equal(body.data.viewCount ?? 0, 0);
});

test('BUG-ENG-007: engagementVersion cannot be spoofed through the same update', async () => {
  const jwt = await registerAndLogin(`sec-engversion-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(jwt);

  const res = await fetch(`${BASE_URL}/profile-settings/${own.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { engagementVersion: 999999, displayName: 'Yeni Isim' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.data.engagementVersion, 999999);
  assert.equal(body.data.displayName, 'Yeni Isim', 'the rest of a legitimate update must still go through');
});

test('BUG-ENG-007: a legitimate bio/avatar/profile field update still works normally', async () => {
  const jwt = await registerAndLogin(`sec-legit-update-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(jwt);

  const res = await fetch(`${BASE_URL}/profile-settings/${own.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { bio: 'Yeni bio metni', city: 'Konya' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.bio, 'Yeni bio metni');
  assert.equal(body.data.city, 'Konya');
});

test('BUG-ENG-007: viewCount cannot be spoofed on create either', async () => {
  const jwt = await registerAndLogin(`sec-create-spoof-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/profile-settings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { displayName: 'Yeni Profil', viewCount: 500, engagementVersion: 500 } }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.data.viewCount ?? 0, 0);
  assert.equal(body.data.engagementVersion ?? 0, 0);
});

test('BUG-ENG-007 regression: the canonical POST /engagements/view flow still increments a profile\'s real viewCount', async () => {
  const targetJwt = await registerAndLogin(`sec-view-target-${randomUUID()}@test.local`);
  const target = await createOwnProfileSetting(targetJwt);
  const visitorJwt = await registerAndLogin(`sec-view-visitor-${randomUUID()}@test.local`);

  // engagement-v1's 'profile' target is resolved by the row's own
  // id/documentId (see engagement-core.ts's resolveTargetRow), not by the
  // profileId custom field -- that field is only used internally for the
  // self-view identity comparison below.
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(visitorJwt),
    body: JSON.stringify({ targetType: 'profile', targetId: target.documentId }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data?.count ?? body.count, 1, 'a real visitor view must still increment the profile viewCount');
});

test('BUG-ENG-007 regression: a self-view does not increment the profile\'s own viewCount', async () => {
  const ownerJwt = await registerAndLogin(`sec-selfview-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(ownerJwt);

  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(ownerJwt),
    body: JSON.stringify({ targetType: 'profile', targetId: own.documentId }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data?.count ?? body.count, 0, 'viewing your own profile must not inflate your own count');
});
