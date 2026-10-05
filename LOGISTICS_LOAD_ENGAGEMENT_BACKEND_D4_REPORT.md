# FAZ D4-B — LOGISTICS LOAD BACKEND DELEGASYONU — RAPOR

**Kapsam: yalnızca `targetType=logisticsLoad` (`api::logistics-load.logistics-load`), `kind=like` ve `kind=favorite`.** Flutter'a dokunulmadı (yalnızca read-only referans). Şema değişmedi (`engagementVersion` zaten mevcuttu). Push yapılmadı.

---

## 1. Eski Akış (D4-B.1 bulgusu)

İki bağımsız, birbirinden habersiz yazı yolu vardı:

1. **`POST /logistics-loads/:id/metrics/like|favorite`** (`auth:{scope:[]}`) → `createMetricUpdater` → `applyLoadActorMetric` — kendi `likedActorKeys`/`favoriteActorKeys` JSON dizisine yazıyor, `likeCount`/`favoriteCount` = `actors.size` (dizi boyutu). Hiçbir atomiklik/kilitleme yok — klasik "kayıp güncelleme" yarışına açık. **Flutter'ın gerçekten kullandığı, tek aktif yol buydu** (`LogisticsStore.toggleLoadLike`/`registerLoadFavorite`).
2. **`POST /logistics-load-likes/toggle`** (`auth:{scope:[]}`) → `toggleLogisticsLoadLike` — birincil işi `profile_settings.likedLogisticsLoadIds` listesini güncellemekti, YAN ETKİ olarak `applyLoadActorMetric`'i de çağırıyordu. Flutter tarafında **sıfır çağrı noktası** (ölü kod, ama eski yayınlanmış istemciler çağırabilir).

