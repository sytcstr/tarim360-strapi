# TARIM360+1 — Notification Follow-up Triage N2

READ-ONLY. No code changed, no commits, no push, `main` untouched, no
production mutation. Every item re-verified directly against the
current `release/preflight-integration` code in both repos (not
assumed from the prior audit or N1 report) — file contents quoted below
are fresh reads taken during this triage, not carried over.

**Final decision: READY FOR TARGETED N2 FIX** (one small item; see below).

---

## Triage table

| ID | Severity | Live? | User impact | Security/privacy? | Decision | Reason |
|---|---|---|---|---|---|---|
| BUG-NOTIF-004 (broadcast read-state) | Re-assessed: LOW (was MEDIUM in the audit) | Yes, but narrower than described | A guessable-id IDOR could mark one specific victim's broadcast row read; does **not** affect "all recipients" via one shared row | Minor privacy/annoyance (badge suppression), not data exposure | **DEFER** | See analysis below — the audit's "single shared row" premise doesn't hold for the only real producer |
| BUG-NOTIF-005 (account deletion orphans) | MEDIUM, and now **wider** than audited | Yes | Deleted user's email/profileId persists on orphaned notification rows (offer + all 4 domain-event social-interaction types) | Yes — data-retention/PII | **FIX NOW** | Trivial, low-risk, one-line filter extension; scope grew because N1's own new producers (`createDomainEvent`, `updateByOfferId`) hit the same gap |
| BUG-NOTIF-006 (restoreForSession race) | **Not reproducible in current code** | N/A | None today | N/A | **NOT A BUG** (current implementation) | `restoreForSession()` has zero internal `await`s — proven below to run-to-completion synchronously before the refresh queue's first real network call starts |
| FCM account-switch/logout race | — | — | — | — | **ALREADY CLOSED BY N1** | Re-verified directly in `auth-flow.ts`, confirmed via the 24 passing N1 tests |
| BUG-NOTIF-009 (no unique `notificationId`) | LOW | — | — | — | **ALREADY CLOSED BY N1** | `schema.json:14` now has `"unique": true`, re-verified directly |
| BUG-NOTIF-010 (`readAt` client-controllable) | LOW | Yes | Own notification only, client can set an arbitrary timestamp | Negligible | **DEFER** | Own-row-only, no cross-user impact; unrelated to N1's scope |
| BUG-NOTIF-011 (no deep-link to specific entity; dead OS-tap) | LOW | Yes | Taps land on generic category tab, not the specific thread/offer/listing; system-tray tap doesn't navigate at all | None (UX only) | **DEFER** | Cosmetic/UX, not a release blocker; unrelated to N1's scope |
| BUG-NOTIF-012 (admin fan-out not atomic) | LOW | Yes, but admin-only surface | Inaccurate `sentCount`/`deliveryStatus` on partial failure | None (not reachable by mobile clients) | **DEFER** | Confirmed still present (bare `for` loop, no per-recipient try/catch); low blast radius |
| BUG-NOTIF-013 (unread count only from latest 50 rows) | LOW | Yes | Can under-count true unread total for users with >50 historical notifications | None | **DEFER** | Cosmetic undercounting edge case |
| BUG-NOTIF-014 (no pull-to-refresh) | LOW | Yes | Minor UX gap | None | **DEFER** | 6 other refresh triggers already cover this |

---

## 1. Broadcast notification read-state — re-assessed

Re-read `notification-ownership.ts` and `notification.ts`'s `markRead`
directly: both still let **any** authenticated user act on a
broadcast-flagged row without an ownership check (`isBroadcast(entity)`
bypasses `mine`/`isOwner` in both the generic policy and the custom
`markRead` action) — this part of the audit's finding is accurate and
unchanged.

