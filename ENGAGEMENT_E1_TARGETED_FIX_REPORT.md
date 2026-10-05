# TARIM360+1 — ENGAGEMENT TARGETED FIX E1 — REPORT

Scope: close BUG-ENG-001 (CRITICAL), BUG-ENG-002 (HIGH), BUG-ENG-003 (HIGH)
from `ENGAGEMENT_SYSTEM_FINAL_RELEASE_AUDIT.md`. No MEDIUM/LOW item was
touched in this phase, per explicit instruction.

Backend: `tarim360-strapi`, branch `release/preflight-integration`.
Flutter: `tarim360`, branch `release/preflight-integration`.

---

## BUG-ENG-001 — Hub content ownership bypass (CRITICAL) — CLOSED

**Old contract**: `hub-content-write-guard.ts` only restricted founder-only
kinds (`knowledge`/`agriData`). For every other kind — including
`farmerQuestion` and ordinary hub posts — the policy returned `true`
unconditionally on update/delete, with no per-row ownership check at all.
The `hub-content` schema itself carried no identity field (only a cosmetic
`authorName` string), so there was nothing to check against even if the
policy had wanted to.

**New contract**:
- Schema gained `ownerEmail`/`ownerProfileId` (plain strings).
- `hub-content` controller's `create` requires an authenticated identity
  and force-stamps both fields from `readIdentity(ctx)` — never from
  client payload. `update` deletes both fields from any incoming payload,
  making them immutable post-creation.