**Kritik risk (D4-B.1'de tespit edildi):** bu iki yol farklı actor-key formatı kullanıyordu — `logistics-load.ts`'nin kendi `actorKeyFor(user)`'ı `profile:<id>` veya `email:<email>` üretiyordu, yeni `engagement_interactions` tablosunun canonical formatı ise `user:<email>`. İkisi aynı tabloya farklı actor-key string'leriyle yazsaydı, composite-unique kısıt aynı gerçek kullanıcıyı deduplike EDEMEZDİ.

`engagement-contract.ts`'deki sözleşme haritaları (`TARGET_UID`, `TARGET_COLLECTION`, `COUNTER_FIELD`, `DOMAIN_SUPPORT`) **zaten** `logistics-load` için tam doluydu — yeni `setMembership` çekirdeği bu domain için hazırdı, D4-B'nin gerçek işi yalnızca 2 legacy yazı yolunu buna delege etmekti.

## 2. Yeni Kanonik Akış

Her iki legacy giriş noktası artık **aynı** `setMembership` çekirdeğini çağırıyor — `PUT/DELETE /engagements/like|favorite`'ın kullandığı tam olarak aynı fonksiyon:

- **`applyLoadActorMetric`** (`logistics-load.ts`) yeniden yazıldı: `setMembership(strapi, actorKey, 'logistics-load', loadId, metric, active)` çağırıyor (transaction-wrapped, atomic `incrementCounterAtomic` + `engagement_interactions` composite-unique kısıt). Sonuç değişmişse (`result.changed`), legacy `likedActorKeys`/`favoriteActorKeys` dizisine best-effort bir mirror yazıyor — try/catch içinde, başarısız olursa yalnızca `strapi.log.warn`, gerçek mutasyonu asla engellemiyor/geciktirmiyor.
- **`createMetricUpdater`** (`/metrics/like`, `/metrics/favorite`) artık `requireAuthenticatedActorKey(ctx)` kullanıyor (eski `actorKeyFor(user)` yerine) — canonical `user:<email>` formatına geçti.
- **`toggleLogisticsLoadLike`** (`engagement.ts`) tamamen yeniden yazıldı: `requireAuthenticatedActorKey` + `applyLoadActorMetric` çağırıyor; `profile_settings.likedLogisticsLoadIds` yalnızca `result.changed && result.active` — yani **sunucunun gerçek sonucuna göre** güncelleniyor, istemcinin gönderdiği `liked` değerine göre değil.

Sonuç: hangi endpoint çağrılırsa çağrılsın (yeni PUT/DELETE, `/metrics/like|favorite`, veya `/logistics-load-likes/toggle`), aynı kullanıcı için tek bir `engagement_interactions` satırı ve tek bir sayaç değişikliği oluşuyor.

## 3. Beklenmeyen Bulgu ve Ek Düzeltme

Testleri gerçek bir Strapi boot ile çalıştırırken **doğrulanmamış bir varsayım çöktü**: `/metrics/like` ve `/metrics/favorite` rotaları geçerli bir JWT ile bile **403** dönüyordu. Sebep: bu rotalar `auth:{scope:[]}` kullanıyor (JWT + izin gerektirir), ama `metricLike`/`metricFavorite` action'ları **hiçbir yerde** "authenticated" rolüne izin olarak verilmemişti — tam olarak Faz B-V'nin `/engagements/*` ve `toggleLogisticsLoadLike` için daha önce düzelttiği aynı sınıf gap. Prod/dev ortamında muhtemelen bir yerde admin panelinden manuel tıklanmış (DB'de duruyor, kodda yok) — ama taze/CI ortamında bu satırlar reddedilirdi.

`src/index.ts`'teki `syncUsersPermissionsRoleConfig`'in `authenticatedActions` dizisine `api::logistics-load.logistics-load.metricLike` ve `.metricFavorite` eklendi (aynı dosyadaki `/engagements/*` girişleriyle birebir aynı desen). Bu olmadan D4-B'nin delegasyonu, gerçek kullanıcılar için legacy rotalara hiç ulaşılamadığı için anlamsız kalırdı — kapsam dışı değil, delegasyonun çalışabilir olmasının ön koşuluydu.

## 4. `likedActorKeys`/`favoriteActorKeys` Kararı (D4-B.4)

Sizin tercihiniz doğrultusunda: **`engagement_interactions` gerçek kaynak, JSON dizileri yalnızca geçici, best-effort bir mirror.**

- Doğrulandı (grep, hem backend hem Flutter): bu diziler **hiçbir yerde okunmuyor** — ne bu repo içinde ne Flutter'da. Sayaç artık asla `actors.size`'dan hesaplanmıyor.
- Mirror yazımı `try/catch` içinde — başarısız olsa bile gerçek mutasyon (setMembership) etkilenmiyor.
- **Kaldırılabilme koşulu (teknik borç):** bu diziler, dış/admin-panel bir tüketici olmadığı kesinleşince güvenle silinebilir. Şu an için "belki bir yerde okunuyordur" ihtimaline karşı tutuluyor — kesin okuyucu yoksa bir sonraki temizlik fazında (`D-final` benzeri) şemadan kaldırılabilir.

## 5. Test Sonuçları (D4-B.5)

Gerçek Strapi boot + tek kullanımlık SQLite DB ile (`tests/integration/logistics-load-engagement.integration.test.ts`, 24 test):

| Senaryo | Sonuç |
|---|---|
| İlk like/favorite (yeni PUT) | PASS |
| Tekrar PUT (no-op, `changed:false`) | PASS |
| DELETE ile unlike (decrement) | PASS |
| 2 eşzamanlı PUT → count=1 | PASS |
| PUT/DELETE yarışı → count asla negatif değil | PASS |
| `engagementVersion` no-op retry'de artmıyor | PASS |
| `engagement_interactions` satır sayısı sayaçla eşleşiyor | PASS |
| Var olmayan yük → 404 | PASS |
| Legacy `/metrics/like` ilk çağrı, tekrar çağrı, `active:false` | PASS |
| Legacy `/metrics/like` JWT'siz istek → 403 (Strapi'nin kendi native davranışı) | PASS |
| Legacy `/metrics/favorite` ilk çağrı, tekrar çağrı | PASS |
| Legacy `/logistics-load-likes/toggle` ilk çağrı, tekrar çağrı, profile-setting mirror | PASS |
| **Legacy + yeni, aynı kullanıcı, art arda (like)** — sayaç yalnızca 1 kez değişiyor | PASS |
| **Legacy + yeni, aynı kullanıcı, art arda (favorite)** — sayaç yalnızca 1 kez değişiyor | PASS |
| **Legacy + yeni, aynı kullanıcı, GERÇEKTEN eşzamanlı (favorite)** — tek `engagement_interactions` satırı | PASS |
| Bozuk/eski `likedActorKeys` dizisi gerçek sayacı etkilemiyor | PASS |

**24/24 PASS.** Tüm `tests/integration/` (listing + logistics-load birlikte): **47/47 PASS.** Unit testler: **23/23 PASS** (değişmedi). `npx tsc --noEmit`: temiz.

## 6. Son Tarama (D4-B.6)

grep ile doğrulandı:

| Aranan | Sonuç |
|---|---|
| `likeCount`/`favoriteCount`'a doğrudan yazan kod (increment/decrement) | **0** — yalnızca `metricBody`'nin okuma amaçlı erişimi ve `sanitizeCreateData`'nın create anında 0'a sıfırlaması kaldı. Tüm gerçek artış/azalış `setMembership`→`incrementCounterAtomic` üzerinden. |
| `likedActorKeys`/`favoriteActorKeys`'e yazan kod | 3 yer: `applyLoadActorMetric`'in best-effort mirror'ı (yeni), `sanitizeCreateData` (create'te boş dizi), `require-logistics-premium.ts` policy'si (create'te boş dizi — create-time initialization, mutasyon değil). Çakışan ikinci bir "gerçek kaynak" yok. |
| `likedLogisticsLoadIds`'e yazan kod | 1 yer: `toggleLogisticsLoadLike`, yalnızca `result.active`/`result.changed`'den. |
| Delege edilmemiş kalan endpoint | **Yok.** Logistics-load için like/favorite'a yazan 2 legacy giriş noktasının (`/metrics/like|favorite`, `/logistics-load-likes/toggle`) ikisi de `setMembership`'e bağlı. |
| Çift-sayaç-güncelleme riski | **Yok** — tüm yollar tek transaction içindeki tek `incrementCounterAtomic` çağrısına iniyor; concurrency testleri bunu gerçek eşzamanlı isteklerle doğruladı. |

