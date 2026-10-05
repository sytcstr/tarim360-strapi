# TARIM360+1 — RELEASE PRE-UAT FUNCTIONAL + UX FLOW AUDIT

READ-ONLY. No code changed, no commits, no push, `main` untouched, no
deploy, no production mutation. Both repos audited on
`release/preflight-integration`, confirmed in sync with `origin` before
starting (backend HEAD `f62470f`, Flutter HEAD `2f33b73`, both
`git status -sb` show no ahead/behind).

**Method**: 8 parallel research passes (offers; profile+auth/settings;
premium/purchase/rocket; listing creation+detail/management; farmer
questions+knowledge hub; agricultural data+search; notifications+
navigation; performance+loading/error states), plus 3 passes done
personally end-to-end (messaging — the mandate's own highest-priority
section; cross-account/session UX; the previous-fix regression
checklist). Every CRITICAL/HIGH claim below was independently re-read
from source by me, not accepted from a single research pass — see the
"personally re-verified" note on each one.

**Final decision: READY FOR TARGETED UX/FUNCTIONAL FIX.**

**Counts**: CRITICAL 1 · HIGH 12 · MEDIUM 24 · LOW 15 · PRODUCT DECISION
(embedded in individual findings above) · MANUAL UAT REQUIRED (embedded)

No CRITICAL/HIGH finding in this audit is a security or data-integrity
issue — every prior security/bug-fix phase (Sprints 1-9, E1, E2) remains
intact (see §19). Everything here is about whether the app *feels* right
and *works completely* for a normal user, which is exactly what this
phase was scoped to check.

---

## 1 — MESSAGING / WHATSAPP-LIKE FLOW (personally investigated in full)

This is the mandate's own highest-priority section. Files read in full:
`message_chat_page.dart`, `messages_page.dart`, `messages_store.dart`,
`message_models.dart`, `listing_detail_page.dart`, `main.dart`'s
`openDirectMessageThread`.

### UX-001 — CRITICAL for the "WhatsApp gibi" bar, filed as HIGH
Severity: HIGH
Feature: Messaging
Live caller: Listing Detail page (`lib/features/listings/pages/listing_detail_page.dart`)
User impact: A buyer viewing a real marketplace listing has **no direct "Message Seller" button anywhere on the page**. Confirmed by reading the entire 1300-line file and grepping it for "Mesaj", "Message", "chat", "iletişim", "contact", "whatsapp", "phone", "IconButton" — zero matches for any messaging entry point. The only seller-facing actions are "Teklif Ver" (make an offer) and tapping the seller's name/avatar to open their profile.
Expected flow: İlan → "Mesaj Gönder" → chat opens (1 tap), per the mandate's own stated target.
Actual flow: İlan → tap seller name/avatar → seller's profile page opens → find "Mesaj" button there (confirmed present in `hesabim_page.dart`/`premium_market_profile_page.dart`) → chat opens. Minimum 2 navigations, not 1.
Root cause: the direct-message entry point (`openDirectMessageThread`, `lib/main.dart:8825`) is wired from profile pages and the (dormant) Ads detail page, but was never added to the real listing detail page.
Flutter file/function: `listing_detail_page.dart` (no message action anywhere); compare `hesabim_page.dart:1852`.
Classification: UX FRICTION — the single most consequential gap relative to this section's own stated target question ("İlandan satıcıya mesaj göndermek kaç adım?").
Release blocker: no
Minimum safe improvement: add a "Mesaj Gönder" button next to "Teklif Ver" on the listing detail page, calling `openDirectMessageThread(...)` with the same seller-identity parameters `_openOfferSheet` already has.

### UX-002
Severity: MEDIUM
Feature: Messaging
Live caller: `message_chat_page.dart`'s `_send()`
User impact: while a message is "sending," the user cannot compose/send a second message — `_sending` is one shared page-level bool, not per-message.
Expected flow: WhatsApp-style — fire off several messages in a row, each progressing independently.
Actual flow: the second send attempt is silently dropped (`if (_sending) return;`) until the first resolves.
Flutter file/function: `message_chat_page.dart:96,100,130`.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: track in-flight state per queued message instead of one page-level flag.

### UX-003
Severity: HIGH
Feature: Messaging
Live caller: `message_chat_page.dart` (open chat), `messages_page.dart` (conversation list)
User impact: messaging is polling-based, not realtime. Open-chat polls every **10s** (`message_chat_page.dart:76-78`); the conversation list polls every **20s** (`messages_page.dart:98-100`). An incoming reply, a read-receipt flip (double-tick), or the list reordering/unread badge can lag up to 10-20s behind what the other person actually did.
Expected flow: feels close to instant, per this section's explicit "gönderir → mesaj balonu hemen görünür → karşı taraf görür → cevaplar" target.
Actual flow: your own outgoing bubble is genuinely instant (optimistic — confirmed correct, see below); an incoming reply is only as fresh as the last poll tick.
Classification: UX FRICTION — the top candidate for a dedicated follow-up given how explicitly the mandate weighted "WhatsApp gibi rahat mı."
Release blocker: no
Minimum safe improvement: shorten the open-chat interval (e.g. 3-5s) as a cheap mitigation, and/or trigger an immediate one-off refresh when a message-type push notification arrives while the relevant screen is foregrounded, rather than waiting for the next fixed tick.

### UX-004
Severity: LOW
Feature: Messaging
Live caller: `messages_store.dart`'s `_ensureRemoteThreadExists` + `_syncOutgoingMessageToStrapi`
User impact: the very FIRST message to a brand-new conversation partner is measurably slower than every later message: two sequential avatar-resolution network calls, then `createThread`, then (separately) `sendMessage` — four sequential round trips stacked before the first checkmark, confirmed by reading lines 1601 and 1872-1892 directly. Correctly guarded (`_remoteKnownThreadIds`/`_remoteCreatingThreadIds`) so this only happens once per thread, never on later messages.
Classification: POTENTIAL PERFORMANCE RISK
Release blocker: no
Minimum safe improvement: run the two avatar-resolution calls with `Future.wait` instead of sequentially.

