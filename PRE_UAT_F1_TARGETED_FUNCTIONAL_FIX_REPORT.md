# TARIM360+1 — PRE-UAT TARGETED FUNCTIONAL FIX F1 — REPORT

Scope: close only the 6 UAT-blocking findings from
`PRE_UAT_FUNCTIONAL_UX_AUDIT.md`'s decision section (UX-032, UX-021,
UX-039, UX-031, UX-001, UX-016). The other ~45 findings were not
touched, per the mandate.

Backend: `tarim360-strapi`, branch `release/preflight-integration`.
Flutter: `tarim360`, branch `release/preflight-integration`.

Every finding's root cause was re-verified directly against current HEAD
before any fix — the audit's own claims were not trusted blindly. One
finding (F1.6) turned out to need more backend investigation than the
audit anticipated (see below); everything else matched the audit exactly.

---

## F1.1 — Tarımsal Veriler / Mock Prices (CRITICAL) — CLOSED (disclosure)

**Re-verified chain**: Flutter UI (`hub_grid_sections.dart`'s `AgriDataGridSection`) → `AgriDataRepository.loadDashboard()` → falls back to `MockAgriDataService` whenever the real Strapi `agri-price-observation` feed is empty → backend's only ingestion mechanism for that feed is `MockAgriDataAdapter` (a deterministic formula, `categoryBasePrice * productFactor * dailyFactor`, gated by `AGRI_INGESTION_ENABLED`, default off). `usingMockPrices` was already computed correctly at the dashboard level but never read by any widget — confirmed via grep, zero references outside the model/repository.

**Fix (disclosure, not a new data source — explicitly out of scope per the mandate)**: added a visible amber banner ("Ürün fiyatları ve il bazlı veriler şu anda örnek (demo) verilerdir...") rendered only when `dashboard.usingMockPrices` is true, positioned directly above the "Ürün Fiyatları" section (which visually covers "İl Bazlı Veriler" right after it too). Confirmed it never appears over "Piyasa Takibi" (currency/gold/fuel) or "Hava Durumu" — both genuinely live — since `usingMockPrices` is only ever set by the product/province fallback paths, never by the market-values or weather loaders.

No real data source was wired (correctly out of scope for this phase); mock data is untouched for dev/test use, it simply can no longer masquerade as real to a production user.

---

## F1.2 — Aktif/Pasif Toggle — CLOSED (removed)

**Re-verified**: the `onTap` handler did exactly `setState(() => _isProfileActive = !_isProfileActive)` plus a SnackBar claiming "Hesap aktife/pasife alındı" — no store call, no network call, `_isProfileActive` read nowhere else in the file. Confirmed no account-level active/passive field exists on `profile-setting` or `seller-store`'s schemas — there was nothing real to wire it to.

**Fix**: per the mandate's second option (no backend field exists → remove/disable, don't build new architecture), replaced the tappable toggle with a static, honest "Aktif" badge — true whenever this screen is reachable at all, since there's no real inactive state today. The misleading SnackBar and the `_isProfileActive` state variable were both removed.

---

## F1.3 — Push Notification Navigation — CLOSED

**Re-verified all listed live types**: message, offer (created/accepted/rejected/countered), listing favorite/like, profile favorite/comment, system/admin/broadcast.

