# TARIM360+1 — PREMIUM TARGETED FIX PHASE P1 — Report

Scope: close the two RELEASE BLOCKER findings from
`PREMIUM_SYSTEM_RELEASE_FORENSIC_AUDIT.md` (BUG-PREM-001 CRITICAL,
BUG-PREM-003 HIGH), plus BUG-PREM-005 (MEDIUM, logout/account-switch
cache) in the same phase, and re-evaluate BUG-PREM-004 (LOW, stale
listing badge). All work done on `release/preflight-integration` in
both repos. No merge to `main`, no production deploy.

Decision: **READY FOR NOTIFICATION AUDIT**

---

## BUG-PREM-001 (CRITICAL) — rocket activation had no real
server-side authority

**Old flow.** `active_rocket_listings_page.dart`'s
`_syncRocketStateToStrapi` sent a plain `PUT /listings/:id` with
`isDoping`/`rocketEndsAt` in the body. The only backend protection was
a field-level guard on the generic update action (added in the
Phase A listing fix) that stripped those fields from client payloads
on the *normal* update path — but the rocket page's PUT still landed
on that same action, meaning any bypass of that guard, or a future
regression to it, would let a client set its own rocket state with no
ownership or entitlement check at all.

**New flow.** A dedicated `POST /listings/:id/rocket/activate`
(`src/api/listing/routes/custom-listing.ts` →
`listing.activateRocket`, `src/api/listing/controllers/listing.ts`):

1. `readIdentity` → 401 if missing.
2. Validates `days` (7/14/28) and a client-supplied UUID
   `operationId` → 400 on either being malformed.
3. Looks up the listing via `findListingByAnyId` → 404 if missing.
4. Verifies real ownership (`matchesIdentity`) → 403 for a non-owner.
5. Runs the request through the existing idempotency utility
   (`operation-idempotency.ts`, already used by
   `listing-comment`/`listing-share`): a retry with the same
   `operationId` + same fingerprint returns the cached result; the
   same `operationId` with a different fingerprint is a 409 conflict.
6. Derives entitlement **server-side**, from one of two existing
   sources of truth (no new/parallel system):
   - the profile's `activePremium.rocketRemaining`/`rocketDays`
     (re-derived from `profile-setting` via the canonical
     `isPremiumActiveFromProfile`/`loadPremiumProfile`, not trusted
     from the client), or
   - a verified `purchase-event` row (`status:'verified'`, a
     `doping_*` productId matching the requested day count) not yet
     referenced by any other `rocket-activation` row.
   No entitlement on either path → 403.
7. Writes a `rocket-activation` ledger row (new content-type,
   `draftAndPublish:false`) recording the operation, decrementing the
   premium credit if that was the source.
8. Applies the result via
   `db.query('api::listing.listing').updateMany({ where: { documentId }, data: { isDoping: true, rocketEndsAt } })`.

**Rocket source of truth.** Entitlement now lives entirely
server-side: `profile-setting.activePremium` for included credits,
`purchase-event` for standalone paid rocket purchases, and
`rocket-activation` as the consumption ledger tying an activation to
whichever of those it consumed. The client never supplies or can
influence `isDoping`/`rocketEndsAt`.

**Entitlement consumption / idempotency.** A retry with the same
`operationId` and the same request body returns the original result
without consuming a second credit or creating a second ledger row (a
unique-constraint race on the ledger insert is caught and re-read
idempotently). A retry with the same `operationId` but a different
body is rejected with 409 rather than silently applied.

**Flutter.** `_syncRocketStateToStrapi` is replaced by
`_activateRocketOnServer`, which calls
`StrapiService.activateListingRocket` and applies
`rocketEndsAt`/`isDoping` to the UI (`ListingsStore.applyServerRocketActivation`)
**only** on a confirmed server response — never optimistically, never
left showing a fake-active state if the call fails. The premium-credit
path no longer decrements `PurchaseStore`'s local rocket counter
itself (the server is now the sole ledger); the UI refreshes from
`PurchaseStore.refreshFromStrapiForCurrentSession` afterwards to pick
up the server-confirmed `rocketRemaining`.

**Side-finding disclosed, not retrofitted:** while debugging this,
found that Strapi's `draftAndPublish` creates two physical rows per
document (draft `publishedAt:null` + published) even when
`entityService.create` is called with `publishedAt` set, and a
`db.query` lookup/update without an explicit
`publishedAt:{$notNull:true}` filter can non-deterministically hit
either row. Fixed for `findListingByAnyId` (shared by the new
endpoint and other callers) and for the new endpoint's own write.
**Not** applied to other pre-existing single-row writers
(`setListingCounter`, `syncOfflineListing` in `engagement.ts`) to
stay in scope for this phase — their own large existing test suites
haven't caught this, but the same class of intermittent issue could
theoretically affect them. Worth a dedicated look in a future phase.

**Tests:** `tests/integration/listing-rocket-activation.integration.test.ts`,
11/11 passing — owner+entitlement activates and persists, non-owner
403, no-entitlement 403, forged `isDoping`/`rocketEndsAt` ignored,
invalid `days`/`operationId` 400, idempotent retry (no double
consumption), conflicting retry 409, a verified doping purchase
consumed exactly once (second attempt 403), unauthenticated 403,
cross-user visibility confirmed via a separate GET.