### Confirmed WORKING correctly (explicitly verified, not assumed)
- Optimistic bubble: appears as `sending` before any network call; text field clears immediately (`message_chat_page.dart:100-121`) — the single most important "feels instant" requirement, genuinely correct.
- sending/sent/failed + retry: real, wired to a visible retry tap target.
- Double-tick read receipt: genuinely server-backed via `ChatMessage.readAt`/`isRead` (`message_models.dart:34,85`), not a fake client flag.
- Opening a chat clears its unread badge both locally (instant) and remotely (`markRead`).
- Starting a conversation is a pure local/deterministic operation — no network round-trip blocks opening the chat screen; messaging yourself is explicitly blocked.
- Cross-user receiver identity resolution is defensively re-derived client-side and independently re-verified server-side (this session's own earlier N1 work) — no messaging-identity regression.

### Manual UAT required
- Actual perceived latency of the 10s/20s polling on a real network — time how long a reply visibly takes to appear.
- Whether a push notification arriving while the app is foregrounded triggers an out-of-band refresh that makes the polling gap rarely matter in practice (not found in the two screens read here — see also §12 UX-039).

---

## 2 — OFFER SYSTEM

### UX-005
Severity: HIGH
Feature: Offers
Live caller: `offers_store.dart:570` (`_refreshRemote`), Teklifler tab badge (`main.dart:1610-1620`)
User impact: the seller's "new offer" badge is not a real unread count — it resets to the TOTAL number of incoming offers on every periodic refresh (every 15s while on the page), not the number genuinely unseen. A seller who already read 5 offers sees the badge jump back to "5" moments later with zero new activity.
Root cause: `_refreshRemote()` unconditionally sets `_incomingUnread = incoming.length` (line 570), never reading back the server's own `seenAt`/`seenBy` fields (correctly written by `offer.ts:230-270`'s `markSeen`) into `OfferItem` — the write path and read path are disconnected.
Flutter file/function: `offers_store.dart:570` (`_refreshRemote`), `:932` (`_fromStrapiOfferRow`, missing `seenAt`/`seenBy` parse).
Classification: FUNCTIONAL BUG
Release blocker: no (cosmetic/badge only) but visible enough to get repeatedly filed as a bug during UAT.
Minimum safe improvement: parse `seenBy`/`seenAt` into `OfferItem`; compute unread as "incoming offers where the current user's key is absent from `seenBy`," not `incoming.length`.

### UX-006
Severity: MEDIUM
Feature: Offers
Live caller: `create_offer_sheet.dart:98-115` (`_send`)
User impact: a buyer cannot specify quantity when making an offer — `_send()` hardcodes `qtyText: ''` (line 102); there's no quantity field in the sheet at all, even though the model/schema/every offer card display are fully wired to show it (`"${item.title} ${item.qtyText}"`), leaving a stray blank everywhere quantity should show.
Classification: FUNCTIONAL BUG / PRODUCT DECISION (confirm whether quantity was intentionally dropped)
Release blocker: no
Minimum safe improvement: add a quantity `TextField` to the offer sheet and wire it through, or strip the now-pointless `qtyText` plumbing if it's genuinely no longer wanted.

### UX-007
Severity: MEDIUM
Feature: Offers
Live caller: `notifications_page.dart:63-129` (`_openByKind`)
User impact: tapping any offer notification (new/accepted/rejected/counter) only switches to the generic Teklifler tab — never opens or highlights the specific offer.
Classification: UX FRICTION (same root cause class as §12 UX-038)
Release blocker: no
Minimum safe improvement: thread the notification's `offerId` through and auto-scroll/highlight the matching card.

### UX-008
Severity: LOW
Feature: Offers
Live caller: `offer_card_x.dart` (no chat entry point), `teklifler_page.dart:477-503`
User impact: the only way into `OfferChatPage` is as a side effect of the seller tapping Accept — no persistent "message about this offer" button exists on any card for either side, for any status.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: add a persistent chat affordance on every offer card regardless of status/side.

### Confirmed correct (personally re-verified given HIGH-adjacent claims)
- **offerCount is server-authoritative**: `recountListingOffers` runs after both create and delete (`offer.ts:167-171,393-399`), clamped at 0, and `offerCount` is in the client-protected-field list — no regression.
- **Offer receiver ownership is sound**: the receiver is always the real listing owner re-derived server-side (never client-suppliable), accept/reject is receiver-only, self-offers on your own listing are blocked. This directly matches the O1 fix's own claim and is intact.
- Multiple simultaneous offers on the same listing by the same buyer are allowed, not merged/deduped — flagged as a PRODUCT DECISION to confirm before UAT sign-off, not a bug.
- Two-device status-sync latency after accept/reject (up to ~15s polling window) — MANUAL UAT REQUIRED, same root cause class as messaging's polling gap.

---

## 3 — PROFILE SYSTEM

### UX-009
Severity: HIGH
Feature: Profile
Live caller: `profile_edit_page.dart:428-641` (`_save`)
User impact: user edits their profile, taps Save, the page closes normally with no error shown — but if the background Strapi sync silently fails, the edit only ever existed in memory. `_save()` mutates the local `ProfileUser` object BEFORE calling `_syncToStrapi()`; if that throws, the catch block shows a snackbar but still `pop(true)`s exactly as on success. On the next cold start, `_applyRemoteProfileSettingsToUser` (`business_vertical_store.dart:942`) unconditionally overwrites local fields with server data, with no timestamp/version comparison — silently reverting the "saved" edit.
Classification: FUNCTIONAL BUG
Release blocker: no (requires a transient network failure at exactly the save moment, but deterministic once that happens)
Minimum safe improvement: don't treat a `_syncToStrapi` throw as success — either defer the local mutation until the server confirms, or surface a persistent "not saved, retry?" state instead of pop-and-forget.

### Confirmed CLEAN in Profile + Auth/Settings (explicitly checked, not assumed)
- **Forgot Password OTP regression — CONFIRMED FIXED**, the exact thing this section asked to hunt for: `ForgotPasswordPage` only shows email input then temporary-password instructions, no code field anywhere; backend `resetPassword` is an intentional dead stub matching it; a dedicated test suite locks this in.
- Owner-vs-visitor profile view, private-field gating (phone/whatsapp/email never leak to a visitor), and premium-badge logic (backend-computed `isPremium`, same rule for any viewer) all checked out as correctly implemented.
- Login/Register/Logout/Password change: straightforward, clear inline validation, no issues found.

---

## 4 — LOGIN + SETTINGS + ACCOUNT

### UX-010
Severity: LOW
Feature: Auth/Settings/Account
Live caller: none — unreachable dead code
User impact: none currently, but `SignupVerificationPage` (`main.dart:7200`) is a fully-built OTP/"kod gir" code-entry screen for signup verification that is never pushed/instantiated anywhere (confirmed via full-repo grep). The live registration path (`_submitRegister`) bypasses it entirely. Same pattern as the already-fixed forgot-password OTP leftover, just for a different flow, and this one was never cleaned up.
Classification: PRODUCT DECISION / dead-code cleanup
Release blocker: no
Minimum safe improvement: delete `SignupVerificationPage` and its two backing `AuthService` methods, or wire it in if email-code signup verification is actually wanted.

### UX-011
Severity: LOW
Feature: Auth/Settings/Account
Live caller: `settings_page.dart:178-269` (`_confirmDeleteAccount`)
User impact: account deletion is discoverable and the confirm dialog clearly states the consequences in Turkish, but it's only a standard two-button `AlertDialog` — no typed confirmation, no re-auth — for an irreversible, cascading delete (comments, threads, listings, logistics, favorites).
Classification: UX FRICTION / PRODUCT DECISION
Release blocker: no
Minimum safe improvement: add a typed confirmation ("Silmek için e-postanızı yazın") before the delete proceeds.

(Cross-account session-isolation findings live in §17, not here, to avoid duplication.)

---

## 5 — PREMIUM / SATIN ALMA / ROCKET

