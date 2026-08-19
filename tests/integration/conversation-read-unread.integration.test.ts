/**
 * MESSAGING M2 (MESSAGING_RELEASE_FORENSIC_AUDIT.md,
 * MESSAGING_M2_READ_UNREAD_FIX_REPORT.md) -- read/seen state and unread
 * counts used to be non-functional end to end: `thread.unreadCount` was
 * never incremented on send and was reset to 0 on every `markRead` call
 * regardless of who called it, and `markRead` itself stamped `readAt`/
 * `readBy` on EVERY message in a thread -- including the caller's own
 * outgoing messages (BUG-M6) -- which would have made the double-tick UI
 * lie the moment either participant opened the thread once.
 *
 * This suite proves: unread count is computed correctly and per-viewer
 * (GET /conversations/mine and /conversations/messages/mine), markRead
 * only touches the OTHER participant's messages and is idempotent,
 * unread counts across unrelated threads never interact, and a
 * non-participant can neither read nor mark-read a thread they're not
 * in.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-conversation-read-unread-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-conversation-read-unread-test.db');
const PORT = 14170;
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

async function sendMessage(jwt: string, data: Record<string, unknown>) {
  const receiverEmail = data.receiverEmail as string | undefined;
  const merged = {
    targetEmail: receiverEmail,
    messageReceiverEmail: receiverEmail,
    ...data,
  };
  const res = await fetch(`${BASE_URL}/conversations/message`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: merged }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function mine(jwt: string) {
  const res = await fetch(`${BASE_URL}/conversations/mine`, { headers: authed(jwt) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function myMessages(jwt: string) {
  const res = await fetch(`${BASE_URL}/conversations/messages/mine`, { headers: authed(jwt) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function markRead(jwt: string | null, threadId: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/conversations/${threadId}/read`, {
    method: 'PATCH',
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
    body: JSON.stringify(extra),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const unreadForThread = (mineBody: any, threadId: string): number | undefined =>
  (mineBody.data as any[]).find((t) => t.threadId === threadId)?.unreadCount;

test('a fresh message is unread for the receiver, and does not count against the sender', async () => {
  const aEmail = `m2-a-${randomUUID()}@test.local`;
  const bEmail = `m2-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const sent = await sendMessage(aJwt, { message: 'merhaba', listingId: contextId, receiverEmail: bEmail });
  assert.equal(sent.status, 200);
  const threadId = sent.body.thread.threadId;

  const bMine = await mine(bJwt);
  assert.equal(unreadForThread(bMine.body, threadId), 1, 'the receiver must see exactly 1 unread message');

  const aMine = await mine(aJwt);
  assert.equal(unreadForThread(aMine.body, threadId), 0, 'the sender must never see their own message as unread');
});

test('a second unread message brings the count to 2', async () => {
  const aEmail = `m2-two-a-${randomUUID()}@test.local`;
  const bEmail = `m2-two-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const first = await sendMessage(aJwt, { message: 'bir', listingId: contextId, receiverEmail: bEmail });
  const threadId = first.body.thread.threadId;
  await sendMessage(aJwt, { message: 'iki', threadId, listingId: contextId, receiverEmail: bEmail });

  const bMine = await mine(bJwt);
  assert.equal(unreadForThread(bMine.body, threadId), 2);
});

test('markRead zeroes the unread count for the reader and stamps readAt on the unread messages', async () => {
  const aEmail = `m2-read-a-${randomUUID()}@test.local`;
  const bEmail = `m2-read-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const first = await sendMessage(aJwt, { message: 'bir', listingId: contextId, receiverEmail: bEmail });
  const threadId = first.body.thread.threadId;
  await sendMessage(aJwt, { message: 'iki', threadId, listingId: contextId, receiverEmail: bEmail });

  const read = await markRead(bJwt, threadId);
  assert.equal(read.status, 200);
  assert.ok(read.body.data.readAt);

  const bMine = await mine(bJwt);
  assert.equal(unreadForThread(bMine.body, threadId), 0, 'unread must drop to 0 after markRead');

  const bMessages = await myMessages(bJwt);
  const threadMessages = (bMessages.body.data as any[]).filter((m) => m.threadId === threadId);
  assert.equal(threadMessages.length, 2);
  assert.ok(
    threadMessages.every((m) => !!m.readAt),
    'both of A\'s messages must now carry a real readAt',
  );
});

test('repeated markRead is idempotent: still 200, still 0 unread, no error', async () => {
  const aEmail = `m2-idem-a-${randomUUID()}@test.local`;
  const bEmail = `m2-idem-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const sent = await sendMessage(aJwt, { message: 'merhaba', listingId: contextId, receiverEmail: bEmail });
  const threadId = sent.body.thread.threadId;

  const first = await markRead(bJwt, threadId);
  assert.equal(first.status, 200);
  const second = await markRead(bJwt, threadId);
  assert.equal(second.status, 200);

  const bMine = await mine(bJwt);
  assert.equal(unreadForThread(bMine.body, threadId), 0);
});

test('markRead never mutates the caller\'s own outgoing messages (BUG-M6)', async () => {
  const aEmail = `m2-own-a-${randomUUID()}@test.local`;
  const bEmail = `m2-own-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const fromA = await sendMessage(aJwt, { message: 'A den B ye', listingId: contextId, receiverEmail: bEmail });
  const threadId = fromA.body.thread.threadId;
  await sendMessage(bJwt, { message: 'B den A ya cevap', threadId, listingId: contextId, receiverEmail: aEmail });

  // B opens the thread and marks it read -- only A's message (incoming to B) should gain a readAt.
  await markRead(bJwt, threadId);

  const bMessages = (await myMessages(bJwt)).body.data as any[];
  const threadMessages = bMessages.filter((m) => m.threadId === threadId);
  const fromAMsg = threadMessages.find((m) => (m.senderEmail || '').toLowerCase() === aEmail.toLowerCase());
  const fromBMsg = threadMessages.find((m) => (m.senderEmail || '').toLowerCase() === bEmail.toLowerCase());
  assert.ok(fromAMsg?.readAt, 'the incoming message (from A) must be marked read');
  assert.ok(!fromBMsg?.readAt, 'B\'s own outgoing message must NOT be mutated by B\'s own markRead call');
});

test('a non-participant cannot read or mark-read a thread they are not in', async () => {
  const aEmail = `m2-nonpart-a-${randomUUID()}@test.local`;
  const bEmail = `m2-nonpart-b-${randomUUID()}@test.local`;
  const cEmail = `m2-nonpart-c-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const cJwt = await registerAndLogin(cEmail);
  const contextId = `listing-${randomUUID()}`;

  const sent = await sendMessage(aJwt, { message: 'gizli sohbet', listingId: contextId, receiverEmail: bEmail });
  const threadId = sent.body.thread.threadId;

  const read = await markRead(cJwt, threadId);
  assert.equal(read.status, 403, 'a non-participant must not be able to mark another pair\'s thread as read');

  const cMine = await mine(cJwt);
  assert.equal(
    unreadForThread(cMine.body, threadId),
    undefined,
    'a non-participant must not even see this thread in their own list',
  );
});

test('unauthenticated markRead is rejected', async () => {
  const aEmail = `m2-anon-a-${randomUUID()}@test.local`;
  const bEmail = `m2-anon-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const sent = await sendMessage(aJwt, { message: 'merhaba', listingId: contextId, receiverEmail: bEmail });
  const threadId = sent.body.thread.threadId;

  const read = await markRead(null, threadId);
  assert.equal(read.status, 403);
});

test('a client-supplied readBy/actor override in the request body has no effect -- identity is server-derived', async () => {
  const aEmail = `m2-spoof-a-${randomUUID()}@test.local`;
  const bEmail = `m2-spoof-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const sent = await sendMessage(aJwt, { message: 'merhaba', listingId: contextId, receiverEmail: bEmail });
  const threadId = sent.body.thread.threadId;

  const read = await markRead(bJwt, threadId, {
    readBy: { 'profile:u_someone_else': '2020-01-01T00:00:00.000Z' },
    actorKey: 'profile:u_someone_else',
  });
  assert.equal(read.status, 200);

  const row = await strapiInstance.db.query('api::thread.thread').findOne({ where: { threadId } } as any);
  const receipts = row.readReceipts || {};
  const keys = Object.keys(receipts);
  assert.equal(keys.length, 1, 'exactly one real actor key must be recorded');
  assert.notEqual(keys[0], 'profile:u_someone_else', 'the client-supplied actor key must never be trusted');
});

test('unread counts for unrelated threads never interact', async () => {
  const aEmail = `m2-iso-a-${randomUUID()}@test.local`;
  const bEmail = `m2-iso-b-${randomUUID()}@test.local`;
  const cEmail = `m2-iso-c-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const cJwt = await registerAndLogin(cEmail);

  const contextAB = `listing-${randomUUID()}`;
  const contextAC = `listing-${randomUUID()}`;

  const ab = await sendMessage(aJwt, { message: 'A-B', listingId: contextAB, receiverEmail: bEmail });
  const ac = await sendMessage(aJwt, { message: 'A-C', listingId: contextAC, receiverEmail: cEmail });
  const threadAB = ab.body.thread.threadId;
  const threadAC = ac.body.thread.threadId;

  await markRead(bJwt, threadAB);

  const aMine = await mine(aJwt);
  assert.equal(unreadForThread(aMine.body, threadAB), 0);
  assert.equal(unreadForThread(aMine.body, threadAC), 0, 'A never has unread on their own sent messages');

  const cMine = await mine(cJwt);
  assert.equal(unreadForThread(cMine.body, threadAC), 1, 'reading the A-B thread must not affect the unrelated A-C thread');
});

test('read state survives a fresh fetch (simulates app restart / refetch)', async () => {
  const aEmail = `m2-restart-a-${randomUUID()}@test.local`;
  const bEmail = `m2-restart-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  const bJwt = await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const sent = await sendMessage(aJwt, { message: 'merhaba', listingId: contextId, receiverEmail: bEmail });
  const threadId = sent.body.thread.threadId;
  await markRead(bJwt, threadId);

  // A second, independent fetch (no shared client-side cache) must show the same, persisted state.
  const refetched = await mine(bJwt);
  assert.equal(unreadForThread(refetched.body, threadId), 0);
  const refetchedMessages = (await myMessages(bJwt)).body.data as any[];
  const msg = refetchedMessages.find((m) => m.threadId === threadId);
  assert.ok(msg?.readAt, 'readAt must be persisted, not just an in-memory response artifact');
});
