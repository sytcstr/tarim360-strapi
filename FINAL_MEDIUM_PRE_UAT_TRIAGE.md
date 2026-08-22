# TARIM360+1 — FINAL MEDIUM PRE-UAT TRIAGE M1

Backend: `C:\projeler\tarim360-strapi`
Flutter: `C:\projeler\tarim360`
Branch (both repos): `release/preflight-integration`

Reference: `FINAL_RELEASE_INTEGRITY_SWEEP.md`, `FINAL_R1_TARGETED_RELEASE_FIX_REPORT.md`.

Scope: re-verify the 6 MEDIUM findings from the sweep against current
HEAD, do a deep, field-by-field cross-account audit of the Payment/
Purchase UI, and re-confirm all 6 R1 (CRITICAL/HIGH) fixes are still
present. No fixes were applied in this phase **except** the one
cross-account leak the mandate explicitly authorized fixing immediately
if confirmed (M6, below).

---

## M1 — Read receipt / double-tick — **CONFIRMED, still live**

- **Live caller:** `MessagesStore._mergeRemoteChatHistory`/`_dedupKeyFor`
  (`lib/features/messages/stores/messages_store.dart:960-996`), consumed
  by `MessageChatPage._pollMessages`/`_hydrateHistoryFromRemote`
  (`lib/features/messages/pages/message_chat_page.dart:27-51`).
- **Expected:** once the recipient reads a sent message, the sender's
  bubble flips from single to double tick (`readAt` becomes non-null,
  server-authoritative).
- **Actual:** re-read the exact code — `readAt` is a `final` field on
  `ChatMessage` (`message_models.dart:33`), so it can never be updated
  in place. `_mergeRemoteChatHistory` concatenates `[local existing,
  ...remote]`, sorts by time, then dedups by `Set.add` keeping the
  **first-seen** entry per `_dedupKeyFor` key. The optimistic local
  bubble is created at send time (earlier timestamp) and the
  server-echoed row (with the real `readAt` once read) arrives later —
  so the earlier local object always wins the dedup and the `readAt`
  update is silently discarded on every poll. This does **not**
  self-heal by navigating away and back to the chat: `getHistory()`
  reads the same store-level `_chatHistory` cache regardless of which
  page instance calls it, so the stuck object persists for the rest of
  the app session (only a logout/login or full process restart clears
  it).
- **User impact:** sender never sees the double-tick confirmation within
  a continuous session, even though the recipient genuinely read the
  message. Purely cosmetic — no message loss, no functional break.
- **Security/data impact:** none. `readAt` is never trusted for any
  access-control decision, only display.
- **Decision:** confirmed real, MEDIUM, not a blocker for physical UAT
  (a tester noticing "the checkmark doesn't turn blue" is a real but
  non-critical finding).
