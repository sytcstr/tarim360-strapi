# TARIM360+1 — SPRINT 4 — OFFER SYSTEM PHASE O1: CORE BUG FIXES

Branch: `fix/release-offer-core` (backend only — no Flutter changes required, see §7)
Backend repo: `C:\projeler\tarim360-strapi`, created from `main` HEAD (`864b826`)
References: `OFFER_SYSTEM_FORENSIC_AUDIT.md`

---

## 1. Receiver identity: old vs. new flow

**Old:** `offer-ownership.ts` (policy, runs first on `POST /offers`) and `offer.ts`'s `create` action independently resolved the receiver from the real listing owner **only when the client sent neither `receiverEmail` nor `receiverProfileId`**. Since the real Flutter client always sends both, this fallback path never actually ran in production — the server had zero independent verification that an offer's receiver was the listing's real owner. Live-reproduced during the audit: an attacker account created a `201` offer with `receiverEmail`/`receiverProfileId` pointing at an arbitrary victim, on a `listingId` that didn't even need to exist.

**New:** both files now resolve the listing owner via `resolveListingOwnerByAnyId` **unconditionally**, and that result wins over client-supplied receiver fields whenever it resolves successfully — the same "server is authoritative, client is a hint at best" posture M1 established for message sender identity. Client-supplied values are only used as a fallback for the case listing resolution itself fails (unknown/legacy `listingId`), preserving today's behavior for that edge case rather than turning it into a hard rejection.

