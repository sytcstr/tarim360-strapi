/**
 * Soru/Profil/Kart denetimi (2026-10-25) — Çiftçi Sorulari Madde 5.
 *
 * `deleteAnswerByIds` (farmer_questions_repo.dart) used to "delete" an
 * answer via a client-driven full-row PUT of the QUESTION, which never
 * reaches a standalone answer row at all, and silently swallowed a
 * rejection (403) as success. This file empirically verifies the new
 * dedicated `DELETE /hub-contents/farmer-questions/:questionId/answers/:answerId`
 * endpoint (hub-content.ts's deleteFarmerQuestionAnswer) for BOTH the
 * standalone-row shape and the legacy-embedded shape, separately, with
 * the exact authorization the existing UI already assumes
 * (`_isQuestionOwner() || _isAnswerOwner(a)`), and without touching the
 * generic question PUT policy at all.
 *
 * Run only this file:
 *   npx tsx --test tests/integration/farmer-question-answer-deletion.integration.test.ts
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-farmer-answer-delete-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-farmer-answer-delete-test.db');
const PORT = 14235;
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

async function createQuestion(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        kind: 'farmerQuestion',
        state: 'published',
        authorName: 'Test Ciftci',
        title: `Soru ${randomUUID()}`,
        descShort: 'Kisa soru',
        body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
        content: 'Soru metni',
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  return { status: res.status, documentId: json?.data?.documentId as string, body: json };
}

async function addAnswer(jwt: string, questionId: string, text: string) {
  const res = await fetch(`${BASE_URL}/hub-contents/farmer-questions/${questionId}/answers`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { text, operationId: randomUUID() } }),
  });
  const json = await res.json();
  return { status: res.status, answerId: json?.data?.id as string, body: json };
}

async function deleteAnswer(jwt: string, questionId: string, answerId: string) {
  const res = await fetch(`${BASE_URL}/hub-contents/farmer-questions/${questionId}/answers/${encodeURIComponent(answerId)}`, {
    method: 'DELETE',
    headers: authed(jwt),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function getQuestion(jwt: string, documentId: string) {
  const res = await fetch(`${BASE_URL}/hub-contents/${documentId}`, { headers: authed(jwt) });
  const json = await res.json();
  return { status: res.status, row: json?.data };
}

function parseBody(row: any): Record<string, unknown> {
  try {
    return JSON.parse(String(row?.body ?? '{}'));
  } catch (_) {
    return {};
  }
}

// ============================================================
// Standalone answer row (the MODERN shape, created via addFarmerQuestionAnswer).
// ============================================================
test('Madde 5 (bağımsız cevap): the real answerer can delete their OWN standalone answer -- row is actually gone server-side', async () => {
  const asker = await registerAndLogin(`r5a-asker-${randomUUID()}@test.local`);
  const answerer = await registerAndLogin(`r5a-answerer-${randomUUID()}@test.local`);

  const question = await createQuestion(asker.jwt);
  assert.equal(question.status, 201);
  const answer = await addAnswer(answerer.jwt, question.documentId, 'Silinecek cevap');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  const del = await deleteAnswer(answerer.jwt, question.documentId, answer.answerId);
  console.log('Madde5 (bağımsız, gerçek cevaplayan) ->', del.status, JSON.stringify(del.body));
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body?.data?.mode, 'standalone');

  // Prove it's REALLY gone -- a real DB row count, not just a client-side list.
  const rows = await strapiInstance.db.query('api::hub-content.hub-content').findMany({
    where: { kind: 'farmerQuestionComment' },
  });
  const stillThere = rows.some((r: any) => {
    try {
      return JSON.parse(String(r.body ?? '{}')).answerId === answer.answerId;
    } catch (_) {
      return false;
    }
  });
  assert.equal(stillThere, false, 'the standalone answer row must be genuinely deleted from the database, not just hidden client-side');
});

test('Madde 5 (bağımsız cevap): the QUESTION OWNER (not the answerer) can also delete the answer -- matches existing UI intent (_isQuestionOwner() || _isAnswerOwner())', async () => {
  const asker = await registerAndLogin(`r5b-asker-${randomUUID()}@test.local`);
  const answerer = await registerAndLogin(`r5b-answerer-${randomUUID()}@test.local`);

  const question = await createQuestion(asker.jwt);
  const answer = await addAnswer(answerer.jwt, question.documentId, 'Moderasyon testi');
  assert.equal(answer.status, 200);

  const del = await deleteAnswer(asker.jwt, question.documentId, answer.answerId);
  console.log('Madde5 (bağımsız, soru sahibi) ->', del.status, JSON.stringify(del.body));
  assert.equal(del.status, 200, JSON.stringify(del.body));
});

test('Madde 5 (bağımsız cevap): a STRANGER (neither the question owner nor the answerer) cannot delete it -- 403, row survives', async () => {
  const asker = await registerAndLogin(`r5c-asker-${randomUUID()}@test.local`);
  const answerer = await registerAndLogin(`r5c-answerer-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r5c-stranger-${randomUUID()}@test.local`);

  const question = await createQuestion(asker.jwt);
  const answer = await addAnswer(answerer.jwt, question.documentId, 'Yabancidan korunan cevap');
  assert.equal(answer.status, 200);

  const del = await deleteAnswer(stranger.jwt, question.documentId, answer.answerId);
  console.log('Madde5 (bağımsız, yabancı) ->', del.status, JSON.stringify(del.body));
  assert.equal(del.status, 403, JSON.stringify(del.body));

  const rows = await strapiInstance.db.query('api::hub-content.hub-content').findMany({
    where: { kind: 'farmerQuestionComment' },
  });
  const stillThere = rows.some((r: any) => {
    try {
      return JSON.parse(String(r.body ?? '{}')).answerId === answer.answerId;
    } catch (_) {
      return false;
    }
  });
  assert.equal(stillThere, true, 'a rejected delete attempt must leave the real row completely untouched');
});

test('Madde 5: deleting an already-deleted (or never-existing) answerId returns 404, not a false success', async () => {
  const asker = await registerAndLogin(`r5d-asker-${randomUUID()}@test.local`);
  const question = await createQuestion(asker.jwt);
  const del = await deleteAnswer(asker.jwt, question.documentId, 'fa_does_not_exist');
  console.log('Madde5 (var olmayan cevap) ->', del.status, JSON.stringify(del.body));
  assert.equal(del.status, 404, JSON.stringify(del.body));
});

// ============================================================
// Legacy embedded answer (inside the question's own body.answers[]).
// ============================================================
test('Madde 5 (eski gömülü cevap): the embedded answer\'s real author can delete their OWN entry even though they are NOT the question owner -- other entries untouched', async () => {
  const asker = await registerAndLogin(`r5e-asker-${randomUUID()}@test.local`);
  const realAnswerer = await registerAndLogin(`r5e-answerer-${randomUUID()}@test.local`);
  const otherAnswerer = await registerAndLogin(`r5e-other-${randomUUID()}@test.local`);

  const qId = `local_${randomUUID()}`;
  const question = await createQuestion(asker.jwt, {
    body: JSON.stringify({
      questionId: qId,
      answers: [
        { answerId: 'fa_target', name: 'Hedef', city: 'Konya', text: 'Silinecek gömülü cevap', email: realAnswerer.email, profileId: realAnswerer.ownerId },
        { answerId: 'fa_other', name: 'Diger', city: 'Izmir', text: 'Korunmasi gereken diger cevap', email: otherAnswerer.email, profileId: otherAnswerer.ownerId },
      ],
    }),
  });
  assert.equal(question.status, 201);

  const del = await deleteAnswer(realAnswerer.jwt, question.documentId, 'fa_target');
  console.log('Madde5 (gömülü, gerçek yazar) ->', del.status, JSON.stringify(del.body));
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body?.data?.mode, 'embedded');

  const after = await getQuestion(asker.jwt, question.documentId);
  const body = parseBody(after.row) as any;
  console.log('Madde5 (gömülü) remaining answers ->', JSON.stringify(body.answers));
  assert.equal(body.answers?.length, 1, 'exactly the targeted entry must be removed');
  assert.equal(body.answers?.[0]?.answerId, 'fa_other', 'the OTHER embedded answer must survive completely untouched');
  assert.equal(body.answers?.[0]?.text, 'Korunmasi gereken diger cevap');
});

test('Madde 5 (eski gömülü cevap): the QUESTION OWNER can delete someone else\'s embedded answer too', async () => {
  const asker = await registerAndLogin(`r5f-asker-${randomUUID()}@test.local`);
  const realAnswerer = await registerAndLogin(`r5f-answerer-${randomUUID()}@test.local`);

  const qId = `local_${randomUUID()}`;
  const question = await createQuestion(asker.jwt, {
    body: JSON.stringify({
      questionId: qId,
      answers: [
        { answerId: 'fa_mod', name: 'Hedef', city: 'Konya', text: 'Moderasyon', email: realAnswerer.email, profileId: realAnswerer.ownerId },
      ],
    }),
  });
  assert.equal(question.status, 201);

  const del = await deleteAnswer(asker.jwt, question.documentId, 'fa_mod');
  console.log('Madde5 (gömülü, soru sahibi) ->', del.status, JSON.stringify(del.body));
  assert.equal(del.status, 200, JSON.stringify(del.body));
});

test('Madde 5 (eski gömülü cevap): a STRANGER (neither question owner nor that answer\'s author) cannot delete it -- 403, entry survives', async () => {
  const asker = await registerAndLogin(`r5g-asker-${randomUUID()}@test.local`);
  const realAnswerer = await registerAndLogin(`r5g-answerer-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r5g-stranger-${randomUUID()}@test.local`);

  const qId = `local_${randomUUID()}`;
  const question = await createQuestion(asker.jwt, {
    body: JSON.stringify({
      questionId: qId,
      answers: [
        { answerId: 'fa_protected', name: 'Hedef', city: 'Konya', text: 'Korunan gömülü cevap', email: realAnswerer.email, profileId: realAnswerer.ownerId },
      ],
    }),
  });
  assert.equal(question.status, 201);

  const del = await deleteAnswer(stranger.jwt, question.documentId, 'fa_protected');
  console.log('Madde5 (gömülü, yabancı) ->', del.status, JSON.stringify(del.body));
  assert.equal(del.status, 403, JSON.stringify(del.body));

  const after = await getQuestion(asker.jwt, question.documentId);
  const body = parseBody(after.row) as any;
  assert.equal(body.answers?.length, 1, 'the rejected delete attempt must leave the embedded answer untouched');
  assert.equal(body.answers?.[0]?.text, 'Korunan gömülü cevap');
});

// ============================================================
// Regression: the generic question PUT policy must be completely
// unaffected by this new endpoint -- still rejects a non-owner body-PUT
// exactly as before (hub-content-write-guard.ts untouched).
// ============================================================
test('Madde 5 (regresyon): the generic question PUT is still rejected for a non-owner trying to touch the body directly -- not loosened by this change', async () => {
  const asker = await registerAndLogin(`r5h-asker-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r5h-stranger-${randomUUID()}@test.local`);
  const question = await createQuestion(asker.jwt);

  const res = await fetch(`${BASE_URL}/hub-contents/${question.documentId}`, {
    method: 'PUT',
    headers: authed(stranger.jwt),
    body: JSON.stringify({ data: { body: JSON.stringify({ questionId: 'x', answers: [] }) } }),
  });
  console.log('Madde5 regresyon (genel PUT, yabancı) ->', res.status);
  assert.equal(res.status, 403, 'the generic question PUT policy must remain exactly as restrictive as before');
});
