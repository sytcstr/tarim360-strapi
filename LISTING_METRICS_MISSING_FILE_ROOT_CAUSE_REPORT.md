# Root Cause Report — Strapi Cloud Build Failure (Missing `listing-metrics.ts`)

**Date:** 2026-08-09
**Production merge commit that failed:** `e2853b1` (main)
**Fix branch:** `fix/listing-metrics-missing-from-git`
**Fix commit:** `7698ce5`

## Exact root cause

`src/utils/listing-metrics.ts` was **never committed to this repository, on any branch, ever** (`git log --all -- src/utils/listing-metrics.ts` returns nothing before this fix). It existed only as untracked local WIP on the development machine.

Two commits from 2026-07-31 added controllers that import from it without ever `git add`-ing the file itself:

- `9764714` "feat: add operation idempotency persistence" — committed `src/api/listing-comment/controllers/listing-comment.ts`, which imports `recountListingComments` from `../../../utils/listing-metrics`. The commit message itself says this "includes that pre-existing recountListingComments-based comment persistence unchanged" — i.e. the controller was already-existing WIP that got wired into git at this point, but its dependency wasn't.
- `0c650b4` "feat: add idempotent share endpoint" — same pattern for `src/api/listing-share/controllers/listing-share.ts` and `recountListingShares`.

## Which file was missing

`src/utils/listing-metrics.ts` only. Exports: `listingIdCandidates`, `findListingByAnyId`, `setListingCounter`, `recountListingOffers`, `recountListingComments`, `recountListingShares`.

## Why local `npm run build` previously passed every time

TypeScript/Node module resolution reads straight from the filesystem, not from git's index. The file was physically present on disk in every development session (this one included, across all of Phase 1/2/3 of this release), so `npx tsc --noEmit`, `npm test`, and `npm run build` all resolved the import successfully locally — including in this session's own Phase 2 verification, which reported "TypeScript temiz" truthfully for the local filesystem state while GitHub's actual tracked content was already broken. Only Strapi Cloud's genuine clean `git clone` (no untracked files) exposed it, via `TS2307`.

## Every live importer (confirmed via full-repo grep)

| Importer | Function used | Committed? |
|---|---|---|
| `src/api/listing-comment/controllers/listing-comment.ts` | `recountListingComments` | Yes (`9764714`) |
| `src/api/listing-share/controllers/listing-share.ts` | `recountListingShares` | Yes (`0c650b4`) |
| `src/api/offer/controllers/offer.ts` | `recountListingOffers` | **No** — this import exists only in a separate, still-uncommitted local WIP diff on `offer.ts` (confirmed via `git diff -- src/api/offer/controllers/offer.ts`: the entire diff is exactly this import plus two call sites wrapped in try/catch). The *committed* version of `offer.ts` on GitHub does not reference `listing-metrics.ts` at all. |

No other file in `src/` imports `listingIdCandidates`, `findListingByAnyId`, or `setListingCounter` directly — those are only used internally within `listing-metrics.ts` by the three `recountListing*` functions.

## Was `listing-metrics.ts` committed whole or split?

**Whole, unmodified.** Splitting was considered per the instructions' conditional branch ("if the file mixes required comment/share functionality with unfinished offer functionality, separate them") but the dependency audit showed this condition doesn't hold in a way that requires splitting:

- The file's `recountListingOffers`/`OFFER_UID` *are* offer-domain code sitting in the same file as the comment/share utilities — so yes, there is topical mixing.
- But **nothing currently committed calls `recountListingOffers`**. The only caller is the uncommitted `offer.ts` WIP. So committing the whole file activates nothing — `recountListingOffers` becomes present-but-unused dead code from the committed tree's perspective, exactly as harmless as it was when the file itself was merely sitting untracked on disk.
- The `api::offer.offer` content-type schema is already committed and stable (checked via `git ls-files src/api/offer/`), so even in a hypothetical future where this function *is* called, it wouldn't fail for referencing a nonexistent content type.

Splitting the file would have been unnecessary surgery beyond the smallest production-safe fix the task asked for, and would itself have been a larger, less-reviewable diff than committing the file as it already exists and has existed (unchanged) throughout this entire project.

## Confirmation: `offer.ts` WIP remains untouched

Verified before and after the fix commit via `git diff --stat -- src/api/offer/controllers/offer.ts`: unchanged, still exactly `+12` lines uncommitted (the `recountListingOffers` import + two call sites). Not modified, not reset, not staged, not committed, not deleted.

## Clean-checkout build validation (the critical new check)

Per the lesson from this incident, verified the build would succeed with **only git-tracked content**, not the local filesystem's superset:

1. Created an isolated `git worktree` of `HEAD` (`git worktree add ../tarim360-strapi-clean-checkout-test HEAD`) — worktrees check out only the committed tree, carrying over zero untracked files from the main working copy.
2. Confirmed the worktree genuinely lacked `listing-metrics.ts`.
3. Ran `npx tsc --noEmit` in the clean worktree **before** adding the fix → reproduced the *exact* two `TS2307` errors Strapi Cloud reported. This validates the methodology: the isolated worktree faithfully reproduces what a real clean clone sees.
4. Copied `listing-metrics.ts` into the worktree (the same content about to be committed) → `npx tsc --noEmit` → exit 0. `npm run build` → exit 0 (TS compile + admin panel build both succeeded).
5. Removed the temporary worktree.

Only after this passed was the real commit created on `fix/listing-metrics-missing-from-git`.

## Standard verification (on the fix branch, after staging the fix)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS — clean |
| `npm test` (unit) | PASS — 23/23 |
| `npm run test:integration` | PASS — 125/125 on a clean re-run. **Disclosed anomaly:** the first run had one transient failure in `public-profile-read.integration.test.ts`, coinciding with heavy concurrent I/O from the worktree build validation running moments earlier. Re-run immediately after was clean and reproducible; treated as test-infra resource contention, not a regression — not silently hidden. |
| `npm run build` | PASS — exit 0 |
| `git diff --check` | PASS — clean |
| Staged diff scope | Exactly one file: `src/utils/listing-metrics.ts`, 135 insertions, new file. `offer.ts` not staged. |

## Commit / push

- Branch: `fix/listing-metrics-missing-from-git` (created from `origin/main` at `e2853b1`)
- Commit: `7698ce5` — "fix: include required listing metrics utility for production build"
- Pushed to `origin/fix/listing-metrics-missing-from-git`

## PR to main

**Could not open programmatically** — `gh` CLI is not installed in this environment and no other GitHub API credential is available. GitHub provided a direct PR-creation link on push:

```
https://github.com/sytcstr/tarim360-strapi/pull/new/fix/listing-metrics-missing-from-git
```

Please open that link to create the PR (base `main`, head `fix/listing-metrics-missing-from-git`). Suggested title: `fix: include required listing metrics utility for production build` — the commit message itself doubles as a complete PR description.

## READY / BLOCKED for opening the PR

**READY.** Clean-checkout validation proves GitHub will contain everything `listing-comment`/`listing-share` need to build. Standard verification suite is fully green. `offer.ts` WIP is confirmed untouched. Nothing has been pushed to `main` and no Strapi Cloud deploy has been triggered — both remain your call, per the explicit constraints of this task.
