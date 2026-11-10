/**
 * Uçtan uca, İKİ GERÇEK HESAPLA (A ve B), aynı Strapi uygulama koduna
 * (gerçek controller'lar, gerçek route'lar) karşı -- A'nın ekranında
 * "başarılı" görünmesi TEK BAŞINA yeterli sayılmıyor; her adımda hem
 * sunucudaki ham satır hem de B'nin/A'nın KENDİ okuma yolundan gelen
 * yanıt doğrudan kontrol ediliyor.
 *
 * Ortam: gerçek Strapi boot, throwaway SQLite dosyası (production/canlı
 * veritabanına HİÇ bağlanmıyor -- bkz. bu dosyanın DATABASE_CLIENT/
 * DATABASE_FILENAME override'ı aşağıda). Bu "test ortamında" doğrulama
 * sayılır; gerçek bir fiziksel cihazda İKİ gerçek hesapla deneme DEĞİLDİR
 * -- o kısım bu dosyanın kapsamı dışında ve ayrıca "doğrulanmadı" olarak
 * işaretlenmiştir.
 *
 * Run: npm run test:integration (veya doğrudan bu dosyayı hedefleyerek).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-two-account-e2e-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-two-account-e2e-test.db');
const PORT = 14288;
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

const uid = () => randomUUID().slice(0, 8);
const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function registerAccount(tag: string) {
  const email = `${tag}-${uid()}@test.local`;
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = (await res.json()) as any;
  const ownerId = `u_${email.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt as string, email, ownerId };
}

const profileRow = (profileId: string) =>
  strapiInstance.db.query('api::profile-setting.profile-setting').findOne({ where: { profileId } } as any);

// addProfileComment/rateProfile both require the TARGET to already have a
// profile-setting row (they look it up by profileId and 404 otherwise) --
// registering an account does not create one by itself. Mirrors the
// existing farmer-question-answer-identity test's own setDisplayName
// helper: a plain POST /profile-settings, no explicit profileId (stamped
// server-side from the authenticated session).
async function touchOwnProfile(jwt: string, displayName: string, city = 'Konya') {
  await fetch(`${BASE_URL}/profile-settings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { displayName, city } }),
  });
}

// B'nin KENDİ Hesabım ekranı açıldığında Flutter'ın gerçekte gönderdiği
// istekle BİREBİR aynı (StrapiService._fetchProfileSettingsUncached).
async function fetchOwnProfileAsSelf(jwt: string, profileId: string) {
  const res = await fetch(
    `${BASE_URL}/profile-settings?filters[profileId][$eq]=${encodeURIComponent(profileId)}&pagination[limit]=1`,
    { headers: authed(jwt) },
  );
  const json = (await res.json()) as any;
  const row = Array.isArray(json?.data) ? json.data[0] : null;
  if (!row) return null;
  const attrs = row.attributes && typeof row.attributes === 'object' ? row.attributes : {};
  return { ...row, ...attrs } as Record<string, any>;
}

// Herhangi bir ziyaretçinin (ya da B'nin kendisinin, tutarlılık için)
// gördüğü GERÇEK, herkese açık profil yanıtı -- Flutter'ın
// StrapiService.fetchPublicProfile'ı ile birebir aynı.
async function fetchPublicProfile(profileId: string) {
  const res = await fetch(`${BASE_URL}/public-profiles/${encodeURIComponent(profileId)}`);
  const json = (await res.json()) as any;
  return { status: res.status, profile: json?.profile ?? null };
}

test('1) A, B\'ye yorum yazıyor -- sunucuda hedef GERÇEKTEN B mi, ve B kendi Hesabım ekranını yeniden açınca yorumu görüyor mu', async () => {
  const A = await registerAccount('cmt-a');
  const B = await registerAccount('cmt-b');
  await touchOwnProfile(B.jwt, 'Satici B');
  const text = `Harika bir satıcı, çok memnun kaldım! ${uid()}`;

  // Adım 1: A, B'nin profiline yorum yazıyor -- GERÇEK HTTP isteği.
  const res = await fetch(`${BASE_URL}/profile-settings/${encodeURIComponent(B.ownerId)}/comments`, {
    method: 'POST',
    headers: authed(A.jwt),
    body: JSON.stringify({ data: { text, operationId: randomUUID() } }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, `A'nın yorum isteği HTTP 200 dönmeli, kanıt: ${JSON.stringify(body)}`);

  // Adım 2 (A'nın ekranındaki "başarı" DEĞİL): sunucudaki HAM satırı
  // doğrudan sorgula -- yorumun hedefi GERÇEKTEN B'nin kendi satırı mı?
  const bRow = await profileRow(B.ownerId);
  assert.ok(bRow, 'B için bir profile-setting satırı oluşmuş olmalı (addProfileComment onu yaratır).');
  const bComments = (bRow.incomingProfileComments ?? bRow.incomingComments ?? []) as any[];
  const savedOnServer = bComments.find((c) => String(c?.text ?? '') === text);
  assert.ok(
    savedOnServer,
    `SUNUCU SONUCU: yorum B'nin KENDİ satırına kaydedildi mi? HAYIR -- B'nin satırında bu metin yok. Satır: ${JSON.stringify(bRow)}`,
  );
  assert.equal(
    String(savedOnServer!.fromProfileId ?? ''),
    A.ownerId,
    'SUNUCU SONUCU: kaydedilen yorumun fromProfileId\'si gerçekten A olmalı.',
  );

  // Adım 3: B, KENDİ Hesabım ekranını (yeniden) açıyor -- aynı Flutter
  // çağrısı, aynı JWT, aynı sorgu parametreleri.
  const bOwnView = await fetchOwnProfileAsSelf(B.jwt, B.ownerId);
  assert.ok(bOwnView, 'B kendi profilini GET ile çekebilmeli.');
  const visibleToB = ((bOwnView!.incomingProfileComments ?? bOwnView!.incomingComments ?? []) as any[]).find(
    (c) => String(c?.text ?? '') === text,
  );
  assert.ok(
    visibleToB,
    `KARŞI HESAPTA GÖRÜNDÜ MÜ: HAYIR -- B kendi Hesabım ekranını yeniden açtığında bu yorumu görmüyor. Dönen veri: ${JSON.stringify(bOwnView)}`,
  );

  console.log('[1/3] SONUÇ: sunucuya kaydedildi = EVET (hedef doğru: B); B\'nin kendi ekranında göründü = EVET');
});

test('2) A, B\'ye 5 yıldız veriyor -- puan GERÇEKTEN B\'ye kaydoluyor mu, B\'nin ortalaması/sayısı doğru güncelleniyor mu', async () => {
  const A = await registerAccount('rate-a');
  const B = await registerAccount('rate-b');
  await touchOwnProfile(B.jwt, 'Satici B');

  const res = await fetch(`${BASE_URL}/profile-settings/${encodeURIComponent(B.ownerId)}/rate`, {
    method: 'POST',
    headers: authed(A.jwt),
    body: JSON.stringify({ data: { stars: 5 } }),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 200, `A'nın puanlama isteği HTTP 200 dönmeli, kanıt: ${JSON.stringify(body)}`);

  // Sunucudaki HAM satır: oy GERÇEKTEN B'nin kendi satırında, A'nın
  // kimliğiyle anahtarlanmış mı?
  const bRow = await profileRow(B.ownerId);
  assert.ok(bRow, 'B için bir satır oluşmuş olmalı.');
  const votes = (bRow.ratingVotesByViewer ?? bRow.ratingVotes ?? {}) as Record<string, number>;
  assert.equal(
    votes[A.ownerId],
    5,
    `SUNUCU SONUCU: B'nin satırındaki ratingVotesByViewer[${A.ownerId}] 5 olmalı. Satır: ${JSON.stringify(bRow)}`,
  );

  // B'nin kendi profili GERÇEKTEN güncellendi mi -- herkese açık okuma
  // yoluyla (toplam/ortalama hesaplaması sunucuda yapılıyor).
  const pub = await fetchPublicProfile(B.ownerId);
  assert.equal(pub.status, 200);
  assert.ok(pub.profile, 'public-profile yanıtı B için bir profil nesnesi döndürmeli.');
  assert.equal(
    pub.profile!.ratingCount,
    1,
    `KARŞI HESAPTA GÜNCELLENDİ Mİ (sayı): HAYIR -- B'nin herkese açık ratingCount'u beklenen 1 değil. Yanıt: ${JSON.stringify(pub.profile)}`,
  );
  assert.equal(
    pub.profile!.ratingAverage,
    5,
    `KARŞI HESAPTA GÜNCELLENDİ Mİ (ortalama): HAYIR -- B'nin herkese açık ratingAverage'ı beklenen 5 değil. Yanıt: ${JSON.stringify(pub.profile)}`,
  );

  console.log('[2/3] SONUÇ: sunucuya kaydedildi = EVET (hedef doğru: B); B\'nin ortalaması/sayısı = EVET (5.0 / 1)');
});

test('3) Çiftçiden Sorular: A soru açıyor, B soruyu görüp cevaplıyor, A da B\'nin cevabını kendi tarafında görüyor mu', async () => {
  const A = await registerAccount('fq-a');
  const B = await registerAccount('fq-b');
  const questionTitle = `Domates yaprağında leke var ${uid()}`;

  // Adım 1: A soruyu GERÇEK create endpoint'i ile açıyor (Flutter'ın
  // _toQuestionPayload'ıyla aynı şekil).
  const createRes = await fetch(`${BASE_URL}/hub-contents`, {
    method: 'POST',
    headers: authed(A.jwt),
    body: JSON.stringify({
      data: {
        kind: 'farmerQuestion',
        state: 'published',
        authorName: 'A Ciftci',
        title: questionTitle,
        descShort: 'Yapraklar sararmaya basladi',
        body: JSON.stringify({ questionId: `fq_local_${uid()}`, answers: [] }),
        content: 'Domates yapraklarinda sararma ve leke var, ne yapmaliyim?',
        location: 'Konya',
        likes: 0,
        comments: 0,
      },
    }),
  });
  const createBody = (await createRes.json()) as any;
  assert.equal(
    createRes.status,
    201,
    `A'nın soru oluşturma isteği HTTP 201 (Strapi'nin standart create yanıtı) dönmeli, kanıt: ${JSON.stringify(createBody)}`,
  );
  const questionId = createBody?.data?.id;
  assert.ok(questionId, `Oluşturulan sorunun bir id'si dönmeli. Yanıt: ${JSON.stringify(createBody)}`);

  // Adım 2: B, soruyu GERÇEK liste endpoint'i (find) ile görebiliyor mu?
  const listRes = await fetch(
    `${BASE_URL}/hub-contents?filters[kind][$eq]=farmerQuestion&pagination[pageSize]=100`,
    { headers: authed(B.jwt) },
  );
  const listBody = (await listRes.json()) as any;
  assert.equal(listRes.status, 200);
  const rows = Array.isArray(listBody?.data) ? listBody.data : [];
  const seenByB = rows.find((r: any) => r.id === questionId || (r.attributes ?? r).title === questionTitle);
  assert.ok(
    seenByB,
    `KARŞI HESAPTA GÖRÜNDÜ MÜ (soru): HAYIR -- B, listeleme isteğinde A'nın sorusunu göremiyor. Dönen satır sayısı: ${rows.length}`,
  );

  // Adım 3: B, soruyu GERÇEK cevap endpoint'i ile cevaplıyor.
  const answerText = `Mantar hastaligi olabilir, bakir iceren bir ilaclama deneyin. ${uid()}`;
  const answerRes = await fetch(`${BASE_URL}/hub-contents/farmer-questions/${questionId}/answers`, {
    method: 'POST',
    headers: authed(B.jwt),
    body: JSON.stringify({ data: { text: answerText, operationId: randomUUID() } }),
  });
  const answerBody = (await answerRes.json()) as any;
  assert.equal(
    answerRes.status,
    200,
    `B'nin cevap isteği HTTP 200 dönmeli, kanıt: ${JSON.stringify(answerBody)}`,
  );
  assert.equal(
    String(answerBody?.data?.profileId ?? ''),
    B.ownerId,
    'SUNUCU SONUCU: kaydedilen cevabın profileId\'si gerçekten B olmalı (sunucu tarafından damgalanmış).',
  );

  // Adım 4 (A'nın ekranındaki "başarı" DEĞİL): A, KENDİ tarafında --
  // Flutter'ın _refreshQuestion'ının yaptığı gibi, soruyu TEKRAR, gerçek
  // find endpoint'inden çekip -- B'nin cevabını görüyor mu?
  const aRefetchRes = await fetch(
    `${BASE_URL}/hub-contents?filters[kind][$eq]=farmerQuestionComment&pagination[pageSize]=100`,
    { headers: authed(A.jwt) },
  );
  const aRefetchBody = (await aRefetchRes.json()) as any;
  assert.equal(aRefetchRes.status, 200);
  const answerRows = Array.isArray(aRefetchBody?.data) ? aRefetchBody.data : [];
  const seenByA = answerRows.find((r: any) => {
    const attrs = r.attributes ?? r;
    const parsedBody = (() => {
      try {
        return JSON.parse(String(attrs.body ?? '{}'));
      } catch {
        return {};
      }
    })();
    return (
      String(attrs.content ?? '').includes(answerText) ||
      String(parsedBody.text ?? '').includes(answerText)
    );
  });
  assert.ok(
    seenByA,
    `KARŞI HESAPTA GÖRÜNDÜ MÜ (cevap): HAYIR -- A, kendi tarafında (gerçek find endpoint'i ile) B'nin cevabını göremiyor. Dönen satır sayısı: ${answerRows.length}`,
  );

  console.log(
    '[3/3] SONUÇ: soru sunucuya kaydedildi = EVET; B soruyu listede gördü = EVET; cevap sunucuya kaydedildi = EVET (hedef doğru: B); A kendi tarafında cevabı gördü = EVET',
  );
});
