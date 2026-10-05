# TARIM360+1 — Notification Targeted Security Fix N1

Scope: BUG-NOTIF-001 (CRITICAL), BUG-NOTIF-002 (HIGH), BUG-NOTIF-003
(HIGH), and the FCM account-switch/logout token race (MEDIUM) from
`NOTIFICATION_SYSTEM_RELEASE_FORENSIC_AUDIT.md`. Both repos, branch
`release/preflight-integration`. No merge to `main`, no production
deploy, no production mutation — all verification against isolated
throwaway SQLite test databases.

**Final decision: READY FOR NOTIFICATION FOLLOW-UP.**

---

## BUG-NOTIF-001 — old vs. new trust boundary

**Old.** `POST /api/notifications`'s `notification-ownership.ts` policy
forced only the *sender* fields (`senderEmail`/`senderProfileId`) to the
caller's JWT identity. `targetEmail`/`targetProfileId` were read straight
from the client body and used as-is whenever either was non-empty — only
defaulting to self if the client left *both* empty. Since every
notification create fires the content-type's own `afterCreate` →
`deliverPush`, this meant any authenticated user could push a real,
attacker-titled FCM notification (plus a matching in-app inbox row) to
any other known user, with no rate limit.

**New.** The generic client-reachable `create` action is now
**self-target-only**: on POST, if the client's claimed `targetEmail`/
`targetProfileId` differs from the caller's own identity, the request is
rejected (403) rather than silently redirected to self. Every legitimate
cross-user notification is created by trusted backend code directly
(`entityService.create`, bypassing this public policy entirely — message
lifecycle, support-reply lifecycle, admin-notification fan-out, the
offer controller) or through the new dedicated action below.

### Notification producer matrix (re-verified, not assumed)

| Producer | Recipient source | Trust boundary |
|---|---|---|
| Message (`message/lifecycles.ts`, via `afterCreate`) | message row's own `receiverEmail`/`receiverProfileId` | Now server-derived at the real write path — see BUG-NOTIF-002 |
| Offer (`offer.ts` `create`/`updateByOfferId`) | offer row's own `requesterEmail`/`receiverEmail` | Server-derived (O1, and now `updateByOfferId` too — BUG-NOTIF-003) |
| Support-ticket staff reply (`support-ticket-message/lifecycles.ts`) | ticket's own `requesterEmail`/`requesterProfileId` | Already server-derived, unchanged |
| Admin broadcast/campaign (`admin-notification/lifecycles.ts`) | `admin-notification` entry's own fields; not reachable by mobile clients at all (no `authenticatedActions`/`publicActions` grant) | Already isolated, unchanged |
| Listing favorite/like | real listing owner via `resolveListingOwnerByAnyId` | **NEW**: `notification.createDomainEvent` |
| Logistics-load favorite/like | real load owner via new `resolveLogisticsLoadOwnerByAnyId` (parses `ownerKey`) | **NEW**: `notification.createDomainEvent` |
| Processed-product favorite/like | real product owner via new `resolveProcessedProductOwnerByAnyId` | **NEW**: `notification.createDomainEvent` |
| Profile favorite/comment | real profile via new `resolveProfileOwnerIfExists` (confirms a real `profile-setting` row exists for the claimed id) | **NEW**: `notification.createDomainEvent` |
| Farmer question reply | *(disclosed gap, not migrated — see below)* | Still the generic endpoint, now safely self-target-only |

For every `domain-event` case, the client sends only `{domain, entityId,
event}` — never a recipient, never title/message text. The backend
re-derives the real owner from that entity's own stored data and
generates the notification's title/message itself from a small
per-(domain,event) template; an unresolvable/nonexistent `entityId` is
rejected (404), not silently no-op'd, so a client can't use this to
probe which ids exist. Retrying the identical interaction (same domain +
event + entityId + sender) hits the new unique constraint on
`notificationId` and is absorbed, not duplicated.

**Disclosed, deliberate gap: farmer_question.** Hub-content (what
farmer questions are actually stored on) has no verifiable author-
identity field — only an `authorName` display string, no email/
profileId. Migrating it to a verified domain-event would require a real
schema field first (out of scope for a security-fix phase, matching the
"defer, don't invent a migration mid-sprint" pattern from the Premium
P1 phase). Its push still calls the old client-target path, which the
backend now safely rejects — so it stops notifying the question's other
party rather than staying on a spoofable endpoint. Functional
regression, not a security hole; flagged for a future phase once
hub-content gets a real author-identity field.

