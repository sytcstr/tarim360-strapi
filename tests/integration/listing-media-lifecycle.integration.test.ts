/**
 * LISTING_L13_MEDIA_LIFECYCLE_REPORT.md.
 *
 * Forensic found orphan cleanup did not exist anywhere in this codebase
 * (any content type), and confirmed a real, live security gap: nothing
 * stopped a user from attaching a file id already visibly used on
 * someone ELSE's listing to their own (Strapi's core media-relation
 * connect only checks the file id exists, never who owns it). This
 * suite proves the fix end to end via real HTTP + real multipart
 * uploads: create/update ownership checks, keep/add/remove/replace
 * photo semantics, listing-delete cleanup, and the multi-reference
 * "never delete a file still in use elsewhere" safety net (L13.10).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-media-lifecycle-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-media-lifecycle-test.db');
const PORT = 14190;
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

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

// A minimal valid 1x1 PNG, real image bytes (not a stub) so Strapi's
// own image-processing pipeline (format/size extraction) runs for real.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

async function uploadOnePhoto(jwt: string, filename = `${randomUUID()}.png`): Promise<number> {
  const form = new FormData();
  form.append('files', new Blob([ONE_PX_PNG], { type: 'image/png' }), filename);
  const res = await fetch(`${BASE_URL}/upload`, {
    method: 'POST',
    headers: authed(jwt),
    body: form as any,
  });
  const body = await res.json();
  if (res.status >= 400) {
    throw new Error(`upload failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return (body as any[])[0].id;
}

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings?populate[0]=photos`, {
    method: 'POST',
    headers: { ...authed(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        title: 'L13 Media Test Ilani',
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function updateListing(jwt: string, documentId: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/listings/${documentId}?populate[0]=photos`, {
    method: 'PUT',
    headers: { ...authed(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteListing(jwt: string, documentId: string) {
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  return { status: res.status };
}

async function fileExists(fileId: number): Promise<boolean> {
  const row = await strapiInstance.entityService.findOne('plugin::upload.file', fileId, {});
  return Boolean(row);
}

function photoIds(listingData: any): number[] {
  const photos = listingData?.photos;
  if (!Array.isArray(photos)) return [];
  return photos.map((p: any) => p.id).sort((a: number, b: number) => a - b);
}

// ---------------------------------------------------------------------
// L13.4 -- create: owner's own freshly-uploaded photos are accepted
// ---------------------------------------------------------------------

test('L13.4: creating a listing with the uploader\'s own freshly-uploaded photo succeeds', async () => {
  const owner = await registerAndLogin(`l13-create-owner-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(owner.jwt);

  const { status, body } = await createListing(owner.jwt, { photos: [fileId] });
  assert.equal(status, 201);
  assert.deepEqual(photoIds(body.data), [fileId]);
});

// ---------------------------------------------------------------------
// L13.3 -- security: cannot attach someone else's already-attached photo
// ---------------------------------------------------------------------

test('L13.3: creating a listing that references a file already attached to a DIFFERENT user\'s listing is rejected', async () => {
  const victim = await registerAndLogin(`l13-security-victim-${randomUUID()}@test.local`);
  const victimFileId = await uploadOnePhoto(victim.jwt);
  await createListing(victim.jwt, { photos: [victimFileId] });

  const attacker = await registerAndLogin(`l13-security-attacker-${randomUUID()}@test.local`);
  const { status } = await createListing(attacker.jwt, { photos: [victimFileId] });
  assert.equal(status, 403);
});

test('L13.3: updating a listing to reference a file already attached to a DIFFERENT user\'s listing is rejected, existing photos untouched', async () => {
  const victim = await registerAndLogin(`l13-security-victim2-${randomUUID()}@test.local`);
  const victimFileId = await uploadOnePhoto(victim.jwt);
  await createListing(victim.jwt, { photos: [victimFileId] });

  const attacker = await registerAndLogin(`l13-security-attacker2-${randomUUID()}@test.local`);
  const ownFileId = await uploadOnePhoto(attacker.jwt);
  const created = await createListing(attacker.jwt, { photos: [ownFileId] });
  assert.equal(created.status, 201);

  const { status } = await updateListing(attacker.jwt, created.body.data.documentId, {
    photos: [ownFileId, victimFileId],
  });
  assert.equal(status, 403);

  // Confirm the attempted attach didn't silently partially apply.
  const check = await fetch(`${BASE_URL}/listings/${created.body.data.documentId}?populate[0]=photos`, {
    headers: authed(attacker.jwt),
  });
  const checkBody = await check.json();
  assert.deepEqual(photoIds(checkBody.data), [ownFileId]);
});

test('L13.3 regression: a non-owner cannot update another user\'s listing at all (photos or otherwise)', async () => {
  const owner = await registerAndLogin(`l13-ownership-owner-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const stranger = await registerAndLogin(`l13-ownership-stranger-${randomUUID()}@test.local`);

  const { status } = await updateListing(stranger.jwt, created.body.data.documentId, {
    title: 'Hacked',
  });
  assert.equal(status, 403);
});

// ---------------------------------------------------------------------
// L13.5/L13.6/L13.7/L13.8 -- edit: keep / add / remove / replace
// ---------------------------------------------------------------------

test('L13.5: an edit that changes only the title preserves existing photos when the client resends their ids', async () => {
  const owner = await registerAndLogin(`l13-keep-owner-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(owner.jwt);
  const created = await createListing(owner.jwt, { photos: [fileId] });

  const { status, body } = await updateListing(owner.jwt, created.body.data.documentId, {
    title: 'Yeni Baslik',
    photos: [fileId],
  });
  assert.equal(status, 200);
  assert.deepEqual(photoIds(body.data), [fileId]);
  assert.ok(await fileExists(fileId), 'kept photo file must still exist');
});

test('L13.6: adding a second photo keeps the first and adds the second, in the order sent', async () => {
  const owner = await registerAndLogin(`l13-add-owner-${randomUUID()}@test.local`);
  const fileA = await uploadOnePhoto(owner.jwt, 'a.png');
  const created = await createListing(owner.jwt, { photos: [fileA] });

  const fileB = await uploadOnePhoto(owner.jwt, 'b.png');
  const { status, body } = await updateListing(owner.jwt, created.body.data.documentId, {
    photos: [fileA, fileB],
  });
  assert.equal(status, 200);
  assert.deepEqual(photoIds(body.data), [fileA, fileB].sort((a, b) => a - b));
});

test('L13.7: removing one of two photos leaves only the kept one attached, and physically deletes the removed one (not referenced elsewhere)', async () => {
  const owner = await registerAndLogin(`l13-remove-owner-${randomUUID()}@test.local`);
  const fileA = await uploadOnePhoto(owner.jwt, 'a.png');
  const fileB = await uploadOnePhoto(owner.jwt, 'b.png');
  const created = await createListing(owner.jwt, { photos: [fileA, fileB] });

  const { status, body } = await updateListing(owner.jwt, created.body.data.documentId, {
    photos: [fileA],
  });
  assert.equal(status, 200);
  assert.deepEqual(photoIds(body.data), [fileA]);

  // Cleanup runs synchronously (awaited) inside update() -- safe to
  // assert immediately.
  assert.ok(await fileExists(fileA), 'kept photo must still exist');
  assert.ok(!(await fileExists(fileB)), 'removed, unreferenced photo must be physically deleted');
});

test('L13.10: removing a photo that is ALSO used by the owner\'s OTHER listing does not physically delete it', async () => {
  const owner = await registerAndLogin(`l13-shared-owner-${randomUUID()}@test.local`);
  const shared = await uploadOnePhoto(owner.jwt, 'shared.png');
  const listingOne = await createListing(owner.jwt, { photos: [shared], title: 'Listing One' });
  const listingTwo = await createListing(owner.jwt, { photos: [shared], title: 'Listing Two' });
  assert.equal(listingOne.status, 201);
  assert.equal(listingTwo.status, 201);

  const { status, body } = await updateListing(owner.jwt, listingOne.body.data.documentId, {
    photos: [],
  });
  assert.equal(status, 200);
  assert.deepEqual(photoIds(body.data), []);

  assert.ok(
    await fileExists(shared),
    'a photo still attached to a DIFFERENT live listing must never be physically deleted',
  );

  // The second listing must still show it.
  const check = await fetch(`${BASE_URL}/listings/${listingTwo.body.data.documentId}?populate[0]=photos`, {
    headers: authed(owner.jwt),
  });
  const checkBody = await check.json();
  assert.deepEqual(photoIds(checkBody.data), [shared]);
});

test('L13.8: replacing a photo (A -> D) ends with only D attached, and A is cleaned up', async () => {
  const owner = await registerAndLogin(`l13-replace-owner-${randomUUID()}@test.local`);
  const fileA = await uploadOnePhoto(owner.jwt, 'a.png');
  const created = await createListing(owner.jwt, { photos: [fileA] });

  const fileD = await uploadOnePhoto(owner.jwt, 'd.png');
  const { status, body } = await updateListing(owner.jwt, created.body.data.documentId, {
    photos: [fileD],
  });
  assert.equal(status, 200);
  assert.deepEqual(photoIds(body.data), [fileD]);
  assert.ok(!(await fileExists(fileA)), 'replaced-away photo must be cleaned up');
  assert.ok(await fileExists(fileD), 'the new photo must exist');
});

test('L13.5 regression: an edit that omits the photos key entirely (e.g. no photos ever attached) still succeeds normally', async () => {
  const owner = await registerAndLogin(`l13-nophotos-owner-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const { status } = await updateListing(owner.jwt, created.body.data.documentId, {
    title: 'Baslik Degisti',
  });
  assert.equal(status, 200);
});

// ---------------------------------------------------------------------
// L13.9 -- listing delete cleanup
// ---------------------------------------------------------------------

test('L13.9: deleting a listing physically cleans up its own, unreferenced photos', async () => {
  const owner = await registerAndLogin(`l13-delete-owner-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(owner.jwt);
  const created = await createListing(owner.jwt, { photos: [fileId] });

  const { status } = await deleteListing(owner.jwt, created.body.data.documentId);
  assert.equal(status, 204);
  assert.ok(!(await fileExists(fileId)), 'a deleted listing\'s own unreferenced photo must be cleaned up');
});

test('L13.9/L13.10: deleting a listing does NOT delete a photo still used by another of the owner\'s own listings', async () => {
  const owner = await registerAndLogin(`l13-delete-shared-owner-${randomUUID()}@test.local`);
  const shared = await uploadOnePhoto(owner.jwt, 'shared.png');
  const listingOne = await createListing(owner.jwt, { photos: [shared], title: 'Delete Me' });
  const listingTwo = await createListing(owner.jwt, { photos: [shared], title: 'Keep Me' });

  const { status } = await deleteListing(owner.jwt, listingOne.body.data.documentId);
  assert.equal(status, 204);
  assert.ok(
    await fileExists(shared),
    'a photo still attached to a surviving listing must never be deleted',
  );
  void listingTwo;
});

// ---------------------------------------------------------------------
// L13.3 -- the raw public upload-destroy route is no longer usable
// ---------------------------------------------------------------------

test('L13.3: the raw public DELETE /upload/files/:id route is no longer permitted for any authenticated user', async () => {
  const owner = await registerAndLogin(`l13-rawdelete-owner-${randomUUID()}@test.local`);
  const fileId = await uploadOnePhoto(owner.jwt);

  const res = await fetch(`${BASE_URL}/upload/files/${fileId}`, {
    method: 'DELETE',
    headers: authed(owner.jwt),
  });
  assert.equal(res.status, 403);
  assert.ok(await fileExists(fileId), 'the file must still exist -- the request must have been rejected, not processed');
});

// ---------------------------------------------------------------------
// L13.17 -- file validation (allowedTypes narrowed to images-only)
// ---------------------------------------------------------------------

test('L13.17: a non-image file cannot be attached to a listing\'s photos field', async () => {
  const owner = await registerAndLogin(`l13-filetype-owner-${randomUUID()}@test.local`);
  const form = new FormData();
  form.append('files', new Blob([Buffer.from('not an image')], { type: 'text/plain' }), 'note.txt');
  const uploadRes = await fetch(`${BASE_URL}/upload`, {
    method: 'POST',
    headers: authed(owner.jwt),
    body: form as any,
  });
  const uploadBody = await uploadRes.json();
  const fileId = uploadRes.status < 400 ? (uploadBody as any[])[0]?.id : null;
  if (fileId == null) {
    // Strapi's own global upload validation already rejected it outright
    // -- the listing-level allowedTypes restriction is then moot for
    // this specific file, which is an equally acceptable outcome.
    assert.ok(uploadRes.status >= 400);
    return;
  }
  const { status } = await createListing(owner.jwt, { photos: [fileId] });
  assert.equal(status, 400, 'a non-image file must be rejected by the photos field\'s allowedTypes');
});
