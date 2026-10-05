# Engagement Index Bootstrap — Database Portability Fix

**Date:** 2026-08-09
**Production deployment that failed:** `50ddf1c`
**Fix branch:** `fix/engagement-index-dialect-portability`
**Fix commit:** `a24804d`

## Actual production error

```
[engagement bootstrap] FAILED to ensure unique index
engagement_interactions_actor_target_kind_unique on engagement_interactions

PRAGMA index_list(engagement_interactions)
syntax error at or near "PRAGMA"
```

This crashed application startup — the build itself had already succeeded (the `listing-metrics.ts` fix from the prior phase resolved that separate issue).

## Exact root cause

`PRAGMA` is SQLite-only syntax. Three places in this codebase ran it as hand-written raw SQL to check whether a unique index already existed, before creating it:

1. `src/index.ts:55` — `ensureEngagementUniqueIndexes`, the `bootstrap({strapi})` hook that runs on every boot (the primary, reliable mechanism — see that function's own header comment for why it must run here rather than in a migration).
2. `database/migrations/2026.07.30T00.00.00.add-engagement-interaction-unique-index.ts:62`
3. `database/migrations/2026.07.31T00.00.00.add-engagement-view-unique-index.ts:38`

All three ran `knex.raw(\`PRAGMA index_list(${table})\`)`. Every local and integration verification in this project boots against a throwaway SQLite database (confirmed in `config/database.ts` and every test file's setup), so this always worked locally and in CI-style test runs. Strapi Cloud production runs a different SQL dialect, where `PRAGMA` is not valid syntax at all — hence the syntax error, on the very first attempt, every time.

## Dialect detection method

`@strapi/database`'s `Database` class exposes a public, typed `dialect` property (`node_modules/@strapi/database/dist/index.d.ts`, `node_modules/@strapi/database/dist/dialects/dialect.d.ts`):

```ts
class Dialect {
  db: Database;
  schemaInspector: SchemaInspector; // { getIndexes(tableName): Promise<Index[]>; ... }
  client: string;                   // 'sqlite' | 'postgres' | 'mysql'
}
```

Constructed once at boot from `db.config.connection.client` — the exact same value this project's `config/database.ts` sets from `DATABASE_CLIENT` (`sqlite` | `postgres` | `mysql`). No guessing or environment-variable sniffing needed in our own code: `strapi.db.dialect.client` is always correct by construction, live, at runtime, for whatever Strapi Cloud is actually configured with.

## Was index creation or only index inspection broken?

**Only inspection.** Index *creation* was already dialect-portable: `knex.schema.alterTable(table, (t) => t.unique(columns, { indexName: name }))` uses Knex's schema-builder API, which Knex itself translates correctly per configured client. Only the pre-creation existence check was hand-written, SQLite-specific SQL. This significantly narrowed the fix.

## The fix

Delegate the existence check to Strapi's own per-dialect schema inspector — `db.dialect.schemaInspector.getIndexes(tableName): Promise<Index[]>` — instead of writing any SQL ourselves. This is the exact same mechanism Strapi uses internally for its own schema diffing (verified by reading `node_modules/@strapi/database/dist/dialects/{sqlite,postgresql,mysql}/schema-inspector.js`): SQLite's implementation still uses `PRAGMA index_list`/`PRAGMA index_info` under the hood, PostgreSQL's uses `pg_catalog`/`information_schema`-based SQL, MySQL's uses `information_schema`. All three return a uniform `{ columns, name, type }` shape.

Because this project's code no longer writes any dialect-specific SQL for this check at all, **there is no manual branch to get wrong** — SQLite behavior is unchanged (still PRAGMA-based, just executed by Strapi's own tested inspector rather than duplicated by hand), PostgreSQL now works correctly, and MySQL is supported for free via the same abstraction (the project's `config/database.ts` already lists it as a supported `DATABASE_CLIENT` option).

**New file** `src/utils/engagement-index-support.ts` — exports `hasUniqueIndex(db, table, indexName): Promise<boolean>`, throwing (not silently returning `false`) if the inspector ever returns something that isn't an array, so a genuinely broken inspector call can never be misread as "index missing." Imported by `src/index.ts`'s bootstrap hook.

The two migration files were **not** changed to import this shared helper — `database/migrations/*.ts` resolves from TS source outside the normal `src/` build graph (per the `useTypescriptMigrations` note already in `config/database.ts`), and that cross-boundary import path is unverified in this environment. Each migration file instead got its own small, self-contained inline fix (same `db.dialect.schemaInspector.getIndexes(...)` call), consistent with these files' own existing "redundant, standalone safety net" design (documented in their own header comments).

## Both indexes affected — confirmed

`engagement_interactions_actor_target_kind_unique` and `engagement_views_actor_target_unique` both go through the identical shared loop in `ensureEngagementUniqueIndexes` (`ENGAGEMENT_UNIQUE_INDEXES` array), so both were broken identically and both are fixed identically. Separately, each had its own matching migration file, both fixed the same way.

## Local test matrix

| Check | Result |
|---|---|
| `npx tsc --noEmit` | PASS — clean |
| `npm test` (unit) | PASS — 31/31 (23 pre-existing + 8 new) |
| `npm run test:integration` | PASS — 125/125 |
| `npm run build` | PASS — exit 0 |

**New dialect-branching unit tests** (`tests/unit/engagement-index-support.test.ts`, 8 tests): `hasUniqueIndex` returns true/false correctly, throws on a non-array inspector result; `ensureEngagementUniqueIndexes` no-ops when the index exists, creates it with the right table/columns/name when missing, propagates a real `ALTER TABLE` failure (boot must fail loudly), fails loudly when the table itself is missing after schema sync, and — the key regression guard — produces **identical** calls/behavior whether the fake `dialect.client` is `'sqlite'` or `'postgres'`. The fake `knex`/`db` objects deliberately implement no `.raw()` method at all, so any accidental reintroduction of raw SQL (the original bug) would throw immediately and fail the test, not silently pass.

**Disclosed limitation, as required:** no real PostgreSQL (or MySQL) instance or driver is available in this environment. These unit tests verify query *generation* and control flow against fake dialect/schema objects — they prove this project's own code asks the portable abstraction correctly and behaves identically regardless of the reported dialect label. They do **not** prove Strapi's own PostgreSQL schema-inspector is bug-free against a real PostgreSQL server — that is Strapi's separately-maintained internal code, exercised by Strapi's own test suite, not re-verified here.

**Real, non-mocked confirmation that did happen:** the existing 125-test integration suite boots a genuine Strapi instance against a real (throwaway) SQLite database on every single run, which means the *exact* new code path (`ensureEngagementUniqueIndexes` → `hasUniqueIndex` → `dialect.schemaInspector.getIndexes`) executes for real, dozens of times per run — confirmed by the bootstrap's own `[engagement bootstrap] Created unique index ...` log lines still appearing correctly after the fix.

## Clean-checkout build validation

Same methodology as the prior `listing-metrics.ts` fix: created an isolated `git worktree` of the new commit (`a24804d`) — carrying over zero untracked files — and ran `npx tsc --noEmit` and `npm run build` there. Both passed (exit 0), confirming GitHub will contain everything this fix needs; no untracked local file was silently relied upon.

## WIP preservation

Confirmed via `git status --short` and `git diff --stat -- src/api/offer/controllers/offer.ts` before and after this work: `offer.ts` remains exactly `+12` lines uncommitted, untouched, unstaged, unstashed. Not reset, not deleted. All prior-phase `.md` reports remain untracked and untouched.

## Commit / push

- Branch: `fix/engagement-index-dialect-portability` (created from `origin/main` at `50ddf1c`)
- Commit: `a24804d` — "fix: make engagement index bootstrap database portable"
- Pushed to `origin/fix/engagement-index-dialect-portability` only. **Not** pushed to `main`.

## PR to main

Same limitation as the previous phase: no `gh` CLI or other GitHub API credential is available in this environment, so the PR could not be opened programmatically. GitHub's direct PR-creation link from the push:

```
https://github.com/sytcstr/tarim360-strapi/pull/new/fix/engagement-index-dialect-portability
```

## READY / BLOCKED for PR

**READY.** Clean-checkout validation passes, the full local test matrix is green (including new dialect-portability coverage), the real SQLite path is confirmed working end-to-end via the existing integration suite, and `offer.ts` WIP is untouched. No push to `main`, no production deployment triggered, no production database touched — all remain your call.