- The policy now, on PUT/PATCH/DELETE, always resolves the real DB row
  (never trusts the client's declared `kind`) and compares the
  authenticated actor against `ownerEmail`/`ownerProfileId` via the
  existing canonical `matchesIdentity` helper. The owner is always
  allowed. DELETE by a non-owner is always denied. PUT/PATCH by a
  non-owner is allowed only if the update is reaction-only (existing
  carve-out, e.g. like/comment-count fields) or leaves `title`/`descShort`
  unchanged (`isUnchangedCoreIdentity`) — this preserves the live,
  real "answer someone else's farmer question" flow, which resends the
  full row with the same title/descShort and only a changed embedded
  `body` (answers). A genuine attempt to overwrite another user's
  title/descShort is still denied. All rejections use the repo's
  canonical `denyForbidden(ctx, message)` helper, never raw
  `ctx.forbidden(...)`, avoiding the known "ctx.forbidden is not a
  function" crash in policy context.
- A pre-fix ("legacy") row with no recorded owner is owned by nobody —
  `matchesIdentity` naturally returns `false` for everyone, so it fails
  closed rather than being claimable by whoever asks first.
- Founder-only Knowledge/AgriData restriction is unchanged.

**Farmer Question specifically**: A can update/delete their own question.
B cannot update or delete A's question (403, real row unchanged). A
client-supplied `ownerId`/`ownerEmail`/`profileId`/`email`/`authorProfileId`
spoof in the payload has no effect — the real owner is always the
authenticated creator. B can still legitimately *answer* A's question
(title/descShort resent unchanged, only the answers/body payload
differs) — the exact shape of the live production feature, unbroken.

---

## BUG-ENG-002 — EngagementStore session isolation (HIGH) — CLOSED

**Old behavior**: `EngagementStore` held every target's liked/favorited/
count state, plus the per-lifecycle view-registration guard, in
process-lifetime maps keyed only by `EngagementTarget.cacheKey` — never
by session/owner, with no clearing on logout or account switch. Because
`seed()` deliberately no-ops once `serverVersion>0`, user B logging in
after user A on the same device could see A's like/favorite state
displayed until B happened to personally act on that same target.

**New behavior**: `EngagementStore.clearForSession()` clears both the
notifier map and the view-registration guard set. It is a pure local/
runtime reset — no network call, no backend engagement state touched.
Wired into `AuthService`'s `_onSessionChanged`, alongside the existing
`PurchaseStore`/`FavoriteProfilesStore`/`ProfileCommentsStore` session
resets, so it fires on every login/logout/account-switch. Tested: A
likes/favorites target X (shown true) → session changes → X reverts to
the default false, not A's cached true; B then likes/favorites the same
target independently, from a clean baseline (not conflated with A's
prior count); A logs back in → also re-learned from scratch, not stuck
on B's leftover value. Like and favorite state are verified independent
of each other, and counts are asserted independently of the boolean
state per the mandate.

---

## BUG-ENG-003 — EngagementPendingQueue cross-account replay (HIGH) — CLOSED

**Old behavior**: Queued offline mutations (like/favorite/share/comment)
carried no owner binding. If A's mutation failed while offline, queued,
then A logged out and B logged in on the same device, the next `flush()`
(triggered automatically on every session refresh) would submit A's
queued operation to the server *as B* — a real data-integrity violation.

**New behavior**: `EngagementPendingOperation` gained an `ownerId` field,
populated from the existing canonical `currentSessionOwnerId()` format
at the moment each operation is enqueued (`enqueueMembership`,
`enqueueShare`, `enqueueComment`) — no new identity scheme was invented.
`flush()` computes the current session's owner id and, per queued op:
- `ownerId == null` (a legacy item persisted before this field existed)
  → **dropped**, fail-closed. There is no safe assumption to fall back
  on for who it really belonged to.
- `ownerId != currentOwnerId` (belongs to a different, not-currently-
  logged-in owner) → **paused**, left in the queue untouched, retried
  again only once that exact owner is the one logged in.
- `ownerId == currentOwnerId` → proceeds through the pre-existing
  backoff/attempt-limit logic unchanged.

The pre-existing same-target+kind compaction in `enqueueMembership` is
now also owner-scoped, fixing a related latent bug where B queuing an
op for the same target could have silently deleted A's still-pending,
different op for that same target.

**Legacy queue disposition**: any operation queued by a build prior to
this fix (no `ownerId` in its persisted JSON) is dropped the first time
`flush()` runs post-upgrade, regardless of who is logged in. This is a
deliberate, disclosed fail-closed choice — the alternative (assuming it
belongs to whoever is currently logged in) is exactly the vulnerability
this fix closes.

**Tested**: A queues offline (like/favorite/share/comment shapes) → A
logs out → B logs in → `flush()` does not submit A's op under B (0
calls to the repo, op remains queued, still tagged as A's) → A logs
back in → the paused operation is safely replayed. A legacy (no-owner)
op is dropped without ever reaching the repo. `ownerId` round-trips
through persistence (app-restart safe). Retry/backoff/max-attempt/
duplicate-compaction behavior is unchanged for same-owner operations
(existing fixtures updated to carry a matching owner id, since a bare
op with no owner is now specifically the legacy/fail-closed case, not
the general case).

---

## E1.4 — Notification regression

No file touched by E1 overlaps with the notification domain-event path
(`/notifications/domain-event`, `notification_store.dart`,
`strapi_service.dart`'s `pushDomainEventNotification`). The full backend
integration suite (303/303) and Flutter suite (269/269) — both of which
include the N1 notification security-fix regression coverage — pass
unchanged. Structurally, BUG-ENG-003's fix makes a cross-account queued-
then-replayed engagement action that could produce a wrongly-attributed
notification impossible: a paused operation is never sent under the
wrong owner, so no domain-event is ever created for it under the wrong
identity in the first place.

## E1.5 — Security regression

None of the files touched by E1 (`hub-content` schema/controller/policy,
`engagement_store.dart`, `engagement_models.dart`,
`engagement_pending_queue.dart`, `main.dart`'s one-line session wiring)
overlap with listing counter protection, offline-sync protection,
logistics ownership, offerCount authority, notification domain-event
recipient authority, or public-profile privacy. All pre-existing
regression suites covering those areas pass unchanged within the full
303/303 backend and 269/269 Flutter totals below.

---

## Validation

**Backend** (`tarim360-strapi`):
- `npx tsc --noEmit` — clean.
- `npm run test:unit` — 31/31 pass.
- `npm run test:integration` — 303/303 pass (290 pre-existing + 13 new
  hub-content-ownership tests).
- `npm run build` — clean.
- `git diff --check` — clean.

**Flutter** (`tarim360`):
- `flutter analyze` — 2 issues, both pre-existing, unrelated
  (`_normalizeLogisticsWhatsApp`/`_titleCaseWords` unused-element
  warnings in `logistics_models.dart`).
- `flutter test` — 269/269 pass (247 pre-existing + 22 new
  EngagementStore tests + updated/new EngagementPendingQueue tests).
- `git diff --check` — clean.

No production mutation was performed.

---

## Commits

Backend (`tarim360-strapi`, `release/preflight-integration`):
- `5f61c30` — `fix(hub): enforce content ownership on writes`
- `1c345cd` — `test(engagement): add ownership and session isolation coverage`

Flutter (`tarim360`, `release/preflight-integration`):
- `81dd24a` — `fix(engagement): isolate state by session`
- `9403b58` — `fix(engagement): bind pending operations to session owner`
- `2f33b73` — `test(engagement): add ownership and session isolation coverage`

Pushed to `release/preflight-integration` only, both repos. No merge to
main. No deploy.

---

## Carried over unchanged — 5 MEDIUM / 6 LOW (from ENGAGEMENT_SYSTEM_FINAL_RELEASE_AUDIT.md)

**MEDIUM**
- BUG-ENG-004: processed-product `mine`/`public` list responses never
  project `viewCount`/`likeCount`/`favoriteCount`/`engagementVersion` —
  dashboard/ranking counts frozen, display-only, no security impact.
- BUG-ENG-005: `ListingEngagementStore.seedCounts`'s `takeMax`
  reconciliation only ever raises a cached count, never lowers it when
  the server's real value decreases — display-only.
- BUG-ENG-006: inconsistent partial `EngagementStore.seed()` calls
  across screens can leave a materially incomplete display on whichever
  screen seeds first — display-only.
- BUG-ENG-007: `profile-setting` has no protected-field strip (unlike
  listing/logistics/processed-product/ad) — a user can self-inflate
  their own profile's displayed `viewCount`; no cross-user impact.
- BUG-ENG-008: cross-user profile comments are silently dropped
  client-side (never reach the recipient's real row) — a known
  non-functional feature, not a security issue; needs a real design
  decision (dedicated content-type or narrower backend action), not a
  quick patch.

**LOW**
- BUG-ENG-009: viewing another user's profile can display your own
  incoming comments mislabeled under their profile id (data
  mislabeling, never a real privacy leak).
- BUG-ENG-010: offer-count drift after raw offer deletes (account
  deletion, malformed-offer cleanup) with no follow-up recount — never
  negative, no security impact.
- BUG-ENG-011: dormant legacy `/listing-views` route accepts a
  client-supplied actor key with no JWT — confirmed no live Flutter
  caller.
- BUG-ENG-012: dormant legacy `/logistics-loads/:id/metrics/view` route,
  no rate-limit, IP-bucketed — confirmed dead code client-side.
- BUG-ENG-013: `listing-comment` rows are not cleaned up on account
  deletion (same class as the already-fixed BUG-NOTIF-005), left as PII
  retention.
- BUG-ENG-014: hub-content/farmer-question embedded `commentList`/
  `answers[]` JSON blob is vulnerable to concurrent-write lost updates
  — explicitly disclosed as a deferred architecture issue (would need a
  real per-row comment content-type), not addressed by E1's ownership
  fix by design.

---

## Decision

**READY FOR ENGAGEMENT FOLLOW-UP**

BUG-ENG-001/002/003 are closed with passing regression coverage and
zero regressions across the full backend and Flutter suites. Per the
hard stop, this phase does not proceed to the remaining 5 MEDIUM/6 LOW
triage or to UAT automatically.
