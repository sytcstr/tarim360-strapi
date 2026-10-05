# TARIM360+1 — SPRINT 5 — PERMISSION-GAP FORENSIC AUDIT

**Mod:** READ-ONLY. Bu fazda hiçbir dosya değiştirilmedi, commit/push yapılmadı, branch/production'a dokunulmadı. O1 branch'i (`fix/release-offer-core`, HEAD `0d1d5ca`) ve `main` bu fazın dışında kaldı.
Backend repo: `C:\projeler\tarim360-strapi` (analiz anında branch: `fix/release-offer-core`, working tree temiz — değişiklik yapılmadı).
Flutter repo: `C:\projeler\tarim360` (yalnızca okuma).

Tüm bulgular bu fazda **sıfırdan** yeniden doğrulandı (önceki Offer denetiminin hafızasına güvenilmedi): `src/index.ts`'in `publicActions`/`authenticatedActions` dizileri tam olarak yeniden okundu, 23 custom route dosyasının tamamı tek tek grep'lendi, ilgili controller/policy dosyaları uçtan uca okundu, Flutter tarafında her route için gerçek çağıran kod bulundu.

---

## Kavramsal ayrım (rapor boyunca korunur)

- **Permission gap**: Bir rolün (authenticated) bir action'ı hiç çağıramaması — Strapi RBAC/bootstrap sorunu. Route'a ulaşan istek, controller'a hiç girmeden framework seviyesinde jenerik `403 Forbidden` alır.
- **Authorization gap**: Rol action'ı çağırabiliyor ama bu spesifik çağıranın bu spesifik kaynak üzerinde hakkı yok — uygulama mantığı sorunu (controller/policy içindeki identity/ownership kontrolü).

Bu iki bug sınıfı hiçbir bulguda birbirine karıştırılmadı.

---

## Global sweep metodolojisi ve sonucu

`grep -rln "auth: { scope: \[\] }"` ile `src/api/*/routes/*.ts` altında **23 route dosyası** bulundu (ai, auth-flow, conversation, engagement, engagement-v1, listing-comment, listing-share, logistics-admin, logistics-load ×2, logistics-offer ×2, logistics-vehicle, notification, offer, processed-admin, processed-product, processed-products, processed-seller-payouts, processed-seller-stores, processed-store-documents, promo, purchase). Bu dosyalardaki **her `handler:`** tek tek çıkarıldı ve `src/index.ts`'in `publicActions` (108-159) ile `authenticatedActions` (161-352) dizileriyle satır satır karşılaştırıldı.

**Sonuç: `auth: { scope: [] }` kullanan ama bootstrap dizilerinin hiçbirinde olmayan tam 9 action bulundu:**

| # | Action ID | Grup |
|---|---|---|
| 1 | `api::notification.notification.markRead` | Bilinen (Offer denetiminden) |
| 2 | `api::auth-flow.auth-flow.deleteAccount` | Bilinen |
| 3-9 | `api::logistics-admin.logistics-admin.{access,loads,loadReview,vehicles,vehicleReview,offers,offerReview}` | Bilinen (7 action) |
| **10** | **`api::conversation.conversation.markRead`** | **YENİ — bu sweep'te bulundu** |

Ayrıca `api::conversation.conversation.deleteByThreadId` de aynı şekilde eksik doğrulandı — bu, mesajlaşma sprintinden zaten açık olarak takip edilen **BUG-M7**'nin aynısı (yeni değil, sadece bu sweep'te tazelendi, bkz. Bulgu 5).

Diğer 20 route dosyasındaki tüm `auth:{scope:[]}` handler'ları (ai.*, engagement*.*, listing-comment.*, listing-share.*, processed-*.*, promo.redeem, purchase.verify, logistics-load/vehicle/offer CRUD+custom, offer.markSeen/updateByOfferId/deleteByOfferId) `authenticatedActions` içinde **tam** olarak bulundu — başka eksik yok.

---

## BULGU 1 — `notification.markRead`

