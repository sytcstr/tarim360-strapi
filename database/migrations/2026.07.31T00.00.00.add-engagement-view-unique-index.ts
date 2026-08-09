import type { Knex } from 'knex';
import type { Database } from '@strapi/database';

/**
 * Adds the composite unique DB index backing the Engagement API's view
 * dedup record (ENGAGEMENT_API_CONTRACT.md §4.3 — "son görüntülenme
 * kaydı" model).
 *
 * FAZ B-V UPDATE: same two bugs and same fix as
 * 2026.07.30T00.00.00.add-engagement-interaction-unique-index.ts (named
 * exports instead of a default-exported object; requires
 * config/database.ts's `settings.useTypescriptMigrations: true`) — see
 * that file's header comment for the full explanation. The reliable
 * mechanism for a fresh install is now `ensureEngagementUniqueIndexes`
 * in src/index.ts's `bootstrap({strapi})` hook; this migration is a
 * secondary safety net.
 *
 * PRODUCTION FIX: same SQLite-only PRAGMA bug and same dialect-portable
 * fix as that file too (see
 * ENGAGEMENT_INDEX_PORTABILITY_PRODUCTION_FIX_REPORT.md) — uses `db`'s
 * dialect schema inspector instead of hand-written PRAGMA SQL.
 */

const TABLE = 'engagement_views';
const INDEX_NAME = 'engagement_views_actor_target_unique';
const COLUMNS = ['actor_key', 'target_type', 'target_id'];

export async function up(knex: Knex, db: Database) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) {
    strapi?.log?.warn?.(
      `[engagement migration] ${TABLE} does not exist yet — skipping unique index creation for this boot; src/index.ts's bootstrap hook is the reliable path for this.`,
    );
    return;
  }
  const hasColumns = await Promise.all(COLUMNS.map((c) => knex.schema.hasColumn(TABLE, c)));
  if (hasColumns.some((present) => !present)) {
    strapi?.log?.warn?.(
      `[engagement migration] ${TABLE} exists but is missing expected columns — skipping.`,
    );
    return;
  }
  const existingIndexes = await (db as any).dialect.schemaInspector.getIndexes(TABLE);
  if (Array.isArray(existingIndexes) && existingIndexes.some((i: { name?: string }) => i.name === INDEX_NAME)) {
    return;
  }
  await knex.schema.alterTable(TABLE, (table) => {
    table.unique(COLUMNS, { indexName: INDEX_NAME });
  });
}

export async function down(knex: Knex, _db: Database) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.schema.alterTable(TABLE, (table) => {
    table.dropUnique(COLUMNS, INDEX_NAME);
  });
}
