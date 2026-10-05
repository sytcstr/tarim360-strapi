# Semantic Contract Audit — Phase S1: CRITICAL + HIGH Production Fixes

**Date:** 2026-08-10
**Reference:** `BACKEND_FLUTTER_SEMANTIC_CONTRACT_AUDIT.md`
**Fix branch:** `fix/semantic-contract-s1-critical` (pushed, not merged to main)
**Scope:** Exactly the two CRITICAL/HIGH mismatch classes named in the mandate (A: Logistics ownership actor-key, B: Premium active semantics). No other audit findings touched.

---

## A — Logistics ownership actor-key

### Read-only reverify findings (on current HEAD, before any change)

1. **Flutter's actor/owner key format:** `lib/features/logistics/models/logistics_models.dart:484-492`, `_currentLogisticsActorKey()` → `'id:${AuthService.currentOwnerId}'`.
2. **What backend derives from the logged-in user:** `AuthService.currentOwnerId` (`lib/main.dart:5941-5947`) is **always** `StrapiService.ownerIdFromEmail(email)` = `u_<normalized-email>` — never the real Strapi numeric `user.id`. Confirmed by reading the actual session-restore assignment, not assumed.
3. **Load create:** `logistics-load.ts`'s `sanitizeCreateData` never sets `ownerKey` — it passes through verbatim whatever the client sent. So a real, Flutter-created load's `ownerKey` is always `id:u_<email>`.
4. **Vehicle create:** identical — `logistics-vehicle.ts`'s `create` never computes `transporterKey`; client-supplied verbatim.
5. **Old ownership check:** `canOwnLoad`/`canOwnVehicle` compared against `profile:${user.id}` (real numeric id), `id:${user.id}`, `email:${user.email}`, etc. — **none** of these branches can ever equal `id:u_<email>`.
6. **Existing production row formats:** cannot be queried from here (no DB access). Treated as unknown/unconfirmed, per the mandate's own instruction — handled via additive backward compatibility (see below), not by assuming the answer.

**Working reference pattern found:** `logistics-offer.ts`'s own transporter-ownership check (`matchesTransporter`) already strips a leading `id:`/`email:`/`username:` prefix from a stored key and compares the remainder against `readIdentity(ctx)`'s email-derived `ownerId`/`email` — the exact comparison that correctly recognizes Flutter's real format. `conversation.ts` uses a related but structurally different (dual-column, not single composite key) email/profileId matching scheme — not directly reusable here, but confirms the same "email-derived identity is canonical" principle.

### Fix

New `matchesOwnerKey(rawKey, identity)` in `src/utils/identity.ts` — the one canonical helper, generalizing `logistics-offer.ts`'s own logic (which now calls it too, removing its private duplicate). `canOwnLoad`/`canOwnVehicle` check this canonical rule **first**; the original real-numeric-id-based branches remain **after** it, unchanged, read-only, as backward compatibility for any legacy-format row. `ownerKey`/`transporterKey` is set once at creation from client input and never rewritten on update (confirmed: not in `logistics-load.ts`'s update allowlist; explicitly `delete`d from vehicle's update payload) — so all new writes are canonical by construction, no migration needed, and no currently-working access path was removed.

### Legacy compatibility decision

**Kept, additive-only.** The old `profile:<real-Strapi-id>` branches were not removed — they still work exactly as before for any row that happens to carry that format, while the new canonical check now ALSO recognizes the format every real Flutter-created record actually has. This is the lowest-risk option: it can only widen what's accepted, never narrow it.

---

## B — Premium active semantics

### Canonical rule

`src/utils/premium-sync.ts`'s `isPremiumActiveFromProfile`: missing `endsAt` → active/unlimited; future `endsAt` → active; past `endsAt` → inactive. Never inspects `planTitle`.

### Confirmed independent reimplementations, fixed

