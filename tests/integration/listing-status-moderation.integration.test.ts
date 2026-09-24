/**
 * İlan1 lifecycle/moderation: `status` -> `listingStatus`.
 *
 * Strapi v5's Content Manager reserves the name `status` for a document's
 * draft/published state. With a business attribute literally called
 * `status` on the Draft & Publish `listing` type, an admin could neither
 * see the stored value (the CM reports "published" instead, so the enum
 * dropdown renders blank) nor save `pending`/`rejected` ("Invalid status",
 * a 400 from the CM's own draft|published validation) -- so pending and
 * rejected listings could never be produced by anyone in production.
 *
 * This suite proves the lifecycle is now genuinely operable AND still
 * safe:
 *  - an admin CAN set pending/rejected through the real Content Manager
 *    endpoints (save draft + publish, the exact admin-panel flow);
 *  - a stranger/anonymous caller never sees a non-active listing, on any
 *    discovery surface; the owner keeps their own view of it;
 *  - no client (PUT, create, offline-sync, legacy `status` key from old
 *    app builds) can mutate the lifecycle;
 *  - the legacy `status` -> `listingStatus` data migration copies real
 *    pending/rejected values (the schema default would otherwise stamp
 *    'active' onto them) and never overwrites later moderation edits.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { runListingStatusToListingStatusMigrationOnce } from '../../src/utils/listing-status-migration';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-status-moderation-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-status-moderation-test.db');
const PORT = 14260;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE_URL = `${ORIGIN}/api`;
const CM = `${ORIGIN}/content-manager/collection-types/api::listing.listing`;

let strapiInstance: any;
let adminToken = '';

before(async () => {
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = String(PORT);
  const compiled = await compileStrapi();
  strapiInstance = await createStrapi(compiled).load();
  await strapiInstance.server.listen(PORT);

  const role = await strapiInstance.db.query('admin::role').findOne({ where: { code: 'strapi-super-admin' } });
  await strapiInstance.service('admin::user').create({
    email: 'moderator@test.local',
    firstname: 'Mod',
    lastname: 'Erator',
    password: 'Passw0rd!123',
    isActive: true,
    roles: [role.id],
  });
  const login = await (
    await fetch(`${ORIGIN}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'moderator@test.local', password: 'Passw0rd!123' }),
    })
  ).json();
  adminToken = login.data.token;
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

async function call(method: string, url: string, jwt: string | null, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createListing(owner: { jwt: string }, title: string) {
  const r = await call('POST', `${BASE_URL}/listings`, owner.jwt, {
    data: { operationId: randomUUID(), title, mainType: 'tarim', mode: 'sell', price: 100 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.data as { documentId: string; id: number; listingStatus?: string };
}

// The exact admin-panel flow: save the DRAFT, then Publish it.
async function moderate(documentId: string, listingStatus: 'pending' | 'active' | 'rejected') {
  const save = await call('PUT', `${CM}/${documentId}?status=draft`, adminToken, { listingStatus });
  assert.equal(save.status, 200, `Content Manager rejected listingStatus=${listingStatus}: ${JSON.stringify(save.body)}`);
  const publish = await call('POST', `${CM}/${documentId}/actions/publish`, adminToken, {});
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
}

const listedIn = (r: { body: any }, documentId: string) =>
  (r.body.data ?? []).some((row: any) => row.documentId === documentId);

async function assertHiddenFromStrangers(documentId: string, title: string, stranger: { jwt: string }, ownerId: string) {
  for (const jwt of [null, stranger.jwt]) {
    const who = jwt ? 'stranger' : 'anonymous';
    assert.equal((await call('GET', `${BASE_URL}/listings/${documentId}`, jwt)).status, 404, `${who} findOne`);
    assert.equal((await call('GET', `${BASE_URL}/listings/${documentId}/similar`, jwt)).status, 404, `${who} similar`);
    const byTitle = await call('GET', `${BASE_URL}/listings?filters[title][$eq]=${encodeURIComponent(title)}`, jwt);
    assert.equal(listedIn(byTitle, documentId), false, `${who} raw title filter`);
    const bySearch = await call('GET', `${BASE_URL}/listings?search=${encodeURIComponent(title)}`, jwt);
    assert.equal(listedIn(bySearch, documentId), false, `${who} search`);
    const byIds = await call('GET', `${BASE_URL}/listings?documentIds=${documentId}`, jwt);
    assert.equal(listedIn(byIds, documentId), false, `${who} documentIds`);
    const bySeller = await call('GET', `${BASE_URL}/listings?ownerProfileId=${ownerId}`, jwt);
    assert.equal(listedIn(bySeller, documentId), false, `${who} seller-other`);
    const injected = await call('GET', `${BASE_URL}/listings?filters[listingStatus][$ne]=active`, jwt);
    assert.equal(listedIn(injected, documentId), false, `${who} raw listingStatus filter`);
  }
  const fav = await call('PUT', `${BASE_URL}/engagements/favorite`, stranger.jwt, {
    data: { targetType: 'listing', targetId: documentId },
  });
  assert.equal(fav.status, 404, 'stranger cannot favorite a non-active listing');
}

for (const state of ['pending', 'rejected'] as const) {
  test(`admin can set ${state} through the real Content Manager flow; strangers never see it, the owner keeps their own view`, async () => {
    const owner = await registerAndLogin(`mod-${state}-owner-${randomUUID()}@test.local`);
    const stranger = await registerAndLogin(`mod-${state}-stranger-${randomUUID()}@test.local`);
    const title = `Moderasyon ${state} ${randomUUID()}`;
    const listing = await createListing(owner, title);
    assert.equal(listing.listingStatus, 'active');
    assert.equal((await call('GET', `${BASE_URL}/listings/${listing.documentId}`, null)).status, 200, 'active is public');

    await moderate(listing.documentId, state);

    await assertHiddenFromStrangers(listing.documentId, title, stranger, owner.ownerId);

    // Owner contract: sees the real lifecycle state on their own listing,
    // by id and in their own (Ilanlarim) list.
    const own = await call('GET', `${BASE_URL}/listings/${listing.documentId}`, owner.jwt);
    assert.equal(own.status, 200);
    assert.equal(own.body.data.listingStatus, state);
    const mine = await call('GET', `${BASE_URL}/listings?filters[ownerProfileId][$eq]=${owner.ownerId}&pagination[pageSize]=50`, owner.jwt);
    const mineRow = (mine.body.data ?? []).find((r: any) => r.documentId === listing.documentId);
    assert.ok(mineRow, 'owner still lists their own non-active listing');
    assert.equal(mineRow.listingStatus, state);

    // ...and an admin can restore it.
    await moderate(listing.documentId, 'active');
    assert.equal((await call('GET', `${BASE_URL}/listings/${listing.documentId}`, stranger.jwt)).status, 200);
    assert.equal(
      (await call('GET', `${BASE_URL}/listings/${listing.documentId}`, stranger.jwt)).body.data.listingStatus,
      'active',
    );
  });
}

test('generic thread creation on a moderated (pending) listing is rejected', async () => {
  const owner = await registerAndLogin(`mod-thread-owner-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`mod-thread-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(owner, `Moderasyon thread ${randomUUID()}`);
  await moderate(listing.documentId, 'pending');
  const th = await call('POST', `${BASE_URL}/threads`, buyer.jwt, {
    data: { listingId: listing.documentId, lastMessage: 'merhaba', conversationKey: `mod-${randomUUID()}` },
  });
  assert.equal(th.status, 403, JSON.stringify(th.body));
});

test('no client can mutate the lifecycle: PUT, create body, offline-sync, and the legacy `status` key are all ignored', async () => {
  const owner = await registerAndLogin(`mod-client-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`mod-client-stranger-${randomUUID()}@test.local`);
  const listing = await createListing(owner, `Moderasyon client ${randomUUID()}`);
  const state = async () =>
    (await call('GET', `${BASE_URL}/listings/${listing.documentId}`, owner.jwt)).body.data?.listingStatus;

  for (const bad of [
    { listingStatus: 'pending' },
    { listingStatus: 'rejected' },
    { status: 'rejected' },
    { listingStatus: 'rejected', status: 'rejected', publishedAt: null },
  ]) {
    const put = await call('PUT', `${BASE_URL}/listings/${listing.documentId}`, owner.jwt, { data: bad });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(await state(), 'active', `owner PUT ${JSON.stringify(bad)} must not change the lifecycle`);
  }
  const foreign = await call('PUT', `${BASE_URL}/listings/${listing.documentId}`, stranger.jwt, { data: { listingStatus: 'rejected' } });
  assert.equal(foreign.status, 403);

  const sync = await call('POST', `${BASE_URL}/offline-sync/listings`, owner.jwt, {
    operation: 'update',
    listing: { id: listing.documentId, title: 'sync edit', listingStatus: 'rejected', status: 'rejected' },
  });
  assert.equal(sync.status, 200, JSON.stringify(sync.body));
  assert.equal(await state(), 'active', 'offline-sync must not change the lifecycle');
  assert.equal(
    (await call('GET', `${BASE_URL}/listings/${listing.documentId}`, null)).body.data.title,
    'sync edit',
    'the offline-sync edit itself still applies',
  );

  // Old app builds still send `status` (+ publishedAt) on create; it must
  // be stripped, not fail Strapi's unknown-key validation.
  const legacyCreate = await call('POST', `${BASE_URL}/listings`, owner.jwt, {
    data: {
      operationId: randomUUID(),
      title: `Moderasyon legacy create ${randomUUID()}`,
      mainType: 'tarim',
      mode: 'sell',
      price: 1,
      status: 'rejected',
      listingStatus: 'rejected',
      publishedAt: new Date().toISOString(),
    },
  });
  assert.equal(legacyCreate.status, 201, JSON.stringify(legacyCreate.body));
  assert.equal(legacyCreate.body.data.listingStatus, 'active', 'create always stamps active');
});

test('migration copies real legacy status values (schema default would otherwise stamp active) and never overwrites later moderation', async () => {
  const owner = await registerAndLogin(`mod-migrate-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`mod-migrate-stranger-${randomUUID()}@test.local`);
  const title = `Moderasyon migrate ${randomUUID()}`;
  const listing = await createListing(owner, title);
  const knex = strapiInstance.db.connection;
  const store = strapiInstance.store({ type: 'core', name: 'bootstrap' });
  const key = 'listing_status_to_listing_status_v1_done';

  // Simulate a production row that only carries the legacy value.
  await knex('listings').where({ document_id: listing.documentId }).update({ status: 'pending', listing_status: 'active' });
  await store.set({ key, value: false });

  await runListingStatusToListingStatusMigrationOnce(strapiInstance);
  const rows = await knex('listings').where({ document_id: listing.documentId }).select('status', 'listing_status');
  assert.ok(rows.length >= 1);
  for (const r of rows) assert.equal(r.listing_status, 'pending', 'legacy pending survived the migration');
  assert.equal((await call('GET', `${BASE_URL}/listings/${listing.documentId}`, stranger.jwt)).status, 404);

  // Second run is a no-op even if moderation later changed the new field.
  await moderate(listing.documentId, 'active');
  await runListingStatusToListingStatusMigrationOnce(strapiInstance);
  assert.equal((await call('GET', `${BASE_URL}/listings/${listing.documentId}`, stranger.jwt)).status, 200);
});
