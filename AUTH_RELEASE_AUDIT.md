# Release Bug Fix Sprint — Sprint 1: Auth System Audit (READ-ONLY)

**Date:** 2026-08-11
**Repos:** `C:\projeler\tarim360` (Flutter), `C:\projeler\tarim360-strapi` (backend)
**Mode:** Read-only code analysis. No code changed, no commit, no push.

---

## İlk iş — "Şifremi Unuttum" akışı, uçtan uca, kanıtlı

### Akışın tamamı (dosya/satır ile)

```
Flutter UI (ForgotPasswordPage, main.dart:~7415-7660)
  │
  │ 1) Kullanıcı e-posta girer, "Şifre Yenileme Maili Gönder"e basar
  ▼
AuthService.requestPasswordResetCode (main.dart:5788-5814)
  ▼
StrapiService.authRequestPasswordResetCode (strapi_service.dart:5129-5160)
  │  POST /auth/request-password-reset  { identifier: email }
  ▼
Backend: auth-flow.ts:630-672  requestPasswordReset(ctx)
  │  - kullanıcıyı email ile bulur
  │  - generateTemporaryPassword() ÇAĞIRIR → 'T360-XXXXXX-Aa!' formatında YENİ ŞİFREYİ
  │    ANINDA veritabanına yazar (entityService.update, password: tempPassword)
  │  - sendTemporaryPasswordEmail(...) → mail gönderir
  ▼
Mail içeriği (auth-flow.ts:85-106, sendTemporaryPasswordEmail)
  │  Konu: "Tarim360 Gecici Sifre"
  │  Gövde: "Gecici sifreniz: {tempPassword}" — KOD DEĞİL, doğrudan
  │  kullanılabilir bir GEÇİCİ ŞİFRE. Herhangi bir "code"/token YOK.
  ▼
Flutter UI (aynı sayfa, istek başarılı dönünce hemen açılan bölüm, main.dart:7601-7660)
  │  Kullanıcıya HEM "E-posta kodu" alanı, HEM "Yeni Şifre" + "Yeni Şifre (Tekrar)"
  │  alanları gösterilir — "Şifreyi Yenile" butonu basılabilir durumda.
  │  Üstteki açıklama metni (main.dart:7612) bile bu çelişkiyi itiraf ediyor:
  │  "Mailde kod varsa aşağıdan yeni şifreni belirle; geçici şifre geldiyse
  │  onunla giriş yapıp Ayarlar > Şifre Değiştir adımını kullan."
  ▼
Kullanıcı "kod" alanına mecburen bir şey yazıp "Şifreyi Yenile"ye basarsa:
  ▼
AuthService.resetPassword (main.dart:5816-5846)
  ▼
StrapiService.authResetPassword (strapi_service.dart:5162-5203)
  │  POST /auth/reset-password  { identifier, code, newPassword }
  ▼
Backend: auth-flow.ts:674-682  resetPassword(ctx)
  │  BU ENDPOINT KOŞULSUZ OLARAK ŞUNU DÖNER (kod ne olursa olsun, doğru/yanlış
  │  fark etmez — hiçbir doğrulama YAPILMAZ, çünkü hiçbir doğrulama KODU
  │  gönderilmemiştir zaten):
  │
  │  { ok: false, message: 'Bu akista sifre e-posta ile gecici sifre olarak
  │    gonderilir. Lutfen "sifremi unuttum" adimini tekrar kullanin.' }
  ▼
SONUÇ: "Şifreyi Yenile" butonu HER ZAMAN, %100 ihtimalle başarısız olur.
Bu olasılıksal bir bug değil — deterministik bir çıkmaz sokak.
```

### Sorulan sorulara doğrudan cevap

**"Mail neden geçici şifre gönderiyor?"**
Çünkü backend, `requestPasswordReset` handler'ında (`auth-flow.ts:630-672`) kasıtlı olarak `generateTemporaryPassword()` çağırıyor ve üretilen değeri **kullanıcının gerçek şifresi olarak veritabanına anında yazıyor**, ardından bu değeri mailin gövdesine "Geçici şifreniz: X" diye açıkça yazıyor. Bu bir hata değil — backend'in kasıtlı, çalışan tasarımı bu.

