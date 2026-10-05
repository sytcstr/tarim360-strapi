# TARIM360+1 — SPRINT 6 — LISTING SYSTEM FULL RELEASE FORENSIC AUDIT

**Mod: READ-ONLY.** Hiçbir dosya değiştirilmedi, commit/push yapılmadı, `main`'e dokunulmadı, production mutation/deploy yapılmadı.

Backend repo analiz anındaki durum: `C:\projeler\tarim360-strapi`, branch `fix/release-permission-gaps` (Sprint 5A'dan kalan, `main`'den türetilmiş, `main`'e göre yalnızca `src/index.ts`'e 4 permission satırı + 3 yeni test dosyası ekliyor — ilan/engagement/offer koduna hiç dokunmuyor). Bu nedenle bu denetimdeki **tüm bulgular `main`'in gerçek, güncel halini birebir yansıtıyor**, aksi ayrıca belirtilmedikçe.

Flutter repo: `C:\projeler\tarim360`, yalnızca okuma.

---

## ÖNCELİKLİ BAĞLAM: Branch Entegrasyon Durumu (kod hatası değil, ama release'i doğrudan engelliyor)

Denetime başlamadan önce doğrulandı — `git merge-base --is-ancestor <branch> main`:

| Branch | main'e merge edildi mi? |
|---|---|
| `fix/semantic-contract-s1-critical` | ✅ EVET |
| `fix/semantic-contract-s2-high` | ✅ EVET |
| `fix/engagement-index-dialect-portability` | ✅ EVET |
| `fix/listing-metrics-missing-from-git` | ✅ EVET |
| `fix/release-offer-core` (O1 — teklif alıcı-spoofing, markSeen izni, offerCount düzeltmesi) | ❌ **HAYIR** |
| `fix/release-permission-gaps` (Sprint 5A — 4 permission gap) | ❌ **HAYIR** |
| `fix/release-messaging-core` (M1-M3) | ❌ **HAYIR** |
| `fix/release-messaging-read-state` (M2) | ❌ **HAYIR** |
| `fix/release-messaging-reliability` (M4) | ❌ **HAYIR** |
| `fix/release-profile-premium-badge` | ❌ **HAYIR** |

**Sonuç: bu çok-sprintlik denetim/düzeltme çalışmasının S1/S2 dışındaki HİÇBİR sonucu şu anda `main`'de değil.** `main` — yani gerçek release adayı — hâlâ: orijinal teklif-alıcı-spoofing açığını (BUG-OFFER-001), 4 permission-gap'i, mesajlaşma M1-M4 düzeltmelerini ve profil premium rozeti düzeltmesini İÇERMİYOR. Bu, bu Sprint 6 denetiminin bulduğu yeni bir "bug" değil — ama **release'in önünde, kod değişikliği gerektirmeyen, salt bir merge işlemiyle çözülecek, bağımsız bir blocker**. Aşağıdaki BUG-LISTING-006 bunun İlan Sistemi'ndeki somut örneği.

---

## Yöntem

3 paralel Explore ajanıyla geniş keşif yapıldı (backend ilan yüzeyi, Flutter ilan yüzeyi, çapraz-sistem entegrasyonları), ardından en kritik/şüpheli her iddia **doğrudan bu oturumda dosya okuyarak bizzat doğrulandı** — hiçbir CRITICAL/HIGH bulgu yalnızca ajan özetine dayanmıyor. `src/api/listing/`, `src/policies/listing-owner-write.ts`, `src/api/engagement/controllers/engagement.ts`, ilgili şema dosyaları ve Flutter'ın `listing_detail_page.dart`/`search_listings_page.dart`/`favorites_page.dart` dosyaları bizzat tam okundu.

---

## BULGULAR

### BUG-LISTING-001 — `syncOfflineListing`: yetki kontrolü sıfır, alan koruması sıfır → ilan ele geçirme + toplu-atama

