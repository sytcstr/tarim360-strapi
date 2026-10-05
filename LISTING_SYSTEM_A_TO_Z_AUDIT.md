# TARIM360+1 — LISTING SYSTEM A–Z PRODUCT + ARCHITECTURE + UX AUDIT

Backend: `C:\projeler\tarim360-strapi` · Flutter: `C:\projeler\tarim360` · Branch (both): `main` · Release: `1.0.83+114`

Read-only audit. No code was changed, nothing was committed, nothing was pushed, nothing was deployed.

Method: 7 parallel read-only research passes covering all 38 requested sections, each independently verifying claims against current source (file:line), not against memory of past reports. Findings below are synthesized from all 7, cross-checked against each other where they overlapped (e.g. three passes independently confirmed the same 3 dead card widgets).

**A note on scope of detail**: this audit surfaced roughly 70 distinct, citable findings. Giving every one of them the full 11-field treatment the mandate specifies would make this document unusable as a reference. The ~28 findings that are P0/P1 (real bugs, real architecture root-causes, the clearest dead-code) get the full field set. The remaining UX/ARCH/DEAD/PRODUCT-GAP tail is presented in condensed tables that still carry severity, screen, current/expected, blocker status, and fix — nothing is dropped, just formatted for scanability.

---

## FINAL DECISION: **TARGETED IMPROVEMENTS REQUIRED**

The listing system's *security* and *transactional integrity* layers (ownership, quota, idempotency, premium/rocket spoof protection) are genuinely solid — re-verified end to end against current code and 351 passing integration tests, zero regressions. The *day-to-day product experience*, however, has accumulated real technical debt over many incremental fix passes: one confirmed **data-loss bug** in editing, a fractured card-component architecture (9 live cards, ~0 shared visual components, 3 confirmed-dead cards), search/filter/sort that silently stops being globally correct once the catalog grows past what's cached on-device, a wrong Turkish price format on the two most-used verticals, and a real gap in how buyers reach sellers (no call/WhatsApp path exists at all). None of this requires "MAJOR REDESIGN" — the data model, the security policies, and the core send/receive/offer/favorite mechanics are sound. But it is not "HEALTHY" either: a professional listing app in 2026 should not have an edit screen that silently discards a seller's saved data, or nine near-identical card widgets with no shared component.

---

# PART 1 — SYSTEM MAP (Sections 1–3)

## 1. Full inventory (condensed — see full agent detail for exhaustive file:line)

**Flutter — LIVE**: `ProfileProduct` model, `MainType`/category enum, `ListingsStore` (+ `ListingPendingSyncQueue`), `ListingPinStore`, `ListingEngagementStore`, `_SearchCache`, `CreateListingPage`, `ListingDetailPage`, `CategoryListingsPage`, `_CategoryVitrinPage`, `_GeneralListingManagementPage`, `SearchListingsPage`, `PopularListingsPage`, `ActiveRocketListingsPage`, `ExpiredAdsPage`, plus 9 live card widgets (Section 11) and 2 ad hoc inline card builders.

**Flutter — DEAD**: `FeaturedListingsPage`, `PendingListingsPage` (full pages, zero external callers), `_PremiumHorizontalListingCard`, `_HomeFeaturedListingCard`, `_SearchListingRowCard` (widgets, zero callers), `EngagementBar`/`EngagementAction` (built as "the" shared engagement widget, never adopted), the entire comment/share engagement client slice (`createListingComment`/`createShareIntent` — backend fully functional, zero UI entry point).

**Backend — LIVE**: `listing` content-type/controller/service/routes/policy, `listing-create-operation` (idempotency ledger), `rocket-activation`, `listing-comment`, `listing-share`, `listing-metrics.ts` (shared quota/protected-fields/counter utils), the generic `engagement`/`engagement-v1` subsystem.

**Backend — LEGACY**: `listing-view` content-type/controller — the app now exclusively posts to `/api/engagements/view`; `listing-view` survives only for old app builds still hitting the old route.

**Backend — DEAD (in effect)**: the `status` enum's `pending`/`rejected` values — nothing in the entire backend ever sets a listing to either; every create force-sets `status:'active'` with an immediate `publishedAt`. There is no moderation queue behind this enum today.

**Critical structural finding**: the category system has quietly forked into **three independent product verticals** (general listings; İşlenmiş Ürünler/processed products — its own content-types, own Flutter feature module; Nakliyat & Lojistik — same pattern) while the `MainType` enum still declares all 5 values and the generic listing's attribute-enrichment switch still carries full (dead) branches for the 2 that split off. `home_page.dart`'s category-tap switch has two literally unreachable `case` branches as a direct result.

## 2. Data model — the two duplicate-field pairs and the fallback-chain problem

The single most consequential architectural finding of this audit: **`ListingsStore._fromStrapiRow`'s parser searches up to 4 alternate key names for nearly every field** (`['id','documentId']`, `['ownerProfileId','ownerId','profileId','requestedByProfileId']`, `['mainType','mainCategory','main_type','categoryType']`, etc. — ~30 such fallback chains, fully enumerated in the agent's report). Cross-checking every alternate key against the actual `schema.json`: **the large majority of the alternate keys do not exist in the schema at all** (`requestedByEmail`, `submitter`, `profileId`, `mainCategory`, `categoryName`, `animalAge`, `equipCondition`, `logisticsRoute`, `processedProdDate`, etc.). This means whole branches of `_enrichListingAttrsFromRow` (the hayvancılık/tarımsal-aletler/nakliye/işlenmiş-ürünler attribute mapping) are **permanently no-op dead code** — written defensively for a per-category schema shape that was apparently planned but never actually built on the backend.

**The two real duplicate-field pairs, both always written identically by every code path found:**
- `ownerProfileId` / `ownerId` — same value, same call sites, no code anywhere differentiates them.
- `isPremiumOwner` / `isPremium` — same pattern.

