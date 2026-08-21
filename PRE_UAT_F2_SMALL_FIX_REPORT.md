# PRE-UAT SMALL F2 FIX — Report

Backend: `C:\projeler\tarim360-strapi`
Flutter: `C:\projeler\tarim360`
Branch (both repos): `release/preflight-integration`

Reference: `PRE_UAT_FUNCTIONAL_UX_AUDIT.md`, `PRE_UAT_F1_TARGETED_FUNCTIONAL_FIX_REPORT.md`,
`PRE_UAT_F2_FOLLOWUP_TRIAGE.md`.

Scope: close the 1 A-item + 5 B-items from the F2 triage — UX-003, UX-005,
UX-012, UX-017, UX-040, UX-041. No other triage item (the remaining 40
C/D/E findings) was touched.

---

## F2.1 — UX-003: messaging polling latency

**Files:** `lib/features/messages/pages/message_chat_page.dart`,
`lib/features/messages/pages/messages_page.dart`

- Open-chat poll interval: flat `Timer.periodic(10s)` with no lifecycle
  awareness → `_activeChatPollInterval = Duration(seconds: 4)`, unchanged
  for the conversation list (`_listPollInterval = Duration(seconds: 20)`
  — deliberately left slower; only the screen the user is actively
  watching needed to feel closer to real time).
- Both `_MessageChatPageState` and `_MessagesPageState` now mix in
  `WidgetsBindingObserver`: polling stops on
  paused/inactive/detached/hidden and restarts (with an immediate
  refresh) on resumed. `dispose()` removes the observer and cancels the
  timer.
- No new de-dup/throttle logic was needed: `MessagesStore` already
  throttles `refreshThreadMessages` (2s) and `refreshThreads` (3s) and
  dedupes in-flight requests per thread/globally, which already covers a
  faster poll interval outrunning round-trip time.

## F2.2 — UX-005: offer unread badge

**Files:** `lib/features/offers/models/offer_models.dart`,
`lib/features/offers/stores/offers_store.dart`

- Root cause: the write path (`markIncomingSeen` →
  `markOfferSeenRemote`) was already correct server-side, but the read
  path (`OffersStore._refreshRemote`) recomputed the badge as
  `incoming.length` on every refresh — ignoring the server's own
  `seenBy` map entirely, so the badge could resurrect itself right after
  being cleared.
- `OfferItem` gained `seenByMe` (default `false`), parsed in
  `_fromStrapiOfferRow` from the server's `seenBy` map (offer.ts's
  `markSeen`, keyed by ownerId/email). `_incomingUnread` is now
  `incoming.where((o) => !o.seenByMe).length`.
- No backend change was needed — `seenBy`/`markSeen` already existed and
  is already covered by `offer-receiver-ownership.integration.test.ts`.

## F2.3 — UX-012: Restore Purchase message

**File:** `lib/features/premium/purchase/purchase_coordinator.dart`

- `restorePurchases()` used to return the billing gateway's own fixed
  string verbatim, regardless of whether anything was actually restored.
- Now uses `_waitForActivePremium` (already-existing, polls
  `PurchaseStore.I.activePremium`) as the real signal, plus a
  `PurchaseStore` refresh, to pick one of three exact Turkish messages:
  "Satın alımlarınız geri yüklendi." / "Geri yüklenecek aktif satın alma
  bulunamadı." / "Satın alma bilgileri geri yüklenemedi. Lütfen tekrar
  deneyin." (on exception, now logged via `logCatch` instead of leaking
  the raw exception into the user-facing string).

## F2.4 — UX-017: "Denetime Gönder" label

**File:** `lib/features/listings/pages/create_listing_page.dart`

- The publish button read "Denetime Gönder" (implying a manual-review
  queue) when the real action publishes the listing immediately. Label
  only: `'Denetime Gönder'` → `'İlanı Yayınla'`. No backend/behavior
  change; confirmed via grep no other file/test referenced the old
  string.

## F2.5 — UX-040: broken Turkish characters in notifications