- **ID:** PERM-N1
- **Severity:** Medium (fonksiyonel kırık, güvenlik riski yok)
- **Live caller:** Evet. `notification_store.dart:378` → `_syncReadStateToStrapi()` → `StrapiService.markNotificationReadRemote()` (`strapi_service.dart:4706`) → `PATCH /notifications/:notificationId/read`. Kullanıcı bir bildirimi okudu olarak işaretlediğinde her zaman tetiklenir.
- **Current behavior:** `notification.markRead`, `authenticatedActions`'ta yok → istek controller'a hiç girmeden Strapi policy katmanında jenerik `403 Forbidden` alır. `markNotificationReadRemote` best-effort (`_patchJsonBestEffort`) olduğu için hata fırlatmaz, `false` döner. `_syncReadStateToStrapi` bunu görüp bir **fallback** çalıştırıyor: `strapi.pushNotification({notificationId: item.id, ...})` — bu ham bir `POST /notifications` (create). `notification` şemasında `notificationId` alanı **unique değil** (schema.json'da doğrulandı), yani bu fallback aynı `notificationId` ile **ikinci bir bildirim satırı** yaratıyor (silent duplicate, exception yutuluyor: `catch (e) { debugPrint(...) }`). Bu, permission gap'in yan etkisi olan ayrı bir veri kalitesi sorunu — **bu fazda düzeltilmedi, sadece bildiriliyor.**
- **Expected behavior:** PATCH isteği controller'a ulaşmalı, `isRead=true` ile mevcut satır update edilmeli, yeni satır yaratılmamalı.
- **Root cause:** Saf permission gap. `notification.ts` controller'ı (`markRead`) okundu: `isOwner` kontrolü (`matchesIdentity` — `targetEmail/receiverEmail/recipientEmail` + `targetProfileId/ownerProfileId/receiverProfileId/recipientProfileId`) VEYA `isBroadcast` bypass (broadcast bildirimde tek sahip yok, bilinçli tasarım) — sağlam, doğru. Route hiç çalışmadığı için bu kod hiç tetiklenmiyor.
- **Security impact:** Yok. Authorization mantığı zaten doğru: bir kullanıcı başka birinin özel bildirimini bu endpoint üzerinden asla okundu işaretleyemez (broadcast istisnası hariç, ki o zaten kasıtlı). Permission açılsa bile ekstra bir açık oluşmaz.
- **Minimum safe fix:** `src/index.ts`'in `authenticatedActions` dizisine tek satır: `'api::notification.notification.markRead'` (O1'deki `offer.markSeen` ile birebir aynı desen).
- **Required regression tests:** (a) sahip kullanıcı kendi bildirimini okur → 200 + `isRead:true`, satır sayısı değişmez; (b) sahip olmayan kullanıcı başka birinin bildirim ID'sini verirse → 403; (c) broadcast bildirim herhangi bir authenticated kullanıcı tarafından okunabilir → 200; (d) fallback `pushNotification` yolu artık tetiklenmemeli (duplicate satır oluşmamalı).
- **Release blocker:** Hayır (fonksiyonel bug, güvenlik değil) — ama kullanıcı deneyimini ve veri kalitesini (duplicate satırlar) etkiliyor.

---

## BULGU 2 — `auth-flow.deleteAccount`