**Other schema smells**: `hasatYear` (int) / `hasatDate` (string) — two "when harvested" fields treated as interchangeable by the client; no `unique:true` on `listingNo` despite the UI presenting it as a permanent public ID (client works around this with a hash-and-backfill-retry subsystem); no field at all is `required:true` at the DB layer, so a raw API POST could create a titleless, priceless, photoless listing; no lat/lng coordinate field despite a marketplace generally benefiting from geo search.

## 3. Categories — confirmed fractured, not unified

Only **Tarım, Hayvancılık, Tarımsal Aletler** are actually creatable/browsable through the generic listing flow (`general_listing_management_page.dart`'s own `_categorySpecs` const list contains only these 3). İşlenmiş Ürünler and Nakliye & Lojistik are explicitly redirected away in both `create_listing_page.dart` (SnackBar + pop) and `category_listings_page.dart`/`home_page.dart` (silent substitution to a different page/widget tree entirely) — confirming they are genuinely separate products sharing only a home-screen icon grid, not a shared data model. Category display strings are hardcoded independently in 3 places (canonical `listing_category.dart`, a dead duplicate in `featured_listings_page.dart`, a real 3-of-5 subset in `general_listing_management_page.dart`), and the backend enforces nothing about valid category values (`mainType`/`subType` are plain, unconstrained strings).

---

# PART 2 — CREATE / EDIT / DELETE (Sections 4–10)

## 4–6. Creation flow

One continuous scrollable form, not a multi-step wizard — confirmed by reading the actual `build()` method. Profile info (name/city/email) is correctly auto-filled from session and never re-asked. **No phone/WhatsApp field exists anywhere in the create flow** — contact is exclusively via in-app chat/offer. Category-specific fields **do** genuinely change per `MainType` (a real `switch` renders different widgets for Tarım/Hayvancılık/Tarımsal Aletler) — but depth is uneven: Tarım gets 10 rich fields, Hayvancılık gets only age+weight, Tarımsal Aletler gets only condition+hours+year. `subType` (the dropdown within a category) is purely cosmetic — it never gates which additional fields render. No field anywhere is visually marked as required (no asterisk, no "zorunlu" label) — the user only learns a field was mandatory by submitting and reading the error. Validation coverage is uneven: core fields have real `Form` validators; **every category-specific dynamic field for Hayvancılık and Tarımsal Aletler has no validator at all** — they can be submitted empty or with garbage content and the listing still publishes.

## 7. Photo system

Gallery-only picker (no camera, no video despite the backend schema allowing video/audio media). Real client-side compression (1280×1280 @ q82) — no raw-upload risk. Max 5 photos enforced client-side only (no server cap). Cover-photo selection exists; full drag-reorder does not. Upload is one atomic multipart call before create — no partial-photo-failure state. **Real orphaned-media risk, confirmed**: if photos upload successfully but the subsequent listing-create call is then rejected (e.g. quota exceeded), the uploaded files remain permanently orphaned in Strapi's media library with no cleanup code anywhere. **Photo deletion during edit and listing hard-delete never actually delete the underlying Strapi media file** — only the relation is dropped; every removed/replaced photo becomes a permanent orphan.

## 8. Create atomicity / idempotency — re-verified, solid

Ran the live integration suite (not just read the code): **14/14 pass** for exactly the scenarios required — double-tap, timeout+retry same operationId, different operationId, 5-way concurrency, offline-sync-path idempotency, and the account-switch scenario (a queued draft from user A is correctly paused, never submitted under user B, both client- and server-side). No gap found here.

## 9. Editing — **the audit's single most serious bug**

### LISTING-BUG-001 — Editing a listing silently discards its own saved category-specific data
- **Severity**: **CRITICAL (P0)**
- **Live caller**: `CreateListingPage.initState()` (`lib/features/listings/pages/create_listing_page.dart:103-159`), reached via `hesabim_page.dart:505` (`CreateListingPage(initial: p, ...)`)
- **Affected screen**: İlan Düzenleme (Edit Listing) — reachable from "İlanlarım"
- **Current behavior**: `initState` hydrates only mode/category/title/description/price/location/photos from the listing being edited. It never touches `harvestDateText`, `qualityGrade`, `moisturePercent`, `proteinPercent`, `certificateType`, `analysisNote`, `packaging`, `storageState`, `deliveryType`, `minOrder`/`minOrderUnit`, `animalAge`, `animalWeight`, `equipCondition`, `equipWorkHour`, `equipModelYear` — these fields stay at their hardcoded defaults. `_buildPayload()` unconditionally includes all of them in every update request. **Opening "Düzenle" on a real Tarım listing with saved moisture:12, protein:13.5, packaging:'BigBag' and tapping "İlanı Güncelle" without touching a single dynamic field silently overwrites those real values with the form's defaults ('A', blank, 'Dökme', etc.).**
- **Root cause**: structural, not a simple oversight — `ProfileProduct` (the Flutter domain model) has no fields at all to carry these values back out of Strapi; `_fromStrapiRow` only ever maps them into a generic display-only `attrs: Map<String,String>?`, never into typed model fields `initState` could read from.
- **User impact**: a farmer who edits their listing to fix a typo in the title, without touching anything else, unknowingly wipes their quality/certificate/packaging/storage/delivery data. This is real, reproducible data loss on the single most quality-differentiating information a produce listing carries.
- **Technical debt impact**: fixing this properly requires extending `ProfileProduct` with the missing fields and updating `_fromStrapiRow`, not just patching `initState` — the model itself is incomplete.
- **Release blocker?**: Yes for a "healthy" rating, though not a P0 for the *already-shipped* 1.0.83+114 build (it's a pre-existing, silent bug, not a new regression) — should be the very next fix before broad marketing of the edit feature.
- **Minimum fix**: add the missing fields to `ProfileProduct`, populate them in `_fromStrapiRow` from the real Strapi row, and hydrate them in `initState` exactly like the fields that already work correctly.
- **Fix scope**: Medium — one model file, one parser, one initState, no schema/backend change needed (the backend already stores and returns these fields correctly).

Same section also confirmed clean: owner identity and all protected fields (counts, isPremium, isDoping, rocketEndsAt) are correctly force-derived server-side and cannot be altered via an edit request — this part of edit security is solid.

## 10. Delete / archive / publish

Only 2 real lifecycle actions exist: Edit and hard-Delete. **"Pasife Al" (deactivate) was confirmed already removed** (verified against current code, not just the historical report) — it used to call the exact same handler as delete, so removing the mislabeled duplicate was correct. "Sil" genuinely hard-deletes via Strapi's default `destroy` (no controller override) for the primary path; its soft-delete fallback path is **effectively broken** — it references a `'archived'` status value and `deleted`/`isDeleted`/`deletedAt` fields that don't exist anywhere in the schema, so that fallback would itself fail validation (rarely exercised in practice since the primary hard-delete usually succeeds). The `status` moderation enum (`pending`/`active`/`rejected`) is fully vestigial — every listing auto-publishes instantly, no moderation gate exists despite the schema implying one was planned.

---

# PART 3 — CARDS (Sections 11–14)

## 11–12. Card inventory and the duplication problem

**9 live general-listing card widgets** (`_ProductCard`, `_AllListingRowCard`, `_UnifiedListingRowCard`, `_HomeCompactListingCard`, `_PremiumProductCard`, `_PremiumWideCard`, `_VitrinListingCard`, `_HomePopularHeroCard`, `_PopularEntryRowCard`) plus **2 ad hoc inline card-building methods** duplicated a third time inside `general_listing_management_page.dart` and `hesabim_page.dart`. Two other verticals (logistics: 17 card classes, processed products: 14) show the identical duplication disease — except processed products' `_ProcessedUnifiedCard` is proof the codebase *does* know how to do this correctly (a single widget parameterized by a `_ProcessedCardLayout` enum), just not applied to general listings.

### LISTING-ARCH-001 — Zero shared visual components across 9 near-identical card widgets
- **Severity**: HIGH (P1, architecture)
- **Current state**: image-loading branch logic duplicated 7×, category-accent-color switch duplicated with **an actual color-value discrepancy between copies** (`nakliyeLojistik` renders `0xFF2F5E7E` in the canonical helper but `0xFF1B263B` in two duplicated copies), the favorite-button (InkWell+Icon) rebuilt independently **9 times** with icon sizes ranging `sp(12)`–`sp(20)` and inconsistent shapes/opacities, and the PREMIUM/ROKETLI pill badge rebuilt near-identically 5 times.
- **User impact**: inconsistent visual polish across screens showing "the same kind of thing" — a favorite icon looks and feels different on the search page vs. the favorites page vs. the profile page.
- **Technical debt impact**: every visual tweak (e.g. "make the favorite icon bigger") must be repeated in up to 9 places; the accent-color bug above is a direct, live symptom of this.
- **Release blocker?**: No.
- **Minimum fix**: do NOT implement in this phase (audit only) — see Part 4 for the concrete proposed component set.
- **Fix scope**: Large (touches every card file), but mechanical/low-risk once designed.

## 13. Card UX

Price/title hierarchy is generally good and consistent in *emphasis* (price bold+accent, title largest) but font *sizes* for the same semantic role vary wildly across the 9 widgets (title ranges `sp(9.8)`–`sp(15.5)`, price ranges `sp(9.2)`–`sp(16)`) with no shared typography scale. `_VitrinListingCard` (5 action chips) and the premium+rocket-stacked state (up to 5 simultaneous badge/icon elements) are the most visually crowded cases found.

### LISTING-BUG-002 — Turkish price format is wrong on the two most-used verticals
- **Severity**: HIGH (P1)
- **Live caller**: `create_listing_page.dart:1475` (raw price + unit, no formatting at all); `lib/main.dart:10085-10092` (processed products, `.toStringAsFixed()`, period decimal)
- **Affected screens**: every card and detail page showing a general-listing or processed-product price
- **Current behavior**: a user typing `150000` sees the card literally display `150000 TL` (no thousands grouping at all). Processed products show e.g. `"12345.50 TL"` — a period decimal point, the English convention. Only the **logistics** vertical formats correctly (`_formatCurrencyTry`, period-grouped, e.g. `"₺12.345"`).
- **Expected**: Turkish convention — period as thousands separator, comma as decimal separator (e.g. `"150.000 TL"`, `"12.345,50 TL"`).
- **Root cause**: the price `TextField` has no `TextInputFormatter`/grouping logic, and `priceText` is built by simple string concatenation rather than routed through the one existing correct formatter (`_formatCurrencyTry` in `lib/core/utils/formatters.dart`).
- **User impact**: real, visible on every single general listing and processed product in the app — looks unprofessional and is simply the wrong number format for the target market.
- **Release blocker?**: Recommended fix before next release; not a data-integrity issue.
- **Minimum fix**: route general-listing and processed-product price formatting through the existing `_formatCurrencyTry` helper (already correct for logistics) instead of ad hoc string building.
- **Fix scope**: Small — one shared formatter already exists, this is a call-site fix, not new logic.

*(Separately, mock/demo seed listings in `listings_store.dart` hardcode English-comma prices like `'4,300 TL'` — low real-world impact since these are seed/demo data, but worth cleaning up alongside the real fix.)*

## 14. Responsive design

The scale helper (`UI.s(context)`, width-only, clamped 0.9–1.15) is used consistently for fonts/padding/sizes across all 9 cards — genuinely good discipline. **Gap**: it never accounts for the device's text-scale/accessibility setting, only screen width.

### LISTING-BUG-003 — Fixed-height row cards have zero compression margin left for large system fonts
- **Severity**: MEDIUM (P1/P2 borderline)
- **Live caller**: `_AllListingRowCard` (`height: sp(154)`), `_UnifiedListingRowCard` (`height: sp(154)`), `_PopularEntryRowCard` (`height: sp(132)`) — all three end their info column in a `Spacer()` immediately before a fixed-height CTA element.
- **Affected screens**: Favorites page, search results, featured/popular listings — some of the highest-traffic screens in the app.
- **Current behavior**: on a small-width device (scale pinned at its 0.9 floor) combined with an OS-level large-text accessibility setting (a realistic persona for this app's user base), the `Spacer()` has nothing left to compress once content grows — a `RenderFlex` overflow or clipped content is the likely outcome, not a graceful reflow.
- **Root cause**: `UI.s()` only reads `MediaQuery.size.width`, never `MediaQuery.textScaler`.
- **User impact**: potential visible overflow/clipping for a specific but real user segment (large-text accessibility users on small screens) on the most-trafficked list screens.
- **Release blocker?**: No, but worth a real-device check with large-text settings enabled during physical UAT.
- **Minimum fix**: either give these three cards a min-height instead of a fixed height, or factor `textScaler` into a secondary clamp.
- **Fix scope**: Small-medium, isolated to 3 files.

---

# PART 4 — DETAIL PAGE & CONNECTIONS (Sections 15–22)

## 15–17. Detail page structure, sales actions, owner view

### LISTING-BUG-004 — No way for a buyer to call or WhatsApp a seller, anywhere in the app
- **Severity**: HIGH (P1, product-critical)
- **Live caller**: N/A — feature absent from `listing_detail_page.dart` entirely. A call button (`Icons.call_rounded`) does exist in `hesabim_page.dart:8658` but is gated `if (_isOwnerView)` — **shown only to the profile owner viewing their own profile, never to a visitor.** No WhatsApp button exists anywhere despite `ProfileUser` carrying a `whatsapp` field that's simply never surfaced as an actionable button.
- **Affected screens**: Listing detail page, seller profile "İletişim" tab
- **Expected**: a buyer should be able to call or WhatsApp a seller directly, especially for a farmer-facing app where many users may prefer a phone call over in-app chat.
- **User impact**: for any buyer who prefers calling over chat (very plausible for this specific user base), there is currently **zero path** to do so — the phone number a seller entered on their own profile is functionally decorative.
- **Root cause**: the contact-tab UI simply never renders the phone/WhatsApp row for a non-owner viewer; nothing structurally prevents adding it.
- **Release blocker?**: Not a bug in the sense of broken code — everything works as coded. Flagging as a release-relevant product gap given how central "reach the seller" is to a marketplace.
- **Minimum fix**: surface phone/WhatsApp action buttons to non-owner visitors in the contact tab (and/or directly on the listing detail page), gated by whatever privacy preference the seller wants to expose.
- **Fix scope**: Small — the data already exists, this is a UI-gating fix.

Owner-view is otherwise handled correctly: an owner opening their own listing sees delete + share + stats, never message/like/favorite/offer (each correctly `if (!isOwner)`-gated), and gets a disabled "Bu ilan size ait" button in place of "Teklif Ver." **Gap**: the owner cannot edit or boost (rocket) their own listing from its own detail page — both only exist on the separate "İlanlarım" management list, requiring extra navigation.

## 18–19. Favorites and offers

Favorites: a deliberate, documented primary/mirror pair (`EngagementStore` + `FavoritesStore`), correctly kept in sync at every known write site, with real optimistic-update+rollback and correct per-account session isolation. No issue found here beyond the general cross-store staleness pattern (Part 5). Offers: listingId, receiver (server-derived, re-verified directly against current `offer.ts` — client-supplied receiver is only ever a fallback, never trusted when a real listing owner resolves), and `offerCount` (genuine server-side recount, not client-incremented) are all correctly implemented and protected. Offer count is shown only on the detail page's stats block, never on cards — reasonable.

## 20. Message link — product/UX judgment (not a bug)

Tapping "Mesaj Gönder" correctly opens the real, server-verified seller's thread. **However**: a buyer-seller pair shares exactly **one** conversation thread across *every* listing they ever discuss — the thread's `listingTitle` banner only reflects whichever listing started the very first conversation, and is never updated when a later "Mesaj Gönder" tap from a *different* listing reuses the existing thread. There is also no auto-inserted "regarding listing X" text in the first message itself, and the push notification for a new message is always the generic literal "Yeni Mesaj" with no listing context at all.

### LISTING-PRODUCT-GAP-001 — No listing context in messages/notifications once a thread already exists
- **Severity**: MEDIUM (P2, explicitly a design gap not a defect)
- **User impact**: a seller fielding messages across several active listings has no way to tell, from the notification alone, which listing a new message concerns; if the buyer already has any history with that seller, even opening the chat shows the wrong (stale) listing banner.
- **Suggested direction**: prefix the first message of a new inquiry with the listing title, and/or include the listing title in the push-notification body — needs a product decision on whether one thread should even span multiple listings, or whether a new listing should get its own thread.

## 21. Profile link

Correctly resolves to the real seller's own profile (never the viewer's own), and premium status is never faked client-side for another user. **Narrow edge case**: seller identity is represented via 4 independent raw fields with no canonical object; `ownerIdFromName` (used only when both `ownerId` and `ownerEmail` are blank — a realistic gap for legacy/offline-synced rows) derives an id purely from the display name, so two real sellers sharing a display name with incomplete owner metadata would be merged into the same resolved profile. Narrow but real.

## 22. Premium/Rocket visual treatment

### LISTING-UX-001 — Premium/Rocket badges disappear entirely on the detail page
- **Severity**: MEDIUM (P2)
- **Current behavior**: every card renders premium/rocket badges; `listing_detail_page.dart` calls none of `isDopingListing`/`isPremiumListing`/`rocketOwnerLabel` anywhere — confirmed via grep, zero hits in that file.
- **User impact**: a seller who paid for a rocket boost or holds premium gets that visibility exactly where a buyer is *least* likely to see it re-affirmed — right after they've clicked in and are deciding whether to trust/act.
- **Release blocker?**: No.
- **Minimum fix**: render the same badge treatment used on cards, adapted to the detail page's layout.

Rocket/premium ranking is real (not cosmetic) but **entirely scoped to specific client-side curated feeds** (home "popular" carousel, the Featured/Popular pages) via a client-computed score — the backend's `find`/`findMany` action has no server-side sort by promotion status at all, so plain search/browse results are completely unaffected by a paid rocket boost. Whether this is intentional (rocket = "get featured in curated spots" rather than "always rank first everywhere") is a product decision, not flagged as a bug — but worth confirming it matches what's actually sold to sellers. Rocket expiry correctly stops showing the badge on next rebuild with no restart needed — this part works well.

---

# PART 5 — SEARCH / FILTER / SORT / STATE / OFFLINE (Sections 23–28)

## 23–26. Search, filter, sort, pagination

### LISTING-BUG-005 — Backend search has zero Turkish-diacritic tolerance; only the local cache does
- **Severity**: HIGH (P1)
- **Live caller**: `StrapiService.searchListings` (`lib/services/strapi_service.dart:1160-1191`), sends the raw query into `filters[title][$containsi]` with no normalization; backend is SQLite with no unaccent/ICU extension anywhere in the repo.
- **Current behavior**: the local, already-loaded-listings filter correctly folds İ/ı/ğ/ş/ü/ö/ç before matching — but the actual full-database remote search has no such tolerance at all.
- **User impact**: searching for a listing containing "çiçek" or "İzmir" will reliably fail to match rows where that word wasn't already paged into the client's local cache, even though it's spelled correctly.
- **Root cause**: SQLite's stock `LOWER()`/`UPPER()` only fold ASCII case; nothing normalizes Turkish diacritics at the query layer.
- **Release blocker?**: Recommended fix, not release-blocking for the current build (pre-existing behavior).
- **Minimum fix**: normalize both the stored `title` (or a derived search-index column) and the incoming query through the same diacritic-folding function already written for the local filter, applied server-side.
- **Fix scope**: Medium — needs either a computed/normalized column or a query-time transform.

Also found: the search box's own placeholder text promises name/brand/listing-no search, but the remote query only ever filters on `title` — listing-number and owner-name search silently only work among already-loaded items.

### LISTING-BUG-006 — Every filter and every sort except "newest" is a client-side approximation, not a true global query
- **Severity**: HIGH (P1, correctness-at-scale)
- **Live caller**: `category_listings_page.dart` (city/price/mode/subType filters); `fetchListingsLatest`/`fetchListingsPage` (`strapi_service.dart:1089-1237`, only ever send `pagination`/`sort`/`populate`)
- **Current behavior**: city, min/max price, mode, and sub-type filters are all applied only to whatever's already resident in `ListingsStore` (~60 latest + manually-paged items) — never sent to the backend as query params, despite the backend genuinely supporting server-side filtering on all these fields. "En Eski," both price sorts, and the "Popular" ranking are likewise re-orderings of the same locally-resident subset, not true global sorts. Only "En Yeni" (newest-first) is actually globally correct, because it matches the server's own fixed `createdAt:desc` ordering.
- **User impact**: at real scale (thousands of listings), a price-ascending sort will never surface the actual cheapest listing in the whole catalog if it's old; a city filter will silently miss matching listings not yet paged in; `PopularListingsPage` never even calls `loadNextPage()`, so an old-but-highly-engaged listing can never appear there regardless of its real engagement numbers.
- **Root cause**: filter/sort UI was built against the in-memory store rather than wired to the backend's real, already-existing filter/sort query capability.
- **Release blocker?**: Not for current catalog size; becomes a real, user-visible correctness problem as the catalog grows. Worth prioritizing before a marketing push that grows the catalog significantly.
- **Minimum fix**: thread the same filter/sort state into the actual `fetchListingsPage` query params instead of applying it client-side.
- **Fix scope**: Medium-large — touches the store's fetch methods and the backend query construction, but the backend fields already exist and are already filterable via Strapi's stock mechanism.

### LISTING-BUG-007 — Pagination offset can drift, silently skipping rows
- **Severity**: MEDIUM (P2)
- **Live caller**: `ListingsStore.refreshFromStrapi` (`listings_store.dart:454-465`), triggered on app resume/bootstrap and forced on Search-page open
- **Current behavior**: `refreshFromStrapi` re-fetches "latest N" with no `start` param and overwrites `_loadedOffset` back down to that N, discarding how far a user had already manually paged via "Daha Fazla Göster." Since this is offset pagination against a live, growing table, every listing created by someone else since the last full sync shifts subsequent offsets by one — the next `loadNextPage(start:135)` can silently skip exactly one row per net insertion. Client-side id-dedup prevents ever seeing a *duplicate*, but does not prevent silently skipping a row that shifted position.
- **User impact**: subtle, low-visibility — a user who paged deep into a list, backgrounded the app, and came back could miss a row they'd otherwise have scrolled to.
- **Release blocker?**: No.
- **Minimum fix**: cursor-based pagination (e.g. by `id`/`createdAt` boundary) instead of raw numeric offset would eliminate this class of drift entirely.
- **Fix scope**: Medium — a real pagination-strategy change, not a one-line fix.

## 27. State / cache fragmentation

### LISTING-BUG-008 — Favorite/like counts can visibly disagree between the detail page and the Home/Popular ranking
- **Severity**: MEDIUM-HIGH (P1) — a *new*, previously-undetected instance of the same bug class R1.6 already fixed once
- **Live caller**: `home_page.dart`/`popular_listings_page.dart`'s trend score reads `ListingEngagementStore.I.favoriteCountOf`/`likeCountOf`; `listing_detail_page.dart` reads the new `EngagementStore` snapshot; the real favorite/like toggle path (`_toggleListingEngagementFavorite`) only ever updates `EngagementStore`, **never** `ListingEngagementStore`.
- **Current behavior**: right after a user favorites a listing, its detail page shows the incremented count instantly (server-confirmed), while its rank on Home/Popular can still reflect the pre-favorite count, because `ListingEngagementStore`'s copy is only refreshed on a full listing re-fetch (throttled ≥20s; `PopularListingsPage` never even calls `loadNextPage`).
- **Root cause**: two parallel per-listing count stores exist (`ListingEngagementStore`, legacy; `EngagementStore`, new/authoritative) and only one of the two real write paths keeps both in sync.
- **User impact**: a listing's "trending" rank can lag its real, current popularity by however long since the last full list refresh — invisible to most users, but a real data-freshness bug, not just cosmetic.
- **Release blocker?**: No, but same root cause as an already-fixed bug (R1.6) resurfacing in a sibling code path — worth closing alongside any future work in this area.
- **Minimum fix**: have the real favorite/like toggle path also update `ListingEngagementStore` (or, better, retire `ListingEngagementStore` entirely in favor of the new `EngagementStore` everywhere it's still read).
- **Fix scope**: Medium.

Also found, same root cause family: the favorited/liked **membership boolean** has no authoritative re-fetch path at all — it's seeded only from best-effort, fire-and-forget local mirrors (`FavoritesStore`/`ListingEngagementStore`) synced to `profile-setting`, with only one 4-second local retry on failure. A second device whose sync silently failed once will confidently show "not favorited" until manually re-toggled, with no way to detect or correct the drift.

## 28. Offline sync

Re-verified: owner-binding protection is present and correct on both client (`ListingPendingSyncQueue.retryPending` pauses rows from a different session owner) and server (`syncOfflineListing` force-derives owner identity from the JWT, never the payload) — matches R1.3, not regressed. Create-path idempotency ledger is correctly shared between the direct and offline-sync create paths.

### LISTING-ARCH-002 — Two-device edit conflicts are silent last-write-wins, with no detection even though the data needed for it already exists
- **Severity**: MEDIUM (P2, accepted-risk-but-invisible)
- **Current behavior**: `listing.ts update()` has no version/timestamp precondition at all; `updatedAtClient` is sent by the client on every offline-sync update but is write-only — never compared against the row's actual current state before allowing an unconditional overwrite.
- **Realistic scenario**: the *same* user edits the *same* listing from two of their own devices, one offline, within the retry window — a narrow but real scenario for this app's single-owner-per-row model (not general multi-editor collaboration).
- **Release blocker?**: No — silent last-write-wins is a defensible simplification at this app's scale, but currently invisible to the user even though a cheap warning is nearly free given the data already crosses the wire.
- **Minimum fix**: compare `updatedAtClient` against the row's real last-modified time before an offline-sync flush; surface a "this listing changed elsewhere, review before saving" warning instead of silently overwriting.
- **Fix scope**: Small-medium.

---

# PART 6 — COUNTERS / PERFORMANCE / DUPLICATION / DEAD CODE (Sections 29–32)

## 29. Counters — product judgment

Current placement is already reasonably disciplined: browse cards correctly show **no** raw counters (only a favorite icon's on/off state), the detail page shows all four (view/offer/like/favorite) unconditionally to every visitor including strangers, and the dedicated "Popular" surface earns its counter display by using the numbers to justify the ranking. **Recommendation** (UX opinion, not a bug): consider making like/favorite counts owner-only on the detail page (weak signal to a stranger, real signal to the seller), while keeping view/offer counts public (legitimate buyer social proof). `commentCount`/`shareCount` are modeled and backend-functional but never displayed anywhere in the app — see dead-code findings below for why.

## 30. Performance

### LISTING-PERF-001 — Shared cached-image widget decodes full-resolution bitmaps for thumbnail-sized display, across 26 files
- **Severity**: MEDIUM-HIGH (P1, real but not crash-guaranteed)
- **Live caller**: `AppCachedImage` (`lib/main.dart:656-705`), used in 26 files across listing/home/logistics/processed-product surfaces
- **Current behavior**: wraps `CachedNetworkImage` without `memCacheWidth`/`memCacheHeight`. Listing photos are compressed to at most 1280×1280 on upload; a decoded bitmap at that size is ~6.5MB in the in-memory image cache **per photo**, even when rendered at a 100–250px card thumbnail.
- **User impact**: extra decode work and cache churn/eviction during long scroll sessions, especially on lower-end Android devices — a real, verifiable "large image, small render target" waste, not a hypothetical.
- **Release blocker?**: No.
- **Minimum fix**: add `memCacheWidth`/`memCacheHeight` derived from actual render size to `AppCachedImage` — fixing it once fixes all 26 call sites.
- **Fix scope**: Small (one shared widget) but requires care to pick sane defaults per call site.

Also found: `general_listing_management_page.dart` merges a global `FavoritesStore.I.tick` into a whole-page `AnimatedBuilder`, so favoriting *anything* anywhere else in the app rebuilds this owner-management page if it's mounted — low-moderate severity (bounded catalog, cheap rebuild, not a network storm). Every other browse page correctly scopes rebuilds per-card via `EngagementTarget`-keyed listenables — genuinely good, deliberate design confirmed elsewhere. No N+1 network pattern was found for listing counts or owner-name resolution (both are computed from already-fetched batch data or pure in-memory lookups) — the commonly-feared "one request per visible card" pattern does not exist for listings today.

## 31. Duplication summary table

| Pattern | Verdict | Notes |
|---|---|---|
| Row-card layout (`_UnifiedListingRowCard` vs `_AllListingRowCard`) | ORTAKLAŞTIRILMALI | Near-identical widgets solving the same problem; the "unified" one was clearly meant to supersede the other but never did |
| Premium/rocket badge rendering | ORTAKLAŞTIRILMALI | Byte-for-byte duplicated 3–5×, only scale constants differ |
| Image-resolution branching | ORTAKLAŞTIRILMALI (partial) | Low-level `AppCachedImage` already shared; the branch logic around it isn't |
| Price formatting | ZATEN ORTAK | Genuinely centralized for general listings (though see LISTING-BUG-002 for the *correctness* problem within that one centralized function) |
| Owner display-name resolution | ZATEN ORTAK | Properly centralized (`_listingSellerDisplayName`), just oddly housed in a file named after something else |
| Favorite toggle *logic* | ZATEN ORTAK | Centralized, oddly housed in a page file rather than a utils file |
| Favorite-button *UI* | ORTAKLAŞTIRILMALI | 9 separate re-implementations of the same icon button |
| Engagement metrics bar | ORTAKLAŞTIRILMALI in intent, but the shared widget itself (`EngagementBar`) is dead — see below | |
| Navigation-to-detail (`Navigator.push(...ListingDetailPage...)`) | ORTAKLAŞTIRILMALI (minor) | 12 call sites, one-line but repeated |

## 32. Dead / legacy code — full inventory

### LISTING-DEAD-001 — `FeaturedListingsPage`
Fully implemented (category chips, sort, premium/rocket cards) — zero external callers anywhere in `lib/`. Carries its own `// ignore_for_file: unused_element`, suggesting the author already knew.

### LISTING-DEAD-002 — `PendingListingsPage`
Fully implemented "pending/moderation" queue UI — zero external callers, **and** its entire premise (a moderation queue) doesn't exist on the backend either (the `status` enum's `pending` value is never set by anything).

### LISTING-DEAD-003, 004, 005 — Three orphaned card widgets
`_PremiumHorizontalListingCard`, `_HomeFeaturedListingCard`, `_SearchListingRowCard` — ~808 combined lines, independently confirmed by 3 separate research passes to have zero real call sites. `_PremiumWideCard` and `_MockChip` are technically "used," but only from within the dead `FeaturedListingsPage` — effectively unreachable in practice too.

### LISTING-DEAD-006 — `EngagementBar` + `EngagementAction`
Explicitly documented in its own file header as "the single shared engagement action row every card/page should render instead of building its own" — never instantiated anywhere. The exact duplication this widget was built to solve (Section 31) still exists in the wild because nothing adopted it.

### LISTING-DEAD-007 — Comment/share engagement feature, client side
`EngagementRepository.createListingComment`/`createShareIntent` have zero real UI call sites (only referenced from within the engagement-pending-queue's own retry logic, which nothing ever enqueues from a real user action). Backend (`listing-comment`, `listing-share` content-types/controllers) is fully implemented and functional. This is a complete, working feature with no door into it from the app.

---

# PART 7 — SECURITY RE-CHECK (Section 33)

All 7 previously-fixed protections were re-verified against **current** code (not just cited from past reports) and corroborated by a live, clean rerun of the full integration suite: **351/351 pass, 0 failures.**

| # | Protection | Status |
|---|---|---|
| 1 | Listing ownership on update/delete | **PRESENT** |
| 2 | `ownerEmail` privacy (never leaks to other users) | **PRESENT** |
| 3 | Offline-sync ownership + quota enforcement | **PRESENT** |
| 4 | Protected counters/flags stripped on both create paths | **PRESENT** |
| 5 | Premium/rocket spoof protection | **PRESENT** |
| 6 | Free-tier listing quota, server-side | **PRESENT** |
| 7 | Create idempotency ledger | **PRESENT** |

No MISSING or REGRESSED items found anywhere in the listing security surface.

---

# PART 8 — PRODUCT GAP ANALYSIS (Section 34)

Independent of any bug — features a professional listing app commonly has, checked against actual code (not assumed):

| Feature | Status |
|---|---|
| Draft listings (save incomplete, finish later) | **MISSING** |
| Preview before publish | **MISSING** |
| Auto-save while filling the form | **MISSING** |
| Category-specific fields | **EXISTS, but informally** — via a dynamic `attrs` map, not typed schema columns for livestock/machinery (only produce has real typed columns) |
| Listing quality/completeness score | **MISSING** |
| Photo reorder / per-photo captions | **MISSING** (cover-photo selection alone exists) |
| Share functionality | **EXISTS** (`share_plus`, OS share sheet) |
| Report/flag a listing | **MISSING** |
| "Similar listings" on detail page | **MISSING** |
| "This seller's other listings" on detail page | **MISSING** |
| "Recently viewed" listings | **MISSING** as a user feature (the raw view-log data exists server-side, purely to drive the view counter — nothing surfaces it as a list) |

---

# PART 9 — FINAL USER JOURNEY (Section 35)

Tracing the mandate's exact scenario through the code investigated above:

| Step | Classification | Notes |
|---|---|---|
| User A: giriş | SMOOTH | Standard auth, unaffected by listing system |
| User A: ilan oluştur | SMOOTH (with caveats) | Works; required fields unmarked, uneven validation on Hayvancılık/Tarımsal Aletler dynamic fields (LISTING-BUG findings above), no draft/autosave |
| User A: fotoğraf yükle | SMOOTH | Compression/upload correct; orphan-media risk only on a failure path, not the happy path |
| User A: yayınla | SMOOTH | Idempotent, quota-enforced, verified via live test |
| User B: arama yap | FRICTION | Works for common cases; silently misses Turkish-diacritic matches and anything not yet paged in (LISTING-BUG-005) |
| User B: filtrele | FRICTION | Filters apply, but only over already-loaded items — silently incomplete at scale (LISTING-BUG-006) |
| User B: ilan kartını gör | SMOOTH | Cards render correctly; visual inconsistency (Part 3) is a polish issue, not a functional break |
| User B: detay aç | SMOOTH | Comprehensive detail page; premium/rocket badge oddly absent here (LISTING-UX-001) |
| User B: satıcı profilini gör | SMOOTH | Correct real-seller resolution; narrow name-collision edge case only under missing-data conditions |
| User B: favorile | SMOOTH | Correctly synced, correct rollback, correct session isolation |
| User B: mesaj at | SMOOTH, with a product gap | Reaches the correct real seller; no listing context in the message/notification itself (LISTING-PRODUCT-GAP-001); **no call/WhatsApp alternative exists at all (LISTING-BUG-004)** |
| User B: teklif ver | SMOOTH | Correct listingId/receiver/count, server-verified |
| User A: mesajı al | SMOOTH | — |
| User A: teklifi gör | SMOOTH | — |
| User A: kabul/karşı teklif | MANUAL TEST REQUIRED | Offer accept/reject/counter logic was verified server-side in prior sessions (R1/R2), not re-walked pixel-by-pixel in this pass — recommend confirming in physical UAT |
| User A: ilanı düzenler | **BROKEN** | **If A touches anything other than title/description/price/location/photos, saving silently discards every category-specific value the listing had (LISTING-BUG-001).** This is the one step in the entire journey that is a genuine, confirmed break, not friction. |
| User A: pasife alır/siler | SMOOTH ("pasife al" correctly removed; "sil" hard-deletes correctly) | Media orphaning on delete is a technical-debt issue, not a user-facing break |

---

# PART 10 — PROPOSED COMMON STRUCTURE (Section 37)

Grounded in what actually exists today (Section 31/12), not a hypothetical clean-slate design. The codebase already has the *right instinct* in three places worth copying: `_unifiedListingRowCard` (already meant to be canonical, just not adopted), `_ProcessedUnifiedCard`'s layout-enum pattern (already proven to work for a sibling vertical), and `_listingSellerDisplayName`/price-formatting (already properly centralized data helpers). The minimum realistic refactor is to extend that same pattern, not invent a new one:

1. **`ListingCardImage`** — one widget absorbing the 7 duplicated image-resolution branches (local file / cached network / fallback icon), parameterized by target size so it can also carry the Section 30 `memCacheWidth/Height` fix in exactly one place.
2. **`ListingPromoBadges`** — one widget for the premium/rocket pill pair, replacing the 5 duplicated copies (and closing the accent-color discrepancy bug as a side effect).
3. **`ListingFavoriteButton`** — generalize the already-existing-but-barely-used `_HomeFavoriteButton` into the one favorite-icon implementation, replacing the other 8.
4. **`ListingPriceText` / `ListingTitleText` / `ListingLocationRow`** — three small text-role widgets carrying a single shared typography scale, directly fixing the Section 13 font-size inconsistency.
5. **Consolidate `_AllListingRowCard` into `_UnifiedListingRowCard`** — the latter was already positioned as canonical; finish the migration rather than maintaining both.
6. **A single `openListingDetail(context, product)` helper** replacing the 12 duplicated `Navigator.push(...)` call sites.
7. Do **not** try to force logistics/processed-products/farmer-Q&A cards into the same components — those are genuinely separate verticals per Section 3's own finding; a shared *base* (items 1–4 above) is reasonable, but forcing one card class to serve four products would recreate exactly the category-system fracture problem this audit found elsewhere.

No code was written for any of this — it's a plan for a follow-up phase, using the components the codebase already gestures toward.

---

# PART 11 — PRIORITY ROADMAP (Section 38)

**P0 — Critical / data-security**
1. LISTING-BUG-001 — edit silently discards category-specific saved data

**P1 — Functional**
2. LISTING-BUG-004 — no call/WhatsApp path to a seller anywhere
3. LISTING-BUG-002 — wrong Turkish price format on 2 of 3 verticals
4. LISTING-BUG-005 — backend search has no Turkish-diacritic tolerance
5. LISTING-BUG-006 — filters/sorts (except newest) are client-side-only approximations
6. LISTING-BUG-008 — favorite/like count staleness between detail page and trending rank
7. LISTING-PERF-001 — uncapped image memory cache across 26 files
8. Photo/media orphaning on edit-removal, hard-delete, and quota-rejected create

**P2 — UX**
9. LISTING-UX-001 — premium/rocket badges missing from the detail page
10. LISTING-BUG-007 — pagination offset drift
11. LISTING-ARCH-002 — silent two-device edit conflicts
12. LISTING-PRODUCT-GAP-001 — no listing context in repeat-thread messages/notifications
13. LISTING-BUG-003 — fixed-height row cards under large-text accessibility settings
14. Un-mark-required-fields / uneven category-field validation

**P3 — Architecture / refactor**
15. LISTING-ARCH-001 — consolidate the 9 card widgets per Part 10
16. Retire the `ownerProfileId`/`ownerId` and `isPremiumOwner`/`isPremium` duplicate-field pairs
17. Prune the dead 40-key fallback-chain surface in `_fromStrapiRow`/`_enrichListingAttrsFromRow`
18. Decide the fate of `MainType.islenmisUrunler`/`nakliyeLojistik` — either genuinely remove them from the enum/generic-listing switch, or document why they must stay
19. Delete the 3 confirmed-dead card widgets, `FeaturedListingsPage`, `PendingListingsPage`, `EngagementBar`/`EngagementAction`

**P4 — Product enhancement**
20. Draft listings, preview-before-publish, auto-save
21. Similar-listings / seller's-other-listings on the detail page
22. Listing quality/completeness score
23. Report/flag a listing
24. Photo reorder + per-photo captions
25. Either wire up the already-built comment/share feature to a real UI, or remove the dead client-side scaffolding for it
26. Category-specific fields as real typed schema columns for livestock/machinery (not just produce)
27. Recently-viewed listings as a user-facing feature

## Top 10 — fix these first

1. **LISTING-BUG-001** — stop the edit screen from silently destroying saved data (P0, the only outright "broken" step in the whole user journey)
2. **LISTING-BUG-004** — give buyers a way to call/WhatsApp a seller
3. **Photo/media orphan cleanup** — close the leaks on edit-removal, delete, and quota-rejected create
4. **LISTING-BUG-002** — fix Turkish price formatting on general listings + processed products
5. **LISTING-BUG-006** — wire real filters/sort into the backend query before the catalog outgrows the client cache
6. **LISTING-BUG-005** — Turkish-diacritic search server-side
7. **LISTING-PERF-001** — cap the shared image cache's decode size
8. **LISTING-BUG-008** — close the favorite/like count staleness between detail and trending rank
9. **LISTING-UX-001** — restore premium/rocket badges on the detail page
10. **LISTING-ARCH-001 (start)** — at minimum, finish migrating `_AllListingRowCard` onto `_UnifiedListingRowCard` and delete the 3 confirmed-dead card widgets, as a low-risk first slice of the larger consolidation

---

This audit stops here. No code was changed, nothing was committed, nothing was pushed, nothing was deployed.
