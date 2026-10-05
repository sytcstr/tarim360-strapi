# Release Bug Fix Sprint — Sprint 2: Profile System Audit (READ-ONLY)

**Date:** 2026-08-11
**Repos:** `C:\projeler\tarim360` (Flutter), `C:\projeler\tarim360-strapi` (backend)
**Mode:** Read-only code analysis. No code changed, no commit, no push.

---

## P2.1 — Premium public profile akışı, uçtan uca, kanıtlı

### Zincirin tamamı

```
Strapi DB — profile-setting satırı
  fields: activePremium / activePremiumSubscription (JSON, private),
          accountType (string), businessModules, disabledBusinessModules
  ↓
public-profile/services/public-profile.ts — resolvePublicProfile()
  SELECT_FIELDS listesi: [profileId, displayName, publicUsername, brandName,
  city, bio, aboutText, logisticsAboutText, accountType, avatarUrl, coverUrl,
  profileMediaSettings, showcasePinnedIds, showcasePinnedOrder,
  ratingBaseCount/voteCountBase, ratingBaseAverage/ratingAverageBase,
  ratingVotesByViewer/ratingVotes]
  → activePremium/activePremiumSubscription/businessModules/
    disabledBusinessModules HİÇ SELECT edilmiyor. Servisin kendi yorum
    satırı bunu AÇIKÇA, KASITLI bir karar olarak belgeliyor (satır 27-33):
    "Also excluded: ... any premium/purchase field (their availability
    computation is entangled with activePremium/activePremiumSubscription,
    which must stay private)."
  ↓
GET /api/public-profiles/:ownerId (public-profile/controllers/public-profile.ts)
  → response.profile = yukarıdaki alan seti. accountType DÖNÜYOR (ham
    string, 'standard' veya 'business' — hiçbir zaman 'premium' değil,
    aşağıda kanıtlanıyor), ama premium/subscription bilgisi YOK.
  ↓
Flutter: PublicProfile.fromMap (public_profile.dart:48-90)
  → sınıfın KENDİ ALAN LİSTESİNDE premium/isPremium/premiumEndsAt/planTitle
    diye bir şey YOK. Sınıfın kendi doc-comment'i: "There is no phone,
    whatsapp, birthDate, favorites, or follow-list field here — nothing to
    accidentally leak, by construction" — ama bu cümle premium'u da
    (istemeden) kapsıyor: parse edilecek bir premium alanı yok, çünkü
    backend hiç göndermiyor.
  ↓
PublicProfileRepository.fetch (public_profile_repository.dart:14-34)
  → cache yok, her çağrıda taze network fetch, ownerId'ye göre doğru
    anahtarlanmış. Bug yok.
  ↓
HesabimPage._loadPublicProfileFromStrapi (hesabim_page.dart:196-226)
  → satır 217-218: TEK premium sinyali burada üretiliyor:
      _remotePremiumProfileHint =
          public.accountType == 'premium' || public.accountType == 'business';
  ↓
buildProfilePageForUser / premiumProfileHintForOwner /
shouldShowPremiumProfileForOwner (main.dart:6143-6193)
  → SELF: hasActualProcessedMarketPremiumSubscription() → PurchaseStore.I.activePremium
  → BAŞKASI: resolveBusinessAccountSummary(ownerId, ownerEmail).isBusinessPremium
    (business_vertical_store.dart:698-761)
  ↓
resolveBusinessAccountSummary — BAŞKASI dalı
  isPremiumAccount = entitledModules.isNotEmpty || modules.isNotEmpty ||
                      (isSelf && hasActualProcessedMarketPremiumSubscription())
  → isSelf=false olduğu için üçüncü terim düşer. entitledModules/modules
    KAYNAĞI: BusinessVerticalStore.activeModulesFor/enabledModulesFor.
  ↓
BusinessVerticalStore (business_vertical_store.dart:5-18)
  _prefsKey = 'business_vertical_by_owner_v1' — SADECE BU CİHAZIN LOKAL
  SharedPreferences'ı. Başka bir kullanıcının modül seçimi bu cihazda hiç
  var olmamıştır (o kullanıcı bu cihazda hiç oturum açmadıysa) — bu yüzden
  BAŞKASI için activeModulesFor HER ZAMAN boş küme döner.
  ↓
badge/card/frame UI (hesabim_page.dart satır 1805: `_remotePremiumProfileHint
  ?? widget.premiumHint`)
```

### Sorulan sorulara doğrudan cevap

