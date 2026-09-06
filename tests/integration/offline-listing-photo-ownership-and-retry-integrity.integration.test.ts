/**
 * A-Z PART 3 P0/P1 CORRECTION -- OFFLINE LISTING SECURITY + RETRY/MEDIA
 * INTEGRITY (SPECIAL DIRECT-API MEDIA SECURITY PASS finding + Madde 45).
 *
 * FIX A (P0): `POST /offline-sync/listings` (engagement.ts's
 * syncOfflineListing) is a second, parallel create/update path for
 * api::listing.listing, entirely separate from listing.ts's own
 * create()/update(). Confirmed live it enforced NEITHER photo-ownership
 * nor image-type checks -- any authenticated caller could attach another
 * user's currently-in-use photo (or a non-image file id) to their own
 * listing simply by calling this endpoint instead of the direct one.
 * Fixed by applying the exact same canonical checks (isPhotoOwnedByIdentity,
 * findNonImageFileId, extractRequestedPhotoIds -- listing-media.ts) listing.ts's
 * own create()/update() already use, in the same order, before any
 * entityService call runs.
 *
 * FIX B (P1, Madde 45): syncOfflineListing's create branch previously
 * only ever READ the listing-create-operation ledger (to recognize a
 * listing created via the DIRECT POST /listings path) but never WROTE to
 * it -- a create that itself went through THIS endpoint had no
 * protection against being retried a second time by this same endpoint
 * (its own HTTP response getting lost, and the offline queue re-sending
 * the identical queued row later), producing a genuine duplicate
 * listing. Fixed by giving this path the exact same
 * resolveOperation/fingerprintPayload atomic-claim-and-link ledger
 * dance listing.ts's create() uses.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-offline-listing-photo-retry-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-offline-listing-photo-retry-test.db');
const PORT = 14198;
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

// A minimal valid 1x1 PNG, real image bytes (same fixture as
// listing-media-lifecycle.integration.test.ts) so a real upload happens.
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
  if (res.status >= 400) {
    throw new Error(`upload failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return (body as any[])[0].id;
}

async function uploadOneNonImageFile(jwt: string): Promise<number> {
  const form = new FormData();
  form.append(
    'files',
    new Blob([Buffer.from('not an image, just plain text bytes')], { type: 'text/plain' }),
    `${randomUUID()}.txt`,
  );
  const res = await fetch(`${BASE_URL}/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}` },
    body: form as any,
  });
  const body = await res.json();
  if (res.status >= 400) {
    throw new Error(`upload failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return (body as any[])[0].id;
}

function listingPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Offline Media Test Ilani',
    mainType: 'tarim',
    mode: 'sell',
    price: 100,
    location: 'Konya',
    ...overrides,
  };
}

async function offlineSync(jwt: string, operation: string, listing: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { operation, listing } }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// A real listing created via the DIRECT create path (listing.ts), used as
// "the attacker's own listing already exists, now they attach a foreign
// photo via the OTHER (offline-sync) path" test setup.
async function createDirectListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { ...listingPayload(overrides), operationId: randomUUID() } }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function countListingsByTitle(title: string): Promise<number> {
  const rows = await strapiInstance.db.query('api::listing.listing').findMany({
    where: { title, publishedAt: { $notNull: true } },
  } as any);
  return Array.isArray(rows) ? rows.length : 0;
}

// ---------------------------------------------------------------------
// FIX A (P0): photo-ownership + image-type checks on syncOfflineListing
// ---------------------------------------------------------------------

test('offline create: a freshly-uploaded, not-yet-attached photo (own upload) is allowed', async () => {
  const user = await registerAndLogin(`fixA-own-create-${randomUUID()}@test.local`);
  const photoId = await uploadOnePhoto(user.jwt);
  const title = `FixA Own Create ${randomUUID()}`;

  const res = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: randomUUID(),
    ...listingPayload({ title, photos: [photoId] }),
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.listing.title, title);
  assert.equal(await countListingsByTitle(title), 1);
});

test('offline create: attaching a photo currently in use on ANOTHER user\'s live listing is rejected (403), no listing created', async () => {
  const victim = await registerAndLogin(`fixA-victim-create-${randomUUID()}@test.local`);
  const victimPhotoId = await uploadOnePhoto(victim.jwt);
  const victimTitle = `FixA Victim Listing ${randomUUID()}`;
  const victimListing = await createDirectListing(victim.jwt, { title: victimTitle, photos: [victimPhotoId] });
  assert.equal(victimListing.status, 201);

  const attacker = await registerAndLogin(`fixA-attacker-create-${randomUUID()}@test.local`);
  const attackTitle = `FixA Attacker Listing ${randomUUID()}`;
  const res = await offlineSync(attacker.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: randomUUID(),
    ...listingPayload({ title: attackTitle, photos: [victimPhotoId] }),
  });

  assert.equal(res.status, 403);
  assert.equal(await countListingsByTitle(attackTitle), 0, 'the attacker must end up with NO listing at all');
});

test('offline create: a non-image file id is rejected (400), no listing created', async () => {
  const user = await registerAndLogin(`fixA-nonimage-${randomUUID()}@test.local`);
  const fileId = await uploadOneNonImageFile(user.jwt);
  const title = `FixA Non Image ${randomUUID()}`;

  const res = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: randomUUID(),
    ...listingPayload({ title, photos: [fileId] }),
  });

  assert.equal(res.status, 400);
  assert.equal(await countListingsByTitle(title), 0);
});

test('offline create: a nonexistent upload id fails safely, no listing created', async () => {
  const user = await registerAndLogin(`fixA-nonexistent-${randomUUID()}@test.local`);
  const title = `FixA Nonexistent ${randomUUID()}`;

  const res = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: randomUUID(),
    ...listingPayload({ title, photos: [999999999] }),
  });

  assert.ok(res.status >= 400, `a nonexistent upload id must never silently succeed, got ${res.status}`);
  assert.equal(await countListingsByTitle(title), 0, 'no partial listing may exist after a rejected operation');
});

test('offline create: mixing one OWN upload with one FOREIGN upload rejects the WHOLE operation, no partial listing', async () => {
  const victim = await registerAndLogin(`fixA-victim-mixed-${randomUUID()}@test.local`);
  const victimPhotoId = await uploadOnePhoto(victim.jwt);
  const victimListing = await createDirectListing(victim.jwt, {
    title: `FixA Victim Mixed ${randomUUID()}`,
    photos: [victimPhotoId],
  });
  assert.equal(victimListing.status, 201);

  const attacker = await registerAndLogin(`fixA-attacker-mixed-${randomUUID()}@test.local`);
  const ownPhotoId = await uploadOnePhoto(attacker.jwt);
  const title = `FixA Attacker Mixed ${randomUUID()}`;

  const res = await offlineSync(attacker.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: randomUUID(),
    ...listingPayload({ title, photos: [ownPhotoId, victimPhotoId] }),
  });

  assert.equal(res.status, 403);
  assert.equal(await countListingsByTitle(title), 0, 'a mixed own+foreign request must reject the ENTIRE operation, not attach only the valid one');
});

test('offline update: re-saving a listing\'s OWN existing photo is still allowed', async () => {
  const user = await registerAndLogin(`fixA-own-update-${randomUUID()}@test.local`);
  const photoId = await uploadOnePhoto(user.jwt);
  const created = await createDirectListing(user.jwt, {
    title: `FixA Own Update ${randomUUID()}`,
    photos: [photoId],
  });
  assert.equal(created.status, 201);
  const listingId = created.body.data.id;

  const res = await offlineSync(user.jwt, 'update', {
    id: listingId,
    price: 250,
    photos: [photoId],
  });

  assert.equal(res.status, 200, 'the owner\'s own already-attached photo must remain valid on update/replay');
  assert.equal(Number(res.body.data.listing.price), 250);
});

test('offline update: attaching a photo currently in use on ANOTHER user\'s live listing is rejected (403), victim listing untouched', async () => {
  const victim = await registerAndLogin(`fixA-victim-update-${randomUUID()}@test.local`);
  const victimPhotoId = await uploadOnePhoto(victim.jwt);
  const victimTitle = `FixA Victim Update Target ${randomUUID()}`;
  const victimListing = await createDirectListing(victim.jwt, { title: victimTitle, photos: [victimPhotoId] });
  assert.equal(victimListing.status, 201);

  const attacker = await registerAndLogin(`fixA-attacker-update-${randomUUID()}@test.local`);
  const attackerListing = await createDirectListing(attacker.jwt, {
    title: `FixA Attacker Own Listing ${randomUUID()}`,
  });
  assert.equal(attackerListing.status, 201);

  const res = await offlineSync(attacker.jwt, 'update', {
    id: attackerListing.body.data.id,
    photos: [victimPhotoId],
  });

  assert.equal(res.status, 403);
  const victimRow = await strapiInstance.entityService.findOne('api::listing.listing', victimListing.body.data.id, {
    populate: ['photos'],
  });
  assert.equal(victimRow.photos.length, 1, 'the victim\'s own photo attachment must remain untouched');
  assert.equal(victimRow.photos[0].id, victimPhotoId);
});

// ---------------------------------------------------------------------
// FIX B (P1, Madde 45): syncOfflineListing's own create-retry ledger
// ---------------------------------------------------------------------

test('offline create: missing operationId is rejected (400)', async () => {
  const user = await registerAndLogin(`fixB-missing-op-${randomUUID()}@test.local`);
  const res = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    ...listingPayload({ title: `FixB Missing Op ${randomUUID()}` }),
  });
  assert.equal(res.status, 400);
});

test('offline create: invalid (non-UUID) operationId is rejected (400)', async () => {
  const user = await registerAndLogin(`fixB-invalid-op-${randomUUID()}@test.local`);
  const res = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: 'not-a-uuid',
    ...listingPayload({ title: `FixB Invalid Op ${randomUUID()}` }),
  });
  assert.equal(res.status, 400);
});

test('offline create: retrying the SAME operationId + SAME content via syncOfflineListing itself resolves to the same listing, no duplicate', async () => {
  const user = await registerAndLogin(`fixB-self-retry-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `FixB Self Retry ${randomUUID()}`;

  const first = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: opId,
    ...listingPayload({ title }),
  });
  assert.equal(first.status, 200);
  assert.notEqual(first.body.data.idempotent, true, 'the first attempt is a genuine new create');
  // `listing` has draftAndPublish:true -- a create leaves TWO physical
  // rows (draft + published) sharing one documentId but DIFFERENT
  // numeric ids, so identity must be compared via documentId, not id.
  const firstDocId = first.body.data.listing.documentId;

  // Simulates the offline queue re-sending the identical row (this
  // endpoint's own prior response was lost/never confirmed).
  const retry = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: opId,
    ...listingPayload({ title }),
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.idempotent, true, 'a retry of syncOfflineListing\'s own create must be recognized as the same operation');
  assert.equal(retry.body.data.listing.documentId, firstDocId);
  assert.equal(await countListingsByTitle(title), 1, 'the offline path\'s own retry must never create a second, duplicate listing');
});

test('offline create: the SAME operationId with DIFFERENT content is rejected as a conflict (409)', async () => {
  const user = await registerAndLogin(`fixB-self-conflict-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `FixB Self Conflict ${randomUUID()}`;

  const first = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: opId,
    ...listingPayload({ title }),
  });
  assert.equal(first.status, 200);

  const conflicting = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: opId,
    ...listingPayload({ title: `${title} DIFFERENT` }),
  });
  assert.equal(conflicting.status, 409);
  assert.equal(await countListingsByTitle(title), 1);
  assert.equal(await countListingsByTitle(`${title} DIFFERENT`), 0);
});

test('offline create: retrying with re-uploaded (different) photo ids under the SAME operationId is still recognized as the same operation, not a conflict', async () => {
  const user = await registerAndLogin(`fixB-photo-retry-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `FixB Photo Retry ${randomUUID()}`;

  const firstPhotoId = await uploadOnePhoto(user.jwt);
  const first = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: opId,
    ...listingPayload({ title, photos: [firstPhotoId] }),
  });
  assert.equal(first.status, 200);
  const firstDocId = first.body.data.listing.documentId;

  const retryPhotoId = await uploadOnePhoto(user.jwt);
  const retry = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: opId,
    ...listingPayload({ title, photos: [retryPhotoId] }),
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.idempotent, true);
  assert.equal(retry.body.data.listing.documentId, firstDocId);
  assert.equal(await countListingsByTitle(title), 1);
});

test('offline create: a genuinely different operationId creates a genuinely different listing, even with identical content', async () => {
  const user = await registerAndLogin(`fixB-different-op-${randomUUID()}@test.local`);
  const title = `FixB Different Op ${randomUUID()}`;

  const first = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: randomUUID(),
    ...listingPayload({ title }),
  });
  assert.equal(first.status, 200);
  const second = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: randomUUID(),
    ...listingPayload({ title }),
  });
  assert.equal(second.status, 200);

  assert.notEqual(first.body.data.listing.id, second.body.data.listing.id);
  assert.equal(await countListingsByTitle(title), 2, 'two genuinely separate submissions are two real listings');
});

test('offline create: retrying the SAME operationId that was originally used via the DIRECT POST /listings path still resolves to that listing (cross-path idempotency preserved)', async () => {
  const user = await registerAndLogin(`fixB-cross-path-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `FixB Cross Path ${randomUUID()}`;

  const direct = await createDirectListing(user.jwt, { title });
  assert.equal(direct.status, 201);
  // createDirectListing uses its own random operationId internally, so
  // redo this one call with the operationId we control instead.
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({ data: { ...listingPayload({ title: `${title} v2` }), operationId: opId } }),
  });
  const directJson = await res.json();
  assert.equal(res.status, 201);
  const realId = directJson.data.documentId ?? directJson.data.id;

  const retry = await offlineSync(user.jwt, 'create', {
    id: `l_${Date.now()}`,
    operationId: opId,
    ...listingPayload({ title: `${title} v2` }),
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.idempotent, true);
  const retryId = retry.body.data.listing?.documentId ?? retry.body.data.listing?.id;
  assert.equal(retryId, realId);
  assert.equal(await countListingsByTitle(`${title} v2`), 1);
});
