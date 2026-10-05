# FAZ D8-V-B — PROFILE VIEW BACKEND ÖN KOŞULU — RAPOR

**Kapsam: yalnızca Profile View.** Profile favorite, follow, rating, profile comments veya profile-setting genel okuma yetkileri genişletilmedi. Push yapılmadı.

---

## 0. Kritik Yan Bulgu — Hemen Bildiriliyor

Bu fazda planlanan bir regresyon testi yazılırken (`GET /profile-settings?filters[profileId][$eq]=<başkası>`'nın hâlâ yalnızca çağıranın kendi belgesini döndürdüğünü doğrulamak için), **gerçek bir boot testiyle doğrulanmış, önceden var olan bir güvenlik açığı** ortaya çıktı:

`global::profile-setting-ownership` policy'sinin GET (liste, id'siz) dalı, `ctx.query`'yi çağıranın kendi `profileId`'sine zorlayacak şekilde mutasyona uğratıyor — ama debug ile doğrulandı: **policy çalıştığı anda `ctx.query` zaten boş (`{}`)**, gerçek querystring `filters[profileId][$eq]=...` olsa bile. Policy'nin `ctx.query = {...}` ataması hiçbir zaman controller'a ulaşmıyor; controller, istemcinin gönderdiği filtreyi **olduğu gibi** kabul ediyor.

**Sonuç: bugün, herhangi bir authenticated kullanıcı, `GET /profile-settings?filters[profileId][$eq]=<hedef>` ile BAŞKA HERHANGİ BİR kullanıcının tam profile-setting belgesini (telefon, bio, favoriler, takip listeleri, gelen yorumlar dahil) okuyabilir.**

**Bu D8-V-B kapsamı dışı** — bu faz o policy'ye hiç dokunmadı, yeni lookup endpoint'im ona hiç bağımlı değil (kendi `db.query`'sini kullanıyor, policy'yi bypass ediyor — bu doğru ve kasıtlı). Mandat'ın kendi durak noktası ("genel ownership policy değiştirilmek zorunda kalırsa") burada tam olarak uygulanıyor: **policy'yi düzeltmedim, yalnızca bulguyu raporluyorum.**

**Önemli düzeltme — D8-Analiz raporuna:** Önceki `PROFILE_ENGAGEMENT_D8_ANALYSIS_REPORT.md`'de "GET yalnızca çağıranın kendi belgesine kilitli" diye yazmıştım — bu, policy KODUNUN NİYETİNİ doğru okumuştu ama gerçek ÇALIŞMA ZAMANI davranışını (gerçek bir boot ile hiç test edilmediği için) yanlış varsaymıştı. Gerçek davranış daha da kötü: **hiçbir izolasyon yok.** (İyi haber: PUT/PATCH ve `:id`'li GET/PUT/DELETE dalları — `if (id) {...}` — farklı bir mekanizma kullanıyor, entity'yi doğrudan çekip `profileId` karşılaştırıyor, ve bu dal **doğru çalışıyor** — testle doğrulandı, §7 regresyon testleri. Yalnızca filtreli-liste GET dalı kırık.)

**Öneri (uygulanmadı, yalnızca kayıt amaçlı):** Bu ayrı, kendi mandatıyla ele alınmalı — muhtemelen en basit düzeltme, o GET dalını `ctx.query` mutasyonu yerine controller'ı hiç çalıştırmadan doğrudan `strapi.db.query(...).findMany({where: {profileId: identity.ownerId}})` ile cevaplayıp `return false`/kendi response'unu yazmak (yani policy yerine küçük bir controller override).

---

## 1. Kanonik Profile Target Kimliği (D8-V-B.1)