- **Kendi profilimde premium hangi kaynaktan bulunuyor?** `PurchaseStore.I.activePremium` (self-only, oturum açmış kullanıcının kendi satın-alma geçmişi fetch'i) — `hasActualProcessedMarketPremiumSubscription()` üzerinden.
- **Başkasının profilinde premium hangi kaynaktan bulunuyor?** İki bağımsız, ikisi de kırık kaynak: (1) `public.accountType == 'premium'` (hiç yazılmayan bir string), (2) `resolveBusinessAccountSummary(...).isBusinessPremium` → `BusinessVerticalStore`'un bu cihaza özel, lokal `SharedPreferences` önbelleği.
- **Bu iki yol aynı mı?** **HAYIR.** Kendi profil = gerçek, canlı, sunucudan senkronize `PurchaseStore` verisi. Başkasının profili = ya hiç yazılmayan bir string karşılaştırması, ya da bu cihazda o kullanıcı için hiç var olmamış lokal bir önbellek. Yapısal olarak birbirinden tamamen kopuk.
- **Public profile response premium bilgisini içeriyor mu?** **Hayır**, kesinlikle içermiyor — kanıt yukarıda, `SELECT_FIELDS`'te yok, servisin kendi yorumu bunu kasıtlı olarak açıklıyor.
- **İçeriyorsa hangi alan?** N/A.
- **İçermiyorsa neden?** `public-profile.ts`'in kendi belgelenmiş kararı: `activePremium`/`activePremiumSubscription` "must stay private" — premium hesaplaması bu özel alanlarla iç içe olduğu için ihtiyatlı davranılıp TÜMÜYLE dışarıda bırakılmış. (Bu karar muhtemelen daha önceki bir "PUB-PROFILE-B" fazında, private finansal veriyi sızdırmama amacıyla alınmış — ama premium *rozeti* [boolean, "verified" rozeti gibi public olması beklenen bir sinyal] ile premium *abonelik detayları* [fiyat, bitiş tarihi, plan] arasındaki farkı ayırmamış; ikisi birden "premium field" diye tek kalemde dışlanmış.)
- **Backend public allowlist premium bilgisini dışarı çıkarıyor mu?** Hayır (yukarıdaki gibi).
- **Flutter PublicProfile modeli bunu parse ediyor mu?** Hayır — modelde böyle bir alan yok, backend hiç göndermediği için parse edilecek bir şey de yok.
- **Profile cache premium bilgisini koruyor mu?** `PublicProfileRepository`'de cache yok (her fetch taze). `BusinessVerticalStore`'un kendi lokal cache'i "koruma" değil, doğrudan "hiç sahip olmama" durumunda — bkz. P2.6.
- **Başkasının profilinde self-only PurchaseStore'a yanlışlıkla mı bakılıyor?** Hayır, tam tersi — `isSelf` kontrolüyle DOĞRU şekilde PurchaseStore'a bakılMIYOR başkası için. Sorun yanlış kaynağa bakmak değil, doğru kaynağın (backend'in kendisi) hiç veri sağlamaması.
- **ownerId/email/documentId eşleşmesi yüzünden premium kayboluyor mu?** Hayır, kimlik eşleştirme mantığı (`_isCurrentSessionOwnerIdentity`, `resolveBusinessAccountSummary`'nin kendi isSelf hesabı) tutarlı ve doğru çalışıyor. Kayıp, eşleşme hatasından değil, veri kaynağının yapısal olarak var olmamasından.

---

## P2.2 — Premium semantiği: self-view vs visitor-view

Backend'in kanonik kuralı (`isPremiumActiveFromProfile`, `premium-sync.ts`): `endsAt` yok → aktif; gelecekte → aktif; geçmişte → pasif.

- **Self-view:** `PurchaseStore.parsePremiumSubscription` bu kuralı doğru uyguluyor — bu proje boyunca zaten test edilmiş ve doğrulanmış (`purchase_store_test.dart`: "missing endsAt → active (matches premium-sync.ts isPremiumActiveFromProfile)"). **Doğru.**
- **Visitor-view:** Bu kuralın uygulanacağı hiçbir veri YOK — çünkü `activePremium`/`activePremiumSubscription`'ın kendisi visitor'a hiç ulaşmıyor. Yani "aynı premium durumu self-view ve visitor-view'da farklı yorumlanıyor" değil — **visitor-view'da premium durumu YORUMLANACAK bir veri bile almıyor.** Semantik uyuşmazlık değil, veri yokluğu.
- `premiumEndsAt`/`planTitle` gibi alanlar: `PublicProfile` modelinde ve `public-profile.ts`'in `SELECT_FIELDS`'inde hiç yok — aranan hiçbir yerde bulunamadı.
- `isPremium`/`isPremiumOwner`: bu iki alan `listing`/`ad` content-type'larında VAR ve `premium-sync.ts` tarafından doğru şekilde senkronize ediliyor (S1 fazında doğrulandı) — ama **`profile-setting`'e hiç yazılmıyor.** `premium-sync.ts`'in kendi kodu (satır 1-2, 48-49) yalnızca `LISTING_UID`/`AD_UID` için çalışıyor; `profile-setting` hedefi hiç yok. Bu, aşağıdaki "minimum güvenli çözüm" önerisinin temelini oluşturuyor.

---

## P2.3 — Public profile contract tablosu

| Alan | Backend dönüyor mu | Flutter parse ediyor mu | UI kullanıyor mu |
|---|---|---|---|
| ownerId | ✅ (`profileId`→`ownerId`) | ✅ | ✅ (navigasyon/hedef kimliği) |
| displayName | ✅ | ✅ | ✅ |
| avatar (avatarUrl) | ✅ | ✅ | ✅ |
| bio / aboutText | ✅ | ✅ | ✅ |
| city | ✅ | ✅ | ✅ |
| district | ❌ (schema'da var ama `SELECT_FIELDS`'te yok) | ❌ | ❌ |
| verification | ❌ (profile-setting şemasında böyle bir alan bulunamadı) | ❌ | ❌ |
| account type | ✅ (ham string) | ✅ | ⚠️ **kullanılıyor ama kırık** — `'premium'` değerine karşı hiç yazılmayan bir string karşılaştırıyor |
| rating (average/count) | ✅ (hesaplanmış, oy haritası değil) | ✅ | ✅ |
| premium status | ❌ | ❌ (alan yok) | ⚠️ dolaylı, kırık (accountType üzerinden) |
| premium plan | ❌ | ❌ | ❌ |
| premium expiry | ❌ | ❌ | ❌ |
| showcasePinnedIds/Order | ✅ | ✅ | ✅ |

**Private alanlar açık kalıyor mu?** Kontrol edildi: `phone`, `whatsapp`, `birthDate`, `email`, `activePremium`, `activePremiumSubscription`, `businessModules`, `disabledBusinessModules`, `ratingVotesByViewer` (ham oy haritası, sadece hesaplanmış average/count dönüyor) — hiçbiri `SELECT_FIELDS`'te değil. **Bu fazda hiçbir private alan geri açılmayacak** (mandatın kendi kısıtı zaten buydu).

**Minimum gerçekten gerekli veri:** Sadece **bir boolean** — `isPremium` (veya `isPremiumOwner`, listing/ad ile aynı isimlendirme). Ne plan adı, ne bitiş tarihi, ne fiyat — rozet/kart/çerçeve UI'ı zaten hiçbirini göstermiyor (kod incelemesinde doğrulandı: `HesabimPage`'in premium dalı yalnızca `bool` bir hint tüketiyor). `isPremiumActiveFromProfile(row)` fonksiyonu bu boolean'ı ZATEN hesaplıyor (S1'den beri var, `listing.ts`/`ai.ts`/`require-logistics-premium.ts`/`promo.ts` dörtte kullanılıyor) — `public-profile.ts`'in sadece bu fonksiyonu kendi `row`'u üzerinde çağırıp sonucu response'a eklemesi yeterli, `activePremium`/`activePremiumSubscription`'ın kendisini SELECT etmesi bile gerekmiyor (zaten resolver `strapi.db.query` çağırıyor, `isPremiumActiveFromProfile` için gereken ham JSON alanını `SELECT_FIELDS`'e eklemek yeterli olur, ama response'a ASLA o ham alanın kendisini koymadan, sadece hesaplanmış boolean'ı koyarak).

---

## P2.4 — Kendi profilim (regression riski)

- Premium rozet: `hasActualProcessedMarketPremiumSubscription()` → `PurchaseStore.I.activePremium` — bu fazda hiç dokunulmadı, hiçbir değişiklik önerilmiyor.
- `PublicProfileRepository` self-profile kaynağını EZMİYOR — `_loadProfileFromStrapi`'nin kendi `if (_isOwnerView) { _loadOwnProfileFromStrapi } else { _loadPublicProfileFromStrapi }` dallanması (satır 152-156) bunu yapısal olarak imkansız kılıyor; owner-view asla `PublicProfileRepository`'ye dokunmuyor.
- Profil fotoğrafı, profil düzenleme, premium yetkiler: bu audit'te kod seviyesinde bir kırılma bulunamadı (ayrı, kendi private profile-setting fetch'i üzerinden çalışıyorlar, public-profile zincirinin dışında).

**Sonuç: kendi profilim tarafında regresyon riski taşıyan bir bulgu yok**, ve önerilen minimum-fix (sadece backend'e bir alan eklemek + visitor-view okuma dalını düzeltmek) self-view kod yoluna hiç dokunmuyor.

---

## P2.5 — Başkasının profili: üç giriş noktası

Kod tabanında bulunan gerçek giriş noktaları (`buildProfilePageForUser`/`openProfileByOwnerIdFromContext` çağıranlar, grep ile tam liste):

- **İlan → satıcı profiline git:** `listing_detail_page.dart:206`, `search_listings_page.dart:329` — ✅ var, aynı pipeline.
- **Mesajlaşma → partner profiline git:** `messages_page.dart:84`, `message_chat_page.dart:216`, `offer_chat_page.dart:154` — ✅ var, aynı pipeline.
- **Farmer Question / yorum → kullanıcı avatarına tıkla:** grep ile arandı, **böyle bir navigasyon şu an kodda YOK.** `farmer_question_card.dart` ve `farmer_questions/pages/*.dart` içinde profile-page'e giden hiçbir `Navigator`/`buildProfilePageForUser`/`openProfileByOwnerIdFromContext` çağrısı bulunamadı. Bu, mandatın varsaydığı bir giriş noktası ama şu anki kodda **mevcut değil** — var olmayan bir şeyin "bug'lı" olup olmadığı sorulamaz; sadece "bu özellik henüz implement edilmemiş" diye not ediyorum.

**Tüm gerçek giriş noktaları aynı pipeline'ı (`buildProfilePageForUser` → `premiumProfileHintForOwner`/`shouldShowPremiumProfileForOwner`) kullanıyor — bug tamamen tutarlı şekilde HER YERDE aynı, hiçbir giriş noktası "şansla" doğru çalışmıyor.**

Ek bulgu: `messages_store.dart:1914`'te de AYNI `premiumProfileHintForOwner` fonksiyonu, sohbet listesindeki görünen ismin yanına marka adını eklemek için kullanılıyor (satır 1918-1922) — bu da aynı kök nedenden dolayı hiç tetiklenmiyor. Ayrı bir bug değil, aynı kök nedenin ikinci bir belirtisi.

---

## P2.6 — Avatar / Cache

- `profile_avatar.dart`: premium/accountType'a hiç referans yok — saf avatar-görsel widget'ı, bu konuda risk taşımıyor.
- `messages_store.dart`: yukarıda P2.5'te not edildi — aynı kök neden.
- `PublicProfileRepository`: cache YOK (her `.fetch()` taze network isteği), dolayısıyla "eski cached normal hesap verisi yeni premium bilgisini eziyor" senaryosu bu dosyada mümkün değil.
- `BusinessVerticalStore`'un cache anahtarı: `_ownerKeys(ownerId, ownerEmail)` → `'id:$ownerId'` ve `'email:$email'` biçiminde, tutarlı ve tek. Anahtarlama bozuk değil — sorun anahtarın kendisi değil, o anahtar altında BAŞKA bir kullanıcı için hiç veri bulunmaması.
- **Ezme riski bulunamadı.** Asıl sorun "eski veri yeniyi eziyor" değil, "yeni veri (başkasının premium durumu) bu cihaza hiç ulaşmıyor."

---

## P2.7 — Diğer profil bulguları (bu audit sırasında görülen, ayrı konular)

Kod değiştirilmedi, sadece rapor ediliyor:

- **`accountType` senkronizasyonunun kendisi de premium'dan bağımsız çalışıyor** (`business_vertical_store.dart:302`): `accountType` yalnızca CİHAZDAKİ lokal `BusinessVerticalStore` modül seçimi boşsa `'standard'`, doluysa `'business'` yazıyor — `PurchaseStore.activePremium`'a hiç bakmıyor. Yani hiçbir business modülü açmamış ama gerçekten Premium olan bir kullanıcının `accountType`'ı backend'de zaten `'standard'` olarak duruyor olabilir; `'business'` dalı bile bu kullanıcıyı yakalamaz. Bu, önerilen "yeni `isPremium` boolean'ı ekle" çözümünün NEDEN `accountType` string'ini onarmaya çalışmak yerine ayrı, doğrudan bir alan olması gerektiğini doğruluyor — `accountType` premium'un DOĞRU bir proxy'si değil, hiç olmamış.
- Yanlış kullanıcı bilgisi, avatar karışması, public/private veri karışması, rating yanlışlığı, yanlış kullanıcıya ait ilanlar, profil düzenlemede başka kullanıcı verisi, profile-view duplicate: bu audit'in kapsamında (public-profile zinciri, premium akışı, cache) **böyle bir bulgu görülmedi.** Bunlar ayrı, kendi konularının derinlemesine incelemesini gerektirir (bu Sprint'in odağı değildi) — release blocker olarak işaretlenmiyor, çünkü kanıt yok.

---

## Bug tablosu

| BUG-ID | Severity | Live caller | Root cause | Backend file/function/line | Flutter file/function/line | User impact | Release blocker? | Minimum safe fix |
|---|---|---|---|---|---|---|---|---|
| BUG-002 | 🔴 Kritik | Evet — ilan→satıcı, mesaj→partner, HesabimPage'in kendi "başkasının favorisi" navigasyonu, `messages_store.dart`'ın sohbet-listesi adı | (1) Backend `activePremium`/`activePremiumSubscription`'ı public projeksiyondan kasıtlı dışlıyor, boolean bir premium sinyali de yok. (2) Flutter visitor-view'da `accountType == 'premium'` diye hiç yazılmayan bir string'e bakıyor. (3) `resolveBusinessAccountSummary`'nin başkası-dalı, cihaza-özel lokal `BusinessVerticalStore` önbelleğine düşüyor — bu önbellek başka bir kullanıcı için yapısal olarak hiçbir zaman dolu olamaz. | `src/api/public-profile/services/public-profile.ts:20-33 (SELECT_FIELDS), 158-172 (resolvePublicProfile dönüşü)` | `lib/features/profile/pages/hesabim_page.dart:217-218` (`_loadPublicProfileFromStrapi`), `lib/main.dart:6143-6176` (`shouldShowPremiumProfileForOwner`, `premiumProfileHintForOwner`), `lib/features/profile/stores/business_vertical_store.dart:698-761` (`resolveBusinessAccountSummary`) | Premium bir kullanıcı başka biri tarafından görüntülendiğinde rozet/marka-adı hiç görünmüyor — premium'un tüm sosyal-kanıt/güven değeri kayboluyor, kullanıcılar "ödediğim şey görünmüyor" diye şikayet edebilir. | **EVET** | Backend: `public-profile.ts`'in `SELECT_FIELDS`'ine `activePremium`/`activePremiumSubscription`'ı ekle (yalnızca dahili hesaplama için — response'a HİÇ raw olarak koyma), `resolvePublicProfile`'ın dönüşüne `isPremiumActiveFromProfile(row)`'un sonucunu tek bir `isPremium: boolean` alanı olarak ekle. Flutter: `PublicProfile`'a `isPremium` alanı ekle, `_loadPublicProfileFromStrapi`'deki kırık `accountType=='premium'` karşılaştırmasını `public.isPremium`'a çevir. `resolveBusinessAccountSummary`'ye dokunmaya gerek yok (o zaten "business module" sorusuna doğru cevap veriyor, farklı bir soru). |
| — (P2.7'de not edildi, ayrı ticket) | 🟡 Orta (tech debt) | Evet ama BUG-002'nin bir parçası olarak zaten görünmez | `accountType` senkronizasyonu premium'dan bağımsız, sadece lokal business-module seçimine bakıyor | `business_vertical_store.dart:_syncOwnerToStrapi:282-313` | aynı | Business modülü açmamış saf-premium kullanıcılar `accountType='standard'` olarak senkronize olur — BUG-002'nin `isPremium` fix'i bunu otomatik olarak çözer (accountType'a hiç bağımlı olmayan ayrı bir alan olduğu için), ayrıca dokunmaya gerek yok | Hayır (BUG-002 fix'i ile kendiliğinden kapanıyor) | Yok — BUG-002 fix'inin bir yan faydası |

---

## Son karar

## **SPRINT 2: READY FOR FIX**

BUG-002'nin kök nedeni kanıtla kesinleşti — tahmin değil, üç ayrı dosyada, satır satır izlenmiş bir zincir. Fix kapsamı net ve dar: backend'de tek bir yeni computed boolean alan (`isPremium`, mevcut `isPremiumActiveFromProfile` fonksiyonunu yeniden kullanarak — yeni iş kuralı icat etmiyor), Flutter'da bir model alanı + bir kırık string-karşılaştırmasının değiştirilmesi. Self-view'a, `ChangePasswordPage`'e, listing/ad'lerin zaten çalışan `isPremium`/`isPremiumOwner` mekanizmasına dokunulmuyor. Diğer P2.7 bulgusu ayrı bir aksiyon gerektirmiyor — aynı fix'le kendiliğinden kapanıyor. P2.5'te not edilen "Farmer Question avatar tıklama" giriş noktası kodda hiç yok — bu Sprint'in fix kapsamına girmiyor (var olmayan bir şey düzeltilemez).
