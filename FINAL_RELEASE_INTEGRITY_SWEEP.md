# TARIM360+1 — FINAL RELEASE INTEGRITY SWEEP

Backend: `C:\projeler\tarim360-strapi`
Flutter: `C:\projeler\tarim360`
Branch (both repos): `release/preflight-integration`
Precondition: `PRE_UAT_F2_SMALL_FIX_REPORT.md` = READY FOR UAT (confirmed).

Scope: read-only, end-to-end verification of every main user flow. No code was
changed, no tests were added, nothing was committed or pushed during this
sweep. Question answered: **does each real, live flow actually work, or is
there a live blocker** — not an architecture review. Dead code and
theoretical debt are explicitly excluded below unless they created a
concrete, reachable bug.

Method: 8 parallel read-only research passes (each independently re-verified
current code — not just past fix reports — and where relevant ran the real
test suites), covering all 17 requested sections. Two passes independently
converged on the same CRITICAL finding (FINAL-BUG-001 below), which is a
strong corroboration signal, not a duplicate to be discounted.

---

## FINAL DECISION: **READY FOR TARGETED FINAL FIX**

Every core day-to-day flow (auth, messaging, offers, listings, profile,
farmer questions, knowledge hub, agricultural data, premium purchase
happy-path) works end to end with no data loss and no fake-success UI, and
the full regression suite (653 tests across both repos) is 100% green with
zero prior fixes regressed. **However, one CRITICAL, live, unauthenticated
business-integrity bypass exists (free premium/rocket/AI self-grant via a
plain HTTP call) plus five HIGH-severity items** that would either
undermine revenue integrity, misattribute content across accounts, or
silently lock a user out of their account. None of these require an
architecture change — each has a small, targeted, already-patterned fix
elsewhere in the same codebase. **Fix the CRITICAL item and the HIGH items
below before physical device UAT begins** (recommend fixing before UAT
rather than after, since UAT testers or early real users could trivially
trigger the premium-spoof and offline-queue-misattribution bugs). MEDIUM/LOW
items are good to fix but do not need to block starting UAT.

---

## CRITICAL

### FINAL-BUG-001 — Any authenticated user can self-grant premium, rocket boosts, and AI access with a single HTTP call
- **Severity:** CRITICAL
- **Feature:** Premium / Rocket / AI / Processed-Products (entitlement integrity) — found independently by both the Listing/Premium research pass and the Security research pass
- **Live caller:** `PUT /api/profile-settings/:id` (also reachable via `POST`) — `src/api/profile-setting/controllers/profile-setting.ts:20-41` (`stripEngagementFields`), guarded only by `src/policies/profile-setting-ownership.ts:46-56` (verifies the caller owns the row — proves nothing about which *fields* may be written)
- **Expected:** `activePremium`/`activePremiumSubscription` (the JSON blob every premium/rocket/AI gate reads) must only ever be written by the verified-purchase pipeline (`src/api/purchase/controllers/purchase.ts` → real Apple/Google receipt check), never by a generic client PUT to the user's own profile-setting row.
- **Actual:** `stripEngagementFields` only deletes `viewCount`/`engagementVersion` before calling `super.create`/`super.update`. `activePremium`/`activePremiumSubscription` are plain, unprotected `json` schema fields. Any authenticated user can `PUT /api/profile-settings/<own-id>` with `{"data":{"activePremium":{"endsAt":"2099-01-01T00:00:00Z","rocketRemaining":99,"rocketDays":28,"hasAiAssistant":true}}}` — zero receipt verification. The `afterUpdate` lifecycle hook (`profile-setting/content-types/profile-setting/lifecycles.ts:43-46`, `syncOwnerPremiumFlags`) immediately fans this forged value out to all of that user's existing listings/ads. Every downstream gate trusts it with no independent check: `premium-sync.ts`'s `isPremiumActiveFromProfile` (used by `listing.ts`, `ai.ts`, `auth-flow.ts`, `promo.ts`, `require-logistics-premium.ts`), `listing.ts activateRocket` (reads `rocketRemaining`/`rocketDays` directly from this same row), `ai.ts ensureAiAccess`/`hasActiveAiAccess` (reads `hasAiAssistant`), `processed-products.ts requireActivePremium`.
- **Root cause:** `stripEngagementFields`'s block-list was scoped to the one bug it was written for (BUG-ENG-007, self-inflated `viewCount`) and was never extended to the far more sensitive `activePremium`/`activePremiumSubscription`/`purchaseHistory`/`purchaseRecords` fields on the same content-type. No regression test exists for this — `profile-setting-ownership.integration.test.ts` only tests `viewCount`/`engagementVersion` spoofing; `processed-products-premium-gate.integration.test.ts`'s test named "a client cannot spoof premium via the profile-settings payload itself" only proves the gate doesn't default-allow with *no* row — it never attempts an actual forged PUT.
- **Release blocker?:** Yes. This defeats every "server-authoritative premium/rocket" guarantee established by the PREMIUM_P1/F1/F2 fix passes. A free user gets real paid entitlements (rocket boosts, AI Pro, processed-products access, premium badge) with no purchase at all.
- **Minimum fix:** Add `activePremium`, `activePremiumSubscription`, `purchaseHistory`, `purchaseRecords` (and ideally `accountType`) to a stripped-fields block-list in `profile-setting.ts`'s create/update actions, exactly mirroring how `listing.ts`/`processed-product.ts` already strip their own protected fields via `LISTING_CLIENT_PROTECTED_FIELDS`-style allowlists. Only the internal purchase-verification pipeline (which writes via `entityService` directly, not through this controller) should ever set these fields.

