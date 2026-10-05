# Release Bug Fix Sprint — Sprint 2 / BUG-002 Fix Report

**Date:** 2026-08-11 → 2026-08-12
**Repos:** `tarim360-strapi` (backend), `tarim360` (Flutter)
**Reference:** `PROFILE_RELEASE_AUDIT.md`
**Branch:** `fix/release-profile-premium-badge` (pushed in both repos, not merged to main)

---

## Eski kırık akış

```
Strapi profile-setting.activePremium/activePremiumSubscription (private)
  ↓
public-profile.ts — SELECT_FIELDS'te YOK, response'ta hiç premium sinyali yok
  ↓
Flutter hesabim_page.dart:217-218
  _remotePremiumProfileHint =
      public.accountType == 'premium' || public.accountType == 'business';
  → 'premium' hiç yazılmayan bir string (tek yazıcı: business_vertical_
    store.dart:302, sadece 'standard'/'business' üretiyor)
  → 'business' dalı da BusinessVerticalStore'un CİHAZA ÖZEL lokal
    SharedPreferences önbelleğine bağlı bir başka sinyalle (isBusinessPremium)
    besleniyordu (premiumProfileHintForOwner üzerinden) — başka bir
    kullanıcı için bu önbellek yapısal olarak hep boş
  ↓
SONUÇ: başka kullanıcının premium rozeti/kartı/çerçevesi hiçbir zaman
görünmüyordu — ne kod hiç yazılmadığı için, ne de lokal cihaz önbelleği
başka biri için asla dolu olamayacağı için.
```

## Yeni `isPremium` kontratı

```
Strapi profile-setting.activePremium/activePremiumSubscription (private, HİÇ değişmedi)
  ↓
public-profile.ts — resolvePublicProfile()
  SELECT_FIELDS'e activePremium/activePremiumSubscription eklendi
  (SADECE hesaplama girdisi olarak — response'a asla spread edilmiyor)
  ↓
  isPremium: isPremiumActiveFromProfile(row)
  (S1'den beri var olan, listing.ts/ai.ts/require-logistics-premium.ts/
  promo.ts'de zaten kullanılan AYNI kanonik kural — yeni iş kuralı yok)
  ↓
GET /api/public-profiles/:ownerId response.profile.isPremium: boolean
  ↓
Flutter PublicProfile.isPremium (bool, strict — map['isPremium'] == true)
  ↓
hesabim_page.dart: _remotePremiumProfileHint = public.isPremium;
  ↓
_hasPremiumProfilePresentation (değişmedi) → badge/card/frame UI
```

Ayrıca: `premiumProfileHintForOwner`'ın (main.dart) başkası-dalı artık
`resolveBusinessAccountSummary(...).isBusinessPremium`'a (lokal cihaz
önbelleği) DEĞİL, doğrudan `false`'a düşüyor — bu senkron fonksiyon zaten
sadece async fetch tamamlanana kadarki geçici bir "tahmin"; gerçek cevap
her zaman `public.isPremium`'dan geliyor. `resolveBusinessAccountSummary`
kendisi DOKUNULMADI — "aktif business modülü var mı" sorusuna hâlâ doğru
cevap veriyor, sadece artık "premium mi" sorusunun yanlış vekili olarak
kullanılmıyor.

---

## Privacy garantisi

- `activePremium`/`activePremiumSubscription` `SELECT_FIELDS`'e eklendi ama **hiçbir zaman** `PublicProfileFields`/response objesine spread edilmiyor — yalnızca `isPremiumActiveFromProfile(row)`'un girdisi.
- Yeni backend testi (`the raw activePremium/activePremiumSubscription payload never leaks...`) planTitle, price, transactionId, startsAt gibi gerçek değerleri seed edip **response body'sinin ham metninde bu değerlerin hiçbirinin, hatta `activePremium` alan adının kendisinin bile geçmediğini** doğruluyor — hem premium=true hem premium=false durumunda.
- Diğer tüm private alanlar (phone, whatsapp, birthDate, email, businessModules, disabledBusinessModules, ratingVotesByViewer) **dokunulmadı, hâlâ dışlanıyor** — mevcut `phone, email, and other private fields never leak` testi hiç değiştirilmeden geçmeye devam ediyor.