- **Severity:** **CRITICAL**
- **Release blocker:** **EVET**
- **Live caller:** Evet. `POST /offline-sync/listings` (`api::engagement.engagement.syncOfflineListing`), `authenticatedActions`'ta mevcut, route config'inde **hiçbir policy yok** (yalnızca `auth:{scope:[]}`, doğrulandı: `src/api/engagement/routes/engagement.ts`). Flutter'da `ListingPendingSyncQueue` (`listings_store.dart`) çevrimdışıyken kuyruğa alınan create/update işlemlerini bu endpoint'e göndererek kullanıyor (`strapi.syncOfflineListing`) — gerçek, üretimde çalışan bir kod yolu.
- **Expected:** Bir kullanıcı yalnızca KENDİ ilanını update edebilmeli; sahiplik dışı hiçbir alan (isPremium, isDoping, rocketEndsAt, sayaçlar, status, ownerEmail/ownerProfileId/ownerId) client tarafından serbestçe yazılabilir olmamalı.
- **Actual:** Controller (`src/api/engagement/controllers/engagement.ts:447-480`, bizzat tam okundu) şunu yapıyor:
  ```ts
  listing.ownerEmail = identity.email;
  listing.ownerProfileId = identity.ownerId;
  listing.ownerId = identity.ownerId;
  ...
  const rawId = listing.id ?? listing.listingId ?? listing.remoteId ?? listing.documentId;
  const existing = rawId ? await findListingByAnyId(strapi, rawId) : null;
  if (existing?.id) {
    const entity = await strapi.entityService.update(LISTING_UID, existing.id, { data: listing });
    ...
  }
  ```
  `findListingByAnyId` hedef satırı SADECE id/documentId/listingNo ile buluyor — **hedefin gerçek sahibiyle çağıranın kimliği hiçbir yerde karşılaştırılmıyor**. Aynı zamanda `listing.ts`'deki `CLIENT_PROTECTED_FIELDS`/`stripClientProtectedFields` bu yolda **hiç çağrılmıyor**. Sonuç: kimliği doğrulanmış (`authenticatedActions` iznine sahip) HERHANGİ bir kullanıcı, `id`/`documentId`/`listingNo` bilinen/tahmin edilen HERHANGİ BİR BAŞKA KULLANICININ ilanını tek istekte: (a) kendi hesabına devredebilir (`ownerEmail/ownerProfileId/ownerId` çağıranın kimliğiyle üzerine yazılıyor — bu bir "edit" değil, gerçek bir **sahiplik ele geçirme**), (b) `isPremium`/`isPremiumOwner`/`isDoping`/`rocketEndsAt`'i serbestçe `true`/uzak-gelecek yapabilir (ücretsiz premium/rocket dolandırıcılığı — kendi ilanına bile gerek yok, herhangi bir ilana), (c) `title/description/price/status/photos` dahil her alanı değiştirebilir, (d) tüm sayaçları (`viewCount/likeCount/favoriteCount/offerCount/commentCount/shareCount/engagementVersion`) keyfi değerlere ayarlayabilir. Bu, uygulamanın resmi istemcisi hiç kullanmasa bile geçerli bir JWT ile herhangi bir HTTP istemcisinden (curl/Postman) tetiklenebilir — IDOR'un tanım gereği kanıtı.
- **Root cause:** `POST /offline-sync/listings`'in `listing-owner-write` policy'sinden (core CRUD route'larını koruyan) tamamen bağımsız, ayrı bir yazma yolu olarak eklenmiş olması ve hiçbir sahiplik/alan koruması taşımaması.
- **Backend/Flutter:** Backend.
- **Minimum safe fix:** `syncOfflineListing`'e (a) `update`/`upsert` dalında `existing` bulunduğunda `matchesIdentity`/eşdeğeri ile sahiplik doğrulaması (bulunamazsa/başkasınınsa 403), (b) `stripClientProtectedFields(listing)` çağrısı (aynı `listing.ts`'in kullandığı liste + `isDoping`/`rocketEndsAt`, bkz. BUG-LISTING-004) eklenmesi.
- **Required tests:** (1) sahip olmayan kullanıcı `update`/`upsert` ile başka birinin ilanının id'sini gönderirse → 403, hedef ilan değişmemiş; (2) sahip kendi ilanını bu yoldan güncelleyebiliyor (regresyon yok); (3) `isPremium`/`isDoping`/sayaç alanları bu yoldan da (owner dahil) serbestçe yazılamıyor; (4) `create` operasyonu hâlâ çalışıyor.

---

### BUG-LISTING-002 — `ownerEmail`, herkese açık `GET /listings` / `GET /listings/:id` yanıtında sızıyor

