# Semantic Contract Audit — Phase S2: Remaining CRITICAL + HIGH Fixes

**Date:** 2026-08-10
**Reference:** `BACKEND_FLUTTER_SEMANTIC_CONTRACT_AUDIT.md` (in the `tarim360` repo), `SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md`
**Fix branches:** `fix/semantic-contract-s2-high`, pushed in **both** repos (not merged to main):
- Backend: `tarim360-strapi` — branched from S1's HEAD (`ae8951c`)
- Flutter: `tarim360` — branched from `refactor/main-dart-modularization`'s HEAD (`bb94f98`); S1 made no Flutter commits, so this *is* Flutter's S1-equivalent base
**Scope:** Exactly the four named findings — 2.5, 2.7, 2.9, 2.11 — plus one disclosed extension to 2.11 (see below). No MEDIUM/LOW item touched.

---

## 2.5 — Listing: stale local counter shown next to the live one

### Read-only reverify (on current HEAD, before any change)

Live paths writing listing engagement counts:
1. Engagement v1's `setMembership`/`incrementCounterAtomic` — correct, atomic, untouched.
2. `listing-metrics.ts`'s `recountListingOffers` — correct, canonical for `offerCount`, untouched.
3. `ListingEngagementStore._syncListingMetrics` (Flutter) — a raw, client-computed absolute-value PATCH via `StrapiService.updateListing`, triggered by `registerFavorite`/`registerOffer`.
4. **`listing.ts` had no `update` override at all** (stock `createCoreController`) — unlike `processed-product.ts`/`logistics-vehicle.ts`/`hub-content.ts`, which all strip their engagement-only fields. Any authenticated owner could PATCH their own listing's `likeCount`/`favoriteCount`/`viewCount`/`offerCount`/`commentCount`/`shareCount`/`engagementVersion` to an arbitrary value via a normal `PUT /listings/:id` — worse than the audit's framing of "some gap," this was zero guard.
5. Display sites: `home_page.dart`'s `.listing` hero case and `popular_listings_page.dart`'s hero/row `.listing` cases each computed a stale `final favorites = ListingEngagementStore.I.favoriteCountOf(p.id)` local variable and passed it to the card, sitting right next to `isFavorite: snap.favorited` (the live `EngagementStore` snapshot) on the *same card*.
6. `favorites_page.dart`'s toggle called `FavoritesStore.I.add/remove` (→ `ListingEngagementStore.registerFavorite` → the raw PATCH in #3) **and** `EngagementStore.I.toggleFavorite` in the same tap — a genuine, live, unordered double-mutation to the same field.

### Fix

- **Backend** (`listing.ts`): new `CLIENT_PROTECTED_FIELDS`/`stripClientProtectedFields`, applied to both `create` (previously only `isPremium`/`isPremiumOwner` were force-overridden after spread, leaving count fields spoofable at create time too) and a brand-new `update` override. Disclosed addition beyond the literal field list: `isPremium`/`isPremiumOwner` (premium-sync.ts-owned, same vulnerability class, same file, same fix). Not included: `isDoping`/`rocketEndsAt` (a separate rocket/promotion mechanism, out of this item).
- **Flutter**: `favorites_page.dart` migrated to `FavoritesStore.I.addListingLocal/removeListingLocal` (local mirror only, zero backend calls) — matching every other already-migrated listing surface; the old dual-write is gone. `home_page.dart` and `popular_listings_page.dart` (hero + row) now read `snap.favoriteCount` instead of the stale local variable.
- **Explicitly left alone** (documented, pre-existing scope decision per `LISTING_CARD_ENGAGEMENT_STANDARD_PROPOSAL.md`): `interactions: offers + likes` on these same cards still reads `ListingEngagementStore.I.offersOf/likeCountOf` — "interactions" was deliberately kept off the live snapshot in an earlier phase, and ranking/sort scores (`_popularListingScore` and siblings) intentionally stay on the legacy store for the same reason. This phase did not touch that decision.