---

## BUG-PREM-003 (HIGH) — Processed Products/Seller Stores had no
backend premium gate

**Real Flutter gate, confirmed by reading the live UI code** (not
assumed): `currentSessionHasProcessedStoreAccess()` ==
`PurchaseStore.I.activePremium != null` — premium-only. Other
helpers exist with OR-business-module semantics but are not wired to
any real entry point.

**Fix:** a `requireActivePremium(strapi, identity, ctx)` helper
(loads the profile via `loadPremiumProfile`, checks
`isPremiumActiveFromProfile` — the exact same canonical check every
other premium gate in this codebase uses, no new parsing invented)
applied to `mine` and `upsert` on both `processed-products` and
`processed-seller-stores`. `delete` and `publicList` are deliberately
left ungated — deletion is ownership-scoped cleanup of a user's own
data and shouldn't be blocked by a lapsed subscription, and the
public catalog read must stay public.

**Route-collision discovery.** `GET /processed-products/mine` and
`/public` are registered at the identical path by **both**
`api::processed-product` (singular) and `api::processed-products`
(plural). Strapi silently routes real traffic to the singular
controller — confirmed live via debug logging, not assumed — which
made the plural controller's own `mine`/`publicList` dead code for
those two routes. The premium gate initially only touched the plural
(shadowed) controller and 3/11 tests failed with 200 instead of 403
despite the code looking correct. Fixed by adding the identical gate
to the singular controller's `mine` action, the one Strapi actually
serves.

**Flutter/backend parity.** Same source (`profile-setting.activePremium`),
same check (`isPremiumActiveFromProfile` / `PurchaseSubscription.isCurrentlyActive`,
already unit-tested for endsAt-null/future/past parity in an earlier
phase) on both sides — Flutter and backend cannot disagree for the
same user.

**Tests:** `tests/integration/processed-products-premium-gate.integration.test.ts`,
11/11 passing — free user 403 on `mine`/`upsert`, premium
(`endsAt:null`) 200, premium (future `endsAt`) 200, expired premium
403 (same as free), a premium user's `upsert` reaches the service
layer (not blocked by the gate), a user with no profile-setting row
at all is 403 (gate doesn't default-allow), `publicList` stays fully
public, seller-stores free 403 / premium 200, unauthenticated 403.

---

## BUG-PREM-005 (MEDIUM) — logout/account-switch cache

Re-verified the state chain from the audit: `PurchaseStore` keeps all
premium/purchase state in owner-keyed in-memory maps
(`_activePremiumByOwner`, `_recordsByOwner`, plus several sync-status
maps), and was the **only** owner-scoped store in the app with no
`clearForSession()` — every other one (`OffersStore`, `MessagesStore`,
`NotificationStore`, `SupportStore`, `HubContentRepo`,
`ProfileFollowStore`, `FavoritesStore`, `FavoriteProfilesStore`,
`ProfileCommentsStore`) already clears on every login/logout via
`main.dart`'s `_onSessionChanged`. Because state is keyed by owner id,
a *direct* cross-user leak wasn't possible (a different owner id is a
different map entry), but stale data could persist unboundedly across
every account used in the same app process, and the risk the audit
flagged was real: within one process, switching accounts without a
full app restart could show cached data before the real per-session
refresh completed.

**Fix.** `PurchaseStore.clearForSession()` clears every owner-keyed
map (records, active premium, all remote-sync status/retry/error
tracking) and bumps `tick` so listeners refresh. Purely local — no
network call, no delete against the backend premium record. Wired
into `_onSessionChanged` alongside the other 9 stores. The persistent
backend record is untouched; a real login re-hydrates via
`refreshFromStrapiForCurrentSession`.

**Test-harness gap encountered and how it was closed.** This
codebase's test suite has no pre-existing seam to simulate a logged-in
session (`AuthService.login()` requires a live Strapi backend; this
gap is already disclosed in
`test/features/engagement/favorites_store_local_mirror_test.dart`).
Two minimal `@visibleForTesting` seams were added, mirroring the
existing `GuestActorIdentityService.resetCacheForTest()` convention
already used in this codebase:
- `AuthService.debugSetSessionForTest({email, ownerId})` — sets/clears
  the session identity directly.
- `PurchaseStore.debugSeedOwnerStateForTest(ownerId, {subscription})`
  — seeds owner-scoped state without touching the network (every real
  state-mutating `PurchaseStore` method fires an unawaited
  `_syncOwnerToStrapi` that retries forever on failure, which would
  leave dangling timers with no reachable backend in a test process).

**Tests:** `test/features/premium/purchase_store_test.dart`, 5 new
tests, all passing — A premium → logout → B free stays free; A
premium → logout → A login again (cache cleared, not left broken,
re-populates correctly once "re-hydrated"); B free → logout → A shows
premium; no stale entitlement across 3 repeated switches; `tick`
bumps on clear.

---

## BUG-PREM-004 (LOW) — stale listing premium badge — **DEFERRED**

