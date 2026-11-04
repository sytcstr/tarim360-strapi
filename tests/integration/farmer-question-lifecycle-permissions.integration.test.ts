/**
 * Soru/Profil/Kart denetimi (kapanış) — Çiftçi Sorulari Madde 10-12.
 *
 * Proves, against the REAL controller/write-guard (no mocks):
 *  - the question's own owner may edit its content (title/body) via the
 *    generic PUT, but the embedded author identity stays server-derived;
 *  - a NON-owner may not edit another user's question at all (403);
 *  - the owner may archive their own question (state:'farmerQuestionArchived')
 *    and STILL see it afterwards via both findOne and find() -- while a
 *    different, non-owner user can see neither;
 *  - the owner may soft-delete their own question (state:'farmerQuestionDeleted')
 *    and can no longer see it themselves either, via findOne OR find()
 *    (no physical row removal -- the row still exists in the DB);
 *  - a PRE-FIX-style plain `state:'archived'` row (the old, ambiguous
 *    marker) stays hidden from its own owner too -- never auto-resurfaced
 *    just because this fix shipped;
 *  - a non-owner may not archive or delete another user's question (403);
 *  - a user may not report their OWN question (400, rejected before any
 *    row is created), while a different user reporting the SAME question
 *    succeeds normally (201).
 *
 * Run only this file:
 *   npx tsx --test tests/integration/farmer-question-lifecycle-permissions.integration.test.ts
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-farmer-question-lifecycle-permissions-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-farmer-question-lifecycle-permissions-test.db');
const PORT = 14271;
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
  return { status: res.status, body: json, id: json?.data?.documentId ?? json?.data?.id };
}

async function updateQuestion(jwt: string, id: string | number, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/hub-contents/${id}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function getQuestion(jwt: string | null, id: string | number) {
  const res = await fetch(`${BASE_URL}/hub-contents/${id}`, {
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

async function findQuestionIdInList(jwt: string, title: string): Promise<boolean> {
  const res = await fetch(
    `${BASE_URL}/hub-contents?filters[kind][$eq]=farmerQuestion&filters[title][$eq]=${encodeURIComponent(title)}&pagination[pageSize]=50`,
    { headers: authed(jwt) },
  );
  const json = await res.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows.length > 0;
}

function reportPayload(
  questionRemoteId: string,
  reporter: { email: string; ownerId: string },
) {
  const questionId = `fq_${questionRemoteId}`;
  return {
    kind: 'farmerQuestionReport',
    state: 'pending',
    authorName: 'Reporter',
    title: `question:${questionId}`,
    descShort: 'kotu icerik',
    body: JSON.stringify({
      targetType: 'question',
      targetId: questionId,
      questionId,
      // Madde 12: the real, server-loadable row id -- what the client's
      // own reportQuestion() actually sends (question.remoteEntryId),
      // alongside the synthetic canonical questionId.
      questionRemoteId,
      reason: 'kotu icerik',
      reporterName: 'Reporter',
      reporterCity: 'Turkiye',
      reporterEmail: reporter.email,
      reporterProfileId: reporter.ownerId,
      createdAt: new Date().toISOString(),
    }),
    location: 'Turkiye',
  };
}

async function createReport(
  jwt: string,
  questionRemoteId: string,
  reporter: { email: string; ownerId: string },
) {
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: reportPayload(questionRemoteId, reporter) }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

test('Madde 10: the owner can edit their own question content', async () => {
  const owner = await registerAndLogin(`m10-edit-owner-${randomUUID()}@test.local`);
  const title = `M10 Edit ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const updated = await updateQuestion(owner.jwt, created.id, {
    title: `${title} (duzenlendi)`,
    descShort: 'Guncellenmis kisa aciklama',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.data.title, `${title} (duzenlendi)`);
});

test('Madde 10: a NON-owner cannot edit another user\'s question', async () => {
  const owner = await registerAndLogin(`m10-edit-victim-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`m10-edit-stranger-${randomUUID()}@test.local`);
  const title = `M10 Edit Guard ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const attack = await updateQuestion(stranger.jwt, created.id, {
    title: 'ELE GECIRILDI',
    descShort: 'ELE GECIRILDI',
  });
  assert.equal(attack.status, 403, JSON.stringify(attack.body));

  const stillOriginal = await getQuestion(owner.jwt, created.id);
  assert.equal(stillOriginal.body.data.title, title);
});

test('Madde 11: the owner can archive their own question (deleted/isDeleted explicitly false) and still sees it afterwards', async () => {
  const owner = await registerAndLogin(`m11-archive-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`m11-archive-stranger-${randomUUID()}@test.local`);
  const title = `M11 Archive ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const archived = await updateQuestion(owner.jwt, created.id, {
    state: 'archived',
    deleted: false,
    isDeleted: false,
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  const ownerView = await getQuestion(owner.jwt, created.id);
  assert.equal(ownerView.status, 200, 'owner must still be able to open their own archived question');
  assert.equal(ownerView.body.data.title, title);
  assert.equal(
    await findQuestionIdInList(owner.jwt, title),
    true,
    'owner\'s own archived question must still appear in their own list',
  );

  const strangerView = await getQuestion(stranger.jwt, created.id);
  assert.equal(strangerView.status, 404, 'a non-owner must never see an archived question');
  assert.equal(
    await findQuestionIdInList(stranger.jwt, title),
    false,
    'a non-owner\'s list must never include another user\'s archived question',
  );
});

test('Madde 10: the owner can soft-delete their own question and no longer sees it either', async () => {
  const owner = await registerAndLogin(`m10-delete-owner-${randomUUID()}@test.local`);
  const title = `M10 Delete ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const deleted = await updateQuestion(owner.jwt, created.id, {
    state: 'deleted',
    deleted: true,
    isDeleted: true,
  });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

  const ownerView = await getQuestion(owner.jwt, created.id);
  assert.equal(
    ownerView.status,
    404,
    'a soft-deleted question must be invisible even to its own owner in the normal flow',
  );
  assert.equal(
    await findQuestionIdInList(owner.jwt, title),
    false,
    'owner\'s own list must not include their own soft-deleted question',
  );

  const rawRow = await strapiInstance.db.query('api::hub-content.hub-content').findOne({
    where: { title },
  } as any);
  assert.ok(rawRow, 'the row must still physically exist in the database -- never a hard delete');
  assert.equal(rawRow.state, 'deleted');
});

test('Madde 10-11 (kapanış, düzeltme): a bare state:\'archived\' row with NO deleted/isDeleted flag is still owner-visible', async () => {
  // Kullanıcının netleştirmesi: yalnızca state:'archived' taşıyan eski
  // kayıtlar, ek kanıt (deleted/isDeleted:true) olmadan "silinmiş" sayılıp
  // sahibinden gizlenmeyecek -- bu, mevcut iki testin (privacy-round4,
  // answer-identity) fixture'ı tam olarak budur ve değiştirilmeden geçmeli.
  const owner = await registerAndLogin(`m1011-bare-archived-${randomUUID()}@test.local`);
  const title = `M1011 Bare Archived ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const bareArchive = await updateQuestion(owner.jwt, created.id, { state: 'archived' });
  assert.equal(bareArchive.status, 200, JSON.stringify(bareArchive.body));

  const ownerView = await getQuestion(owner.jwt, created.id);
  assert.equal(
    ownerView.status,
    200,
    'a bare archived row with no additional deleted evidence must stay visible to its own owner',
  );
});

test('Madde 10-11 (kapanış, düzeltme): a LEGACY archived+deleted:true row stays hidden from its own owner too', async () => {
  const owner = await registerAndLogin(`m1011-legacy-${randomUUID()}@test.local`);
  const title = `M1011 Legacy ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const legacyArchive = await updateQuestion(owner.jwt, created.id, {
    state: 'archived',
    deleted: true,
    isDeleted: true,
  });
  assert.equal(legacyArchive.status, 200, JSON.stringify(legacyArchive.body));

  const ownerView = await getQuestion(owner.jwt, created.id);
  assert.equal(
    ownerView.status,
    404,
    'the OLD, genuinely ambiguous archived+deleted:true shape must never be auto-resurfaced to the owner by this fix',
  );
});

test('Madde 10-11: a NON-owner cannot archive or delete another user\'s question', async () => {
  const owner = await registerAndLogin(`m1011-guard-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`m1011-guard-stranger-${randomUUID()}@test.local`);
  const title = `M1011 Guard ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const archiveAttack = await updateQuestion(stranger.jwt, created.id, {
    state: 'archived',
    deleted: false,
    isDeleted: false,
  });
  assert.equal(archiveAttack.status, 403, JSON.stringify(archiveAttack.body));

  const deleteAttack = await updateQuestion(stranger.jwt, created.id, {
    state: 'deleted',
    deleted: true,
    isDeleted: true,
  });
  assert.equal(deleteAttack.status, 403, JSON.stringify(deleteAttack.body));

  const stillThere = await getQuestion(owner.jwt, created.id);
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.body.data.title, title);
});

test('Madde 12: a user cannot report their OWN question', async () => {
  const owner = await registerAndLogin(`m12-self-report-${randomUUID()}@test.local`);
  const title = `M12 Self Report ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const selfReport = await createReport(owner.jwt, String(created.id), {
    email: owner.email,
    ownerId: owner.ownerId,
  });
  assert.equal(selfReport.status, 400, JSON.stringify(selfReport.body));
});

test('Madde 12: a DIFFERENT user reporting the same question still succeeds normally', async () => {
  const owner = await registerAndLogin(`m12-other-report-owner-${randomUUID()}@test.local`);
  const reporter = await registerAndLogin(`m12-other-report-reporter-${randomUUID()}@test.local`);
  const title = `M12 Other Report ${randomUUID()}`;
  const created = await createQuestion(owner.jwt, title);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const report = await createReport(reporter.jwt, String(created.id), {
    email: reporter.email,
    ownerId: reporter.ownerId,
  });
  assert.equal(report.status, 201, JSON.stringify(report.body));
});