---

## Test sonuçları

### Backend

| Suite | Sonuç |
|---|---|
| `npx tsc --noEmit` | PASS — temiz |
| `npm test` (unit) | PASS — 31/31 |
| `npm run test:integration` | PASS — **172/172** (166 önceki + 6 yeni `isPremium` testi) |
| `npm run build` | PASS — exit 0 |
| `git diff --check` | PASS — temiz |
| Clean-checkout (izole `git worktree`, `3f80830`) | PASS — `tsc` ve `build` temiz |

Yeni backend testleri (`public-profile-read.integration.test.ts`):
- premium payload yok → `isPremium: false`
- `endsAt` yok (sınırsız grant) → `true`
- `endsAt` gelecekte → `true`
- `endsAt` geçmişte → `false`
- yabancı (stranger) çağıran için de aynı sonuç — misafir çağırandan farksız
- ham `activePremium`/`activePremiumSubscription` hiçbir zaman sızmıyor (planTitle/price/transactionId/startsAt dahil, alan adının kendisi dahil)
- "response exposes exactly the allowlisted fields" testi güncellendi: artık `isPremium` de beklenen alan setinde

### Flutter

| Suite | Sonuç |
|---|---|
| `flutter analyze` (tüm proje) | PASS — sadece 2 önceden var olan, ilgisiz uyarı |
| `flutter test` (tüm proje) | **PASS — 218/218** |
| `git diff --check` | PASS — temiz |
| Clean-checkout (izole `git worktree`, `6719d99`) | PASS — `flutter analyze` temiz |

Yeni Flutter testleri (`public_profile_test.dart`):
- `isPremium: true/false` doğru parse ediliyor
- alan yok → `false`
- bool olmayan bir değer (örn. `'true'` string'i) → `false` (truthy-coerce edilmiyor)
- `isPremium` `accountType`'tan tamamen bağımsız: `business`+`false` → `false` kalıyor, `standard`+`true` → `true` kalıyor
- `premiumProfileHintForOwner`: başka bir owner için, o owner'a ait lokal `BusinessVerticalStore` kaydı olsa BİLE `false` dönüyor (regresyonun doğrudan kanıtı) — ve hiç lokal kaydı olmayan (gerçek cross-device durum) bir owner için de `false`

**Test edilemeyen kısım, dürüstçe belirtilmesi gereken:** "visitor premium profile → badge görünür" / "badge görünmez" senaryolarının `HesabimPage`'in gerçek widget ağacında UÇTAN UCA (network fetch dahil) doğrulanması bu test suite'inin altyapısında yok — bu dosyanın kendi, önceden var olan yorum satırı bunu zaten açıkça belirtiyordu ("this test suite has no HTTP-mocking infrastructure to boot a fake server against"). Bunun yerine, zincirin doğruluğu iki ayrı, tam kapsamlı seviyede kanıtlandı: (1) backend'in ürettiği `isPremium` değeri doğru (integration testleri, gerçek Strapi'ye karşı), (2) Flutter'ın bu değeri doğru parse ettiği VE `hesabim_page.dart`'ın onu doğrudan `_remotePremiumProfileHint`'e atadığı (tek satırlık, doğrudan okunabilir kod + model testi). Aradaki tek adım (`PublicProfileRepository.fetch`'in JSON'ı `PublicProfile.fromMap`'e geçirmesi) zaten cache'siz, basit bir pass-through — ayrı test gerektirmeyecek kadar mekanik.

---

## Regression