**"Flutter neden kod bekliyor?"**
Çünkü Flutter'ın `ForgotPasswordPage`'i (`main.dart:7415-7660`) ve `AuthService.resetPassword` (`main.dart:5816-5846`) hâlâ ESKİ bir tasarıma (OTP-kod tabanlı, Model A) göre yazılmış ve backend'in artık gerçekte ne yaptığına göre hiç güncellenmemiş. UI, isteği attıktan sonra koşulsuz olarak "kod + yeni şifre" formunu gösteriyor — backend'in cevabında hiçbir kod/token bilgisi olmamasına rağmen.

**"Backend hangi modeli uyguluyor? A) OTP Code veya B) Temporary Password?"**
**Sadece Model B (Temporary Password).** Model A tamamen ve kasıtlı olarak devre dışı: `resetPassword` handler'ının kendi kod yorumu şunu söylüyor — *"This endpoint is kept for backward compatibility. Current flow: request-password-reset sends a temporary password by email."* (`auth-flow.ts:675-676`). Yani backend'de "iki sistem aynı anda" çalışmıyor; backend net bir şekilde Model B'ye geçmiş. Çelişki backend'de değil, **Flutter'ın bunu hiç haber almamış olmasında.**

**"İkisi aynı anda varsa neden?"**
İkisi aynı anda YOK — backend'de sadece Model B canlı, Model A'nın endpoint'i kasıtlı olarak "her zaman başarısız ol" şeklinde stub'lanmış. Ama **kullanıcı deneyimi seviyesinde** ikisi aynı anda varmış GİBİ görünüyor, çünkü Flutter, backend Model B'ye geçtikten sonra hâlâ Model A'nın UI'ını (kod girme formu) göstermeye devam ediyor.

### Kök neden (özet)

Backend bir noktada Model A'dan (OTP kod) Model B'ye (geçici şifre maili) geçiş yapmış ve eski endpoint'i "geriye dönük uyumluluk" için bilinçli olarak `ok:false` döner hale getirmiş — ama bu geçiş Flutter tarafına hiç yansıtılmamış. Flutter hâlâ Model A'nın tam formunu (kod alanı + yeni şifre alanları + "Şifreyi Yenile" butonu) gösteriyor ve bu form built-in olarak asla başarılı olamaz.

Gerçekte ÇALIŞAN tek çıkış yolu: kullanıcı maildeki geçici şifreyle **normal login ekranından giriş yapıp**, sonra **Ayarlar > Şifre Değiştir** (`ChangePasswordPage`, `main.dart:7669+`) sayfasını kullanmak — bu sayfa Strapi'nin stok, yerleşik `/api/auth/change-password` endpoint'ini kullanıyor (`strapi_service.dart:5214-5233`) ve backend'de bu isim altında özel/bozuk bir kod yok, standart Strapi plugin davranışı. Ama Flutter'ın "Şifremi Unuttum" ekranı bu tek gerçek yolu net ve tek bir talimat olarak vermek yerine, kullanıcıyı "kod mu geldi, şifre mi geldi, sen anla" durumunda bırakıyor — ve önce her zaman başarısız olacak formu deniyor.

---

## BUG-001 — Şifremi Unuttum: Model A UI, Model B backend'e karşı

