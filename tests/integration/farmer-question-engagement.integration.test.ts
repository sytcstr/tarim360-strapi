/**
 * Faz D7-B — Farmer Questions like backend readiness.
 *
 * Farmer Questions have NO dedicated Strapi content-type: they are rows
 * in api::hub-content.hub-content with kind='farmerQuestion'
 * (FarmerQuestionsRepo._toQuestionPayload, Flutter, calls createHubContent/
 * updateHubContent directly) — the exact same collection/UID Faz D6
 * already wired to targetType='hub-content'. A separate 'farmer-question'
 * engagement targetType was deliberately NOT created (see the D7-B
 * report): it would let the identical physical row be liked through two
 * independent engagement_interactions namespaces while both drove the
 * same `likes` column — a structural double-count risk. This suite
 * proves the generic engine, the legacy delegation, and D6-B's
 * sanitization all work correctly for farmerQuestion-kind rows using
 * targetType='hub-content' — no new backend code beyond delegating the
 * one legacy toggle route was needed.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file — see beforeAll below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-farmer-question-engagement-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-farmer-question-engagement-test.db');
const PORT = 14154;
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

async function createFarmerQuestion(overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::hub-content.hub-content', {
    data: {
      kind: 'farmerQuestion',
      state: 'published',
      authorName: 'Test Ciftci',
      title: 'Test Soru',
      descShort: 'Kisa soru',
      body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
      content: 'Soru metni',
      likes: 0,
      comments: 0,
      commentCount: 0,
      engagementVersion: 0,
      ...overrides,
    },
  } as any);
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

const fetchRow = async (id: number | string) =>
  strapiInstance.db.query('api::hub-content.hub-content').findOne({ where: { id } } as any);

// ---------------------------------------------------------------------
// Generic route already works for farmerQuestion-kind rows (same UID)
// ---------------------------------------------------------------------

test('like (new): PUT /engagements/like works for a farmerQuestion-kind row via targetType=hub-content', async () => {
  const jwt = await registerAndLogin(`fq-liker-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: question.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.count, 1);
  const row = await fetchRow(question.id);
  assert.equal(row.likes, 1);
  assert.equal(row.kind, 'farmerQuestion');
});

// ---------------------------------------------------------------------
// Legacy route: POST /farmer-question-likes/toggle
// ---------------------------------------------------------------------

test('legacy toggle: first call activates and increments likes', async () => {
  const jwt = await registerAndLogin(`legacy-fq-liker-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  const res = await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.enabled, true);
  const row = await fetchRow(question.id);
  assert.equal(row.likes, 1);
});

test('legacy toggle: repeating the same call does not double-count', async () => {
  const jwt = await registerAndLogin(`legacy-fq-liker-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  const row = await fetchRow(question.id);
  assert.equal(row.likes, 1);
});

test('legacy toggle then new PUT for the same user only changes the counter once (single interaction row)', async () => {
  const jwt = await registerAndLogin(`combo-fq-liker-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: question.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false, 'the same user liking via the new route after the legacy route must be a no-op');
  assert.equal(body.count, 1);
  const row = await fetchRow(question.id);
  assert.equal(row.likes, 1);
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'hub-content', targetId: String(question.id), kind: 'like' },
  });
  assert.equal(rows.length, 1, 'legacy and new routes for the same user must produce exactly one interaction row');
});

test('two simultaneous calls — one legacy, one new — for the same user still only change the counter once', async () => {
  const jwt = await registerAndLogin(`combo-fq-liker2-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  const legacy = fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  const modern = fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: question.id }),
  });
  await Promise.all([legacy, modern]);
  const row = await fetchRow(question.id);
  assert.equal(row.likes, 1);
});

test('legacy toggle: profile-setting likedFarmerQuestionIds is updated from the server result, not the client value', async () => {
  const jwt = await registerAndLogin(`legacy-fq-profile-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  const res = await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  const body = await res.json();
  // Second call is a no-op at the setMembership level (changed:false), so
  // this route intentionally leaves profile-setting untouched — same
  // pattern as toggleLogisticsLoadLike/toggleProcessedProductLike.
  assert.deepEqual(body.data.values, []);
});

test('legacy toggle: unauthenticated request is rejected', async () => {
  const question = await createFarmerQuestion();
  const res = await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ questionId: String(question.id), liked: true }),
  });
  assert.equal(res.status, 403);
});

test('like: non-existent question returns NOT_FOUND', async () => {
  const jwt = await registerAndLogin(`fq-liker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ questionId: '999999999', liked: true }),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------
// D6-B's sanitization already protects farmerQuestion-kind rows too
// (same collection, same controller — confirmed here explicitly)
// ---------------------------------------------------------------------

test('generic update ignores a client-supplied likes for a farmerQuestion-kind row (D6-B protection applies regardless of kind)', async () => {
  const jwt = await registerAndLogin(`fq-spoof-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: question.id }),
  });
  const res = await fetch(`${BASE_URL}/hub-contents/${question.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { likes: 99999, engagementVersion: 99999 } }),
  });
  assert.equal(res.status, 200);
  const row = await fetchRow(question.id);
  assert.equal(row.likes, 1, 'spoofed likes must not have overwritten the real, server-computed value');
  assert.notEqual(row.engagementVersion, 99999);
});

test('the answer/comment-equivalent fields (body/comments/commentCount) still update through the same generic route', async () => {
  const jwt = await registerAndLogin(`fq-answer-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  const newBody = JSON.stringify({ questionId: 'q1', answers: [{ text: 'Cevap' }] });
  const res = await fetch(`${BASE_URL}/hub-contents/${question.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data: { body: newBody, comments: 1, commentCount: 1 } }),
  });
  assert.equal(res.status, 200);
  const row = await fetchRow(question.id);
  assert.equal(row.body, newBody);
  assert.equal(row.commentCount, 1);
});
