# TARIM360+1 — Sprint 9: Engagement System Final Release Forensic Audit

READ-ONLY. No code changed, no commits, no push, `main` untouched, no
production mutation. Both repos audited on `release/preflight-integration`,
confirmed fully in sync with `origin` before starting (`git fetch` +
`status -sb` on both, no ahead/behind drift; backend HEAD `4760da3`,
Flutter HEAD `0e865a0`).

Method: 6 parallel research passes across both repos (listings;
processed products; logistics load+vehicle; profiles; offers+ads+comments;
a repo-wide server-authority/IDOR/idempotency sweep), plus a 7th
covering Flutter-side offline/cache/account-switch/notification wiring.
Every severe or surprising claim was then personally re-verified by
reading the actual source before being written into this report — in
particular the two most consequential findings (`hub-content-write-guard.ts`'s
missing ownership check, and `EngagementPendingQueue`'s cross-account
replay mechanism) were independently confirmed by direct reading, not
taken on trust.

**Note on a referenced document**: `ENGAGEMENT_API_CONTRACT.md` was
cited as the canonical design spec but does not exist in either repo
today (confirmed via full-tree glob in both) — it is referenced
extensively in code comments but appears to have been lost/never
committed. All contract statements below were reconstructed directly
from the living source (`utils/engagement-contract.ts`,
`utils/operation-idempotency.ts`, `utils/listing-metrics.ts`) rather
than from the missing doc. Worth restoring as a follow-up, not a
release blocker on its own.

**Final decision: RELEASE BLOCKED.**

**Counts:** CRITICAL 1 · HIGH 2 · MEDIUM 5 · LOW 6 · POTENTIAL RISK 4 ·
PRODUCT DECISION 2 · DEAD/LEGACY 8

---

## Engagement inventory (by feature)

| Entity | Actions | Live backend path | Server-authoritative? |
|---|---|---|---|
| Listing | favorite, like, view, share, comment, offerCount | `engagement-v1` (favorite/like/view), `listing-share`, `listing-comment`, `offer.ts` (offerCount) | Yes, all correct |
| Logistics Load | favorite, like, view | `engagement-v1` (canonical) + legacy `/logistics-loads/:id/metrics/*` (now unified backend-side, dead client-side) | Yes |
| Logistics Vehicle | favorite, view | `engagement-v1` only, no legacy route | Yes |
| Processed Product | favorite, like, view | `engagement-v1` | Yes on the backend; Flutter-side aggregate display is broken (BUG-ENG-004) |
| Profile | favorite, view, comment | `engagement-v1` (view), `engagement.ts` (favorite), JSON-blob-on-profile-setting (comment, no real endpoint) | View/favorite yes; comment is not durably server-backed at all (BUG-ENG-008) |
| Hub-content / Farmer Question | like, comment (JSON blob "answers") | `engagement-v1` (like), generic `PUT/DELETE /hub-contents/:id` (comment/answer + the whole post) | Like: yes. Comment/answer/post ownership: **no** (BUG-ENG-001, CRITICAL) |
| Ads | like (dormant), view/impression | `engagement-v1` (impression, correct); `ad-event.ts` (legacy showCount/displayCount, non-atomic) | Yes for the live field; feature is dormant (`enableSmartAds=false`) |
| Offer | count only (no like/favorite/view) | `offer.ts` create/updateByOfferId, `recountListingOffers` | Yes for the primary path; drifts on 2 secondary raw-delete paths (BUG-ENG-010) |

---

## Findings

### CONFIRMED BUG