| Alan | Değer |
|---|---|
| **BUG-ID** | BUG-001 |
| **Severity** | 🔴 CRITICAL |
| **Root Cause** | Backend `/auth/reset-password` kasıtlı olarak devre dışı bırakılmış (her zaman `ok:false`), ama Flutter UI hâlâ bu endpoint'i çağıran "kod + yeni şifre" formunu koşulsuz gösteriyor |
| **Dosya (Backend)** | `src/api/auth-flow/controllers/auth-flow.ts` |
| **Fonksiyon (Backend)** | `requestPasswordReset` (satır 630-672), `resetPassword` (satır 674-682) |
| **Dosya (Flutter)** | `lib/main.dart`, `lib/services/strapi_service.dart` |
| **Fonksiyon (Flutter)** | `_ForgotPasswordPageState.build`/`_resetPassword` (main.dart:7484-7660), `AuthService.resetPassword` (main.dart:5816-5846), `StrapiService.authResetPassword` (strapi_service.dart:5162-5203) |
| **Çözüm** | Backend'i değiştirmeye gerek yok — zaten çalışıyor. Flutter'ın `ForgotPasswordPage`'inden kod+yeni-şifre formunu tamamen kaldır; e-posta gönderildikten sonra tek, net bir talimat göster: *"Geçici şifreniz e-postanıza gönderildi. O şifreyle giriş yapıp Ayarlar > Şifre Değiştir'den yeni şifrenizi belirleyin."* `AuthService.resetPassword`/`StrapiService.authResetPassword` ve ilgili stok-Strapi fallback kodu (strapi_service.dart:5147-5157, 5186-5201 — zaten hiç tetiklenmiyor, çünkü custom endpoint'ler var ve 400/404/405 dönmüyorlar) artık ölü kod; kaldırılabilir. |
| **Release Blocker mı?** | **EVET.** Bu akış şu an %100 kullanıcıyı çıkmaz sokağa sokuyor — gerçek bir "önceki sürümde çalışıyordu, şimdi bozuldu" değil, backend'in Model B'ye geçişinden beri muhtemelen HİÇ çalışmamış bir form. |

---

## BUG-002 — Kayıt e-posta doğrulama kodu ekranı: erişilemez ölü kod (bug değil, ama not edilmeye değer)

| Alan | Değer |
|---|---|
| **BUG-ID** | BUG-002 |
| **Severity** | 🟢 LOW (canlı kullanıcı etkisi yok) |
| **Root Cause** | Backend `requestSignupVerification`/`verifySignup` kasıtlı olarak devre dışı ("Registration code flow is intentionally disabled" — kod ne olursa olsun her zaman `ok:true` döner). Flutter'ın `SignupVerificationPage`'i ise kod tabanında hiçbir yerden çağrılmıyor (`grep` ile doğrulandı: kendi constructor tanımı dışında sıfır referans) — yani şu anki kayıt akışı (`AuthService.register`, main.dart:5597-5705) bu sayfaya hiç uğramıyor. |
| **Dosya (Backend)** | `src/api/auth-flow/controllers/auth-flow.ts:580-608` |
| **Dosya (Flutter)** | `lib/main.dart:7212-7299+` (`SignupVerificationPage`, referanssız) |
| **Çözüm** | Zorunlu değil. Temizlik isteniyorsa `SignupVerificationPage` ve ilgili `AuthService.requestSignupVerification`/`verifySignupCodes` kaldırılabilir — ama şu an hiçbir kullanıcıya görünmediği için release'i etkilemiyor. |
| **Release Blocker mı?** | **HAYIR.** Backend ve Flutter bu konuda zaten hemfikir (ikisi de devre dışı); erişilemeyen bir sayfa gerçek bir kullanıcı etkisi üretmiyor. |

---

## İkinci aşama — Login / Register / Logout / Email Verification (kod incelemesi)

### Login
`AuthService.login` (main.dart:5513-5544) → `StrapiService.authLogin` → Strapi'nin stok `/api/auth/local` endpoint'i (`authLocalEndpoint`). Özel/riskli bir üst katman yok. Hatalı girişte `_looksLikeInvalidCredentials` + `_loginAccountExistenceMessage` ile "hesap silinmiş mi" kontrolü ekleniyor — makul, ekstra bir UX katmanı, bozucu bir yan etkisi görülmedi. **Kod incelemesinde blocker bulunamadı.** Gerçek cihazda doğrulama (UAT) hâlâ değerli, çünkü bu sadece statik analiz.

