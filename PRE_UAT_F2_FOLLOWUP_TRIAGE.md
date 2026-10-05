# TARIM360+1 — PRE-UAT UX FOLLOW-UP TRIAGE F2

READ-ONLY. No code changed, no commits, no push, `main` untouched, no
UAT started. Both repos re-verified on `release/preflight-integration`
at current HEAD (backend `68acab3`, Flutter `ae2f0aa` — both in sync
with `origin`, no ahead/behind).

Reference: `PRE_UAT_FUNCTIONAL_UX_AUDIT.md`, `PRE_UAT_F1_TARGETED_FUNCTIONAL_FIX_REPORT.md`.

---

## F1 regression checklist (all confirmed PRESENT, re-verified directly against current HEAD, not assumed)

| Item | Status | Evidence |
|---|---|---|
| Demo veri etiketi | **PRESENT** | `_AgriMockDataBanner` renders whenever `dashboard.usingMockPrices` is true (`hub_grid_sections.dart:1696-1697`) |
| Sahte Aktif/Pasif buton kaldırılmış | **PRESENT** | Zero remaining references to `_isProfileActive` anywhere in `general_listing_management_page.dart` (confirmed via grep) |
| Push tap navigation | **PRESENT** | `onMessageOpenedApp` calls `_handleRemoteMessageTap` (`push_messaging_service.dart:97`) |
| Cold-start push navigation | **PRESENT** | `FirebaseMessaging.instance.getInitialMessage()` checked in `init()` (`push_messaging_service.dart:106-108`) |
| Weather subtitle düz | **PRESENT** | `${_weatherSourceLabel(source)}` correctly wrapped in interpolation braces (`hub_grid_sections.dart:1474`) |
| Listing detail Message button | **PRESENT** | `_openMessageSeller` wired to a chat-bubble icon button in the bottom action bar (`listing_detail_page.dart:237,680`) |
| Listing create idempotency | **PRESENT** | `listing.ts`'s `create()` requires/validates `operationId` against the `listing-create-operation` ledger (confirmed via grep + the 9 passing F1.6 tests) |

No regression in any F1 fix.

---

## Triage table

Severity carried over from the original audit unless noted. Decision
classes: **A** = fix before UAT, **B** = should fix before release, **C**
= defer, **D** = manual UAT only, **E** = not a bug / already closed.

### 1 — Messaging

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-002 | Messaging | MEDIUM | `message_chat_page.dart` `_send()` | Can't compose a 2nd message while the 1st is sending | **C** | Real friction, but requires a slow send to notice; not the primary UAT flow-breaker | Small (per-message in-flight tracking instead of one page flag) |
| UX-003 | Messaging | HIGH | `message_chat_page.dart`/`messages_page.dart` polling | 10s (open chat) / 20s (list) polling lag on replies/read-receipts/reordering — directly the "WhatsApp gibi akıcı mı" question this whole audit chain was built around | **A** | Two real UAT testers messaging back and forth will directly feel this lag; it risks the UAT session itself reading as "messaging feels slow/broken" even though the underlying pipeline (send/retry/read-receipt) is solid | Small, safe, cheap mitigation only: shorten the open-chat poll interval (10s→3-5s); do NOT attempt a websocket/realtime rewrite here |
| UX-004 | Messaging | LOW | `messages_store.dart` first-thread creation | First message to a brand-new contact is measurably slower (2 sequential avatar lookups + createThread + sendMessage) | **C** | Narrow (once per new contact), optimistic bubble already masks it visually | Small (`Future.wait` the two avatar lookups) if ever picked up |