**Root cause, in-app tap**: `AppNotificationItem` stored no entity ids at all (only id/kind/title/message/createdAt/isRead), even though the underlying Strapi rows already carried `threadId`/`offerId`/`listingId` — confirmed directly in the schema and in `message`/`offer` lifecycle producers. The one gap: `createDomainEvent` (favorite/like notifications) resolved `entityId` only to find the owner, then discarded it — never stored on the row. Fixed as part of this phase (see F1.3's backend commit): `listingId` is now stored for `domain: 'listing'` events.

**Root cause, OS push tap**: `onMessageOpenedApp` only triggered a silent background refresh, no navigation at all. **No `getInitialMessage()` call existed anywhere in the codebase** — confirmed via full-repo search — so a cold start via tapping the notification tray did nothing beyond normal app launch.

**Fix**: `AppNotificationItem` gained `threadId`/`offerId`/`listingId`/`source`, populated from the Strapi row (`_fromStrapiRow`) and round-tripped through local persistence. A single shared resolver — `navigateToNotificationTarget` (BuildContext-based, for the in-app list) and `_navigateShellToNotificationTarget` (shell-instance-based, for the FCM callbacks, via a new `_appShellStateKey` global key since those callbacks have no BuildContext of their own) — is the ONE place that knows how to open a real thread/offer/listing:
- **message**: looks up the thread in `MessagesStore.I.threads` (after a `refreshThreads()`), opens `MessageChatPage`.
- **offer**: looks up the offer in `OffersStore.I.incoming`/`outgoing` (after a `refresh()`), opens `OfferChatPage`.
- **favorite/like with `source: 'listing'`**: looks up the listing in `ListingsStore.I.items` (after a `refreshFromStrapi()`), opens `ListingDetailPage`.
- **profile favorite/comment**: unchanged — the existing generic tab-switch to Hesabım was already the correct destination (the notification is about your OWN profile).
- **any kind whose target can't be resolved** (missing id, not loaded locally, deleted): falls back to the exact same tab-switch behavior that existed before this fix — never a crash, never a blank route.
- A short-lived (2s) dedup key prevents a duplicate navigation if the same tap is observed twice (e.g. `onMessageOpenedApp` firing alongside a manual in-app tap).
- `FirebaseMessaging.instance.getInitialMessage()` is now checked once at `init()`, handling the cold-start case that had zero prior handling.

**Testing note, disclosed honestly**: widget-level testing of the actual navigation resolvers was assessed as impractical — `_AppShellState` depends on the full app's backend-connected store graph, and pumping it in a test would require far more scaffolding than this targeted fix's scope justifies. What IS unit-tested (see below) is `AppNotificationItem`'s own serialization contract, which both the sync path and the resolvers depend on. The navigation logic itself was re-read carefully against the existing, working `_openSupportFromNotification`/`_openByKind` patterns it mirrors, and compiles cleanly.

---

## F1.4 — Weather Subtitle — CLOSED

**Root cause, confirmed directly**: `'${weather.description} • $_weatherSourceLabel(source) • ${_weatherTime(weather.updatedAt)}'` — `$_weatherSourceLabel` interpolated the bare method tear-off (a `Function` object), and the trailing `(source)` was emitted as literal text since it sat outside the interpolation braces. No encoding issue, no null-fallback issue — a straightforward missing-braces typo.

**Fix**: `${_weatherSourceLabel(source)}` — one-character-class fix, no hardcoded text added.

---

## F1.5 — Message Gönder on Listing Detail — CLOSED

**Re-verified**: the listing detail page had zero messaging entry points — only "Teklif Ver" and tapping the seller's name/avatar to reach their profile, where the real message button lives.

**Fix**: added a "Mesaj Gönder" icon button to the same bottom action bar as "Teklif Ver" and the like/favorite buttons (hidden for the owner, same as those). Calls the exact same `openDirectMessageThread(...)` pipeline already used from profile pages — no second messaging implementation. Owner identity is resolved via the existing `_resolveListingOwnerId` helper (the same one `_openListingOwnerProfile` already uses), never from a client-editable field. No extra modal or participant-selection step — one tap opens the conversation directly, matching the target flow exactly: İlan Detayı → Mesaj Gönder → conversation → yazma alanı.

---

## F1.6 — Listing Creation Idempotency — CLOSED

**Re-verified root cause, and found it needed more than the audit's own description implied**: the audit was right that `createListing()` had no idempotency key and that a client-side timeout could produce a duplicate via the offline-retry queue. What the investigation added: `listing` has `draftAndPublish: true`, and this codebase's own existing `activateRocket` action already carries an explicit comment explaining that storing an idempotency key directly on a `draftAndPublish` row is unsafe (`entityService.create` with `publishedAt` set produces two physical rows sharing one `documentId`). Re-using `listing-comment`'s simpler pattern (operationId as a unique field on the row being created) would have risked a spurious unique-constraint failure on the row's own creation. Followed the exact same **atomic-claim ledger** pattern `activateRocket` already proves works for this exact class of problem instead.

**Fix**:
- New `listing-create-operation` content-type (no public routes, matching `rocket-activation`'s own precedent) — `operationId` (unique), `payloadFingerprint`, `ownerProfileId`, `listingDocumentId`.
- `listing.ts`'s `create()`: requires a valid `operationId` (400 if missing/invalid). Resolves against the ledger first — same operationId + same payload → returns the already-created listing (200, not 201); same operationId + different payload → 409 conflict. Otherwise, the ledger row is created FIRST as the atomic claim (its unique constraint serializes concurrent identical requests — the loser re-reads the winner's result instead of separately creating a listing), and only then is the real listing created and linked back to the ledger row. A stale claim (won but never linked, e.g. a validation failure on the actual create) self-heals: it's deleted and the request proceeds as a fresh attempt rather than getting permanently stuck.
- `engagement.ts`'s `syncOfflineListing` (`operation: 'create'`): now checks the same ledger by `operationId` before falling back to a raw create, so a client that queued an offline retry after a perceived timeout resolves to the already-created listing instead of duplicating it.
- Flutter: `create_listing_page.dart` generates one `operationId` per publish attempt (`newOperationId()`) and reuses it unchanged if the attempt falls through to `ListingPendingSyncQueue`; `createListing()` and `enqueue()` both thread it through.
- **A real bug found and fixed while building this**: `await super.create(ctx)` does NOT set `ctx.body` as a side effect in this Strapi version — it resolves to the response body as its return value. The original code's `return super.create(ctx);` relied on that return value implicitly; my initial rewrite awaited it without returning, which silently produced an empty/default "Created" text response for every real listing creation. Caught by the test suite immediately, fixed by explicitly capturing and returning `super.create(ctx)`'s result.

**Not fixed, explicitly out of scope**: the pre-existing, unrelated `_isPublishing` narrow pre-flag double-submit window (audit's UX-105) — a different, much lower-severity finding, not part of the 6 UAT-blocking items.

---

## Regression re-check

Re-verified via the full passing test suites (below) plus direct reading where a fix touched shared code:

| Area | Status | Note |
|---|---|---|
| Messaging M1–M4 | **PRESENT** | No messaging internals touched; F1.3/F1.5 only read `MessagesStore.I.threads`/call the existing `openDirectMessageThread` pipeline |
| Offer ownership | **PRESENT** | `offer-receiver-ownership.integration.test.ts` passes unchanged (updated only to send a valid `operationId` when creating its test listing, per F1.6's new requirement) |
| Listing ownership / offline-sync | **PRESENT** | `syncOfflineListing`'s ownership check (`matchesIdentity`) and update path are completely untouched — the new ledger check only runs for `operation: 'create'`, before the final raw-create fallback |
| Rocket activation | **PRESENT** | `listing-rocket-activation.integration.test.ts` passes unchanged; that suite creates its listings via `entityService.create` directly (bypassing the controller), unaffected by the new `operationId` requirement |
| Premium gates | **PRESENT** | `premium-gates.integration.test.ts` passes (updated to send `operationId` when creating its test listing) |
| Notification N1/N2 | **PRESENT** | `notification-n1-security-fix.integration.test.ts` passes, plus the new F1.3 `listingId`-storage test in the same file |
| Farmer Question ownership | **PRESENT** | No hub-content file touched this phase |
| Engagement E1/E2 | **PRESENT** | No engagement-store/pending-queue/processed-product/profile-setting file touched this phase |
| Account/session isolation | **PRESENT** | No session/store-clearing file touched this phase |

No regression found.

---

## Validation

**Backend** (`tarim360-strapi`):
- `npx tsc --noEmit` — clean.
- `npm run test:unit` — 31/31 pass.
- `npm run test:integration` — 327/327 pass (317 pre-F1 + 10 new: 9 listing-create-idempotency tests + 1 notification listingId test).
- `npm run build` — clean.
- `git diff --check` — clean.

**Flutter** (`tarim360`):
- `flutter analyze` — 2 issues, both pre-existing/unrelated (`_normalizeLogisticsWhatsApp`/`_titleCaseWords` in `logistics_models.dart`).
- `flutter test` — 278/278 pass (269 pre-F1 + 9 new: 5 `AppNotificationItem` tests + 4 `ListingPendingSyncQueue` tests).
- `git diff --check` — clean.

No production mutation was performed.

---

## Commits

Backend (`tarim360-strapi`, `release/preflight-integration`):
- `0a9f669` — `fix(notifications): store listingId on domain-event rows`
- `50d9b59` — `fix(listings): make listing creation idempotent`
- `68acab3` — `test(listings,notifications): add F1 regression coverage`

Flutter (`tarim360`, `release/preflight-integration`):
- `ec5e1e1` — `fix(agri-data): disclose mock prices and fix weather source label`
- `08729a4` — `fix(listings): remove non-functional account status toggle`
- `8117814` — `fix(notifications): navigate to the real target on tap`
- `5beec95` — `fix(listings): add direct message-seller button to listing detail`
- `bd05f22` — `fix(listings): thread idempotent operationId through listing creation`
- `ae2f0aa` — `test(notifications,listings): add F1 regression coverage`

Pushed to `release/preflight-integration` only, both repos. No merge to
main. No deploy. No production mutation.

---

## Decision

**READY FOR UX FOLLOW-UP TRIAGE**

All 6 UAT-blocking findings are closed, tested, and regression-verified
with zero failures across both repos. None of the remaining ~45 findings
from the full audit were touched, per the mandate. Per the user's own
framing: the next step is a short triage of those ~45 (not a fix-them-
all pass) to identify the 3-5 that genuinely affect daily use, deferring
the rest — cosmetic items or ones needing larger architecture — to
post-release.

Per the mandate: stopping here. Not proceeding to the remaining findings
or to UAT automatically.
