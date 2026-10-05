# Release Bug Fix Sprint — Sprint 1 / BUG-001 Fix Report

**Date:** 2026-08-11
**Repo:** `tarim360` (Flutter only — backend untouched, per mandate)
**Reference:** `AUTH_RELEASE_AUDIT.md`
**Branch:** `fix/release-auth-forgot-password` (pushed, not merged to main)

---

## Eski akış

```
ForgotPasswordPage
  → e-posta gir, "Şifre Yenileme Maili Gönder"
  → istek başarılı dönünce KOŞULSUZ olarak açılan form:
      - "E-posta kodu" alanı
      - "Yeni Şifre" alanı
      - "Yeni Şifre (Tekrar)" alanı
      - "Şifreyi Yenile" butonu
  → "Şifreyi Yenile" → AuthService.resetPassword → POST /auth/reset-password
  → backend BU ENDPOINT'İ HER ZAMAN ok:false ile reddediyordu (kod ne olursa
    olsun) — deterministik, %100 başarısız çıkmaz sokak.
```

## Yeni akış

```
ForgotPasswordPage
  → e-posta gir, "Geçici Şifre Gönder"
  → POST /auth/request-password-reset (AuthService.requestPasswordResetCode,
    tek ve değişmeyen backend çağrısı — DOKUNULMADI)
  → başarılı dönünce: kod/yeni-şifre formu YOK. Bunun yerine:
      "Geçici şifreniz {maskedEmail} adresine gönderildi.
       Bu şifreyle giriş yapın, ardından Ayarlar > Şifre Değiştir
       bölümünden yeni şifrenizi oluşturun."
      + "Giriş Ekranına Dön" (Navigator.pop)
      + "Tamam" (formu sıfırlar, başka bir e-posta ile tekrar denenebilir)
  → başarısızlık: gerçek backend mesajı SnackBar'da gösterilir, sahte
    başarı YOK.
  → null sonuç (hesap yok — enumeration guard): jenerik "hesap varsa
    gönderilecektir" mesajı, başarı paneli AÇILMAZ.
```

## Kaldırılan OTP UI ve ölü kod

- `_ForgotPasswordPageState`'ten: `_codeCtrl`, `_newPassCtrl`, `_newPass2Ctrl`, `_resetPassword()` — hepsi silindi.
- `AuthService.resetPassword` (main.dart) — silindi. Grep ile doğrulandı: bu committen önce tek çağıran yeri `_resetPassword()` idi, başka hiçbir yerden çağrılmıyordu.
- `StrapiService.authResetPassword` (strapi_service.dart) — silindi. Tek çağıran yeri `AuthService.resetPassword` idi.
- `StrapiConfig.authResetPasswordEndpoint` getter'ı — silindi. Tek kullanıcısı `authResetPassword` idi.
- **Dokunulmayanlar (mandat gereği):** `SignupVerificationPage` ve ilgili kayıt-doğrulama kodu (ayrı, erişilemez bir konu, bu commit'in kapsamı dışında — `AUTH_RELEASE_AUDIT.md`'nin BUG-002'sinde ayrıca not edildi). `AuthService.requestPasswordResetCode`, `StrapiService.authRequestPasswordResetCode`, `authRequestPasswordResetEndpoint`, `authForgotPasswordEndpoint` — bunlar gerçek, çalışan çağrının parçası, dokunulmadı. `ChangePasswordPage`, `AuthService.changePassword`, `StrapiService.authChangePassword`, `/api/auth/change-password` — tamamen dokunulmadı, bu akışın gerçek çözümü zaten buydu.

## Kullanılan backend endpoint

Sadece **`POST /auth/request-password-reset`** (`auth-flow.ts:630-672`, backend'e hiç dokunulmadı). `POST /auth/reset-password`'a artık bu ekrandan hiçbir çağrı yapılmıyor.

## Test sonuçları

| Test | Sonuç |
|---|---|
| `test/features/auth/forgot_password_page_test.dart` (yeni, 7 test) | **PASS — 7/7** |
| `flutter analyze` (tüm proje) | PASS — sadece 2 önceden var olan, ilgisiz uyarı (`logistics_models.dart`) |
| `flutter test` (tüm proje) | **PASS — 217/217** (210 önceki + 7 yeni) |
| `git diff --check` | PASS — temiz |

Yeni testlerin kapsadığı senaryolar (mandatın istediği listeyle bire bir):
- Ekran açılır → yalnız email alanı + "Geçici Şifre Gönder" butonu; kod alanı yok, yeni şifre alanı yok, "Şifreyi Yenile" yok. ✅
- Başarılı istek → geçici şifre açıklaması görünür, kod/yeni-şifre alanları hâlâ yok. ✅
- `request-password-reset` çağrısı = 1 (enjekte edilen sahte fonksiyonla sayıldı). ✅
- `reset-password` çağrısı = 0: kod tabanında bu yolu tetikleyecek hiçbir widget/metod kalmadığı için (yapısal olarak imkansız hale getirildi) — bir "sayaç" testi değil, bir "hiç var olmama" testi olarak doğrulandı. ✅
- Hızlı çift tık → tek request (buton `busy` iken `onPressed:null` + `_requestTemporaryPassword`'ün kendi `if(_busy) return;` koruması, 200ms gecikmeli sahte çağrıyla test edildi). ✅
- Backend hatası → gerçek hata mesajı gösterilir, sahte başarı yok. ✅
- Null sonuç (hesap yok) → jenerik mesaj, başarı paneli açılmaz. ✅ (mandatta açıkça istenmemişti ama enumeration-guard davranışını doğru test etmek için eklendi)
- Başarı → "Giriş Ekranına Dön" gerçekten `Navigator.pop()` yapıyor (iki route'lu gerçek bir navigasyon senaryosuyla test edildi). ✅
- "Tamam" → formu sıfırlayıp tekrar denemeye izin veriyor (mandatta yoktu, ekstra bir davranış olduğu için ayrıca test edildi). ✅

## Regression

- Login, Register, Logout: bu committe hiç dokunulmadı (dosya diff'inde bu fonksiyonlara ait tek satır değişiklik yok).
- `ChangePasswordPage` / `/api/auth/change-password`: hiç dokunulmadı.
- Tüm proje `flutter test` (217/217) ve `flutter analyze` temiz — başka hiçbir ekranda regresyon yok.

## Commit ve push

- Commit: `86e82be` — `fix(auth): align forgot password UI with temporary password flow`
- Branch: `fix/release-auth-forgot-password` (yeni, `main`'in mevcut HEAD'inden — `9e4a563` — dallandı)
- Push: `origin/fix/release-auth-forgot-password` ✅ (main'e doğrudan push YAPILMADI, local `main` hâlâ `9e4a563`'te, temiz)
- PR linki (açılmadı): `https://github.com/sytcstr/tarim360arti1/pull/new/fix/release-auth-forgot-password`

## Sprint 1 sonucu

## **PASS**

BUG-001 kapatıldı, kod+test+regresyon doğrulaması tamam. Backend'e hiç dokunulmadı (mandat gereği). BUG-002 (kayıt doğrulama kodu ekranı) hâlâ açık ama zararsız/erişilemez olarak işaretli, bu sprint'in scope'unda değildi.

Sprint 1 burada duruyor. Sprint 2'ye (Profil sistemi, başkasının profilinde premium görünmeme) geçiş onayını bekliyorum.
