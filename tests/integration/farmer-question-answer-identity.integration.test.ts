/**
 * "Çiftçiden Sorular" audit follow-up — Maddeler 1-3.
 *
 * Covers POST /hub-contents/farmer-questions/:questionId/answers
 * (hub-content.ts's addFarmerQuestionAnswer) and the farmer_question
 * domain added to POST /notifications/domain-event
 * (notification.ts's createDomainEvent):
 *
 *   Madde 1: the answer's author identity (name/city/profileId/email) is
 *   always the AUTHENTICATED caller's, server-derived -- never whatever
 *   the request body claims. The question's own ownerEmail/ownerProfileId
 *   and any PRE-EXISTING embedded answers are never touched/re-stamped.
 *
 *   Madde 2: each answer is its own row (a plain INSERT) -- two
 *   concurrent answers from different users both persist, and resending
 *   the identical answer (same client operationId) returns the original
 *   instead of creating a duplicate.
 *
 *   Madde 3: a real, cross-user answer/like notifies the question's REAL
 *   owner (loaded server-side, never the client's claim); a self-
 *   interaction never notifies; a retried identical answer never
 *   double-notifies; two DIFFERENT answers from the same person each
 *   notify once.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-farmer-question-answer-identity-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-farmer-question-answer-identity-test.db');
const PORT = 14178;
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

async function setDisplayName(jwt: string, displayName: string, city = 'Konya') {
  await fetch(`${BASE_URL}/profile-settings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { displayName, city } }),
  });
}

async function createFarmerQuestion(overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::hub-content.hub-content', {
    data: {
      kind: 'farmerQuestion',
      state: 'published',
      authorName: 'Test Ciftci',
      title: 'Test Soru',
      descShort: 'Kisa soru',
      body: JSON.stringify({ questionId: `fq_local_${randomUUID()}`, answers: [] }),
      content: 'Soru metni',
      likes: 0,
      comments: 0,
      commentCount: 0,
      engagementVersion: 0,
      ...overrides,
    },
  } as any);
}

const fetchRow = async (id: number | string) =>
  strapiInstance.db.query('api::hub-content.hub-content').findOne({ where: { id } } as any);

const answer = async (
  jwt: string,
  questionId: number | string,
  data: Record<string, unknown>,
) => {
  const res = await fetch(`${BASE_URL}/hub-contents/farmer-questions/${questionId}/answers`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const notificationsFor = async (ownerId: string) =>
  strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetProfileId: ownerId },
  } as any);

// Real like/unlike -- the SAME route EngagementStore.toggleLike's
// legacy-toggle path actually calls, writing a genuine
// engagement-interaction row (targetType='hub-content', kind='like').
// Used so the "sahte bildirim" tests below can prove the domain-event
// `like` notification now requires one of these to actually exist.
const toggleQuestionLike = async (jwt: string, questionId: number | string, liked: boolean) => {
  const res = await fetch(`${BASE_URL}/farmer-question-likes/toggle`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { questionId: String(questionId), liked } }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const domainEvent = async (
  jwt: string,
  payload: Record<string, unknown>,
) => {
  const res = await fetch(`${BASE_URL}/notifications/domain-event`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ---------------------------------------------------------------------
// Madde 1: server-verified answer identity
// ---------------------------------------------------------------------

test('Madde 1: answer author identity (name/profileId/email) is the authenticated caller\'s, server-derived, never the request body\'s claim', async () => {
  const askerJwt = await registerAndLogin(`fq-asker-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  const answererEmail = `fq-answerer-${randomUUID()}@test.local`;
  const answererJwt = await registerAndLogin(answererEmail);
  await setDisplayName(answererJwt, 'Gercek Cevaplayan');

  const { status, body } = await answer(answererJwt, question.id, {
    text: 'Gercek cevap metni',
    operationId: randomUUID(),
    // Spoofing attempt -- every one of these must be ignored.
    name: 'Sahte Isim',
    profileId: 'u_someone_else',
    email: 'victim@test.local',
  });

  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.name, 'Gercek Cevaplayan');
  assert.equal(body.data.email, answererEmail.toLowerCase());
  assert.notEqual(body.data.profileId, 'u_someone_else');
  assert.notEqual(body.data.name, 'Sahte Isim');
  assert.notEqual(body.data.email, 'victim@test.local');
});

test('Madde 1: cannot answer as another user even when claiming their exact real profileId/email', async () => {
  const victimEmail = `fq-victim-${randomUUID()}@test.local`;
  await registerAndLogin(victimEmail); // the real victim account exists
  const question = await createFarmerQuestion();
  const attackerJwt = await registerAndLogin(`fq-attacker-${randomUUID()}@test.local`);

  const { body } = await answer(attackerJwt, question.id, {
    text: 'Saldirgan cevabi',
    operationId: randomUUID(),
    email: victimEmail,
    profileId: `u_${victimEmail.replace(/[^a-z0-9]/g, '_')}`,
  });

  assert.notEqual(body.data.email, victimEmail.toLowerCase());
});

test('Madde 1: the question\'s own ownership fields are never changed by an answer', async () => {
  const askerJwt = await registerAndLogin(`fq-asker2-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion();
  const before = await fetchRow(question.id);
  const answererJwt = await registerAndLogin(`fq-answerer2-${randomUUID()}@test.local`);
  await answer(answererJwt, question.id, { text: 'Cevap', operationId: randomUUID() });
  const after = await fetchRow(question.id);
  assert.equal(after.ownerEmail, before.ownerEmail);
  assert.equal(after.ownerProfileId, before.ownerProfileId);
  assert.equal(after.kind, 'farmerQuestion');
});

test('Madde 1: a pre-existing embedded answer is never rewritten/re-stamped by a new answer', async () => {
  const legacyAnswer = { answerId: 'fa_legacy_1', text: 'Eski cevap', name: 'Eski Yazar', profileId: 'u_eski', email: 'eski@test.local' };
  const question = await createFarmerQuestion({
    body: JSON.stringify({ questionId: 'fq_legacy_q', answers: [legacyAnswer] }),
  });
  const answererJwt = await registerAndLogin(`fq-newanswerer-${randomUUID()}@test.local`);
  await answer(answererJwt, question.id, { text: 'Yeni cevap', operationId: randomUUID() });

  const row = await fetchRow(question.id);
  const body = JSON.parse(row.body);
  assert.deepEqual(body.answers, [legacyAnswer], 'the question row\'s own embedded legacy answer must be byte-for-byte unchanged');
});

// ---------------------------------------------------------------------
// Madde 2: concurrency + idempotency
// ---------------------------------------------------------------------

test('Madde 2: two concurrent answers from two different users BOTH persist (no lost update)', async () => {
  const question = await createFarmerQuestion();
  const jwtA = await registerAndLogin(`fq-concurrent-a-${randomUUID()}@test.local`);
  const jwtB = await registerAndLogin(`fq-concurrent-b-${randomUUID()}@test.local`);

  const [resA, resB] = await Promise.all([
    answer(jwtA, question.id, { text: 'Cevap A', operationId: randomUUID() }),
    answer(jwtB, question.id, { text: 'Cevap B', operationId: randomUUID() }),
  ]);
  assert.equal(resA.status, 200, JSON.stringify(resA.body));
  assert.equal(resB.status, 200, JSON.stringify(resB.body));
  assert.notEqual(resA.body.data.id, resB.body.data.id);

  const rows = await strapiInstance.db.query('api::hub-content.hub-content').findMany({
    where: { kind: 'farmerQuestionComment' },
  } as any);
  const texts = rows.map((r: any) => JSON.parse(r.body).text);
  assert.ok(texts.includes('Cevap A'), 'answer A must be persisted');
  assert.ok(texts.includes('Cevap B'), 'answer B must be persisted');
});

test('Madde 2: resubmitting the identical answer (same operationId) returns the original, does not create a duplicate row', async () => {
  const question = await createFarmerQuestion();
  const jwt = await registerAndLogin(`fq-retry-${randomUUID()}@test.local`);
  const operationId = randomUUID();
  const first = await answer(jwt, question.id, { text: 'Tekrar edilen cevap', operationId });
  const second = await answer(jwt, question.id, { text: 'Tekrar edilen cevap', operationId });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.data.id, second.body.data.id, 'a retry must return the SAME answer id, not a new one');

  const rows = await strapiInstance.db.query('api::hub-content.hub-content').findMany({
    where: { kind: 'farmerQuestionComment', operationId },
  } as any);
  assert.equal(rows.length, 1, 'exactly one row must exist for this operationId');
});

test('Madde 2: reusing an operationId with DIFFERENT content is rejected as a conflict', async () => {
  const question = await createFarmerQuestion();
  const jwt = await registerAndLogin(`fq-conflict-${randomUUID()}@test.local`);
  const operationId = randomUUID();
  await answer(jwt, question.id, { text: 'Ilk metin', operationId });
  const second = await answer(jwt, question.id, { text: 'Farkli metin', operationId });
  assert.equal(second.status, 400);
});

// ---------------------------------------------------------------------
// Validation: only a real, accessible farmerQuestion row may be answered
// ---------------------------------------------------------------------

test('a blog/knowledge-kind row cannot be "answered" as if it were a farmer question', async () => {
  const blogRow = await strapiInstance.entityService.create('api::hub-content.hub-content', {
    data: {
      kind: 'knowledge',
      state: 'published',
      authorName: 'Tarim 360',
      title: 'Blog Yazisi',
      descShort: 'Kisa',
      body: '{}',
      content: 'Blog icerigi',
    },
  } as any);
  const jwt = await registerAndLogin(`fq-wrongkind-${randomUUID()}@test.local`);
  const { status } = await answer(jwt, blogRow.id, { text: 'Spam', operationId: randomUUID() });
  assert.equal(status, 400);
});

test('a non-existent question id returns 404', async () => {
  const jwt = await registerAndLogin(`fq-missing-${randomUUID()}@test.local`);
  const { status } = await answer(jwt, 999999999, { text: 'x', operationId: randomUUID() });
  assert.equal(status, 404);
});

test('a deleted/archived question cannot be answered', async () => {
  const question = await createFarmerQuestion({ state: 'archived' });
  const jwt = await registerAndLogin(`fq-archived-${randomUUID()}@test.local`);
  const { status } = await answer(jwt, question.id, { text: 'x', operationId: randomUUID() });
  assert.equal(status, 404);
});

test('an unauthenticated answer attempt is rejected', async () => {
  const question = await createFarmerQuestion();
  const res = await fetch(`${BASE_URL}/hub-contents/farmer-questions/${question.id}/answers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { text: 'x', operationId: randomUUID() } }),
  });
  // Strapi's own auth middleware rejects a missing/invalid Authorization
  // header BEFORE the controller action ever runs -- 403, matching every
  // other "unauthenticated" assertion already established in this
  // codebase's own tests (e.g. farmer-question-engagement's "legacy
  // toggle: unauthenticated request is rejected").
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------
// Madde 3: notifications
// ---------------------------------------------------------------------

test('Madde 3: a real cross-user answer notifies the question\'s REAL owner, with the answer\'s own text as the message', async () => {
  const askerEmail = `fq-owner-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}` });
  const ownerId = question.ownerProfileId;
  const answererJwt = await registerAndLogin(`fq-answerer3-${randomUUID()}@test.local`);

  await answer(answererJwt, question.id, { text: 'Bu gercek cevap metni', operationId: randomUUID() });

  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 1, JSON.stringify(notifs));
  assert.equal(notifs[0].message, 'Bu gercek cevap metni');
  assert.equal(notifs[0].kind, 'comment');
  assert.equal(notifs[0].source, 'farmer_question');
});

test('Madde 3: answering your OWN question never notifies (self-interaction)', async () => {
  const askerEmail = `fq-self-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });

  await answer(askerJwt, question.id, { text: 'Kendi soruma cevap', operationId: randomUUID() });

  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 0, 'answering your own question must never notify yourself');
});

test('Madde 3: a retried identical answer never creates a second notification', async () => {
  const askerEmail = `fq-retrynotif-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });
  const answererJwt = await registerAndLogin(`fq-answerer4-${randomUUID()}@test.local`);
  const operationId = randomUUID();

  await answer(answererJwt, question.id, { text: 'Tekrarlanan', operationId });
  await answer(answererJwt, question.id, { text: 'Tekrarlanan', operationId });

  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 1, 'a retried answer must not produce a second notification');
});

test('Madde 3: two DIFFERENT answers from the same person each notify once (not collapsed into one)', async () => {
  const askerEmail = `fq-twoanswers-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });
  const answererJwt = await registerAndLogin(`fq-answerer5-${randomUUID()}@test.local`);

  await answer(answererJwt, question.id, { text: 'Birinci cevap', operationId: randomUUID() });
  await answer(answererJwt, question.id, { text: 'Ikinci cevap', operationId: randomUUID() });

  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 2, 'two distinct answers from the same person must each produce their own notification');
});

test('Madde 3: domain-event like notifies the real owner with the pre-existing product copy (includes question title)', async () => {
  const askerEmail = `fq-likeowner-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({
    ownerEmail: askerEmail.toLowerCase(),
    ownerProfileId: ownerId,
    title: 'Bugday ekimi ne zaman yapilir',
  });
  const likerJwt = await registerAndLogin(`fq-liker-${randomUUID()}@test.local`);

  const liked = await toggleQuestionLike(likerJwt, question.id, true);
  assert.equal(liked.status, 200, JSON.stringify(liked.body));
  const res = await domainEvent(likerJwt, { domain: 'farmer_question', event: 'like', entityId: String(question.id) });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 1);
  assert.ok(notifs[0].message.includes('Bugday ekimi ne zaman yapilir'));
  assert.ok(notifs[0].message.includes('sorunu beğendi'));
});

test('Madde 3: liking your OWN question never notifies', async () => {
  const askerEmail = `fq-selflike-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });

  await toggleQuestionLike(askerJwt, question.id, true);
  const res = await domainEvent(askerJwt, { domain: 'farmer_question', event: 'like', entityId: String(question.id) });
  const body = res.body;
  assert.equal(body.data.skipped, 'self');
  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 0);
});

// ---------------------------------------------------------------------
// "Sahte bildirim" follow-up: the domain-event endpoint must not let a
// caller manufacture a notification for an interaction that never
// actually happened.
// ---------------------------------------------------------------------

test('sahte bildirim: a domain-event like with NO real like interaction is rejected, no notification created', async () => {
  const askerEmail = `fq-fakelike-owner-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });
  const attackerJwt = await registerAndLogin(`fq-fakelike-attacker-${randomUUID()}@test.local`);

  // Never actually liked the question -- straight to the domain-event
  // call, exactly what a forged/replayed request would do.
  const res = await domainEvent(attackerJwt, { domain: 'farmer_question', event: 'like', entityId: String(question.id) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 0, 'no notification may be created for a like that never happened');
});

test('sahte bildirim: removing a like (unlike) deletes the real interaction row, so a later domain-event like is rejected too', async () => {
  const askerEmail = `fq-unlike-owner-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });
  const likerJwt = await registerAndLogin(`fq-unlike-liker-${randomUUID()}@test.local`);

  const liked = await toggleQuestionLike(likerJwt, question.id, true);
  assert.equal(liked.status, 200);
  const unliked = await toggleQuestionLike(likerJwt, question.id, false);
  assert.equal(unliked.status, 200, JSON.stringify(unliked.body));

  const res = await domainEvent(likerJwt, { domain: 'farmer_question', event: 'like', entityId: String(question.id) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 0, 'unliking then replaying a like domain-event must not produce a notification');
});

test('sahte bildirim: a domain-event `answer` call is rejected outright -- that event is server-to-server only', async () => {
  const askerEmail = `fq-fakeanswer-owner-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });
  const attackerJwt = await registerAndLogin(`fq-fakeanswer-attacker-${randomUUID()}@test.local`);

  const res = await domainEvent(attackerJwt, { domain: 'farmer_question', event: 'answer', entityId: String(question.id) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 0, 'a client must never be able to manufacture a fake "new answer" notification');
});

test('beğeni tekrarları: two DIFFERENT users each really liking the same question get their own separate notification, never collapsed into one', async () => {
  const askerEmail = `fq-twolikers-owner-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });
  const likerA = await registerAndLogin(`fq-twolikers-a-${randomUUID()}@test.local`);
  const likerB = await registerAndLogin(`fq-twolikers-b-${randomUUID()}@test.local`);

  await toggleQuestionLike(likerA, question.id, true);
  await toggleQuestionLike(likerB, question.id, true);
  const resA = await domainEvent(likerA, { domain: 'farmer_question', event: 'like', entityId: String(question.id) });
  const resB = await domainEvent(likerB, { domain: 'farmer_question', event: 'like', entityId: String(question.id) });
  assert.equal(resA.status, 200, JSON.stringify(resA.body));
  assert.equal(resB.status, 200, JSON.stringify(resB.body));

  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 2, 'the deterministic notificationId is keyed by the LIKER\'s own ownerId -- two different likers must never collapse onto one notification');
});

test('a domain-event like against a NON-farmerQuestion row id is rejected (kind check applies here too)', async () => {
  const blogRow = await strapiInstance.entityService.create('api::hub-content.hub-content', {
    data: { kind: 'knowledge', state: 'published', authorName: 'Tarim 360', title: 'Blog', descShort: 'x', body: '{}', content: 'x' },
  } as any);
  const jwt = await registerAndLogin(`fq-spoofkind-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/notifications/domain-event`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ domain: 'farmer_question', event: 'like', entityId: String(blogRow.id) }),
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------
// Regression: existing listing/profile domain-event notifications and
// the pre-existing generic hub-content create/update/engagement flows
// are unaffected by this phase's changes.
// ---------------------------------------------------------------------

test('regression: listing domain-event notifications still work unchanged', async () => {
  const listing = await strapiInstance.entityService.create('api::listing.listing', {
    data: {
      title: 'Test ilan', status: 'published', mainType: 'tarim', mode: 'sell', price: 10,
      ownerEmail: `fq-listingowner-${randomUUID()}@test.local`.toLowerCase(),
      ownerProfileId: 'u_listing_owner_fixed',
      ownerId: 'u_listing_owner_fixed',
      listingNo: Math.floor(Math.random() * 1000000),
      listingStatus: 'active',
    },
  } as any);
  const jwt = await registerAndLogin(`fq-listingliker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/notifications/domain-event`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ domain: 'listing', event: 'like', entityId: String(listing.id) }),
  });
  assert.equal(res.status, 200);
  const notifs = await notificationsFor('u_listing_owner_fixed');
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].listingId, String(listing.id));
});

test('regression: generic hub-content create still server-stamps ownerEmail/ownerProfileId for an ordinary (non-founder-restricted) post', async () => {
  const jwt = await registerAndLogin(`fq-bloggerreg-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { kind: 'post', state: 'published', authorName: 'x', title: 'y', descShort: 'z', body: '{}', content: 'c' } }),
  });
  // Strapi's standard core create() returns 201, not 200.
  assert.equal(res.status, 201, JSON.stringify(await res.clone().json().catch(() => ({}))));
  const body = await res.json();
  assert.ok(body.data.ownerEmail, 'ownerEmail must still be server-stamped for a regular create');
});

// ---------------------------------------------------------------------
// "Eski cevap ekleme yolu" follow-up: the OLD generic PUT /hub-contents/
// :id must no longer be usable to forge/alter a farmerQuestion(Comment)
// row's `body` (where each answer's own name/profileId/email lives) as
// a non-owner, now that the dedicated answer endpoint is the only
// legitimate way to add one.
// ---------------------------------------------------------------------

const putHubContent = async (jwt: string, id: number | string, data: Record<string, unknown>) => {
  const res = await fetch(`${BASE_URL}/hub-contents/${id}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const getHubContent = async (id: number | string, jwt?: string) => {
  const res = await fetch(`${BASE_URL}/hub-contents/${id}`, {
    method: 'GET',
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

test('eski cevap yolu: a non-owner can no longer forge the body/answers JSON via the old generic PUT (title/descShort left unchanged)', async () => {
  const askerJwt = await registerAndLogin(`fq-oldputowner-${randomUUID()}@test.local`);
  const question = await createFarmerQuestion({
    title: 'Degismemesi gereken baslik',
    descShort: 'Degismemesi gereken ozet',
  });
  const before = await fetchRow(question.id);
  const attackerJwt = await registerAndLogin(`fq-oldputattacker-${randomUUID()}@test.local`);

  const forgedBody = JSON.stringify({
    questionId: `fq_local_${question.id}`,
    answers: [{ answerId: 'fa_forged', text: 'Sahte cevap', name: 'Sahte Yazar', profileId: 'u_victim', email: 'victim@test.local' }],
  });
  // Strapi 5's core PUT route resolves by documentId, not the raw
  // numeric id (the write-guard POLICY's own loadEntityByRouteId
  // tolerates either, which is why this would still 403 either way --
  // documentId is used here to match the real client's own request
  // shape exactly).
  const { status } = await putHubContent(attackerJwt, question.documentId, { body: forgedBody });

  assert.equal(status, 403, 'a non-owner PUT that changes `body` must now be rejected outright for a farmerQuestion row');
  const after = await fetchRow(question.id);
  assert.equal(after.body, before.body, 'the row\'s body must be completely unchanged after the rejected PUT');
});

test('eski cevap yolu: a non-owner reaction-only PUT (e.g. commentCount) on a farmerQuestion row is still allowed, unaffected by the tightened guard', async () => {
  const question = await createFarmerQuestion();
  const nonOwnerJwt = await registerAndLogin(`fq-oldputreactor-${randomUUID()}@test.local`);

  const { status, body } = await putHubContent(nonOwnerJwt, question.documentId, { commentCount: 5 });
  assert.equal(status, 200, JSON.stringify(body));
});

test('eski cevap yolu (kalan sınır): a non-owner reaction-only update cannot smuggle in a state/ownership/body change alongside allowed fields', async () => {
  const question = await createFarmerQuestion();
  const before = await fetchRow(question.id);
  const nonOwnerJwt = await registerAndLogin(`fq-smuggle-${randomUUID()}@test.local`);

  const { status } = await putHubContent(nonOwnerJwt, question.documentId, {
    commentCount: 5, // allowed alone
    state: 'archived', // NOT allowed -- visibility change
  });
  assert.equal(status, 403, 'a mixed payload with even one non-reaction field must be rejected outright');
  const after = await fetchRow(question.id);
  assert.equal(after.state, before.state, 'state must be completely unchanged');
});

test('eski cevap yolu (kalan sınır): the QUESTION OWNER cannot rewrite an EXISTING embedded answer\'s authorship via the old generic PUT', async () => {
  const askerEmail = `fq-ownerforge-asker-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const realAnswer = { answerId: 'fa_real_1', text: 'Gercek cevap', name: 'Gercek Cevaplayan', profileId: 'u_real_answerer', email: 'real@test.local' };
  const question = await createFarmerQuestion({
    ownerEmail: askerEmail.toLowerCase(),
    ownerProfileId: ownerId,
    body: JSON.stringify({ questionId: 'fq_ownerforge', answers: [realAnswer] }),
  });

  // The OWNER (not a non-owner) tries to rewrite the existing answer's
  // own name/profileId/email while resending everything else unchanged
  // -- exactly the shape farmer_questions_repo.dart's own legitimate
  // background cleanup resend would have, except with forged content.
  const forgedAnswer = { ...realAnswer, name: 'Sahte Isim', profileId: 'u_victim', email: 'victim@test.local' };
  const forgedBody = JSON.stringify({ questionId: 'fq_ownerforge', answers: [forgedAnswer] });
  const { status } = await putHubContent(askerJwt, question.documentId, { body: forgedBody });

  assert.equal(status, 403, 'the owner must not be able to rewrite an existing answer\'s own authorship');
  const after = await fetchRow(question.id);
  assert.ok(after.body.includes('Gercek Cevaplayan'), 'the real answer\'s authorship must survive untouched');
  assert.ok(!after.body.includes('Sahte Isim'));
});

test('eski cevap yolu (kalan sınır): the owner CAN still remove an answer (legitimate cleanup) -- dropping an answerId is not "rewriting" it', async () => {
  const askerEmail = `fq-ownercleanup-asker-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const keepAnswer = { answerId: 'fa_keep', text: 'Kalan cevap', name: 'Kalan', profileId: 'u_keep', email: 'keep@test.local' };
  const dropAnswer = { answerId: 'fa_drop', text: 'Silinecek cevap', name: 'Silinen', profileId: 'u_drop', email: 'drop@test.local' };
  const question = await createFarmerQuestion({
    ownerEmail: askerEmail.toLowerCase(),
    ownerProfileId: ownerId,
    body: JSON.stringify({ questionId: 'fq_ownercleanup', answers: [keepAnswer, dropAnswer] }),
  });

  const newBody = JSON.stringify({ questionId: 'fq_ownercleanup', answers: [keepAnswer] });
  const { status, body } = await putHubContent(askerJwt, question.documentId, { body: newBody });
  assert.equal(status, 200, JSON.stringify(body));
  const after = await fetchRow(question.id);
  assert.ok(after.body.includes('fa_keep'));
  assert.ok(!after.body.includes('fa_drop'));
});

// ---------------------------------------------------------------------
// "Sahte bildirim" kalan sınır: the like-notification check must match
// the SPECIFIC question, not just "this person liked something".
// ---------------------------------------------------------------------

test('sahte bildirim (kalan sınır): liking question A does not authorize a domain-event like claim for question B', async () => {
  const ownerAEmail = `fq-crossq-ownerA-${randomUUID()}@test.local`;
  await registerAndLogin(ownerAEmail);
  const ownerAId = `u_${ownerAEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const questionA = await createFarmerQuestion({ ownerEmail: ownerAEmail.toLowerCase(), ownerProfileId: ownerAId });

  const ownerBEmail = `fq-crossq-ownerB-${randomUUID()}@test.local`;
  await registerAndLogin(ownerBEmail);
  const ownerBId = `u_${ownerBEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const questionB = await createFarmerQuestion({ ownerEmail: ownerBEmail.toLowerCase(), ownerProfileId: ownerBId });

  const likerJwt = await registerAndLogin(`fq-crossq-liker-${randomUUID()}@test.local`);
  const liked = await toggleQuestionLike(likerJwt, questionA.id, true);
  assert.equal(liked.status, 200);

  // Real like is on A; domain-event claims B.
  const res = await domainEvent(likerJwt, { domain: 'farmer_question', event: 'like', entityId: String(questionB.id) });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  const notifsB = await notificationsFor(ownerBId);
  assert.equal(notifsB.length, 0, 'B must not be notified for a like that was actually on A');
});

// ---------------------------------------------------------------------
// Database-level concurrency/idempotency (true races, not sequential
// awaits) -- and operationId scoping across users/questions.
// ---------------------------------------------------------------------

test('eşzamanlılık (DB-level): the SAME operationId submitted truly concurrently (Promise.all) creates exactly one row', async () => {
  const question = await createFarmerQuestion();
  const jwt = await registerAndLogin(`fq-raceop-${randomUUID()}@test.local`);
  const operationId = randomUUID();

  const [r1, r2] = await Promise.all([
    answer(jwt, question.id, { text: 'Yarisan cevap', operationId }),
    answer(jwt, question.id, { text: 'Yarisan cevap', operationId }),
  ]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r1.body.data.id, r2.body.data.id, 'both concurrent responses must agree on the SAME winning answer id');

  const rows = await strapiInstance.db.query('api::hub-content.hub-content').findMany({
    where: { kind: 'farmerQuestionComment', operationId },
  } as any);
  assert.equal(rows.length, 1, 'the DB unique constraint must allow exactly one row to win the race, not two');
});

test('operationId kapsamı: the same operationId reused by a DIFFERENT user is rejected as a conflict, never returns the first user\'s answer', async () => {
  const question = await createFarmerQuestion();
  const jwtA = await registerAndLogin(`fq-opscope-a-${randomUUID()}@test.local`);
  const jwtB = await registerAndLogin(`fq-opscope-b-${randomUUID()}@test.local`);
  const operationId = randomUUID();

  const first = await answer(jwtA, question.id, { text: 'Ayni metin', operationId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await answer(jwtB, question.id, { text: 'Ayni metin', operationId });

  assert.equal(second.status, 400, 'a different actor reusing the operationId must conflict, not silently succeed');
  assert.ok(!second.body?.data, 'a rejected conflict must never hand back user A\'s answer data to user B');
});

test('operationId kapsamı: the same operationId reused by the SAME user on a DIFFERENT question is rejected as a conflict', async () => {
  const questionX = await createFarmerQuestion();
  const questionY = await createFarmerQuestion();
  const jwt = await registerAndLogin(`fq-opscope-q-${randomUUID()}@test.local`);
  const operationId = randomUUID();

  const first = await answer(jwt, questionX.id, { text: 'Ayni metin', operationId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await answer(jwt, questionY.id, { text: 'Ayni metin', operationId });

  assert.equal(second.status, 400, 'the same operationId on a DIFFERENT question must conflict, never return question X\'s answer for question Y');
});

test('eşzamanlılık (DB-level): the SAME domain-event like request fired truly concurrently (Promise.all) produces exactly one notification', async () => {
  const askerEmail = `fq-raceevent-owner-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({ ownerEmail: askerEmail.toLowerCase(), ownerProfileId: ownerId });
  const likerJwt = await registerAndLogin(`fq-raceevent-liker-${randomUUID()}@test.local`);
  await toggleQuestionLike(likerJwt, question.id, true);

  const [r1, r2] = await Promise.all([
    domainEvent(likerJwt, { domain: 'farmer_question', event: 'like', entityId: String(question.id) }),
    domainEvent(likerJwt, { domain: 'farmer_question', event: 'like', entityId: String(question.id) }),
  ]);
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r2.status, 200, JSON.stringify(r2.body));

  const notifs = await notificationsFor(ownerId);
  assert.equal(notifs.length, 1, 'a true concurrent double-fire of the identical event must still only notify once');
});

// ---------------------------------------------------------------------
// Erişim kontrolü kalan sınır: hiding/archiving a row at the APP layer
// (farmer_questions_repo.dart's own client-side filtering) is not a
// security boundary by itself -- the SERVER must refuse to serve a
// hidden/archived/deleted row to a direct GET, not just rely on the
// client choosing not to display it.
// ---------------------------------------------------------------------

test('erişim kontrolü (kalan sınır): a direct GET of an ARCHIVED farmerQuestion row is rejected by the SERVER (404), not just hidden client-side', async () => {
  const askerEmail = `fq-hiddenget-asker-${randomUUID()}@test.local`;
  await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({
    ownerEmail: askerEmail.toLowerCase(),
    ownerProfileId: ownerId,
    state: 'archived',
  });
  const strangerJwt = await registerAndLogin(`fq-hiddenget-stranger-${randomUUID()}@test.local`);

  const viaStranger = await getHubContent(question.documentId, strangerJwt);
  assert.equal(viaStranger.status, 404, JSON.stringify(viaStranger.body));
  assert.ok(!viaStranger.body?.data, 'an archived row\'s data must never be present in the response body');

  const viaAnonymous = await getHubContent(question.documentId);
  assert.equal(viaAnonymous.status, 404, 'an unauthenticated direct GET must be rejected exactly the same way');
});

test('erişim kontrolü (kalan sınır): a direct GET of a DELETED-state farmerQuestion row is rejected by the SERVER (404)', async () => {
  const question = await createFarmerQuestion({ state: 'deleted' });
  const jwt = await registerAndLogin(`fq-hiddenget-deleted-${randomUUID()}@test.local`);
  const res = await getHubContent(question.documentId, jwt);
  assert.equal(res.status, 404, JSON.stringify(res.body));
});

test('erişim kontrolü: the OWNER can still GET their own archived row directly (not locked out of their own content)', async () => {
  const askerEmail = `fq-hiddenget-ownerview-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({
    ownerEmail: askerEmail.toLowerCase(),
    ownerProfileId: ownerId,
    state: 'archived',
  });
  const res = await getHubContent(question.documentId, askerJwt);
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

test('erişim kontrolü: a direct GET of an ordinary PUBLISHED farmerQuestion row still works for anyone (no over-blocking)', async () => {
  const question = await createFarmerQuestion({ title: 'Herkese acik normal soru' });
  const res = await getHubContent(question.documentId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body?.data?.title, 'Herkese acik normal soru');
});

// ---------------------------------------------------------------------
// Eski cevap yolu kalan sınır: the OWNER must not be able to ADD a brand
// new fake answer (not just rewrite/duplicate an existing one) via the
// old generic PUT, and must not be able to duplicate a real answerer's
// identity onto a new entry either.
// ---------------------------------------------------------------------

test('eski cevap yolu (kalan sınır): the owner cannot ADD a brand-new fake answer via the old generic PUT (only removal is allowed)', async () => {
  const askerEmail = `fq-ownerfakenew-asker-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const question = await createFarmerQuestion({
    ownerEmail: askerEmail.toLowerCase(),
    ownerProfileId: ownerId,
    body: JSON.stringify({ questionId: 'fq_ownerfakenew', answers: [] }),
  });

  const fakeNewAnswer = { answerId: 'fa_totally_fake', text: 'Uydurma cevap', name: 'Uydurma Kisi', profileId: 'u_fake', email: 'fake@test.local' };
  const forgedBody = JSON.stringify({ questionId: 'fq_ownerfakenew', answers: [fakeNewAnswer] });
  const { status } = await putHubContent(askerJwt, question.documentId, { body: forgedBody });

  assert.equal(status, 403, 'the owner must not be able to inject a brand-new answer this way');
  const after = await fetchRow(question.id);
  assert.ok(!after.body.includes('fa_totally_fake'));
});

test('eski cevap yolu (kalan sınır): the owner cannot duplicate a real answerer\'s identity onto a second, different answerId', async () => {
  const askerEmail = `fq-ownerdupe-asker-${randomUUID()}@test.local`;
  const askerJwt = await registerAndLogin(askerEmail);
  const ownerId = `u_${askerEmail.replace(/[^a-z0-9]/g, '_').toLowerCase()}`;
  const realAnswer = { answerId: 'fa_real_dupe_1', text: 'Gercek cevap', name: 'Gercek Kisi', profileId: 'u_real_dupe', email: 'realdupe@test.local' };
  const question = await createFarmerQuestion({
    ownerEmail: askerEmail.toLowerCase(),
    ownerProfileId: ownerId,
    body: JSON.stringify({ questionId: 'fq_ownerdupe', answers: [realAnswer] }),
  });

  // Same real identity (name/profileId/email), but attached to a SECOND,
  // brand-new answerId -- "aynı kimliği çoğaltma".
  const duplicatedAnswer = { ...realAnswer, answerId: 'fa_duplicate_of_real' };
  const forgedBody = JSON.stringify({
    questionId: 'fq_ownerdupe',
    answers: [realAnswer, duplicatedAnswer],
  });
  const { status } = await putHubContent(askerJwt, question.documentId, { body: forgedBody });

  assert.equal(status, 403, 'duplicating a real answerer\'s identity onto a new answerId must be rejected');
  const after = await fetchRow(question.id);
  assert.ok(!after.body.includes('fa_duplicate_of_real'));
});
