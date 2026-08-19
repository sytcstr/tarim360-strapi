/**
 * MESSAGING M4 (MESSAGING_RELEASE_FORENSIC_AUDIT.md,
 * MESSAGING_M4_RELIABILITY_FIX_REPORT.md) -- POST /conversations/message
 * had no idempotency guarantee: a client retrying a send it never got a
 * response for (timeout, dropped connection) had no way to avoid
 * creating a second, duplicate message. This mirrors the proven
 * operationId + payloadFingerprint pattern already used by
 * listing-comment/listing-share (operation-idempotency.ts): a client
 * generates a stable UUID once per logical send and resends the SAME one
 * on retry; the server treats a retry with the same operationId AND the
 * same fingerprint as a no-op (returns the original message), and a
 * different fingerprint under the same operationId as a conflict.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-conversation-send-retry-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-conversation-send-retry-test.db');
const PORT = 14171;
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

test('first send with an operationId succeeds like any normal send', async () => {
  const aEmail = `m4-first-a-${randomUUID()}@test.local`;
  const bEmail = `m4-first-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;
  const operationId = randomUUID();

  const res = await sendMessage(aJwt, {
    message: 'merhaba',
    listingId: contextId,
    receiverEmail: bEmail,
    operationId,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.senderEmail, aEmail.toLowerCase());

  const row = await strapiInstance.db.query('api::message.message').findOne({ where: { operationId } });
  assert.ok(row, 'the message must be persisted with its operationId');
});

test('retrying the same operationId does not create a second message', async () => {
  const aEmail = `m4-retry-a-${randomUUID()}@test.local`;
  const bEmail = `m4-retry-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;
  const operationId = randomUUID();
  const payload = { message: 'merhaba', listingId: contextId, receiverEmail: bEmail, operationId };

  const first = await sendMessage(aJwt, payload);
  assert.equal(first.status, 200);
  const second = await sendMessage(aJwt, payload);
  const third = await sendMessage(aJwt, payload);
  assert.equal(second.status, 200);
  assert.equal(third.status, 200);
  assert.equal(second.body.data.id, first.body.data.id, 'a retry must return the SAME message row');
  assert.equal(third.body.data.id, first.body.data.id);

  const rows = await strapiInstance.db.query('api::message.message').findMany({ where: { operationId } } as any);
  assert.equal(rows.length, 1, 'exactly one message must exist in the DB after 3 identical sends');
});

test('concurrent sends with the same operationId produce exactly one message', async () => {
  const aEmail = `m4-race-a-${randomUUID()}@test.local`;
  const bEmail = `m4-race-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;
  const operationId = randomUUID();
  const payload = { message: 'ayni anda gonderilen mesaj', listingId: contextId, receiverEmail: bEmail, operationId };

  const [r1, r2] = await Promise.all([sendMessage(aJwt, payload), sendMessage(aJwt, payload)]);
  assert.equal(r1.status, 200, 'first concurrent request must not fail');
  assert.equal(r2.status, 200, 'second concurrent request must not fail (a losing race resolves to the winner, not an error)');
  assert.equal(r1.body.data.id, r2.body.data.id);

  const rows = await strapiInstance.db.query('api::message.message').findMany({ where: { operationId } } as any);
  assert.equal(rows.length, 1);
});

test('the same operationId with a DIFFERENT body is rejected as a conflict, not silently accepted', async () => {
  const aEmail = `m4-conflict-a-${randomUUID()}@test.local`;
  const bEmail = `m4-conflict-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;
  const operationId = randomUUID();

  const first = await sendMessage(aJwt, { message: 'ilk metin', listingId: contextId, receiverEmail: bEmail, operationId });
  assert.equal(first.status, 200);

  const conflicting = await sendMessage(aJwt, { message: 'FARKLI metin', listingId: contextId, receiverEmail: bEmail, operationId });
  assert.equal(conflicting.status, 400, 'reusing an operationId with different content must be rejected, not accepted as if it were the same send');

  const rows = await strapiInstance.db.query('api::message.message').findMany({ where: { operationId } } as any);
  assert.equal(rows.length, 1, 'the conflicting attempt must not have created a second row');
});

test('an unauthenticated retry is rejected, same as any other unauthenticated send', async () => {
  const operationId = randomUUID();
  const res = await sendMessage(null, {
    message: 'kimliksiz',
    listingId: `listing-${randomUUID()}`,
    receiverEmail: 'someone@test.local',
    operationId,
  });
  assert.equal(res.status, 403);
});

test('a non-participant cannot use a stolen/guessed operationId to inject into someone else\'s thread', async () => {
  const bEmail = `m4-nonpart-b-${randomUUID()}@test.local`;
  const cEmail = `m4-nonpart-c-${randomUUID()}@test.local`;
  const attackerEmail = `m4-nonpart-attacker-${randomUUID()}@test.local`;
  const bJwt = await registerAndLogin(bEmail);
  await registerAndLogin(cEmail);
  const attackerJwt = await registerAndLogin(attackerEmail);
  const contextId = `listing-${randomUUID()}`;
  const operationId = randomUUID();

  const real = await sendMessage(bJwt, { message: 'B den C ye', listingId: contextId, receiverEmail: cEmail, operationId });
  assert.equal(real.status, 200);
  const realThreadId = real.body.thread.threadId;

  // Attacker reuses the SAME operationId (e.g. guessed/observed) but targets the real thread as an outsider.
  const hijack = await sendMessage(attackerJwt, {
    message: 'saldirgan mesaji',
    threadId: realThreadId,
    requesterEmail: attackerEmail,
    receiverEmail: 'someone-else@test.local',
    operationId,
  });
  assert.equal(hijack.status, 403, 'participant enforcement must still apply even when an operationId is reused');

  const rows = await strapiInstance.db.query('api::message.message').findMany({ where: { operationId } } as any);
  assert.equal(rows.length, 1, 'the attacker must not have created a row under the reused operationId');
});

test('sending without an operationId still works (backward compatible, no idempotency applied)', async () => {
  const aEmail = `m4-noop-a-${randomUUID()}@test.local`;
  const bEmail = `m4-noop-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const res = await sendMessage(aJwt, { message: 'operationId yok', listingId: contextId, receiverEmail: bEmail });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.operationId ?? null, null);
});

test('a malformed operationId (not a UUID) is ignored, not rejected -- send still succeeds without idempotency', async () => {
  const aEmail = `m4-malformed-a-${randomUUID()}@test.local`;
  const bEmail = `m4-malformed-b-${randomUUID()}@test.local`;
  const aJwt = await registerAndLogin(aEmail);
  await registerAndLogin(bEmail);
  const contextId = `listing-${randomUUID()}`;

  const res = await sendMessage(aJwt, {
    message: 'gecersiz operationId',
    listingId: contextId,
    receiverEmail: bEmail,
    operationId: 'not-a-real-uuid',
  });
  assert.equal(res.status, 200);
});
