# TARIM360 — ENGAGEMENT BACKEND IMPLEMENTASYON RAPORU (Faz B)

> **GÜNCELLEME (Faz B-V):** Bu rapor Faz B'nin YAZILDIĞI anki durumu anlatır. Faz B-V (gerçek boot doğrulaması) bu raporun §7 ve §10'unda "bilinmiyor"/"risk" olarak işaretlenen noktalarda **6 gerçek bug** buldu ve düzeltti — migration'ların hiç keşfedilmemesi, eksik rol izinleri, `auth:false`'ta JWT'nin hiç okunmaması, `resolveTargetRow`'un eksik alan seçimi, **draft-and-publish nedeniyle sayaçların hiç görünmeyen taslak satıra yazılması**, ve DELETE isteklerinde body'nin ayrıştırılmaması. Güncel, doğrulanmış durum için **`ENGAGEMENT_BACKEND_VERIFICATION_REPORT.md`**'ye bakın — bu dosya artık asıl referanstır.

**Referans:** `ENGAGEMENT_API_CONTRACT.md` (v1, revize).
**Repo:** `C:\projeler\tarim360-strapi`, branch `feature/agri-data-strapi-schema`.
**Kapsam:** Yalnızca backend. Flutter'a hiç dokunulmadı. Push yapılmadı. Production veritabanına bağlanılmadı, migration çalıştırılmadı (yalnızca migration dosyaları oluşturuldu).

---

## 1. Doğrulanan Strapi Transaction API

`node_modules` kaynak kodu doğrudan okunarak (varsayım yapılmadan) doğrulandı:

- **API:** `strapi.db.transaction(async ({ trx, commit, rollback, onCommit, onRollback }) => {...})` — kaynak: `node_modules/@strapi/database/dist/index.js:56-93`.
- **Mekanizma:** Node `AsyncLocalStorage` (`transaction-context.js`) ile ambient bağlam taşınır. Callback içinde hata fırlatılırsa otomatik `rollback()`, aksi halde otomatik `commit()` — normal akışta manuel çağrı gerekmez.
- **Kritik doğrulama:** `strapi.entityService.*`/`strapi.db.query(uid).*` çağrıları, transaction callback'i içinde çalıştığı sürece **otomatik olarak aynı transaction'a katılır** — `query-builder.js:511-514`'te her `execute()` çağrısı `transactionContext.transactionCtx.get()`'i kontrol edip varsa `qb.transacting(transaction)` uyguluyor. Yani `{transacting: trx}` parametresini manuel taşımaya gerek yok, çağrının aynı async zincirde kalması yeterli.
- **`SELECT ... FOR UPDATE` — KULLANILAMAZ, doğrulandı:** `knex` 3.0.1'in SQLite dialekti `forShare`/`forUpdate`'i `emptyStr`'e sabitliyor (`knex/lib/dialects/sqlite3/query/sqlite-querycompiler.js:24-26`) — sessiz no-op, hata vermiyor. Bu yüzden hiçbir akış satır kilidine dayanmıyor.

## 2. Kullanılan DB Garanti Yöntemi

Satır kilidi yerine iki mekanizma kombinasyonu:

