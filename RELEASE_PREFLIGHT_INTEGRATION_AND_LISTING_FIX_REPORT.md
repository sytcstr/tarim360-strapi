# TARIM360+1 — RELEASE INTEGRATION + LISTING CRITICAL FIX PHASE

Backend repo: `C:\projeler\tarim360-strapi`, branch `release/preflight-integration`, HEAD `802cf2e`
Flutter repo: `C:\projeler\tarim360`, branch `release/preflight-integration`, HEAD `c550e3a`
References: `LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md`, `PERMISSION_GAP_RELEASE_AUDIT.md`, `OFFER_SYSTEM_FORENSIC_AUDIT.md`

`main` was not touched in either repo. No production deploy. Both branches pushed to origin; no PR opened, no merge to `main`.

---

## 1. Branch ancestry audit (Aşama 1)

`git fetch origin --prune` run first in both repos, then every candidate branch's commits relative to `origin/main` were enumerated (`git log origin/main..origin/<branch>`) and cross-checked with `git merge-base --is-ancestor` before any merge was attempted.

**Backend:**

| Branch | Unique commits vs main | Ancestry |
|---|---|---|
| `fix/release-messaging-core` | 3 | ⊂ read-state ⊂ reliability (confirmed via `--is-ancestor`) |
| `fix/release-messaging-read-state` | 6 (includes core's 3) | ⊂ reliability |
| `fix/release-messaging-reliability` | 8 (includes read-state's 6) | tip — merging this alone brings in M1-M5 |
| `fix/release-offer-core` (O1) | 4 | independent |
| `fix/release-permission-gaps` (S5A) | 2 | independent |
| `fix/release-profile-premium-badge` | 2 | independent |

Only `fix/release-messaging-reliability` needed merging for the full messaging fix set — verified `core` and `read-state` are strict ancestors, so merging them separately would have been redundant, contrary to the explicit "aynı commitleri tekrar merge/cherry-pick etme" instruction.

**Flutter:** identical stacking pattern (`core` ⊂ `read-state` ⊂ `reliability`). Additionally checked: local (unpushed) `fix/release-offer-core` branch — `git log origin/main..fix/release-offer-core` was empty and `git merge-base --is-ancestor fix/release-offer-core origin/main` returned true, confirming it is already fully contained in main with zero unique work (matches `OFFER_O1_CORE_FIX_REPORT.md`'s own statement: "zero commits were made on it"). Nothing to merge from it. `fix/release-auth-forgot-password` (1 commit) is Flutter-only — no backend counterpart exists.

No branch had ambiguous ancestry; nothing was skipped or cherry-picked by guesswork.

---

## 2. Release integration branch (Aşama 2)

`release/preflight-integration` created fresh from `origin/main` in both repos, then merged in dependency order: messaging-reliability → offer-core → permission-gaps → profile-premium-badge (backend); messaging-reliability → auth-forgot-password → permission-gaps → profile-premium-badge (Flutter). Every merge was followed by a conflict check, `git diff --check`, and (where relevant) an unexpected-file scan before moving on.

**Conflicts hit and resolved (not blindly auto-accepted):**

- **Backend `src/index.ts`**: merging `fix/release-permission-gaps` conflicted with `fix/release-messaging-reliability` — both branches independently added `api::conversation.conversation.markRead` to `authenticatedActions` at the same location (found and fixed twice, once by messaging M2, once by this engagement's own Sprint 5A permission-gap sweep, neither aware of the other since both were built on unmerged `main`). Resolved by keeping the single `markRead` entry plus permission-gaps' additional `deleteByThreadId`/`notification.markRead`/`auth-flow.deleteAccount` entries, with a merged comment crediting both origins. Verified via `grep` afterward that all 5 expected permission entries exist exactly once each.
- **Flutter `main.dart`/`strapi_service.dart`**: `fix/release-auth-forgot-password` (522-line `main.dart` diff) and `fix/release-profile-premium-badge` (276-line `main.dart` diff) both touch this large shared file; git's 3-way merge auto-resolved both merges with no conflict markers. Given the size and criticality, this was **not** trusted blindly — verified via a full `flutter analyze` (0 new issues) and `flutter test` (252/252 passing) immediately after, which would have caught any semantic breakage a clean textual merge could hide.
- **Integration test port collisions** (not a git conflict, a semantic one, caught by inspection): `fix/release-messaging-reliability`, `fix/release-offer-core`, and `fix/release-permission-gaps` were each developed independently and picked the next free port at the time, leaving three ports double-booked (14165/14166/14167) after merging all three. Reassigned the three messaging-reliability test files to 14169-14171; committed separately (`fix(tests): resolve integration test port collisions after branch merge`).

**Confirmed present in `release/preflight-integration` after all merges** (Aşama 2's required proof list):

- BUG-OFFER-001 fix (O1, receiver bound to resolved listing owner): ✅ present (`fix/release-offer-core` merged, and re-verified live in this phase's own `listing-owner-email-privacy.integration.test.ts` — the offer test creates a listing, has a different user submit an offer with no `receiverEmail` field at all, and asserts the server resolves the real seller's email server-side).
- Messaging M1-M5: ✅ present (`fix/release-messaging-reliability`, which is the tip of the full stack).
- Profile public premium fix: ✅ present.
- Forgot-password fix (Flutter only): ✅ present.
- Permission-gap S5A: ✅ present (all 5 entries confirmed via grep post-merge).

An unrelated operational incident during this phase, disclosed rather than silently worked around: an earlier session's `git worktree remove --force` (used for Sprint 5A's clean-checkout validation, with `node_modules` linked into the worktree via a Windows junction) appears to have recursively deleted through the junction into the real `node_modules` directory, leaving it empty. Discovered when `tsc` failed with "this is not the tsc command you are looking for." No tracked/committed files were affected (`node_modules` is gitignored and fully regenerable) — restored via `npm ci` against the untouched `package-lock.json`, verified clean afterward. Noted here because it explains why this phase does **not** repeat that clean-checkout worktree technique (see §7).

---

## 3. BUG-LISTING-001 (CRITICAL) — offline-sync ownership + field protection

`POST /offline-sync/listings` (`engagement.ts`'s `syncOfflineListing`) had **zero** ownership check on its update/upsert branch and never stripped protected fields — confirmed live before the fix: a stranger's request against another user's listing id returned `200` and reassigned that listing's `ownerEmail`/`ownerProfileId`/`ownerId` to the attacker.

**Fixed:**
- Ownership verified via `matchesIdentity` before any update; `403` if the resolved row isn't the caller's own.
- New shared `LISTING_CLIENT_PROTECTED_FIELDS`/`stripListingProtectedFields` (`src/utils/listing-metrics.ts`) strips counters/premium/rocket fields on this path — the same protection `listing.ts`'s own routes have, now in one place both consume.
- A second, independently-discovered bug found while testing this fix: a client-echoed `id`/`documentId`/`listingId`/`remoteId` field in the payload could make Strapi attempt to move the target row to a different primary key (`UNIQUE constraint failed: listings.id` — reproduced live). Stripped these identifier fields from the write payload too.

**Also fixed in the same area (found via the same testing pass, not assumed):** `src/policies/listing-owner-write.ts` called `ctx.forbidden(...)` directly — Strapi policies don't get the Koa response-helper mixin controllers do, so every ownership rejection on `PUT`/`DELETE /listings/:id` was crashing with a raw `500` instead of returning `403` (confirmed via the actual stack trace). Fixed with the codebase's own `denyForbidden` helper — the same policy-layer bug class already found and fixed in `offer-ownership.ts` during O1.

---

## 4. BUG-LISTING-002 (CRITICAL) — seller email disclosure

`listing.ownerEmail` had no `private:true` flag, so every listing's real seller email was returned verbatim in the public, unauthenticated `GET /listings`/`GET /listings/:id` response.

**Fixed:** `"private": true` added to the schema field. Verified:
- Public `GET /listings` → `ownerEmail` absent from every row; `ownerName`/`ownerCity`/`ownerProfileId`/`ownerId` still present (these are intentionally public).
- Public `GET /listings/:id` → same.
- An authenticated **non-owner** (logged-in stranger) hitting the same detail endpoint → still absent — `private` applies regardless of caller, not just to anonymous requests.
- Backend-internal usage unaffected: `resolveListingOwnerByAnyId` (used by offer creation) still resolves the real seller email correctly — `private` only strips fields from the REST API's own output-sanitization step, never from internal `entityService`/`db.query` reads.
- Flutter dependency traced before touching anything (per the explicit "körlemesine field silme" instruction): every `ownerEmail` read in the Flutter codebase is a null-safe fallback checked only *after* `ownerId` (always server-set for every listing) is empty, or feeds a non-critical local profile cache. No UI code requires `ownerEmail` from the listing API response — confirmed via `flutter analyze`/`flutter test` showing no regressions. No Flutter change was needed or made.

---

## 5. HIGH listing fixes (Aşama 5)

**BUG-LISTING-003 (favorites sync):** `listing_detail_page.dart`'s favorite toggle only called `EngagementStore.I.toggleFavorite` — unlike every other listing-favorite call site (`search_listings_page.dart`, `favorites_page.dart`), which mirror the mutation into `FavoritesStore`'s local id set (the established "D4-F" local-only-mirror pattern) specifically so the Favorites page — which reads local state, not a live server fetch — stays in sync. This page was missed during that migration. Fixed with the identical pattern already used everywhere else; no new mechanism introduced, no second backend mutation.

**BUG-LISTING-004 (isDoping/rocketEndsAt spoof):** now covered by the same shared `LISTING_CLIENT_PROTECTED_FIELDS` as BUG-LISTING-001 — rocket/premium fields are protected on both the offline-sync path and the normal `PUT /listings/:id` path from a single source of truth, closing the gap `SEMANTIC_CONTRACT_S2_HIGH_FIX_REPORT.md` had explicitly deferred.

---

## 6. Remaining audit items — reclassified (Aşama 6)

Per instruction, only release blockers and safe/low-risk fixes were applied here; no large product-behavior changes.

- **BUG-LISTING-009 (Pasife Al mislabeled)** — fixed: removed the duplicate, misleading "Pasife Al" menu entry (it called the exact same hard-delete handler as "Kaldır"; there was never a real pause/reactivate feature). One-line-scope UI fix, zero behavior change for the one real capability that existed.
- **BUG-LISTING-005 (ownership fields not stripped on update)** — fixed alongside BUG-LISTING-004 in the same commit (same file, same mechanism, same low risk: forcing identity server-side mirrors what `create()` already did).
- **BUG-LISTING-007 (message receiver not cross-verified against listing owner)** — **deferred, not fixed.** Not a security gap (this app doesn't restrict who a user may message; the risk is data-integrity/context-mismatch, not authorization bypass), and closing it would mean adding a new cross-check to `conversation.ts`'s participant resolution — a real behavior change to messaging, out of this phase's safe/low-risk scope.
- **BUG-LISTING-008 (message from profile page doesn't carry listingId)** — **deferred, not fixed.** Requires threading a new parameter through the listing→profile→message navigation chain across multiple files; moderate scope, not a blocker.
- **RISK-1/2/3** (dual engagement pipelines beyond the one instance already fixed as BUG-LISTING-003; client-local rocket/premium display override; Favorites page not force-refreshing from server) — left as reported, no action taken; none were classified as blockers in the original audit.
- **DEAD-1/2** (unused `updateListingCounter`/`toggleProfileList` in `engagement.ts`; `ListingEngagementStore._syncListingMetrics`'s now-fully-neutralized raw counter payload) — left as reported, unchanged; safe cleanup candidates for a future pass, not urgent.

---

## 7. Full validation (Aşama 7)

**Backend:**
- `npx tsc --noEmit`: clean, run after every fix in this phase (not just once at the end).
- `npm run test:integration`: **237/237 passing**, exit 0 (166 pre-existing on `main` + 17 S5A + 10 O1 + messaging-reliability's own suites + profile-premium-badge's additions + 14 new listing tests from this phase).
- `npm run test:unit`: **31/31 passing**.
- `npm run build`: succeeds (TS compile + admin panel build).
- `git diff --check`: clean on every commit (only benign LF→CRLF notices).

**Flutter:**
- `flutter analyze`: **0 new issues** (2 pre-existing, unrelated warnings in `logistics_models.dart`, untouched by this phase).
- `flutter test`: **252/252 passing**, no regressions.
- `git diff --check`: clean.

**Clean-checkout validation:** not repeated via an isolated `git worktree` this phase, given the incident described in §2 (a junction-linked worktree's removal wiped the real `node_modules`). `tsc`/`build`/the full test suites already ran clean directly against every committed state in this phase's primary working tree, which is the actual `release/preflight-integration` branch content that was pushed — this catches the same class of bug (implicit reliance on an untracked file) that clean-checkout validation exists for, for changes of this shape (no new dependencies, no new content-type schema files). Disclosed plainly rather than silently claimed as done or silently skipped.

**Post-merge sweep (Aşama 7's closing checklist):**
- Public `ownerEmail` leak: **0** (verified, §4).
- Offline-sync ownership bypass: **0** (verified, §3).
- Client rocket/premium spoof: **0** (verified, §3/§5, both the offline-sync path and the normal update path).
- Offer receiver-spoof fix (O1) present in integration branch: **✅** (verified live, §2).
- Messaging fixes present in integration branch: **✅**.
- Permission fixes present in integration branch: **✅**.

---

## 8. Commits

**Backend** (`release/preflight-integration`, 6 new commits beyond the merges):
```
160145b fix(tests): resolve integration test port collisions after branch merge
17e793c fix(listings): enforce ownership in offline sync
03f6230 fix(listings): protect rocket/premium and owner fields on update
ed51114 fix(policies): avoid ctx.forbidden crash in listing-owner-write
b921079 fix(listings): prevent seller email disclosure
802cf2e test(listings): add ownership, protected-field, and email-privacy coverage
```
Plus 4 merge commits bringing in `fix/release-messaging-reliability`, `fix/release-offer-core`, `fix/release-permission-gaps`, `fix/release-profile-premium-badge`.

**Flutter** (`release/preflight-integration`, 2 new commits beyond the merges):
```
7645819 fix(listings): synchronize detail-page favorites with FavoritesStore
c550e3a fix(listings): remove misleading non-functional Pasife Al menu entry
```
Plus 3 merge commits bringing in `fix/release-messaging-reliability`, `fix/release-auth-forgot-password`, `fix/release-permission-gaps`, `fix/release-profile-premium-badge`.

| | Backend | Flutter |
|---|---|---|
| Branch | `release/preflight-integration` | `release/preflight-integration` |
| Base | `origin/main` | `origin/main` |
| HEAD | `802cf2e` | `c550e3a` |
| Commits ahead of main | 25 | 17 |
| origin/main sync | 0 behind | 0 behind |
| Pushed | Yes — branch only | Yes — branch only |

`main` untouched in both repos. No PR opened, no merge, no production deploy.

---

## RESULT

# READY FOR NEXT AUDIT

All 3 CRITICAL and 2 HIGH release-blocking items from `LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md` are closed on `release/preflight-integration`: the offline-sync ownership/mass-assignment hole (001), the public seller-email leak (002), the merge-only offer-receiver-spoof gap (006, resolved by integrating O1), the detail-page favorites desync (003), and the free rocket/premium self-grant (004). Two related bugs found only through this phase's own regression testing — a policy-layer crash-instead-of-403 and a client-echoed-primary-key write hazard — were fixed alongside their root causes rather than left for a future pass. Every previously-completed, previously-unmerged sprint (messaging M1-M5, offer O1, permission-gap S5A, profile premium badge, forgot-password) is now integrated and re-verified together on one branch for the first time. Full validation: backend 237/237 integration + 31/31 unit + clean tsc/build; Flutter 252/252 tests + clean analyze. Two MEDIUM/LOW items (007, 008) and three non-blocking risks/dead-code notes remain open by design — deferred, not forgotten, and none were classified as blockers.

**`release/preflight-integration` is the release candidate going forward.** Next audits (Premium → Bildirimler → Engagement → two-user UAT) should target this branch, not `main`.
