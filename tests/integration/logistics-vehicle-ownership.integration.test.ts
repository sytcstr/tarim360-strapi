/**
 * SEMANTIC_CONTRACT_S1 — logistics-vehicle ownership actor-key fix.
 *
 * Root cause: canOwnVehicle compared `vehicle.transporterKey` against a
 * real-Strapi-numeric-user-id-based scheme (`profile:<user.id>`), but
 * Flutter's own `_currentLogisticsActorKey()` (logistics_models.dart)
 * always sends `id:u_<normalized-email>` (email-derived, via
 * AuthService.currentOwnerId -> StrapiService.ownerIdFromEmail). No
 * branch of the old check could ever match that format, so a real
 * owner's own update/delete always 403'd. Fixed by adding a canonical
 * check (matchesOwnerKey against readIdentity's email-derived ownerId --
 * the same comparison logistics-offer.ts's transporter-ownership check
 * already used successfully) ahead of the legacy branches, which are
 * kept for backward compatibility only (never written by current code).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-logistics-vehicle-ownership-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-logistics-vehicle-ownership-test.db');
const PORT = 14160;
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
  const ownerId = `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt, ownerId };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

// Exactly what Flutter's _currentLogisticsActorKey() produces for a
// logged-in user: `id:${AuthService.currentOwnerId}`.
const canonicalActorKey = (ownerId: string) => `id:${ownerId}`;

async function createVehicle(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/logistics-vehicles`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        transporterName: 'Test Nakliyeci',
        vehicleType: 'Kamyon',
        capacity: 10,
        currentCity: 'Konya',
        latitude: 37.87,
        longitude: 32.48,
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  return json.data;
}

test('owner creates a vehicle using the canonical actor key', async () => {
  const { jwt, ownerId } = await registerAndLogin(`veh-owner-${randomUUID()}@test.local`);
  const vehicle = await createVehicle(jwt, { transporterKey: canonicalActorKey(ownerId) });
  assert.equal(vehicle.transporterKey, canonicalActorKey(ownerId));
});

test('owner can edit their own vehicle (canonical key)', async () => {
  const { jwt, ownerId } = await registerAndLogin(`veh-edit-${randomUUID()}@test.local`);
  const vehicle = await createVehicle(jwt, { transporterKey: canonicalActorKey(ownerId) });
  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { currentCity: 'Ankara' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.currentCity, 'Ankara');
});

test('owner can deactivate (available:false) their own vehicle (canonical key)', async () => {
  const { jwt, ownerId } = await registerAndLogin(`veh-deact-${randomUUID()}@test.local`);
  const vehicle = await createVehicle(jwt, { transporterKey: canonicalActorKey(ownerId) });
  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { available: false } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.available, false);
});

test('owner can delete their own vehicle (canonical key)', async () => {
  const { jwt, ownerId } = await registerAndLogin(`veh-del-${randomUUID()}@test.local`);
  const vehicle = await createVehicle(jwt, { transporterKey: canonicalActorKey(ownerId) });
  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  assert.equal(res.status, 200);
  const row = await strapiInstance.db
    .query('api::logistics-vehicle.logistics-vehicle')
    .findOne({ where: { id: vehicle.id } } as any);
  assert.equal(row, null);
});

test('a stranger cannot edit someone else\'s vehicle', async () => {
  const owner = await registerAndLogin(`veh-owner2-${randomUUID()}@test.local`);
  const vehicle = await createVehicle(owner.jwt, { transporterKey: canonicalActorKey(owner.ownerId) });
  const stranger = await registerAndLogin(`veh-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'PUT',
    headers: authed(stranger.jwt),
    body: JSON.stringify({ data: { currentCity: 'Hacked' } }),
  });
  assert.equal(res.status, 403);
});

test('a stranger cannot delete someone else\'s vehicle', async () => {
  const owner = await registerAndLogin(`veh-owner3-${randomUUID()}@test.local`);
  const vehicle = await createVehicle(owner.jwt, { transporterKey: canonicalActorKey(owner.ownerId) });
  const stranger = await registerAndLogin(`veh-stranger2-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'DELETE',
    headers: authed(stranger.jwt),
  });
  assert.equal(res.status, 403);
});

test('legacy profile:<real Strapi id> transporterKey is still recognized for the real owner (backward compatibility)', async () => {
  const owner = await registerAndLogin(`veh-legacy-owner-${randomUUID()}@test.local`);
  const meRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(owner.jwt) });
  const me = await meRes.json();
  // A pre-existing row using the OLD scheme this code used before the
  // S1 fix -- never written by current app code, but must remain
  // editable by its real owner.
  const vehicle = await createVehicle(owner.jwt, { transporterKey: `profile:${me.id}` });
  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({ data: { currentCity: 'Legacy format still works' } }),
  });
  assert.equal(res.status, 200);
});

test('a different user cannot access a legacy-format vehicle record they do not own', async () => {
  const owner = await registerAndLogin(`veh-legacy-owner2-${randomUUID()}@test.local`);
  const meRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(owner.jwt) });
  const me = await meRes.json();
  const vehicle = await createVehicle(owner.jwt, { transporterKey: `profile:${me.id}` });
  const stranger = await registerAndLogin(`veh-legacy-stranger-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'PUT',
    headers: authed(stranger.jwt),
    body: JSON.stringify({ data: { currentCity: 'Should not work' } }),
  });
  assert.equal(res.status, 403);
});