1. **DB-seviyeli composite unique constraint** (`engagement_interactions`: `actor_key,target_type,target_id,kind`; `engagement_views`: `actor_key,target_type,target_id`) — SQLite'ta `CREATE UNIQUE INDEX` olarak, tam tablo yeniden oluşturma gerektirmeden ekleniyor (doğrulandı: `knex/lib/dialects/sqlite3/schema/sqlite-tablecompiler.js:132-154`).
2. **Tek-atomik `UPDATE ... WHERE` ifadeleri** (sayaç artışı, view'in koşullu tazeleme kontrolü) — knex `??`/raw ile parametreli, storage-engine seviyesinde doğası gereği atomik, hiçbir kilit primitifi gerekmez.
3. **Insert-çakışması-yakala deseni**: unique constraint ihlali → "zaten var" kabul et, hata fırlatma (offer'ın kanıtlanmış `offerId` deseninin genellemesi).

Bu üçü birlikte, satır kilidi olmadan aynı garantiyi sağlıyor.

## 3. Eklenen Content-Type'lar

| Content-Type | Amaç | Public route | 
|---|---|---|
| `engagement-interaction` | Like/favorite kalıcı üyelik kaydı | Yok (yalnızca `entityService`/`db.query` ile dahili kullanım) |
| `engagement-view` | View'in "son görüntülenme" kaydı, kayan 24s dedup | Yok (dahili) |

## 4. Eklenen Migration'lar

| Dosya | Amaç | Bilinen sınır |
|---|---|---|
| `database/migrations/2026.07.30T00.00.00.add-engagement-interaction-unique-index.ts` | `engagement_interactions` üzerinde composite unique index | Tablo henüz yoksa sessizce atlar (bkz §9) |
| `database/migrations/2026.07.31T00.00.00.add-engagement-view-unique-index.ts` | `engagement_views` üzerinde composite unique index | Aynı sınır |

**Hiçbiri bu oturumda çalıştırılmadı** — yalnızca dosya olarak oluşturuldu, kurallar gereği.

## 5. Route / Controller / Service Listesi

| Route | Handler | Service |
|---|---|---|
| `PUT/DELETE /engagements/like` | `engagement-v1.putLike/deleteLike` | `engagement-v1.ts#setMembership` |
| `PUT/DELETE /engagements/favorite` | `engagement-v1.putFavorite/deleteFavorite` | aynı |
| `POST /engagements/view` | `engagement-v1.postView` | `engagement-view-service.ts#registerView` |
| `POST /listing-comments` (mevcut, operationId eklendi) | `listing-comment.create` | `listing-metrics.ts#recountListingComments` (dokunulmadı) |
| `POST /listing-shares` (mevcut, auth+operationId eklendi) | `listing-share.create` | `listing-metrics.ts#recountListingShares` (dokunulmadı) |
| `POST /listing-views` (legacy, delege edildi) | `listing-view.create` | `engagement-view-service.ts#registerView` |
| `POST /logistics-loads/:id/metrics/view` (legacy, delege edildi) | `logistics-load.metricView` | `engagement-view-service.ts#registerView` |
| `POST /listing-favorites/toggle`, `/listing-likes/toggle` (legacy, delege edildi) | `engagement.toggleListingFavorite/toggleListingLike` | `engagement-v1.ts#setMembership` |

Paylaşılan çekirdek: `src/api/engagement/services/engagement-core.ts` (`resolveTargetRow`, `incrementCounterAtomic`, `toSnakeCase`), `src/utils/engagement-contract.ts` (sabitler/tipler/zarf), `src/utils/operation-idempotency.ts` (comment/share için).

## 6. Legacy Uyumluluk Yöntemi

Hiçbir eski route kaldırılmadı. **Delege edilenler:** `toggleListingFavorite`/`toggleListingLike` (artık `setMembership` çağırıyor, response şekli korunuyor), `listing-view.create` ve `logistics-load`'un `/metrics/view`'i (artık `registerView` çağırıyor — Faz A'daki client-manipülasyon düzeltmesinin üzerine artık 24s dedup da eklendi).

**Bilinçli olarak delege EDİLMEYENLER** (bkz §9 — Bilinen Kalan Riskler): `toggleProfileFavorite`, `toggleLogisticsLoadLike`, `toggleFarmerQuestionLike`, `toggleProcessedProductLike`.

## 7. Test Sonuçları

**`npm test` (unit, bu oturumda gerçekten çalıştırıldı) — 23/23 geçti:**
```
tests/unit/engagement-contract.test.ts    — 12 test
tests/unit/operation-idempotency.test.ts  — 7 test
tests/unit/engagement-core.test.ts        — 4 test
```

**`npm run test:integration` — YAZILDI, ÇALIŞTIRILMADI.** Gerçek Strapi boot + geçici SQLite dosyası gerektiriyor; bu oturumun "DB'ye bağlanma" kuralı gereği çalıştırılamadı. `tsc --noEmit` bu dosyada da temiz geçiyor ama testlerin gerçekten geçtiği **gözlemlenmedi** — ilk çalıştırma gerçek doğrulama sayılmalı, formalite değil.

## 8. Commit Hash'leri (bu Faz B oturumunda, sıralı)

```
7764a67 feat: add engagement contract primitives
1c0471e feat: add engagement interaction persistence
71bd6a0 feat: add idempotent like and favorite endpoints
acca481 feat: add deduplicated engagement views
9764714 feat: add operation idempotency persistence
0c650b4 feat: add idempotent share endpoint
6fd0e07 feat: add minimum rate-limit protection for the auth-less view endpoint
62bdf28 refactor: delegate legacy engagement routes to the new engagement core
17ea73d test: add engagement concurrency coverage
```
(Öncesinde Faz A'nın 3 commit'i: `48be3c8`, `b806136`, `9bca80a` — bu raporun kapsamı dışında, önceki oturumda tamamlandı.)

## 9. Değiştirilen/Eklenen Dosyalar (özet — tam liste `git diff --stat 7764a67~1..HEAD`)

42 dosya, +2406/-75 satır. Yeni: 2 content-type klasörü (`engagement-interaction`, `engagement-view`), 2 migration, `engagement-contract.ts`, `operation-idempotency.ts`, `engagement-core.ts`, `engagement-v1.ts` (controller+service+routes), `engagement-view-service.ts`, `engagement-rate-limit.ts` middleware, 4 test dosyası. Değiştirilen: 7 content-type schema.json (`engagementVersion` + eksik sayaç alanları eklendi — additive, hiçbir alan kaldırılmadı/yeniden adlandırılmadı), `engagement.ts`, `listing-view.ts`, `logistics-load.ts` controller'ları (delegasyon), `listing-comment.ts`/`listing-share.ts` controller+schema (operationId), `package.json`/`package-lock.json` (`tsx` devDependency + test script'leri).

**Dokunulmayan, korunan WIP:** `src/api/offer/controllers/offer.ts` (hâlâ commit'lenmemiş, Faz A öncesinden), `src/utils/listing-metrics.ts` (hâlâ commit'lenmemiş).

## 10. Bilinen Kalan Riskler

1. **Migration sıralama riski (kritik, açıkça belgelendi):** Strapi migration'ları yeni content-type tablosu oluşturulmadan ÖNCE çalıştırıyor (`@strapi/database`'in `schema/index.js#sync()` kaynağından doğrulandı). Aynı deploy'da hem content-type hem migration ilk kez devreye girerse, composite unique index o ilk boot'ta eklenemeyebilir ve migration ledger'ına "tamamlandı" yazılıp bir daha hiç denenmeyebilir. **Deploy sonrası zorunlu doğrulama:** `PRAGMA index_list('engagement_interactions')` ve `PRAGMA index_list('engagement_views')` ile index'lerin gerçekten oluştuğunu kontrol edin; yoksa migration dosyasının adını `strapi_migrations` tablosundan silip uygulamayı yeniden başlatın.
2. **`toggleProfileFavorite`, `toggleLogisticsLoadLike`, `toggleFarmerQuestionLike`, `toggleProcessedProductLike` delege edilmedi.** İlk üçü Flutter tarafından hiç çağrılmıyor (önceki denetimde doğrulanmıştı) — düşük risk. `toggleProfileFavorite` yapısal olarak farklı (hedef-sayaç değil, iki-yönlü profil ilişkisi) — bu fazın kapsamı dışında bırakıldı.
3. **`recountListingComments`/`recountListingShares` üzerinden güncellenen sayaçlar `engagementVersion`'ı artırmıyor.** Yalnızca like/favorite/view mutasyonları `serverVersion`'ı garantili artırıyor; comment/share'in recount-tabanlı yolu bu fazda ele alınmadı (mevcut, dokunulmamış `listing-metrics.ts` WIP'i değiştirmemek için bilinçli tercih).
4. **Integration testleri çalıştırılmadı** (bkz §7) — ilk gerçek çalıştırma, bu implementasyonun runtime doğruluğunun İLK gerçek kanıtı olacak.
5. **Rate-limit yalnızca view endpoint'inde, yalnızca in-memory/tek-process.** Çoklu-instance deploy'da koruma sağlamaz (proje şu an SQLite/tek-instance göstergesi taşıyor, ama bu kesin bir garanti değil).
6. **Misafir (guest) actor-key için Flutter tarafında henüz cihaz-kalıcı UUID üretimi yok** — backend `guestActorId` kabul etmeye hazır (UUID formatı doğrulanıyor), ama Flutter bunu göndermeye başlamadan misafir view-dedup'ı büyük ölçüde IP-fallback'e düşecek (daha kaba, ama işlevsiz değil).
7. **Ownership (kendi hedefini beğenememe) kontrolü yalnızca `listing` için var.** Logistics-load/processed-product/ad/hub-content için bu fazda eklenmedi.

