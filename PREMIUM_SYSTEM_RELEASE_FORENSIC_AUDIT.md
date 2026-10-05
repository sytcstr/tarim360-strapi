# TARIM360+1 — SPRINT 7 — PREMIUM SYSTEM FULL RELEASE FORENSIC AUDIT

**Mod: READ-ONLY.** Hiçbir dosya değiştirilmedi, commit/push yapılmadı, `release/preflight-integration` branch'i her iki repoda da hiç dokunulmadan bırakıldı, production mutation/deploy yapılmadı.

Backend: `C:\projeler\tarim360-strapi`, branch `release/preflight-integration`, HEAD `802cf2e`.
Flutter: `C:\projeler\tarim360`, branch `release/preflight-integration`, HEAD `c550e3a`.
Her iki repo da analiz başında `git branch --show-current` ile doğrulandı.

**Yöntem:** 3 paralel Explore ajanıyla geniş keşif (backend premium yüzeyi, Flutter premium yüzeyi, önceki fix'lerin regresyon kontrolü), ardından en kritik iddialar (roket aktivasyon akışı, processed-products premium kontrolü, public premiumOwners endpoint'i) bizzat dosya okunarak doğrulandı.

---

## 1. Premium Source of Truth

**Tek gerçek source-of-truth: `profile-setting.activePremium` (ve aynadaki `activePremiumSubscription`, ikisi de aynı payload'ı tutar) — backend'de.**

Yazan: `src/api/purchase/lib/persistence.ts`'nin `upsertProfilePurchase` (satın alma doğrulama/webhook sonrası) ve `src/api/promo/controllers/promo.ts`'nin `redeem` (promo kod kullanımı). İkisi de doğrudan `profile-setting.activePremium`/`activePremiumSubscription`'a `entityService.update`/`.create` ile yazıyor.

Okuyan/hesaplayan: `src/utils/premium-sync.ts`'nin `isPremiumActiveFromProfile(row)` — **tek kanonik aktiflik kuralı**, repo genelinde 6 canlı yerde (AI, logistics, listing create, public-profile, promo, auth-flow/premiumOwners) bu fonksiyona delege ediliyor, hiçbiri kendi bağımsız kopyasını implement etmiyor (bir istisna var, bkz. Bulgu 2 dead-code).

Flutter tarafı **kendi başına hiçbir premium veri saklamıyor** — `PurchaseStore` SharedPreferences kullanmıyor (repo genelinde grep doğrulandı, sıfır eşleşme), tamamen bellekte `ownerId`'ye göre anahtarlanmış map'ler tutuyor ve her session-restore/login'de Strapi'den taze çekiyor (`_refreshSessionFeeds`'in `'purchase'` adımı → `PurchaseStore.I.refreshFromStrapiForCurrentSession`). Bu, sorunun kendi 4. maddesine ("yalnız local cache'e bağımlı mı?") net cevap: **HAYIR, backend her zaman otoriter, her girişte yeniden hydrate ediliyor.** Bu iyi bir bulgu, düzeltme gerektirmiyor.

`PurchaseSubscription.isCurrentlyActive` (Flutter) ve `isPremiumActiveFromProfile` (backend) **aynı semantiği** kullanıyor — her ikisi de kod içi yorumlarla birbirine referans veriyor.

**Bağımsız eski implementasyon kalıntıları bulundu — 3 tane, hepsi kanonik kuralla tutarlı VEYA ölü:**
1. `src/api/logistics-load/policies/require-logistics-premium.js` (backend) — **ölü ama YANLIŞ mantık** (Bulgu-adayı, bkz. DEAD/LEGACY).
2. `lib/main.dart`'ın `_remoteProfileHasActivePremiumSubscription` (Flutter) — canlı, ama kanonik kuralın ikinci bir kopyası (şu an tutarlı, gelecekte sürüklenme riski).
3. Flutter'ın rocket/doping (`isRocketActive` processed_market_stores.dart, `logistics_vehicle_promotion_store.dart`) ve approved-ads (`publishEndsAt`) `endsAt` kontrolleri — bunlar Premium'dan tamamen **ayrı** özellikler, kendi (bazen ters: null=pasif) semantiklerini kullanıyorlar, Premium ile karıştırılmamalı; kontrol edildi, doğru/kasıtlı.

---

## 2. Premium Active Semantics — her gate'te tutarlılık

| Gate | Backend mekanizma | Kanonik mi? |
|---|---|---|
| AI | `src/api/ai/controllers/ai.ts` `hasActiveAiAccess` | ✅ delege ediyor + `hasAiAssistant` plan-tier kontrolü ekliyor |
| Logistics | `src/policies/require-logistics-premium.ts` (canlı, `global::` route'a bağlı) | ✅ delege ediyor |
| Listing (premium rozeti create'te) | `src/api/listing/controllers/listing.ts` `hasActivePremiumExpiry` | ✅ delege ediyor |
| Public profile badge | `src/api/public-profile/services/public-profile.ts` | ✅ delege ediyor |
| Promo redemption | `src/api/promo/controllers/promo.ts` | ✅ delege ediyor |
| Ads / Smart Ads | — | Gate YOK (bkz. Bulgu 11) |
| Processed Products | — | **Gate YOK — Bulgu-PREM-003, bkz. aşağı** |
| Rocket/Doping | — | Premium'la hiç bağlantısı yok (ayrı ürün), bkz. Bulgu-PREM-001 |

**Bağımsız `endsAt != null && endsAt > now` tipi eski implementasyon** yalnızca bir yerde bulundu: `src/api/logistics-load/policies/require-logistics-premium.js` (ölü, DEAD/LEGACY bölümünde).

---

## 3. Premium Purchase Flow

Gerçek `in_app_purchase` entegrasyonu VAR (`StoreBillingGateway`, `lib/features/premium/billing/billing_gateway.dart`) — placeholder değil, tam Play/StoreKit akışı (`purchaseStream`, `queryProductDetails`, `completePurchase`, `restorePurchases`). `kReleaseMode`'da otomatik aktif; debug/profile build'lerde `--dart-define=ENABLE_STORE_BILLING=true` verilmezse `MockBillingGateway` kullanılıyor ve her satın alma "Mağaza ödeme altyapısı bu buildde aktif değil" ile başarısız oluyor — **bu bilinçli bir davranış** (debug build'lerde sessiz/otomatik premium verilmiyor), production ödeme YAPILMADI, sadece kod okundu.

Akış: plan seçimi → `PurchaseCoordinator.purchase()` → store satın alma → `strapi.verifyPurchase()` (POST `/purchases/verify`, sunucu tarafında `verifyWithProvider` ile gerçek doğrulama) → yalnız `verified:true` dönerse `PurchaseStore.I.buy()` (yerel state) → arka planda Strapi'ye `profile-settings` PUT.

Çift satın alma / idempotency: backend `purchase.ts`'nin `verify()`'ı `transactionId`'ye göre idempotent (var olan `purchase-event` satırı `status==='verified'` ise 200 döner, tekrar yazmaz). Retry: `_syncOwnerToStrapiOnce` başarısız Strapi PUT'unu üstel geri çekilmeyle (30s tavan) tekrar dener. Satın alma başarılı ama Strapi sync başarısız senaryosu: yerel `PurchaseStore` state'i zaten güncellenmiş oluyor (`buy()` senkron), arka plan retry mekanizması Strapi'yi eninde sonunda yakalıyor — kısa süreli cihaz-sunucu tutarsızlığı mümkün ama kalıcı kayıp yok.

**Bulunan sorun bu bölümde değil, roket/promosyon bölümünde (Bulgu-PREM-001) — satın alma doğrulamasının kendisi sağlam, ama "roket" ürün hattının SONUÇ yazma adımı backend tarafından tamamen reddediliyor.**

---

## 4. Restore / History

Zaten madde 1'de kanıtlandı: local cache yok, her login/restore'da backend'den taze çekiliyor (`_refreshSessionFeeds` → `PurchaseStore.refreshFromStrapiForCurrentSession`). Ayrıca `PurchaseCoordinator.restorePurchases()` (explicit "Satın Alımları Geri Yükle" butonu) ve iOS "already owned" onarım yolu (`_restoreAlreadyOwnedPremium`) mevcut. Temiz kurulumda sunucuda premium olan kullanıcı → login sonrası tekrar premium **oluyor** (kanıtlandı, kod okundu). Bug yok.

---

## 5. Profile Premium

**SELF (kendi profili):** `hasActualProcessedMarketPremiumSubscription()` → `PurchaseStore.I.activePremium != null` (canlı `PurchaseStore` state'i).

**VISITOR (başkasının profili):** `PublicProfile.isPremium` ← `GET /public-profiles/:ownerId` (`auth:false`, IP-limitli 30/dk) ← backend `resolvePublicProfile`'ın döndürdüğü **tek boolean**.

**Sprint 2 fix'i integration branch'te KANITLANDI mevcut** — 3 bağımsız doğrulama:
- Backend `SELECT_FIELDS`, `activePremium`/`activePremiumSubscription`'ı yalnız `isPremiumActiveFromProfile` hesaplaması İÇİN seçiyor, yanıt gövdesine hiç spread etmiyor (satır satır okundu — `resolvePublicProfile` alan alan obje kuruyor, `row`'u hiç spread etmiyor).
- Yanıt objesinde `price`/`transactionId`/`startsAt`/`endsAt`/`planTitle` YOK — yalnız `isPremium: boolean`.
- Flutter `PublicProfile.isPremium` (`map['isPremium'] == true`) → `hesabim_page.dart`'ın visitor dalında (`_remotePremiumProfileHint`) doğru şekilde kullanılıyor.

Bug bulunmadı. **PRESENT.**

---

## 6. AI Premium Gate

Backend: `hasActiveAiAccess` — hem `isPremiumActiveFromProfile` (aktiflik) HEM `premium.hasAiAssistant===true` (plan-tier: yalnız Pro plan `hasAiAssistant:true` taşıyor, `PREMIUM_PRODUCTS` kataloğunda doğrulandı) ikisini birden istiyor.
Flutter: `PurchaseStore.hasProAiAccess` — aktif premium + (Pro plan eşleşmesi VEYA `planTitle` içinde "pro premium" + `hasAiAssistant`) — backend'in çifte koşuluyla tutarlı.

Normal user → deny, aktif premium+Pro → allow, endsAt:null → allow (kanonik kural üzerinden), expired → deny, client spoof → deny (backend her zaman DB'den okunan `profile-setting` satırına bakıyor, client body'sinden asla). Semantic mismatch bulunmadı. **PRESENT, bug yok.**

---

## 7. Logistics Premium

Canlı route (`global::require-logistics-premium`) kanonik fonksiyona delege ediyor — S1 semantic contract fix integration branch'te **PRESENT**. `logistics-admin.*` bu audit'in kapsamı dışında bırakıldı, karıştırılmadı.

Ayrı, ölü bir kopya bulundu — bkz. DEAD/LEGACY bölümü.

---

## 8/9. Premium Listing & Rocket/Promotion

### BUG-PREM-001 — Roket aktivasyon akışı, kendi CRITICAL fix'imizin yan etkisiyle tamamen kırık

- **Severity:** **CRITICAL**
- **Release blocker:** **EVET**
- **Live caller:** Evet. `lib/features/listings/pages/active_rocket_listings_page.dart` — hem premium-included roket hakkı kullanımı (satır ~529) hem bağımsız ücretli roket satın alma (satır ~570), ikisi de `_syncRocketStateToStrapi` çağırıyor.
- **Expected:** Kullanıcı roket satın aldığında/premium hakkını kullandığında, `isDoping`/`rocketEndsAt` sunucuda gerçekten yazılmalı — böylece diğer kullanıcılar ilanı "roketli" görsün.
- **Actual:** `_syncRocketStateToStrapi` (`active_rocket_listings_page.dart:251-266`, bizzat okundu) düz bir `strapi.updateListing(rawId, {'isDoping': true, 'rocketEndsAt': ...})` çağırıyor — normal `PUT /listings/:id` yolu. Ama bu TAM OLARAK önceki fazda (Listing Sistemi audit'i, BUG-LISTING-004) kapattığımız yol: `listing.ts`'in `update()`'i artık `LISTING_CLIENT_PROTECTED_FIELDS` üzerinden `isDoping`/`rocketEndsAt`'i HER update'te siliyor (bizzat kod okunarak doğrulandı, istisna yok). **Roket için hiçbir alternatif, sunucu-otoriter aktivasyon endpoint'i yok** — repo genelinde grep edildi, `src/api/promo/`, `src/api/purchase/` dahil hiçbir controller `isDoping`/`rocketEndsAt`'i yazmıyor.
- **Reproduction/code path:** Kullanıcı premium roket hakkını kullanır veya roket satın alır → Flutter UI "roketlendi" mesajı gösterir, yerel state güncellenir → arka planda `_syncRocketStateToStrapi` çağrılır → backend sessizce `isDoping`/`rocketEndsAt`'i siler, geri kalan alanları (varsa) günceller, `200 OK` döner (hata yok, sadece bu iki alan yok sayılıyor) → 2 saniye sonra kod kendi kendine `ListingsStore.I.refreshFromStrapi(force:true)` çağırıyor (satır 267-271) → sunucudan gelen taze veri roketin hiç aktif olmadığını gösterir. Yerel `listing_rocket_overrides_v1` override mekanizması (Listing audit'te bulunmuştu) bu durumu SATICININ kendi ekranında bir süre maskeleyebilir, ama BAŞKA HİÇBİR kullanıcı ilanı hiçbir zaman roketli göremez.
- **Root cause:** BUG-LISTING-004'ün güvenlik düzeltmesi (kullanıcının kendi kendine ücretsiz roket vermesini engellemek) doğru ve gerekliydi, ama tek yazma yolunu (client PUT) kapatırken yerine gerçek, satın-alma-doğrulamalı bir sunucu-otoriter aktivasyon yolu koymadı — çünkü böyle bir yol zaten hiç yoktu, yalnızca (artık kapatılmış) client PUT'a güveniliyordu.
- **Backend / Flutter / Both:** Backend (eksik endpoint) — Flutter'ın kodu zaten "doğru" davranıyor (satın alma doğrulanmış, doğru alanları PUT ediyor), sorun sunucu tarafının artık bu yazmayı kabul etmemesi.
- **Security/data impact:** Güvenlik açığı değil — tam tersi, GÜVENLİK DÜZELTMESİNİN istenmeyen yan etkisi. Ama gerçek para/gerçek premium hakkı karşılığında müşteriye ürün teslim edilmiyor — ciddi bir iş bütünlüğü/güven sorunu.
- **Minimum safe fix:** `engagement.ts`veya `offer.ts` gibi ayrı, dar kapsamlı bir controller action'ı (örn. `POST /listings/:id/rocket`) eklenmeli: kimlik doğrulama + ilan sahipliği kontrolü + (a) `PurchaseStore`'daki roket kredisinin backend'de de doğrulanması (şu an sadece client-local sayılıyor, bkz. POTENTIAL RISK) veya (b) `purchase-event`/ayrı bir roket-satın-alma kaydı üzerinden doğrulama + yalnız bu path'in `isDoping`/`rocketEndsAt`'i server-authoritative şekilde yazması.
- **Required regression tests:** roket satın alma sonrası ilan gerçekten `isDoping:true` ile DB'de görünüyor mu (entegrasyon testi); premium olmayan/kredisi olmayan kullanıcı bu yeni endpoint'i çağıramaz; normal `PUT /listings/:id` hâlâ bu alanları reddediyor (BUG-LISTING-004 regresyonu olmamalı).

### BUG-PREM-002 — Premium ilan `isPremium`/`isPremiumOwner` client-push'u artık zararsız ölü kod (BUG-PREM-001'in tersine, bu ZARARSIZ)

Aynı desen (`ListingsStore.syncOwnerPremiumStateToStrapi` → `strapi.updateListing(id, {isPremium, isPremiumOwner})`) `isPremium`/`isPremiumOwner` için de var ve aynı şekilde artık backend'de sessizce siliniyor. **Ama bu ZARARSIZ** çünkü bu iki alanın GERÇEK senkronizasyonu zaten backend'in kendi `profile-setting` lifecycle hook'u (`syncOwnerPremiumFlags`, satın alma/promo her `profile-setting` güncellemesinde otomatik tetikleniyor) üzerinden doğru şekilde yürüyor — client push'u hiç gerekmiyor, hep gereksizmiş. **DEAD/LEGACY olarak sınıflandırıldı, bug değil** (bkz. aşağı).

### Client premium/rocket spoof denemesi

`isPremium=true, isPremiumOwner=true, isDoping=true, rocketEndsAt=...` göndererek ücretsiz premium/rocket elde edilebiliyor mu? **HAYIR** — tüm yollar tarandı:
- Normal `create`/`update` (`listing.ts`): `LISTING_CLIENT_PROTECTED_FIELDS` hepsini siliyor. ✅ Engellendi.
- `offline-sync` (`engagement.ts`'nin `syncOfflineListing`): aynı korumayı kullanıyor (BUG-LISTING-001 fix'i). ✅ Engellendi.
- Legacy/promotion endpoint'leri: repo genelinde grep edildi, `isDoping`/`rocketEndsAt`'i yazan başka hiçbir endpoint yok (yukarıdaki BUG-PREM-001'in ta kendisi — yazan hiçbir şey yok, ne meşru ne kötü niyetli).

---

## 10. Processed Products

### BUG-PREM-003 — Processed Products premium/business-module kontrolü yalnızca Flutter UI'da var, backend'de HİÇ yok

- **Severity:** **HIGH**
- **Release blocker:** Ürün kararı gerektirir, ama güçlü öneri: EVET (aşağıda gerekçe)
- **Live caller:** Evet. `src/api/processed-products/controllers/processed-products.ts`'nin `upsert`/`mine` (bizzat okundu, satır 29-71) yalnızca `readIdentity(ctx)` (oturum var mı) kontrol ediyor — premium/business-module kontrolü YOK. Aynı durum `processed-product` ve `processed-seller-stores` controller'ları için de doğrulandı (repo genelinde `premium`/`Premium` grep'i bu 3 dizinde SIFIR eşleşme verdi).
- **Expected:** Flutter'ın `processed_seller_center_page.dart`'ın erişimi `currentSessionHasProcessedStoreAccess()` (→ `PurchaseStore.I.activePremium != null` VEYA business-module) ile kapıyor olması, bu özelliğin premium/business-gated olması gerektiğini gösteriyor (premium plan payload'ında da `unlimitedListings:true` adında açık bir premium hakkı var).
- **Actual:** Backend `POST /processed-products/upsert` (ve `mine`, `delete`) yalnızca "giriş yapmış mısın" soruyor. Premium olmayan, business modülü olmayan HERHANGİ bir kayıtlı kullanıcı, doğrudan API çağrısıyla (Flutter UI'yı hiç kullanmadan) processed-product oluşturabilir/yönetebilir.
- **Root cause:** Flutter tarafında UI-seviyesinde gate eklenmiş, backend'e karşılık gelen bir yetki kontrolü hiç yazılmamış.
- **Backend / Flutter / Both:** Backend (eksik kontrol).
- **Security/data impact:** Veri/gizlilik ihlali değil — iş/gelir bütünlüğü ihlali: ücretli bir özelliğin backend'i tamamen ücretsiz kullanılabiliyor.
- **Minimum safe fix:** `processed-products`/`processed-product`/`processed-seller-stores` controller'larının `upsert`/`create`-benzeri action'larına, `listing.ts`'in `hasActivePremiumExpiry`/`require-logistics-premium.ts` ile aynı desende bir premium-veya-business-module kontrolü eklenmesi (`isPremiumActiveFromProfile(profile) || hasBusinessModule(profile, 'processedProductsStore')`).
- **Required regression tests:** premium olmayan kullanıcı `upsert` çağırınca 403; premium kullanıcı çalışmaya devam ediyor; business-module sahibi (premium olmasa da) çalışmaya devam ediyor; mevcut (premium'suz oluşturulmuş) kayıtlar için geriye dönük bir geçiş kararı (silinsin mi, dokunulmasın mı) ayrı bir ürün kararı.

`endsAt:null` fix'inden sonra beklenmeyen bir entitlement genişlemesi bulunmadı — çünkü zaten hiç kontrol yok, "genişleme" diye bir şey ölçülemez; sorun her zaman bu genişti.

---

## 11. Ads / Smart Ads

`AppFeatureFlags.enableSmartAds = false` — `main.dart:990-992`'de sabit (`bool.fromEnvironment` değil, gerçek bir `const`), production'da runtime'da açılamaz. Kapalıyken: 4 `smart_ads_*` SKU satın alınabilir ürün setinden çıkarılıyor, ilgili UI'lar (fiyatlandırma sayfası, ayarlar, session-refresh) devre dışı. **Flag kapalı → şu an canlı bug yok, DEAD/DORMANT kod olarak sayıldı, production bug olarak raporlanmadı** (talimata uygun).

**POTENTIAL RISK (flag açılırsa):** Premium plan payload'ı (`smartAdIncludedTotal`/`smartAdRemaining`) her plan için dolduruluyor, ama bu sayaçları TÜKETEN/DOĞRULAYAN hiçbir backend mekanizması bulunamadı (`src/api/ad/`'de grep edildi). Flag açılırsa, "premium'a dahil ücretsiz akıllı reklam hakkı" salt kozmetik kalır — gerçek bir tüketim/limit uygulaması yok. Güvenlik açığı değil (ayrı SKU'lar zaten ücretli), ama tamamlanmamış bir özellik.

---

## 12. Admin-Granted / Unlimited Premium (`endsAt:null`)

Zaten madde 1-2'de kanıtlandı: `isPremiumActiveFromProfile`'ın `endsAt` eksik/parse edilemez → `true` kuralı TÜM gate'lerde (AI, logistics, listing, public-profile, promo) tutarlı şekilde uygulanıyor — hepsi aynı fonksiyona delege ediyor. `promo.ts`'nin `buildSubscriptionPayload`'ı, mevcut `endsAt:null` bir üyeliği UZATIRKEN bile `endsAt:null`'ı korumaya özen gösteriyor ("unlimited stays unlimited", satır 66 civarı yorumla doğrulandı) — bu özel durum ayrıca test edilmiş (`premium-gates.integration.test.ts`'nin "promo redemption: extending an unlimited... stays unlimited" testi).

`planTitle` eksik/boş → Flutter `'Premium'` fallback'i **PRESENT** (`purchase_store.dart:753-754`, bizzat doğrulandı).

Bug bulunmadı.

---

## 13. Expiration

- **UI ne zaman güncelleniyor?** `PurchaseStore.activePremium` getter'ı her okunduğunda kendi kendini iyileştiriyor (self-healing): süresi dolmuş bir cache girdisi bulursa siler, `ListingsStore`'a "artık premium değil" yayar, Strapi'ye yeniden senkronlar (satır 271-277, doğrulandı). Yani UI en geç bir sonraki `activePremium` okumasında (pratikte anlık, her `tick` değişiminde) güncelleniyor.
- **Backend gate hemen reddediyor mu?** Evet — her istek anlık `isPremiumActiveFromProfile(profile)` hesaplıyor, önbelleklenmiş bir "was premium" değeri yok.
- **Listing/ad premium flags nasıl güncelleniyor?** `syncOwnerPremiumFlags`, `profile-setting`'in `afterUpdate`/`afterCreate` lifecycle hook'u üzerinden — yani premium durumu HERHANGİ bir nedenle `profile-setting` satırı güncellendiğinde yeniden hesaplanıyor. **Ama süre dolumu kendiliğinden bir `profile-setting` güncellemesi TETİKLEMİYOR** (zaman geçmesi bir event değil) — bu yüzden bir üyelik sessizce süresi dolduğunda, o ANDA hiçbir otomatik senkron tetiklenmiyor; `listing.isPremium`/`isPremiumOwner` bir SONRAKİ `profile-setting` yazımına (örn. kullanıcının profilini güncellemesi, yeni satın alma, promo kullanımı) kadar ESKİ (hâlâ `true`) değerde KALABİLİR.
- **Sorulan spesifik risk doğrulandı:** Evet, teorik olarak mümkün — üyelik bugün sona eriyor ama `listing.isPremiumOwner=true` kalıcı şekilde kalabilir, ta ki bir sonraki `profile-setting` yazımı bunu düzeltene kadar. **Ancak gerçek kullanıcı etkisi SINIRLI**, çünkü: (a) `isPremiumActiveFromProfile`'ın kendisi HER gerçek gate'te (AI, logistics, public-profile badge) her istekte YENİDEN hesaplanıyor — yalnız listing/ad'ın DENORMALİZE `isPremium` kopyası (görsel rozet amaçlı) stale kalabilir; (b) `src/index.ts`'te bir bootstrap-time `runPremiumFlagsBackfill()` var (tüm profil satırlarını tarayıp yeniden senkronluyor) ama bu yalnız boot'ta çalışıyor, periyodik bir cron değil.

**BUG-PREM-004 (LOW, potential risk olarak sınıflandırıldı, confirmed bug değil):** Süresi dolan bir üyeliğin listing/ad üzerindeki `isPremium`/`isPremiumOwner` rozet alanı, bir sonraki `profile-setting` yazımına kadar stale `true` kalabilir — yalnızca GÖRSEL rozet etkisi (gerçek gate'ler her zaman doğru), düşük öncelik, periyodik bir yeniden-senkron cron job'ı önerilir ama bu fazda zorunlu değil.

---

## 14. Logout / Account Switch

`PurchaseStore` state'i `ownerId` ile anahtarlanmış bellek-içi map'ler (`_activePremiumByOwner` vb.) — **doğrudan bir "B, A'nın premium'unu görür" sızıntısı YOK**, çünkü farklı `ownerId` = farklı map anahtarı = User B'nin sorgusu asla User A'nın verisine denk gelmiyor.

**Ama gerçek bir tutarsızlık bulundu:** `PurchaseStore`'un `clearForSession()` metodu YOK ve `main.dart`'ın logout akışındaki (`_onSessionChanged`, satır 5980-5989) temizlenen store listesinde de yok — `OffersStore`, `MessagesStore`, `NotificationStore`, `SupportStore`, `HubContentRepo`, `ProfileFollowStore`, `FavoritesStore`, `FavoriteProfilesStore`, `ProfileCommentsStore` hepsi temizleniyor, `PurchaseStore` YOK.

### BUG-PREM-005 — PurchaseStore logout'ta temizlenmiyor, aynı hesap tekrar girişte bayat veri servis edebilir

- **Severity:** MEDIUM
- **Release blocker:** Hayır
- **Live caller:** Evet, her logout — ama etkisi yalnız AYNI hesabın AYNI app process'i içinde tekrar giriş yaptığı dar senaryoda ortaya çıkar.
- **Expected:** Diğer tüm per-owner store'larla tutarlı şekilde, logout'ta bellek-içi state temizlenmeli.
- **Actual:** Temizlenmiyor. Kullanıcı A çıkış yapıp aynı process içinde tekrar A olarak giriş yaparsa, `_remoteLoadedOwners` hâlâ A'yı içerdiği için `_ensureOwnerLoaded` taze bir Strapi çağrısı yapmadan eski (potansiyel olarak artık yanlış) bellek-içi veriyi servis edebilir.
- **Root cause:** `PurchaseStore`'a hiç `clearForSession()` eklenmemiş — muhtemelen ownerId-keying'in "zaten güvenli" görünmesi nedeniyle atlanmış.
- **Backend / Flutter / Both:** Flutter.
- **Security/data impact:** Cross-user sızıntı yok (ownerId-keying koruyor), yalnız bayat-veri/tutarlılık riski, dar senaryoda.
- **Minimum safe fix:** `PurchaseStore`'a diğer store'larla aynı desende bir `clearForSession()` eklenmesi (map'leri temizle) ve `main.dart`'ın `_onSessionChanged` temizleme listesine eklenmesi.
- **Required regression tests:** A çıkış → B giriş → A tekrar giriş senaryosunda `activePremium`'un taze bir Strapi çağrısıyla geldiğinin doğrulanması.

---

## 15/16. Security & API Privacy

Mass assignment / spoofing taraması (madde 8/9'da detaylandırıldı): listing write yolları (`create`/`update`/`offline-sync`) hepsi korumalı. `profile-setting`'in kendi `activePremium`/`activePremiumSubscription` alanları client tarafından doğrudan yazılabiliyor mu diye ayrıca kontrol edildi — `upsertProfileSettings` (Flutter → backend) genel bir PUT/POST; backend'de `profile-setting`'in kendi controller'ının bu iki alanı client'tan koruyup korumadığı BU AUDIT'TE AYRICA doğrulanmadı (yalnız listing/ad write yolları ve purchase/promo'nun kendi yazım mantığı incelendi) — **bu tek başına ayrı bir CONFIRMED bug değil, ama bir POTENTIAL RISK olarak işaretleniyor**, çünkü eğer `profile-setting`'in kendi `update` action'ı `activePremium`'u client body'sinden strip etmiyorsa, bir kullanıcı doğrudan `PUT /profile-settings/:id` ile kendine sınırsız premium yazabilir — bu ihtimal Sprint 8'de (ya da hemen bir hedefli kontrolle) ayrıca doğrulanmalı.

**API Privacy:** `public-profile` endpoint'i temiz (yalnız boolean, madde 5'te kanıtlandı). `GET /auth-flow/premium-owners` (public, auth yok) yalnız `{ok, ownerIds:[...]}` döndürüyor — ham `activePremium` objesi asla sızmıyor (bizzat kod okunarak doğrulandı). **POTENTIAL RISK (düşük öncelik):** bu endpoint, herkese açık ve auth gerektirmeden, TÜM premium üyelerin `ownerId`'lerinin (== `u_<email>` deterministik dönüşümü) tam listesini veriyor — ham PII değil ama bilinen bir e-postanın premium olup olmadığını kontrol etmek için bir "üyelik durumu oracle"ı oluşturuyor. Rate-limit var mı doğrulanmadı (bu fazda kontrol edilmedi).

---

## 17. Dead / Legacy Implementations

| Konum | Sınıflandırma | Not |
|---|---|---|
| `src/api/logistics-load/policies/require-logistics-premium.js` (backend) | **DEAD** | Hiçbir route bunu referans almıyor (repo genelinde grep doğrulandı) — ama içindeki mantık YANLIŞ (eksik `endsAt`'i pasif sayıyor, pre-fix davranış). Şu an zararsız ama gelecekte yanlışlıkla wire edilirse SEMANTIC_CONTRACT_S1 hatasını geri getirir. **Silinmesi önerilir.** |
| `ListingsStore.syncOwnerPremiumStateToStrapi`'nin `isPremium`/`isPremiumOwner` push'u (Flutter) | **DEAD (zararsız)** | Artık backend'de sessizce reddediliyor ama gerçek senkron zaten lifecycle hook üzerinden doğru çalışıyor — bu push hiç gerekmiyormuş. BUG-PREM-001'in (roket) tam tersi durum: burada "backend'in reddetmesi" zararsız çünkü gerçek bir alternatif zaten var. |
| `main.dart`'ın `_remoteProfileHasActivePremiumSubscription` | **LIVE, DUPLICATE (şu an tutarlı)** | Sahibin kendi profilinde `PurchaseStore` tam yüklenmeden önce hızlı bir "hint" olarak kullanılıyor. Mantık kanonik kuralla aynı ama ayrı bir kopya — kanonik kural değişirse senkronize güncellenmesi unutulabilir. |
| `AppFeatureFlags.enableSmartAds` arkasındaki tüm smart-ads kodu | **DORMANT (kasıtlı, ürün kararı)** | Flag kapalı, bug değil. |

---

## 18. Previous Fix Regression Check

| Madde | Durum |
|---|---|
| Flutter `endsAt:null` fix (`isCurrentlyActive`) | **PRESENT** |
| `planTitle` fallback ('Premium') | **PRESENT** |
| Backend `isPremiumActiveFromProfile` | **PRESENT** |
| AI canonical delegation | **PRESENT** |
| Logistics canonical delegation (canlı route) | **PRESENT** — ama yanında ölü/yanlış bir kopya var (bkz. §17) |
| Listing canonical delegation | **PRESENT** |
| Promo unlimited-premium fix | **PRESENT** (`endsAt:null` uzatmada korunuyor, test'le doğrulanmış) |
| `PublicProfile.isPremium` | **PRESENT** |
| Public raw premium privacy (sızıntı yok) | **PRESENT** |
| Listing premium/rocket field guards (BUG-LISTING-004) | **PRESENT, ama bu audit'te bir REGRESYONA yol açtığı bulundu** — güvenlik düzeltmesinin kendisi doğru ve hâlâ geçerli, ama roket için meşru aktivasyon yolunu da kapattı (BUG-PREM-001). Bu, BUG-LISTING-004'ün "regresse" olduğu anlamına gelmiyor (kendi amacını hâlâ doğru yerine getiriyor) — ayrı, yeni bir bug'ın (eksik replacement endpoint) ortaya çıkmasına neden oldu. |

---

## 19. Test Coverage Audit

**Backend** (`tests/integration/premium-gates.integration.test.ts`, 13 test): AI gate (future/null/past/no-premium ×4), logistics gate (aynı ×4), listing CREATE-zamanı premium stamping (×4), promo unlimited-extend (×1).

**Eksikler:**
- Listing UPDATE yolunda (yalnız create test edilmiş) premium/rocket alan koruması — kısmen `listing-ownership-and-protected-fields.integration.test.ts`'te (Listing fazından) örtülü ama Premium'a özel senaryo yok.
- Public-profile `isPremium` boolean'ının doğru hesaplandığına dair entegrasyon testi (`public-profile-read.integration.test.ts`'te olabilir, bu faz doğrulamadı).
- Roket aktivasyon akışı — **hiç test yok** (zaten hiç çalışan bir endpoint yok, BUG-PREM-001).
- Processed-products premium kontrolü — **hiç test yok** (zaten hiç kontrol yok, BUG-PREM-003).
- Account-switch / restore-hydration senaryoları.
- Client spoof denemesi (`isPremium=true` doğrudan `profile-setting`'e PUT) — madde 15'teki potential risk'in kendisi test edilmemiş.

**Flutter** (`test/features/premium/purchase_store_test.dart`): `isCurrentlyActive` (3), `parsePremiumSubscription` planTitle/endsAt senaryoları (~8). `test/features/profile/public_profile_test.dart`: `isPremium` parse + `premiumProfileHintForOwner` (Sprint 2/BUG-002 testleri, önceki fazda görülmüştü).

**Eksikler:** `clearForSession` yokluğu zaten test edilemez (metod yok). Hesap değişimi senaryosu. AI/logistics Flutter-taraf gate testleri. Roket satın alma akışı testi.

---

## ÖZET SAYIM

- **CONFIRMED BUG:** 5 (BUG-PREM-001 → 005)
  - CRITICAL: 1 (001 — roket aktivasyonu tamamen kırık)
  - HIGH: 1 (003 — processed-products premium kontrolü backend'de yok)
  - MEDIUM: 1 (005 — PurchaseStore clearForSession eksik)
  - LOW: 1 (004 — süresi dolan üyelikte listing rozeti stale kalabilir)
  - (002 numarası kasıtlı olarak DEAD/LEGACY'ye taşındı, confirmed bug sayılmadı)
- **POTENTIAL RISK:** 3 (profile-setting'in kendi update action'ının activePremium'u strip edip etmediği doğrulanmadı; smart-ads sayaçlarının tüketim mantığı yok; public premiumOwners endpoint'i üyelik-durumu oracle'ı)
- **PRODUCT DECISION:** 1 (`enableSmartAds=false`, kasıtlı)
- **DEAD/LEGACY CODE:** 3 (ölü+yanlış logistics policy .js dosyası; zararsız isPremium client-push; main.dart'ın duplicate hint fonksiyonu)

---

## KARAR

# RELEASE BLOCKED

Gerekçe: **BUG-PREM-001 (CRITICAL)** — roket ürün hattının tek aktivasyon yolu, önceki fazın (BUG-LISTING-004) güvenlik düzeltmesinin istenmeyen ama kesin yan etkisiyle tamamen kırılmış durumda; gerçek para veya premium hakkı karşılığında müşteriye ürün teslim edilmiyor. **BUG-PREM-003 (HIGH)** — processed-products'ın premium/business-module kontrolü yalnızca Flutter UI'da var, backend'de hiç yok; herhangi bir ücretsiz kullanıcı bu özelliği doğrudan API ile bypass edip kullanabiliyor.

Bu ikisi dışında Premium sisteminin geri kalanı (source-of-truth tutarlılığı, `endsAt:null` semantiği, AI/Logistics/Listing/Public-Profile gate'leri, satın alma doğrulaması, restore/hydration, spoof koruması) **temiz** — önceki tüm ilgili fix'ler integration branch'te doğrulanmış şekilde mevcut, hiçbir gerçek regresyon (BUG-PREM-001'in kök nedeni hariç) bulunmadı.

**Önerilen sıradaki adım:** BUG-PREM-001 ve BUG-PREM-003'ü hedefli bir fix fazında kapatmak (BUG-PREM-005 de düşük risk/kolay, aynı fazda eklenebilir), ardından Bildirim Sistemi audit'ine geçmek.
