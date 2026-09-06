/**
 * MESSAGING M1/M5 (MESSAGING_RELEASE_FORENSIC_AUDIT.md,
 * MESSAGING_M1_M3_CORE_FIX_REPORT.md) — POST /conversations/message and
 * POST /conversations/upsert used to trust client-supplied senderEmail/
 * senderProfileId over the real, JWT-authenticated identity, letting any
 * authenticated user record a message as if a DIFFERENT real user sent
 * it. A second, related gap: authorization was computed from participant
 * fields in the CLIENT PAYLOAD rather than an already-existing thread's
 * own stored participants, letting a caller "hijack" (overwrite the
 * participants of) a real thread between two other users by supplying
 * its threadId plus a self-consistent, fabricated requester/receiver
 * pair. This suite proves both are closed, that a real participant's
 * normal send flow is untouched, and that concurrent first-message
 * creation between the same pair does not 500 or produce a duplicate
 * thread (M5).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-conversation-messaging-security-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-conversation-messaging-security-test.db');
const PORT = 14169;
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

async function sendMessage(jwt: string | null, data: Record<string, unknown>) {
  // message.targetEmail/messageReceiverEmail are real (email-typed) schema
  // fields the actual Flutter client always sends alongside receiverEmail
  // (see messages_store.dart's _syncOutgoingMessageToStrapi) -- mirrored
  // here so these tests exercise the same payload shape production does.
  const receiverEmail = data.receiverEmail as string | undefined;
  const merged = {
    targetEmail: receiverEmail,
    messageReceiverEmail: receiverEmail,
    ...data,
  };
  const res = await fetch(`${BASE_URL}/conversations/message`, {
    method: 'POST',
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
    body: JSON.stringify({ data: merged }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const fetchThreadByContextId = async (contextId: string) =>
  strapiInstance.db.query('api::thread.thread').findOne({ where: { contextId } } as any);

test('send success: an authenticated user sends a message and the DB row records their real identity', async () => {
  const aEmail = `m1-a-${randomUUID()}@test.local`;
  const bEmail = `m1-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const { status, body } = await sendMessage(aJwt, {
    message: 'merhaba',
    listingId: contextId,
    receiverEmail: bEmail,
  });

  assert.equal(status, 200);
  assert.equal(body.data.senderEmail, aEmail.toLowerCase());
  assert.equal(body.data.requesterEmail, aEmail.toLowerCase());
  assert.equal(body.data.receiverEmail, bEmail.toLowerCase());
});

test('spoof prevention: A submits senderEmail=B, backend still records A as the real sender', async () => {
  const aEmail = `m1-spoof-a-${randomUUID()}@test.local`;
  const bEmail = `m1-spoof-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const { status, body } = await sendMessage(aJwt, {
    message: 'ben aslinda B gibi davraniyorum',
    listingId: contextId,
    senderEmail: bEmail,
    senderProfileId: 'u_should_be_ignored',
    senderName: 'Sahte Isim',
    receiverEmail: bEmail,
  });

  assert.equal(status, 200);
  assert.equal(body.data.senderEmail, aEmail.toLowerCase(), 'sender must always be the real authenticated user');
  assert.notEqual(body.data.senderEmail, bEmail.toLowerCase());

  const row = await fetchThreadByContextId(contextId);
  assert.equal(row.lastSenderEmail, aEmail.toLowerCase(), 'thread.lastSenderEmail must also reflect the real sender, not a spoofed one');
});

// LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 21 (P0): requesterEmail/
// requesterProfileId used to be trusted outright whenever the client
// sent ANY non-empty value -- only defaulted to the real authenticated
// user when BOTH fields were empty. An authenticated attacker could
// submit a real third party's email as requesterEmail while claiming
// receiverEmail=themselves, which defeated the self-message check
// (different emails -> not "same person") and created a thread carrying
// the victim's real email as its requester -- appearing in the victim's
// OWN `GET /conversations/mine` list (that endpoint's userFilter matches
// on requesterEmail/receiverEmail) despite the victim never having sent
// or received anything.
test('requester spoof prevention: A submits requesterEmail=B (a real user), backend still records A as the real requester -- no ghost thread in B\'s inbox', async () => {
  const aEmail = `m1-reqspoof-a-${randomUUID()}@test.local`;
  const bEmail = `m1-reqspoof-b-${randomUUID()}@test.local`;
  const cEmail = `m1-reqspoof-c-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  await registerAndLogin(cEmail);
  const contextId = `listing-${randomUUID()}`;

  const { status, body } = await sendMessage(aJwt, {
    message: 'C ye mesaj atarken B gibi davranmayi deniyorum',
    listingId: contextId,
    requesterEmail: bEmail,
    receiverEmail: cEmail,
  });

  // The request itself is still accepted (A is genuinely messaging
  // about a context) -- what must never happen is B's real identity
  // ending up as this thread's requester.
  assert.equal(status, 200);
  assert.equal(
    body.data.requesterEmail,
    aEmail.toLowerCase(),
    'requester must always be the real authenticated caller, never a client-supplied claim',
  );
  assert.notEqual(body.data.requesterEmail, bEmail.toLowerCase());

  const row = await fetchThreadByContextId(contextId);
  assert.notEqual(
    row.requesterEmail,
    bEmail.toLowerCase(),
    'B must never have a ghost thread recorded with their real email as requester',
  );
});

test('requester spoof prevention: A submits requesterProfileId belonging to a real user B, backend still records A as the real requester', async () => {
  const aEmail = `m1-reqspoof2-a-${randomUUID()}@test.local`;
  const bEmail = `m1-reqspoof2-b-${randomUUID()}@test.local`;
  const cEmail = `m1-reqspoof2-c-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  await registerAndLogin(cEmail);
  const contextId = `listing-${randomUUID()}`;
  const bProfileId = `u_${bEmail.replace(/[^a-z0-9]/g, '_')}`;

  const { status, body } = await sendMessage(aJwt, {
    message: 'sahte requesterProfileId denemesi',
    listingId: contextId,
    requesterProfileId: bProfileId,
    receiverEmail: cEmail,
  });

  assert.equal(status, 200);
  assert.equal(body.data.requesterEmail, aEmail.toLowerCase());
  assert.notEqual(body.data.requesterProfileId, bProfileId);
});

test('requester spoof cannot be used to defeat self-message protection', async () => {
  const aEmail = `m1-reqspoof-self-${randomUUID()}@test.local`;
  const victimEmail = `m1-reqspoof-victim-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(victimEmail);
  const contextId = `listing-${randomUUID()}`;

  const { status, body } = await sendMessage(aJwt, {
    message: 'kendime sahte requester ile mesaj atmayi deniyorum',
    listingId: contextId,
    requesterEmail: victimEmail,
    receiverEmail: aEmail,
  });

  // Before the fix this would succeed (200): isSamePerson(requester=victim,
  // receiver=A) is false, so the self-message guard never fired. After
  // the fix, requester is forced back to A regardless of the client's
  // claim, so requester === receiver === A and self-message is correctly
  // rejected.
  assert.equal(status, 400);
  assert.match(body.error?.message ?? '', /kendisine mesaj/i);
});

test('valid A-to-seller flow still works after the requester-identity fix (regression)', async () => {
  const buyerEmail = `m1-reqfix-buyer-${randomUUID()}@test.local`;
  const sellerEmail = `m1-reqfix-seller-${randomUUID()}@test.local`;
  const buyerJwt = await registerAndLogin(buyerEmail);
  await registerAndLogin(sellerEmail);
  const contextId = `listing-${randomUUID()}`;

  const { status, body } = await sendMessage(buyerJwt, {
    message: 'satici ile normal akis',
    listingId: contextId,
    receiverEmail: sellerEmail,
  });

  assert.equal(status, 200);
  assert.equal(body.data.requesterEmail, buyerEmail.toLowerCase());
  assert.equal(body.data.receiverEmail, sellerEmail.toLowerCase());
});

test('participant authorization: a non-participant cannot hijack an existing thread by supplying its threadId', async () => {
  const bEmail = `m1-hijack-b-${randomUUID()}@test.local`;
  const cEmail = `m1-hijack-c-${randomUUID()}@test.local`;
  const attackerEmail = `m1-hijack-attacker-${randomUUID()}@test.local`;
  const bJwt = await registerAndLogin(bEmail);
  await registerAndLogin(cEmail);
  const attackerJwt = await registerAndLogin(attackerEmail);
  const contextId = `listing-${randomUUID()}`;

  const real = await sendMessage(bJwt, {
    message: 'B den C ye ilk mesaj',
    listingId: contextId,
    receiverEmail: cEmail,
  });
  assert.equal(real.status, 200);
  const realThreadId = real.body.thread.threadId;

  const hijack = await sendMessage(attackerJwt, {
    message: 'saldirgan mesaji',
    threadId: realThreadId,
    requesterEmail: attackerEmail,
    receiverEmail: 'someone-else@test.local',
  });
  assert.equal(hijack.status, 403, 'a non-participant must never be able to act on a real thread by guessing/reusing its threadId');

  const row = await fetchThreadByContextId(contextId);
  assert.equal(row.requesterEmail, bEmail.toLowerCase(), 'the real thread\'s participants must be untouched by the rejected hijack attempt');
  assert.equal(row.receiverEmail, cEmail.toLowerCase());
  assert.notEqual(row.lastSenderEmail, attackerEmail.toLowerCase());
});

test('unauthenticated send is rejected, never silently recorded', async () => {
  // Strapi's own auth middleware rejects a missing/invalid token with 403
  // before this route's handler ever runs (the same convention every
  // other authenticated route in this codebase relies on -- confirmed
  // against the rest of this test suite, none of which expect a bare 401
  // for a missing token). Either way, the key property this test proves
  // is "rejected, not silently recorded" -- the exact status code is a
  // Strapi framework convention, not a per-route decision.
  const { status } = await sendMessage(null, {
    message: 'kimliksiz mesaj',
    listingId: `listing-${randomUUID()}`,
    receiverEmail: 'someone@test.local',
  });
  assert.equal(status, 403);
});

test('a genuine participant can reply on the real thread (regression: fix does not block legitimate use)', async () => {
  const bEmail = `m1-reply-b-${randomUUID()}@test.local`;
  const cEmail = `m1-reply-c-${randomUUID()}@test.local`;
  const bJwt = await registerAndLogin(bEmail);
  const cJwt = await registerAndLogin(cEmail);
  const contextId = `listing-${randomUUID()}`;

  const first = await sendMessage(bJwt, {
    message: 'ilk mesaj',
    listingId: contextId,
    receiverEmail: cEmail,
  });
  assert.equal(first.status, 200);
  const threadId = first.body.thread.threadId;

  const reply = await sendMessage(cJwt, {
    message: 'cevap',
    threadId,
    listingId: contextId,
    receiverEmail: bEmail,
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.senderEmail, cEmail.toLowerCase());
  assert.equal(reply.body.thread.threadId, threadId, 'the reply must land on the SAME thread, not a new one');
});

test('M5: two concurrent first-messages between the same new pair produce exactly one thread, neither request 500s', async () => {
  const aEmail = `m5-a-${randomUUID()}@test.local`;
  const bEmail = `m5-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const [first, second] = await Promise.all([
    sendMessage(aJwt, { message: 'race mesaj 1', listingId: contextId, receiverEmail: bEmail }),
    sendMessage(aJwt, { message: 'race mesaj 2', listingId: contextId, receiverEmail: bEmail }),
  ]);

  assert.equal(first.status, 200, 'first concurrent request must not 500');
  assert.equal(second.status, 200, 'second concurrent request must not 500 -- a losing race must resolve to the existing thread, not an error');
  assert.equal(first.body.thread.threadId, second.body.thread.threadId, 'both concurrent sends must resolve to the SAME thread');

  const threads = await strapiInstance.db.query('api::thread.thread').findMany({ where: { contextId } } as any);
  assert.equal(threads.length, 1, 'exactly one thread must exist for this pair/context, no duplicate');

  const messages = await strapiInstance.db.query('api::message.message').findMany({ where: { contextId } } as any);
  assert.equal(messages.length, 2, 'both messages must have been recorded, on the single shared thread');
});
