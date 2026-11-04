/**
 * Soru/Profil/Kart denetimi (2026-10-25) — Profil grubu Madde 13/14/17.
 *
 * Bu dosya ÖNCE (rapor aşaması) şunu kanıtlamıştı: A, B'yi takip edince
 * SADECE A'nın kendi dokümanı güncelleniyordu (B'nin followerIds'i hiçbir
 * yazma yoluyla asla değişmiyordu) ve followersFallback/ratingBaseCount/
 * ratingBaseAverage hiçbir alan koruması görmüyordu (client kendi
 * dokümanına sahte bir değer yazabiliyor, bu da gerçek ziyaretçi-yüzü
 * /public-profiles yanıtına yansıyordu).
 *
 * ŞİMDİ (düzeltme aşaması) bu dosya onaylanan 4 adımı doğruluyor:
 *  1) rateProfile/addProfileComment/followProfile/unfollowProfile --
 *     JWT kimliğine bağlı, dar, sunucu-taraflı yazma yolları (hedefin
 *     dokümanını istemci değil sunucu günceller).
 *  2) Bu yollar gerçekten HER İKİ tarafı da günceller (A→B→C temiz
 *     okuma).
 *  3) Tekrarlanan/eşzamanlı istekler çift yorum/fazla oy/fazla
 *     takipçi/kayıp güncelleme üretmez.
 *  4) ratingBaseAverage/ratingBaseCount/followerIds/followingIds/
 *     followersFallback/followingFallback/ratingVotesByViewer/
 *     incomingProfileComments artık genel create/update'ten STRIP
 *     ediliyor -- sahte bir değer artık generic PUT ile yazılamıyor.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-profile-follow-rating-integrity-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-profile-follow-rating-integrity-test.db');
const PORT = 14270;
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

async function createOwnProfileSetting(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/profile-settings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { displayName: 'Test Profil', ...overrides } }),
  });
  const json = await res.json();
  return json.data;
}

async function fetchOwnProfileSetting(jwt: string, profileId: string) {
  const res = await fetch(`${BASE_URL}/profile-settings?filters[profileId][\$eq]=${encodeURIComponent(profileId)}`, {
    headers: authed(jwt),
  });
  const body = await res.json();
  return body.data?.[0] ?? null;
}

async function follow(jwt: string, targetProfileId: string) {
  const res = await fetch(`${BASE_URL}/profile-settings/${encodeURIComponent(targetProfileId)}/follow`, {
    method: 'POST',
    headers: authed(jwt),
  });
  return { status: res.status, body: await res.json() };
}

async function unfollow(jwt: string, targetProfileId: string) {
  const res = await fetch(`${BASE_URL}/profile-settings/${encodeURIComponent(targetProfileId)}/unfollow`, {
    method: 'POST',
    headers: authed(jwt),
  });
  return { status: res.status, body: await res.json() };
}

async function rate(jwt: string, targetProfileId: string, stars: number) {
  const res = await fetch(`${BASE_URL}/profile-settings/${encodeURIComponent(targetProfileId)}/rate`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { stars } }),
  });
  return { status: res.status, body: await res.json() };
}

async function comment(jwt: string, targetProfileId: string, text: string, operationId: string, rating = 0) {
  const res = await fetch(`${BASE_URL}/profile-settings/${encodeURIComponent(targetProfileId)}/comments`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { text, operationId, rating } }),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------
// Madde 14: followProfile/unfollowProfile now update BOTH sides,
// server-side, in one real HTTP call.
// ---------------------------------------------------------------------

test('Madde 14 (düzeltme): A, B\'yi followProfile ile takip edince HER İKİ taraf da gerçekten güncellenir', async () => {
  const a = await registerAndLogin(`m14-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m14-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  const res = await follow(a.jwt, b.ownerId);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const aRow = await fetchOwnProfileSetting(a.jwt, a.ownerId);
  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.deepEqual(aRow.followingIds, [b.ownerId], 'A\'nın kendi dokümanı güncellenmeli');
  assert.deepEqual(bRow.followerIds, [a.ownerId], 'B\'nin kendi dokümanı da GERÇEKTEN güncellenmeli -- önceki turda hiç güncellenmiyordu');
});

test('Madde 14 (düzeltme): A, B profilinden ÖNCE kendi profil-setting dokümanını oluşturmamış olsa bile follow çalışır (viewer satırı yoksa oluşturulur)', async () => {
  const a = await registerAndLogin(`m14-noown-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m14-noown-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(b.jwt);
  // A kasıtlı olarak KENDİ dokümanını hiç oluşturmadı.

  const res = await follow(a.jwt, b.ownerId);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const aRow = await fetchOwnProfileSetting(a.jwt, a.ownerId);
  assert.ok(aRow, 'A\'nın dokümanı follow sırasında otomatik oluşturulmalı');
  assert.deepEqual(aRow.followingIds, [b.ownerId]);
});

test('Madde 14 (düzeltme): A→B→C zinciri -- her satırın takip/takipçi durumu temiz bir OKUMA ile doğru görünür', async () => {
  const a = await registerAndLogin(`m14-chain-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m14-chain-b-${randomUUID()}@test.local`);
  const c = await registerAndLogin(`m14-chain-c-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);
  await createOwnProfileSetting(c.jwt);

  assert.equal((await follow(a.jwt, b.ownerId)).status, 200);
  assert.equal((await follow(b.jwt, c.ownerId)).status, 200);

  // Temiz okuma -- her kullanıcı KENDİ JWT'siyle kendi dokümanını çekiyor,
  // aynı optimistik bellek-içi nesneleri yeniden kullanmıyor.
  const aRow = await fetchOwnProfileSetting(a.jwt, a.ownerId);
  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  const cRow = await fetchOwnProfileSetting(c.jwt, c.ownerId);

  assert.deepEqual(aRow.followingIds, [b.ownerId]);
  assert.ok(!aRow.followerIds || aRow.followerIds.length === 0);
  assert.deepEqual(bRow.followerIds, [a.ownerId]);
  assert.deepEqual(bRow.followingIds, [c.ownerId]);
  assert.deepEqual(cRow.followerIds, [b.ownerId]);
  assert.ok(!cRow.followingIds || cRow.followingIds.length === 0);
});

test('Madde 14 (düzeltme): kendi kendini takip etmeye çalışmak reddedilir', async () => {
  const a = await registerAndLogin(`m14-self-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  const res = await follow(a.jwt, a.ownerId);
  assert.equal(res.status, 400);
});

test('Madde 14 (düzeltme): aynı takibi İKİ KEZ göndermek (double-tap) fazla takipçi oluşturmaz -- idempotent', async () => {
  const a = await registerAndLogin(`m14-doubletap-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m14-doubletap-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  await follow(a.jwt, b.ownerId);
  await follow(a.jwt, b.ownerId);

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.deepEqual(bRow.followerIds, [a.ownerId], 'aynı takipçi iki kez eklenmemeli');
});

test('Madde 14 (düzeltme): eşzamanlı (Promise.all) farklı takipçiler -- hiçbiri KAYBOLMAZ (kayıp güncelleme yok)', async () => {
  const b = await registerAndLogin(`m14-concurrent-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(b.jwt);
  const followers = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const u = await registerAndLogin(`m14-concurrent-f${i}-${randomUUID()}@test.local`);
      await createOwnProfileSetting(u.jwt);
      return u;
    }),
  );

  const results = await Promise.all(followers.map((f) => follow(f.jwt, b.ownerId)));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  const expectedIds = followers.map((f) => f.ownerId).sort();
  const actualIds = [...(bRow.followerIds ?? [])].sort();
  assert.deepEqual(
    actualIds,
    expectedIds,
    `tüm ${followers.length} eşzamanlı takipçi kaybolmadan kaydedilmeli, bulunan: ${actualIds.length}`,
  );
});

test('Madde 14 (düzeltme): unfollowProfile her iki tarafı da gerçekten temizler', async () => {
  const a = await registerAndLogin(`m14-unfollow-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m14-unfollow-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  await follow(a.jwt, b.ownerId);
  const unfRes = await unfollow(a.jwt, b.ownerId);
  assert.equal(unfRes.status, 200);

  const aRow = await fetchOwnProfileSetting(a.jwt, a.ownerId);
  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.ok(!aRow.followingIds || aRow.followingIds.length === 0);
  assert.ok(!bRow.followerIds || bRow.followerIds.length === 0);
});

// ---------------------------------------------------------------------
// Madde 13: rateProfile -- gerçek yazma yolu, kendi kendine puan
// yasağı, çift oy/eşzamanlılık güvenliği.
// ---------------------------------------------------------------------

test('Madde 13 (düzeltme): A, B\'ye rateProfile ile puan verince B\'nin dokümanına GERÇEKTEN ulaşır', async () => {
  const a = await registerAndLogin(`m13-rate-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-rate-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  const res = await rate(a.jwt, b.ownerId, 5);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.equal(bRow.ratingVotesByViewer?.[a.ownerId], 5, 'A\'nın oyu B\'nin KENDİ dokümanında gerçekten kaydedilmeli');
});

test('Madde 13 (düzeltme): kendi profiline puan vermek reddedilir', async () => {
  const a = await registerAndLogin(`m13-rate-self-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  const res = await rate(a.jwt, a.ownerId, 5);
  assert.equal(res.status, 400);
});

test('Madde 13 (düzeltme): gecersiz stars (0, 6, ondalik) reddedilir', async () => {
  const a = await registerAndLogin(`m13-rate-invalid-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-rate-invalid-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);
  assert.equal((await rate(a.jwt, b.ownerId, 0)).status, 400);
  assert.equal((await rate(a.jwt, b.ownerId, 6)).status, 400);
});

test('Madde 13 (düzeltme): aynı kullanıcı AYNI profile iki kez oy verirse fazla oy oluşmaz -- oy güncellenir, eklenmez', async () => {
  const a = await registerAndLogin(`m13-rate-retap-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-rate-retap-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  await rate(a.jwt, b.ownerId, 2);
  await rate(a.jwt, b.ownerId, 5);

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.equal(Object.keys(bRow.ratingVotesByViewer ?? {}).length, 1, 'A\'nın ikinci oyu İLKİ ile BİRLEŞMELİ, ayrı bir oy olmamalı');
  assert.equal(bRow.ratingVotesByViewer[a.ownerId], 5, 'son gönderilen değer geçerli olmalı');
});

test('Madde 13 (düzeltme): eşzamanlı (Promise.all) farklı oylar -- hiçbiri KAYBOLMAZ', async () => {
  const b = await registerAndLogin(`m13-rate-concurrent-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(b.jwt);
  const voters = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const u = await registerAndLogin(`m13-rate-concurrent-v${i}-${randomUUID()}@test.local`);
      await createOwnProfileSetting(u.jwt);
      return u;
    }),
  );

  const results = await Promise.all(voters.map((v, i) => rate(v.jwt, b.ownerId, (i % 5) + 1)));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  const votes = bRow.ratingVotesByViewer ?? {};
  assert.equal(
    Object.keys(votes).length,
    voters.length,
    `tüm ${voters.length} eşzamanlı oy kaybolmadan kaydedilmeli, bulunan: ${Object.keys(votes).length}`,
  );
  for (const [i, v] of voters.entries()) {
    assert.equal(votes[v.ownerId], (i % 5) + 1, `oy veren #${i}'in oyu kaybolmamalı/değişmemeli`);
  }
});

// ---------------------------------------------------------------------
// Madde 13: addProfileComment -- gerçek yazma yolu, sunucu-taraflı
// kimlik çözümleme, operationId tabanlı tekillik, eşzamanlılık.
// ---------------------------------------------------------------------

test('Madde 13 (düzeltme): A, B\'ye yorum yazınca B\'nin dokümanına GERÇEKTEN ulaşır, isim sunucu tarafından çözülür', async () => {
  const a = await registerAndLogin(`m13-comment-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-comment-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt, { displayName: 'Gerçek A İsmi' });
  await createOwnProfileSetting(b.jwt);

  const opId = randomUUID();
  const res = await comment(a.jwt, b.ownerId, 'Harika bir satici!', opId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.fromName, 'Gerçek A İsmi', 'isim CLIENT\'ın gönderdiği değil, sunucunun kendi profilinden çözdüğü isim olmalı');

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.equal(bRow.incomingProfileComments?.length, 1);
  assert.equal(bRow.incomingProfileComments[0].text, 'Harika bir satici!');
  assert.equal(bRow.incomingProfileComments[0].fromProfileId, a.ownerId);
});

test('Madde 13 (düzeltme): client\'in sahte fromName göndermesi hiçbir etki yapmaz', async () => {
  const a = await registerAndLogin(`m13-comment-spoof-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-comment-spoof-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt, { displayName: 'Gerçek İsim' });
  await createOwnProfileSetting(b.jwt);

  const res = await fetch(`${BASE_URL}/profile-settings/${encodeURIComponent(b.ownerId)}/comments`, {
    method: 'POST',
    headers: authed(a.jwt),
    body: JSON.stringify({ data: { text: 'Test', operationId: randomUUID(), fromName: 'Sahte İsim' } }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.fromName, 'Gerçek İsim', 'client-sağlanan fromName\'in hiçbir etkisi olmamalı');
});

test('Madde 13 (düzeltme): kendi profiline yorum yazmak reddedilir', async () => {
  const a = await registerAndLogin(`m13-comment-self-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  const res = await comment(a.jwt, a.ownerId, 'Kendi profilime yorum', randomUUID());
  assert.equal(res.status, 400);
});

test('Madde 13 (düzeltme): aynı operationId + aynı metinle retry (double-tap) İKİNCİ bir yorum OLUŞTURMAZ', async () => {
  const a = await registerAndLogin(`m13-comment-retry-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-comment-retry-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  const opId = randomUUID();
  const first = await comment(a.jwt, b.ownerId, 'Aynı yorum', opId);
  assert.equal(first.status, 200);
  const retry = await comment(a.jwt, b.ownerId, 'Aynı yorum', opId);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.id, first.body.data.id, 'retry AYNI yorum kaydına dönmeli');

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.equal(bRow.incomingProfileComments?.length, 1, 'tekrarlanan istek ikinci bir yorum oluşturmamalı');
});

test('Madde 13 (düzeltme): aynı operationId + FARKLI metin çakışma olarak reddedilir, orijinal yorum değişmez', async () => {
  const a = await registerAndLogin(`m13-comment-conflict-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-comment-conflict-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  const opId = randomUUID();
  await comment(a.jwt, b.ownerId, 'Orijinal metin', opId);
  const conflicting = await comment(a.jwt, b.ownerId, 'Farkli metin', opId);
  assert.equal(conflicting.status, 400);

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.equal(bRow.incomingProfileComments?.length, 1);
  assert.equal(bRow.incomingProfileComments[0].text, 'Orijinal metin');
});

test('Madde 13 (düzeltme): kasıtlı olarak AYRI iki yorum (farklı operationId, aynı metin) İKİSİ de oluşur -- birleştirilmez', async () => {
  const a = await registerAndLogin(`m13-comment-separate-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`m13-comment-separate-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  await comment(a.jwt, b.ownerId, 'Tesekkurler', randomUUID());
  await comment(a.jwt, b.ownerId, 'Tesekkurler', randomUUID());

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.equal(bRow.incomingProfileComments?.length, 2, 'farklı operationId\'li iki ayrı deneme asla birleştirilmemeli');
});

test('Madde 13 (düzeltme): eşzamanlı (Promise.all) farklı yorumcular -- hiçbir yorum KAYBOLMAZ', async () => {
  const b = await registerAndLogin(`m13-comment-concurrent-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(b.jwt);
  const commenters = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const u = await registerAndLogin(`m13-comment-concurrent-c${i}-${randomUUID()}@test.local`);
      await createOwnProfileSetting(u.jwt);
      return u;
    }),
  );

  const results = await Promise.all(
    commenters.map((c, i) => comment(c.jwt, b.ownerId, `Yorum ${i}`, randomUUID())),
  );
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));

  const bRow = await fetchOwnProfileSetting(b.jwt, b.ownerId);
  assert.equal(
    bRow.incomingProfileComments?.length,
    commenters.length,
    `tüm ${commenters.length} eşzamanlı yorum kaybolmadan kaydedilmeli, bulunan: ${bRow.incomingProfileComments?.length}`,
  );
});

// ---------------------------------------------------------------------
// Madde 15: gerçek sunucu toplamları ziyaretçi-yüzü /public-profiles
// yanıtına yansır.
// ---------------------------------------------------------------------

test('Madde 15 (düzeltme): rateProfile/followProfile ile oluşan GERÇEK toplamlar /public-profiles üzerinden bir ziyaretçiye görünür', async () => {
  const b = await registerAndLogin(`m15-visible-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(b.jwt);
  const a = await registerAndLogin(`m15-visible-a-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  const c = await registerAndLogin(`m15-visible-c-${randomUUID()}@test.local`);
  await createOwnProfileSetting(c.jwt);

  await rate(a.jwt, b.ownerId, 4);
  await rate(c.jwt, b.ownerId, 2);
  await follow(a.jwt, b.ownerId);
  await follow(c.jwt, b.ownerId);

  const visitorJwt = (await registerAndLogin(`m15-visitor-${randomUUID()}@test.local`)).jwt;
  const res = await fetch(`${BASE_URL}/public-profiles/${b.ownerId}`, { headers: authed(visitorJwt) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.profile.ratingAverage, 3, '(4+2)/2 = 3');
  assert.equal(body.profile.ratingCount, 2);
  assert.equal(body.profile.followerCount, 2);
});

// ---------------------------------------------------------------------
// Madde 17: ratingBaseAverage/ratingBaseCount/followerIds/followingIds/
// followersFallback/followingFallback/ratingVotesByViewer/
// incomingProfileComments artık generic create/update'ten STRIP edilir.
// ---------------------------------------------------------------------

test('Madde 17 (düzeltme): bir kullanıcı artık KENDİ dokümanına generic PUT ile sahte rating/follow alanı YAZAMAZ', async () => {
  const a = await registerAndLogin(`m17-fixed-selfinflate-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(a.jwt);

  const res = await fetch(`${BASE_URL}/profile-settings/${own.documentId}`, {
    method: 'PUT',
    headers: authed(a.jwt),
    body: JSON.stringify({
      data: {
        ratingBaseAverage: 5,
        ratingBaseCount: 500,
        followersFallback: 999999,
        followerIds: ['u_fake_1', 'u_fake_2'],
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.data.ratingBaseAverage, 5, 'ratingBaseAverage artık viewCount/activePremium gibi STRIP edilmeli');
  assert.notEqual(body.data.ratingBaseCount, 500);
  assert.notEqual(body.data.followersFallback, 999999);
  assert.ok(
    !body.data.followerIds || !body.data.followerIds.includes('u_fake_1'),
    'followerIds de artık generic update üzerinden sahte değerle yazılamamalı',
  );
});

test('Madde 17 (düzeltme): sahte taban artık /public-profiles yanıtına YANSIMAZ (generic PUT ile denense de)', async () => {
  const a = await registerAndLogin(`m17-fixed-visible-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(a.jwt);

  await fetch(`${BASE_URL}/profile-settings/${own.documentId}`, {
    method: 'PUT',
    headers: authed(a.jwt),
    body: JSON.stringify({ data: { ratingBaseAverage: 5, ratingBaseCount: 777 } }),
  });

  const visitorJwt = (await registerAndLogin(`m17-fixed-visitor-${randomUUID()}@test.local`)).jwt;
  const res = await fetch(`${BASE_URL}/public-profiles/${a.ownerId}`, { headers: authed(visitorJwt) });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.profile.ratingCount, 0, 'sahte taban artık hiç yazılmadığı için ziyaretçiye 0 oy görünmeli');
});

test('regresyon: viewCount/activePremium koruması Madde 17\'nin yeni stripinden ETKİLENMEMİŞ', async () => {
  const a = await registerAndLogin(`m17-regression-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(a.jwt);

  const res = await fetch(`${BASE_URL}/profile-settings/${own.documentId}`, {
    method: 'PUT',
    headers: authed(a.jwt),
    body: JSON.stringify({
      data: {
        viewCount: 999999,
        activePremium: { planTitle: 'Forged', endsAt: null },
        bio: 'Gercek bio guncellemesi',
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.data.viewCount, 999999);
  assert.ok(body.data.activePremium === null || body.data.activePremium === undefined);
  assert.equal(body.data.bio, 'Gercek bio guncellemesi', 'meşru, ilgisiz alanların güncellenmesi aynı istekte yine çalışmalı');
});

test('regresyon: bir kullanıcı BAŞKASININ dokümanına generic PUT ile hâlâ yazamaz (çapraz-profil koruması Madde 17\'den etkilenmemiş)', async () => {
  const a = await registerAndLogin(`m17-crossprofile-${randomUUID()}@test.local`);
  const target = await registerAndLogin(`m17-crossprofile-target-${randomUUID()}@test.local`);
  const targetRow = await createOwnProfileSetting(target.jwt);

  const res = await fetch(`${BASE_URL}/profile-settings/${targetRow.documentId}`, {
    method: 'PUT',
    headers: authed(a.jwt),
    body: JSON.stringify({ data: { bio: 'Hacklendim' } }),
  });
  assert.notEqual(res.status, 200, 'başkasının dokümanına PUT, ownership politikası tarafından reddedilmeli');
});

// ---------------------------------------------------------------------
// 13-18 grubu kalan noktalar.
// ---------------------------------------------------------------------

async function fetchPublicProfile(ownerId: string, jwt?: string) {
  const res = await fetch(`${BASE_URL}/public-profiles/${encodeURIComponent(ownerId)}`, {
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
  });
  const raw = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(raw);
  } catch (_) {
    body = null;
  }
  return { status: res.status, body, raw };
}

// ---------------------------------------------------------------------
// Nokta 1: yorumların gerçek okuma akışı -- mevcut "Yorumlar" sekmesinin
// ihtiyacı. A, B'ye yorum yazınca B VE yetkisiz bir ziyaretçi C bunu
// temiz yüklemede (kendi JWT'si/anonim olarak) görebilmeli -- generic
// profil belgesi veya özel alan (fromEmail/operationId/fingerprint) hiç
// açılmadan.
// ---------------------------------------------------------------------

test('Nokta 1: A, B\'ye yorum yazınca C (farklı bir kullanıcı) bunu /public-profiles üzerinden GERÇEKTEN görür, fromEmail hiç yok', async () => {
  const a = await registerAndLogin(`n1-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`n1-b-${randomUUID()}@test.local`);
  const c = await registerAndLogin(`n1-c-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt, { displayName: 'Gercek A' });
  await createOwnProfileSetting(b.jwt);
  await createOwnProfileSetting(c.jwt);

  await comment(a.jwt, b.ownerId, 'Cok iyi bir satici!', randomUUID());

  const { status, body, raw } = await fetchPublicProfile(b.ownerId, c.jwt);
  assert.equal(status, 200);
  assert.equal(body.profile.comments.length, 1);
  assert.equal(body.profile.comments[0].fromName, 'Gercek A');
  assert.equal(body.profile.comments[0].text, 'Cok iyi bir satici!');
  assert.equal(body.profile.comments[0].fromEmail, undefined, 'fromEmail yanıt şeklinde hiç olmamalı');
  assert.ok(!raw.includes(a.email), 'A\'nın gerçek e-postası hiçbir şekilde sızmamalı');
  assert.ok(!raw.includes('operationId'), 'dahili idempotency alanları (operationId) hiç sızmamalı');
  assert.ok(!raw.includes('fingerprint'), 'dahili idempotency alanları (fingerprint) hiç sızmamalı');
});

test('Nokta 1: aynı yorum, ANONİM (JWT\'siz) bir istekle de görülür -- /public-profiles zaten auth:false, yeni bir görünürlük kuralı icat edilmedi', async () => {
  const a = await registerAndLogin(`n1-anon-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`n1-anon-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt, { displayName: 'Gercek A' });
  await createOwnProfileSetting(b.jwt);

  await comment(a.jwt, b.ownerId, 'Anonim de gorebilmeli', randomUUID());

  const { status, body } = await fetchPublicProfile(b.ownerId);
  assert.equal(status, 200);
  assert.equal(body.profile.comments.length, 1);
  assert.equal(body.profile.comments[0].text, 'Anonim de gorebilmeli');
});

test('Nokta 1: B kendi yorumunu SİLİNCE, C\'nin SONRAKİ temiz yüklemesinde yorum artık görünmez', async () => {
  const a = await registerAndLogin(`n1-delete-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`n1-delete-b-${randomUUID()}@test.local`);
  const c = await registerAndLogin(`n1-delete-c-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);
  await createOwnProfileSetting(c.jwt);

  const created = await comment(a.jwt, b.ownerId, 'Silinecek yorum', randomUUID());
  assert.equal(created.status, 200);
  const commentId = created.body.data.id;

  const beforeDelete = await fetchPublicProfile(b.ownerId, c.jwt);
  assert.equal(beforeDelete.body.profile.comments.length, 1);

  const delRes = await fetch(
    `${BASE_URL}/profile-settings/${encodeURIComponent(b.ownerId)}/comments/${encodeURIComponent(commentId)}`,
    { method: 'DELETE', headers: authed(b.jwt) },
  );
  assert.equal(delRes.status, 200);

  const afterDelete = await fetchPublicProfile(b.ownerId, c.jwt);
  assert.equal(afterDelete.body.profile.comments.length, 0, 'silinen yorum, sonraki temiz yüklemede artık görünmemeli');
});

test('Nokta 1: C, KENDİSİ hiç yorum yazmamış olsa da A\'nın yazdığı yorumu görür -- herhangi bir takip/engelleme kısıtı yok (mevcut davranış korunuyor)', async () => {
  const a = await registerAndLogin(`n1-nofollow-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`n1-nofollow-b-${randomUUID()}@test.local`);
  const c = await registerAndLogin(`n1-nofollow-c-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);
  await createOwnProfileSetting(c.jwt);
  // C, B'yi hiç takip etmiyor -- mevcut kodda yorum görünürlüğü takiple
  // hiç ilişkili değil (Explore ajanının bulgusu), bu test bunu koruyor.

  await comment(a.jwt, b.ownerId, 'Takipsiz de gorulmeli', randomUUID());
  const { body } = await fetchPublicProfile(b.ownerId, c.jwt);
  assert.equal(body.profile.comments.length, 1);
});

// ---------------------------------------------------------------------
// Nokta 15/16 (düzeltme -- takipçi sayısının doğruluğu): public
// followerCount/followingCount artık YALNIZCA gerçek, doğrulanmış
// followerIds/followingIds uzunluğudur -- eski followersFallback/
// followingFallback ile hiç harmanlanmaz (ne max(), ne toplama). Bu,
// kullanıcının verdiği EGZAKT örnekle doğrulanıyor: gerçek liste 2, eski
// fallback 777 iken bir GERÇEK kullanıcı takipten çıkınca public toplam
// kaçtır?
// ---------------------------------------------------------------------

test('Nokta 15/16: gerçek liste 2, eski fallback 777 iken GERÇEK bir takipten çıkma -- public toplam SADECE gerçek listeyi yansıtır (2 -> 1), 777 asla "gerçek toplam" gibi gösterilmez', async () => {
  const b = await registerAndLogin(`n15-example-b-${randomUUID()}@test.local`);
  const bRow = await createOwnProfileSetting(b.jwt);
  const a = await registerAndLogin(`n15-example-a-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  const c = await registerAndLogin(`n15-example-c-${randomUUID()}@test.local`);
  await createOwnProfileSetting(c.jwt);

  // Production verisini SİLMEDEN/bulk migration YAPMADAN -- yalnız bu
  // testin KENDİ ürettiği satır için, kullanıcının verdiği örneği
  // (gerçek liste 2, eski fallback 777) birebir kuruyoruz.
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { documentId: bRow.documentId },
    data: { followersFallback: 777 },
  });
  await follow(a.jwt, b.ownerId);
  await follow(c.jwt, b.ownerId);

  const before = await fetchPublicProfile(b.ownerId);
  assert.equal(
    before.body.profile.followerCount,
    2,
    'gerçek liste 2 kişi (A, C) -- eski fallback (777) hiç karışmamalı, public toplam baştan itibaren SADECE gerçek listedir',
  );

  await unfollow(a.jwt, b.ownerId);
  const after = await fetchPublicProfile(b.ownerId);
  assert.equal(
    after.body.profile.followerCount,
    1,
    'GERÇEK bir takipten çıkma sonrası public toplam 2 -> 1 olmalı -- 776 DEĞİL. "776" eski fallback\'in yalnızca 1 azalmış hâli olurdu ve bu hiçbir şekilde "gerçek takipçi toplamı düzeldi" anlamına gelmezdi (fallback doğrulanmış veri değildir); bu yüzden fallback public toplama artık hiç karışmıyor.',
  );

  // Eski değer (777) production'da SAKLANIYOR -- silinmedi/değiştirilmedi.
  const rawRow = await strapiInstance.db.query('api::profile-setting.profile-setting').findOne({
    where: { documentId: bRow.documentId },
  } as any);
  assert.equal(rawRow.followersFallback, 777, 'eski fallback değeri production\'da hiç dokunulmadan saklanıyor -- sadece public toplamda KULLANILMIYOR');
});

test('Nokta 15/16 (açıkça raporlanan sonuç): SADECE eski fallback\'e sahip, hiç gerçek takipçisi olmayan bir hesap artık public\'te 0 gösterir -- görünür düşüş beklenir ve kabul edilir', async () => {
  const b = await registerAndLogin(`n15-onlylegacy-${randomUUID()}@test.local`);
  const bRow = await createOwnProfileSetting(b.jwt);
  await strapiInstance.db.query('api::profile-setting.profile-setting').update({
    where: { documentId: bRow.documentId },
    data: { followersFallback: 500 },
  });

  const { body } = await fetchPublicProfile(b.ownerId);
  assert.equal(
    body.profile.followerCount,
    0,
    'hiç gerçek (doğrulanmış) takipçisi olmayan bir hesap artık 0 gösterir -- önceki turda bu 500 gösterilirdi; bu KASITLI ve raporlanan bir görünür düşüştür, bir regresyon değil',
  );
});

test('Nokta 17/18: followersFallback generic PUT ile hâlâ ayarlanamaz (zaten stripli); ayrıca artık public toplama hiç karışmadığı için bunun bir önemi de yok', async () => {
  const b = await registerAndLogin(`n18-notverified-${randomUUID()}@test.local`);
  const bRow = await createOwnProfileSetting(b.jwt);

  const res = await fetch(`${BASE_URL}/profile-settings/${bRow.documentId}`, {
    method: 'PUT',
    headers: authed(b.jwt),
    body: JSON.stringify({ data: { followersFallback: 999999 } }),
  });
  const body = await res.json();
  assert.notEqual(body.data.followersFallback, 999999, 'followersFallback generic PUT ile yazılamıyor');

  const { body: pub } = await fetchPublicProfile(b.ownerId);
  assert.equal(pub.profile.followerCount, 0, 'her durumda public toplam gerçek listeden geliyor, fallback\'ten değil');
});

// ---------------------------------------------------------------------
// Nokta 3: eşzamanlılık garantisi -- withProfileRow artık
// `SELECT ... FOR UPDATE` (trx(...).forUpdate()) ile satırı kilitliyor
// (profile-setting.ts). Bu test SQLite üzerinde ÇALIŞMAYA DEVAM
// ETTİĞİNİ doğruluyor (regresyon) -- gerçek kilit garantisi Postgres
// (production) için koddaki .forUpdate() çağrısıdır, bu testin SQLite'ta
// geçmesi o garantinin KENDİSİ değildir (bkz. profile-setting.ts'in
// withProfileRow üzerindeki kendi doc yorumu).
// ---------------------------------------------------------------------

test('Nokta 3 (regresyon): kilit eklendikten SONRA eşzamanlı 8 farklı takipçi hâlâ hiç kaybolmadan kaydediliyor', async () => {
  const b = await registerAndLogin(`n3-lock-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(b.jwt);
  const followers = await Promise.all(
    Array.from({ length: 8 }, async (_, i) => {
      const u = await registerAndLogin(`n3-lock-f${i}-${randomUUID()}@test.local`);
      await createOwnProfileSetting(u.jwt);
      return u;
    }),
  );

  const results = await Promise.all(followers.map((f) => follow(f.jwt, b.ownerId)));
  for (const r of results) assert.equal(r.status, 200);

  const { body } = await fetchPublicProfile(b.ownerId);
  assert.equal(body.profile.followerCount, 8, 'kilit eklendikten sonra da 8 eşzamanlı takipçinin hiçbiri kaybolmamalı');
});

// Nokta 3 (kilidin kapsamı): A→B ve B→A karşılıklı takip işlemleri
// GERÇEKTEN eşzamanlı (Promise.all) çalıştırıldığında ikisi de başarıyla
// tamamlanmalı -- withTwoProfileRows'un iki satırı DAİMA aynı (sıralı)
// sırayla kilitlemesi sayesinde (hangisi "hedef" hangisi "görüntüleyen"
// olursa olsun) bu senaryo Postgres'te KİLİTLENMEDEN (deadlock) çözülür.
// SQLite'ta zaten tek-yazarlı olduğu için bu test o garantiyi KANITLAMAZ
// (yukarıdaki dosya başlığı yorumuyla aynı sınırlama) -- yalnız her iki
// isteğin de başarıyla, hatasız tamamlandığını ve nihai durumun doğru
// olduğunu (her iki taraf da diğerini takip ediyor) doğrular.
test('Nokta 3 (kilidin kapsamı): A→B ve B→A eşzamanlı karşılıklı takip -- ikisi de hatasız tamamlanır, sıra A-önce veya B-önce olmasından etkilenmez', async () => {
  const a = await registerAndLogin(`n3-reciprocal-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`n3-reciprocal-b-${randomUUID()}@test.local`);
  await createOwnProfileSetting(a.jwt);
  await createOwnProfileSetting(b.jwt);

  const [resAtoB, resBtoA] = await Promise.all([follow(a.jwt, b.ownerId), follow(b.jwt, a.ownerId)]);
  assert.equal(resAtoB.status, 200, 'A->B isteği deadlock/hata ile başarısız olmamalı');
  assert.equal(resBtoA.status, 200, 'B->A isteği deadlock/hata ile başarısız olmamalı');

  const aPub = await fetchPublicProfile(a.ownerId);
  const bPub = await fetchPublicProfile(b.ownerId);
  assert.equal(aPub.body.profile.followerCount, 1, 'A, B tarafından takip ediliyor olmalı');
  assert.equal(bPub.body.profile.followerCount, 1, 'B, A tarafından takip ediliyor olmalı');
});

// ---------------------------------------------------------------------
// Nokta 4: alan korumasının tamamı -- ana listedeki TÜM eski alias
// alanları (ratingVotes, voteCountBase, ratingAverageBase, followersIds,
// followersCountBase, vb.) tek tek, generic PUT üzerinden denenir.
// ---------------------------------------------------------------------

test('Nokta 4: ana listedeki TÜM eski alias alanları generic PUT ile tek tek denendiğinde HİÇBİRİ puan/takip toplamını değiştiremez', async () => {
  const user = await registerAndLogin(`n4-aliases-${randomUUID()}@test.local`);
  const own = await createOwnProfileSetting(user.jwt);

  const forgedFields: Record<string, unknown> = {
    ratingVotesByViewer: { u_someone: 5 },
    ratingVotes: { u_someone: 5 },
    ratingBaseCount: 500,
    voteCountBase: 500,
    ratingBaseAverage: 5,
    ratingAverageBase: 5,
    followerIds: ['u_fake_1'],
    followersIds: ['u_fake_1'],
    followers: ['u_fake_1'],
    followingIds: ['u_fake_2'],
    followsIds: ['u_fake_2'],
    following: ['u_fake_2'],
    followersFallback: 999999,
    followingFallback: 999999,
    followersCountBase: 999999,
    followingCountBase: 999999,
    incomingProfileComments: [{ id: 'fake', fromName: 'Sahte', text: 'Sahte yorum' }],
    incomingComments: [{ id: 'fake', fromName: 'Sahte', text: 'Sahte yorum' }],
  };

  // Her alanı AYRI AYRI deniyoruz -- biri diğerinin stripini maskelemesin.
  for (const [field, value] of Object.entries(forgedFields)) {
    const res = await fetch(`${BASE_URL}/profile-settings/${own.documentId}`, {
      method: 'PUT',
      headers: authed(user.jwt),
      body: JSON.stringify({ data: { [field]: value } }),
    });
    assert.equal(res.status, 200, `${field} isteği başarısız oldu: ${res.status}`);
    const body = await res.json();
    assert.notDeepStrictEqual(
      body.data[field],
      value,
      `${field} hâlâ generic PUT üzerinden client-sağlanan değerle yazılabiliyor -- Madde 18 kapanmamış`,
    );
  }

  // Meşru yazma yolları (rateProfile/followProfile/addProfileComment) bu
  // stripten etkilenmemiş olmalı -- aynı kullanıcı dışında biri gerçek
  // bir oy/takip/yorum eylemi yaptığında hâlâ çalışmalı.
  const other = await registerAndLogin(`n4-aliases-other-${randomUUID()}@test.local`);
  await createOwnProfileSetting(other.jwt);
  const rateRes = await rate(other.jwt, user.ownerId, 4);
  assert.equal(rateRes.status, 200, 'meşru rateProfile endpoint\'i strip\'ten etkilenmemiş olmalı');
  const followRes = await follow(other.jwt, user.ownerId);
  assert.equal(followRes.status, 200, 'meşru followProfile endpoint\'i strip\'ten etkilenmemiş olmalı');
});
