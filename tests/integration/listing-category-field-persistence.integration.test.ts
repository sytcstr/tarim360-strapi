/**
 * LISTING_L2_CANONICAL_CATEGORY_MODEL_REPORT.md — L2.
 *
 * LISTING_L1_EDIT_ROUND_TRIP_FIX_REPORT.md fixed the Flutter-side edit
 * round trip for Tarım's category-specific fields, but never proved the
 * backend's own create -> persist -> read -> update -> read contract with
 * a real integration test (L1 was a pure Flutter-side fix). Separately,
 * Hayvancılık (animalAge/animalWeight) and Tarımsal Aletler
 * (equipCondition/equipWorkHour/equipModelYear) had NO backend schema
 * column at all before L2 -- the Flutter form collected them but they
 * were never sent to, or storable by, the server.
 *
 * This suite proves, against a real Strapi boot (not a unit-level parser
 * test), that a real POST /listings create persists every category field
 * for all three categories, a real GET reads them back unchanged, and a
 * real PUT that only touches one unrelated field never disturbs the rest
 * -- the exact contract LISTING-BUG-001 broke on the client side and
 * that Hayvancılık/Tarımsal Aletler never had at all.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-category-field-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-category-field-test.db');
const PORT = 14182;
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

async function createListing(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { operationId: randomUUID(), ...data } }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function getListing(documentId: string) {
  const res = await fetch(`${BASE_URL}/listings/${documentId}`);
  const json = await res.json();
  return { status: res.status, body: json };
}

async function updateListing(jwt: string, documentId: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------
// Tarım — real backend round trip (never proven with an integration
// test in L1, which was a pure Flutter-side fix).
// ---------------------------------------------------------------------

test('Tarım: create persists all category fields, a title-only update leaves them unchanged', async () => {
  const user = await registerAndLogin(`l2-tarim-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, {
    title: 'Bugday Ilani',
    mainType: 'tarim',
    mode: 'sell',
    price: 100,
    hasatYear: 2026,
    hasatDate: 'Mart 2026',
    qualityGrade: 'B',
    moisture: 12,
    protein: 13.5,
    certificateType: 'Organik',
    analysisNote: 'Lab raporu',
    packaging: 'BigBag',
    storage: 'Silo',
    delivery: 'Depoda teslim',
    minOrder: 5,
    minOrderUnit: 'ton',
  });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;

  const read1 = await getListing(documentId);
  assert.equal(read1.body.data.hasatYear, 2026);
  assert.equal(read1.body.data.hasatDate, 'Mart 2026');
  assert.equal(read1.body.data.qualityGrade, 'B');
  assert.equal(Number(read1.body.data.moisture), 12);
  assert.equal(Number(read1.body.data.protein), 13.5);
  assert.equal(read1.body.data.certificateType, 'Organik');
  assert.equal(read1.body.data.packaging, 'BigBag');
  assert.equal(read1.body.data.storage, 'Silo');
  assert.equal(read1.body.data.delivery, 'Depoda teslim');
  assert.equal(Number(read1.body.data.minOrder), 5);
  assert.equal(read1.body.data.minOrderUnit, 'ton');

  const updated = await updateListing(user.jwt, documentId, { title: 'Bugday Ilani v2' });
  assert.equal(updated.status, 200);

  const read2 = await getListing(documentId);
  assert.equal(read2.body.data.title, 'Bugday Ilani v2');
  assert.equal(read2.body.data.hasatYear, 2026, 'unrelated update must not touch hasatYear');
  assert.equal(read2.body.data.qualityGrade, 'B', 'unrelated update must not touch qualityGrade');
  assert.equal(Number(read2.body.data.moisture), 12, 'unrelated update must not touch moisture');
  assert.equal(read2.body.data.packaging, 'BigBag', 'unrelated update must not touch packaging');
});

// ---------------------------------------------------------------------
// Hayvancılık — animalAge/animalWeight had no backend column before L2.
// ---------------------------------------------------------------------

test('Hayvancılık: create persists age+weight; edit only title -> age/weight unchanged; edit only age -> only age changes', async () => {
  const user = await registerAndLogin(`l2-hayvan-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, {
    title: 'Holstein Inek',
    mainType: 'hayvancilik',
    mode: 'sell',
    price: 50000,
    animalAge: '2 yaş',
    animalWeight: '450 kg',
  });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;

  const read1 = await getListing(documentId);
  assert.equal(read1.body.data.animalAge, '2 yaş');
  assert.equal(read1.body.data.animalWeight, '450 kg');

  const titleUpdate = await updateListing(user.jwt, documentId, { title: 'Holstein Inek v2' });
  assert.equal(titleUpdate.status, 200);
  const read2 = await getListing(documentId);
  assert.equal(read2.body.data.title, 'Holstein Inek v2');
  assert.equal(read2.body.data.animalAge, '2 yaş', 'title-only update must not touch animalAge');
  assert.equal(read2.body.data.animalWeight, '450 kg', 'title-only update must not touch animalWeight');

  const ageUpdate = await updateListing(user.jwt, documentId, { animalAge: '3 yaş' });
  assert.equal(ageUpdate.status, 200);
  const read3 = await getListing(documentId);
  assert.equal(read3.body.data.animalAge, '3 yaş', 'age update must apply');
  assert.equal(read3.body.data.animalWeight, '450 kg', 'age-only update must not touch weight');
});

// ---------------------------------------------------------------------
// Tarımsal Aletler — equipCondition/equipWorkHour/equipModelYear had no
// backend column before L2.
// ---------------------------------------------------------------------

test('Tarımsal Aletler: create persists condition+workHour+modelYear; edit only price -> all three unchanged; edit only workHour -> only workHour changes', async () => {
  const user = await registerAndLogin(`l2-alet-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, {
    title: 'John Deere Traktor',
    mainType: 'tarimsalAletler',
    mode: 'sell',
    price: 800000,
    equipCondition: 'İyi',
    equipWorkHour: '1200 saat',
    equipModelYear: 2022,
  });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;

  const read1 = await getListing(documentId);
  assert.equal(read1.body.data.equipCondition, 'İyi');
  assert.equal(read1.body.data.equipWorkHour, '1200 saat');
  assert.equal(read1.body.data.equipModelYear, 2022);

  const priceUpdate = await updateListing(user.jwt, documentId, { price: 750000 });
  assert.equal(priceUpdate.status, 200);
  const read2 = await getListing(documentId);
  assert.equal(Number(read2.body.data.price), 750000);
  assert.equal(read2.body.data.equipCondition, 'İyi', 'price-only update must not touch equipCondition');
  assert.equal(read2.body.data.equipWorkHour, '1200 saat', 'price-only update must not touch equipWorkHour');
  assert.equal(read2.body.data.equipModelYear, 2022, 'price-only update must not touch equipModelYear');

  const workHourUpdate = await updateListing(user.jwt, documentId, { equipWorkHour: '1500 saat' });
  assert.equal(workHourUpdate.status, 200);
  const read3 = await getListing(documentId);
  assert.equal(read3.body.data.equipWorkHour, '1500 saat', 'workHour update must apply');
  assert.equal(read3.body.data.equipCondition, 'İyi', 'workHour-only update must not touch equipCondition');
  assert.equal(read3.body.data.equipModelYear, 2022, 'workHour-only update must not touch equipModelYear');
});

// ---------------------------------------------------------------------
// Backward compatibility — a listing created before these columns
// existed (i.e. simply never set) must read back as null, not crash and
// not fabricate a value.
// ---------------------------------------------------------------------

test('a listing created without any category fields reads back as null for all of them, no crash, no invented value', async () => {
  const user = await registerAndLogin(`l2-legacy-${randomUUID()}@test.local`);
  const created = await createListing(user.jwt, {
    title: 'Eski Ilan (alan yok)',
    mainType: 'hayvancilik',
    mode: 'sell',
    price: 1000,
  });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;

  const read = await getListing(documentId);
  assert.equal(read.status, 200);
  assert.equal(read.body.data.animalAge, null);
  assert.equal(read.body.data.animalWeight, null);
  assert.equal(read.body.data.equipCondition, null);
  assert.equal(read.body.data.equipWorkHour, null);
  assert.equal(read.body.data.equipModelYear, null);
});

// ---------------------------------------------------------------------
// New fields must never bypass ownership -- same protected-fields
// pipeline as every other listing field (stripListingProtectedFields is
// unaffected, but the request must still go through listing-owner-write).
// ---------------------------------------------------------------------

test('a stranger cannot set another owner\'s Hayvancılık/Tarımsal Aletler fields via PUT', async () => {
  const owner = await registerAndLogin(`l2-strange-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`l2-strange-attacker-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt, {
    title: 'Sahibinin Ineği',
    mainType: 'hayvancilik',
    mode: 'sell',
    price: 10000,
    animalAge: '1 yaş',
  });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;

  const res = await updateListing(stranger.jwt, documentId, { animalAge: '99 yaş' });
  assert.equal(res.status, 403);

  const read = await getListing(documentId);
  assert.equal(read.body.data.animalAge, '1 yaş', 'a stranger must not be able to change animalAge');
});

// ---------------------------------------------------------------------
// Offline-sync path (engagement.ts syncOfflineListing) must carry the
// new fields too -- it's a second real create/update path, same as the
// existing quota/protected-field tests in
// listing-ownership-and-protected-fields.integration.test.ts prove for
// other fields.
// ---------------------------------------------------------------------

test('offline-sync (syncOfflineListing) persists Hayvancılık/Tarımsal Aletler fields on create and update', async () => {
  const user = await registerAndLogin(`l2-offline-${randomUUID()}@test.local`);

  const createRes = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'create',
      listing: {
        id: `l_${Date.now()}`,
        title: 'Offline Alet Ilani',
        mainType: 'tarimsalAletler',
        mode: 'sell',
        price: 200000,
        equipCondition: 'Orta',
        equipWorkHour: '3000 saat',
        equipModelYear: 2018,
      },
    }),
  });
  assert.equal(createRes.status, 200);
  const createJson = await createRes.json();
  assert.equal(createJson.data.listing.equipCondition, 'Orta');
  assert.equal(createJson.data.listing.equipWorkHour, '3000 saat');
  assert.equal(createJson.data.listing.equipModelYear, 2018);

  const listingId = createJson.data.listing.id;
  const updateRes = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      operation: 'update',
      listing: { id: listingId, equipWorkHour: '3200 saat' },
    }),
  });
  assert.equal(updateRes.status, 200);
  const updateJson = await updateRes.json();
  assert.equal(updateJson.data.listing.equipWorkHour, '3200 saat');
  assert.equal(updateJson.data.listing.equipCondition, 'Orta', 'offline update must not disturb equipCondition');
  assert.equal(updateJson.data.listing.equipModelYear, 2018, 'offline update must not disturb equipModelYear');
});