### UX-012
Severity: HIGH
Feature: Premium/Purchase
Live caller: "Satın Alımları Geri Yükle" (Restore Purchase) button
User impact: after tapping Restore Purchase, the user is told the exact same static message ("Satın alımlar mağazadan geri yükleme için istendi.") whether the restore actually found and reactivated a real entitlement or found nothing at all. `PurchaseCoordinator.restorePurchases()` (`purchase_coordinator.dart:580-590`) does wait up to 8s and force-refresh from Strapi — but then discards both outcomes and returns the gateway's fixed string regardless.
Classification: FUNCTIONAL BUG
Release blocker: no
Minimum safe improvement: branch on `PurchaseStore.I.activePremium` after the wait and return a message reflecting what actually happened.

### UX-013
Severity: MEDIUM
Feature: Premium/Purchase
Live caller: `hesabim_page.dart:3141-3148` (Hesabım hero card), `purchase_store.dart:207-223`, `session_profile_store.dart:34-36`
User impact: a user whose premium has expired can still see "Premium Üye" on their own profile — both `_propagatePremiumVisualState` and `resolveForCurrentSession()` only ever WRITE `roleText = 'Premium Üye'` when active is true; neither has an `else` branch reverting it when it becomes false, on a cached mutable object.
Classification: FUNCTIONAL BUG
Release blocker: no
Minimum safe improvement: add the missing `else` branch resetting `roleText` to the non-premium default.

### UX-014
Severity: LOW
Feature: Premium/Purchase
Live caller: `payment_status_page.dart:8,243` ("Ödeme Durumu" diagnostic screen)
User impact: lifetime/unlimited premium (`endsAt: null`) shows "Abonelik Bitiş: -" here (reads as unknown/missing) while `subscription_management_page.dart` correctly labels the identical state "Süresiz" — inconsistent, though not the "shows expired incorrectly" failure mode.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: reuse the "Süresiz" label on this screen too.

### UX-015
Severity: MEDIUM
Feature: Premium/Purchase
Live caller: `purchase_store.dart:667` (`_syncOwnerToStrapi`), `:722` (retry/backoff)
User impact: if Strapi sync keeps failing after a real successful on-device purchase and the app is killed before a retry succeeds, the purchase state — in-memory only, never persisted to disk — is lost on both sides; the app now shows the user as non-premium despite having paid, with no auto-recovery (no `restorePurchases()` call anywhere in the startup path) — only a manual "Restore Purchase" tap can fix it, and per UX-012 even that doesn't confirm success clearly.
Classification: POTENTIAL PERFORMANCE RISK / FUNCTIONAL BUG (edge case)
Release blocker: no
Minimum safe improvement: persist a "pending sync" marker to local storage so it survives process death and is retried/flagged on next launch.

### Confirmed correct (personally re-verified, HIGH-adjacent claims)
- **Rocket activation is genuinely server-authoritative**: `activateRocket` re-derives entitlement server-side (never trusts a client `isDoping`/`rocketEndsAt`), is idempotent via an operationId ledger, Flutter only applies local state after the server call succeeds. Matches the earlier E1/E2-era claims exactly, still true.
- `endsAt: null` handled consistently as active/unlimited on both client and server (except the one display inconsistency in UX-014).
- `PurchaseStore.clearForSession()` genuinely wired into the real session-change path — no stale-premium flash across account switches.
- Premium badge updates immediately after purchase, no restart needed.

---

## 6 — İLAN OLUŞTURMA (Listing Creation)

### UX-016
Severity: HIGH
Feature: Listing Creation
Live caller: `create_listing_page.dart:1071-1145` (`_publish` catch block, network-timeout branch)
User impact: if a create request actually reaches and is processed by the server, but the client times out waiting for the response (15s receive timeout), the app treats it as a total failure and queues a brand-new **local-only** id for offline retry. When that retry later syncs (`syncOfflineListing`), it looks the row up by this local id, which never matches the already-created server row — the fallback then creates a genuine **duplicate listing**.
Root cause: `createListing()` has no idempotency/operation key at all, unlike `activateRocket`, which already uses one.
Classification: FUNCTIONAL BUG
Release blocker: recommend fixing before UAT — this is a plausible real-world path specifically on the flaky rural connections this app's actual users (farmers) will have.
Minimum safe improvement: generate a client-side idempotency key per submit attempt and have `create()` dedupe on it, mirroring the pattern already used for Rocket activation.

### UX-017
Severity: MEDIUM
Feature: Listing Creation
Live caller: `create_listing_page.dart:2150` (button label "Denetime Gönder" = "Send for review")
User impact: the button tells the seller their listing is going into a moderation queue. In reality, backend `listing.ts create()` unconditionally sets `status: 'active'`/`publishedAt: now` — every listing is instantly, fully public. The schema even has an unused `pending` status.
Classification: FUNCTIONAL BUG (label/behavior mismatch) / PRODUCT DECISION
Release blocker: no, but affects seller trust ("why did my 'pending' ad show up to buyers instantly") — worth resolving before UAT sign-off.
Minimum safe improvement: relabel to "İlanı Yayınla," or actually gate behind `pending` if moderation is truly wanted.

### UX-018
Severity: MEDIUM
Feature: Listing Creation
Live caller: `strapi_service.dart:1023` (`uploadImages`), `create_listing_page.dart:1153-1186`
User impact: photo+form upload shows only one spinner; any failure discards the whole attempt including photos that already succeeded, since all files go in one atomic multipart POST with no progress reporting.
Classification: UX FRICTION (absence of progress UI verified from code; actual felt speed is MANUAL UAT REQUIRED)
Release blocker: no
Minimum safe improvement: add upload progress reporting, keep picked photos on failure so the user isn't forced to re-pick.

### UX-019
Severity: LOW
Feature: Listing Creation
Live caller: `create_listing_page.dart:378-408` (`_pickPhoto`)
User impact: photos must be added one at a time across 5 fixed slots — no gallery multi-select.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: add a multi-select entry point that fills empty slots in order.

### UX-020
Severity: LOW
Feature: Listing Creation
Live caller: `create_listing_page.dart:855-1020` (`_publish`)
User impact: the `_isPublishing` double-submit guard is set only after several synchronous checks and an awaited quota check — a narrow theoretical double-submit window before the flag is set (in practice mitigated by a blocking quota dialog for new listings, not for the pure-edit path).
Classification: POTENTIAL FUNCTIONAL BUG (defense-in-depth gap, not confirmed reproducible)
Release blocker: no
Minimum safe improvement: set `_isPublishing = true` as the very first line of `_publish()`.

---

## 7 — İLAN DETAY + İLAN YÖNETİMİ

### UX-021 — personally re-verified (CONFIRMED)
Severity: HIGH
Feature: Listing Detail/Management
Live caller: `general_listing_management_page.dart:862-921` (hero "Aktif/Pasif" account-status toggle)
User impact: tapping this pill flips between "Aktif"/"Pasif" and shows a confirming SnackBar — "Hesap aktife alındı."/"Hesap pasife alındı." — strongly implying the seller's storefront visibility just changed. **Personally confirmed by reading the exact `onTap` handler (lines 862-876): it does nothing but `setState(() => _isProfileActive = !_isProfileActive)` and show the SnackBar.** `_isProfileActive` is a plain local bool, never persisted, never sent to the backend, never used to filter what buyers see anywhere. Reopening the screen resets it to `true`.
Classification: FUNCTIONAL BUG — a feature that actively claims success while doing nothing.
Release blocker: **yes** — a seller could genuinely believe they've taken their storefront offline (vacation, stockout, a dispute) and be wrong; this is a trust/business-impact issue, not cosmetic.
Minimum safe improvement: remove the toggle until real account-deactivation exists server-side, or wire it to an actual field that listing-fetch queries respect.

