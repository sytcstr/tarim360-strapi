# FAZ D7-B — FARMER QUESTIONS ENGAGEMENT BACKEND HAZIRLIĞI — RAPOR

**Kapsam: yalnızca `kind=like`, gerçek `targetType='hub-content'` üzerinden (aşağıda açıklanan mimari karar gereği).** Answer/comment, favorite, view, share, offer, profile, hub-content'in kendi davranışlarına dokunulmadı. Push yapılmadı.

---

## 1. Gerçek Model/UID — Kritik Bulgu (D7-B.1)

**Farmer Questions'ın kendi Strapi content-type'ı yok.** `FarmerQuestionsRepo._toQuestionPayload` (Flutter, `farmer_questions_repo.dart:702-735`) doğrudan `strapi.createHubContent`/`updateHubContent` çağırıyor — yani her `FarmerQuestion`, `api::hub-content.hub-content` koleksiyonunda `kind: 'farmerQuestion'` alanına sahip bir satırdır. Bu, **Faz D6'nın `targetType='hub-content'` için zaten tam yapılandırdığı AYNI koleksiyon**.

- Kanonik id: `FarmerQuestion.remoteEntryId` ↔ hub-content satırının `documentId`/`id`'si (`FarmerQuestionsRepo`'da `q.remoteEntryId` tutarlı şekilde kullanılıyor).
- Like sayacı: `likes` alanı — Knowledge Hub içeriğiyle **aynı fiziksel kolon**.
- Kullanıcının beğenip beğenmediği: yerel `FarmerQuestion.isLiked` (client-side), backend'de karşılığı yok.
- Eski özel endpoint: `POST /farmer-question-likes/toggle` → `engagement.toggleFarmerQuestionLike` — yalnızca `profile_settings.likedFarmerQuestionIds`'e yazıyordu, `hub_contents.likes`'a hiç dokunmuyordu.
- `StrapiService.toggleFarmerQuestionLikeRemote` (Flutter) — **grep ile doğrulandı, sıfır çağıran** (`strapi_service.dart` dışında hiç referans yok) — tamamen ölü kod.
- **Gerçek aktif mutasyon:** `FarmerQuestionsRepo.toggleLike` (`farmer_questions_repo.dart:437`) — client-computed delta (`max(0, q.likes ± 1)`), sonra `updateHubContent(remoteId, {'likes': q.likes})` ile en-iyi-çaba PATCH. Bu, D6-B'nin zaten koruma altına aldığı **aynı jenerik update rotası**.
- Answer/comment: gerçek cevap metni `body` alanına JSON-encoded olarak gömülü (`jsonEncode(body)` — `questionId`/`answers` içeren ayrı bir yapı), Hub'ın kendi `commentList` alanından farklı bir mekanizma — ama `comments`/`commentCount` alanları her iki özellik tarafından da (görüntüleme amaçlı) ortak kullanılıyor.

## 2. TargetType Kararı — Kullanıcı Onayı (D7-B.2)

**Yeni bir `targetType='farmer-question'` EKLENMEDİ.** Sebep: Farmer Question ve Knowledge Hub satırları fiziksel olarak aynı tablo/satır — ayrı bir targetType eklemek, aynı satırın iki bağımsız `engagement_interactions` namespace'i (`hub-content` vs `farmer-question`) üzerinden beğenilebilmesine, ama HER İKİSİNİN DE aynı `likes` kolonunu artırmasına yol açardı — yapısal bir çift-sayım riski. Bu, oturumda kullanıcıya açıkça sunuldu ve **"targetType='hub-content' yeniden kullan"** seçeneği onaylandı.

**Sonuç:** `engagement-contract.ts`'e hiçbir yeni satır eklenmedi. `TARGET_UID`, `DOMAIN_SUPPORT`, `COUNTER_FIELD` zaten D6'da `hub-content` için tam yapılandırılmıştı — Farmer Questions bunu olduğu gibi miras alıyor.

## 3. Şema Kararı (D7-B.3)

**Şema değişikliği gerekmedi.** `likes`/`engagementVersion` zaten hub-content şemasında mevcut (D6). İki ayrı alan üretilmedi — Farmer Questions ve Knowledge Hub aynı `likes` kolonunu paylaşıyor, bu kasıtlı ve doğru.

## 4. Legacy Delegasyon (D7-B.4)

`toggleFarmerQuestionLike` artık `setMembership(strapi, actorKey, 'hub-content', questionId, 'like', enabled)` çağırıyor — `toggleLogisticsLoadLike`/`toggleProcessedProductLike` ile birebir aynı desen. `profile_settings.likedFarmerQuestionIds` yalnızca sunucunun gerçek sonucuna göre güncelleniyor. İzin kontrolü: `api::engagement.engagement.toggleFarmerQuestionLike` zaten Faz B-V'nin toplu düzeltmesinde `authenticatedActions`'a eklenmişti — yeni bir izin açığı **yok**.

## 5. Client-Computed Like Kapatma (D7-B.5)

