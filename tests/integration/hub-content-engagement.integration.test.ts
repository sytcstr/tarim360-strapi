/**
 * Faz D6-B — Knowledge Hub like backend readiness.
 *
 * hub-content's engagement-contract.ts entries (TARGET_UID, DOMAIN_SUPPORT
 * like:true/favorite:false/view:false, COUNTER_FIELD.like='likes') and
 * schema fields (likes, engagementVersion) already existed — the generic
 * PUT/DELETE /engagements/like route already works end-to-end for
 * targetType=hub-content with zero additional code. There was never a
 * dedicated /hub-contents/:id/metrics/like route or a legacy toggle route
 * to delegate — the only pre-D6 "like" mechanism was the Flutter client
 * (HubContentRepo) computing `likes` locally and PATCHing it via the
 * generic core update route (HubContentRepo._syncLike).
 *
 * Unlike the equivalent processed-product gap (Faz D5-B), this one is
 * NOT blocked by a missing permission — hub-content.update is granted to
 * the authenticated role, and hub-content-write-guard's "reaction-only
 * update" allowance means a client-supplied `likes` value was a live,
 * reachable path, not just a theoretical one. This suite proves the fix.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-hub-content-engagement-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-hub-content-engagement-test.db');
const PORT = 14153;
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

async function createHubContent(overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::hub-content.hub-content', {
    data: {
      kind: 'haber',
      state: 'published',
      authorName: 'Test Yazar',
      title: 'Test İçerik',
      descShort: 'Kısa açıklama',
      description: 'Açıklama',
      body: 'Gövde metni',
      likes: 0,
      comments: 0,
      commentCount: 0,
      commentList: [],
      engagementVersion: 0,
      ...overrides,
    },
  } as any);
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

const fetchHubContentRow = async (id: number | string) =>
  strapiInstance.db.query('api::hub-content.hub-content').findOne({ where: { id } } as any);

// ---------------------------------------------------------------------
// New canonical route (PUT/DELETE /engagements/like) — already generic
// ---------------------------------------------------------------------

test('like (new): first PUT activates and increments the "likes" counter', async () => {
  const jwt = await registerAndLogin(`hub-liker-${randomUUID()}@test.local`);
  const content = await createHubContent();
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.count, 1);
  const row = await fetchHubContentRow(content.id);
  assert.equal(row.likes, 1);
});

test('like (new): repeating the same PUT is a no-op', async () => {
  const jwt = await registerAndLogin(`hub-liker-${randomUUID()}@test.local`);
  const content = await createHubContent();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const body = await res.json();
  assert.equal(body.changed, false);
  assert.equal(body.count, 1);
});

test('like (new): DELETE unlikes and decrements', async () => {
  const jwt = await registerAndLogin(`hub-liker-${randomUUID()}@test.local`);
  const content = await createHubContent();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const res = await fetch(
    `${BASE_URL}/engagements/like?targetType=hub-content&targetId=${content.id}`,
    { method: 'DELETE', headers: authed(jwt) },
  );
  const body = await res.json();
  assert.equal(body.active, false);
  assert.equal(body.count, 0);
  const row = await fetchHubContentRow(content.id);
  assert.equal(row.likes, 0);
});

test('like (new): two concurrent PUTs from the same actor result in count=1', async () => {
  const jwt = await registerAndLogin(`hub-liker-${randomUUID()}@test.local`);
  const content = await createHubContent();
  const fire = () =>
    fetch(`${BASE_URL}/engagements/like`, {
      method: 'PUT',
      headers: authed(jwt),
      body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
    }).then((r) => r.json());
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal([a.changed, b.changed].filter(Boolean).length, 1);
  assert.equal(Math.max(a.count, b.count), 1);
  const row = await fetchHubContentRow(content.id);
  assert.equal(row.likes, 1);
});

test('like/DELETE race never leaves count negative', async () => {
  const jwt = await registerAndLogin(`hub-liker-${randomUUID()}@test.local`);
  const content = await createHubContent();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const putAgain = fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  }).then((r) => r.json());
  const del = fetch(
    `${BASE_URL}/engagements/like?targetType=hub-content&targetId=${content.id}`,
    { method: 'DELETE', headers: authed(jwt) },
  ).then((r) => r.json());
  const [a, b] = await Promise.all([putAgain, del]);
  assert.ok(a.count >= 0 && b.count >= 0);
  const row = await fetchHubContentRow(content.id);
  assert.ok(row.likes >= 0);
});

test('engagementVersion only advances on a real mutation, not a no-op retry', async () => {
  const jwt = await registerAndLogin(`hub-ver-${randomUUID()}@test.local`);
  const content = await createHubContent();
  const first = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  }).then((r) => r.json());
  const retry = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  }).then((r) => r.json());
  assert.equal(retry.serverVersion, first.serverVersion);
});

test('count matches the real engagement-interaction row count', async () => {
  const jwt = await registerAndLogin(`hub-count-${randomUUID()}@test.local`);
  const content = await createHubContent();
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const rows = await strapiInstance.db.query('api::engagement-interaction.engagement-interaction').findMany({
    where: { targetType: 'hub-content', targetId: String(content.id), kind: 'like' },
  });
  assert.equal(rows.length, 1);
});

test('like: non-existent hub content returns NOT_FOUND', async () => {
  const jwt = await registerAndLogin(`hub-liker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: '999999999' }),
  });
  assert.equal(res.status, 404);
});

test('favorite/view are unsupported for hub-content, not silently accepted', async () => {
  const jwt = await registerAndLogin(`hub-cap-${randomUUID()}@test.local`);
  const content = await createHubContent();
  const favRes = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const favBody = await favRes.json();
  assert.equal(favRes.status, 400);
  assert.equal(favBody.error.code, 'ENGAGEMENT_NOT_SUPPORTED');

  const viewRes = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const viewBody = await viewRes.json();
  assert.equal(viewRes.status, 400);
  assert.equal(viewBody.error.code, 'ENGAGEMENT_NOT_SUPPORTED');
});

// ---------------------------------------------------------------------
// Generic create/update must strip a client-supplied likes/engagementVersion,
// but must NOT interfere with the comment system's use of the same route
// ---------------------------------------------------------------------

test('generic update ignores a client-supplied likes/engagementVersion (the old HubContentRepo._syncLike path)', async () => {
  const jwt = await registerAndLogin(`hub-spoof-${randomUUID()}@test.local`);
  const content = await createHubContent();
  // Real like first, so we can prove the spoofed PATCH doesn't touch it.
  await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'hub-content', targetId: content.id }),
  });
  const res = await fetch(`${BASE_URL}/hub-contents/${content.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: { likes: 99999, engagementVersion: 99999 },
    }),
  });
  assert.equal(res.status, 200, 'the (now-empty) update must still succeed, not error');
  const row = await fetchHubContentRow(content.id);
  assert.equal(row.likes, 1, 'spoofed likes must not have overwritten the real, server-computed value');
  assert.notEqual(row.engagementVersion, 99999);
});

test('generic create ignores a client-supplied likes/engagementVersion', async () => {
  const jwt = await registerAndLogin(`hub-spoof-create-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        kind: 'haber',
        title: 'Spoof İçerik',
        authorName: 'Test',
        likes: 500,
        engagementVersion: 500,
      },
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  const created = body.data ?? body;
  assert.equal(created.likes ?? 0, 0);
});

test('the comment system\'s own fields still update through the same generic route (comment behavior unaffected)', async () => {
  const jwt = await registerAndLogin(`hub-comment-${randomUUID()}@test.local`);
  const content = await createHubContent();
  const res = await fetch(`${BASE_URL}/hub-contents/${content.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        comments: 1,
        commentCount: 1,
        commentList: [{ name: 'Test', text: 'Merhaba' }],
        lastCommentText: 'Merhaba',
        lastCommentAuthor: 'Test',
      },
    }),
  });
  assert.equal(res.status, 200);
  const row = await fetchHubContentRow(content.id);
  assert.equal(row.commentCount, 1);
  assert.equal(row.lastCommentText, 'Merhaba');
});