**What's materially different from how the audit described it**: the
audit characterized this as "one shared row, so one user's read flips
it for everyone." Re-reading the *only* real, live broadcast producer —
`admin-notification/content-types/admin-notification/lifecycles.ts`'s
`dispatchAdminNotification` — shows this is **not** a single shared row.
It loops over every resolved recipient and calls `entityService.create`
**once per recipient**, each with its own deterministic-but-recipient-
specific `notificationId` (`admin_${entryId}_${stableToken(recipient.ownerId
|| recipient.email)}`) and that recipient's own `targetEmail`/
`targetProfileId`. So User A marking "their" broadcast notification read
only ever touches A's own row — it does **not** flip B's or C's read
state, because there is no single row shared across recipients in the
first place.

The residual real risk is narrower and different in kind: because the
ownership check is bypassed entirely for broadcast rows, and each
recipient's `notificationId` is a *deterministic, guessable* string
(`admin_<entryId>_<normalized email or ownerId>`), an attacker who knows
(a) a real admin-notification `entryId` (small sequential integer) and
(b) a victim's email or ownerId could construct that victim's exact
`notificationId` and call `markRead` on it — silently marking that one
specific victim's broadcast notification as read (suppressing their
badge for it) without their knowledge or consent. This requires the
attacker to already hold a valid JWT (admin-notification itself is not
reachable by mobile clients — no `create`/`find` grant — but `markRead`
on an *existing* row is a generic, already-authenticated-user-reachable
action) plus specific knowledge of the entryId+victim-identity pair. No
data is exposed, no content is created/modified — the only effect is
flipping one boolean on one specific victim's own notification.

**Decision: DEFER.** This is a real, if narrow, IDOR-adjacent gap, but
materially lower severity than the audit's original framing (no
cross-user data corruption, no shared-state effect on other recipients,
requires non-trivial guessing, and the actual harm ceiling is "one
notification silently marked read for one specific victim"). Not a
release blocker. If addressed in a future phase, the fix would be to
extend the ownership check for broadcast rows in `markRead`/the policy's
`if(id)` branch to still verify the caller matches that row's own
`targetEmail`/`targetProfileId` — i.e. treat "broadcast" as "readable
without restriction" (already the case via the GET-scope filter) but not
"mark-read-able by anyone," since each row already has a real, single
intended owner despite the `broadcast` flag.

---

## 2. Account deletion — confirmed live, wider than audited

Re-read `auth-flow.ts`'s `deleteAccount` cleanup directly:

```ts
deleted.notification = await deleteByFilter(
  'api::notification.notification',
  {
    $or: [
      { ownerProfileId: ownerId },
      { receiverEmail: email },
      { requesterEmail: email },
    ],
  },
);
```

Unchanged since the original audit — still omits `targetEmail`/
`targetProfileId`/`recipientEmail`/`recipientProfileId`/
`receiverProfileId`. Re-checked every notification producer's actual
written fields:

| Producer | Fields it sets | Caught by the current filter? |
|---|---|---|
| Message (`message/lifecycles.ts`) | `receiverEmail`/`receiverProfileId` (+ `targetEmail`/`messageReceiverEmail` aliases, now server-verified per N1) | Yes |
| Support-reply (`support-ticket-message/lifecycles.ts`) | `targetEmail`/`targetProfileId` only | **No** |
| Offer created (`offer.ts` `create`) | `targetEmail`/`targetProfileId` only | **No** |
| Offer accepted/rejected/countered (`offer.ts` `updateByOfferId`, added in N1) | `targetEmail`/`targetProfileId` only | **No** |
| Domain-event: listing/logistics-load/processed-product/profile favorite+like+comment (`notification.ts` `createDomainEvent`, added in N1) | `targetEmail`/`targetProfileId` only | **No** |
| Admin broadcast (`admin-notification/lifecycles.ts`) | `targetEmail`/`targetProfileId` (+ `receiverEmail`/`receiverProfileId`, both set) | Yes (via `receiverEmail`) |

So today, **every producer except message and admin-broadcast** creates
rows that survive account deletion as orphaned PII — and N1 itself
*added two more* such producers (offer status-changes, domain-events),
widening this gap's real-world footprint rather than narrowing it. This
is a genuine data-retention/privacy issue: a deleted user's email
persists indefinitely on notification rows referencing them.

