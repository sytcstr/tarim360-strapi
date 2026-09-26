# Agricultural price sources

Real market prices only. No mock, estimated or hard-coded prices anywhere in the
production path. If a real source is unavailable the price is empty.

## TOBB (primary source for grains, pulses, oilseeds, dried nuts)

- **Source:** TOBB Ticaret Borsaları Ürün Fiyat Bilgileri, <https://borsa.tobb.org.tr/>.
  Prices are entered by the commodity exchanges themselves and TOBB states they
  may be used when the source is cited. **Every observation carries that
  attribution** (`sourceName` = "<Exchange> (TOBB)", `provider` = `tobb`,
  `sourceUrl` = the TOBB page, `observedAt` = TOBB "Son İşlem Tarihi",
  `fetchedAt` = our UTC fetch time).
- **Page contract:** `fiyat_urun3.php?ana_kod=<n>&alt_kod=<n>` lists, per
  exchange: last trade time, min / max / average price (TL), quantity, number of
  trades and amount (TL), in the unit shown in the title (mostly KG).
  Numbers use Turkish format (`.` thousands, `,` decimals).
- **Parser:** the table header must match the verified column layout exactly and
  the header unit must equal the title unit, otherwise the page is rejected
  (fail closed). Pages with the text "Bu ürün için veri girişinde
  bulunulmamıştır" are "no data", not errors.
- **Canonical price:** `price = averagePrice` (TOBB average). It is never derived
  from min/max. Unit: TRY per kg (only KG and TON->KG are converted; ADET/KASA/... are rejected).
- **Row validation:** `quantity x average` must reproduce the reported amount
  (tolerance 25%). Real data is bimodal: valid rows are within ~1.5% of the
  amount, corrupt rows are off by exactly 1000x (e.g. Eskişehir enters TL/ton in the
  KG column, quantities typed without the thousands dot) and are rejected.
  Future dates, invalid dates and rows older than 60 days
  (`DEFAULT_MAX_INGEST_AGE_DAYS`) are not ingested.
- **Freshness classes** (`freshness.ts`, the price is never altered):
  fresh <= 7 days, stale 8-30 days, very_stale > 30 days.
- **Deduplication:** `dedupeKey = tobb:<ana>-<alt>:<exchange>:<observedAt UTC>:kg`.
  Existing keys are skipped; `unique` is enforced by the Strapi document
  service (a draft-and-publish type keeps draft+published rows, so there is no
  raw DB unique index); runs are serialised in-process.
- **Exchange -> province:** deterministic table
  `src/seeds/data/tobb-exchange-province-map.json` (112 exchanges, district
  exchanges such as Akşehir/Ilgın -> Konya, Bandırma -> Balıkesir are explicit).
  An unknown exchange gets `province = null`; nothing is matched by substring.
- **National price:** none. Per-exchange observations are the raw truth; no
  averaging into a "Türkiye fiyatı".
- **Fetch policy:** one page per auto-mapped product (9 pages), sequential,
  >= 2 s between requests, 20 s timeout, 2 retries with backoff on 5xx/429/network
  (never on 4xx), 2 MB cap, User-Agent `Tarim360 agricultural data service`.
  Twice a day (`AGRI_REAL_PRICE_CRON`, default `20 5,14 * * *` UTC).
- **TLS:** the TOBB server omits its intermediate certificate, so Node fails with
  UNABLE_TO_VERIFY_LEAF_SIGNATURE. Verification stays ON; the public Sectigo
  intermediate (`tobb/tls.ts`) is added to the trust list. If TOBB changes CA the
  fetch fails closed.
- **Failure behaviour:** a failed provider writes nothing, deletes nothing and
  invents nothing; existing observations are untouched.

### Modes (`AGRI_REAL_PRICE_INGESTION_MODE`)

| Mode | Network | DB read | DB write |
|---|---|---|---|
| `off` (default) | no | no | no |
| `dry-run` | yes | yes | no |
| `apply` | yes | yes | create only (valid, deduplicated, reference rows must exist) |

`AGRI_REAL_PRICE_RUN_ON_BOOT=true` runs one pass ~45 s after boot (useful for the
first production dry-run). The mock ingestion remains hard-disabled in production.

