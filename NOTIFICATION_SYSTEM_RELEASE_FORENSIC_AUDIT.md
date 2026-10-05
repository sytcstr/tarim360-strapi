# TARIM360+1 — Sprint 8: Notification System Full Release Forensic Audit

Scope: READ-ONLY. No code changed, no commits, no push, `main` untouched, no
production mutation. Both repos audited on `release/preflight-integration`.

Method: 5 parallel research passes across both repos (a 6th, covering test
inventory + a second spoof pass, stalled after 600s with no output and was
not retried — its scope turned out to already be covered redundantly by the
other 5, cross-checked below), followed by direct personal verification of
every load-bearing/high-severity claim by reading the actual source
(`notification-ownership.ts`, `message-ownership.ts`, `offers_store.dart`,
`notification_store.dart`, `strapi_service.dart`, `auth-flow.ts`) before
writing anything into this report. One claim from the research pass
(a purported "message notifications never reach the bell") was checked and
found **not supported** by the code — see the corrected note under §4.

**Final decision: RELEASE BLOCKED.**

**Counts:** CRITICAL 1 · HIGH 2 · MEDIUM 5 · LOW 6 · POTENTIAL RISK 2 ·
PRODUCT DECISION 2 · DEAD/LEGACY 1 (two functions)

---

## Real architecture (as confirmed, not assumed)

```
business event (message/offer/support-reply/admin broadcast)
  -> backend notification create (4 call sites total, see §1)
  -> api::notification.notification row (targetEmail/targetProfileId + 6 alias fields)
  -> content-type's own afterCreate lifecycle -> deliverPush() -> real FCM send
       (HTTP v1 with service-account JWT, or legacy FCM API fallback)
  -> Flutter: NotificationStore.refreshFromStrapi() (generic GET, no kind
       filter; ownership-scoped server-side) on: cold start, login/account
       switch, a 30s poll (LiveSyncManager, only while logged in), app
       foreground-resume, opening the bell, and on receiving a push while open
  -> unread count = client-side items.where(!isRead).length (no server aggregate)
  -> UI: bell badge + bottom-nav badges + notifications list page
  -> tap: routes to the generic category tab only (Messages/Teklifler/etc.),
       never to a specific thread/offer/listing (no reference id is even
       carried by the client model)
  -> system-tray tap: no-op (no navigation hookup at all, see §10)
```

Two, and only two, notification-related content-types exist backend-side:
`api::notification.notification` (the per-user inbox row) and
`api::admin-notification.admin-notification` (an admin-only "campaign" entity
that fans out into individual `notification` rows — not reachable by mobile
clients; its action ids are absent from both `publicActions` and
`authenticatedActions` in `src/index.ts`).

---

## §1 — Notification sources

Confirmed exhaustively (only 4 real creation call sites exist in the entire
backend `src/api` tree — favorites/likes, plain listings, logistics,
processed products, and premium/rocket create **zero** notifications today):

| Source | Function | Endpoint/hook | Recipient | Flutter consumer |
|---|---|---|---|---|
| New offer received | `offer.ts` `create`, lines 173-192 | `POST /offers` (backend-triggered, not a separate endpoint) | `resolveListingOwnerByAnyId` result — DB-derived, hardened per O1 | Notifications bell, kind `offer` |
| New message | `message/content-types/message/lifecycles.ts:21-78` `pushMessageNotification`, `afterCreate` | fires on any message row insert | `receiverEmail`/`receiverProfileId` off the message row (see §2 for how those get set) | Notifications bell, kind `message` (misclassified to `support` if text looks like a ticket, `notification_store.dart:466-482`) |
| Support ticket staff reply | `support-ticket-message/content-types/support-ticket-message/lifecycles.ts:260-299` | `afterCreate`, guarded to `senderType==='support'` only | `requesterEmail`/`requesterProfileId` off the ticket | Notifications bell, kind `support` |
| Admin broadcast/campaign | `admin-notification/content-types/admin-notification/lifecycles.ts` | Strapi Admin panel only | `resolveRecipients`: all/selected/single, server-derived from the admin-notification entry itself | Notifications bell, kind `broadcast` |
| **Offer accepted/rejected/countered** | **none, backend-side** — `offer.ts` `updateByOfferId` (lines 262-314) has zero notification code | n/a | n/a | See BUG-NOTIF-003 |
| Favorite / like / listing / logistics / processed product / premium / rocket | **none exist** | n/a | n/a | Not implemented (no bug — simply no source exists; flag for product to confirm this is intentional) |

---

## §2 — Identity / recipient

The schema (`notification/content-types/notification/schema.json:21-27`) has
**6 different recipient-alias fields** with no single canonical one:
`targetEmail`, `targetProfileId`, `ownerProfileId`, `receiverEmail`,
`receiverProfileId`, `recipientEmail`, `recipientProfileId` (plus 4
actor/sender aliases). Every read path (list-scope filter, `markRead`
ownership check) correctly ORs across all the aliases. The problem is not
inconsistency between these aliases — it's that **on creation, two of the
three producers let the client set them without server-side verification**:

- **Notification creation itself** (`notification-ownership.ts`, POST
  branch): `targetEmail`/`targetProfileId` are read directly from the
  client's `data` and used as-is whenever either is non-empty — only
  `senderEmail`/`senderProfileId` are forced server-side. **This is
  BUG-NOTIF-001, see below.**
- **Message creation** (`message-ownership.ts`): `receiverEmail`/
  `receiverProfileId` are taken from client `data` first, and only
  DB-resolved from the real thread/listing when the client left them
  **empty**. The check that's supposed to prevent abuse
  (`emailContainsMe || profileContainsMe`) is trivially satisfied because
  `requesterEmail` always defaults to the caller's own identity. **This is
  BUG-NOTIF-002.**
- **Offer creation** (`offer.ts:113-138`): correctly hardened — recipient is
  `resolveListingOwnerByAnyId(...)`, a real DB lookup that overrides any
  client-supplied value. This is the one producer that got it right (per the
  O1 fix).

---

## §3 — Creation (server-authoritative? duplicate risk?)

Not server-authoritative for the generic create endpoint or for messages
(see §2). Duplicate risk:

- No content-type has a DB-level unique constraint on `notificationId`
  (`schema.json:14`, no `unique: true`) — every producer relies on an
  application-level dedup key only (BUG-NOTIF-009, LOW, since in practice
  each key is derived from a just-created row's own id and each lifecycle
  fires once per insert).
- The one **concretely observed** duplicate: offer-created fires both the
  backend's own auto-notification (`offer.ts:173-192`) AND a client-pushed
  one (`offers_store.dart:613-620` → `_pushOfferRemoteNotification`) for the
  same event — two rows, two real FCM pushes. See BUG-NOTIF-003.

---

## §4 — Message notifications

- Message persists via the generic core controller; notification is created
  in `afterCreate` (`message/lifecycles.ts:21-78`), independent of the
  message write itself (own try/catch, logs-only on failure — a notification
  failure never rolls back or blocks the message).
- Sender self-notification is guarded (`isSamePerson` check,
  `lifecycles.ts:10-19,30-35`) — but only effective if the receiver field is
  genuinely different from the sender, which BUG-NOTIF-002 shows isn't
  guaranteed against a malicious client.