**Decision: FIX NOW.** The fix is a one-line filter extension (add
`targetEmail`/`targetProfileId` to the existing `$or` array — the other
two alias fields, `recipientEmail`/`recipientProfileId`, aren't
currently written by any live producer but are cheap to include for
completeness against future producers). Low risk, high value, directly
proportional to the gap N1 itself widened.

**Minimum fix scope**: extend the one `$or` filter array in
`auth-flow.ts`'s `deleteAccount` notification cleanup to include
`targetEmail`, `targetProfileId`, `recipientEmail`, `recipientProfileId`.
No schema change, no migration, no other file touched. One regression
test: delete an account with an offer-created notification and a
domain-event notification pointing at it; assert both rows are gone.

---

## 3. `restoreForSession` race — re-verified, not reproducible

Re-read `notification_store.dart`'s `restoreForSession()` in full:

```dart
Future<void> restoreForSession() async {
  try {
    final prefs = AppPrefs.instance;
    final raw = prefs.getString(_storageKeyForCurrentSession()) ?? '';
    if (raw.trim().isEmpty) return;
    final parsed = jsonDecode(raw);
    if (parsed is! List) return;
    final restored = parsed.whereType<Map>()...toList(growable:false)..sort(...);
    if (restored.isEmpty) return;
    _items..clear()..addAll(restored);
    _ping();
  } catch (e) { debugPrint('Notifications restore failed: $e'); }
}
```

**There is no `await` anywhere in this function's body.** It's declared
`async` (returns a `Future<void>`) but never actually suspends — every
operation inside (`AppPrefs.instance` field access, `jsonDecode`, list
mapping/sorting) is synchronous CPU work. `AppPrefs.instance` is
confirmed (`app_prefs.dart:6,12`) to be a `static late SharedPreferences`
— i.e. already loaded into memory once at app boot; `.getString()` on it
is a synchronous in-memory map lookup, not a disk read.

**The async ordering, proven, not assumed**: in `main.dart`'s
`_onSessionChanged` (line 5983 area):

```dart
NotificationStore.I.clearForSession();
unawaited(NotificationStore.I.restoreForSession());   // (A)
...
unawaited(_runSessionRefreshQueue());                  // (B)
```

Per Dart's execution model, an `async` function runs synchronously up to
its first genuine suspension point (an `await` on a not-already-resolved
`Future`). Since (A) has no such suspension point at all, calling it
runs its **entire body to completion**, synchronously, before the
enclosing `_onSessionChanged` call even reaches line (B) — `_items` is
already fully restored-and-overwritten before `_runSessionRefreshQueue()`
starts, let alone before it reaches its 7th sequential step
(`notifications`, after listings/hub/farmer/favorites/favoriteProfiles/
offers/messages, each a real network round-trip).

**A login → fresh fetch → stale cache restore scenario, checked
directly**: for the network fetch to be overwritten by a *stale* local
restore, (A) would need to complete *after* the notifications step of
(B) — structurally impossible today, since (A) always finishes (fully
synchronously) before (B) is even invoked, and (B) additionally has 6
other awaited network steps ahead of the notifications step even if (A)
were somehow delayed.

**Decision: NOT A BUG**, as currently implemented. This reasoning is
contingent on `AppPrefs`/`SharedPreferences` remaining a pre-loaded,
synchronous, in-memory-backed store — worth re-checking only if that
storage layer is ever replaced with something genuinely async (e.g. a
real database-backed preferences store), which is not planned and not
in scope here.

---

## 4. FCM race — confirmed already closed by N1