- **ID:** PERM-N2
- **Severity:** High (kullanıcıya sunulan kritik bir özellik — "Hesabı ve Verileri Sil" — şu an %100 kırık)
- **Live caller:** Evet, tam zincir doğrulandı. `settings_page.dart:220-244` (onay dialogu → `Ayarlar > Veri Silme Politikası > "Hesabı ve Verileri Sil"`) → `HubContentRepo`/`FarmerQuestionsRepo` temizliği → `StrapiService(jwt:jwt).deleteAllMyThreads()` (best-effort) → `StrapiService(jwt:jwt).deleteCurrentAccount()` (`strapi_service.dart:4892`) → `DELETE /auth/account`.
- **Current behavior:** Route `authenticatedActions`'ta yok → `DELETE /auth/account` her zaman `403 Forbidden` (framework seviyesi, controller'a girmiyor). `settings_page.dart:236-243`'teki `try/catch` bunu yakalıyor, kullanıcıya hata snackbar'ı gösteriyor ve **return** ediyor — yerel temizliğe (satır 245+) hiç geçmiyor. Yani: **bu buton bugün hiçbir kullanıcı için hesap silmiyor; sistem güvenli şekilde başarısız oluyor (yarım silme / tutarsız state yok), ama özellik tamamen işlevsiz.**
- **Expected behavior:** İstek controller'a ulaşmalı, `deleteAccount` çalışmalı, hesap + ilişkili veriler silinmeli.
- **Root cause:** Saf permission gap. Controller (`auth-flow.ts:276-456`) tam okundu.
- **Spoof analizi (mandatın özellikle istediği):** `userId`/`email`/`username`/`ownerId` tamamen `ctx.state.user` (kimlik doğrulanmış JWT session) üzerinden okunuyor — **request body'den hiçbir kullanıcı-kimliği alanı okunmuyor**. Yani istemci hangi hesabın silineceğini hiçbir şekilde etkileyemez; her zaman token'ın sahibi olan hesap silinir. **Spoof mümkün değil.**
- **Veri temizliği (read-only inceleme, hiçbir silme çalıştırılmadı):** `deleteAccount`, sırayla `cleanupOwnerEmbeddedHubContent` + 19 ayrı `deleteByFilter` çağrısıyla (ad-click, ad-event, listing-view, profile-view, ai-log, notification, message, offer, thread, support-ticket-message, support-ticket, purchase-event, promo-redemption, logistics-offer, logistics-load, logistics-vehicle, store-document, processed-product, seller-store, ad, listing, profile-setting) kullanıcıya ait tüm içerikleri temizliyor, sonra 15 günlük saklama süreli bir `deleted-account-record` oluşturuyor, en son `plugin::users-permissions.user` satırını siliyor. Bu akış **tek bir DB transaction içinde değil** — 22 ayrı sıralı `await` çağrısı. Ortadaki bir çağrı (ör. DB timeout) başarısız olursa dizinin geri kalanı çalışmaz ve hesap kısmen temizlenmiş ama kullanıcı satırı hâlâ duran bir ara state'te kalabilir. **Bu, mandatın kapsamı dışında bir dayanıklılık gözlemi — bu fazda düzeltilmedi, sadece bildiriliyor** (permission gap'ten bağımsız, önceden var olan bir karakteristik).
- **Security impact:** Yok — self-only, spoof-proof. Permission açılması ekstra risk yaratmaz.
- **Minimum safe fix:** `authenticatedActions`'a `'api::auth-flow.auth-flow.deleteAccount'` eklenmesi.
- **Required regression tests:** (a) gerçek JWT ile kendi hesabını silme → 200, `deleted-account-record` oluşur, `users-permissions.user` satırı gider; (b) silinen hesabın ilişkili 21 content-type'taki satırları gerçekten temizlendiğini doğrulayan sayım testi; (c) JWT yokken/geçersizken → 401; (d) ara adımlardan biri (ör. bir `deleteByFilter`) hata fırlatırsa 500 dönüyor ve mevcut testlerde bu senaryo zaten kontrollü mü, değilse transaction/rollback ihtiyacı ayrı bir karar maddesi olarak not edilmeli.
- **Release blocker:** Evet, eğer "Hesabı Sil" özelliği bu sürümde kullanıcıya sunuluyorsa (Ayarlar ekranı ve KVKK/gizlilik metinleri zaten bu özelliği vaat ediyor — `settings_page.dart:410-413`, "Veri ve Hesap Silme" bölümü). Yasal/regülasyon taahhüdü verilen ama çalışmayan bir özellik.

---

## BULGU 3 — `logistics-admin.*` (7 action)

