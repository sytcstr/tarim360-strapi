/**
 * Soru/Profil/Kart denetimi (2026-10-25) — Çiftçi Sorulari Madde 8.
 *
 * Question CREATION had no idempotency at all before this round (unlike
 * addFarmerQuestionAnswer, which already reused this same mechanism): a
 * double-tap, a client-level retry, or a genuinely-ambiguous "server
 * saved it but the response was lost" case could each produce a real
 * duplicate question. hub-content.ts's create() now accepts an opt-in,
 * client-generated `operationId` (UUID) for kind:'farmerQuestion' only --
 * reusing operation-idempotency.ts's existing resolveOperation/
 * fingerprintPayload exactly like addFarmerQuestionAnswer already does.
 *
 * This suite proves, against the REAL controller (no mocks):
 *  - a fresh operationId creates a real row;
 *  - a sequential retry with the SAME operationId + SAME content resolves
 *    to the SAME row (200, not 201), no duplicate;
 *  - N concurrent requests with the SAME operationId + SAME content never
 *    produce more than one real row;
 *  - the SAME operationId with DIFFERENT content is rejected as a 400
 *    conflict, and neither the original row nor a new one is affected;
 *  - a DIFFERENT real user cannot take over or collide with another
 *    user's operationId (the actor is part of the fingerprint) -- always
 *    a conflict, never a silent takeover;
 *  - two DELIBERATELY SEPARATE questions with identical text but
 *    different operationIds are both created as genuinely separate rows,
 *    never merged just because the content matches;
 *  - a legacy/old-client request with NO operationId at all still creates
 *    normally, exactly as before (opt-in, not required) -- including
 *    multiple such requests with identical content never colliding.
 *
 * Run only this file:
 *   npx tsx --test tests/integration/farmer-question-create-idempotency.integration.test.ts
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-farmer-question-create-idempotency-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-farmer-question-create-idempotency-test.db');
const PORT = 14241;
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

function questionPayload(title: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Test Ciftci',
    title,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
    ...overrides,
  };
}

async function createQuestion(jwt: string, title: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: questionPayload(title, overrides) }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function countFarmerQuestionsByTitle(title: string): Promise<number> {
  const rows = await strapiInstance.db.query('api::hub-content.hub-content').findMany({
    where: { kind: 'farmerQuestion', title },
  } as any);
  return Array.isArray(rows) ? rows.length : 0;
}

test('Madde 8: missing operationId still creates normally (legacy client, opt-in only)', async () => {
  const user = await registerAndLogin(`m8-legacy-${randomUUID()}@test.local`);
  const title = `M8 Legacy ${randomUUID()}`;
  const res = await createQuestion(user.jwt, title);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(await countFarmerQuestionsByTitle(title), 1);
});

test('Madde 8: two legacy (no operationId) requests with IDENTICAL content never collide -- each creates its own row', async () => {
  const user = await registerAndLogin(`m8-legacy-dup-${randomUUID()}@test.local`);
  const title = `M8 Legacy Dup ${randomUUID()}`;
  const first = await createQuestion(user.jwt, title);
  const second = await createQuestion(user.jwt, title);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(
    await countFarmerQuestionsByTitle(title),
    2,
    'legacy clients (no operationId) must behave exactly as before -- no new, unrequested dedup by content',
  );
});

test('Madde 8: invalid (non-UUID) operationId is rejected', async () => {
  const user = await registerAndLogin(`m8-invalid-${randomUUID()}@test.local`);
  const res = await createQuestion(user.jwt, `M8 Invalid ${randomUUID()}`, { operationId: 'not-a-uuid' });
  assert.equal(res.status, 400);
});

test('Madde 8: a fresh operationId creates a real question', async () => {
  const user = await registerAndLogin(`m8-fresh-${randomUUID()}@test.local`);
  const title = `M8 Fresh ${randomUUID()}`;
  const opId = randomUUID();
  const res = await createQuestion(user.jwt, title, { operationId: opId });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.title, title);
  assert.equal(await countFarmerQuestionsByTitle(title), 1);
});

// Soru/Profil/Kart denetimi (2026-10-25) Madde 9 (kapanış düzeltmesi 1):
// this test (and "concurrency" below) is the REAL DB-level proof that a
// retry with the same operationId never produces a second row -- the
// Flutter-side widget test (farmer_question_account_switch_guard_test.dart,
// "Madde 9 (kapanış düzeltmesi 2)") only proves the CLIENT preserves and
// resends the same operationId; it uses a fake HTTP adapter and cannot
// see this app's real database. This is also the exact scenario asked
// about -- "the server wrote the row, but the client's own view of that
// attempt failed (500/timeout/lost response), then retries" -- because
// from create()'s own code (hub-content.ts), nothing runs AFTER a
// successful entityService.create() call that could turn that same
// write into a 500 for this app's own reasons; a real retry after any
// such client-perceived failure is this exact same HTTP call shape.
test('Madde 8: double-tap -- retrying with the SAME operationId + SAME content resolves to the SAME question, no duplicate', async () => {
  const user = await registerAndLogin(`m8-retry-same-${randomUUID()}@test.local`);
  const title = `M8 Retry Same ${randomUUID()}`;
  const opId = randomUUID();
  // A real double-tap resends BYTE-IDENTICAL content -- the body must be
  // fixed once here, not regenerated per call (questionPayload's default
  // body embeds a fresh random questionId every time it's invoked, which
  // would make two calls look like genuinely different submissions).
  const fixedBody = JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] });

  const first = await createQuestion(user.jwt, title, { operationId: opId, body: fixedBody });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.data.documentId ?? first.body.data.id;

  const retry = await createQuestion(user.jwt, title, { operationId: opId, body: fixedBody });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  const retryId = retry.body.data.documentId ?? retry.body.data.id;
  assert.equal(retryId, firstId, 'a retry of the same submission must resolve to the SAME question, not a new one');
  assert.equal(await countFarmerQuestionsByTitle(title), 1, 'no duplicate question may exist');
});

test('Madde 8: concurrency -- N simultaneous requests with the SAME operationId produce exactly ONE real question', async () => {
  const user = await registerAndLogin(`m8-concurrent-${randomUUID()}@test.local`);
  const title = `M8 Concurrent ${randomUUID()}`;
  const opId = randomUUID();
  const fixedBody = JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => createQuestion(user.jwt, title, { operationId: opId, body: fixedBody })),
  );

  for (const r of results) {
    assert.ok(
      r.status === 200 || r.status === 201,
      `every concurrent attempt with the same operationId+content must succeed (200 or 201), got ${r.status}: ${JSON.stringify(r.body)}`,
    );
  }
  const ids = new Set(results.map((r) => r.body.data.documentId ?? r.body.data.id));
  assert.equal(ids.size, 1, 'all concurrent responses must resolve to the SAME single question');
  assert.equal(await countFarmerQuestionsByTitle(title), 1, 'exactly one real question must exist despite 5 concurrent submissions');
});

test('Madde 8: the SAME operationId with DIFFERENT content is rejected as a conflict, original untouched, no new row', async () => {
  const user = await registerAndLogin(`m8-conflict-${randomUUID()}@test.local`);
  const title = `M8 Conflict ${randomUUID()}`;
  const opId = randomUUID();

  const first = await createQuestion(user.jwt, title, { operationId: opId });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const differentTitle = `${title} DIFFERENT`;
  const conflicting = await createQuestion(user.jwt, differentTitle, { operationId: opId });
  assert.equal(conflicting.status, 400, 'reusing the same operationId with different content must be rejected');
  assert.equal(await countFarmerQuestionsByTitle(title), 1, 'the original question must be unaffected');
  assert.equal(await countFarmerQuestionsByTitle(differentTitle), 0, 'no new question may be created from the rejected conflict');
});

test('Madde 8: a DIFFERENT real user cannot collide with or take over another user\'s operationId', async () => {
  const userA = await registerAndLogin(`m8-crossuser-a-${randomUUID()}@test.local`);
  const userB = await registerAndLogin(`m8-crossuser-b-${randomUUID()}@test.local`);
  const titleA = `M8 CrossUser A ${randomUUID()}`;
  const titleB = `M8 CrossUser B ${randomUUID()}`;
  const opId = randomUUID();

  const first = await createQuestion(userA.jwt, titleA, { operationId: opId });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = first.body.data.documentId ?? first.body.data.id;

  // userB attempts to reuse the SAME operationId with their OWN content --
  // the actor is part of the fingerprint, so this can never silently
  // resolve as "duplicate" (which would hand userB userA's row) -- it must
  // be a conflict, and userA's row must stay exactly as it was.
  const second = await createQuestion(userB.jwt, titleB, { operationId: opId });
  assert.equal(second.status, 400, 'a different user reusing someone else\'s operationId must be rejected, never silently accepted');
  assert.equal(await countFarmerQuestionsByTitle(titleB), 0, 'userB must not have created a question via the collision');

  const stillA = await strapi_lookupByDocumentId(firstId);
  assert.equal(stillA?.title, titleA, 'userA\'s original question must be completely unaffected by userB\'s attempt');
  assert.equal(String(stillA?.ownerEmail ?? '').toLowerCase(), userA.email, 'ownership of the original row must still belong to userA');
});

async function strapi_lookupByDocumentId(documentId: string) {
  return strapiInstance.db.query('api::hub-content.hub-content').findOne({ where: { documentId } } as any);
}

test('Madde 8: two deliberately separate questions with IDENTICAL text but DIFFERENT operationIds are both created, never merged', async () => {
  const user = await registerAndLogin(`m8-separate-${randomUUID()}@test.local`);
  const title = `M8 Separate ${randomUUID()}`;

  const first = await createQuestion(user.jwt, title, { operationId: randomUUID() });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await createQuestion(user.jwt, title, { operationId: randomUUID() });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const firstId = first.body.data.documentId ?? first.body.data.id;
  const secondId = second.body.data.documentId ?? second.body.data.id;
  assert.notEqual(firstId, secondId, 'two genuinely separate submissions (different operationIds) must be two separate rows');
  assert.equal(
    await countFarmerQuestionsByTitle(title),
    2,
    'identical text alone must never merge two deliberately separate questions',
  );
});

test('Madde 8: idempotency is scoped to farmerQuestion only -- an unrelated hub-content kind sending operationId is unaffected (regression)', async () => {
  const user = await registerAndLogin(`m8-otherkind-${randomUUID()}@test.local`);
  const title = `M8 Other Kind ${randomUUID()}`;
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      data: {
        kind: 'blogPost',
        state: 'published',
        authorName: 'Test Ciftci',
        title,
        descShort: 'Blog ozeti',
        body: 'blog govde metni',
        content: 'Blog icerigi',
        operationId: randomUUID(),
      },
    }),
  });
  const json = await res.json();
  assert.equal(res.status, 201, JSON.stringify(json));
  assert.equal(json.data.title, title);
});