- **Flutter'ın bildiği:** `ownerId` (`ProfileUser.id`, `SessionProfileStore` içinde üretilen yerel kimlik).
- **Backend'in karşılığı:** `profile-setting.profileId` — **tam olarak aynı değer**, çünkü ikisi de aynı deterministik fonksiyondan türüyor: `ownerIdFromEmail(email) = 'u_' + normalize(email)`. Flutter'da `ownerIdFromEmail` (Dart), backend'de `ownerIdFromEmail` (`utils/identity.ts`) — birebir aynı algoritma, bağımsız ama tutarlı türetiliyor. `global::profile-setting-ownership` policy'si her create/update'te `data.profileId = identity.ownerId`'yi zorluyor (satır 37), yani bir profile-setting satırı her zaman kendi sahibinin `ownerId`'siyle etiketli.
- **`engagement targetType=profile` hangi UID'ye gidiyor:** `api::profile-setting.profile-setting` (`engagement-contract.ts`, zaten mevcuttu).
- **`resolveTargetRow` hangi biçimi kabul ediyor:** Yalnızca gerçek Strapi `id`/`documentId` — asla `profileId` gibi bir iş anahtarı. Bu, D8-V-B.2'nin var olma sebebi.
- **Birden fazla profile-setting satırı aynı owner için oluşabilir mi:** Hayır — `profileId` şemada `unique: true` (DB seviyesinde gerçek bir unique index). Lookup servisi yine de `findMany({limit:2})` ile savunmacı davranıyor (bkz. §2) ve varsayılan olarak tekil sonucu güvenmiyor.
- **`draftAndPublish`:** `profile-setting` şemasında `false` — draft/published satır ayrımı riski (listing'de bulunan) burada yok.

## 2. Dar Lookup Endpoint (D8-V-B.2)

**`GET /api/profile-view-target/:ownerId`** — yeni, bağımsız route/controller/service:
- `src/api/engagement/services/engagement-profile-lookup.ts` — `profileId` ile `findMany({limit:2, select:['documentId','profileId','viewCount','engagementVersion']})`.
- `src/api/engagement/controllers/engagement-profile.ts` — ince controller, `sendEngagementError`'ı yeniden kullanıyor.
- `src/api/engagement/routes/engagement-profile.ts` — `auth: false` + `engagement-rate-limit` (60sn/30istek, IP anahtarlı).

Response (yalnızca bu alanlar, başka hiçbir şey):
```json
{
  "success": true,
  "target": { "type": "profile", "id": "<documentId>" },
  "viewCount": 0,
  "serverVersion": 0,
  "contractVersion": "1"
}
```
404 (`NOT_FOUND`) olmayan owner için. 500 (`SERVER_ERROR`, loglanır) teorik olarak imkânsız ama kod-seviyesinde korunan çoklu-satır belirsizliği için.

**Neden profile-setting'in kendi router'ına eklenmedi:** O router `global::profile-setting-ownership` ile tamamen kendine-kilitli — bu endpoint'in AMACI tam olarak o kısıtlamayı (güvenli, dar bir şekilde) aşmak, o yüzden ayrı, kendi yetkilendirme mantığına sahip bir route.

**Public mi JWT mi — karar ve gerekçe:** **Public (`auth:false`) + IP-anahtarlı rate-limit.** Gerekçe: `/engagements/view`'ın kendisi zaten `auth:false` (misafir görüntüleme destekleniyor — `resolveActorKey` guest UUID kabul ediyor); Flutter'da profil açma (`onOpenProfile` gibi çağrılar) `requireLogin` ile sarmalanmıyor, yani misafir kullanıcı bir profili görüntüleyebiliyor. Lookup'ı JWT'ye kilitlemek, misafir bir ziyaretçinin view kaydını hiç tetikleyememesine (görünmez bir ürün regresyonu) yol açardı. Açığa çıkan veri (bir opak id + iki sayı) hassas değil; asıl risk `ownerId` enumerasyonu (bir email'den `u_<email>` tahmin edip hesap var/yok kontrolü) — bunu `engagement-rate-limit`'in IP-anahtarlı çalışması (soft-auth kullanılmadığı için `ctx.state.user` hiç dolmuyor, limiter her zaman IP'ye düşüyor) kısmen yumuşatıyor.

**Gizlilik sınırı:** Yalnızca `documentId`, `profileId` (yalnızca dahili self-view karşılaştırması için, response'a hiç yazılmıyor), `viewCount`, `engagementVersion` seçiliyor. `select` allowlist'i dışında hiçbir alan sorgulanmıyor bile (isim, telefon, bio, favoriler, takip listeleri vs. hiç çekilmiyor) — test edildi (§7, "private alan sızıntısı yok").

## 3. Profile View Mutation Kuralı (D8-V-B.3)

`POST /engagements/view` (`targetType=profile`) — **hiçbir yeni route yok, mevcut generic route'a bir dal eklendi** (`controllers/engagement-v1.ts`'in `postView`'ı içinde, yalnızca `targetType==='profile'` iken çalışan bir blok):

- Çağıranın kimliği varsa (`readIdentity`), hedef satır çözülür (`resolveTargetRow`, aynı fonksiyon `registerView`'ın kullandığı).
- `target.profileId === identity.ownerId` ise: `registerView` HİÇ ÇAĞRILMIYOR, doğrudan `incremented:false` + mevcut `viewCount`/`engagementVersion` dönülüyor. **Hiçbir `engagement-view` satırı yazılmıyor** — bu, bir dedup penceresi tüketmediği anlamına gelir (test edildi: sahibin art arda kendi profilini "görüntülemesi", sonra gerçek bir ziyaretçinin ilk view'ının hâlâ `count:1`/`incremented:true` olarak sayıldığını doğrulayan test).
- Kontrol yalnızca backend'de — Flutter ne gönderirse gönderiisin, kimlik JWT'den türetiliyor (`readIdentity`), asla istemciden gelen bir alandan değil.
- Misafir (kimliksiz) çağrılarda bu kontrol atlanıyor (`identity` null ise) — bir misafir zaten "sahip" olamaz (misafirin kalıcı bir profil kimliği yok), dolayısıyla self-view kavramı misafirler için anlamsız.
- `registerView`/`setMembership` çekirdeği **hiç değişmedi** — kontrol tamamen `postView` controller seviyesinde, `targetType==='profile'` guard'ı içinde. Diğer domainler bu koddan hiç geçmiyor.

## 4. Ownership ve Gizlilik (D8-V-B.4)

- `global::profile-setting-ownership` **yeni endpoint'e uygulanmıyor** (kasıtlı — kendi router'ının dışında).
- Genel `profile-setting` `find`/`findOne`/`create`/`update`/`delete` izinlerinde **hiçbir değişiklik yapılmadı** (izin bootstrap dizisine yalnızca YENİ eylemim — `engagement-profile.getViewTarget` — eklendi, mevcut hiçbir satır dokunulmadı).
- Yeni endpoint bilinçli olarak dar bir `select` listesiyle çalışıyor — genel find/findOne izni açılmadı, bypass yalnızca bu tek, minimal-alan-seçimli controller üzerinden.
- Private alan sızıntısı testi yazıldı ve geçti (§7).

## 5. Test Sonuçları (D8-V-B.5)

**16 yeni test, hepsi PASS** (`tests/integration/profile-view-engagement.integration.test.ts`):
- Lookup: mevcut owner, olmayan owner (404), yalnız izin verilen alanlar + private alan sızıntısı yok (açık string-içerik kontrolü dahil), auth'suz erişim, farklı bir authenticated kullanıcıyla erişim.
- View: ilk view, 24s içi tekrar, 24s sonrası tekrar artış, **sahip kendi profilini görüntüleyince `incremented:false`**, **sahibin tekrar tekrar "görüntülemesi" hiç dedup satırı yazmıyor ve sonraki gerçek ziyaretçi hâlâ `count:1`**, eşzamanlı ilk-view'lar tek artış, client-supplied count yok sayılıyor, geçersiz hedef 404, misafir (guestActorId) view.
- Regresyon: `PUT`/`GET-by-id` ile başkasının profile-setting'ine erişim hâlâ 403 (bu dal doğru çalışıyor — yalnızca filtreli-liste GET dalı kırık, §0).
- **Kaldırılan bir test var:** filtreli-liste GET regresyon testi, gerçek (kırık) davranışı ortaya çıkardığı için, o davranışı "beklenen" gibi assert etmek yerine dosyadan çıkarıldı ve bulgu ayrıca raporlandı (§0).

**Tüm `test:integration`: 101/101 PASS** (85 önceki + 16 yeni). Unit: 23/23. `tsc --noEmit`: temiz.

(Not: test dosyası tek başına çalıştırıldığında, TÜM testler geçtikten SONRA, Strapi'nin kendi cron servisinde `node_modules/@strapi/core` içinde teardown zamanlamasına bağlı, tekrar üretilemeyen bir `ReferenceError: strapi is not defined` gözlemlendi — bu koddan bağımsız, framework-içi bir race; ikinci çalıştırmada ve tam `test:integration` koşusunda hiç tekrarlanmadı, hiçbir assertion'ı etkilemedi.)

## 6. Son Tarama (D8-V-B.6)

| Aranan | Sonuç |
|---|---|
| Profile target çözüm yolu | `GET /profile-view-target/:ownerId` → `documentId` |
| Açılan alanlar | Yalnızca `target.type`, `target.id`, `viewCount`, `serverVersion`, `contractVersion` |
| Genel profile-setting izinlerinde değişiklik | **Yok** (yalnızca kendi yeni eylemim bootstrap listesine eklendi) |
| Self-view backend guard | Var, `postView` içinde, `targetType==='profile'`'a scope'lu |
| Eski `/profile-views` endpoint durumu | Değişmedi, hâlâ çıplak CRUD, hâlâ hiçbir sayaç güncellemiyor — D8-V-F'de Flutter tarafında çağrısı kaldırılabilir (backend'de silmeye gerek yok, zaten zararsız) |
| Delege edilmemiş eski view yolu | Yok — bu, önceki fazlardaki gibi bir "eski route'u yeniye devret" değil, daha önce Flutter'dan hiç çağrılamayan bir yeteneğin (profile view via engagement v1) ilk kez erişilebilir kılınması |
| **YENİ bulgu (kapsam dışı, ayrıca bildirildi)** | `profile-setting-ownership`'in GET-liste dalı çalışmıyor — §0 |

## 7. Commit'ler

1. `28f2dd9` feat: add safe profile engagement target lookup
2. `7630c76` fix: prevent self profile view increments
3. `2fee7a6` test: add profile view engagement coverage

## 8. Flutter D8-V-F İçin Kesin Sözleşme

1. **Lookup:** `GET /api/profile-view-target/:ownerId` (auth gerekmez, ama JWT varsa da çalışır). 200 → `{success, target:{type:'profile', id}, viewCount, serverVersion, contractVersion}`. 404 → profil (henüz) yok, view kaydı denenmemeli.
2. **View kaydı:** `POST /api/engagements/view`, body `{targetType:'profile', targetId: <lookup'tan gelen id>}` (+ misafir ise `guestActorId`). Sunucu `incremented`/`count`/`serverVersion` döner, tek otorite.
3. **Kendi profili:** Flutter'ın `!_isOwnerView` guard'ı korunabilir (gereksiz ağ çağrısını önler) ama artık **zorunlu değil** — backend zaten `incremented:false` dönecek, sahte artış riski yok.
4. **Eski `/profile-views` çağrısı** (`StrapiService.recordProfileView`) kaldırılmalı — hiçbir sayaç okumadığı için kaldırılması hiçbir mevcut UI'ı bozmaz.
5. Flutter'da `viewCount` şu an hiçbir yerde gösterilmiyor (D8-Analiz §1) — D8-V-F'nin bir UI değişikliği yapmasına gerek yok, yalnızca çağrı noktası taşınıyor.

## 9. D8-V-F İçin Karar

**READY.** Backend, Flutter'ın ihtiyaç duyduğu tüm sözleşmeyi sağlıyor: dar, gizlilik-korumalı bir lookup + kendi profilini sayma riski olmayan bir view mutation. Follow/rating/comments'e hiç dokunulmadı, genel profile-setting izinleri değişmedi.

**Ayrıca, D8-V-F'den bağımsız olarak kullanıcıya iletilmesi gereken:** §0'daki `profile-setting-ownership` GET-liste bulgusu — bu fazın bir parçası değil ama üretimde gerçek bir veri ifşası.

D8-V-B tamamlandı. Burada duruyorum. Flutter'a geçmiyorum, push yapmıyorum.