Re-read `auth-flow.ts`'s `registerPushToken` directly (not from the N1
report): the cross-profile eviction block is present exactly as
described — before adding a token to the caller's own `fcmTokens`, it
scans every *other* `profile-setting` row (`filters: { profileId: { $ne:
profileId } }`) for the same token string and removes it. Confirmed via
the 24 passing N1 regression tests, including the two dedicated to this
exact scenario (`N1.4: registering a token to user B evicts it from user
A` and the multi-device non-eviction test). **ALREADY CLOSED BY N1 — no
new code written.**

---

## 5. Remaining LOW items — individually re-verified

- **BUG-NOTIF-009** (no unique `notificationId` constraint) —
  `schema.json:14` now reads `"notificationId": { "type": "string",
  "unique": true }`. **ALREADY CLOSED BY N1.**
- **BUG-NOTIF-010** (`readAt` accepted verbatim from the client in
  `markRead`) — confirmed still present, unchanged, own-row-only. **DEFER.**
- **BUG-NOTIF-011** (no reference id carried by `AppNotificationItem`;
  no `getInitialMessage`/`onDidReceiveNotificationResponse` callback) —
  out of N1's scope, confirmed untouched. Cosmetic/UX, not security.
  **DEFER.**
- **BUG-NOTIF-012** (admin-notification fan-out loop has no
  per-recipient try/catch) — re-read `lifecycles.ts`'s
  `dispatchAdminNotification` directly: still a bare `for` loop, still
  not reachable by mobile clients. **DEFER.**
- **BUG-NOTIF-013** (`fetchNotificationsLatest(limit:50)` can
  under-count true unread total) — out of N1's scope, confirmed
  untouched. **DEFER.**
- **BUG-NOTIF-014** (no pull-to-refresh on the notifications list page)
  — out of N1's scope, confirmed untouched; 6 other refresh triggers
  already exist. **DEFER.**

No dead/legacy caller was mistaken for a live bug in this pass; no
cosmetic/UI-only item was escalated to release-blocker.

---

## 6. N1 regression check — all 8 items confirmed present

| Item | Status | Evidence |
|---|---|---|
| Generic notification create is self-target-only | PRESENT | `notification-ownership.ts:94-101`, `claimsOther` check re-read directly |
| `POST /notifications/domain-event` exists | PRESENT | `custom-notification.ts` route + `notification.ts`'s `createDomainEvent` action re-read directly |
| Server-derived recipient (domain-event) | PRESENT | `resolveDomainOwner`/four resolvers still wired, re-read directly |
| Server-derived notification text (domain-event) | PRESENT | `DOMAIN_EVENTS` template map + `senderLabel` construction re-read directly |
| Conversation receiver protection | PRESENT | `verifyAndCorrectReceiver`/`resolveContextOwner` still present and wired into both `sendMessage` and `upsert`, confirmed via grep |
| Offer create/accept/reject/counter server notification | PRESENT | `offer.ts` `create` + `updateByOfferId` notification blocks re-read directly |
| Duplicate offer-created notification removed (Flutter) | PRESENT | `_pushOfferRemoteNotification`/`pushRemoteTarget` confirmed absent from `offers_store.dart` via grep |
| FCM token single-owner enforcement | PRESENT | Covered in §4 above |

No regression found.

---

## FIX NOW list (the only item requiring action)

1. **BUG-NOTIF-005 (account deletion orphans)** — extend
   `auth-flow.ts`'s `deleteAccount` notification-cleanup `$or` filter to
   include `targetEmail`/`targetProfileId` (and, for completeness,
   `recipientEmail`/`recipientProfileId`). One file, one array, one new
   regression test. No schema change, no migration.

Everything else is DEFER, NOT A BUG, or ALREADY CLOSED BY N1 — none of
it release-blocking.

## Decision

**READY FOR TARGETED N2 FIX** — one small, well-scoped item (BUG-NOTIF-005's
cleanup filter). No CRITICAL/HIGH findings surfaced in this triage; the
Notification system's release-blocking security work (N1) stands closed.

Per the mandate: stopping here. Not implementing the fix, not proceeding
to the Engagement Final Audit automatically — awaiting your decision on
whether to do the one-line N2 fix now or defer it too.
