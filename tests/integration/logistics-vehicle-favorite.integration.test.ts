/**
 * Production-blocker fix (post D-final) — logistics-vehicle favorite.
 *
 * The Flutter client was toggling vehicle favorites via the generic
 * listing-favorite toggle, treating a vehicle id as if it were a listing
 * id — the same class of cross-domain id-collision risk D4-F already
 * fixed for logistics-load (see
 * FAVORITES_LOCAL_MIRROR_AND_LOGISTICS_LOAD_D4F_REPORT.md). This suite
 * proves logistics-vehicle now has its own, correct favorite support in
 * the generic Engagement v1 engine (targetType='logistics-vehicle'),
 * exactly like logistics-load already has — no new route, no new engine,
 * just DOMAIN_SUPPORT/COUNTER_FIELD/schema completing what was already
 * there for view.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-logistics-vehicle-favorite-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-logistics-vehicle-favorite-test.db');
const PORT = 14158;
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

async function createVehicleOwnedByStranger(overrides: Record<string, unknown> = {}) {
  const ownerJwt = await registerAndLogin(`veh-owner-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/logistics-vehicles`, {
    method: 'POST',
    headers: authed(ownerJwt),
    body: JSON.stringify({
      data: {
        transporterName: 'Test Nakliyeci',
        transporterKey: `profile:owner-${randomUUID()}`,
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

const fetchRow = async (id: number | string) =>
  strapiInstance.db.query('api::logistics-vehicle.logistics-vehicle').findOne({ where: { id } } as any);

test('favorite: first PUT activates and increments favoriteCount (changed:true)', async () => {
  const jwt = await registerAndLogin(`fav-${randomUUID()}@test.local`);
  const vehicle = await createVehicleOwnedByStranger();
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: vehicle.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.changed, true);
  assert.equal(body.count, 1);
  const row = await fetchRow(vehicle.id);
  assert.equal(row.favoriteCount, 1);
});

test('favorite: a second PUT from the same user is a no-op (changed:false)', async () => {
  const jwt = await registerAndLogin(`fav-${randomUUID()}@test.local`);
  const vehicle = await createVehicleOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: vehicle.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: vehicle.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
});

test('favorite: DELETE deactivates and decrements', async () => {
  const jwt = await registerAndLogin(`fav-${randomUUID()}@test.local`);
  const vehicle = await createVehicleOwnedByStranger();
  await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: vehicle.id }),
  });
  // DELETE requests carry targetType/targetId as query params, not body —
  // Strapi/Koa leaves ctx.request.body empty for DELETE even with a JSON
  // body sent (same pattern as engagement.integration.test.ts).
  const res = await fetch(
    `${BASE_URL}/engagements/favorite?targetType=logistics-vehicle&targetId=${vehicle.id}`,
    {
      method: 'DELETE',
      headers: authed(jwt),
    },
  );
  const body = await res.json();
  assert.equal(body.active, false);
  assert.equal(body.count, 0);
  const row = await fetchRow(vehicle.id);
  assert.equal(row.favoriteCount, 0);
});

test('favorite: like is still rejected for logistics-vehicle (only favorite/view are supported)', async () => {
  const jwt = await registerAndLogin(`fav-${randomUUID()}@test.local`);
  const vehicle = await createVehicleOwnedByStranger();
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: vehicle.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'ENGAGEMENT_NOT_SUPPORTED');
});

test('favorite: non-existent vehicle returns NOT_FOUND', async () => {
  const jwt = await registerAndLogin(`fav-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: '999999999' }),
  });
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('generic update ignores a client-supplied favoriteCount/viewCount/engagementVersion for logistics-vehicle', async () => {
  // Owner identity must genuinely match canOwnVehicle's actorKeyFor (based
  // on the real Strapi user id) so the update actually reaches
  // stripEngagementFields instead of being rejected by the ownership
  // check first -- a stranger's PUT would 403 before ever exercising the
  // strip logic, which would prove nothing about it.
  const ownerJwt = await registerAndLogin(`veh-spoof-owner-${randomUUID()}@test.local`);
  const meRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(ownerJwt) });
  const me = await meRes.json();
  const vehicle = await createVehicleOwnedByStranger({ transporterKey: `profile:${me.id}` });

  const stranger = await registerAndLogin(`veh-spoof-fan-${randomUUID()}@test.local`);
  await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(stranger),
    body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: vehicle.id }),
  });

  const res = await fetch(`${BASE_URL}/logistics-vehicles/${vehicle.documentId}`, {
    method: 'PUT',
    headers: authed(ownerJwt),
    body: JSON.stringify({
      data: { favoriteCount: 99999, viewCount: 99999, engagementVersion: 99999 },
    }),
  });
  assert.equal(res.status, 200, 'the real owner must be able to update their own vehicle');
  const row = await fetchRow(vehicle.id);
  assert.equal(row.favoriteCount, 1, 'spoofed favoriteCount must not overwrite the real, server-computed value');
  assert.notEqual(row.engagementVersion, 99999);
});

test('two simultaneous favorite PUTs from the same user increment exactly once', async () => {
  const jwt = await registerAndLogin(`fav-concurrent-${randomUUID()}@test.local`);
  const vehicle = await createVehicleOwnedByStranger();
  const fire = () =>
    fetch(`${BASE_URL}/engagements/favorite`, {
      method: 'PUT',
      headers: authed(jwt),
      body: JSON.stringify({ targetType: 'logistics-vehicle', targetId: vehicle.id }),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(Math.max(a.count, b.count), 1);
  assert.equal([a.changed, b.changed].filter(Boolean).length, 1);
});
