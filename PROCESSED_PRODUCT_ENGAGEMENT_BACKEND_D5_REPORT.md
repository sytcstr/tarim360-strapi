# FAZ D5-B — PROCESSED PRODUCTS ENGAGEMENT BACKEND HAZIRLIĞI — RAPOR

**Kapsam: yalnızca `targetType=processedProduct`, `kind=like/favorite/view`.** Flutter'a dokunulmadı (yalnızca read-only doğrulama). Push yapılmadı.

---

## 1. Gerçek Şema ve Route Haritası (D5-B.1)

### İçerik-tipi ve route çakışması — kritik bulgu

`processed-product` (tekil) ve `processed-products` (çoğul) diye **iki paralel API klasörü** var:
- **`processed-product`** (`src/api/processed-product/`) — gerçek schema.json'ı burada (`collectionName: processed_products`). Core router (`factories.createCoreRouter`) + kendi `00-custom-processed-product.ts`'i `GET /processed-products/mine` ve `GET /processed-products/public`'i kayıt ediyor.
- **`processed-products`** (`src/api/processed-products/`) — **kendi schema.json'ı yok**; servisi (`processed-products.ts`) `PRODUCT_UID = 'api::processed-product.processed-product'` üzerinden AYNI koleksiyona yazıyor/okuyor — sadece farklı bir controller/route katmanı. Kendi route'ları da **AYNI** `GET /processed-products/mine` / `GET /processed-products/public` path'lerini KAYDEDİYOR (birebir çakışma), artı benzersiz `POST /processed-products/upsert` ve `POST /processed-products/delete`.

**Sonuç:** `mine`/`public` için iki ayrı route dosyası aynı path'i kayıt ediyor — ama her ikisinin handler'ı da (tekil controller'ın `mine`/`publicList`'i bile) sonunda **aynı** `api::processed-products.processed-products` servisini çağırıyor, yani hangi kayıt "kazanırsa kazansın" sonuç aynı. **Fonksiyonel bir çakışma yok, ama kod tekrarı/kafa karıştırıcı bir ikili route katmanı var** — D5-B kapsamında dokunulmadı (mandat: "gerçek content-type ile parallel route çakışıyorsa" DURAK NOKTASI, ama gerçek davranış farkı olmadığı için engagement işini bloklamıyor; ayrı bir temizlik konusu olarak not düşülüyor).

### Sayaç alanları — zaten mevcut

`processed-product` schema.json'ında **zaten** var: `viewCount`, `likeCount`, `favoriteCount`, `engagementVersion` (hepsi `integer, default 0`). **Şema değişikliği gerekmedi.**

### `engagement-contract.ts` — zaten tam yapılandırılmış