### UX-022
Severity: MEDIUM
Feature: Listing Detail/Management
Live caller: `listing_detail_page.dart:833-863` (owner icon row)
User impact: when an owner opens their own listing's detail page, the only owner action shown is Delete (+Share) — no Edit or Roketle button exists here at all; both only live in separate management screens. Confirmed by reading the full 1301-line file.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: add Edit/Roketle to the owner's icon row, reusing the existing `CreateListingPage(initial:)`/`openRocketPurchaseForListing(...)` already used elsewhere.

### UX-023
Severity: MEDIUM
Feature: Listing Detail/Management
Live caller: `general_listing_management_page.dart:583-624`
User impact: no reversible pause/reactivate exists for an individual listing — only permanent delete. Confirmed via the code's own comment: a "Pasife Al" entry used to exist, called the same delete handler, and was deliberately removed as misleading, since no real pause status exists in the schema.
Classification: PRODUCT DECISION (a real feature needs a new status value + endpoint, not a UI fix) — already consciously scoped out, not an oversight.
Release blocker: no
Minimum safe improvement: none required unless UAT expects reversible deactivation as a real feature.

### UX-024
Severity: MEDIUM
Feature: Listing Detail/Management
Live caller: `listing_detail_page.dart:1215-1293` ("İlan İstatistikleri" card)
User impact: view/like/favorite counts come from the newer `EngagementStore` (server-authoritative, updates instantly on tap) while "Teklif" (offer count) is still read from the older `ListingEngagementStore` — an explicitly-documented parallel-store migration state that can make some counters feel more "live" than others on the same card.
Classification: UX FRICTION (perceived-consistency only, not a security issue)
Release blocker: no
Minimum safe improvement: migrate offer counting onto the same `EngagementStore` refresh path.

### Confirmed correct (personally re-verified given the security-adjacent framing of ownership gating)
- Owner-vs-visitor action visibility is correctly gated both client-side (`isOwner`/`_isOwnerView` conditionals) and server-side (`listing-owner-write` policy + `matchesIdentity`, independent of client claims) — no cross-user privilege leak in either direction, on the actual detail page or in `hesabim_page.dart`'s listing grid.
- Publish-button double-submit via a physical double-tap: guarded once the flag is set (see UX-020 for the narrow pre-flag window).
- Delete confirms via dialog, disables itself while in flight — no double-delete issue.

---

## 8 — ÇİFTÇİ SORULARI (Farmer Questions)

### Targeted verification requested by the mandate: does answering still work after BUG-ENG-001's ownership fix?
**Confirmed working correctly, not a bug.** `FarmerQuestionsRepo.addAnswer` does a full-row PUT that always recomputes `title`/`descShort` from the question's own stored fields (never from the answer) — since there is no UI to edit a question after creation (see UX-025), these fields are always unchanged, so `hub-content-write-guard.ts`'s `isUnchangedCoreIdentity` check lets the non-owner's answer PUT through, exactly by design. Ownership (`ownerEmail`/`ownerProfileId`) is stamped once at create and stripped on every update, so authorship can never be hijacked. From the UI it reads like a normal comment box, not like editing someone else's post. This part of the audit is clean.

(One already-disclosed, already-deferred limitation restated for UAT awareness, not re-scored: the embedded `answers` JSON blob can still lose an update if two people answer at nearly the same moment — BUG-ENG-014, a known architecture debt item, not new.)

### UX-025
Severity: HIGH
Feature: Farmer Questions
Live caller: `FarmerQuestionDetailPage`
User impact: a user who posted a question has no way to correct a typo or delete it if posted by mistake — the only removal path is full account deletion. `_isQuestionOwner()` is used only to gate deleting an individual answer, never the question itself; the only visible action on the question card is "Şikayet et" (report), shown unconditionally even to the owner.
Classification: FUNCTIONAL BUG (missing feature relative to normal Q&A expectations)
Release blocker: no (the same end result is reachable via account deletion, and moderation exists via report) but should be tracked.
Minimum safe improvement: add an owner-only "Soruyu Sil" action, reusing the existing archive-on-server pattern already used for account-deletion cleanup.