## 7. Commit'ler

İki commit yapıldı (mandattaki 3 yerine — bkz. aşağıdaki sapma açıklaması):

```
cc25bd6 refactor: delegate logistics load like+favorite to engagement v1
68394e9 test: add logistics load legacy compatibility coverage
```

**Sapma açıklaması:** Mandat "like" ve "favorite" delegasyonu için ayrı commit istiyordu. Gerçek kod yapısında bu ikisi **tek, metric-agnostic bir fonksiyonu** (`applyLoadActorMetric(strapi, load, actorKey, metric: 'like'|'favorite', active)`) paylaşıyor — `metric` parametresiyle ayrışıyor, aynı `createMetricUpdater` şablonundan geliyor. Bunu yapay olarak ikiye bölmek ya kodu gereksiz yere çatallandırıp neredeyse birebir iki fonksiyon yaratmak (kod tekrarı, kötü pratik), ya da ikinci commit'i içeriksiz/boş bırakmak anlamına gelirdi. Bu yüzden tek bir delegasyon commit'inde birleştirdim ve durumu burada açıkça bildiriyorum, sessizce atlamak yerine.

Her commit öncesi çalıştırıldı: `npx tsc --noEmit` (temiz), `npm test` (23/23), `npm run test:integration` (47/47), `git diff --check` (sorun yok), `git status --short` (yalnızca amaçlanan dosyalar staged — `offer.ts`/`listing-metrics.ts` WIP'e hiç dokunulmadı).

## 8. Kalan Teknik Borç

- `likedActorKeys`/`favoriteActorKeys`: kaldırılabilir, §4'teki koşula bağlı.
- `logisticsActorKeyFor` (eski `actorKeyFor` alias'ı) `engagement.ts`'den kaldırıldı (kullanılmıyordu); `logistics-load.ts`'deki asıl `actorKeyFor` hâlâ `update`/`delete` sahiplik kontrollerinde kullanılıyor — dokunulmadı, D4-B kapsamı dışı.
- Permission-bootstrap gap'i (§3) yalnızca bu 2 action için kapatıldı; aynı sınıf başka delege edilmemiş custom action kalmış olabilir — bu D4-B'nin kapsamı dışında, ayrı bir tarama gerektirir.

## 9. D4-F (Flutter) İçin Karar

**READY.** Backend artık logistics-load like/favorite için tek kanonik mutasyon çekirdeğine sahip; legacy ve yeni rotalar aynı kullanıcı için asla çift saymıyor. Flutter'ın `LogisticsStore.toggleLoadLike`/`registerLoadFavorite`'i hâlâ `/metrics/like|favorite`'i çağırıyor — bu artık `setMembership`'e bağlı olduğu için, D4-F'de kartları `EngagementStore`'a taşırken backend tarafında ek bir risk yok.

D4-B burada duruyorum. Flutter'a geçmiyorum, push yapmıyorum.