---

## HIGH

### FINAL-BUG-002 — Listing creation has no server-side free-tier quota enforcement
- **Severity:** HIGH
- **Feature:** Listing (monetization gate — "Normal Hesap İlan Limiti")
- **Live caller:** `POST /api/listings` → `listing.ts create()` (`src/api/listing/controllers/listing.ts:142-317`)
- **Expected:** A non-premium account gets a fixed number of free listings, then must buy a listing-quota pack, per `create_listing_page.dart:_ensureNormalListingQuota` (`lib/features/listings/pages/create_listing_page.dart:1367-1427`).
- **Actual:** That check exists ONLY in the Flutter UI. The backend `create()` action has no count/quota check at all — no lifecycle hook, no query against prior listings or quota purchases. A direct `POST /api/listings` call (bypassing the app entirely) creates unlimited listings for free, regardless of purchase history.
- **Root cause:** The free-tier cap was implemented as a client-side UX gate only; never mirrored server-side the way rocket entitlement was.
- **Release blocker?:** Yes for monetization integrity (unlimited free listings via direct API); no cross-user security impact, hence HIGH not CRITICAL.
- **Minimum fix:** In `listing.ts create()`, count the owner's published listings + paid quota-pack purchases server-side before allowing a create, rejecting over-limit the same way `activateRocket` rejects unentitled rocket requests.

### FINAL-BUG-003 — Offline-queued listing creates can be published under the next logged-in account
- **Severity:** HIGH
- **Feature:** Cross-Account Isolation — Listing Offline Sync Queue
- **Live caller:** `ListingPendingSyncQueue` (`lib/features/listings/stores/listings_store.dart:8-115`), triggered every 30s by `LiveSyncManager` (`lib/main.dart:1030`); enqueued on network failure from `create_listing_page.dart:1123-1136`
- **Expected:** A listing queued while offline under user A must never be submitted/attributed to user B after a fast account switch on the same device — the same guarantee `EngagementPendingQueue` already provides (BUG-ENG-003).
- **Actual:** `ListingPendingSyncQueue` has no `clearForSession()` and its `retryPending()` submits every queued row using whatever JWT is currently active, with **no `ownerId` comparison against the current session at all** — unlike `EngagementPendingQueue.flush()`, which explicitly pauses ops whose `ownerId` doesn't match. Backend's `syncOfflineListing` (`src/api/engagement/controllers/engagement.ts:467-548`) does force owner fields from whichever identity's JWT calls it, but for a genuine new *create* there's no prior owner to reject against — so it succeeds, publishing A's title/photos/price/description as B's own listing.
- **Root cause:** `ListingPendingSyncQueue` was never given the owner-aware pause logic that `EngagementPendingQueue` received specifically to close this exact bug class.
- **Release blocker?:** Yes — realistic given the app's own flaky-rural-connectivity use case; misattributes real content across accounts without consent.
- **Minimum fix:** Stamp each queued row with `ownerId` and have `retryPending()` skip/pause rows whose `ownerId` doesn't match `currentSessionOwnerId()`, mirroring `EngagementPendingQueue`'s existing pattern exactly.