| File | Old behavior on missing `endsAt` | Fix |
|---|---|---|
| `src/api/ai/controllers/ai.ts` (`hasActiveAiAccess`) | **denied** | Delegates to `isPremiumActiveFromProfile`; kept its own separate `hasAiAssistant` plan-tier check |
| `src/policies/require-logistics-premium.ts` (`hasActivePremium`) | **denied** | Delegates fully; kept its own separate `hasLogisticsModule` check |
| `src/api/listing/controllers/listing.ts` (`hasActivePremiumExpiry`) | **denied** (stamped `isPremium:false` at listing-creation time) | Delegates fully |
| `src/api/promo/controllers/promo.ts` (`buildSubscriptionPayload`'s `hasActiveCurrent`) — **found via the mandated repo-wide grep, not one of the three named files** | **denied** — would have silently downgraded an unlimited/admin-granted premium to a fresh time-limited one on promo-code redemption | Delegates fully; also fixed the now-reachable case where extension math (`currentEndsAt.getTime() + ...`) had no prior date to extend — an unlimited grant now stays unlimited instead of crashing (`TypeError`) or being narrowed to an arbitrary date |

Repo-wide grep for every remaining `endsAt`/`Date.now`/`isAfter` premium-adjacent pattern (`grep -rn "endsAt" src`) confirmed no fifth reimplementation exists. `promo-code.startsAt/endsAt` (a genuinely different object — promo code validity window, not member premium status) and `purchase/lib/persistence.ts` (a pure writer, always producing a concrete `endsAt`, never an activation check) were inspected and confirmed out of scope. `auth-flow.ts`'s `/auth/premium-owners` endpoint was already correctly calling `isPremiumActiveFromProfile` — no change needed.

### Single source of truth

`isPremiumActiveFromProfile` (`src/utils/premium-sync.ts`) is now the **only** place `endsAt`-based premium activation is computed anywhere in the backend. All four gates above call it directly; none re-derive the rule.

### Incidental fix required to make the mandated tests pass

`require-logistics-premium.ts` called `policyContext.forbidden(...)`/`.unauthorized(...)` directly. These are not guaranteed to exist at the policy layer in this Strapi version (`src/utils/identity.ts`'s `denyNoIdentity`/`denyForbidden` exist for exactly this reason). Every rejection therefore crashed with a raw `500 TypeError` instead of ever returning the intended `401`/`403` — undetected until now because the only pre-existing test exercising this policy (`logistics-load-engagement.integration.test.ts`) deliberately bypasses it via `entityService`, never through a real HTTP request. Fixed with the same defensive fallback pattern already used elsewhere in this codebase.

### "Durak noktası" flagged, resolved conservatively (not blocked on)

Fixing `promo.ts`'s extension math for a null `currentEndsAt` required a small business-rule judgment call (what should happen to `endsAt` when a promo code "extends" an unlimited grant). Took the most conservative, least-surprising option — unlimited stays unlimited — rather than inventing a new fixed date or blocking the whole phase on it. Flagged here explicitly per the mandate's own "Premium helper başka iş kuralı gerektiriyorsa" stop-condition, for your review.

---

## Files changed

- `src/utils/identity.ts` — new `matchesOwnerKey`
- `src/api/logistics-load/controllers/logistics-load.ts` — `canOwnLoad` canonical check
- `src/api/logistics-vehicle/controllers/logistics-vehicle.ts` — `canOwnVehicle` canonical check
- `src/api/logistics-offer/controllers/logistics-offer.ts` — refactored to call the shared helper
- `src/api/ai/controllers/ai.ts` — `hasActiveAiAccess` delegates
- `src/policies/require-logistics-premium.ts` — `hasActivePremium` delegates; `policyContext.forbidden` bug fixed
- `src/api/listing/controllers/listing.ts` — `hasActivePremiumExpiry` delegates
- `src/api/promo/controllers/promo.ts` — `buildSubscriptionPayload`'s `hasActiveCurrent` delegates; extension math null-safe
- `tests/integration/logistics-load-ownership.integration.test.ts` (new, 8 tests)
- `tests/integration/logistics-vehicle-ownership.integration.test.ts` (new, 8 tests)
- `tests/integration/premium-gates.integration.test.ts` (new, 13 tests)

**Not touched:** `src/api/offer/controllers/offer.ts` (WIP, confirmed unchanged before/after — still exactly `+12` uncommitted lines), Flutter repo (zero tracked changes — actor-key contract verified read-only, no code change needed since Flutter's format is what the fix now correctly recognizes).

---

## Test results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | PASS — clean |
| `npm test` (unit) | PASS — 31/31 |
| `npm run test:integration` | PASS — **154/154** (125 baseline + 16 logistics ownership + 13 premium gates) |
| `npm run build` | PASS — exit 0 |
| `git diff --check` | PASS — clean |

New coverage detail:
- **Logistics ownership (16 tests, 8 per domain):** owner create→edit→deactivate→delete all PASS with the canonical key; stranger edit/delete → 403; legacy `profile:<real id>` row still owner-accessible; a different user still rejected on the legacy row.
- **Premium gates (13 tests):** AI (4: null/future/past/none), Logistics policy (4: null/future/past/none), Listing stamp (4: null/future/past/none), promo extension of an unlimited grant (1).

## Clean-checkout validation

Isolated `git worktree` of the final commit (`ae8951c`), zero untracked files carried over: `npx tsc --noEmit` and `npm run build` both PASS.

## Commit hashes

1. `a7d7105` — `fix: align logistics ownership actor identity`
2. `cf88e99` — `fix: unify premium active semantics across backend guards`
3. `ae8951c` — `test: add semantic contract regression coverage`

Branch pushed: `fix/semantic-contract-s1-critical` → `origin/fix/semantic-contract-s1-critical`. **Not** pushed to or merged into `main`.

---

## Audit findings closed by this phase

Of the 14 confirmed mismatches in `BACKEND_FLUTTER_SEMANTIC_CONTRACT_AUDIT.md`:

- **2.1** (CRITICAL — Logistics ownership) — **CLOSED**
- **2.2** (AI Assistant endsAt) — **CLOSED**
- **2.3** (Logistics premium policy endsAt) — **CLOSED**
- **2.4** (Listing creation split-brain) — **CLOSED**
- Plus **one new confirmed finding** (promo.ts extension-of-unlimited-premium), not in the original 14, found via the mandated grep and closed in the same phase.

## Remaining CRITICAL/HIGH items (untouched, per scope)

- **2.5** — Listing eski/canlı sayaç karışıklığı (HIGH)
- **2.7** — Approved Ads impressions çift sayım (HIGH)
- **2.9** — Processed Products yönetim sayfası bayat sayaç (MEDIUM-HIGH)
- **2.11** — Approved Ads moderasyon bypass (HIGH, dormant behind `enableSmartAds=false`)

Plus 6 MEDIUM/LOW-MEDIUM items (2.6, 2.8, 2.10, 2.12, 2.13, 2.14) — all deliberately untouched this phase.

## READY / BLOCKED for S2

**READY.** All verification passes, clean-checkout passes, WIP untouched, Flutter untouched. Both named CRITICAL/HIGH mismatch classes closed with regression coverage. Stopping here as instructed — no further audit items addressed, no PR opened (same `gh` CLI limitation as prior phases — direct link: `https://github.com/sytcstr/tarim360-strapi/pull/new/fix/semantic-contract-s1-critical`), no production deploy.