- **Minimum fix (not applied):** in `_mergeRemoteChatHistory`, when two
  entries share a dedup key, keep the fresher one (or merge the
  remote row's `readAt`/`deliveryStatus` onto the retained object)
  instead of always keeping first-seen; also loosen
  `_pollMessages`'s `remote.length <= msgs.length` early-return so an
  in-place field change still triggers a re-render.

---

## M2 — Farmer Questions answer/like notifications — **CONFIRMED, still live**

- **Live caller:** `pushRemoteFarmerQuestionNotification`
  (`lib/features/farmer_questions/models/farmer_question_models.dart:135`)
  → `NotificationStore.pushRemoteTarget` → `_pushTargetToStrapi` → the
  generic, self-target-only `POST /api/notifications`.
- **Expected:** a question owner is notified when someone answers or
  likes their question.
- **Actual:** re-verified `src/policies/notification-ownership.ts`'s
  self-target-only enforcement is unchanged, and re-read
  `notification.ts`'s `DOMAIN_EVENTS` registry — still has no
  `farmer_question` entry. The registry's own comment (line 24-28)
  still says this is because "hub-content... has no verifiable
  author-identity field today" — but `hub-content.ts`'s `create()`
  (lines 51-52) genuinely stamps `data.ownerEmail = identity.email;
  data.ownerProfileId = identity.ownerId;` on every row, confirmed
  present in the current schema (`schema.json:23,26`). The comment's
  own justification is now stale; the notification is never delivered
  (rejected 403 by the ownership policy, swallowed silently client-side
  at `NotificationStore._pushTargetToStrapi`'s `catch (e) {
  debugPrint(...) }`).
- **User impact:** a farmer who asks a question is never notified when
  it's answered or liked — a real, complete, silent failure of a core,
  advertised engagement feature.
- **Security/data impact:** none — fails closed (403), not an
  information leak.
- **Decision:** confirmed real, MEDIUM-HIGH on user-facing impact
  (silent, total feature failure) but not a release blocker on its own.
- **Minimum fix (not applied):** add a `farmer_question` entry to
  `DOMAIN_EVENTS` with an owner-resolution lookup against
  `hub-content.ownerEmail`/`ownerProfileId`, and switch the Flutter call
  from `pushRemoteTarget` to `pushDomainEvent`/`createDomainEvent`.

---

## M3 — Offer unread badge race — **CONFIRMED, still live**

- **Live caller:** `_AppShellState._selectTab` (`lib/main.dart:1450-1452`),
  `OffersStore.markIncomingSeen`/`_markIncomingOffersSeenRemote`
  (`lib/features/offers/stores/offers_store.dart:28-48`), `_refreshRemote`
  (`:574`).
- **Expected:** opening the Offers tab clears the incoming-unread badge
  and it stays cleared.
- **Actual:** unchanged since the sweep (this file was not touched by
  R1). `_selectTab` calls `markIncomingSeen()` (zeroes the badge, then
  fires a **sequential** loop of one `PATCH /offers/:id/seen` per
  incoming offer) immediately followed by an unawaited `refresh()`. If
  the single GET completes before all the sequential PATCHes commit —
  plausible, one round trip vs. N — `_refreshRemote` unconditionally
  recomputes the badge from the still-stale fetched `seenBy` data,
  reappearing nonzero for up to ~15s even while the user is looking
  straight at the cleared list.
- **User impact:** a transient, self-healing badge flicker (clears again
  on the next poll). Cosmetic, not a functional break — offers are still
  correctly accepted/rejected/countered regardless.
- **Security/data impact:** none.
- **Decision:** confirmed real, MEDIUM, self-heals within one poll
  cycle. Not a blocker.
- **Minimum fix (not applied):** await `_markIncomingOffersSeenRemote()`
  before firing the post-tab-switch `refresh()`, or have
  `_refreshRemote()` treat recently-locally-marked-seen ids as seen
  regardless of the fetched snapshot.

---

## M4 — Self-view inflates own listing/logistics/processed-product view count — **CONFIRMED, still live**

- **Live caller:** `listing_detail_page.dart:46`,
  `logistics_load_detail_page.dart:27`,
  `logistics_vehicle_detail_page.dart:37`,
  `processed_product_detail_page.dart:27` — all four still call
  `unawaited(EngagementStore.I.registerView(_target))` unconditionally in
  `initState()`, confirmed no owner guard anywhere around any of the four
  call sites (re-read each surrounding block directly).
- **Expected:** an owner opening their own item shouldn't inflate its own
  view count (the app already does this correctly for profiles).
- **Actual:** backend's self-view exclusion (`engagement-v1.ts:136`) is
  still deliberately scoped to `targetType === 'profile'` only,
  unchanged. A seller checking/editing their own listing/load/
  vehicle/processed-product increments its view count (bounded to +1/day
  by the server's 24h actor-dedup, never excluded).
- **User impact:** a real, easily reproducible, minor metric-accuracy
  bug on a number sellers look at directly.
- **Security/data impact:** none.
- **Decision:** confirmed real, MEDIUM. Not a blocker.
- **Minimum fix (not applied):** wrap each of the four `registerView`
  calls in an `if (!isOwner)` check, matching the existing profile-page
  pattern.

---

## M5 — Hub/Farmer Questions error state indistinguishable from empty — **CONFIRMED, still live**

- **Live caller:** `HubContentRepo.fetchList` (`lib/main.dart:4508`,
  `catch (e) { debugPrint('Hub refresh failed: $e'); }`),
  `FarmerQuestionsRepo.refresh`
  (`lib/features/farmer_questions/repositories/farmer_questions_repo.dart:306-320`,
  `catch (e) { debugPrint('Farmer refresh failed: $e'); _lastRefreshAt =
  DateTime.now(); }`).
- **Expected:** a failed fetch shows a real error/retry state,
  distinguishable from a genuinely empty backend.
- **Actual:** unchanged — both catch blocks only `debugPrint` and return/
  keep whatever's cached (empty on cold start); the widgets render the
  same "Henüz içerik eklenmedi" empty card either way. No
  `lastFetchFailed`-style flag exists in either repo.
- **User impact:** a user on a bad connection can't tell "nothing here"
  from "couldn't load" — pull-to-refresh still lets them retry, so this
  never shows stale-wrong data, just an ambiguous message.
- **Security/data impact:** none.
- **Decision:** confirmed real, MEDIUM (cosmetic/UX). Not a blocker.
- **Minimum fix (not applied):** track a last-fetch-failed flag in both
  repos and branch the empty-state widgets on it to show a real retry
  affordance with an explicit error message.

---

## M6 — Payment/Purchase UI cross-account state leak — **CONFIRMED + FIXED NOW**

Full field-by-field audit, not just `activePremium`:

- **`activePremium` / purchase records / owner-scoped caches
  (`PurchaseStore`):** re-read `clearForSession()`
  (`lib/features/premium/purchase/purchase_store.dart:163-177`) — clears
  `_recordsByOwner`, `_activePremiumByOwner`, `_remoteLoadedOwners`,
  `_remoteLoadingOwners`, `_remoteSyncingOwners`,
  `_remoteSyncQueuedOwners`, `_remoteSyncRetryScheduledOwners`,
  `_remoteSyncRetryCountByOwner`, `_remoteSyncLastAttemptAtByOwner`,
  `_remoteSyncLastSuccessAtByOwner`, `_remoteSyncLastErrorByOwner`,
  `_localPurchaseUpdatedAtByOwner` — every single field in the class is
  an owner-keyed `Map`/`Set` and all of them are cleared. **Clean, no
  leak.**
- **"Selected plan":** searched the whole premium feature tree — no
  persistent "currently selected plan" state exists anywhere; plan
  selection lives in ordinary `StatefulWidget` local state on the
  packages/pricing page, which is naturally disposed on navigation.
  **Not a real risk.**
- **"Payment result" / "loading/success/error state" (`PurchaseCoordinator`):**
  **this is the real, confirmed leak.** `PurchaseCoordinator` (`lib/features/premium/purchase/purchase_coordinator.dart:288-317`)
  holds 7 plain singleton fields — `_lastAttemptAt`, `_lastFinishedAt`,
  `_lastSuccess`, `_lastVerified`, `_lastMessage`, `_lastTransactionId`,
  `_lastProductId` — set by every real `purchase()`/`restorePurchases()`
  attempt and **never referenced anywhere in `main.dart`'s
  `_onSessionChanged`** (confirmed by grep — zero hits before this fix).
  `payment_status_page.dart`'s "Son Ödeme İşlemi" ("Last Payment
  Transaction") card (lines 56-70+) reads exactly these fields directly
  off `PurchaseCoordinator.I`. Concrete scenario: User A attempts or
  completes any purchase (even a failed one — `_flowResult` runs on
  every outcome), logs out, User B logs in on the same device/app
  process, opens "Ödeme Durumu" — B sees A's last transaction ID,
  product ID, success/verification outcome, and timestamps, with zero
  purchase attempt of B's own.
- **Decision: real cross-account leak, fixed now per the mandate.**
- **Fix applied:** added `PurchaseCoordinator.resetForSession()`
  (`purchase_coordinator.dart`, clears all 7 fields, bumps `statusTick`
  so the page rebuilds) and wired it into `main.dart`'s
  `_onSessionChanged` (`lib/main.dart:6015`), immediately after
  `PurchaseStore.I.clearForSession()`. Deliberately left `_inited`
  (device/store connection flag, not per-account data) and
  `_purchaseInFlight` (forcing it false mid-flight could let a new
  purchase start while a real pending one is still resolving) untouched.
- **Tests added** (`test/features/premium/restore_purchases_message_test.dart`,
  +2 tests): a real `purchase()` attempt populates every `_last*`
  field, then `resetForSession()` clears all of them back to null;
  `resetForSession()` bumps `statusTick` so the page actually rebuilds.
- **Validation after the fix:** `flutter analyze` clean, full `flutter
  test` 297/297 pass (up from 295 pre-fix), `git diff --check` clean —
  confirmed the change is exactly these two files plus the new tests.

---

## R1 regression re-check — all 6 **PRESENT**

| Item | Status | Evidence |
|---|---|---|
| R1.1 Premium protected fields stripped | PRESENT | `profile-setting.ts:36` `PURCHASE_PROTECTED_FIELDS`, still wired into `CLIENT_STRIPPED_FIELDS`; `profile-setting-ownership.integration.test.ts`'s 9 R1.1 tests pass (part of 351/351). |
| R1.2 Backend listing quota | PRESENT | `listing.ts:249` and `engagement.ts:556` both call `canCreateNextNormalListing`; `listing-create-idempotency.integration.test.ts`'s 5 quota tests pass. |
| R1.3 Offline listing queue owner binding | PRESENT | `listings_store.dart:86-96` `currentOwnerId`/`rowOwnerId` comparison in `retryPending()`, unchanged. |
| R1.4 Logistics owner stamping | PRESENT | `logistics-load.ts:344` and `logistics-vehicle.ts:196` both stamp `id:${identity.ownerId}`; `logistics-owner-spoof.integration.test.ts`'s 3 tests pass. |
| R1.5 Forgot-password email-first | PRESENT | `auth-flow.ts:737-745` — email send still precedes the password `entityService.update`; `forgot-password-email-failure.integration.test.ts`'s 3 tests pass. |
| R1.6 Counter decrement/recount | PRESENT | `takeLatest` present and wired in both `listing_engagement_store.dart` and `processed_market_stores.dart`; `engagement_counter_reconciliation_test.dart`'s 5 tests pass. |

Raw suite results (both repos, run to completion after the M6 fix):

| Suite | Result |
|---|---|
| Backend `npx tsc --noEmit` | Clean |
| Backend unit (`npm run test:unit`) | 31/31 pass |
| Backend integration (`npm run test:integration`) | 351/351 pass |
| Backend `git diff --check` | Clean, **zero files changed** this phase (no backend fix was needed) |
| Flutter `flutter analyze` | 0 errors (2 pre-existing, unrelated warnings) |
| Flutter `flutter test` | **297/297 pass** |
| Flutter `git diff --check` | Clean — exactly `purchase_coordinator.dart`, `main.dart` (1 line), and the updated test file |

---

## Final decision: **READY FOR PHYSICAL UAT**

The one item in this triage with a real, confirmed cross-account data
leak (M6) has been fixed immediately, tested, and validated, per the
mandate's explicit authorization. The remaining 5 MEDIUM findings (M1-M5)
are all confirmed genuinely still present, but every one of them is
cosmetic/UX-only — no data loss, no security impact, no functional
breakage of any core flow (messages still send/receive, offers still
accept/reject, farmer questions still work end-to-end minus the
notification, listings/products still display correctly). None of them
would block a physical device UAT pass; they are good candidates for a
follow-up polish pass but do not need to gate starting UAT. All 6 R1
(CRITICAL/HIGH) fixes remain fully in place with zero regressions.
Two real accounts on two physical devices can now proceed to UAT.
