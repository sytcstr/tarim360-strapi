/**
 * Unit tests for src/utils/engagement-index-support.ts and
 * src/index.ts's ensureEngagementUniqueIndexes bootstrap hook.
 *
 * Production incident: the original implementation ran a hand-written
 * `knex.raw('PRAGMA index_list(...)')`, which is SQLite-only syntax and
 * crashed Strapi Cloud's boot (non-SQLite production dialect). These
 * tests prove the fixed code never issues that call for ANY dialect --
 * the fake `knex`/`db` objects below deliberately do NOT implement a
 * `.raw()` method at all, so an accidental raw-SQL call would throw
 * "not a function" and fail the test loudly, not silently pass.
 *
 * No real PostgreSQL (or MySQL) instance/driver is available in this
 * environment -- these tests verify query GENERATION and control flow
 * against fake dialect/schema objects, not actual PostgreSQL wire
 * behavior. That is a real, disclosed limitation: it proves this code
 * asks the dialect-portable abstraction correctly and branches
 * identically regardless of the reported `dialect.client` label, but it
 * does not prove Strapi's own PostgreSQL schema-inspector implementation
 * is bug-free against a real Postgres server (out of scope here -- that
 * is Strapi's own, separately-maintained code, not this project's).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUniqueIndex } from '../../src/utils/engagement-index-support.ts';
import { ensureEngagementUniqueIndexes, ENGAGEMENT_UNIQUE_INDEXES } from '../../src/index.ts';

test('hasUniqueIndex returns true when the named index is present', async () => {
  const db = {
    dialect: {
      client: 'postgres',
      schemaInspector: {
        getIndexes: async () => [{ name: 'other_index' }, { name: 'target_index' }],
      },
    },
  };
  assert.equal(await hasUniqueIndex(db, 'some_table', 'target_index'), true);
});

test('hasUniqueIndex returns false when the named index is absent', async () => {
  const db = {
    dialect: {
      client: 'sqlite',
      schemaInspector: {
        getIndexes: async () => [{ name: 'other_index' }],
      },
    },
  };
  assert.equal(await hasUniqueIndex(db, 'some_table', 'target_index'), false);
});

test('hasUniqueIndex throws (does not silently say "missing") on a non-array result', async () => {
  const db = {
    dialect: {
      client: 'postgres',
      schemaInspector: {
        getIndexes: async () => undefined as any,
      },
    },
  };
  await assert.rejects(() => hasUniqueIndex(db, 'some_table', 'target_index'));
});

/** Fakes just enough of `strapi.db.connection` + `strapi.db.dialect` for
 * ensureEngagementUniqueIndexes -- deliberately has NO `.raw()` method,
 * so any accidental raw-SQL call (the old PRAGMA bug) throws instead of
 * silently succeeding. */
const fakeStrapi = (opts: {
  hasTable?: boolean;
  existingIndexNamesByTable?: Record<string, string[]>;
  dialectClient?: string;
  alterTableThrows?: boolean;
}) => {
  const calls = { getIndexes: [] as string[], alterTable: [] as string[], uniqueArgs: [] as any[] };
  const knex = {
    schema: {
      hasTable: async (_table: string) => opts.hasTable ?? true,
      alterTable: async (table: string, cb: (t: any) => void) => {
        calls.alterTable.push(table);
        if (opts.alterTableThrows) throw new Error('simulated ALTER TABLE failure');
        const builder = {
          unique: (columns: string[], config: { indexName: string }) => {
            calls.uniqueArgs.push({ table, columns, indexName: config.indexName });
          },
        };
        cb(builder);
      },
    },
  };
  const db = {
    connection: knex,
    dialect: {
      client: opts.dialectClient ?? 'sqlite',
      schemaInspector: {
        getIndexes: async (table: string) => {
          calls.getIndexes.push(table);
          return (opts.existingIndexNamesByTable?.[table] ?? []).map((name) => ({ name }));
        },
      },
    },
  };
  const logs: string[] = [];
  const strapi: any = {
    db,
    log: { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
  };
  return { strapi, calls, logs };
};

test('existing index on both tables → no-op, no ALTER TABLE issued', async () => {
  const existingIndexNamesByTable: Record<string, string[]> = {};
  for (const { table, name } of ENGAGEMENT_UNIQUE_INDEXES) {
    existingIndexNamesByTable[table] = [name];
  }
  const { strapi, calls } = fakeStrapi({ existingIndexNamesByTable });
  await ensureEngagementUniqueIndexes(strapi);
  assert.deepEqual(calls.alterTable, []);
  assert.equal(calls.getIndexes.length, ENGAGEMENT_UNIQUE_INDEXES.length);
});

test('missing index on both tables → ALTER TABLE issued with the right columns/name', async () => {
  const { strapi, calls } = fakeStrapi({ existingIndexNamesByTable: {} });
  await ensureEngagementUniqueIndexes(strapi);
  assert.equal(calls.alterTable.length, ENGAGEMENT_UNIQUE_INDEXES.length);
  for (const { table, name, columns } of ENGAGEMENT_UNIQUE_INDEXES) {
    const created = calls.uniqueArgs.find((c) => c.table === table);
    assert.ok(created, `expected a unique() call for ${table}`);
    assert.deepEqual(created.columns, columns);
    assert.equal(created.indexName, name);
  }
});

test('a real ALTER TABLE failure propagates — boot fails loudly, not silently', async () => {
  const { strapi } = fakeStrapi({ existingIndexNamesByTable: {}, alterTableThrows: true });
  await assert.rejects(() => ensureEngagementUniqueIndexes(strapi));
});

test('sqlite and postgres dialect labels take the identical code path (no manual branch to get wrong)', async () => {
  const existingIndexNamesByTable: Record<string, string[]> = {};
  for (const { table, name } of ENGAGEMENT_UNIQUE_INDEXES) {
    existingIndexNamesByTable[table] = [name];
  }
  const sqliteRun = fakeStrapi({ existingIndexNamesByTable, dialectClient: 'sqlite' });
  const postgresRun = fakeStrapi({ existingIndexNamesByTable, dialectClient: 'postgres' });

  await ensureEngagementUniqueIndexes(sqliteRun.strapi);
  await ensureEngagementUniqueIndexes(postgresRun.strapi);

  // Same tables queried via the dialect-portable schemaInspector, same
  // outcome (no-op) -- neither dialect ever needed a `.raw()` call
  // (the fake knex object doesn't even define one, so a PRAGMA-style
  // regression would have thrown above rather than silently passing).
  assert.deepEqual(sqliteRun.calls.getIndexes.sort(), postgresRun.calls.getIndexes.sort());
  assert.deepEqual(sqliteRun.calls.alterTable, postgresRun.calls.alterTable);
});

test('missing table after schema sync fails loudly instead of silently skipping', async () => {
  const { strapi } = fakeStrapi({ hasTable: false });
  await assert.rejects(() => ensureEngagementUniqueIndexes(strapi));
});
