# TARIM360+1 — SPRINT 5A — TARGETED PERMISSION-GAP FIX

Branch: `fix/release-permission-gaps` (both repos, created from `main`)
Backend repo: `C:\projeler\tarim360-strapi`, HEAD `064102f`
Flutter repo: `C:\projeler\tarim360`, HEAD `99d1a19`
Reference: `PERMISSION_GAP_RELEASE_AUDIT.md`

Scope: exactly the 4 confirmed permission gaps (PERM-N1, N2, N4, N5). `logistics-admin.*` was **not touched** — deferred per instruction, see §6. Neither `main` was touched in either repo, nor were any O1 (`fix/release-offer-core`) branches/commits.

---

## 1. Permission fix (backend)

`src/index.ts`'s `authenticatedActions` bootstrap array now includes the 4 missing action ids, added next to their related entries with a short inline note pointing back to the audit:

```
api::notification.notification.markRead
api::auth-flow.auth-flow.deleteAccount
api::conversation.conversation.markRead
api::conversation.conversation.deleteByThreadId
```

Same one-line-per-action pattern as the earlier `offer.markSeen` fix. No route config, controller, or policy code was changed — every controller's existing ownership/participant check was already correct (confirmed in the audit and re-confirmed here by the tests below), so this is a pure permission grant.

`logistics-admin.*`'s 7 actions were **not added** — see §6.

---

## 2. Root-cause correction: the notification duplicate-fallback claim

The audit's stated premise — "the 403 permission gap causes `notification.markRead`'s Flutter fallback to create a duplicate notification row" — **does not hold up** and is corrected here rather than carried forward silently.

Tracing the actual call chain (`StrapiService._patchJsonBestEffort`, `strapi_service.dart:4628-4643`):
```dart
} on DioException catch (e) {
  final code = e.response?.statusCode ?? 0;
  if (code == 401 || code == 403) {
    throw Exception(_extractError(e));   // <-- 403 THROWS, does not return false
  }
  return false;
}
```
A 401/403 **throws**, which propagates straight through `markNotificationReadRemote` (a plain pass-through wrapper) into `_syncReadStateToStrapi`'s outer `catch (e) { debugPrint(...) }` — the duplicate-creating `pushNotification` fallback is guarded *before* it, on `if (ok) return;`, and is never reached in the 403 case. **The permission gap never triggered this fallback.**

The real (narrower) risk: `_patchJsonBestEffort` returns `false` (no throw) for any *non*-auth failure — a genuine 404 (row never existed, e.g. the original creation-time push failed while offline) or a transient 5xx/network error on a row that *does* already exist. Since `notification` has no unique constraint on `notificationId` (confirmed via schema.json), a transient failure racing an already-existing row would create a second row for the same `notificationId`. This is pre-existing, narrow, and independent of whether the permission gap is fixed.

**Fix applied** (`notification_store.dart`, `_syncReadStateToStrapi`): removed the blind `pushNotification` create-fallback entirely. On any failure it now just logs (`debugPrint`), matching the "best effort" naming already used throughout this file. Local read state is unaffected either way — `markRead()` already flips `_items[i].isRead` before this remote sync ever runs. This eliminates 100% of the duplicate-row risk at the cost of the rare self-healing "recreate a row that was never pushed" case, which is an acceptable trade given the alternative (a cheap, reliable existence-check) isn't available without an extra round trip, and is out of proportion to a permission-gap fix.

**Not covered by an automated test**: `NotificationStore` is a `part of main.dart` singleton with no dependency-injection seam (unlike `EngagementStore`, which is built for exactly this kind of test via an overridable repository class) — it instantiates `StrapiService` directly inline. Adding one would mean refactoring the class for testability, which is a larger change than the fix itself and was judged out of proportion here. Verified instead by full code-path reading (quoted above) plus `flutter analyze` (0 new issues) and the full `flutter test` run (210/210, no regressions). **Manual regression suggestion**: mark a notification read while the device is offline or Strapi is briefly down, then check `GET /notifications` afterward for a duplicate `notificationId`.

---

## 3. Test results

### Targeted (new) tests — 17/17 passing

| File | Tests | Covers |
|---|---|---|
| `tests/integration/notification-mark-read.integration.test.ts` | 5 | owner success, non-owner 403, unauthenticated 403, idempotent re-read with no duplicate row, broadcast bypass |
| `tests/integration/auth-flow-delete-account.integration.test.ts` | 4 | self-deletion + data cleanup + retention record, unauthenticated rejected, request-body spoofing has no effect, unrelated user's account/data survives |
| `tests/integration/conversation-read-and-delete-ownership.integration.test.ts` | 8 | both participants can markRead, non-participant rejected (403), unauthenticated rejected (403), a sibling thread is unaffected, participant can delete + messages cascade, non-participant delete rejected (404), unauthenticated delete rejected (403) |

One status-code correction made while writing these: unauthenticated calls to any `auth:{scope:[]}` route in this codebase return **403**, not 401 — Strapi's own authorize middleware rejects a missing token before the request is treated as "who are you," a documented platform characteristic already noted in `engagement.integration.test.ts` and `profile-setting-ownership.integration.test.ts`. All 4 "unauthenticated" tests were corrected to assert 403 to match this and now pass; this is not a gap in the fix.

`conversation.deleteByThreadId`'s non-participant case asserts **404** (not 403) — the controller's own code returns `ctx.notFound(...)` when `userFilter(user)` finds no matching thread, distinct from `markRead`'s `ctx.forbidden(...)` on the same condition. Verified against the actual controller code, not assumed.

### Full backend suite