### Live-caller / double-mutation audit
- Client-computed absolute-count PATCH for engagement-scoped like/favorite/view: **0** live callers remain that can reach the backend (the raw PATCH path in `ListingEngagementStore` is now neutralized at the source — the backend field guard strips it regardless of whether Flutter still calls it).
- Second backend metric mutation per action: **0** (`favorites_page.dart`'s dual-write eliminated).
- UI count = server-authoritative snapshot on every card display site checked (home, popular listings hero/row); offer/comment/share remain on their own canonical sources, unchanged.

---

## 2.7 — Approved Ads: `impressions` double-counted

### Read-only reverify

- `ad-event.ts`'s `create()` bumped `impressions` unconditionally on **every** `POST /ad-events`, regardless of `eventType`, no dedup.
- `engagement-contract.ts`'s `VIEW_COUNT_FIELD.ad = 'impressions'` → Engagement v1's `registerView` increments the **same column**, with real 24h actor dedup.
- Flutter's ad detail page `initState` (`main.dart`) fires both `EngagementStore.I.registerView(_target)` and `ApprovedAdsStore.I.trackClick(...)` (→ `POST /ad-events`, `eventType:'click'`) in the same lifecycle. Grepped for every `eventType` value any live caller sends: **only `'click'`** exists — no separate navigation-helper or card-visibility duplicate trigger.

### Fix

`ad-event.ts`: `impressions` is never written by this controller anymore — Engagement v1's `registerView` is now the sole authority. The legacy `showCount`/`displayCount`/`viewCount` counters only bump for a genuine `eventType === 'impression'` event (a path with no live caller today, fixed defensively so a click can never inflate an impression-labeled counter either). No Flutter change needed — `main.dart`'s own comment already documented the intended click/impression separation; the backend just wasn't honoring it.

### Double-mutation audit
One real impression intent (opening the ad detail page) → **one** backend mutation to `impressions` (proved end-to-end in the new test: `registerView` + `trackClick`, mirroring `main.dart`'s exact call site, increments `impressions` by exactly 1, not 2). A rebuild of the same page does not re-send (`EngagementStore`'s existing per-mount guard, unchanged). Ad-click legitimately stays outside the engagement contract, as Flutter's own code already intended.

---

## 2.9 — Processed Products: stale count in the seller's own management card

### Read-only reverify

- `ProcessedProductInsightsStore` (Flutter) is a local, monotonic-max cache (`seedCounts`/`takeMax`), seeded **only** from `ProcessedProductItem.fromMap` when a product is fetched/re-fetched from Strapi — it is never written to by any live user action.
- Backend: `COUNTER_FIELD['processed-product'] = { like: 'likeCount', favorite: 'favoriteCount' }`, `VIEW_COUNT_FIELD['processed-product'] = 'viewCount'` — Engagement v1 writes these exact fields atomically on the same entity. `processed-product.ts` already had the correct field guard (no client writes possible) — this item was never about a write-side bug.
- `EngagementStore` (Flutter) is updated live and immediately on every toggle/view, independent of any catalog refetch.
- Confirmed, by reading every call site: `processed_unified_card.dart` (the actual browse/discovery card) and both `home_page.dart`/`popular_listings_page.dart`'s `.processed` hero/row cases already read `snap.viewCount`/`snap.favoriteCount`/`snap.likeCount` — correct, live, no bug. Ranking/sort scores (`_popularProcessedScore`, `_entryPopularity`, `_processedMarketPopularityScore`) and aggregate dashboard totals (`sellerViewsTotal`, `_buildPremiumManagementDashboard`, `hesabim_page.dart`'s category stat banners) all intentionally stay on the local cache — same scope-out precedent as 2.5's "interactions," legitimate for a sum-across-many-products aggregate.
- The one confirmed live, single-item, stale-count display bug: **`_ProcessedProductManageCard`** (`processed_products_manage_page.dart`) — the seller's own per-product management card, showing "Görüntüleme"/"Beğeni"/"İlgi" read directly from `ProcessedProductInsightsStore`. The page rebuilds on `Listenable.merge([ProcessedProductStore.I.tick, OffersStore.I.tick, ProcessedProductInsightsStore.I.tick, ProcessedProductPromotionStore.I.tick])` — **`EngagementStore` is not in that merge list at all** — so a seller watching their own manage page would not see a view/like/favorite that happened elsewhere (e.g. a buyer opening the detail page in another session) until the whole catalog was refetched.
- A second dead-code instance was found (`_ProcessedMiniProductCard` in `processed_marketplace_widgets.dart`, same stale-read pattern for a view-count text) but has **zero live callers** anywhere in the codebase (confirmed via grep) — per this project's own "don't touch code with no live caller" discipline, left alone.

