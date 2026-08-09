import type { Knex } from 'knex';
import type { Database } from '@strapi/database';

/**
 * Adds the composite unique DB index backing the Engagement API's
 * like/favorite interaction identity (ENGAGEMENT_API_CONTRACT.md §3.1).
 *
 * FAZ B-V UPDATE — this file alone is NOT sufficient and is now a
 * secondary/redundant safety net. Two bugs were found by actually
 * booting Strapi against a throwaway SQLite DB (see
 * ENGAGEMENT_BACKEND_VERIFICATION_REPORT.md):
 *
 * 1. Migration files under `database/migrations/*.ts` are invisible to
 *    Strapi unless `config/database.ts` sets
 *    `settings.useTypescriptMigrations: true` — without it, Strapi
 *    looks for migrations in the SOURCE `database/migrations` dir
 *    (only .ts files there, glob only matches .js/.sql) instead of the
 *    compiled `dist/database/migrations`. This project's config didn't
 *    set that flag; it now does (config/database.ts).
 * 2. Even with discovery fixed, this file must export named `up`/`down`
 *    functions, NOT a default-exported `{up, down}` object — Strapi's
 *    migration resolver (`@strapi/database/dist/migrations/users.js`)
 *    does `require(path).up` directly, not `.default.up`. A TS
 *    `export default {...}` compiles to `exports.default = {...}`,
 *    which silently produced `migration.up === undefined` — no error,
 *    just a migration that discovery skipped or that resolved to a
 *    no-op function reference.
 *
 * Separately, the ORIGINAL ordering concern this file documented (Strapi
 * runs pending migrations before syncing brand-new content-type tables
 * into existence — confirmed via `@strapi/database`'s
 * `schema/index.js#sync()`) is real and NOT solved by fixing the two
 * bugs above: on a truly fresh install where this content-type and this
 * migration ship in the same deploy, `hasTable` below will still be
 * false on the first boot. The RELIABLE fix for that is
 * `ensureEngagementUniqueIndexes` in `src/index.ts`'s `bootstrap({strapi})`
 * hook, which runs unconditionally AFTER schema sync every boot and is
 * idempotent — that is now the primary mechanism. This migration file is
 * kept as a secondary, standards-shaped `database/migrations` entry
 * that will also succeed correctly on any second-or-later boot.
 */

const TABLE = 'engagement_interactions';
const INDEX_NAME = 'engagement_interactions_actor_target_kind_unique';
const COLUMNS = ['actor_key', 'target_type', 'target_id', 'kind'];

export async function up(knex: Knex, _db: Database) {
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
      `[engagement migration] ${TABLE} exists but is missing expected columns — skipping unique index creation this boot.`,
    );
    return;
  }
  const existingIndexes: Array<{ name: string }> = await knex.raw(`PRAGMA index_list(${TABLE})`);
  if (Array.isArray(existingIndexes) && existingIndexes.some((i) => i.name === INDEX_NAME)) {
    return; // already present
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
