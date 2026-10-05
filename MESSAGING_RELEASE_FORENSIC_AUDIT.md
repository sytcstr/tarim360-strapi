# Release Bug Fix Sprint — Sprint 3: Messaging System Forensic Audit (READ-ONLY)

**Date:** 2026-08-12
**Repos:** `tarim360` (Flutter), `tarim360-strapi` (backend)
**Mode:** Read-only code analysis. No code changed, no commit, no push, no production mutation.

---

## 1 — Mimari harita

```
Kullanıcı A
  │
  │ "Mesaj Gönder" (listing_detail_page / search_listings_page / offer akışı)
  ▼
MessagesStore.I.upsertFromListing / .upsertFromOffer / .ensureThreadForSending
  (lib/features/messages/stores/messages_store.dart)
  │
  ▼
MessagesStore.sendMessage(threadId, text)
  → useStrapiMessages ? _remoteSendMessage(...) : (tamamen local mock, ağ yok)
  │  (BackendRuntimeConfig.useStrapiMessages, main.dart:940-943 —
  │   bool.fromEnvironment('USE_STRAPI_MESSAGES', defaultValue: true).
  │   Bu repoda hiçbir dart-define override kanıtı yok; CodeMagic'in kendi
  │   build ayarlarında bir override olup olmadığı bu ortamdan
  │   DOĞRULANAMIYOR — kod varsayılanı true.)
  ▼
_normalizeParticipantsForSend (messages_store.dart:1306-1387)
  → thread'in requester/receiver alanlarından + ilan sahibinden hedef
  (target) kullanıcıyı heuristik olarak çözmeye çalışır
  ▼
_syncOutgoingMessageToStrapi (messages_store.dart:1522-1607)
  ▼
StrapiService.sendMessage (strapi_service.dart:2959-2982)
  → önce _currentSessionIsConversationParticipant (2933-2957) client-side
    kontrolü
  → POST /conversations/message (canlı, birincil yol)
  → 400/403/404/405 ise stok POST /messages'a fallback (nadiren tetiklenir)
  ▼
Backend: conversation.ts controller, sendMessage handler (satır 390-459)
  → normalizeParticipants + senderIsParticipant kontrolü
  → upsertThread (thread'i bulur/oluşturur) + entityService.create(MESSAGE_UID)
  ▼
message lifecycle afterCreate (content-types/message/lifecycles.ts)
  → api::notification.notification satırı oluşturur (kendine bildirim yok)
  ▼
notification lifecycle afterCreate (content-types/notification/lifecycles.ts)
  → deliverPush → sendFcmLegacyPush (src/utils/fcm.ts) — gerçek FCM çağrısı
  ▼
Kullanıcı B'nin cihazı
  → Sohbet listesi: yalnızca manuel/lifecycle refresh (Timer YOK)
  → Sohbet detay ekranı AÇIKSA: 10 saniyede bir polling
    (message_chat_page.dart:75-78, Timer.periodic)
  → Push bildirimi (varsa, cihaz/FCM canlı testi bu ortamdan doğrulanamaz)
```

### Flutter dosya envanteri
- Model: `lib/features/messages/models/message_models.dart` — `ChatMessage` (me/text/time — **read/seen alanı YOK**), `MessageThread`
- Store: `lib/features/messages/stores/messages_store.dart` (2471 satır, tek `MessagesStore` sınıfı, duplicate/legacy yok)
- Repository/service: ayrı bir repository katmanı yok — `messages_store.dart` doğrudan `StrapiService`'i çağırıyor
- Sohbet listesi: `lib/features/messages/pages/messages_page.dart`
- Sohbet detay: `lib/features/messages/pages/message_chat_page.dart`, `offer_chat_page.dart` (teklif bağlamlı ayrı sayfa, aynı deseni tekrarlıyor)
- Composer/send: her iki chat sayfasının kendi `_send()` metodu
- Polling: yalnızca `message_chat_page.dart`'ta `Timer.periodic(10s)` — store'da veya liste sayfasında Timer YOK
- Read-state metodu: `MessagesStore.markRead` (709-717) — sadece local `unreadCount=0` + `/conversations/:id/read` çağrısı; backend'in döndürdüğü `readAt`/`readBy` hiçbir yerde okunmuyor
- Unread-count: `MessagesStore.totalUnread` (satır 47) — tek tüketici `main.dart:1724` (bottom-nav badge)
- Attachment: YOK (aşağıda §10)
- Notification entegrasyonu: `NotificationStore`/`notifications_page.dart` (in-app), gerçek push backend'den geliyor

