# TARIM360 — ENGAGEMENT BACKEND DOĞRULAMA RAPORU (Faz B-V)

**Amaç:** Faz B'nin yazılan-ama-çalıştırılmayan kodunu gerçek bir Strapi boot + geçici SQLite test veritabanı ile fiilen doğrulamak. Production veritabanına bağlanılmadı, migration production'da çalıştırılmadı — yalnızca proje köküne göre relatif, tek-seferlik, atılabilir test dosyaları (`.verification-tmp/*.db`, `tests/integration/.tmp-*.db`) kullanıldı; tümü iş bitince silindi. WIP dosyaları (`offer.ts`, `listing-metrics.ts`) değiştirilmedi/commit'lenmedi, hâlâ orijinal haliyle duruyor. Push yapılmadı.

**Sonuç, özetle: Faz B'nin yazdığı kod DOĞRU MİMARİYE sahipti ama 6 gerçek, üretim-engelleyici bug taşıyordu — hepsi bu doğrulama turunda bulundu ve düzeltildi. Şimdi 23/23 unit test + 23/23 integration test gerçek bir Strapi instance'a karşı geçiyor.**

---

## PASS/FAIL TABLOSU

| # | Kontrol | Durum | Kanıt |
|---|---|---|---|
| 1 | `npx tsc --noEmit` (tüm proje) | ✅ PASS | Exit code 0 |
| 2 | `npm test` (23 unit test, no-DB) | ✅ PASS | 23/23, aşağıda tam çıktı |
| 3 | Yeni content-type tabloları gerçekten oluşuyor mu | ✅ PASS | `engagement_interactions`, `engagement_views` gerçek boot'ta oluştu |
| 4 | Composite unique index'ler gerçekten kuruluyor mu | ✅ PASS (düzeltme sonrası) | `PRAGMA index_list` ile doğrulandı, `unique:1` bayrağıyla |
| 5 | `npm run test:integration` (23 concurrency/idempotency testi, gerçek DB) | ✅ PASS (düzeltmeler sonrası) | 23/23, aşağıda tam çıktı |
| 6 | Eşzamanlı PUT/DELETE testleri | ✅ PASS | count asla negatif değil, tam olarak 1 kez artıyor |
| 7 | View 24s dedup (kayan pencere) | ✅ PASS | ilk view / pencere-içi tekrar / pencere-sonrası tekrar hepsi doğru |
| 8 | Rollback (transaction hata durumunda geri alma) | ⚠️ DOLAYLI DOĞRULANDI | Doğrudan bir "transaction ortasında hata fırlat" testi yazılmadı; ama `strapi.db.transaction`'ın hata durumunda otomatik rollback yaptığı kaynak kod okumasıyla (Faz B raporu §1) ve concurrency testlerinin (insert-çakışması → catch → doğru sayaç) tutarlı sonuç vermesiyle dolaylı doğrulandı. Bkz §7 "Kalan Riskler". |
| 9 | Legacy + yeni endpoint'in aynı kaynağa yazdığı | ✅ PASS (mimari olarak) | `engagement.ts`'in legacy `toggleListingFavorite/toggleListingLike`'ı artık `setMembership`'i çağırıyor — kod seviyesinde aynı fonksiyon, ayrı bir "iki endpoint aynı anda" testi yazılmadı ama aynı fonksiyonu çağırdıkları için mantıksal olarak imkansız çift kayıt |
| 10 | Production DB connector doğrulaması | ✅ PASS | `.env`: `DATABASE_CLIENT` tanımlı değilse varsayılan `sqlite`; kurulu bağımlılık yalnızca `better-sqlite3` (pg/mysql driver'ı yok) — bkz §6 |
| 11 | WIP dosyaları değiştirilmedi/commit'lenmedi | ✅ PASS | `git status --short` altta |
| 12 | Push yapılmadı | ✅ PASS | Yalnızca lokal commit'ler |

---

## Bu Turda Bulunan ve Düzeltilen 6 Gerçek Bug

### 1. Migration dosyaları hiçbir zaman keşfedilmiyordu
**Kanıt:** İlk boot'ta `strapi_migrations` tablosu tamamen boştu, hiçbir log satırı yoktu.
**Kök neden (ikisi birden):**
- `config/database.ts`'de `settings.useTypescriptMigrations: true` yoktu → Strapi migration'ları TS kaynak klasöründe arıyordu (`.js`/`.sql` glob'u, orada yalnızca `.ts` var) — `@strapi/core`'un `Strapi.js:211-213`'ünde doğrulandı.
- Migration dosyaları `export default {up, down}` kullanıyordu; migration resolver `require(path).up` diye doğrudan okuyor (`@strapi/database/migrations/users.js`), `.default.up` değil.
**Düzeltme:** `config/database.ts`'ye bayrak eklendi + migration dosyaları adlandırılmış `export async function up/down` kullanacak şekilde değiştirildi.
**Doğrulama:** Düzeltme sonrası gerçek boot loglarında `[internal migration]: migrating ...` satırları göründü.

### 2. Migration sıralaması (ayrı, ikinci sorun)
**Kanıt:** Migration artık keşfediliyor OLSA da, gerçek boot logunda: `[engagement migration] engagement_interactions does not exist yet — skipping...` — çünkü Strapi migration'ları şema senkronundan ÖNCE çalıştırıyor (`@strapi/database`'in `schema/index.js#sync()`'inde doğrulandı: `db.migrations.up()` önce, `syncSchema()` sonra).
**Düzeltme:** `src/index.ts`'in `bootstrap({strapi})` hook'una `ensureEngagementUniqueIndexes` eklendi — bu, şema senkronundan KESİNLİKLE SONRA çalışıyor (Strapi'nin kendi boot sırası garantisi), idempotent, ve gerçek bir hata durumunda sessizce yutmuyor (rethrow ediyor, boot'u durduruyor).
**Doğrulama:** Gerçek boot logunda: `[engagement bootstrap] Created unique index engagement_interactions_actor_target_kind_unique on engagement_interactions.` + `PRAGMA index_list` ile `unique:1` bayrağıyla doğrulandı.

### 3. "authenticated" rolüne yeni/eski engagement action'ları hiç tanımlanmamıştı
**Kanıt:** `PUT /api/engagements/like` geçerli bir JWT ile bile **403** dönüyordu.
**Kök neden:** `src/index.ts`'teki `authenticatedActions` allowlist'i (bu projenin kendi, kod-takipli izin mekanizması) bu action'ların HİÇBİRİNİ içermiyordu — ne yeni `engagement-v1.*` ne de daha önce var olan legacy `engagement.*` action'ları. Gerçek prod/dev ortamında bu muhtemelen admin panelinden elle açılmış (kod dışı, tekrarlanamaz).
**Düzeltme:** `api::engagement.engagement-v1.putLike/deleteLike/putFavorite/deleteFavorite/postView`, legacy `engagement.*` action'ları, ve `listing-comment.create/delete`, `listing-share.create` listeye eklendi.
**Doğrulama:** Gerçek boot + gerçek HTTP isteğiyle, `200`/`201` dönüyor.

### 4. `auth:false` rotalarda JWT hiç okunmuyor
**Kanıt:** `POST /engagements/view` geçerli bir JWT gönderilse bile `400 VALIDATION_ERROR` ("guestActorId gerekli") dönüyordu.
**Kök neden:** Strapi'nin `auth:false` route ayarı JWT doğrulamasını TAMAMEN atlıyor — `ctx.state.user` hiçbir zaman doldurulmuyor, token gönderilse bile.
**Düzeltme:** Yeni `src/middlewares/engagement-soft-auth.ts` — Strapi'nin KENDİ `users-permissions` JWT servisini kullanarak (yeniden icat etmeden) token varsa doğrulayıp `ctx.state.user`'ı dolduruyor, yoksa/geçersizse sessizce devam ediyor (asla reddetmiyor — auth zaten opsiyonel).
**Doğrulama:** Gerçek istekle, JWT'li view isteği artık doğru `actorKey`'i kullanıyor.

### 5. `resolveTargetRow` eksik alan seçimi
**Kanıt:** Aynı PUT isteği iki kez gönderildiğinde, ikinci (no-op) cevap `count:0, serverVersion:0` dönüyordu — ilk cevap `count:1, serverVersion:1` iken.
**Kök neden:** `resolveTargetRow`, hedefi yalnızca `['id','documentId']` alanlarıyla çekiyordu; no-op yolu `target.likeCount`/`target.engagementVersion`'ı okuyordu ama bunlar hiç seçilmediği için `undefined` idi.
**Düzeltme:** Alan kısıtlaması tamamen kaldırıldı, tam entity çekiliyor.

### 6. **EN KRİTİK** — draft-and-publish nedeniyle sayaçlar hiç görünmeyen taslak satıra yazılıyordu
**Kanıt (doğrudan, ham satır dökümüyle):**
```
CLIENT-FACING listing id (yaratma cevabından): 2
ALL raw listing rows: [{"id":1,"publishedAt":null,"likeCount":0},{"id":2,"publishedAt":"...","likeCount":0}]
[PUT /engagements/like]
ALL raw listing rows AFTER like: [{"id":1,"publishedAt":null,"likeCount":1},{"id":2,"publishedAt":"...","likeCount":0}]
```
**Kök neden:** `listing` şeması `draftAndPublish:true`. Bir ilan oluşturulduğunda AYNI `documentId`'yi paylaşan İKİ satır oluşuyor: taslak (draft, `publishedAt:null`) ve yayınlanan (published). İstemciye dönen ve gerçek kullanıcıların gördüğü satır **published** olanı (`id:2`), ama `entityService.findOne(uid, id)` — `status` parametresi verilmezse — Strapi'nin Document Service'i **varsayılan olarak DRAFT'ı** döndürüyor (`@strapi/core`'un `services/document-service/draft-and-publish.js`'inde doğrulandı). Sonuç: her like/favorite/view işlemi, kullanıcının hiç göremediği taslak satırın sayaçlarını artırıyordu — **yayınlanan ilanın sayacı sonsuza kadar 0 kalıyordu.**
**Düzeltme:** `resolveTargetRow`'daki her `entityService.findOne` çağrısına `{status:'published'}` eklendi.
**Doğrulama:** Düzeltme sonrası, aynı senaryoda `id:2` (published) `likeCount:1` oluyor, `id:1` (draft) `0` kalıyor — doğru.
**Önem notu:** Bu bug, statik kod incelemesiyle veya unit testle **yakalanamazdı** — yalnızca gerçek bir Strapi boot + gerçek bir draft-and-publish content-type'a karşı gerçek bir istek atarak ortaya çıktı. Kullanıcının bu doğrulama turunu ısrarla istemesinin tam olarak haklı çıktığı nokta budur.

**Ayrıca (aynı turda bulunan, kod bug'ı değil ama test/sözleşme netliği gerektiren 2 bulgu):**
- DELETE istekleri bu Strapi/Koa kurulumunda body'yi HİÇ ayrıştırmıyor (JSON body gönderilse bile `ctx.request.body` boş) — `dataBody()` artık query-string'i de (fallback olarak) okuyor; DELETE çağrıları `?targetType=...&targetId=...` kullanmalı.
- Token TAMAMEN eksikse Strapi'nin kendi yetkilendirme katmanı **403** dönüyor (401 değil) — çünkü anonim istek "public" rolü olarak değerlendiriliyor ve o rolün izni yok. Bu, Strapi'nin standart davranışı; sözleşmenin UNAUTHORIZED=401 tanımı geçerli bir JWT'nin REDDEDİLMESİ durumu için geçerli, tokenin TAMAMEN YOKLUĞU için değil.

---

## Gerçek Komut Çıktıları

### `npx tsc --noEmit`
```
TSC_EXIT=0
```

### `npm test` (unit, no-DB)
```
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

### `npm run test:integration` (gerçek Strapi boot + geçici SQLite)
```
✔ like: first PUT activates and increments count (changed:true)
✔ like: repeating the same PUT is a no-op (changed:false, same active/count)
✔ like: DELETE after PUT deactivates and decrements
✔ like: repeating DELETE when already inactive is a no-op
✔ like: two concurrent PUTs from the same actor result in count=1, not 2
✔ like: two concurrent DELETEs from the same already-liked actor result in count=0, not -1
✔ like: request with no JWT at all is rejected before reaching our controller
✔ favorite: unsupported domain (logistics-vehicle) returns ENGAGEMENT_NOT_SUPPORTED
✔ like: non-existent target returns NOT_FOUND
✔ view: first view increments and returns incremented:true
✔ view: repeating within 24h does not increment again
✔ view: after the 24h window elapses, a new view increments again
✔ view: two concurrent first-views from the same actor increment exactly once
✔ view: a client-supplied count/viewCount in the body is ignored
✔ view: an invalid guest UUID is rejected
✔ view: non-existent target returns NOT_FOUND
✔ share: first operationId creates a real row and returns 201
✔ share: retrying the same operationId with the same payload is idempotent
✔ share: same operationId with a DIFFERENT payload returns 409 CONFLICT
✔ share: two concurrent requests with the same operationId create exactly one row
✔ share: request with no JWT at all is rejected
✔ general: engagementVersion only advances on a real mutation, not on a no-op retry
✔ general: count matches the real engagement-interaction row count

ℹ tests 23
ℹ pass 23
ℹ fail 0
```

### DB Index Doğrulaması (ham `PRAGMA` çıktısı, gerçek test boot'undan)
```
indexes on engagement_interactions: [{"name":"engagement_interactions_actor_target_kind_unique","unique":1},
  {"name":"engagement_interactions_updated_by_id_fk","unique":0},
  {"name":"engagement_interactions_created_by_id_fk","unique":0},
  {"name":"engagement_interactions_documents_idx","unique":0}]
  engagement_interactions_actor_target_kind_unique columns: ["actor_key","target_type","target_id","kind"]

indexes on engagement_views: [{"name":"engagement_views_actor_target_unique","unique":1}, ...]
  engagement_views_actor_target_unique columns: ["actor_key","target_type","target_id"]
```

### `git status --short` (WIP korunuyor mu)
```
 M src/api/offer/controllers/offer.ts
?? src/utils/listing-metrics.ts
```
(İkisi de bu turda ve önceki Faz B/A turlarında hiç dokunulmadı — hâlâ orijinal, commit'lenmemiş haliyle duruyor.)

---

## Production DB Connector Doğrulaması

`package.json`'da yalnızca `better-sqlite3` kurulu (`pg`/`mysql2` yok). `.env`'de `DATABASE_CLIENT` tanımlı değil → `config/database.ts`'nin varsayılanı `sqlite` devreye giriyor. Bu, projenin production'da da SQLite kullandığını **kesin** kanıtlamaz (env değişkeni gerçek deploy ortamında farklı ayarlanmış olabilir) ama kurulu bağımlılıklar (yalnızca `better-sqlite3`) production'da da başka bir motor kullanılmadığına dair güçlü bir gösterge. Eğer gerçek production Postgres/MySQL kullanıyorsa: composite unique index migration'ının `CREATE UNIQUE INDEX` sözdizimi (knex üzerinden) her üç motorda da standart ve taşınabilir olduğundan risk düşük, ama `PRAGMA index_list`/`PRAGMA table_info` gibi SQLite'a özel doğrulama komutları o ortamda çalışmaz — Postgres için `\d+ engagement_interactions` veya `SELECT * FROM pg_indexes WHERE tablename='engagement_interactions'` kullanılmalıdır.

---

## Kalan Riskler (artık daha az ve daha net)

1. **Transaction rollback'in DOĞRUDAN bir testi yok** — yalnızca dolaylı kanıt var (insert-çakışması senaryoları doğru sonuç veriyor, kaynak kod okuması `db.transaction`'ın hata durumunda `rollback()` çağırdığını gösteriyor). Gerçek bir "transaction ortasında zorla hata fırlat, interaction satırının da sayaç artışının da geri alındığını doğrula" testi yazılmadı — bu, gelecekte eklenebilecek somut bir iyileştirme.
2. **`toggleProfileFavorite`/`toggleLogisticsLoadLike`/`toggleFarmerQuestionLike`/`toggleProcessedProductLike` hâlâ delege edilmedi** (Faz B'nin bilinçli kapsam dışı bırakması, değişmedi).
3. **Comment/share'in recount-tabanlı sayaçları `engagementVersion`'ı artırmıyor** (değişmedi).
4. **Rate-limit hâlâ yalnızca in-memory/tek-process, yalnızca view'da** (değişmedi).
5. **Flutter'da misafir cihaz-UUID üretimi yok** (değişmedi, Faz C'nin işi).
6. **Ownership kontrolü yalnızca `listing` için var** (değişmedi).
7. **Production gerçekten SQLite mi kesin doğrulanmadı** (yalnızca güçlü gösterge var, §6).
8. **"Legacy + yeni endpoint aynı anda çağrılırsa duplicate üretmiyor" iddiası testle değil, kod-okumasıyla doğrulandı** (ikisi de aynı `setMembership` fonksiyonunu çağırıyor, bu yapısal olarak duplicate'i imkansız kılıyor, ama bunu kanıtlayan ayrı bir entegrasyon testi yazılmadı).

---

## KESİN KARAR

| Soru | Cevap |
|---|---|
| Kod yazımı tamamlandı mı? | ✅ Evet |
| Gerçek DB/boot doğrulaması yapıldı mı? | ✅ Evet — bu raporun konusu |
| Migration güvenilir mi? | ✅ Evet (bootstrap-hook mekanizmasıyla, migration dosyaları ikincil/yedek) |
| Composite unique index'ler gerçekten var mı? | ✅ Evet, `PRAGMA index_list` ile doğrulandı |
| Concurrency/idempotency testleri geçiyor mu? | ✅ Evet, 23/23, gerçek DB'ye karşı |
| Draft-and-publish sayaç bug'ı çözüldü mü? | ✅ Evet — bu turun en kritik bulgusu ve düzeltmesi |
| Production-ready backend mi? | ✅ **Faz B'nin kapsamı için evet** — kalan riskler (yukarıda) bilinçli kapsam-dışı bırakmalar veya düşük-öncelikli iyileştirmeler, bloklayıcı değil |
| Flutter Faz C'ye başlanabilir mi? | ✅ **EVET** — tüm kritik testler (like/favorite/view/share concurrency, idempotency, ENGAGEMENT_NOT_SUPPORTED, count/version doğruluğu) gerçek bir Strapi instance'a karşı geçti |

**Flutter Faz C (EngagementService → Repository → Store → EngagementBar) için onay: READY.**