### FINAL-BUG-004 — Logistics load/vehicle listings trust client-supplied owner identity on creation
- **Severity:** HIGH
- **Feature:** Server Authority — Logistics Load/Vehicle Owner
- **Live caller:** `logistics-load.ts:326-338` (`create`) and `logistics-vehicle.ts:181-192` (`create`) — neither calls `readIdentity(ctx)`; no ownership-forcing policy on either route
- **Expected:** `ownerKey`/`ownerProfileId`/`ownerEmail` (load) and `transporterKey` (vehicle) should be derived from the authenticated caller's JWT on create, matching `listing.ts`/`offer.ts`.
- **Actual:** `sanitizeCreateData` only zeroes engagement counters; the file's own comment (`logistics-load.ts:103-106`) discloses `ownerKey` is "set once at creation directly from whatever the client sends... never computed server-side." Any authenticated user can `POST /logistics-loads` or `/logistics-vehicles` with an `ownerKey`/`transporterKey` matching an arbitrary real person, publishing a live listing that impersonates their contact details, or later handing that real person unwanted edit/delete rights over content they never created. Update-time reassignment is correctly blocked (`transporterKey` deleted from update payloads), but creation has no such guard.
- **Root cause:** Same vulnerability class as the already-fixed BUG-LISTING-001/BUG-OFFER-001 (client-trusted identity fields), never extended to logistics-load/vehicle `create`.
- **Release blocker?:** Yes — live, reachable, no gate blocks it for vehicles at all; genuine identity/content-authenticity spoof.
- **Minimum fix:** Call `readIdentity(ctx)` in both `create()` actions and force the owner/transporter identity fields from it, exactly as `listing.ts create()` already does.

### FINAL-BUG-005 — Forgot-password can silently invalidate a user's password when the reset email fails to send
- **Severity:** HIGH
- **Feature:** Auth / Forgot Password ("Şifremi Unuttum")
- **Live caller:** `auth-flow.ts` `requestPasswordReset` (`src/api/auth-flow/controllers/auth-flow.ts:705-747`)
- **Expected:** If the temporary-password email cannot be delivered, the user's real password must remain unchanged.
- **Actual:** The handler writes the new temp password to the user record (line 729-733) **before** attempting to send the email. If `sendTemporaryPasswordEmail` throws (SMTP timeout/outage/bad credentials/rate limit), the catch block returns a plain failure — but the password mutation is never rolled back. The user's old password silently stops working while they see only a generic "gönderilemedi" failure message, with no indication their credentials just changed. Zero test coverage exists for this handler.
- **Root cause:** Password mutation happens before, not after, the side-effect (email send) that's supposed to communicate the new value — no rollback on send failure.
- **Release blocker?:** Yes — deterministic, reproducible under a realistic failure mode (any SMTP hiccup), and every affected user is left thinking forgot-password "failed" while actually being locked out.
- **Minimum fix:** Send the email first; only persist the new password after `sendTemporaryPasswordEmail` resolves successfully.

