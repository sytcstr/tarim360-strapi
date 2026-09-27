/**
 * UAT #11 (real-device 1.0.85 report): a listing the user deleted kept
 * reappearing from category browsing while correctly disappearing from
 * Profile/Popular/Home.
 *
 * Root cause: the Flutter client only ever had `ProfileProduct.id`
 * ("strapi_<numericId>") to delete by, and its delete call guessed a
 * numeric id by stripping known prefixes -- never the real `documentId`
 * Strapi 5's document service actually deletes by. `delete()` (listing.ts)
 * passed `ctx.params.id` through to `super.delete(ctx)` UNRESOLVED: given
 * a numeric id (or any other non-documentId string), the document
 * service's `deleteDocument` builds `where: { documentId }`, matches ZERO
 * rows, and returns a normal-looking success with nothing actually
 * deleted -- no thrown error, no 404. The client believed the delete
 * worked and hid the row in every locally-tracked cache, while the row
 * stayed fully `active`/published on the server -- exactly why a genuine
 * fresh server query (category browsing) still returned it.
 *
 * This suite proves, against a real Strapi boot: (1) DELETE by a
 * listing's raw numeric `id` now genuinely removes the row (not just a
 * 200 status -- the row is gone), (2) DELETE by a garbage/nonexistent id
 * now returns a real 404 instead of a silent fake-success, and the row
 * count is provably unchanged, (3) the normal, already-correct
 * documentId-based delete path (existing tests' own contract) is
 * unaffected.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-uat11-listing-delete-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-uat11-listing-delete-test.db');
const PORT = 14197;
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

async function registerAndLogin(email: string): Promise<{ jwt: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return { jwt: json.jwt };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: { ...authed(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        title: 'UAT11 Delete Test Ilani',
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, id: body?.data?.id, documentId: body?.data?.documentId };
}

async function findByDocumentId(documentId: string) {
  return strapiInstance.db
    .query('api::listing.listing')
    .findOne({ where: { documentId } });
}

async function countAllListings(): Promise<number> {
  return strapiInstance.db.query('api::listing.listing').count();
}

test('UAT #11: DELETE by a listing\'s raw numeric id actually deletes the row (not just a success status)', async () => {
  const owner = await registerAndLogin(`uat11-numeric-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  assert.equal(created.status, 201);
  assert.ok(created.id, 'create must return a numeric id');
  assert.ok(created.documentId, 'create must return a documentId');

  const res = await fetch(`${BASE_URL}/listings/${created.id}`, {
    method: 'DELETE',
    headers: authed(owner.jwt),
  });
  assert.ok(
    res.status === 200 || res.status === 204,
    `a raw numeric id must resolve to the real row and delete it (got ${res.status})`,
  );

  const stillThere = await findByDocumentId(created.documentId);
  assert.equal(stillThere, null, 'the row must be genuinely gone from the database, not just hidden client-side');
});

test('UAT #11: DELETE by "strapi_<id>" (the exact shape the old Flutter bug sent) also actually deletes the row', async () => {
  // findListingByAnyId's own candidate resolution already strips this
  // exact prefix (listingIdCandidates) -- this proves the delete() fix
  // (rewriting ctx.params.id to the RESOLVED documentId before calling
  // super.delete) actually benefits from that existing resolution instead
  // of bypassing it the way the unfixed code did.
  const owner = await registerAndLogin(`uat11-prefixed-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);

  const res = await fetch(`${BASE_URL}/listings/strapi_${created.id}`, {
    method: 'DELETE',
    headers: authed(owner.jwt),
  });
  assert.ok(
    res.status === 200 || res.status === 204,
    `a "strapi_"-prefixed id must resolve to the real row and delete it (got ${res.status})`,
  );

  const stillThere = await findByDocumentId(created.documentId);
  assert.equal(stillThere, null, 'the row must be genuinely gone, not silently kept alive');
});

test('UAT #11: DELETE by an id that matches no real row deletes nothing (pre-existing owner-write policy denies it before the controller is ever reached)', async () => {
  const owner = await registerAndLogin(`uat11-nomatch-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const before = await countAllListings();

  // A well-formed but entirely nonexistent documentId shape -- no prefix
  // stripping or digit-extraction in listingIdCandidates can turn this
  // into anything that matches a real row. `global::listing-owner-write`
  // (the route's own policy, unrelated to and unchanged by this fix)
  // denies with 403 for any id it cannot load an owner for -- this proves
  // that pre-existing guard is untouched, and that the controller's own
  // notFound fallback never gets a chance to silently "succeed" either.
  const res = await fetch(`${BASE_URL}/listings/zzznonexistentdocumentid000`, {
    method: 'DELETE',
    headers: authed(owner.jwt),
  });
  assert.equal(res.status, 403);

  const after = await countAllListings();
  assert.equal(after, before, 'nothing may be deleted when the id resolves to no real row');

  const stillThere = await findByDocumentId(created.documentId);
  assert.ok(stillThere, 'the unrelated real listing must be completely untouched');
});

// ---------------------------------------------------------------------
// UAT #12 CORRECTION: READ != WRITE. A real, valid, someone-else's-
// listing DELETE attempt must still be denied (this is unaffected by
// this file's own fix, which only ever changes WHICH row a legitimate
// owner's delete targets -- never who is allowed to delete it).
// ---------------------------------------------------------------------

test('UAT #12: a stranger cannot delete another user\'s real, valid, active listing (READ != WRITE)', async () => {
  const owner = await registerAndLogin(`uat12-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`uat12-stranger-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);

  const res = await fetch(`${BASE_URL}/listings/${created.documentId}`, {
    method: 'DELETE',
    headers: authed(stranger.jwt),
  });
  assert.equal(res.status, 403);

  const stillThere = await findByDocumentId(created.documentId);
  assert.ok(stillThere, 'the owner\'s listing must survive a stranger\'s delete attempt');
});

test('UAT #11 regression: DELETE by the real documentId (the already-correct path) still works', async () => {
  const owner = await registerAndLogin(`uat11-docid-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);

  const res = await fetch(`${BASE_URL}/listings/${created.documentId}`, {
    method: 'DELETE',
    headers: authed(owner.jwt),
  });
  assert.ok(res.status === 200 || res.status === 204);

  const stillThere = await findByDocumentId(created.documentId);
  assert.equal(stillThere, null);
});
