/**
 * LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 26 (P0).
 *
 * conversation.ts's own custom `/conversations/message` and
 * `/conversations/upsert` endpoints already reject creating a brand-new
 * message/thread about a pending/rejected listing (see
 * conversation-listing-context.integration.test.ts). Strapi's GENERIC
 * stock-CRUD routes for the exact same content types --
 * `POST /api/messages` (message-ownership.ts) and `POST /api/threads`
 * (thread-ownership.ts) -- sit on the same `message`/`thread` content
 * types and are reachable directly by any authenticated client bypassing
 * `/conversations/*` entirely, but had no equivalent lifecycle check at
 * all: a caller could create a brand-new message/thread referencing a
 * pending/rejected listing through this route even though the app's own
 * primary endpoint correctly refused it. This suite proves that gap is
 * closed, and that legitimate active-listing use through the generic
 * routes (which Flutter's own sendMessage/createThread fall back to on a
 * 404/405 from the primary endpoint -- see strapi_service.dart) still
 * works.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-message-thread-generic-route-lifecycle-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-message-thread-generic-route-lifecycle-test.db');
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

async function registerAndLogin(email: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return json.jwt;
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Madde26 Test Ilani',
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        location: { city: 'Konya' },
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  if (res.status >= 400) {
    throw new Error(`createListing failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
}

const setListingStatus = (documentId: string, status: string) =>
  strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId },
    data: { status },
  });

async function genericCreateMessage(jwt: string | null, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/messages`, {
    method: 'POST',
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function genericCreateThread(jwt: string | null, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/threads`, {
    method: 'POST',
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---------------------------------------------------------------------
// POST /api/messages (message-ownership.ts)
// ---------------------------------------------------------------------

test('generic POST /api/messages on an ACTIVE listing succeeds', async () => {
  const seller = await registerAndLogin(`m26-msg-active-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m26-msg-active-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);

  const { status, body } = await genericCreateMessage(buyer, {
    message: 'aktif ilan hakkinda mesaj',
    listingId: listing.documentId,
  });
  assert.equal(status, 201, JSON.stringify(body));
});

test('generic POST /api/messages on a PENDING listing is rejected', async () => {
  const seller = await registerAndLogin(`m26-msg-pending-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m26-msg-pending-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);
  await setListingStatus(listing.documentId, 'pending');

  const { status, body } = await genericCreateMessage(buyer, {
    message: 'beklemedeki ilana mesaj denemesi',
    listingId: listing.documentId,
  });
  assert.equal(status, 403, JSON.stringify(body));
  assert.ok(body.error?.message);
});

test('generic POST /api/messages on a REJECTED listing is rejected', async () => {
  const seller = await registerAndLogin(`m26-msg-rejected-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m26-msg-rejected-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);
  await setListingStatus(listing.documentId, 'rejected');

  const { status } = await genericCreateMessage(buyer, {
    message: 'reddedilen ilana mesaj denemesi',
    listingId: listing.documentId,
  });
  assert.equal(status, 403);
});

test('generic POST /api/messages: owner cannot message their own listing (receiver unverifiable)', async () => {
  const owner = await registerAndLogin(`m26-msg-self-${randomUUID()}@test.local`);
  const listing = await createListing(owner);

  const { status } = await genericCreateMessage(owner, {
    message: 'kendi ilanima mesaj',
    listingId: listing.documentId,
  });
  assert.equal(status, 403);
});

test('generic POST /api/messages: an unrelated user cannot spoof another participant as receiver on a real listing', async () => {
  const seller = await registerAndLogin(`m26-msg-spoof-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m26-msg-spoof-buyer-${randomUUID()}@test.local`);
  const impostorEmail = `m26-msg-spoof-impostor-${randomUUID()}@test.local`;
  const listing = await createListing(seller);

  const { status, body } = await genericCreateMessage(buyer, {
    message: 'satici yerine baskasini alici gostermeyi deniyorum',
    listingId: listing.documentId,
    receiverEmail: impostorEmail,
    receiverProfileId: 'u_impostor',
  });
  assert.equal(status, 201, JSON.stringify(body));
  assert.notEqual(body.data.receiverEmail, impostorEmail.toLowerCase());
});

// ---------------------------------------------------------------------
// POST /api/threads (thread-ownership.ts). `conversationKey` is a
// required field on this content type -- conversation.ts's own custom
// controller computes it (normalizeThreadData), but the generic stock
// create route has no such logic, so a raw caller must supply one
// itself. Unrelated to the Madde 26 fix; just what a well-formed raw
// request to this route needs to pass basic schema validation.
// ---------------------------------------------------------------------

test('generic POST /api/threads on an ACTIVE listing succeeds', async () => {
  const seller = await registerAndLogin(`m26-thr-active-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m26-thr-active-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);

  const { status, body } = await genericCreateThread(buyer, {
    listingId: listing.documentId,
    lastMessage: 'merhaba',
    conversationKey: `m26-key-${randomUUID()}`,
  });
  assert.equal(status, 201, JSON.stringify(body));
});

test('generic POST /api/threads on a PENDING listing is rejected', async () => {
  const seller = await registerAndLogin(`m26-thr-pending-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m26-thr-pending-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);
  await setListingStatus(listing.documentId, 'pending');

  const { status, body } = await genericCreateThread(buyer, {
    listingId: listing.documentId,
    lastMessage: 'beklemedeki ilan icin sohbet denemesi',
    conversationKey: `m26-key-${randomUUID()}`,
  });
  assert.equal(status, 403, JSON.stringify(body));
});

test('generic POST /api/threads on a REJECTED listing is rejected', async () => {
  const seller = await registerAndLogin(`m26-thr-rejected-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`m26-thr-rejected-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller);
  await setListingStatus(listing.documentId, 'rejected');

  const { status, body } = await genericCreateThread(buyer, {
    listingId: listing.documentId,
    lastMessage: 'reddedilen ilan icin sohbet denemesi',
    conversationKey: `m26-key-${randomUUID()}`,
  });
  assert.equal(status, 403, JSON.stringify(body));
});
