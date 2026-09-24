/**
 * Full-app reconciliation P0/P1 findings (measured in production):
 *
 * 1. The Flutter app identifies a listing as `strapi_<numeric id>`
 *    (ProfileProduct.id) and sends that verbatim as the engagement targetId.
 *    The resolver only understood a bare numeric id or a documentId, so every
 *    favorite/like/view from the app answered 404 "listing bulunamadi".
 *    Favorites hydration (`documentIds=strapi_<id>`) could never match either.
 *
 * 2. Strapi v5 rebuilds the published row FROM THE DRAFT on every publish
 *    (each owner edit) and gives it a new numeric id. Counters written only to
 *    the published row were wiped on the first edit (fav 1 -> 0, like 1 -> 0,
 *    view 1 -> 0) and the per-actor favorite/like/view records, keyed by the
 *    old numeric id, were orphaned (a second favorite counted twice).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-engagement-id-forms-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-engagement-id-forms-test.db');
const PORT = 14262;
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

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function call(method: string, url: string, jwt: string | null, body?: unknown) {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function registerAndLogin(email: string) {
  const r = await call('POST', '/auth/local/register', null, { username: email, email, password: 'Passw0rd!123' });
  return { jwt: r.body.jwt as string, email: email.toLowerCase() };
}

async function createListing(owner: { jwt: string }, title: string) {
  const r = await call('POST', '/listings', owner.jwt, {
    data: { operationId: randomUUID(), title, mainType: 'tarim', mode: 'sell', price: 100 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { documentId: r.body.data.documentId as string, id: r.body.data.id as number };
}

const counters = async (documentId: string) => {
  const r = await call('GET', `/listings/${documentId}?fields[0]=favoriteCount&fields[1]=likeCount&fields[2]=viewCount`, null);
  return { id: r.body.data.id as number, fav: r.body.data.favoriteCount, like: r.body.data.likeCount, view: r.body.data.viewCount };
};

const membership = (kind: 'favorite' | 'like', on: boolean, jwt: string, targetId: string) =>
  on
    ? call('PUT', `/engagements/${kind}`, jwt, { targetType: 'listing', targetId })
    : call('DELETE', `/engagements/${kind}?targetType=listing&targetId=${encodeURIComponent(targetId)}`, jwt);

test('every id form the app or an API client can send resolves: strapi_<id>, listing_<id>, numeric id, documentId (favorite, like, view, legacy toggle)', async () => {
  const owner = await registerAndLogin(`eid-owner-${randomUUID()}@test.local`);
  const s = await registerAndLogin(`eid-actor-${randomUUID()}@test.local`);
  const listing = await createListing(owner, `Kimlik Bicimleri ${randomUUID()}`);
  const forms: Array<[string, string]> = [
    ['strapi_<id> (Flutter ProfileProduct.id)', `strapi_${listing.id}`],
    ['listing_<id>', `listing_${listing.id}`],
    ['numeric id', String(listing.id)],
    ['documentId', listing.documentId],
  ];
  for (const [label, id] of forms) {
    for (const kind of ['favorite', 'like'] as const) {
      const on = await membership(kind, true, s.jwt, id);
      assert.equal(on.status, 200, `${kind} ON with ${label}: ${JSON.stringify(on.body)}`);
      assert.equal(on.body.active, true);
      assert.equal(on.body.count, 1);
      const off = await membership(kind, false, s.jwt, id);
      assert.equal(off.status, 200, `${kind} OFF with ${label}: ${JSON.stringify(off.body)}`);
      assert.equal(off.body.active, false);
      assert.equal(off.body.count, 0);
    }
    const legacy = await call('POST', '/listing-favorites/toggle', s.jwt, { data: { listingId: id, favorite: true } });
    assert.equal(legacy.status, 200, `legacy favorite ON with ${label}: ${JSON.stringify(legacy.body)}`);
    const legacyOff = await call('POST', '/listing-favorites/toggle', s.jwt, { data: { listingId: id, favorite: false } });
    assert.equal(legacyOff.status, 200, `legacy favorite OFF with ${label}`);
  }
  // a view through the app form counts once (24h dedupe), never twice via another form
  const v1 = await call('POST', '/engagements/view', s.jwt, { targetType: 'listing', targetId: `strapi_${listing.id}` });
  assert.equal(v1.status, 200, JSON.stringify(v1.body));
  assert.equal(v1.body.incremented, true);
  const v2 = await call('POST', '/engagements/view', s.jwt, { targetType: 'listing', targetId: listing.documentId });
  assert.equal(v2.body.incremented, false, 'same actor + same listing = same view regardless of the id form');
  assert.deepEqual(await counters(listing.documentId), { id: listing.id, fav: 0, like: 0, view: 1 });

  // strings that merely CONTAIN digits must never resolve to a listing
  for (const bogus of [`abc${listing.id}def`, `xstrapi_${listing.id}`, 'strapi_', 'strapi_nope']) {
    assert.equal((await membership('favorite', true, s.jwt, bogus)).status, 404, `bogus id "${bogus}" must 404`);
  }
  // owner self-favorite stays blocked for every form
  for (const [, id] of forms) {
    assert.equal((await membership('favorite', true, owner.jwt, id)).status, 403);
  }
});

for (const path of ['owner PUT', 'offline-sync update'] as const) {
  test(`an owner edit (${path}) republishes with a new numeric id but keeps counters and each user's favorite/like/view`, async () => {
    const owner = await registerAndLogin(`rep-owner-${randomUUID()}@test.local`);
    const a = await registerAndLogin(`rep-a-${randomUUID()}@test.local`);
    const b = await registerAndLogin(`rep-b-${randomUUID()}@test.local`);
    const listing = await createListing(owner, `Yeniden Yayin ${randomUUID()}`);

    assert.equal((await membership('favorite', true, a.jwt, `strapi_${listing.id}`)).status, 200);
    assert.equal((await membership('like', true, a.jwt, listing.documentId)).status, 200);
    assert.equal((await membership('favorite', true, b.jwt, String(listing.id))).status, 200);
    assert.equal((await call('POST', '/engagements/view', a.jwt, { targetType: 'listing', targetId: `strapi_${listing.id}` })).body.incremented, true);
    assert.deepEqual(await counters(listing.documentId), { id: listing.id, fav: 2, like: 1, view: 1 });

    const editRes =
      path === 'owner PUT'
        ? await call('PUT', `/listings/${listing.documentId}`, owner.jwt, { data: { title: 'Duzenlendi' } })
        : await call('POST', '/offline-sync/listings', owner.jwt, {
            operation: 'update',
            listing: { id: listing.documentId, title: 'Duzenlendi' },
          });
    assert.equal(editRes.status, 200, JSON.stringify(editRes.body));

    const after = await counters(listing.documentId);
    assert.notEqual(after.id, listing.id, 'precondition: Strapi replaced the published row (numeric id churn)');
    assert.deepEqual(
      { fav: after.fav, like: after.like, view: after.view },
      { fav: 2, like: 1, view: 1 },
      'counters survive the republish',
    );

    // memberships survive: acting again is idempotent, not a second count
    const again = await membership('favorite', true, a.jwt, listing.documentId);
    assert.equal(again.body.changed, false, "A's favorite is still recorded after the edit");
    assert.equal(again.body.count, 2);
    const view = await call('POST', '/engagements/view', a.jwt, { targetType: 'listing', targetId: listing.documentId });
    assert.equal(view.body.incremented, false, "A's view dedupe survives the edit");
    // ...and undoing works, decrementing the surviving count exactly once
    const off = await membership('favorite', false, a.jwt, `strapi_${after.id}`);
    assert.equal(off.body.changed, true);
    assert.equal(off.body.count, 1);
    assert.equal((await membership('like', false, a.jwt, listing.documentId)).body.count, 0);
    assert.deepEqual(await counters(listing.documentId), { id: after.id, fav: 1, like: 0, view: 1 });
  });
}

test('Favorites hydration: documentIds accepts documentId, numeric id and the app strapi_<id> form, mixed, and still hides non-active listings', async () => {
  const owner = await registerAndLogin(`hyd-owner-${randomUUID()}@test.local`);
  const one = await createListing(owner, `Hidrasyon Bir ${randomUUID()}`);
  const two = await createListing(owner, `Hidrasyon Iki ${randomUUID()}`);
  const ids = async (q: string) => {
    const r = await call('GET', `/listings?documentIds=${encodeURIComponent(q)}`, null);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return (r.body.data as any[]).map((row) => row.documentId).sort();
  };
  assert.deepEqual(await ids(one.documentId), [one.documentId]);
  assert.deepEqual(await ids(`strapi_${one.id}`), [one.documentId]);
  assert.deepEqual(await ids(String(one.id)), [one.documentId]);
  assert.deepEqual(await ids(`listing_${one.id}`), [one.documentId]);
  assert.deepEqual(await ids(`strapi_${one.id},${two.documentId}`), [one.documentId, two.documentId].sort());
  assert.deepEqual(await ids(`strapi_${one.id},strapi_${two.id}`), [one.documentId, two.documentId].sort());
  assert.deepEqual(await ids('strapi_99999999,doesnotexist'), []);
  assert.deepEqual(await ids(`abc${one.id}def`), [], 'digits inside another string never match');

  await strapiInstance.db.query('api::listing.listing').updateMany({ where: { documentId: two.documentId }, data: { listingStatus: 'pending' } });
  assert.deepEqual(await ids(`strapi_${one.id},strapi_${two.id}`), [one.documentId], 'a pending listing is never returned by any id form');
});

test('records written under the legacy numeric key are adopted, not duplicated', async () => {
  const owner = await registerAndLogin(`leg-owner-${randomUUID()}@test.local`);
  const s = await registerAndLogin(`leg-actor-${randomUUID()}@test.local`);
  const listing = await createListing(owner, `Eski Anahtar ${randomUUID()}`);
  const actorKey = `user:${s.email}`;
  // what an old deployment wrote: keyed by the numeric id
  await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').create({
    data: { actorKey, targetType: 'listing', targetId: String(listing.id), kind: 'favorite' },
  });
  await strapiInstance.db.query('api::listing.listing').updateMany({ where: { documentId: listing.documentId }, data: { favoriteCount: 1 } });

  const again = await membership('favorite', true, s.jwt, listing.documentId);
  assert.equal(again.body.changed, false, 'the legacy row counts as already favorited');
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({ where: { actorKey, kind: 'favorite' } });
  assert.equal(rows.length, 1, 'no duplicate row');
  assert.equal(rows[0].targetId, listing.documentId, 'adopted onto the stable documentId key');
  const off = await membership('favorite', false, s.jwt, `strapi_${listing.id}`);
  assert.equal(off.body.changed, true);
  assert.equal(off.body.count, 0);
});

// The guards (ownership, lifecycle) and the mutation must resolve an id the
// same way -- otherwise a form only one of them understands slips past the
// guard (a real regression this suite caught while fixing the 404).
test('lifecycle and ownership guards apply to the app id form exactly as to a documentId', async () => {
  const owner = await registerAndLogin(`grd-owner-${randomUUID()}@test.local`);
  const s = await registerAndLogin(`grd-actor-${randomUUID()}@test.local`);
  const listing = await createListing(owner, `Koruma Tutarliligi ${randomUUID()}`);
  await strapiInstance.db.query('api::listing.listing').updateMany({ where: { documentId: listing.documentId }, data: { listingStatus: 'pending' } });
  for (const id of [`strapi_${listing.id}`, `listing_${listing.id}`, String(listing.id), listing.documentId]) {
    assert.equal((await membership('favorite', true, s.jwt, id)).status, 404, `pending listing via ${id}`);
    assert.equal((await membership('like', true, s.jwt, id)).status, 404);
    const legacy = await call('POST', '/listing-favorites/toggle', s.jwt, { data: { listingId: id, favorite: true } });
    assert.equal(legacy.status, 404, `legacy toggle on a pending listing via ${id}`);
    assert.equal((await call('POST', '/engagements/view', s.jwt, { targetType: 'listing', targetId: id })).status, 404);
    assert.equal((await membership('favorite', true, owner.jwt, id)).status, 403, `owner self-favorite via ${id}`);
    const legacyOwn = await call('POST', '/listing-favorites/toggle', owner.jwt, { data: { listingId: id, favorite: true } });
    assert.equal(legacyOwn.status, 403, `legacy owner self-favorite via ${id}`);
  }
});
