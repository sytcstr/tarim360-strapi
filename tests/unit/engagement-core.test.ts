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
  engagementRecordKeys,
  incrementCounterAtomic,
  stripListingIdPrefix,
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
    whereNot(col: string, val: any) {
      calls.push({ whereCol: `NOT ${col}`, whereVal: val });
      return builder;
    },
    update(set: Record<string, any>) {
      calls.push({ update: set });
      // Simulate the DB applying the raw increment/decrement expression.
      for (const [col, val] of Object.entries(set)) {
        if (val && typeof val === 'object' && '__raw' in val) {
          const current = Number(row[col] ?? 0);
          if (val.__raw.includes('- 1')) {
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

// Regression: production (Postgres) answered 500 to every unfavorite/unlike
// because the decrement used SQLite's scalar MAX(a, b), which Postgres does
// not have. Every SQL fragment must stay dialect-portable.
test('incrementCounterAtomic decrement SQL is dialect-portable (no SQLite-only scalar MAX, no GREATEST)', async () => {
  const row = { like_count: 2, engagement_version: 1, updated_at: '2026-01-01T00:00:00.000Z' };
  const trx = fakeTrx(row);
  await incrementCounterAtomic(trx, 'listings', 1, 'likeCount', -1);
  const set = trx.__calls.find((c: any) => c.update).update as Record<string, { __raw: string }>;
  for (const val of Object.values(set)) {
    assert.doesNotMatch(val.__raw, /\bMAX\s*\(/i, 'scalar MAX(a,b) is SQLite-only');
    assert.doesNotMatch(val.__raw, /\bGREATEST\s*\(/i, 'GREATEST() is not available on SQLite');
    assert.doesNotMatch(val.__raw, /\bMIN\s*\(/i, 'scalar MIN(a,b) is SQLite-only');
  }
  assert.match(set.like_count.__raw, /CASE WHEN/i);
  assert.equal(row.like_count, 1);
});

test('incrementCounterAtomic issues exactly one update() call, not a read-then-write pair', async () => {
  const row = { view_count: 1, engagement_version: 0, updated_at: '2026-01-01T00:00:00.000Z' };
  const trx = fakeTrx(row);
  await incrementCounterAtomic(trx, 'listings', 1, 'viewCount', 1);
  const updateCalls = trx.__calls.filter((c: any) => c.update);
  assert.equal(updateCalls.length, 1, 'expected exactly one atomic update() call');
});

// Production: Flutter sends `strapi_<numeric id>` (ProfileProduct.id) as the
// engagement targetId and every favorite/like/view answered 404.
test('stripListingIdPrefix strips exactly one strapi_/listing_ app prefix for listings, nothing else', () => {
  assert.equal(stripListingIdPrefix('listing', 'strapi_64'), '64');
  assert.equal(stripListingIdPrefix('listing', 'listing_64'), '64');
  assert.equal(stripListingIdPrefix('listing', 'strapi_h9o2qkqj64r8lq9w4fdihma5'), 'h9o2qkqj64r8lq9w4fdihma5');
  assert.equal(stripListingIdPrefix('listing', '64'), '64');
  assert.equal(stripListingIdPrefix('listing', 'h9o2qkqj64r8lq9w4fdihma5'), 'h9o2qkqj64r8lq9w4fdihma5');
  // never "extract the digits" out of an arbitrary string
  assert.equal(stripListingIdPrefix('listing', 'abc64def'), 'abc64def');
  assert.equal(stripListingIdPrefix('listing', 'xstrapi_64'), 'xstrapi_64');
  // an empty remainder is left alone rather than becoming ''
  assert.equal(stripListingIdPrefix('listing', 'strapi_'), 'strapi_');
  // other target types are not touched
  assert.equal(stripListingIdPrefix('processed-product', 'strapi_64'), 'strapi_64');
  assert.equal(stripListingIdPrefix('hub-content', 'listing_1'), 'listing_1');
});

test('engagementRecordKeys keys by the stable documentId and still reads the legacy numeric key', () => {
  assert.deepEqual(engagementRecordKeys({ id: 170, documentId: 'abc123' }, 'listing'), { key: 'abc123', legacy: '170', both: ['abc123', '170'] });
  assert.deepEqual(engagementRecordKeys({ id: 7 }, 'listing'), { key: '7', legacy: '7', both: ['7'] });
  assert.deepEqual(engagementRecordKeys({ id: 7, documentId: '  ' }, 'listing'), { key: '7', legacy: '7', both: ['7'] });
  // other target types keep their numeric key
  assert.deepEqual(engagementRecordKeys({ id: 9, documentId: 'zzz' }, 'hub-content'), { key: '9', legacy: '9', both: ['9'] });
});

// Draft & Publish: Strapi rebuilds the published row FROM THE DRAFT on every
// publish, so a counter written only to the published row was wiped on the
// listing's first edit (production: fav 1 -> 0, like 1 -> 0, view 1 -> 0).
test('incrementCounterAtomic mirrors the new values onto every sibling row of the same document', async () => {
  const row = { like_count: 4, engagement_version: 10, updated_at: '2026-01-01T00:00:00.000Z' };
  const trx = fakeTrx(row);
  await incrementCounterAtomic(trx, 'listings', 170, 'likeCount', 1, 'docABC');
  const updates = trx.__calls.filter((c: any) => c.update);
  assert.equal(updates.length, 2, 'primary update + one sibling mirror update');
  const mirror = updates[1].update;
  assert.equal(mirror.like_count, 5);
  assert.equal(mirror.engagement_version, 11);
  const filters = trx.__calls.filter((c: any) => c.whereCol).map((c: any) => [c.whereCol, c.whereVal]);
  assert.ok(filters.some(([c, v]: any[]) => c === 'document_id' && v === 'docABC'));
  assert.ok(filters.some(([c, v]: any[]) => c === 'NOT id' && v === 170), 'the primary row is excluded from the mirror update');
});

test('incrementCounterAtomic without a documentId keeps the single-row behavior', async () => {
  const trx = fakeTrx({ like_count: 1, engagement_version: 1, updated_at: 'x' });
  await incrementCounterAtomic(trx, 'listings', 1, 'likeCount', 1);
  assert.equal(trx.__calls.filter((c: any) => c.update).length, 1);
});
