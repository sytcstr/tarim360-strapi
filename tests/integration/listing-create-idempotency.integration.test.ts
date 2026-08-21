/**
 * PRE_UAT_F1_TARGETED_FUNCTIONAL_FIX_REPORT.md F1.6.
 *
 * createListing() had no idempotency key at all: if a create request
 * actually reached and was processed by the server but the client timed
 * out waiting for the response (a realistic scenario on the flaky rural
 * connections this app's actual users have), the client believed the
 * submit failed, queued a brand-new local-only id for offline retry, and
 * that retry (via engagement.ts's syncOfflineListing) had no way to
 * recognize the already-created row -- producing a genuine duplicate
 * listing.
 *
 * Fixed with the same atomic-claim ledger pattern already proven by
 * listing.activateRocket: `listing` has draftAndPublish:true, which makes
 * storing operationId directly on the listing row itself unsafe, so a
 * separate listing-create-operation content-type claims the operationId
 * first (its unique constraint is what actually serializes concurrent
 * identical requests), and only a request that wins that claim goes on to
 * create the real listing.
 *
 * This suite proves: a retry with the same operationId + same payload
 * returns the already-created listing instead of creating a new one; the
 * same operationId with a different payload is rejected as a conflict; a
 * genuinely different operationId creates a genuinely new listing;
 * concurrent identical requests never produce more than one real listing;
 * and the offline-sync retry path (syncOfflineListing) recognizes an
 * already-created listing by the same operationId instead of duplicating
 * it.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-create-idempotency-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-create-idempotency-test.db');
const PORT = 14178;
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

function listingPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: 'F1.6 Test Ilani',
    mainType: 'bitkisel',
    mode: 'sell',
    price: 100,
    location: 'Konya',
    ...overrides,
  };
}

async function createListing(jwt: string, operationId: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { ...listingPayload(overrides), operationId } }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

// `listing` has draftAndPublish:true -- every real create leaves TWO
// physical rows sharing one documentId (a draft, publishedAt:null, and
// the published row callers actually mean), so counting "real listings"
// must filter to the published row only, exactly like this codebase's
// own findListingByAnyId (listing-metrics.ts) does for the same reason.
async function countListingsByTitle(title: string): Promise<number> {
  const rows = await strapiInstance.db.query('api::listing.listing').findMany({
    where: { title, publishedAt: { $notNull: true } },
  } as any);
  return Array.isArray(rows) ? rows.length : 0;
}

test('missing operationId is rejected', async () => {
  const user = await registerAndLogin(`f16-missing-op-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({ data: listingPayload() }),
  });
  assert.equal(res.status, 400);
});

test('invalid (non-UUID) operationId is rejected', async () => {
  const user = await registerAndLogin(`f16-invalid-op-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({ data: { ...listingPayload(), operationId: 'not-a-uuid' } }),
  });
  assert.equal(res.status, 400);
});

test('a fresh operationId creates a real listing', async () => {
  const user = await registerAndLogin(`f16-fresh-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `F1.6 Fresh ${randomUUID()}`;
  const res = await createListing(user.jwt, opId, { title });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.title, title);
  assert.equal(await countListingsByTitle(title), 1);
});

test('retrying with the SAME operationId + SAME payload returns the already-created listing, no duplicate', async () => {
  const user = await registerAndLogin(`f16-retry-same-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `F1.6 Retry Same ${randomUUID()}`;

  const first = await createListing(user.jwt, opId, { title });
  assert.equal(first.status, 201);
  const firstId = first.body.data.documentId ?? first.body.data.id;

  const retry = await createListing(user.jwt, opId, { title });
  assert.equal(retry.status, 200, 'a duplicate submission must not return 201 again');
  const retryId = retry.body.data.documentId ?? retry.body.data.id;
  assert.equal(retryId, firstId, 'the retry must resolve to the SAME listing, not a new one');
  assert.equal(await countListingsByTitle(title), 1, 'no duplicate listing may exist');
});

test('the SAME operationId with a DIFFERENT payload is rejected as a conflict', async () => {
  const user = await registerAndLogin(`f16-conflict-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `F1.6 Conflict ${randomUUID()}`;

  const first = await createListing(user.jwt, opId, { title });
  assert.equal(first.status, 201);

  const conflicting = await createListing(user.jwt, opId, { title: `${title} DIFFERENT` });
  assert.equal(conflicting.status, 409);
  assert.equal(await countListingsByTitle(title), 1);
  assert.equal(await countListingsByTitle(`${title} DIFFERENT`), 0);
});

test('a genuinely different operationId creates a genuinely different listing, even with identical content', async () => {
  const user = await registerAndLogin(`f16-different-op-${randomUUID()}@test.local`);
  const title = `F1.6 Different Op ${randomUUID()}`;

  const first = await createListing(user.jwt, randomUUID(), { title });
  assert.equal(first.status, 201);
  const second = await createListing(user.jwt, randomUUID(), { title });
  assert.equal(second.status, 201);

  const firstId = first.body.data.documentId ?? first.body.data.id;
  const secondId = second.body.data.documentId ?? second.body.data.id;
  assert.notEqual(firstId, secondId);
  assert.equal(await countListingsByTitle(title), 2, 'two genuinely separate submissions are two real listings');
});

test('concurrency: N simultaneous requests with the SAME operationId produce exactly ONE real listing', async () => {
  const user = await registerAndLogin(`f16-concurrent-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `F1.6 Concurrent ${randomUUID()}`;

  const results = await Promise.all(
    Array.from({ length: 5 }, () => createListing(user.jwt, opId, { title })),
  );

  for (const r of results) {
    assert.ok(
      r.status === 200 || r.status === 201,
      `every concurrent attempt with the same operationId+payload must succeed (200 or 201), got ${r.status}`,
    );
  }
  const ids = new Set(results.map((r) => r.body.data.documentId ?? r.body.data.id));
  assert.equal(ids.size, 1, 'all concurrent responses must resolve to the SAME single listing');
  assert.equal(await countListingsByTitle(title), 1, 'exactly one real listing must exist despite 5 concurrent submissions');
});

test('offline-sync retry (syncOfflineListing, operation:create) with the SAME operationId as an already-succeeded create does not duplicate it', async () => {
  const user = await registerAndLogin(`f16-offline-retry-${randomUUID()}@test.local`);
  const opId = randomUUID();
  const title = `F1.6 Offline Retry ${randomUUID()}`;

  // Simulates the real bug scenario: the initial POST /listings actually
  // succeeded server-side, but the client never saw the response and
  // believes it needs to retry via the offline-sync queue.
  const first = await createListing(user.jwt, opId, { title });
  assert.equal(first.status, 201);
  const realId = first.body.data.documentId ?? first.body.data.id;

  const retryRes = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      data: {
        operation: 'create',
        listing: {
          id: `l_${Date.now()}`, // the client's own new local-only id -- must NOT be used to look anything up
          operationId: opId,
          ...listingPayload({ title }),
        },
      },
    }),
  });
  assert.equal(retryRes.status, 200);
  const retryJson = await retryRes.json();
  assert.equal(retryJson.data.idempotent, true, 'must be recognized as the already-created listing, not a fresh create');
  const retryId = retryJson.data.listing?.documentId ?? retryJson.data.listing?.id;
  assert.equal(retryId, realId);
  assert.equal(await countListingsByTitle(title), 1, 'the offline-retry path must never create a second, duplicate listing');
});

test('offline-sync retry with no matching operationId still creates normally (genuine first-time offline create)', async () => {
  const user = await registerAndLogin(`f16-offline-fresh-${randomUUID()}@test.local`);
  const title = `F1.6 Offline Fresh ${randomUUID()}`;

  const res = await fetch(`${BASE_URL}/offline-sync/listings`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      data: {
        operation: 'create',
        listing: {
          id: `l_${Date.now()}`,
          operationId: randomUUID(),
          ...listingPayload({ title }),
        },
      },
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.notEqual(json.data.idempotent, true);
  assert.equal(await countListingsByTitle(title), 1);
});