## Coverage of the 52 reference products

Match confidence: EXACT / SAFE_ALIAS are ingested automatically; AMBIGUOUS
(several variants/forms) and NO_MATCH are **not**.

- **A. Automatic from TOBB: 9**
- **B. In TOBB but a variant decision is needed: 14**
- **C. Fresh fruit/vegetable, HKS/hal needed: 18**
- **D. Other source needed: 11**
- Total: 52

### A - automatic
| Code | Product | Confidence | TOBB item | Notes |
|---|---|---|---|---|
| CAVDAR | Çavdar | EXACT | ÇAVDAR (1/301) | Plain "ÇAVDAR"; the 2./3. GRUP items are grade variants and are not used. |
| YULAF | Yulaf | EXACT | YULAF (1/801) | Plain "YULAF"; 1./2. GRUP items are grade variants and are not used. |
| CELTIK | Çeltik | EXACT | ÇELTİK (1/403) | Exact name. |
| DARI | Darı | SAFE_ALIAS | DARI NATÜREL (1/501) | "DARI NATÜREL": the only millet item (natural = unprocessed). |
| NOHUT | Nohut | EXACT | NOHUT (3/704) | Plain "NOHUT"; İSPANYOL/KALBURALTI/NATÜREL/SIRA/TÜYLÜ are variants and are not used. |
| YESIL_MERCIMEK | Yeşil Mercimek | EXACT | MERCİMEK YEŞİL (3/609) | "MERCİMEK YEŞİL"; SULTANİ (608) is a distinct variety and is not used. |
| KANOLA | Kanola | EXACT | KANOLA (4/402) | Exact name. |
| SOYA_FASULYESI | Soya Fasulyesi | EXACT | SOYA FASULYESİ (4/501) | Exact name. |
| FIG | Fiğ | EXACT | FİĞ (3/201) | "FİĞ" (listed under bakliyat in TOBB, the same commodity). |

Currently without TOBB rows (page says no data): Çeltik, Darı, Soya Fasulyesi.

### B - decision needed
| Code | Product | Confidence | TOBB item | Notes |
|---|---|---|---|---|
| BUGDAY | Buğday | AMBIGUOUS | 23 variants | Anadolu kırmızı sert / beyaz / ekmeklik / durum / yemlik and grades: no single "Buğday". |
| ARPA | Arpa | AMBIGUOUS | 7 variants | Beyaz (grup), biralık, yemlik, çakır, barem dışı: no single "Arpa". |
| MISIR | Mısır | AMBIGUOUS | 4 variants | Sarı / beyaz / karışık / kuru: no single "Mısır". |
| KURU_FASULYE | Kuru Fasulye | AMBIGUOUS | 9 variants | Natürel vs many bean varieties. |
| KIRMIZI_MERCIMEK | Kırmızı Mercimek | AMBIGUOUS | 2 variants | Kabuklu (raw) vs kırılmış iç (processed). |
| BAKLA | Bakla | AMBIGUOUS | 2 variants | Kabuklu vs iç. |
| AYCICEGI | Ayçiçeği | AMBIGUOUS | 2 variants | Tohumluk (planting seed) vs yağlık (oil crop). |
| PATATES | Patates | AMBIGUOUS | 2 variants | Eski ürün vs yeni ürün (season variants). |
| PAMUK | Pamuk | AMBIGUOUS | 14 variants | Çekirdekli (by region) vs roll/lint grades. |
| HASHAS | Haşhaş | AMBIGUOUS | 3 variants | Haşhaş tohumu by colour (mavi/beyaz/sarı). |
| FINDIK | Fındık | AMBIGUOUS | 12 variants | Kabuklu (tombul/sivri) vs iç by calibre/grade. |
| ANTEP_FISTIGI | Antep Fıstığı | AMBIGUOUS | 5 variants | Kabuklu vs iç (boz/sarı/yeşil). |
| CEVIZ | Ceviz | AMBIGUOUS | 2 variants | Kabuklu vs iç. |
| BADEM | Badem | AMBIGUOUS | 1 variants | Only "BADEM İÇ" (shelled kernel) is listed; whether that is the intended product needs a decision. |