### FINAL-BUG-006 — Favorite/like/offer counts shown to users can only ever increase locally, never reflect a real decrease
- **Severity:** HIGH
- **Feature:** Engagement (listing + processed-product counters)
- **Live caller:** `lib/features/engagement/stores/listing_engagement_store.dart:96-124` (`seedCounts`/`takeMax`) and the identical pattern in `lib/features/processed_products/stores/processed_market_stores.dart:540-561`
- **Expected:** When the server's authoritative count decreases (someone unfavorites/unlikes, or an offer is deleted so `recountListingOffers` lowers `offerCount`), the number shown to the user should follow.
- **Actual:** `takeMax` only ever raises the cached local value (`if (value > current) target[key] = value`), never lowers it. Concrete case: listing X has 5 offers cached locally; one offer is deleted server-side (`offerCount` → 4); next fetch calls `seedCounts(..., offers: 4)`, but `4 > 5` is false, so the cached `5` sticks **forever on that device**. Same applies to `favoriteCount`/`likeCount` whenever any user removes a favorite/like. This value is read directly by real UI: home page, popular-listings rail, seller stats on `HesabimPage`, and the initial paint of the listing detail page.
- **Root cause:** `takeMax` reconciliation is correct for `views` (which legitimately never decrease) but was also incorrectly applied to `favorites`/`likes`/`offers`, which legitimately can decrease.
- **Release blocker?:** Borderline-yes — a real, easily reproducible, permanently-wrong business number sellers rely on, and it never self-corrects. Recommend fixing before UAT since offer/favorite counts are exactly the kind of number a tester will notice and flag as "obviously broken."
- **Minimum fix:** In `seedCounts` (both files), use a plain "always take the freshest server value" assignment for `favorites`/`likes`/`offers` (keep `takeMax` only for `views`).

---

## MEDIUM