**Bonus fix, found while testing this (disclosed, not silently expanded):** `offer-ownership.ts` called `ctx.forbidden(...)` directly in five places — not a valid method in a Strapi **policy** context (policies don't get the same Koa response-helper mixin controllers do). Every rejection branch in this policy (mismatched requester, missing receiver, self-offer, non-participant access) was throwing a raw `500` instead of returning a clean `403`. This was caught by my own new self-offer test, not assumed — confirmed via the actual `TypeError: ctx.forbidden is not a function` stack trace. Fixed by switching to this codebase's own `denyForbidden` helper (already used correctly by three other policy files: `hub-content-write-guard.ts`, `profile-setting-ownership.ts`, `require-logistics-premium.ts`), which safely falls back to `ctx.throw`/raw status+body when the Koa helper isn't available. One characteristic of Strapi's own policy pipeline, confirmed live and *not* something this fix changes: a policy returning `false` gets wrapped in Strapi's generic `403 "PolicyError: Policy Failed"` response regardless of what message the policy itself set — so the custom Turkish messages (`"Kendi ilaniniza teklif veremezsiniz."` etc.) don't reach the client for policy-layer rejections specifically. The important part — no more crash, clean status code, correct enforcement — is fixed; the message-text limitation is a pre-existing platform characteristic, noted for awareness.

---

## 2. Permission fix

`api::offer.offer.markSeen` (`PATCH /offers/:offerId/seen`) used `auth: { scope: [] }` but was never added to `src/index.ts`'s `authenticatedActions` allowlist — same exact gap class as `markRead` (messaging M2), `metricLike`/`metricFavorite` before it, and (found but out of Offer scope) `notification.markRead`/`auth-flow.deleteAccount`/`logistics-admin.*`. Confirmed live before the fix: a valid JWT for a real offer participant still got Strapi's generic `403 Forbidden`, never reaching the controller. One line added; offer "seen" tracking is now reachable for real participants and still correctly forbidden for non-participants.

---

## 3. `offerCount` source of truth

`listing.offerCount` had no write path at all beyond a client-supplied value (already neutralized server-side since `SEMANTIC_CONTRACT_S2` added `offerCount` to `listing.ts`'s `CLIENT_PROTECTED_FIELDS`/`stripClientProtectedFields` — confirmed still in place and applied on both create and update). The long-uncommitted WIP (`recountListingOffers`, present in this repo since before this entire messaging sprint began, protected untouched through every prior phase per your own instruction each time) is the correct, and only, real fix: it recomputes `listing.offerCount` from the true row count and is now called after offer create and after offer delete.

**Verified, not assumed, via the new test suite:**
- Create → `offerCount` increments (0→1→2 across two independent offers on the same listing).
- Accept/reject/bargain (`updateByOfferId`) → `offerCount` **unchanged** — correct, since a status change never adds or removes a row.
- Delete → `offerCount` decrements.
- A mixed create/create/create/delete sequence stays accurate throughout, never goes negative (structurally guaranteed by `setListingCounter`'s `Math.max(0, ...)` clamp).

**Client-computed `offerCount` PATCH path — found, already neutralized, no code change needed or made:** `ListingEngagementStore._syncListingMetrics` (Flutter) does send a locally-computed `offerCount` in its listing-metrics PATCH payload. This is harmless dead weight, not a live vulnerability — `stripClientProtectedFields` deletes it server-side before any write happens, confirmed by reading the exact strip-list and its call sites in both `create` and `update`. No Flutter change was made (per this phase's explicit "don't touch Flutter unless the read contract is affected" instruction) since removing this dead send wouldn't change any behavior — flagging as an optional, purely cosmetic Flutter cleanup if you want it in a future pass, not urgent.

**The `limit: 1000` question, answered:** `listing-metrics.ts`'s `rowsForListing` caps the count query at `limit: 1000`. If a single listing somehow accumulated more than 1000 offer rows, `offerCount` would plateau at 1000 rather than reflect the true (higher) count. Given this app's realistic usage (agricultural marketplace listings, not a high-volume auction platform), this is a low-probability, low-severity theoretical ceiling — reported per your instruction, not fixed, since fixing it would mean either raising the limit (doesn't solve the underlying assumption) or paginating the count query (a larger, unrelated change). Recommend leaving as-is unless real usage ever approaches it.

---

## 4. Product decisions — recorded, not implemented (per explicit instruction)

- **Duplicate active offers**: your direction — allow multiple offers on the same listing over time, but a single user should not have more than one *active* (non-terminal-status) offer open on the same listing simultaneously; counter-offers should continue to update the same row rather than create a new one (already true today, confirmed in the audit — `bargain`/`_remoteBargain` reuse the existing `offerId`). **Not implemented this phase** — would need a new check (e.g., reject/merge a second `create` while an active offer from the same requester on the same listing already exists) in `offer.ts`'s `create` action and/or `offer-ownership.ts`.
- **Premium teklifler**: **DEFER**. No premium-specific behavior exists anywhere in the offer system today (confirmed by grep, zero matches, both repos) and none was added. Treated as a new feature request for a future phase, not a bug.
- **Accept/reject dedicated notification**: **NEXT OFFER PHASE**. Confirmed `updateByOfferId` creates no notification row of its own today — the only notification either party currently gets about a status change comes from the offer-event chat message's own `message.afterCreate` → `notification.afterCreate` → FCM chain, which (per M4's audit) has no delivery guarantee. Not implemented this phase; recommend a direct `notification.notification` create inside `updateByOfferId`, decoupled from chat delivery, as the fix direction for that future phase.
- **Accepted offer delete**: your direction — don't allow deleting an accepted offer; archive/close it instead. **Not implemented this phase** — `deleteByOfferId` today still allows either participant to delete an offer in any status. Would need a status check (`entity.offerStatus === 'accepted'` → reject or redirect to an archive/close action instead of `entityService.delete`) in a future phase.

---

## 5. Tests

**Backend** (`offer-receiver-ownership.integration.test.ts`, new, port 14165): **10/10 passing.**

**Full backend integration suite: 176/176 passing, exit 0** — verified twice against the final committed HEAD (`0d1d5ca`): once immediately pre-commit (176/176, ~226s) and once again fresh against the committed state after all 4 commits (176/176, ~199s), both genuine completions with real summary output, not partial/hung runs.

**Worth disclosing directly**, since you specifically asked for transparency here: the *first* attempt at the full integration run (before these final two) genuinely hung — confirmed via live diagnosis (frozen log for 8.5 minutes, ~26s total CPU across 11+ minutes wall time, no listening test ports, one unclosed temp DB file from `logistics-load-engagement.integration.test.ts`, unrelated to Offers). Root-caused as that file's `after()` shutdown hook never resolving — a pre-existing test-infrastructure flake, not something introduced by O1's code changes (my own isolated run of the new offer test file had already passed 10/10 before this happened, independently). Diagnosed properly (not blindly killed), then the stuck processes were terminated and the suite re-run cleanly twice. No source code was touched to "fix" this — it wasn't a code bug, and it didn't recur.

Unit: **31/31**. `tsc --noEmit`: clean. `npm run build`: succeeds. `git diff --check`: clean. Clean-checkout worktree validation (isolated `git worktree`, tracked-only, `node_modules` linked via a Windows junction — not a plain symlink, specifically to avoid a repeat of an earlier session's near-miss where `rm -rf` through an MSYS symlink risked traversing into the real target): passed.

---

## 6. Commit hashes

```
21137e8 fix(offers): bind receiver to listing ownership
542175e fix(offers): grant mark-seen permission
e3693f2 fix(offers): make listing offer count server authoritative
0d1d5ca test(offers): add ownership and counter coverage
```

The `offer.ts` receiver-fix and `offer.ts` offerCount-fix commits both touch the same file but were reconstructed as genuinely separate, non-overlapping edits (revert → reapply stage 1 → commit → reapply stage 2 → commit), and the two-commit split was verified **byte-identical** against the original single-pass combined diff before committing — no fix content was lost, merged, or reordered by the split.

Pushed: **branch only** (`fix/release-offer-core`). `main` untouched, no production deploy. No Flutter branch was pushed — a local `fix/release-offer-core` branch was created in the Flutter repo per the original instruction, but zero commits were made on it (confirmed no code change was needed, §7), so there is nothing to push; it can be discarded or left alone.

| | Backend |
|---|---|
| Branch | `fix/release-offer-core` |
| HEAD | `0d1d5ca` |
| Commits this phase | 4 |
| origin sync | 0 ahead / 0 behind |

---

## 7. Flutter

No code change made or required. Confirmed by reading the actual consumer (`ListingEngagementStore`): `offerCount` is read via the same field name/shape from `listing.offerCount` as always — this phase changes the *value* flowing through that field (now server-accurate) but not its name, type, or the endpoint shape, so the Flutter read contract is unaffected. The one Flutter-side item found (the dead client-computed `offerCount` PATCH) is already inert server-side and was left as-is per this phase's explicit scope (§3).

---

## 8. Remaining scope

- **Permission-Gap Sweep Fix** (your next planned short phase) — `notification.markRead`, `auth-flow.deleteAccount`, `logistics-admin.*` (7 actions). Found during the audit, confirmed live, **not touched this phase**, exactly as instructed.
- **BUG-M7** (messaging's `deleteByThreadId` permission gap) — still open, unrelated to Offers, tracked from the messaging sprint.
- **BUG-003A** (premium branding) — still open, unrelated to Offers.
- The four product-decision items from §4 — recorded, awaiting a future implementation phase.

---

## DECISION

# READY FOR O2 (Permission-Gap Sweep Fix)

O1's three core bugs are closed and verified: an offer's receiver can no longer be redirected to an arbitrary third party (server-authoritative, matching M1's identity discipline), offer "seen" tracking is reachable, and `listing.offerCount` now has a real, tested write path instead of silently staying wrong forever. A genuine adjacent crash (policy-layer `ctx.forbidden`) was found and fixed in the same file, disclosed rather than silently bundled in. All verification is against the final committed HEAD, not just the working tree: 176/176 integration, 31/31 unit, clean build, clean diff-check, clean-checkout passed.

**Stopping here per instruction — not proceeding to the permission-gap sweep or any product-decision item without your explicit go-ahead.**