## 11. Flutter Faz C İçin Kesin API Çağrı Sözleşmesi

```
PUT    /api/engagements/like      { targetType, targetId }   [JWT zorunlu]
DELETE /api/engagements/like      { targetType, targetId }   [JWT zorunlu]
PUT    /api/engagements/favorite  { targetType, targetId }   [JWT zorunlu]
DELETE /api/engagements/favorite  { targetType, targetId }   [JWT zorunlu]
POST   /api/engagements/view      { targetType, targetId, guestActorId? }  [JWT veya guestActorId]

targetType ∈ {listing, logistics-load, logistics-vehicle, processed-product, ad, hub-content, profile}
```

**Response (like/favorite):** `{success, active, changed, count, target:{type,id}, updatedAt, serverVersion, contractVersion}` — Flutter **kendi hesapladığı sayıyı asla göstermemeli**, `count` alanını doğrudan göstermeli.

**Response (view):** `{success, incremented, count, target, updatedAt, serverVersion, contractVersion}`.

**Hata zarfı:** `{success:false, error:{code, message}, contractVersion}` — `code` ∈ `UNAUTHORIZED|FORBIDDEN|NOT_FOUND|VALIDATION_ERROR|ENGAGEMENT_NOT_SUPPORTED|RATE_LIMITED|CONFLICT|SERVER_ERROR`. Flutter, `ENGAGEMENT_NOT_SUPPORTED` alan bir domain için o metriği hiç göstermemeli (sessizce yutmak yerine, geliştirme sırasında bunun bir programlama hatası olduğunu varsaymalı).

**Comment/Share (mevcut route'lar, artık `operationId` zorunlu):**
```
POST /api/listing-comments { listingId, body, operationId }   [JWT zorunlu]
POST /api/listing-shares   { listingId, channel, operationId } [JWT zorunlu, ÖNCEDEN auth'suzdu]
```
`operationId`: Flutter'ın ürettiği bir UUID (her mantıksal kullanıcı eylemi için bir kez üretilir, retry'lerde AYNI değer tekrar gönderilir — yeni bir UUID üretilirse idempotency çalışmaz).

**Faz C'nin ilk işi:** `EngagementService` bu sözleşmeyi tüketmeli; hiçbir yerde `likeCount`/`favoriteCount`/`viewCount` istemci tarafında hesaplanıp sunucuya gönderilmemeli — yalnızca niyet gönderilir, sayaç `count` alanından okunur.

---

Faz B tamamlandı. Flutter koduna geçilmedi, push yapılmadı.
