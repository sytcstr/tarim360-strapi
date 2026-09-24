/**
 * Full-app reconciliation finding (data exposure): the public logistics reads
 * (core find/findOne, /nearby, /logistics-offers/load/:id) returned the
 * moderator's free-text notes and admin status fields
 * (moderationNote, adminNote, adminStatus, adminIssueStatus) to anonymous
 * callers. Those fields are written only by /logistics-admin/* and read only by
 * the admin screens. The public response must never carry them; the stored
 * values and the admin write path stay untouched.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-logistics-internal-fields-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-logistics-internal-fields-test.db');
const PORT = 14264;
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

const INTERNAL = ['moderationNote', 'adminNote', 'adminStatus', 'adminIssueStatus'];
const NOTE = 'INTERNAL moderator note - must never be public';

const getJson = async (url: string, jwt?: string) => {
  const res = await fetch(`${BASE_URL}${url}`, { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const rowsOf = (body: any): any[] => (Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : []);

const assertNoInternal = (label: string, res: { status: number; body: any }) => {
  assert.equal(res.status, 200, label + ": status");
  const body = res.body;
  const rows = rowsOf(body);
  assert.ok(rows.length > 0, `${label}: expected at least one row, got ${JSON.stringify(body).slice(0, 300)}`);
  for (const row of rows) {
    for (const f of INTERNAL) assert.equal(f in row, false, `${label}: leaked ${f}`);
  }
  assert.doesNotMatch(JSON.stringify(body), /INTERNAL moderator note/, `${label}: note text leaked`);
};

const seed = async (uid: string, data: Record<string, unknown>) => {
  try {
    return await strapiInstance.documents(uid).create({ status: 'published', data });
  } catch (e: any) {
    throw new Error(uid + ' seed failed: ' + JSON.stringify(e?.details?.errors ?? e?.message));
  }
};

test('public logistics reads never return moderator notes or admin status fields; stored values are untouched', async () => {
  const vehicle = await seed('api::logistics-vehicle.logistics-vehicle', {
    transporterName: 'Test Nakliyeci',
    transporterKey: 'id:u_internal_fields_owner',
    vehicleType: 'Kamyon',
    capacity: 10,
    currentCity: 'Konya',
    latitude: 37.87,
    longitude: 32.48,
    available: true,
    moderationStatus: 'approved',
    moderationNote: NOTE,
    adminStatus: 'approved',
    adminNote: NOTE,
  });
  const load = await seed('api::logistics-load.logistics-load', {
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
    ownerKey: 'id:u_internal_fields_owner',
    status: 'open',
    moderationStatus: 'approved',
    moderationNote: NOTE,
    adminStatus: 'approved',
    adminNote: NOTE,
  });
  const offer = await seed('api::logistics-offer.logistics-offer', {
    offerId: 'offer-internal-fields',
    loadId: String(load.documentId),
    transporterName: 'Test Nakliyeci',
    transporterKey: 'id:u_internal_fields_transporter',
    price: 1000,
    vehicleType: 'Kamyon',
    estimatedTime: '2 saat',
    adminIssueStatus: 'flagged',
    adminNote: NOTE,
  });

  assertNoInternal('GET /logistics-vehicles', await getJson('/logistics-vehicles'));
  assertNoInternal('GET /logistics-vehicles/:id', await getJson(`/logistics-vehicles/${vehicle.documentId}`));
  assertNoInternal('GET /logistics-vehicles/nearby', await getJson('/logistics-vehicles/nearby?latitude=37.87&longitude=32.48&km=50'));
  assertNoInternal('GET /logistics-loads', await getJson('/logistics-loads'));
  assertNoInternal('GET /logistics-loads/:id', await getJson(`/logistics-loads/${load.documentId}`));
  assertNoInternal('GET /logistics-loads/nearby', await getJson('/logistics-loads/nearby?latitude=37.87&longitude=32.48&km=500'));
  assertNoInternal('GET /logistics-offers', await getJson('/logistics-offers'));
  assertNoInternal('GET /logistics-offers/:id', await getJson(`/logistics-offers/${offer.documentId}`));
  assertNoInternal('GET /logistics-offers/load/:id', await getJson(`/logistics-offers/load/${load.documentId}`));

  // A signed-in caller gets the same sanitized view.
  const email = `internal-${Date.now()}@test.local`;
  const reg = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const jwt = (await reg.json()).jwt as string;
  assertNoInternal('signed-in GET /logistics-vehicles', await getJson('/logistics-vehicles', jwt));

  // The non-internal moderation flag the app already reads is still returned,
  // and the internal values are still stored (admin screens keep working).
  const listed = rowsOf((await getJson('/logistics-vehicles')).body)[0];
  assert.equal(listed.moderationStatus, 'approved');
  const stored = await strapiInstance.db.query('api::logistics-vehicle.logistics-vehicle').findOne({
    where: { documentId: vehicle.documentId },
  });
  assert.equal(stored.adminNote, NOTE);
  assert.equal(stored.moderationNote, NOTE);
});
