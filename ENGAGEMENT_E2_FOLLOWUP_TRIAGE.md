# TARIM360+1 — ENGAGEMENT FOLLOW-UP TRIAGE E2

READ-ONLY. No code changed, no commits, no push, `main` untouched, no
production mutation. Both repos re-verified on `release/preflight-integration`,
in sync with `origin` (backend HEAD `1c345cd`, Flutter HEAD `2f33b73` —
both `git status -sb` show no ahead/behind).

Reference: `ENGAGEMENT_SYSTEM_FINAL_RELEASE_AUDIT.md`,
`ENGAGEMENT_E1_TARGETED_FIX_REPORT.md`.

Scope: the 5 MEDIUM + 6 LOW findings left open after E1 (BUG-ENG-001/002/003
closed). Every item below was re-read directly against current HEAD, not
assumed from the original audit text.

---

## E1 regression re-check (all PRESENT)

| Check | Status | Evidence |
|---|---|---|
| hub-content ownership enforcement | **PRESENT** | `src/policies/hub-content-write-guard.ts` resolves the real row and compares `ownerEmail`/`ownerProfileId` via `matchesIdentity`; schema carries both fields, server-stamped only in the controller's `create`. |
| Farmer Question own update/delete | **PRESENT** | `hub-content-ownership.integration.test.ts`: "owner can update their own farmer question" / "owner can delete their own farmer question" both pass. |
| Cross-user answer flow not broken | **PRESENT** | Same suite: "a different user can still legitimately answer another user's farmer question" passes (title/descShort unchanged carve-out). |
| EngagementStore session isolation | **PRESENT** | `clearForSession()` clears `_notifiers`/`_viewRegisteredForKey`, wired into `AuthService._onSessionChanged`; 22/22 store tests pass including the new BUG-ENG-002 group. |
| PendingQueue owner binding | **PRESENT** | `EngagementPendingOperation.ownerId` set on every enqueue; `flush()` gates on `currentOwnerId`; 16/16 queue tests pass including the new BUG-ENG-003 group. |
| Legacy no-owner queue item fail-closed | **PRESENT** | Test "a legacy operation with no recorded owner is dropped fail-closed" passes; `flush()`'s `if (op.ownerId == null) { ...continue; }` branch confirmed in source. |
| Notification domain-event flow unbroken | **PRESENT** | No E1-touched file overlaps `notification_store.dart`/`strapi_service.dart`'s domain-event path or `notification.ts`; full 303/303 backend + 269/269 Flutter suites (which include the N1 notification regression coverage) pass unchanged. |

No regression found.

---

## Triage table