- **Severity:** **CRITICAL**
- **Release blocker:** **EVET**
- **Live caller:** Evet — kimliksiz (`publicActions`'ta `find`/`findOne`), her ziyaretçi/bot/scraper.
- **Expected:** Bir satıcının gerçek e-posta adresi, uygulamanın kendi tasarım niyetiyle tutarlı biçimde (bkz. `hesabim_page.dart`'ın `_isOwnerView` dışında e-postayı `'Uygulama içi'` ile maskelemesi) yalnızca sahibine veya sunucu tarafı kararlarına görünür olmalı; herkese açık ilan listesi API yanıtında ham e-posta olmamalı.
- **Actual:** `src/api/listing/content-types/listing/schema.json` içinde `ownerEmail: { "type": "email" }` — **`"private": true` işareti yok** (dosya bizzat tam okundu, satır 101-103). `listing.ts` controller'ı `find`/`findOne` için hiçbir override/alan-gizleme yapmıyor (yalnızca `create`/`update` override edilmiş). Strapi 5'te bir alan `private:true` olarak işaretlenmedikçe REST yanıtından otomatik çıkarılmaz. Sonuç: `GET /listings` ve `GET /listings/:id`'nin döndürdüğü HER ilan satırında satıcının gerçek e-posta adresi ham olarak yer alıyor — kimlik doğrulaması gerekmeden, sayfalama ile tüm ilanlar taranarak toplu hasat edilebilir (spam/phishing/KVKK ihlali riski).
- **Root cause:** Şema alan tanımında eksik `private:true` bayrağı; controller'da `find`/`findOne` için bir sanitize/allowlist katmanı hiç yok.
- **Backend/Flutter:** Backend.
- **Minimum safe fix:** `schema.json`'da `ownerEmail` alanına `"private": true` eklenmesi (Strapi bunu tüm REST çıktısından otomatik çıkarır) — YA DA controller'da `find`/`findOne`'ı override edip `sanitizeOutput` sonrası `ownerEmail`'i silen bir adım eklemek. İlk seçenek daha az riskli (mevcut iç kullanım — örn. `syncOwnerPremiumFlags`, `offer.ts`'nin `resolveListingOwnerByAnyId`'i — `entityService`/`db.query` üzerinden çalıştığı için `private:true`'dan etkilenmez, yalnızca REST API çıktısını etkiler).
- **Required tests:** (1) kimliksiz `GET /listings` ve `GET /listings/:id` yanıtlarında `ownerEmail` alanı artık YOK; (2) `ownerName`/`ownerCity`/`ownerProfileId`/`ownerId` hâlâ VAR (bunlar kasıtlı olarak public); (3) backend-içi kullanım noktaları (`resolveListingOwnerByAnyId`, `syncOwnerPremiumFlags`, `offer.ts`) hâlâ çalışıyor (bunlar `entityService`/`db.query` kullanıyor, `private` bayrağından etkilenmemeli — regresyon testiyle doğrulanmalı).

---

### BUG-LISTING-003 — İlan detay sayfasından favorileme, Favoriler sayfasına yansımıyor (eksik migrasyon)

- **Severity:** **HIGH**
- **Release blocker:** **EVET** (temel bir pazar yeri özelliği, herhangi bir manuel QA turunda görülür)
- **Live caller:** Evet — `listing_detail_page.dart`'ın favori butonu, uygulamanın kullanıcıların bir ilanı favorilediği en belirgin yer.
- **Expected:** Bir ilan herhangi bir ekrandan favorilendiğinde, Favoriler sayfasında görünmeli (uygulamanın kendi kod tabanında bu tam olarak çözülmüş bir problem — bkz. Actual).
- **Actual:** `listing_detail_page.dart`'ın `_toggleFav` (satır 106-135, bizzat tam okundu) SADECE `EngagementStore.I.toggleFavorite(target)` çağırıyor. `FavoritesStore.I.addListingLocal`/`removeListingLocal` çağrısı **YOK**. Oysa aynı işlevi yapan DİĞER tüm çağrı noktaları — `search_listings_page.dart`'ın `_toggleListingEngagementFavorite`/`_setAccountHubListingFavorite` (satır 597-654) ve `favorites_page.dart`'ın kendi `_toggleFavoritesPageListingFavorite`'i (satır 605-643) — `EngagementStore.I.toggleFavorite` çağrısının YANINA bilinçli olarak `FavoritesStore.I.addListingLocal`/`removeListingLocal` ekliyor; kod içi yorumlar bunun tam olarak bu senkronizasyon sorununu çözmek için "D4-F"de eklendiğini açıkça belirtiyor ("favorited from any of this helper's call sites would never appear in FavoritesPage... `addListingLocal`/`removeListingLocal` are the local-only mirror established in D4-F for exactly this purpose"). `listing_detail_page.dart` bu migrasyonu **kaçırmış**. `FavoritesPage` ise (`favorites_page.dart`) sunucudan canlı yeniden çekim yapmıyor, salt `FavoritesStore.I.ids` (yerel küme) + `ListingsStore.I.items`'a güveniyor. Sonuç: kullanıcı bir ilanı detay sayfasından favorilerse, sunucuda `engagement_interactions`/`favoriteCount` doğru güncellenir ama `FavoritesStore.I.ids` hiç güncellenmez → **Favorilerim sayfasında o ilan görünmez**, ta ki (varsa) başka bir yol bu yerel kümeyi ayrıca güncelleyene kadar.
- **Root cause:** İki paralel engagement sistemi arasında (eski `ListingEngagementStore`/`FavoritesStore` vs yeni `EngagementStore`/v1 contract) eksik köprü — bu spesifik sayfa migrasyonda atlanmış.
- **Backend/Flutter:** Flutter.
- **Minimum safe fix:** `listing_detail_page.dart`'ın `_toggleFav`'ına, `search_listings_page.dart`'daki aynı desen: `EngagementStore.I.toggleFavorite(target)` başarılı olduktan sonra `EngagementStore.I.snapshotFor(target).favorited`'e göre `FavoritesStore.I.addListingLocal`/`removeListingLocal` çağrısı eklenmesi.
- **Required tests:** (1) bir ilanı detay sayfasından favorile → Favoriler sayfasını aç → ilan orada; (2) aynı ilanı detay sayfasından favoriden çıkar → Favoriler sayfasında artık yok; (3) `EngagementContractException` durumunda (mevcut diğer call site'lardaki gibi) yerel mirror geri alınıyor.

---

### BUG-LISTING-004 — `isDoping`/`rocketEndsAt`, `CLIENT_PROTECTED_FIELDS`'te değil → ücretsiz kendi-kendine rocket/boost

- **Severity:** **HIGH**
- **Release blocker:** Karar gerektirir — takım tarafından zaten bilinen, bilinçli olarak ertelenmiş bir madde (bkz. Actual), ama gerçek ve hâlâ açık.
- **Live caller:** Evet — herhangi bir authenticated kullanıcı, `PUT /listings/:id` (kendi ilanı için, `listing-owner-write` policy'sini geçer).
- **Expected:** `isDoping`/`rocketEndsAt`, gerçek bir satın alma/onay akışından geçmeden client tarafından ayarlanamamalı (`isPremium`/`isPremiumOwner` için zaten böyle).
- **Actual:** `listing.ts`'in `CLIENT_PROTECTED_FIELDS` listesi (satır 36-46, bizzat okundu) `likeCount, favoriteCount, viewCount, offerCount, commentCount, shareCount, engagementVersion, isPremium, isPremiumOwner` içeriyor — **`isDoping` ve `rocketEndsAt` yok**. Kodun kendi yorumu bunu doğruluyor: *"Not included: isDoping/rocketEndsAt (a separate rocket/promotion mechanism, not part of this audit item — flagged in SEMANTIC_CONTRACT_S2_HIGH_FIX_REPORT.md as a follow-up, not fixed here)."* Sonuç: herhangi bir kullanıcı kendi ilanına `PUT /listings/:id` ile `{isDoping:true, rocketEndsAt:"2099-01-01"}` gönderip ücretsiz "roket" boost'u self-servis alabilir — ödeme/onay katmanı bypass edilir.
- **Root cause:** Bilinen, önceki bir raporda (`SEMANTIC_CONTRACT_S2_HIGH_FIX_REPORT.md`) takip için işaretlenmiş ama henüz düzeltilmemiş kapsam dışı bırakma.
- **Backend/Flutter:** Backend.
- **Minimum safe fix:** `CLIENT_PROTECTED_FIELDS`'e `isDoping`/`rocketEndsAt` eklenmesi; gerçek rocket satın alma akışı varsa (Flutter'daki `ListingsStore.setRocket` çağrı zincirinin nereye çıktığı bu fazda ayrıca doğrulanmalı) onun sunucu tarafında ayrı, korumasız bir yoldan (örn. satın alma doğrulamasından sonra `entityService.update` çağıran özel bir action) bu alanları yazması sağlanmalı.
- **Required tests:** kendi ilanına `isDoping`/`rocketEndsAt` göndererek `PUT` → değer sunucuda değişmiyor; gerçek rocket satın alma akışı (varsa) hâlâ çalışıyor.

---

### BUG-LISTING-005 — `ownerEmail`/`ownerProfileId`/`ownerId`, `update()`'te ne siliniyor ne yeniden zorlanıyor

- **Severity:** MEDIUM-HIGH
- **Release blocker:** Hayır (BUG-LISTING-001 düzeltildiğinde saldırı yüzeyi daralır, ama bu ayrı ve kendi başına gerçek bir gedik)
- **Live caller:** Evet — herhangi bir ilan sahibi, kendi `PUT /listings/:id` isteğine bu alanları ekleyebilir.
- **Expected:** `create()`'teki gibi, `update()` de sahiplik alanlarını her zaman sunucu kimliğinden yeniden zorlamalı (istemcinin gönderdiği herhangi bir değeri yok saymalı).
- **Actual:** `listing.ts`'in `update()`'i (satır 133-138, bizzat okundu) yalnızca `stripClientProtectedFields(input)` çağırıyor — `ownerEmail`/`ownerProfileId`/`ownerId` bu listede değil. `listing-owner-write` policy'si de yalnızca `POST` (create) için body'e sahiplik alanları enjekte ediyor (satır 15-24); `PUT` için yalnızca mevcut satırın sahipliğini KONTROL EDİYOR, body'i hiç dokunmuyor. Sonuç: bir ilan sahibi kendi `PUT /listings/:id` isteğine `ownerEmail`/`ownerProfileId`/`ownerId` alanları ekleyerek kendi ilanının sahipliğini keyfi (başka gerçek/sahte) bir kimliğe devredebilir.
- **Root cause:** `create()`'teki sahiplik-zorlama deseninin `update()`'e uygulanmamış olması.
- **Backend/Flutter:** Backend.
- **Minimum safe fix:** `update()`'e de `create()`'teki gibi `ownerEmail`/`ownerProfileId`/`ownerId`'yi `stripClientProtectedFields`'ten SONRA identity'den yeniden zorlayan 3 satır eklenmesi.
- **Required tests:** sahip kendi ilanını günceller ve body'e farklı bir `ownerEmail` koyar → satırın gerçek sahibi DEĞİŞMİYOR (hâlâ orijinal sahip).

---

### BUG-LISTING-006 — Teklif alıcı-spoofing (BUG-OFFER-001), `main`'de hâlâ açık — O1 merge edilmemiş

- **Severity:** **CRITICAL (main'in mevcut hali için)** — ama kod değişikliği DEĞİL, merge gerektiriyor
- **Release blocker:** EVET
- **Live caller:** Evet — `POST /offers` (`offer.ts` `create`), "Teklif Ver" akışı.
- **Expected:** İlan sahibi sunucu tarafında `resolveListingOwnerByAnyId` ile otoriter biçimde çözülmeli; istemci değeri yalnızca çözümleme başarısız olursa fallback olmalı (tam olarak `OFFER_O1_CORE_FIX_REPORT.md`'nin tarif ettiği düzeltme).
- **Actual:** Bu oturumda bizzat okunan `offer.ts` (mevcut `fix/release-permission-gaps` branch'i, `main` tabanlı) hâlâ:
  ```ts
  let receiverEmail = normalizeEmail(data.receiverEmail);
  let receiverProfileId = String(data.receiverProfileId ?? '').trim();
  if (!receiverEmail && listingOwner?.email) receiverEmail = listingOwner.email;
  if (!receiverProfileId && listingOwner?.ownerId) receiverProfileId = listingOwner.ownerId;
  ```
  yani **istemci değeri, gönderildiğinde, sunucunun çözdüğü gerçek ilan sahibinin önüne geçiyor** — tam olarak `OFFER_SYSTEM_FORENSIC_AUDIT.md`'nin bulduğu ve `OFFER_O1_CORE_FIX_REPORT.md`'nin düzelttiği orijinal açık. Bu **Sprint 6'nın yeni bulduğu bir şey değil** — O1 bunu zaten doğru şekilde düzeltti (`listingOwner` sonucu artık istemci değerinin ÖNÜNE geçecek şekilde), ama düzeltme `fix/release-offer-core` branch'inde duruyor ve `main`'e hiç merge edilmedi (bkz. rapor başındaki Branch Entegrasyon Durumu). Bugünkü haliyle `main`'den alınacak bir release, saldırganın rastgele bir kurbana yönelik teklif oluşturabildiği (mevcut olmayan bir `listingId` ile bile) orijinal açığı taşır.
- **Root cause:** Merge eksikliği, yeni bir kod hatası değil.
- **Backend/Flutter:** Backend (zaten var olan bir fix'i merge etmek).
- **Minimum safe fix:** `fix/release-offer-core`'un `main`'e merge edilmesi (kod değişikliği gerekmiyor, fix zaten yazılmış ve 176/176 test ile doğrulanmış — `OFFER_O1_CORE_FIX_REPORT.md`).
- **Required tests:** O1 raporundaki testler zaten mevcut; merge sonrası tam suite tekrar koşulmalı.

---

### BUG-LISTING-007 — Mesaj alıcı kimliği, ilan sahibiyle sunucu tarafında çapraz doğrulanmıyor

- **Severity:** LOW-MEDIUM (güvenlik açığı değil — veri bütünlüğü)
- **Release blocker:** Hayır
- **Live caller:** Evet — `conversation.ts`'in `upsert`/`sendMessage`'ı.
- **Expected/Actual:** `normalizeParticipants` (`conversation.ts` 77-130, bizzat okundu) `senderEmail`/`senderProfileId`'yi her zaman `ctx.state.user`'dan (JWT) türetiyor — bu iyi, spoof edilemez. Ama `receiverEmail`/`receiverProfileId` tamamen istemciden okunuyor; hiçbir yerde `resolveListingOwnerByAnyId`-benzeri bir çağrı ile "bu alıcı gerçekten bu ilanın sahibi mi" kontrol edilmiyor (yalnızca kendi kendine mesajı ve `senderIsParticipant` kontrol ediliyor). Bu, `offer.ts`'nin yaptığı (kısmi de olsa) çapraz kontrolden farklı. **Güvenlik açığı değil** çünkü bu uygulamada mesajlaşma zaten "yalnızca ilan sahibiyle" kısıtlı değil — herhangi bir kullanıcı herhangi bir kullanıcıya mesaj başlatabiliyor gibi görünüyor (kimseyi taklit edemiyor, sadece istediği gerçek bir hesaba mesaj gönderebiliyor). Risk, kötü niyetli/değiştirilmiş bir istemcinin bir ilanla ilgiliymiş gibi görünen ama aslında listingId/alıcı uyuşmayan bir konuşma başlatabilmesi — veri bütünlüğü/bağlam karışıklığı, yetkilendirme ihlali değil.
- **Root cause:** `offer.ts`'deki `resolveListingOwnerByAnyId` desenine paralel bir doğrulamanın `conversation.ts`'e hiç eklenmemiş olması.
- **Backend/Flutter:** Backend.
- **Minimum safe fix (opsiyonel, düşük öncelik):** `data.listingId` mevcutsa, `resolveListingOwnerByAnyId` ile çözülen sahibi `receiverEmail`/`receiverProfileId` ile karşılaştırıp uyuşmazlıkta reddetmek yerine sunucu-otoriter değeri kullanmak (offer.ts'nin O1-sonrası deseniyle aynı).
- **Required tests:** varsa, listingId + yanlış receiver kombinasyonuyla thread açma denemesi.

---

### BUG-LISTING-008 — Profil sayfasından başlatılan mesaj, `listingId` taşımıyor

- **Severity:** MEDIUM
- **Release blocker:** Hayır
- **Live caller:** Evet — `hesabim_page.dart`/`premium_market_profile_page.dart`'ın "Mesaj Gönder" butonu (ilan detayından "ilan sahibi" kartına tıklanarak ulaşılan profil sayfası).
- **Expected:** İlan detayından ilan sahibinin profiline gidip mesaj başlatan bir kullanıcının konuşması, o ilanla ilişkilendirilmeli (offer-chat'in yaptığı gibi).
- **Actual:** `openDirectMessageThread` çağrıları (`premium_market_profile_page.dart`) `listingId`/`listingTitle`/`imageUrl` parametrelerini geçmiyor (varsayılan boş string) — bizzat doğrulandı. Konuşma yalnızca `targetProfileId` ile açılıyor, hangi ilan üzerinden geldiği kayboluyor.
- **Root cause:** Eksik parametre aktarımı.
- **Backend/Flutter:** Flutter.
- **Minimum safe fix:** `_openListingOwnerProfile`'dan profil sayfasına ilan bağlamını (id/title/ilk görsel) taşıyıp, oradaki "Mesaj Gönder" çağrısına iletmek.
- **Required tests:** ilan detayından "ilan sahibi" → "Mesaj Gönder" → açılan thread'in `listingId` alanı dolu.

---

### BUG-LISTING-009 — "Pasife Al" aslında geri döndürülemez tam silme

- **Severity:** MEDIUM
- **Release blocker:** Hayır, ama kullanıcıyı yanıltıyor
- **Live caller:** Evet — `general_listing_management_page.dart`'ın popup menüsündeki "Pasife Al" seçeneği.
- **Expected:** "Pasife Al" ilanı geçici olarak gizlemeli, sahibi istediğinde yeniden aktifleştirebilmeli (etiketin ima ettiği gibi).
- **Actual:** `'passive'` menü seçeneği, `'delete'` ile AYNI handler'ı (`widget.onDelete`) çağırıyor — yani "Pasife Al" gerçekte kalıcı silme yapıyor, geri dönüşü yok, ne backend'de ne Flutter'da bir "reactivate" yolu mevcut değil.
- **Root cause:** UI etiketi ile gerçek davranış arasında uyuşmazlık; muhtemelen "deactivate" özelliği hiç implemente edilmemiş, geçici olarak delete'e yönlendirilmiş.
- **Backend/Flutter:** Flutter (UI/UX + gerçek pasife-alma mantığının eksikliği; backend'de zaten `status` enum'unda `pending/active/rejected` var ama bir "paused/inactive" değeri yok — şema seviyesinde de eksik).
- **Minimum safe fix:** Ya etiketi "Sil" olarak düzeltip yanıltıcı vaadi kaldırmak (hızlı, düşük risk), ya da gerçek bir pasif durum (`status` enum'una yeni değer + gizleme mantığı) eklemek (daha büyük iş, ayrı faz).
- **Required tests:** N/A bu fazda (ürün kararı gerektiriyor).

---

## RİSKLER (doğrulanmış bug değil, ama izlenmeli)

**RISK-1 — İki paralel engagement pipeline'ı (eski `ListingEngagementStore`/`FavoritesStore` vs yeni `EngagementStore`/v1 contract).** BUG-LISTING-003'ün kök nedeni; migrasyon tamamlanana kadar benzer kaçırılmış-senkronizasyon hataları başka ekranlarda da çıkabilir. Kart widget'larının (`all_listing_row_card.dart` vb.) beğeni/favori durumunu hangi store'dan okuduğu bu fazda tek tek doğrulanmadı — ayrı bir geçiş taraması önerilir.

**RISK-2 — Client-side rocket/premium override kalıcılığı.** `ListingsStore`'un `listing_rocket_overrides_v1` (yerel rocket bitiş tarihi override'ı) ve `effectiveIsPremium`'un `PurchaseStore.I.activePremium != null` ile yerel override'ı — yalnızca ilgili kullanıcının KENDİ cihazında KENDİ ilanının görünümünü etkiliyor, sunucuya yazılmıyor, başka kullanıcıları etkilemiyor. Güvenlik riski değil ama sahibinin kendi ekranında gerçekte süresi dolmuş bir rocket/premium'u "aktif" görmesine neden olabilir (kafa karışıklığı).

**RISK-3 — Favoriler sayfası açılışta canlı sunucu senkronizasyonu yapmıyor**, yerel `FavoritesStore.I.ids` + `ListingsStore.I.items` önbelleğine güveniyor. Uygulamanın genel offline-first mimarisiyle tutarlı görünüyor (muhtemelen kasıtlı), ama çoklu-cihaz senaryosunda gecikmeli tutarlılığa yol açabilir.

---

## DEAD CODE

**DEAD-1 — `engagement.ts`'teki `updateListingCounter`/`toggleProfileList`.** Grep ile doğrulandı: bu iki fonksiyon tanımlı ama `toggleListingFavorite`/`toggleListingLike` artık `delegateListingMembershipToggle`'a yönlendirildiği için (Aşama 10 migrasyonu) hiçbir yerden çağrılmıyor. Silinebilir.

**DEAD-2 — `ListingEngagementStore._syncListingMetrics`'in gönderdiği ham sayaç payload'ı.** Tam olarak "dead" değil (hâlâ çağrılıyor ve ağ isteği gidiyor), ama backend'in `CLIENT_PROTECTED_FIELDS`'i tarafından sessizce siliniyor — yani gönderilen `views/viewCount/favoriteCount/favorites/likeCount/likes/offerCount` alanlarının HİÇBİRİ artık sunucuda hiçbir etki yapmıyor. Fonksiyonel olarak ölü, ama gereksiz ağ trafiği üretmeye devam ediyor. Temizlenmesi önerilir (Faz C/D kapsamında, bu fazda dokunulmadı).

---

## S1/S2 Semantic Contract yeniden kontrolü

**S1 (premium `endsAt:null` semantiği):** `isPremiumActiveFromProfile` (`premium-sync.ts`) bizzat okundu — `endsAt` eksik/parse edilemezse `true` (aktif/sınırsız) dönüyor, tutarlı ve regresyon yok. `listing.ts`'in `hasActivePremiumExpiry`'si buna 1:1 delege ediyor.

**S2 (listing `CLIENT_PROTECTED_FIELDS`):** `update()`'te 9 alan için hâlâ doğru çalışıyor, regresyon yok. **Ama bu denetim aynı zafiyet sınıfının 3 komşu yerde hâlâ açık olduğunu buldu**: `isDoping`/`rocketEndsAt` (BUG-LISTING-004, S2 raporunun kendisinde zaten bilinen bir takip maddesi olarak işaretli), sahiplik alanları `update()`'te (BUG-LISTING-005, yeni), ve en önemlisi `syncOfflineListing`'in S2 korumasını tamamen atlayan paralel bir yazma yolu olması (BUG-LISTING-001, yeni ve en kritik).

---

## ÖZET SAYIM

- **Gerçek, doğrulanmış bug:** **9** (BUG-LISTING-001 → 009)
  - CRITICAL: 3 (001, 002, 006 — 006 kod değil merge sorunu)
  - HIGH: 2 (003, 004)
  - MEDIUM-HIGH: 1 (005)
  - MEDIUM: 2 (008, 009)
  - LOW-MEDIUM: 1 (007)
- **Potansiyel risk (bug değil, izlenmeli):** **3** (RISK-1, RISK-2, RISK-3)
- **Dead code:** **2** (DEAD-1, DEAD-2)

---

## KARAR

# RELEASE BLOCKED

Gerekçe: iki bağımsız, kimlik doğrulaması ötesinde hiçbir ek yetki gerektirmeyen (BUG-LISTING-002 kimliksiz bile) **CRITICAL** güvenlik açığı `main`'de canlı ve doğrudan kanıtlandı — biri herhangi bir kullanıcının herhangi bir başka kullanıcının ilanını ele geçirip/bozabilmesine (BUG-LISTING-001), diğeri her satıcının e-posta adresinin herkese açık sızmasına (BUG-LISTING-002) izin veriyor. Ayrıca `main`'in kendisi hâlâ önceki sprint'lerde bulunup düzeltilmiş ama merge edilmemiş bir CRITICAL açığı (teklif alıcı-spoofing, BUG-LISTING-006) taşıyor. Bunlara ek olarak favorileme özelliğinin bir ekrandan bozuk çalıştığı (BUG-LISTING-003) ve ücretsiz rocket-boost self-servis açığı (BUG-LISTING-004) gibi HIGH bulgular var.

Bu üç CRITICAL madde (001, 002, 006) düzeltilip/merge edilmeden hiçbir release yapılmamalı. 003 ve 004 de release öncesi kapatılması güçlü şekilde önerilen HIGH öncelikli maddeler. Diğer maddeler (005, 007, 008, 009) ve riskler, bu fazın ardından planlanan hedefli düzeltme turunda ele alınabilir.