- **ID:** PERM-N3
- **Severity:** Medium (özellik kırık, ama izin açılması güvenlik açığı yaratmıyor — kullanıcının en çok endişe ettiği senaryo gerçekleşmiyor)
- **Live caller:** Evet. `LogisticsAdminStore` (`lib/features/logistics/stores/logistics_admin_store.dart`) → `ensureAccessLoaded()` → `strapi.fetchLogisticsAdminAccess()` (`GET /logistics-admin/access`) ve `refreshPanel()` → `fetchLogisticsAdminLoads/Vehicles/Offers` + `reviewLogisticsAdminLoad/Vehicle/Offer` (POST review endpoint'leri). `logistics_admin_page.dart` bu store'u kullanan gerçek bir UI ekranı.

### 3a. Authentication vs. Authorization — ayrı ayrı (mandatın istediği gibi)

`logistics-admin.ts` controller'ı (7 action, hepsi) her handler'ın başında `assertAdmin(ctx)` çağırıyor:
```js
const assertAdmin = (ctx) => {
  if (!ctx.state.user) { ctx.unauthorized(...); return false; }   // authentication
  if (!isAdminUser(ctx.state.user)) { ctx.forbidden(...); return false; } // authorization
  return true;
};
```
- **Authentication:** `ctx.state.user` var mı — standart JWT kontrolü.
- **Authorization:** `isAdminUser(user)` — kullanıcının `roles`/`role` alanındaki `code/type/name` değeri `'admin'`, `'administrator'`, `'super-admin'` ile eşleşiyor mu ya da `'admin'` string'ini içeriyor mu. **Bu, Strapi'nin permission-gap'inden tamamen bağımsız, controller-içi ikinci bir gate.**

### 3b. "İzin açılırsa gerçek bir güvenlik deliği oluşur mu?" — Kanıtlanmış cevap: HAYIR

`authenticatedActions`'a bu 7 action eklense bile, **sıradan (admin olmayan) authenticated bir kullanıcı** hâlâ `isAdminUser` kontrolünden geçemeyecek ve `403 forbidden` alacaktır — çünkü bu kontrol Strapi'nin rol/izin sisteminden değil, doğrudan controller kodundan geliyor ve JWT'deki kullanıcının gerçek `role` ilişkisine bakıyor. **Kullanıcının en başta belirttiği endişe ("yanlışlıkla admin yetkisi açılması") bu spesifik mekanizma için gerçekleşmiyor — permission grant'i tek başına hiçbir sıradan kullanıcıya admin erişimi açmaz.**

### 3c. Bugün fail-closed durumu KİMİ için geçerli?

Permission eksikliği bugün **herkesi** engelliyor — gerçek adminler dahil. Yani bu, "güvenlik için kasıtlı fail-closed" değil, basitçe **kırık bir özellik**: hiç kimse (admin bile) bu paneli backend üzerinden kullanamıyor.

### 3d. YENİ, mandatın doğrudan sormadığı ama disclosure disiplini gereği bildirilen ek bulgu: `isAdminUser`'ın gerçek admin operatörü tanıma zayıflığı

Projede paralel bir admin modülü daha var: `processed-admin.*` (aynı desende, `PROCESSED_MARKETPLACE_ADMIN_EMAILS` ortam değişkeniyle beslenen bir allowlist + rol kontrolü — `processed-admin/services/processed-admin.ts:52-82`, `loadAdminUser`). Bu modül **zaten `authenticatedActions`'ta var ve çalışıyor** (bootstrap dizisinde 5/5 action mevcut, taze doğrulandı). `loadAdminUser`'ın kontrolü:
```js
const roleBasedAdmin = roleType==='admin' || roleType==='super-admin' || roleName.includes('admin') || roleName.includes('yonetici');
const allowlistAdmin = adminAllowlist.has(email) || adminAllowlist.has(username); // env: PROCESSED_MARKETPLACE_ADMIN_EMAILS
if (!roleBasedAdmin && !allowlistAdmin) throw 403;
```
`logistics-admin.ts`'in `isAdminUser`'ı ise **sadece rol kontrolü** yapıyor — allowlist fallback'i yok. Bu, `logistics_admin_store.dart:418-427`'deki fallback koduyla da tutarlı: `ensureAccessLoaded()` backend çağrısı hata verdiğinde (bugün her zaman, çünkü 403) `ProcessedAdminStore.I.ensureAccessLoaded()`'a düşüyor ve **oradaki (allowlist'li) admin durumunu ödünç alıyor** — ki bu da UI'da "admin" görünmesini sağlayan gerçek mekanizmanın muhtemelen zaten allowlist tarafı olduğunu gösteriyor.

**Sonuç: Permission gap düzeltilse bile, gerçek lojistik admin operatörünün Strapi'de rolü tam olarak `admin`/`administrator`/`super-admin` tipinde/adında değilse (ki `processed-admin` tarafının neden ayrıca bir allowlist'e ihtiyaç duyduğu düşünülürse bu olası), `logistics-admin.*` yine erişilemez kalabilir — izin tek başına yeterli olmayabilir.** Bu, salt bir permission-gap konusu değil; **hangi mekanizmanın (rol mü, allowlist mi, ikisi mi) gerçek admin operatörünü tanıyacağına dair bir ürün kararı.**