- `npm run test:integration`: **183/183 passing** (166 pre-existing on `main` + 17 new), exit 0, ~180s.
- `npm run test:unit`: **31/31 passing**.
- `npx tsc --noEmit`: clean.
- `npm run build`: succeeds (admin panel + TS compile).
- `git diff --check`: clean (only benign LF→CRLF line-ending notices on the new files, no real whitespace errors).

One transient failure observed during iteration, not in the final result: running all 3 new integration files together in a single `node --test` invocation hit a post-test-completion crash (`ReferenceError: strapi is not defined` inside `@strapi/core`'s cron service, firing after a test file's own teardown had already destroyed its Strapi instance) — a pre-existing test-infra timing issue between Strapi's cron scheduler and `node:test`'s per-file teardown, unrelated to this fix's code (same category as the flake documented in `OFFER_O1_CORE_FIX_REPORT.md` §5). Each of the 3 files passes cleanly when run alone; the full `npm run test:integration` run above (which runs everything together, same as always) completed cleanly at 183/183, so this did not affect the final result.

### Clean-checkout worktree validation — partial, and why

An isolated `git worktree` at the final backend commit (`node_modules` linked via a Windows junction, same technique as O1) was used to validate `tsc --noEmit` (clean) and `npm run build` (succeeds) against tracked-files-only state — this is the specific class of bug clean-checkout validation exists to catch (silent reliance on an untracked/gitignored file), and this fix has no such risk surface (no new dependencies, no new content-type schema files, only an array edit + 3 self-contained test files).

Re-running the full integration suite a second time inside that same worktree was attempted but abandoned: Strapi boots inside the fresh worktree were 10-80x slower than in the primary working tree (a single test that normally completes in ~150ms took 6.9-11.8s there, with the process then stalling indefinitely afterward) — environment-specific (very likely Windows filesystem/antivirus contention on a newly created directory, or cold framework caches not present in a fresh worktree), not a code issue, and reproduced identically on two separate attempts. Diagnosed via the same live-process technique used in O1 (`tasklist`, `Get-Process ... | Select CPU/WS/StartTime`, `netstat` for listening ports) before terminating the stuck processes rather than assuming and killing blindly. Given the integration suite already ran 183/183 against the exact same committed code in the primary working tree, and the failure mode observed was consistently "measurably slower / stalls," never a code-level assertion failure, this was judged not worth further infra debugging for this fix's scope. Disclosed here rather than silently omitted or silently re-claimed as "passed."

### Flutter

- `flutter analyze`: 0 new issues (2 pre-existing, unrelated warnings in `logistics_models.dart`, a file this fix does not touch).
- `flutter test`: **210/210 passing**, no regressions.

---

## 4. Files changed

**Backend** (`fix/release-permission-gaps`, 2 commits):
```
ff7b4b1 fix(permissions): grant the 4 confirmed authenticated-role permission gaps
  src/index.ts (24 insertions)

064102f test(permissions): add regression coverage for the 4 permission-gap fixes
  tests/integration/notification-mark-read.integration.test.ts (new)
  tests/integration/auth-flow-delete-account.integration.test.ts (new)
  tests/integration/conversation-read-and-delete-ownership.integration.test.ts (new)
  (530 insertions, 3 files)
```

**Flutter** (`fix/release-permission-gaps`, 1 commit):
```
99d1a19 fix(notifications): remove duplicate-prone create fallback in markRead sync
  lib/features/notifications/stores/notification_store.dart (11 insertions, 13 deletions)
```

---

## 5. Branch / push status

| | Backend | Flutter |
|---|---|---|
| Branch | `fix/release-permission-gaps` | `fix/release-permission-gaps` |
| Base | `main` @ `864b826` | `main` @ `9e4a563` |
| HEAD | `064102f` | `99d1a19` |
| Commits this phase | 2 | 1 |
| Pushed | Yes — branch only | Yes — branch only |
| origin/main sync | 0 behind / 2 ahead | 0 behind / 1 ahead |

`main` untouched in both repos, no production deploy, no merge.

---

## 6. Explicitly deferred

**`logistics-admin.*` (7 actions) — DEFERRED, product/security decision required.** Not touched in this phase. Per `PERMISSION_GAP_RELEASE_AUDIT.md` §BULGU 3: granting the permission carries no security risk on its own (the controller's independent `isAdminUser` role-check still blocks ordinary authenticated users regardless of the Strapi-level grant), but that check is role-only with no allowlist fallback (unlike the parallel `processed-admin` module, which already works today via a role-or-allowlist check). Whether to (a) grant the permission and confirm the real admin account already holds a qualifying Strapi role, or (b) also strengthen `isAdminUser` with an allowlist, is the user's call — awaiting that before touching this area.

**Not carried into this fix, out of scope per instruction:**
- `auth-flow.deleteAccount`'s 22-step deletion chain still runs outside a single DB transaction — a pre-existing durability characteristic, unrelated to the permission gap, explicitly excluded from this phase.

---

## RESULT

# PASS

All 4 confirmed permission gaps (notification.markRead, auth-flow.deleteAccount, conversation.markRead, conversation.deleteByThreadId) are fixed with the minimum-necessary one-line-per-action grant, no authorization logic loosened or added, no client-supplied identity trusted anywhere. 17 new regression tests, all passing; full backend suite 183/183; unit 31/31; tsc/build clean; Flutter analyze clean, `flutter test` 210/210. A real, if narrower-than-originally-stated, notification-duplication bug was found while investigating the audit's fallback claim and fixed with a small, well-justified change. Both branches pushed, `main` and O1 untouched, `logistics-admin.*` explicitly left for a separate decision.
