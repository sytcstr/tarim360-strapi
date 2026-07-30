import type { Knex } from 'knex';
import type { Database } from '@strapi/database';

/**
 * Adds the composite unique DB index backing the Engagement API's
 * like/favorite interaction identity (ENGAGEMENT_API_CONTRACT.md §3.1).
 *
 * IMPORTANT — known ordering limitation (see
 * ENGAGEMENT_BACKEND_IMPLEMENTATION_REPORT.md "Bilinen kalan riskler"):
 * Strapi runs pending `database/migrations/*` files BEFORE it syncs new
 * content-type tables into existence (confirmed by reading
 * `@strapi/database`'s `schema/index.js#sync()`: it calls
 * `db.migrations.up()` first, then `syncSchema()`). If this migration and
 * the `engagement-interaction` content-type are deployed in the same boot,
 * the `engagement_interactions` table will not exist yet when this file
 * first runs. Each migration is recorded in `strapi_migrations` and never
 * re-run once it completes — so this migration deliberately does NOT
 * throw in that case (a thrown error here would abort the whole Strapi
 * boot). Instead it no-ops safely, which means the unique index may not
 * get created on that first boot.
 *
 * Operational requirement: after the first deploy that introduces this
 * content-type, verify the index actually exists, e.g.:
 *   PRAGMA index_list('engagement_interactions');
 * If it's missing, delete this migration's row from `strapi_migrations`
 * (`DELETE FROM strapi_migrations WHERE name = '<this file's basename>'`)
 * and restart the app once more so it re-runs against the now-existing
 * table. This gap is bridged in application code too: the like/favorite
 * controller (Aşama 4) always does an explicit existence check before
 * inserting, so duplicate rows are already unlikely even without the DB
 * index — the index closes the remaining true-concurrency window.
 */

const TABLE = 'engagement_interactions';
const INDEX_NAME = 'engagement_interactions_actor_target_kind_unique';
const COLUMNS = ['actor_key', 'target_type', 'target_id', 'kind'];

export default {
  async up(knex: Knex, _db: Database) {
    const hasTable = await knex.schema.hasTable(TABLE);
    if (!hasTable) {
      strapi?.log?.warn?.(
        `[engagement migration] ${TABLE} does not exist yet — skipping unique index creation for this boot; will not automatically retry (see migration file comment for manual recovery steps).`,
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
    const existingIndexes: Array<{ name: string }> = await knex.raw(
      `PRAGMA index_list(${TABLE})`,
    );
    if (Array.isArray(existingIndexes) && existingIndexes.some((i) => i.name === INDEX_NAME)) {
      return; // already present (e.g. migration re-run after manual ledger cleanup)
    }
    await knex.schema.alterTable(TABLE, (table) => {
      table.unique(COLUMNS, { indexName: INDEX_NAME });
    });
  },

  async down(knex: Knex, _db: Database) {
    const hasTable = await knex.schema.hasTable(TABLE);
    if (!hasTable) return;
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropUnique(COLUMNS, INDEX_NAME);
    });
  },
};
