# SEC-1 — PROFILE SETTING OWNERSHIP FIX — RAPOR

**Kapsam: yalnızca `GET /profile-settings` (filtreli liste), `global::profile-setting-ownership` policy'sinin GET dalı, filtre bypass, private alan sızıntısı, integration test.** Başka hiçbir domain, route, izin veya dosyaya dokunulmadı. Push yapılmadı.

---

## 1. Kök Neden — Gerçek Boot ile Doğrulandı

D8-V-B raporunda (§0) bildirilen bulgu, bu fazda debug instrumentation ile **kesin olarak** kök nedenine indirgendi:

Eski kod:
```ts
if (method === 'GET' && !id) {
  const query = (ctx.query ?? {}) as Record<string, unknown>;
  const filters = (query.filters ?? {}) as Record<string, unknown>;
  ctx.query = { ...query, filters: { ...filters, profileId: { $eq: identity.ownerId } } };
  return true;
}
```

Gerçek bir boot'ta, policy içine debug log eklenerek doğrulandı:
- `ctx.query` (mutasyondan ÖNCE): **`undefined`** — gerçek bir querystring (`filters[profileId][$eq]=...`) istekte mevcutken bile.
- `ctx.request.query` (aynı anda): **doğru, ayrıştırılmış** `{filters: {profileId: {$eq: 'someone-else'}}}`.
- `ctx.query = {...}` atamasından SONRA: `ctx.query` artık doğru (zorlanmış) değeri gösteriyor — ama `ctx.request.query` **hiç değişmemiş**, hâlâ istemcinin orijinal (kısıtlanmamış) filtresini taşıyor.

**Kanıtlanan gerçek:** Strapi'nin policy çalıştırma bağlamında `ctx.query` ve `ctx.request.query`, vanilla Koa'daki gibi AYNI delege edilmiş özellik DEĞİL. Strapi'nin core `find` controller'ı filtreleri `ctx.request.query`'den okuyor — eski kod bunu hiç dokunmuyordu. Sonuç: **bu dal tamamen no-op'tu** — istemcinin gönderdiği `filters` objesi, kimlikten bağımsız olarak, olduğu gibi uygulanıyordu.

**Gerçek etki (üretimde, bu faz öncesi):** Herhangi bir authenticated kullanıcı, `GET /profile-settings?filters[profileId][$eq]=<hedef>` (veya **herhangi bir başka alana göre filtreleyerek**, örn. `filters[displayName][$eq]=...`) ile **başka herhangi bir kullanıcının tam profile-setting belgesini** (telefon, bio, favoriler, takip listeleri, gelen yorumlar, vb.) okuyabiliyordu. Bu, bir debug testiyle (yalnızca `displayName` filtresi kullanılarak, `profileId` hiç denenmeden) ayrıca doğrulandı — yani açık yalnızca `profileId` alanına özgü değildi, **filtrelenebilir her alan** üzerinden çalışıyordu.

## 2. Düzeltme

```ts
if (method === 'GET' && !id) {
  const query = (ctx.request?.query ?? {}) as Record<string, unknown>;
  const forced = {
    ...query,
    filters: { profileId: { $eq: identity.ownerId } },
  };
  ctx.query = forced;
  ctx.request.query = forced;
  return true;
}
```

İki değişiklik:
1. **Hem `ctx.query` hem `ctx.request.query` set ediliyor** — hangi Strapi core action'ının hangisini okuduğuna bağımlı kalınmıyor.
2. **`filters` artık istemcinin gönderdiğiyle BİRLEŞTİRİLMİYOR, tamamen DEĞİŞTİRİLİYOR** (`{...filters, profileId:...}` yerine yalnızca `{profileId: {$eq: identity.ownerId}}`). Gerekçe: bir kullanıcının yalnızca bir profile-setting belgesi olabilir (`profileId` `unique:true`), yani istemcinin `profileId`-kendi-kısıtlamasına EK bir filtre eklemesinin hiçbir meşru faydası yok — bu, yalnızca `profileId` değil, **hiçbir alan** üzerinden bypass edilemeyeceğini garantiliyor. `query` objesinin geri kalanı (üst seviye `pagination`/`populate`/`sort`) korunuyor — yalnızca `filters` alt-anahtarı tam olarak değiştiriliyor.

`id`'li dal (`GET/PUT/PATCH/DELETE /profile-settings/:id`) **hiç değişmedi** — o zaten `loadEntityByRouteId` ile doğrudan entity çekip karşılaştırma yapıyordu, `ctx.query` mutasyonuna hiç bağımlı değildi, ve testlerle (hem bu fazda hem D8-V-B'de) doğru çalıştığı doğrulandı.

