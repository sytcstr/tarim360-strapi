/**
 * LISTING_L14_LIFECYCLE_STATE_MACHINE_REPORT.md.
 *
 * Forensic found the real lifecycle model is narrower than the phase's
 * own hypothetical list: `status` is a 3-value enum (pending/active/
 * rejected) with NO passive/archived/expired/draft/deleted value
 * anywhere in the schema, and the app itself never writes anything but
 * 'active' -- pending/rejected are enforced on the read side (discovery
 * exclusion, messaging/offer creation gates) but have no real write path
 * in application code (only reachable via a direct DB write or the
 * Strapi admin panel). This suite locks in: client status-spoof
 * protection on create/update (already enforced since L9, re-verified
 * here as this phase's own regression), and the new `findOne` owner-vs-
 * stranger gate (L14.14) that closes a real, live gap -- a direct
 * `GET /api/listings/:id` for a pending/rejected listing previously
 * returned its full content to ANY caller, public or not, even though
 * every list/search/popular endpoint already excluded it.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-lifecycle-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-lifecycle-test.db');
const PORT = 14191;
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

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: { ...authed(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({
      data: {
        title: 'L14 Lifecycle Test Ilani',
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
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'PUT',
    headers: { ...authed(jwt), 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getListing(jwt: string | null, documentId: string) {
  const res = await fetch(`${BASE_URL}/listings/${documentId}`, {
    method: 'GET',
    headers: jwt ? authed(jwt) : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Directly flips a listing's `status` at the DB layer -- the only way
 * any real row in this codebase ever ends up pending/rejected, since no
 * application code path writes anything but 'active'. Updates BOTH the
 * draft and published physical rows sharing this documentId (this
 * content-type's draftAndPublish:true duplication). */
async function forceStatus(documentId: string, status: 'pending' | 'active' | 'rejected') {
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId },
    data: { status },
  });
}

test('L14.4: create cannot spoof status -- client-sent status is always ignored, row ends up active', async () => {
  const owner = await registerAndLogin(`l14-create-spoof-${randomUUID()}@test.local`);
  for (const spoofed of ['rejected', 'pending', 'approved', 'archived']) {
    const { status, body } = await createListing(owner.jwt, { status: spoofed });
    assert.equal(status, 201);
    assert.equal(body.data.status, 'active');
  }
});

test('L14.4: update cannot spoof status -- client-sent status in a PUT body never changes the real value', async () => {
  const owner = await registerAndLogin(`l14-update-spoof-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  assert.equal(created.status, 201);
  const documentId = created.body.data.documentId;

  for (const spoofed of ['rejected', 'pending', 'approved']) {
    const { status, body } = await updateListing(owner.jwt, documentId, {
      status: spoofed,
      title: `Retitled via ${spoofed} attempt`,
    });
    assert.equal(status, 200);
    assert.equal(body.data.status, 'active');
  }
});

test('L14.14: owner can fetch their own listing regardless of status (sees the real value)', async () => {
  const owner = await registerAndLogin(`l14-owner-view-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const documentId = created.body.data.documentId;

  for (const real of ['pending', 'rejected', 'active'] as const) {
    await forceStatus(documentId, real);
    const { status, body } = await getListing(owner.jwt, documentId);
    assert.equal(status, 200);
    assert.equal(body.data.status, real);
  }
});

test('L14.14: a stranger (and an unauthenticated caller) gets a plain not-found for a pending/rejected listing, never the content', async () => {
  const owner = await registerAndLogin(`l14-hidden-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`l14-stranger-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const documentId = created.body.data.documentId;

  for (const hidden of ['pending', 'rejected'] as const) {
    await forceStatus(documentId, hidden);

    const asStranger = await getListing(stranger.jwt, documentId);
    assert.equal(asStranger.status, 404);
    assert.equal(asStranger.body?.data, null);

    const anonymous = await getListing(null, documentId);
    assert.equal(anonymous.status, 404);
  }
});

test('L14.14 regression: an active listing is still fetchable by anyone (the new findOne guard does not break the normal path)', async () => {
  const owner = await registerAndLogin(`l14-active-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`l14-active-stranger-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const documentId = created.body.data.documentId;

  const asStranger = await getListing(stranger.jwt, documentId);
  assert.equal(asStranger.status, 200);
  assert.equal(asStranger.body.data.status, 'active');

  const anonymous = await getListing(null, documentId);
  assert.equal(anonymous.status, 200);
});

test('L14.6/L14.7: pending/rejected listings never leak into public discovery', async () => {
  const owner = await registerAndLogin(`l14-discovery-${randomUUID()}@test.local`);
  const tag = `l14disc${randomUUID().slice(0, 8)}`;
  const created = await createListing(owner.jwt, { subType: tag });
  const documentId = created.body.data.documentId;

  await forceStatus(documentId, 'pending');
  const whilePending = await fetch(`${BASE_URL}/listings?subType=${tag}`);
  const pendingBody = await whilePending.json();
  assert.equal((pendingBody.data ?? []).length, 0);

  await forceStatus(documentId, 'rejected');
  const whileRejected = await fetch(`${BASE_URL}/listings?subType=${tag}`);
  const rejectedBody = await whileRejected.json();
  assert.equal((rejectedBody.data ?? []).length, 0);

  await forceStatus(documentId, 'active');
  const whileActive = await fetch(`${BASE_URL}/listings?subType=${tag}`);
  const activeBody = await whileActive.json();
  assert.equal((activeBody.data ?? []).length, 1);
});

test('L14.6/L14.7: the owner\'s own listing-management fetch (raw ownerProfileId filter, no discovery params) still shows a pending/rejected listing', async () => {
  const owner = await registerAndLogin(`l14-mgmt-${randomUUID()}@test.local`);
  const created = await createListing(owner.jwt);
  const documentId = created.body.data.documentId;
  await forceStatus(documentId, 'pending');

  const res = await fetch(
    `${BASE_URL}/listings?filters[ownerProfileId][$eq]=${owner.ownerId}`,
    { headers: authed(owner.jwt) },
  );
  const body = await res.json();
  const found = (body.data ?? []).find((row: any) => row.documentId === documentId);
  assert.ok(found, 'owner-scoped raw-filter fetch must still return their own pending listing');
  assert.equal(found.status, 'pending');
});
