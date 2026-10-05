# Semantic Contract Audit — Phase S3: Remaining MEDIUM + LOW Triage (READ-ONLY)

**Date:** 2026-08-10
**Reference:** `BACKEND_FLUTTER_SEMANTIC_CONTRACT_AUDIT.md`, `SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md`, `SEMANTIC_CONTRACT_S2_HIGH_FIX_REPORT.md`
**Mode:** Read-only. No code changed, no commit created, no push. Both repos left exactly where S2 left them (`fix/semantic-contract-s2-high`, backend HEAD `ff47226`, Flutter HEAD `b4329c5`; `offer.ts` WIP unchanged).

---

## 2.6 — Favorilerim sayfası: dual+legacy write

**Still present on current HEAD? NO — already closed.** Not a new fix; a byproduct of S2's 2.5 work.

Re-read `favorites_page.dart:605-643` (`_toggleFavoritesPageListingFavorite`, current line numbers shifted from the audit's original 601-639 reference): the function now calls `FavoritesStore.I.addListingLocal/removeListingLocal` (local mirror only, zero backend calls) instead of the old `FavoritesStore.I.add/remove` that used to trigger `ListingEngagementStore.registerFavorite`'s raw PATCH. The only backend call left in the function is the single `EngagementStore.I.toggleFavorite(target)`. The dual-write this item was about no longer exists — it was eliminated as part of S2's `fix: remove remaining legacy listing metric writes` commit (`94c806f`), which changed exactly this call site for a different named reason (2.5) but happened to fully close 2.6 too.

**Classification: not applicable — CLOSED.** No action needed in S3 or S4.

---

## 2.8 — Approved Ads: "İzlenme" label is click-derived, not real video-view data

1. **Still present?** Yes, in the code. The mechanism is unchanged: `videoViews` (schema field) and `izlenmeCount` have **zero writers anywhere in the backend** (confirmed by grep — both names appear only in `ad.ts`'s S2.4 protected-fields strip list and the schema definition, never in an `entityService`/`db.query` write call). `approved_ads_repo.dart:213-222`'s fallback chain (`videoViews → views → viewCount → izlenmeCount → watchCount`) still resolves to `viewCount` for any video-typed ad, displayed under the "İzlenme" label in `main.dart`.
2. **Backend file/function/line:** `ad/content-types/ad/schema.json` (fields `videoViews`, `izlenmeCount`, no writer); `ad-event/controllers/ad-event.ts` (only writer of `viewCount`, now gated behind `eventType==='impression'` since S2.2 — a path no live Flutter caller reaches).
3. **Flutter file/function/line:** `lib/features/approved_ads/repositories/approved_ads_repo.dart:213-222`; label rendered in `main.dart` (~line 3708, unchanged).
4. **Live caller?** No, currently — re-verified beyond the original audit's own check: `ApprovedAdsStore.refresh()` (`approved_ads_store.dart:159-168`) short-circuits entirely when `AppFeatureFlags.enableSmartAds == false` (its current, compile-time value) — clears local state and returns **before ever calling the repo/backend fetch**. The whole Approved Ads read path, not just the write path, is dormant today.
5. **Real user impact today:** none — the screen this label lives on is unreachable in the shipped app.
6. **Data loss / wrong data / UI inconsistency / tech debt?** UI-label inconsistency only, and only if/when the feature ships — never data loss, never a wrong financial number.
7. **Production trigger probability:** effectively zero while `enableSmartAds=false`. If the flag ever flips on, the number shown would most likely read `0` for most ads today (post-S2.2, nothing currently increments `viewCount` in live traffic either) — misleading only in *label*, not in an inflated magnitude anymore (S2.2 incidentally reduced this item's severity).
8. **Test coverage:** none.
9. **Fix scope if done:** either relabel ("Açılma" instead of "İzlenme") or build real video-view tracking — the second is a product/infra decision (does a video player emit real watch-progress events at all today?), not a mechanical fix.
10. **Side-effect risk:** low either way; a relabel is copy-only, a real tracker is new infra.

**Classification: D — Tech debt / no user impact.** Entire feature area is flag-gated off; nothing to fix under release pressure. Worth a one-line product note for whoever eventually flips `enableSmartAds` on, not a code task now.

---

## 2.10 — Logistics `moderationStatus`: missing-value default inverted

1. **Still present?** Yes, unchanged. `logistics_admin_store.dart:86-97` (`LogisticsAdminLoadReviewRecord.fromMap`): `moderationStatus.isEmpty ? 'approved' : ...`. Backend: `logistics-load/content-types/logistics-load/schema.json:177-180` (`enum:[...], default:"pending"`) and `logistics-admin.ts:106-107,139-140` (`load.moderationStatus || 'pending'`) both still treat missing as `"pending"`.
2. **Backend file/function/line:** as above.
3. **Flutter file/function/line:** `lib/features/logistics/stores/logistics_admin_store.dart:86-97` (load), and the vehicle equivalent nearby (audit's `:207-209`).
4. **Live caller?** Yes, confirmed — `LogisticsAdminLoadReviewRecord.fromMap` is invoked from a real remote-refresh call inside `LogisticsAdminStore` (line ~456), which backs the actual `logistics_admin_page.dart` admin screen (`LogisticsAdminStore` is referenced from `main.dart` and the logistics detail/list pages too).
5. **Real user impact:** admin-facing only, not end-customer-facing. If it fires, an admin reviewing loads/vehicles would see a record marked "approved" (skipping the "İncelemede" review queue) when the backend actually considers it unreviewed.
6. **Data loss / wrong data / UI inconsistency / tech debt?** UI-inconsistency with a moderation-integrity angle — not data loss (nothing is overwritten), but a genuinely wrong status read.
7. **Production trigger probability: unconfirmed, could not be verified from this environment (no production DB access).** The only way to reach an empty `moderationStatus` today is a legacy row predating the schema default, or a direct DB write bypassing Strapi's ORM — `entityService.create` always applies the schema default on any normal path. This is the one item in this triage where "is it actually live in prod" is a real open question rather than something confirmable by reading code.
8. **Test coverage:** none.
9. **Fix scope:** small — mirror the same `?? 'pending'` semantics Flutter already has correct in `logistics-admin.ts`'s own backend fallback; one string literal change plus the vehicle equivalent.
10. **Side-effect risk:** low — purely a display-default correction, no write path touched.

**Classification: C — Safe to defer, but flagged for a one-time data check.** Recommend running a single read-only query (`SELECT COUNT(*) FROM logistics_loads WHERE moderation_status IS NULL OR moderation_status = ''` and the vehicle equivalent) against production before the next release decision — if that count is 0, this is pure tech debt (reclassify D); if non-zero, promote to B next phase given the moderation-integrity angle. Not blocking this release either way — the fix is one line and can ride along with the next touch to this file.

---

## 2.12 — Purchase history: empty categoryTitle/planTitle drops the whole record

1. **Still present?** Yes, unchanged. `purchase_store.dart:794-802` (`_toPurchaseRecordList`): `if (categoryTitle.isEmpty || planTitle.isEmpty) continue;` — silently skips the entire record (price, date, transactionId included).
2. **Backend file/function/line:** `src/api/purchase/controllers/purchase.ts:65-66` — `asString(body.categoryTitle) || 'Bilinmeyen Kategori'`, `asString(body.planTitle) || 'Bilinmeyen Plan'` — confirmed still always writes a non-empty fallback string, never a genuinely empty value, on every live write path through this controller.
3. **Flutter file/function/line:** as above.
4. **Live caller?** Yes, the parsing function runs on every profile refresh — but the emptiness *trigger condition* has no live writer today (same class of bug as the already-fixed `activePremium.planTitle` issue from an earlier phase, per the audit's own comparison).
5. **Real user impact today:** none confirmed — would only fire on a legacy/malformed JSON blob or an out-of-band (e.g. Strapi admin panel manual edit) purchase record.
6. **Data loss / wrong data / UI inconsistency / tech debt?** **Silent, complete record loss** if triggered — the most severe *failure mode* of the three dormant "empty-field-drops-whole-record" items (2.12/2.13/2.14), even though its *trigger likelihood* is currently as low as the others.
7. **Production trigger probability:** low, same reasoning as 2.10 — no live write path produces the empty value; only reachable via legacy data or manual edit.
8. **Test coverage:** none.
9. **Fix scope:** trivial — fall back to the same `'Bilinmeyen Kategori'`/`'Bilinmeyen Plan'` labels Flutter already uses correctly elsewhere in this file, instead of `continue`-ing past the whole record.
10. **Side-effect risk:** minimal — purely additive (shows a record that was previously invisible), cannot make anything currently-visible disappear.

**Classification: C — Safe to defer.** Real bug, zero confirmed live trigger, but the failure mode (a purchase — i.e. money — silently vanishing from a user's own history) is severe enough that this is the recommended first pick if any single S3 item gets fixed opportunistically before the next release, purely because the fix is a 2-line change with no side-effect risk.

---

## 2.13 — Profile comments: empty fromName drops the comment

1. **Still present?** Yes, unchanged. `profile_comments_store.dart:322-330`: `if (fromName.isEmpty || text.isEmpty) continue;`. Sibling function `CommentX.fromMap` (`main.dart`, unchanged location near the audit's `:5157-5172`) still correctly falls back empty name to `'Kullanıcı'`, only rejecting empty `text` — confirming this is a genuine, still-inconsistent sibling-function divergence, not an intentional design choice.
2. **Backend file/function/line:** JSON blob field, no schema enforcement (unchanged).
3. **Flutter file/function/line:** as above.
4. **Live caller?** Yes, every profile-comment hydration — trigger condition (empty `fromName`) still has no live writer: all 3 write call sites (`premium_market_profile_page.dart:1555`, `hesabim_page.dart:7948,9530`) fill `fromName: UserSession.current.name`, which is never empty by construction (`'Kullanıcı'`/`'Misafir Kullanıcı'` defaults upstream).
5. **Real user impact today:** none confirmed.
6. **Data loss / wrong data / UI inconsistency / tech debt?** Silent single-comment loss if triggered — smallest blast radius of the three dormant "drop" items (one comment, no financial/transactional data attached).
7. **Production trigger probability:** low, same reasoning as 2.10/2.12.
8. **Test coverage:** none.
9. **Fix scope:** trivial — copy the sibling `CommentX.fromMap`'s already-correct fallback (`fromName.isEmpty ? 'Kullanıcı' : fromName`), only reject on empty `text`.
10. **Side-effect risk:** minimal, same reasoning as 2.12.

**Classification: D — Tech debt / no user impact.** Same mechanism class as 2.12 but the lowest-severity failure mode of the three (one non-transactional comment vs. a purchase record or a two-party offer) — safe to leave for routine cleanup, not worth prioritizing over 2.14/2.12 if only one gets picked up.

---

## 2.14 — Offers: empty title/listingTitle/name drops the whole offer

1. **Still present?** Yes, unchanged. `offers_store.dart:1047-1052` (`_fromStrapiOfferRow`): `if (title.isEmpty) return null;`, filtered out via `.whereType<OfferItem>()` at the call site.
2. **Backend file/function/line:** `offer/content-types/offer/schema.json` — `title` still not required, only `offerId` is required/unique (unchanged).
3. **Flutter file/function/line:** as above.
4. **Live caller?** Yes, every offers-list refresh — trigger condition (all of `title`/`listingTitle`/`name` empty) still has no live writer: the client-side offer-creation path (`offers_store.dart:1339`, `'title': it.title`) always sources `title` from the listing's own title before sending.
5. **Real user impact today:** none confirmed.
6. **Data loss / wrong data / UI inconsistency / tech debt?** Silent, complete **two-sided transactional object** loss if triggered — an offer carries price, status, and thread linkage for *both* the buyer and the seller; unlike 2.12 (one user's own history) or 2.13 (one comment), a vanished offer could desync two different users' views of the same negotiation.
7. **Production trigger probability:** low, same reasoning as 2.10/2.12/2.13 — no live write path produces the empty value; only a future server-side offer-creation path (e.g. an admin tool, a bulk import, a different client) that doesn't set `title` could trigger it.
8. **Test coverage:** none.
9. **Fix scope:** trivial — fall back to a generic label (e.g. `'İlan'`/`'Teklif'`) instead of dropping the whole offer, mirroring the same pattern as 2.12's fix.
10. **Side-effect risk:** minimal, same reasoning as 2.12/2.13.

**Classification: C — Safe to defer.** Same trigger-probability profile as 2.10/2.12/2.13, but the two-party blast radius (a real negotiation silently vanishing for both sides, not just one user's own history) makes this the second-highest-priority item in this triage after 2.12, for the same "cheap fix, real failure mode, zero current trigger" reasoning.

---

## Final decision matrix

| Bulgu | Severity (orijinal) | Live? | User impact | Release class | Fix now? |
|---|---|---|---|---|---|
| 2.6 | MEDIUM | — | — | **CLOSED** (byproduct of S2's 2.5 fix) | No — already done |
| 2.8 | MEDIUM | No (feature flag off, entire read path dormant) | None today | **D** | No |
| 2.10 | MEDIUM | Yes (admin panel), but empty-value trigger unconfirmed in prod | Admin-only, moderation-integrity | **C** (data-check recommended) | No — but run a 1-query prod check before next release cut |
| 2.12 | LOW-MEDIUM | Yes (parser), trigger dormant | None today, worst-case = invisible purchase record | **C** | No — but cheapest, highest-value opportunistic fix if any gets picked |
| 2.13 | LOW-MEDIUM | Yes (parser), trigger dormant | None today, worst-case = invisible comment | **D** | No |
| 2.14 | MEDIUM | Yes (parser), trigger dormant | None today, worst-case = invisible two-party offer | **C** | No — second-highest-value opportunistic fix |

No item in this triage checked any of: server-authoritative data being overwritten by the client, a broken user-facing action, or a security/privacy exposure — the three patterns that drove every S1/S2 fix. All six are either already closed, feature-flag-dormant, or narrow-trigger read-side fallback quirks with no confirmed live occurrence.

---

## Decision

## **1. READY FOR RELEASE MERGE**

None of the remaining 6 findings is a release blocker. 2.6 is fully closed. 2.8 and 2.13 are tech debt with no live user impact (D). 2.10, 2.12, and 2.14 are real bugs (C) but every one of them requires a data condition (an empty field in stored data) that no currently-live write path in either repo produces — confirmed by re-reading every write call site, not assumed. 2.10 carries one open question this environment cannot resolve (whether any production row actually has an empty `moderationStatus`) — recommended as a cheap one-query check before the release cut, not as a blocker.

If you want to pick up any of these opportunistically alongside the release work, recommended order by value-for-effort: **2.12 → 2.14 → 2.10 (after the data check) → 2.13/2.8** (any time, no urgency).