### Fix

`_ProcessedProductManageCard.build()`: now calls `seedProcessedProductEngagement(item)` and wraps its return in `ValueListenableBuilder<EngagementSnapshot>` on `EngagementStore.I.listenableFor(target)`, reading `snap.viewCount`/`snap.likeCount`/`snap.favoriteCount` (→ "İlgi") instead of the frozen local cache. `orderCount` is unchanged (offers stay outside the engagement contract, same as every other domain).

### Count-authority audit
Live user card/detail UI → `EngagementStore` server-authoritative snapshot, confirmed for every single-item display site touched or reviewed this phase. Dashboard/ranking/seller-center aggregates → kept on their existing read model (a genuinely different shape of read — sum across N products — not a second authority for the same single-target counter); disclosed as an intentional scope boundary, matching 2.5's precedent, not a new gap.

---

## 2.11 — Ads: moderation bypass

### Read-only reverify

`ad.ts` was a fully stock `factories.createCoreController('api::ad.ad')` — **zero** field guard of any kind. The only gate at all is the `ad-owner-write` policy, which verifies ownership (`requestedByEmail`/`submitter`/`requestedByProfileId`/`ownerProfileId` matches the caller's identity) and, on `POST`, force-sets `requestedByEmail`/`requestedByProfileId` from identity — but it never sanitizes the payload on update, and never touches approval/moderation fields at all.

Schema (`ad/content-types/ad/schema.json`) has **four** distinct approval/moderation-shaped fields with **no default**: `approvalStatus`, `reviewStatus`, `isApproved`, `approved`. There is no separate `ad-admin` controller (unlike `logistics-admin`/`processed-admin`) — moderation, when it happens, goes through the Strapi admin panel's own privileged surface, entirely separate from this public REST controller.

`approved_ads_repo.dart` (Flutter) reads exactly these fields to decide Approved Ads feed membership — confirmed **two independent mechanisms**, both closed this phase:
1. **Client-PATCH spoofing** (the mandate's named framing): any owner could `PUT /ads/:id` with `approvalStatus:'approved'`/`isApproved:true` and self-approve their own ad. Real and exploitable via a raw HTTP call bypassing Flutter entirely — only "dormant" because Flutter's own ad-creation UI is compile-time disabled (`AppFeatureFlags.enableSmartAds = false`, `main.dart:991`), not because the backend enforced anything.
2. **Missing-default fallthrough** (the original audit's own framing of 2.11, distinct from #1, initially missed by this phase's first pass and caught on review before writing this report): with no schema default, an honestly-created ad's `isApproved`/`approved` stayed `null`. `approved_ads_repo.dart`'s fallback check (`approvedBool != false`, i.e. `null != false` → `true`) treats an unmoderated ad as already approved whenever that fallback query path is hit. Stripping client input alone does not fix this — a stripped field just stays `null`, identical to before.

### Fix

`ad.ts`: same `CLIENT_PROTECTED_FIELDS`/`stripClientProtectedFields` pattern as `listing.ts` (S2.5), covering `approvalStatus`/`reviewStatus`/`isApproved`/`approved` **plus** the same engagement/analytics counters S2.7 just made server-exclusive (`impressions`, `likes`, `likeCount`, `favoriteCount`, `showCount`, `displayCount`, `viewCount`, `videoViews`, `izlenmeCount`, `engagementVersion` — without this, S2.7's fix would be trivially bypassable via a raw `PATCH /ads/:id`) and `isPremiumOwner` (premium-sync.ts-owned, same as `listing.ts`'s `isPremium`/`isPremiumOwner`). Applied to both `create` and `update`.

Additionally (mechanism #2, its own commit, disclosed as a deviation from the planned 5-commit structure): `create()` now stamps an explicit `approvalStatus:'pending', reviewStatus:'pending', isApproved:false, approved:false` on every new ad, matching this codebase's own established convention for missing moderation state (audit 2.10's logistics `moderationStatus` `default:"pending"`).

**Not fixed, disclosed as a follow-up:** update-time ownership/identity field spoofing (e.g. a owner rewriting `submitter`/`ownerProfileId` on their own ad via `PUT`) — the policy only force-overwrites `requestedByEmail`/`requestedByProfileId` on `POST`, never sanitizes `PUT`. This is a distinct, narrower question from "moderation state," out of this item's named scope.

### Moderation security test results (5-scenario matrix + 1 extra)

| Scenario | Result |
|---|---|
| Spoofed `approvalStatus` on update → rejected/stripped | **PASS** — stays off `'approved'` |
| Spoofed `isApproved`/`approved`/`reviewStatus` on update → rejected/stripped | **PASS** |
| Spoofed engagement counters (`impressions`, `likes`, etc.) on update → rejected/stripped | **PASS** |
| Normal editable field (`title`, `description`) update → works | **PASS** — 200, values persisted |
| Admin/moderator legitimate update (via `entityService`, the same surface the Strapi admin panel uses) → works | **PASS** — this fix only guards the public REST field surface, not the admin-privileged path |
| A normal, honest create with no spoofing attempt → starts explicitly `pending`/`false`, not `null` | **PASS** — closes the original audit's own framing of 2.11 |

---

## Test results

| Suite | Result |
|---|---|
| Backend `npx tsc --noEmit` | PASS — clean |
| Backend `npm test` (unit) | PASS — 31/31 |
| Backend `npm run test:integration` | PASS — **166/166** (154 S1 baseline + 3 listing field guard + 3 ad-event impression + 6 ad moderation field guard) |
| Backend `npm run build` | PASS — exit 0 |
| Backend `git diff --check` | PASS — clean (CRLF-conversion warnings only, no actual conflicts/trailing-whitespace issues) |
| Flutter `flutter analyze` | PASS — only 2 pre-existing warnings in an untouched file (`logistics_models.dart`), unchanged before/after |
| Flutter `flutter test` | PASS — **210/210**, including the new S2.3 regression test |

New coverage detail:
- **`listing-engagement-field-guard.integration.test.ts`** (3 tests): create-time spoof of 9 protected fields → server defaults; update-time spoof → stripped, real owner update still succeeds; normal fields still work.
- **`ad-event-impression-double-count.integration.test.ts`** (3 tests): a click never touches `impressions`; a genuine impression event bumps legacy counters but never `impressions`; the real end-to-end scenario increments `impressions` exactly once.
- **`ad-moderation-field-guard.integration.test.ts`** (6 tests): the 5-scenario matrix above, plus the missing-default regression test.
- **Flutter `processed_product_engagement_test.dart`** (+1 test): proves `ProcessedProductInsightsStore` and `EngagementStore` genuinely diverge after a live mutation — the exact reason the manage card needed to move off the former.

## Clean-checkout validation

Isolated `git worktree` of each repo's final S2 commit, zero untracked files carried over:
- Backend (`ff47226`): `npx tsc --noEmit` and `npm run build` both PASS.
- Flutter (`b4329c5`): `flutter analyze` PASS (same 2 pre-existing warnings only).

## Commit hashes

**Backend (`tarim360-strapi`, branched from S1's `ae8951c`):**
1. `1efdf48` — `fix: remove remaining legacy listing metric writes`
2. `92aa8c8` — `fix: prevent duplicate approved ad impressions`
3. `2f987a5` — `fix: protect ad moderation fields from client updates`
4. `dc275c3` — `test: add remaining semantic contract regression coverage`
5. `ff47226` — `fix: default new ads to unapproved until reviewed` *(deviation — see 2.11 above)*

**Flutter (`tarim360`, branched from `refactor/main-dart-modularization`'s `bb94f98`):**
1. `94c806f` — `fix: remove remaining legacy listing metric writes`
2. `9ac777d` — `fix: make processed product counts server authoritative`
3. `b4329c5` — `test: add remaining semantic contract regression coverage`

Branches pushed: `fix/semantic-contract-s2-high` → `origin/fix/semantic-contract-s2-high` in **both** repos. **Not** pushed to or merged into `main`, no PR opened (no `gh` CLI in this environment) — compare links:
- `https://github.com/sytcstr/tarim360-strapi/pull/new/fix/semantic-contract-s2-high`
- `https://github.com/sytcstr/tarim360arti1/pull/new/fix/semantic-contract-s2-high`

### Disclosed deviation from the planned 5-commit structure

The mandate's 5-commit plan maps naturally to **8 commits across 2 repos** (each named item split by which repo actually has changes for it — S2.7 and 2.11 are backend-only, S2.9 is Flutter-only, S2.5 and the test commit touch both), plus **one extra commit** (`ff47226`) born from catching, during review before writing this report, that the first pass at 2.11 only closed the spoofing mechanism and missed the audit's own original "missing default" framing. Not an artificial split — the natural per-repo/per-finding boundary, with one honest addition disclosed rather than folded silently into an amend.

`src/api/offer/controllers/offer.ts` (WIP) confirmed unchanged before, during, and after this phase — still exactly `+12` uncommitted lines, never staged.

---

## Audit findings closed by this phase

Of the 14 confirmed mismatches in `BACKEND_FLUTTER_SEMANTIC_CONTRACT_AUDIT.md`:
- **2.5** (Listing stale/live counter) — **CLOSED**
- **2.7** (Approved Ads impression double-count) — **CLOSED**
- **2.9** (Processed Products stale management-card count) — **CLOSED**
- **2.11** (Ads moderation bypass) — **CLOSED** (both mechanisms — spoofing and missing-default)

**Total closed across S1 + S2: 8 of 14** (2.1, 2.2, 2.3, 2.4 from S1; 2.5, 2.7, 2.9, 2.11 from S2), plus the one bonus `promo.ts` finding S1 found beyond the original 14.

## Remaining MEDIUM/LOW items (untouched, per scope)

- **2.6** — Favorilerim sayfası üçlü yazma (MEDIUM) — *narrower than it looks now*: 2.5's fix already migrated `favorites_page.dart` off the dual-write path this item was originally about; worth a quick re-check next phase to confirm 2.6 is now fully subsumed rather than independently re-verifying it from scratch.
- **2.8** — Approved Ads "İzlenme" video-view mislabeling (MEDIUM)
- **2.10** — Logistics `moderationStatus` missing-value default inversion (MEDIUM)
- **2.12** — Purchase history empty categoryTitle/planTitle (LOW-MEDIUM, dormant)
- **2.13** — Profile inbound comments empty fromName (LOW-MEDIUM, dormant)
- **2.14** — Offers empty title/listingTitle/name (MEDIUM, dormant)

## READY / BLOCKED for S3 / final rollout

**READY.** All four named CRITICAL/HIGH items closed with regression coverage (11 new backend tests, 1 new Flutter test, all passing), full verification suite green in both repos, clean-checkout passes in both repos, `offer.ts` WIP untouched, every deviation from the plan disclosed above. Stopping here as instructed — no MEDIUM/LOW item touched, no PR opened, no merge to main, no production deploy.
