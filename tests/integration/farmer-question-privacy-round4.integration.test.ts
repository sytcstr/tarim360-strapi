/**
 * Soru/Profil/Kart denetimi (2026-10-25) — Çiftçi Sorulari Madde 1-4.
 *
 * Round-4 targeted, empirical checks against the REAL Strapi controller
 * code (not a theoretical claim) for exactly the four privacy/identity
 * items this pass was scoped to:
 *
 *  1) GET /hub-contents (list) must not return a hidden/archived/deleted
 *     farmerQuestion row to a non-owner (findOne already did; find did
 *     not -- confirmed by reading hub-content.ts before this fix).
 *  2) A published (visible) farmerQuestion's/farmerQuestionComment's own
 *     embedded email field(s) inside `body` must not reach a non-owner
 *     caller via find OR findOne, including a legacy-shaped embedded
 *     answers[] array.
 *  3) A client-supplied authorEmail/authorProfileId in a farmerQuestion's
 *     body at create time must have no effect -- the real, authenticated
 *     identity always wins.
 *  4) Same as (3) for a farmerQuestionReport's reporterEmail/
 *     reporterProfileId.
 *
 * Also includes a narrow regression check that an ordinary ("general")
 * hub-content row -- standing in for blog/Knowledge Hub content sharing
 * the same table/body field -- is completely unaffected by any of this.
 *
 * Run only this file:
 *   npx tsx --test tests/integration/farmer-question-privacy-round4.integration.test.ts
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-farmer-privacy-r4-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-farmer-privacy-r4-test.db');
const PORT = 14234;
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
const anon = () => ({ 'content-type': 'application/json' });

async function createHubContent(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  return { status: res.status, documentId: json?.data?.documentId, body: json };
}

async function listHubContents(headers: Record<string, string>, kind: string) {
  const res = await fetch(
    `${BASE_URL}/hub-contents?filters[kind][$eq]=${encodeURIComponent(kind)}&pagination[limit]=100`,
    { headers },
  );
  const json = await res.json();
  return { status: res.status, rows: Array.isArray(json?.data) ? json.data : [] };
}

async function getHubContent(headers: Record<string, string>, documentId: string) {
  const res = await fetch(`${BASE_URL}/hub-contents/${documentId}`, { headers });
  const json = await res.json();
  return { status: res.status, row: json?.data };
}

async function updateHubContent(jwt: string, documentId: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/hub-contents/${documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  return { status: res.status, body: json };
}

function parseBody(row: any): Record<string, unknown> {
  try {
    return JSON.parse(String(row?.body ?? '{}'));
  } catch (_) {
    return {};
  }
}

// ============================================================
// Madde 1: hidden/archived/deleted row must not appear via LIST either.
// ============================================================
test('Madde 1: a HIDDEN farmerQuestion is excluded from the public LIST for a non-owner, but still visible to its real owner', async () => {
  const owner = await registerAndLogin(`r4m1-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m1-stranger-${randomUUID()}@test.local`);
  const uniqueTitle = `Gizli Soru ${randomUUID()}`;

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Test Ciftci',
    title: uniqueTitle,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  // Simulate moderation hiding it (archived/removed/blocked/etc. all match
  // isDeletedOrHiddenState's substring rule -- using 'archived' here).
  await strapiInstance.db.query('api::hub-content.hub-content').update({
    where: { documentId },
    data: { state: 'archived' },
  } as any);

  const asStranger = await listHubContents(authed(stranger.jwt), 'farmerQuestion');
  const strangerSeesIt = asStranger.rows.some((r: any) => r.documentId === documentId);
  console.log(`Madde1: stranger list sees hidden row? -> ${strangerSeesIt} (rows=${asStranger.rows.length})`);
  assert.equal(strangerSeesIt, false, 'a hidden row must not appear in the public list for a non-owner');

  const asAnon = await listHubContents(anon(), 'farmerQuestion');
  const anonSeesIt = asAnon.rows.some((r: any) => r.documentId === documentId);
  assert.equal(anonSeesIt, false, 'a hidden row must not appear in the public list for an anonymous caller either');

  const asOwner = await listHubContents(authed(owner.jwt), 'farmerQuestion');
  const ownerSeesIt = asOwner.rows.some((r: any) => r.documentId === documentId);
  assert.equal(ownerSeesIt, true, "the row's real owner must still see their own hidden row in their own list");
});

test('Madde 1 (kapanış kontrolü): every legacy/alternate hidden-state spelling isDeletedOrHiddenState recognizes is ALSO excluded from the LIST endpoint, not just findOne', async () => {
  const owner = await registerAndLogin(`r4m1e-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m1e-stranger-${randomUUID()}@test.local`);
  const uniqueTag = randomUUID();
  // Same legacy/alternate state spellings already covered for findOne in
  // farmer-question-answer-identity.integration.test.ts ("erişim kontrolü
  // (kalan sınır)" tests, 'archived'/'deleted') plus the other substrings
  // isDeletedOrHiddenState itself recognizes.
  const hiddenStates = ['archived', 'deleted', 'blocked', 'removed', 'hidden', 'draft', 'unpublished'];

  for (const state of hiddenStates) {
    const created = await createHubContent(owner.jwt, {
      kind: 'farmerQuestion',
      state,
      authorName: 'Test Ciftci',
      title: `Legacy Durum ${state} ${uniqueTag}`,
      descShort: 'Kisa soru',
      body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
      content: 'Soru metni',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const documentId = created.documentId as string;

    const asStranger = await listHubContents(authed(stranger.jwt), 'farmerQuestion');
    const seen = asStranger.rows.some((r: any) => r.documentId === documentId);
    console.log(`Madde1 kontrol: state="${state}" visible in list for a stranger? -> ${seen}`);
    assert.equal(seen, false, `a row with state="${state}" must be excluded from the list for a non-owner, exactly like findOne already excludes it`);
  }
});

test('Madde 1 (regresyon): a PUBLISHED farmerQuestion is still visible to everyone via list (no over-filtering)', async () => {
  const owner = await registerAndLogin(`r4m1b-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m1b-stranger-${randomUUID()}@test.local`);

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Test Ciftci',
    title: `Acik Soru ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201);
  const documentId = created.documentId as string;

  const asStranger = await listHubContents(authed(stranger.jwt), 'farmerQuestion');
  const seen = asStranger.rows.some((r: any) => r.documentId === documentId);
  assert.equal(seen, true, 'a published row must remain visible to a non-owner via list');
});

test('Madde 1 (kapanış kontrolü): the query visibility filter only inspects the `state` column -- a PUBLISHED question whose title/detail text happens to contain "arşiv"/"silindi" stays fully visible', async () => {
  const owner = await registerAndLogin(`r4m1d-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m1d-stranger-${randomUUID()}@test.local`);
  const uniqueTag = randomUUID();

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Test Ciftci',
    title: `Domates yapraklarim silindi mi arsivlenmeli mi ${uniqueTag}`,
    descShort: 'Bu soru metninde "silindi", "arsiv", "blocked", "removed", "hidden", "draft", "unpublish" kelimeleri gecebilir',
    body: JSON.stringify({
      questionId: `local_${randomUUID()}`,
      answers: [],
      question:
        'Domatesimin yapraklari silindi/arsivlendi/blocked/removed/hidden/draft/unpublish gibi kelimeler icerse de bu soru hala published durumda.',
    }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  const listAsStranger = await listHubContents(authed(stranger.jwt), 'farmerQuestion');
  const seenInList = listAsStranger.rows.some((r: any) => r.documentId === documentId);
  console.log(`Madde1 kontrol: published row with "silindi"/"arsiv" in its TEXT visible in list for a stranger? -> ${seenInList}`);
  assert.equal(seenInList, true, 'the visibility filter must only check the `state` column, never title/descShort/body free text');

  const singleAsStranger = await getHubContent(authed(stranger.jwt), documentId);
  console.log('Madde1 kontrol: findOne status for the same row ->', singleAsStranger.status);
  assert.equal(singleAsStranger.status, 200, 'findOne must also remain reachable -- the hidden-keyword text must not accidentally trigger the hidden-state rule');
});

test('Madde 1 (regresyon, paylaşılan yapı): a hidden ORDINARY ("general"/blog-like) hub-content row is also excluded from list for a non-owner -- same generic rule, not farmer-question-specific', async () => {
  const owner = await registerAndLogin(`r4m1c-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m1c-stranger-${randomUUID()}@test.local`);

  const created = await createHubContent(owner.jwt, {
    kind: 'general',
    state: 'published',
    authorName: 'Test Kullanici',
    title: `Genel Gonderi ${randomUUID()}`,
    descShort: 'Kisa aciklama',
    body: 'Govde metni (JSON degil, duz metin)',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  const beforeHide = await listHubContents(authed(stranger.jwt), 'general');
  assert.equal(
    beforeHide.rows.some((r: any) => r.documentId === documentId),
    true,
    'sanity: a published general post is visible before hiding',
  );

  await strapiInstance.db.query('api::hub-content.hub-content').update({
    where: { documentId },
    data: { state: 'archived' },
  } as any);

  const afterHide = await listHubContents(authed(stranger.jwt), 'general');
  assert.equal(
    afterHide.rows.some((r: any) => r.documentId === documentId),
    false,
    'a hidden general/blog-like row must also be excluded from list for a non-owner',
  );
  // Plain-text (non-JSON) body must survive untouched for this non-farmer kind.
  const stillThereForOwner = await listHubContents(authed(owner.jwt), 'general');
  const ownRow = stillThereForOwner.rows.find((r: any) => r.documentId === documentId);
  assert.equal(ownRow?.body, 'Govde metni (JSON degil, duz metin)', "a non-farmer kind's plain-text body must be untouched");
});

// ============================================================
// Madde 2: email fields inside `body` must not leak to a non-owner, via
// EITHER list or single-row read -- even for ordinary PUBLISHED content.
// ============================================================
test('Madde 2: a PUBLISHED farmerQuestion\'s body.authorEmail is hidden from a non-owner (list + findOne), but visible to its real owner', async () => {
  const owner = await registerAndLogin(`r4m2-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m2-stranger-${randomUUID()}@test.local`);

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Test Ciftci',
    title: `E-posta Testi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({
      questionId: `local_${randomUUID()}`,
      authorEmail: owner.email,
      authorProfileId: owner.ownerId,
      answers: [],
    }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201);
  const documentId = created.documentId as string;

  const listAsStranger = await listHubContents(authed(stranger.jwt), 'farmerQuestion');
  const rowInList = listAsStranger.rows.find((r: any) => r.documentId === documentId);
  assert.ok(rowInList, 'sanity: published row must appear in the list');
  const bodyInList = parseBody(rowInList);
  console.log('Madde2 list (non-owner) body ->', JSON.stringify(bodyInList));
  assert.equal(bodyInList.authorEmail, undefined, 'authorEmail must be stripped from the LIST response for a non-owner');

  const singleAsStranger = await getHubContent(authed(stranger.jwt), documentId);
  const bodySingle = parseBody(singleAsStranger.row);
  console.log('Madde2 findOne (non-owner) body ->', JSON.stringify(bodySingle));
  assert.equal(bodySingle.authorEmail, undefined, 'authorEmail must be stripped from the FINDONE response for a non-owner');

  const singleAsOwner = await getHubContent(authed(owner.jwt), documentId);
  const bodyOwner = parseBody(singleAsOwner.row);
  assert.equal(bodyOwner.authorEmail, owner.email, "the real owner must still see their OWN authorEmail unchanged");
});

test('Madde 2: a standalone answer row\'s body.email is hidden from a non-owner, visible to the answerer', async () => {
  const asker = await registerAndLogin(`r4m2b-asker-${randomUUID()}@test.local`);
  const answerer = await registerAndLogin(`r4m2b-answerer-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m2b-stranger-${randomUUID()}@test.local`);

  const question = await createHubContent(asker.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Soran',
    title: `Cevap E-posta Testi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(question.status, 201);
  const questionId = question.documentId as string;

  const answerRes = await fetch(`${BASE_URL}/hub-contents/farmer-questions/${questionId}/answers`, {
    method: 'POST',
    headers: authed(answerer.jwt),
    body: JSON.stringify({ data: { text: 'Bu bir test cevabidir.', operationId: randomUUID() } }),
  });
  const answerJson = await answerRes.json();
  assert.equal(answerRes.status, 200, JSON.stringify(answerJson));

  const listAsStranger = await listHubContents(authed(stranger.jwt), 'farmerQuestionComment');
  assert.ok(listAsStranger.rows.length > 0, 'sanity: at least one answer row must be listed');
  for (const row of listAsStranger.rows) {
    const b = parseBody(row);
    assert.equal(b.email, undefined, 'a standalone answer row must never expose body.email to a non-owner via list');
  }

  const listAsAnswerer = await listHubContents(authed(answerer.jwt), 'farmerQuestionComment');
  const ownRow = listAsAnswerer.rows.find((r: any) => parseBody(r).text === 'Bu bir test cevabidir.');
  assert.ok(ownRow, 'the answerer must see their own answer row in their own list');
  assert.equal(parseBody(ownRow).email, answerer.email, "the real answerer must still see their OWN email unchanged");
});

test('Madde 2/3: a legacy-shaped embedded answers[].email is stripped for a non-owner AND for the question\'s OWN owner (per-answerer isolation, not row-ownership)', async () => {
  const owner = await registerAndLogin(`r4m2c-owner-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`r4m2c-stranger-${randomUUID()}@test.local`);
  const realAnswerer = await registerAndLogin(`r4m2c-answerer-${randomUUID()}@test.local`);

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Test Ciftci',
    title: `Gomulu Cevap Testi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201);
  const documentId = created.documentId as string;

  // Simulate a pre-existing legacy row whose answers are embedded directly
  // in the question's own body (the shape this app's read path already
  // merges/dedups against standalone answer rows). The embedded answer's
  // real author is `realAnswerer` -- a DIFFERENT real identity than the
  // question's own owner.
  await strapiInstance.db.query('api::hub-content.hub-content').update({
    where: { documentId },
    data: {
      body: JSON.stringify({
        questionId: `local_${randomUUID()}`,
        answers: [
          {
            answerId: 'fa_legacy_1',
            name: 'Eski Cevaplayan',
            city: 'Konya',
            text: 'Eski cevap',
            email: realAnswerer.email,
            profileId: realAnswerer.ownerId,
          },
        ],
      }),
    },
  } as any);

  const singleAsStranger = await getHubContent(authed(stranger.jwt), documentId);
  const emailForStranger = (parseBody(singleAsStranger.row) as any)?.answers?.[0]?.email;
  console.log('Madde2c embedded answer email (stranger) ->', emailForStranger);
  assert.equal(emailForStranger, undefined, "an embedded legacy answer's email must be stripped for a non-owner stranger");

  // Madde 3 -- the core closure: the QUESTION OWNER must NOT see the
  // embedded answerer's email just because they own the question row.
  const singleAsQuestionOwner = await getHubContent(authed(owner.jwt), documentId);
  const bodyForOwner = parseBody(singleAsQuestionOwner.row) as any;
  console.log('Madde3 embedded answer email (question owner, NOT the answerer) ->', bodyForOwner?.answers?.[0]?.email);
  assert.equal(
    bodyForOwner?.answers?.[0]?.email,
    undefined,
    "the question owner must NOT see an embedded answer's email just because they own the question -- only the real answerer may",
  );
  assert.equal(bodyForOwner?.answers?.[0]?.text, 'Eski cevap', 'the rest of the embedded answer must survive untouched');

  // The REAL answerer, reading the SAME question row (e.g. via the thread
  // view), must still see their OWN embedded email.
  const singleAsRealAnswerer = await getHubContent(authed(realAnswerer.jwt), documentId);
  const bodyForRealAnswerer = parseBody(singleAsRealAnswerer.row) as any;
  console.log('Madde3 embedded answer email (the real answerer) ->', bodyForRealAnswerer?.answers?.[0]?.email);
  assert.equal(
    bodyForRealAnswerer?.answers?.[0]?.email,
    realAnswerer.email,
    'the real answerer must still see their OWN embedded email, even though they do not own the parent question row',
  );
});

async function createOwnProfileSetting(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/profile-settings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  const json = await res.json();
  return { status: res.status, profile: json?.data };
}

// ============================================================
// Madde 1 (round 2) + Madde 3: client-supplied authorEmail/
// authorProfileId/authorName/authorCity/authorAvatarUrl at create time
// must have no effect -- the real identity AND that identity's own real
// profile-setting row always win. No profile -> a safe, self-derived
// fallback (never another identity).
// ============================================================
test('Madde 1/3: with a real profile-setting row, authorName/City/AvatarUrl are derived from it, ignoring spoofed values', async () => {
  const realAsker = await registerAndLogin(`r4m3a-real-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`r4m3a-victim-${randomUUID()}@test.local`);

  const profileRes = await createOwnProfileSetting(realAsker.jwt, {
    displayName: 'Gercek Ad Soyad',
    city: 'Konya',
  });
  assert.equal(profileRes.status, 201, JSON.stringify(profileRes.profile));
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { profileId: realAsker.ownerId },
    data: { avatarUrl: 'https://example.test/real-avatar.png' },
  } as any);

  const created = await createHubContent(realAsker.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Sahte Isim',
    title: `Kimlik Taklidi Testi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({
      questionId: `local_${randomUUID()}`,
      authorEmail: victim.email,
      authorProfileId: victim.ownerId,
      authorName: 'Sahte Isim Body',
      authorCity: 'Sahte Sehir',
      authorAvatarUrl: 'https://attacker.test/victim-looking-photo.png',
      answers: [],
    }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  const asOwner = await getHubContent(authed(realAsker.jwt), documentId);
  const body = parseBody(asOwner.row) as any;
  console.log('Madde3 stored body ->', JSON.stringify(body));
  assert.equal(body.authorEmail, realAsker.email, 'authorEmail must be the real caller, ignoring the spoofed value');
  assert.equal(body.authorProfileId, realAsker.ownerId, 'authorProfileId must be the real caller, ignoring the spoofed value');
  assert.equal(body.authorName, 'Gercek Ad Soyad', "authorName must come from the real profile-setting row, ignoring the spoofed name");
  assert.equal(body.authorCity, 'Konya', "authorCity must come from the real profile-setting row, ignoring the spoofed city");
  assert.equal(
    body.authorAvatarUrl,
    'https://example.test/real-avatar.png',
    "authorAvatarUrl must come from the real profile-setting row, ignoring the spoofed/attacker-supplied URL",
  );
});

test('Madde 1/3 (kapanış kontrolü): with NO profile-setting row, authorName falls back to the generic "Kullanıcı" label -- never any part of the real email, never the spoofed value, never another identity', async () => {
  const realAsker = await registerAndLogin(`r4m3b-real-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`r4m3b-victim-${randomUUID()}@test.local`);
  // Deliberately never create a profile-setting row for realAsker.

  const created = await createHubContent(realAsker.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Sahte Isim',
    title: `Profilsiz Fallback Testi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({
      questionId: `local_${randomUUID()}`,
      authorEmail: victim.email,
      authorProfileId: victim.ownerId,
      authorName: victim.email, // attacker tries to make the fallback itself look like the victim
      authorCity: 'Sahte Sehir',
      answers: [],
    }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  const asOwner = await getHubContent(authed(realAsker.jwt), documentId);
  const body = parseBody(asOwner.row) as any;
  console.log('Madde3 (no profile) stored body ->', JSON.stringify(body));
  assert.equal(
    body.authorName,
    'Kullanıcı',
    'with no profile, authorName must fall back to the generic "Kullanıcı" label -- never any part of the real email (that would still leak part of the email), never the spoofed value',
  );
  assert.notEqual(body.authorName, victim.email, 'the fallback must never equal the victim\'s identity');
  assert.ok(!body.authorName.includes('@'), 'the fallback name must never contain any part of an email address');
  const emailLocalPart = realAsker.email.split('@')[0];
  assert.notEqual(body.authorName, emailLocalPart, 'the fallback must never be the real caller\'s own email local-part either -- that still exposes part of a real email');
  assert.equal(body.authorCity, 'Türkiye', 'with no profile, authorCity must fall back to the safe default city');
  assert.equal(body.authorAvatarUrl, '', 'with no profile, authorAvatarUrl must be empty, never a spoofed/guessed URL');
});

// ============================================================
// Madde 4: client-supplied reporterEmail/reporterProfileId/reporterName/
// reporterCity at create time must have no effect -- the real identity
// AND that identity's own real profile-setting row always win.
// ============================================================
test('Madde 4: reporterEmail/reporterProfileId/reporterName/reporterCity are all derived from the real identity and profile, ignoring spoofed values', async () => {
  const realReporter = await registerAndLogin(`r4m4-real-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`r4m4-victim-${randomUUID()}@test.local`);

  const profileRes = await createOwnProfileSetting(realReporter.jwt, {
    displayName: 'Gercek Sikayetci',
    city: 'Izmir',
  });
  assert.equal(profileRes.status, 201, JSON.stringify(profileRes.profile));

  const created = await createHubContent(realReporter.jwt, {
    kind: 'farmerQuestionReport',
    state: 'pending',
    authorName: 'Sahte Sikayetci',
    title: 'farmerQuestion:fq_123',
    descShort: 'uygunsuz icerik',
    body: JSON.stringify({
      targetType: 'farmerQuestion',
      targetId: 'fq_123',
      questionId: 'fq_123',
      reason: 'uygunsuz icerik',
      reporterName: 'Sahte Sikayetci',
      reporterCity: 'Sahte Sehir',
      reporterEmail: victim.email,
      reporterProfileId: victim.ownerId,
    }),
    location: 'Sahte Sehir',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  const asOwner = await getHubContent(authed(realReporter.jwt), documentId);
  const body = parseBody(asOwner.row) as any;
  console.log('Madde4 stored body ->', JSON.stringify(body));
  assert.equal(body.reporterEmail, realReporter.email, 'reporterEmail must be the real caller, ignoring the spoofed value');
  assert.equal(body.reporterProfileId, realReporter.ownerId, 'reporterProfileId must be the real caller, ignoring the spoofed value');
  assert.equal(body.reporterName, 'Gercek Sikayetci', 'reporterName must come from the real profile-setting row, ignoring the spoofed name');
  assert.equal(body.reporterCity, 'Izmir', 'reporterCity must come from the real profile-setting row, ignoring the spoofed city');
});

test('Madde 4 (kapanış kontrolü): with NO profile-setting row, reporterName falls back to the generic "Kullanıcı" label -- same rule as the question identity', async () => {
  const realReporter = await registerAndLogin(`r4m4d-real-${randomUUID()}@test.local`);
  // Deliberately never create a profile-setting row for realReporter.

  const created = await createHubContent(realReporter.jwt, {
    kind: 'farmerQuestionReport',
    state: 'pending',
    authorName: 'Sahte Sikayetci',
    title: 'farmerQuestion:fq_456',
    descShort: 'uygunsuz icerik',
    body: JSON.stringify({
      targetType: 'farmerQuestion',
      targetId: 'fq_456',
      questionId: 'fq_456',
      reason: 'uygunsuz icerik',
      reporterName: 'Sahte Sikayetci',
      reporterCity: 'Sahte Sehir',
    }),
    location: 'Sahte Sehir',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  const asOwner = await getHubContent(authed(realReporter.jwt), documentId);
  const body = parseBody(asOwner.row) as any;
  console.log('Madde4 (no profile) stored body ->', JSON.stringify(body));
  assert.equal(body.reporterName, 'Kullanıcı', 'with no profile, reporterName must fall back to the generic "Kullanıcı" label too -- same rule as the question identity');
  assert.ok(!body.reporterName.includes('@'), 'the fallback reporter name must never contain any part of an email address');
});

// ============================================================
// Madde 2 (round 2): create() AND update() protected TOGETHER -- a row's
// own owner cannot use PUT to reassign their OWN visible identity to a
// different real person either.
// ============================================================
test('Madde 2: the question OWNER cannot use PUT to reassign their own authorEmail/authorName to a different real person', async () => {
  const owner = await registerAndLogin(`r4m2d-owner-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`r4m2d-victim-${randomUUID()}@test.local`);
  await createOwnProfileSetting(owner.jwt, { displayName: 'Gercek Sahip', city: 'Bursa' });

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Gercek Sahip',
    title: `Update Kilidi Testi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const documentId = created.documentId as string;

  // The row's own real owner now tries to PUT a spoofed identity into
  // their OWN question's body -- note `kind` is deliberately omitted
  // from this request, exactly like a real partial update, to prove the
  // fix reads the real kind from the EXISTING row, not from this request.
  const updateRes = await updateHubContent(owner.jwt, documentId, {
    title: 'Guncellenmis Baslik',
    body: JSON.stringify({
      questionId: `local_${randomUUID()}`,
      authorEmail: victim.email,
      authorProfileId: victim.ownerId,
      authorName: 'Sahte Isim Update',
      authorCity: 'Sahte Sehir Update',
      answers: [],
    }),
  });
  assert.equal(updateRes.status, 200, JSON.stringify(updateRes.body));

  const asOwner = await getHubContent(authed(owner.jwt), documentId);
  const body = parseBody(asOwner.row) as any;
  console.log('Madde2 (update) stored body ->', JSON.stringify(body));
  assert.equal(body.authorEmail, owner.email, 'PUT must not let the owner reassign authorEmail to a different real person');
  assert.equal(body.authorProfileId, owner.ownerId, 'PUT must not let the owner reassign authorProfileId to a different real person');
  assert.equal(body.authorName, 'Gercek Sahip', 'PUT must not let the owner reassign authorName -- still derived from the real profile');
  assert.equal(body.authorCity, 'Bursa', 'PUT must not let the owner reassign authorCity -- still derived from the real profile');
  assert.equal(asOwner.row?.title, 'Guncellenmis Baslik', 'sanity: the legitimate title change in the same request must still go through');
});

test('Madde 2: updating a question\'s title does NOT reassign an existing embedded answer\'s real author to the question owner', async () => {
  const owner = await registerAndLogin(`r4m2e-owner-${randomUUID()}@test.local`);
  const realAnswerer = await registerAndLogin(`r4m2e-answerer-${randomUUID()}@test.local`);

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Soru Sahibi',
    title: `Gomulu Cevap Korunmasi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201);
  const documentId = created.documentId as string;

  const originalQuestionId = `local_${randomUUID()}`;
  await strapiInstance.db.query('api::hub-content.hub-content').update({
    where: { documentId },
    data: {
      body: JSON.stringify({
        questionId: originalQuestionId,
        answers: [
          {
            answerId: 'fa_legacy_2',
            name: 'Gercek Cevaplayan',
            city: 'Antalya',
            text: 'Gercek cevap metni',
            email: realAnswerer.email,
            profileId: realAnswerer.ownerId,
          },
        ],
      }),
    },
  } as any);

  // Owner edits only the title, resending the full body as the real app's
  // own full-row PUT flow does (farmer_questions_repo.dart's
  // _toQuestionPayload always resends the complete body, embedded answers
  // included) -- this must not let the stamping step reassign the
  // embedded answer's real author to the owner.
  const updateRes = await updateHubContent(owner.jwt, documentId, {
    kind: 'farmerQuestion',
    title: 'Yeni Baslik',
    body: JSON.stringify({
      questionId: originalQuestionId,
      answers: [
        {
          answerId: 'fa_legacy_2',
          name: 'Gercek Cevaplayan',
          city: 'Antalya',
          text: 'Gercek cevap metni',
          email: realAnswerer.email,
          profileId: realAnswerer.ownerId,
        },
      ],
    }),
  });
  assert.equal(updateRes.status, 200, JSON.stringify(updateRes.body));

  const asRealAnswerer = await getHubContent(authed(realAnswerer.jwt), documentId);
  const body = parseBody(asRealAnswerer.row) as any;
  console.log('Madde2 (embedded answer after update) ->', JSON.stringify(body.answers));
  assert.equal(
    body.answers?.[0]?.email,
    realAnswerer.email,
    "updating the question's title must not reassign the embedded answer's real author email to the question owner",
  );
  assert.equal(
    body.answers?.[0]?.profileId,
    realAnswerer.ownerId,
    "updating the question's title must not reassign the embedded answer's real author profileId to the question owner",
  );
});

test('Kontrol (madde 2): a full-body PUT from the question owner attempting to rewrite an embedded answer\'s own text/identity is ALREADY blocked -- pre-existing hub-content-write-guard.ts protection, not a fix made this round', async () => {
  const owner = await registerAndLogin(`r4m2f-owner-${randomUUID()}@test.local`);
  const realAnswerer = await registerAndLogin(`r4m2f-answerer-${randomUUID()}@test.local`);

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Soru Sahibi',
    title: `Full Body Tamper Testi ${randomUUID()}`,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201);
  const documentId = created.documentId as string;

  const qId = `local_${randomUUID()}`;
  await strapiInstance.db.query('api::hub-content.hub-content').update({
    where: { documentId },
    data: {
      body: JSON.stringify({
        questionId: qId,
        answers: [
          {
            answerId: 'fa_legacy_3',
            name: 'Gercek Cevaplayan',
            city: 'Antalya',
            text: 'Orijinal gercek cevap',
            email: realAnswerer.email,
            profileId: realAnswerer.ownerId,
          },
        ],
      }),
    },
  } as any);

  // The question OWNER (not the answerer) sends a full-row PUT that
  // tries to rewrite the embedded answer's own text AND identity. This
  // was flagged for VERIFICATION this round, not assumed fixed or
  // broken. Real finding: `hub-content-write-guard.ts`'s own
  // `embeddedAnswersAuthorshipUnchanged` check (pre-existing in this
  // codebase, own header comment cites this exact "kalan sınır" from an
  // earlier audit pass) already parses both the stored and incoming
  // `body.answers[]` by `answerId` and rejects (403) any PUT/PATCH from
  // the question's own owner that changes an existing answerId's
  // name/profileId/email/text, or introduces a brand-new answerId. This
  // is NOT something fixed in this round -- it was already there.
  const tamperRes = await updateHubContent(owner.jwt, documentId, {
    kind: 'farmerQuestion',
    body: JSON.stringify({
      questionId: qId,
      answers: [
        {
          answerId: 'fa_legacy_3',
          name: 'Degistirilmis Isim',
          city: 'Antalya',
          text: 'Degistirilmis cevap metni',
          email: owner.email,
          profileId: owner.ownerId,
        },
      ],
    }),
  });

  const asRealAnswerer = await getHubContent(authed(realAnswerer.jwt), documentId);
  const body = parseBody(asRealAnswerer.row) as any;
  console.log(
    'Kontrol: tamper PUT status ->', tamperRes.status,
    '| embedded answer after tamper attempt ->', JSON.stringify(body.answers),
  );
  console.log(
    'KONTROL SONUCU: soru sahibi gömülü cevabın metnini/kimliğini full-body PUT ile DEĞİŞTİREMİYOR -- ' +
    '403 ile reddediliyor (hub-content-write-guard.ts, bu round\'dan ÖNCE de vardı, ben eklemedim).',
  );
  assert.equal(tamperRes.status, 403, 'rewriting an existing embedded answer\'s identity/text must be rejected -- pre-existing guard');
  assert.equal(body.answers?.[0]?.text, 'Orijinal gercek cevap', 'the embedded answer must remain completely unchanged after the rejected attempt');
  assert.equal(body.answers?.[0]?.email, realAnswerer.email, 'the embedded answer\'s real author email must remain unchanged');
});

// ============================================================
// Madde 4 (round 2): the visibility filter must be applied BEFORE
// pagination -- no missing page, no wrong total, no hidden-inclusive
// total-count leak, and no bypass via a different filter/sort param.
// ============================================================
test('Madde 4: pagination total/pageCount reflect only VISIBLE rows, and hidden rows never occupy a page slot', async () => {
  const stranger = await registerAndLogin(`r4m4b-stranger-${randomUUID()}@test.local`);
  const owner = await registerAndLogin(`r4m4b-owner-${randomUUID()}@test.local`);
  const uniqueTag = randomUUID();

  const createdDocIds: string[] = [];
  const visibleTitles = new Set<string>();
  // 5 visible + 3 hidden, interleaved, all the SAME kind/filter so they'd
  // all land in the same query if the visibility filter were applied
  // post-hoc instead of as a real query filter.
  for (let i = 0; i < 8; i++) {
    const title = `Sayfalama ${uniqueTag} #${i}`;
    const created = await createHubContent(owner.jwt, {
      kind: 'farmerQuestion',
      state: 'published',
      authorName: 'Sayfalama Testi',
      title,
      descShort: 'Kisa soru',
      body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
      content: 'Soru metni',
    });
    assert.equal(created.status, 201);
    const documentId = created.documentId as string;
    createdDocIds.push(documentId);
    if (i % 3 === 2) {
      await strapiInstance.db.query('api::hub-content.hub-content').update({
        where: { documentId },
        data: { state: 'archived' },
      } as any);
    } else {
      visibleTitles.add(title);
    }
  }
  console.log(`Madde4 pagination: created ${createdDocIds.length} rows, ${visibleTitles.size} visible, ${createdDocIds.length - visibleTitles.size} hidden`);

  // Walk every page with a small page size, as a non-owner stranger, and
  // collect every title actually returned.
  const pageSize = 2;
  const seenTitles = new Set<string>();
  let lastTotal: number | null = null;
  let lastPageCount: number | null = null;
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(
      `${BASE_URL}/hub-contents?filters[title][$containsi]=${encodeURIComponent(uniqueTag)}&pagination[page]=${page}&pagination[pageSize]=${pageSize}`,
      { headers: authed(stranger.jwt) },
    );
    const json = await res.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    const total = json?.meta?.pagination?.total;
    const pageCount = json?.meta?.pagination?.pageCount;
    console.log(`Madde4 page ${page} -> rows=${rows.length} total=${total} pageCount=${pageCount}`);
    lastTotal = total;
    lastPageCount = pageCount;
    for (const row of rows) seenTitles.add(row.title);
    if (page >= (pageCount ?? 1)) break;
  }

  assert.equal(lastTotal, visibleTitles.size, 'meta.pagination.total must count only VISIBLE rows -- never the hidden ones, which would leak how much hidden content exists');
  assert.equal(lastPageCount, Math.ceil(visibleTitles.size / pageSize), 'pageCount must be computed from the visible-only total');
  assert.deepEqual(
    new Set([...seenTitles]),
    visibleTitles,
    'walking every page must recover EXACTLY the visible set -- no visible row skipped across a page boundary, no hidden row ever occupying a page slot',
  );

  // The row's real owner, using the SAME filter, must still see ALL 8 of
  // their own rows (hidden ones included) -- the visibility filter must
  // never hide a row from its own owner, even at the query level.
  const resOwner = await fetch(
    `${BASE_URL}/hub-contents?filters[title][$containsi]=${encodeURIComponent(uniqueTag)}&pagination[pageSize]=20`,
    { headers: authed(owner.jwt) },
  );
  const jsonOwner = await resOwner.json();
  const ownerTotal = jsonOwner?.meta?.pagination?.total;
  console.log('Madde4 owner total (must include hidden rows too) ->', ownerTotal);
  assert.equal(ownerTotal, createdDocIds.length, "the row owner's own total must include their own hidden rows too");
});

test('Madde 4: the visibility filter cannot be bypassed by sending a different/conflicting raw filter', async () => {
  const stranger = await registerAndLogin(`r4m4c-stranger-${randomUUID()}@test.local`);
  const owner = await registerAndLogin(`r4m4c-owner-${randomUUID()}@test.local`);
  const uniqueTitle = `Bypass Denemesi ${randomUUID()}`;

  const created = await createHubContent(owner.jwt, {
    kind: 'farmerQuestion',
    state: 'published',
    authorName: 'Bypass Testi',
    title: uniqueTitle,
    descShort: 'Kisa soru',
    body: JSON.stringify({ questionId: `local_${randomUUID()}`, answers: [] }),
    content: 'Soru metni',
  });
  assert.equal(created.status, 201);
  const documentId = created.documentId as string;
  await strapiInstance.db.query('api::hub-content.hub-content').update({
    where: { documentId },
    data: { state: 'archived' },
  } as any);

  // Try a handful of plausible bypass attempts: an explicit raw state
  // filter contradicting the hidden state, sorting tricks, and a direct
  // title match -- none may surface the hidden row to a non-owner.
  const attempts = [
    `filters[title][$eq]=${encodeURIComponent(uniqueTitle)}`,
    `filters[title][$eq]=${encodeURIComponent(uniqueTitle)}&filters[state][$eq]=archived`,
    `filters[title][$eq]=${encodeURIComponent(uniqueTitle)}&sort[0]=createdAt:asc`,
    `filters[title][$eq]=${encodeURIComponent(uniqueTitle)}&pagination[pageSize]=100`,
  ];
  for (const qs of attempts) {
    const res = await fetch(`${BASE_URL}/hub-contents?${qs}`, { headers: authed(stranger.jwt) });
    const json = await res.json();
    const rows = Array.isArray(json?.data) ? json.data : [];
    console.log(`Madde4 bypass attempt "${qs}" -> rows=${rows.length}`);
    assert.equal(rows.length, 0, `a hidden row must not surface via: ${qs}`);
  }
});