**Zaten yapılmıştı — D6-B'nin `hub-content` controller'ındaki `stripEngagementFields` (`likes`/`engagementVersion` silme) `kind`'a göre ayrım yapmıyor, tüm hub-content satırlarını (farmerQuestion dahil) kapsıyor.** Bu, gerçek bir boot testiyle özellikle `kind='farmerQuestion'` bir satır üzerinde doğrulandı (§7). Reaction-only-update guard (Hub D6-B'de bulunan) burada da aynı şekilde geçerli ve zaten güvenli — yeni bir kod değişikliği gerekmedi, yalnızca doğrulandı.

**Not:** Bunun beklenmeyen bir yan etkisi var — `FarmerQuestionsRepo.toggleLike`'ın aktif PATCH'i D6-B'den beri zaten sessizce yok sayılıyor (client `likes` gönderiyor, sunucu siliyor). Yani bugün itibariyle, gerçek `likes` sayacı Farmer Questions için **zaten hiç değişmiyor** (D7-F migration'ı tamamlanana kadar) — kritik bir regresyon değil (sayaç zaten cihazlar arası tutarsızdı), ama D7-F'in aciliyetini artıran bir bulgu.

## 6. Migration/Recount (D7-B.6)

Farmer Question'a özel bir actor-listesi/JSON alanı yok. `scripts/recount-hub-content-engagement.ts` hazırlandı — **hem Knowledge Hub hem Farmer Questions'ı kapsıyor** (D6 hiç recount script'i almamıştı, bu fazda o boşluk da dolduruldu). `likes`'ı `engagement_interactions`'dan yeniden hesaplıyor, yalnızca farklıysa yazıyor, `kind` ayrımı yapmadan tüm hub-content satırlarını tarıyor (rapor çıktısında farmerQuestion satır sayısını ayrıca gösteriyor). **Production'da çalıştırılmadı** — yalnızca boş, tek kullanımlık bir SQLite'a dry-run edildi, sonra silindi.

## 7. Test Sonuçları (D7-B.7)

**10/10 yeni test PASS** (`farmer-question-engagement.integration.test.ts`): jenerik rota farmerQuestion-kind satırda çalışıyor, legacy toggle (ilk/tekrar/legacy+yeni ardışık VE gerçekten eşzamanlı — tek interaction satırı), profile-setting mirror sunucu sonucundan, unauthorized/not-found, **D6-B'nin sanitizasyonunun farmerQuestion-kind satırlar için de geçerli olduğu** (özel olarak test edildi, varsayılmadı), answer/comment-eşdeğeri alanların (`body`/`comments`/`commentCount`) etkilenmediği.

**Tüm `test:integration`: 85/85 PASS** (75 önceki + 10 yeni). Unit: 23/23. `tsc --noEmit`: temiz.

## 8. Son Tarama (D7-B.8)

| Aranan | Sonuç |
|---|---|
| Farmer Question `likes` yazan noktalar | `setMembership` (yeni, atomik) + D6-B'nin sanitize ettiği eski client-PATCH yolu (artık zararsız) — çift kaynak yok |
| Client mutlak count kabul eden uç | **0** — D6-B'nin koruması burada da geçerli, ayrıca test edildi |
| Delege edilmemiş legacy route | **0** — tek özel route (`toggleFarmerQuestionLike`) delege edildi; `toggleFarmerQuestionLikeRemote` zaten hiç çağrılmıyordu |
| Interaction source-of-truth durumu | Net — `engagement_interactions`, `targetType='hub-content'` |
| Answer/comment diff | **0** — ayrı testle doğrulandı |

## 9. Flutter D7-F İçin API Sözleşmesi

- **Like:** `PUT/DELETE /api/engagements/like` `{targetType:'hub-content', targetId: question.remoteEntryId}` — **`targetType='farmer-question'` DEĞİL, `'hub-content'`.**
- D7-F'in `FarmerQuestion` için de Faz D6'daki `hubContentEngagementTarget`/`seedHubContentEngagement`/`toggleHubContentEngagementLike` adaptor fonksiyonlarını **doğrudan yeniden kullanması** öneriliyor (yeni bir "farmer question adapter" yazmaya gerek yok) — `EngagementTarget(type: EngagementTargetType.hubContent, id: question.remoteEntryId)` D6'da zaten var olan Knowledge Hub kartlarıyla otomatik olarak aynı state'i paylaşacaktır (aynı fiziksel satır olduğu için bu zaten doğru davranış).

## 10. D7-F İçin Karar

**READY.** Backend, Farmer Question like için Knowledge Hub ile aynı kanonik `setMembership` çekirdeğini kullanıyor; eski özel route delege edildi; client-computed count zaten D6-B'den beri engelleniyor (bu fazda farmerQuestion-kind'a özel olarak doğrulandı); recount script hem Hub hem Farmer Questions için hazır.

**D7-F'e özel hatırlatma:** Yeni bir `targetType=farmerQuestion` YOK — D7-F, D6-F'nin (varsa) veya bu fazın adapter fonksiyonlarını `EngagementTargetType.hubContent` ile çağırmalı, `q.remoteEntryId`'yi hedef id olarak kullanmalı.

Burada duruyorum. Flutter'a geçmiyorum, push yapmıyorum.
