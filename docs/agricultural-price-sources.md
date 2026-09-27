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
- **Fetch policy:** one page per auto-mapped product (13 pages), sequential,
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

- **A. Automatic from TOBB: 13**
- **B. In TOBB but a variant decision is needed: 10**
- **C. Fresh fruit/vegetable, HKS/hal needed: 18**
- **D. Other source needed: 11**
- Total: 52

Real crop coverage phase (2026-09-27): MISIR, AYÇİÇEĞİ, PATATES and BADEM were
promoted B -> A after a live check showed each has exactly one TOBB variant that
actually trades (the others are permanently no-data), so picking that one
variant carries no "wrong crop" risk. Every other B-class product still has
**two or more genuinely active variants** (real, current trades on more than
one item) and stays AMBIGUOUS -- picking one would be a real product decision,
not a mapping fix.

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
| **MISIR** | Mısır | **SAFE_ALIAS** | MISIR SARI (1/601) | Only "SARI" (yellow/dent, the standard commercial corn) trades; BEYAZ/KARIŞIK/KURU are permanently no-data. Live 2026-09-27: 5 rows, Bandırma valid+fresh. |
| **AYCICEGI** | Ayçiçeği | **SAFE_ALIAS** | AYÇİÇEĞİ YAĞLIK (4/602) | Only "YAĞLIK" (oil-type, the commercial crop) trades; TOHUMLUK (planting seed, a different market) is permanently no-data. Live 2026-09-27: 6 rows, 4 valid (Bandırma/Çorum/Sungurlu/Uzunköprü). |
| **PATATES** | Patates | **SAFE_ALIAS** | PATATES YENİ ÜRÜN (8/102) | ESKİ/YENİ ÜRÜN is season labelling (carry-over stock vs current harvest), not a crop/form variant -- the same commodity. YENİ ÜRÜN is the current-season row; ESKİ ÜRÜN's only row is 60+ days old (permanently too-old). Live 2026-09-27: Nevşehir, valid. |
| **BADEM** | Badem | **SAFE_ALIAS** | BADEM İÇ (9/902) | TOBB lists only the shelled-kernel form for almonds -- nothing to be ambiguous against. Live 2026-09-27: Gaziantep, valid+fresh. |

Currently without TOBB rows (page says no data): Çeltik, Darı, Soya Fasulyesi.

### B - decision needed
| Code | Product | Confidence | TOBB item | Notes |
|---|---|---|---|---|
| BUGDAY | Buğday | AMBIGUOUS | 23 variants | Anadolu kırmızı sert / beyaz / ekmeklik / durum / yemlik and grades: no single "Buğday". Live 2026-09-27: 22/23 variants trade -- too many active grades to pick one safely. |
| ARPA | Arpa | AMBIGUOUS | 7 variants | Beyaz (grup), biralık, yemlik, çakır, barem dışı: no single "Arpa". Live: 5/7 variants trade. |
| KURU_FASULYE | Kuru Fasulye | AMBIGUOUS | 9 variants | Natürel vs many bean varieties (Dermason, Barbunya, ...). Live: 3/9 trade -- genuinely different bean types, not grades of one crop. |
| KIRMIZI_MERCIMEK | Kırmızı Mercimek | AMBIGUOUS | 2 variants | Kabuklu (raw/whole) vs kırılmış iç (split, processed) -- a real form difference with a real price difference; both currently trade. |
| BAKLA | Bakla | AMBIGUOUS | 2 variants | Kabuklu vs iç (same form distinction as above); currently no-data on both. |
| PAMUK | Pamuk | AMBIGUOUS | 14 variants | Çekirdekli (seed cotton, by region) vs roll/lint grades -- two different markets. Live: only 2/14 trade, and both rejected (too-old) -- no usable data either way today. |
| HASHAS | Haşhaş | AMBIGUOUS | 3 variants | Haşhaş tohumu by colour (mavi/beyaz/sarı) -- real, separately-priced varieties. Live: 2/3 trade (beyaz, sarı). |
| FINDIK | Fındık | AMBIGUOUS | 12 variants | Kabuklu (tombul/sivri) vs iç by calibre/grade -- form + grade both vary the price. Live: only 1/12 trades, and it is rejected (too-old) -- no usable data today. |
| ANTEP_FISTIGI | Antep Fıstığı | AMBIGUOUS | 5 variants | Kabuklu vs iç (boz/sarı/yeşil) -- shell/kernel is a large price difference. Live: 4/5 trade. |
| CEVIZ | Ceviz | AMBIGUOUS | 2 variants | Kabuklu (whole, in shell) vs iç (kernel) -- kernel trades several times the whole-nut price; picking one would misrepresent "Ceviz" as whichever form was chosen. Live: only İç currently trades (fresh); Kabuklu is too-old today, so the risk is about tomorrow's data, not today's. |