- Retry: the Message content-type has a DB-**unique** `operationId`
  (`message/schema.json:102-108`, unlike notification), and the Flutter retry
  path reuses the original `operationId` (`message_chat_page.dart:150-157`).
  A genuine retry hits the unique constraint and the insert fails outright —
  so **no duplicate notification on retry**, but the retry itself errors even
  if the original send actually succeeded (a messaging bug, not a
  notification-duplication bug, out of this audit's scope).
- **Corrected finding** (a research pass initially concluded "real chat
  messages never populate the bell for live traffic," citing
  `MessagesStore.receiveMessage()`/`_remoteReceiveMessage()` as evidence).
  Verified directly: those two methods **are** dead code (confirmed zero
  external call sites for `receiveMessage`, and its only caller of
  `_remoteReceiveMessage` is itself) — see DEAD/LEGACY below — but that is a
  *different* code path from the one that actually matters. The live path is
  `NotificationStore.refreshFromStrapi()` → `strapi.fetchNotificationsLatest()`
  (`strapi_service.dart:5230-5279`, confirmed to apply **no kind filter**,
  just sort+paginate) → `_fromStrapiRow()` (`notification_store.dart:394-492`,
  confirmed `_kindFromString('message')` correctly maps to
  `NotificationKind.message`, line 579-580) → `_items`. A real backend
  message-notification row (which sets `receiverEmail`/`receiverProfileId`,
  both included in the ownership policy's list-scope OR-filter) **should**
  reach the bell through this path like any other kind. The dead-code finding
  stands; the "message notifications never appear" conclusion does not, and
  is not included as a bug here.

---

## §5 — Offer notifications

| Event | Backend notification | Client notification |
|---|---|---|
| Created | Yes (`offer.ts:173-192`) | Yes, also (`offers_store.dart:613-620`) — **duplicate** |
| Accepted | No | Yes only (`offers_store.dart:801-808`) |
| Rejected | No | Yes only (`offers_store.dart:840-847`) |
| Countered | No | Yes only (`offers_store.dart:900-907`, `:957`) |

`OFFER_O1_CORE_FIX_REPORT.md:45` already documents that `updateByOfferId`
creates no notification of its own and that the only signal either party
gets is via the offer-event chat message's own notification chain — but the
report predates (or wasn't aware of) the client's own direct
`_pushOfferRemoteNotification` calls, which now **also** fire for every one
of these events through `NotificationStore.pushRemoteTarget` →
`strapi.pushNotification()`, a raw POST to the same open/spoofable create
endpoint from BUG-NOTIF-001. Net effect: offer-created double-notifies today;
accept/reject/counter get exactly one notification, but it's client-forged
through a vulnerable endpoint rather than server-verified, and it's
untyped (`kind: 'offer'` for all four events — Flutter has no
`offer_accepted`/`offer_rejected` sub-kind, `notification_models.dart:6-16`;
UI differentiates purely by the free-text title string, not a structured
field). See BUG-NOTIF-003.

Logistics-offer (the secondary offer flow) has zero notification code at
all — noted for completeness, out of primary scope.

---

## §6 — Read / unread

- `markRead` (`notification.ts:11-79`) is real ownership-checked
  (`matchesIdentity` against server-loaded entity fields, not just
  "authenticated") and idempotent (repeat calls always update the same row to
  `isRead:true`, no duplicate row, confirmed by
  `notification-mark-read.integration.test.ts:132-156`).
- **Sprint 5A markRead permission fix: PRESENT**, confirmed directly —
  `src/index.ts:266` grants `'api::notification.notification.markRead'` to
  the authenticated role, with the surrounding comment block (`index.ts:251,
  261-265`) explicitly noting this was reconciled during the
  `release/preflight-integration` merge, not just documented in the .md
  report.
- **Broadcast shared-state bug**: broadcast notifications are a single
  shared row (no per-recipient join table) — any authenticated user marking
  a broadcast "read" flips `isRead=true` for the row, i.e. for **every**
  recipient of that broadcast simultaneously. Confirmed intentional-bypass in
  the ownership check (both `notification-ownership.ts` and the `markRead`
  controller explicitly allow it), but the cross-user data-integrity
  consequence isn't further tested or (seemingly) considered. See
  BUG-NOTIF-004.
- Non-owner tries to `markRead` someone else's private notification → 403,
  target stays unread. Covered by an existing test.
- `readAt` (unlike `isRead`) is accepted verbatim from the client body
  (`notification.ts` markRead handler) — own-row-only, low impact, still
  worth noting. See BUG-NOTIF-010.
- Unread count is 100% client-computed (`_items.where(!isRead).length`, no
  server aggregate exists at all — confirmed no `count`/`unread-count`
  backend action exists).

---

## §7 — Refresh / polling

Confirmed trigger points: cold start (`restoreSessionIfNeeded` →
`_onSessionChanged(force:true)`), login/account switch (same path), a 30s
poll while logged in (`LiveSyncManager._tick`, `main.dart:1035`), app
foreground-resume (`HomePage.didChangeAppLifecycleState`,
`home_page.dart:136`), a 1-minute `HomePage` timer, receiving a push while
the app is open (`onMessage`/`onMessageOpenedApp` → `_refreshAfterPush`), and
opening the bell (`openNotifications()`). No pull-to-refresh exists on the
notifications list page itself (BUG-NOTIF-014, LOW — the other 6 triggers
make this a minor gap, not a missed-notification risk).

Given how many triggers exist, "new notification on server, never picked up"
is not a realistic risk for an app that's ever opened/foregrounded within a
reasonable window. The genuine correctness question in this area is the
account-switch race described in §15/BUG-NOTIF-006, not a lack of refresh
triggers.

---

## §8 — Push notifications

**Real, working FCM integration on both sides** (not a stub) — full
provider/registration/refresh/send/invalid-token-cleanup chain confirmed:

- Provider: Firebase Cloud Messaging, hand-rolled REST client server-side
  (`src/utils/fcm.ts`, HTTP v1 with service-account JWT + legacy-API
  fallback), no `firebase-admin` dependency.
- Token registration: real (`push_messaging_service.dart` →
  `auth-flow.registerPushToken`, which re-derives `profileId` from the JWT
  server-side, not from the client-supplied value — stored as a deduped
  array in `profile-setting.fcmTokens`, so multi-device is supported).
- Token refresh: implemented (`onTokenRefresh` → re-sync, `force:true`).
- Invalid-token cleanup: implemented and real —
  `notification/content-types/notification/lifecycles.ts:113-141`
  (`syncInvalidTokens`) strips reported-invalid tokens from `fcmTokens` after
  every send attempt.
- Logout cleanup: implemented, but with a **race** — see BUG-NOTIF-007.
- Cross-account contamination on a shared device — see BUG-NOTIF-008.
- No retry/backoff on transient (non-invalid-token) send failures — one
  attempt, marked `failed`, no requeue. POTENTIAL RISK, not a confirmed
  functional bug (a deliberate simplicity tradeoff is plausible).
- **iOS configuration gap**: `android/app/google-services.json` exists;
  no `GoogleService-Info.plist` and no FlutterFire-generated
  `firebase_options.dart` were found anywhere in the Flutter repo. Since
  `Firebase.initializeApp()` (`push_messaging_service.dart:23`) is wrapped in
  a try/catch that sets `_firebaseReady=false` on failure, **push is likely
  non-functional on iOS in this checkout** — flagged as POTENTIAL RISK rather
  than a confirmed bug, since this file is commonly excluded from a
  repository intentionally and may exist only in real deploy secrets/CI.
  Worth a direct confirmation before release.

---

## §9 — Foreground / background

No double-display risk found. Foreground pushes go through
`NotificationsService.show()` (a `flutter_local_notifications` banner) with
`setForegroundNotificationPresentationOptions(alert:false,...)` set during
init to suppress the OS's own foreground auto-display. The background
handler (`main.dart:347-386`) explicitly skips manual display for
`notification`-type payloads (deferring to the OS tray) and only manually
shows a local banner for data-only messages — a correctly guarded design for
the payload shapes reviewed.

---

## §10 — Deep link / tap

**Confirmed dead tap at the OS-notification level.** No
`getInitialMessage()` (cold-start tap) and no
`onDidReceiveNotificationResponse`/`onDidReceiveBackgroundNotificationResponse`
callback exist anywhere in `lib/` (verified directly — zero matches).
`FirebaseMessaging.onMessageOpenedApp` (the one handler that does exist,
`push_messaging_service.dart:93-97`) only calls `_refreshAfterPush()` — it
never reads `message.data` to navigate anywhere. Tapping a system-tray
notification, whether the app was backgrounded or terminated, never
navigates to a specific screen.

In-app list taps (`notifications_page.dart`) do route by `kind`, and every
enum value is handled (no literal no-op branch) — but only to the **generic
category tab** (Messages/Teklifler/etc.), never a specific thread/offer/
listing, because `AppNotificationItem` (`notification_models.dart:18-64`)
carries no reference id at all (no `threadId`/`offerId`/`listingId`), even
though producers already send this data in an `extra` payload
(`offers_store.dart:666-676`) that the client-side parser silently discards.
The one partial exception: support notifications extract a ticket ref via a
**regex over the free-text title/message**, not structured data. See
BUG-NOTIF-011.

---

## §11 — Badge counts

Fully client-computed, no server aggregate. `markRead` is optimistic-first
(local flag flips before the network call resolves) with **no rollback** on
server failure — a deliberate prior design choice (documented inline,
`notification_store.dart:373-382`, tagged `PERMISSION_GAP_S5A`) after an
earlier retry-via-create fallback was found to duplicate rows. Reconciliation
on next fetch is one-directional ("locally read" always wins over a fresher
server value showing unread), which prevents the badge from flickering back
but means local/server can permanently diverge in the other direction. Count
cannot go negative (pure filter, no arithmetic decrement) but can **under**-
count: `fetchNotificationsLatest(limit:50)` means anything older than the
newest 50 rows is never fetched and never counted. See BUG-NOTIF-013.
`openNotifications()` also marks every currently-fetched notification "read"
immediately on opening the bell, before the user has scrolled to or viewed
any individual item — a "seen the list" semantic, not "read this item,"
which is a product-decision question rather than a bug.

---

## §12 — Duplicate prevention

Client-side dedup by id works correctly for the normal fetch/merge case
(`refreshFromStrapi`'s `Map<id, item>` merge). The one confirmed concrete
duplicate is the offer-created double-notification (§5/BUG-NOTIF-003). A
narrower, unconfirmed-in-practice gap: `_fromStrapiRow`'s id fallback
(`'n_remote_${...microsecondsSinceEpoch}'`) only triggers if a server row is
missing both `notificationId` and `id`, which shouldn't normally happen for a
real Strapi REST response.

---

## §13 — Notification schema

`api::notification.notification` (`schema.json:1-51`), no relations, all
flat scalars:

| Field | Type | Notes |
|---|---|---|
| `notificationId` | string | app-level id, **no unique constraint** |
| `kind`, `type` | string | `kind` is primary, `type` is a fallback read everywhere |
| `title`, `message` | string, text | |
| `isRead` | boolean | default false, server-set only via `markRead` |
| `readAt` | datetime | **client-settable verbatim** via `markRead` body |
| `targetEmail`, `targetProfileId`, `ownerProfileId`, `receiverEmail`, `receiverProfileId`, `recipientEmail`, `recipientProfileId` | string | 6-way recipient alias sprawl, all OR'd on every ownership check |
| `senderEmail`, `senderProfileId`, `requesterEmail`, `requesterProfileId` | string | actor aliases |
| `listingId`, `offerId`, `threadId`, `questionId`, `answerId` | string | deep-link reference fields — **exist on the schema but are never read back into the Flutter model** |
| `source`, `event` | string | metadata |
| `broadcast`, `isBroadcast`, `targetAll`, `audience`, `targetAudience` | mixed | 5 different ways to mean "everyone" — redundant, all checked in `isBroadcast()`, not dead but a cleanup opportunity |
| `skipPush`, `pushStatus`, `pushError`, `sentAt` | mixed | push bookkeeping |
| `createdAtClient`, `updatedAtClient` | datetime | |

**Flutter model does not match**: `AppNotificationItem`
(`notification_models.dart:18-64`) only has `id, kind, title, message,
createdAt, isRead` — every deep-link field the schema already has
(`listingId`/`offerId`/`threadId`) is dropped during parsing. This is the
root cause of BUG-NOTIF-011.

---

## §14 — Security

Covered in depth above. Summary: `find`/`findOne`/`update`/`delete` and
`markRead` are all correctly ownership-checked against server-loaded data,
**not** IDOR-vulnerable. The one severe gap is `create` itself — see
BUG-NOTIF-001. Broadcast rows are a deliberate, if under-considered,
shared-state exception (BUG-NOTIF-004).

---

## §15 — Account switch

`NotificationStore.clearForSession()` (`notification_store.dart:164-168`)
exists and is wired into the single shared `_onSessionChanged`, confirmed at
all 3 of its call sites (`main.dart:5319, 5724, 5974`) — covers login,
logout, and the other login path alike, unlike the pre-fix `PurchaseStore`
bug from the Premium audit. Persisted cache keys are namespaced by owner
id/email, so a genuinely different account never reads another account's
local cache. `unreadCount` is a live getter over `_items`, not a separately
cached field, so it can't survive independently of the clear.

**However, a real same-owner race exists**: `restoreForSession()` is fired
`unawaited` immediately after `clearForSession()` (`main.dart:5993`) and does
an unconditional `_items..clear()..addAll(restored)` from local
SharedPreferences whenever it happens to finish — with no ordering guarantee
against the session-refresh queue's own `await NotificationStore.I
.refreshFromStrapi(force:true)` a few steps later
(`main.dart:6014-6058`). If the local read is ever slower to start/finish
relative to the network fetch completing, `restoreForSession()`'s hard
overwrite can silently replace freshly-fetched server data with an older
local snapshot. Not a cross-account leak (the storage key already belongs to
the new owner by that point), but a real data-freshness bug. See
BUG-NOTIF-006.

---

## §16 — Dead / legacy code

- `MessagesStore.receiveMessage(threadId, msg)` (`messages_store.dart:765`)
  and `_remoteReceiveMessage` (`:1768`, only ever called from the former) —
  **DEAD**. Confirmed zero external call sites for `receiveMessage` anywhere
  in `lib/`. These are the only functions in the whole message/notification
  path that call `NotificationStore.I.add()` directly for an inbound
  message — since they're unreachable, the live path is entirely the
  generic `refreshFromStrapi()` fetch (see the §4 correction).
- No second/parallel notification content-type or mechanism exists
  backend-side — `admin-notification` is a distinct, intentional fan-out
  source, not a legacy duplicate (**LIVE**).
- The 5-field broadcast-flag redundancy (§13) is **LIVE** (all checked), just
  redundant design, not dead.

---

## §17 — Test coverage

**Backend** — one file exists,
`tests/integration/notification-mark-read.integration.test.ts`: owner
marks-read (200), non-owner denied (403, victim stays unread), unauthenticated
(403), idempotent double-mark-read (200 twice, one row), broadcast bypass
(any user can mark a broadcast read, documented but the shared-state
consequence for other recipients isn't further asserted). **Missing**: no
test for `find`/`findOne`/`update`/`delete` ownership (only `markRead` is
covered, despite sharing the same policy); no test at all for `create`
(neither the happy path — does a message really produce the right
notification row end-to-end — nor BUG-NOTIF-001's spoof); no duplicate-
notification test for the offer-created double-fire; no push-token
registration/refresh/logout-cleanup test.

**Flutter** — **zero** test coverage for `NotificationStore` (no
`test/features/notifications/` directory exists at all, confirmed via
search). For comparison, the just-completed Premium P1 phase added
`clearForSession()` coverage for the analogous `PurchaseStore`
(`test/features/premium/purchase_store_test.dart`) — `NotificationStore` has
the same class of session/account-switch surface area, plus the
newly-identified `restoreForSession()` race that `PurchaseStore` doesn't
have (no local-persistence layer there), and none of it is tested.

---

## §18 — Previous fix regression check

| Item | Status |
|---|---|
| Sprint 5A `notification.markRead` permission fix | **PRESENT** — `src/index.ts:266`, independently re-derived from the controller's ownership check, not just the .md report |
| S5A "create-fallback removal" (retry-via-create on markRead failure) | **PRESENT** — confirmed removed, replaced by the "local read wins, no rollback" design documented at `notification_store.dart:373-382` |
| Messaging ↔ notification relationship | **PRESENT AND LIVE**, but see BUG-NOTIF-002 — the relationship itself works (a message creates a notification), but the recipient-resolution half of it (`message-ownership.ts`) has its own, separate spoof gap not previously audited under "Messaging M1-M4" (those sprints fixed delivery/read/reliability, not this) |

No regression found in previously-shipped notification behavior; the new
findings below are gaps that were never fixed, not something that broke.

---

## Findings

### CONFIRMED BUG

**BUG-NOTIF-001 — CRITICAL — RELEASE BLOCKER**
- **Live caller**: `POST /api/notifications` (`src/api/notification/routes/notification.ts`, default Strapi `create` action), guarded only by `global::notification-ownership` (`src/policies/notification-ownership.ts:71-97`), and `'api::notification.notification.create'` is granted to the authenticated role (`src/index.ts:256`).
- **Expected**: a client can only ever create a notification addressed to themselves, or the recipient is independently re-derived server-side from a real relationship (thread participant, listing owner, ticket requester).
- **Actual**: on POST, `targetEmail`/`targetProfileId` are read directly from the client's `data` object (lines 80-81) and used as-is whenever either is non-empty; they only default to the caller's own identity if **both** are empty (lines 83-86). Only `senderEmail`/`senderProfileId` are forced server-side (lines 92-93).
- **Root cause**: the policy validates who's *sending*, never who's allowed to *receive*.
- **Backend**. **Security/data impact**: any authenticated user can create a notification (with attacker-controlled `title`/`message`/`kind`/deep-link metadata fields) targeting an arbitrary victim by email or profileId. Because every notification create triggers the content-type's own `afterCreate` → `deliverPush` (`notification/content-types/notification/lifecycles.ts:241-253`), this is a real, working **arbitrary FCM push injection** to any victim with a registered device — usable for phishing (fake "offer accepted"/system messages with attacker-chosen text and deep-link-looking metadata), harassment/spam (no rate limit found), and it also silently populates the victim's real in-app notification list. `isBroadcast()` only blocks the "everyone" case; a single-target spoof is trivial to construct and avoids all of its keyword checks.
- **Minimum safe fix**: on POST, require `targetEmail`/`targetProfileId` to either (a) equal the caller's own identity, or (b) be independently re-derived server-side from a real relationship the specific `kind` implies (thread participant for `message`, listing owner for `offer`, ticket requester for `support`) — i.e. apply the same pattern `offer.ts` already uses for offer notifications to the generic create endpoint itself, or retire the generic client-reachable `create` action entirely in favor of internal-only notification creation (mirroring `engagement-interaction`'s empty-routes pattern used elsewhere in this codebase) plus dedicated, server-verified endpoints per source (which would also directly fix BUG-NOTIF-003).
- **Required tests**: self-target succeeds; client-supplied `targetEmail` different from caller and not derivable from any real relationship → rejected; a legitimate thread-participant/listing-owner/ticket-requester target still succeeds via the hardened path; broadcast-keyword bypass attempt still rejected; victim's device does not receive a push from a rejected attempt.

**BUG-NOTIF-002 — HIGH**
- **Live caller**: `POST /api/messages` guarded by `global::message-ownership` (`src/policies/message-ownership.ts:36-118`).
- **Expected**: `receiverEmail`/`receiverProfileId` should always be the real other participant of the thread/listing, server-derived, never trusted from the client when non-empty.
- **Actual**: client-supplied `receiverEmail`/`receiverProfileId` are used first (lines 41-44); server-side thread/listing resolution only fills gaps when the client left them **empty** (line 70 guard). The anti-abuse check (`emailContainsMe || profileContainsMe`, line 105) is trivially satisfied because `requesterEmail` defaults to the caller's own identity (line 67) regardless of what `receiverEmail` was set to.
- **Root cause**: participant validation checks "am I *a* participant" instead of "is the declared receiver *actually* the other side of this thread/listing."
- **Backend**. **Security/data impact**: an authenticated user can send a message directly to an arbitrary victim's email/profileId without a real shared thread/listing context, which (per the live, confirmed message→notification pipeline) also notifies that victim and can trigger a real push — a spam/harassment vector at minimum, and a broader messaging-integrity concern beyond notifications specifically.
- **Minimum safe fix**: when `threadId`/`listingId` is present, `receiverEmail`/`receiverProfileId` must be **overridden** by the DB-resolved participant/owner, not merely used as a fallback for empty values; when neither is present (a genuinely new, context-free message), require an explicit, separately-validated relationship before allowing send.
- **Required tests**: client-supplied `receiverEmail` differing from the resolved thread participant is rejected/overridden; existing legitimate thread/listing message flows still pass; a message with no `threadId`/`listingId` and an arbitrary receiver is rejected.

**BUG-NOTIF-003 — HIGH**
- **Live caller**: `OffersStore._pushOfferRemoteNotification` (`offers_store.dart:638-678`), called for created/accepted/rejected/countered (lines 613, 801, 840, 900, 957 and 2 more), via `NotificationStore.pushRemoteTarget` → a raw create against the endpoint from BUG-NOTIF-001.
- **Expected**: each offer lifecycle event produces exactly one server-verified, correctly-typed notification.
- **Actual**: "created" produces **two** (the backend's own `offer.ts:173-192` plus the client's push) → two real FCM pushes for one event. Accepted/rejected/countered produce no backend-verified notification at all (`updateByOfferId`, `offer.ts:262-314`, has none) — only the client-forged one via the vulnerable open endpoint, untyped (`kind:'offer'` for all four events, differentiated only by a free-text title, not a structured sub-type Flutter can branch on).
- **Root cause**: the client took on notification-creation responsibility that should live in `updateByOfferId`/`offer.create` server-side, using the same open, unverified endpoint flagged in BUG-NOTIF-001.
- **Backend + Flutter**. **Security/data impact**: shares BUG-NOTIF-001's spoofing exposure (a client can forge an "offer accepted" notification for a fake/nonexistent offer against a victim), plus a real duplicate-notification/duplicate-push UX bug on offer creation today, independent of the security angle.
- **Minimum safe fix**: move accept/reject/counter notification creation into `updateByOfferId` server-side (mirroring the already-correct `offer.create` pattern), add a distinct `event`/sub-kind field the Flutter model actually reads, and remove the client's own `_pushOfferRemoteNotification` calls entirely once the backend covers all 4 events (this also directly resolves the "created" duplicate).
- **Required tests**: accept/reject/counter each produce exactly one server-created notification; created still produces exactly one; a forged client push for one of these events (bypassing the real offer-status flow) is rejected once BUG-NOTIF-001 is fixed.

### POTENTIAL RISK / MEDIUM

**BUG-NOTIF-004 — MEDIUM**
- Broadcast notifications are a single shared row (`isRead`/`readAt` scalar fields, no per-recipient join). Any recipient marking it read flips it for **every** recipient. Confirmed intentional in the ownership-bypass code, but the cross-user consequence (User A's read action silently clearing User B's unread badge for that broadcast) doesn't appear to have been a deliberate product decision so much as an accepted side effect of the data model.
- **Minimum safe fix**: either a per-recipient read-receipt join table for broadcasts, or explicitly document/product-decide that broadcast read-state is intentionally shared (in which case reclassify as PRODUCT DECISION).
- **Required tests**: User A marks a broadcast read; assert User B's own unread state for that broadcast (if per-recipient state existed) is unaffected — currently would fail by design.

**BUG-NOTIF-005 — MEDIUM**
- Account deletion (`auth-flow.ts:332-341`) filters notification cleanup by `{ownerProfileId, receiverEmail, requesterEmail}` only — omits `targetEmail`/`targetProfileId`/`recipientEmail`/`recipientProfileId`/`receiverProfileId`. Offer-created and support-reply notifications set only `targetEmail`/`targetProfileId` and so **survive account deletion** as orphaned rows referencing the deleted user's email.
- **Minimum safe fix**: extend the `$or` filter to cover all 7 recipient-alias fields.
- **Required tests**: delete an account with an offer-received notification and a support-reply notification; assert both rows are gone afterward (currently would fail).

**BUG-NOTIF-006 — MEDIUM**
- `NotificationStore.restoreForSession()` (unawaited local SharedPreferences read/overwrite) races against the session-refresh queue's `await refreshFromStrapi(force:true)` with no ordering guarantee (`main.dart:5993` vs. `main.dart:6014-6058`). If the local read finishes after the network fetch, fresher server data is silently discarded and replaced by a stale local snapshot for the same (correct) owner.
- **Minimum safe fix**: await `restoreForSession()` before the session-refresh queue starts (or have `refreshFromStrapi` refuse to be overwritten by a lower-timestamped local restore).
- **Required tests**: simulate a slow local-prefs read completing after a fast `refreshFromStrapi` and assert the server data wins.

**BUG-NOTIF-007 — MEDIUM**
- `AuthService.logout()` fires `unawaited(PushMessagingService.unregisterForEmail(...))` and `unawaited(StrapiService.clearJwt())` back-to-back with no ordering (`main.dart:5714-5725`). `unregisterForEmail` needs to read the still-valid JWT before it can call the backend; if `clearJwt()` wins the race, the JWT read returns empty and the backend unregister call is silently skipped (only local state is cleared).
- **Minimum safe fix**: `await` the unregister call (or at least its JWT read) before clearing the JWT.
- **Required tests**: force the clearJwt-first ordering and assert the backend token removal still happens.

**BUG-NOTIF-008 — MEDIUM**
- `registerPushToken` never checks whether the same token string already exists in a **different** profile's `fcmTokens` before adding it to the current profile's array (`auth-flow.ts:459-528`). Combined with BUG-NOTIF-007's race, "A logs out (unregister silently skipped) → B logs in on the same device" can leave the identical token in both A's and B's `fcmTokens`, so a notification addressed to A can still push to the device now used by B, until FCM organically reports the token invalid for A (which it won't, since the token is still valid, just now used by someone else) or some other flow separately unregisters it.
- **Minimum safe fix**: on `registerPushToken`, proactively remove the same token string from every other profile's `fcmTokens` before adding it to the caller's.
- **Required tests**: A registers a token, logs out (simulate the BUG-NOTIF-007 race so unregister is skipped), B logs in with the same token on the same device — assert the token no longer appears in A's `fcmTokens`.

### LOW

**BUG-NOTIF-009 — LOW**: no DB-level unique constraint on `notificationId` (`schema.json:14`) across any of the 4 creation call sites — app-level dedup keys only, no backstop against a future bug/race double-inserting. Fix: add `unique: true`.

**BUG-NOTIF-010 — LOW**: `markRead`'s `readAt` is accepted verbatim from the client body (own row only). Fix: server-derive `readAt` from `new Date()` unconditionally, ignore any client-supplied value.

**BUG-NOTIF-011 — LOW**: `AppNotificationItem` carries no `threadId`/`offerId`/`listingId`/reference id at all, even though the backend schema already has these fields and producers already send them in an `extra` payload that the client silently discards — every tap (in-app and system-tray) lands on a generic category tab/page at best, or nowhere at all for a system-tray tap (no `getInitialMessage`/`onDidReceiveNotificationResponse` exists anywhere). Fix: extend `AppNotificationItem`/`_fromStrapiRow` to keep the reference id(s), thread the corresponding page constructors to accept one, and wire `getInitialMessage`/`onMessageOpenedApp`/a local-notification response callback to actually navigate using it.

**BUG-NOTIF-012 — LOW**: `admin-notification`'s recipient fan-out loop (`lifecycles.ts:188-194`) has no per-iteration error handling; one `entityService.create` failure partway through aborts all remaining recipients, yet the entry is marked `deliveryStatus:'failed', sentCount:0` even if earlier recipients already got a row — inaccurate accounting on top of incomplete delivery. Admin-only surface (not reachable by mobile clients), hence LOW despite the correctness gap. Fix: per-recipient try/catch, accurate `sentCount`, and a resumable retry path.

**BUG-NOTIF-013 — LOW**: `unreadCount` is computed only from the newest 50 fetched rows (`fetchNotificationsLatest(limit:50)`) — a user with more than 50 historical notification rows can have a true unread total the client under-counts. Fix: either raise the fetch limit for this specific purpose or add a real server-side unread-count aggregate endpoint.

**BUG-NOTIF-014 — LOW**: no pull-to-refresh on the notifications list page. Minor, since 6 other refresh triggers exist. Fix: add a `RefreshIndicator` calling `refreshFromStrapi(force:true)`.

### POTENTIAL RISK (not a confirmed bug)

- iOS Firebase config (`GoogleService-Info.plist`/`firebase_options.dart`) not found anywhere in this checkout — push is likely non-functional on iOS builds unless real deploy secrets differ from what's committed. Could simply be an intentionally-gitignored secret; worth a direct confirmation before release rather than assuming either way.
- No retry/backoff/queue for transient (non-invalid-token) FCM send failures — a single attempt, marked failed, never retried. Plausibly an intentional simplicity tradeoff for a first release rather than an oversight.

### PRODUCT DECISION (flagging for confirmation, not asserting as wrong)

- No backend bulk/`markAllRead` endpoint — the client's `markAllRead()` just fires one `markRead` PATCH per item. Works, but is N concurrent requests instead of one; likely fine at current scale.
- `openNotifications()` marks every currently-fetched notification "read" the moment the bell is opened, not when each item is individually viewed — a "seen the list" semantic. Worth confirming this matches intended UX.

### DEAD / LEGACY

- `MessagesStore.receiveMessage()` / `_remoteReceiveMessage()` (`messages_store.dart:765, 1768`) — confirmed dead, zero external callers. Safe to delete in a future cleanup pass; not touched in this read-only audit.

---

## Decision

**RELEASE BLOCKED.**

BUG-NOTIF-001 is a real, currently-exploitable vulnerability: any
authenticated user can push an arbitrary, attacker-controlled real
FCM notification (title, body, and deep-link-looking metadata) to any other
known user's device and inbox, today, with no rate limit. This must close
before this system can ship. BUG-NOTIF-002 and BUG-NOTIF-003 share enough of
the same root cause (client-driven notification creation through an
unverified path) that they should reasonably be closed in the same pass.

Recommend a **Notification Targeted Fix phase** (mirroring the just-closed
Premium P1 structure) covering, at minimum, BUG-NOTIF-001/002/003 as the
release blockers, with BUG-NOTIF-004 through 008 (MEDIUM) as strong
candidates for the same phase given how small each fix is, and the LOW/
POTENTIAL RISK/PRODUCT DECISION items deferred or product-confirmed as
appropriate — matching the disposition pattern already used for BUG-PREM-004
in the Premium phase.

Per the audit instruction: stopping here. Not proceeding to code fixes
automatically.
