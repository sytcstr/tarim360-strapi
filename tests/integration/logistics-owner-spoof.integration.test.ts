/**
 * FINAL_R1_TARGETED_RELEASE_FIX_REPORT.md R1.4 (FINAL-BUG-004, HIGH).
 *
 * logistics-load's `ownerKey` and logistics-vehicle's `transporterKey`
 * used to pass straight through from the client on create -- any
 * authenticated caller could set either to an arbitrary real person's
 * identity string, either impersonating that person's listing or handing
 * them unwanted edit/delete rights over content they never created
 * (canOwnLoad/canOwnVehicle both trust these same fields). Both create()
 * actions now force the field server-side from the JWT-derived identity,
 * in the same `id:<ownerId>` format matchesOwnerKey and Flutter's own
 * `_currentLogisticsActorKey()` already use -- the canonical S1 identity
 * comparison itself (SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md,
 * logistics-load-ownership.integration.test.ts /
 * logistics-vehicle-ownership.integration.test.ts) is unchanged.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-logistics-owner-spoof-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-logistics-owner-spoof-test.db');
const PORT = 14181;
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

async function registerAndLogin(email: string): Promise<{ jwt: string; ownerId: string; email: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  const ownerId = `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt, ownerId, email: email.trim().toLowerCase() };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });
const canonicalActorKey = (ownerId: string) => `id:${ownerId}`;

// POST /logistics-loads is gated by global::require-logistics-premium,
// which (as re-verified while writing this suite) actually requires BOTH
// an active premium subscription AND a logistics module entry -- not
// either/or. That policy ALSO force-stamps data.ownerKey = profile.
// profileId itself (line 114 of require-logistics-premium.ts) BEFORE the
// controller ever runs, which means logistics-load's create-time
// ownerKey spoof was already closed by this pre-existing policy; the
// controller-level fix below is confirmed-redundant defense-in-depth for
// loads specifically, not a newly-closed hole (see FINAL_R1 report for
// the full disclosure). logistics-vehicle's create route has no such
// policy at all, so its transporterKey fix is the sole real protection.
async function grantLogisticsModule(owner: { ownerId: string; email: string }) {
  const premium = { planTitle: 'Eco Premium', endsAt: null };
  return strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: {
      profileId: owner.ownerId,
      ownerEmail: owner.email,
      activeModules: ['logistics'],
      activePremium: premium,
      activePremiumSubscription: premium,
    },
  });
}

test('FINAL-BUG-004 (load): a spoofed ownerKey on create is ignored -- the real creator, not the claimed victim, ends up owning it', async () => {
  const attacker = await registerAndLogin(`r14-load-attacker-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`r14-load-victim-${randomUUID()}@test.local`);
  await grantLogisticsModule(attacker);

  const res = await fetch(`${BASE_URL}/logistics-loads`, {
    method: 'POST',
    headers: authed(attacker.jwt),
    body: JSON.stringify({
      data: {
        title: 'Spoofed Owner Yuku',
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
        ownerKey: canonicalActorKey(victim.ownerId),
        ownerName: victim.email,
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.data.ownerKey,
    canonicalActorKey(attacker.ownerId),
    'ownerKey must always be the real, JWT-derived creator identity, never the client-claimed one',
  );
  assert.notEqual(body.data.ownerKey, canonicalActorKey(victim.ownerId));

  const documentId = body.data.documentId;

  // The claimed victim must NOT be able to edit/delete this load.
  const victimEdit = await fetch(`${BASE_URL}/logistics-loads/${documentId}`, {
    method: 'PUT',
    headers: authed(victim.jwt),
    body: JSON.stringify({ data: { title: 'Victim tries to edit' } }),
  });
  assert.equal(victimEdit.status, 403, 'the spoofed target must never gain edit rights over content they never created');

  // The real creator must be able to edit their own load.
  const ownerEdit = await fetch(`${BASE_URL}/logistics-loads/${documentId}`, {
    method: 'PUT',
    headers: authed(attacker.jwt),
    body: JSON.stringify({ data: { title: 'Real creator edits successfully' } }),
  });
  assert.equal(ownerEdit.status, 200, 'the real creator must still be able to edit their own load (no regression)');
});

test('FINAL-BUG-004 (vehicle): a spoofed transporterKey on create is ignored -- the real creator ends up owning it', async () => {
  const attacker = await registerAndLogin(`r14-veh-attacker-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`r14-veh-victim-${randomUUID()}@test.local`);

  const res = await fetch(`${BASE_URL}/logistics-vehicles`, {
    method: 'POST',
    headers: authed(attacker.jwt),
    body: JSON.stringify({
      data: {
        transporterName: 'Spoofed Transporter Araci',
        vehicleType: 'Kamyon',
        capacity: 10,
        currentCity: 'Konya',
        latitude: 37.87,
        longitude: 32.48,
        transporterKey: canonicalActorKey(victim.ownerId),
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(
    body.data.transporterKey,
    canonicalActorKey(attacker.ownerId),
    'transporterKey must always be the real, JWT-derived creator identity, never the client-claimed one',
  );
  assert.notEqual(body.data.transporterKey, canonicalActorKey(victim.ownerId));

  const documentId = body.data.documentId;

  const victimEdit = await fetch(`${BASE_URL}/logistics-vehicles/${documentId}`, {
    method: 'PUT',
    headers: authed(victim.jwt),
    body: JSON.stringify({ data: { title: 'Victim tries to edit' } }),
  });
  assert.equal(victimEdit.status, 403, 'the spoofed target must never gain edit rights over content they never created');

  const ownerEdit = await fetch(`${BASE_URL}/logistics-vehicles/${documentId}`, {
    method: 'PUT',
    headers: authed(attacker.jwt),
    body: JSON.stringify({ data: { title: 'Real creator edits successfully' } }),
  });
  assert.equal(ownerEdit.status, 200, 'the real creator must still be able to edit their own vehicle (no regression)');
});

test('FINAL-BUG-004: an unauthenticated create is still rejected (no identity to stamp)', async () => {
  // 403, not 401: Strapi's own RBAC layer rejects an unauthenticated
  // request before this route's own handler/policy ever runs -- the same
  // behavior already established for other unauthenticated routes
  // elsewhere in this test suite (e.g. profile-setting-ownership).
  const res = await fetch(`${BASE_URL}/logistics-vehicles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        transporterName: 'No Auth Vehicle',
        vehicleType: 'Kamyon',
        capacity: 10,
        currentCity: 'Konya',
        latitude: 37.87,
        longitude: 32.48,
      },
    }),
  });
  assert.equal(res.status, 403);
});
