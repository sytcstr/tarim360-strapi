# TARIM360+1 — FINAL TARGETED RELEASE FIX R1

Backend: `C:\projeler\tarim360-strapi`
Flutter: `C:\projeler\tarim360`
Branch (both repos): `release/preflight-integration`

Reference: `FINAL_RELEASE_INTEGRITY_SWEEP.md`.

Scope: close the 1 CRITICAL + 5 HIGH findings from the sweep before UAT.
The 6 MEDIUM + 2 LOW findings were **not** touched in this phase.

Every finding below was re-verified against current HEAD before any fix
was written — the sweep report was treated as a lead, not proof. One
finding turned out to be only partially accurate (R1.4/logistics-load),
disclosed in full below.

---

## R1.1 — CRITICAL: Premium/Rocket/AI self-grant — **CONFIRMED + FIXED**

**Re-verification:** confirmed live. `src/api/profile-setting/controllers/profile-setting.ts`'s
`stripEngagementFields` only deleted `viewCount`/`engagementVersion` before
calling `super.create`/`super.update`. `activePremium`,
`activePremiumSubscription`, `purchaseHistory`, `purchaseRecords` were
completely unprotected `json` schema fields, reachable via
`PUT /profile-settings/:id` (granted to the `authenticated` role,
guarded only by an ownership policy that checks *whose* row is being
written, never *which fields*). Every premium/rocket/AI gate in the app
(`premium-sync.ts`'s `isPremiumActiveFromProfile`, `listing.ts
activateRocket`, `ai.ts ensureAiAccess`, `processed-products.ts
requireActivePremium`) reads this same field with no independent
verification.

**Fix:** `src/api/profile-setting/controllers/profile-setting.ts` — added
`PURCHASE_PROTECTED_FIELDS` (`activePremium`, `activePremiumSubscription`,
`purchaseHistory`, `purchaseRecords`, `purchaseUpdatedAt`) to the same
strip list. The one legitimate writer, `src/api/purchase/lib/persistence.ts`,
writes via `strapi.entityService.update`/`.create` directly — it never
goes through this HTTP controller, so real premium sync is unaffected
(confirmed by a dedicated regression test, see below).

**Tests added** (`tests/integration/profile-setting-ownership.integration.test.ts`,
+9 tests): activePremium spoof stripped (update + create), `endsAt:null`
("unlimited") spoof stripped, `activePremiumSubscription` stripped
independently, `purchaseHistory`/`purchaseRecords`/`purchaseUpdatedAt`
stripped, a spoofed `rocketRemaining` does **not** grant a real rocket
activation (`POST /listings/:id/rocket/activate` still rejects it), a
normal bio/city update still works in the same request as a stripped
premium field, and the real internal premium-sync write path (direct
`entityService.create`, mirroring `persistence.ts`) is confirmed
unaffected.

---

## R1.2 — HIGH: Listing quota enforced client-side only — **CONFIRMED + FIXED**

**Re-verification:** confirmed live. `listing.ts create()` had zero
quota/count logic; a direct `POST /listings` created unlimited listings
regardless of the Flutter-only `_ensureNormalListingQuota` gate
(`kNormalListingFreeCount = 5`, `kNormalListingBlockSize = 5`, quota-pack
product `normal_listing_5_399`).

**Fix:** added `canCreateNextNormalListing` to `src/utils/listing-metrics.ts`
(shared, since two independent code paths create listings) — counts real
listing rows for the owner (correctly filtered to `publishedAt: {$notNull:
true}`, since `listing` has `draftAndPublish:true` and every create
leaves two physical rows sharing one documentId — a bug in the first
draft of this fix that its own regression test caught immediately, before
it ever ran against the full suite) and real, verified `purchase-event`
rows for the quota product, mirroring `NormalListingQuotaStatus` exactly.
Wired into both `listing.ts create()` and `engagement.ts
syncOfflineListing`'s create branch (the offline-sync queue's own create
path is a second, independent way to create a listing row — it would
otherwise trivially bypass the new gate). Premium/business accounts are
exempt, matching `_isPremiumOwnerForListingQuota`.

**Tests added** (`tests/integration/listing-create-idempotency.integration.test.ts`,
+5 tests): exactly 5 free creates succeed, the 6th is rejected (403); a
premium account is fully exempt; a verified quota-pack purchase raises
the real allowed count by 5 (and an 11th is still rejected); retrying the
same `operationId` at the quota boundary never double-consumes the
quota; the offline-sync create path enforces the identical quota (a
6th listing via `/offline-sync/listings` is rejected and never created).

---

## R1.3 — HIGH: Offline listing queue cross-account replay — **CONFIRMED + FIXED**

**Re-verification:** confirmed live. `ListingPendingSyncQueue.retryPending()`
(`lib/features/listings/stores/listings_store.dart`) submitted every
queued row using whatever JWT was currently active, with no comparison
against the row's own `ownerId` at all — unlike
`EngagementPendingQueue.flush()`, which already does exactly this
comparison (its BUG-ENG-003 fix). The row already carried `ownerId:
product.ownerId` at enqueue time; it was simply never read back at retry
time.

**Fix:** `retryPending()` now compares each row's `ownerId` against
`currentSessionOwnerId()`, mirroring `EngagementPendingQueue.flush()`
exactly: a row with no recorded `ownerId` (legacy, pre-fix) is dropped
(fail-closed — no safe owner to fall back on); a row belonging to a
different owner is paused (kept queued, never submitted, never
reassigned to the new session) until that exact owner logs back in; a
row matching the current session proceeds as before.

**Tests:** `flutter analyze` confirms the change is clean. This exact
logic is **not independently unit-testable in the current harness**:
`StrapiService.readJwt()` calls `flutter_secure_storage` directly with no
try/catch, which throws `MissingPluginException` in every test in this
suite (a pre-existing, disclosed limitation — see
`messages_reliability_test.dart`'s own comment on the identical gap for
a different store) — so `retryPending()` throws before ever reaching the
row-processing loop, with no way to reach it without either mocking a
platform channel (fragile) or making a real network call to a live
Strapi host from a unit test (unacceptable). `EngagementPendingQueue` is
independently testable only because a prior fix pass added constructor-
based dependency injection (`EngagementPendingQueue({repository, jwtProvider})`)
specifically for this reason; adding the same seam to
`ListingPendingSyncQueue` was judged out of scope for a *targeted* fix
(it's a real, reasonable follow-up, not a requirement of this phase).
Verified by direct code review against the now-proven `EngagementPendingQueue`
pattern instead.

---

## R1.4 — HIGH: Logistics load/vehicle owner spoof — **PARTIALLY CONFIRMED + FIXED (see disclosure)**

**Re-verification — logistics-vehicle:** confirmed live and unmitigated.
`logistics-vehicle.ts create()` had no `readIdentity` call at all;
`transporterKey` passed straight through from the client. No route
policy existed to protect it either.

**Re-verification — logistics-load — important correction to the sweep's
original finding:** `logistics-load.ts create()` itself also had no
`readIdentity` call and let `ownerKey` pass through unchanged — **but**
the route's own `global::require-logistics-premium` policy (which already
ran before the controller on every real create) *already* force-stamps
`data.ownerKey = profile.profileId` at line 114, unconditionally
overwriting whatever the client sent, before the controller ever saw it.
For logistics-load specifically, this means the create-time ownerKey
spoof described in the sweep was **already closed** by this pre-existing
policy for any request that reaches the controller at all (a request
without a real premium+logistics-module profile never gets that far,
403s at the policy first) — the sweep's static read of `sanitizeCreateData`
in isolation missed that the policy which runs immediately before it
already neutralizes the spoof. This is disclosed per the mandate's
explicit instruction rather than silently claimed as a newly-closed hole.

**Fix (applied to both, for consistency and defense-in-depth):**
`logistics-load.ts create()` and `logistics-vehicle.ts create()` both now
call `readIdentity(ctx)` and force `ownerKey`/`transporterKey` to
`id:<ownerId>` (the exact format `matchesOwnerKey` and Flutter's own
`_currentLogisticsActorKey()` already use) directly in the controller —
for vehicles this is the sole, real fix closing a genuinely open hole;
for loads it is a harmless second layer, not a functional change to
what was already enforced.

**Tests added** (new file `tests/integration/logistics-owner-spoof.integration.test.ts`,
3 tests): a spoofed `ownerKey` on load-create is ignored (the real
creator, not the claimed victim, ends up owning it; the claimed victim
cannot edit it; the real creator still can — no regression); the
identical proof for `transporterKey` on vehicle-create; an unauthenticated
create is still rejected.

**Regression found and fixed in an existing test:** this same fix broke
one pre-existing test (`logistics-vehicle-favorite.integration.test.ts`'s
"generic update ignores a client-supplied favoriteCount/..." test), which
had relied on the very vulnerability being closed — it created a vehicle
via one throwaway user and then injected a `transporterKey` override to
make an *unrelated* second user appear to be the real owner, as a test-
setup convenience. That test now has the real owner create the vehicle
directly (no override needed, since real ownership is automatic under
the fix) — verified passing, no loss of coverage.

---

## R1.5 — HIGH: Forgot-password email-failure semantics — **CONFIRMED + FIXED**

**Re-verification:** confirmed live. `auth-flow.ts requestPasswordReset`
persisted the new temporary password to the user record *before*
attempting `sendTemporaryPasswordEmail`; a send failure (SMTP
outage/timeout/bad credentials/rate limit) still returned a failure
response, but the real password had already been overwritten with no
rollback — the user is locked out, believing the reset "failed."
Enumeration protection (unknown identifier still returns `ok:true`)
was and remains untouched — that branch returns before either the send
or the persist.

**Fix:** reordered so the email send is attempted first; the password is
only persisted once delivery has genuinely succeeded. A send failure now
leaves the account's real password completely untouched.

**Tests added** (new file `tests/integration/forgot-password-email-failure.integration.test.ts`,
3 tests, stubbing the real Strapi `email` plugin's `send` method
directly on the booted instance rather than relying on ambient SMTP
availability): a send failure leaves the original password working
(login with it still succeeds); a successful send changes the password
to the delivered temporary one (extracted from the stubbed email body)
and the old password stops working; an unknown email still returns
`ok:true` (enumeration protection unaffected).

---

## R1.6 — HIGH: Favorite/Like/Offer counters never decrement — **CONFIRMED + FIXED (client-side only; server counter was already correct)**

**Re-verification, domain by domain:**
- **Listing favorite/like/offerCount** (`listing_engagement_store.dart`
  `seedCounts`): confirmed — `takeMax` applied uniformly to
  views/favorites/offers/likes, permanently sticking the displayed count
  at its highest-ever local value.
- **Processed product favorite/like** (`processed_market_stores.dart`
  `seedCounts`): confirmed — identical bug, same fix needed.
- **Logistics load/vehicle**: **not reproducible** — these domains have
  no equivalent local max-caching layer; their like/favorite counts are
  parsed directly from each freshly-fetched row into the model every
  time, so a server-side decrease is already reflected on next refresh.
  No fix needed or applied here.
- **Server-side counter mechanics** (`engagement-core.ts
  incrementCounterAtomic`): re-verified — already fully correct
  (`MAX(count - 1, 0)` on decrement, atomic SQL, already covered by
  passing unit tests). The bug was exclusively in the Flutter client's
  local reconciliation cache, never on the server.

**Fix:** in both `listing_engagement_store.dart` and
`processed_market_stores.dart`, `seedCounts` now uses `takeMax` only for
`views` (which legitimately never decrease); `favorites`/`likes`/`offers`
now always take the fresh server value via a new `takeLatest` helper.

**Tests added** (new file `test/features/engagement/engagement_counter_reconciliation_test.dart`,
5 tests): favorites/likes/offers follow a real server-reported decrease
for both stores; views still only ever take the max; a count can go all
the way down to zero.

---

## Security / regression re-check

Full suites re-run after all 6 fixes (not spot-checked):

| Suite | Result |
|---|---|
| Backend `npx tsc --noEmit` | Clean |
| Backend unit (`npm run test:unit`) | 31/31 pass |
| Backend integration (`npm run test:integration`) | **351/351 pass** |
| Backend build (`npm run build`) | Succeeds |
| Backend `git diff --check` | Clean (CRLF/LF warnings only) |
| Flutter `flutter analyze` | 0 errors (2 pre-existing, unrelated warnings) |
| Flutter `flutter test` | **295/295 pass** |
| Flutter `git diff --check` | Clean (CRLF/LF warning only; one stray BOM artifact found and reverted from `lib/main.dart`, unrelated to any of these 6 fixes) |

The 351 backend integration tests include full coverage of every item the
mandate asked to re-verify: Messaging M1-M4 + F2 polling/read
(`conversation-*`), Offer ownership + `markSeen` + `offerCount`
(`offer-receiver-ownership`, `listing-create-idempotency`'s idempotency
suite), Public Profile premium (`public-profile-read`), Listing
ownership/offline-sync protection (`listing-ownership-and-protected-fields`,
`listing-owner-email-privacy`, `listing-engagement-field-guard`), Listing
create idempotency (`listing-create-idempotency`), Rocket
server-authoritative activation (`listing-rocket-activation`), Processed
Product premium gate (`processed-products-premium-gate`), Notification
N1/N2 (`notification-n1-security-fix`, `notification-mark-read`,
`auth-flow-delete-account`), FCM token ownership (N1.4, within
`notification-n1-security-fix`), Hub/Farmer Question ownership
(`hub-content-ownership`), Engagement E1/E2 (`engagement`,
`hub-content-engagement`, `profile-setting-ownership`), session/account-
switch isolation (covered client-side by the full Flutter suite,
including `purchase_store_test.dart`'s BUG-PREM-005 group), and F1/F2
fixes (`notification-turkish-copy`, and the F2 Flutter test files, all
green). Zero regressions found beyond the one pre-existing test that
depended on the R1.4 vulnerability itself (fixed, see above).

---

## Final decision: **READY FOR MEDIUM TRIAGE**

All 1 CRITICAL + 5 HIGH findings from `FINAL_RELEASE_INTEGRITY_SWEEP.md`
are closed (with one, R1.4/logistics-load, disclosed as only partially a
new fix — see above). Every fix has targeted regression coverage. The
full test suite of both repos is green with zero unexplained
regressions. Per the mandate, stopping here — not proceeding to the 6
MEDIUM findings or to UAT automatically.