## 3. Test Sonuçları

**7 yeni test, hepsi PASS** (`tests/integration/profile-setting-ownership.integration.test.ts`):
- Kendi belgesi olmayan bir viewer, `profileId=<hedef>` ile filtrelediğinde boş liste alıyor (hedefin verisi değil).
- Kendi belgesi OLAN bir viewer, `profileId=<hedef>` ile filtrelediğinde yalnızca KENDİ belgesini alıyor.
- **`displayName` gibi tamamen ilgisiz bir alanla filtreleme** (yalnızca hedefe uyan bir değerle) — hedefin verisi sızmıyor, private alan (`phone`) response'da hiç görünmüyor.
- Kendi belgesine uyan bir `displayName` filtresi — meşru kendi-erişim hâlâ çalışıyor (fix'in yanlışlıkla kendi erişimini de kırmadığı doğrulandı).
- `pagination[pageSize]` gibi diğer query parametreleri, zorlanmış filtreyle birlikte hâlâ doğru çalışıyor.
- Hiç filtre göndermeden GET — hâlâ yalnızca kendi belgesine scope'lu.
- Kimliksiz istek hâlâ reddediliyor (403 — Strapi'nin kendi RBAC katmanı, policy'den önce; bu faz bunu değiştirmedi).

**Tüm `test:integration`: 108/108 PASS** (101 önceki + 7 yeni). Unit: 23/23. `tsc --noEmit`: temiz.

## 4. Fonksiyonel Yan Etki — Bilgi Amaçlı, Bu Fazın Kapsamı Dışı

Bu düzeltme, **güvenlik açığını kapatıyor** ama önceden var olan bir ürün-seviyesi tutarsızlığı ortaya çıkarıyor: `hesabim_page.dart`'ın `_loadProfileFromStrapi` metodu, **başkasının profilini görüntülerken de** `fetchProfileSettings(profileId: <görüntülenen kişi>)` çağırıyor (business module hint'leri, vitrin pin sırası, premium hint için). Bu fix'ten ÖNCE, açık sayesinde bu çağrı (yanlışlıkla) HEDEFİN gerçek verisini döndürüyordu — yanlış bir mekanizmayla ama görünürde "doğru" veri gösteriyordu. Fix'ten SONRA, aynı çağrı artık doğru şekilde YALNIZCA ÇAĞIRANIN KENDİ belgesini döndürüyor — yani başkasının profilini görüntülerken bu alanlar (vitrin pin sırası, business module hint'i, premium hint) artık **ya boş/varsayılan kalacak ya da çağıranın kendi verisini yanlışlıkla gösterebilir** (aynı `_applyRemoteProfileSettingsToUser(widget.user, remote)` çağrısı hâlâ orada — `remote` artık hedefin değil, çağıranın kendi verisi).

**Bu, SEC-1'in bir regresyonu değil** — SEC-1 öncesi davranış zaten yanlıştı (yalnızca bir güvenlik açığı sayesinde "çalışıyormuş gibi" görünüyordu). Ama Flutter tarafında görünür bir davranış değişikliği olacak. Bu fazın kapsamı dışında bırakıldı (kullanıcının talimatı: "Başka hiçbir şeye dokunmayın") — muhtemel takip konusu: başkalarının profilini görüntülemek için gerçekten NE'nin herkese açık olması gerektiğini tanımlayan, dar bir "public profile read" endpoint'i (yalnızca isim/avatar/şehir/herkese açık ilanlar gibi) — bu, D8'in kapsamına da girmiyor, ayrı bir ürün kararı.

## 5. Commit

1. `7dcc10b` fix: close profile-setting ownership filter bypass (SEC-1)

(Test dosyası aynı commit'te — mandatın "tek fazlık, küçük" talimatına uygun olarak ayrı bir "test:" commit'i açılmadı; fix ve onu doğrulayan test tek, atomik bir değişiklik olarak birleştirildi.)

## 6. Sonuç

Açık kapatıldı, gerçek boot testiyle doğrulandı. `id`'li dal zaten doğruydu, dokunulmadı. Follow/rating/comments/D8-V-B'nin kendi işlevselliği etkilenmedi (108/108 testin hepsi, bu üç alanı da kapsayan önceki testler dahil, hâlâ geçiyor).

Burada duruyorum. D8-V-F'ye geçmiyorum, push yapmıyorum.