### 2 — Offers

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-005 | Offers | HIGH | `offers_store.dart:570` | Seller's unread-offer badge resets to the full incoming count on every refresh, not genuinely-unseen count | **B** | Highly visible during any offer-flow UAT pass, cheap and safe to fix (parse `seenBy` already written server-side) | Small-medium (parse `seenBy`/`seenAt` into `OfferItem`, recompute unread) |
| UX-006 | Offers | MEDIUM | `create_offer_sheet.dart` | No quantity field when making an offer, despite full model/schema/card wiring for it | **C** | Real gap but a product-scope question (was quantity intentionally dropped?) — needs a decision, not just code | Medium (add field + wire through) or trivial (strip dead plumbing) depending on the decision |
| UX-007 | Offers | HIGH → **CLOSED** | `notifications_page.dart` | Tapping an offer notification only switched tabs | **E** | F1.3's shared notification-target resolver now opens `OfferChatPage` for offer notifications by `offerId` — this exact gap is closed | none |
| UX-008 | Offers | LOW | `offer_card_x.dart` | No persistent "message about this offer" button on cards | **C** | Minor convenience gap; the accept-flow chat entry point still works | Small (add a chat icon to the card's action row) |

### 3-4 — Profile / Auth / Settings / Account

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-009 | Profile | HIGH | `profile_edit_page.dart` `_save` | A profile edit can silently revert on next cold start if the sync call fails at exactly the wrong moment | **C** | Requires a transient network failure precisely at save time — unlikely to manifest in a short, well-connected UAT session, but real and worth fixing post-release | Medium (defer local mutation until server confirms, or add a persistent retry state) |
| UX-010 | Auth/Settings | LOW | dead code | Unreachable OTP signup-verification screen still compiled in | **C** | Zero user-facing impact; pure cleanup | Trivial (delete) |
| UX-011 | Auth/Settings | LOW | `settings_page.dart` | Account deletion has no typed confirmation for an irreversible action | **C** | Real product-hardening idea, not a defect blocking UAT | Small (add a typed-confirmation step) |

### 5 — Premium / Rocket

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-012 | Premium | HIGH | `purchase_coordinator.dart` `restorePurchases` | Restore Purchase always shows the same message regardless of whether it actually found/restored anything | **B** | If a UAT tester tries Restore Purchase, the message they see will be actively misleading either way; cheap, safe, isolated fix | Small (branch on `PurchaseStore.I.activePremium` after the existing wait) |
| UX-013 | Premium | MEDIUM | `purchase_store.dart`/`session_profile_store.dart` | Expired premium can still show "Premium Üye" on own profile | **C** | Requires premium to actually expire/be revoked mid-test — unlikely in a short UAT window | Small (add the missing `else` branch) |
| UX-014 | Premium | LOW | `payment_status_page.dart` | Lifetime premium shows "-" instead of "Süresiz" on one diagnostic screen | **C** | Cosmetic, low-traffic screen | Trivial (reuse the existing "Süresiz" label) |
| UX-015 | Premium | MEDIUM | `purchase_store.dart` sync retry | A purchase that succeeds on-device but never syncs to Strapi (app killed mid-retry) has no disk-persisted recovery | **D** | Genuinely needs a real purchase + a forced-kill scenario on a device to evaluate risk in practice | Medium (persist a pending-sync marker) |

### 6-7 — Listing Creation / Detail / Management

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-017 | Listing Creation | MEDIUM | `create_listing_page.dart` publish button | Button says "Denetime Gönder" (send for review) but the listing goes live instantly | **B** | Every UAT tester creating a listing sees this label; trivial, zero-risk fix (label only, or gate behind `pending` if moderation is truly wanted — recommend the label fix only for this phase) | Trivial (relabel to "İlanı Yayınla") |
| UX-018 | Listing Creation | MEDIUM | `strapi_service.dart` `uploadImages` | No upload progress; a failure discards already-uploaded photos | **D** | Actual felt impact depends on real network speed on a device | Medium (progress reporting + retry-keeps-photos) |
| UX-019 | Listing Creation | LOW | `create_listing_page.dart` `_pickPhoto` | No gallery multi-select, one photo at a time | **C** | Workflow still completes, just slower | Small (`pickMultiImage` entry point) |
| UX-020 | Listing Creation | LOW | `create_listing_page.dart` `_publish` | Narrow theoretical double-submit window before the guard flag is set | **C** | Not confirmed reproducible; existing quota dialog mitigates the realistic case | Trivial (move flag-set earlier) |
| UX-022 | Listing Detail | MEDIUM | `listing_detail_page.dart` | No Edit/Roketle button on the detail page itself, only in management screens | **C** | A working path exists (management screen); convenience gap, not a block | Small (add both buttons, reuse existing handlers) |
| UX-023 | Listing Detail | MEDIUM → **RESOLVED** | `general_listing_management_page.dart` | No reversible pause for a listing | **E** | Confirmed already a deliberate, disclosed product decision (a misleading "Pasife Al" entry was already removed on purpose) — not an oversight | none |
| UX-024 | Listing Detail | MEDIUM | `listing_detail_page.dart` stats card | Offer count reads from a legacy store, feels slightly less "live" than like/favorite/view | **C** | Cosmetic consistency only, no wrong data | Medium (migrate to `EngagementStore`) |

### 8 — Farmer Questions

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-025 | Farmer Questions | HIGH | `farmer_question_detail_page.dart` | No edit/delete for your own question after posting | **C** | Real gap, but a UAT tester posting a test question doesn't typically need to correct it mid-session; workaround (account deletion) exists | Medium (add an owner-only delete action, reusing the existing archive pattern) |
| UX-026 | Farmer Questions | HIGH | `notifications_page.dart` | Question comment/like notification tap doesn't open the question | **C** | Moot in practice until UX-042 (the notification itself doesn't fire) is addressed — bundling these two is the sensible unit of work if ever picked up | Medium (needs UX-042's author-identity field first) |
| UX-027 | Farmer Questions | LOW | `farmer_question_detail_page.dart` | "Şikayet et" shown even to the question's own owner | **C** | Trivial cosmetic oddity | Trivial (wrap in an owner check) |

### 9 — Knowledge Hub

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-028 | Knowledge Hub | MEDIUM | whole feature | No search, only category chips | **C** | Product-scope question; category browsing still works | Medium (client-side title/description filter) |
| UX-029 | Knowledge Hub | MEDIUM | detail pages | Date/read-time shown on cards vanish on detail | **C** | Minor information-completeness gap | Small (carry the same metadata row into detail) |
| UX-030 | Knowledge Hub | MEDIUM | `HubContentRepo.fetchList` | A failed fetch looks identical to a genuinely empty hub | **D** | Only visible if a real fetch failure happens during UAT — network-condition-dependent | Medium (surface a failed-refresh signal to the UI) |

### 10 — Agricultural Data

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-033 | Agri Data | MEDIUM | market/product/province cards | No staleness ("last updated") indicator | **C** | Now that F1.1's disclosure banner exists for mock data, this is a smaller residual polish item for the genuinely-live fields | Small (render the already-populated `updatedAt`) |
| UX-034 | Agri Data | LOW | `market.ts` scrapers | Some currency/fuel fields depend on fragile HTML scraping with no monitoring | **D** | Operational/data-quality risk, not something a short UAT session will surface either way | Medium (add a scrape-health alert) — operational, not a UAT blocker |

### 11 — Search / Filter / Discovery

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-035 | Search | MEDIUM | `category_listings_page.dart` | Filtered-to-zero looks identical to genuinely-empty category | **C** | Minor confusion, workaround (manually clear filters) is discoverable | Small (distinct message + clear-filters button) |
| UX-036 | Search | MEDIUM | `search_listings_page.dart` | Rocket badge shown but not prioritized in keyword search specifically | **C** | Inconsistent, not deceptive (badge still shown); monetization-polish item | Small (reuse existing roketli-first sort) |
| UX-037 | Search | LOW | `listings_store.dart` pagination | "Daha Fazla Göster" can show once extra at the end | **C** | Harmless extra tap | Medium (needs a real server total) |

### 12 — Notifications

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-038 | Notifications | HIGH → **PARTIALLY CLOSED by F1.3** | `notifications_page.dart` | In-app tap for message/offer/listing-favorite-like now opens the real target (F1.3); logistics-load/processed-product domain-events and comment-on-profile still only switch tabs (the latter is already the CORRECT destination, not a gap) | **C** | Residual gap is now narrow (2 less-common domains); the highest-traffic notification types (message, offer, listing) are fixed | Small (extend F1.3's resolver's `favorite`/`like` branch to also handle `logistics_load`/`processed_product` sources) |
| UX-040 | Notifications | MEDIUM | `notification.ts`/`offer.ts` copy | Backend notification titles/bodies are ASCII-only (broken Turkish diacritics), visible on every domain-event/offer notification | **B** | Every UAT tester will see multiple notifications during testing; purely a string-constant fix, zero logic risk | Small (re-key the constant strings with correct diacritics) |
| UX-041 | Notifications | MEDIUM | `main.dart` `_selectTab` | Offers/Messages tabs don't clear their own unread notification badge on view (Support tab does) | **B** | Cheap, safe, mirrors an already-proven pattern in the same function; a tester reading a message/offer in its own tab and still seeing it "unread" in the bell is a likely UAT observation | Trivial (call the existing `markReadForKinds` in the same two tab-entry branches) |
| UX-042 | Notifications | MEDIUM | `farmer_question_models.dart` | Farmer-question-answered notifications don't fire at all (disclosed N1-era trade-off) | **C** | Already explicitly disclosed and accepted; needs a real backend identity field, not a quick patch | Medium-large (new hub-content author-identity field + dedicated resolver) |

### 13 — Navigation / Back Stack

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-043 | Navigation | MEDIUM | essentially every card `onTap` | Rapid double-tap can push the same detail screen twice | **C** | Plausible but not guaranteed during UAT; the "fix" as scoped touches many call sites, bigger than a quick patch | Medium (shared navigate-once guard at the highest-traffic entry points) |

### 14 — Performance (static only)

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-044 | Performance | HIGH | `main.dart` `AppShell` | Background tabs keep polling forever once visited (battery/data cost) | **D** | Real but only observable over a longer session than a typical UAT pass | Medium (pause/resume timers on tab (in)activity) |
| UX-045 | Performance | MEDIUM | `home_page.dart` | 5 home refreshes run sequentially instead of in parallel | **D** | Perceived home-load speed needs a real device to judge severity | Small (`Future.wait` the independent calls) |
| UX-046 | Performance | LOW | `home_page.dart` popular rail | Full recompute on every unrelated engagement tick | **D** | Only matters on lower-end devices/larger catalogs; needs device measurement | Medium (debounce/cache the aggregation) |

### 15 — Loading / Empty / Error / Offline States

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-047 | Error/Offline | MEDIUM | app-wide | No offline/connectivity detection anywhere | **D** | Directly relevant to this app's real rural-connectivity user base, but its actual UAT impact depends entirely on the testers' real network conditions — worth explicitly testing (e.g. airplane-mode pass) rather than guessing | Medium (connectivity check + shared banner) |
| UX-048 | Error/Offline | MEDIUM | `messages_store.dart`/`strapi_service.dart` | Some backend errors show raw/technical text in chat | **D** | Only visible on an actual error; severity depends on which errors actually occur during UAT | Small (always fall back to a generic Turkish message) |
| UX-049 | Error/Offline | MEDIUM | `search_listings_page.dart` | A failed search looks identical to a genuine empty result | **D** | Same — only visible on a real search failure | Small (track a failed-search flag) |
| UX-050 | Error/Offline | LOW | Messages/Notifications/Farmer Questions lists | Brief empty-state flash before the first fetch completes, on every cold start | **C** | Reliably reproducible (not network-conditional) but very brief and low-stakes | Small (reuse Knowledge Hub's `_initialLoading` pattern) |
| UX-051 | Error/Offline | LOW | `home_page.dart` | Generic empty tiles if backend is down on first launch, no distinct signal | **D** | Network-condition-dependent, same as UX-047 | Small (a single dismissible retry banner) |

### 17 — Cross-Account / Session UX

| ID | Feature | Severity | Live caller | User impact | Decision | Reason | Est. fix scope |
|---|---|---|---|---|---|---|---|
| UX-052 | Session UX | LOW → **CONFIRMED SAFE** | `session_profile_store.dart` | Not in the explicit session-clear sweep | **E** | Proven safe by construction (ownerId-keyed cache) — no real defect, purely a hygiene/consistency note | none |

---

## Summary counts

| Class | Count | Items |
|---|---|---|
| **A — Fix before UAT** | **1** | UX-003 |
| **B — Should fix before release** | **5** | UX-005, UX-012, UX-017, UX-040, UX-041 |
| **C — Defer** | **26** | UX-002, 004, 006, 008, 009, 010, 011, 013, 014, 019, 020, 022, 024, 025, 026, 027, 028, 029, 033, 035, 036, 037, 038, 042, 043, 050 |
| **D — Manual UAT only** | **11** | UX-015, 018, 030, 034, 044, 045, 046, 047, 048, 049, 051 |
| **E — Not a bug / already closed** | **3** | UX-007, UX-023, UX-052 |

Total = 46, matching the audit's own "~45 remaining" count.

---

## Proposed scope if the user wants to close A + a subset of B now

Per the mandate, no code was touched this phase. If closing before UAT is
wanted, the smallest-risk, highest-visibility subset is:

1. **UX-003 (A)** — shorten the open-chat poll interval from 10s to
   3-5s. One constant change, no architecture change, directly addresses
   the audit chain's own top stated priority (WhatsApp-like feel).
2. **UX-017 (B)** — relabel the publish button from "Denetime Gönder" to
   "İlanı Yayınla". One string, zero logic change.
3. **UX-041 (B)** — call the existing `markReadForKinds` inside the
   Offers/Messages tab-entry branches in `_selectTab`, mirroring the
   Support tab's already-proven pattern exactly. Two lines.
4. **UX-040 (B)** — re-key the backend's ASCII notification title/body
   constants with correct Turkish diacritics. String-only change,
   `notification.ts`/`offer.ts`.
5. **UX-005 (B)** and **UX-012 (B)** are the two B items with slightly
   more real logic (parsing `seenBy` into `OfferItem`; branching
   `restorePurchases()`'s return message) — still small and low-risk,
   but not one-liners like the above three.

Not implemented in this phase — proposal only, per the mandate.

---

## Decision

**READY FOR SMALL F2 FIX**

One A-class item (messaging polling latency — directly the thing this
entire audit chain was built to protect) and five small, low-risk
B-class items remain that are worth closing before real-device UAT
given how cheap and safe they are relative to their visibility. The
other 40 items are genuinely deferrable — either narrow edge cases (C),
dependent on real device/network conditions to even evaluate (D), or
already confirmed non-issues (E).

Per the mandate: stopping here. No code changed, no commits, no push,
`main` untouched, no UAT started.