The audit's finding stands: a listing's `isPremium`/`isPremiumOwner`
badge field can remain stale `true` after the owner's subscription
expires, until the next write that happens to touch it (currently
only `syncOwnerPremiumStateToStrapi`, which only updates listings
**currently loaded in the Flutter client's in-memory store** when
`activePremium` detects expiry — not a backend-wide sweep).

Checked whether this produces a genuinely wrong **public** view, not
just a stale badge on the owner's own screen: `search_listings_page.dart`
sorts seller profile-hits in search results by `isPremiumHint`
(`p.isPremiumSafe`, sourced directly from this same stored field) —
premium sellers first. So yes, a lapsed subscriber could keep a
public search-ranking advantage until something happens to refresh
that field.

**Why deferred rather than fixed here:** the only self-healing fix
that doesn't require a migration/recount is a **read-time** check —
looking up the owner's current `profile-setting` premium status when
serving listing data instead of trusting the stored field. That would
touch the listing list/search read path, which is hot and
high-traffic; done naively it's an N+1 profile lookup per response,
which is not a "low-risk" change for a LOW-severity, badge-only issue.
The audit's own recommendation (a periodic re-sync cron job) is
closer to the "large migration/recount" work the mandate explicitly
excludes from this phase. Real entitlement gates (AI, logistics,
rocket, processed products) all check current backend state directly
after P1.1/P1.2 and are unaffected by this field either way — this is
cosmetic/ranking-only exposure, not a feature-access bypass.

**Recommendation:** track as a follow-up (periodic re-sync job or a
batched, cached read-time check), not release-blocking.

---

## Validation

**Backend** (`tarim360-strapi`, `release/preflight-integration`):
- `npx tsc --noEmit` — clean.
- `npm test` (unit) — 31/31 passing.
- `npm run test:integration` — **259/259 passing** (includes the 22
  new tests from this phase plus every pre-existing suite — no
  regression in listing ownership, protected-field/rocket-spoof
  guard, seller-email privacy, permission-gap fixes, public-profile
  privacy, or anything else already covered).
- `npm run build` — clean.
- `git diff --check` — clean.

**Flutter** (`tarim360`, `release/preflight-integration`):
- `flutter analyze` — clean except 2 pre-existing, unrelated warnings
  in `logistics_models.dart` (unused private helpers, untouched by
  this phase).
- `flutter test` — **257/257 passing**, including the 5 new
  account-switch tests and the existing `PublicProfile`/AI/Logistics
  gate coverage.
- `git diff --check` — clean.

Explicitly re-verified still intact: normal listing update still
strips/rejects rocket and premium fields from client payloads
(pre-existing Phase A guard, unaffected by the new dedicated
endpoint), AI premium gate, Logistics premium gate, PublicProfile
privacy (allowlisted fields, no raw `activePremium` leak), and listing
ownership checks.

---

## Commits

No artificial splitting was needed; the suggested commit plan mapped
cleanly onto the actual work, with one addition (a Flutter-side
`feat(premium): wire rocket activation to the server-authoritative
endpoint` commit, since the backend feature commit and its Flutter
counterpart are naturally separate repos/commits, not a deviation from
intent).

**Backend (`tarim360-strapi`):**
- `8256b5f` — `feat(premium): add server-authoritative rocket activation`
- `ae0ec93` — `fix(processed-products): enforce backend premium entitlement`
- `2709ee4` — `test(premium): add entitlement and rocket regression coverage`

**Flutter (`tarim360`):**
- `1263995` — `feat(premium): wire rocket activation to the server-authoritative endpoint`
- `1eae316` — `fix(premium): clear runtime entitlement on account switch`
- `deda8c9` — `test(premium): add account-switch regression coverage`

Pushed to `release/preflight-integration` only, both repos. No merge
to `main`, no production deploy.

**Note (out of scope for this phase, disclosed for awareness):** the
two prior phases' required report deliverables
(`RELEASE_PREFLIGHT_INTEGRATION_AND_LISTING_FIX_REPORT.md` in the
backend repo, `PREMIUM_SYSTEM_RELEASE_FORENSIC_AUDIT.md` in the
backend repo) exist on disk but were never `git add`-ed/committed in
either phase — this report follows the same pattern (written to disk,
not committed) for consistency, but flagging it in case committing
these `.md` reports is actually wanted.

---

## Remaining premium risks carried over from the audit

- BUG-PREM-004 (LOW): deferred, see above — not release-blocking.
- The `draftAndPublish` dual-row write-reliability issue found while
  building BUG-PREM-001's fix is real but only fixed for the new
  rocket endpoint and `findListingByAnyId`'s read paths; other
  pre-existing single-row writers on `listing` (and potentially other
  `draftAndPublish` content types) were not audited/fixed in this
  phase.

No other CONFIRMED BUG or RELEASE BLOCKER items remain open from
`PREMIUM_SYSTEM_RELEASE_FORENSIC_AUDIT.md`.

## Decision

**READY FOR NOTIFICATION AUDIT.**

Per the hard-stop instruction, this phase stops here — not proceeding
to the Notification System Full Audit without explicit go-ahead.
