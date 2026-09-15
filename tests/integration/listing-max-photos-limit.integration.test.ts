/**
 * İLAN 1B — MEDIA (Madde 47).
 *
 * LISTING_AZ_REVALIDATION_PART3_41_60.md confirmed the 5-photo cap was
 * enforced only client-side (create_listing_page.dart's fixed-length
 * `photos` array) -- the backend had no schema constraint or controller
 * check on `photos.length`, so a direct API call with a valid JWT could
 * attach 6+ photo ids to a single listing. Classified P2/product-limit
 * (not a security issue -- every id still passes ownership/image-type
 * checks) and deliberately deferred to İlan 1. This suite proves the new
 * `exceedsMaxListingPhotos` check (listing-media.ts) is enforced
 * identically on all three write paths that accept a `photos` array:
 * POST /listings, PUT /listings/:id, and POST /offline-sync/listings.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-max-photos-limit-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-max-photos-limit-test.db');
const PORT = 14205;
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
  return { jwt: json.jwt, email: json.user?.email ?? email };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

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

async function uploadPhotos(jwt: string, count: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(await uploadOnePhoto(jwt));
  return ids;
}

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Madde47 Test Ilani',
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function updateListing(jwt: string, documentId: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function offlineSync(jwt: string, operation: string, listing: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ operation, listing }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------
// POST /listings (create)
// ---------------------------------------------------------------------

test('create: exactly 5 photos is accepted (at the limit, not over it)', async () => {
  const user = await registerAndLogin(`m47-create-at-limit-${randomUUID()}@test.local`);
  const ids = await uploadPhotos(user.jwt, 5);
  const res = await createListing(user.jwt, { photos: ids });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

test('create: 6 photos is rejected with a clear error, no listing created', async () => {
  const user = await registerAndLogin(`m47-create-over-limit-${randomUUID()}@test.local`);
  const ids = await uploadPhotos(user.jwt, 6);
  const title = `Madde47 Over Limit ${randomUUID()}`;
  const res = await createListing(user.jwt, { title, photos: ids });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const rows = await strapiInstance.db.query('api::listing.listing').findMany({ where: { title } } as any);
  assert.equal(rows.length, 0, 'no listing may be created when the photo limit is exceeded');
});

// ---------------------------------------------------------------------
// PUT /listings/:id (update)
// ---------------------------------------------------------------------

test('update: growing an existing listing from 5 to 6 photos is rejected, existing photos untouched', async () => {
  const user = await registerAndLogin(`m47-update-over-limit-${randomUUID()}@test.local`);
  const initialIds = await uploadPhotos(user.jwt, 5);
  const created = await createListing(user.jwt, { photos: initialIds });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.body.data.documentId;

  const extraId = await uploadOnePhoto(user.jwt);
  const res = await updateListing(user.jwt, documentId, { photos: [...initialIds, extraId] });
  assert.equal(res.status, 400, JSON.stringify(res.body));

  const row = await strapiInstance.db
    .query('api::listing.listing')
    .findOne({ where: { documentId }, populate: ['photos'] } as any);
  assert.equal(row.photos.length, 5, 'the update must be rejected before touching the existing photos relation');
});

test('update: an unrelated field change still succeeds when photos are not touched', async () => {
  const user = await registerAndLogin(`m47-update-untouched-${randomUUID()}@test.local`);
  const initialIds = await uploadPhotos(user.jwt, 5);
  const created = await createListing(user.jwt, { photos: initialIds });
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;

  const res = await updateListing(user.jwt, documentId, { title: 'Guncellendi' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

// ---------------------------------------------------------------------
// POST /offline-sync/listings
// ---------------------------------------------------------------------

test('offline-sync create: 6 photos is rejected the same way as the direct path', async () => {
  const user = await registerAndLogin(`m47-offline-create-${randomUUID()}@test.local`);
  const ids = await uploadPhotos(user.jwt, 6);
  const res = await offlineSync(user.jwt, 'create', {
    operationId: randomUUID(),
    title: 'Madde47 Offline Over Limit',
    mainType: 'tarim',
    mode: 'sell',
    photos: ids,
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('offline-sync update: growing to 6 photos is rejected the same way as the direct path', async () => {
  const user = await registerAndLogin(`m47-offline-update-${randomUUID()}@test.local`);
  const initialIds = await uploadPhotos(user.jwt, 5);
  const created = await createListing(user.jwt, { photos: initialIds });
  assert.equal(created.status, 201);

  const extraId = await uploadOnePhoto(user.jwt);
  const res = await offlineSync(user.jwt, 'update', {
    id: created.body.data.id,
    photos: [...initialIds, extraId],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
});

test('a client sending the same id repeated does not falsely trip the limit (distinct-id count)', async () => {
  const user = await registerAndLogin(`m47-duplicate-ids-${randomUUID()}@test.local`);
  const ids = await uploadPhotos(user.jwt, 5);
  const res = await createListing(user.jwt, { photos: [...ids, ids[0], ids[0]] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
});