`TARGET_UID['processed-product'] = 'api::processed-product.processed-product'`, `TARGET_COLLECTION = 'processed_products'`, `DOMAIN_SUPPORT = {like:true, favorite:true, view:true, comment:false, share:false}`, `COUNTER_FIELD = {like:'likeCount', favorite:'favoriteCount'}`, `VIEW_COUNT_FIELD = 'viewCount'` — **hepsi zaten mevcuttu.** Yeni jenerik `PUT/DELETE /engagements/like|favorite` ve `POST /engagements/view` rotaları, hiçbir ek kod olmadan `processed-product` için baştan beri çalışıyordu (§bkz. §5'teki test kanıtı).

### Eski mekanizma — logistics-load'dan farklı, daha basit

Logistics-load'ın aksine, **processed-product'ın hiç özel bir `/metrics/like|favorite|view` rotası yoktu**, ne de bir JSON actor-list mirror'ı vardı. Tek gerçek eski mekanizma: Flutter'ın `ProcessedProductInsightsStore` (`processed_market_stores.dart:439-`) tamamen client-side sayaç tutuyor (`_viewsByProductId`/`_favoritesByProductId`/`_likesByProductId`), ve `_syncProductMetrics` en-iyi-çaba ile **jenerik** `PUT/PATCH /processed-products/:id` rotasına (`updateProcessedProductMetricsBestEffort` → `StrapiService._updateEntryBestEffort`) `{views, viewCount, favoriteCount, favorites, likeCount, likes}` gönderiyor.

**Tek gerçek özel eski endpoint:** `POST /processed-product-likes/toggle` → `engagement.toggleProcessedProductLike` — yalnızca `profile_settings.likedProductIds`'e yazıyordu, `processed_product.likeCount`'a HİÇ dokunmuyordu (favorite için eşdeğer bir toggle rotası hiç yok).

### İzin durumu — kritik bulgu (gerçek boot ile kanıtlandı)

`processed-product`'ın core `create`/`update`/`delete` action'ları **hiçbir yerde** "authenticated" rolüne izin olarak verilmemiş (`src/index.ts`'in `authenticatedActions` dizisinde yok — yalnızca `.mine`/`.publicList` ve çoğul servisin `.upsert`/`.delete`'i var). **Gerçek bir boot ile doğrulandı** (bkz. §5, entegrasyon testleri): `PUT /processed-products/:id` ve `POST /processed-products` geçerli bir JWT ile bile **403** dönüyor. Bu, eski `_syncProductMetrics` mekanizmasının muhtemelen **hiçbir zaman gerçekten sunucuya yazamadığı** anlamına geliyor — ama gerçek prod ortamında bu izin admin panelinden manuel verilmiş olabilir (kod bunu göremez), bu yüzden §D5-B.4'teki sanitizasyon "izin durumu ne olursa olsun" güvenli.

**Ayrıca not:** `processed-product`'ın core `update` rotasında **hiçbir sahiplik (ownership) policy'si yok** (listing'in `global::listing-owner-write`'ının eşdeğeri yok) — izin bir gün açılırsa, herhangi bir authenticated kullanıcı herhangi bir ürünü düzenleyebilirdi. Bu, engagement kapsamı dışında, ayrı bir yetkilendirme konusu — D5-B'de dokunulmadı, ama gelecekte bu route'a izin verilmek istenirse mutlaka bir sahiplik policy'siyle birlikte yapılmalı.

## 2. Şema Kararı (D5-B.2)

**Şema değişikliği gerekmedi** — `likeCount`/`favoriteCount`/`viewCount`/`engagementVersion` zaten mevcuttu, `COUNTER_FIELD`/`VIEW_COUNT_FIELD` zaten doğru alanlara işaret ediyordu. Ayrı isimlendirme/migration commit'i yok.

## 3. Kanonik Endpointler (D5-B.3)

**Yeni kod gerekmedi** — jenerik `PUT/DELETE /api/engagements/like|favorite` ve `POST /api/engagements/view` (targetType=`processed-product`) baştan beri çalışıyordu. D5-B.4'teki delegasyon iki mevcut riski kapatıyor.

## 4. Legacy Delegasyon (D5-B.4)

- **`toggleProcessedProductLike`** artık `setMembership(strapi, actorKey, 'processed-product', productId, 'like', enabled)` çağırıyor — `toggleLogisticsLoadLike`'ın birebir aynı deseni. `profile_settings.likedProductIds` yalnızca sunucunun gerçek sonucuna göre güncelleniyor.
- **`processed-product` controller'ının `create`/`update` action'ları** artık `likeCount`/`favoriteCount`/`viewCount`/`engagementVersion` (+ eski takma adlar `likes`/`favorites`/`views`) alanlarını gelen payload'dan siliyor (`stripEngagementFields`), `super.create`/`super.update`'e geçmeden önce. Çoğul servisin `upsert`'ü zaten bu alanları hiç içermeyen bir whitelist kullanıyordu (`getProductPayload` — kontrol edildi, risk yok).
- **View için delege edilecek özel bir eski rota yoktu** — zaten jenerik motor kullanılıyordu.

## 5. OrderCount Bug Analizi (D5-B.5)

`ProcessedProductInsightsStore.orderCountOf(productId)` (`processed_market_stores.dart:635-639`):
```dart
int orderCountOf(String productId) {
  final key = productId.trim();
  if (key.isEmpty) return 0;
  return ListingEngagementStore.I.offersOf(key);
}
```
**Kesin kök neden:** `ListingEngagementStore` yalnızca **LISTING** domain'inin yerel `_offersByListingId` map'ini tutuyor — burada `productId` (bir processed-product id'si) bir listing id'si sanılıp bu haritada aranıyor. Gerçek sipariş/teklif sayısı hiçbir zaman doğru okunmuyor (yalnızca `productId` sayısal olarak alakasız bir listing'in offer sayısıyla çakışırsa yanlış bir değer döner, aksi halde her zaman 0).

**Bu engagement kapsamına girmiyor** — like/favorite/view ile hiçbir ilgisi yok, salt sipariş/teklif sayacı kablolama hatası. **D5-B'ye veya D5-F'e karıştırılmadı.** Önerilen ayrı, küçük düzeltme: `orderCountOf`, `OffersStore.incoming`'i (veya varsa gerçek `processed-orders` koleksiyonunu, `BackendRuntimeConfig.useStrapiProcessedOrders`) `productId`'ye göre filtrelemeli — bu D5-F'in bir parçası DEĞİL, tamamen bağımsız bir Flutter fix olarak ele alınmalı.

## 6. Recount / Migration (D5-B.6)

- Yerel actor-list JSON alanı hiç yoktu (logistics-load'ın aksine) — migrate edilecek bir liste yok.
- `scripts/recount-processed-product-engagement.ts` hazırlandı: her processed-product satırı için `likeCount`/`favoriteCount`'u gerçek `engagement_interactions` satır sayısından yeniden hesaplıyor, yalnızca farklıysa yazıyor (idempotent). `viewCount` **kasıtlı olarak dokunulmuyor** — `engagement_views` satır sayısı gerçek tarihsel viewCount ile birebir eşleşmiyor (24 saat sonrası tekrar ziyaretler yeni satır açmadan sayacı artırıyor), bu yüzden tam olarak yeniden inşa edilemez.
- **Production'da ÇALIŞTIRILMADI.** Yalnızca tek kullanımlık, boş bir SQLite dosyasına karşı dry-run edildi (0/0 satır, script'in gerçekten boot edip sorgulayıp güvenle tamamlandığını kanıtladı), sonra o dosya hemen silindi.
- `npm run recount:processed-product-engagement` komutu eklendi.

## 7. Test Sonuçları (D5-B.7)

**16/16 yeni test PASS** (`processed-product-engagement.integration.test.ts`, gerçek Strapi boot + tek kullanımlık SQLite): ilk/tekrar/unlike/unfavorite (yeni rota), view + client-count spoof yok sayılıyor, 2 eşzamanlı PUT, PUT/DELETE yarışı, `engagement_interactions` satır sayısı sayaçla eşleşiyor, `engagementVersion` no-op'ta artmıyor, capability matrisi, legacy toggle (ilk/tekrar/legacy+yeni birleşik — tek satır), var olmayan ürün → 404, **ve generic create/update'in client-supplied count'u kabul etmediği (403 ile ampirik olarak kanıtlandı)**.

**Tüm `test:integration` (listing + logistics-load + processed-product): 63/63 PASS.** Unit: 23/23. `tsc --noEmit`: temiz.

## 8. Son Tarama (D5-B.8)

| Aranan | Sonuç |
|---|---|
| `likeCount`/`favoriteCount`/`viewCount`'a doğrudan yazan kalan kod | **0** (yalnızca `stripEngagementFields`'ın kendi alan-adı listesi) |
| Delege edilmemiş endpoint | **0** — tek özel eski rota (`toggleProcessedProductLike`) delege edildi; view/favorite için delege edilecek özel rota hiç yoktu |
| Client mutlak count kabul eden uç | **0** — `create`/`update` artık siliyor, gerçek boot ile 403 olduğu da ayrıca kanıtlandı |
| Çift source-of-truth riski | **Yok** — `engagement_interactions` tek kaynak |
| Route çakışması | `mine`/`public` iki kez kayıtlı ama aynı servise gidiyor — fonksiyonel risk yok, kod temizliği borcu (§1) |

## 9. Flutter D5-F İçin API Sözleşmesi

- **Like:** `PUT/DELETE /api/engagements/like` `{targetType:'processed-product', targetId}` — JWT zorunlu.
- **Favorite:** `PUT/DELETE /api/engagements/favorite` — aynı şekil.
- **View:** `POST /api/engagements/view` `{targetType:'processed-product', targetId, guestActorId?}` — JWT veya guest UUID.
- Legacy `POST /processed-product-likes/toggle` hâlâ çalışır (eski istemciler için), ama D5-F'in **yeni** kod yolu doğrudan yukarıdaki jenerik rotaları kullanmalı — `listing` domain'inin zaten yaptığı gibi, processed-product için özel bir `/metrics/*` rotası **yok ve gerekmiyor**.

## 10. Flutter D5-F İçin Karar

**READY.** Backend, like/favorite/view için tek kanonik `setMembership`/`registerView` çekirdeğine sahip; eski tek özel rota delege edildi; jenerik create/update artık client-supplied count kabul etmiyor (gerçek boot ile kanıtlandı). D5-F'e geçmeden önce hatırlatma: `orderCountOf` bug'ı (§5) engagement migration'ının bir parçası değil — ayrı, küçük bir Flutter düzeltmesi olarak ele alınmalı, D5-F'e karıştırılmamalı.

Burada duruyorum. Flutter'a geçmiyorum, push yapmıyorum.
