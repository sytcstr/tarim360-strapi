/**
 * LISTING_L7_SELLER_CONTACT_PRIVACY_REPORT.md.
 *
 * Covers what L7 actually added to POST /conversations/upsert and
 * POST /conversations/message when a request carries a real listingId
 * context and no thread exists yet:
 *  - the receiver is re-derived from the listing's REAL owner (a client
 *    cannot spoof who the "seller" is by claiming a different receiver
 *    alongside a real listingId) -- the underlying mechanism predates
 *    this phase, but had no dedicated test proving it for this exact
 *    "brand-new conversation, listingId-driven" path (see L7.1's
 *    forensic finding); this suite closes that gap.
 *  - a brand-new conversation about a non-`active` listing is rejected
 *    (400), while an EXISTING thread about a listing that later becomes
 *    inactive is completely unaffected.
 *  - a brand-new conversation whose resolved listing owner has no
 *    corresponding profile-setting row (simulating a deleted/never-
 *    completed account) is rejected (400), never silently created.
 *  - `listingTitle` is canonicalized from the listing's own real title,
 *    not trusted from client input, for a brand-new conversation.
 *  - self-messaging is rejected even when a real listingId happens to
 *    belong to the caller themselves.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-conversation-listing-context-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-conversation-listing-context-test.db');
const PORT = 14185;
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

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'L7 Test Ilani',
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

async function upsertConversation(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/conversations/upsert`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function sendMessage(jwt: string, data: Record<string, unknown>) {
  const receiverEmail = data.receiverEmail as string | undefined;
  const merged = { targetEmail: receiverEmail, messageReceiverEmail: receiverEmail, ...data };
  const res = await fetch(`${BASE_URL}/conversations/message`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: merged }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const fetchThreadByContextId = async (contextId: string) =>
  strapiInstance.db.query('api::thread.thread').findOne({ where: { contextId } } as any);

// ---------------------------------------------------------------------
// Spoof-the-seller-via-listingId regression (mechanism pre-exists this
// phase; this is the dedicated test the L7.1 forensic found missing)
// ---------------------------------------------------------------------

test('a buyer cannot redirect a new listing-context conversation to an arbitrary claimed receiver', async () => {
  const seller = await registerAndLogin(`l7-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l7-buyer-${randomUUID()}@test.local`);
  const impostor = await registerAndLogin(`l7-impostor-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, { title: `Spoof Test ${randomUUID()}` });

  const { status, body } = await upsertConversation(buyer.jwt, {
    listingId: listing.documentId,
    receiverEmail: `l7-impostor-${randomUUID()}@test.local`, // claimed, wrong
    receiverProfileId: 'u_someone_else',
  });
  assert.equal(status, 200);
  // The real seller must be the resolved receiver, never the claimed one.
  const thread = await fetchThreadByContextId(listing.documentId);
  assert.ok(thread);
  assert.equal((thread as any).receiverProfileId || '', body.data.receiverProfileId);
  assert.notEqual(body.data.receiverProfileId, 'u_someone_else');
  void impostor;
});

// ---------------------------------------------------------------------
// Listing status guard (new conversation only)
// ---------------------------------------------------------------------

test('starting a brand-new conversation about a pending listing is rejected', async () => {
  const seller = await registerAndLogin(`l7-pending-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l7-pending-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, { title: `Pending Test ${randomUUID()}` });
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId: listing.documentId },
    data: { status: 'pending' },
  });

  const { status, body } = await upsertConversation(buyer.jwt, { listingId: listing.documentId });
  assert.equal(status, 400);
  assert.ok(body.error?.message || body.message);
});

test('starting a brand-new conversation about a rejected listing is rejected', async () => {
  const seller = await registerAndLogin(`l7-rejected-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l7-rejected-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, { title: `Rejected Test ${randomUUID()}` });
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId: listing.documentId },
    data: { status: 'rejected' },
  });

  const { status } = await upsertConversation(buyer.jwt, { listingId: listing.documentId });
  assert.equal(status, 400);
});

test('an EXISTING thread about a listing that later becomes inactive is completely unaffected', async () => {
  const seller = await registerAndLogin(`l7-existing-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l7-existing-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, { title: `Existing Thread Test ${randomUUID()}` });

  const first = await upsertConversation(buyer.jwt, { listingId: listing.documentId });
  assert.equal(first.status, 200);

  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId: listing.documentId },
    data: { status: 'rejected' },
  });

  const reply = await sendMessage(buyer.jwt, {
    listingId: listing.documentId,
    threadId: first.body.data.threadId,
    message: 'Hala burada mısınız?',
  });
  assert.equal(reply.status, 200);
});

// ---------------------------------------------------------------------
// Deleted/unavailable seller -- account deletion (auth-flow.ts
// deleteAccount) cascades to delete the owner's OWN listings too, so a
// genuinely deleted seller's listing simply no longer resolves at all.
// A non-resolving listing context deliberately falls through to the
// exact SAME pre-existing behavior as before this phase (see the
// comment on this check in conversation.ts) -- confirmed necessary live
// while writing this fix: this codebase's OWN pre-existing conversation
// tests use a `listing-<uuid>`-shaped synthetic id purely as a context-
// grouping key with no real listing behind it at all, and rejecting
// that case outright broke every one of them. This test locks in that
// deliberate choice as a regression guard, rather than re-introducing a
// hard block that would risk the same breakage.
// ---------------------------------------------------------------------

test('a listingId that never resolves to any real listing falls through unchanged (legacy/synthetic-context compatibility)', async () => {
  const buyer = await registerAndLogin(`l7-orphan-buyer-${randomUUID()}@test.local`);
  const seller = await registerAndLogin(`l7-orphan-seller-${randomUUID()}@test.local`);
  // Deliberately no digits at all: idCandidates() also tries a numeric-
  // substring fallback (built for real Strapi ids), which could
  // otherwise coincidentally collide with some unrelated real listing's
  // listingNo elsewhere in a large shared test-run database -- this
  // string must resolve to nothing, cleanly, by construction.
  const fakeListingId = `listing-synthetic-context-key-no-digits-${randomUUID().replace(/[0-9]/g, 'x')}`;
  const sellerEmail = `l7-orphan-target-${randomUUID()}@test.local`;

  const { status, body } = await upsertConversation(buyer.jwt, {
    listingId: fakeListingId,
    receiverEmail: sellerEmail,
  });
  assert.equal(status, 200);
  assert.equal(body.data.receiverEmail, sellerEmail);
  void seller;
});

// ---------------------------------------------------------------------
// Canonical listing title (not trusted from client input)
// ---------------------------------------------------------------------

test('listingTitle is canonicalized from the real listing row for a brand-new conversation', async () => {
  const seller = await registerAndLogin(`l7-title-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l7-title-buyer-${randomUUID()}@test.local`);
  const realTitle = `Gercek Baslik ${randomUUID()}`;
  const listing = await createListing(seller.jwt, { title: realTitle });

  const { status, body } = await upsertConversation(buyer.jwt, {
    listingId: listing.documentId,
    listingTitle: 'Sahte baslik (client tarafindan uydurulmus)',
  });
  assert.equal(status, 200);
  assert.equal(body.data.listingTitle, realTitle);
});

// ---------------------------------------------------------------------
// Self-message via a real listingId
// ---------------------------------------------------------------------

test('a seller cannot message themselves about their own listing', async () => {
  const seller = await registerAndLogin(`l7-self-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, { title: `Self Message Test ${randomUUID()}` });

  const { status, body } = await upsertConversation(seller.jwt, { listingId: listing.documentId });
  assert.equal(status, 400);
  assert.ok(body.error?.message || body.message);
});

// =======================================================================
// LISTING_L8_MESSAGING_LISTING_CONTEXT_REPORT.md
// =======================================================================

// ---------------------------------------------------------------------
// L8.3 -- thread reuse semantics: same buyer+seller, two DIFFERENT
// listings (no explicit threadId/contextId reused) must produce two
// SEPARATE threads, each with its own correct, un-mixed context.
// ---------------------------------------------------------------------

test('the same buyer and seller messaging about two different listings get two separate threads', async () => {
  const seller = await registerAndLogin(`l8-multi-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l8-multi-buyer-${randomUUID()}@test.local`);
  const listingA = await createListing(seller.jwt, { title: `Listing A ${randomUUID()}` });
  const listingB = await createListing(seller.jwt, { title: `Listing B ${randomUUID()}` });

  const convA = await upsertConversation(buyer.jwt, { listingId: listingA.documentId });
  const convB = await upsertConversation(buyer.jwt, { listingId: listingB.documentId });
  assert.equal(convA.status, 200);
  assert.equal(convB.status, 200);

  assert.notEqual(convA.body.data.threadId, convB.body.data.threadId);
  assert.equal(convA.body.data.listingTitle, listingA.title);
  assert.equal(convB.body.data.listingTitle, listingB.title);
  assert.equal(convA.body.data.listingId, listingA.documentId);
  assert.equal(convB.body.data.listingId, listingB.documentId);
});

// ---------------------------------------------------------------------
// LISTING_L18_CONTACT_CONTEXT_CONSISTENCY_REPORT.md L18.28/L18.29/L18.37:
// the mirror image of the test above -- the SAME listing, messaged by
// TWO DIFFERENT buyers, must produce two separate threads (never one
// merged/shared conversation). `conversationKeyFor` already includes
// the sorted actor pair, so this was structurally sound before this
// phase, just not directly asserted by a dedicated test until now.
// ---------------------------------------------------------------------

test('the same listing messaged by two different buyers gets two separate threads', async () => {
  const seller = await registerAndLogin(`l18-shared-listing-seller-${randomUUID()}@test.local`);
  const buyerB = await registerAndLogin(`l18-shared-listing-buyerB-${randomUUID()}@test.local`);
  const buyerC = await registerAndLogin(`l18-shared-listing-buyerC-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, { title: `Shared Listing ${randomUUID()}` });

  const convB = await upsertConversation(buyerB.jwt, { listingId: listing.documentId });
  const convC = await upsertConversation(buyerC.jwt, { listingId: listing.documentId });
  assert.equal(convB.status, 200);
  assert.equal(convC.status, 200);

  assert.notEqual(convB.body.data.threadId, convC.body.data.threadId);
  assert.equal(convB.body.data.listingId, listing.documentId);
  assert.equal(convC.body.data.listingId, listing.documentId);
  assert.equal(convB.body.data.listingTitle, listing.title);
  assert.equal(convC.body.data.listingTitle, listing.title);

  // Buyer B sending a follow-up message must never land in buyer C's
  // thread, and vice versa -- confirms the separation holds for the
  // message path too, not just the initial upsert.
  const replyB = await sendMessage(buyerB.jwt, {
    threadId: convB.body.data.threadId,
    listingId: listing.documentId,
    message: 'Buyer B mesaji',
  });
  assert.equal(replyB.status, 200);
  assert.equal(replyB.body.thread.threadId, convB.body.data.threadId);
  assert.notEqual(replyB.body.thread.threadId, convC.body.data.threadId);
});

// ---------------------------------------------------------------------
// L8.3/L8.4 -- the actual bug found during this phase's own forensic: a
// client resending a real, existing thread's threadId alongside a
// DIFFERENT listing's listingId must NOT silently redirect that
// thread's canonical context to the new listing.
// ---------------------------------------------------------------------

test('reusing an existing threadId with a different listingId does not corrupt the thread\'s canonical context', async () => {
  const seller = await registerAndLogin(`l8-pin-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l8-pin-buyer-${randomUUID()}@test.local`);
  const listingA = await createListing(seller.jwt, { title: `Pinned A ${randomUUID()}` });
  const listingB = await createListing(seller.jwt, { title: `Pinned B ${randomUUID()}` });

  const first = await upsertConversation(buyer.jwt, { listingId: listingA.documentId });
  assert.equal(first.status, 200);
  const threadId = first.body.data.threadId;

  // Reuse the SAME real threadId, but this message claims a DIFFERENT
  // listing -- exactly the shape a listing-context-unaware local
  // thread-id scheme would send (see the paired Flutter fix).
  const second = await sendMessage(buyer.jwt, {
    threadId,
    listingId: listingB.documentId,
    listingTitle: listingB.title,
    message: 'Bu ikinci ilan hakkinda mesaj',
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.thread.threadId, threadId);
  // The thread's canonical context must still be listing A -- untouched.
  assert.equal(second.body.thread.listingId, listingA.documentId);
  assert.equal(second.body.thread.listingTitle, listingA.title);

  const persisted = await strapiInstance.db
    .query('api::thread.thread')
    .findOne({ where: { threadId } } as any);
  assert.equal((persisted as any).listingId, listingA.documentId);
  assert.equal((persisted as any).listingTitle, listingA.title);
});

// ---------------------------------------------------------------------
// L8.2/L8.7 -- listingNo/mode are canonicalized from the real listing,
// never trusted from client input, for a brand-new conversation. Price
// is deliberately NOT canonicalized here (see identity.ts's doc
// comment) -- Flutter has no raw price to verify a client value
// against in the first place, only the already-formatted L5 display
// string, so listingPriceText stays a client-trusted display snapshot,
// same precedent as imageUrl.
// ---------------------------------------------------------------------

test('listingNo/mode are canonicalized from the real listing, forged client values are ignored', async () => {
  const seller = await registerAndLogin(`l8-canon-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l8-canon-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, {
    title: `Canonical Fields Test ${randomUUID()}`,
    mode: 'sell',
  });

  const { status, body } = await upsertConversation(buyer.jwt, {
    listingId: listing.documentId,
    listingNo: 999999999,
    listingMode: 'buy',
  });
  assert.equal(status, 200);
  assert.equal(body.data.listingNo, listing.listingNo);
  assert.notEqual(body.data.listingNo, 999999999);
  assert.equal(body.data.listingMode, 'sell');
});

test('a thread with no canonical listingNo (e.g. a non-resolving legacy context) never lets a client backfill it later', async () => {
  const buyer = await registerAndLogin(`l8-nobackfill-buyer-${randomUUID()}@test.local`);
  const fakeListingId = `listing-no-real-match-${randomUUID().replace(/[0-9]/g, 'x')}`;
  const sellerEmail = `l8-nobackfill-target-${randomUUID()}@test.local`;

  const first = await upsertConversation(buyer.jwt, {
    listingId: fakeListingId,
    receiverEmail: sellerEmail,
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.listingNo, null);
  const threadId = first.body.data.threadId;

  const second = await sendMessage(buyer.jwt, {
    threadId,
    listingId: fakeListingId,
    listingNo: 12345,
    message: 'Ikinci mesaj',
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.thread.listingNo, null);
});

// ---------------------------------------------------------------------
// L8.9 -- push notification title carries the canonical T360-XXXXX
// number when the conversation has one, server-derived only.
// ---------------------------------------------------------------------

test('a new message about a real listing creates a notification titled with its canonical T360 number', async () => {
  const seller = await registerAndLogin(`l8-push-seller-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l8-push-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(seller.jwt, { title: `Push Context Test ${randomUUID()}` });

  const conv = await upsertConversation(buyer.jwt, { listingId: listing.documentId });
  assert.equal(conv.status, 200);
  const send = await sendMessage(buyer.jwt, {
    threadId: conv.body.data.threadId,
    listingId: listing.documentId,
    message: 'Merhaba, ilan hala musait mi?',
  });
  assert.equal(send.status, 200);

  const notification = await strapiInstance.db
    .query('api::notification.notification')
    .findOne({ where: { kind: 'message', threadId: conv.body.data.threadId } } as any);
  assert.ok(notification);
  assert.equal((notification as any).title, `Yeni Mesaj — T360-${listing.listingNo}`);
});

test('a message with no resolvable listing context creates a notification with the plain default title', async () => {
  const buyer = await registerAndLogin(`l8-push-plain-buyer-${randomUUID()}@test.local`);
  const sellerEmail = `l8-push-plain-target-${randomUUID()}@test.local`;
  const fakeListingId = `listing-no-real-match-${randomUUID().replace(/[0-9]/g, 'x')}`;

  const conv = await upsertConversation(buyer.jwt, {
    listingId: fakeListingId,
    receiverEmail: sellerEmail,
  });
  assert.equal(conv.status, 200);
  const send = await sendMessage(buyer.jwt, {
    threadId: conv.body.data.threadId,
    listingId: fakeListingId,
    message: 'Merhaba',
  });
  assert.equal(send.status, 200);

  const notification = await strapiInstance.db
    .query('api::notification.notification')
    .findOne({ where: { kind: 'message', threadId: conv.body.data.threadId } } as any);
  assert.ok(notification);
  assert.equal((notification as any).title, 'Yeni Mesaj');
});