**Files:** `src/api/notification/controllers/notification.ts` (`DOMAIN_EVENTS`
map + the domain-event action's `senderLabel` fallback),
`src/api/offer/controllers/offer.ts` (create + accept/reject/bargaining
notification title/message), `src/api/message/content-types/message/lifecycles.ts`
(message-notification preview fallback + sender fallback),
`src/api/support-ticket-message/content-types/support-ticket-message/lifecycles.ts`
(support-reply title).

- Root cause: these were hardcoded ASCII-only source strings (e.g.
  "Ilanin Favorilendi", "Karsi Teklif", "Bir kullanici", "Destek
  Yaniti") — not an encoding/mojibake issue, so no charset/encoding
  config was touched. Every literal was rewritten with the correct
  Turkish diacritics (ğ, ş, ı, İ, ç, ö, ü); no logic, schema, or route
  contract changed.
- Scope check: only the `listing` domain's DOMAIN_EVENTS entries were
  re-verified end-to-end via a live integration test; `logistics_load`/
  `processed_product`/`profile` share the identical object and code path
  so a structural regression there is already caught by the same test.

## F2.6 — UX-041: Offers/Messages tab unread clearing

**File:** `lib/main.dart` (`_AppShellState._selectTab`)

- The Support tab already called
  `NotificationStore.I.markReadForKinds({NotificationKind.support})` on
  entry; the Offers (tab 1) and Messages (tab 3) branches never did the
  equivalent for their own kinds, so a bell-feed entry for an offer/
  message could still show unread there even after being handled in its
  own tab.
- Added `NotificationStore.I.markReadForKinds({NotificationKind.offer})`
  to the tab-1 branch and `{NotificationKind.message}` to the tab-3
  branch, mirroring the Support tab's exact, already-proven pattern.
  `markReadForKinds` only touches the requested kind(s), so this cannot
  clear the other tab's unread state.

---

## New tests added

- `test/features/messages/messaging_polling_lifecycle_test.dart` (Flutter,
  widget-level): drives `MessageChatPage`/`MessagesPage` through the real,
  valid `AppLifecycleState` chain (resumed→inactive→hidden→paused→…→resumed)
  multiple times, then unmounts. `flutter_test` fails a test if any `Timer`
  is still pending at teardown, so a leaked or duplicated poll timer would
  fail this suite, not just look wrong on a device.
- `test/features/offers/offer_seen_badge_test.dart` (Flutter): locks in
  `OfferItem.seenByMe`'s default and the `count(!seenByMe)` badge formula.
- `test/features/premium/restore_purchases_message_test.dart` (Flutter):
  exercises `PurchaseCoordinator.I.restorePurchases()` end-to-end against
  `MockBillingGateway` (the gateway this build actually uses under
  `flutter test`) for both the found-active and nothing-to-restore
  outcomes, asserting the returned string is never the gateway's own raw
  message.
- `test/features/notifications/notification_store_mark_read_test.dart`
  (Flutter): `markReadForKinds` clears only the requested kind, never an
  unrelated one.
- `tests/integration/notification-turkish-copy.integration.test.ts`
  (backend, real Strapi boot): asserts the actual persisted
  title/message content — not just the source file — for listing
  favorite/like domain-events, offer created/bargaining, and a real chat
  message notification, all with correct Turkish diacritics.

F2.4 has no dedicated automated test: it is a single UI string literal
inside `create_listing_page.dart`'s large `build()` method with no
isolated pure function to target, verified instead via `flutter analyze`
and a grep confirming no other caller/test referenced the old string.

---

## Regression re-check

Re-ran in full (not spot-checked):

- **Backend unit** (`npm run test:unit`): 31/31 pass.
- **Backend integration** (`npm run test:integration`, includes this
  session's new file): **332/332 pass**, covering — among the full
  suite — Messaging M1-M4 read/unread/retry, offer receiver ownership +
  `markSeen`, the N1 notification-security suite (self-target-only
  create, domain-event owner resolution/spoofed-target rejection,
  message-receiver server-derivation, FCM token cross-account eviction),
  F1's listingId-on-notification regression, listing create idempotency,
  premium gates, and profile-setting/session-isolation privacy checks.
- **Backend build** (`npm run build`): succeeds (TS compile + admin
  panel build), no errors.
- **Backend `git diff --check`**: clean (only CRLF/LF line-ending
  warnings, no real whitespace errors).
- **Flutter `flutter analyze`**: clean — only the 2 pre-existing,
  unrelated `unused_element` warnings in `logistics_models.dart`
  (`_normalizeLogisticsWhatsApp`/`_titleCaseWords`), present before this
  session.
- **Flutter `flutter test`**: **290/290 pass** (full suite, including
  all 4 new files above).
- **Flutter `git diff --check`**: clean (only a CRLF/LF warning on
  `lib/main.dart`, no real whitespace errors).

## Push

Both repos are already on `release/preflight-integration`. Changes are
ready to commit and push to that branch only — no merge to `main`, no
deploy, no production mutation.

## Final decision: **READY FOR UAT**

All 6 targeted F2 items are closed, all new and pre-existing automated
tests pass in both repos, both builds are clean, and no other UAT/audit
scope was touched. Per the mandate, stop here — do not proceed to UAT
automatically, and do not touch the remaining 40 deferred/manual-only
findings in `PRE_UAT_F2_FOLLOWUP_TRIAGE.md`.
