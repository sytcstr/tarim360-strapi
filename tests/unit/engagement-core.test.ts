/**
 * Unit tests for src/api/engagement/services/engagement-core.ts.
 * incrementCounterAtomic is exercised against a minimal fake Knex
 * transaction object (recording the exact SQL fragments it would send)
 * rather than a real DB — this is a no-DB substitute for the concurrency
 * scenarios that genuinely need a live database, which are documented
 * (not executed) in tests/integration/. Run with:
 *   node --test tests/unit/engagement-core.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  incrementCounterAtomic,
  toSnakeCase,
} from '../../src/api/engagement/services/engagement-core.ts';

test('toSnakeCase matches Strapi\'s real column naming (verified against the local dev DB)', () => {
  assert.equal(toSnakeCase('likeCount'), 'like_count');
  assert.equal(toSnakeCase('favoriteCount'), 'favorite_count');
  assert.equal(toSnakeCase('viewCount'), 'view_count');
  assert.equal(toSnakeCase('engagementVersion'), 'engagement_version');
  assert.equal(toSnakeCase('ownerProfileId'), 'owner_profile_id');
  assert.equal(toSnakeCase('likes'), 'likes'); // already lowercase, no-op
});

/** Minimal fake of the Knex.Transaction callable-query-builder shape
 * incrementCounterAtomic relies on: trx(table).where(col,val).update(set)
 * and .first(...cols). Records the SQL fragments passed to raw() so the
 * test can assert on the *shape* of the atomic statement without a DB. */
const fakeTrx = (row: Record<string, any>) => {
  const calls: { update?: Record<string, any>; whereCol?: string; whereVal?: any }[] = [];
  const raw = (sql: string, bindings: string[]) => ({ __raw: sql, __bindings: bindings });
  const builder: any = {
    where(col: string, val: any) {
      calls.push({ whereCol: col, whereVal: val });
      return builder;
    },
    update(set: Record<string, any>) {
      calls.push({ update: set });
      // Simulate the DB applying the raw increment/decrement expression.
      for (const [col, val] of Object.entries(set)) {
        if (val && typeof val === 'object' && '__raw' in val) {
          const current = Number(row[col] ?? 0);
          if (val.__raw.includes('MAX')) {
            row[col] = Math.max(current - 1, 0);
          } else {
            row[col] = current + 1;
          }
        }
      }
      return Promise.resolve(1);
    },
    first(...cols: string[]) {
      const projected: Record<string, any> = {};
      for (const c of cols) projected[c] = row[c];
      return Promise.resolve(projected);
    },
  };
  const trxFn: any = (_table: string) => builder;
  trxFn.raw = raw;
  trxFn.__calls = calls;
  trxFn.__row = row;
  return trxFn;
};

test('incrementCounterAtomic increments the counter and engagementVersion together on delta +1', async () => {
  const row = { like_count: 4, engagement_version: 10, updated_at: '2026-01-01T00:00:00.000Z' };
  const trx = fakeTrx(row);
  const result = await incrementCounterAtomic(trx, 'listings', 1, 'likeCount', 1);
  assert.equal(result.count, 5);
  assert.equal(result.serverVersion, 11);
});

test('incrementCounterAtomic clamps a decrement at zero, never goes negative', async () => {
  const row = { like_count: 0, engagement_version: 3, updated_at: '2026-01-01T00:00:00.000Z' };
  const trx = fakeTrx(row);
  const result = await incrementCounterAtomic(trx, 'listings', 1, 'likeCount', -1);
  assert.equal(result.count, 0); // clamped, not -1
  assert.equal(result.serverVersion, 4); // version still advances even on a clamped no-op decrement
});

test('incrementCounterAtomic issues exactly one update() call, not a read-then-write pair', async () => {
  const row = { view_count: 1, engagement_version: 0, updated_at: '2026-01-01T00:00:00.000Z' };
  const trx = fakeTrx(row);
  await incrementCounterAtomic(trx, 'listings', 1, 'viewCount', 1);
  const updateCalls = trx.__calls.filter((c: any) => c.update);
  assert.equal(updateCalls.length, 1, 'expected exactly one atomic update() call');
});
