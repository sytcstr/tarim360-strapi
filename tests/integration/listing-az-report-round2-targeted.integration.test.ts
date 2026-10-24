/**
 * A-Z ILAN OLUSTURMA RAPORU - ROUND 2 TARGETED EMPIRICAL CHECKS.
 *
 * Narrow, report-only reproduction of the claims across two rounds of user
 * review, verified against the REAL local Strapi integration harness (NOT
 * production) rather than accepted from code-reading alone:
 *
 *  A) Backend content validation: title/description/price/demandAmount/
 *     min-1-photo are now enforced on create (round 1 finding, round 2
 *     fix) -- and a definitive rejection does NOT auto-delete the
 *     uploaded photo (round 2 correction: see C1/A6 below).
 *  B) Quota race: with exactly 1 free slot left, two concurrent creates
 *     with DIFFERENT operationIds -- measured, not assumed fixed; a
 *     SAME-operationId repeat still produces only one listing.
 *  C) Orphaned upload file: a definitive rejection leaves the file a real,
 *     untouched orphan (round 2: automatic cleanup was reverted as unsafe
 *     -- no uploader-identity signal exists to tell "my own upload" apart
 *     from a stranger's still-pending one; see listing.ts's create() for
 *     the full reasoning). An ambiguous-network-retry (same operationId
 *     resent) still correctly recovers the already-created listing.
 *  D/E/F) PUT/offline-sync update: only a field THIS request actually
 *     submits is validated (never a pre-existing untouched field) -- but
 *     price/demandAmount are checked against the FINAL merged mode
 *     whenever either side of that relationship changes (a mode flip
 *     without the new mode's required field is rejected).
 *  G) The hourly premium-flag cron (config/cron-tasks.ts) actually
 *     corrects a stale isPremiumOwner on the real PUBLISHED row, not just
 *     some row.
 *  H) Photo-binding safety (round 3): can a DIFFERENT user bind a
 *     stranger's unattached, never-claimed upload to their OWN listing
 *     (create, update, offline-sync)? Measures the real behavior; does
 *     not assume one.
 *
 * This file performs ZERO production requests. Same throwaway-SQLite-file
 * harness pattern as every other *.integration.test.ts in this directory.
 * Run ONLY this file:
 *   npx tsx --test tests/integration/listing-az-report-round2-targeted.integration.test.ts
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runPremiumFlagsBackfill } = require('../../src/utils/premium-flags-backfill');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-az-report-r2-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-az-report-r2-test.db');
const PORT = 14233;
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

async function registerAndLogin(email: string): Promise<{ jwt: string; email: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return { jwt: json.jwt, email: email.trim().toLowerCase() };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Rapor R2 Test Ilani',
    description: 'Rapor R2 icin yeterli uzunlukta aciklama metni.',
    mainType: 'bitkisel',
    mode: 'sell',
    price: 100,
    location: { city: 'Konya', district: 'Meram', display: 'Konya / Meram' },
    ...overrides,
  };
}

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function uploadOnePhoto(jwt: string): Promise<number> {
  const form = new FormData();
  form.append('files', new Blob([ONE_PX_PNG], { type: 'image/png' }), `${randomUUID()}.png`);
  const res = await fetch(`${BASE_URL}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}` },
    body: form as any,
  });
  const body = await res.json();
  if (res.status >= 400) throw new Error(`upload failed (${res.status}): ${JSON.stringify(body)}`);
  return (body as any[])[0].id;
}

// ILAN OLUSTURMA RAPORU ROUND 2: now that the server enforces a minimum of
// 1 photo (item 1's fix), every createListing() call that doesn't
// deliberately test the photo dimension itself needs a REAL uploaded photo
// attached, or it would now fail for an unrelated reason. Auto-uploads one
// unless the caller explicitly passed its own `photos` (including the
// deliberately-empty `[]` A5 uses to test the min-photo rule itself).
async function createListing(
  jwt: string,
  operationId: string,
  overrides: Record<string, unknown> = {},
) {
  let data: Record<string, unknown> = { ...basePayload(overrides), operationId };
  if (!Object.prototype.hasOwnProperty.call(overrides, 'photos')) {
    const fileId = await uploadOnePhoto(jwt);
    data = { ...data, photos: [fileId] };
  }
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function fileRelatedCount(fileId: number): Promise<number> {
  const row: any = await strapiInstance.entityService.findOne('plugin::upload.file', fileId, {
    populate: ['related'],
  });
  return Array.isArray(row?.related) ? row.related.length : 0;
}

// ============================================================
// A) BACKEND CONTENT VALIDATION (fixed by this round -- now REJECTED)
// ============================================================
test('A: POST /listings now REJECTS an empty title', async () => {
  const { jwt } = await registerAndLogin(`r2a1_${randomUUID()}@test.local`);
  const { status, body } = await createListing(jwt, randomUUID(), { title: '' });
  console.log('A1 empty title ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400, 'empty title must now be rejected server-side');
});

test('A: POST /listings now REJECTS a 2-character description (Flutter requires >=12)', async () => {
  const { jwt } = await registerAndLogin(`r2a2_${randomUUID()}@test.local`);
  const { status, body } = await createListing(jwt, randomUUID(), { description: 'ab' });
  console.log('A2 short description ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400);
});

test('A: POST /listings now REJECTS a negative sell price', async () => {
  const { jwt } = await registerAndLogin(`r2a3_${randomUUID()}@test.local`);
  const { status, body } = await createListing(jwt, randomUUID(), { mode: 'sell', price: -50 });
  console.log('A3 negative price ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400);
});

test('A: POST /listings now REJECTS an invalid (negative) buy demandAmount', async () => {
  const { jwt } = await registerAndLogin(`r2a4_${randomUUID()}@test.local`);
  const { status, body } = await createListing(jwt, randomUUID(), {
    mode: 'buy',
    price: undefined,
    demandAmount: -10,
  });
  console.log('A4 negative demandAmount (buy) ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400);
});

test('A: POST /listings now REJECTS zero photos, and a valid resubmission still succeeds (not quota-consumed)', async () => {
  const { jwt } = await registerAndLogin(`r2a5_${randomUUID()}@test.local`);
  const { status, body } = await createListing(jwt, randomUUID(), { photos: [] });
  console.log('A5 zero photos ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400);

  // The invalid attempt must not have consumed a free-tier quota unit --
  // 5 further genuinely valid creates for this SAME owner must all still
  // succeed (if the invalid attempt had counted, only 4 more would fit).
  for (let i = 0; i < 5; i++) {
    const r = await createListing(jwt, randomUUID(), { title: `A5 follow-up ${i}` });
    assert.equal(r.status, 201, `follow-up create #${i} should succeed (invalid attempt must not have used quota)`);
  }
});

test('A: a definitive content-validation rejection does NOT delete the uploaded photo (automatic cleanup was reverted as unsafe -- see item 3)', async () => {
  const { jwt } = await registerAndLogin(`r2a6_${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(jwt);
  const { status, body } = await createListing(jwt, randomUUID(), { title: '', photos: [fileId] });
  console.log('A6 invalid title + real photo ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400);
  const stillExists = await strapiInstance.entityService.findOne('plugin::upload.file', fileId, {});
  console.log(`A6 uploaded file #${fileId} still exists (must NOT be auto-deleted)? ->`, !!stillExists);
  assert.ok(stillExists, 'no uploader-identity signal exists, so automatic deletion was reverted -- the file must survive, as a known, still-open orphan');
  const relatedCount = await fileRelatedCount(fileId);
  assert.equal(relatedCount, 0, 'it is a real orphan (unattached), but deliberately left alone rather than risking another user\'s data');
});

// ============================================================
// B) QUOTA RACE (different operationId) vs SAME-operationId PROTECTION
// ============================================================
test('B1: same operationId double-submit produces exactly one listing (existing protection holds)', async () => {
  const { jwt } = await registerAndLogin(`r2b1_${randomUUID()}@test.local`);
  const opId = randomUUID();
  const [r1, r2] = await Promise.all([
    createListing(jwt, opId, { title: 'B1 Same Op' }),
    createListing(jwt, opId, { title: 'B1 Same Op' }),
  ]);
  console.log(
    'B1 concurrent SAME operationId ->',
    r1.status, r1.body?.data?.id, r1.body?.data?.documentId,
    '|', r2.status, r2.body?.data?.id, r2.body?.data?.documentId,
  );
  const docIds = [r1, r2]
    .map((r) => r.body?.data?.documentId)
    .filter((x) => x !== undefined);
  const uniqueDocIds = new Set(docIds);
  assert.ok(
    [r1.status, r2.status].every((s) => s === 201 || s === 200 || s === 409),
    'every response must be either the real create or a recognized conflict/duplicate, never a silent second create',
  );
  assert.equal(uniqueDocIds.size, 1, 'same operationId must never yield two distinct listing documentIds');

  const docId = [...uniqueDocIds][0];
  const realRowCount = await strapiInstance.db.query('api::listing.listing').count({
    where: { documentId: docId, publishedAt: { $notNull: true } },
  } as any);
  console.log(`B1 real PUBLISHED row count for documentId=${docId} ->`, realRowCount);
  assert.equal(realRowCount, 1, 'exactly one real published row must exist for this operationId, regardless of id-field shape in the two HTTP responses');
});

test('B2: two DIFFERENT operationIds racing on the LAST free slot — measure real overrun', async () => {
  const { jwt } = await registerAndLogin(`r2b2_${randomUUID()}@test.local`);
  // Reach usedCount = 4 (one free slot left out of NORMAL_LISTING_FREE_COUNT=5).
  for (let i = 0; i < 4; i++) {
    const r = await createListing(jwt, randomUUID(), { title: `B2 warmup ${i}` });
    assert.equal(r.status, 201, `warmup create #${i} should succeed, got ${r.status}: ${JSON.stringify(r.body)}`);
  }

  // Fire two genuinely concurrent creates with DIFFERENT operationIds for
  // the SAME owner, both racing against the single remaining slot.
  const [ra, rb] = await Promise.all([
    createListing(jwt, randomUUID(), { title: 'B2 race A' }),
    createListing(jwt, randomUUID(), { title: 'B2 race B' }),
  ]);
  console.log('B2 race results ->', ra.status, JSON.stringify(ra.body).slice(0, 120), '|', rb.status, JSON.stringify(rb.body).slice(0, 120));

  const successCount = [ra, rb].filter((r) => r.status === 201).length;
  const rejectedCount = [ra, rb].filter((r) => r.status === 403).length;
  console.log(`B2 successCount=${successCount} rejectedCount=${rejectedCount} (only 1 free slot existed before this race)`);

  // Report the REAL measured outcome without assuming which way it falls --
  // this assertion only records whether an overrun actually happened on
  // this run; it intentionally does not fail the suite either way so the
  // true number gets printed and quoted in the report.
  assert.ok(successCount === 1 || successCount === 2, 'sanity: at least the expected shape of outcomes');
});

// ============================================================
// C) ORPHANED UPLOAD FILE vs AMBIGUOUS-NETWORK-RETRY RECOVERY
// ============================================================
test('C1: photo uploaded then create DEFINITIVELY REJECTED (quota exceeded) -> file stays unattached (real orphan)', async () => {
  const { jwt } = await registerAndLogin(`r2c1_${randomUUID()}@test.local`);
  // Exhaust the free quota first (5 successful creates -> usedCount=5).
  for (let i = 0; i < 5; i++) {
    const r = await createListing(jwt, randomUUID(), { title: `C1 warmup ${i}` });
    assert.equal(r.status, 201, `warmup create #${i} should succeed`);
  }
  // Now upload a real photo, then attempt a 6th create -- must be
  // DEFINITIVELY rejected (403 quota message), not an ambiguous outcome.
  const fileId = await uploadOnePhoto(jwt);
  const { status, body } = await createListing(jwt, randomUUID(), { photos: [fileId] });
  console.log('C1 6th create (quota exceeded) ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 403, 'the 6th create must be a definitive, known rejection (quota), not ambiguous');

  // ILAN OLUSTURMA RAPORU ROUND 2 (item 3) -- automatic cleanup on this
  // path was reverted as unsafe (no uploader-identity signal exists to
  // tell this caller's own upload apart from a stranger's pending one).
  // This remains a real, OPEN, unresolved orphan-file problem.
  const relatedCount = await fileRelatedCount(fileId);
  console.log(`C1 uploaded file #${fileId} related-reference count after definitive rejection = ${relatedCount}`);
  assert.equal(relatedCount, 0, 'file is a real orphan: zero relations after a definitive create rejection');
  const stillExists = await strapiInstance.entityService.findOne('plugin::upload.file', fileId, {});
  assert.ok(stillExists, 'must NOT be auto-deleted -- the orphan is left in place, not risked away');
});

test('C2: ambiguous-network-retry (same operationId resent) recovers the REAL created listing, never discards/duplicates it', async () => {
  const { jwt } = await registerAndLogin(`r2c2_${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(jwt);
  const opId = randomUUID();

  // First attempt "succeeds server-side" -- simulate the client never
  // having seen the response by simply not looking at r1 and immediately
  // retrying with the SAME operationId, as the offline-retry queue does.
  const r1 = await createListing(jwt, opId, { photos: [fileId] });
  assert.equal(r1.status, 201, 'first attempt must genuinely succeed server-side');
  const firstDocId = r1.body?.data?.documentId;

  const r2 = await createListing(jwt, opId, { photos: [fileId] });
  console.log(
    'C2 ambiguous-retry (same operationId) ->',
    r1.status, r1.body?.data?.id, firstDocId,
    '| retry ->', r2.status, r2.body?.data?.id, r2.body?.data?.documentId,
  );
  assert.ok(r2.status === 200 || r2.status === 201, 'the retry must recover the existing listing, not error out');
  assert.equal(r2.body?.data?.documentId, firstDocId, 'retry must resolve to the SAME listing documentId, never a duplicate');

  const realRowCount = await strapiInstance.db.query('api::listing.listing').count({
    where: { documentId: firstDocId, publishedAt: { $notNull: true } },
  } as any);
  console.log(`C2 real PUBLISHED row count for documentId=${firstDocId} ->`, realRowCount);
  assert.equal(realRowCount, 1, 'exactly one real published row must exist after the ambiguous-retry, regardless of id-field shape');

  const relatedCount = await fileRelatedCount(fileId);
  console.log(`C2 uploaded file #${fileId} related-reference count after successful create+retry = ${relatedCount}`);
  assert.equal(relatedCount, 1, 'the real, successfully-attached photo must be referenced exactly once, by the one real listing');
});

// ============================================================
// D) PARTIAL UPDATE: validate only what's submitted, against the real
// resulting (merged) state -- never reject over an untouched field.
// ============================================================
test('D1: PUT /listings/:id with ONLY price changed is NOT rejected for not resending title/description', async () => {
  const { jwt } = await registerAndLogin(`r2d1_${randomUUID()}@test.local`);
  const created = await createListing(jwt, randomUUID(), { title: 'D1 Original', price: 100 });
  assert.equal(created.status, 201);
  const id = created.body?.data?.documentId ?? created.body?.data?.id;

  const res = await fetch(`${BASE_URL}/listings/${id}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { price: 250 } }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('D1 price-only PUT ->', res.status, JSON.stringify(body).slice(0, 200));
  assert.equal(res.status, 200, 'a price-only edit must succeed without needing to resend title/description');
  assert.equal(body?.data?.price, 250);
});

test('D2: PUT /listings/:id with an invalid (negative) price IS rejected, using the existing (unresent) mode', async () => {
  const { jwt } = await registerAndLogin(`r2d2_${randomUUID()}@test.local`);
  const created = await createListing(jwt, randomUUID(), { title: 'D2 Original', mode: 'sell', price: 100 });
  assert.equal(created.status, 201);
  const id = created.body?.data?.documentId ?? created.body?.data?.id;

  const res = await fetch(`${BASE_URL}/listings/${id}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { price: -5 } }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('D2 invalid price-only PUT ->', res.status, JSON.stringify(body).slice(0, 200));
  assert.equal(res.status, 400, 'a negative price must be rejected even though mode itself was not resent');
});

// ============================================================
// E) OFFLINE-SYNC PATH (POST /offline-sync/listings): same rules apply.
// ============================================================
async function offlineSync(
  jwt: string,
  operation: 'create' | 'update',
  listing: Record<string, unknown>,
) {
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ operation, listing }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('E1: POST /offline-sync/listings (create) now REJECTS an empty title too', async () => {
  const { jwt } = await registerAndLogin(`r2e1_${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(jwt);
  const { status, body } = await offlineSync(jwt, 'create', {
    operationId: randomUUID(),
    title: '',
    description: 'Yeterli uzunlukta aciklama metni burada.',
    mainType: 'bitkisel',
    mode: 'sell',
    price: 100,
    location: { city: 'Konya', district: 'Meram', display: 'Konya / Meram' },
    photos: [fileId],
  });
  console.log('E1 offline-sync create, empty title ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400, 'the offline-sync create path must enforce the same title rule as the direct path');
});

test('E2: POST /offline-sync/listings (update) with only price changed is NOT rejected for omitting title/description', async () => {
  const { jwt } = await registerAndLogin(`r2e2_${randomUUID()}@test.local`);
  const created = await createListing(jwt, randomUUID(), { title: 'E2 Original', price: 100 });
  assert.equal(created.status, 201);
  const id = created.body?.data?.id;

  const { status, body } = await offlineSync(jwt, 'update', { id, price: 300 });
  console.log('E2 offline-sync price-only update ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 200, 'a price-only offline-sync update must succeed without resending title/description');
});

// ============================================================
// F) FULL RESULTING (merged) STATE on a mode change -- item 2.
// ============================================================
test('F1: PUT /listings/:id changing buy -> sell WITHOUT resending price is REJECTED (resulting row would have no valid price)', async () => {
  const { jwt } = await registerAndLogin(`r2f1_${randomUUID()}@test.local`);
  const created = await createListing(jwt, randomUUID(), {
    title: 'F1 Buy Original',
    mode: 'buy',
    price: undefined,
    demandAmount: 20,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body?.data?.documentId ?? created.body?.data?.id;

  const res = await fetch(`${BASE_URL}/listings/${id}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { mode: 'sell' } }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('F1 buy->sell, no price resent ->', res.status, JSON.stringify(body).slice(0, 200));
  assert.equal(res.status, 400, 'the FINAL resulting row (mode=sell, price=null from the old buy listing) must be rejected');
});

test('F2: PUT /listings/:id changing buy -> sell WITH a valid price in the same request succeeds', async () => {
  const { jwt } = await registerAndLogin(`r2f2_${randomUUID()}@test.local`);
  const created = await createListing(jwt, randomUUID(), {
    title: 'F2 Buy Original',
    mode: 'buy',
    price: undefined,
    demandAmount: 20,
  });
  assert.equal(created.status, 201);
  const id = created.body?.data?.documentId ?? created.body?.data?.id;

  const res = await fetch(`${BASE_URL}/listings/${id}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { mode: 'sell', price: 500 } }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('F2 buy->sell, valid price included ->', res.status, JSON.stringify(body).slice(0, 200));
  assert.equal(res.status, 200, 'a mode change WITH a valid price for the new mode must succeed');
  assert.equal(body?.data?.mode, 'sell');
  assert.equal(body?.data?.price, 500);
});

// ============================================================
// G) PREMIUM FLAG CRON -- item 4/5: does the hourly resync actually
// correct a stale isPremiumOwner flag, end to end?
// ============================================================
test('G1: runPremiumFlagsBackfill (the exact function the new hourly cron calls) corrects a STALE isPremiumOwner after Premium expired', async () => {
  const { jwt } = await registerAndLogin(`r2g1_${randomUUID()}@test.local`);
  const created = await createListing(jwt, randomUUID(), { title: 'G1 Listing' });
  assert.equal(created.status, 201);
  const listingId = created.body?.data?.id;
  const ownerProfileId = created.body?.data?.ownerProfileId;
  assert.ok(ownerProfileId, 'the created listing must carry a real ownerProfileId');

  // Simulate the REAL-WORLD stale condition: Premium genuinely expired
  // (endsAt in the past) but nothing has re-synced the listing's own
  // isPremiumOwner flag yet (no profile-setting write, no restart since).
  await strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: {
      profileId: ownerProfileId,
      activePremium: { endsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() },
    },
  });
  await strapiInstance.db.query('api::listing.listing').update({
    where: { id: listingId },
    data: { isPremiumOwner: true, isPremium: true },
  } as any);

  const beforeRow: any = await strapiInstance.db.query('api::listing.listing').findOne({
    where: { id: listingId },
    select: ['isPremiumOwner', 'isPremium'],
  } as any);
  assert.equal(beforeRow.isPremiumOwner, true, 'sanity: the stale flag must actually be true before the backfill runs');

  await runPremiumFlagsBackfill(strapiInstance);

  const documentId = created.body?.data?.documentId;
  const allRowsForDoc: any[] = await strapiInstance.db.query('api::listing.listing').findMany({
    where: { documentId },
    select: ['id', 'isPremiumOwner', 'isPremium', 'publishedAt'],
  } as any);
  console.log('G1 ALL physical rows for this documentId after backfill ->', JSON.stringify(allRowsForDoc));

  const publishedAfter = allRowsForDoc.find((r) => r.publishedAt !== null);
  assert.ok(publishedAfter, 'a published row must still exist after the backfill runs');
  console.log('G1 isPremiumOwner before ->', beforeRow.isPremiumOwner, '| PUBLISHED row after backfill ->', publishedAfter.isPremiumOwner);
  assert.equal(publishedAfter.isPremiumOwner, false, 'the PUBLICLY VISIBLE (published) row -- the one listing-popular-query.ts actually ranks by -- must have the corrected flag');
  assert.equal(publishedAfter.isPremium, false);
});

test('F3: POST /offline-sync/listings (update) changing buy -> sell WITHOUT resending price is REJECTED', async () => {
  const { jwt } = await registerAndLogin(`r2f3_${randomUUID()}@test.local`);
  const created = await createListing(jwt, randomUUID(), {
    title: 'F3 Buy Original',
    mode: 'buy',
    price: undefined,
    demandAmount: 20,
  });
  assert.equal(created.status, 201);
  const id = created.body?.data?.id;

  const { status, body } = await offlineSync(jwt, 'update', { id, mode: 'sell' });
  console.log('F3 offline-sync buy->sell, no price resent ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 400, 'the offline-sync update path must apply the same final-merged-state rule');
});

// ============================================================
// H) PHOTO-BINDING SAFETY -- item 1 (round 3): can a DIFFERENT user bind
// a stranger's unattached, never-claimed upload to their OWN listing?
// ROUND 3 FIX: isPhotoOwnedByIdentity now also requires a genuine,
// server-stamped uploader-identity match (upload-uploader-identity.ts)
// for an unattached file -- these three tests used to measure the gap
// without asserting a specific outcome; they now assert the fix holds,
// against the real create()/update()/offline-sync paths.
// ============================================================
test('H1: user B is REJECTED attaching user A\'s unattached, never-claimed upload to B\'s own new listing via direct create (round-3 fix)', async () => {
  const userA = await registerAndLogin(`r2h1-a-${randomUUID()}@test.local`);
  const userB = await registerAndLogin(`r2h1-b-${randomUUID()}@test.local`);
  const aFileId = await uploadOnePhoto(userA.jwt);

  const { status, body } = await createListing(userB.jwt, randomUUID(), {
    title: 'B tries A photo',
    photos: [aFileId],
  });
  console.log('H1 B create using A\'s unattached upload ->', status, JSON.stringify(body).slice(0, 200));

  assert.equal(status, 403, 'B must be rejected: the file was genuinely uploaded by A, not B');
  const relatedCount = await fileRelatedCount(aFileId);
  assert.equal(relatedCount, 0, 'the rejected attempt must never attach A\'s file to anything');
});

test('H2: user B is REJECTED attaching user A\'s unattached, never-claimed upload via PUT update on B\'s own existing listing (round-3 fix)', async () => {
  const userA = await registerAndLogin(`r2h2-a-${randomUUID()}@test.local`);
  const userB = await registerAndLogin(`r2h2-b-${randomUUID()}@test.local`);
  const aFileId = await uploadOnePhoto(userA.jwt);

  const bListing = await createListing(userB.jwt, randomUUID(), { title: 'B own listing' });
  assert.equal(bListing.status, 201, JSON.stringify(bListing.body));
  const documentId = bListing.body.data.documentId;

  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'PUT',
    headers: authed(userB.jwt),
    body: JSON.stringify({ data: { photos: [aFileId] } }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('H2 B update using A\'s unattached upload ->', res.status, JSON.stringify(body).slice(0, 200));

  assert.equal(res.status, 403, 'B must be rejected: the file was genuinely uploaded by A, not B');
  const relatedCount = await fileRelatedCount(aFileId);
  assert.equal(relatedCount, 0, 'the rejected update must never attach A\'s file to anything');
});

test('H3: user B is REJECTED attaching user A\'s unattached, never-claimed upload via offline-sync create (round-3 fix)', async () => {
  const userA = await registerAndLogin(`r2h3-a-${randomUUID()}@test.local`);
  const userB = await registerAndLogin(`r2h3-b-${randomUUID()}@test.local`);
  const aFileId = await uploadOnePhoto(userA.jwt);

  const { status, body } = await offlineSync(userB.jwt, 'create', {
    operationId: randomUUID(),
    title: 'B offline tries A photo',
    description: 'H3 testi icin yeterli uzunlukta aciklama.',
    mainType: 'bitkisel',
    mode: 'sell',
    price: 100,
    location: { city: 'Konya', district: 'Meram', display: 'Konya / Meram' },
    photos: [aFileId],
  });
  console.log('H3 B offline-sync create using A\'s unattached upload ->', status, JSON.stringify(body).slice(0, 200));

  assert.equal(status, 403, 'B must be rejected: the file was genuinely uploaded by A, not B');
  const relatedCount = await fileRelatedCount(aFileId);
  assert.equal(relatedCount, 0, 'the rejected offline-sync create must never attach A\'s file to anything');
});

// ============================================================
// H4-H8: the fix must not break legitimate same-owner flows, and the
// uploader-identity stamp itself must not be client-spoofable.
// ============================================================
test('H4: a user CAN attach their OWN freshly-uploaded, unattached photo to their OWN new listing (self-upload still works)', async () => {
  const { jwt } = await registerAndLogin(`r2h4-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(jwt);

  const { status, body } = await createListing(jwt, randomUUID(), {
    title: 'H4 own photo',
    photos: [fileId],
  });
  console.log('H4 self create using own fresh upload ->', status, JSON.stringify(body).slice(0, 200));
  assert.equal(status, 201, 'a user must still be able to attach their own freshly-uploaded photo');
  const relatedCount = await fileRelatedCount(fileId);
  assert.equal(relatedCount, 1);
});

test('H5: editing a listing while RESENDING its own already-attached photo id is NOT rejected (ordinary edit must keep working)', async () => {
  const { jwt } = await registerAndLogin(`r2h5-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(jwt);
  const created = await createListing(jwt, randomUUID(), { title: 'H5 Original', photos: [fileId] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.body.data.documentId;

  // Re-save the SAME already-attached photo id alongside an unrelated
  // field change -- this must never be treated as a NEW, newly-referenced
  // attach attempt that requires a fresh uploader-identity check to be
  // re-run against a file that is already legitimately this owner's.
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { title: 'H5 Edited', photos: [fileId] } }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('H5 edit resending own already-attached photo ->', res.status, JSON.stringify(body).slice(0, 200));
  assert.equal(res.status, 200, 'resaving one\'s own already-attached photo during an ordinary edit must not be blocked');
  const relatedCount = await fileRelatedCount(fileId);
  assert.equal(relatedCount, 1, 'still exactly one relation (same listing), not duplicated or dropped');
});

test('H6: offline-sync recovery (same operationId retried) with the SAME already-uploaded photo id still works after the round-3 fix', async () => {
  const { jwt } = await registerAndLogin(`r2h6-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(jwt);
  const opId = randomUUID();

  const r1 = await createListing(jwt, opId, { title: 'H6 Original', photos: [fileId] });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const firstDocId = r1.body?.data?.documentId;

  // Simulate the client never having seen r1's response and retrying with
  // the identical operationId+photo, exactly like C2's existing coverage,
  // but specifically re-checked here against the new uploader-identity
  // gate (this must recover the existing listing, not get rejected).
  const r2 = await createListing(jwt, opId, { title: 'H6 Original', photos: [fileId] });
  console.log('H6 offline-recovery retry with own uploaded photo ->', r2.status, JSON.stringify(r2.body).slice(0, 200));
  assert.ok(r2.status === 200 || r2.status === 201, 'the retry must recover the existing listing, not be rejected');
  assert.equal(r2.body?.data?.documentId, firstDocId, 'retry must resolve to the SAME listing documentId');
});

test('H7: a client CANNOT spoof the uploader identity by sending uploaderEmail directly in the upload request', async () => {
  const userA = await registerAndLogin(`r2h7-a-${randomUUID()}@test.local`);
  const userB = await registerAndLogin(`r2h7-b-${randomUUID()}@test.local`);

  // B uploads a file but tries to claim it was uploaded by A, by sending
  // a client-supplied uploaderEmail field alongside the real file bytes.
  const form = new FormData();
  form.append('files', new Blob([ONE_PX_PNG], { type: 'image/png' }), `${randomUUID()}.png`);
  form.append('fileInfo', JSON.stringify({ uploaderEmail: userA.email }));
  const uploadRes = await fetch(`${BASE_URL}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userB.jwt}` },
    body: form as any,
  });
  const uploadBody = await uploadRes.json();
  if (uploadRes.status >= 400) throw new Error(`upload failed (${uploadRes.status}): ${JSON.stringify(uploadBody)}`);
  const spoofedFileId = (uploadBody as any[])[0].id;

  // The stamp must come from B's OWN verified session (requestContext),
  // never from anything in the request body -- so B, the REAL uploader,
  // must still be able to attach it to B's own listing...
  const bCreate = await createListing(userB.jwt, randomUUID(), {
    title: 'H7 B uses own upload despite spoof attempt',
    photos: [spoofedFileId],
  });
  console.log('H7 B attaches its own (spoof-attempted) upload ->', bCreate.status, JSON.stringify(bCreate.body).slice(0, 200));
  assert.equal(bCreate.status, 201, 'B is the REAL uploader (per requestContext), so B must still be able to attach it');

  // ...while A, who never actually uploaded it, must still be rejected --
  // proving the spoofed uploaderEmail field had no effect.
  const spoofedFile: any = await strapiInstance.entityService.findOne('plugin::upload.file', spoofedFileId, {
    fields: ['uploaderEmail'],
  });
  console.log('H7 stored uploaderEmail on the file ->', spoofedFile?.uploaderEmail, '(must be B\'s email, not A\'s)');
  assert.equal(
    String(spoofedFile?.uploaderEmail ?? '').toLowerCase(),
    userB.email,
    'the server-stamped uploaderEmail must be the REAL uploader (B), ignoring the spoofed value in the request body',
  );
});

test('H8: a client CANNOT overwrite uploaderEmail on an EXISTING file via the update-file-info route either (not just at creation)', async () => {
  const userA = await registerAndLogin(`r2h8-a-${randomUUID()}@test.local`);
  const userB = await registerAndLogin(`r2h8-b-${randomUUID()}@test.local`);

  // B genuinely uploads a file (uploaderEmail stamped as B).
  const fileId = await uploadOnePhoto(userB.jwt);

  // B now calls the SEPARATE update-file-info path (POST /upload?id=X,
  // no files attached -> content-api.js's upload() dispatches to
  // updateFileInfo()) and tries to overwrite uploaderEmail to A's email
  // via fileInfo, alongside a legitimately-allowed field
  // (alternativeText) to prove the request itself is genuinely reaching
  // the real update logic, not failing outright for an unrelated reason.
  const updateRes = await fetch(`${BASE_URL}/upload?id=${fileId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${userB.jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      fileInfo: { uploaderEmail: userA.email, alternativeText: 'H8 updated caption' },
    }),
  });
  const updateBody = await updateRes.json().catch(() => ({}));
  console.log('H8 update-file-info spoof attempt ->', updateRes.status, JSON.stringify(updateBody).slice(0, 200));

  const fileAfter: any = await strapiInstance.entityService.findOne('plugin::upload.file', fileId, {
    fields: ['uploaderEmail', 'alternativeText'],
  });
  console.log('H8 file after update attempt -> uploaderEmail:', fileAfter?.uploaderEmail, '| alternativeText:', fileAfter?.alternativeText);
  assert.equal(
    String(fileAfter?.uploaderEmail ?? '').toLowerCase(),
    userB.email,
    'uploaderEmail must still be the REAL uploader (B) after an update-file-info call attempting to overwrite it to A',
  );

  // Now that uploaderEmail is proven unchanged, confirm A still cannot
  // attach this file to A's own listing (the real guarantee this field
  // exists to provide), end to end through the normal create path.
  const aCreate = await createListing(userA.jwt, randomUUID(), {
    title: 'H8 A tries B photo after spoof attempt',
    photos: [fileId],
  });
  console.log('H8 A tries to attach B\'s file after spoof attempt ->', aCreate.status, JSON.stringify(aCreate.body).slice(0, 200));
  assert.equal(aCreate.status, 403, 'A must still be rejected -- the spoofed update-file-info call had no effect on real ownership');
});

test('H9: a LEGACY photo with no recorded uploaderEmail (predates this fix), already attached to an existing listing, can still be edited by its real owner', async () => {
  const { jwt, email } = await registerAndLogin(`r2h9-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(jwt);

  // Attach it to a real listing FIRST, while uploaderEmail is still
  // genuinely set (otherwise create() itself would reject it as an
  // unattached file with no provable uploader -- correct, but not what
  // this test is simulating). THEN wipe the stamp, to simulate a file
  // that was already attached BEFORE this round's fix existed (the
  // lifecycle hook never ran for it) and is only being edited now.
  const created = await createListing(jwt, randomUUID(), { title: 'H9 Legacy Original', photos: [fileId] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.body.data.documentId;

  await strapiInstance.db.query('plugin::upload.file').update({
    where: { id: fileId },
    data: { uploaderEmail: null },
  } as any);
  const fileBefore: any = await strapiInstance.entityService.findOne('plugin::upload.file', fileId, {
    fields: ['uploaderEmail'],
  });
  console.log('H9 sanity: legacy file uploaderEmail before edit ->', fileBefore?.uploaderEmail, '(must be null/empty)');
  assert.ok(!fileBefore?.uploaderEmail, 'sanity: the simulated legacy file must genuinely have no uploaderEmail recorded');

  // Editing the listing while RESENDING this already-attached legacy
  // photo must still succeed -- isPhotoOwnedByIdentity's "already
  // attached to one of my own listings" branch must take priority over
  // the (otherwise-failing, since uploaderEmail is null) uploader check,
  // exactly as it does for H5's non-legacy case.
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { title: 'H9 Legacy Edited', photos: [fileId] } }),
  });
  const body = await res.json().catch(() => ({}));
  console.log('H9 editing a listing with a legacy (no-uploaderEmail) already-attached photo ->', res.status, JSON.stringify(body).slice(0, 200));
  assert.equal(res.status, 200, 'editing a listing must not break just because its already-attached photo predates the uploaderEmail stamp');
  const relatedCount = await fileRelatedCount(fileId);
  assert.equal(relatedCount, 1, 'still exactly one relation (same listing)');
});
