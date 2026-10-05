# TARIM360+1 — ENGAGEMENT TARGETED FIX E2 — REPORT

Scope: close BUG-ENG-013 (FIX NOW), BUG-ENG-004 (SHOULD FIX), BUG-ENG-007
(SHOULD FIX) from `ENGAGEMENT_E2_FOLLOWUP_TRIAGE.md`. The other 8 DEFER
findings were not touched.

Backend: `tarim360-strapi`, branch `release/preflight-integration`.
Flutter: `tarim360`, branch `release/preflight-integration` — **no Flutter
changes were needed**; all three fixes are backend-only (confirmed for
BUG-ENG-004 specifically: `ProcessedProductItem.fromMap` already reads
`viewCount`/`favoriteCount`/`likeCount` from the response and feeds
`ProcessedProductInsightsStore.seedCounts` on every parse — this was a
pure read-projection gap on the backend, nothing to change client-side).

---

## BUG-ENG-013 — Account deletion + listing comments — CLOSED

**Root cause**: `auth-flow.ts`'s `deleteAccount` cleanup cascade covered
notifications, messages, offers, listings, ads, processed products, and
more, but never `api::listing-comment.listing-comment` — a deleted
user's `ownerEmail` (PII) survived indefinitely on their public listing
comments. Same class of gap as the already-fixed BUG-NOTIF-005.

**Fix**: the real schema fields are `ownerId`/`ownerEmail` (confirmed
directly from `listing-comment`'s schema — `authorEmail`/`authorProfileId`/
`profileId` do not exist on this content-type, so those were not used).
Before deleting, the affected `listingId`s are collected from the
soon-to-be-deleted rows; the rows are then hard-deleted via the same
`deleteByFilter` pattern used for every other content-type in this
cascade; each affected listing's cached `commentCount` is then recounted
via the existing `recountListingComments` utility (which safely no-ops
if that listing was also deleted in the same pass).

**Tested**: A comments then deletes their account → the comment row is
gone (hard-deleted, not soft-marked). B's comment on the same listing
survives A's deletion. An unrelated comment on a different listing by a
different user is untouched. After cleanup, exactly the real remaining
comment (B's) is left for that listing. Notification cleanup is
unaffected by the new step. Account-deletion permission (the PERM-N2
fix) still works end-to-end.

---

## BUG-ENG-004 — Processed product engagement fields — CLOSED

**Root cause**: `getMine`/`listPublic` (in
`processed-products/services/processed-products.ts`) never selected or
returned `likeCount`/`favoriteCount`/`viewCount`/`engagementVersion` at
all — confirmed directly by reading both `select` arrays and
`mapProduct`. On the Flutter side, `ProcessedProductItem.fromMap` (in
`processed_product_models.dart`) already calls
`ProcessedProductInsightsStore.I.seedCounts(...)` with values picked
from this exact response on every parse — so the store's reconciliation
always received `null` and could never refresh, freezing the
seller-center stats sheet and every card's initial seed at whatever was
last cached.

**Endpoints/callers verified**: `GET /processed-products/public`
(`listPublic`, public, no premium gate) and `GET /processed-products/mine`
(`getMine`, premium-gated via `requireActivePremium`) both live in the
`processed-products` (plural) content-type's controller/service — the
one Strapi actually routes to (the `processed-product` singular
content-type's identically-pathed actions are dead/shadowed, per the
existing D5-B report). The product **detail** page
(`processed_product_detail_page.dart`) and the **management** page's
per-card widgets read live counts directly from `EngagementStore`'s
canonical snapshot (server-authoritative already, confirmed by reading
both files) — only the **seller-center stats sheet**
(`processed_seller_center_page.dart`, via
`ProcessedProductInsightsStore.I.favoriteCountOf`) and card **initial
seed values** (`processed_unified_card.dart`) were actually affected, and
both are fixed by this same backend change with zero Flutter code
changes.

**Fix**: added `likeCount`/`favoriteCount`/`viewCount`/`engagementVersion`
to both `select` arrays and to `mapProduct`'s returned object (via a new
`asCount` coercion helper). Read-projection only — no write path
touched; `engagement-core` (`setMembership`/`registerView`) remains the
sole writer of these fields, and the existing spoof-rejection tests
(generic create/update ignoring client-supplied counts) are unaffected.

**Tested**: `GET /processed-products/public` returns the real,
current `likeCount`/`favoriteCount`/`viewCount`/`engagementVersion`
after a real like/favorite/view. `GET /processed-products/mine` (with a
seeded premium profile) returns the same real count as `/public` for the
owner's own product.

---

## BUG-ENG-007 — Profile viewCount spoof protection — CLOSED

**Root cause**: `profile-setting`'s controller was a fully stock
`factories.createCoreController('api::profile-setting.profile-setting')`
with zero field stripping — confirmed directly, unlike every other
engagement-bearing content-type (listing/logistics/processed-product),
which all strip their counter fields on create/update. A user could PUT
their own profile-setting row with an arbitrary `viewCount` to
self-inflate a publicly-displayed number.

**Fix**: added the same protected-field-strip pattern already used in
`processed-product.ts` (`ENGAGEMENT_ONLY_FIELDS`/`stripEngagementFields`)
to `profile-setting`'s `create`/`update` actions, stripping `viewCount`
and `engagementVersion` from any client-supplied payload before
delegating to the stock action. The canonical `POST /engagements/view`
flow (`engagement-view-service.ts`) writes via `db.query`/
`db.transaction` directly — never through this controller — and is
completely untouched by this fix, including its existing self-view
exclusion for `targetType: 'profile'`.