---

## BUG-NOTIF-002 — receiver derivation

**Critical correction made mid-phase, disclosed here rather than
silently left**: the initial pass fixed `message-ownership.ts` (the
generic `api::message.message` stock-CRUD policy) — real, but re-
verification found this is **not** the live path. `StrapiService.
sendMessage()` posts to `/conversations/message`
(`conversation.ts`'s `sendMessage`), and the generic REST route is only
a same-repo fallback reached if that 404s, which it never does against
this backend. The actual, live vulnerability was in `conversation.ts`
itself: `normalizeParticipants()` took a client-supplied receiver first,
falling back to real thread/listing resolution only when the client left
it empty — and `isRealParticipantOfThread` only checked "is the caller a
stored participant," it never re-derived the receiver from the thread's
own data. A genuine participant of thread A↔B could reply with
`receiverEmail=C` (an arbitrary third party) while passing the real
`threadId`, and the message — and its resulting notification/push —
would go to C, not B.

**Fix, in `conversation.ts`**: `verifyAndCorrectReceiver()` now runs
before `normalizeParticipants` on every `sendMessage`/`upsert` call:

- If a real thread already exists for the given `threadId`/
  `conversationKey`, the caller must be one of its two stored
  participants (else 403 — preserves the existing M1 hijack-prevention
  test), and the receiver becomes unconditionally "whichever stored
  participant is *not* the caller" — the client's claimed receiver is
  discarded entirely, not merely deferred to.
- If no thread exists yet (a genuinely new conversation) but the message
  carries a real, explicit `listingId`/`productId`, that entity's real
  owner (via the *same* resolvers `domain-event` uses) overrides the
  client's claim when it differs from the caller.
- If neither applies (context-free new conversation), the client-
  supplied receiver is still trusted — the same disclosed, narrower
  limitation `farmer_question` has, since there is genuinely no other
  way to learn a brand-new counterparty's identity yet.
- The message row's own `targetEmail`/`targetProfileId`/
  `messageReceiverEmail`/`messageReceiverProfileId` alias fields, which
  used to be re-picked from raw client data *independently* of the
  verified participant set, now always mirror the same verified value.

`message-ownership.ts` (the fallback route) received the equivalent
fix for defense in depth, even though it isn't reachable by real traffic
today.

**Side-finding, fixed in the same pass**: building this fix's own tests
surfaced a real, previously-untested `ctx.forbidden is not a function`
crash risk in both `message-ownership.ts` and `notification-ownership.ts`
— `ctx.forbidden` doesn't reliably work when called directly inside a
Strapi *policy* (as opposed to a controller), the same class of bug
already fixed elsewhere in this codebase via a `denyForbidden` helper.
Every raw `ctx.forbidden` call in both policy files (including
pre-existing ones this phase didn't otherwise touch) now goes through
`denyForbidden`.

**Side-finding, disclosed not fixed**: `resolveListingOwnerByAnyId`'s
numeric-substring id-matching fallback (built for real Strapi ids in the
offer flow, where `listingId` is always a genuine reference) can produce
a false-positive match if fed a non-listing string that merely *contains*
digits — discovered because this fix's own test suite mixed real
listings with synthetic test context markers in one shared DB. Fixed at
the call site in `conversation.ts`'s `resolveContextOwner` (only ever
called with an *explicit* `listingId`/`productId` field, never a generic
`contextId`/`threadId` fallback) rather than changing the shared,
already-relied-upon helper itself. Real production `listingId` values
are always genuine listing/load/product references from the app's own
create/detail flows, so this narrow risk is confined to how test data was
shaped, not a live production path — but worth keeping in mind if this
helper is reused elsewhere against non-guaranteed-real input in the
future.

---

## BUG-NOTIF-003 — offer notification source of truth

`updateByOfferId` (accept/reject/counter, i.e. `offerStatus` transitions
to `accepted`/`rejected`/`bargaining`) now creates the notification
itself, immediately after the status update succeeds:

- **Recipient**: always derived from the real offer row's own
  `requesterEmail`/`receiverEmail`/`requesterProfileId`/
  `receiverProfileId` fields — never client input — and is always
  "whichever participant did *not* make this call" (the caller is never
  notified about their own action).
- **Exactly one per event**: `notificationId` is deterministic
  (`offer_${status}_${offerId}`), so a client retry of the same status
  update hits the new unique constraint on `notificationId` and is
  silently absorbed rather than creating a second row/push.
- **Offer-created deduplicated**: its own `notificationId` is likewise
  now `offer_created_${offerId}` (was `offer_${Date.now()}`), closing the
  same retry-duplication exposure, and the Flutter client's own
  duplicate push for this event was removed (see below) — this event
  used to fire twice (backend auto-notification + client push) for every
  new offer; now exactly once.
- **Client-driven creation removed entirely**: `OffersStore.
  _pushOfferRemoteNotification` and its 7 call sites (created,
  accepted, rejected, counter ×2 code paths, and a "requester edits a
  still-pending offer" update) are deleted, along with the now-dead
  `_offerNotificationMessage` helper. The chat-message side-channel
  (`MessagesStore.syncOfferEventFromCurrentUser`) is untouched and still
  fires for all of these events — it's no longer the *only* signal for
  accept/reject/counter (that's the backend notification now), just an
  additional, unrelated chat entry, matching the mandate's requirement
  that the side-channel not be the sole guarantee.

**Disclosed gap**: the removed "requester edits a still-pending offer"
push has no server-side replacement — `updateByOfferId` deliberately
skips notification creation when `status == 'pending'`, since that's
also a brand-new offer's default status and firing on every `pending`
transition would risk spurious notifications. The receiver no longer
learns about a price/note edit on a still-pending offer until a
dedicated backend event is added for it specifically. This is a genuine,
disclosed functional regression, weighed against removing it from the
vulnerable client-push path — not an oversight.

---

## Duplicate prevention (summary across N1.1–N1.3)

Every notification creation touched by this phase now has a
deterministic `notificationId` (`${domain}_${event}_${entityId}_
${senderId}` for domain-events, `offer_created_${offerId}`/
`offer_${status}_${offerId}` for offers), backed by a real, new unique
constraint on `notification.notificationId` (previously absent entirely
— BUG-NOTIF-009 from the audit, closed as a side-effect of enabling this
idempotency). A retry of the identical event now always resolves to
"already exists, do nothing" rather than a second row/push, verified
directly for both the domain-event action and offer status changes.

---

## FCM token ownership / account switch

Re-verified the race directly: `AuthService.logout()` fires `unawaited
(PushMessagingService.unregisterForEmail(...))` and `unawaited
(StrapiService.clearJwt())` with no ordering guarantee — if `clearJwt()`
wins, the unregister call's own JWT read comes back empty and it
silently no-ops, leaving the token registered to the logged-out user.
This race itself is **not modified in this phase** (would require
either awaiting the unregister call before clearing the JWT, or a
different synchronization primitive — assessed as more invasive than
the minimum safe fix below, given the register-side fix already fully
closes the resulting cross-delivery risk regardless of whether logout's
own unregister succeeds).

**Fix applied**: `registerPushToken` now scans every *other*
`profile-setting` row for the same token string and removes it before
adding the token to the caller's own `fcmTokens` — server-authoritative
token ownership, corrected on every registration regardless of whether
a prior logout's unregister call ever reached the backend. Scenario
verified directly: A registers a token → B logs in on the same device
and registers the identical token → A's `fcmTokens` no longer contains
it, B's does. Multi-device (a single user registering two distinct
tokens) is unaffected — verified neither token evicts the other.

---

## Test coverage

**Backend**: 24 new tests in
`tests/integration/notification-n1-security-fix.integration.test.ts`,
covering all four fixes (see the commit message for the full list).
Full suite re-run after all changes: **31/31 unit, 283/283 integration**
(up from 259 before this phase — 24 new, 0 regressions across every
pre-existing suite, including offer ownership, listing ownership,
messaging M1–M5, premium gates, public-profile privacy, and the
pre-existing `notification-mark-read` suite). `npx tsc --noEmit`,
`npm run build`, `git diff --check` all clean.

**Flutter**: no new dedicated test file (the removed/migrated code was
Flutter-side wiring with no existing unit coverage of its own to
extend safely within this phase's scope — the security-critical
verification lives entirely in the backend, which is the actual
trust boundary). Full suite re-run: **257/257 passing** (unchanged
count — none of the touched code had prior direct test coverage to
break). `flutter analyze`: clean except the same 2 pre-existing,
unrelated warnings in `logistics_models.dart` noted in the Premium P1
and Notification audit reports. `git diff --check` clean. One
self-introduced mistake caught and fixed during this phase: deleting
`_logisticsKeyProfileId`/`_logisticsKeyEmail` as apparently-dead code
turned out to break 3 other call sites (`logistics_store.dart`,
`logistics_vehicle_detail_page.dart`, `hesabim_page.dart`) that also use
them — restored before commit, confirmed via a second clean `flutter
analyze` run.

---

## Regression check (explicitly re-verified, not assumed)

| Area | Status |
|---|---|
| Messaging send/receive | PRESENT — `conversation-messaging-security.integration.test.ts` (M1/M5) and this phase's own N1.2 tests both pass |
| Messaging unread/read (M2) | PRESENT — untouched, `conversation-read-unread.integration.test.ts` still passes |
| Messaging retry/idempotency (M4) | PRESENT — untouched, `conversation-send-retry.integration.test.ts` still passes |
| Offer create/accept/reject/counter | PRESENT — `offer-receiver-ownership.integration.test.ts` (O1) still passes; offerCount tests unaffected (notification creation doesn't touch listing counters) |
| Offer ownership | PRESENT — unchanged, self-offer/non-participant checks untouched |
| `notification.markRead` | PRESENT — `notification-mark-read.integration.test.ts` still passes; S5A permission grant untouched |
| Notification unread/list | PRESENT — ownership policy's GET-scope filter untouched (only the POST branch changed) |
| Public profile privacy | PRESENT — `public-profile-read.integration.test.ts` still passes |
| Account switch | PRESENT — Premium P1's `PurchaseStore.clearForSession()` coverage untouched; this phase adds the FCM-token-specific server-side hardening on top |

---

## Commits

Backend (`tarim360-strapi`):
- `b618d2a` — `fix(notifications): close arbitrary-recipient notification/push injection`
- `27d320b` — `fix(messaging): derive message receiver server-side, never from client`
- `efb3df3` — `fix(offers): make offer status-change notifications server-authoritative`
- `b905b7c` — `fix(push): evict FCM token from other profiles on registration`
- `b549597` — `test(notifications): add N1 security fix regression coverage`

Flutter (`tarim360`):
- `e0342b4` — `feat(notifications): add server-verified domain-event notification client`
- `48ded4d` — `fix(notifications): migrate social-interaction notifications off the spoofable endpoint`
- `0e865a0` — `fix(offers): remove client-driven notification push (now server-authoritative)`

No artificial splitting was forced; this maps cleanly onto the
mandate's N1.1–N1.4 structure plus one Flutter-side commit split
(core client wiring vs. the 7 call-site migrations) for clarity, and no
deviation beyond that.

Pushed to `release/preflight-integration` only, both repos. No merge to
`main`, no production deploy.

---

## Remaining MEDIUM/LOW items from the audit (unchanged by this phase)

Carried over from `NOTIFICATION_SYSTEM_RELEASE_FORENSIC_AUDIT.md`,
**not** touched in this security-focused phase, available for a fast
triage pass now that 001/002/003 + the FCM race are closed:

- BUG-NOTIF-004 (MEDIUM) — broadcast notification shared read-state.
- BUG-NOTIF-005 (MEDIUM) — account-deletion cleanup filter misses
  `targetEmail`/`targetProfileId` (offer-created/support-reply rows
  survive deletion).
- BUG-NOTIF-006 (MEDIUM) — `restoreForSession()` vs. `refreshFromStrapi()`
  race on account switch.
- BUG-NOTIF-007 (MEDIUM) — the logout/unregister-token race itself
  (the register-side eviction fixed in this phase closes its
  *cross-delivery* consequence, but the race — a silently-skipped
  unregister call on logout — still exists).
- BUG-NOTIF-009 through 014 (LOW) — see the audit for the full list;
  BUG-NOTIF-009 (no unique `notificationId` constraint) is now
  **closed** as a side-effect of this phase's idempotency work.

## Decision

**READY FOR NOTIFICATION FOLLOW-UP.**

BUG-NOTIF-001/002/003 and the FCM cross-account token race are closed,
verified, and regression-tested against the full existing suite with
zero breakage. Per the mandate: stopping here. Not proceeding to the
Engagement Final Audit automatically.