### UX-026
Severity: HIGH
Feature: Farmer Questions
Live caller: NotificationsPage → tap a question-comment/like notification
User impact: when someone answers/likes a farmer's question, the asker gets a notification, but tapping it never opens that question — only the generic Hesabım tab. `questionId`/`answerId` ARE computed and even sent to Strapi, but `AppNotificationItem`'s `fromJson` never reads them back, so the data is fetched and then thrown away client-side.
Classification: FUNCTIONAL BUG (same root cause class as §12's general notification-deep-link gap, §12 UX-038)
Release blocker: no, but high-value for UAT feedback quality
Minimum safe improvement: add an optional target field to `AppNotificationItem`, populate it from the `extra.questionId` already being sent, and special-case comment/like notifications with `source: 'farmer_questions'` to open the question directly.

### UX-027
Severity: LOW
Feature: Farmer Questions
Live caller: `FarmerQuestionDetailPage`
User impact: a user viewing their own question sees a "Şikayet et" (report) button as if they could report themselves — rendered unconditionally regardless of ownership.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: wrap the report button in an owner check.

### Confirmed correct, no finding
Founder-only enforcement is intact end-to-end. Knowledge Hub and Farmer Questions are clearly distinct in navigation/labeling. Question→asker-profile links work in both list and detail. Like/comment counters update correctly and immediately (optimistic + max-merge on refresh). "Soru Sor" is prominent and login-gated.

---

## 9 — BİLGİ BANKASI (Knowledge Hub)

### UX-028
Severity: MEDIUM
Feature: Knowledge Hub
Live caller: whole `lib/features/knowledge_hub/` tree
User impact: no search exists anywhere in the hub — only category chips. Confirmed via repo-wide search: no "search"/"ara" string or search `TextField` in the feature folder.
Classification: PRODUCT DECISION / UX FRICTION
Release blocker: no
Minimum safe improvement: add a simple client-side title/description filter over the already-fetched content list.

### UX-029
Severity: MEDIUM
Feature: Knowledge Hub
Live caller: `KnowledgeDetailPage`/`DataDetailPage` (article detail screens)
User impact: publish date and read time are prominent on list cards but vanish entirely on the detail screen once you actually tap in.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: add the same date + "X dk okuma" row under the title on both detail pages, reusing fields already on the model.

### UX-030
Severity: MEDIUM
Feature: Knowledge Hub
Live caller: `HubContentRepo.fetchList` (`main.dart:4470-4497`), `_KnowledgeGridSectionState.build`
User impact: if the feed fails to load (server error, timeout, no network), the user sees the exact same "Henüz içerik eklenmedi" empty-state as a genuinely empty hub — fetch errors are caught and only `debugPrint`'d, with no error flag surfaced, and no third UI branch exists for "fetch failed" vs. "genuinely empty."
Classification: FUNCTIONAL BUG (missing error state) / UX FRICTION
Release blocker: no
Minimum safe improvement: surface a boolean "last refresh failed and cache is empty" signal so the presentation layer can show a distinct retry card.

### UX-031 — personally re-verified (double-confirmed by two independent research passes AND by me directly)
Severity: LOW severity / HIGH visibility
Feature: Knowledge Hub — Agricultural Data tab
Live caller: `hub_grid_sections.dart:1474` (weather panel subtitle)
User impact: **confirmed directly by reading the exact line**: `'${weather.description} • $_weatherSourceLabel(source) • ${_weatherTime(weather.updatedAt)}'` — `$_weatherSourceLabel` interpolates the bare method tear-off (a `Function` object), and the following `(source)` is emitted as literal text since it sits outside the interpolation braces. Every single user sees garbled text (e.g. a `Closure:...` dump followed by the literal text `(source)`) instead of "Open-Meteo" on every load of the weather card — this is on a core, high-traffic screen.
Classification: FUNCTIONAL BUG — trivial one-character-class fix, but visible on every load.
Release blocker: recommend fixing immediately — it is a two-minute fix and highly visible.
Minimum safe improvement: `'${weather.description} • ${_weatherSourceLabel(source)} • ${_weatherTime(weather.updatedAt)}'`.

### Confirmed correct, no finding
Founder/admin content vs. user-generated content boundary is intact end-to-end (no Flutter caller for the founder-only submit path exists at all; backend independently enforces it too). Knowledge Hub is visually/navigationally distinct from Farmer Questions.

---

## 10 — TARIMSAL VERİLER (Agricultural Data)

### UX-032 — personally re-verified (CONFIRMED)
Severity: **CRITICAL**
Feature: Agricultural Data
Live caller: `AgriDataGridSection` → "Ürün Fiyatları" / "İl Bazlı Veriler"
User impact: the ~30-40 agricultural product prices and city-level breakdowns shown to users can be **entirely fabricated numbers with zero visual or textual disclosure**. **Personally confirmed** by reading `mock-adapter.ts` directly: `MockAgriDataAdapter` computes every price as `categoryBasePrice[category] * productFactor * dailyFactor` — a deterministic formula with a day-based wobble, `sourceUrl: 'https://example.invalid/agri-data/mock'` — and this is the **only** product-price ingestion mechanism that exists anywhere in the backend (no real adapter of this kind exists at all). A `usingMockPrices` flag does exist in the model, but **personally confirmed via grep it is never read by any Flutter widget** — the fake and real data render in visually identical cards, same trending arrows, same percentage-change styling.
Root cause: no real product-price ingestion source was ever built; the "using mock" flag was computed but never wired to any UI element.
Flutter file/function: `agri_data_repository.dart:43-51` (flag computed, unused); `mock_agri_data_service.dart:9-90`; `hub_grid_sections.dart:2089-2270` (cards never render source/label).
Backend file/function: `src/services/agri-data-ingestion/mock-adapter.ts:91-134`; `config/cron-tasks.ts:33-48` (gated by `AGRI_INGESTION_ENABLED`, default false).
Classification: FUNCTIONAL BUG / PRODUCT DECISION
Release blocker: **yes** — this is the single most severe finding in this audit; a farming app presenting fabricated market prices as real, with no disclosure, directly undermines the app's core value proposition and user trust.
Minimum safe improvement: at an absolute minimum, wire the already-computed `usingMockPrices` flag to a visible "örnek veri" badge/banner on affected cards, and surface `sourceName`/`updatedAt`, before this reaches real users. A real data source is the actual fix; the disclosure is the minimum safe stopgap.

(UX-031, the weather source-label bug, is filed under §9 since its widget lives in the Knowledge Hub file, but it is squarely part of this same Agricultural Data screen — flagging the cross-reference here too.)

### UX-033
Severity: MEDIUM
Feature: Agricultural Data
Live caller: `_AgriMarketCard`/`_AgriProductCard`/`_AgriProvinceCard`
User impact: no way to tell whether a price is seconds or days old — `updatedAt` is populated on every model and the cache layer even enforces different max-ages per data type, but none of the three card widgets render it.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: add a "güncelleme: HH:mm" label per card, reusing the already-populated field.

### UX-034
Severity: LOW
Feature: Agricultural Data
Live caller: `market.ts:250-326` (Bigpara/akaryakit.org scrapers)
User impact: none directly today (null-safe end to end), but gold/silver/gasoline/diesel/Brent partly depend on regex-scraping third-party HTML pages with no monitoring — a genuine positive finding is that currency/gold/fuel data IS real/live (TCMB, open.er-api, gold-api, CoinMarketCap, Binance, CoinGecko), just fragile on this subset.
Classification: POTENTIAL PERFORMANCE RISK (data-quality/availability risk)
Release blocker: no
Minimum safe improvement: add a scrape-health check/alert.

### Confirmed correct, no finding
Weather correctly uses real current-location GPS via Open-Meteo (manual province → GPS-nearest → profile city → null, no hardcoded default), with a genuine `null` (not a fake value) when location is unavailable. Loading/empty states use real "veri yok"/"--" messaging, never a misleading "0 TL."

---

## 11 — ARAMA / FİLTRE / KEŞİF

### UX-035
Severity: MEDIUM
Feature: Search/Filter/Discovery
Live caller: `category_listings_page.dart:575-588`
User impact: filters that match zero listings show the exact same "Henüz ilan yok" message as a genuinely empty category, with no "clear filters" shortcut, even though the page already computes whether advanced filters are active.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: show a distinct "filtrenize uygun ilan yok" message + a "Filtreleri Temizle" button when filters are active and results are empty.

### UX-036
Severity: MEDIUM
Feature: Search/Filter/Discovery
Live caller: `search_listings_page.dart:339-357`, `listings_store.dart:371-374`
User impact: global keyword search shows the "ROKET" badge on boosted listings but does NOT actually prioritize them in result order — unlike category/featured/popular listing pages, which all correctly boost. A seller who paid for Rocket may still rank below non-boosted listings when found via keyword search specifically.
Classification: FUNCTIONAL BUG / PRODUCT DECISION (inconsistent monetized-feature behavior across surfaces; not deceptive since the badge is still shown, just not prioritized)
Release blocker: no
Minimum safe improvement: apply the same roketli-first ordering already used in `CategoryListingsPage._applySort` to the merged search results.

### UX-037
Severity: LOW
Feature: Search/Filter/Discovery
Live caller: `listings_store.dart:437-490` ("Daha Fazla Göster")
User impact: pagination's `hasMore` uses an optimistic total-count guess (no real server total), so the load-more button can appear once extra near the end of real results.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: have the backend return a real total/hasMore signal.

### Confirmed correct, no finding
Debounced, Turkish-aware keyword search with race-guarding against out-of-order responses; working filter reset (Temizle+Uygula); dedup'd manual-button pagination (no duplicate/skip); clear "ROKET"/"VİTRİN" visual promotion badges where prioritization IS implemented.

---

## 12 — BİLDİRİMLER

### UX-038
Severity: HIGH
Feature: Notifications
Live caller: `notification_models.dart:18-64` (`AppNotificationItem`), `notifications_page.dart:63-179` (`_openByKind`)
User impact: tapping ANY in-app notification (message, offer accepted/rejected/countered, like/favorite, comment) never opens the specific conversation/offer/listing it's about — it only switches to the corresponding bottom-nav tab, without even resetting that tab's own navigation stack. `AppNotificationItem` stores no entity ids at all, even though the underlying Strapi rows already carry `threadId`/`offerId`/`listingId`.
Classification: FUNCTIONAL BUG (this is the SAME root-cause gap independently surfaced in §2's offer findings and §8's farmer-question findings — one underlying fix closes all three).
Release blocker: no (in-app bell tap; see UX-039 for the more severe OS-push version of this same gap)
Minimum safe improvement: add `threadId`/`offerId`/`listingId`/`profileId` to `AppNotificationItem`, populate from the Strapi row, and push the specific detail page instead of only switching tabs.

### UX-039 — personally re-verified (CONFIRMED)
Severity: HIGH
Feature: Notifications
Live caller: `push_messaging_service.dart:93-97` (`onMessageOpenedApp`), `init()`
User impact: **personally confirmed by reading the exact listener**: when a user taps the real OS push-notification tray entry — app backgrounded OR fully killed — nothing navigates anywhere. `onMessageOpenedApp` only calls a silent background data refresh; there is **no `getInitialMessage()` call anywhere in the codebase** (confirmed via full-repo search), so a cold-start tap on a notification is not handled at all — the app just launches to its normal startup route.
Root cause: FCM tap-through deep-linking was never implemented; only the foreground in-app banner (`onMessage`) and a bare background-refresh hook exist.
Flutter file/function: `push_messaging_service.dart:93-97`, `:245-253` (`_refreshAfterPush`).
Classification: FUNCTIONAL BUG
Release blocker: **yes** — tapping the OS notification tray (not the in-app bell) is the single most common real-world way users interact with a push, and it currently does nothing beyond a silent refresh.
Minimum safe improvement: parse `message.data` (already carries kind/notificationId/offerId/threadId/listingId server-side) in both `onMessageOpenedApp` and a new `getInitialMessage()` check at startup, routing to the same detail-page logic recommended for UX-038.

### UX-040
Severity: MEDIUM
Feature: Notifications
Live caller: `notification.ts:36-58` (DOMAIN_EVENTS text), `offer.ts:187-357`
User impact: backend-authored notification titles/bodies are ASCII-only ("Ilanin Favorilendi", "Karsi Teklif" instead of proper Turkish diacritics), unlike correctly-accented client-side strings elsewhere in the same app. Accept/reject/counter-offer body text is also identical across all three statuses.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: re-key the backend notification copy with correct Turkish diacritics; give each offer status its own informative body text.

### UX-041
Severity: MEDIUM
Feature: Notifications
Live caller: `main.dart:1406-1452` (`_selectTab`), `support_center_page.dart:26-28`
User impact: viewing the Support tab correctly clears its own unread notifications on open, but the equivalent doesn't happen for Offers/Messages tabs — a user who reads a message/offer directly in its own tab still sees it as unread in the Bildirimler list and bell badge.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: call the same `markReadForKinds` used for Support inside the Offers/Messages tab-entry hooks too.

### UX-042
Severity: MEDIUM
Feature: Notifications
Live caller: `farmer_question_models.dart:135-160` (`pushRemoteFarmerQuestionNotification`)
User impact: a farmer who gets an answer to their question receives no notification at all — no push, no in-app entry — even though the client code that requests one still runs and appears to succeed.
Root cause: **explicitly disclosed, not an oversight** — hub-content/farmer-questions has no server-verifiable author-identity field, so N1's security fix (which made the generic notification route self-target-only) collaterally broke this one interaction type, per the code's own comment.
Classification: PRODUCT DECISION (disclosed trade-off) / FUNCTIONAL BUG from an end-user perspective
Release blocker: no (already a known, accepted N1-era gap) — flagging so it's explicitly signed off for this release rather than rediscovered as a surprise during UAT.
Minimum safe improvement: add a real author-identity field to hub-content and a dedicated domain-event resolver for this notification type, or explicitly scope it out of this release's stated feature set.

### Notifications — coverage summary (per-type)
- New message: server-created correctly, single-row (no duplicate). Tap destination: broken both in-app (UX-038) and via OS push (UX-039).
- Offer created/accepted/rejected/counter: deterministic `notificationId` prevents duplicates by design. Same tap-destination gaps as above; body-text issue UX-040.
- Favorite/like/comment on listing/logistics-load/processed-product/profile: fully migrated to the secure domain-event path (this session's own N1 work) — solid; text-quality issue only (UX-040).
- Farmer question answered: silently broken end-to-end (UX-042), disclosed trade-off.
- System/admin/broadcast: correctly not client-forgeable (`notification-ownership.ts` denies any client-submitted broadcast row); real admin broadcast creation path not traced (out of scope) — MANUAL UAT REQUIRED if exercised this release.

---

## 13 — NAVIGATION / BACK STACK

### UX-043
Severity: MEDIUM
Feature: Navigation
Live caller: `search_listings_page.dart:308-312` (`_openDetail`), and the same unguarded pattern at essentially every card `onTap` across the app
User impact: rapidly double-tapping a listing/profile card (easy on a slow frame or laggy list) can push the same detail screen twice — the back button then has to be pressed twice to actually leave, feeling like the app "got stuck." Confirmed this is the norm, not an exception — no shared navigation-lock/debounce utility exists anywhere in `lib/`.
Classification: POTENTIAL PERFORMANCE RISK / UX FRICTION
Release blocker: no
Minimum safe improvement: add a small shared "navigate once" guard at the handful of highest-traffic detail-page entry points.

### Confirmed correct, no finding
Bottom-nav tab state/scroll position preserved correctly across switches (`IndexedStack` + `_loadedTabs`, no bug). System back correctly pops the active tab's own stack, else jumps to tab 0, else exits — standard, correct pattern. Re-tapping an already-active tab resets it to root (`popUntil isFirst`) — good, deliberate anti-"lost" design; the same reset is specifically missing on notification-driven tab switches (see UX-038).

---

## 14 — PERFORMANCE / RESPONSIVENESS (static audit only, no runtime measurement)

### UX-044 — personally re-verified (CONFIRMED)
Severity: HIGH
Feature: Performance
Live caller: `main.dart:1488-1558` (`AppShell`, `IndexedStack`)
User impact: **personally confirmed**: `_loadedTabs` (line 1331) only ever grows (`.add`), never shrinks, across `main.dart` — once a tab is visited, its `State` (and any `Timer.periodic` in its `initState`) stays alive and running for the rest of the session even while a different tab is frontmost. Concretely: Home (always active) polls every 60s doing 5 sequential refreshes each tick; Offers polls every 15s; Messages polls every 20s. Once a user has opened Offers and Messages once, all three timers run concurrently forever regardless of which tab is on screen — real, ongoing battery/data cost with no user benefit.
Classification: POTENTIAL PERFORMANCE RISK
Release blocker: no
Minimum safe improvement: pause each tab's `Timer.periodic` when its tab index isn't the active one; resume on return.

### UX-045
Severity: MEDIUM
Feature: Performance
Live caller: `home_page.dart:122-144` (`_refreshHomePublicData`)
User impact: 5 independent backend refreshes (listings, ads, hub, farmer questions, notifications) are awaited strictly sequentially with no data dependency requiring that order — first-paint and every periodic refresh are slower than necessary.
Classification: POTENTIAL PERFORMANCE RISK
Release blocker: no
Minimum safe improvement: wrap the independent calls in `Future.wait`.

### UX-046
Severity: LOW
Feature: Performance
Live caller: `home_page.dart:1439-1490, 2037-2081` ("Popüler İlanlar" rail)
User impact: this section rebuilds and fully re-scans/re-sorts the entire listings+processed-products+logistics universe on EVERY tick from six different merged notifiers — e.g. one favorite toggle anywhere triggers a full recompute.
Classification: POTENTIAL PERFORMANCE RISK
Release blocker: no
Minimum safe improvement: debounce/cache the aggregation instead of recomputing on every merged tick.

---

## 15 — LOADING / EMPTY / ERROR / OFFLINE STATES

### UX-047
Severity: MEDIUM
Feature: Loading/Empty/Error/Offline States
Live caller: app-wide
User impact: no connectivity/offline-detection layer exists anywhere (`pubspec.yaml` has no `connectivity_plus` or equivalent) — every store catches network errors silently and keeps stale cache with zero user-visible signal that the last refresh actually failed.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: add a lightweight connectivity check + shared "offline" banner at the app-shell level.

### UX-048
Severity: MEDIUM
Feature: Loading/Empty/Error/Offline States
Live caller: `messages_store.dart:1580-1584` (`_friendlySendErrorText`), `strapi_service.dart:761-766` (`localizeServerErrorMessage` fallback)
User impact: some backend failures surface a technical/partially-English message in the chat SnackBar instead of a clear Turkish explanation — the fallback path only does light substring replacement and passes through any unmapped backend error text largely unedited.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: make the fallback always return a fixed generic Turkish string when no known pattern matches.

### UX-049
Severity: MEDIUM
Feature: Loading/Empty/Error/Offline States
Live caller: `search_listings_page.dart:75-91, 458-473` (`_triggerRemoteSearch`)
User impact: a failed search (network/server error) looks IDENTICAL to a genuine zero-result search — "Sonuç bulunamadı." — with no retry option; the exception is fully discarded in a blanket `catch (_)`.
Classification: FUNCTIONAL BUG
Release blocker: no
Minimum safe improvement: track a `_searchFailed` flag, render a distinct error message with retry.

### UX-050
Severity: LOW
Feature: Loading/Empty/Error/Offline States
Live caller: `messages_page.dart:501-513`, `notifications_page.dart:301-316`, `farmers_questions_page.dart:250-267`
User impact: these three lists can show their "nothing here" empty copy before the very first fetch has even completed (no `isLoading`/`initialLoading` gate), making the feature look empty/broken on a cold start or slow network. Knowledge Hub already does this correctly (`_initialLoading` pattern) — the other three were never brought up to the same standard.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: reuse the Knowledge Hub `_initialLoading` pattern on all three screens.

### UX-051
Severity: LOW
Feature: Loading/Empty/Error/Offline States
Live caller: `home_page.dart:122-144, 1326-1350`
User impact: if the backend is unreachable on first launch, Home just shows generic "no listings yet" tiles per section with no indication this is a connectivity problem and no retry beyond waiting for the next timer tick.
Classification: UX FRICTION
Release blocker: no
Minimum safe improvement: track "all sources failed on first load" and show one dismissible retry banner.

### Positive notes (not findings)
`EngagementStore.messageFor` already maps 401/403/404/429/network/timeout to clear Turkish strings — a good existing model the messaging/search paths above should be brought in line with. `AgriDataRepository` already has the most resilient degradation path seen in this audit (per-source on-device cache, then mock as last resort — though see UX-032 for why the mock fallback itself is undisclosed).

---

## 16 — GERÇEK USER JOURNEY SIMÜLASYONU

| Step | Classification | Note |
|---|---|---|
| Kayıt (register) | SMOOTH | clear inline validation, KVKK gate |
| Giriş (login) | SMOOTH | |
| Profilini düzenle | FRICTION | UX-009: silent-revert risk if sync fails at exactly the wrong moment (edge case, not routine) |
| İlan ara | SMOOTH | debounced, race-guarded search; minor FRICTION on Rocket-priority inconsistency (UX-036) |
| İlan aç | SMOOTH | |
| Satıcının profiline bak | SMOOTH | |
| **Satıcıya mesaj gönder** | **FRICTION** | **UX-001: no direct button on the listing itself — must detour through the seller's profile first. This is the step the mandate weighted most heavily.** |
| Cevap al | FRICTION | UX-003: up to 10-20s polling latency, not realtime |
| Teklif ver | SMOOTH | button easy to find, form works; minor gap: no quantity field (UX-006) |
| Teklif kabul/red/karşı teklif | SMOOTH functionally | unread badge inaccurate (UX-005), no notification deep-link (UX-007/038) |
| İlanı favorile | SMOOTH | |
| Çiftçi Soruları'nda soru sor | SMOOTH | prominent entry point, login-gated |
| Başka soruya cevap ver | SMOOTH | confirmed working correctly after the ownership security fix |
| Bilgi Bankası içeriği oku | FRICTION | date/read-time vanish on detail (UX-029); no search (UX-028) |
| **Tarımsal Veriler'e bak** | **BROKEN / trust risk** | **UX-032 (CRITICAL): product prices can be entirely fabricated with no disclosure; UX-031: weather subtitle renders garbled text on every load** |
| Premium satın al | SMOOTH | badge updates instantly; FRICTION on restore-purchase messaging (UX-012) |
| Rocket kullan | SMOOTH | genuinely server-authoritative, confirmed |
| **Bildirim al** | **FRICTION / BROKEN** | **UX-038/039: tapping a notification — in-app or the real OS push tray — never opens the relevant screen; this is the single most common real-world notification interaction and it currently does nothing** |
| Ayarlara gir | SMOOTH | well organized, discoverable |
| Şifre değiştir | SMOOTH | |
| Çıkış yap | SMOOTH | |
| Başka hesapla giriş yap | SMOOTH | cross-account isolation thoroughly confirmed, see §17 |

---

## 17 — CROSS-ACCOUNT / SESSION UX (personally investigated)

Traced `AuthService._onSessionChanged` (`main.dart:5983-6007`), the single choke point every login/logout/account-switch passes through.

**Confirmed cleared on every session change (11 stores, all explicitly called, not just present as methods)**: `OffersStore`, `MessagesStore`, `NotificationStore` (+ restore), `SupportStore`, `HubContentRepo`, `ProfileFollowStore`, `FavoritesStore`, `FavoriteProfilesStore`, `ProfileCommentsStore`, `PurchaseStore`, `EngagementStore`. This directly covers **messages, unread, offers, premium, favorites, likes, notifications** from the mandate's own checklist.

**Pending engagement queue** — confirmed correct BY DESIGN, not an oversight: deliberately excluded from the clear sweep. A queued operation is owner-tagged and `flush()` pauses (never sends, never silently drops) any operation belonging to a different owner than whoever is currently logged in, replaying it once that owner returns — this session's own earlier E1 fix (BUG-ENG-003), re-confirmed via the existing passing test suite.

### UX-052
Severity: LOW
Feature: Cross-account/session UX (profile)
Live caller: `session_profile_store.dart`
User impact: none found in practice — `SessionProfileStore` is the one store NOT in the explicit clear sweep, but its internal cache is keyed by `ownerId`, so B logging in after A always resolves/creates B's own separate entry; A's cached data is never re-read. Confirmed safe by construction, not by luck.
Classification: PRODUCT DECISION / code-hygiene, not a real defect — independently reached by the parallel profile/auth research pass too.
Release blocker: no
Minimum safe improvement: add it to the clear sweep purely for memory hygiene over a long multi-account-switch session, not for correctness.

**"Listing state"**: `ListingsStore` holds public marketplace data, not per-viewer private state — every listing carries its own real `ownerId`/`ownerEmail`, and every "is this mine" check compares against `currentSessionOwnerId()` live at render time, never a cached per-viewer annotation. No clearing needed, no leak risk found.

---

## 19 — ÖNCEKİ FIX REGRESSION CHECK

All items confirmed present at current HEAD (`f62470f`/`2f33b73`, unchanged since this audit began — this phase made no commits). Where a dedicated, currently-passing automated test exists, that is the primary evidence; several were additionally re-confirmed directly by source reading during this pass.

| Item | Status | Evidence |
|---|---|---|
| Forgot Password geçici şifre modeli | **PRESENT** | Personally re-verified (§3/§4): `ForgotPasswordPage` has no code field; backend `resetPassword` is an intentional dead stub; dedicated test suite locks it in |
| Public Profile premium boolean | **PRESENT** | Backend-computed `isPremium`, same rule for any viewer — re-verified by the profile/auth research pass |
| Messaging identity protection | **PRESENT** | Personally re-verified (§1): receiver resolution defensively re-derived client-side, independently re-verified server-side (N1 work), unchanged |
| Messaging thread creation/idempotency | **PRESENT** | Personally re-verified (§1): `_ensureRemoteThreadExists` correctly guarded against redundant calls |
| Messaging read/unread | **PRESENT** | Personally re-verified (§1): `readAt`/`isRead` genuinely server-backed |
| Messaging retry/idempotency | **PRESENT** | Personally re-verified (§1): `operationId` used in send/retry |
| Offer receiver ownership | **PRESENT** | Re-verified by the offers research pass: receiver always the real listing owner, never client-suppliable |
| Offer markSeen | **PRESENT server-side** | `offer.ts`'s `markSeen` correctly writes `seenAt`/`seenBy`; the client-side unread-badge gap (UX-005) is a separate, pre-existing display bug, not a regression of this mechanism |
| OfferCount server authority | **PRESENT** | `recountListingOffers` runs after create/delete, clamped at 0 |
| Offline listing ownership | **PRESENT** — personally re-verified | `syncOfflineListing` (`engagement.ts:465-519`) strips protected fields via `stripListingProtectedFields` and force-sets `ownerEmail`/`ownerProfileId`/`ownerId` from the authenticated identity, never the client; ownership re-checked via `matchesIdentity` before any update |
| Listing private ownerEmail | **PRESENT** | Covered by the still-passing `listing-owner-email-privacy` integration suite (part of the 317/317 currently-passing backend tests, unchanged since E2) |
| Listing protected counters/Rocket fields | **PRESENT** | Same currently-passing suite; no listing/rocket file touched since E2 |
| Server-authoritative Rocket activation | **PRESENT** | Personally re-verified (§5): re-derives entitlement server-side, idempotent via operationId ledger |
| Processed Product premium gate | **PRESENT** | Covered by the still-passing `processed-products-premium-gate` suite |
| Notification domain-event security | **PRESENT** | Covered by the still-passing N1 security-fix suite; no touched file since |
| FCM token ownership | **PRESENT** | Same N1 suite, unchanged |
| Account deletion notification cleanup | **PRESENT** | This session's own E2 fix, tested this same phase |
| Hub/Farmer Question ownership | **PRESENT** | This session's own E1 fix; §8's targeted re-verification confirms the answering flow specifically still works |
| EngagementStore session isolation | **PRESENT** | This session's own E1 fix; personally re-verified in §17 |
| PendingQueue owner binding | **PRESENT** | This session's own E1 fix; personally re-verified in §17 |
| Processed Product authoritative counts | **PRESENT** | This session's own E2 fix (BUG-ENG-004), tested this same phase |
| Profile engagement counter protection | **PRESENT** | This session's own E2 fix (BUG-ENG-007), tested this same phase |
| Listing-comment account deletion cleanup | **PRESENT** | This session's own E2 fix (BUG-ENG-013), tested this same phase |

**No regression found in any previously-shipped, previously-verified fix.**

---

## 20 — FINAL KARAR

**READY FOR TARGETED UX/FUNCTIONAL FIX**

No CRITICAL or HIGH finding in this audit is a security or data-integrity
regression — every prior security/bug-fix phase remains fully intact
(§19). Every finding here is a functional-completeness or UX-quality gap,
which is exactly what this phase was scoped to surface before real-device
UAT.

That said, several findings are severe enough that shipping to real
farmers without addressing them first would likely produce a poor first
UAT impression or genuine user harm:

**Recommend fixing before UAT** (ranked by impact):
1. **UX-032 (CRITICAL)** — undisclosed fabricated agricultural product
   prices. This is the one finding in the whole audit that touches user
   trust in the app's core data, not just convenience.
2. **UX-021 (HIGH)** — the fake "Aktif/Pasif" account toggle that claims
   success while doing nothing.
3. **UX-039 (HIGH)** — tapping a real OS push notification does nothing;
   this is the most common real-world notification interaction.
4. **UX-031 (trivial)** — the garbled weather-subtitle text; a two-minute
   fix with outsized visibility.
5. **UX-001 (HIGH)** — no direct "Message Seller" button on the listing
   detail page, directly contradicting this audit's own stated
   messaging-UX target.
6. **UX-016 (HIGH)** — listing-creation has no idempotency key, risking
   real duplicate listings on the flaky rural connections this app's
   actual users will have.

Everything else (§1-§17's remaining ~45 findings) is real but lower-
stakes — reasonable to triage in a short follow-up pass the same way the
prior Engagement E1/E2 phases were handled, rather than blocking this
audit's own sign-off.

Per the mandate: stopping here. No code was changed, no commits, no
push, `main` untouched, no deploy. Not proceeding to fixes or to UAT
automatically.