**BUG-ENG-001 — CRITICAL — RELEASE BLOCKER**
- **Live caller**: `PUT/DELETE /hub-contents/:id` — granted to the authenticated role (`src/index.ts:273-277`), gated only by `global::hub-content-write-guard`.
- **Entity/action**: hub-content (covers both ordinary Knowledge Hub posts and Farmer Questions — confirmed the same content-type, no split) — update and delete.
- **Expected**: only a row's own author (or an explicitly-designated moderator) can update or delete it.
- **Actual**: verified directly in `src/policies/hub-content-write-guard.ts:79-114` — the guard only restricts **founder-only kinds** (`knowledge`/`agridata`, via `isFounderOnlyKind`). For every other kind — which includes ordinary posts and `farmerQuestion` — line 98-100 returns `true` unconditionally for any authenticated identity, with **no comparison of the caller's identity to the row's own author/owner field anywhere in the policy**. The controller (`src/api/hub-content/controllers/hub-content.ts:36-50`, also read directly) adds no ownership check of its own either — it only strips `likes`/`engagementVersion` and delegates straight to Strapi's default `super.create`/`super.update`; `delete` isn't overridden at all.
- **Root cause**: the founder-only-kind restriction was built as the *only* authorization axis for this policy; per-row authorship was never added for the (much more common) non-founder-kind case.
- **Backend**. **Security/data impact**: any authenticated user can overwrite another user's entire farmer question or hub post (including forging comment/answer authorship inside the JSON blob, or deleting other users' comments/answers), or delete the post outright. This is a genuine, live, exploitable IDOR against real, currently-used content.
- **Minimum safe fix**: add a real per-row ownership check for non-founder-only kinds on `update`/`delete` (author email/profileId match against the row's own stored author field, mirroring the pattern already used for listing/logistics/profile-setting), while preserving the founder-only-kind restriction and the existing "reaction-only update" bypass for legitimate engagement fields if that's still wanted.
- **Required regression tests**: non-author cannot update or delete another user's hub-content/farmer-question row (403); the author can still update/delete their own; founder-only kinds remain founder-restricted; the reaction-only bypass (likes/commentCount passthrough) still works for a non-owner's legitimate engagement action if retained by design.

**BUG-ENG-002 — HIGH**
- **Live caller**: every real listing/logistics-load/logistics-vehicle/processed-product/hub-content like-or-favorite screen goes through `EngagementStore`.
- **Entity/action**: cross-domain — `EngagementStore` (Flutter), the shared like/favorite/view state manager.
- **Expected**: owner-scoped state must be cleared on logout/account switch, like every other such store in this app.
- **Actual**: confirmed directly — `EngagementStore` has zero references to `clearForSession` (verified via grep), and `main.dart`'s `_onSessionChanged` never calls one for it either (verified directly). Its `_notifiers` map is keyed purely by `EngagementTarget.cacheKey` (`type::id`), never by owner.
- **Root cause**: same class of gap as the already-fixed `PurchaseStore` (BUG-PREM-005), not yet extended to `EngagementStore`.
- **Flutter only**. **Security/data impact**: cross-account state leak — once user A likes/favorites something in the current app process, that liked/favorited boolean (and locally-known count) is shown to user B if B logs in on the same device afterward, with no self-correction short of B independently re-toggling that exact target.
- **Minimum safe fix**: add `EngagementStore.clearForSession()` (clear `_notifiers`) and wire it into `_onSessionChanged` alongside every other owner-scoped store.
- **Required regression tests**: A likes/favorites listing X → logout → B logs in → B's `EngagementStore` snapshot for X shows not-liked/not-favorited (i.e. is cleared, not carried over).

**BUG-ENG-003 — HIGH**
- **Live caller**: `EngagementPendingQueue.flush()`, called from `main.dart`'s `_refreshSessionFeeds` on every session change while logged in.
- **Entity/action**: cross-domain — the retry queue for failed like/favorite/share/comment mutations.
- **Expected**: a queued mutation should only ever be replayed under the identity of the user who originally performed it.
- **Actual**: confirmed directly by reading `engagement_pending_queue.dart` in full — the queue is persisted under one global (non-owner-scoped) prefs key (`engagement_pending_queue_v1`), `EngagementPendingOperation` carries no owner/session field, and `flush()` (lines 167-227) fetches whatever JWT is currently active (`_jwtProvider()` = `StrapiService.readJwt`) with no association back to who queued each op.
- **Root cause**: the queue was built without session-scoping, on the (reasonable-looking but incorrect) assumption that flush would always run under the same session that enqueued the operation.
- **Both** (the bug is entirely client-side; the backend correctly attributes the replayed action to whoever's JWT accompanies it, which is exactly what it should do given what it's told). **Security/data impact**: cross-account action misattribution — a real like/favorite/share/comment that failed for user A and got queued can be silently submitted under user B's identity if B logs in on the same device before A's op is retried or dropped. No malicious action is required to trigger this — an ordinary network hiccup plus a quick account switch is enough.
- **Minimum safe fix**: namespace the persisted queue by owner id (matching the pattern already used elsewhere, e.g. `NotificationStore`'s `_storageKeyForCurrentSession`), and ensure a session change either flushes only the current owner's own queued ops or otherwise prevents cross-owner replay.
- **Required regression tests**: A queues a failed like (simulate a network failure), logs out before it's retried, B logs in — assert B's login does not cause A's queued like to be submitted under B's identity, and that A's op is still available (or safely dropped) without misattribution.

**BUG-ENG-004 — MEDIUM**
- **Live caller**: `GET /processed-products/mine` and `/public`.
- **Entity/action**: processed-product favorite/like/view counts, as displayed on the seller-center stats sheet, the `hesabim_page` premium dashboard totals, and the home/popular/featured ranking scores.
- **Expected**: these aggregate surfaces should reflect real, current engagement data.
- **Actual**: confirmed directly — `processed-products.ts`'s `getMine`/`listPublic` response projection (`mapProduct`, lines 114-138, and both `select` lists) never includes `viewCount`/`likeCount`/`favoriteCount`/`engagementVersion` at all. `ProcessedProductInsightsStore.seedCounts`'s `takeMax` reconciliation (the only ingestion path for these fields) therefore always receives `null` from every real fetch and no-ops — these counts are frozen at whatever was last written to local prefs (from before this migration, or `0` on a fresh install), never refreshed by any normal list/mine/public fetch.
- **Root cause**: the backend's list-endpoint response shape was never updated to project these fields after the underlying counters moved to the new atomic engagement-core system.
- **Both**. **Security/data impact**: none — a real, user-facing correctness issue (sellers see permanently-stale dashboard totals and ranking scores), not a security one.
- **Minimum safe fix**: include `viewCount`/`likeCount`/`favoriteCount`/`engagementVersion` in `getMine`/`listPublic`'s response projection.
- **Required regression tests**: fetch `mine`/`public` after a real like/favorite/view on a processed product and assert the response includes the updated counts.

**BUG-ENG-005 — MEDIUM**
- **Live caller**: home page, popular listings, general listing management, featured listings, category vitrin page, `hesabim_page` — all read `ListingEngagementStore` directly.
- **Entity/action**: listing favorite/like/view/offer counts as cached locally.
- **Expected**: a locally-cached count should track the server's real current value, in both directions.
- **Actual**: confirmed — `ListingEngagementStore.seedCounts`'s `takeMax` reconciliation only ever *raises* a cached value to match a higher server value; it never lowers it when the server's true value has since decreased (e.g., another user un-favorited).
- **Root cause**: `takeMax` was designed for "catch up on missed increments," not for a value that legitimately moves in both directions.
- **Flutter only**. **Security/data impact**: none, display-correctness only — but wide-reaching, affecting most of the app's list/dashboard surfaces.
- **Minimum safe fix**: reconcile by always trusting the freshly-fetched server value directly (replace, not `takeMax`) once a real fetch response is available.
- **Required regression tests**: seed count=5 locally, then seed again from a fresh fetch reporting count=2; assert the displayed count becomes 2.

**BUG-ENG-006 — MEDIUM**
- **Live caller**: search results page, listing detail page, home popular-hero card, featured listings page.
- **Entity/action**: listing favorite/like count display consistency across screens.
- **Expected**: the same listing's count should read the same everywhere.
- **Actual**: confirmed — different screens seed `EngagementStore`'s shared-by-cacheKey snapshot with different, sometimes-partial value sets before the current user has personally toggled that target this session (e.g. the home popular-hero card never seeds `favoriteCount` at all). Because `EngagementSnapshot.seed()` only no-ops once `serverVersion>0`, whichever screen seeds first (with incomplete data) can leave a materially wrong display on a screen that hasn't independently seeded the full value set.
- **Root cause**: inconsistent, ad-hoc partial seed-value construction per screen rather than a single shared, complete seeding path.
- **Flutter only**. **Security/data impact**: none, UX correctness only.
- **Minimum safe fix**: standardize every screen's seed call to pass the full known set of counts it already has available.
- **Required regression tests**: seed the same target from two different partial seed calls in sequence; assert the final snapshot reflects the most complete/correct values, not whichever seeded first.

**BUG-ENG-007 — MEDIUM**
- **Live caller**: `PUT /profile-settings/:id` (a user's own row).
- **Entity/action**: `profile-setting.viewCount`.
- **Expected**: server-computed only, like every other engagement counter in this codebase.
- **Actual**: confirmed directly — `profile-setting`'s controller (`src/api/profile-setting/controllers/profile-setting.ts`) is a fully stock `factories.createCoreController` with zero field-stripping. Only the row-ownership policy exists (forces `profileId` to the caller's own); no field-level protection exists at all, unlike listing/logistics-load/logistics-vehicle/processed-product/ad, which all have one.
- **Root cause**: `profile-setting` was never given the protected-field strip pattern used everywhere else.
- **Backend only**. **Security/data impact**: self-serving metric inflation (a user can set their own profile's displayed view count to any value) — not an attack on another user's data.
- **Minimum safe fix**: add a protected-field strip (at minimum `viewCount`, `engagementVersion`) to `profile-setting`'s create/update actions.
- **Required regression tests**: a user PUTs their own profile-setting with an arbitrary `viewCount`; assert the server ignores it.

**BUG-ENG-008 — MEDIUM**
- **Live caller**: `hesabim_page.dart`/`premium_market_profile_page.dart`'s "leave a comment on this profile" UI.
- **Entity/action**: profile comment (cross-user).
- **Expected**: a comment left on another user's profile should durably reach that user.
- **Actual**: confirmed via direct tracing — when user X comments on user Y's profile, the write is skipped **client-side** (`strapi_service.dart:1983-1990`'s safety gate, added specifically because the server's per-profile ownership policy would reject a cross-profile write anyway) before it ever reaches Y's real row. The comment survives only in X's local, unpersisted, in-session memory; a notification is sent, but with a fixed template, never the actual comment text. Y's real backend document is never updated by this flow.
- **Root cause**: profile comments have no dedicated backend delivery mechanism — the feature relies on writing into the recipient's own JSON blob field, which the (correct) per-profile ownership policy structurally forbids from anyone but the recipient themselves.
- **Both**. **Security/data impact**: none (the blocking behavior is actually correct/intentional from a security standpoint) — but the feature does not work for its stated purpose today.
- **Minimum safe fix**: requires a real design decision (a dedicated profile-comment content-type with its own authorization, or a backend action that legitimately lets an authenticated commenter append to a *different* user's incoming-comments field under its own, narrower authorization). Not a small fix — recommend disclosing this clearly as a known non-functional feature rather than shipping believing it works, and scoping the real fix as a follow-up.
- **Required regression tests**: X comments on Y's profile; Y's own subsequent fetch actually shows the comment.

### LOW

**BUG-ENG-009 — LOW** (data mislabeling, not a privacy leak): viewing another user's profile can display *your own* incoming comments under their profile id, because `ProfileCommentsStore._loadIncomingFromStrapi` never verifies the returned document's `profileId` matches the requested target before caching/displaying it — the ownership policy correctly redirects the GET to the caller's own scope, but the client doesn't notice. Never exposes another user's real data (always the viewer's own, just mislabeled). Same root-cause family plausibly affects `profile_rating_store.dart`/`profile_follow_store.dart`/`business_vertical_store.dart` (not independently audited here). Fix: verify the returned row's own `profileId` matches the requested id before using it.

**BUG-ENG-010 — LOW**: offer count drift after account-deletion and the bootstrap malformed-offer cleanup job — both delete `api::offer.offer` rows via raw `db.query(...).delete()`/`deleteMany()` without a follow-up `recountListingOffers` call, leaving affected listings' `offerCount` stale-too-high until an unrelated future create/delete on the same listing happens to trigger a fresh recount. Never negative, no security impact. Fix: call `recountListingOffers` for each affected listingId after both raw-delete paths.

**BUG-ENG-011 — LOW**: the legacy `/listing-views` route derives its view-dedup actor-key from a client-supplied `email`/`ownerId` field when no JWT is present, letting an anonymous direct-API caller fabricate a view-event actor-keyed as an arbitrary real user's email (tainting that user's 24h dedup record, shared with the canonical table). Confirmed no live Flutter caller exists — dormant from the real app's perspective, reachable only via a direct, out-of-app API call. Fix: remove the route, or make it delegate to the same JWT-only actor derivation as `/engagements/view`.

**BUG-ENG-012 — LOW**: the legacy `/logistics-loads/:id/metrics/view` route has no rate-limiting and always buckets by IP (not per-authenticated-user), since it's `auth:false` with no soft-auth middleware. Confirmed zero live Flutter callers (`trackLoadView` is dead code client-side). Same disposition as BUG-ENG-011.

**BUG-ENG-013 — LOW**: `listing-comment` rows are not included in the account-deletion cleanup cascade (`auth-flow.ts`'s `deleteAccount` never calls `deleteByFilter`/soft-delete for this content-type) — a deleted user's listing comments (with their `ownerEmail`) persist indefinitely. Same class of gap as the already-fixed BUG-NOTIF-005 (notification PII retention), not yet applied here. Fix: extend the account-deletion cascade to also clean up (or anonymize) the deleted user's `listing-comment` rows.

**BUG-ENG-014 — LOW**: hub-content/farmer-question `commentList`/`answers[]` and their counts are computed via wholesale client-side array overwrite (not a real per-row recount), so two concurrent commenters can clobber each other's writes (lost update), silently dropping a comment/answer and under-counting. Distinct from BUG-ENG-001 (an authorization gap) — this is a data-loss-under-concurrency risk stemming from the architectural choice to embed comments as a JSON blob rather than real rows, explicitly disclosed in-code as "out of scope for Faz D6." Recommend **DEFER** — fixing this properly requires migrating to a real per-row comment content-type (a genuine architecture change, not a quick patch), consistent with how BUG-PREM-004/similar deferred items were handled in prior phases.

### POTENTIAL RISK

- Ad legacy `showCount`/`displayCount`/`viewCount` (`ad-event.ts`) use a non-atomic read-then-write (`Number(ad.x)+1`), race-prone under concurrent impressions — but the smart-ads feature is confirmed **dormant** (`AppFeatureFlags.enableSmartAds = false`), so this is low-priority today; would need fixing before the flag is ever flipped on.
- Logistics-load's `sanitizeCreateData` doesn't reset `engagementVersion` on create (the vehicle controller's equivalent does) — a client could set an arbitrary initial value. No access-control impact (`engagementVersion` is a cache-staleness hint only, never a CAS/security token per the contract) — a parity/consistency fix, not urgent.
- A narrow reseed race exists for processed-product engagement during the very first pending mutation on a target this session (before `serverVersion>0`): a sibling widget rebuilding and reseeding mid-flight can momentarily flicker the optimistic UI back to a stale state. Self-corrects once the real response lands; no lasting incorrect state.
- The missing `ENGAGEMENT_API_CONTRACT.md` file itself — referenced everywhere in code comments as the source of truth but absent from both repos. Worth restoring so future audits don't have to reconstruct it from source each time.

### PRODUCT DECISION (flagging for confirmation, not asserting as wrong)

- Self-like/self-favorite is blocked only for `listing` (`isOwnListingTarget`) — processed-product, logistics-load, logistics-vehicle, and ad have no equivalent restriction, so a seller can like/favorite their own item to inflate its apparent popularity. The contract's own design (profile's self-view exclusion comment states this is deliberately scoped, domain-by-domain) suggests this may be intentional, but it's worth an explicit confirmation given the social-proof-spoofing angle.
- `listing-comment` delete only allows the comment's own author — a listing owner cannot moderate/delete abusive comments on their own listing. No stated requirement this should work differently; flagging as a product question, not a bug.

### DEAD/LEGACY

- `toggleProfileList`/`updateListingCounter` (`engagement.ts`) — confirmed zero callers, superseded by `delegateListingMembershipToggle`/`setMembership`.
- `ListingEngagementStore._syncListingMetrics`'s PUT of protected counter fields — wasted network traffic on every favorite/offer registration; the backend already strips every field it sends, so it has zero server effect.
- `_ProcessedMiniProductCard` (Flutter) — hardwired to the legacy store's view count, zero instantiation sites anywhere in the app.
- Legacy `LogisticsStore.setLoadLike`/`setLoadFavorite`/`trackLoadView` — zero call sites; the live UI exclusively uses `EngagementStore`.
- `ad.izlenmeCount` — schema field with no live write path anywhere.
- `ad.likeCount`/`ad.favoriteCount` (plain integer fields, distinct from `likes`) — unreachable given `DOMAIN_SUPPORT.ad`'s gating.
- `src/api/logistics-load/policies/require-logistics-premium.js` — a duplicate, unreachable/shadowed copy of the real (`src/policies/`) policy.
- `NotificationStore.pushRemoteTarget` — zero remaining engagement-relevant callers post-N1 (only `farmer_question_models.dart`, already disclosed as an out-of-scope, deliberately-deferred gap in the N1 report).

---

## Previous fix regression — PRESENT / MISSING / REGRESSED

| Item | Status | Evidence |
|---|---|---|
| Listing legacy metric write removal | **PRESENT** | `LISTING_CLIENT_PROTECTED_FIELDS` strips all 11 counter/metadata fields on both `create`/`update`, re-verified directly |
| Ads impression double-count fix | **PRESENT** | `ad-click.ts` touches no ad counter field at all; `ad-event.ts` only bumps legacy fields, never `impressions`; re-verified against the existing test file |
| Processed-product stale count fix (view double-count via `openProcessedProductDetail`) | **PRESENT** | The extra unconditional `registerPublicView` call is confirmed removed, only a comment remains explaining why |
| offerCount server-authoritative fix | **PRESENT**, with a caveat | Correct for create/delete via the controller (BUG-ENG-010 is a *different*, secondary drift source, not a regression of the original fix) |
| `recountListingOffers` | **PRESENT** | Defined and wired exactly as before, re-verified directly |
| Listing detail favorite mirror fix | **PRESENT** | `listing_detail_page.dart`'s `_toggleFav` still mirrors into `FavoritesStore.addListingLocal`/`removeListingLocal` |
| Listing offline-sync protected counters | **PRESENT** | `syncOfflineListing` strips the same protected-field list and re-forces ownership fields from server identity |
| Logistics ownership canonical fix (S1) | **PRESENT** | `matchesOwnerKey` is still the primary check on both load and vehicle controllers, legacy numeric fallback kept only as a secondary path |
| Notification domain-event producer | **PRESENT**, wiring re-verified correct | Zero remaining engagement-relevant callers of the old `pushRemoteTarget`; every favorite/like/comment interaction site fires exactly one `pushDomainEvent` call, gated on success and the activation direction only |

No regression found in any previously-shipped, previously-verified fix.

---

## Test coverage — entity-by-entity summary

Backend: strong, direct coverage exists for listing (favorite/like/view/share/comment/offerCount), logistics-load/vehicle (favorite/like/view, ownership, cross-route convergence), processed-product (favorite/like/view, spoof-rejection), profile (view, ownership, public-profile allowlist), ads (impression double-count), and idempotency (comment/share/rocket-activation/message). Flutter: `EngagementStore`/`EngagementRepository`/`EngagementPendingQueue` have solid unit coverage (optimistic update, rollback, cross-widget sharing, seed-doesn't-clobber-confirmed), matched per-domain for logistics-load/vehicle, processed-product, hub-content, farmer-question, approved-ads, and profile-view.

**Missing, confirmed by direct inspection, not assumed:**
- No test anywhere exercises the hub-content ownership gap (BUG-ENG-001) — the missing check has zero regression coverage today.
- No `clearForSession`/account-switch test exists for `EngagementStore`, `ListingEngagementStore`, `ProcessedProductInsightsStore`, `FavoritesStore`, `FavoriteProfilesStore`, `ProfileCommentsStore`, `ProfileFollowStore`, or `OffersStore` — the only precedent is `PurchaseStore`'s (from the Premium phase), never extended to engagement.
- No test exercises `EngagementPendingQueue` across a session/account switch (would have caught BUG-ENG-003).
- No cross-surface/cross-screen consistency test (would have caught BUG-ENG-004/005/006).
- No `POST /profile-favorites/toggle` test file at all.
- No test for the offer-count-drift-on-account-deletion path (BUG-ENG-010).
- No spoof-attempt test for `profile-setting.viewCount` (BUG-ENG-007) or an engagement-endpoint-used-as-a-metadata-mutation-bypass test for any domain (all currently safe by code inspection, but untested against future regression).

---

## Decision

**RELEASE BLOCKED.**

BUG-ENG-001 is a real, currently-exploitable IDOR: any authenticated user
can overwrite or delete any other user's farmer question or hub-content
post today. This alone blocks release. BUG-ENG-002 and BUG-ENG-003 are
both real cross-account data-integrity bugs (state leak and action
misattribution respectively) that should reasonably close in the same
pass, given how directly they parallel the just-fixed `PurchaseStore`
precedent and how easily an ordinary shared-device account switch
triggers them.

Recommend an **Engagement Targeted Fix phase** (mirroring the Premium
P1 / Notification N1 structure) covering, at minimum, BUG-ENG-001/002/003
as release blockers. BUG-ENG-004 through 007 (MEDIUM) are small,
well-scoped fixes worth bundling into the same phase given their
direct relevance to counters actually being trustworthy at release.
BUG-ENG-008 (profile comments non-functional) needs a product decision
before any fix, not a quick patch — recommend deferring the fix but
disclosing the current non-functional state explicitly. BUG-ENG-009
through 014 (LOW) and the POTENTIAL RISK/PRODUCT DECISION items are
candidates for a fast triage pass (blocker/defer), matching the
Notification system's own N2 triage precedent, once 001-003 are closed.

Per the audit instruction: stopping here. Not proceeding to code fixes
automatically. No commits, no push, no production mutation were made
during this audit.