- `accountType`/business görünümü: `resolveBusinessAccountSummary` ve `BusinessVerticalStore` kod olarak hiç değişmedi — sadece `premiumProfileHintForOwner`'ın onları "premium" için yanlış vekil olarak kullanması durduruldu.
- Rating, avatar, profile view engagement: bu commit'lerin hiçbirinde dokunulmadı.
- `ChangePasswordPage`/Login/Auth (Sprint 1'in BUG-001 fix'i): bu Sprint'te hiç dokunulmadı, ayrı branch/commit'te duruyor.
- Self-view premium davranışı: `hasActualProcessedMarketPremiumSubscription()`/`PurchaseStore.I.activePremium` yolu kod olarak değişmedi.

---

## Açıkça bırakılan, çözülmeyen bir uç (disclosure)

`messages_store.dart:1914`'teki sohbet-listesi görünen-isim fonksiyonu da `premiumProfileHintForOwner`'ı kullanıyor — bu fonksiyon artık başkası için her zaman `false` döndüğü için, sohbetteki premium partnerin marka-adı eki (`'$fullName • $brand'`) hâlâ hiç görünmeyecek. Bu YENİ bir regresyon DEĞİL — eskiden de aynı sonuç, sadece "yanlışlıkla her zaman boş lokal cache" yoluyla değil, artık "kasıtlı, dürüst false" yoluyla üretiliyor. Gerçek düzeltme, `messages_store.dart`'ın bu senkron fonksiyona değil, `PublicProfile.isPremium`'a (async) bağlanmasını gerektirir — bu, mesajlaşma sisteminin kendi async/cache mimarisine dokunan, ayrı ve daha büyük bir değişiklik olur; bu fix'in "minimum safe fix" kapsamının dışında bırakıldı, sıradaki Sprint 3 (Mesajlaşma) analizinde gündeme getirilmesi öneriliyor.

---

## Commit hash'leri

**Backend (`tarim360-strapi`, `fix/release-profile-premium-badge`, main'in `864b826` HEAD'inden dallandı):**
1. `5d4377a` — `fix(profile): expose safe premium status in public profile`
2. `3f80830` — `test(profile): add isPremium public-profile coverage`

**Flutter (`tarim360`, `fix/release-profile-premium-badge`, main'in `9e4a563` HEAD'inden dallandı):**
1. `782437f` — `fix(profile): use public premium status for viewed profiles`
2. `6719d99` — `test(profile): add isPremium and premiumProfileHintForOwner coverage`

Push: her iki repoda `origin/fix/release-profile-premium-badge` ✅. **main'e dokunulmadı, deploy yapılmadı.**

PR linkleri (açılmadı):
- Backend: `https://github.com/sytcstr/tarim360-strapi/pull/new/fix/release-profile-premium-badge`
- Flutter: `https://github.com/sytcstr/tarim360arti1/pull/new/fix/release-profile-premium-badge`

`src/api/offer/controllers/offer.ts` WIP: bu fazda da dokunulmadan, commit edilmeden duruyor (hâlâ `+12` uncommitted).

---

## Sprint 2 sonucu

## **PASS**

BUG-002 kapatıldı — kanıtlanmış kök nedenin her iki kırık noktası da (backend'in hiç sinyal göndermemesi, Flutter'ın yanlış/boş kaynaklara bakması) düzeltildi, ham abonelik verisi hiçbir zaman public olmadı, self-view ve ChangePassword/Login/Auth'a dokunulmadı, tüm doğrulamalar (tsc/unit/integration/build/analyze/test/diff-check/clean-checkout) her iki repoda temiz. Bir disclosure kaydedildi (messages_store.dart'ın marka-adı eki hâlâ görünmeyecek, pre-existing bir sınırlamanın devamı, yeni bir regresyon değil) — Sprint 3 analizine not düşüldü.

`PROFILE_RELEASE_AUDIT.md`'de P2.5'te tespit edilen "Farmer Question → avatar" giriş noktasının kodda hiç var olmaması ve P2.7'de not edilen `accountType` senkronizasyonunun premium'dan bağımsız çalışması — bu fix'le birlikte artık ikisi de ilgisiz: birincisi zaten mevcut değildi, ikincisi `isPremium`'un `accountType`'tan tamamen bağımsız olması sayesinde otomatik olarak kapandı (yeni testlerle doğrulandı).