### Register
`AuthService.register` (main.dart:5597-5705) → `StrapiService.authRegister` → Strapi'nin stok `/api/auth/local/register` endpoint'i. Backend tarafında `registration-guard.ts` middleware'i (temiz, amaca uygun: email/telefon blocklist kontrolü, `findActiveRegistrationBlock`) ve Flutter tarafında `_signupRateLimitMessage`/`_recordSignupAttempt` (rate limit) katmanı var. Kayıt sonrası `authSendSignupWelcome` çağrısı `try/catch` ile sarılmış (mail başarısız olsa da kayıt tamamlanıyor — doğru davranış). **Kod incelemesinde blocker bulunamadı.**

### Logout
`AuthService.logout` (main.dart:5707+) — tamamen client-side: push-token unregister + local session temizliği. Backend round-trip'i yok, dolayısıyla backend kaynaklı bir başarısızlık riski yok. **Kod incelemesinde blocker bulunamadı.**

### Email Verification (kayıt doğrulama)
Yukarıda BUG-002'de detaylandırıldı — hem backend hem Flutter tarafında kasıtlı olarak devre dışı/erişilemez, tutarlı. **Blocker değil.**

### Change Password (Şifremi Unuttum'un gerçek çözümü)
`ChangePasswordPage`/`AuthService.changePassword` (main.dart:7669+, main.dart:5848+) → `StrapiService.authChangePassword` (strapi_service.dart:5214-5233) → Strapi'nin stok `/api/auth/change-password` endpoint'i (`currentPassword`/`password`/`passwordConfirmation` — plugin'in kendi beklediği şekil). Özel backend kodu yok (auth-flow.ts route listesinde bu path hiç tanımlı değil — stok plugin route'u kullanılıyor). **Kod seviyesinde sağlam görünüyor** — BUG-001'in asıl çözümü zaten bu sayfa, sadece "Şifremi Unuttum" ekranı kullanıcıyı buraya net şekilde yönlendirmiyor.

---

## Özet — BUG tablosu

| ID | Modül | Hata | Severity | Release Blocker | Durum |
|---|---|---|---|---|---|
| BUG-001 | Şifremi Unuttum | Backend Model B (geçici şifre) uyguluyor, Flutter UI hâlâ Model A (kod) formu gösteriyor — "Şifreyi Yenile" her zaman başarısız | 🔴 Kritik | **EVET** | Açık |
| BUG-002 | Kayıt e-posta doğrulama | Kod ekranı hem backend hem Flutter'da devre dışı/erişilemez — tutarlı, zararsız | 🟢 Düşük | Hayır | Açık (opsiyonel temizlik) |
| — | Login | Kod incelemesinde sorun yok (stok Strapi `/auth/local`) | — | — | Kod seviyesinde temiz |
| — | Register | Kod incelemesinde sorun yok (stok Strapi `/auth/local/register` + temiz guard/rate-limit katmanları) | — | — | Kod seviyesinde temiz |
| — | Logout | Kod incelemesinde sorun yok (tamamen client-side) | — | — | Kod seviyesinde temiz |
| — | Change Password | Kod incelemesinde sorun yok (stok Strapi `/auth/change-password`) — BUG-001'in fiili çözümü | — | — | Kod seviyesinde temiz |

---

## Not

Bu rapor tamamen statik kod incelemesine dayanıyor — hiçbir gerçek cihaz/hesap testi yapılmadı (mandat gereği: kod değiştirme, commit yok, push yok, sadece analiz). Login/Register/Logout/Change Password için "kod seviyesinde temiz" ifadesi, kodda BUG-001'e benzer bir çelişki bulunmadığı anlamına gelir — gerçek davranışın uçtan uca doğrulanması hâlâ UAT'ın (senin planladığın gerçek cihaz testi) işi. BUG-001 ise kod kanıtıyla %100 kesinleştirilmiş durumda; herhangi bir cihaz testine gerek kalmadan, sadece kodu okuyarak "her zaman başarısız olur" sonucuna varılabiliyor.
