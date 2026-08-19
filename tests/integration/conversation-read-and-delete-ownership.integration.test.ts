/**
 * PERMISSION_GAP_S5A — conversation.markRead + conversation.deleteByThreadId
 * permission-gap fixes.
 *
 * Root cause (PERMISSION_GAP_RELEASE_AUDIT.md, PERM-N4 / PERM-N5=BUG-M7):
 * `PATCH /conversations/:threadId/read` and `DELETE /conversations/:threadId`
 * both use `auth: { scope: [] }`, but neither
 * `api::conversation.conversation.markRead` nor
 * `api::conversation.conversation.deleteByThreadId` was ever added to
 * src/index.ts's `authenticatedActions` bootstrap array -- every call
 * 403'd at the Strapi policy layer before reaching the controller. Both
 * handlers already enforce participant-only access at the query level
 * (`userFilter(user)` baked directly into the thread lookup, so a
 * non-participant's query simply returns no row) -- only the permission
 * grant was missing. This suite proves the routes are now reachable AND
 * that the pre-existing participant-only enforcement still holds.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-conversation-read-delete-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-conversation-read-delete-test.db');
const PORT = 14168;
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

async function openThread(requesterJwt: string, receiverEmail: string, listingId: string) {
  const res = await fetch(`${BASE_URL}/conversations/upsert`, {
    method: 'POST',
    headers: authed(requesterJwt),
    body: JSON.stringify({ data: { receiverEmail, listingId, message: 'Merhaba' } }),
  });
  assert.equal(res.status, 200, 'thread setup via /conversations/upsert must succeed');
  const body = await res.json();
  return body.data.threadId as string;
}

test('a participant (requester) can mark their own thread read -> 200, unreadCount resets', async () => {
  const requester = await registerAndLogin(`conv-req-${randomUUID()}@test.local`);
  const receiver = await registerAndLogin(`conv-recv-${randomUUID()}@test.local`);
  const threadId = await openThread(requester.jwt, receiver.email, `listing_${randomUUID()}`);

  const res = await fetch(`${BASE_URL}/conversations/${threadId}/read`, {
    method: 'PATCH',
    headers: authed(requester.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, 'permission gap must be closed: participant should reach the controller and succeed');
  const body = await res.json();
  assert.equal(body.data.ok, true);
  assert.equal(body.data.thread.unreadCount, 0);
});

test('the other participant (receiver) can also mark the same thread read -> 200', async () => {
  const requester = await registerAndLogin(`conv-req2-${randomUUID()}@test.local`);
  const receiver = await registerAndLogin(`conv-recv2-${randomUUID()}@test.local`);
  const threadId = await openThread(requester.jwt, receiver.email, `listing_${randomUUID()}`);

  const res = await fetch(`${BASE_URL}/conversations/${threadId}/read`, {
    method: 'PATCH',
    headers: authed(receiver.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
});

test('a non-participant cannot mark someone else\'s thread read -> 403', async () => {
  const requester = await registerAndLogin(`conv-req3-${randomUUID()}@test.local`);
  const receiver = await registerAndLogin(`conv-recv3-${randomUUID()}@test.local`);
  const threadId = await openThread(requester.jwt, receiver.email, `listing_${randomUUID()}`);

  const stranger = await registerAndLogin(`conv-stranger3-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/conversations/${threadId}/read`, {
    method: 'PATCH',
    headers: authed(stranger.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});

test('an unauthenticated caller is rejected on markRead', async () => {
  // 403, not 401: same documented Strapi auth:{scope:[]} platform
  // behavior as engagement.integration.test.ts's identical case.
  const requester = await registerAndLogin(`conv-req4-${randomUUID()}@test.local`);
  const receiver = await registerAndLogin(`conv-recv4-${randomUUID()}@test.local`);
  const threadId = await openThread(requester.jwt, receiver.email, `listing_${randomUUID()}`);

  const res = await fetch(`${BASE_URL}/conversations/${threadId}/read`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});

test('marking one thread read does not affect a different thread\'s unread state', async () => {
  const requester = await registerAndLogin(`conv-req5-${randomUUID()}@test.local`);
  const receiverA = await registerAndLogin(`conv-recvA5-${randomUUID()}@test.local`);
  const receiverB = await registerAndLogin(`conv-recvB5-${randomUUID()}@test.local`);
  const threadA = await openThread(requester.jwt, receiverA.email, `listing_a_${randomUUID()}`);
  const threadB = await openThread(requester.jwt, receiverB.email, `listing_b_${randomUUID()}`);

  await strapiInstance.db.query('api::thread.thread').update({ where: { threadId: threadB }, data: { unreadCount: 3 } } as any);

  const res = await fetch(`${BASE_URL}/conversations/${threadA}/read`, {
    method: 'PATCH',
    headers: authed(requester.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);

  const untouched = await strapiInstance.db.query('api::thread.thread').findOne({ where: { threadId: threadB } } as any);
  assert.equal(untouched.unreadCount, 3, 'a sibling thread must not be affected by marking a different thread read');
});

test('a participant can delete their own thread -> 200, thread and its messages are removed', async () => {
  const requester = await registerAndLogin(`conv-del-req-${randomUUID()}@test.local`);
  const receiver = await registerAndLogin(`conv-del-recv-${randomUUID()}@test.local`);
  const threadId = await openThread(requester.jwt, receiver.email, `listing_${randomUUID()}`);

  await fetch(`${BASE_URL}/conversations/message`, {
    method: 'POST',
    headers: authed(requester.jwt),
    body: JSON.stringify({ data: { receiverEmail: receiver.email, threadId, message: 'ikinci mesaj' } }),
  });

  const res = await fetch(`${BASE_URL}/conversations/${threadId}`, {
    method: 'DELETE',
    headers: authed(requester.jwt),
  });
  assert.equal(res.status, 200, 'permission gap must be closed: participant should reach the controller and succeed');

  const thread = await strapiInstance.db.query('api::thread.thread').findOne({ where: { threadId } } as any);
  assert.equal(thread, null);
  const messages = await strapiInstance.db.query('api::message.message').findMany({ where: { threadId } } as any);
  assert.equal(messages.length, 0, 'all messages in the deleted thread must be removed');
});

test('a non-participant cannot delete someone else\'s thread by supplying its threadId -> 404, thread survives', async () => {
  const requester = await registerAndLogin(`conv-del-req2-${randomUUID()}@test.local`);
  const receiver = await registerAndLogin(`conv-del-recv2-${randomUUID()}@test.local`);
  const threadId = await openThread(requester.jwt, receiver.email, `listing_${randomUUID()}`);

  const stranger = await registerAndLogin(`conv-del-stranger2-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/conversations/${threadId}`, {
    method: 'DELETE',
    headers: authed(stranger.jwt),
  });
  assert.equal(res.status, 404, 'a stranger supplying another user\'s threadId must not be able to delete it');

  const survivingThread = await strapiInstance.db.query('api::thread.thread').findOne({ where: { threadId } } as any);
  assert.notEqual(survivingThread, null, 'the thread must survive an unauthorized delete attempt');
});

test('an unauthenticated caller is rejected on deleteByThreadId', async () => {
  // 403, not 401: same documented Strapi auth:{scope:[]} platform
  // behavior as engagement.integration.test.ts's identical case.
  const requester = await registerAndLogin(`conv-del-req3-${randomUUID()}@test.local`);
  const receiver = await registerAndLogin(`conv-del-recv3-${randomUUID()}@test.local`);
  const threadId = await openThread(requester.jwt, receiver.email, `listing_${randomUUID()}`);

  const res = await fetch(`${BASE_URL}/conversations/${threadId}`, { method: 'DELETE' });
  assert.equal(res.status, 403);

  const survivingThread = await strapiInstance.db.query('api::thread.thread').findOne({ where: { threadId } } as any);
  assert.notEqual(survivingThread, null);
});