### C - fresh produce (HKS / hal)
| Code | Product | Confidence | TOBB item | Notes |
|---|---|---|---|---|
| BEZELYE | Bezelye | NO_MATCH | - | Fresh pea (hal/HKS); TOBB lists no pea item. |
| DOMATES | Domates | NO_MATCH | - | Fresh vegetable (hal/HKS). |
| BIBER | Biber | NO_MATCH | - | Fresh vegetable (hal/HKS). |
| SOGAN | Soğan | NO_MATCH | - | Fresh vegetable (hal/HKS). |
| SALATALIK | Salatalık | NO_MATCH | - | Fresh vegetable (hal/HKS). |
| PATLICAN | Patlıcan | NO_MATCH | - | Fresh vegetable (hal/HKS). |
| HAVUC | Havuç | NO_MATCH | - | Fresh vegetable (hal/HKS). |
| LAHANA | Lahana | NO_MATCH | - | Fresh vegetable (hal/HKS). |
| ELMA | Elma | NO_MATCH | - | Fresh fruit (hal/HKS). |
| UZUM | Üzüm | NO_MATCH | - | Fresh grape (hal/HKS); TOBB lists only dried raisins. |
| PORTAKAL | Portakal | NO_MATCH | - | Fresh fruit (hal/HKS). |
| MANDALINA | Mandalina | NO_MATCH | - | Fresh fruit (hal/HKS). |
| LIMON | Limon | NO_MATCH | - | Fresh fruit (hal/HKS). |
| KIRAZ | Kiraz | NO_MATCH | - | Fresh fruit (hal/HKS). |
| KAYISI | Kayısı | NO_MATCH | - | Fresh apricot (hal/HKS); TOBB lists only dried apricot, a different product. |
| SEFTALI | Şeftali | NO_MATCH | - | Fresh fruit (hal/HKS). |
| NAR | Nar | NO_MATCH | - | Fresh fruit (hal/HKS). |
| MUZ | Muz | NO_MATCH | - | Fresh fruit (hal/HKS). |

### D - other source
| Code | Product | Confidence | TOBB item | Notes |
|---|---|---|---|---|
| TRITIKALE | Tritikale | NO_MATCH | - | No triticale item in TOBB. |
| SUSAM | Susam | NO_MATCH | - | No sesame item in TOBB. |
| ASPIR | Aspir | NO_MATCH | - | No safflower item in TOBB. |
| YER_FISTIGI | Yer Fıstığı | NO_MATCH | - | No peanut item in TOBB. |
| SEKER_PANCARI | Şeker Pancarı | NO_MATCH | - | Contract crop (no exchange price). |
| TUTUN | Tütün | NO_MATCH | - | Regulated/contract crop (no exchange price). |
| CAY | Çay | NO_MATCH | - | Contract crop (no exchange price). |
| KESTANE | Kestane | NO_MATCH | - | No chestnut item in TOBB. |
| YONCA | Yonca | NO_MATCH | - | No item (küspeler group is empty). |
| KORUNGA | Korunga | NO_MATCH | - | No item in TOBB. |
| SILAJLIK_MISIR | Silajlık Mısır | NO_MATCH | - | Silage maize is not an exchange commodity. |

## HKS (Ticaret Bakanlığı Hal Kayıt Sistemi)

**HKS_API_STATUS = UNVERIFIED.** HKS publishes national daily fruit/vegetable
price and quantity information on public web pages (hal.gov.tr), and the İBB
open-data portal has a separate Istanbul hal web service. No documented public
API, terms of use or stable contract for the national data was found, so no
scraper or endpoint was written or guessed. Next step: confirm the access method
and licence with the Ministry (HKS call centre 444 0 425) before any code.

## TÜİK

Tarım-ÜFE is a monthly producer price *index*. It is not a daily spot price and
must not create `agri-price-observation` rows; it can become a separate
analytics/trend provider later.

## Open-Meteo

Unchanged: the commercial-licence blocker in `docs/production-readiness.md`
still applies.
