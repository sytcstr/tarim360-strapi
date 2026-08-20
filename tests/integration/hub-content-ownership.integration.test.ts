/**
 * ENGAGEMENT_E1_TARGETED_FIX_REPORT.md — BUG-ENG-001 (CRITICAL).
 *
 * hub-content-write-guard.ts used to restrict ONLY founder-only kinds
 * (Knowledge/AgriData); for every other kind -- ordinary hub posts and,
 * critically, farmerQuestion -- it returned true unconditionally with no
 * per-row ownership check at all, letting any authenticated user
 * overwrite or delete any other user's post. hub-content also had no
 * identity field at all before this fix (only a cosmetic authorName
 * string) -- ownerEmail/ownerProfileId were added and are now stamped
 * server-side on create.
 *
 * Farmer-question "answering" is a real, live, core cross-user feature
 * implemented as a full-row PUT that resends the original asker's
 * title/descShort unchanged while only the embedded `body` JSON (answers)
 * differs -- this suite proves that flow is NOT broken by the new
 * ownership check, alongside proving the actual vulnerability (a
 * non-owner changing the question's own title/descShort, or deleting it
 * outright) is now closed.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-hub-content-ownership-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-hub-content-ownership-test.db');
const PORT = 14177;
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

async function createFarmerQuestion(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        kind: 'farmerQuestion',
        state: 'published',
        authorName: 'Test Ciftci',
        title: 'Domates yapraklarinda leke var',
        descShort: 'Kisa soru',
        body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
        content: 'Soru metni',
        likes: 0,
        comments: 0,
        commentCount: 0,
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  return { status: res.status, id: json?.data?.documentId ?? json?.data?.id, body: json };
}

async function createOrdinaryPost(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        kind: 'general',
        state: 'published',
        authorName: 'Test Kullanici',
        title: 'Genel gonderi',
        descShort: 'Kisa aciklama',
        body: 'Govde',
        content: 'Icerik',
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  return { status: res.status, id: json?.data?.documentId ?? json?.data?.id, body: json };
}

test('owner can update their own farmer question', async () => {
  const a = await registerAndLogin(`hub-a-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt);
  assert.equal(created.status, 201);

  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'PUT',
    headers: authed(a.jwt),
    body: JSON.stringify({ data: { title: 'Guncellenmis soru basligi' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.title, 'Guncellenmis soru basligi');
});

test('owner can delete their own farmer question', async () => {
  const a = await registerAndLogin(`hub-a2-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt);

  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'DELETE',
    headers: authed(a.jwt),
  });
  assert.equal(res.status, 204);
});

test('BUG-ENG-001: a different user cannot update (change the title of) another user\'s farmer question -> 403', async () => {
  const a = await registerAndLogin(`hub-b-owner-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`hub-b-attacker-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt);

  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'PUT',
    headers: authed(b.jwt),
    body: JSON.stringify({ data: { title: 'Saldirgan tarafindan degistirildi' } }),
  });
  assert.equal(res.status, 403);

  const row = await strapiInstance.db.query('api::hub-content.hub-content').findOne({
    where: { documentId: created.id },
  } as any);
  assert.notEqual(row.title, 'Saldirgan tarafindan degistirildi', 'the real title must be untouched');
});

test('BUG-ENG-001: a different user cannot delete another user\'s farmer question -> 403', async () => {
  const a = await registerAndLogin(`hub-c-owner-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`hub-c-attacker-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt);

  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'DELETE',
    headers: authed(b.jwt),
  });
  assert.equal(res.status, 403);

  const row = await strapiInstance.db.query('api::hub-content.hub-content').findOne({
    where: { documentId: created.id },
  } as any);
  assert.ok(row, 'the question must still exist');
});

test('a client-supplied owner/author payload spoof has no effect on authorization', async () => {
  const a = await registerAndLogin(`hub-d-owner-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`hub-d-attacker-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt);

  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'PUT',
    headers: authed(b.jwt),
    body: JSON.stringify({
      data: {
        title: 'Sahte sahiplik ile degistirme',
        ownerEmail: a.email,
        ownerProfileId: a.ownerId,
        authorProfileId: a.ownerId,
        authorEmail: a.email,
      },
    }),
  });
  assert.equal(res.status, 403, 'claiming to be the owner in the payload must not bypass the real, server-recorded ownership check');
});

test('the real owner of a newly-created row is always the authenticated creator, never a client-supplied value', async () => {
  const a = await registerAndLogin(`hub-e-real-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`hub-e-victim-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt, {
    ownerEmail: victim.email,
    ownerProfileId: victim.ownerId,
  });
  assert.equal(created.status, 201);

  const row = await strapiInstance.db.query('api::hub-content.hub-content').findOne({
    where: { documentId: created.id },
  } as any);
  assert.equal(row.ownerEmail, a.email, 'ownerEmail must always be the real creator, not the spoofed value');
  assert.equal(row.ownerProfileId, a.ownerId);
});

test('the same protection applies to an ordinary (non-farmer-question) hub post', async () => {
  const a = await registerAndLogin(`hub-f-owner-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`hub-f-attacker-${randomUUID()}@test.local`);
  const created = await createOrdinaryPost(a.jwt);

  const updateRes = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'PUT',
    headers: authed(b.jwt),
    body: JSON.stringify({ data: { title: 'Saldiri' } }),
  });
  assert.equal(updateRes.status, 403);

  const deleteRes = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'DELETE',
    headers: authed(b.jwt),
  });
  assert.equal(deleteRes.status, 403);
});

test('founder-only Knowledge/AgriData restriction is unaffected: a non-founder still cannot update knowledge content', async () => {
  const nonFounder = await registerAndLogin(`hub-g-nonfounder-${randomUUID()}@test.local`);
  const row = await strapiInstance.entityService.create('api::hub-content.hub-content', {
    data: { kind: 'knowledge', state: 'published', title: 'Tarimsal Bilgi', authorName: 'Kurucu' },
  } as any);

  const res = await fetch(`${BASE_URL}/hub-contents/${row.documentId}`, {
    method: 'PUT',
    headers: authed(nonFounder.jwt),
    body: JSON.stringify({ data: { title: 'Degistirildi' } }),
  });
  assert.equal(res.status, 403);
});

test('unauthenticated caller cannot update or delete any hub-content row', async () => {
  const a = await registerAndLogin(`hub-h-owner-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt);

  const updateRes = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { title: 'x' } }),
  });
  assert.equal(updateRes.status, 403);

  const deleteRes = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(deleteRes.status, 403);
});

test('regression: a different user can still legitimately answer another user\'s farmer question (core-identity unchanged)', async () => {
  const asker = await registerAndLogin(`hub-i-asker-${randomUUID()}@test.local`);
  const answerer = await registerAndLogin(`hub-i-answerer-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(asker.jwt);
  const row = await strapiInstance.db.query('api::hub-content.hub-content').findOne({
    where: { documentId: created.id },
  } as any);

  // Mirrors farmer_questions_repo.dart's addAnswer: resends the SAME
  // title/descShort, only the embedded body (answers) actually changes.
  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'PUT',
    headers: authed(answerer.jwt),
    body: JSON.stringify({
      data: {
        kind: 'farmerQuestion',
        title: row.title,
        descShort: row.descShort,
        body: JSON.stringify({ questionId: 'q1', answers: [{ text: 'Cevabim budur', name: 'Answerer' }] }),
        comments: 1,
        commentCount: 1,
      },
    }),
  });
  assert.equal(res.status, 200, 'answering someone else\'s farmer question must still work');
  const updated = await res.json();
  assert.equal(updated.data.commentCount, 1);
});

test('regression: a different user can still react (like/comment-count-only) on another user\'s ordinary hub post', async () => {
  const owner = await registerAndLogin(`hub-j-owner-${randomUUID()}@test.local`);
  const reactor = await registerAndLogin(`hub-j-reactor-${randomUUID()}@test.local`);
  const created = await createOrdinaryPost(owner.jwt);

  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'PUT',
    headers: authed(reactor.jwt),
    body: JSON.stringify({ data: { commentCount: 1, comments: 1 } }),
  });
  assert.equal(res.status, 200, 'a pure reaction-only update from a non-owner must still work');
});

test('policy rejection returns a clean 403, not a 500 (denyForbidden, not a raw ctx.forbidden crash)', async () => {
  const a = await registerAndLogin(`hub-k-owner-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`hub-k-attacker-${randomUUID()}@test.local`);
  const created = await createFarmerQuestion(a.jwt);

  const res = await fetch(`${BASE_URL}/hub-contents/${created.id}`, {
    method: 'DELETE',
    headers: authed(b.jwt),
  });
  assert.equal(res.status, 403);
  const body = await res.json().catch(() => ({}));
  assert.notEqual(res.status, 500);
  assert.ok(body?.error, 'a real Strapi policy-denial error body must be present, not a crash');
});

test('a legacy row created with no owner recorded cannot be updated or deleted by a non-founder (fail-closed)', async () => {
  const stranger = await registerAndLogin(`hub-l-stranger-${randomUUID()}@test.local`);
  const legacyRow = await strapiInstance.entityService.create('api::hub-content.hub-content', {
    data: {
      kind: 'farmerQuestion',
      state: 'published',
      authorName: 'Eski Kayit',
      title: 'Eski soru',
      descShort: 'Eski',
      body: JSON.stringify({ answers: [] }),
      // Deliberately no ownerEmail/ownerProfileId, simulating a row that
      // existed before this fix.
    },
  } as any);

  const res = await fetch(`${BASE_URL}/hub-contents/${legacyRow.documentId}`, {
    method: 'DELETE',
    headers: authed(stranger.jwt),
  });
  assert.equal(res.status, 403, 'a row with no recorded owner must not be deletable by an arbitrary authenticated user');
});