**Tested**: a normal update with `viewCount: 999999` is ignored (stays
0). `engagementVersion` spoof is likewise ignored, while the rest of a
legitimate update (`displayName`) still lands. A genuine bio/city update
still works normally. Create-time spoofing of both fields is ignored.
Regression: the canonical `POST /engagements/view` flow still
increments a profile's real `viewCount` for a genuine visitor, and a
self-view still does not inflate the owner's own count (existing,
untouched server-side contract).

---

## E2.4 — Regression re-check (all unaffected)

None of E2's three touched files (`auth-flow.ts`,
`processed-products/services/processed-products.ts`,
`profile-setting/controllers/profile-setting.ts`) overlap with
`hub-content-write-guard.ts`, `EngagementStore`, `EngagementPendingQueue`,
or the notification domain-event path. Confirmed via the full backend
and Flutter suites, which include this exact coverage and pass
unchanged:

| Check | Status |
|---|---|
| EngagementStore session isolation | **PRESENT** — Flutter suite includes the E1 BUG-ENG-002 test group, all pass |
| PendingQueue owner binding | **PRESENT** — E1 BUG-ENG-003 test group, all pass |
| Farmer Question ownership | **PRESENT** — `hub-content-ownership.integration.test.ts`, all pass |
| Cross-user answer flow | **PRESENT** — same suite, "can still legitimately answer" test passes |
| Processed product entitlement | **PRESENT** — `processed-products-premium-gate.integration.test.ts` + this phase's own premium-gated `mine` test pass |
| Notification domain-event | **PRESENT** — `notification-n1-security-fix.integration.test.ts`, all pass |
| Account deletion notification cleanup | **PRESENT** — pre-existing notification tests in `auth-flow-delete-account.integration.test.ts` pass unchanged alongside the new listing-comment tests |
| Public profile privacy | **PRESENT** — `public-profile-read.integration.test.ts` + `profile-setting-ownership.integration.test.ts`'s SEC-1 GET-list tests pass unchanged alongside the new BUG-ENG-007 tests in the same file |

No regression found.

---

## Validation

**Backend** (`tarim360-strapi`):
- `npx tsc --noEmit` — clean.
- `npm run test:unit` — 31/31 pass.
- `npm run test:integration` — 317/317 pass (303 pre-E2 + 14 new: 2
  processed-product list-projection tests, 6 profile-setting field-
  protection tests, 6 auth-flow listing-comment cleanup tests).
- `npm run build` — clean.
- `git diff --check` — clean.

**Flutter** (`tarim360`):
- `flutter analyze` — 2 issues, both pre-existing/unrelated
  (`_normalizeLogisticsWhatsApp`/`_titleCaseWords` in
  `logistics_models.dart`).
- `flutter test` — 269/269 pass, unchanged (no Flutter files were
  touched this phase).
- `git diff --check` — clean (no changes to check).

No production mutation was performed.

---

## Commits

Backend (`tarim360-strapi`, `release/preflight-integration`):
- `67250e2` — `fix(auth): remove listing comments on account deletion`
- `9295dc2` — `fix(processed-products): expose authoritative engagement counts`
- `68973d2` — `fix(profile): protect profile engagement counters`
- `f62470f` — `test(engagement): add final release regression coverage`

Flutter: no commits (no changes needed).

Pushed to `release/preflight-integration` only (backend). No merge to
main. No deploy.

---

## Remaining — 8 DEFER items (unchanged, carried over from E2 triage)

- BUG-ENG-005: `ListingEngagementStore.seedCounts`'s `takeMax` never
  lowers a cached count — needs a dedicated reconciliation-strategy pass
  with its own regression tests.
- BUG-ENG-006: inconsistent partial `EngagementStore.seed()` value sets
  across ~10+ screens — needs a multi-screen standardization pass.
- BUG-ENG-008: cross-profile comments are silently dropped client-side —
  needs a product/architecture decision before any code.
- BUG-ENG-009: `ProfileCommentsStore._loadIncomingFromStrapi` doesn't
  verify the returned row's own `profileId` — data mislabeling only, low
  priority.
- BUG-ENG-010: offer-count drift after raw deletes (account deletion,
  malformed-offer cleanup) with no follow-up recount — narrow, self-
  correcting, no security impact.
- BUG-ENG-011: dormant legacy `POST /listing-views` route accepts a
  client-supplied actor key with no JWT — zero live Flutter callers.
- BUG-ENG-012: dormant legacy `POST /logistics-loads/:id/metrics/view`
  route, no rate-limit — zero live Flutter callers.
- BUG-ENG-014: hub-content/farmer-question embedded comment JSON blob is
  vulnerable to concurrent lost updates — explicitly disclosed
  architecture debt, needs a real per-row comment content-type.

None are release-blocking.

---

## Decision

**READY FOR UAT**

All release-blocking and should-fix engagement findings identified
across the Engagement audit (Sprint 9), E1 (BUG-ENG-001/002/003), and E2
(BUG-ENG-013/004/007) are now closed, tested, and regression-verified
with zero test failures across both repos. The remaining 8 DEFER items
are real but properly scoped out of this release — none threaten data
integrity, security, or core functionality.

Per the mandate: stopping here. Not proceeding to UAT myself — this
closes the code-side audit/fix work; real-device UAT is the next phase.
