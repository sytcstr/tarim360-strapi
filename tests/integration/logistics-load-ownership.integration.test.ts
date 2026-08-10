/**
 * SEMANTIC_CONTRACT_S1 — logistics-load ownership actor-key fix.
 *
 * Root cause: canOwnLoad compared `load.ownerKey` against a real-Strapi-
 * numeric-user-id-based scheme (`profile:<user.id>`), but Flutter's own
 * `_currentLogisticsActorKey()` (logistics_models.dart) always sends
 * `id:u_<normalized-email>` (email-derived, via AuthService.currentOwnerId
 * -> StrapiService.ownerIdFromEmail). No branch of the old check could
 * ever match that format, so a real owner's own update/delete always
 * 403'd. Fixed by adding a canonical check (matchesOwnerKey against
 * readIdentity's email-derived ownerId -- the same comparison
 * logistics-offer.ts's transporter-ownership check already used
 * successfully) ahead of the legacy branches, which are kept for
 * backward compatibility only (never written by current code).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-logistics-load-ownership-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-logistics-load-ownership-test.db');
const PORT = 14159;
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

async function registerAndLogin(email: string): Promise<{ jwt: string; ownerId: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  // Mirrors StrapiService.ownerIdFromEmail / utils/identity.ts's
  // ownerIdFromEmail exactly: 'u_' + email with non-alnum -> '_'.
  const ownerId = `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt, ownerId };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

// Exactly what Flutter's _currentLogisticsActorKey() produces for a
// logged-in user: `id:${AuthService.currentOwnerId}`.
const canonicalActorKey = (ownerId: string) => `id:${ownerId}`;

/**
 * Creates a logistics-load row directly through entityService, bypassing
 * the require-logistics-premium policy that gates the real POST
 * /logistics-loads route (see logistics-load-engagement.integration.test.ts's
 * identical rationale) -- that policy is unrelated to this suite, which
 * is only concerned with the update/delete ownership check once a load
 * already exists. `update`/`delete` carry no such policy (confirmed via
 * routes/logistics-load.ts), so exercising them through the real HTTP
 * routes below still genuinely proves the ownership fix.
 */
async function createLoad(ownerKey: string, overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::logistics-load.logistics-load', {
    data: {
      title: 'Test Yuku',
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
      ownerName: 'Test Sahibi',
      ownerKey,
      status: 'open',
      viewCount: 0,
      likeCount: 0,
      favoriteCount: 0,
      ...overrides,
    },
  });
}

test('a load created with the canonical actor key is owner-editable', async () => {
  const { jwt, ownerId } = await registerAndLogin(`load-owner-${randomUUID()}@test.local`);
  const load = await createLoad(canonicalActorKey(ownerId));
  assert.equal(load.ownerKey, canonicalActorKey(ownerId));
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { title: 'Confirms canonical key match' } }),
  });
  assert.equal(res.status, 200, 'the exact key Flutter sends (id:u_<email>) must be owner-editable');
});

test('owner can edit their own load (canonical key)', async () => {
  const { jwt, ownerId } = await registerAndLogin(`load-edit-${randomUUID()}@test.local`);
  const load = await createLoad(canonicalActorKey(ownerId));
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { title: 'Guncellenmis Yuk' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.title, 'Guncellenmis Yuk');
});

test('owner can deactivate (status update) their own load (canonical key)', async () => {
  const { jwt, ownerId } = await registerAndLogin(`load-deact-${randomUUID()}@test.local`);
  const load = await createLoad(canonicalActorKey(ownerId));
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { status: 'closed' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.status, 'closed');
});

test('owner can delete their own load (canonical key)', async () => {
  const { jwt, ownerId } = await registerAndLogin(`load-del-${randomUUID()}@test.local`);
  const load = await createLoad(canonicalActorKey(ownerId));
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  assert.equal(res.status, 200);
  const row = await strapiInstance.db
    .query('api::logistics-load.logistics-load')
    .findOne({ where: { id: load.id } } as any);
  assert.equal(row, null);
});

test('a stranger cannot edit someone else\'s load', async () => {
  const owner = await registerAndLogin(`load-owner2-${randomUUID()}@test.local`);
  const load = await createLoad(canonicalActorKey(owner.ownerId));
  const stranger = await registerAndLogin(`load-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'PUT',
    headers: authed(stranger.jwt),
    body: JSON.stringify({ data: { title: 'Hacked' } }),
  });
  assert.equal(res.status, 403);
});

test('a stranger cannot delete someone else\'s load', async () => {
  const owner = await registerAndLogin(`load-owner3-${randomUUID()}@test.local`);
  const load = await createLoad(canonicalActorKey(owner.ownerId));
  const stranger = await registerAndLogin(`load-stranger2-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'DELETE',
    headers: authed(stranger.jwt),
  });
  assert.equal(res.status, 403);
});

test('legacy profile:<real Strapi id> ownerKey is still recognized for the real owner (backward compatibility)', async () => {
  const owner = await registerAndLogin(`load-legacy-owner-${randomUUID()}@test.local`);
  const meRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(owner.jwt) });
  const me = await meRes.json();
  // A pre-existing row using the OLD scheme this code used before the
  // S1 fix -- never written by current app code, but must remain
  // editable by its real owner.
  const load = await createLoad(`profile:${me.id}`);
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({ data: { title: 'Legacy format still works' } }),
  });
  assert.equal(res.status, 200);
});

test('a different user cannot access a legacy-format record they do not own', async () => {
  const owner = await registerAndLogin(`load-legacy-owner2-${randomUUID()}@test.local`);
  const meRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(owner.jwt) });
  const me = await meRes.json();
  const load = await createLoad(`profile:${me.id}`);
  const stranger = await registerAndLogin(`load-legacy-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/logistics-loads/${load.documentId}`, {
    method: 'PUT',
    headers: authed(stranger.jwt),
    body: JSON.stringify({ data: { title: 'Should not work' } }),
  });
  assert.equal(res.status, 403);
});