### FINAL-BUG-007 — Read receipts (double-tick) never update within a session
- **Severity:** MEDIUM
- **Feature:** Messaging (read receipts)
- **Live caller:** `MessagesStore._mergeRemoteChatHistory`/`_dedupKeyFor` (`lib/features/messages/stores/messages_store.dart:960-996`), consumed by `message_chat_page.dart:27-51` and `offer_chat_page.dart`
- **Expected:** A sent message shows a single tick until the recipient reads it, then flips to double-tick once the server stamps `readAt` (which is genuinely server-authoritative).
- **Actual:** The optimistic local message (created at send time, `readAt` hardcoded null and immutable) is added immediately; when the poll later fetches the server-echoed row with a populated `readAt`, `_mergeRemoteChatHistory`'s dedup keeps the **first-seen** (always the earlier local) object over the later server one — so the `readAt` update is silently discarded on every poll. `MessageChatPage._pollMessages()` additionally only re-renders when `remote.length > msgs.length`, so even an in-place field change wouldn't refresh the UI. Net effect: send a message, have the recipient read it, look back — still shows a single tick indefinitely, until the app is fully killed and relaunched.
- **Root cause:** Dedup-by-first-seen always prefers the pre-send local object over the fresher server-echoed one; `readAt` is a `final` field with no update path once cached.
- **Release blocker?:** No — no data loss, sending/receiving still works — but it's user-visible, easy to notice, and undermines a feature explicitly named as important ("is read/unread server-authoritative"). Recommend fixing before UAT sign-off.
- **Minimum fix:** When two entries share a dedup key, keep the fresher one (or merge the remote row's `readAt`/`deliveryStatus` onto the retained object) instead of always keeping first-seen; loosen the `remote.length <= msgs.length` early-return so in-place field changes still re-render.

### FINAL-BUG-008 — Farmer-question answer/like notifications are never delivered to the question owner
- **Severity:** MEDIUM-HIGH
- **Feature:** Farmer Questions — notifications
- **Live caller:** `pushRemoteFarmerQuestionNotification` (`lib/features/farmer_questions/models/farmer_question_models.dart:135`), called from answer and like actions
- **Expected:** The question owner is notified when someone answers or likes their question.
- **Actual:** This calls the generic `POST /api/notifications`, which is self-target-only (by design, per the N1 security fix) — any cross-user target is rejected with 403, and the 403 is silently swallowed client-side (`NotificationStore._pushTargetToStrapi`, `catch (e) { debugPrint(...) }`). The question owner is **never** notified. The backend's `DOMAIN_EVENTS` registry (the secure, server-verified path used for listing/logistics/processed-product/profile) has no `farmer_question` entry — its absence was originally justified because hub-content "has no verifiable author-identity field," but that justification is now stale: a later commit (`fix(hub): enforce content ownership on writes`) added real `ownerEmail`/`ownerProfileId` fields to `hub-content`, already used elsewhere for ownership enforcement, but the notification registry was never updated to use them.
- **Root cause:** The secure domain-event notification path was never extended to farmer questions after the underlying data (owner identity fields) became available.
- **Release blocker?:** Borderline — fails closed (no security hole), but it's a silent, complete failure of a core, advertised engagement feature.
- **Minimum fix:** Add a `farmer_question` entry to `DOMAIN_EVENTS` with an owner-resolution lookup against `hub-content.ownerEmail`/`ownerProfileId`, and switch the Flutter call to `createDomainEvent`.

### FINAL-BUG-009 — Offer "unread" badge can flicker back on right after opening the tab
- **Severity:** MEDIUM
- **Feature:** Offers (F2.2/F2.6 interaction)
- **Live caller:** `main.dart:1450-1452` (`_selectTab`), `offers_store.dart:34-48`/`:574`
- **Expected:** Opening the Offers tab clears the incoming-unread badge and it stays cleared.
- **Actual:** `_selectTab` calls `markIncomingSeen()` (zeroes the badge locally, then fires a **sequential** loop of one `PATCH /offers/:id/seen` per incoming offer) immediately followed by an unawaited `refresh()`. If the GET completes before all the sequential PATCHes commit (plausible — one round trip vs. N), `_refreshRemote()` unconditionally recomputes the badge from the (stale) fetched `seenBy` data, so it can reappear nonzero for up to ~15s even though the user is looking at the list.
- **Root cause:** No ordering guarantee/reconciliation between the in-flight mark-seen PATCHes and the immediately-following GET refresh.
- **Release blocker?:** No — self-heals within one poll cycle, doesn't affect real accept/reject functionality — but it's a direct, visible regression of the exact symptom F2.2 was written to fix.
- **Minimum fix:** Await `_markIncomingOffersSeenRemote()` before firing the post-tab-switch `refresh()`, or have `_refreshRemote()` treat recently-locally-marked-seen ids as seen regardless of the fetched snapshot.

### FINAL-BUG-010 — Viewing your own listing/logistics-load/vehicle/processed-product counts as a view
- **Severity:** MEDIUM
- **Feature:** Engagement (view counting)
- **Live caller:** `listing_detail_page.dart:46`, `logistics_load_detail_page.dart:27`, `logistics_vehicle_detail_page.dart:37`, `processed_product_detail_page.dart:27` — all call `registerView` unconditionally in `initState()`, no owner check
- **Expected:** A view by the item's own owner shouldn't inflate its view count (the app already does this correctly for profiles).
- **Actual:** Self-view exclusion is deliberately scoped server-side to `targetType === 'profile'` only (confirmed by an explicit code comment); the client mirrors this gap — profile pages have an `!_isOwnerView` guard around `registerView`, the four detail pages above do not. A seller opening their own listing to check/edit it increments its view count (bounded to +1/day per the server's 24h actor-dedup, but never excluded).
- **Root cause:** The self-view exclusion pattern built for `profile` was never extended to the other four domains.
- **Release blocker?:** No — but it's a confirmed, easily reproduced metric-accuracy bug on a number sellers look at directly.
- **Minimum fix:** Wrap each of the four `registerView` calls in an `if (!isOwner)` check, matching the existing profile-page pattern.

### FINAL-BUG-011 — Knowledge Hub / Farmer Questions show an indistinguishable "empty" state on a failed fetch
- **Severity:** MEDIUM
- **Feature:** Knowledge Hub, Farmer Questions
- **Live caller:** `HubContentRepo.fetchList` (`lib/main.dart:4484-4516`), `FarmerQuestionsRepo.refresh` (`lib/features/farmer_questions/repositories/farmer_questions_repo.dart:296`)
- **Expected:** A failed fetch should show a real error/retry state, distinguishable from a genuinely empty backend.
- **Actual:** On error, both repos only `debugPrint` and return whatever's already cached (empty on cold start); the widgets then render the same "Henüz içerik eklenmedi" empty card either way. A user on a bad connection can't tell "nothing here" from "couldn't load."
- **Root cause:** No error/failure flag is threaded from repo to widget, only a loading boolean.
- **Release blocker?:** No — pull-to-refresh lets the user retry, never shows stale-wrong data, just an ambiguous empty state.
- **Minimum fix:** Track last-fetch-failed in both repos and have the empty-state widgets branch on it to show a retry affordance with an explicit error message.

### FINAL-BUG-012 — Payment-status screen can show the previous account's transaction data after an account switch
- **Severity:** MEDIUM
- **Feature:** Cross-Account Isolation — Purchase Coordinator
- **Live caller:** `PurchaseCoordinator` singleton fields (`lib/features/premium/purchase/purchase_coordinator.dart:288-317`), rendered by `payment_status_page.dart:163-203` ("Son Ödeme İşlemi")
- **Expected:** No residual data from a previous account should be readable after switching accounts on the same device.
- **Actual:** `PurchaseCoordinator.I` is never referenced in `main.dart`'s session-reset handler (confirmed by grep) — unlike `PurchaseStore`, which does have `clearForSession()` and is correctly wired in. If user A attempts/completes a purchase, then B logs in on the same device, "Ödeme Durumu" shows B A's last transaction ID, product ID, and success/verification result until B makes their own purchase.
- **Root cause:** `PurchaseCoordinator` was added alongside `PurchaseStore` but never given its own reset method or wired into the session-change handler.
- **Release blocker?:** No — metadata leak only, not an account-takeover or entitlement leak (that's covered by `PurchaseStore`, which IS correctly isolated) — but real and confirmed.
- **Minimum fix:** Add a `resetForSession()` to `PurchaseCoordinator` clearing its six `_last*` fields; call it from `_onSessionChanged` alongside `PurchaseStore.I.clearForSession()`.

---

## LOW

### FINAL-BUG-013 — "Analitik İzni" settings toggle is fully cosmetic
- **Severity:** LOW
- **Feature:** Settings
- **Live caller:** `_setAnalyticsConsent` (`lib/features/settings/pages/settings_page.dart:125-128`)
- **Expected:** Given the page's own privacy-policy copy referencing it, toggling this should gate some real analytics/telemetry collection.
- **Actual:** The value is persisted and displayed, but nothing in the codebase reads it — no analytics/telemetry SDK is integrated anywhere in the app at all.
- **Release blocker?:** No — functionally harmless (nothing is collected either way), but misleading relative to its own privacy-policy reference.
- **Minimum fix:** Either wire it to a real analytics gate when one exists, or remove the toggle and its privacy-policy reference until then.

### FINAL-BUG-014 — Farmer question owners cannot edit or delete their own question (feature gap, not a broken implementation)
- **Severity:** LOW-MEDIUM
- **Feature:** Farmer Questions
- **Live caller:** N/A — capability absent from `farmer_questions_repo.dart` and `ask_farmer_question_page.dart` (create-only)
- **Expected (per this sweep's checklist):** a question owner can edit/delete their own question.
- **Actual:** Not implemented client-side at all — not hidden, not broken, simply absent. Notably the backend is already built for this: `hub-content-write-guard.ts` already correctly allows owner PUT/DELETE of the full row.
- **Release blocker?:** No, unless product intends this as a UAT must-have — flag for a product decision.
- **Minimum fix:** Add edit/delete UI wiring calling the already-secure `PUT`/`DELETE /hub-contents/:id`.

---

## Everything checked and cleared (no live bug found)

**Auth:** register (client + server-side registration-guard block both effective, no bypass), login (JWT flow, account-existence messaging), logout (client-side, push-token eviction race already mitigated server-side), change password (stock, server-validated), delete account (full cascade across 20+ content-types, notification cleanup widened per N2, stale JWT can't act as deleted user post-delete).

**Settings:** logout button, push-notification toggle (genuinely gates FCM registration server-side), location toggle, all navigation entry points (subscriptions, purchase history, payment status, packages/pricing, active rockets, expired ads, legal, support) — all real, substantial pages, no stub/no-op handlers found.

**Agricultural data:** weather (real Open-Meteo API), currency/gold/silver/oil/fuel/crypto (`market/snapshot` — real scraped/queried external sources with real fallback chains, legitimately cached, not fabricated), commodity prices & province-level data (real when Strapi has observations; when it doesn't, an explicit amber "demo data" disclosure banner is shown — confirmed still correctly wired from a prior fix pass), province selection genuinely changes displayed data, loading/error states are explicit, never a silent hang.

**Messaging:** A→B send, B→A reply, retry (operationId dedup, 8/8 concurrent-race/conflict tests pass against current code), duplicate prevention, failure modes (no fake-success, failed sends visibly marked `failed` with retry, never silently dropped), unread badge (fully server-authoritative from `readAt`, three independent pollers keep it fresh), F2.1's faster polling confirmed genuinely live with no hidden throttle undoing it, F2.6's per-kind tab mark-read re-verified directly in current code.

**Notifications:** every kind's full source→row→push→display chain (message/offer/like/favorite/profile-comment/support/broadcast) traced; deterministic notificationId + unique constraint blocks duplicates everywhere except the farmer-question gap above; FCM cross-account token eviction (N1.4) confirmed still correct; cold-start push tap correctly resolves and opens the real target; account-switch clears both `MessagesStore` and `NotificationStore`.

**Offers:** create → receiver sees it (server-derived receiver, idempotent), accept/reject role checks (only the receiver can act), notification correctness (never self-notifies, no double-notify on retry), `offerCount` computed by fresh server-side recount (no drift structurally — see BUG-006 for how the *displayed* value can still go stale on-device).

**Engagement:** optimistic favorite/like toggle with correct rollback on failure, favorite/like boolean state (distinct from the count-staleness bug) persists and reconciles correctly across refresh and account switch, view dedup is atomic and race-safe server-side, no client-supplied count/delta is ever trusted (the one place a client tries to push counts is silently stripped, wasted traffic not a spoof vector), pending queue correctly distinguishes retryable/permanent failures and never fakes success, session isolation confirmed for `EngagementStore`/`FavoritesStore`/`ListingEngagementStore`.

**Profile:** self vs. visitor distinction, editing/persistence, avatar upload, premium badge (server-authoritative, confirmed via `public-profile` service and `hesabim_page.dart`), public/private field allowlisting (no phone/email/purchase-data leak), profile view counting (self-view genuinely excluded server-side for this domain), profile→message (correct counterpart), profile→listings (correctly visited-profile-scoped).

**Farmer Questions:** ownership enforcement for edit/delete is real and server-side (not just UI-hidden), answering someone else's question is a deliberate tested carve-out, like routes through the same server-authoritative engagement system as everywhere else.

**Knowledge Hub:** list/category/featured/latest, detail view, like — same engagement system, no distinct issue; founder-only content restriction is real and server-enforced via an email/ownerId allowlist.

**Listing:** create/idempotency (20/20 tests pass against current code, 5-way concurrency covered), photo upload, edit/delete (server-enforced ownership, force-overwritten owner fields), owner security (protected-fields allowlist applied uniformly), offline sync ownership check on *updates* (only the create-path gap in BUG-003 above), deactivate/republish deliberately removed as a documented product decision (not a regression), offer/message entry points both independently re-verify identity server-side (defense in depth, not just hidden buttons).

**Premium/Rocket:** restore-purchases (F2.3) confirmed current, publish-button label (F2.4) confirmed current, rocket activation's own entitlement/idempotency/ownership logic is correct in isolation (its only weakness is inheriting BUG-001's compromised credit source), account-switch premium isolation (`PurchaseStore.clearForSession()`) confirmed correctly wired, purchase double-charge guard (`_purchaseInFlight`) present, AI Pro gating requires both a real flag and `isPremiumActiveFromProfile` (also inherits BUG-001), logistics module gating is deliberately free/non-premium (by design, not a gap), premium badge privacy (raw purchase data never leaks to other viewers).

**Cross-account isolation (device-level):** `MessagesStore`, `OffersStore`, `NotificationStore`, `SupportStore`, `HubContentRepo`, `ProfileFollowStore`, `FavoritesStore`, `FavoriteProfilesStore`, `ProfileCommentsStore`, `PurchaseStore`, `EngagementStore` all confirmed correctly reset on every login/logout in `main.dart:_onSessionChanged`. Every store *not* in that list was confirmed safe by construction (data keyed fresh by current owner id on every read, not leftover) — except the two gaps called out in BUG-003 and BUG-012 above.

**Server authority / spoof resistance:** listing owner (force-overwritten from JWT identity), message receiver (re-derived from real thread/listing owner, N1.2 confirmed current), notification sender/target (self-target-only + domain-event server-side owner resolution, N1 confirmed current), offer status transitions (requester cannot accept/reject their own offer), engagement counts (delta is always a typed `1|-1`, never client-supplied, unique-constraint-protected against double-count) — all independently re-read and confirmed still correctly enforced, except the two gaps in BUG-001 and BUG-004 above.

---

## Final regression check (prior fixes)

All 11 previously-fixed items re-verified against **current** code (not just report existence) and confirmed **PRESENT**, none MISSING or REGRESSED:

| # | Item | Status |
|---|---|---|
| 1 | Forgot Password (AUTH-BUG-001) | PRESENT |
| 2 | Public Premium (PROFILE-BUG-002) | PRESENT |
| 3 | Messaging M1-M4 | PRESENT |
| 4 | Offer O1 | PRESENT |
| 5 | Permission S5A | PRESENT |
| 6 | Listing critical fixes | PRESENT |
| 7 | Rocket activation | PRESENT |
| 8 | Processed premium gate | PRESENT |
| 9 | Notification N1/N2 | PRESENT |
| 10 | Engagement E1/E2 | PRESENT |
| 11 | F1/F2 UX fixes | PRESENT |

Raw suite results (both repos, run to completion in this sweep):

| Suite | Result |
|---|---|
| Backend `npx tsc --noEmit` | Clean |
| Backend unit (`npm run test:unit`) | 31/31 pass |
| Backend integration (`npm run test:integration`) | 332/332 pass |
| Flutter `flutter analyze` | 0 errors (2 pre-existing, unrelated `unused_element` warnings) |
| Flutter `flutter test` | 290/290 pass |

**653/653 automated tests pass. Zero regressions of any prior fix.**

---

## MANUAL UAT REQUIRED (could not be verified by static/automated means)

- Actual SMTP email delivery for signup-welcome and temporary-password emails (deliverability, provider throttling, real prod credentials).
- Actual FCM push delivery timing/reliability on a real device, including cold-start tap after the app was fully killed by the OS, and behavior under Doze/battery-optimization.
- Location-permission OS dialogs (including "denied forever → app settings" branch).
- Real in-app-purchase round-trip through Google Play / App Store billing, including sandbox vs. production receipt differences.
- Google/Apple purchase webhook signature verification against real subscription lifecycle events (renewal/cancellation/refund).
- Photo upload under real flaky-network conditions with real files.
- Whether the production Strapi database's `agri-price-observations`/`agri-products`/`provinces` collections currently hold real data or are empty (would put every user into the disclosed mock-data banner state — this is a content/ops question, not a code defect).
- Third-party market-data API reliability at UAT time (TCMB, Bigpara, gold-api.com, etc. — code degrades gracefully if some are down, but worth watching live).
- FINAL-BUG-009's timing window (offer badge race) is easier to observe on a real device/cellular connection than on localhost.
- FINAL-BUG-006 and FINAL-BUG-010 are trivial to reproduce with two physical test accounts (unfavorite-then-recheck-count; open your own listing and check its view count) — good candidates for a quick manual confirmation alongside the code fix.
- Whether the `HUB_CONTENT_FOUNDER_EMAILS`/`FOUNDER_OWNER_IDS` env allowlist is actually populated correctly in the production Strapi environment.