| ID | Severity | Live caller | User impact | Data/security impact | Fix scope | Release class | Decision |
|---|---|---|---|---|---|---|---|
| BUG-ENG-004 | MEDIUM | `GET /processed-products/mine`, `/public` (seller-center stats, `hesabim_page` premium dashboard, home/popular/featured ranking) | Confirmed still present: `processed-products.ts`'s `getMine`/`listPublic` `select` lists and `mapProduct` (services/processed-products.ts:113-139, 235-266, 268-298) still omit `viewCount`/`likeCount`/`favoriteCount`/`engagementVersion` entirely. Sellers see permanently-stale dashboard totals/ranking scores. | None — display-only. | Small, purely additive: add 4 field names to 2 `select` arrays + 4 fields to `mapProduct`'s returned object. No behavior change to any existing field. | **B — SHOULD FIX** | Low risk, small scope, directly serves "counters must be trustworthy" — good candidate to bundle into a short fix turn if one happens. |
| BUG-ENG-005 | MEDIUM | Home, popular listings, listing management, featured, category vitrin, `hesabim_page` — all via `ListingEngagementStore` | Confirmed still present: `seedCounts`'s `takeMax` (listing_engagement_store.dart:96-124) still only raises a cached count, never lowers it when the server's real value has decreased. | None — display-only, but wide-reaching (most list/dashboard surfaces). | Requires replacing the reconciliation strategy (trust-fresh-fetch instead of max) across a widely-shared store used by many screens — needs its own regression-test pass, not a quick additive change. | **C — DEFER** | Real bug, no security impact, needs a dedicated pass with proper before/after count-drop test coverage — too much surface to safely bundle into a 1-2 item turn. |
| BUG-ENG-006 | MEDIUM | ~10+ screens seeding `EngagementStore` with different partial value sets (home popular-hero, category/featured/search listing pages, `hesabim_page`, `premium_market_profile_page`, favorites page all seed `favorited`-only; `logistics_load_card`/`processed_unified_card` seed fuller sets) | Confirmed still present via direct grep of every `EngagementStore.I.seed(...)` call site. Practical impact is bounded: `EngagementSnapshot.seed()` is a no-op once `serverVersion>0`, so this only affects the brief window before the user's own first real interaction with that target this session — but the display can be materially incomplete during that window (e.g. no `favoriteCount` shown on a card until first toggle). | None — UX correctness only. | Auditing and standardizing every seed call site across ~10 files/screens to pass a consistent value set — real scope, no small patch closes it fully. | **C — DEFER** | Real but narrow-impact-window bug; fixing it fully means touching many screens — schedule as its own small pass rather than folding into E2. |
| BUG-ENG-007 | MEDIUM | `PUT /profile-settings/:id` (own row) | Confirmed still present: `src/api/profile-setting/controllers/profile-setting.ts` is still a fully stock `factories.createCoreController('api::profile-setting.profile-setting')` with zero field stripping — the only protection is the ownership policy (forces `profileId` to caller's own), no field-level guard at all, unlike listing/logistics/processed-product/ad. | Self-serving only — a user can set their own profile's displayed `viewCount` to an arbitrary value. | No cross-user impact, but undermines "counters are trustworthy" for a publicly-displayed number. | Small: add the same protected-field-strip pattern already used in `processed-product.ts`/listing/logistics controllers (mirror `ENGAGEMENT_ONLY_FIELDS`/`stripEngagementFields`) to `profile-setting`'s create/update. Mechanical, well-precedented, low regression risk. | **B — SHOULD FIX** | Low risk, small, mirrors an established in-repo pattern exactly — good candidate for a short fix turn. |
| BUG-ENG-008 | MEDIUM | `hesabim_page.dart`/`premium_market_profile_page.dart`'s cross-profile comment UI | Confirmed still present: `strapi_service.dart`'s `upsertProfileSettings` (lines ~1978-1990) still has the client-side safety gate that silently skips any cross-profile write (`pid != sessionOwnerId` → `return`) before it ever reaches the recipient's real row. A comment left on someone else's profile still never durably arrives. | None (the blocking behavior is actually the *correct* security response to a policy that structurally forbids cross-profile writes) — but the feature does not work for its stated purpose. | Requires a real design decision (dedicated profile-comment content-type with its own narrower authorization, or a backend action letting a commenter append to a different user's incoming-comments field safely) — explicitly not a quick patch per the original audit. | **C — DEFER** | Needs a product/architecture decision before any code is written. Recommend disclosing plainly that cross-profile comments are currently non-functional rather than shipping believing they work. |
| BUG-ENG-009 | LOW | `ProfileCommentsStore._loadIncomingFromStrapi` (any profile page rendering incoming comments) | Confirmed still present: `_loadIncomingFromStrapi` (profile_comments_store.dart:193-223) uses `remote?['incomingProfileComments']`/`incomingComments'` directly with no check that the returned row's own `profileId` matches the requested `id`. Never exposes another user's real data — only mislabels the viewer's own comments under a different profile's id. | Data mislabeling only, not a privacy leak. | Small: verify the returned row's `profileId` matches the requested id before caching/displaying. | **C — DEFER** | Real but low-severity cosmetic bug; low priority relative to the MEDIUM items. |
| BUG-ENG-010 | LOW | Account deletion (`auth-flow.ts deleteAccount`) + bootstrap malformed-offer cleanup (`offer-id-dedupe.ts`) | Confirmed still present: `deleteAccount`'s `deleted.offer = await deleteByFilter('api::offer.offer', ...)` (auth-flow.ts:355) and `offer-id-dedupe.ts`'s cleanup both delete offer rows via raw delete with no follow-up `recountListingOffers` call — grep confirms `recountListingOffers` is only referenced in `offer.ts`'s own create/update paths, never from these two raw-delete paths. | Affected listings show a stale-too-high `offerCount` until an unrelated future create/delete on the same listing happens to trigger a fresh recount. | Never negative, no security impact; self-correcting eventually. | Small: call `recountListingOffers(strapi, listingId)` for each affected listing after both raw-delete paths. | **C — DEFER** | Low severity, narrow/rare trigger (account deletion, one-time bootstrap job), self-correcting — safe to defer. |
| BUG-ENG-011 | LOW | Legacy `POST /listing-views` (`create` action, `auth: false`) | Confirmed still present and still live: `listing-view.ts` route config still has `create: { auth: false }`; the controller (`listing-view` controller) still derives the actor key from client-supplied `data.email`/`data.ownerId` when no JWT is present (`jwtEmail ? ... : email ? ... : ownerId ? ...`). Grep confirms **zero** Flutter callers of this endpoint anywhere in `lib/`. | None through the real app — reachable only via a direct, out-of-app API call. | A crafted direct API call could taint another real user's 24h view-dedup record by supplying their email/ownerId with no JWT. Real vulnerability at the endpoint level, but dormant from the shipped app's perspective. | Small: remove the route, or make it delegate to the same JWT-only actor derivation as `/engagements/view`. | **C — DEFER** | No live exploitation path through the app; worth closing eventually but not blocking this release. |
| BUG-ENG-012 | LOW | Legacy `POST /logistics-loads/:id/metrics/view` (`auth: false`) | Confirmed still present: `custom-logistics-load.ts` still registers this route with `auth: false`, no rate-limiting, IP-bucketed only. Grep confirms **zero** call sites of `LogisticsStore.trackLoadView(...)` anywhere in `lib/` (only the method's own definition/stub exist). | None through the real app. | Same disposition as BUG-ENG-011 — real but dormant. | Same fix options as BUG-ENG-011. | **C — DEFER** | Same reasoning as BUG-ENG-011. |
| BUG-ENG-013 | LOW | Account deletion (`auth-flow.ts deleteAccount`) | Confirmed still present: the full `deleted[...]` cleanup cascade in `deleteAccount` (auth-flow.ts) has no entry for `api::listing-comment.listing-comment` — a deleted user's listing comments (with their `ownerEmail`) persist indefinitely. Directly the same class of gap as BUG-NOTIF-005 (notification PII retention), which this project already closed as a dedicated N2 fix. | None beyond the retained rows themselves being visible to other users viewing that listing's comments (already-public content, but now orphaned from a deleted account). | Data retention (PII) after account deletion, pre-release hygiene concern given the direct precedent. | Small: add one more `deleteByFilter('api::listing-comment.listing-comment', { ownerEmail: email })` (or equivalent) call to the existing cascade, mirroring the pattern already used for every other content-type in that same function. | **A — FIX NOW** | Same class of issue as BUG-NOTIF-005, which was treated as release-worthy on its own; the fix is a single-line addition to an already-existing, already-tested cascade — minimal risk, real pre-release hygiene gap. |
| BUG-ENG-014 | LOW | hub-content/farmer-question `commentList`/`answers[]` (JSON blob) | Confirmed unchanged by E1 — E1.1 only added `ownerEmail`/`ownerProfileId` and enforced ownership on the top-level row; it did not touch the embedded JSON blob's client-side wholesale-overwrite update path. Two concurrent commenters can still clobber each other's writes. | Data-loss-under-concurrency (lost update), not an authorization gap — already distinct from and unaffected by BUG-ENG-001's fix. | Would require migrating to a real per-row comment content-type — a genuine architecture change. | Large — not a patch. | **C — DEFER** | Explicitly disclosed in-code as out of scope; consistent with how BUG-PREM-004-class deferred items were handled previously. |

---

## Summary

- **FIX NOW (A)**: 1 — BUG-ENG-013 (listing-comment PII retention on account deletion).
- **SHOULD FIX (B)**: 2 — BUG-ENG-004 (processed-product list projection), BUG-ENG-007
  (profile-setting.viewCount spoof protection). Both small, additive, low-risk,
  and directly serve the "counters must be trustworthy" goal — good
  candidates to bundle alongside BUG-ENG-013 in one short fix turn if desired.
- **DEFER (C)**: 8 — BUG-ENG-005, 006, 008, 009, 010, 011, 012, 014. All
  confirmed real, none release-blocking; several need either a dedicated
  regression-test pass (005), wide multi-screen scope (006), or a product/
  architecture decision (008, 014) before any code is written.
- **NOT A BUG / DEAD (D)**: none — every remaining finding is still
  genuinely present on current HEAD.

Not part of this triage's 5 MEDIUM + 6 LOW scope but worth a one-line note:
the audit's separate POTENTIAL RISK and PRODUCT DECISION sections
(ad legacy counter race, logistics-load `engagementVersion` reset parity,
processed-product reseed flicker, missing `ENGAGEMENT_API_CONTRACT.md`;
self-like/favorite on non-listing domains, listing-owner comment
moderation) were not re-triaged here and remain exactly as the audit left
them — none are release-blocking.

---

## Decision

**READY FOR TARGETED E2 FIX**

BUG-ENG-013 is a real, small, well-precedented pre-release fix (FIX NOW).
BUG-ENG-004 and BUG-ENG-007 are good, low-risk candidates to close in the
same short turn if the aim is to minimize what's left open before UAT.
The remaining 8 items are genuine but properly deferred — none block
release, and several need more scope (dedicated tests, multi-screen
changes, or a product decision) than a quick pass allows.

Per the mandate: stopping here. Not proceeding to code changes, commits,
push, or UAT automatically.