### Backend dosya envanteri
- `conversation` content-type: **YOK** — `api::conversation` diye bir content-type hiç yok. `/conversations/*` route'ları aslında `api::thread.thread` + `api::message.message` üzerinde çalışıyor (isimlendirme kafa karıştırıcı ama koddaki gerçek).
- `thread` content-type: `src/api/thread/content-types/thread/schema.json`, stok CRUD controller/routes (`global::thread-ownership` policy'siyle korunuyor) + AYRICA özel `conversation.ts` controller'ı (`/conversations/*` route'ları)
- `message` content-type: `src/api/message/content-types/message/schema.json`, stok CRUD (`global::message-ownership`) + özel `conversation.ts` üzerinden de yazılıyor
- Lifecycle: `message/content-types/message/lifecycles.ts` (afterCreate → notification oluştur), `notification/content-types/notification/lifecycles.ts` (afterCreate → FCM push)
- Policy: `src/policies/thread-ownership.ts`, `src/policies/message-ownership.ts` — **yalnızca stok `/api/threads`, `/api/messages` route'larını koruyor; özel `/conversations/*` route'larının KENDİ, FARKLI ve daha zayıf doğrulaması var (bkz. §2, §13, BUG-M1).**

---

## 2 — Identity / Participant Audit (KRİTİK)

Kullanılan formatlar, dosya/satır ile:

| Format | Nerede | Örnek |
|---|---|---|
| `senderEmail`/`senderProfileId` (düz alan) | message şeması, conversation.ts, message-ownership.ts | `"sytcstr@gmail.com"` / `"u_sytcstr_gmail_com"` |
| `requesterEmail`/`requesterProfileId`, `receiverEmail`/`receiverProfileId` | thread + message şeması | aynı format |
| `targetEmail`/`targetProfileId`, `messageReceiverEmail`/`messageReceiverProfileId` | message şeması — **fazladan, kısmen redundant alanlar** | aynı format |
| `actorKey(profileId, email, name)` → `profile:<pid>` / `email:<email>` / `name:<name>` | **YALNIZCA** `conversation.ts:45-51`, `conversationKey` hash'ini hesaplamak için — kalıcı alan olarak hiçbir yere yazılmıyor | `"profile:u_sytcstr_gmail_com"` |

`ownerId`/`profileId` formatı = `u_<email'in temizlenmiş hali>` — **bu proje boyunca tutarlı olan tek gerçek kimlik formatı** (`ownerIdFromEmail`). Logistics'teki `id:`/`profile:` prefix karışıklığı sınıfı **burada tekrar bulunmadı** — mesajlaşma hiçbir zaman prefix'li bir actor-key'i KALICI alan olarak saklamıyor; `actorKey()` yalnızca dahili hash girdisi.

### Kritik soru: A'nın yazdığı participant key ile B'nin aradığı key birebir aynı mı?

**Evet, e-posta/profileId düzeyinde** — her iki taraf da `ownerIdFromEmail`/`AuthService.currentEmail` üzerinden aynı normalize edilmiş formatı üretiyor (küçük harfe çevirme, aynı `u_` prefix algoritması). Format uyuşmazlığı BULUNAMADI.

### Ama gerçek sorun format değil, KİM'in "sender" olarak KABUL EDİLDİĞİ (bkz. §13, BUG-M1)

Backend'in özel `conversation.ts` handler'ı `senderEmail`/`senderProfileId`'yi **önce client payload'ından**, sadece boşsa `ctx.state.user`'dan (`current = actorForUser(user)`) alıyor (satır 100-102):
```ts
const senderEmail = cleanEmail(pick(data, ['senderEmail'])) || current.email;
const senderProfileId = cleanId(pick(data, ['senderProfileId'])) || current.profileId;
```
Buna karşılık, stok `/api/messages` route'unun `message-ownership.ts` policy'si **koşulsuz** gerçek kimlikten zorluyor (satır 114-115):
```ts
data.senderEmail = identity.email;
data.senderProfileId = identity.ownerId;
```
**İki paralel yol, iki farklı güvenlik seviyesi.** Flutter'ın gerçekte kullandığı (canlı) yol, zayıf olanı. Detay: §13, BUG-M1.

---

## 3 — Conversation Oluşturma / Bulma

- **Arama:** `findThread` (conversation.ts:180-194) önce `conversationKey`, sonra `threadId` ile arar.
- **conversationKey hesabı:** `[actorKey(A), actorKey(B)].sort().join('|') + '|' + contextType + ':' + contextId` — **katılımcı sırası fark YARATMIYOR** (sort ediliyor), doğru.
- **Duplicate conversation:** `thread.conversationKey` şemada `unique: true` — DB seviyesinde engellenmiş, **ama** `findThread` → `entityService.create` arasında transaction/lock yok (TOCTOU). Aynı anda iki taraf ilk mesajı atarsa, ikisi de "bulunamadı" görüp create denemesi yapabilir; ikincisi unique-constraint hatasıyla **yakalanmadan** patlar (`upsertThread`'de try/catch yok bu noktada) → BUG-M5.
- **listingId değişince ayrı sohbet mi?** `contextId` (= `listingId`/`productId`/vb.) `conversationKey`'in bir parçası — evet, farklı ilan = farklı `conversationKey` = farklı thread. Kasıtlı tasarım, tutarlı.
- **Yanlış kullanıcıya bağlanma:** `senderIsParticipant` kontrolü var ama zayıf temelli (bkz. §2/§13) — mekanizma olarak "yanlış kullanıcı" değil, "istemcinin iddia ettiği kullanıcı" ile çalışıyor.

---

## 4 — Mesaj Gönderme: KESİN KIRILMA NOKTASI

**Tahmin yok — üç bağımsız, birbiriyle tam örtüşmeyen doğrulama katmanı var; herhangi biri anlaşmazsa gönderim engelleniyor:**

1. **Flutter, ağa çıkmadan önce (`_normalizeParticipantsForSend`, messages_store.dart:1306-1387):** thread'in requester/receiver alanlarından + `_findListingByAnyId(thread.listingId)` üzerinden ilan sahibinden hedef kullanıcıyı heuristik zincirle çözmeye çalışır. Hedef boş kalırsa veya gönderenin kendisiyle aynı çıkarsa:
   ```dart
   // satır 1470-1475
   if ((targetEmail.isEmpty && targetProfileId.isEmpty) || targetIsSender) {
     debugPrint('Message send blocked: target is empty or self. ...');
     return false;
   }
   ```
   Bu **ağa hiç çıkmadan, sessizce** (yalnızca `debugPrint` — production'da görünmez) gönderimi durdurur. İlan silinmişse/`_findListingByAnyId` bulamazsa, ya da thread'in requester/receiver alanları eksikse (örn. eski/bozuk bir thread kaydı) bu heuristik başarısız olabilir.

2. **Flutter, ağa çıkarken (`_currentSessionIsConversationParticipant`, strapi_service.dart:2933-2957):** payload'daki 5 farklı email alanı + 5 farklı profileId alanının HİÇBİRİ oturum kimliğiyle eşleşmezse `Exception('Bu sohbet icin kullanici dogrulamasi yapilamadi.')` fırlatır.

3. **Backend (`senderIsParticipant`, conversation.ts:141-153):** `p.senderProfileId/senderEmail`'in requester VEYA receiver ile eşleşip eşleşmediğini kontrol eder; eşleşmezse `403 Forbidden`.

**Sonuç:** kullanıcıya gösterilen tek geri bildirim, `message_chat_page.dart`'ın generic SnackBar'ı — *"Mesaj iletilemedi. Sohbeti yenileyip tekrar deneyin."* — hangi katmanda, neden engellendiğine dair HİÇBİR ayrım yok. Bu, kullanıcının "mesaj gönderemiyorum" şikayetinin **doğrudan, kod-kanıtlı** açıklaması: gönderim, üç ayrı, birbirinden bağımsız-ama-tutarsız doğrulamadan geçmek zorunda, herhangi biri (özellikle #1, ağa hiç çıkmadan) engellerse kullanıcı sadece jenerik bir hata görür. → **BUG-M3**

**Backend tarafında (istek gerçekten ulaştığında):** auth zorunlu (`ctx.state.user` kontrolü var), ama **sender spoofing mümkün** (§13, BUG-M1) — yani backend "kimin gönderdiğini" doğru doğrulamıyor, sadece "gönderen (iddia edilen kişi) katılımcı mı" doğruluyor. DB kaydı (`entityService.create`) başarılı istekler için gerçek ve güvenilir — kayıt katmanında bir sorun bulunamadı.

---

## 5 — Mesaj Alma / Refresh

- **Gerçek zamanlı mekanizma:** YOK. WebSocket/SSE hiçbir yerde yok (grep ile doğrulandı).
- **Sohbet listesi sayfası (`messages_page.dart`):** otomatik polling YOK — yalnızca sayfa açıldığında / manuel yenilemede fetch.
- **Sohbet detay sayfası:** `Timer.periodic(10s)` (message_chat_page.dart:75-78), sayfa `dispose()` olunca `_pollTimer?.cancel()` ile düzgün temizleniyor (leak riski bulunamadı). Aynı anda birden fazla timer başlama riski yok (tek `initState`, tek `_pollTimer` alanı).
- **Fetch sıralaması:** backend `mine` (`sort: lastMessageAt desc`), `messagesByThread` (`sort: sentAt asc`) — doğru, tutarlı.
- **Pagination:** `messagesByThread` limit=300 sabit, gerçek sayfalama (`start`/`offset` ilerletme) YOK — 300'den fazla mesajı olan bir sohbette en eski mesajlar hiç gelmez (kenar durum, düşük öncelik ama not edilmeye değer).
- **DB'de var ama UI'da görünmeme ihtimali:** `_pollMessages()`'daki `if (remote.length <= msgs.length) return;` kıyaslaması **sayı bazlı**, id/hash bazlı değil — eşzamanlı bir senaryoda (örn. karşı taraf tam o anda yeni mesaj atarken siz de kendi mesajınızı optimistic olarak eklediyseniz) sayılar tesadüfen eşleşip bir yenileme atlanabilir. Kod-kanıtlı bir kırılganlık, kesin kanıt için çoklu-cihaz stres testi gerekir.

---

## 6 — Optimistic UI / Server State

- Send sonrası mesaj UI'ya **hemen** ekleniyor (`message_chat_page.dart:_send()`, satır 112-117).
- Server başarısız olursa: `_remoteSendMessage` **tam rollback** yapıyor (`threads[currentIdx] = previous`, satır 1508-1517) — sahte "gönderilmiş" mesaj UI'da KALMIYOR (regular chat için). "Gönderilemedi" SnackBar'ı gösteriliyor (message_chat_page.dart:104-108).
- Server başarılı olup sonraki poll'da tekrar fetch edilirse: **sayı bazlı** karşılaştırma (§5) nedeniyle teorik olarak duplicate riski var ama id/text bazlı bir dedup mekanizması da ayrıca mevcut (`_chatHistory` dedup, messages_store.dart:963-968, 1070-1074) — çift kayıt riski düşük ama sıfır değil.
- **Client ID / server ID eşleştirme:** YOK — optimistic mesaj ile server'dan dönen gerçek mesaj arasında `operationId`/`clientMessageId` tabanlı bir eşleştirme yok (message şemasında böyle bir alan da yok). Bu, S1/S2'de kullanılan `operation-idempotency.ts` desenine benzer bir korumanın mesajlaşmada HİÇ olmadığı anlamına geliyor.

---

## 7 — Okundu Bilgisi

### Backend mekanizması (gerçek, kalıcı)
`PATCH /conversations/:threadId/read` (conversation.ts:307-366):
- Thread'de: `unreadCount=0`, `lastReadAt`, `readReceipts[actor]=readAt` (JSON map, aktöre özel — doğru tasarım).
- **Thread'deki HER mesajda:** `readAt` (düz `datetime` alan, TEK değer, üzerine yazılıyor) + `readBy[actor]=readAt` (JSON map) güncelleniyor — **gönderenin KENDİ mesajları dahil, ayrım yapılmadan** (satır 349-360). Zararsız gürültü (kimin mesajını kim okudu sorusuna yanlış cevap ÜRETMİYOR, çünkü `readBy` aktöre-özel kalıyor) ama gereksiz ve `readAt` (düz alan) iki taraf da çağırdığında "en son kim okudu" bilgisini anlamsızlaştırıyor. → BUG-M6 (LOW).

### Flutter tarafı: TAMAMEN BAĞLANTISIZ
- `ChatMessage` modelinde (`message_models.dart:7-12`) **`read`/`readAt`/`readBy` alanı YOK.**
- `messages_store.dart` ve her iki chat sayfasında `readAt`/`readBy` hiçbir yerde parse edilmiyor/okunmuyor (grep ile doğrulandı, sıfır sonuç).
- **"Okundu" ikonu (`Icons.done_all`, WhatsApp çifte-tik) her iki chat sayfasında da (`message_chat_page.dart:464-471`, `offer_chat_page.dart:397-404`) SADECE `if (m.me)` koşuluyla gösteriliyor — yani "ben gönderdim" demek, sunucudan gelen hiçbir okundu-bilgisiyle İLİŞKİSİ YOK.**

### Kesin hüküm
**"Gönderildi / iletildi / okundu" ayrımı YOK — sahte görsel.** Her gönderilen mesaj, karşı taraf sohbeti hiç açmamış olsa bile, anında "okundu" (çifte tik) gösteriyor. Backend'in gerçek, kalıcı read-tracking altyapısı var ama istemci onu hiç kullanmıyor. → **BUG-M2 (kesin kanıtlandı, tahmin değil).**

App restart sonrası: read state backend'de DB'de kalıcı (doğru), ama zaten UI hiç okumadığı için bu kalıcılığın kullanıcıya bir yansıması yok.

---

## 8 — Unread Sayacı

- **Tek source-of-truth:** `MessagesStore.totalUnread` = `threads.fold(0, (a,b) => a + b.unreadCount)` (satır 47) — her thread'in kendi `unreadCount`'unun toplamı, ayrı/bağımsız bir global sayaç YOK. Tek tüketici: `main.dart:1724` (bottom-nav badge). Yapısal olarak sağlam (tek kaynak).
- **0→1→2, sohbet açınca 0:** kod yolu (`receiveMessage`'da `+= 1`, `markRead`'de `=0`) doğru davranışı üretiyor.
- **Başka sohbetin sayısı etkilenmemeli:** `markRead(threadId)` yalnız `threads[idx]` (ilgili thread) üzerinde çalışıyor, doğru izole.
- **Negatif/bayat count:** kod içinde `unreadCount -= 1` gibi bir azaltma işlemi YOK (yalnızca `=0` veya `+=1`) — negatif değer riski yapısal olarak yok. "Bayat" risk, yalnızca §5'teki poll/fetch gecikmesine bağlı (sayaç kendisi yanlış hesaplanmıyor, sadece güncel VERİ gecikmeli gelebilir).

---

## 9 — Sohbet Listesi

- Son mesaj/zaman: thread'in kendi `lastMessage`/`lastTimeText`/`lastMessageAt` alanlarından, sorun bulunamadı.
- **Sıralama:** backend `mine` → `sort: lastMessageAt desc` (doğru); client tarafında da her `sendMessage`/`receiveMessage` sonrası `threads.removeAt(idx); threads.insert(0, t);` ile anlık olarak üste taşınıyor — tutarlı.
- Empty `lastMessage` → thread kaybolması: `_shouldKeepLocalThread` (845-874) böyle bir thread'i filtrelemiyor görünüyor, ayrı bir "boş mesaj = sil" mantığı bulunamadı; net bir kayıp riski görülmedi.
- **Partner bilgisi (isim/avatar) SEC-1/PublicProfile sonrası doğru endpoint'ten mi geliyor?** `messages_store.dart:1914` civarındaki `SessionProfileStore.I.resolveForOwner` üzerinden geliyor — bu, Sprint 2'de düzeltilen `PublicProfile`/`public-profiles` zincirinin **DIŞINDA**, ayrı bir profil-önbellek mekanizması. Sprint 2'nin `isPremium` düzeltmesi bu dosyaya YAYILMADI.
- **Premium marka-adı eki (BUG-003A, kullanıcının önceden adlandırdığı gibi):** satır 1914, `premiumProfileHintForOwner(ownerId: id, ownerEmail: ownerEmail)` — Sprint 2 fix'i sonrası bu fonksiyon başkası için artık HER ZAMAN `false` dönüyor (kasıtlı, dürüst default — bkz. `PROFILE_BUG002_PUBLIC_PREMIUM_FIX_REPORT.md`'nin "Açıkça bırakılan, çözülmeyen bir uç" bölümü). Sonuç: **sohbet listesinde hiçbir konuşma partnerinin marka-adı eki artık hiç görünmeyecek** — yeni bir regresyon değil (öncesinde de fiilen hep boştu, lokal cihaz önbelleği asla dolu olmadığı için), ama gerçek düzeltmesi (async `PublicProfile.isPremium`'a bağlanma) hâlâ yapılmadı. → **BUG-003A, MEDIUM, confirmed.**

---

## 10 — Fotoğraf / Attachment

**DESTEKLENMİYOR.** Kanıt:
- `message` şemasında (`schema.json`) medya/attachment/image alanı YOK.
- Her iki chat sayfasında (`message_chat_page.dart`, `offer_chat_page.dart`) `ImagePicker`/`image_picker`/"attach" butonu YOK (grep, sıfır sonuç).
- Tek `Icons.image_not_supported_outlined` eşleşmesi `offer_chat_page.dart:301` — bu bir mesaj eki değil, sohbet başlığındaki ürün/ilan küçük resminin hata-durumu ikonu.

Bu, mandatın kendi talimatı gereği "yok" olarak açıkça raporlanıyor — bir bug değil, uygulanmamış bir özellik.

---

## 11 — Notification

- **Zincir gerçek, sahte değil:** `message.afterCreate` → `notification` satırı → `notification.afterCreate` → `deliverPush` → `sendFcmLegacyPush` (`src/utils/fcm.ts`) — kod seviyesinde tam, çalışan bir FCM push zinciri (S1/S2 boyunca zaten var olan, kanıtlanmış `fcm.ts` altyapısını kullanıyor).
- **Sender'a bildirim gitmiyor mu?** Evet, doğru — `pushMessageNotification`'ın `isSamePerson(sender, receiver)` kontrolü (message lifecycle, satır 31-35) kendine bildirimi engelliyor.
- **Çift bildirim riski:** `message.afterCreate` her mesaj için TAM OLARAK BİR `notification` satırı oluşturuyor (döngü/tekrar yok) — çift bildirim riski kod seviyesinde görülmedi.
- **Notification başarısız olunca message send başarısız mı oluyor?** HAYIR, doğru — `pushMessageNotification`/`deliverPush` kendi try/catch'leri içinde, mesaj oluşturma işleminden SONRA (afterCreate) ve ayrı; bir push hatası mesajın DB'ye kaydını asla etkilemiyor.
- **Doğrulanamayan kısım:** gerçek FCM kimlik bilgilerinin/token teslimatının canlı bir cihazda çalışıp çalışmadığı — bu, statik kod analiziyle kanıtlanamaz, cihaz testi gerektirir. Notification tap → doğru conversation: uygulama-içi bildirim sayfasında (`notifications_page.dart`) `NotificationKind.message` için yönlendirme kodu var; OS bildirim tepsisinden (arka plan/kapalı uygulama) tıklamanın native deep-link davranışı bu ortamdan doğrulanamadı.

---

## 12 — Offline / Network Failure

- **Internet yokken send:** `_syncOutgoingMessageToStrapi`'nin try/catch'i ağ hatasını yakalıyor, `_remoteSendMessage` bunu **tam rollback**'e çeviriyor (optimistic mesaj kayboluyor, kullanıcıya "Mesaj iletilemedi" gösteriliyor). Sahte-başarı YOK — bu doğru.
- **Otomatik retry:** **YOK.** `DeliverySyncState.queued` durumu var (regular chat send'de hiç kullanılmıyor, sadece `syncOfferEventFromCurrentUser`'da) ama hiçbir Timer/lifecycle-hook/manuel-buton bu durumu tarayıp yeniden denemiyor (grep ile doğrulandı, sıfır sonuç).
- **Teklif-olayı (offer event) mesajları sessizce kaybolabilir:** `syncOfferEventFromCurrentUser` (1609-1688) başarısız olursa thread `queued` işaretleniyor ama asla yeniden denenmiyor — bir teklif kabul/red/karşı-teklif anındaki geçici bir ağ sorunu, o sistem mesajını KALICI olarak, hiçbir kullanıcı bildirimi olmadan kaybedebilir. → **BUG-M4.**
- **Engagement Pending Queue kullanılıyor mu?** HAYIR — mesajlaşmanın kendi, ayrı (ve retry'siz) mekanizması var, S1/S2'nin `EngagementPendingQueue`'suyla hiçbir bağlantısı yok.

---

## 13 — Security / Ownership / IDOR

### GET tarafı (okuma) — SAĞLAM
- `mine`/`myMessages`: `userFilter(ctx.state.user)` — yalnızca gerçek oturum kimliğiyle eşleşen thread/mesajlar. Client bunu spoof edemez (filtre `ctx.state.user`'dan, body'den değil).
- `messagesByThread`: önce thread'i `userFilter` ile doğruluyor (`403` yoksa), SONRA o thread'in mesajlarını çekiyor — IDOR riski görülmedi (bir threadId tahmin etse bile, kullanıcı o thread'in katılımcısı değilse `403`).
- `markRead`: aynı desen, thread ownership önce doğrulanıyor.
- Stok `/api/threads`, `/api/messages` (GET): `thread-ownership.ts`/`message-ownership.ts`'in `mergeScopeOrFilter` dalı aynı şekilde sağlam.

### POST tarafı (yazma) — **KRİTİK ZAAF: BUG-M1**

`conversation.ts`'in `sendMessage`/`upsert` handler'ları, sender kimliğini **client payload'ından öncelikli olarak** alıyor (`normalizeParticipants`, satır 100-102 — yukarıda §2'de gösterildi). Yalnızca `senderIsParticipant` kontrolü var — bu, "iddia edilen sender, thread'in requester VEYA receiver'ı mı" diye bakıyor, **"iddia edilen sender GERÇEKTEN ctx.state.user mı" diye BAKMIYOR.**

**Somut senaryo:** Kimlik doğrulaması yapılmış herhangi bir kullanıcı (X), aşağıdaki payload'ı `POST /conversations/message`'a gönderirse:
```json
{
  "senderEmail": "magdur@ornek.com",
  "senderProfileId": "u_magdur_ornek_com",
  "requesterEmail": "magdur@ornek.com",
  "requesterProfileId": "u_magdur_ornek_com",
  "receiverEmail": "hedef@ornek.com",
  "receiverProfileId": "u_hedef_ornek_com",
  "message": "..."
}
```
`senderIsParticipant` kontrolü **GEÇER** (sender==requester eşleşiyor, X'in KENDİ oturumuyla hiçbir ilgisi yok) ve mesaj, `magdur@ornek.com` (Mağdur) tarafından gönderilmiş gibi `senderEmail`/`senderProfileId` alanlarıyla DB'ye yazılır — X, Mağdur'un şifresine/oturumuna hiç ihtiyaç duymadan, sadece KENDİ (X'in) geçerli bir hesabıyla giriş yapmış olarak.

**Karşılaştırma — DOĞRU YAPILAN YER, AYNI REPO'DA:** stok `/api/messages` route'unun `message-ownership.ts` policy'si (satır 114-115) `data.senderEmail = identity.email; data.senderProfileId = identity.ownerId;` ile **koşulsuz** zorluyor — client'ın gönderdiği hiçbir sender alanı dikkate alınmıyor. Aynı düzeltme `conversation.ts`'e uygulanmamış.

**Live caller:** EVET — bu, Flutter'ın gerçekte kullandığı BİRİNCİL endpoint (`/conversations/message`, `/conversations/upsert`). Meşru Flutter istemcisi kendi gerçek kimliğini gönderiyor (spoof etmiyor), ama bu backend'in DEĞİL, istemcinin "iyi niyetli" olmasının bir sonucu — herhangi bir HTTP istemcisi (curl/Postman/değiştirilmiş bir APK) bu korumayı atlayabilir.

**Diğer client-supplied alanlara güven:** `senderEmail`/`senderProfileId`/`requesterEmail`/`requesterProfileId` hepsi aynı zayıflığı paylaşıyor (`normalizeParticipants`'ın tamamı). `receiverEmail`/`receiverProfileId` nispeten daha az riskli (alıcıyı spoof etmenin doğrudan bir "birini taklit etme" etkisi yok, sadece mesajı yanlış kişiye yönlendirebilir — ki `senderIsParticipant` zaten bunu bir dereceye kadar kısıtlıyor).

**Message/thread delete:** `deleteByThreadId` (461-488) `userFilter` ile thread ownership'i doğruluyor — bu yol sağlam.

**Minimum güvenli çözüm:** `conversation.ts`'in `sendMessage` ve `upsert` handler'larında, `message-ownership.ts`'in zaten yaptığı gibi, `senderEmail`/`senderProfileId`'yi (varsa `requesterEmail`/`requesterProfileId`'yi de, eğer sender==requester ise) her zaman `ctx.state.user`'dan (identity) türetip client payload'ını YOK SAYMAK — backend'e dokunmadan Flutter tarafında hiçbir değişiklik gerekmiyor, çünkü meşru istemci zaten kendi gerçek kimliğini gönderiyor.

---

## 14 — Strapi Schema

### Thread (`api::thread.thread`)
| Alan | Tip | Not |
|---|---|---|
| threadId | string, **unique** | |
| conversationKey | string, **required, unique** | Server-side hesaplanıyor, client'tan gelen değer stok CRUD fallback'i dışında yok sayılıyor |
| requesterEmail/ProfileId/Name, receiverEmail/ProfileId/Name | string | Relation DEĞİL, düz string |
| lastMessage, lastMessagePreview, lastTimeText, lastMessageAt | text/string/datetime | |
| lastSenderEmail/ProfileId | string | |
| unreadCount | integer | |
| readReceipts | **json** | aktöre-özel harita |
| lastReadAt | datetime | |
| contextType | enumeration (general/listing/processed_product/logistics_load/support) | |
| contextId, listingId, listingTitle, listingQtyText, imageUrl, personName/City/AvatarUrl | string | |
| metadata | json | |

### Message (`api::message.message`)
| Alan | Tip | Not |
|---|---|---|
| threadId | string | **relation değil** — düz string eşleşmesi |
| message, text | text | iki ayrı, birbirini kopyalayan alan |
| senderEmail/ProfileId/Name | string | §13'te tartışılan zayıf nokta |
| requesterEmail/ProfileId/Name, receiverEmail/ProfileId/Name | string | |
| targetEmail/ProfileId, messageReceiverEmail/ProfileId | string | requester/receiver ile kısmen redundant |
| sentAt | datetime | |
| readAt | datetime | **tek değer, aktöre özel değil** (bkz. BUG-M6) |
| readBy | json | aktöre-özel harita — doğru olan bu |
| conversationKey, contextType, contextId, listingId, listingTitle | | thread ile aynı |
| metadata | json | |
| **media/attachment** | — | **YOK** |
| **operationId/clientMessageId** | — | **YOK** |

**Flutter model ile birebir uyum mu?** Kısmen — `MessageThread`/`ChatMessage` yukarıdaki alanların çoğunu taşıyor, ama `readAt`/`readBy` **hiç taşınmıyor** (§7). `threadId`/`message`'ın relation değil düz string olması, hem backend hem Flutter'ın tutarlı davrandığı bir tasarım tercihi (basit ama esnek), IDOR riski yaratmıyor çünkü tüm sorgular ayrıca ownership ile filtreleniyor.

---

## 15 — Real API Contract

| METHOD | PATH | AUTH | Flutter Caller |
|---|---|---|---|
| GET | `/conversations/mine` | JWT (auth scope boş ama `ctx.state.user` kontrolü route içinde yok — **bkz. not aşağıda**) | `fetchThreadsLatest` |
| GET | `/conversations/messages/mine` | aynı | `fetchMessagesLatest` |
| GET | `/conversations/:threadId/messages` | JWT zorunlu (`ctx.state.user` kontrolü var) | `fetchMessagesByThreadId` |
| PATCH | `/conversations/:threadId/read` | JWT zorunlu | `markConversationRead` |
| POST | `/conversations/upsert` | JWT zorunlu | `createThread` |
| POST | `/conversations/message` | JWT zorunlu | `sendMessage` |
| DELETE | `/conversations/:threadId` | JWT zorunlu | `deleteThread` |

**Not:** route config'lerinde `config: { auth: { scope: [] } }` var — bu Strapi'de "herhangi bir authenticated kullanıcı, özel bir role/permission scope'u gerekmez" anlamına gelir, **auth'un tamamen kapalı olduğu anlamına gelmez** (`mine`/`myMessages` handler'ları da `ctx.state.user`'ı kullanıyor, ama bu ikisinde `if (!user) return ctx.unauthorized(...)` şeklinde AÇIK bir kontrol YOK — `userFilter(undefined)` çağrılırsa `actorForUser(undefined)` boş email/profileId üretir, `userFilter` de `{id: -1}` döner (satır 264) yani **boş sonuç**, hata değil. Yani auth'suz bir çağrı 401 almaz ama veri de almaz — fonksiyonel olarak güvenli ama HTTP semantiği tutarsız (401 yerine sessizce boş liste).

Flutter'ın parse ettiği alanlarla backend response'u karşılaştırıldığında (`_extractRowMaps`, `_pickString`/`_pickInt` fallback zincirleri) uyumsuzluk bulunamadı — Flutter tarafı zaten geniş fallback anahtar listeleriyle yazılmış (`threadId`/`conversationId`, `unreadCount`/`unread` vb.).

---

## 16 — Legacy / Dead Messaging Code

- **Stok `/api/threads`, `/api/messages` CRUD route'ları:** ÖLÜ DEĞİL, ama nadiren tetikleniyor — yalnızca özel `/conversations/*` endpoint'i 400/403/404/405 dönerse fallback olarak devreye giriyor. İronik not: bu "neredeyse hiç kullanılmayan" yol, `message-ownership.ts` sayesinde BUG-M1'den ETKİLENMİYOR (daha güvenli).
- **Duplicate messaging store:** YOK, tek `MessagesStore` sınıfı.
- **Mock/local-only mod:** `useStrapiMessages=false` durumu için kod hâlâ var (§1) ama varsayılan `true`; bu bir "eski kod" değil, aktif bir feature-flag dalı (Flutter'ın diğer tüm `useStrapiXxx` bayraklarıyla aynı desen).
- **Deprecated helper:** `targetEmail`/`messageReceiverEmail` gibi kısmen redundant alanlar (aynı bilgiyi 2 farklı isimle taşıyor) temizlik açısından not edilmeye değer ama "ölü kod" değil, ikisi de gerçekten okunuyor/yazılıyor (geriye dönük uyumluluk amaçlı görünüyor).

**Silme yapılmadı**, mandat gereği.

---

## 17 — İki Kullanıcılı Senaryo Matrisi (kod izleme ile değerlendirme)

Bu ortamda gerçek iki-cihaz/iki-kullanıcı canlı testi YAPILAMADI (mandat read-only, production mutation yok). Aşağıdaki değerlendirme kod izleme ile yapıldı; "KOD KANITLI" = mekanizma kesin okunabiliyor, "CANLI TEST GEREKİR" = mekanizma var ama gerçek zamanlama/race koşulları ancak çalıştırarak kesinleşir.

| # | Senaryo | Değerlendirme |
|---|---|---|
| 1 | A → B ilk mesaj | KOD KANITLI: thread oluşur (conversationKey unique), mesaj DB'ye yazılır — spoofing riski hariç (BUG-M1) |
| 2 | B mesajı görür | CANLI TEST GEREKİR: yalnızca B, sohbet listesini manuel yeniler VEYA detay sayfasını açıp 10sn bekler ise (§5) |
| 3 | B açar → read | KOD KANITLI: `markRead` çağrılır, backend'de kalıcı |
| 4 | A read bilgisini görür | **KOD KANITLI OLARAK ÇALIŞMIYOR** — UI hiç göstermiyor (BUG-M2), A her zaman "okundu" görür, B okumuş olsun ya da olmasın |
| 5 | B cevap verir | KOD KANITLI: aynı send zinciri |
| 6 | A cevap alır | CANLI TEST GEREKİR (aynı §5 gecikme/polling sınırlaması) |
| 7 | A ikinci mesaj atar | KOD KANITLI |
| 8 | İki taraf aynı anda yazar | CANLI TEST GEREKİR — race condition (BUG-M5) yalnızca ilk mesaj/thread oluşturma anında teorik risk taşıyor; sonraki mesajlarda (thread zaten var) risk yok |
| 9 | App restart | KOD KANITLI: thread/mesaj geçmişi backend'den `_hydrateHistoryFromRemote`/`refreshThreads` ile tazeleniyor |
| 10 | Sohbet geçmişi aynı kalır | KOD KANITLI (yukarıdaki gibi) |
| 11 | Unread doğru | KOD KANITLI (§8) |
| 12 | Conversation list order doğru | KOD KANITLI (§9) |
| A→C senaryosu, B'nin unread/count'u bozulmamalı | KOD KANITLI — `markRead`/sayaç mantığı yalnız ilgili `threadId` üzerinde çalışıyor, çapraz-thread etkileşim bulunamadı |

---

## 18 — Test Coverage Audit

**Mevcut testler: SIFIR.** Hem `tarim360/test/` hem `tarim360-strapi/tests/` içinde mesajlaşma/conversation/thread/chat ile ilgili tek bir test dosyası bulunamadı (dosya adı araması, sıfır sonuç).

Eksik olanlar (mandatın listesinin tamamı):
- send success / send failure / duplicate send
- receive / polling
- read receipt / unread
- participant ownership / **IDOR (özellikle BUG-M1'in tam tersi senaryosu: sender spoofing reddediliyor mu)**
- conversation duplicate (race condition)
- media (N/A, özellik yok)
- notification (push zincirinin en azından `message.afterCreate`→`notification` satırı oluşturduğu seviyede test edilebilir, FCM'in kendisi mock'lanarak)
- restart/cache

**Bu, kullanıcının "mesajlaşma hiç test edilmemiş" izlenimini doğruluyor — sıfır otomatik test kapsamı, iddia değil, doğrulanmış gerçek.**

---

## 19 — Bug Raporu

| BUG-ID | Severity | Release Blocker? | Flutter/Backend | Dosya | Fonksiyon | Satır | Root Cause | Live Caller | User Impact | Minimum Safe Fix | Required Tests |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **BUG-M1** | 🔴 CRITICAL | EVET | Backend | `src/api/conversation/controllers/conversation.ts` | `normalizeParticipants`, `sendMessage`, `upsert` | 100-102, 390-459, 368-388 | `senderEmail`/`senderProfileId` client payload'ından öncelikli alınıyor, gerçek `ctx.state.user`'dan zorlanmıyor (stok `/api/messages`'ın `message-ownership.ts`'i doğru yapıyor, bu dosya yapmıyor) | EVET — Flutter'ın kullandığı birincil endpoint | Kimlik doğrulaması olan herhangi bir kullanıcı, başka bir gerçek kullanıcı adına mesaj gönderebilir (kimlik hırsızlığı/dolandırıcılık/taciz vektörü) | `data.senderEmail = identity.email; data.senderProfileId = identity.ownerId;` koşulsuz zorla (message-ownership.ts'deki desenin aynısı) | Sender spoofing denemesi 403/stripped olmalı; gerçek kullanıcı kendi adına göndermeye devam edebilmeli |
| **BUG-M3** | 🔴 CRITICAL | EVET | Flutter | `lib/features/messages/stores/messages_store.dart` | `_normalizeParticipantsForSend`, `_remoteSendMessage` | 1306-1387, 1467-1475 | Eksik/belirsiz katılımcı verisi olan thread'lerde hedef kullanıcı heuristik olarak çözülemiyor, gönderim ağa hiç çıkmadan sessizce (yalnız debugPrint) engelleniyor; toplam 3 bağımsız doğrulama katmanından herhangi biri anlaşmazsa gönderim durur | EVET, her gönderimde | "Mesaj gönderemiyorum" şikayetinin doğrudan, kod-kanıtlı açıklaması (bir alt küme thread için) | Katılımcı çözümleme mantığını backend'e (thread'in zaten sakladığı requester/receiver'a) taşı, tek otorite yap; kullanıcıya/loglara gerçek başarısızlık nedenini yansıt | Eksik listing/katılımcı verisi olan bir thread'de gönderim ya başarılı olmalı ya da SPESİFİK bir hata göstermeli |
| **BUG-M2** | 🟠 HIGH | EVET | Flutter | `message_chat_page.dart`, `offer_chat_page.dart`, `message_models.dart` | UI: 464-471 / 397-404; model: `ChatMessage` (7-12) | "Okundu" ikonu yalnız `m.me` kontrolüyle gösteriliyor, backend'in gerçek `readAt`/`readBy`'ı hiç fetch/parse edilmiyor | EVET, her gönderilen mesajda | Kullanıcı, mesajı karşı taraf hiç görmemiş olsa bile "okundu" sanıyor — güven zedeleyici, yanıltıcı | `ChatMessage`'a `read` alanı ekle, fetch/poll bunu backend'in `readBy`sinden doldursun, ikon gerçek duruma göre koşullansın (ya da bu release'de öncelik değilse ikon tamamen kaldırılsın) | Read ikonu yalnız gerçek alıcı markRead çağırdıktan SONRA görünmeli |
| **BUG-M4** | 🟠 HIGH | EVET | Flutter | `messages_store.dart` | `syncOfferEventFromCurrentUser`, retry mekanizması | 1609-1688 (retry: yok) | Başarısız teklif-olayı mesajları `queued` işaretleniyor ama hiçbir kod bunu tarayıp yeniden denemiyor | EVET (teklif kabul/red/karşı-teklif akışında) | Geçici ağ sorunu, bir teklif durumunu bildiren sistem mesajını sessizce ve kalıcı olarak kaybedebilir | App foreground/thread-open anında `queued` mesajları tara ve yeniden dene; en azından kullanıcıya "gönderilemedi, tekrar dene" affordance'ı göster | Queued bir offer-event mesajı, sonraki ilgili app olayında `synced`'e geçmeli |
| **BUG-M5** | 🟠 HIGH (rubrik: duplicate/conversation kaybı sınıfı; tetiklenme olasılığı düşük, kod-kanıtlı, canlı stres testiyle doğrulanmadı) | Değerlendirilmeli | Backend | `conversation.ts` | `findThread`, `upsertThread` | 180-194, 232-250 | TOCTOU: `findThread` (read) ile `entityService.create` (write) arasında lock/transaction yok; `conversationKey` unique constraint'i DB'de var ama create hatası yakalanmıyor | EVET (her ilk-mesaj anında, ama race'in gerçekleşmesi nadir) | Aynı anda iki taraf ilk mesajı atarsa, biri yakalanmamış 500 hatası alabilir | `upsertThread`'in create dalını try/catch'e al, unique-constraint hatasında `findThread`'i tekrar çalıştır | İki eşzamanlı upsert/sendMessage aynı yeni çift için ikisi de başarılı olmalı, tek thread oluşmalı |
| **BUG-003A** | 🟡 MEDIUM | Hayır (kozmetik/marka, veri kaybı yok) | Flutter | `messages_store.dart` | (partner display name resolution) | 1914 | Sprint 2'nin `premiumProfileHintForOwner` düzeltmesi (başkası için artık dürüst `false`) bu senkron/cache'li kullanım noktasına async `PublicProfile.isPremium` ile hiç bağlanmadı | EVET | Sohbet listesinde premium partnerin marka-adı eki hiç görünmez (yeni bir regresyon değil, önceden de fiilen hep boştu) | Partner başına async `PublicProfile.isPremium` fetch/cache ekle | Premium bir partnerin marka adı sohbet listesinde görünmeli |
| **BUG-M6** | 🟢 LOW | Hayır | Backend | `conversation.ts` | `markRead` | 343-360 | `readAt`/`readBy` thread'deki HER mesajda güncelleniyor, gönderenin kendi mesajları dahil, ayrım yapılmadan | EVET | Gürültü, yanlış bir "kim okudu" sinyali ÜRETMİYOR (readBy aktöre-özel), ama `readAt` düz alanı anlamsızlaşıyor | `message.senderEmail/senderProfileId == actor` olan mesajları readBy güncellemesinden hariç tut (opsiyonel, düşük öncelik) | — |

**Toplam confirmed bug: 7**
- 🔴 CRITICAL: **2** (BUG-M1, BUG-M3)
- 🟠 HIGH: **3** (BUG-M2, BUG-M4, BUG-M5)
- 🟡 MEDIUM: **1** (BUG-003A)
- 🟢 LOW: **1** (BUG-M6)

---

## 20 — Final Karar

### On soruya tek cümlelik cevap

1. **Mesaj neden gitmiyor?** Bir alt kümede, istemci-taraflı katılımcı çözümleme mantığı (`_normalizeParticipantsForSend`) eksik/belirsiz thread verisiyle karşılaşınca gönderimi ağa hiç çıkmadan sessizce durduruyor (BUG-M3); ayrıca aynı gönderim üç ayrı, tam örtüşmeyen doğrulama katmanından geçmek zorunda.
2. **Mesaj neden gelmiyor?** Gerçek zamanlı/websocket mekanizma yok; sohbet listesi yalnız manuel/lifecycle yenileniyor, sohbet detay ekranı yalnız açıkken 10 saniyede bir polling yapıyor — karşı taraf ekranı kapalıyken "gelmeme" hissi bu gecikme/manuel-yenileme bağımlılığından kaynaklanıyor.
3. **Mesaj DB'ye gerçekten kaydoluyor mu?** Doğrulama katmanlarını geçen istekler için EVET, kod kanıtlı gerçek bir `entityService.create` çağrısı.
4. **Conversation doğru oluşturuluyor mu?** Genelde evet (deterministik, unique-constraint'li); eşzamanlı ilk-mesaj race'inde teorik, stres-testiyle doğrulanmamış bir kırılganlık var (BUG-M5).
5. **Read/seen gerçekten kalıcı mı?** Backend'de kalıcı, ama istemci hiç okumuyor — gösterilen "okundu" ikonu tamamen sahte (BUG-M2, kesin kanıtlandı).
6. **Unread sayaç güvenilir mi?** Mekanizma olarak evet, tek kaynaklı ve tutarlı; doğruluğu yalnızca yukarıdaki gönderim/alım gecikmelerine bağlı.
7. **Notification gerçekten çalışıyor mu?** Kod zinciri gerçek ve sahte değil (message→notification→FCM push); FCM kimlik bilgilerinin canlı teslimatı bu ortamdan doğrulanamaz.
8. **Fotoğraf gerçekten destekleniyor mu?** HAYIR, ne şemada ne UI'da böyle bir özellik yok.
9. **İki cihaz/iki kullanıcı kullanımı güvenli mi?** HAYIR — BUG-M1 nedeniyle, kimlik doğrulaması olan herhangi bir kullanıcı başka bir gerçek kullanıcı adına mesaj gönderebilir.
10. **Release'e engel olan messaging bug'ları hangileri?** BUG-M1 (kimlik sahteciliği), BUG-M3 (sessiz gönderim engeli), BUG-M2 (sahte okundu göstergesi), BUG-M4 (sessiz kalıcı teklif-mesajı kaybı) — hepsi release blocker. BUG-M5 önerilir ama zorunlu değil (nadiren tetiklenir). BUG-003A ve BUG-M6 blocker değil.

### Karar

## **READY FOR FIX**

Kök nedenlerin tamamı kod kanıtıyla kesinleşti — hiçbiri tahmine dayanmıyor. Tek istisna BUG-M5 (race condition): mekanizma kesin kanıtlı ama gerçek tetiklenme sıklığı ancak eşzamanlı canlı/stres testiyle ölçülebilir; bu durum fix'i engellemez, sadece "confirmed by code" ile "confirmed live" arasındaki farkı dürüstçe işaretler.

Önerilen sıralama (M1→M2→M3 hattı en yüksek etkiye sahip, en düşük riskli/en izole fix'ler önce):
- **M1 (Fix Phase M-1):** backend-only, tek dosya, mevcut `message-ownership.ts` deseninin birebir kopyası — en düşük risk, en yüksek güvenlik etkisi.
- **M2 (Fix Phase M-1 veya M-2):** Flutter-only, model + iki UI dosyası, backend'e dokunmuyor (veri zaten var, `readAt`/`readBy` fetch edilip UI'ya bağlanacak).
- **M3 (Fix Phase M-2):** en karmaşık — üç katmanlı doğrulamanın birleştirilmesi/basitleştirilmesi gerekiyor, daha dikkatli bir tasarım kararı istiyor.
- **M4, M5, M6, BUG-003A (Fix Phase M-3):** daha izole, daha düşük risk.

Kod değiştirilmedi, commit yok, push yok, production mutation yok — mandat tam olarak uygulandı.