Rows dropped from B in this phase (now A): MISIR, AYÇİÇEĞİ, PATATES, BADEM
(see the A table). Reference: the pre-phase classification was A=9, B=14.

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
| Code | Product | Confidence | Real source investigated | Verdict |
|---|---|---|---|---|
| TRITIKALE | Tritikale | NO_MATCH | TOBB (no item); no other exchange found | BLOCKED |
| SUSAM | Susam | NO_MATCH | TOBB (no item); no other exchange found | BLOCKED |
| ASPIR | Aspir | NO_MATCH | TOBB (no item); no other exchange found | BLOCKED |
| YER_FISTIGI | Yer Fıstığı | NO_MATCH | TOBB (no item); no other exchange found | BLOCKED |
| KESTANE | Kestane | NO_MATCH | TOBB (no item); no other exchange found | BLOCKED |
| YONCA | Yonca | NO_MATCH | TOBB (küspeler grubu boş); no other exchange found | BLOCKED |
| KORUNGA | Korunga | NO_MATCH | TOBB (no item); no other exchange found | BLOCKED |
| SILAJLIK_MISIR | Silajlık Mısır | NO_MATCH | Not an exchange commodity (on-farm/contract feed use) | BLOCKED |
| SEKER_PANCARI | Şeker Pancarı | NO_MATCH | Türkiye Şeker Fabrikaları A.Ş. / pancar kotası: a regulated per-factory delivery price under a farming contract, not an open-market spot trade | BLOCKED -- would be a contract price mislabelled as spot |
| TUTUN | Tütün | NO_MATCH | Regulated under 4733 sayılı Kanun / TAPDK licensing; sold under buyer contracts, no public spot exchange | BLOCKED -- would be a contract price mislabelled as spot |
| CAY | Çay | NO_MATCH | ÇAYKUR publishes an annual taban fiyat (state floor price), not a traded spot price | BLOCKED -- a floor/reference price is not a market spot price (same reasoning the brief gives for TMO) |

None of the 11 have a genuine, citable open-market spot-price source today. No
endpoint was written or guessed for any of them.

## HKS (Ticaret Bakanlığı Hal Kayıt Sistemi)

**HKS_API_STATUS (national, Ticaret Bakanlığı) = UNVERIFIED.** hal.gov.tr
publishes national daily fruit/vegetable price and quantity information on
public web *pages*. No documented public API, developer portal, terms of use
or stable machine-readable contract for the **national** data was found in
this pass either. Next step: confirm the access method and licence with the
Ministry (HKS call centre 444 0 425) before any code.

**A real, separate, documented API exists for Istanbul only:** the İBB Open
Data Portal's "Hal Ürünleri ve Fiyatları Web Servisi"
(<https://data.ibb.gov.tr/dataset/hal-urunleri-ve-fiyatlari-web-servisi>),
published under the İBB Open Data Licence, with a Swagger UI at
`https://halfiyatlaripublicdata.ibb.gov.tr/swagger/ui/index` (loads, HTTP 200).
It covers only Istanbul's Bayrampaşa hal (not national) and its dataset page
was last updated 2022-04-04. **The Swagger backend endpoint itself
(`/swagger/docs/v1`, referenced by the UI's own config) could not be reached
from this environment** -- both curl and Node's fetch complete the TLS
handshake and then have the connection closed before any HTTP response
(`schannel: server closed abruptly` / `UND_ERR_SOCKET`), consistent with a
bot/geo/WAF filter rather than the service being down (the UI page itself
loads fine). **No response schema was ever obtained, so no adapter was
written or guessed** -- this stays BLOCKED on the same "API contract not
verified" rule as the national HKS, and if it were reachable it would only
cover Istanbul, not the national coverage the brief asks for.

What would unblock either path: for the national HKS, a documented API or a
data.gov.tr dataset from the Ministry; for the İBB service, successfully
retrieving `/swagger/docs/v1` (or its JSON) from a network path that is not
filtered, to see the actual fields/methods before writing anything.

## TMO (Toprak Mahsulleri Ofisi)

Not used as a source for any of the 52 products in this phase. TMO publishes
its own *alım fiyatı* (intervention/purchase price) for a few strategic crops
(mainly wheat and barley, which this app already sources from TOBB's real
market trades). Per the brief's own rule, an intervention/purchase price is
not a market spot price and must not be labelled as one -- it was not
substituted for or blended with the TOBB observations.

## TÜİK

Tarım-ÜFE is a monthly producer price *index*. It is not a daily spot price and
must not create `agri-price-observation` rows; it can become a separate
analytics/trend provider later.

## Open-Meteo

Unchanged: the commercial-licence blocker in `docs/production-readiness.md`
still applies.