- **Root cause:** (i) Permission gap (kanıtlandı, 7/7 action `authenticatedActions`'ta yok). (ii) Ayrı, muhtemelen yetersiz authorization mekanizması (`isAdminUser` yalnız rol-bazlı, allowlist yok) — bu ikinci madde güvenlik açığı değil, aksine muhtemelen **fazla kısıtlayıcı** (gerçek admini de dışlayabilir).
- **Security impact:** Sıradan kullanıcı için: **Yok** (kanıtlandı, §3b). Gerçek admin operatörü için: izin düzeltmesi tek başına yeterli olmayabilir (§3d) — bu bir kullanılabilirlik riski, güvenlik riski değil.
- **Minimum safe fix (iki ayrı karar gerektirir, bu fazda hiçbiri uygulanmadı):**
  1. `authenticatedActions`'a 7 action eklenmesi — güvenlik açısından tek başına serbest (kanıtlandı).
  2. `isAdminUser`'ın `processed-admin`'deki gibi bir allowlist fallback'i alıp almayacağı — **ürün/güvenlik kararı**, kullanıcının vereceği.
- **Required regression tests:** (a) admin rolüne sahip olmayan authenticated kullanıcı → 7 action'ın hepsinde 403 (izin açıldıktan sonra bile); (b) gerçek admin rolüne/allowlist'e sahip kullanıcı → 200; (c) `assertAdmin` her 7 handler'da da en başta çalışıyor mu (regresyonla bozulmadığını doğrulamak için).
- **Release blocker:** Kullanıcının kararına bağlı — güvenlik engeli değil, ama "hangi mekanizma admin sayılacak" sorusu netleşmeden izin açmak, özelliği yine çalışmaz bırakabilir.

---

## BULGU 4 — `conversation.markRead` (YENİ — global sweep'te bulundu)

- **ID:** PERM-N4
- **Severity:** Medium (fonksiyonel kırık, güvenlik riski yok — Bulgu 1 ile birebir aynı desen, farklı content-type)
- **Live caller:** Evet. `messages` özelliğinde okunan mesaj sayacı senkronizasyonu için kullanılıyor: `StrapiService.markConversationRead({required threadId})` (`strapi_service.dart:4695-4704`) → `PATCH /conversations/:threadId/read` (`conversationReadEndpoint`, satır 93-94).
- **Current behavior:** `conversation.markRead`, `authenticatedActions`'ta yok → `403 Forbidden`, controller'a hiç girmiyor. `markConversationRead` de best-effort (`_patchJsonBestEffort`), hata fırlatmıyor — sessizce başarısız oluyor, thread'in `unreadCount`/`lastReadAt`/`readReceipts` alanları backend'de hiç güncellenmiyor.
- **Expected behavior:** İstek controller'a ulaşmalı, thread'in okunma bilgisi güncellenmeli.
- **Root cause:** Saf permission gap. Controller (`conversation.ts:307-366`, `markRead`) okundu: yetkilendirme sorgu seviyesinde yapılıyor — `strapi.entityService.findMany(THREAD_UID, { filters: { $and: [{threadId}, userFilter(user)] } })`. Çağıran kullanıcı thread'in katılımcısı değilse sorgu boş döner → `403 forbidden`. Bu, Bulgu 1/2'dekinden bile daha sıkı bir desen (fetch-then-check değil, filter-in-query) — **sağlam.**
- **Security impact:** Yok. Bir kullanıcı başkasının konuşmasını bu yolla okundu işaretleyemez zaten (sorgu seviyesinde engelleniyor).
- **Minimum safe fix:** `authenticatedActions`'a `'api::conversation.conversation.markRead'` eklenmesi.
- **Required regression tests:** (a) katılımcı kendi thread'ini okur → 200, `unreadCount:0`; (b) katılımcı olmayan kullanıcı başka bir threadId verirse → 403; (c) `lastReadAt`/`readReceipts` doğru güncelleniyor mu.
- **Release blocker:** Hayır (fonksiyonel/UX, güvenlik değil) — ama okunmadı sayaçlarının backend'e hiç yansımaması gerçek bir kullanıcı deneyimi sorunu.

---

## BULGU 5 — `conversation.deleteByThreadId` (BUG-M7, önceden bilinen — bu sweep'te taze doğrulandı)

- **ID:** PERM-N5 (= BUG-M7)
- **Severity:** Medium
- **Live caller:** Evet. `StrapiService.deleteThread(threadId)` (`strapi_service.dart:3009-3016`) → `DELETE /conversations/:threadId` (`conversationDeleteEndpoint`).
- **Current behavior:** `conversation.deleteByThreadId` `authenticatedActions`'ta yok → `403 Forbidden`, controller'a girmiyor.
- **Root cause:** Saf permission gap. Controller (`conversation.ts:461-488`) aynı `userFilter(user)` sorgu-seviyesi deseniyle sağlam yetkilendirme yapıyor — katılımcı olmayan biri thread'i silemez zaten.
- **Security impact:** Yok.
- **Minimum safe fix:** `authenticatedActions`'a `'api::conversation.conversation.deleteByThreadId'` eklenmesi.
- **Not:** Bu madde mesajlaşma sprintinden beri zaten ayrı takip ediliyordu (BUG-M7); bu sweep onu yeniden, bağımsız olarak, taze kodla doğruladı — kapsam dışına çıkarılmadı, burada da listeleniyor çünkü aynı fix penceresinde (Sprint 5) tek satırla çözülebilir.
- **Release blocker:** Hayır.

---

## Özet tablo

| ID | Action | Permission gap | Authz mantığı | Güvenlik riski | Fix karmaşıklığı |
|---|---|---|---|---|---|
| PERM-N1 | `notification.markRead` | Var | Sağlam (owner ∨ broadcast) | Yok | 1 satır |
| PERM-N2 | `auth-flow.deleteAccount` | Var | Sağlam (self-only, spoof-proof) | Yok | 1 satır |
| PERM-N3 | `logistics-admin.*` (×7) | Var | Ayrı controller-gate var (rol-bazlı, allowlist yok) | Yok (izin açmak tek başına risksiz) | 7 satır + **ürün kararı** (allowlist eklenecek mi) |
| PERM-N4 | `conversation.markRead` | Var (YENİ) | Sağlam (query-level participant filter) | Yok | 1 satır |
| PERM-N5 | `conversation.deleteByThreadId` | Var (BUG-M7, bilinen) | Sağlam (query-level participant filter) | Yok | 1 satır |

**Yan bulgular (bu fazda düzeltilmedi, sadece bildiriliyor):**
- `notification.markRead` 403 aldığında Flutter fallback'i (`pushNotification`) aynı `notificationId` ile duplicate satır yaratıyor (`notificationId` unique değil). Permission fix'i bu yan etkiyi de otomatik olarak ortadan kaldırır (fallback artık tetiklenmeyecek).
- `auth-flow.deleteAccount` 22 adımlık silme zinciri tek bir DB transaction'ı içinde değil — ara bir adımın başarısız olması kısmi temizlik riski taşıyor. Permission gap'ten bağımsız, önceden var olan bir dayanıklılık konusu.

---

## DECISION

# BLOCKED — NEEDS PRODUCT/SECURITY DECISION

Gerekçe: 5 bulgunun **4'ü** (PERM-N1, N2, N4, N5) tamamen temiz — saf permission gap, authorization mantığı zaten doğru ve kanıtlanmış, güvenlik riski yok, tek satırlık `authenticatedActions` eklemesiyle çözülebilir; bunlar için ek bir karara gerek yok, doğrudan **READY FOR TARGETED FIX** durumundadır.

Ancak **PERM-N3 (`logistics-admin.*`)** tek başına genel kararı `BLOCKED` yapıyor: izin açılmasının güvenlik açığı yaratmadığı kanıtlandı (kullanıcının asıl endişesi olan "sıradan kullanıcıya yanlışlıkla admin yetkisi" senaryosu gerçekleşmiyor — `isAdminUser` bağımsız bir gate), **ama** bu controller-içi admin kontrolünün gerçek admin operatörünü tanıyıp tanımayacağı belirsiz (rol-bazlı, allowlist yok — paralel `processed-admin` modülünün aksine). Bu yüzden izin eklemek güvenli olsa da, özelliği fiilen çalışır hale getirip getirmeyeceği kullanıcının vereceği bir karara bağlı: **(a)** sadece izni aç ve gerçek admin hesabının zaten uygun bir Strapi rolüne sahip olduğunu doğrula, ya da **(b)** `isAdminUser`'ı `processed-admin`'deki gibi bir env-var allowlist ile de güçlendir.

**Önerilen sıradaki adım:** Kullanıcı PERM-N3'teki (a)/(b) sorusuna karar verince, Sprint 5 fix fazı 5 bulgunun tamamını (gerekirse N3 için ek allowlist kodu dahil) tek bir küçük, izole PR'da uygulayabilir — hepsi aynı desende (`authenticatedActions`'a satır ekleme), hiçbiri şema değişikliği gerektirmiyor.
